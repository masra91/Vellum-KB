// Agents drill-in shell (VUX-CONFORM #524 §5, VUX-17) — shared across the three Agents-hub sub-views
// (Librarians/Schedules/Researchers). A visible chevron cue + click-to-open on every card, a detail
// panel built from EXISTING per-agent/job/researcher data. No modal/drawer primitive exists in the
// design system yet — this is an in-card `<div class="ag-detail">` toggle, not a new route (avoids
// shell.ts routing/deep-link changes). Librarians have no runs concept at all (they work continuously
// via the pipeline, not in discrete dispatches) so their panel keeps the honest "not available yet"
// placeholder; Jobs/Researchers backfill a real timeline (#559) lazily on first open.
import { esc } from '../html';

/** The chevron cue (VUX-17's own "visible chevron cue in the card head") — a REAL button, not a bare
 *  span, so it's independently focusable/keyboard-operable without making the whole card an interactive
 *  role (the card already contains other real controls — selects, buttons, <details> — so giving the
 *  card itself role="button" would be a nested-interactive-role a11y violation). */
export function drillChevronHtml(label: string): string {
  return `<button type="button" class="ag-drill" data-act="drill" aria-expanded="false" aria-label="View details for ${esc(label)}">›</button>`;
}

/** Wire click-to-open on every `.ag-card` in `container`: clicking the chevron button, or anywhere on
 *  the card that ISN'T another interactive control, toggles that card's `.ag-detail` panel. Mirrors the
 *  mock's own click-delegation guard (`e.target.closest('button,a,select,input,textarea,summary,details')`)
 *  so existing per-card controls (model picker, schedule segments, run-now button, etc.) keep working
 *  unchanged — the drill-in never swallows a click meant for them. `onOpen` fires only on the transition
 *  INTO open (#559: the hook a view uses to lazy-fetch its real past-runs timeline on first reveal, not
 *  on every render — a card the Principal never opens never costs an IPC round-trip). */
export function wireDrillIn(container: HTMLElement, onOpen?: (card: HTMLElement) => void): void {
  container.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.ag-card');
    if (!card) return;
    const target = e.target as HTMLElement;
    const isDrillButton = target.closest('.ag-drill') != null;
    // Any OTHER interactive descendant (model select, schedule segment, run-now, the model <details>,
    // per-row confirm buttons, …) keeps its own behavior — the drill-in only fires for the chevron
    // itself or a genuinely inert part of the card (avatar, name, state pill).
    if (!isDrillButton && target.closest('button, a, select, input, textarea, summary, details, [role="radio"]')) return;
    const opened = toggleDetail(card);
    if (opened && onOpen) onOpen(card);
  });
}

/** Toggles the card's detail panel; returns true when the toggle just OPENED it (false when it closed
 *  it, or when the card has no detail panel at all). */
function toggleDetail(card: HTMLElement): boolean {
  const detail = card.querySelector<HTMLElement>('.ag-detail');
  const chevron = card.querySelector<HTMLButtonElement>('.ag-drill');
  if (!detail || !chevron) return false;
  const opening = detail.hidden;
  detail.hidden = !opening;
  chevron.setAttribute('aria-expanded', String(opening));
  return opening;
}

/** The past-runs placeholder — Librarians only (#559 scoped the real timeline to Jobs/Researchers;
 *  pipeline librarians work continuously, not in discrete dispatches, so there is no run list to fetch). */
export function pastRunsPlaceholderHtml(): string {
  return `<div class="ag-detail-runs">
    <h4 class="ag-detail-h">Past runs</h4>
    <p class="ag-detail-empty viz-body">History isn’t available yet — coming once the library index can look back further.</p>
  </div>`;
}

/** The past-runs slot BEFORE the card has ever been opened (#559) — genuinely empty, not "Loading…":
 *  nothing is loading until the Principal actually opens the panel (lazy-fetch), so claiming otherwise
 *  in the initial (hidden) markup would be dishonest — and would leak "Loading…" into `.textContent`
 *  on every render whether or not anyone ever opens the card. */
export function runsPendingHtml(): string {
  return `<div class="ag-detail-runs"></div>`;
}

/** The past-runs region while its real timeline is being fetched (#559) — set at the moment a card is
 *  actually opened (never baked into the initial render). Two shaped `.skel-row` lines, the same VUX-6
 *  skeleton primitive every other view's cold-start face uses (#520 §8: never bare "Loading…" text). */
export function runsLoadingHtml(): string {
  const row = '<div class="skel-row" aria-hidden="true"><span class="skel skel-ln skel-ln--short"></span><span class="skel skel-ln"></span></div>';
  return `<div class="ag-detail-runs" aria-busy="true"><h4 class="ag-detail-h">Past runs</h4><div class="skel-rows">${row}${row}</div></div>`;
}

/** The real past-runs timeline (#559) — `rows` are pre-formatted, already-escaped HTML for one run
 *  each (newest-first, per the IPC contract); an empty array renders an honest "no runs yet" rather
 *  than nothing. */
export function runsTimelineHtml(rows: string[]): string {
  if (rows.length === 0) {
    return `<div class="ag-detail-runs"><h4 class="ag-detail-h">Past runs</h4><p class="ag-detail-empty viz-body">No runs yet.</p></div>`;
  }
  return `<div class="ag-detail-runs"><h4 class="ag-detail-h">Past runs</h4><ul class="ag-detail-runlist">${rows.map((r) => `<li class="ag-detail-run">${r}</li>`).join('')}</ul></div>`;
}

/** One labeled read-only row in a detail panel's "current config" list. */
export function detailRowHtml(label: string, value: string): string {
  return `<div class="ag-detail-row"><span class="ag-detail-k">${esc(label)}</span><span class="ag-detail-v">${esc(value)}</span></div>`;
}
