// Tests for the process-wide copilot concurrency limit (dogfood #4). Proves the global ceiling
// holds even when many spawners (stages + jobs + researchers) contend at once — the safety bound
// that makes raising per-stage caps safe. Deterministic: no copilot, just instrumented async work.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import {
  Semaphore,
  withCopilotSlot,
  acquireCopilotSlot,
  copilotSemaphore,
  CopilotCapacityTimeoutError,
  applyCopilotCeiling,
  recordCopilotOutcome,
  isCopilotThrottled,
  adaptiveCeilingActive,
  coresDerivedCeiling,
  copilotScaleRuntime,
  __setAdaptiveControllerForTest,
} from './copilotConcurrency';

/** Run `n` tasks concurrently through `gate`, each holding its slot for a tick; return the peak
 *  number ever in-flight simultaneously. */
async function peakConcurrency(n: number, gate: <T>(fn: () => Promise<T>) => Promise<T>): Promise<number> {
  let inFlight = 0;
  let peak = 0;
  const task = (): Promise<void> =>
    gate(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot briefly so contention is real
      inFlight--;
    });
  await Promise.all(Array.from({ length: n }, task));
  return peak;
}

describe('coresDerivedCeiling baseline (SCALE adaptive-default — SPEC-0048 batch-2)', () => {
  it('is the AIMD seed = cores-1 bounded to [3, 16] (raised so real machines start higher)', () => {
    const c = coresDerivedCeiling();
    expect(c).toBeGreaterThanOrEqual(3); // floor: even a small box can fill a cap-3+ stage
    expect(c).toBeLessThanOrEqual(16); // cap: a huge box still seeds sanely; AIMD climbs to MAX from here
    // Within bounds it tracks the machine's real parallelism.
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    expect(c).toBe(Math.max(3, Math.min(16, cores - 1)));
  });
});

describe('Semaphore (copilot concurrency primitive)', () => {
  it('never lets in-flight exceed the ceiling under heavy contention', async () => {
    const sem = new Semaphore(3);
    const peak = await peakConcurrency(20, (fn) => withSem(sem, fn));
    // #514: UNTAGGED background (this test's flood carries no `stage`) now reserves 1 slot for
    // interactive (ASK-16) — so it fans out to ceiling-1, not the full ceiling. Still reaches its
    // bound (not over-serialized) AND never exceeds it.
    expect(peak).toBe(2);
  });

  it('serializes fully at ceiling 1', async () => {
    const sem = new Semaphore(1);
    const peak = await peakConcurrency(8, (fn) => withSem(sem, fn));
    expect(peak).toBe(1);
  });

  it('grants slots FIFO (fairness)', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const release0 = await sem.acquire(); // take the only slot
    // queue three waiters in order
    const waiters = [1, 2, 3].map((i) =>
      sem.acquire().then((rel) => {
        order.push(i);
        rel();
      }),
    );
    expect(sem.waiting).toBe(3);
    release0(); // free the slot → waiters drain in FIFO order
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it('release is idempotent (double-release cannot over-grant a slot)', async () => {
    const sem = new Semaphore(1);
    const rel = await sem.acquire();
    rel();
    rel(); // second release is a no-op
    expect(sem.active).toBe(0);
    // a fresh acquire still respects the ceiling
    const peak = await peakConcurrency(5, (fn) => withSem(sem, fn));
    expect(peak).toBe(1);
  });

  it('drains every task (no deadlock/leak): all resolve, ends at zero in-flight', async () => {
    const sem = new Semaphore(2);
    let done = 0;
    await Promise.all(Array.from({ length: 30 }, () => withSem(sem, async () => { done++; })));
    expect(done).toBe(30);
    expect(sem.active).toBe(0);
    expect(sem.waiting).toBe(0);
  });
});

// ASK-16: the interactive PRIORITY lane — a foreground (recall/Ask/Explore) acquire jumps ahead of
// background (pipeline) waiters, and a bounded acquire fails fast instead of hanging.
describe('Semaphore priority lane + bounded acquire (ASK-16)', () => {
  it('serves a PRIORITY waiter before earlier-queued background waiters on the next freed slot', async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    const hold = await sem.acquire(); // saturate the only slot (the "pipeline" holds it)
    // Two BACKGROUND waiters queue first, THEN a PRIORITY (interactive) waiter arrives last.
    const bg1 = sem.acquire().then((rel) => { order.push('bg1'); rel(); });
    const bg2 = sem.acquire().then((rel) => { order.push('bg2'); rel(); });
    const fg = sem.acquire({ priority: true }).then((rel) => { order.push('fg'); rel(); });
    expect(sem.waiting).toBe(3);
    expect(sem.priorityWaiting).toBe(1);
    hold(); // free the slot → the human jumps the queue despite arriving last (background yields)
    await Promise.all([bg1, bg2, fg]);
    expect(order[0]).toBe('fg'); // FOREGROUND served first; FAILS-BEFORE (plain FIFO) → 'bg1'
    expect(order).toEqual(['fg', 'bg1', 'bg2']);
    expect(sem.active).toBe(0);
  });

  it('a bounded acquire FAILS FAST (CopilotCapacityTimeoutError) when no slot frees in time', async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire(); // never released within the bound → saturated/wedged pool
    await expect(sem.acquire({ priority: true, timeoutMs: 20 })).rejects.toBeInstanceOf(CopilotCapacityTimeoutError);
    expect(sem.waiting).toBe(0); // the timed-out waiter gave up its place in line (no leak)
    hold();
    expect(sem.active).toBe(0);
  });

  it('a bounded acquire RESOLVES (and cancels its timer) when a slot frees within the bound', async () => {
    const sem = new Semaphore(1);
    const hold = await sem.acquire();
    const fg = sem.acquire({ priority: true, timeoutMs: 1000 });
    setTimeout(hold, 5); // a background op frees the slot well within the bound
    const rel = await fg; // resolves, does not reject
    expect(sem.active).toBe(1);
    rel();
    expect(sem.active).toBe(0);
  });

  it('priority + bounded acquisitions still never exceed the ceiling', async () => {
    const sem = new Semaphore(2);
    const peak = await peakConcurrency(20, (fn) => withSemPriority(sem, fn));
    expect(peak).toBe(2);
  });
});

