// Reflect job behavior (SPEC-0024): bounded working-set selection + finding→disposition mapping,
// plus one e2e through the JOBS engine. Working-set unit tests need no git (just entity files);
// the e2e uses real git + the runtime.
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
import { runJobOnce, readJournal } from './jobStage';
import { makeReflectJobBehavior, REFLECT_WORKING_SET_SIZE, REFLECT_JOB_TYPE, filterStatefulFindings } from './reflectJob';
import { makeReflectDecider } from './reflectAgent';
import { writeReviewFile, reviewRel, answerReview, findOpenReviews } from './reviewStore';
import { recordConsolidationDirective, readConsolidationDirectives, consolidationDirectiveForPair, readContradictionDirectives, openContradictionsForIdentity, contradictionForKey } from './directives';
import { recordDisambiguationDecision } from './disambiguationDecisions';
import { ulid } from './ulid';
import type { Review } from './reviews';
import type { ReflectContext, ReflectDecider, ReflectFinding } from './reflectAgent';
import type { JobConfig, JobPassContext, JournalEntry } from './jobs';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

/** Write `n` entity nodes under root/entities/person (no git needed for the behavior unit tests). */
async function seedEntities(root: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const rel = path.join('entities', 'person', `e${String(i).padStart(3, '0')}.md`);
    const dest = path.join(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, `---\nid: 01E${i}\nkind: person\nname: E${i}\ntags: ["type/person"]\n---\n\n# E${i}\n\nbody ${i}\n`, 'utf8');
  }
}

/** Rewrite the SAME entity files with FRESH ULIDs but identical content — simulates the re-derive /
 *  Full Replay rebirth that purges + rebuilds entities/ (ULID changes, block identity stays). */
async function rebirthEntities(root: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const dest = path.join(root, 'entities', 'person', `e${String(i).padStart(3, '0')}.md`);
    await fs.writeFile(dest, `---\nid: ${ulid()}\nkind: person\nname: E${i}\ntags: ["type/person"]\n---\n\n# E${i}\n\nbody ${i}\n`, 'utf8');
  }
}

const ctxWith = (root: string, journal: JournalEntry[] = []): JobPassContext => ({ root, posture: 'guarded', journal });

/** A decider that records the context it saw and returns configurable findings. */
function captureDecider(out: ReflectContext[], findings: ReflectFinding[] = []): ReflectDecider {
  return async (ctx) => {
    out.push(ctx);
    return { inspected: 'ran', findings };
  };
}

