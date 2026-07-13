// Reviews view — the "needs you" queue (SPEC-0018 REVIEW-10). Lists open reviews; each is a
// single yes/no question with expandable context, a Confirm / Reject pair, and an optional
// note (a correction or extra context that becomes a primary source — REVIEW-7). Thin DOM
// over the typed IPC (REVIEW-11); the main process owns the store.
//
// #110: the view is mounted ONCE and shown by un-hiding it (shell mount-once, SHELL-8), while the
// rail badge live-polls `listReviews()` every 5s. So a review raised AFTER the view first mounted
// (e.g. a CONNECT-15 ambiguous-link review) made the badge tick to "1" while this list stayed frozen
// on its initial "Nothing needs you" — count vs list disagreed and a real review couldn't be acted
// on. Fix: a visibility-aware refresh poll, same cadence as the badge, so the list always reflects
// the same `listReviews()` the badge counts. It re-renders only when the open-review *set* changes
// and never while a note is being written (so it can't clobber in-progress input).
import { esc, emptyState } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import { createVisibilityPoll, type VisibilityPoll } from '../visibilityPoll';
import { subscribeProjectionChanged } from '../projectionPush';
import type { ViewHandle } from '../viewLifecycle';

// UX v2 (SPEC-0058): the Reviews "needs you" queue, lifted off the legacy `.card`/`--border` chrome onto
// the v2 material. `reviews-v2` scopes every override to this surface. Reviews is the ONE peripheral screen
// where EMBER is correct (DL-2 contract / language §4): an open review IS a "needs your decision" cue — each
// item wears an ember spine. The empty state stays calm (no ember, no 🎉 — a quiet v2 `.viz-empty`). Heads
// = Spectral (no 🔍), data = mono, copy = Inter sentence case.
const V2 = 'reviews-v2 viz-surface';
const V2_HEAD = `<h1 class="reviews-title viz-voice">Reviews</h1>`;
import type { ReviewSummary, Projection, SetAsideView, PipelineControlRequest } from '../../kb/types';
import type { ReviewSubjectCandidate } from '../../kb/reviews';
import { stageDisplayName } from '../stageLabels';

/** Poll cadence — matches the rail badge (shell.ts) so the list and the count never drift. */
const REVIEW_POLL_MS = 5000;

// Canonical ULID shape (Crockford base32, 26 chars), re-stated as a pure regex — `ulid.ts` value-imports
// `node:crypto` and THIS module is renderer-bundled (#248 boundary). Global + token-bounded so it scrubs
// a bare ULID anywhere in user-surfaced text. Excludes I/L/O/U like Crockford's alphabet.
const ULID_TOKEN_RE = /\b[0-9A-HJKM-NP-TV-Z]{26}\b/gi;

/**
 * Backstop render guard (PRIN-24 / "never surface ULIDs"): strip any bare source/entity ULID that a
 * model parroted into agent-authored review text (question / detail / gloss). The PRIMARY fix feeds the
 * Connect prompt source TITLES not ids (connectAgent.ts), so this should rarely fire — but a stray id
 * must never reach the Principal. Replaced with a neutral word, not deleted, so the sentence still reads.
 */
function scrubUlids(text: string | null | undefined): string {
  return typeof text === 'string' ? text.replace(ULID_TOKEN_RE, 'a source') : '';
}

// View-local state (the shell mounts this view once; reset on each mount for test isolation).
let poll: VisibilityPoll | undefined;
let renderedSig = ''; // the open-review id set currently painted — re-render only when it changes
// REVIEW-20 (optimistic confirm/deny): an answered item leaves the queue INSTANTLY on click; the
// verdict IPC + backend resume/merge run async (the UI never waits). `answeredIds` suppresses an
// optimistically-removed item from the reconcile poll so it can't flicker back before the backend (and
// the SHELL-12 projection `listReviews` reads) catch up; `failedIds` re-surfaces an item whose async
// answer failed, carrying an honest error affordance; `lastList` is the last fetched queue so an
// optimistic mutation can re-derive the painted set without a refetch.
let answeredIds = new Set<string>();
let failedIds = new Map<string, string>();
let lastList: ReviewSummary[] = [];
// #192/VIZ-7 — set-aside recovery (the pipeline's poison-item queue, OBS-17) lives in its own oxide-toned
// section of this same view, visually distinct from the ember review cards above (DL-2's IA call: Reviews
// already owns "needs a human decision", but set-aside is NOT part of the counted question queue — the
// VIZ-7 baseline, not the unified brass queue that spec explicitly defers). Same optimistic-remove /
// reconcile-on-failure shape as `answeredIds`/`failedIds`/`lastList` above, keyed by `stage:itemId`.
let setAsideAnsweredKeys = new Set<string>();
let setAsideFailedKeys = new Map<string, string>();
let lastSetAside: SetAsideView[] = [];