describe('withCopilotSlot / acquireCopilotSlot (the shared global slot)', () => {
  it('a flood of mixed stage+job+researcher spawners never exceeds the global ceiling', async () => {
    const ceiling = copilotSemaphore.ceiling;
    // Simulate all three spawner families contending on the ONE shared semaphore at once.
    const flood = ceiling * 4 + 7;
    const peak = await peakConcurrency(flood, withCopilotSlot);
    expect(peak).toBeLessThanOrEqual(ceiling); // the global bound holds...
    // #514: withCopilotSlot carries no `stage` (jobs/researchers class) — UNTAGGED background now
    // reserves 1 slot for interactive (ASK-16), so it fans out to ceiling-1, not the full ceiling.
    expect(peak).toBe(ceiling > 1 ? ceiling - 1 : ceiling); // ...and reaches its (reserved) bound
    expect(copilotSemaphore.active).toBe(0); // fully drained
  });

  it('releases the slot even when the wrapped work throws', async () => {
    const before = copilotSemaphore.active;
    await expect(withCopilotSlot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(copilotSemaphore.active).toBe(before); // no leaked slot
  });

  it('acquireCopilotSlot hands back a working release (session-hold pattern)', async () => {
    const release = await acquireCopilotSlot();
    expect(copilotSemaphore.active).toBeGreaterThanOrEqual(1);
    release();
    expect(copilotSemaphore.active).toBe(0);
  });
});

describe('Semaphore — SPEC-0048 SCALE-3 per-stage no-starvation reservation', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('a stage ALONE still fans out to the full ceiling (the reservation only bites under contention)', async () => {
    const sem = new Semaphore(3);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        (async () => {
          const rel = await sem.acquire({ stage: 'decompose' });
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight--;
          rel();
        })(),
      ),
    );
    expect(peak).toBe(3); // no false starvation when no other stage is contending
  });

  it('a busy upstream stage cannot starve a downstream stage to zero (the live BLOCKED-Claims bug)', async () => {
    const sem = new Semaphore(4); // the dogfood ceiling
    // Decompose grabs 3 + Connect 1 = the whole ceiling (the exact starvation config).
    const d = [
      await sem.acquire({ stage: 'decompose' }),
      await sem.acquire({ stage: 'decompose' }),
      await sem.acquire({ stage: 'decompose' }),
    ];
    const c = await sem.acquire({ stage: 'connect' });
    expect(sem.active).toBe(4);
    expect(sem.activeForStage('decompose')).toBe(3);

    // Claims + Compose each have work; a HUNGRY Decompose also wants a 4th slot.
    let claims = false;
    let compose = false;
    const claimsP = sem.acquire({ stage: 'claims' }).then((r) => ((claims = true), r));
    const composeP = sem.acquire({ stage: 'compose' }).then((r) => ((compose = true), r));
    void sem.acquire({ stage: 'decompose' }); // hungry 4th — must NOT win the freed slots over a starved stage
    await tick();
    expect(claims).toBe(false); // still full
    expect(compose).toBe(false);

    // Decompose finishes one → the freed slot goes to a STARVED stage (its reserved slot), not back to decompose.
    d[0]();
    await tick();
    expect(claims || compose).toBe(true);
    // Decompose finishes another → the OTHER starved stage gets ITS reserved slot.
    d[1]();
    await tick();
    expect(claims && compose).toBe(true); // BOTH downstream stages ran — no starvation
    expect(sem.activeForStage('decompose')).toBeLessThanOrEqual(2); // the hungry 4th stayed held back

    c();
    d[2]();
    (await claimsP)();
    (await composeP)();
  });

  it('priority (interactive) acquisitions still preempt — the reservation never blocks the human (ASK-16)', async () => {
    const sem = new Semaphore(2);
    const d = [await sem.acquire({ stage: 'decompose' }), await sem.acquire({ stage: 'decompose' })]; // full
    let interactive = false;
    const pP = sem.acquire({ priority: true }).then((r) => ((interactive = true), r));
    const bgP = sem.acquire({ stage: 'claims' }); // a background stage also waiting
    await tick();
    expect(interactive).toBe(false); // full
    d[0]();
    await tick();
    expect(interactive).toBe(true); // the freed slot went to the human FIRST (ASK-16), not the stage
    d[1]();
    (await pP)();
    (await bgP)();
  });
});