describe('makeReflectJobBehavior — bounded working-set selection (REFLECT-2)', () => {
  it('empty KB → a graceful no-op pass (REFLECT-6)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await fs.mkdir(root, { recursive: true });
      const seen: ReflectContext[] = [];
      const res = await makeReflectJobBehavior(captureDecider(seen))(ctxWith(root));
      expect(res.findings).toEqual([]);
      expect(res.cursor).toEqual({ offset: 0, count: 0 });
      expect(res.inspected).toContain('empty KB');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('feeds the decider a BOUNDED slice (≤ size) and advances the cursor', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, REFLECT_WORKING_SET_SIZE + 5); // 20 nodes
      const seen: ReflectContext[] = [];
      const res = await makeReflectJobBehavior(captureDecider(seen))(ctxWith(root));
      expect(seen[0].workingSet.length).toBe(REFLECT_WORKING_SET_SIZE); // never the whole KB
      expect(res.cursor).toEqual({ offset: REFLECT_WORKING_SET_SIZE, count: 20 });
    } finally {
      await rmTempDir(dir);
    }
  });

  it('round-robins coverage via the journal cursor (wraps the end)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 20);
      const seen: ReflectContext[] = [];
      const journal: JournalEntry[] = [{ ts: '2026-06-01T00:00:00Z', runId: 'r', inspected: 'prev', applied: 0, deferred: 0, cursor: { offset: 15, count: 20 } }];
      const res = await makeReflectJobBehavior(captureDecider(seen))(ctxWith(root, journal));
      expect(seen[0].workingSet.length).toBe(REFLECT_WORKING_SET_SIZE); // 5 from tail + 10 wrapped from head
      expect(res.cursor).toEqual({ offset: 10, count: 20 }); // (15 + 15) % 20
    } finally {
      await rmTempDir(dir);
    }
  });

  it('passes a churn hint when the KB grew since the last run (REFLECT-2)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 8);
      const seen: ReflectContext[] = [];
      const journal: JournalEntry[] = [{ ts: '2026-06-01T00:00:00Z', runId: 'r', inspected: 'prev', applied: 0, deferred: 0, cursor: { offset: 0, count: 3 } }];
      await makeReflectJobBehavior(captureDecider(seen))(ctxWith(root, journal));
      expect(seen[0].journalNotes.some((n) => n.includes('churn'))).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('maps additive→auto and destructive→review proposals (REFLECT-4/5)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2);
      const decider: ReflectDecider = async () => ({
        inspected: 'two findings',
        findings: [
          { summary: 'add claim', kind: 'additive', confidence: 0.9, writes: [{ rel: 'claims/x.md', content: 'c' }] },
          { summary: 'merge dupes', kind: 'destructive', confidence: 0.6, review: { question: 'Merge?' } },
        ],
      });
      const res = await makeReflectJobBehavior(decider)(ctxWith(root));
      expect(res.findings[0]).toMatchObject({ kind: 'additive', proposed: 'auto', writes: [{ rel: 'claims/x.md', content: 'c' }] });
      expect(res.findings[1]).toMatchObject({ kind: 'destructive', proposed: 'review', review: { question: 'Merge?' } });
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('Reflect job e2e through the JOBS engine (SPEC-0024 / SPEC-0023)', () => {
  it('runs a rumination pass: additive finding auto-applies + promotes; destructive → Review', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      // Seed an entity on staging so the working set is non-empty.
      await fs.mkdir(path.join(stagingWt, 'entities', 'person'), { recursive: true });
      await fs.writeFile(path.join(stagingWt, 'entities/person/steve.md'), '---\nid: 01E\nkind: person\nname: Steve\ntags: ["type/person"]\n---\n# Steve\n', 'utf8');
      await simpleGit(stagingWt).add('-A').then(() => simpleGit(stagingWt).commit('seed'));

      const decider: ReflectDecider = async () => ({
        inspected: 'rumination',
        findings: [
          { summary: 'emergent topic note', kind: 'additive', confidence: 1, writes: [{ rel: 'outputs/reflect/topics.md', content: '# Topics\n' }] },
          { summary: 'retire stale node', kind: 'destructive', confidence: 0.7, review: { question: 'Retire X?' } },
        ],
      });
      const job: JobConfig = { id: 'reflect', type: REFLECT_JOB_TYPE, schedule: 'several-daily', enabled: true, posture: 'guarded', facing: 'internal' };
      const res = await runJobOnce(stagingWt, job, makeReflectJobBehavior(decider), lock);
      expect(res.applied).toBe(1); // additive
      expect(res.deferred).toBe(1); // destructive → Review (guarded)

      await promote(root);
      expect(await pathExists(path.join(root, 'outputs/reflect/topics.md'))).toBe(true); // additive on main (REFLECT-7)
      expect(await pathExists(path.join(stagingWt, 'reviews'))).toBe(true); // destructive raised a Review
      const journal = await readJournal(stagingWt, 'reflect');
      expect(journal[0].cursor?.count).toBe(1); // working-set cursor journaled (REFLECT-8)
    } finally {
      await rmTempDir(dir);
    }
  });

  // SPEC-0036 CONTRA acceptance — the full lifecycle through the real engine: a detected contradiction
  // raises a Review AND flags the entity durably (needs-you), and answering the review CLEARS the flag.
  it('CONTRA: a contradiction finding raises a Review + a durable entity flag; resolving clears the flag', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();
      // Seed the entity the contradiction is about, on staging (so jobStage can resolve its block identity).
      await fs.mkdir(path.join(stagingWt, 'entities', 'person'), { recursive: true });
      await fs.writeFile(path.join(stagingWt, 'entities/person/ada.md'), '---\nid: 01ADA\nkind: person\nname: Ada Lovelace\ntags: ["type/person"]\n---\n# Ada Lovelace\n', 'utf8');
      await simpleGit(stagingWt).add('-A').then(() => simpleGit(stagingWt).commit('seed'));

      // The REAL decider path (makeReflectDecider + injected runner) so the contradiction prompt-contract
      // is exercised end-to-end — the agent reports a birth-year disagreement on the one entity.
      const decider = makeReflectDecider({
        available: true,
        run: async () =>
          JSON.stringify({
            inspected: 'rumination over Ada',
            findings: [
              {
                summary: 'birth year disagrees across sources',
                kind: 'destructive',
                confidence: 0.6,
                review: {
                  question: 'Ada Lovelace born 1815 or 1816 — supersede with the newer source (confirm) or keep both (reject)?',
                  detail: 'Two sources give different birth years.',
                  contradiction: { entityRel: 'entities/person/ada.md', statementA: 'Born in 1815.', statementB: 'Born in 1816.' },
                },
              },
            ],
          }),
      });
      const job: JobConfig = { id: 'reflect', type: REFLECT_JOB_TYPE, schedule: 'several-daily', enabled: true, posture: 'guarded', facing: 'internal' };
      const res = await runJobOnce(stagingWt, job, makeReflectJobBehavior(decider), lock);
      expect(res.deferred).toBe(1); // routed to Review (guarded), no destructive write

      const IDENTITY = 'person|ada lovelace'; // blockKey(person, Ada Lovelace) — content-derived, rebirth-stable

      // (1) review-item: an OPEN contradiction Review exists, carrying the stable identity in its markerKey.
      const open = await findOpenReviews(stagingWt);
      const contraReview = open.find((r) => r.raisedBy.markerKey.kind === 'contradiction');
      expect(contraReview).toBeDefined();
      expect(contraReview!.raisedBy.markerKey.identityKey).toBe(IDENTITY);

      // (2) entity-flag: a durable contradiction flag on the entity in `needs-you` — recorded in the SAME
      // commit as the Review (atomic at detection).
      const flags = await readContradictionDirectives(stagingWt);
      expect(openContradictionsForIdentity(flags, IDENTITY)).toHaveLength(1);
      expect(contradictionForKey(flags, IDENTITY, 'Born in 1815.', 'Born in 1816.')?.state).toBe('needs-you');

      // (3) flag clears on resolve: answering CONFIRM transitions the flag to `resolved`; it leaves the
      // needs-you queue. The claim files are untouched (CONTRA-4 retains both — we only nudge the flag).
      const ans = await answerReview(stagingWt, lock, contraReview!.id, { verdict: 'confirm' });
      expect(ans.ok).toBe(true);
      const after = await readContradictionDirectives(stagingWt);
      expect(openContradictionsForIdentity(after, IDENTITY)).toHaveLength(0); // flag cleared
      expect(contradictionForKey(after, IDENTITY, 'Born in 1815.', 'Born in 1816.')?.state).toBe('resolved');
    } finally {
      await rmTempDir(dir);
    }
  });
});

