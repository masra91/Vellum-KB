// Pipeline Status view — "The Line" (SPEC-0032 / DESIGN-VIZ + SPEC-0030 OBS-5/6/7/8/9/11/15/17). The
// static `<h2>` lists of the old Status view are replaced by **The Line**: a refinery-conveyor
// instrument panel — six stations on a horizontal spine, each with a gauge-rail funnel; in-flight
// sources as carriages (the per-item "pizza tracker"); set-aside items pulled onto a siding with
// Retry / Dismiss; and a stuck-canonical-writer-lock alarm (the "silent stall, made loud"). Ember =
// work, cool = rest; condensed signage + tabular numerics; one signature motion (index) + one ambient
// (ember breathe), with full reduced-motion parity. Built on the shared `_design-system` foundation
// (#179): `--viz-*` tokens, bundled faces, flat-ink primitives — this file is the surface composition.
//
// Read-only by default (OBS-9): it reports, never mutates. The ONE sanctioned exception is OBS-17's
// poison recovery — a set-aside item carries Retry / Dismiss that delegate to the stage-owned
// `kb:pipelineControl` primitives (no mutation logic lives here). Live by polling `kb:pipelineStatusView`
// every 2500ms while visible (OBS-8); the §9 event-push channel is a deferred fast-follow (poll is the
// floor). Thin DOM over the typed IPC; `esc()` on every interpolation (XSS-safe); render helpers are
// pure (data → HTML string) so they unit-test without a DOM; the funnel/stepper math lives in
// `theLineModel.ts` (also pure).
import { esc } from '../html';
import { withTimeout, skeletonFragmentHtml } from '../loadGuard';
import { formatTimestamp } from '../formatTime';
import { stageDisplayName } from '../stageLabels';
import {
  buildStations,
  splitCarriages,
  OVERALL_GLYPH,
  type StationModel,
  type CarriageModel,
} from './theLineModel';
import { isPermissionDeniedError } from '../../kb/permissions';
import { OVERALL_LABEL } from '../../kb/pipelineStatusLabels';
import { DEFAULT_ERROR_FRESH_MS } from '../../kb/pipelineStatusView';
import { applyLineMotion, createMotionStores, type MotionStores } from './lineMotion';
import type { PipelineStatusView, RecentError, WorktreeInfo, SetAsideView, PipelineControlRequest } from '../../kb/types';

const POLL_MS = 2500;

/** Which lens the Line foregrounds (VIZ-5). Default `stage` — at-a-glance health is the more frequent
 *  job; `item` foregrounds the carriages. Same structure + data, only the visual weight shifts. */
type Lens = 'stage' | 'item';

// View-local, ephemeral state (the shell mounts once + toggles visibility).
let view: PipelineStatusView | null = null;
let loading = false;
let errorMsg = '';
let expanded = new Set<number>(); // recent-error rows drilled-down to their cause (OBS-6)
let lens: Lens = 'stage'; // pivot toggle (VIZ-5)
let timer: ReturnType<typeof setInterval> | null = null;
// HEAL-8 (SPEC-0049) — set-aside Retry/Dismiss is OPTIMISTIC: the item leaves the siding INSTANTLY on
// click; the under-lock audit-append + re-enqueue/re-run run async (the UI never waits — today it
// blocked on a multi-second under-lock git commit). `actedKeys` (keyed `stage:itemId`) suppresses an
// optimistically-removed item from the 2.5s poll so it can't bounce back before the backend (and the
// status projection) catch up; `failedActs` re-surfaces an item whose async action failed, with an
// honest retryable error. Mirrors the REVIEW-20 `answeredIds`/`failedIds` optimistic seam.
let actedKeys = new Set<string>();
let failedActs = new Map<string, string>();
let lastHtml = ''; // change-guard: skip re-rendering identical HTML so CSS motion doesn't restart (VIZ-9)
// §5 motion carry-over: the last odometer value per key + the last stepper position per carriage, so
// a repaint can roll the number / index the advance from where it was (not snap). Reset on mount.
let motionStores: MotionStores = createMotionStores();

export function mountStatus(container: HTMLElement): void {
  view = null;
  loading = true;
  errorMsg = '';
  expanded = new Set();
  lens = 'stage';
  actedKeys = new Set();
  failedActs = new Map();
  lastHtml = '';
  motionStores = createMotionStores(); // fresh motion history per mount (no carry-over across vault switches)
  // UX v2 (SPEC-0058): `status-v2` scopes the material/voice adoption to Status only — the pipeline +
  // in-flight regions gain card depth + Spectral heads, KEEPING The Line's instrument (stations, rails,
  // carriages, motion). Color discipline is already correct (#450 ember→sprout sweep). Counts stay mono.
  container.innerHTML = `<div class="viz-surface the-line status-v2"><div class="line-body" id="lineBody"></div></div>`;
  wire(container);
  void load(container);
  // Live-update (OBS-8) — poll only while visible (don't burn IPC when another view is showing).
  // Clear any prior interval first so a re-mount never stacks pollers.
  if (timer !== null) clearInterval(timer);
  timer = setInterval(() => {
    if (isVisible(container)) void load(container);
  }, POLL_MS);
}