// #514 (deep review 2026-07-12): "the interactive lane is front-of-queue for the NEXT FREED SLOT
// ONLY — researchers hold a slot up to 60min, Ask hard-fails after 30s." A saturated pool of UNTAGGED
// background work (researchers/jobs) must never be able to consume the ceiling's last slot, so an
// interactive acquire is granted immediately instead of waiting behind a long-held researcher.
describe('Semaphore — untagged background reserves ≥1 slot for interactive (#514 / ASK-16)', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('with the ceiling saturated by UNTAGGED background holders, a priority acquire is granted immediately — no waiting for a release', async () => {
    const sem = new Semaphore(3);
    // Two untagged (researcher/job-style) acquisitions — the reservation caps them at ceiling-1.
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.active).toBe(2);
    // A third untagged acquisition would saturate the ceiling — the reservation must block it.
    let thirdGranted = false;
    const r3P = sem.acquire().then((r) => ((thirdGranted = true), r));
    await tick();
    expect(thirdGranted).toBe(false); // held back — 1 slot stays reserved for interactive
    expect(sem.active).toBe(2);

    // The interactive acquire is granted RIGHT NOW, using the reserved slot — no wait for r1/r2 to release.
    const release = await sem.acquire({ priority: true, timeoutMs: 50 });
    expect(sem.active).toBe(3);
    release();
    r1();
    r2();
    (await r3P)();
  });

  it('does NOT reserve when nothing background is tagged AND no interactive demand exists — a lone untagged acquisition still gets the slot', async () => {
    const sem = new Semaphore(3);
    const rel = await sem.acquire(); // 1 of 3 — well under the reserve boundary
    expect(sem.active).toBe(1);
    rel();
  });

  it('a SOLO tagged pipeline stage still fans out to the FULL ceiling (untouched — the interactive reserve is scoped to untagged work only)', async () => {
    const sem = new Semaphore(3);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        (async () => {
          const rel = await sem.acquire({ stage: 'decompose' });
          inFlight++;
          peak = Math.max(peak, inFlight);
          await tick();
          inFlight--;
          rel();
        })(),
      ),
    );
    expect(peak).toBe(3); // no throughput cost for tagged pipeline work — the reserve targets untagged only
  });

  it('at ceiling=1 there is nothing to reserve — untagged background still gets the only slot (never starves outright)', async () => {
    const sem = new Semaphore(1);
    const rel = await sem.acquire();
    expect(sem.active).toBe(1);
    rel();
  });
});

