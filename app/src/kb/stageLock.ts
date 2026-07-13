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
   *  `boundedGit`'s own process-level timeout is what unblocks a pure-git section in practice). Set
   *  this on the shared per-vault lock as defense-in-depth for the non-git work inside a section
   *  (fs writes, sidecar reads) that boundedGit can't bound. See `run()`. */
  sectionTimeoutMs?: number;
}

export interface RunOptions {
  /** Overrides the Mutex-level `sectionTimeoutMs` default for this one section. Pass `0`/`Infinity` is
   *  not special-cased — pass `undefined` to fall back to the Mutex default (which may itself be off). */
  timeoutMs?: number;
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

/** A tiny async mutex: serializes async work so two critical sections never overlap. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  // Introspection bookkeeping (OBS-7) — does NOT affect serialization, only `state()`.
  private pending = 0; // queued + running sections
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
   * name) + the #163 watchdog; it never changes ordering. Semantics are unchanged: `fn` runs after
   * the prior section settles (success OR failure), and the chain advances on `finally` so a failed
   * section never wedges the lock. A section held past `stuckMs` logs a loud `lock.stuck` warning +
   * sets the `stuck` status flag (a silent wedge becomes a named, surfaced error — AUDIT-2).
   *
   * #515: if a section timeout is in effect (`opts.timeoutMs` or the Mutex's `sectionTimeoutMs`
   * default), a section that hasn't settled by the deadline REJECTS ITS CALLER with
   * `LockSectionTimeoutError` and RELEASES THE CHAIN — the next queued section runs immediately,
   * rather than waiting on a wedge that may never clear. The timed-out `fn()` keeps running
   * in the background (Node can't cancel an arbitrary promise); its eventual settlement only
   * updates `state()` bookkeeping and is otherwise discarded. This is a backstop for non-git work
   * in a section (fs writes, sidecar reads) — a section built entirely from `boundedGit` calls
   * already self-unwedges via git's own process-level timeout.
   */
  run<T>(fn: () => Promise<T>, label?: string, opts: RunOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.sectionTimeoutMs;
    const prev = this.tail;
    this.pending += 1;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runFn = async (): Promise<T> => {
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
      try {
        return await fn();
      } finally {
        clearTimeout(watchdog);
        this.running = false;
        this.holder = undefined;
        this.heldSince = undefined;
        this.heldSinceMs = undefined;
        this.stuck = false;
      }
    };
    const settled = prev.then(runFn, runFn);
    let chainReleased = false;
    const releaseChain = (): void => {
      if (chainReleased) return;
      chainReleased = true;
      this.pending -= 1;
      release();
    };
    settled.finally(releaseChain);
    // Swallow a background rejection from the orphaned `fn()` after a timeout has already settled the
    // caller — otherwise it surfaces as an unhandled rejection with nothing left to catch it.
    settled.catch(() => {});
    if (timeoutMs === undefined) return settled;
    return new Promise<T>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.log.error('lock.section-timeout', {
          holder: label ?? '(unlabeled)',
          timeoutMs,
          waiters: Math.max(0, this.pending - 1),
        });
        releaseChain();
        reject(new LockSectionTimeoutError(label, timeoutMs));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      settled.then(
        (value) => {
          clearTimeout(timer);
          if (!timedOut) resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          if (!timedOut) reject(err);
        },
      );
    });
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
