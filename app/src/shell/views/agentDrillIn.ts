// Agents drill-in shell (VUX-CONFORM #524 §5, VUX-17) — shared across the three Agents-hub sub-views
// (Librarians/Schedules/Researchers). Ship-the-shell scope: a visible chevron cue + click-to-open on
// every card, a detail panel built from EXISTING per-agent/job/researcher data (no new store), and a
// calm "not available yet" placeholder for the past-runs timeline (the richer history view is a fast-
// follow once SPEC-0061 T1's run-history index is queryable). No modal/drawer primitive exists in the
// design system yet — this is an in-card `<div class="ag-detail">` toggle, not a new route (avoids
// shell.ts routing/deep-link changes for a "ship now" slice).
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
 *  unchanged — the drill-in never swallows a click meant for them. */
export function wireDrillIn(container: HTMLElement): void {
  container.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.ag-card');
    if (!card) return;
    const target = e.target as HTMLElement;
    const isDrillButton = target.closest('.ag-drill') != null;
    // Any OTHER interactive descendant (model select, schedule segment, run-now, the model <details>,
    // per-row confirm buttons, …) keeps its own behavior — the drill-in only fires for the chevron
    // itself or a genuinely inert part of the card (avatar, name, state pill).
    if (!isDrillButton && target.closest('button, a, select, input, textarea, summary, details, [role="radio"]')) return;
    toggleDetail(card);
  });
}

function toggleDetail(card: HTMLElement): void {
  const detail = card.querySelector<HTMLElement>('.ag-detail');
  const chevron = card.querySelector<HTMLButtonElement>('.ag-drill');
  if (!detail || !chevron) return;
  const open = detail.hidden;
  detail.hidden = !open;
  chevron.setAttribute('aria-expanded', String(open));
}

/** The past-runs placeholder (VUX-17 §5's approved sequencing, step 2): a calm "not available yet"
 *  state, not a broken/empty look — the timeline is a fast-follow once SPEC-0061 T1's run-history index
 *  (wave-1 #530) is queryable. Every detail panel ends with this, regardless of item type. */
export function pastRunsPlaceholderHtml(): string {
  return `<div class="ag-detail-runs">
    <h4 class="ag-detail-h">Past runs</h4>
    <p class="ag-detail-empty viz-body">History isn’t available yet — coming once the library index can look back further.</p>
  </div>`;
}

/** One labeled read-only row in a detail panel's "current config" list. */
export function detailRowHtml(label: string, value: string): string {
  return `<div class="ag-detail-row"><span class="ag-detail-k">${esc(label)}</span><span class="ag-detail-v">${esc(value)}</span></div>`;
}