/** Stop the live-update poll (clean shutdown / tests). */
export function stopStatusPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** True when the view is actually on screen (the shell hides inactive views with display:none). */
function isVisible(container: HTMLElement): boolean {
  return container.offsetParent !== null || container.getClientRects().length > 0;
}

async function load(container: HTMLElement): Promise<void> {
  if (view === null) {
    loading = true;
    renderBody(container);
  }
  try {
    // #145: bound the wait — a hung `pipelineStatusView` must surface as an error, not an infinite
    // "Loading…". The live poll (POLL_MS) then auto-retries, so no manual retry button is needed here.
    view = await withTimeout(window.kbApi.pipelineStatusView());
    errorMsg = '';
    // HEAL-8: prune the optimistic-acted set — once the backend stops returning an item, the action
    // landed; drop its key so the set can't grow and a future same-key item isn't wrongly suppressed.
    const present = new Set((view?.setAsideItems ?? []).map(sideKey));
    for (const k of Array.from(actedKeys)) if (!present.has(k)) actedKeys.delete(k);
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
    renderBody(container);
  }
}

function wire(container: HTMLElement): void {
  container.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    // VIZ-5 pivot — non-mutating; flips which lens the Line foregrounds.
    if (act === 'pivot') {
      const next = el.dataset.lens === 'item' ? 'item' : 'stage';
      if (next !== lens) {
        lens = next;
        renderBody(container);
      }
      return;
    }
    // MACOS-7: open System Settings for the vault-blocked recovery (opens an external pane; the vault
    // itself is untouched — this stays within the read-only-except-OBS-17 boundary).
    if (act === 'open-settings') {
      void window.kbApi.openSystemSettingsPrivacy();
      return;
    }
    if (act === 'toggle-err') {
      const i = Number(el.dataset.i);
      if (expanded.has(i)) expanded.delete(i);
      else expanded.add(i);
      renderBody(container);
      return;
    }
    // HEAL-8: retry / dismiss a set-aside item — OPTIMISTIC (the item leaves the siding instantly, so a
    // double-fire is impossible — the buttons vanish with it). Dismiss is confirmed first.
    if (act === 'setaside-retry' || act === 'setaside-dismiss') {
      const itemId = el.dataset.id ?? '';
      if (!itemId) return;
      const action: PipelineControlRequest['action'] = act === 'setaside-retry' ? 'retry' : 'dismiss';
      const stage = el.dataset.stage ?? 'claims';
      const label = el.dataset.label || itemId;
      if (action === 'dismiss' && !window.confirm(`Dismiss “${label}”? It leaves the recovery list and won’t be re-derived.`)) return;
      void runControl(container, { action, stage, itemId });
      return;
    }
  });
}

/** The optimistic-suppression key for a set-aside item — `stage:itemId` (an itemId can repeat across
 *  stages, so the stage qualifies it). */
function sideKey(x: { stage: string; itemId: string }): string {
  return `${x.stage}:${x.itemId}`;
}

/**
 * HEAL-8 (SPEC-0049) — Retry/Dismiss a set-aside item OPTIMISTICALLY. The item leaves the siding the
 * INSTANT the Principal clicks (no wait on the backend — today `pipelineControl` blocks on a
 * multi-second under-lock git commit); the audit-append + re-enqueue/re-run happen async. On async
 * failure we reconcile honestly: un-suppress the item and re-surface it with a retryable error. Mirrors
 * the REVIEW-20 optimistic confirm/deny seam; stage-agnostic, so it covers claims + connect + any
 * future set-aside.
 */
async function runControl(container: HTMLElement, req: PipelineControlRequest): Promise<void> {
  const k = sideKey(req);
  failedActs.delete(k); // a fresh click clears any prior failure affordance
  actedKeys.add(k); // optimistic: suppress from the siding + the reconcile poll
  renderBody(container); // the item leaves the siding immediately — the UI never waits
  let ok = false;
  let message = '';
  try {
    const res = await window.kbApi.pipelineControl(req);
    ok = !!res?.ok;
    message = res?.message ?? '';
  } catch (err) {
    ok = false;
    message = err instanceof Error ? err.message : String(err);
  }
  if (ok) {
    void load(container); // reconcile against fresh state (prunes the acted key once the backend drops it)
    return;
  }
  // FAILED → honest rollback: un-suppress + re-surface the item carrying a retryable error affordance.
  actedKeys.delete(k);
  failedActs.set(k, message || 'Couldn’t complete that — please try again.');
  renderBody(container);
}