// REFLECT-18 — a bad agent pass must NOT crash the Reflect job. KB-Lead saw it live: `job.failed
// JSON.parse SyntaxError` from unparseable agent output. The pass sets the slice aside (advances the
// cursor so the next run moves on, not re-stuck) and continues; never fabricates a finding.
describe.skipIf(!gitAvailable)('makeReflectJobBehavior — crash-robustness (REFLECT-18)', () => {
  it('an UNPARSEABLE agent pass (through the real decider) sets the slice aside + advances, never throws', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, REFLECT_WORKING_SET_SIZE + 5); // 20 nodes
      // The REAL agent path: makeReflectDecider over an injected runner returning non-JSON output → its
      // parseReflectResult throws. FAILS-BEFORE: that throw propagated out → job.failed. PASSES-AFTER:
      // the behavior catches it and returns a graceful skipped-slice pass.
      const decider = makeReflectDecider({ available: true, run: async () => 'I pondered the graph but emitted { not json' });
      const res = await makeReflectJobBehavior(decider)(ctxWith(root)); // must NOT throw
      expect(res.findings).toEqual([]); // no fabricated findings from a failed pass
      expect(res.cursor).toEqual({ offset: REFLECT_WORKING_SET_SIZE, count: 20 }); // advanced — slice set aside, next run moves on
      expect(res.inspected).toMatch(/skipped a slice|agent pass failed/i); // honestly journaled
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a decider that THROWS (agent/runtime error, not just a parse) is also caught — the run continues', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 20);
      const throwing: ReflectDecider = async () => { throw new Error('reflect: copilot session crashed'); };
      const res = await makeReflectJobBehavior(throwing)(ctxWith(root));
      expect(res.findings).toEqual([]);
      expect(res.cursor?.offset).toBe(REFLECT_WORKING_SET_SIZE); // advanced
      expect(res.inspected).toMatch(/skipped a slice|session crashed/i);
    } finally {
      await rmTempDir(dir);
    }
  });
});

