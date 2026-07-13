// The view lifecycle contract (SPEC-0058 STATE-8, issue #510). Before this, the shell had NO show/hide/
// unmount concept: `render()` only toggled a `.hidden` CSS class, so every registered view's live-update
// logic (polling, subscriptions, timers) had to self-police visibility with ad-hoc `document.contains` /
// `classList.contains('hidden')` checks scattered per view — several of them wrong (checking the view's
// OWN element instead of the shell's outer `.view` wrapper) or missing a stop entirely, leaking an
// interval that ticks forever once a view is ever mounted.
//
// `mount()` now optionally returns a `ViewHandle`: `show()` fires when the view becomes the active one
// (including immediately after its very first mount, so "start listening for live updates + paint the
// latest data" lives in ONE place, not split between mount-time and re-activation — this is what
// unfreezes a view on switching back to it, STATE-8 AC1); `hide()` fires when the view is switched away
// from and MUST stop every timer/subscription the view started (no leaked interval ticking a hidden
// view — the contract every registered view is swept against, see shell.test.ts's lifecycle sweep);
// `unmount()` is reserved for a future full-teardown path (e.g. a vault switch tearing down the whole
// shell) — not yet invoked by `render()` today, since views are still mounted once for the shell's life.

/** Optional per-view lifecycle hooks a `mount()` returns to hand the shell control over its live behavior. */
export interface ViewHandle {
  /** The view is now the active/visible one. Re-read the latest (possibly pushed) data and resume any
   *  live subscription/timer. Called once right after the view's first mount, and again every time the
   *  view is reactivated after being hidden. Must be safe to call more than once in a row (idempotent). */
  show?: () => void;
  /** The view was switched away from. Must stop every timer/subscription started in `show()` (or `mount()`)
   *  — the contract sweep asserts zero leaked timers across every registered view after `hide()`. */
  hide?: () => void;
  /** The view's container is being permanently torn down. Reserved for a future full-unmount path. */
  unmount?: () => void;
}

/** A view's mount function: builds its DOM into `container` and optionally returns lifecycle hooks
 *  (sync or async — many views need an initial IPC read before they have anything to hand back). */
export type MountFn = (container: HTMLElement) => ViewHandle | void | Promise<ViewHandle | void>;