function renderBody(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#lineBody');
  if (!el) return;
  const html = lineBodyHtml({ view, loading, errorMsg, expanded, lens, actedKeys, failedActs }, Date.now());
  // VIZ-9 change-guard: only touch the DOM when the markup actually changed, so an unchanged poll
  // doesn't restart the ember-breathe / stepper animations (and saves layout on the calm idle).
  if (html !== lastHtml) {
    el.setAttribute('aria-busy', String(loading && view === null));
    el.innerHTML = html;
    lastHtml = html;
    // §5 motion (VIZ-1/signature): roll the funnel/in-flight counts from their prior values + index
    // any carriage that advanced a station. Applied AFTER the repaint (which destroyed the nodes), so
    // the stores carry the prior value across it; reduced-motion snaps. Only on an actual change.
    applyLineMotion(el, motionStores);
  }
}

// ── Render (pure helpers return HTML strings) ─────────────────────────────────────────────────────

interface BodyState {
  view: PipelineStatusView | null;
  loading: boolean;
  errorMsg: string;
  expanded: Set<number>;
  lens: Lens;
  actedKeys?: Set<string>; // HEAL-8: set-aside items optimistically removed (suppressed from the siding)
  failedActs?: Map<string, string>; // HEAL-8: key → error for a re-surfaced item whose async act failed
}

/** The whole Line body (`nowMs` injected for the carriage dwell so it's testable without a clock). */
export function lineBodyHtml(s: BodyState, nowMs: number): string {
  // #160 "leave last-known": only surface the error banner when there's NO prior snapshot to show. After a
  // successful first paint, `view` holds the last-known Line; a transient 2.5s poll blip sets `errorMsg`
  // but must NOT wipe a healthy Line (the poll auto-retries + self-heals). With a view present we keep
  // rendering it; only a cold failure (no last-known) shows the banner.
  if (s.errorMsg && s.view === null) return `<p class="line-error viz-body" role="alert">Couldn’t load status: ${esc(s.errorMsg)}</p>`;
  if (s.loading && s.view === null) return skeletonFragmentHtml('rows');
  if (s.view === null) return `<p class="line-empty viz-body">No library open.</p>`;
  const stations = buildStations(s.view);
  // ENG-15/16: a legacy/partial status payload may omit `inFlight`/`setAsideItems`; coalesce here to match
  // the guards `load()`/`buildStations` already apply (the sibling derefs were the lone unguarded outliers).
  const { shown, more } = splitCarriages(s.view.inFlight ?? [], nowMs);
  return [
    overallHtml(s.view),
    alarmHtml(s.view, nowMs),
    pivotHtml(s.lens),
    `<div class="line-core line-lens-${esc(s.lens)}">`,
    spineHtml(stations),
    carriagesHtml(shown, more),
    `</div>`,
    sidingHtml(
      (s.view.setAsideItems ?? []).filter((it) => !s.actedKeys?.has(`${it.stage}:${it.itemId}`)),
      { failures: s.failedActs },
    ),
    readoutHtml(s.view, s.expanded),
  ].join('');
}

/** OBS-5/11: the headline state badge (`◐ RUNNING`). Large display element → state hue allowed (§3). */
export function overallHtml(v: PipelineStatusView): string {
  const label = OVERALL_LABEL[v.overall];
  const last = v.lastActivity
    ? `<span class="line-lastact viz-body">last activity <span class="viz-numeric">${esc(formatTimestamp(v.lastActivity))}</span></span>`
    : '';
  return `<header class="line-head viz-ruled">
    <span class="line-title viz-signage">Pipeline</span>
    <span class="line-overall line-overall-${esc(v.overall)} viz-signage" role="status"><span class="line-overall-glyph" aria-hidden="true">${esc(OVERALL_GLYPH[v.overall])}</span> ${esc(label)}</span>
    ${last}
  </header>`;
}

/** OBS-11/VIZ-1 — the "silent stall, made loud" alarm, the headline reason this surface exists. A
 *  STUCK canonical-writer lock (#163 P0 class) is THE silent wedge: render it as the primary oxide
 *  alarm naming the holder + elapsed (#170 `lock.stuck`/`heldMs`/holder). Else a generic stall (queued
 *  but no progress) raises the same alarm box. Oxide colors only the glyph + the box's left edge — the
 *  reason text stays `--viz-ink` (oxide is sub-AA on small text, §3 / Design-Lead cert). Healthy idle
 *  and a held-but-moving lock stay quiet. */
/** A recent error is "fresh" (still relevant now) iff within the freshness window — or has an
 *  unparseable ts (err toward fresh: never hide a possible vault denial, #56). Mirrors deriveStageError. */
function isFreshError(ts: string, nowMs: number): boolean {
  const t = Date.parse(ts);
  return !Number.isFinite(t) || nowMs - t <= DEFAULT_ERROR_FRESH_MS;
}