// REFLECT-14 — stateful: never re-raise an open or already-decided finding (the open Review IS the
// state). The Principal: "I get it bubbling up the same reviews every time and it doesn't act on them."
describe.skipIf(!gitAvailable)('Reflect is stateful — no re-raise of open/decided findings (REFLECT-14)', () => {
  const CANON = 'entities/person/e000.md';
  const LOSER = 'entities/person/e001.md';

  async function openConsolidationReview(root: string): Promise<void> {
    const id = ulid();
    const review: Review = {
      id, status: 'open', question: 'Merge E1 into E0?', detail: 'same entity?',
      raisedBy: {
        stage: 'job:reflect', runId: 'r0', item: { kind: 'job', ref: '.kb/jobs/reflect/journal.jsonl' },
        auditRel: '.kb/jobs/reflect/journal.jsonl',
        markerKey: { jobId: 'reflect', runId: 'r0', kind: 'consolidation', canonicalRel: CANON, loserRels: LOSER },
      },
      subject: {}, createdAt: '2026-06-01T00:00:00Z',
    };
    await writeReviewFile(path.join(root, reviewRel(id)), review);
  }

  const consolidationDecider = () =>
    makeReflectDecider({
      available: true,
      run: async () => JSON.stringify({
        inspected: 'dedup pass',
        findings: [{ summary: 'merge E1 into E0', kind: 'destructive', confidence: 0.6, review: { question: 'Merge E1 into E0?', consolidation: { canonicalRel: CANON, loserRels: [LOSER] } } }],
      }),
    });

  it('does NOT re-raise a consolidation already OPEN as a Review (suppressed by plan signature)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2);
      await openConsolidationReview(root); // a prior run already raised this exact merge
      const res = await makeReflectJobBehavior(consolidationDecider())(ctxWith(root));
      expect(res.findings).toEqual([]); // FAILS-BEFORE: the same review re-raised every run
      expect(res.inspected).toMatch(/suppressed/);
    } finally { await rmTempDir(dir); }
  });

  it('does NOT re-raise a consolidation whose entity-pair is already DECIDED (REVIEW-18)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2); // ids 01E0, 01E1
      await recordDisambiguationDecision(root, { a: '01E0', b: '01E1', verdict: 'distinct', reviewId: 'R', decidedAt: '2026-06-01T00:00:00Z' });
      const res = await makeReflectJobBehavior(consolidationDecider())(ctxWith(root));
      expect(res.findings).toEqual([]); // the Principal already ruled these distinct — never re-ask
    } finally { await rmTempDir(dir); }
  });

  // SPEC-0050 slice-2: the durable CONSOLIDATION DIRECTIVE keyed on STABLE block identities is what
  // makes a settled merge/distinct survive the ULID rebirth that defeats the per-pair ULID decision.
  it('does NOT re-raise a consolidation settled by a durable CONSOLIDATION DIRECTIVE (identity-keyed)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2); // identities person|e0, person|e1
      await recordConsolidationDirective(root, { identityA: 'person|e0', identityB: 'person|e1', verdict: 'distinct', reviewId: 'R', decidedAt: '2026-06-01T00:00:00Z' });
      const res = await makeReflectJobBehavior(consolidationDecider())(ctxWith(root));
      expect(res.findings).toEqual([]); // settled distinct by directive — never re-ask
    } finally { await rmTempDir(dir); }
  });

  it('the directive SURVIVES ULID rebirth where the ULID-keyed decision goes blind (the replay bug)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2);
      // The Principal ruled these distinct: legacy decision keyed on the ORIGINAL ULIDs + durable
      // directive keyed on the stable identities, exactly as answerReview records both.
      await recordDisambiguationDecision(root, { a: '01E0', b: '01E1', verdict: 'distinct', reviewId: 'R', decidedAt: '2026-06-01T00:00:00Z' });
      await recordConsolidationDirective(root, { identityA: 'person|e0', identityB: 'person|e1', verdict: 'distinct', reviewId: 'R', decidedAt: '2026-06-01T00:00:00Z' });
      await rebirthEntities(root, 2); // re-derive/replay → fresh ULIDs, same identities
      const res = await makeReflectJobBehavior(consolidationDecider())(ctxWith(root));
      expect(res.findings).toEqual([]); // STILL suppressed — only the identity directive can carry it now
    } finally { await rmTempDir(dir); }
  });

  it('CONTROL: the ULID decision ALONE goes blind after rebirth (this is the bug the directive fixes)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2);
      await recordDisambiguationDecision(root, { a: '01E0', b: '01E1', verdict: 'distinct', reviewId: 'R', decidedAt: '2026-06-01T00:00:00Z' });
      await rebirthEntities(root, 2); // fresh ULIDs → the ULID-keyed decision no longer matches
      const res = await makeReflectJobBehavior(consolidationDecider())(ctxWith(root));
      expect(res.findings).toHaveLength(1); // re-raises — proving the directive (above) is what carries it
    } finally { await rmTempDir(dir); }
  });

  it('DOES raise a FRESH finding, and an additive high-confidence finding passes through (auto-applies)', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2);
      const decider = makeReflectDecider({
        available: true,
        run: async () => JSON.stringify({
          inspected: 'mixed',
          findings: [
            { summary: 'add emergent topic', kind: 'additive', confidence: 0.95, writes: [{ rel: 'outputs/reflect/t.md', content: '# T' }] },
            { summary: 'merge E1 into E0', kind: 'destructive', confidence: 0.6, review: { question: 'Merge E1 into E0?', consolidation: { canonicalRel: CANON, loserRels: [LOSER] } } },
          ],
        }),
      });
      const res = await makeReflectJobBehavior(decider)(ctxWith(root)); // nothing open, nothing decided
      expect(res.findings).toHaveLength(2); // both pass: additive→auto, fresh consolidation→review
      expect(res.findings.find((f) => f.kind === 'additive')?.proposed).toBe('auto');
      expect(res.findings.find((f) => f.kind === 'destructive')?.proposed).toBe('review');
    } finally { await rmTempDir(dir); }
  });

  it('filterStatefulFindings: additive always passes; an open-question dup is suppressed', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await seedEntities(root, 2);
      await openConsolidationReview(root); // its question is "Merge E1 into E0?"
      const { live, suppressed } = await filterStatefulFindings(root, [
        { summary: 'a', kind: 'additive', confidence: 1, writes: [{ rel: 'outputs/x.md', content: 'x' }] },
        { summary: 'dup by question', kind: 'destructive', confidence: 0.5, review: { question: 'merge e1 into e0?' } }, // case/space-insensitive match
      ]);
      expect(live).toHaveLength(1); // only the additive
      expect(live[0].kind).toBe('additive');
      expect(suppressed).toBe(1);
    } finally { await rmTempDir(dir); }
  });
});

