// #515 BUG-2 regression: macOS Cmd-Q/Dock-Quit never called `stopPipeline` (only `window-all-closed`
// did, and darwin doesn't fire that with no window open) — so an in-flight advance/promote could be
// SIGKILLed mid-write. `stopPipelineForQuit` is the fix's other half: `main.ts`'s `before-quit` handler
// awaits it so a pending coalesced promote gets a bounded chance to land before the process exits. This
// pins the "bounded" half: a `flushNow()` that never settles must not hang `stopPipelineForQuit` past
// its own timeout — the flush is best-effort (staging is the durable source of truth either way).
import { describe, it, expect, vi } from 'vitest';
import { makeTempDir } from '../../test/tempVault';

const h = vi.hoisted(() => {
  class StubStage {
    start(): void {}
    stop(): void {}
  }
  let flushNowCalls = 0;
  return {
    StubStage,
    getFlushNowCalls: () => flushNowCalls,
    // A promoter whose flushNow() never settles — the exact "wedged flush" this test defends against.
    fakePromoter: {
      request: () => {},
      flushNow: () => {
        flushNowCalls++;
        return new Promise<void>(() => {});
      },
      stop: () => {},
      pending: () => false,
    },
  };
});

vi.mock('../kb/orchestrator', async (orig) => ({ ...(await orig<typeof import('../kb/orchestrator')>()), Orchestrator: h.StubStage }));
vi.mock('../kb/decomposeStage', async (orig) => ({ ...(await orig<typeof import('../kb/decomposeStage')>()), DecomposeStage: h.StubStage }));
vi.mock('../kb/connectStage', async (orig) => ({ ...(await orig<typeof import('../kb/connectStage')>()), ConnectStage: h.StubStage }));
vi.mock('../kb/claimsStage', async (orig) => ({ ...(await orig<typeof import('../kb/claimsStage')>()), ClaimsStage: h.StubStage }));
vi.mock('../kb/jobScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/jobScheduler')>()), JobScheduler: h.StubStage }));
vi.mock('../kb/researcherScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/researcherScheduler')>()), ResearcherScheduler: h.StubStage }));
vi.mock('../kb/coalescingPromoter', async (orig) => ({
  ...(await orig<typeof import('../kb/coalescingPromoter')>()),
  createCoalescingPromoter: () => h.fakePromoter,
}));
vi.mock('../kb/stagingWorktree', async (orig) => ({
  ...(await orig<typeof import('../kb/stagingWorktree')>()),
  ensureStagingWorktree: vi.fn(),
}));

import { startPipeline, stopPipelineForQuit } from './pipeline';
import { ensureStagingWorktree } from '../kb/stagingWorktree';

describe('#515 stopPipelineForQuit — bounded best-effort flush', () => {
  it('resolves within its own timeout even when the promoter flush never settles', async () => {
    const vault = await makeTempDir();
    const staging = await makeTempDir();
    vi.mocked(ensureStagingWorktree).mockResolvedValue(staging);
    await startPipeline(vault);

    const startedAt = Date.now();
    await stopPipelineForQuit(30); // small bound so the test itself stays fast
    const elapsedMs = Date.now() - startedAt;

    expect(h.getFlushNowCalls()).toBe(1); // it DID attempt the flush…
    expect(elapsedMs).toBeLessThan(1000); // …but never blocked on it past the bound
  });

  it('is a no-op when no pipeline is active', async () => {
    await expect(stopPipelineForQuit(30)).resolves.toBeUndefined();
  });
});