export function alarmHtml(v: PipelineStatusView, nowMs: number = Date.now()): string {
  // SPEC-0034 MACOS-7 / #56: a folder-permission denial at write time (`Operation not permitted` — the
  // app lacks the macOS TCC grant) is the most fundamental wedge, so it takes priority over the lock/
  // stall alarms. Surface it as the **brass** "vault access blocked" recovery (waiting on YOU to grant
  // access — expected setup, NOT oxide/broken), with the System-Settings deep-link. This is the
  // pipeline-run-on-a-never-granted/revoked vault case (the design's flow 4 — never silently stall).
  // Bounded to FRESH denials (#163 deriveStageError precedent) so a since-fixed grant clears the alarm
  // instead of lingering until the error rolls off the recent-25 window; an unparseable ts errs toward
  // SHOWING the alarm (the safe direction — never hide a possible denial).
  if (v.recentErrors.some((e) => isPermissionDeniedError(e.message) && isFreshError(e.ts, nowMs))) {
    return `<div class="line-alarm line-alarm-blocked" role="alert">
      <span class="line-alarm-glyph line-alarm-glyph-blocked" aria-hidden="true">⚠</span>
      <span class="line-alarm-text viz-body">Vellum can’t write to your vault folder — access is turned off, so the pipeline is stalled until you allow it. <button type="button" class="viz-btn viz-focusable line-open-settings" data-act="open-settings">Open System Settings</button></span>
    </div>`;
  }
  if (v.lock.stuck) {
    const who = v.lock.holder ? holderLabel(v.lock.holder) : 'a stage';
    const forHow = typeof v.lock.heldMs === 'number' ? heldFor(v.lock.heldMs) : null;
    return `<div class="line-alarm line-alarm-stuck" role="alert">
      <span class="line-alarm-glyph viz-state-error" aria-hidden="true">✕</span>
      <span class="line-alarm-text viz-body"><strong>Stuck</strong> — the write lock has been held by <strong>${esc(who)}</strong>${forHow ? ` for <span class="viz-numeric">${esc(forHow)}</span>` : ''} and isn’t releasing; the pipeline is wedged on this section. See the write lock below.</span>
    </div>`;
  }
  if (v.stalled) {
    return `<div class="line-alarm line-alarm-stall" role="alert">
      <span class="line-alarm-glyph viz-state-error" aria-hidden="true">✕</span>
      <span class="line-alarm-text viz-body">Work is queued but nothing has progressed${v.lastActivity ? ` since <span class="viz-numeric">${esc(formatTimestamp(v.lastActivity))}</span>` : ''} — the pipeline looks stuck. Check the write lock + recent errors below.</span>
    </div>`;
  }
  return '';
}

/** VIZ-5 pivot toggle — flip emphasis between per-stage (default) and per-item. Non-mutating. */
export function pivotHtml(active: Lens): string {
  const btn = (l: Lens, text: string): string =>
    `<button type="button" class="viz-btn viz-focusable line-pivot-btn${active === l ? ' line-pivot-on' : ''}" data-act="pivot" data-lens="${l}" aria-pressed="${active === l}">${text}</button>`;
  return `<div class="line-pivot" role="group" aria-label="Lens">${btn('stage', 'Per-stage')}${btn('item', 'Per-item')}</div>`;
}

/** §2/§6: the station spine — six stations on one horizontal rule, each a glyph + signage + gauge-rail
 *  (volume bar + directional conversion caption). State = glyph + hue + fill (never colour alone).
 *  VIZ-10: a once-per-spine legend decodes the caption grammar (progressive disclosure, not a banner). */
export function spineHtml(stations: StationModel[]): string {
  return `<section class="line-spine-wrap" aria-label="Pipeline stations"><ol class="line-spine">${stations.map(stationHtml).join('')}</ol>${legendHtml()}</section>`;
}

/** VIZ-10 spine legend — one quiet, always-available key that decodes the dense caption grammar once,
 *  so the engineered captions stay glanceable without cluttering every station. A `details` affordance
 *  (progressive disclosure), never a loud banner (§6 / DESIGN-3). */
function legendHtml(): string {
  return `<details class="line-legend">
    <summary class="line-legend-key viz-signage">Reading the numbers</summary>
    <p class="line-legend-body viz-body"><span class="viz-numeric">→</span> fan-out/deduped projection to next · vol = reached here · queue = waiting · set aside = pulled off</p>
  </details>`;
}

/**
 * VIZ-12 — the rail's primary fill is the two-segment PENDING bar (DEV-6's bar-fill geometry, #336):
 * the **in-progress** segment is the warm EMBER base anchored at the spine (breathing — the
 * Principal's "fade"), the **queued** segment a still SLATE cap stacked above (brass only when the
 * backlog is actually STUCK). Heights are a % of the rail track, scaled to the peak pending across
 * stations (`st.pendingBar`). `0` pending → an empty track (calm/idle). Reads live off `view.inFlight`
 * so it's never the stale cumulative end-state; the ember segment is present *iff* something is
 * genuinely `active` (no frozen breathing bar). The bar is decorative — the ink counts + the `title`
 * carry the accessible reading. ENG-16: a NaN/negative geometry floored to 0 in the model.
 */
