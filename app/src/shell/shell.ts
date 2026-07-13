// App Navigation Shell — DOM layer (SPEC-0017 SHELL-1/2/3/4).
//
// Thin glue over the pure navModel (SHELL-6): it renders a persistent left rail and
// a single content region, mounts each view lazily once, and switches by toggling
// visibility (which is what lets in-progress capture text survive a switch — SHELL-8).
import { createNavModel, type NavView } from './navModel';
import {
  NAV_VIEWS,
  DEFAULT_VIEW_ID,
  VIEW_TODAY,
  VIEW_CAPTURE,
  VIEW_REVIEWS,
  VIEW_ACTIVITY,
  VIEW_ASK,
  VIEW_EXPLORE,
  VIEW_HEALTH,
  VIEW_AGENTS,
  VIEW_SOURCES,
  VIEW_CONNECTORS,
  VIEW_SETTINGS,
} from './views';
import { esc, baseName } from './html';
import { navIcon } from './icons';
import { latticeMotif } from './latticeMotif';
import { NAVIGATE_EVENT, TOPBAR_CONTEXT_EVENT, type NavigateDetail, type TopbarContextDetail } from './nav';
import { wireTopbarSearch } from './topbarSearch';
import { reviewBadgeText, reviewBadgeAria } from './reviewBadge';
import { createVisibilityPoll, type VisibilityPoll } from './visibilityPoll';
import { renderLoadError, reportLoadFailure } from './loadGuard';
import { mountToday } from './views/todayView';
import { mountCapture } from './views/captureView';
import { mountReviews } from './views/reviewsView';
import { mountActivity } from './views/activityView';
import { mountAsk } from './views/askView';
import { mountExplore } from './views/exploreView';
import { mountHealth } from './views/healthView';
import { mountAgentsHub } from './views/agentsHubView';
import { mountSources } from './views/sourcesView';
import { mountSettings } from './views/settingsView';
import type { MountFn, ViewHandle } from './viewLifecycle';
import type { TodayProjectionView } from '../kb/types';

// The Vellum crystalline mark as the v3 MOTION brand-diamond (SPEC-0060 §5): `.dmk` with `.is-working`
// (the inner core looms — the "always working" signature) + the shell adds `.is-thinking` (the mid frame
// churns) briefly on every view change. Gold-stroked via the v3 --gold token. Inlined; decorative.
const BRAND_DIAMOND =
  `<span class="dmk sidebar-brand-glyph brand-mark is-working" aria-hidden="true">` +
  latticeMotif({ size: 24, depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1], levelClassNames: ['d-out', 'd-mid'], core: 'dot', coreClassName: 'd-core' }) +
  `</span>`;

// The v3 top bar (SPEC-0060 §4, VUX-3): a warm-themed bar with a REAL global ⌘K search (#519 §2 — a
// live `<input>` + a `role="listbox"` results overlay, wired by topbarSearch.ts), the per-view
// contextual filter slot (#topctx — filled by each view via setTopbarContext, cleared on view change),
// and the viridian Quick-add (→ Capture). The glyph + ⌘K hint are siblings of the input (an `<input>`
// can't hold child elements) inside `.topsearch-shell`, which carries the pill visual `.topsearch` used
// to own directly.
const TOP_BAR =
  `<div class="bar">` +
  `<div class="topsearch-shell">` +
  `<span class="ts-glyph" aria-hidden="true">${navIcon('search')}</span>` +
  `<input type="text" class="topsearch" id="globalSearch" placeholder="Search entities, claims, sources…" ` +
  `aria-label="Search everything" autocomplete="off" role="combobox" aria-expanded="false" ` +
  `aria-controls="searchResults" aria-autocomplete="list" />` +
  `<span class="kbd" aria-hidden="true">⌘K</span>` +
  `<div class="search-results" id="searchResults" role="listbox" aria-label="Search results" hidden></div>` +
  `</div>` +
  `<div class="topctx" id="topctx"></div>` +
  `<div class="topspacer"></div>` +
  `<button type="button" class="quickadd" data-goto="${VIEW_CAPTURE}">${navIcon('capture')} Quick add</button>` +
  `</div>`;
