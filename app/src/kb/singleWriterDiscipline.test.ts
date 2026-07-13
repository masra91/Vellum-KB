// #517 regression: watch/intake/researcher schedulers used to call `captureToInbox` UNLOCKED, racing
// stage advances/promotes and each other on the same git index — the mechanism behind intermittent
// `index.lock: File exists` failures and (BUG-10) foreign staged state bleeding into an unrelated
// commit. This is the "stress test: N interleaved writers on one repo → zero index.lock errors; linear
// history" acceptance criterion from the issue, exercised against the REAL functions (not mocks) now
// that watch/intake both accept + use the shared lock (`RunWatchDeps.lock` / `RunIntakeDeps.lock`).
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { createKb, ensureGitIdentity } from './vault';
import { ensureStagingWorktree } from './stagingWorktree';
import { Mutex } from './stageLock';
import { captureToInbox } from './ingest';
import { ingestWatchedFile } from './watchRun';
import { runIntakeConnector } from './intakeRun';
import type { WatchFolderConfig } from './watchConnectors';
import type { IntakeConnectorConfig, IntakeItem } from './intakeConnectors';

const watchConfig: WatchFolderConfig = {
  id: 'w1',
  folderPath: '/tmp/unused-in-this-test',
  scope: 'personal',
  sensitivity: 'normal',
  recursive: false,
  enabled: true,
};

const intakeConfig: IntakeConnectorConfig = {
  id: 'i1',
  type: 'rss',
  config: { url: 'https://example.invalid/feed' },
  scope: 'personal',
  sensitivity: 'normal',
  schedule: 'daily',
  enabled: true,
};

describe.skipIf(!gitAvailable)('#517 single-writer discipline — concurrent writers on one shared lock', () => {
  it('20 interleaved captures (orchestrator-style, watch, and intake) through ONE shared lock: zero index.lock races, every capture lands', async () => {
    const dir = await makeTempDir();
    try {
      const root = path.join(dir, 'vault');
      await createKb({ path: root, initGitIfNeeded: true });
      const stagingWt = await ensureStagingWorktree(root);
      const lock = new Mutex();

      const N = 20;
      const tasks: Array<Promise<unknown>> = [];
      for (let i = 0; i < N; i++) {
        const kind = i % 3;
        if (kind === 0) {
          // Orchestrator-style: the caller wraps captureToInbox in lock.run itself (the existing
          // correct pattern, e.g. Orchestrator.capture()).
          tasks.push(lock.run(() => captureToInbox(stagingWt, 'test-orch', [{ kind: 'text', text: `orch ${i}` }], Date.now() + i), `capture-${i}`));
        } else if (kind === 1) {
          // Watch-style: the scheduler threads the SAME shared lock into ingestWatchedFile.
          const data = new TextEncoder().encode(`watched content ${i}`);
          tasks.push(ingestWatchedFile(stagingWt, watchConfig, `file-${i}.txt`, data, Date.now() + i, new Date().toISOString(), undefined, lock));
        } else {
          // Intake-style: the scheduler threads the SAME shared lock into runIntakeConnector.
          const item: IntakeItem = { externalId: `item-${i}`, title: `Item ${i}`, contentMd: `body ${i}`, publishedAt: new Date().toISOString() };
          tasks.push(
            runIntakeConnector(stagingWt, intakeConfig, {
              fetch: async () => [item],
              now: () => new Date().toISOString(),
              lock,
            }),
          );
        }
      }

      // All 20 interleaved writers settle with no rejection (fails-before: an unlocked mix of these
      // three call sites intermittently throws `index.lock: File exists` under real concurrency).
      const results = await Promise.allSettled(tasks);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toEqual([]);

      // Linear history: every one of the 20 writers produced exactly one commit, serialized.
      const git = simpleGit(stagingWt);
      await ensureGitIdentity(git);
      const log = await git.log();
      // seed commit(s) from createKb/ensureStagingWorktree + one commit per writer.
      expect(log.total).toBeGreaterThanOrEqual(N + 1);
      // No merge commits / no stray parallel branches — a linear chain (each commit has exactly 1 parent,
      // save the root).
      const allCommits = log.all;
      for (const c of allCommits) {
        const parents = (await git.raw('log', '-1', '--pretty=%P', c.hash)).trim();
        const parentCount = parents.length === 0 ? 0 : parents.split(' ').length;
        expect(parentCount).toBeLessThanOrEqual(1);
      }
    } finally {
      await rmTempDir(dir);
    }
  });
});
