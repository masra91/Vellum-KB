// Job runtime integration (SPEC-0023 JOBS). Real FS + git + worktrees against a throwaway temp
// vault (TEST-18); behaviors are injected (pure cognition, no copilot). Exercises the harness:
// bounded pass → disposition routing → per-job journal on `staging` (never `main`) → promotion of
// evergreen findings → single-flight.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createKb } from './vault';
import { Mutex } from './stageLock';
import { ensureStagingWorktree } from './stagingWorktree';
import { promote } from './staging';
import { runJobOnce, JobRunner, readJournal, journalRel } from './jobStage';
import { exampleJobBehavior, EXAMPLE_CENSUS_REL, EXAMPLE_JOB_TYPE } from './exampleJob';
import type { JobConfig, JobBehavior } from './jobs';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const exampleJob: JobConfig = { id: 'example', type: EXAMPLE_JOB_TYPE, schedule: 'daily', enabled: true, posture: 'guarded', facing: 'internal' };

/** Commit files onto `staging` via the staging worktree (which is checked out on `staging`). */
async function commitOnStaging(stagingWt: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(stagingWt, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
  }
  const git = simpleGit(stagingWt);
  await git.add('-A');
  await git.commit('seed on staging');
}

async function withVault(fn: (root: string, stagingWt: string, lock: Mutex) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    const stagingWt = await ensureStagingWorktree(root);
    await fn(root, stagingWt, new Mutex());
  } finally {
    await rmTempDir(dir);
  }
}

describe('readJournal — read-boundary normalization (no git; JOBS-8 "undefined" fix)', () => {
  it('normalizes a legacy/partial line, keeps a well-formed one, and skips malformed JSON', async () => {
    const root = await makeTempDir();
    try {
      const jp = path.join(root, journalRel('reflect'));
      await fs.mkdir(path.dirname(jp), { recursive: true });
      // Line 1: legacy (no JOBS-8 counts). Line 2: current. Line 3: malformed (not JSON).
      await fs.writeFile(
        jp,
        `{"ts":"2026-06-01T00:00:00.000Z","runId":"OLD"}\n` +
          `{"ts":"2026-06-02T00:00:00.000Z","runId":"NEW","inspected":"entities/ (3)","applied":2,"deferred":1}\n` +
          `{not json\n`,
        'utf8',
      );
      const journal = await readJournal(root, 'reflect');
      expect(journal).toHaveLength(2); // malformed line skipped, never crashes continuity
      // Legacy line: counts coerced to 0, inspected '' — never undefined (the run-detail "undefined" bug).
      expect(journal[0]).toEqual({ ts: '2026-06-01T00:00:00.000Z', runId: 'OLD', inspected: '', applied: 0, deferred: 0 });
      expect(journal[1].applied).toBe(2);
      expect(journal[1].deferred).toBe(1);
    } finally {
      await rmTempDir(root);
    }
  });
});