function railFillHtml(st: StationModel): string {
  const { activePct, queuedPct } = st.pendingBar;
  const active = activePct > 0 ? `<span class="line-pending-active" style="height:${activePct}%"></span>` : '';
  const queued = queuedPct > 0 ? `<span class="line-pending-queued${st.queueConcerning ? ' line-queue-concern' : ''}" style="height:${queuedPct}%"></span>` : '';
  return `<span class="line-rail-fill">${active}${queued}</span>`;
}

function stationHtml(st: StationModel): string {
  // Small text (the state word, counts, captions, queue, set-aside badge) stays ink/ink-muted; the
  // state hue rides the glyph + the gauge-rail bar (large/graphic) only (§3 contrast rule). VIZ-10
  // separates two typographic lanes: the RAIL lane (volume + projection — flows-through) and the
  // LIVE-STATE cluster (queue + current + set-aside — what's actually sitting here), so a projection
  // can never read as a backlog.
  const r = st.rail;
  // Lane 1 — RAIL: volume (count + bucket noun, role 1) then the projection caption (role 2). Each
  // carries a decode-on-hover `title=`.
  const count = `<span class="line-rail-count viz-numeric" title="${esc(r.countTitle)}"><span class="line-num" data-odo data-odo-key="vol-${esc(st.stage)}">${r.count}</span> <span class="line-rail-noun viz-signage">${esc(r.noun)}</span></span>`;
  const caption = r.caption
    ? `<span class="line-rail-caption line-cap-${r.captionKind} viz-numeric"${r.captionTitle ? ` title="${esc(r.captionTitle)}"` : ''}>${esc(r.caption)}</span>`
    : '';
  // Lane 2 — LIVE-STATE cluster (VIZ-12): the two pending NUMBERS (ink, §3) sitting here — `▣ N active`
  // (the ember glyph carries the heat; the count is ink-numeric) + `queue N` (waiting, brass when the
  // backlog is actually stuck) — then the current item + the set-aside badge. These are the actionable
  // sitting-here numbers, apart from the rail's cumulative volume/projection (a projection, never live).
  const active = st.inProgress > 0
    ? `<span class="line-station-active viz-body" title="${st.inProgress} actively being worked at ${esc(st.name)}"><span class="line-active-glyph" aria-hidden="true">▣</span> <span class="viz-numeric">${st.inProgress}</span> <span class="viz-signage">active</span></span>`
    : '';
  // `queue N` is the existing live-state chip (queueDepth, VIZ-10's backlog number) — unchanged; VIZ-12
  // only ADDS the `▣ active` sibling above. The bar's queued *segment* uses the roster split separately.
  const queue = st.queueDepth > 0
    ? `<span class="line-station-queue viz-body${st.queueConcerning ? ' line-queue-concern' : ''}" title="${st.queueDepth} waiting to be processed at ${esc(st.name)}">queue <span class="viz-numeric">${st.queueDepth}</span></span>`
    : '';
  const current = st.currentItem ? `<span class="line-station-current viz-body">▶ ${esc(st.currentItem)}</span>` : '';
  const setAside = st.setAside > 0 ? `<span class="line-station-setaside line-badge-error"><span class="viz-numeric">${st.setAside}</span> set aside</span>` : '';
  const live = active || queue || current || setAside ? `<span class="line-station-live">${active}${queue}${current}${setAside}</span>` : '';
  const latency = st.slowest && st.latency ? `<span class="line-station-latency viz-numeric" title="Slowest station">slowest · ${esc(st.latency)}</span>` : '';
  return `<li class="line-station line-station-${esc(st.state)}${st.slowest ? ' line-station-slow' : ''}" data-stage="${esc(st.stage)}">
    <span class="line-station-glyph ${st.stateClass}" aria-hidden="true">${esc(st.glyph)}</span>
    <span class="line-station-name viz-signage">${esc(st.name)}</span>
    <span class="line-station-state viz-chip" title="${esc(st.state)}">${esc(st.state)}</span>
    <span class="line-rail" aria-hidden="true">${railFillHtml(st)}</span>
    <span class="line-station-rail-lane">
      ${count}
      ${caption}
    </span>
    ${live}
    ${latency}
  </li>`;
}

/** §2/VIZ-2: in-flight carriages — each live source is a six-cell stepper (done · current · pending)
 *  with its current dwell. Beyond N=12 the rest collapse to a "+K more" row (VIZ-9 virtualization). */
