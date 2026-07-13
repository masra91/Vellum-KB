// Derived activity index (SPEC-0029 AUDIT-4/7/10). Real FS + git against throwaway temp vaults
// (TEST-18). Two tiers: (1) hand-written audit files exercise the walker / cap / cache / freshness
// / filter precisely; (2) an integration test runs REAL stages so the normalizer is proven against
// the shapes the emitters actually write — not just hand-crafted ones.
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { appendAuditEvent } from './audit';
import { captureToInbox } from './ingest';
import { archiveOne, readQueue } from './orchestrator';
import { deterministicDecider } from './archivist';
import { decomposeOne, readDecomposeQueue } from './decomposeStage';
import type { DecomposeDecider } from './decomposeAgent';
import {
  buildActivityIndex,
  loadActivityIndex,
  readAllAuditEvents,
  readActivityIndexCache,
  writeActivityIndexCache,
  filterEvents,
  readEvents,
  ACTIVITY_INDEX_REL,
  ACTIVITY_INDEX_VERSION,
} from './activityIndex';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withTempVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

/** Append JSONL lines to a vault-relative audit file (creating dirs). */
async function writeAudit(root: string, rel: string, lines: Record<string, unknown>[]): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

/** Commit everything on the vault's current branch so HEAD advances (for freshness tests). */
async function commitAll(root: string, msg: string): Promise<void> {
  const git = simpleGit(root);
  await git.raw('add', '-A');
  await git.commit(msg);
}

/** A spread of realistic audit across all source files. */
async function seedAudit(root: string): Promise<void> {
  await writeAudit(root, path.join('sources', '2026', '01', 'S1', 'audit.jsonl'), [
    { action: 'archived', id: 'S1', archivedAt: '2026-01-01T00:00:00.000Z', decision: { route: 'keep' }, agent: { via: 'deterministic' } },
    { ts: '2026-01-01T00:01:00.000Z', stage: 'decompose', runId: 'D1', sourceId: 'S1', model: 'm', event: 'decomposed', candidates: 2 },
    { ts: '2026-01-01T00:02:00.000Z', stage: 'claims', runId: 'C1', entityId: 'E1', sourceId: 'S1', model: 'm', event: 'claimed', claims: 3 },
  ]);
  await writeAudit(root, path.join('connect', 'audit.jsonl'), [
    { ts: '2026-01-01T00:03:00.000Z', stage: 'connect', runId: 'N1', blockKey: 'person|atlas', model: 'm', event: 'resolved', node: 'entities/2026/01/E1.md', candidates: 2, merged: 1 },
  ]);
  await writeAudit(root, path.join('.kb', 'jobs', 'reflect', 'journal.jsonl'), [
    { ts: '2026-01-01T00:04:00.000Z', runId: 'J1', inspected: 5, applied: 1, deferred: 0 },
  ]);
  await writeAudit(root, path.join('.kb', 'cache', 'ask', 'audit.jsonl'), [
    { ts: '2026-01-01T00:05:00.000Z', event: 'recall', question: 'who is Atlas?', grounded: true },
  ]);
}