export function mountReviews(container: HTMLElement): ViewHandle {
  poll?.stop();
  poll = undefined;
  renderedSig = '';
  answeredIds = new Set();
  failedIds = new Map();
  lastList = [];
  setAsideAnsweredKeys = new Set();
  setAsideFailedKeys = new Map();
  lastSetAside = [];
  paintSkeleton(container); // SPEC-0060 VUX-13: a calm warming skeleton — never a 2s blank / wrong-empty.
  let unsubscribe: (() => void) | null = null;
  return {
    // #510: re-read on every activation (STATE-8 AC1) and subscribe to the 'review' push topic so an
    // answer/re-raise elsewhere repaints within ~1s while Reviews stays visible (AC2). `startPoll`'s
    // #509 `createVisibilityPoll` stays as the backstop cadence; `hide()` now fully `stop()`s it (not
    // just self-gating) so it matches every other view's contract (zero live timers once hidden).
    show: () => {
      void refresh(container);
      startPoll(container);
      unsubscribe ??= subscribeProjectionChanged('review', () => void refresh(container, { onlyIfChanged: true }));
    },
    hide: () => {
      poll?.stop();
      poll = undefined;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/**
 * The warming skeleton (SPEC-0060 VUX-13). On a cold launch the review projection is still building
 * (`reviewProjection()` → null) for a beat; the OLD view read `listReviews()`, which collapses that
 * warming-null to `[]`, so it flashed the "Nothing needs you right now" empty state — wrong-empty, the
 * 2s blank. This paints placeholder card shapes in the same v2 material so the surface reads "preparing"
 * (not "empty", not a spinner) with no layout jump when the real list lands. aria-busy for AT.
 */
function paintSkeleton(container: HTMLElement): void {
  const row = `<li class="rev-skeleton-card" aria-hidden="true"><span class="rev-skeleton rev-skeleton-line"></span><span class="rev-skeleton rev-skeleton-line rev-skeleton-line--short"></span></li>`;
  container.innerHTML = `
    <div class="${V2}" aria-busy="true">
      ${V2_HEAD}
      <div class="rev-skel-status" aria-hidden="true"><span class="vmark loom"></span> Reading your library…</div>
      <ul class="review-list rev-skeleton-list">${row}${row}</ul>
    </div>`;
}

/** Keep the list in sync with the live badge: re-fetch while visible; skip when hidden or mid-note.
 *  #509: the visibility/detach mechanics now come from the shared helper (geometry-based, bounded error
 *  backoff on a failing `refresh`) — this keeps only the Reviews-specific "don't yank a note out from
 *  under someone typing" guard. */
function startPoll(container: HTMLElement): void {
  poll = createVisibilityPoll(container, REVIEW_POLL_MS, () => {
    if (hasDirtyNote(container)) return; // don't yank the list out from under an in-progress note
    return refresh(container, { onlyIfChanged: true });
  });
}

/** A note the Principal is actively writing (focused or non-empty) — re-rendering would lose it. */
function hasDirtyNote(container: HTMLElement): boolean {
  for (const ta of Array.from(container.querySelectorAll<HTMLTextAreaElement>('.review-note'))) {
    if (ta === document.activeElement || ta.value.trim().length > 0) return true;
  }
  return false;
}

/**
 * Fetch the open reviews and paint them. With `onlyIfChanged` (the poll path) it repaints only when
 * the set of open review ids differs from what's shown — so an unchanged poll is a no-op (no flicker,
 * no lost focus) — and a transient IPC error leaves the current list in place. The initial/forced
 * path surfaces a load error.
 */
async function refresh(container: HTMLElement, opts: { onlyIfChanged?: boolean } = {}): Promise<void> {
  let projection: Projection<ReviewSummary[]> | null;
  let setAside: SetAsideView[];
  try {
    // #145: bound the wait so a hung IPC can't leave an infinite spinner; a hang then surfaces as a
    // normal rejection this catch handles. SPEC-0060 VUX-13: read the freshness ENVELOPE, not the
    // flattened `listReviews()` — so warming (projection still building → null) is distinguishable
    // from genuinely-empty (built, zero open reviews), instead of both reading as "empty".
    // #192: pipelineStatusView() is a cheap, backend-cached read (OBS-24 — never the render-path
    // assembly), fetched alongside on the same cadence. It's a SECONDARY surface on this view, so its
    // own failure degrades to an empty set-aside list rather than blanking the whole Reviews queue.
    const [proj, status] = await Promise.all([withTimeout(window.kbApi.reviewProjection()), withTimeout(window.kbApi.pipelineStatusView()).catch(() => null)]);
    projection = proj;
    setAside = Array.isArray(status?.setAsideItems) ? status.setAsideItems : [];
  } catch {
    if (!opts.onlyIfChanged) {
      // Initial/forced load failed → a retryable error (the poll keeps trying too).
      renderLoadError(container, V2_HEAD, () => void refresh(container));
    }
    return; // poll error → keep the last good list
  }
  if (projection === null) {
    // Still warming (or no active vault): hold the calm skeleton on the initial/forced path; on the
    // poll path keep whatever's painted. Never collapse warming to the "Nothing needs you" empty state.
    if (!opts.onlyIfChanged) paintSkeleton(container);
    return;
  }
  const list = Array.isArray(projection.data) ? projection.data : [];
  lastList = list;
  lastSetAside = setAside;
  // REVIEW-20: prune the optimistic-answered set — once the backend stops returning an id, the answer
  // landed for real; drop it so the set can't grow unbounded across a session.
  for (const id of Array.from(answeredIds)) if (!list.some((r) => r?.id === id)) answeredIds.delete(id);
  // #192: same prune for set-aside — once a retried/dismissed item stops appearing, drop its suppression.
  for (const key of Array.from(setAsideAnsweredKeys)) if (!setAside.some((it) => setAsideKey(it?.stage ?? '∅', it?.itemId ?? '∅') === key)) setAsideAnsweredKeys.delete(key);
  // ENG-16: the change-signature must tolerate a malformed item too (a null/odd entry can't be
  // allowed to throw here and abort the whole render before `paint` ever runs). It reflects the
  // VISIBLE set (REVIEW-20: minus anything optimistically answered) so a removed item stays removed.
  const sig = `${sigFor(list)}|${setAsideSigFor(setAside)}`;
  if (opts.onlyIfChanged && sig === renderedSig) return;
  renderedSig = sig;
  paint(container, visibleOf(list), visibleSetAsideOf(setAside));
}

/** The render-visible reviews: the fetched queue minus anything optimistically answered (REVIEW-20). */
function visibleOf(list: ReviewSummary[]): ReviewSummary[] {
  return (Array.isArray(list) ? list : []).filter((r) => !answeredIds.has(r?.id));
}

/** The change-signature of what would paint now (visible ids) — ENG-16 null-tolerant. */
function sigFor(list: ReviewSummary[]): string {
  return visibleOf(list)
    .map((r) => r?.id ?? '∅')
    .join(',');
}

/** #192: a set-aside item's stable identity — `itemId` alone isn't unique across stages (claims'
 *  entityId, connect's blockKey, and archive's inbox-unit id are independent id spaces). */
function setAsideKey(stage: string, itemId: string): string {
  return `${stage}:${itemId}`;
}

/** The render-visible set-aside items: minus anything optimistically retried/dismissed (mirrors
 *  `visibleOf` for reviews). */
function visibleSetAsideOf(items: SetAsideView[]): SetAsideView[] {
  return (Array.isArray(items) ? items : []).filter((it) => !setAsideAnsweredKeys.has(setAsideKey(it?.stage ?? '∅', it?.itemId ?? '∅')));
}

/** The change-signature of the visible set-aside list — same null-tolerant shape as {@link sigFor}. */
function setAsideSigFor(items: SetAsideView[]): string {
  return visibleSetAsideOf(items)
    .map((it) => setAsideKey(it?.stage ?? '∅', it?.itemId ?? '∅'))
    .join(',');
}

/** The empty state — extracted so the optimistic-remove path can show it the instant the last item
 *  is answered (REVIEW-20), without waiting on a refetch. */
function paintEmpty(container: HTMLElement): void {
  // Calm by design (no ember, no 🎉) — the queue is quiet; ember is reserved for an actual open review.
  container.innerHTML = `<div class="${V2}">${V2_HEAD}${emptyState({
    title: 'Nothing needs you right now.',
    body: 'When the pipeline hits a judgment call it can’t make on its own, it’ll ask you here.',
  })}</div>`;
}

/** Render the review list + the set-aside section (or the fully-calm empty state) and wire every
 *  per-item control. #192: set-aside is a SEPARATE section from the review queue — not counted in the
 *  "N question(s) for you" subheading (DL-2: the two queues must never share a count — VIZ-7 §9's
 *  anti-#110 invariant). Reviews.length === 0 no longer alone means "nothing needs you": a non-empty
 *  set-aside list still needs a Retry/Dismiss surface. */
function paint(container: HTMLElement, reviews: ReviewSummary[], setAside: SetAsideView[]): void {
  const header = V2_HEAD;
  if (reviews.length === 0 && setAside.length === 0) {
    paintEmpty(container);
    return;
  }

  // ENG-16 per-item failure isolation: one malformed review degrades its OWN row, never the whole
  // list. A field with an unexpected shape (e.g. `refs` not an array, a candidate row that throws)
  // must not take down every other review + leave the surface stuck on "Loading…" (REVIEW-19).
  const items = reviews
    .map((r) => {
      try {
        return reviewItemHtml(r);
      } catch (err) {
        console.warn('reviews: a review item failed to render — showing a fallback row', err);
        return reviewItemFallback(r);
      }
    })
    .join('');
  const reviewsBlock =
    reviews.length > 0
      ? `<p class="viz-body reviews-sub">${reviews.length} question${reviews.length === 1 ? '' : 's'} for you. Each is a quick yes/no.</p>
         <ul class="review-list">${items}</ul>`
      : `<p class="viz-body reviews-sub muted">No open questions right now.</p>`;
  const setAsideBlock = setAside.length > 0 ? setAsideSectionHtml(setAside) : '';

  container.innerHTML = `
    <div class="${V2}">
      ${header}
      ${reviewsBlock}
      ${setAsideBlock}
    </div>`;

  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.review-confirm, .review-reject'))) {
    btn.addEventListener('click', () => {
      const verdict = btn.classList.contains('review-confirm') ? 'confirm' : 'reject';
      void answer(container, btn.dataset.id!, verdict);
    });
  }

  // REVIEW-16: each candidate row's "Open in Obsidian" opens its source dir in Obsidian. Reuses the
  // ASK-14/EXPLORE-4 `openCitation` IPC (repo-relative path → obsidian:// deep link in the main
  // process) — the renderer never builds a URL itself, so the agent-authored `sourceRel` can't reach
  // a markup/href sink. `data-rel` was esc()'d at render; we read it back as a plain string.
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.review-candidate-open'))) {
    btn.addEventListener('click', () => {
      const rel = btn.dataset.rel;
      if (rel) void window.kbApi.openCitation(rel);
    });
  }

  // #192: Retry/Dismiss — both call the same stage-agnostic `kb:pipelineControl` IPC, keyed by the
  // exact (stage, itemId) pair the SetAsideView item carried (never renderer-invented — pipelineControl.ts
  // resolves it to the server-derived recovery handle, a #153/#157 trust-boundary requirement).
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.setaside-retry, .setaside-dismiss'))) {
    btn.addEventListener('click', () => {
      const action = btn.classList.contains('setaside-retry') ? 'retry' : 'dismiss';
      void answerSetAside(container, btn.dataset.stage!, btn.dataset.itemId!, action);
    });
  }
}

