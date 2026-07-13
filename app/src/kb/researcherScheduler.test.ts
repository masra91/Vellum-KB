// Scheduled-researcher tick (SPEC-0028 RESEARCH-2; Option (a)). Real FS+git temp vault (TEST-18);
// cognition (research) injected deterministically — no network. Cadence/due/single-flight mirror
// JobScheduler but the body is runResearcher (ingest), keeping JOBS-10 intact.
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { upsertResearcher } from './researcherRegistry';
import { readEvents } from './activityIndex';
import * as activityIndexModule from './activityIndex';
import { ResearcherScheduler, isResearcherDue, standingRequest } from './researcherScheduler';
import type { ResearchFn } from './researchRun';
import type { ResearcherConfig } from './researchers';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    await fn(root);
  } finally {
    await rmTempDir(dir);
  }
}

const web = (over: Partial<ResearcherConfig> = {}): ResearcherConfig => ({
  id: 'web-1', template: 'web', prompt: 'p', egressTier: 'public-web', scope: 'global',
  budget: { maxToolCalls: 8, maxDepth: 2 }, schedule: 'daily', posture: 'guarded', enabled: true, topics: ['atlas'], ...over,
});
const stub: ResearchFn = async (_r, req) => ({ found: true, note: `note on ${req.what}`, citations: ['https://example.com/x'], query: req.what });
const DAY = 24 * 60 * 60 * 1000;

describe('standingRequest', () => {
  it('builds a request from the researcher topic/label, marked scheduler-originated', () => {
    const r = standingRequest(web({ topics: ['atlas'] }), 'rid', '2026-06-02T00:00:00.000Z');
    expect(r).toMatchObject({ what: 'atlas', by: { stage: 'scheduler' }, why: 'scheduled standing research' });
  });
});

describe.skipIf(!gitAvailable)('isResearcherDue', () => {
  it('enabled+scheduled never-run → due; off/disabled → not due', async () => {
    await withVault(async (root) => {
      expect(await isResearcherDue(root, web({ schedule: 'daily', enabled: true }), Date.now())).toBe(true);
      expect(await isResearcherDue(root, web({ schedule: 'off' }), Date.now())).toBe(false);
      expect(await isResearcherDue(root, web({ enabled: false }), Date.now())).toBe(false);
    });
  });
});

describe.skipIf(!gitAvailable)('ResearcherScheduler.tick (RESEARCH-2, Option a)', () => {
  it('runs a due researcher → writes a secondary source + audit, then is not due within the interval', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', schedule: 'daily', enabled: true }));
      const sched = new ResearcherScheduler(root, { researchFn: stub });
      const t0 = Date.parse('2026-06-02T00:00:00.000Z');

      const fired1 = await sched.tick(t0);
      expect(fired1).toEqual(['web-1']);
      const events1 = await readEvents(root, { actors: ['researcher'], subjectId: 'web-1' });
      expect(events1.some((e) => e.eventType === 'researched')).toBe(true);

      // Within the daily interval → not due → no second run.
      const fired2 = await sched.tick(t0 + 60_000);
      expect(fired2).toEqual([]);
    });
  });

  it('re-runs the same standing topic after the interval (cadence, NOT dedup-blocked)', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', schedule: 'daily', enabled: true }));
      const sched = new ResearcherScheduler(root, { researchFn: stub });
      const t0 = Date.parse('2026-06-02T00:00:00.000Z');
      await sched.tick(t0);
      const after = await sched.tick(t0 + DAY + 1000); // a day later → due again
      expect(after).toEqual(['web-1']); // standing research re-runs the same topic (no dedup ledger)
      const researched = (await readEvents(root, { actors: ['researcher'], subjectId: 'web-1' })).filter((e) => e.eventType === 'researched');
      expect(researched.length).toBe(2);
    });
  });

  it('skips disabled/off researchers', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'off', schedule: 'off', enabled: true }));
      await upsertResearcher(root, web({ id: 'disabled', schedule: 'daily', enabled: false }));
      const fired = await new ResearcherScheduler(root, { researchFn: stub }).tick(Date.now());
      expect(fired).toEqual([]);
    });
  });

  // The inline trigger (RESEARCH-3): a stage emits a research-request signal; the tick's sweep routes
  // it through the dispatcher to an enabled researcher. Uses an `off`-schedule researcher so no
  // standing pass fires — isolating the inline path. Cognition is the injected stub (no network).
  it('runs an inline research-request from the audit on tick (off-schedule → no standing pass)', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', schedule: 'off', enabled: true, topics: [] }));
      await fs.mkdir(path.join(root, '.kb'), { recursive: true });
      const sig = JSON.stringify({ ts: '2026-06-02T00:00:00.000Z', stage: 'decompose', event: 'signal', type: 'research-request', what: 'Atlas', note: 'unexplained term', context: 'ship on Atlas', sourceId: 'S1' }) + '\n';
      await fs.appendFile(path.join(root, '.kb', 'audit.jsonl'), sig, 'utf8');

      const fired = await new ResearcherScheduler(root, { researchFn: stub }).tick(Date.parse('2026-06-02T01:00:00.000Z'));
      expect(fired).toEqual([]); // off-schedule → no standing pass fired
      // ...but the inline sweep dispatched the request: a `researched` event for web-1 now exists.
      const researched = (await readEvents(root, { actors: ['researcher'], subjectId: 'web-1' })).filter((e) => e.eventType === 'researched');
      expect(researched.length).toBe(1);
    });
  });

  // #506: isResearcherDue walks the WHOLE audit.jsonl per researcher per tick. Once THIS scheduler
  // instance has run a researcher, its due-check should be served from the in-process lastRunAt memo
  // — no audit read at all for that researcher's due-check (the due-check's distinctive call shape is
  // `readEvents(root, {actors:['researcher'], subjectId})`; the inline sweep's own unrelated
  // `readEvents(root, {})` call is filtered out below so it can't mask a regression).
  it('after a researcher has run once in-process, its due-check no longer walks the audit log', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', schedule: 'daily', enabled: true }));
      const sched = new ResearcherScheduler(root, { researchFn: stub });
      const t0 = Date.parse('2026-06-02T00:00:00.000Z');
      await sched.tick(t0); // cold: falls back to the audit-derived isResearcherDue at least once

      const spy = vi.spyOn(activityIndexModule, 'readEvents');
      try {
        const fired = await sched.tick(t0 + 60_000); // within the daily interval → not due
        expect(fired).toEqual([]);
        const dueCheckCalls = spy.mock.calls.filter(([, opts]) => (opts as { subjectId?: string } | undefined)?.subjectId === 'web-1');
        expect(dueCheckCalls).toHaveLength(0); // served from the in-process memo, zero audit reads
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('a FRESH scheduler instance (process restart) falls back to the audit-derived due-check', async () => {
    await withVault(async (root) => {
      await upsertResearcher(root, web({ id: 'web-1', schedule: 'daily', enabled: true }));
      const t0 = Date.parse('2026-06-02T00:00:00.000Z');
      await new ResearcherScheduler(root, { researchFn: stub }).tick(t0); // "prior process" ran it once

      // A brand-new scheduler instance has no in-process memo — must still get the CORRECT (not-due)
      // answer via the restart-safe audit-derived path.
      const fresh = new ResearcherScheduler(root, { researchFn: stub });
      const fired = await fresh.tick(t0 + 60_000);
      expect(fired).toEqual([]);
    });
  });
});