describe.skipIf(!gitAvailable)('readAllAuditEvents — the walker (AUDIT-4/10)', () => {
  it('aggregates every audit source into canonical events, newest-first', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedAudit(root);
      const events = await readAllAuditEvents(root);
      expect(events.map((e) => e.actor)).toEqual(['recall', 'job', 'connect', 'claims', 'decompose', 'archivist']);
      // working-zone (.kb, connect) AND evergreen (sources) are both covered (AUDIT-10).
      expect(events.find((e) => e.actor === 'archivist')!.subjects.sourceId).toBe('S1');
      expect(events.find((e) => e.actor === 'job')!.subjects.jobId).toBe('reflect');
      expect(events.find((e) => e.actor === 'connect')!.subjects.entityId).toBe('E1');
      // provenance points back at the raw line for drill-down.
      expect(events.find((e) => e.actor === 'decompose')!.provenance).toEqual({ file: path.join('sources', '2026', '01', 'S1', 'audit.jsonl'), line: 1 });
    });
  });

  it('picks up the cross-cutting control log written by appendAuditEvent (panel actor)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await appendAuditEvent(root, { actor: 'panel', eventType: 'job-config-change', subjects: { jobId: 'reflect' }, payload: { field: 'enabled', from: false, to: true, why: 'Principal change' }, ts: '2026-02-01T00:00:00.000Z' });
      const events = await readAllAuditEvents(root);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor: 'panel', eventType: 'job-config-change' });
      expect(events[0].provenance.file).toBe(path.join('.kb', 'audit.jsonl'));
      // readEvents convenience: read + filter in one call.
      expect(await readEvents(root, { actors: ['panel'] })).toHaveLength(1);
      expect(await readEvents(root, { subjectId: 'reflect' })).toHaveLength(1);
      expect(await readEvents(root, { actors: ['claims'] })).toHaveLength(0);
    });
  });

  it('tolerates malformed lines and an empty/absent vault', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      expect(await readAllAuditEvents(root)).toEqual([]); // nothing audited yet
      await writeAudit(root, path.join('connect', 'audit.jsonl'), []);
      await fs.appendFile(path.join(root, 'connect', 'audit.jsonl'), 'not json\n{"ts":"2026-01-01T00:00:00.000Z","stage":"connect","event":"connected","clusters":1}\n');
      const events = await readAllAuditEvents(root);
      expect(events).toHaveLength(1); // the malformed line is skipped
      expect(events[0].eventType).toBe('connected');
    });
  });

  // Regression (SPEC-0029 AUDIT-6/10): post-SCALE-5, connect writes its RESOLVE (entity-merge) audit
  // PER-BLOCK under `connect/blocks/*.jsonl`, not the legacy shared `connect/audit.jsonl`. The walker
  // must read those per-block files or connect's transformations vanish from the feed/lineage/source
  // trace whenever cap>1 (the default). Fails-before (walker only read connect/audit.jsonl) → passes-after.
  it('reads connect RESOLVE audit from the per-block connect/blocks/*.jsonl files (SCALE-5)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // Two concurrent blocks, each its own disjoint per-block file (the SCALE-5 layout). No shared
      // connect/audit.jsonl is written for resolves at cap>1.
      await writeAudit(root, path.join('connect', 'blocks', 'person-atlas-1a2b3c4d.jsonl'), [
        { ts: '2026-01-01T00:03:00.000Z', stage: 'connect', runId: 'N1', blockKey: 'person|atlas', model: 'm', event: 'resolved', node: 'entities/2026/01/E1.md', candidates: 2, merged: 1 },
      ]);
      await writeAudit(root, path.join('connect', 'blocks', 'org-acme-9f8e7d6c.jsonl'), [
        { ts: '2026-01-01T00:04:00.000Z', stage: 'connect', runId: 'N2', blockKey: 'org|acme', model: 'm', event: 'resolved', node: 'entities/2026/01/E2.md', candidates: 3, merged: 2 },
      ]);
      const events = await readAllAuditEvents(root);
      const connectEvents = events.filter((e) => e.actor === 'connect');
      expect(connectEvents).toHaveLength(2);
      // Each per-block resolve surfaces with its merged entity as the subject (so it joins lineage).
      expect(connectEvents.map((e) => e.subjects.entityId).sort()).toEqual(['E1', 'E2']);
      // Provenance points back at the per-block file + line for raw drill-down (AUDIT-5).
      expect(connectEvents.find((e) => e.subjects.entityId === 'E1')!.provenance.file).toBe(
        path.join('connect', 'blocks', 'person-atlas-1a2b3c4d.jsonl'),
      );
      // And the per-block resolve is reachable by subject filter (AUDIT-7) — what the source trace uses.
      expect(filterEvents(events, { subjectId: 'E2' }).some((e) => e.actor === 'connect')).toBe(true);
    });
  });
});

describe.skipIf(!gitAvailable)('buildActivityIndex — cap + determinism (AUDIT-4)', () => {
  it('is deterministic: same audit on disk → identical events', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedAudit(root);
      const a = await buildActivityIndex(root, { now: () => 'T' });
      const b = await buildActivityIndex(root, { now: () => 'T' });
      expect(a).toEqual(b);
      expect(a.total).toBe(6);
      expect(a.truncated).toBe(false);
    });
  });

  it('caps to the recent window and surfaces truncation — never silently (Q3)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedAudit(root);
      const idx = await buildActivityIndex(root, { window: 2 });
      expect(idx.events).toHaveLength(2);
      expect(idx.total).toBe(6);
      expect(idx.truncated).toBe(true);
      // the newest two survive (recall @00:05, job @00:04).
      expect(idx.events.map((e) => e.actor)).toEqual(['recall', 'job']);
    });
  });
});

