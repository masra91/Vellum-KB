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
import { NAVIGATE_EVENT, TOPBAR_CONTEXT_EVENT, type NavigateDetail, type TopbarContextDetail } from './nav';
import { reviewBadgeText, reviewBadgeAria } from './reviewBadge';
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

// The Vellum crystalline mark as the v3 MOTION brand-diamond (SPEC-0060 §5): `.dmk` with `.is-working`
// (the inner core looms — the "always working" signature) + the shell adds `.is-thinking` (the mid frame
// churns) briefly on every view change. Gold-stroked via the v3 --gold token. Inlined; decorative.
const BRAND_DIAMOND =
  `<span class="dmk sidebar-brand-glyph brand-mark is-working" aria-hidden="true">` +
  `<svg width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="var(--gold)" stroke-linejoin="round">` +
  `<polygon class="d-out" points="12,2 22,12 12,22 2,12" stroke-width="1.4"/>` +
  `<polygon class="d-mid" points="12,7 17,12 12,17 7,12" stroke-width="1.1"/></g>` +
  `<circle class="d-core" cx="12" cy="12" r="1.9" fill="var(--gold)"/></svg></span>`;

// The v3 top bar (SPEC-0060 §4, VUX-3): a warm-themed bar with global ⌘K search, the per-view contextual
// filter slot (#topctx — filled by each view via setTopbarContext, cleared on view change), and the
// viridian Quick-add (→ Capture). Search is a command-surface affordance (⌘K focuses it); a results
// backend is a later feature, so it stays an honest entry point, not a dead control.
const TOP_BAR =
  `<div class="bar">` +
  `<button type="button" class="topsearch" id="globalSearch" title="Search everything (⌘K)" aria-label="Search everything">` +
  `${navIcon('search')}<span class="ts-ph">Search entities, claims, sources…</span><span class="kbd">⌘K</span></button>` +
  `<div class="topctx" id="topctx"></div>` +
  `<div class="topspacer"></div>` +
  `<button type="button" class="quickadd" data-goto="${VIEW_CAPTURE}">${navIcon('capture')} Quick add</button>` +
  `</div>`;
// A large, very-faint fractal-lattice watermark low in the sidebar (UX v2 shell language).
const SIDEBAR_WMARK =
  `<div class="sidebar-wmark" aria-hidden="true"><svg width="220" height="220" viewBox="0 0 24 24">` +
  `<g fill="none" stroke="var(--viz-brass)" stroke-linejoin="round" stroke-width="0.5"><polygon points="12,2 22,12 12,22 2,12"/>` +
  `<polygon points="12,7 17,12 12,17 7,12"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></g></svg></div>`;

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

/** Mount a view's content into its (freshly created) container. */
type MountFn = (container: HTMLElement) => void | Promise<void>;

/** The active shell's document-level handlers — module-scoped so a vault switch (re-mount) removes the
 *  prior shell's handlers before binding the new model, never leaking listeners / firing a stale model.
 *  `navHandler` = kb:navigate deep-links; `cmdkHandler` = ⌘K → focus global search; `ctxHandler` =
 *  kb:topbar-context → fill the per-view contextual filter slot (SPEC-0060 VUX-3). */
let navHandler: ((e: Event) => void) | null = null;
let cmdkHandler: ((e: KeyboardEvent) => void) | null = null;
let ctxHandler: ((e: Event) => void) | null = null;

export function mountShell(root: HTMLElement, vaultPath: string, name: string): void {
  const mounts: Record<string, MountFn> = {
    [VIEW_TODAY]: mountToday,
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
            <div class="user-id"><b>You</b><span>${esc(baseName(vaultPath))}</span></div>
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

  function render(): void {
    const activeId = model.activeId;

    // Lazily create + mount the active view's container on first activation.
    if (!containers.has(activeId)) {
      const el = document.createElement('div');
      el.className = 'view';
      el.dataset.view = activeId;
      host.appendChild(el);
      containers.set(activeId, el);
      void mounts[activeId]?.(el);
    }

    for (const [id, el] of containers) el.classList.toggle('hidden', id !== activeId);
    for (const b of buttons) {
      const isActive = b.dataset.view === activeId;
      b.classList.toggle('active', isActive);
      if (isActive) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }

    // v3 (SPEC-0060 §5): the brand diamond CHURNS briefly as the new view settles in; the per-view
    // contextual filter slot resets (the activated view re-fills it via setTopbarContext). Reduced-motion
    // collapses the churn (design-system.css). The host scrolls back to top on a view change.
    if (brandDiamond) {
      brandDiamond.classList.add('is-thinking');
      window.setTimeout(() => brandDiamond.classList.remove('is-thinking'), 1100);
    }
    if (topctx) topctx.textContent = '';
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

  // Top-bar wiring (SPEC-0060 §4): Quick-add → Capture; ⌘K focuses the global search (a results backend
  // is a later feature — for now an honest, focusable command surface); views fill the contextual filter
  // slot via setTopbarContext. Quick-add is a per-mount element (wired directly, no leak); the ⌘K + context
  // handlers are document-level → cleaned up + rebound per mount (mirrors navHandler).
  const quickAdd = root.querySelector<HTMLButtonElement>('.quickadd');
  quickAdd?.addEventListener('click', () => model.select(VIEW_CAPTURE));
  const search = root.querySelector<HTMLButtonElement>('#globalSearch');
  search?.addEventListener('click', () => search.focus());

  if (cmdkHandler) document.removeEventListener('keydown', cmdkHandler);
  cmdkHandler = (e: KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      search?.focus();
    }
  };
  document.addEventListener('keydown', cmdkHandler);

  if (ctxHandler) document.removeEventListener(TOPBAR_CONTEXT_EVENT, ctxHandler);
  ctxHandler = (e: Event): void => {
    // detail.html is the active view's own trusted filter markup (code-supplied, not user data).
    if (topctx) topctx.innerHTML = (e as CustomEvent<TopbarContextDetail>).detail?.html ?? '';
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
    const timer = setInterval(() => {
      if (!document.contains(root)) {
        clearInterval(timer);
        return;
      }
      // The badge lives in the always-visible rail, so it stays live across in-app view switches —
      // but skip the IPC when the window itself is hidden/backgrounded (no one's looking).
      if (document.hidden) return;
      void updateReviewBadge();
    }, 5000);
  }
}
