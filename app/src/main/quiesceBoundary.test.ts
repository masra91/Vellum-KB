// QUIESCE controller boundary (SPEC-0045). Drives the genuine wired pipeline fns against a real staging
// worktree; the heavy stages/schedulers are stubbed (start/stop/busy) so the test is deterministic. Asserts
// the state machine (running → quiescing → resume), the live "N remaining / safe to shut down" status off
// the real queues + lock, and that the producers are stopped on quiesce / restarted on resume (QUIESCE-1/3/5).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const h = vi.hoisted(() => {
  const calls = { producerStops: 0, producerStarts: 0 };
  class StubStage {
    start(): void {}
    stop(): void {}
    poke(): void {}
    busy(): boolean {
      return false;
    }
  }
  // A scheduler stub that records start/stop so the test can prove producers are paused/resumed.
  class StubScheduler {
    start(): void {
      calls.producerStarts++;
    }
    stop(): void {
      calls.producerStops++;
    }
    busy(): boolean {
      return false;
    }
    async refresh(): Promise<void> {}
    watchingIds(): Set<string> {
      return new Set();
    }
  }
  return { reap: vi.fn(async () => ({ worktrees: 0, branches: 0 })), StubStage, StubScheduler, calls };
});
vi.mock('../kb/canonicalAdvance', async (orig) => ({ ...(await orig<typeof import('../kb/canonicalAdvance')>()), reapEphemeralWorktrees: h.reap }));
vi.mock('../kb/orchestrator', async (orig) => ({ ...(await orig<typeof import('../kb/orchestrator')>()), Orchestrator: h.StubStage }));
vi.mock('../kb/decomposeStage', async (orig) => ({ ...(await orig<typeof import('../kb/decomposeStage')>()), DecomposeStage: h.StubStage }));
vi.mock('../kb/connectStage', async (orig) => ({ ...(await orig<typeof import('../kb/connectStage')>()), ConnectStage: h.StubStage }));
// ComposeStage was missing from this list — its real `start()` fires an unawaited `poke()` like every
// other stage here, so leaving it real (unlike its siblings) made this suite's "settles almost
// instantly" assumption depend on incidental timing. #506 gave it the same canonical-HEAD queue memo
// its siblings already had, which — like the siblings' own memo — adds a real async step to that
// unawaited poke; stub it too so the suite is deterministic per this file's own stated intent.
vi.mock('../kb/composeStage', async (orig) => ({ ...(await orig<typeof import('../kb/composeStage')>()), ComposeStage: h.StubStage }));
vi.mock('../kb/claimsStage', async (orig) => ({ ...(await orig<typeof import('../kb/claimsStage')>()), ClaimsStage: h.StubStage }));
vi.mock('../kb/jobScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/jobScheduler')>()), JobScheduler: h.StubScheduler }));
vi.mock('../kb/researcherScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/researcherScheduler')>()), ResearcherScheduler: h.StubScheduler }));
vi.mock('../kb/intakeScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/intakeScheduler')>()), IntakeScheduler: h.StubScheduler }));
vi.mock('../kb/watchScheduler', async (orig) => ({ ...(await orig<typeof import('../kb/watchScheduler')>()), WatchScheduler: h.StubScheduler }));

import { createKb } from '../kb/vault';
import { ensureStagingWorktree } from '../kb/stagingWorktree';
import { captureToInbox } from '../kb/ingest';
import { startPipeline, quiesceActive, resumeActive, quiesceStatusForActive, isActiveQuiescing, stopPipeline } from './pipeline';

let dir: string | null = null;

afterEach(async () => {
  stopPipeline();
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  dir = null;
  h.calls.producerStops = 0;
  h.calls.producerStarts = 0;
  vi.clearAllMocks();
});

async function openVault(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-quiesce-'));
  const vault = path.join(dir, 'vault');
  await createKb({ path: vault, initGitIfNeeded: true });
  const staging = await ensureStagingWorktree(vault);
  await startPipeline(vault); // 4 producers start()ed
  h.calls.producerStarts = 0; // ignore the startup starts; count only resume's
  return staging;
}

describe('QUIESCE controller (SPEC-0045)', () => {
  it('an idle KB: quiesce → quiescing + SAFE immediately (queues empty, nothing in flight, lock free) (QUIESCE-3)', async () => {
    await openVault();
    expect((await quiesceStatusForActive())!).toMatchObject({ quiescing: false, detail: 'Running normally.' });

    const s = await quiesceActive();
    expect(s.quiescing).toBe(true);
    expect(s.remaining).toBe(0);
    expect(s.safe).toBe(true);
    expect(s.detail).toMatch(/Safe to shut down/i);
    expect(isActiveQuiescing()).toBe(true);
    expect(h.calls.producerStops).toBe(4); // jobs/researchers/intake/watch all paused (QUIESCE-1)
  });

  it('with queued work: quiesce reports "N remaining" + NOT safe until it drains (QUIESCE-2/3)', async () => {
    const staging = await openVault();
    await captureToInbox(staging, 'in-app-panel', [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]); // 2 archive-queue items
    const s = await quiesceActive();
    expect(s.quiescing).toBe(true);
    expect(s.remaining).toBeGreaterThanOrEqual(2);
    expect(s.safe).toBe(false);
    expect(s.detail).toMatch(/remaining/i);
  });

  it('is reversible: resume un-pauses (restarts the producers) → back to normal (QUIESCE-5)', async () => {
    await openVault();
    await quiesceActive();
    expect(isActiveQuiescing()).toBe(true);

    const r = await resumeActive();
    expect(r.quiescing).toBe(false);
    expect(r.detail).toBe('Running normally.');
    expect(isActiveQuiescing()).toBe(false);
    expect(h.calls.producerStarts).toBe(4); // the 4 producers restarted
  });

  it('quiesce is idempotent — a second call does not re-stop producers', async () => {
    await openVault();
    await quiesceActive();
    expect(h.calls.producerStops).toBe(4);
    await quiesceActive(); // already quiescing → no-op
    expect(h.calls.producerStops).toBe(4);
  });
});
