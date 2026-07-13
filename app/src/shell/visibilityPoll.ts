// Shared render-safe poll helper (#509 — deep review 2026-07-12, PERF-R1/R2/R9/R15). Every view-local
// poll needs the same three rules: pause while nobody's looking (window backgrounded or the poll's own
// view isn't the active one), stop the instant the container is detached, and never let a rejecting
// target spam an unhandledrejection / IPC / log line every tick. Before this, each view re-derived (and
// sometimes got wrong) its own version — Capture's 1.5s pipeline poll had NO visibility gate and no
// try/catch at all, and Agents' guard checked its OWN container's `.hidden` class when the shell actually
// toggles `.hidden` on an ANCESTOR `.view` wrapper (Agents' poll target is nested inside the Agents hub,
// not the `.view` itself) — so the intended pause never engaged.

/** True when `el` is actually on-screen: attached to the document, the window isn't backgrounded, and no
 *  ancestor `.view` (the shell's mount-once wrapper, SHELL-8) — or `el` itself — carries `.hidden`.
 *  Geometry-based rather than checking `el`'s own class alone, because a poll target is often nested
 *  under the toggled `.view` rather than being it (e.g. Agents' section lives inside the Agents hub). */
export function isPollTargetVisible(el: HTMLElement): boolean {
  if (!document.contains(el)) return false;
  if (document.hidden) return false;
  if (el.classList.contains('hidden')) return false; // el IS the toggled `.view` (or is hidden directly)
  const view = el.closest('.view');
  if (view?.classList.contains('hidden')) return false; // el is NESTED inside the toggled `.view`
  return true;
}

export interface VisibilityPoll {
  /** Stop polling immediately (a no-op if already stopped/detached). */
  stop(): void;
}

// Cap the backoff at 8× the base interval — bounded, so a broken IPC degrades to quiet, spaced-out
// retries (never silence forever, never an error-every-tick spam).
const MAX_BACKOFF_MULTIPLIER = 8;

/**
 * Poll `fn` on a cadence of `ms` while `el` is visible ({@link isPollTargetVisible}), skipping ticks
 * (no IPC, no work) while hidden/backgrounded, and stopping itself the moment `el` is detached — the
 * caller never needs its own `document.contains` check. A rejecting `fn` is caught here (no
 * unhandledrejection reaches the caller) and backs off geometrically, capped at {@link
 * MAX_BACKOFF_MULTIPLIER}×, resetting to the base cadence on the next success — so a hung/erroring
 * target degrades to bounded, quiet retries instead of an error (and, pre-#509, a log line + a
 * `reportRendererError` IPC) every single tick.
 */
export function createVisibilityPoll(el: HTMLElement, ms: number, fn: () => void | Promise<void>): VisibilityPoll {
  let stopped = false;
  let backoffMultiplier = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(tick, ms * backoffMultiplier);
  };

  function tick(): void {
    if (stopped) return;
    if (!document.contains(el)) {
      stopped = true; // the shell tore the container out — stop for good, mirrors the prior per-view checks
      return;
    }
    if (!isPollTargetVisible(el)) {
      scheduleNext(); // hidden/backgrounded this tick — skip the work, keep the cadence alive
      return;
    }
    Promise.resolve()
      .then(fn)
      .then(() => {
        backoffMultiplier = 1; // a success resets the backoff
      })
      .catch(() => {
        backoffMultiplier = Math.min(backoffMultiplier * 2, MAX_BACKOFF_MULTIPLIER);
      })
      .finally(scheduleNext);
  }

  scheduleNext();
  return {
    stop(): void {
      stopped = true;
      if (timer != null) clearTimeout(timer);
    },
  };
}