/** The full markup for one review item. Extracted so the list `.map` can isolate a per-item render
 *  failure (ENG-16) — a throw here drops to `reviewItemFallback`, never the whole list. */
function reviewItemHtml(r: ReviewSummary): string {
  const refs = Array.isArray(r.refs) ? r.refs : []; // legacy/malformed: refs may be absent/non-array
  // REVIEW-20: a re-surfaced item whose async answer failed carries an honest, retryable error banner.
  // Oxide colours only the glyph (off small text, design-system §3); the message stays readable ink.
  const err = failedIds.has(r.id)
    ? `<p class="review-error viz-body" role="alert"><span class="review-error-glyph viz-state-error" aria-hidden="true">✕</span> ${esc(failedIds.get(r.id))}</p>`
    : '';
  // v3 ember kicker — the sanctioned "needs your decision" cue. Derived from the data shape (a
  // candidate set = a tell-apart/merge review), never an invented field.
  const kicker = r.candidates?.length ? 'Tell these apart' : 'Needs your decision';
  return `
      <li class="review" data-id="${esc(r.id)}">
        ${err}
        <div class="review-kicker"><span class="glyph" aria-hidden="true">◆</span> ${kicker}</div>
        <div class="review-q">${esc(scrubUlids(r.question))}</div>
        ${candidatesBlock(r)}
        <details class="review-detail">
          <summary>Why this matters</summary>
          <p>${esc(scrubUlids(r.detail))}</p>
          ${refs.length ? `<p class="muted">About: ${refs.map(esc).join(', ')}</p>` : ''}
          <p class="muted">Raised by: ${esc(r.stage)}</p>
        </details>
        <label class="viz-field review-note-field">
          <span class="viz-field__label viz-signage">Note (optional)</span>
          <textarea class="review-note viz-field__input viz-field__input--multiline" rows="2" placeholder="Optional note (e.g. a correction) — saved as a source"></textarea>
        </label>
        <div class="review-actions">
          <button type="button" class="viz-btn viz-btn--primary review-confirm" data-id="${esc(r.id)}">Confirm</button>
          <button type="button" class="viz-btn review-reject" data-id="${esc(r.id)}">Reject</button>
        </div>
      </li>`;
}

