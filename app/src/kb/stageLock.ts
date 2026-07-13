// The serialized canonical writer (SPEC-0014 §5 / SPEC-0015 §5). Every pipeline stage
// runs its cognition + worktree work concurrently, but the final step that advances the
// CANONICAL vault ref (fast-forward + refresh root) must go through ONE lock per vault so
// commits land one at a time and two stages never race on the root repo's `index.lock`.
//
// In v1 the engine runs in-process, so a single shared `Mutex` instance — injected into
// every stage of a vault — IS that serialized writer. Capture, archive, and decompose all
// share one lock per vault.
//
// #163: the lock is the pipeline's single most dangerous wedge point — if a critical section
// never settles (a re-entrant `lock.run` on the same Mutex self-deadlocks, or an awaited
// promise never resolves), every future canonical write blocks behind it and the pipeline
// silently reports "Running" while doing zero work. So the Mutex is observable + self-
// surfacing: every section carries a `label` (the holder names itself in OBS-7), and a
// WATCHDOG turns a section held past a threshold into a loud dev-log warning + a `stuck` flag
// in the status snapshot — a silent wedge becomes a named, surfaced error (AUDIT-2).
import { noopDevLog, type DevLog } from './devlog';

/** A read-only snapshot of the lock for the Status view (SPEC-0030 OBS-7): is the canonical
 *  writer held right now, how many sections are waiting behind it, and (if labelled) who holds it. */
export interface LockState {
  /** True while a critical section is executing. */
  held: boolean;
  /** Sections queued behind the current holder (0 when idle/unheld). */
  waiters: number;
  /** Optional label of the current holder (e.g. the stage), when the caller passed one. */
  holder?: string;
  /** ISO timestamp the current section acquired the lock — so a long hold is visible. */
  since?: string;
  /** How long the current section has been held (ms) — lets OBS-7/11 flag a slow/stuck hold. */
  heldMs?: number;
  /** True once the current section has been held past the watchdog threshold (#163): a likely
   *  deadlock/stuck section, surfaced so the pipeline never *silently* wedges. */
  stuck?: boolean;
}

export interface MutexOptions {
  /** Where the stuck-section watchdog logs (OBS dev-log, scope `lock`). Defaults to noop. */
  log?: DevLog;
  /** Watchdog threshold (ms): a section held longer than this logs `lock.stuck` + sets `stuck`.
   *  Default 30s — far above any real canonical advance (a git ff/cherry-pick is sub-second). */
  stuckMs?: number;
  /** #515: default per-section hard timeout (ms), applied to every `run()` call that doesn't pass its
   *  own `opts.timeoutMs`. Undefined (default) disables enforcement — existing callers/tests that
   *  construct a bare `new Mutex()` keep today's behavior (a wedged section wedges the chain forever;
   *  `boundedGit`'s own process-level timeout is what unblocks a pure-git section in practice).
   *  CAUTION (KB-QD review): a timeout that fires WHILE a git call inside the section is still in
   *  flight releases the chain for the next waiter, which then runs CONCURRENTLY with the still-live
   *  orphaned write — recreating the single-writer violation #515 fixes, not mitigating it. Only safe
   *  to set on a Mutex whose EVERY section's total `boundedGit` call budget is providably < this value —
   *  the shared per-vault lock (pipeline.ts) deliberately does NOT set it today, since it's threaded
   *  through heterogeneous multi-git-call sections (connect/claims/compose/decompose) with no single
   *  safe constant. See `run()`. */
  sectionTimeoutMs?: number;
}

