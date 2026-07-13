// The canonical-writer Mutex (SPEC-0014 §5) + its OBS-7 introspection (SPEC-0030). Serialization
// semantics must be unchanged; `state()` is read-only bookkeeping for the Status view.
import { describe, it, expect } from 'vitest';
import { Mutex } from './stageLock';
import type { DevLog } from './devlog';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A DevLog that captures `warn` events — to assert the #163 watchdog surfaces a stuck section. */
function capturingLog(): { log: DevLog; warns: Array<{ event: string; fields?: Record<string, unknown> }> } {
  const warns: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const log: DevLog = {
    debug: () => {},
    info: () => {},
    warn: (event, fields) => warns.push({ event, fields }),
    error: () => {},
    child: () => log,
    flush: async () => {},
  };
  return { log, warns };
}

describe('Mutex (canonical writer)', () => {
  it('serializes sections — they never overlap, order preserved', async () => {
    const lock = new Mutex();
    const log: string[] = [];
    const section = (name: string) => async (): Promise<void> => {
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
    };
    await Promise.all([lock.run(section('a')), lock.run(section('b')), lock.run(section('c'))]);
    // Each section fully completes before the next starts (no interleaving), FIFO order.
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a throwing section never wedges the lock (chain advances)', async () => {
    const lock = new Mutex();
    await expect(lock.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The next section still runs (the original `prev.then(fn, fn)` resilience).
    await expect(lock.run(async () => 42)).resolves.toBe(42);
    expect(lock.state().held).toBe(false);
  });

  // KB-Quality-Driver review (#544 REJECT → fix): the original #515 refactor left an unattached
  // `.finally()`-derived promise that fired a REAL Node `unhandledRejection` event on every ORDINARY
  // section failure — nothing to do with the new `sectionTimeoutMs` feature (the pre-existing "boom"
  // test above still passed logically; the break was only visible as a process-level event, which is
  // exactly why it slipped past a plain `.rejects.toThrow()` assertion and only surfaced as vitest's
  // own "Unhandled Errors" / non-zero exit code in CI). This listens for that event directly.
  it('#544 REGRESSION: a normal (non-timeout) section rejection never fires an unhandledRejection event', async () => {
    const captured: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      captured.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const lock = new Mutex(); // no sectionTimeoutMs configured — the exact path that broke
      await expect(lock.run(async () => { throw new Error('ordinary failure'); }, 'section')).rejects.toThrow('ordinary failure');
      // Flush a full macrotask so a dangling derived-promise rejection (queued on a microtask) has
      // settled and had its chance to fire `unhandledRejection` before we assert.
      await sleep(20);
      expect(captured).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('state() reports held + waiters + holder while a section runs (OBS-7)', async () => {
    const lock = new Mutex();
    expect(lock.state()).toMatchObject({ held: false, waiters: 0 });

    let releaseFirst: () => void = () => {};
    const firstDone = new Promise<void>((r) => (releaseFirst = r));
    const first = lock.run(async () => { await firstDone; }, 'decompose');
    const second = lock.run(async () => {}, 'connect'); // queues behind `first`
    await tick(); // let `first` acquire

    const s = lock.state();
    expect(s.held).toBe(true);
    expect(s.holder).toBe('decompose'); // the running section's label
    expect(typeof s.since).toBe('string');
    expect(s.waiters).toBe(1); // `second` is waiting

    releaseFirst();
    await Promise.all([first, second]);
    expect(lock.state()).toMatchObject({ held: false, waiters: 0 });
    expect(lock.state().holder).toBeUndefined();
  });

  it('an unlabelled section still reports held (label is optional)', async () => {
    const lock = new Mutex();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const p = lock.run(async () => { await gate; }); // no label
    await tick();
    expect(lock.state().held).toBe(true);
    expect(lock.state().holder).toBeUndefined();
    release();
    await p;
  });

  // #163: the lock's watchdog turns a critical section that never settles (a re-entrant `lock.run`
  // self-deadlock, or any hung await) from a SILENT wedge into a loud, named, surfaced state.
  it('#163 watchdog: a section held past stuckMs sets `stuck` + logs a named `lock.stuck`', async () => {
    const { log, warns } = capturingLog();
    const lock = new Mutex({ log, stuckMs: 20 });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const p = lock.run(async () => { await gate; }, 'claims:afterDrain');
    await tick();
    expect(lock.state().stuck).toBeUndefined(); // not yet — held < threshold
    await sleep(40); // exceed stuckMs
    const s = lock.state();
    expect(s.stuck).toBe(true);
    expect(s.holder).toBe('claims:afterDrain'); // the holder names itself (no more "a stage")
    expect(typeof s.heldMs).toBe('number');
    expect(warns.some((w) => w.event === 'lock.stuck' && w.fields?.holder === 'claims:afterDrain')).toBe(true);
    release();
    await p;
    expect(lock.state()).toMatchObject({ held: false, waiters: 0 }); // cleared on settle
    expect(lock.state().stuck).toBeUndefined();
  });

  it('#163 watchdog: a fast section never trips `stuck` / `lock.stuck`', async () => {
    const { log, warns } = capturingLog();
    const lock = new Mutex({ log, stuckMs: 1000 });
    await lock.run(async () => { await tick(); }, 'claims:advance');
    expect(warns.some((w) => w.event === 'lock.stuck')).toBe(false);
    expect(lock.state().stuck).toBeUndefined();
  });

  // #515: `sectionTimeoutMs` is the hard backstop UNDER the watchdog — a section that never settles
  // (the exact #163 mechanism, e.g. non-git work in a section that boundedGit can't reach) must reject
  // its caller AND release the chain for the next waiter, rather than wedging every future canonical
  // write behind it forever.
  it('#515 sectionTimeoutMs: a never-resolving section rejects its caller and the chain proceeds', async () => {
    const lock = new Mutex({ sectionTimeoutMs: 20 });
    const neverSettles = new Promise<void>(() => {}); // deliberately never resolves/rejects
    const wedged = lock.run(async () => {
      await neverSettles;
    }, 'wedged');
    await expect(wedged).rejects.toThrow(/timed out after 20ms/);
    // The next queued section runs promptly — it was NOT stuck behind the orphaned `wedged` section.
    const queued = lock.run(async () => 'ran', 'after');
    const raced = await Promise.race([queued, sleep(200).then(() => 'lock-still-wedged' as const)]);
    expect(raced).toBe('ran');
  });

  it('#515 sectionTimeoutMs: a per-call `timeoutMs` overrides the Mutex default', async () => {
    const lock = new Mutex({ sectionTimeoutMs: 10_000 }); // Mutex default is generous…
    const wedged = lock.run(async () => new Promise<void>(() => {}), 'wedged', { timeoutMs: 15 }); // …call override is not
    await expect(wedged).rejects.toThrow(/timed out after 15ms/);
  });

  it('#515 sectionTimeoutMs: undefined (the default) never rejects — unchanged behavior for bare `new Mutex()`', async () => {
    const lock = new Mutex();
    let released: () => void = () => {};
    const gate = new Promise<void>((r) => (released = r));
    const p = lock.run(async () => {
      await gate;
      return 'ok';
    }, 'slow');
    await sleep(30); // comfortably past every timeout used in the other cases above
    released();
    await expect(p).resolves.toBe('ok'); // no timeout configured → never forced to reject
  });

  it('#515 sectionTimeoutMs: a section that settles well within the timeout is unaffected', async () => {
    const lock = new Mutex({ sectionTimeoutMs: 500 });
    await expect(lock.run(async () => { await tick(); return 7; }, 'quick')).resolves.toBe(7);
  });

  it('#163: a RE-ENTRANT lock.run still deadlocks (known) but the watchdog SURFACES it — no silent wedge', async () => {
    const { log, warns } = capturingLog();
    const lock = new Mutex({ log, stuckMs: 20 });
    // The exact #163 bug: a section re-enters the SAME mutex; the inner section queues behind the
    // outer, which awaits the inner → mutual deadlock. We deliberately do NOT await it (it never
    // settles); the assertion is that the watchdog turns the silent wedge into a named `lock.stuck`.
    let started = false;
    void lock.run(async () => {
      started = true;
      await lock.run(async () => {}, 'inner'); // re-entrant → never resolves (self-deadlock)
    }, 'outer:reentrant');
    await tick();
    expect(started).toBe(true);
    await sleep(40);
    expect(lock.state().stuck).toBe(true);
    expect(lock.state().holder).toBe('outer:reentrant'); // names the deadlocking holder
    expect(warns.some((w) => w.event === 'lock.stuck' && w.fields?.holder === 'outer:reentrant')).toBe(true);
  });
});

// #507 item 4: a priority lane (mirrors copilotConcurrency's Semaphore priorityWaiters/pump()) so a
// capture-shaped write is never stuck behind a long queue of background sections (Connect's
// link/orphan/dedup sweep, PERF-E3) — without ever running two sections concurrently.
describe('Mutex priority lane (#507 item 4)', () => {
  it('a priority section queued behind N background sections runs BEFORE all of them', async () => {
    const lock = new Mutex();
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => (releaseFirst = r));

    // Occupy the lock so everything below queues (never runs) until we release it.
    const first = lock.run(async () => {
      order.push('first');
      await firstGate;
    }, 'first');
    await tick(); // let `first` acquire

    // Queue 3 background sections, THEN a priority one — priority must still run before all 3.
    const bg1 = lock.run(async () => { order.push('bg1'); }, 'bg1');
    const bg2 = lock.run(async () => { order.push('bg2'); }, 'bg2');
    const bg3 = lock.run(async () => { order.push('bg3'); }, 'bg3');
    const prio = lock.run(async () => { order.push('prio'); }, 'prio', { priority: true });

    releaseFirst();
    await Promise.all([first, bg1, bg2, bg3, prio]);
    expect(order).toEqual(['first', 'prio', 'bg1', 'bg2', 'bg3']); // priority jumped the background queue
  });

  it('multiple priority sections still serialize FIFO among themselves', async () => {
    const lock = new Mutex();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const holder = lock.run(async () => { await gate; }, 'holder');
    await tick();

    const p1 = lock.run(async () => { order.push('p1'); }, 'p1', { priority: true });
    const p2 = lock.run(async () => { order.push('p2'); }, 'p2', { priority: true });
    const p3 = lock.run(async () => { order.push('p3'); }, 'p3', { priority: true });

    release();
    await Promise.all([holder, p1, p2, p3]);
    expect(order).toEqual(['p1', 'p2', 'p3']); // FIFO within the priority lane, no reordering
  });

  it('priority NEVER preempts an already-RUNNING section — still exactly one section active at a time', async () => {
    const lock = new Mutex();
    let bgRunning = false;
    let overlapped = false;
    let releaseBg: () => void = () => {};
    const bgGate = new Promise<void>((r) => (releaseBg = r));

    const bg = lock.run(async () => {
      bgRunning = true;
      await bgGate;
      bgRunning = false;
    }, 'bg');
    await tick(); // let `bg` acquire and start running

    const prio = lock.run(async () => {
      if (bgRunning) overlapped = true; // would mean two sections ran concurrently — must never happen
    }, 'prio', { priority: true });

    await tick(); // give the priority section every chance to (wrongly) start early
    expect(lock.state().holder).toBe('bg'); // bg is still the one holding the lock
    releaseBg();
    await Promise.all([bg, prio]);
    expect(overlapped).toBe(false);
  });

  it('a priority capture completes promptly even with a long queue of background sections ahead of it (the AC)', async () => {
    const lock = new Mutex();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => (releaseFirst = r));
    const first = lock.run(async () => { await firstGate; }, 'connect:sweep-start');

    await tick();
    // Simulate a long queue of background (connect-sweep-shaped) sections already waiting. Generous
    // per-section duration (100ms ⇒ ≥1s to drain all 10) so the race margin stays robust under
    // full-suite parallel load (a shared-machine timing-flake source, not a correctness one).
    const backgrounds = Array.from({ length: 10 }, (_, i) => lock.run(async () => sleep(100), `connect:link-${i}`));

    const startedAt = Date.now();
    const capture = lock.run(async () => 'captured', 'capture', { priority: true });

    releaseFirst();
    const result = await Promise.race([capture, sleep(700).then(() => 'timed-out' as const)]);
    expect(result).toBe('captured'); // resolved well before the 10 background sections could have drained
    expect(Date.now() - startedAt).toBeLessThan(700); // generous secondary check — well under the ~1s the 10 backgrounds alone would take
    await first;
    await Promise.all(backgrounds); // drain cleanly (no leaked timers/state)
  });

  it('state().waiters counts BOTH lanes combined', async () => {
    const lock = new Mutex();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const holder = lock.run(async () => { await gate; }, 'holder');
    await tick();

    const bg = lock.run(async () => {}, 'bg');
    const p1 = lock.run(async () => {}, 'p1', { priority: true });
    const p2 = lock.run(async () => {}, 'p2', { priority: true });
    await tick();

    expect(lock.state().waiters).toBe(3); // 1 background + 2 priority, regardless of lane
    release();
    await Promise.all([holder, bg, p1, p2]);
    expect(lock.state()).toMatchObject({ held: false, waiters: 0 });
  });

  it('sectionTimeoutMs still rejects + advances the queue for a priority section (the #515 backstop applies to both lanes)', async () => {
    const lock = new Mutex({ sectionTimeoutMs: 20 });
    const neverSettles = new Promise<void>(() => {});
    const wedged = lock.run(async () => { await neverSettles; }, 'wedged', { priority: true });
    await expect(wedged).rejects.toThrow(/timed out after 20ms/);
    const after = await Promise.race([lock.run(async () => 'ran', 'after'), sleep(200).then(() => 'lock-still-wedged' as const)]);
    expect(after).toBe('ran'); // the queue advanced — a later section (even non-priority) isn't stuck behind it
  });

  it('an unlabeled/no-options run() still defaults to the background lane (backward-compatible)', async () => {
    const lock = new Mutex();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const holder = lock.run(async () => { await gate; });
    await tick();
    const bg = lock.run(async () => { order.push('bg'); }); // no label, no opts — plain call, matches every pre-#507 call site
    const prio = lock.run(async () => { order.push('prio'); }, 'prio', { priority: true });
    release();
    await Promise.all([holder, bg, prio]);
    expect(order).toEqual(['prio', 'bg']); // the plain call defaulted to background, priority still jumped it
  });
});