/** A minimal, still-actionable fallback row when a review item can't be fully rendered (ENG-16). The
 *  Confirm/Reject pair stays wired (keyed by id) so the Principal can still clear the item; the rest
 *  of the list is unaffected. Every field is esc()'d (null-safe) so the fallback itself can't throw. */
function reviewItemFallback(r: ReviewSummary): string {
  const id = esc(r?.id);
  const actions = id
    ? `<div class="review-actions">
          <button type="button" class="viz-btn viz-btn--primary review-confirm" data-id="${id}">Confirm</button>
          <button type="button" class="viz-btn review-reject" data-id="${id}">Reject</button>
        </div>`
    : '';
  return `
      <li class="review" data-id="${id}">
        <div class="review-q">${esc(r?.question) || 'This review couldn’t be fully displayed.'}</div>
        <p class="muted">Some details for this item are unavailable.</p>
        ${actions}
      </li>`;
}

/**
 * REVIEW-16 — the disambiguation candidate rows. A "same entity?" review's candidates usually share
 * a name, so the distinguishing **gloss** ("from the fishing trip" vs "Dave's wedding") is the star;
 * each row also offers a working Obsidian link whose TEXT is the source's human title (PRIN-24 — never
 * the raw ULID), opening that candidate's `source.md` when known. This enriches the decision *context*
 * only — the Confirm/Reject verdict (REVIEW-2) is unchanged.
 *
 * Returns '' for an ordinary review (no candidates) so nothing renders. Name/gloss/title/sourceRel are
 * source-/agent-derived (untrusted) → every interpolation is esc()'d, including the `data-rel` the
 * click handler reads back (KB-QD-2's forward-flagged XSS).
 *
 * REVIEW-19 / ENG-15/16: the data is partial in the LIVE queue — candidates raised before
 * title-persistence (#295/#305) carry `title: null` (55 such candidates / 9 open reviews observed,
 * incl. "Jordan"). So the link text falls back title → name → a generic "Open" (NEVER `esc(undefined)`,
 * NEVER a raw ULID), and each candidate row is isolated: one malformed candidate degrades its OWN row.
 */
