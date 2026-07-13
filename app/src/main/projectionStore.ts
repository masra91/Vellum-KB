// SHELL-12: the cached-PROJECTION backbone — the shared spine that makes the renderer NEVER block on a
// backend op. Generalized from OBS-24's status snapshot store (`statusSnapshot.ts`, now a thin adapter
// over this): every surface (status · reviews · settings · activity) reads a maintained last-known-good
// projection INSTANTLY off this store — the render path does zero git/fs/lock/recompute. A background
// refresher recomputes on a cadence OFF the render path; a slow/blocked compute simply yields a
// slightly-stale projection (honest — every read carries `builtAt` + `stale`), NEVER a render-path
// timeout. The last-known-good is persisted so launch shows the surface instantly, then goes live.
//
// Dependency-injected (compute / persistence / clock / scheduler / push) so it's unit-testable without
// a real backend, timer, or filesystem.
//
// The `Projection<T>` envelope is the cross-boundary contract (the renderer reads it too), so it lives
// in the neutral `kb/types`; this store owns the mechanics that maintain it.
import type { Projection } from '../kb/types';

export type { Projection };

export interface ProjectionStoreDeps<T> {
  /** The expensive compute (the former synchronous recompute) — run ONLY on the background cadence,
   *  never the render path. Returns null when there's nothing to project (e.g. no active KB). */
  compute: () => Promise<T | null>;
  /** Background refresh cadence in ms. */
  intervalMs: number;
  /** ISO clock for `builtAt` (injectable for tests). Default `new Date().toISOString()`. */
  now?: () => string;
  /** Load the persisted last-known-good payload (shown instantly on launch); null if none. Read at
   *  `start()` so it reflects the now-active context. Best-effort (errors → null). May return a
   *  Promise (#508 item 4 — a large persisted payload's disk read shouldn't block `start()` itself);
   *  an async load races the first live `refreshNow()` `start()` already kicks off, and only seeds the
   *  stale snapshot if the live refresh hasn't already landed one. */
  load?: () => T | null | Promise<T | null>;
  /** Persist a freshly-computed payload as the new last-known-good. Best-effort (errors swallowed). */
  save?: (data: T) => void;
  /** Report a background compute failure (the last-known-good projection is retained, marked stale). */
  onError?: (err: unknown) => void;
  /** PUSH hook (SHELL-12 (c)) — fired after each refresh that changes the projection, so the renderer
   *  can re-read instantly instead of waiting on a live recompute. Best-effort (errors swallowed). */
  onUpdate?: (projection: Projection<T>) => void;
  /** Injectable timer (tests). Defaults to global setInterval/clearInterval. */
  scheduler?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void };
}

export interface ProjectionStore<T> {
  /** The last-known-good projection, or null if none computed/persisted yet. INSTANT — no compute. */
  current(): Projection<T> | null;
  /** Begin background refresh (immediate first refresh + on the cadence). Seeds from persistence.
   *  Idempotent — a second call while running is a no-op. */
  start(): void;
  /** Stop background refresh. Retains the in-memory projection. */
  stop(): void;
  /** Run one refresh now and await it (used by `start`, post-mutation seams, and tests; coalesces
   *  concurrent calls so a slow compute never stacks). */
  refreshNow(): Promise<void>;
}

const defaultScheduler = {
  setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
  clearInterval: (handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createProjectionStore<T>(deps: ProjectionStoreDeps<T>): ProjectionStore<T> {
  const sched = deps.scheduler ?? defaultScheduler;
  const now = deps.now ?? ((): string => new Date().toISOString());
  let projection: Projection<T> | null = null;
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null; // coalesce overlapping refreshes (a slow compute must not stack)

  function set(data: T | null, stale: boolean): void {
    if (data === null) {
      projection = null; // compute reported nothing to project → nothing to show
      return;
    }
    projection = { data, builtAt: now(), stale };
    try {
      deps.onUpdate?.(projection);
    } catch {
      /* push is best-effort — a listener failure must never break the projection */
    }
  }

  async function doRefresh(): Promise<void> {
    try {
      const next = await deps.compute();
      if (next !== null) {
        // A HEAD-gated compute (#505/#506) that finds nothing changed returns the SAME reference it
        // returned last time instead of redoing the expensive work — a true no-op: no restamp, no
        // save, no push. Every other store's compute always builds a fresh object, so this branch is
        // dead weight for them (reference equality never holds by construction) — safe by default.
        if (projection && next === projection.data) return;
        set(next, false);
        try {
          deps.save?.(next);
        } catch {
          /* persistence is best-effort — a write failure must never break the projection */
        }
      } else {
        projection = null;
      }
    } catch (err) {
      deps.onError?.(err);
      // Keep the last-known-good payload but mark it stale — staleness is honest, a timeout is not.
      if (projection) set(projection.data, true);
    }
  }

  function refreshNow(): Promise<void> {
    // Coalesce: while a refresh is running, callers await the same one (no stacked computes).
    if (!inFlight) {
      inFlight = doRefresh().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    current: () => projection,
    start() {
      if (timer !== null) return;
      // Seed instantly from the persisted last-known-good for the now-active context, then go live.
      // `start()` itself stays SYNCHRONOUS even when `load` returns a Promise (#508 item 4): a seed
      // that only lands after the disk read resolves is fine — `refreshNow()` below is already racing
      // it for the live projection, and the seed is a no-op if the live one already won.
      if (deps.load) {
        try {
          const loaded = deps.load();
          if (loaded instanceof Promise) {
            loaded.then(
              (v) => {
                if (v !== null && projection === null) projection = { data: v, builtAt: now(), stale: true };
              },
              () => {
                /* best-effort seed — a failed async load just leaves projection null until the live refresh */
              },
            );
          } else if (loaded !== null) {
            projection = { data: loaded, builtAt: now(), stale: true }; // persisted = stale until first live refresh
          }
        } catch {
          projection = null;
        }
      }
      void refreshNow(); // don't wait a full interval for the first live projection
      timer = sched.setInterval(() => void refreshNow(), deps.intervalMs);
    },
    stop() {
      if (timer !== null) {
        sched.clearInterval(timer);
        timer = null;
      }
    },
    refreshNow,
  };
}