// A large, very-faint fractal-lattice watermark low in the sidebar (UX v2 shell language).
// #402 §3: was `var(--viz-brass)` — the "needs you / caution" semantic state hue, wrong for a silent
// decorative watermark (terminology.md §3: never for reassurance/informational chrome). The motif is
// gold-only per BRAND-GUIDELINES §3; this now matches BRAND_DIAMOND's stroke + the source SVG's gradient.
const SIDEBAR_WMARK =
  `<div class="sidebar-wmark" aria-hidden="true">` +
  latticeMotif({ size: 220, depth: 2, stroke: 'var(--gold)', strokeWidths: [0.5, 0.5], crosshair: true, crosshairStrokeWidth: 0.5 }) +
  `</div>`;

// #512 PERF-R8: SIDEBAR_WMARK's ambient `viz-drift` animation used to run unconditionally the ENTIRE
// time the app is open (it's persistent shell chrome, not tied to any view) — pure decoration keeping
// the compositor from ever going idle in the background/unfocused. `body.shell-idle` (index.css) pauses
// it via `animation-play-state`; toggled here, once, on blur/focus/visibilitychange. No per-mount
// closure state (unlike navHandler/cmdkHandler/ctxHandler below), so — unlike those — this registers
// once at module load rather than re-binding on every `mountShell` call.
function updateShellIdleClass(): void {
  document.body.classList.toggle('shell-idle', document.hidden || !document.hasFocus());
}
if (typeof window !== 'undefined') {
  window.addEventListener('blur', updateShellIdleClass);
  window.addEventListener('focus', updateShellIdleClass);
  document.addEventListener('visibilitychange', updateShellIdleClass);
}

/** Build the rail's inner HTML: a section heading before each new `group`, then one button per view. */
function railHtml(views: readonly NavView[]): string {
  let lastGroup: string | undefined;
  let html = '';
  for (const v of views) {
    if (v.group && v.group !== lastGroup) {
      html += `<div class="nav-group" role="presentation">${esc(v.group)}</div>`;
    }
    lastGroup = v.group;
    html +=
      `<button type="button" class="nav-item" data-view="${esc(v.id)}">` +
      // v.icon is a trusted icon-set KEY → inline line-icon SVG (UX v2); navIcon returns '' for an unknown key.
      `<span class="nav-icon" aria-hidden="true">${v.icon ? navIcon(v.icon) : ''}</span>` +
      `<span class="nav-label">${esc(v.label)}</span></button>`;
  }
  return html;
}

/** The active shell's document-level handlers — module-scoped so a vault switch (re-mount) removes the
 *  prior shell's handlers before binding the new model, never leaking listeners / firing a stale model.
 *  `navHandler` = kb:navigate deep-links; `cmdkHandler` = ⌘K → focus global search; `ctxHandler` =
 *  kb:topbar-context → fill the per-view contextual filter slot (SPEC-0060 VUX-3). */
let navHandler: ((e: Event) => void) | null = null;
let cmdkHandler: ((e: KeyboardEvent) => void) | null = null;
let ctxHandler: ((e: Event) => void) | null = null;
// The reviews rail badge poll (#509): a vault switch calls `mountShell` again on the SAME `root` element
// (`root.innerHTML` is replaced, `root` itself never leaves the document), so the prior interval's own
// `document.contains(root)` self-stop check never fired — every re-mount stacked ANOTHER permanent poller
// pinning the detached prior `reviewsBtn` forever. Stop the previous one explicitly, mirroring the
// nav/cmdk/ctx handler re-bind pattern above.
let badgePoll: VisibilityPoll | null = null;