describe.skipIf(!gitAvailable)('runJobOnce — bounded pass, journal, promotion (SPEC-0023)', () => {
  it('runs the example job: census applied on staging, promoted to main; journal stays on staging only', async () => {
    await withVault(async (root, stagingWt, lock) => {
      // Seed one entity on staging so the census has something to count.
      await commitOnStaging(stagingWt, { 'entities/person/steve.md': '---\nid: 01E\nname: Steve\n---\n# Steve\n' });

      const res = await runJobOnce(stagingWt, exampleJob, exampleJobBehavior, lock);
      expect(res.outcome).toBe('advanced');
      expect(res.applied).toBe(1); // census changed n/a → 1
      expect(res.deferred).toBe(0);

      // Journal written on staging (JOBS-7), audit-rich (applied count + cursor).
      const journal = await readJournal(stagingWt, 'example');
      expect(journal).toHaveLength(1);
      expect(journal[0].applied).toBe(1);
      expect(journal[0].cursor?.entityCount).toBe(1);
      // Census artifact on staging.
      expect(await pathExists(path.join(stagingWt, EXAMPLE_CENSUS_REL))).toBe(true);

      // Promote: the evergreen census reaches main (JOBS-12); the journal NEVER does (JOBS-7).
      await promote(root);
      expect(await pathExists(path.join(root, EXAMPLE_CENSUS_REL))).toBe(true);
      expect(await pathExists(path.join(root, '.kb', 'jobs', 'example', 'journal.jsonl'))).toBe(false);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('a no-find run still journals (continuity); a re-run with unchanged census applies nothing', async () => {
    await withVault(async (root, stagingWt, lock) => {
      await commitOnStaging(stagingWt, { 'entities/person/steve.md': '---\nid: 01E\nname: Steve\n---\n# Steve\n' });
      await runJobOnce(stagingWt, exampleJob, exampleJobBehavior, lock); // census n/a → 1 (applied)
      const res2 = await runJobOnce(stagingWt, exampleJob, exampleJobBehavior, lock); // unchanged → no-op
      expect(res2.applied).toBe(0);
      const journal = await readJournal(stagingWt, 'example');
      expect(journal).toHaveLength(2); // both runs recorded (JOBS-7/8), even the no-find one
      expect(journal[1].applied).toBe(0);
    });
  });

  it('disposition routing (JOBS-9): guarded sends destructive → Review (no effect), additive → auto', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const behavior: JobBehavior = async () => ({
        inspected: 'two findings',
        findings: [
          { summary: 'retire stale node', kind: 'destructive', confidence: 0.95, proposed: 'auto', review: { question: 'Retire X?' } },
          { summary: 'add census', kind: 'additive', confidence: 1, proposed: 'auto', writes: [{ rel: 'outputs/example/note.md', content: 'hi\n' }] },
        ],
      });
      const job: JobConfig = { id: 'mixed', type: 'mixed', schedule: 'daily', enabled: true, posture: 'guarded', facing: 'internal' };
      const res = await runJobOnce(stagingWt, job, behavior, lock);
      expect(res.applied).toBe(1); // the additive
      expect(res.deferred).toBe(1); // the destructive → Review
      // additive auto-applied on staging…
      expect(await pathExists(path.join(stagingWt, 'outputs/example/note.md'))).toBe(true);
      // …destructive raised a Review (SPEC-0018), applied no effect.
      expect(await pathExists(path.join(stagingWt, 'reviews'))).toBe(true);
      const journal = await readJournal(stagingWt, 'mixed');
      const deferred = journal[0].findings?.find((f) => f.disposition === 'review');
      expect(deferred?.reviewId).toBeTruthy();
    });
  });

  // #528 fast-follow: an agent-backed behavior's JobPassResult.agent (ORCH-16 provenance) used to have
  // nowhere to go — JournalEntry had no `agent` field, so the runner silently dropped it. FAILS-BEFORE
  // (reverting the spread in the journal-entry construction drops `.agent`) / PASSES-AFTER this fix.
  it("persists an agent-backed behavior's AgentTrace onto the journal entry (#528 fast-follow)", async () => {
    await withVault(async (root, stagingWt, lock) => {
      const behavior: JobBehavior = async () => ({
        inspected: 'ran',
        findings: [],
        agent: { via: 'copilot', runtime: 'copilot', model: 'claude-x', params: ['--no-ask-user', '--model', 'claude-x'], ok: true, ms: 5, at: '2026-07-13T00:00:00Z' },
      });
      const job: JobConfig = { id: 'agent-backed', type: 'agent-backed', schedule: 'daily', enabled: true, posture: 'guarded', facing: 'internal' };
      await runJobOnce(stagingWt, job, behavior, lock);
      const journal = await readJournal(stagingWt, 'agent-backed');
      expect(journal[0].agent).toEqual({ via: 'copilot', runtime: 'copilot', model: 'claude-x', params: ['--no-ask-user', '--model', 'claude-x'], ok: true, ms: 5, at: '2026-07-13T00:00:00Z' });
    });
  });
});

describe.skipIf(!gitAvailable)('JobRunner — single-flight (JOBS-6/11)', () => {
  it('a runNow while a run is in flight is skipped, not stacked', async () => {
    await withVault(async (root, stagingWt, lock) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      let runs = 0;
      const slow: JobBehavior = async () => {
        runs += 1;
        await gate; // hold the run open
        return { inspected: 'slow', findings: [] };
      };
      const job: JobConfig = { id: 'slow', type: 'slow', schedule: 'daily', enabled: true, posture: 'guarded', facing: 'internal' };
      const runner = new JobRunner(stagingWt, job, slow, lock);
      const first = runner.runNow(); // starts, parks on the gate
      await Promise.resolve();
      const second = await runner.runNow(); // in flight → skipped
      expect(second).toBe('skipped');
      release();
      await first;
      expect(runs).toBe(1); // the second never started
    });
  });
});