describe.skipIf(!gitAvailable)('loadActivityIndex — cache + HEAD-poke freshness (AUDIT-4 / Q2)', () => {
  it('serves the cache while HEAD is unchanged, rebuilds when HEAD moves', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await writeAudit(root, path.join('.kb', 'cache', 'ask', 'audit.jsonl'), [{ ts: '2026-01-01T00:00:00.000Z', event: 'recall', question: 'q1' }]);
      await commitAll(root, 'audit a');

      const idx1 = await loadActivityIndex(root);
      expect(idx1.total).toBe(1);
      expect(await readActivityIndexCache(root)).not.toBeNull(); // cache was written

      // Append more recall audit (working-zone, gitignored) but move nothing — HEAD unchanged →
      // the poke returns the cache as-is (the new working-tree event isn't picked up yet).
      await fs.appendFile(path.join(root, '.kb', 'cache', 'ask', 'audit.jsonl'), JSON.stringify({ ts: '2026-01-02T00:00:00.000Z', event: 'recall', question: 'q2' }) + '\n');
      const idx2 = await loadActivityIndex(root);
      expect(idx2.total).toBe(1); // still cached

      // A tracked change moves HEAD → rebuild folds in the working-tree recall events (the ask
      // audit is gitignored, so it never moves HEAD itself; it's read fresh on the next rebuild).
      await fs.appendFile(path.join(root, 'README.md'), '\nmarker\n');
      await commitAll(root, 'tracked change');
      const idx3 = await loadActivityIndex(root);
      expect(idx3.total).toBe(2);
    });
  });

  it('discards a cache written by an older shape version', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await writeActivityIndexCache(root, { version: ACTIVITY_INDEX_VERSION + 99, builtAt: 'x', head: 'h', total: 1, truncated: false, events: [] });
      expect(await readActivityIndexCache(root)).toBeNull(); // stale shape → ignored
    });
  });

  it('writes the cache under the gitignored .kb/cache (never promoted)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await writeAudit(root, path.join('.kb', 'cache', 'ask', 'audit.jsonl'), [{ ts: '2026-01-01T00:00:00.000Z', event: 'recall', question: 'q' }]);
      await commitAll(root, 'a');
      await loadActivityIndex(root);
      expect(ACTIVITY_INDEX_REL.startsWith(path.join('.kb', 'cache'))).toBe(true);
      await expect(fs.access(path.join(root, ACTIVITY_INDEX_REL))).resolves.toBeUndefined();
    });
  });
});

describe('filterEvents — filter/search (AUDIT-7)', () => {
  it('filters by actor, event-type, subject id, time range, and free text', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedAudit(root);
      const all = await readAllAuditEvents(root);

      expect(filterEvents(all, { actors: ['claims', 'connect'] }).map((e) => e.actor).sort()).toEqual(['claims', 'connect']);
      expect(filterEvents(all, { eventTypes: ['recall'] })).toHaveLength(1);
      expect(filterEvents(all, { subjectId: 'E1' }).map((e) => e.actor).sort()).toEqual(['claims', 'connect']);
      expect(filterEvents(all, { subjectId: 'S1' }).length).toBe(3); // archived + decomposed + claimed all name S1
      expect(filterEvents(all, { since: '2026-01-01T00:04:00.000Z' }).map((e) => e.actor)).toEqual(['recall', 'job']);
      expect(filterEvents(all, { until: '2026-01-01T00:01:00.000Z' }).map((e) => e.actor)).toEqual(['decompose', 'archivist']);
      expect(filterEvents(all, { text: 'atlas' }).length).toBeGreaterThan(0); // matches connect blockKey/recall question
      expect(filterEvents(all, {})).toHaveLength(all.length); // empty filter = identity
    });
  }, 20_000);
});

describe.skipIf(!gitAvailable)('integration — index over REAL stage emission (AUDIT-1/4)', () => {
  it('captures archived + decomposed events the actual stages wrote', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      // Archive a text source via the real archivist, then decompose it via the real stage.
      await captureToInbox(root, 'in-app-panel', [{ kind: 'text', text: 'Atlas is a project led by Mira.' }]);
      const queue = await readQueue(root);
      const sourceRel = await archiveOne(root, queue[queue.length - 1], deterministicDecider);

      const decider: DecomposeDecider = async (input) => ({
        sourceId: input.sourceId,
        entities: [{ kind: 'person', name: 'Mira', confidence: 0.9, mentions: ['Mira'] }],
        agent: { via: 'copilot', model: 'test' },
      });
      const dq = await readDecomposeQueue(root);
      expect(dq.length).toBeGreaterThan(0);
      await decomposeOne(root, dq[0], decider);

      const idx = await buildActivityIndex(root);
      const kinds = idx.events.map((e) => `${e.actor}:${e.eventType}`);
      expect(kinds).toContain('archivist:archived');
      expect(kinds).toContain('decompose:decomposed');
      // the archivist event names the real source id.
      const archived = idx.events.find((e) => e.eventType === 'archived')!;
      expect(archived.subjects.sourceId).toBe(path.basename(sourceRel));
    });
  }, 30_000);
});