function candidatesBlock(r: ReviewSummary): string {
  if (!r.candidates?.length) return '';
  const rows = r.candidates
    .map((c) => {
      try {
        return candidateRowHtml(c);
      } catch (err) {
        console.warn('reviews: a candidate row failed to render — showing a fallback', err);
        return `<li class="review-candidate viz-spine"><span class="review-candidate-gloss viz-body muted">This candidate couldn’t be displayed.</span></li>`;
      }
    })
    .join('');
  return `<ul class="review-candidates" aria-label="Candidates to tell apart">${rows}</ul>`;
}

/** One candidate row. The Obsidian link TEXT is the source title with a robust fallback chain so a
 *  legacy `title: null` candidate still renders a real, working link (REVIEW-19 / PRIN-24). */
function candidateRowHtml(c: ReviewSubjectCandidate): string {
  // title → name → (neither) a generic label. NEVER the raw ULID/sourceRel basename (PRIN-24), and
  // NEVER `esc(undefined)`. `name` is the legacy fall-through (e.g. "Jordan") when title is absent.
  const label = firstNonEmpty(c.title, c.name);
  const linkText = label ? `${esc(label)} ↗` : 'Open in Obsidian ↗';
  const link = c.sourceRel
    ? `<button type="button" class="review-candidate-open viz-btn viz-btn--ghost viz-focusable" data-rel="${esc(c.sourceRel)}" title="Open in Obsidian">${linkText}</button>`
    : '';
  return `
        <li class="review-candidate viz-spine">
          <span class="review-candidate-name viz-signage v3-clip" title="${esc(c.name)}">${esc(c.name)}</span>
          <span class="review-candidate-gloss viz-body">${esc(scrubUlids(c.gloss))}</span>
          ${link}
        </li>`;
}