export interface RunOptions {
  /** Overrides the Mutex-level `sectionTimeoutMs` default for this one section. Pass `0`/`Infinity` is
   *  not special-cased — pass `undefined` to fall back to the Mutex default (which may itself be off). */
  timeoutMs?: number;
  /**
   * #507 item 4: queue this section ahead of every already-waiting NON-priority section (never ahead
   * of an already-queued priority section — priority sections still serialize FIFO among themselves).
   * Mirrors `copilotConcurrency.ts`'s `Semaphore` priority lane (ASK-16): two FIFO queues, priority
   * always drained first, background only once no priority section is waiting. This reorders WHO'S
   * NEXT, never HOW MANY run at once — exactly one section is ever active regardless of priority, so
   * the single-writer invariant is untouched; priority only bounds how long a capture-shaped write can
   * be stuck behind a long bulk/sweep pass (Connect's link/orphan/dedup tail, PERF-E3), not whether one.
   *
   * KNOWN TRADEOFF (KB-Quality-Driver review): there's no aging/round-robin/max-consecutive-priority
   * backstop — a continuous stream of priority sections could in theory starve the background lane
   * indefinitely. Accepted deliberately: this fixes captures queuing behind Connect's sweep (the
   * issue's actual scope), not general fair scheduling; captures are short-lived one-off writes (never
   * a sustained stream in practice), and a delayed background pass (Connect's sweep, an advance) is
   * idempotent/self-healing on the next tick, never a lossy outcome. Revisit only if a real workload
   * demonstrates sustained priority pressure — don't add starvation-prevention machinery pre-emptively.
   */
  priority?: boolean;
}

/** #515: a section timed out — the caller was rejected and the chain was released for the next
 *  waiter. The original `fn()` may still be running in the background (never cancelled — Node has no
 *  primitive to abort an arbitrary promise); its eventual result/error is discarded and logged. */
export class LockSectionTimeoutError extends Error {
  constructor(label: string | undefined, timeoutMs: number) {
    super(`lock section "${label ?? '(unlabeled)'}" timed out after ${timeoutMs}ms`);
    this.name = 'LockSectionTimeoutError';
  }
}

/** A tiny async mutex: serializes async work so two critical sections never overlap.
 *
 * #507 item 4: internally a QUEUE (two FIFO lanes — priority + background), not a bare promise chain.
 * `pump()` starts the next queued section once the current one finishes, priority lane first. Exactly
 * one section is ever active — priority reorders who's next, it never runs two sections concurrently. */
export class Mutex {
  private readonly waiters: Array<() => void> = []; // background lane, FIFO
  private readonly priorityWaiters: Array<() => void> = []; // priority lane, FIFO, always drained first
  // Introspection bookkeeping (OBS-7) — does NOT affect serialization, only `state()`.
  private pending = 0; // queued (both lanes) + running sections
  private running = false; // a section is executing now
  private holder: string | undefined; // label of the running section (optional)
  private heldSince: string | undefined; // ISO when it acquired
  private heldSinceMs: number | undefined; // epoch ms when it acquired (for elapsed)
  private stuck = false; // the watchdog has flagged the current section as held-too-long (#163)
  private readonly log: DevLog;
  private readonly stuckMs: number;
  private readonly sectionTimeoutMs: number | undefined;

  constructor(opts: MutexOptions = {}) {
    this.log = opts.log ?? noopDevLog;
    this.stuckMs = opts.stuckMs ?? 30_000;
    this.sectionTimeoutMs = opts.sectionTimeoutMs;
  }