// #508 item 3: audit files are append-only; a full re-read of every file on every rebuild was wasted
// once we'd already parsed its earlier bytes. Prove the incremental cache: a byte-identical file costs
// zero content reads, and a grown file re-reads only the bytes appended — never the whole vault.
describe.skipIf(!gitAvailable)('readAllAuditEvents — incremental per-file cache, append-only (#508 item 3)', () => {
  it('a byte-identical file costs ZERO content reads on a second call', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await seedAudit(root);
      const first = await readAllAuditEvents(root);
      expect(first.length).toBeGreaterThan(0);

      const spy = vi.spyOn(fs, 'open');
      try {
        const second = await readAllAuditEvents(root);
        expect(second).toEqual(first); // identical result — the cache didn't drop or duplicate anything
        expect(spy).not.toHaveBeenCalled(); // every file was byte-identical → fs.stat only, no content read
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('appending to ONE file among many re-reads only that file, not a full re-walk', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const FILE_COUNT = 20;
      for (let i = 0; i < FILE_COUNT; i++) {
        await writeAudit(root, path.join('sources', '2026', '01', `S${i}`, 'audit.jsonl'), [
          { action: 'archived', id: `S${i}`, archivedAt: '2026-01-01T00:00:00.000Z', decision: { route: 'keep' }, agent: { via: 'deterministic' } },
        ]);
      }
      const first = await readAllAuditEvents(root);
      expect(first).toHaveLength(FILE_COUNT);

      // Append-only growth on exactly one file (the steady-state case every canonical advance produces).
      await fs.appendFile(
        path.join(root, 'sources', '2026', '01', 'S0', 'audit.jsonl'),
        JSON.stringify({ ts: '2026-01-01T00:01:00.000Z', stage: 'decompose', runId: 'D1', sourceId: 'S0', model: 'm', event: 'decomposed', candidates: 1 }) + '\n',
        'utf8',
      );

      const spy = vi.spyOn(fs, 'open');
      try {
        const second = await readAllAuditEvents(root);
        expect(second).toHaveLength(FILE_COUNT + 1); // the new event is picked up
        expect(spy).toHaveBeenCalledTimes(1); // exactly one file's content was re-read (the fixture: N files, append 1 → 1 re-read)
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('a torn (mid-write) line is never lost — picked up whole once the write completes', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const rel = path.join('sources', '2026', '01', 'S1', 'audit.jsonl');
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const line1 = JSON.stringify({ action: 'archived', id: 'S1', archivedAt: '2026-01-01T00:00:00.000Z', decision: { route: 'keep' }, agent: { via: 'deterministic' } });
      // A complete first line, then a SECOND line written WITHOUT its trailing newline yet (simulates
      // a read landing mid-append) — must not be counted as "consumed" (that would lose it forever).
      await fs.writeFile(abs, `${line1}\n{"ts":"2026-01-01T00:01:00.000Z","stage":"decompose","sourceId":"S1"`, 'utf8');
      const mid = await readAllAuditEvents(root);
      expect(mid).toHaveLength(1); // only the complete line

      // The write "completes" — the torn line gets its closing content + newline appended.
      await fs.appendFile(abs, ',"model":"m","event":"decomposed","candidates":1}\n', 'utf8');
      const after = await readAllAuditEvents(root);
      expect(after).toHaveLength(2); // the previously-torn line is now picked up whole, not skipped
      expect(after.map((e) => e.eventType).sort()).toEqual(['archived', 'decomposed']);
    });
  });

  it('a new audit file appearing later is picked up alongside already-cached files', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await writeAudit(root, path.join('sources', '2026', '01', 'S1', 'audit.jsonl'), [
        { action: 'archived', id: 'S1', archivedAt: '2026-01-01T00:00:00.000Z', decision: { route: 'keep' }, agent: { via: 'deterministic' } },
      ]);
      expect(await readAllAuditEvents(root)).toHaveLength(1);

      await writeAudit(root, path.join('sources', '2026', '01', 'S2', 'audit.jsonl'), [
        { action: 'archived', id: 'S2', archivedAt: '2026-01-01T00:05:00.000Z', decision: { route: 'keep' }, agent: { via: 'deterministic' } },
      ]);
      const events = await readAllAuditEvents(root);
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.subjects.sourceId).sort()).toEqual(['S1', 'S2']);
    });
  });
});