export function carriagesHtml(shown: CarriageModel[], more: number): string {
  if (shown.length === 0 && more === 0) {
    return `<section class="line-flight"><h2 class="line-h2 viz-signage">In flight</h2><p class="line-flight-empty viz-body">Nothing on the line right now.</p></section>`;
  }
  const rows = shown.map(carriageHtml).join('');
  const moreRow = more > 0 ? `<li class="line-carriage line-carriage-more viz-body">+<span class="viz-numeric">${more}</span> more in flight</li>` : '';
  return `<section class="line-flight"><h2 class="line-h2 viz-signage">In flight (<span class="viz-numeric" data-odo data-odo-key="inflight-total">${shown.length + more}</span>)</h2><ul class="line-carriages">${rows}${moreRow}</ul></section>`;
}

function carriageHtml(c: CarriageModel): string {
  const cur = c.cells.findIndex((r) => r === 'current');
  const cells = c.cells
    .map((role) => `<span class="line-cell line-cell-${role}${role === 'current' && c.active ? ' line-cell-breathe' : ''}" aria-hidden="true"></span>`)
    .join('');
  const dwell = c.dwell ? `<span class="line-carriage-dwell viz-numeric">${esc(c.dwell)}</span>` : '';
  // data-carriage-id + data-step let the §5 index motion detect a station advance across repaints.
  return `<li class="line-carriage${c.active ? ' line-carriage-active' : ''}" data-carriage-id="${esc(c.itemId)}" data-step="${cur}">
    <span class="line-carriage-name viz-body">▸ ${esc(c.name)}</span>
    <span class="line-stepper" role="img" aria-label="${esc(c.stageName)} — step ${cur + 1} of 6">${cells}</span>
    <span class="line-carriage-stage viz-signage">${esc(c.stageName)}</span>
    ${dwell}
  </li>`;
}

/** §2/§6 VIZ-7: the set-aside siding — errored/poison items pulled OFF the line, oxide-prominent, each
 *  carrying Retry / Dismiss (OBS-17). Reuses the existing `kb:pipelineControl` contract verbatim
 *  (`data-act`/`data-stage`/`data-id`) — no new mutation surface. Oxide carries the badge fill + the
 *  siding's left border; the reason line stays ink (§3). HEAL-8: the action is OPTIMISTIC (the item is
 *  removed by the caller before this renders, so there's no global "acting" disable); `failures` carries
 *  a per-item retryable error for an item whose async action failed and was re-surfaced. */
export function sidingHtml(items: SetAsideView[], opts: { failures?: Map<string, string> } = {}): string {
  if (items.length === 0) return '';
  const failures = opts.failures;
  const rows = items
    .map((it) => {
      const label = it.name ?? it.itemId;
      const data = `data-stage="${esc(it.stage)}" data-id="${esc(it.itemId)}" data-label="${esc(label)}"`;
      // HEAL-8: a re-surfaced item whose async Retry/Dismiss failed carries an honest, retryable error.
      const err = failures?.get(`${it.stage}:${it.itemId}`);
      const errLine = err
        ? `<span class="line-siding-error viz-body" role="alert"><span class="line-siding-error-glyph viz-state-error" aria-hidden="true">✕</span> ${esc(err)}</span>`
        : '';
      return `<li class="line-siding-item">
        <span class="line-siding-badge" aria-hidden="true">✕ set aside</span>
        <span class="line-siding-where viz-body">${esc(stageDisplayName(it.stage))} · ${esc(label)}</span>
        ${it.reason ? `<span class="line-siding-reason viz-body">${esc(it.reason)}</span>` : ''}
        ${errLine}
        <span class="line-siding-actions">
          <button type="button" class="viz-btn viz-focusable line-siding-retry" data-act="setaside-retry" ${data}>Retry</button>
          <button type="button" class="viz-btn viz-focusable line-siding-dismiss" data-act="setaside-dismiss" ${data}>Dismiss</button>
        </span>
      </li>`;
    })
    .join('');
  return `<section class="line-siding"><h2 class="line-h2 viz-signage">⟂ Set aside — needs attention (<span class="viz-numeric">${items.length}</span>)</h2><ul class="line-siding-items">${rows}</ul></section>`;
}

// ── Secondary instrument readout — retains OBS-6/7/15 depth the Line doesn't surface inline ─────────

/** The diagnostic readout below the Line: the write lock (OBS-7), recent errors w/ drill-down (OBS-6),
 *  latency & throughput (OBS-15), and worktrees (OBS-7). The Line is the at-a-glance instrument; this
 *  is the depth behind it. */
function readoutHtml(v: PipelineStatusView, expanded: Set<number>): string {
  return `<section class="line-readout">${[lockHtml(v.lock), errorsHtml(v.recentErrors, expanded), healthHtml(v), latencyHtml(v), worktreesHtml(v.worktrees)].join('')}</section>`;
}

/** Format a held-lock duration (ms) compactly for the OBS-7 readout (#163): "45s", "2m 5s". */
function heldFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Human label for a lock holder (#163). The watchdog labels sections `stage:op` (e.g.
 *  `claims:advance`, `connect:afterDrain`) so the exact stuck section is nameable — map the stage to
 *  its display name + keep the `op` as the diagnostic suffix ("Claim extraction (advance)"). */
