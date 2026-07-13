// #507 item 4 — end-to-end proof of the issue's own acceptance criterion: "Lock-contention test: start
// a long link pass, assert a concurrent capture completes without waiting for it (fails today)." Uses
// the REAL `Orchestrator.capture()` production method (not a synthetic `{ priority: true }` test call)
// racing against a realistic queue of background sections already waiting on the SAME shared lock — the
// shape every OTHER stage's canonical advance takes (decompose/claims/compose/connect all share one
// Mutex per vault, SPEC-0014 §5, so several can genuinely queue at once after a burst of new content).
// The pure Mutex-mechanism tests (priority ordering, FIFO-within-lane, no-concurrent-execution) live in
// stageLock.test.ts; this file's job is narrower and different: prove `orchestrator.ts` actually PASSES
// `priority: true` in production, so a future edit that silently drops it fails here, not just in a
// synthetic unit test that wouldn't notice a real call site regressing.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { createKb } from './vault';
import { Orchestrator } from './orchestrator';
import { Mutex } from './stageLock';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withTempVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    await fn(root);
  } finally {
    await rmTempDir(dir);
  }
}

describe.skipIf(!gitAvailable)("#507 item 4 — priority lane end-to-end: a real orchestrator.capture() is never stuck behind a background queue", () => {
  it('resolves before a long queue of already-waiting background sections (a real production capture, not a synthetic priority flag)', async () => {
    await withTempVault(async (root) => {
      const lock = new Mutex();
      const orch = new Orchestrator(root, undefined, lock);

      // Occupy the lock so everything below genuinely QUEUES (not just runs back-to-back) — mirrors
      // the real pipeline moment several stages' sections all become ready at once (a burst of newly-
      // archived sources fans out decompose/claims/compose/connect work simultaneously, SPEC-0014 §5).
      let releaseHolder: () => void = () => {};
      const holderGate = new Promise<void>((r) => (releaseHolder = r));
      const holder = lock.run(async () => holderGate, 'other-stage:holding');

      // Queue 10 background sections — representative of Connect's per-node link/orphan/dedup tail
      // (PERF-E3) or any other stage's advance — each slow enough that draining all 10 sequentially
      // would take far longer than a single capture should ever have to wait. The per-section sleep is
      // generous (100ms ⇒ ≥1s to drain all 10) so the race margin stays robust under full-suite
      // parallel load (a shared-machine timing flake source, not a correctness one — see the elapsed
      // bound below, which only needs to beat that ~1s, not chase a tight budget).
      const backgrounds = Array.from({ length: 10 }, (_, i) => lock.run(() => sleep(100), `other-stage:section-${i}`));

      // The REAL production call — proves `orchestrator.ts`'s `capture()` actually passes
      // `priority: true` through to `lock.run`, not just that the Mutex CAN reorder when told to.
      const startedAt = Date.now();
      const captured = orch.capture('test', [{ kind: 'text', text: 'a concurrent capture' }]);

      releaseHolder();
      const outcome = await Promise.race([
        captured.then(() => 'captured' as const),
        Promise.all(backgrounds).then(() => 'backgrounds-drained-first' as const),
      ]);
      const elapsedMs = Date.now() - startedAt;

      // The load-bearing assertion is WHICH promise settled first (fails-loud, not fails-slow, if a
      // future edit drops `{ priority: true }` from orchestrator.ts's capture()) — draining all 10
      // background sections first would take ≥1s doing it. The elapsed bound is a secondary sanity
      // check only, generously loose so it can't flake under shared-machine/full-suite load.
      expect(outcome).toBe('captured');
      expect(elapsedMs).toBeLessThan(700);

      await holder;
      await Promise.all(backgrounds); // drain cleanly — no leaked timers/state
      await captured;
    });
  });
});