  /**
   * Run `fn` as a serialized critical section. `label` is metadata for OBS-7 status (the holder
   * name) + the #163 watchdog; it never changes ordering by itself. Semantics are unchanged from the
   * original plain-FIFO design: among sections of the SAME lane (both non-priority, the default), `fn`
   * runs strictly in call order, and a failed section never wedges the lock — the queue always advances
   * on settle. `opts.priority` (#507 item 4) puts this section in the priority lane instead, served
   * ahead of every already-queued background section (never ahead of an already-queued priority one).
   *
   * #515: if a section timeout is in effect (`opts.timeoutMs` or the Mutex's `sectionTimeoutMs`
   * default), a section that hasn't settled by the deadline REJECTS ITS CALLER with
   * `LockSectionTimeoutError` and ADVANCES THE QUEUE — the next queued section runs immediately,
   * rather than waiting on a wedge that may never clear. The timed-out `fn()` keeps running
   * in the background (Node can't cancel an arbitrary promise); its eventual settlement only
   * updates `state()` bookkeeping and is otherwise discarded. This is a backstop for non-git work
   * in a section (fs writes, sidecar reads) — a section built entirely from `boundedGit` calls
   * already self-unwedges via git's own process-level timeout.
   */
  run<T>(fn: () => Promise<T>, label?: string, opts: RunOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.sectionTimeoutMs;
    this.pending += 1;
    return new Promise<T>((resolveOuter, rejectOuter) => {
      let settledOuter = false; // guards timeout-vs-real-settle: whichever fires first wins
      const resolve = (v: T): void => {
        if (settledOuter) return;
        settledOuter = true;
        resolveOuter(v);
      };
      const reject = (e: unknown): void => {
        if (settledOuter) return;
        settledOuter = true;
        rejectOuter(e);
      };

      const start = (): void => {
        this.running = true;
        this.holder = label;
        this.heldSince = new Date().toISOString();
        this.heldSinceMs = Date.now();
        this.stuck = false;
        const startedAt = this.heldSinceMs;
        // #163 watchdog: a section that never settles would otherwise wedge the pipeline silently.
        // Surface it loudly past the threshold (named by `label`). `unref` so an idle watchdog never
        // keeps the process alive.
        const watchdog = setTimeout(() => {
          this.stuck = true;
          this.log.warn('lock.stuck', {
            holder: label ?? '(unlabeled)',
            since: this.heldSince,
            elapsedMs: Date.now() - startedAt,
            thresholdMs: this.stuckMs,
            waiters: Math.max(0, this.pending - 1),
          });
        }, this.stuckMs);
        if (typeof watchdog.unref === 'function') watchdog.unref();

        let timer: ReturnType<typeof setTimeout> | undefined;
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            this.log.error('lock.section-timeout', {
              holder: label ?? '(unlabeled)',
              timeoutMs,
              waiters: Math.max(0, this.pending - 1),
            });
            reject(new LockSectionTimeoutError(label, timeoutMs));
            advance(); // release the queue for the next waiter — the orphaned fn() settles in the background
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }

        let advanced = false;
        const advance = (): void => {
          if (advanced) return;
          advanced = true;
          clearTimeout(watchdog);
          if (timer) clearTimeout(timer);
          this.running = false;
          this.holder = undefined;
          this.heldSince = undefined;
          this.heldSinceMs = undefined;
          this.stuck = false;
          this.pending -= 1;
          this.pump();
        };

        fn().then(
          (v) => {
            resolve(v);
            advance();
          },
          (e) => {
            reject(e);
            advance();
          },
        );
      };

      if (opts.priority) this.priorityWaiters.push(start);
      else this.waiters.push(start);
      this.pump();
    });
  }

  /** Start the next queued section, priority lane first, iff nothing is currently running. Called on
   *  every enqueue and every settle — the only place a section transitions from queued to running. */
  private pump(): void {
    if (this.running) return; // exactly one section active at a time, regardless of lane
    const next = this.priorityWaiters.shift() ?? this.waiters.shift();
    if (next) next();
  }

  /** A read-only snapshot for the Status view (OBS-7). */
  state(): LockState {
    return {
      held: this.running,
      waiters: Math.max(0, this.pending - (this.running ? 1 : 0)),
      ...(this.holder !== undefined ? { holder: this.holder } : {}),
      ...(this.heldSince !== undefined ? { since: this.heldSince } : {}),
      ...(this.running && this.heldSinceMs !== undefined ? { heldMs: Date.now() - this.heldSinceMs } : {}),
      ...(this.stuck ? { stuck: true } : {}),
    };
  }
}