function holderLabel(holder: string): string {
  const i = holder.indexOf(':');
  if (i === -1) return stageDisplayName(holder);
  return `${stageDisplayName(holder.slice(0, i))} (${holder.slice(i + 1)})`;
}

/** OBS-7: the canonical-writer lock — held/holder/waiters, and (#163) a **stuck** warning when the
 *  watchdog flags a section held too long (the primary alarm is `alarmHtml`; this is the readout detail). */
export function lockHtml(lock: PipelineStatusView['lock']): string {
  const heading = `<h2 class="line-h2 viz-signage" title="Canonical-writer lock">Write lock</h2>`;
  if (!lock.held) {
    const waiting = lock.waiters > 0 ? ` <span class="viz-body">(<span class="viz-numeric">${lock.waiters}</span> waiting)</span>` : '';
    return `${heading}<p class="line-lock viz-body">free${waiting}</p>`;
  }
  const who = lock.holder ? esc(holderLabel(lock.holder)) : 'a stage';
  const waiting = lock.waiters > 0 ? `, ${lock.waiters} waiting` : '';
  if (lock.stuck) {
    const forHow = typeof lock.heldMs === 'number' ? ` for ${heldFor(lock.heldMs)}` : ' too long';
    return `${heading}<p class="line-lock line-lock-stuck viz-body"><span class="line-lock-glyph viz-state-error" aria-hidden="true">✕</span> <strong>Stuck</strong> — held by <strong>${who}</strong>${esc(forHow)}${esc(waiting)}; the pipeline is wedged on this section. Check recent errors below.</p>`;
  }
  const since = lock.since ? ` since ${esc(formatTimestamp(lock.since))}` : '';
  const forHow = typeof lock.heldMs === 'number' ? ` <span class="viz-body">(<span class="viz-numeric">${esc(heldFor(lock.heldMs))}</span>)</span>` : '';
  return `${heading}<p class="line-lock viz-body">held by <strong>${who}</strong>${since}${esc(waiting)}${forHow}</p>`;
}

/** OBS-6: recent errors + set-aside markers, each expandable to its cause (drill-down). The level
 *  badge is a ruled chip (ink text, not oxide — small text §3); state still reads via the badge + glyph. */
export function errorsHtml(errors: RecentError[], expanded: Set<number>): string {
  if (errors.length === 0) return `<h2 class="line-h2 viz-signage">Recent errors</h2><p class="viz-body line-readout-empty">None — clean.</p>`;
  const rows = errors
    .map((e, i) => {
      const open = expanded.has(i);
      const where = [e.stage, e.itemId].filter(Boolean).map((x) => esc(String(x))).join(' · ');
      const detail = open
        ? `<div class="line-err-detail"><pre><code>${esc(e.message ?? '(no message)')}</code></pre>${e.runId ? `<div class="viz-body line-err-runid">runId <span class="viz-numeric">${esc(e.runId)}</span></div>` : ''}</div>`
        : '';
      return `<li class="line-err line-err-${esc(e.level)}${open ? ' open' : ''}">
        <button class="line-err-head viz-focusable" data-act="toggle-err" data-i="${i}" aria-expanded="${open}">
          <span class="viz-chip line-err-level">${esc(e.level)}</span>
          <span class="line-err-event viz-body">${esc(e.event)}</span>
          ${where ? `<span class="viz-body line-err-where">${where}</span>` : ''}
          <span class="line-err-ts viz-numeric">${esc(e.ts)}</span>
        </button>
        ${detail}
      </li>`;
    })
    .join('');
  return `<h2 class="line-h2 viz-signage">Recent errors</h2><ul class="line-errors">${rows}</ul>`;
}