/** First value that is a non-empty string (trims) — for null-safe display fallbacks. */
function firstNonEmpty(...vals: Array<string | null | undefined>): string | undefined {
  for (const v of vals) if (typeof v === 'string' && v.trim().length > 0) return v;
  return undefined;
}

/**
 * REVIEW-20 — answering is OPTIMISTIC. The item leaves the queue the INSTANT the Principal clicks
 * (no backend wait — the #322 P1 was "confirm/deny takes forever to disappear, waiting on the
 * backend"); the verdict IPC and the heavy resume/merge run async. Removing the row also makes a
 * double-submit impossible (the buttons are gone), so no in-flight disabling is needed. On async
 * failure we reconcile honestly: un-suppress the id and re-surface the item with a retryable error.
 */
async function answer(container: HTMLElement, id: string, verdict: 'confirm' | 'reject'): Promise<void> {
  const li = container.querySelector<HTMLElement>(`.review[data-id="${cssEscape(id)}"]`);
  const note = li?.querySelector<HTMLTextAreaElement>('.review-note')?.value ?? '';
  // A fresh click on this item is a new attempt — clear any prior failure affordance.
  failedIds.delete(id);
  // Optimistic: suppress it from the reconcile poll, then drop the row immediately.
  answeredIds.add(id);
  optimisticallyRemove(container, id);
  // Fire the verdict in the background. The UI has already moved on.
  let ok = false;
  try {
    const res = await window.kbApi.answerReview({ id, verdict, note: note.trim() || undefined });
    ok = !!res?.ok;
  } catch {
    ok = false;
  }
  if (ok) return; // answered for real — the poll/projection keeps it gone; `answeredIds` is pruned then
  // FAILED → honest reconcile: un-suppress + re-surface the item carrying a retryable error affordance.
  answeredIds.delete(id);
  failedIds.set(id, 'Couldn’t submit your answer — please try again.');
  await refresh(container); // forced repaint → the still-open item returns with its error banner
}