export function mountShell(root: HTMLElement, vaultPath: string, name: string, todayPrefetch?: Promise<TodayProjectionView>): void {
  badgePoll?.stop(); // #509: stop the PRIOR shell's badge poll before this (re)mount starts a new one
  badgePoll = null;

  const mounts: Record<string, MountFn> = {
    // #512 PERF-R6: hand Today the read the caller may have already kicked off concurrently with
    // getState() — its OWN show()/load() still does a fresh read on every later activation.
    [VIEW_TODAY]: (c) => mountToday(c, todayPrefetch),
    [VIEW_CAPTURE]: (c) => mountCapture(c, vaultPath, name),
    [VIEW_REVIEWS]: mountReviews,
    [VIEW_ACTIVITY]: mountActivity,
    [VIEW_ASK]: mountAsk,
    [VIEW_EXPLORE]: mountExplore,
    [VIEW_HEALTH]: mountHealth,
    [VIEW_AGENTS]: mountAgentsHub,
    // SPEC-0060 VUX-4: the rail entry is now "Connectors", aliased to the existing Sources mount until the
    // Connectors view rebuild lands (its own PR). VIEW_SOURCES stays mounted for any 'sources' deep-link.
    // Status is DISSOLVED (no rail entry, no mount) — its flow folds into Today/Health; nothing deep-links
    // to it (verified), so there is no dead route.
    [VIEW_CONNECTORS]: mountSources,
    [VIEW_SOURCES]: mountSources,
    [VIEW_SETTINGS]: mountSettings,
  };

  const model = createNavModel(NAV_VIEWS, DEFAULT_VIEW_ID);

  // View→view deep-links (SHELL): a view dispatches `kb:navigate` (e.g. the Field Desk escalation report
  // → Reviews); we select the named view if it's a real one. Re-bind per mount (vault switch) so the
  // handler always drives the CURRENT model — remove the prior shell's first (no leak / stale select).
  if (navHandler) document.removeEventListener(NAVIGATE_EVENT, navHandler);
  navHandler = (e: Event): void => {
    const view = (e as CustomEvent<NavigateDetail>).detail?.view;
    if (typeof view === 'string' && view in mounts) model.select(view);
  };
  document.addEventListener(NAVIGATE_EVENT, navHandler);

  document.body.classList.add('shell-active');
  root.innerHTML = `
    <div class="win">
      ${TOP_BAR}
      <div class="body">
        <nav class="sidebar" aria-label="Primary">
          <div class="sidebar-brand">${BRAND_DIAMOND}<span class="sidebar-brand-name viz-voice">Vellum</span></div>
          <div class="sidebar-nav">${railHtml(NAV_VIEWS)}</div>
          ${SIDEBAR_WMARK}
          <div class="user" title="You — your library identity">
            <span class="user-ini" aria-hidden="true">${navIcon('person')}</span>
            <div class="user-id"><b>You</b><span title="${esc(baseName(vaultPath))}">${esc(baseName(vaultPath))}</span></div>
          </div>
        </nav>
        <main class="content" id="viewHost"></main>
      </div>
    </div>
    <div id="viewAnnounce" class="sr-only" aria-live="polite" role="status"></div>`;

  const host = root.querySelector('#viewHost') as HTMLElement;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('.nav-item'));
  const brandDiamond = root.querySelector<HTMLElement>('.brand-mark');
  const topctx = root.querySelector<HTMLElement>('#topctx');
  const viewAnnounce = root.querySelector<HTMLElement>('#viewAnnounce');
  const containers = new Map<string, HTMLElement>();
  // #519 §3 — the shell mounts each view ONCE (SHELL-8); a REVISIT to an already-mounted view just
  // toggles `.hidden` and runs no view code, so nothing would re-fill #topctx (cleared on the way out) —
  // it'd read empty on the second visit even though the view "fills" it per the AC. Caching the last HTML
  // each view handed to setTopbarContext, keyed by view id, and restoring it on every activation (not just
  // first mount) fixes this centrally, for every current AND future filler-view, no per-view code needed.
  const lastTopctxByView = new Map<string, string>();
  // SPEC-0058 STATE-8 (#510): each mounted view's lifecycle hooks, keyed by view id. A view with no
  // live behavior returns no handle (or omits show/hide) — hide()/show() are no-ops for it.
  const handles = new Map<string, ViewHandle>();
  // The view id `hide()` was last called for lacking a matching `show()` yet — tracks which view to
  // deactivate on the NEXT render (the shell must hide the PREVIOUSLY active view, not the new one).
  let previousActiveId: string | null = null;

  // BUG-12 (#518): the container used to be cached (containers.set, above) BEFORE the (possibly async)
  // mount settled, via a bare `void Promise.resolve(mounts[activeId]?.(el)).then(...)` with no `.catch` —
  // a rejecting (or synchronously throwing) mount was telemetry-silent, and since `containers.has(activeId)`
  // stayed true forever, every later revisit fell into the "already mounted" branch below and found no
  // `handle` — a permanently blank pane until relaunch. Now a mount failure (sync throw OR async rejection)
  // is un-swallowed to the app-log (reportLoadFailure) and renders the shared retryable error face directly
  // into the SAME already-appended container (loadGuard's renderLoadError, the same primitive every view
  // uses for its own internal load failures) — Retry re-invokes this same attempt against that container,
  // no orphaned DOM nodes, no dead end.
  function attemptMount(activeId: string, el: HTMLElement): void {
    const onFailure = (err: unknown): void => {
      reportLoadFailure(activeId, err);
      handles.delete(activeId); // a half-registered handle from a partial mount must not receive show()/hide()
      const label = NAV_VIEWS.find((v) => v.id === activeId)?.label ?? activeId;
      renderLoadError(el, `<h1 class="viz-voice">${esc(label)}</h1>`, () => attemptMount(activeId, el));
    };
    try {
      Promise.resolve(mounts[activeId]?.(el))
        .then((handle) => {
          if (handle) handles.set(activeId, handle);
          if (model.activeId === activeId) handle?.show?.();
        })
        .catch(onFailure);
    } catch (err) {
      onFailure(err); // a mount that throws SYNCHRONOUSLY (never returns a promise to reject) needs the same fallback
    }
  }

  function render(): void {
    const activeId = model.activeId;

    // Lazily create + mount the active view's container on first activation. `show()` fires once the
    // (possibly async) mount resolves — but only if this view is STILL the active one by then (a rapid
    // navigate-away-before-mount-finishes race must not paint/subscribe a view nobody's looking at).
    if (!containers.has(activeId)) {
      const el = document.createElement('div');
      el.className = 'view';
      el.dataset.view = activeId;
      host.appendChild(el);
      containers.set(activeId, el);
      attemptMount(activeId, el);
    } else {
      // Already mounted — reactivating. `show()` re-reads the (instant, possibly push-updated)
      // projection and resumes any live subscription (STATE-8 AC1: switching back repaints fresh data
      // without a poll having run while hidden).
      handles.get(activeId)?.show?.();
    }

    // The PREVIOUSLY active view (if any, and if it actually changed) stops its live behavior within
    // this tick (STATE-8 AC1) — `hide()` must clear every timer/subscription it started.
    if (previousActiveId !== null && previousActiveId !== activeId) {
      handles.get(previousActiveId)?.hide?.();
    }
    previousActiveId = activeId;

    for (const [id, el] of containers) el.classList.toggle('hidden', id !== activeId);
    for (const b of buttons) {
      const isActive = b.dataset.view === activeId;
      b.classList.toggle('active', isActive);
      if (isActive) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }

    // v3 (SPEC-0060 §5): the brand diamond CHURNS briefly as the new view settles in; the per-view
    // contextual filter slot restores the activated view's last-known filler (or empties, for a view on
    // the documented empty list) — see the `lastTopctxByView` note above. Reduced-motion collapses the
    // churn (design-system.css). The host scrolls back to top on a view change.
    if (brandDiamond) {
      brandDiamond.classList.add('is-thinking');
      window.setTimeout(() => brandDiamond.classList.remove('is-thinking'), 1100);
    }
    if (topctx) topctx.innerHTML = lastTopctxByView.get(activeId) ?? '';
    host.scrollTop = 0;

    // VUX-CONFORM #524 §6: announce every route change to screen readers — a silent view swap gives
    // no cue the content region just changed. Mirrors the ConfirmInline aria-live="polite" convention
    // (_design-system.md §5) rather than inventing a second live-region pattern.
    if (viewAnnounce) {
      const activeLabel = NAV_VIEWS.find((v) => v.id === activeId)?.label ?? activeId;
      viewAnnounce.textContent = `${activeLabel} view`;
    }
  }

  for (const b of buttons) {
    b.addEventListener('click', () => model.select(b.dataset.view!));
  }

  // Top-bar wiring (#519 §2/§4): Quick-add → Capture; ⌘K focuses + selects the REAL search input (topbarSearch.ts
  // owns the input/type-ahead/Enter-to-navigate wiring); views fill the contextual filter slot via
  // setTopbarContext. Quick-add is a per-mount element (wired directly, no leak); the ⌘K + context
  // handlers are document-level → cleaned up + rebound per mount (mirrors navHandler).
  const quickAdd = root.querySelector<HTMLButtonElement>('.quickadd');
  quickAdd?.addEventListener('click', () => model.select(VIEW_CAPTURE));
  const search = wireTopbarSearch(root);

  if (cmdkHandler) document.removeEventListener('keydown', cmdkHandler);
  cmdkHandler = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      search?.focus();
      search?.select(); // re-summon convention: a repeat ⌘K re-selects for a fresh query
    }
  };
  document.addEventListener('keydown', cmdkHandler);

  if (ctxHandler) document.removeEventListener(TOPBAR_CONTEXT_EVENT, ctxHandler);
  ctxHandler = (e: Event): void => {
    // detail.html is the active view's own trusted filter markup (code-supplied, not user data). Cached
    // under the CURRENTLY active view so a later revisit (no view code re-runs) restores it — see
    // `lastTopctxByView` above.
    const html = (e as CustomEvent<TopbarContextDetail>).detail?.html ?? '';
    lastTopctxByView.set(model.activeId, html);
    if (topctx) topctx.innerHTML = html;
  };
  document.addEventListener(TOPBAR_CONTEXT_EVENT, ctxHandler);

  model.onChange(render);
  render(); // initial paint → Today, the launch home (SPEC-0058 default)

  // PANEL-8: surface the "needs you" review count on the Reviews rail item, so it's visible from
  // anywhere (incl. the Manage section) and the item links to the queue (clicking it navigates).
  // Live via a light poll; stops if the shell is detached. Never errors the shell (degrades to no badge).
  const reviewsBtn = buttons.find((b) => b.dataset.view === VIEW_REVIEWS);
  if (reviewsBtn) {
    const updateReviewBadge = async (): Promise<void> => {
      let count = 0;
      try {
        count = (await window.kbApi.listReviews()).length;
      } catch {
        return; // leave the last-known badge
      }
      let badge = reviewsBtn.querySelector<HTMLElement>('.nav-badge');
      const text = reviewBadgeText(count);
      if (!text) {
        badge?.remove();
        reviewsBtn.removeAttribute('aria-label');
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        badge.setAttribute('aria-hidden', 'true');
        reviewsBtn.appendChild(badge);
      }
      badge.textContent = text;
      reviewsBtn.setAttribute('aria-label', `${reviewsBtn.textContent?.trim() ?? 'Reviews'} — ${reviewBadgeAria(count)}`);
    };
    void updateReviewBadge();
    // The badge lives in the always-visible rail, so it stays live across in-app view switches (`root`
    // has no `.view` ancestor to gate on) — but skips the IPC when the window itself is hidden/backgrounded
    // (no one's looking), and stops itself once `root` is detached.
    badgePoll = createVisibilityPoll(root, 5000, updateReviewBadge);
  }
}
