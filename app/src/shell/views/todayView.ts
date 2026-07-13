// Today — the v2 command-center home (SPEC-0058 STATE-7). The first thing you see: a calm, glanceable
// state-of-your-library. A time-of-day greeting, "The Line" pipeline ribbon, the four headline counts,
// recent activity, the ONE "needs you" decision surface, and a health glance — all from a SINGLE
// maintained projection read (`kb:getTodayProjection`), no live vault scan on the render path (STATE-1).
//
// Built in the UX v2 instrument language (design-system.css primitives + the `.today-*` layer in
// index.css). `status` is FIRST-CLASS, mirroring exploreView: a calm `warming` face while the composite
// builds its first snapshot (never the alarming error face), `ready` once built, honest degrade on a
// genuine `error` / thrown IPC (#160). The live date/time clock is the only thing the view computes
// itself (it ticks) — everything else is the projection's, drawn exactly as served.
import { esc, emptyState } from '../html';
import { navIcon } from '../icons';
import { navigateTo } from '../nav';
import { renderLoadError, renderWarming, reportLoadFailure, paintSkeleton } from '../loadGuard';
import type { TodayActivityItem, TodayDecision, TodayHealthRow, TodayProjection, TodayProjectionView, TodayStat, TodayStation } from '../../kb/types';

const HEADER = `<h1 class="today-title viz-signage">Today</h1>`;

/** Per-mount view state: the warming re-poll handle + the live-clock ticker (both cleared on unmount). */
interface TodayState {
  warmTimer?: number;
  clockTimer?: number;
}

/** A stat key → the inline icon that labels its card (reuses the shared nav/feed icon set). */
const STAT_ICON: Record<TodayStat['key'], string> = { sources: 'sources', claims: 'quote', entities: 'explore', connections: 'link' };

/** An activity kind → its feed-row glyph (DL-2's table; same line idiom as the Activity view tiles). */
const ACTIVITY_ICON: Record<TodayActivityItem['kind'], string> = {
  composed: 'book',
  connected: 'link',
  extracted: 'quote',
  captured: 'capture',
  linked: 'link',
  other: 'sparkles',
};

/** A decision kind → its card glyph. `contradiction` = the split (sources fork); `review` = the queue. */
const DECISION_ICON: Record<TodayDecision['kind'], string> = { contradiction: 'split', review: 'reviews' };

/** A health-row severity → its glyph. ok = settled check (patina); warn/bad = the alert triangle, the
 *  hue carried by `data-status` in CSS (brass / oxide) — the glyph keeps the signal non-colour-alone (#184). */
const HEALTH_ICON: Record<TodayHealthRow['status'], string> = { ok: 'circle-check', warn: 'alert-triangle', bad: 'alert-triangle' };

export async function mountToday(container: HTMLElement): Promise<void> {
  const state: TodayState = {};
  paintSkeleton(container, HEADER, 'prose');
  await load(container, state);
}

/** Read the maintained Today projection (ONE read, no live scan — STATE-1) and paint. `status` is
 *  first-class: `warming`/null data → a calm warming face + auto-recheck; `error` or a thrown IPC →
 *  honest degrade with Recheck (never a stuck spinner, #160). */
async function load(container: HTMLElement, state: TodayState): Promise<void> {
  let env: TodayProjectionView;
  try {
    env = await window.kbApi.getTodayProjection();
  } catch (err) {
    reportLoadFailure('today', err); // un-swallow to the app-log, then honest error face
    clearTimers(state);
    renderLoadError(container, HEADER, () => void load(container, state));
    return;
  }
  if (env.status === 'error') {
    clearTimers(state);
    renderLoadError(container, HEADER, () => void load(container, state));
    return;
  }
  if (env.status === 'warming' || env.data === null) {
    // Still composing the first snapshot — calm warming face + auto-recheck, never the broken face.
    clearTimers(state);
    renderWarming(container, HEADER, () => void load(container, state));
    state.warmTimer = setTimeout(() => {
      if (container.isConnected) void load(container, state);
    }, 2000) as unknown as number;
    return;
  }
  clearTimeout(state.warmTimer);
  paint(container, state, env.data);
}

/** Render the full command-center surface from the served projection. No IPC — pure draw. */
function paint(container: HTMLElement, state: TodayState, data: TodayProjection): void {
  container.innerHTML = `<div class="today today-v2 viz-surface">
    ${hero(data)}
    ${flowStrip(data.line)}
    ${statsGrid(data.stats)}
    <div class="today-cols">
      ${activityPanel(data.activity)}
      <div class="today-side">
        ${needsPanel(data.decisions)}
        ${healthPanel(data.health)}
      </div>
    </div>
  </div>`;
  wire(container, state);
}

/** The greeting hero — Spectral salutation (comma only when the name is known), the calm state-of-the-
 *  library subtitle, the live clock, and the primary Capture CTA. */