/** OBS-15: latency & throughput — Copilot p50/p95, per-stage throughput, where-time-goes. */
export function latencyHtml(v: PipelineStatusView): string {
  const c = v.perf.copilot;
  const w = v.perf.whereTimeGoes;
  const copilot =
    c.count > 0
      ? `<p class="line-latency viz-body">Copilot calls: <strong class="viz-numeric">${c.count}</strong> · avg <span class="viz-numeric">${c.avgMs}ms</span> · p50 <span class="viz-numeric">${c.p50Ms}ms</span> · p95 <span class="viz-numeric">${c.p95Ms}ms</span></p>`
      : `<p class="viz-body line-readout-empty">No Copilot calls recorded yet.</p>`;
  const where =
    w.totalMs > 0
      ? `<p class="line-where viz-body">Where time goes: <span class="viz-numeric">${Math.round(w.copilotPct * 100)}%</span> Copilot, <span class="viz-numeric">${100 - Math.round(w.copilotPct * 100)}%</span> other (<span class="viz-numeric">${Math.round(w.copilotMs / 1000)}s / ${Math.round(w.totalMs / 1000)}s</span>)</p>`
      : '';
  const stages = v.perf.stages.length
    ? `<ul class="line-throughput">${v.perf.stages
        .map((st) => `<li class="viz-body">${esc(stageDisplayName(st.stage))}: <span class="viz-numeric">${st.throughputPerMin}/min</span> · <span class="viz-numeric">${st.runs}</span> runs · avg <span class="viz-numeric">${st.avgMs}ms</span></li>`)
        .join('')}</ul>`
    : '';
  const slow = v.perf.slowest.length
    ? `<div class="line-slowops"><span class="viz-body">Slowest ops:</span><ul>${v.perf.slowest
        .slice(0, 5)
        .map((s) => {
          const where2 = [s.stage, s.itemId].filter(Boolean).map((x) => esc(String(x))).join(' · ');
          return `<li class="viz-body">${esc(s.op)}${where2 ? ` (${where2})` : ''}: <span class="viz-numeric">${s.durationMs}ms</span></li>`;
        })
        .join('')}</ul></div>`
    : '';
  return `<h2 class="line-h2 viz-signage">Latency &amp; throughput</h2>${copilot}${where}${stages}${slow}`;
}

/** OBS-22 — the memory/health readout: current RSS/heap, the OBS-21 leak trend (a loud "climbing"
 *  alarm when leaking — mirrors the stall alarm's treatment, hue on the glyph only per §2), and the
 *  last crash breadcrumb (when/where/last item). Answers "is memory climbing / did we recently crash
 *  + on what" at a glance. Omitted entirely when the build has no telemetry wired. */
export function healthHtml(v: PipelineStatusView): string {
  const h = v.health;
  if (!h) return '';
  const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}`;
  const parts: string[] = [`<h2 class="line-h2 viz-signage">Memory &amp; health</h2>`];

  if (h.memory) {
    const m = h.memory;
    parts.push(
      `<p class="line-health-mem viz-body">RSS <strong class="viz-numeric">${mb(m.rss)} MB</strong> · heap <span class="viz-numeric">${mb(m.heapUsed)}/${mb(m.heapTotal)} MB</span> · external <span class="viz-numeric">${mb(m.external)} MB</span></p>`,
    );
  } else {
    parts.push(`<p class="viz-body line-readout-empty">No memory sample yet.</p>`);
  }

  if (h.trend?.leaking) {
    // Loud "memory climbing" alarm — reuses the stall-alarm treatment (glyph carries the hue, §2).
    parts.push(
      `<div class="line-alarm line-alarm-stall" role="alert"><span class="line-alarm-glyph viz-state-error" aria-hidden="true">✕</span><span class="line-alarm-text viz-body"><strong>Memory climbing</strong> — RSS <span class="viz-numeric">+${h.trend.rssDeltaMb} MB</span> over <span class="viz-numeric">${h.trend.windowMin}m</span> (<span class="viz-numeric">${h.trend.rssSlopeMbPerMin} MB/min</span>), no plateau. A slow leak is the prime suspect for an OOM-class crash.</span></div>`,
    );
  } else if (h.trend) {
    parts.push(
      `<p class="line-health-trend viz-body">Trend: <span class="viz-numeric">${h.trend.rssDeltaMb >= 0 ? '+' : ''}${h.trend.rssDeltaMb} MB</span> RSS over <span class="viz-numeric">${h.trend.windowMin}m</span> — steady.</p>`,
    );
  }

  if (h.lastCrash) {
    const c = h.lastCrash;
    const where = [c.stage, c.itemId].filter(Boolean).map((x) => esc(String(x))).join(' · ');
    parts.push(
      `<div class="line-health-crash" role="alert"><span class="line-alarm-glyph viz-state-error" aria-hidden="true">⚠</span> <span class="viz-body">Last crash: <strong>${esc(c.kind)}</strong> at <span class="viz-numeric">${esc(formatTimestamp(c.ts))}</span>${where ? ` · ${where}` : ''}${c.reason ? ` — ${esc(c.reason)}` : ''}</span></div>`,
    );
  }
  return parts.join('');
}

/** OBS-7: the live worktrees + the branch each is on. */
export function worktreesHtml(worktrees: WorktreeInfo[]): string {
  if (worktrees.length === 0) return '';
  const rows = worktrees
    // Show the worktree dir basename (the full `.kb/cache/...` path is dev-noise); keep it as a tooltip.
    .map((w) => `<li class="viz-body" title="${esc(w.path)}"><code>${esc(w.path.replace(/\/+$/, '').split('/').pop() ?? w.path)}</code>${w.branch ? ` → ${esc(w.branch)}` : ''}</li>`)
    .join('');
  return `<h2 class="line-h2 viz-signage">Worktrees</h2><ul class="line-worktrees">${rows}</ul>`;
}