describe('SPEC-0048 SCALE-7/8 — adaptive ceiling (AIMD) runtime wiring', () => {
  const ENV_KEY = 'KB_COPILOT_MAX_CONCURRENCY';
  let savedEnv: string | undefined;
  let savedCeiling: number;
  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY]; // default each test to NO env override so the Auto path is reachable
    savedCeiling = copilotSemaphore.ceiling;
  });
  afterEach(() => {
    __setAdaptiveControllerForTest(null); // clear adaptive mode so other suites see fixed behaviour
    copilotSemaphore.resize(savedCeiling); // restore the shared global ceiling
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('Auto (no env, no manual) turns adaptation ON, seeded at the cores-derived default', () => {
    const eff = applyCopilotCeiling(undefined);
    expect(adaptiveCeilingActive()).toBe(true);
    expect(eff).toBe(coresDerivedCeiling());
    expect(copilotSemaphore.ceiling).toBe(coresDerivedCeiling());
  });

  it('a manual Settings ceiling pins FIXED mode (no adaptation)', () => {
    const eff = applyCopilotCeiling(6);
    expect(adaptiveCeilingActive()).toBe(false);
    expect(eff).toBe(6);
    expect(copilotSemaphore.ceiling).toBe(6);
  });

  it('an env override pins FIXED mode and wins over a manual value (precedence env > manual > Auto)', () => {
    process.env[ENV_KEY] = '5';
    const eff = applyCopilotCeiling(6); // manual present, but env wins
    expect(adaptiveCeilingActive()).toBe(false);
    expect(eff).toBe(5);
    expect(copilotSemaphore.ceiling).toBe(5);
  });

  it('in Auto, a rate-limit outcome backs the live ceiling off + flips throttled', () => {
    applyCopilotCeiling(undefined); // adaptive, seed = cores-derived (>= 2)
    const seed = copilotSemaphore.ceiling;
    recordCopilotOutcome(new Error('429 too many requests'), 1000);
    expect(copilotSemaphore.ceiling).toBeLessThan(seed); // halved live
    expect(isCopilotThrottled(1000)).toBe(true);
  });

  it('in Auto, a content/parse error does NOT back off (not a capacity signal)', () => {
    applyCopilotCeiling(undefined);
    const seed = copilotSemaphore.ceiling;
    recordCopilotOutcome(new Error('Unexpected end of JSON input'), 1000);
    expect(copilotSemaphore.ceiling).toBe(seed);
    expect(isCopilotThrottled(1000)).toBe(false);
  });

  it('in FIXED mode, outcomes are ignored — no resize, never throttled', () => {
    applyCopilotCeiling(6); // fixed (manual)
    recordCopilotOutcome(new Error('429'), 1000);
    expect(copilotSemaphore.ceiling).toBe(6);
    expect(isCopilotThrottled(1000)).toBe(false);
  });

  it('withCopilotSlot records a rate-limit THROW → the live ceiling backs off (the chokepoint)', async () => {
    applyCopilotCeiling(undefined);
    const seed = copilotSemaphore.ceiling;
    await expect(withCopilotSlot(async () => { throw new Error('HTTP 429'); })).rejects.toThrow('429');
    expect(copilotSemaphore.ceiling).toBeLessThan(seed);
    expect(copilotSemaphore.active).toBe(0); // slot still released
  });

  it('withCopilotSlot success records ok (feeds the streak; one success is below the increase threshold)', async () => {
    applyCopilotCeiling(undefined);
    const seed = copilotSemaphore.ceiling;
    await withCopilotSlot(async () => 'fine');
    expect(copilotSemaphore.ceiling).toBe(seed); // one ok < increaseAfter → no climb yet
    expect(isCopilotThrottled()).toBe(false);
  });

  it('copilotScaleRuntime: fixed mode reports not-adaptive, effective===reference, never backed-off', () => {
    applyCopilotCeiling(6); // manual pin → fixed
    const rt = copilotScaleRuntime(1000);
    expect(rt).toMatchObject({ adaptive: false, effective: 6, reference: 6, throttled: false, backedOff: false });
  });

  it('copilotScaleRuntime: in Auto, a rate-limit shows backed-off with effective < reference (the indicator data)', () => {
    applyCopilotCeiling(undefined); // adaptive, seed = cores-derived (>= 2)
    const seed = copilotSemaphore.ceiling;
    recordCopilotOutcome(new Error('429'), 1000);
    const rt = copilotScaleRuntime(1000);
    expect(rt.adaptive).toBe(true);
    expect(rt.effective).toBeLessThan(seed);
    expect(rt.reference).toBe(seed); // climbs back toward the pre-backoff level
    expect(rt.backedOff).toBe(true);
    expect(rt.throttled).toBe(true); // inside the cooldown
  });
});

/** Local helper: run `fn` holding one slot of `sem` (mirrors withCopilotSlot but on an explicit instance). */
async function withSem<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  const release = await sem.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Like {@link withSem} but acquires through the interactive PRIORITY lane (ASK-16). */
async function withSemPriority<T>(sem: Semaphore, fn: () => Promise<T>): Promise<T> {
  const release = await sem.acquire({ priority: true });
  try {
    return await fn();
  } finally {
    release();
  }
}