function hero(data: TodayProjection): string {
  const name = data.greeting.name ? `<span class="today-greet-name">, ${esc(data.greeting.name)}</span>` : '';
  // v3: no hero Capture CTA — the top bar's global Quick-add covers it (SPEC-0060 §4). Just greeting + the
  // live clock (the mock's "when"). Capture stays a click away via the rail + Quick-add.
  return `<header class="today-hero">
    <div class="today-hero-text">
      <h1 class="today-greet viz-voice">${esc(data.greeting.salutation)}${name}.</h1>
      <p class="today-sub viz-body">${esc(data.subtitle)}</p>
    </div>
    <time class="today-clock viz-numeric" aria-live="off">${esc(clockText())}</time>
  </header>`;
}

/** The slim flow-strip (SPEC-0060 VUX-10) — the dialed-down "Line" on Today now that Status is dissolved:
 *  a loom-marked lead (it's humming), compact named stages with a done/working/waiting legend, and a
 *  "See activity" link. Stage state reads via a computed done/working/waiting class (+ blocked/error),
 *  never colour-alone — the dot AND the legend carry it (#184). The continuous loom mark signals live work. */
function flowStrip(line: TodayProjection['line']): string {
  const sts = line.stations;
  // Frontier = the furthest station with activity (count>0 or a live state). Items have passed everything
  // before it (done); everything after is waiting. (The contract's `state` collapses passed→idle, so the
  // done/waiting split — VUX-10's legend — is inferred from position relative to the live frontier.)
  let frontier = -1;
  sts.forEach((s, i) => {
    if (s.count > 0 || s.state === 'running' || s.state === 'blocked' || s.state === 'error') frontier = i;
  });
  const stations = sts.map((s, i) => flowStation(s, i, frontier)).join('');
  return `<section class="today-flow" aria-label="Pipeline flow">
    <div class="today-flow-lead"><span class="vmark loom" aria-hidden="true"></span><span class="viz-numeric">${esc(line.meta)}</span></div>
    <div class="today-flow-stations" role="list">${stations || '<span class="today-flow-empty viz-body">The pipeline is idle.</span>'}</div>
    <div class="today-flow-key" aria-hidden="true">
      <span><i style="background:var(--viridian)"></i>done</span>
      <span><i style="background:var(--sprout)"></i>working</span>
      <span><i style="background:var(--hair)"></i>waiting</span>
    </div>
    <button type="button" class="today-flow-go viz-focusable" data-target="activity">See activity ›</button>
  </section>`;
}

/** One flow-strip stage: a state-coloured dot + name + (its count when items are present). The fs-class
 *  is the glanceable done/working/waiting (+ blocked/error) reading; the legend names the three. */
function flowStation(s: TodayStation, i: number, frontier: number): string {
  const fs = s.state === 'running' ? 'working' : s.state === 'blocked' ? 'blocked' : s.state === 'error' ? 'error' : i < frontier ? 'done' : 'waiting';
  const ct = s.count > 0 ? ` <span class="ct">${esc(String(s.count))}</span>` : '';
  return `<span class="today-fs-st" data-fs="${fs}" role="listitem" title="${esc(s.name)} — ${esc(s.state)}"><span class="d" aria-hidden="true"></span>${esc(s.name)}${ct}</span>`;
}

/** The four headline stat cards, each with its today-delta ("+6 today" up / "stable" flat). */
function statsGrid(stats: TodayStat[]): string {
  const cards = stats
    .map((s) => {
      const up = s.delta.dir === 'up';
      const delta = `<div class="today-stat-d" data-dir="${esc(s.delta.dir)}">${up ? `${navIcon('arrow-up-circle')} ` : ''}${esc(s.delta.text)}</div>`;
      return `<div class="today-stat viz-card viz-card--lift">
        <div class="today-stat-k viz-signage">${navIcon(STAT_ICON[s.key])} ${esc(s.label)}</div>
        <div class="today-stat-v viz-numeric">${esc(groupThousands(s.value))}</div>
        ${delta}
      </div>`;
    })
    .join('');
  return `<div class="today-stats">${cards}</div>`;
}

/** Recent activity — the curated feed (newest-first, capped), with a "View all" deep-link to Activity. */
function activityPanel(items: TodayActivityItem[]): string {
  const rows = items.length
    ? `<ul class="today-feed" role="list">${items.map(feedRow).join('')}</ul>`
    : emptyState({ title: 'Nothing has moved yet.', body: 'As the pipeline captures and connects, the latest steps appear here.', compact: true });
  return `<section class="today-panel viz-card" aria-label="Recent activity">
    <h3 class="today-panel-head viz-voice">${navIcon('activity')} Recent activity
      <button type="button" class="today-panel-link viz-focusable" data-target="activity">View all</button>
    </h3>
    ${rows}
  </section>`;
}