describe.skipIf(!gitAvailable)('runJobOnce — write-sink containment (JOBS-10 security: agent rel is injection surface)', () => {
  const sinkJob: JobConfig = { id: 'sink', type: 'sink', schedule: 'daily', enabled: true, posture: 'guarded', facing: 'internal' };
  const additiveWrites = (writes: { rel: string; content: string }[]): JobBehavior => async () => ({
    inspected: 'crafted',
    findings: [{ summary: 'crafted write', kind: 'additive', confidence: 1, proposed: 'auto', writes }],
  });

  // A rejected finding: nothing applied, routed to Review, the journal records the rejection reason.
  async function expectRejected(stagingWt: string, lock: Mutex, rel: string): Promise<void> {
    const res = await runJobOnce(stagingWt, sinkJob, additiveWrites([{ rel, content: 'EVIL' }]), lock);
    expect(res.applied).toBe(0); // guard blocks the auto-apply (JOBS-10)
    expect(res.deferred).toBe(1); // routed to Review, not silently dropped (guard 4)
    expect(await pathExists(path.join(stagingWt, 'reviews'))).toBe(true);
    const journal = await readJournal(stagingWt, 'sink');
    expect(journal[journal.length - 1].findings?.[0].rejection).toBeTruthy(); // reason audited
  }

  it('T1/T2: blocks `..` traversal and absolute paths (containment)', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      await expectRejected(stagingWt, lock, '../escape.md');
      await expectRejected(stagingWt, lock, '../../escape.md');
      await expectRejected(stagingWt, lock, '/etc/evil');
      // nothing escaped the worktree into the cache/worktrees parent:
      expect(await pathExists(path.join(stagingWt, '..', 'escape.md'))).toBe(false);
    });
  });

  it('T3/T4/T5: blocks paths outside the knowledge roots (.git/, .kb/ journal, app/)', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      await expectRejected(stagingWt, lock, '.git/hooks/post-checkout');
      await expectRejected(stagingWt, lock, '.kb/jobs/sink/journal.jsonl'); // engine-owned, not a knowledge root
      await expectRejected(stagingWt, lock, 'app/src/kb/staging.ts');
      await expectRejected(stagingWt, lock, 'sources/2026/forged/source.md'); // jobs never write ground truth
    });
  });

  it('T7: a new, contained, allowlisted additive write still auto-applies (happy-path regression)', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      const res = await runJobOnce(stagingWt, sinkJob, additiveWrites([{ rel: 'entities/person/new.md', content: '# New\n' }]), lock);
      expect(res.applied).toBe(1);
      expect(res.deferred).toBe(0);
      expect(await pathExists(path.join(stagingWt, 'entities/person/new.md'))).toBe(true);
    });
  });

  it('T8: a finding with one bad write rejects the WHOLE finding — the valid write does NOT partially land (atomic)', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      const res = await runJobOnce(
        stagingWt,
        sinkJob,
        additiveWrites([
          { rel: 'outputs/ok.md', content: 'ok' },
          { rel: '../bad.md', content: 'bad' },
        ]),
        lock,
      );
      expect(res.applied).toBe(0);
      expect(res.deferred).toBe(1);
      expect(await pathExists(path.join(stagingWt, 'outputs/ok.md'))).toBe(false); // no partial write
    });
  });

  it('T5c: classifies on the RESOLVED path — `entities/../sources/x` is rejected (not the raw string)', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      await expectRejected(stagingWt, lock, 'entities/../sources/steve.md');
      await expectRejected(stagingWt, lock, './'); // degenerate
    });
  });

  it('T6: an additive OVERWRITE within the knowledge roots is allowed (REFLECT-4 refresh / regen)', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      // Seed an existing entity on staging, then have the job rewrite it (a refresh).
      await fs.mkdir(path.join(stagingWt, 'entities', 'person'), { recursive: true });
      await fs.writeFile(path.join(stagingWt, 'entities/person/steve.md'), '# Steve (old)\n', 'utf8');
      { const g = simpleGit(stagingWt); await g.add('-A'); await g.commit('seed entity'); }

      const res = await runJobOnce(stagingWt, sinkJob, additiveWrites([{ rel: 'entities/person/steve.md', content: '# Steve (refreshed)\n' }]), lock);
      expect(res.applied).toBe(1); // overwrite within entities/ is legitimate, not blocked
      expect(await fs.readFile(path.join(stagingWt, 'entities/person/steve.md'), 'utf8')).toContain('refreshed');
    });
  });

  it('T9 (REQUIRED): a write through a committed symlink that escapes the worktree is blocked (symlink-safe containment)', async () => {
    await withVault(async (_root, stagingWt, lock) => {
      // A symlink committed inside the knowledge tree pointing OUT of the worktree (the classic
      // lexical-containment bypass): `entities/escape -> <outside>`.
      const outside = path.join(stagingWt, '..', '..', '..', 'escape-target'); // well outside the worktree
      await fs.mkdir(outside, { recursive: true });
      await fs.mkdir(path.join(stagingWt, 'entities'), { recursive: true });
      await fs.symlink(path.resolve(outside), path.join(stagingWt, 'entities', 'escape'));
      { const g = simpleGit(stagingWt); await g.add('-A'); await g.commit('seed escaping symlink'); }

      const res = await runJobOnce(stagingWt, sinkJob, additiveWrites([{ rel: 'entities/escape/pwned.md', content: 'PWNED' }]), lock);
      expect(res.applied).toBe(0); // resolveSymlinkSafe realpaths the symlink → outside wt → rejected
      expect(res.deferred).toBe(1);
      expect(await pathExists(path.join(path.resolve(outside), 'pwned.md'))).toBe(false); // never followed out
    });
  });
});