/** REVIEW-20: mark one answered row as leaving IMMEDIATELY (before the verdict IPC resolves), so the
 *  queue reflects the click with zero backend wait. #520 §10: the row exits via `.is-leaving` (fade+lift
 *  over --dur-settle) rather than a synchronous `.remove()` — the actual DOM removal (+ empty-state check)
 *  happens once the transition ends, with a matching-duration fallback timer so a reduced-motion run
 *  (no transition, no `transitionend`) still removes the node. `renderedSig` updates immediately either
 *  way, so the next unchanged poll stays a no-op rather than repainting the item back mid-exit. */
function optimisticallyRemove(container: HTMLElement, id: string): void {
  const li = container.querySelector<HTMLElement>(`.review[data-id="${cssEscape(id)}"]`);
  if (li) {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const setAsideStillLive = !!container.querySelector('.setaside-card');
      li.remove();
      if (container.querySelector('.review')) return; // other reviews remain — nothing else to reconcile
      // #192: the fully-calm empty state only applies once BOTH queues are empty. A still-live set-aside
      // section can't just be left in place either — the "N question(s) for you" subheading above it
      // would go stale ("1 question" with an empty `<ul>`) — so a full repaint reconciles it honestly.
      if (setAsideStillLive) paint(container, [], visibleSetAsideOf(lastSetAside));
      else paintEmpty(container);
    };
    li.classList.add('is-leaving');
    li.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 340); // matches --dur-settle; the reduced-motion path (no transition) relies on this
  }
  // #192: the combined signature (both queues) so the next unchanged poll — which now sigs both parts —
  // stays a no-op rather than seeing a stale set-aside half and repainting the item back mid-exit.
  renderedSig = `${sigFor(lastList)}|${setAsideSigFor(lastSetAside)}`;
}

/** Minimal CSS.escape fallback (review ids are ULIDs, so this is belt-and-suspenders). */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/**
 * #192/VIZ-7 — the set-aside recovery section: the pipeline's poison-item queue (OBS-17), presented as
 * its own oxide-toned block distinct from the ember review cards. `items` are already the visible set
 * (post `visibleSetAsideOf` filtering). ENG-16: one malformed item degrades its own card, not the section.
 */
function setAsideSectionHtml(items: SetAsideView[]): string {
  const cards = items
    .map((it) => {
      try {
        return setAsideCardHtml(it);
      } catch (err) {
        console.warn('reviews: a set-aside card failed to render — showing a fallback', err);
        return setAsideCardFallback(it);
      }
    })
    .join('');
  return `
    <section class="setaside-section" aria-label="Set aside — needs recovery">
      <div class="setaside-kicker"><span class="glyph" aria-hidden="true">⚑</span> Set aside — ${items.length} item${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} recovery</div>
      <p class="viz-body setaside-sub muted">The pipeline parked these instead of looping or wedging on them. Retry to try again, or Dismiss to drop them for good.</p>
      <ul class="setaside-list">${cards}</ul>
    </section>`;
}

/** One set-aside card. `stage`/`itemId` on the Retry/Dismiss buttons are read back verbatim by the
 *  click handler and sent to `kb:pipelineControl` unchanged — never renderer-invented (the IPC resolves
 *  them to the server-derived recovery handle, #153/#157's trust boundary). */
function setAsideCardHtml(it: SetAsideView): string {
  const key = setAsideKey(it.stage, it.itemId);
  const err = setAsideFailedKeys.has(key)
    ? `<p class="setaside-error viz-body" role="alert"><span class="viz-state-error" aria-hidden="true">✕</span> ${esc(setAsideFailedKeys.get(key))}</p>`
    : '';
  const name = firstNonEmpty(it.name) ?? 'an item';
  const reason = firstNonEmpty(it.reason) ?? 'set aside after repeated failures';
  return `
      <li class="setaside-card" data-stage="${esc(it.stage)}" data-item-id="${esc(it.itemId)}">
        ${err}
        <div class="setaside-name viz-body">${esc(name)}</div>
        <div class="setaside-reason viz-body muted">${esc(reason)} · ${esc(stageDisplayName(it.stage))}</div>
        <div class="setaside-actions">
          <button type="button" class="viz-btn setaside-retry" data-stage="${esc(it.stage)}" data-item-id="${esc(it.itemId)}">Retry</button>
          <button type="button" class="viz-btn viz-btn--danger setaside-dismiss" data-stage="${esc(it.stage)}" data-item-id="${esc(it.itemId)}">Dismiss</button>
        </div>
      </li>`;
}

