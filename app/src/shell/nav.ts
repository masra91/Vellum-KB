// View→view navigation primitive (SPEC-0017 SHELL). The nav model (`model.select`) is private to the
// shell module, so a view can't switch views directly. This is the thin, decoupled bridge: a view asks
// to navigate by dispatching a `kb:navigate` CustomEvent; the shell listens once and calls `select`.
// Keeps views ignorant of the shell/model (they just name a target view id), and lets any view deep-link
// to another — e.g. the Field Desk's escalation report → the Reviews queue (no dead affordance).
export const NAVIGATE_EVENT = 'kb:navigate';

/** Detail payload of a `kb:navigate` event — the target view id (one of the SHELL view constants), plus
 *  an optional `focus` (#519 §2: e.g. an entity id/rel the ⌘K search overlay resolved to) — a view that
 *  cares reads it off the event directly (the shell's mount-once model means a re-mount can't carry it). */
export interface NavigateDetail {
  view: string;
  focus?: string;
}

/** Ask the shell to switch to `view`, optionally carrying a `focus` payload the target view interprets
 *  (e.g. Explore re-centers on it). Fire-and-forget — a no-op if no shell is mounted (e.g. tests that
 *  don't mount the shell can still listen for the event to assert the intent). */
export function navigateTo(view: string, focus?: string): void {
  if (focus) pendingFocus = { view, focus };
  document.dispatchEvent(new CustomEvent<NavigateDetail>(NAVIGATE_EVENT, { detail: { view, ...(focus ? { focus } : {}) } }));
}

// A view's FIRST-EVER mount can be a direct synchronous side effect of this same navigateTo() dispatch
// (the shell's mount-once model, SHELL-8, lazily mounts on first activation) — a listener the mounting
// view registers during that mount can't retroactively catch the event that's already mid-dispatch (DOM
// event semantics). `pendingFocus` is the fallback a view consults once at mount start, in ADDITION to
// listening for `kb:navigate` for subsequent (already-mounted) jumps — one value, always freshly consumed.
let pendingFocus: { view: string; focus: string } | null = null;

/** Consume (read-and-clear) the pending focus for `view`, if `navigateTo` set one for it. Call once at
 *  mount start AND from a `kb:navigate` listener — both paths funnel through this so the value can never
 *  go stale (a later unrelated mount can't pick up an old jump). */
export function consumePendingFocus(view: string): string | undefined {
  if (pendingFocus?.view === view) {
    const f = pendingFocus.focus;
    pendingFocus = null;
    return f;
  }
  return undefined;
}

// --- SPEC-0060 VUX-3: the top bar's per-view contextual filter slot ---
// The v3 top bar carries a per-view filter slot (`#topctx`). The shell owns the slot + clears it on every
// view change; a view fills it on activation by calling `setTopbarContext(html)` (its own trusted filter
// markup — NOT user data). This is the decoupled seam (mirrors navigateTo): views stay ignorant of the
// shell. Each view rebuilt in v3 populates its own filters; until then the slot renders empty (no chrome).
export const TOPBAR_CONTEXT_EVENT = 'kb:topbar-context';

/** Detail payload of a `kb:topbar-context` event — the view's contextual-filter HTML (trusted, code-supplied). */
export interface TopbarContextDetail {
  html: string;
}

/** Set the top bar's contextual filter slot to `html` (the calling view's own trusted markup). A no-op if
 *  no shell is mounted. The shell clears the slot on each view change, so a view re-sets it on activation. */
export function setTopbarContext(html: string): void {
  document.dispatchEvent(new CustomEvent<TopbarContextDetail>(TOPBAR_CONTEXT_EVENT, { detail: { html } }));
}