// #29 — runJobOnce's last-line sink guard: the registry read/write guards drop unsafe ids upstream,
// but the run sink ALSO asserts `isSafeJobId(job.id)` before composing journalRel(id)/the per-job
// worktree/the work branch — so even a direct caller that bypassed the registry can never drive a
// traversal id into a filesystem path. QA finder: KB-Quality-Driver-2.
describe.skipIf(!gitAvailable)('runJobOnce — job-id sink guard (#29 / JOBS-10)', () => {
  const neverRuns: JobBehavior = async () => {
    throw new Error('behavior must not run for an unsafe job id (guard fires first)');
  };

  it('throws on an unsafe job id and creates NO journal / worktree path for it', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const evil: JobConfig = { id: '../../../tmp/evil', type: 'reflect', schedule: 'daily', enabled: true, posture: 'guarded', facing: 'internal' };
      await expect(runJobOnce(stagingWt, evil, neverRuns, lock)).rejects.toThrow(/unsafe id/);
      // The traversal target outside `.kb/jobs` was never written (journalRel would have escaped there).
      expect(await pathExists(path.join(stagingWt, '..', '..', '..', 'tmp', 'evil'))).toBe(false);
      // No per-job worktree was minted for the bad id either.
      expect(await pathExists(path.join(stagingWt, '.kb', 'cache', 'worktrees', 'job-../../../tmp/evil'))).toBe(false);
    });
  });

  it('a safe id still runs (regression — the guard only rejects unsafe ids)', async () => {
    await withVault(async (root, stagingWt, lock) => {
      await commitOnStaging(stagingWt, { 'entities/person/steve.md': '---\nid: 01E\nname: Steve\n---\n# Steve\n' });
      const res = await runJobOnce(stagingWt, exampleJob, exampleJobBehavior, lock);
      expect(res.outcome).toBe('advanced');
    });
  });
});