/** A minimal, still-actionable fallback card (ENG-16) — Retry/Dismiss stay wired (keyed by stage+itemId)
 *  even when the item's other fields can't be trusted enough to render normally. */
function setAsideCardFallback(it: SetAsideView): string {
  const stage = esc(it?.stage);
  const itemId = esc(it?.itemId);
  const actions =
    stage && itemId
      ? `<div class="setaside-actions">
            <button type="button" class="viz-btn setaside-retry" data-stage="${stage}" data-item-id="${itemId}">Retry</button>
            <button type="button" class="viz-btn viz-btn--danger setaside-dismiss" data-stage="${stage}" data-item-id="${itemId}">Dismiss</button>
          </div>`
      : '';
  return `
      <li class="setaside-card" data-stage="${stage}" data-item-id="${itemId}">
        <p class="muted">Some details for this item are unavailable.</p>
        ${actions}
      </li>`;
}

/**
 * #192 — retry/dismiss is OPTIMISTIC, same shape as {@link answer} for reviews: the card leaves the
 * section the INSTANT the Principal clicks (no backend wait), the `kb:pipelineControl` IPC runs async.
 * On failure we reconcile honestly: un-suppress the item and re-surface it with a retryable error.
 */
async function answerSetAside(container: HTMLElement, stage: string, itemId: string, action: PipelineControlRequest['action']): Promise<void> {
  const key = setAsideKey(stage, itemId);
  // A fresh click on this item is a new attempt — clear any prior failure affordance.
  setAsideFailedKeys.delete(key);
  // Optimistic: suppress it from the reconcile poll, then drop the row immediately.
  setAsideAnsweredKeys.add(key);
  optimisticallyRemoveSetAside(container, stage, itemId);
  let ok = false;
  let message: string | undefined;
  try {
    const res = await window.kbApi.pipelineControl({ action, stage, itemId });
    ok = !!res?.ok;
    message = res?.message;
  } catch {
    ok = false;
  }
  if (ok) return; // handled for real — the poll/status snapshot keeps it gone; the key is pruned then
  // FAILED → honest reconcile: un-suppress + re-surface the item carrying a retryable error affordance.
  setAsideAnsweredKeys.delete(key);
  setAsideFailedKeys.set(key, message || `Couldn’t ${action} — please try again.`);
  await refresh(container); // forced repaint → the still-set-aside item returns with its error banner
}

/** Mirrors {@link optimisticallyRemove} for the set-aside section: fade+lift exit (#520 §10), a
 *  matching-duration fallback timer for reduced-motion, and the same "don't leave a stale section behind"
 *  reconciliation — removing the LAST set-aside card while reviews remain needs a full repaint so the
 *  section (and its "N items" count) disappears cleanly rather than leaving an empty shell. */
function optimisticallyRemoveSetAside(container: HTMLElement, stage: string, itemId: string): void {
  const li = container.querySelector<HTMLElement>(`.setaside-card[data-stage="${cssEscape(stage)}"][data-item-id="${cssEscape(itemId)}"]`);
  if (li) {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const reviewsStillLive = !!container.querySelector('.review');
      li.remove();
      if (container.querySelector('.setaside-card')) return; // other set-aside items remain — done
      if (reviewsStillLive) paint(container, visibleOf(lastList), []);
      else paintEmpty(container);
    };
    li.classList.add('is-leaving');
    li.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 340); // matches --dur-settle; the reduced-motion path (no transition) relies on this
  }
  renderedSig = `${sigFor(lastList)}|${setAsideSigFor(lastSetAside)}`;
}
