// SHELL-12 — the generic cached-projection spine (pure, node tier). The load-bearing guarantees every
// surface (status · reviews · settings · activity) rides on: the render-path read NEVER computes (no
// git/fs/lock on `current()` → a timeout is structurally impossible), the background cadence maintains
// it off the render path, a compute failure RETAINS the last-known-good (marked `stale`), and a
// persisted payload is shown instantly on start. Generalized from OBS-24's status store.
import { describe, it, expect, vi } from 'vitest';
import { createProjectionStore } from './projectionStore';

/** A monotonically-stamping clock so `builtAt` is deterministic + assertable in tests. */
function fakeClock(start = 0) {
  let t = start;
  return () => `t${t++}`;
}

/** A fake scheduler that captures the interval callback so tests drive ticks deterministically. */
function fakeScheduler() {
  let cb: (() => void) | null = null;
  return {
    sched: {
      setInterval: (fn: () => void) => {
        cb = fn;
        return 1;
      },
      clearInterval: () => {
        cb = null;
      },
    },
    tick: () => cb?.(),
    isRunning: () => cb !== null,
  };
}

describe('createProjectionStore (SHELL-12 spine)', () => {
  it('current() is null before any refresh', () => {
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('x'), intervalMs: 1000 });
    expect(store.current()).toBeNull();
  });

  it('refreshNow() populates current() with data + builtAt + stale:false', async () => {
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('hello'), intervalMs: 1000, now: fakeClock() });
    await store.refreshNow();
    expect(store.current()).toEqual({ data: 'hello', builtAt: 't0', stale: false });
  });

  it('READS NEVER COMPUTE — current() does zero work on the render path (the SHELL-12 guarantee)', async () => {
    const compute = vi.fn().mockResolvedValue('v');
    const store = createProjectionStore<string>({ compute, intervalMs: 1000 });
    await store.refreshNow(); // 1 compute (background)
    for (let i = 0; i < 50; i++) store.current(); // 50 render-path reads
    expect(compute).toHaveBeenCalledTimes(1); // reads added zero computes → no git/fs on read, never blocks
  });

  it('start() seeds instantly from the persisted last-known-good (marked stale), then refreshes live', async () => {
    const compute = vi.fn().mockResolvedValue('live');
    const fk = fakeScheduler();
    const store = createProjectionStore<string>({ compute, intervalMs: 1000, load: () => 'persisted', scheduler: fk.sched, now: fakeClock() });
    store.start();
    expect(store.current()).toMatchObject({ data: 'persisted', stale: true }); // instant on launch, flagged stale until live
    await store.refreshNow();
    expect(store.current()).toMatchObject({ data: 'live', stale: false }); // then goes live
    expect(fk.isRunning()).toBe(true);
  });

  it('a compute failure RETAINS the last-known-good, marks it STALE, and reports onError — never throws to the reader', async () => {
    const compute = vi.fn().mockResolvedValueOnce('good').mockRejectedValueOnce(new Error('git blocked'));
    const onError = vi.fn();
    const store = createProjectionStore<string>({ compute, intervalMs: 1000, onError, now: fakeClock() });
    await store.refreshNow();
    expect(store.current()).toMatchObject({ data: 'good', stale: false });
    await store.refreshNow(); // this compute throws
    expect(store.current()).toMatchObject({ data: 'good', stale: true }); // retained + flagged stale, NOT cleared, NOT thrown
    expect(onError).toHaveBeenCalledOnce();
  });

  it('compute reporting nothing-to-project (null) clears the projection', async () => {
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue(null), intervalMs: 1000 });
    await store.refreshNow();
    expect(store.current()).toBeNull();
  });

  it('persists each freshly-computed payload as the new last-known-good', async () => {
    const save = vi.fn();
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('v1'), intervalMs: 1000, save });
    await store.refreshNow();
    expect(save).toHaveBeenCalledWith('v1');
  });

  it('onUpdate (the push hook) fires with the new projection after each successful refresh', async () => {
    const onUpdate = vi.fn();
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('v'), intervalMs: 1000, onUpdate, now: fakeClock() });
    await store.refreshNow();
    expect(onUpdate).toHaveBeenCalledWith({ data: 'v', builtAt: 't0', stale: false });
  });

  it('a failing onUpdate / save listener never breaks the projection (best-effort push + persist)', async () => {
    const store = createProjectionStore<string>({
      compute: vi.fn().mockResolvedValue('v'),
      intervalMs: 1000,
      onUpdate: () => { throw new Error('listener blew up'); },
      save: () => { throw new Error('disk full'); },
    });
    await expect(store.refreshNow()).resolves.toBeUndefined();
    expect(store.current()?.data).toBe('v'); // projection still set despite the throwing listeners
  });

  it('coalesces overlapping refreshes — a slow compute does not stack', async () => {
    let resolve!: (v: string) => void;
    const compute = vi.fn().mockImplementation(() => new Promise<string>((r) => (resolve = r)));
    const store = createProjectionStore<string>({ compute, intervalMs: 1000 });
    const p1 = store.refreshNow();
    const p2 = store.refreshNow(); // while the first is still pending
    expect(compute).toHaveBeenCalledTimes(1); // both await the same in-flight compute
    resolve('done');
    await Promise.all([p1, p2]);
    expect(store.current()?.data).toBe('done');
  });

  it('start() is idempotent and stop() halts the cadence', () => {
    const fk = fakeScheduler();
    const store = createProjectionStore<string>({ compute: vi.fn().mockResolvedValue('v'), intervalMs: 1000, scheduler: fk.sched });
    store.start();
    store.start(); // second call is a no-op (no double timer)
    expect(fk.isRunning()).toBe(true);
    store.stop();
    expect(fk.isRunning()).toBe(false);
  });

  // #505/#506: a HEAD-gated compute (graph projection, status queues) detects "nothing changed" and
  // returns the SAME object it returned last time instead of redoing the walk — a true no-op tick
  // should skip the restamp/save/push too, not just the walk.
  it('compute returning the SAME reference as current data is a true no-op — no restamp, no save, no push', async () => {
    const cached = { v: 1 };
    const compute = vi.fn().mockResolvedValue(cached);
    const save = vi.fn();
    const onUpdate = vi.fn();
    const clock = fakeClock();
    const store = createProjectionStore<{ v: number }>({ compute, intervalMs: 1000, now: clock, save, onUpdate });
    await store.refreshNow(); // first tick: real compute, sets builtAt t0
    const first = store.current();
    expect(first).toEqual({ data: cached, builtAt: 't0', stale: false });
    expect(save).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await store.refreshNow(); // second tick: compute returns the SAME reference (unchanged HEAD)
    expect(store.current()).toBe(first); // untouched — not even a new envelope object
    expect(save).toHaveBeenCalledTimes(1); // no redundant disk write
    expect(onUpdate).toHaveBeenCalledTimes(1); // no redundant push
  });

  it('compute returning a DIFFERENT reference still refreshes normally (every other store is unaffected)', async () => {
    const compute = vi.fn().mockResolvedValueOnce({ v: 1 }).mockResolvedValueOnce({ v: 2 });
    const clock = fakeClock();
    const store = createProjectionStore<{ v: number }>({ compute, intervalMs: 1000, now: clock });
    await store.refreshNow();
    await store.refreshNow();
    expect(store.current()).toEqual({ data: { v: 2 }, builtAt: 't1', stale: false });
  });

  it('a bad persisted load never throws out of start() (best-effort seed)', () => {
    const store = createProjectionStore<string>({
      compute: vi.fn().mockResolvedValue('v'),
      intervalMs: 1000,
      load: () => { throw new Error('corrupt snapshot'); },
      scheduler: fakeScheduler().sched,
    });
    expect(() => store.start()).not.toThrow();
    expect(store.current()).toBeNull(); // a failed seed leaves it empty, then the live refresh fills it
  });

  // #508 item 4: `load` may now return a Promise (a large persisted payload's disk read shouldn't
  // block the vault-activation path). `start()` itself must stay synchronous regardless.
  it('start() stays synchronous even when load() returns a Promise', () => {
    const store = createProjectionStore<string>({
      compute: vi.fn().mockResolvedValue('live'),
      intervalMs: 1000,
      load: () => Promise.resolve('persisted'),
      scheduler: fakeScheduler().sched,
    });
    expect(() => store.start()).not.toThrow(); // start() returns before the load Promise ever settles
  });

  it('an async load() seeds the stale snapshot once it resolves, if the live refresh has not already landed', async () => {
    let resolveLoad!: (v: string | null) => void;
    const loadPromise = new Promise<string | null>((r) => {
      resolveLoad = r;
    });
    let resolveCompute!: (v: string) => void;
    const computePromise = new Promise<string>((r) => {
      resolveCompute = r;
    });
    const store = createProjectionStore<string>({
      compute: () => computePromise,
      intervalMs: 1000,
      load: () => loadPromise,
      now: fakeClock(),
      scheduler: fakeScheduler().sched,
    });
    store.start();
    expect(store.current()).toBeNull(); // neither the async load nor the live compute has resolved yet

    resolveLoad('persisted'); // the async load resolves first — the live compute is still pending
    await Promise.resolve();
    await Promise.resolve();
    expect(store.current()).toMatchObject({ data: 'persisted', stale: true });

    resolveCompute('live'); // now the live refresh lands and takes over
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.current()).toMatchObject({ data: 'live', stale: false });
  });

  it('a live refresh that lands FIRST is never overwritten by a late-resolving async load', async () => {
    let resolveLoad!: (v: string | null) => void;
    const loadPromise = new Promise<string | null>((r) => {
      resolveLoad = r;
    });
    const store = createProjectionStore<string>({
      compute: vi.fn().mockResolvedValue('live'),
      intervalMs: 1000,
      load: () => loadPromise,
      now: fakeClock(),
      scheduler: fakeScheduler().sched,
    });
    store.start();
    await store.refreshNow(); // the live refresh completes (coalesces onto start()'s own kick-off)
    expect(store.current()).toMatchObject({ data: 'live', stale: false });

    resolveLoad('stale-persisted'); // resolves LATE — must be a no-op now
    await Promise.resolve();
    await Promise.resolve();
    expect(store.current()).toMatchObject({ data: 'live', stale: false }); // unchanged
  });

  it('a rejected async load() never throws or breaks the store', async () => {
    const store = createProjectionStore<string>({
      compute: vi.fn().mockResolvedValue('live'),
      intervalMs: 1000,
      load: () => Promise.reject(new Error('disk read failed')),
      now: fakeClock(),
      scheduler: fakeScheduler().sched,
    });
    expect(() => store.start()).not.toThrow();
    await store.refreshNow();
    expect(store.current()).toMatchObject({ data: 'live' });
  });
});