// SPEC-0050 slice-2 producer: answering a Reflect consolidation review graduates the verdict to a
// durable consolidation directive keyed on the STABLE block identities (the half that survives replay).
describe.skipIf(!gitAvailable)('Reflect consolidation answer → durable directive (SPEC-0050 slice-2)', () => {
  const CANON = 'entities/person/e000.md';
  const LOSER = 'entities/person/e001.md';

  async function openConsolidationReviewWithId(root: string): Promise<string> {
    const id = ulid();
    const review: Review = {
      id, status: 'open', question: 'Merge E1 into E0?', detail: 'same entity?',
      raisedBy: {
        stage: 'job:reflect', runId: 'r0', item: { kind: 'job', ref: '.kb/jobs/reflect/journal.jsonl' },
        auditRel: '.kb/jobs/reflect/journal.jsonl',
        markerKey: { jobId: 'reflect', runId: 'r0', kind: 'consolidation', canonicalRel: CANON, loserRels: LOSER },
      },
      subject: {}, createdAt: '2026-06-01T00:00:00Z',
    };
    await writeReviewFile(path.join(root, reviewRel(id)), review);
    await fs.mkdir(path.join(root, '.kb', 'jobs', 'reflect'), { recursive: true }); // audit marker target dir
    return id;
  }

  it('reject → records a DISTINCT directive on the block-identity pair', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      await seedEntities(root, 2); // identities person|e0, person|e1
      const id = await openConsolidationReviewWithId(root);
      await answerReview(root, new Mutex(), id, { verdict: 'reject' });
      const map = await readConsolidationDirectives(root);
      expect(consolidationDirectiveForPair(map, 'person|e0', 'person|e1')?.verdict).toBe('distinct');
    } finally { await rmTempDir(dir); }
  });

  it('confirm → records a MERGE directive on the block-identity pair', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      await seedEntities(root, 2);
      const id = await openConsolidationReviewWithId(root);
      await answerReview(root, new Mutex(), id, { verdict: 'confirm' });
      const map = await readConsolidationDirectives(root);
      expect(consolidationDirectiveForPair(map, 'person|e0', 'person|e1')?.verdict).toBe('merge');
    } finally { await rmTempDir(dir); }
  });
});