/** One activity row: a kind-glyph tile, the human summary (with `[[Name]]` refs highlighted), the age. */
function feedRow(a: TodayActivityItem): string {
  return `<li class="today-feed-row">
    <span class="today-feed-glyph" data-kind="${esc(a.kind)}" aria-hidden="true">${navIcon(ACTIVITY_ICON[a.kind] ?? 'sparkles')}</span>
    <div class="today-feed-text viz-body">${highlightRefs(a.text)}</div>
    <span class="today-feed-when viz-numeric">${esc(a.when)}</span>
  </li>`;
}

/** "Needs you" — the ONE ember surface on Today (decisions only). Empty → the calm "nothing needs you"
 *  rest state (settled, NOT ember — attention hue is rationed to genuine open decisions, brand §3). */
function needsPanel(decisions: TodayDecision[]): string {
  const body = decisions.length
    ? decisions.map(decisionCard).join('')
    : `<div class="today-rest">${navIcon('circle-check')}<p class="viz-body">Nothing needs you — your library is current.</p></div>`;
  return `<section class="today-panel today-needs${decisions.length ? ' is-active' : ''} viz-card" aria-label="Needs you">
    <h3 class="today-panel-head viz-voice">${navIcon('reviews')} Needs you</h3>
    ${body}
  </section>`;
}

/** One decision card — glyph + title + body + a CTA that deep-links to its target view. Ember-cued. */
function decisionCard(d: TodayDecision): string {
  return `<div class="today-decide" data-kind="${esc(d.kind)}">
    <span class="today-decide-ic" aria-hidden="true">${navIcon(DECISION_ICON[d.kind] ?? 'reviews')}</span>
    <div class="today-decide-tx">
      <b class="viz-signage">${esc(d.title)}</b>
      <p class="viz-body">${esc(d.body)}</p>
    </div>
    <button type="button" class="today-go viz-focusable" data-target="${esc(d.targetView)}">${esc(d.action)} ›</button>
  </div>`;
}

/** The health glance — the SAME dimensions + severity as the Health view (so a row reads identically),
 *  with a "Full report" deep-link. ok=patina settled · warn=brass · bad=oxide, glyph carries the signal. */
function healthPanel(rows: TodayHealthRow[]): string {
  const list = rows
    .map(
      (r) => `<div class="today-hrow" data-status="${esc(r.status)}">
        <span class="today-hi" aria-hidden="true">${navIcon(HEALTH_ICON[r.status] ?? 'circle-check')}</span>
        <div class="today-ht"><b class="viz-signage">${esc(r.label)}</b><span class="viz-body">${esc(r.sub)}</span></div>
        <span class="today-hn viz-numeric">${esc(r.value)}</span>
      </div>`,
    )
    .join('');
  return `<section class="today-panel viz-card" aria-label="Health">
    <h3 class="today-panel-head viz-voice">${navIcon('health')} Health
      <button type="button" class="today-panel-link viz-focusable" data-target="health">Full report</button>
    </h3>
    ${list}
  </section>`;
}

/** Wire the deep-links (decision CTAs, "View all"/"Full report", Capture) → `navigateTo`, and start the
 *  live-clock ticker (cleared on unmount via the isConnected guard). All targets are static view ids. */
function wire(container: HTMLElement, state: TodayState): void {
  for (const el of Array.from(container.querySelectorAll<HTMLButtonElement>('[data-target]'))) {
    el.addEventListener('click', () => {
      const target = el.dataset.target;
      if (target) navigateTo(target);
    });
  }
  clearTimeout(state.clockTimer);
  const clock = container.querySelector<HTMLTimeElement>('.today-clock');
  const tick = (): void => {
    if (!container.isConnected || !clock) {
      clearTimeout(state.clockTimer);
      return;
    }
    clock.textContent = clockText();
    state.clockTimer = setTimeout(tick, 30000) as unknown as number;
  };
  state.clockTimer = setTimeout(tick, 30000) as unknown as number;
}

/** Cancel any pending warming re-poll + clock ticker (on a status change away from ready / on reload). */
function clearTimers(state: TodayState): void {
  clearTimeout(state.warmTimer);
  clearTimeout(state.clockTimer);
}

/** The live clock label — "Saturday, June 28 · 8:21 AM" (view-rendered; the projection carries no clock). */
function clockText(): string {
  const now = new Date();
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

/** Group a non-negative integer with thousands separators ("1847" → "1,847"). Locale-free + deterministic. */
function groupThousands(n: number): string {
  const safe = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Highlight `[[Name]]` / source-basename refs woven into an activity summary (esc first, then wrap the
 *  inner name in a styled — non-interactive — span; Today is a glance, deep interaction lives in Activity).
 *  A malformed `[[` left in the text is harmless (rendered as the escaped literal). */
function highlightRefs(text: string): string {
  return esc(text).replace(/\[\[([^\]]+)\]\]/g, (_whole, inner: string) => {
    const bar = inner.indexOf('|');
    const name = (bar === -1 ? inner : inner.slice(bar + 1)).trim();
    return `<span class="today-src">${name}</span>`;
  });
}
