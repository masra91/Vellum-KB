// Activity view (SPEC-0029 AUDIT-5/6/7/8) — the "observatory". A read-only window on what the KB
// has been doing: a curated, human-friendly feed (one entry per run) with drill-down to the raw
// audit events, filter/search (by actor + free text), and a lineage tracer for any subject id.
//
// READ-ONLY (AUDIT-8): no retries, edits, approvals, or config here — those live in Reviews /
// Control Panel. Thin DOM over the typed IPC, matching the other views; `esc()` on every
// interpolation (XSS-safe). Render helpers are pure (data → HTML string) so they unit-test without
// a DOM; `mountActivity` wires the IPC + events.
//
// NB: imports here are TYPE-ONLY from kb/types (erased at build) — the renderer must not pull the
// audit domain modules' node:fs/simple-git runtime deps (STACK-6). The actor filter options are
// derived from the loaded data, not imported from AUDIT_ACTORS (a runtime value).
import { esc } from '../html';
import { withTimeout, skeletonFragmentHtml } from '../loadGuard';
import { formatTimestamp, relativeCompact } from '../formatTime';
import { stageDisplayName } from '../stageLabels';
import { glyphFor } from './activityGlyph';
import { navIcon } from '../icons';
import { setTopbarContext } from '../nav';
import type { ActivityFeedEntry, AuditEvent, Lineage, ActivityFilter, AuditActor, SourceSensitivity } from '../../kb/types';

// View-local, ephemeral state (the shell mounts once + toggles visibility).
let entries: ActivityFeedEntry[] = [];
let total = 0;
let truncated = false;
let knownActors: string[] = []; // the actor universe, captured from the first unfiltered load
let filter: ActivityFilter = {};
let expanded = new Set<string>(); // entry ids currently drilled-down to raw events
let lineage: Lineage | null = null;
let sourceSensitivities: Record<string, SourceSensitivity> = {}; // SENSE-10: per-source label for the lineage chips (read-only)
let loading = false;
let errorMsg = '';
// SPEC-0060 VUX-14: debounce the search input so a (re)load fires after the Principal pauses typing,
// not on every keystroke — no per-keystroke IPC, no flicker.
export const SEARCH_DEBOUNCE_MS = 200;
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

export function mountActivity(container: HTMLElement): void {
  entries = [];
  total = 0;
  truncated = false;
  knownActors = [];
  filter = {};
  expanded = new Set();
  lineage = null;
  sourceSensitivities = {};
  loading = true;
  errorMsg = '';
  // #519 §3 — verbatim from the mock (design-prototypes/vellum-v3.html CTX.activity). One static chip;
  // Activity's own in-view controls (actor/search filters) already live in `.activity-controls`.
  setTopbarContext(`<span class="topchip">${navIcon('stack-2')} All activity</span>`);
  container.innerHTML = `
    <div class="activity-view">
      <h1 class="activity-title viz-voice">Activity</h1>
      <p class="activity-note">What your library has been doing — and why. Read-only.</p>
      <div class="activity-controls" id="activityControls"></div>
      <div class="activity-body" id="activityBody"></div>
      <div class="activity-lineage" id="activityLineage"></div>
    </div>`;
  wire(container);
  renderControls(container);
  void load(container);
}

/** (Re)load the feed for the current filter (AUDIT-5/7). buildActivityIndex on the main side keeps
 *  it fresh; the first unfiltered load seeds the actor dropdown universe. */
async function load(container: HTMLElement): Promise<void> {
  loading = true;
  errorMsg = '';
  renderBody(container);
  try {
    // #145: bound the wait so a hung `activityFeed` can't leave an infinite spinner.
    const res = await withTimeout(window.kbApi.activityFeed(filter));
    entries = res.entries;
    total = res.total;
    truncated = res.truncated;
    if (knownActors.length === 0 && !hasActiveFilter()) {
      knownActors = [...new Set(entries.map((e) => e.actor))].sort();
      renderControls(container);
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  } finally {
    loading = false;
    renderBody(container);
  }
}

function hasActiveFilter(): boolean {
  return Boolean(filter.actors?.length || filter.text);
}

// ── Event wiring ────────────────────────────────────────────────────────────────────────────────

function wire(container: HTMLElement): void {
  // Delegate: controls + feed rerender, so handlers survive innerHTML swaps.
  container.addEventListener('input', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'activitySearch') {
      const v = (t as HTMLInputElement).value.trim();
      filter = { ...filter, text: v || undefined };
      // Debounced: coalesce a burst of keystrokes into one load once typing pauses (VUX-14).
      if (searchDebounce !== undefined) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        searchDebounce = undefined;
        void load(container);
      }, SEARCH_DEBOUNCE_MS);
    }
  });
  container.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'activityActor') {
      const v = (t as HTMLSelectElement).value;
      filter = { ...filter, actors: v ? [v as AuditActor] : undefined };
      void load(container);
    }
  });
  // Enter in the trace-lookup input submits, mirroring the button (a keyboard-first path, AUDIT-7).
  container.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.id === 'activityTraceId' && (e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      submitTraceLookup(container);
    }
  });
  container.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle') {
      const id = el.dataset.id!;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderBody(container);
    } else if (act === 'lineage') {
      void traceLineage(container, el.dataset.id!);
    } else if (act === 'trace-lookup') {
      submitTraceLookup(container); // AUDIT-6/7: trace any entity/source/claim id the Principal holds
    } else if (act === 'clear-lineage') {
      lineage = null;
      renderLineage(container);
    } else if (act === 'retry-load') {
      void load(container); // #145: re-run the feed load after a failure/timeout
    }
  });
}

/** Read the trace-lookup input and trace the entered id (AUDIT-6/7). A blank/whitespace id is a
 *  no-op (no empty traces); the id is trimmed so a stray copy-paste space doesn't miss. */
function submitTraceLookup(container: HTMLElement): void {
  const input = container.querySelector<HTMLInputElement>('#activityTraceId');
  const id = input?.value.trim();
  if (!id) return;
  void traceLineage(container, id);
}

async function traceLineage(container: HTMLElement, id: string): Promise<void> {
  try {
    lineage = await withTimeout(window.kbApi.activityLineage(id));
  } catch (err) {
    lineage = { subjectId: id, kind: 'unknown', sources: [], events: [], decisions: [] };
    errorMsg = err instanceof Error ? err.message : String(err);
  }
  // SENSE-10 (read-only, AUDIT-8-safe): fold each source's current sensitivity label in for the chip. A
  // failed read just omits the chip — never blocks the lineage panel.
  sourceSensitivities = {};
  if (lineage.sources.length > 0) {
    try {
      sourceSensitivities = await withTimeout(window.kbApi.getSourceSensitivities(lineage.sources));
    } catch {
      /* no chips this render */
    }
  }
  renderLineage(container);
}

// ── Render (pure helpers return HTML strings) ─────────────────────────────────────────────────

function renderControls(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#activityControls');
  if (el) el.innerHTML = controlsHtml(knownActors, filter);
}
function renderBody(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#activityBody');
  if (!el) return;
  el.setAttribute('aria-busy', String(loading));
  el.innerHTML = bodyHtml({ entries, total, truncated, expanded, loading, errorMsg });
}
function renderLineage(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#activityLineage');
  if (el) el.innerHTML = lineage ? lineageHtml(lineage, sourceSensitivities) : '';
}

export function controlsHtml(actors: readonly string[], f: ActivityFilter): string {
  const opts = ['<option value="">All activity</option>']
    .concat(actors.map((a) => `<option value="${esc(a)}"${f.actors?.[0] === a ? ' selected' : ''}>${esc(a)}</option>`))
    .join('');
  return `
    <label class="viz-field activity-field">
      <span class="viz-field__label viz-signage">Filter</span>
      <select id="activityActor" class="activity-actor viz-field__input viz-body viz-focusable" aria-label="Filter by stage or agent">${opts}</select>
    </label>
    <label class="viz-field activity-field">
      <span class="viz-field__label viz-signage">search</span>
      <input id="activitySearch" class="activity-search viz-field__input viz-body viz-focusable" type="search" placeholder="Search activity…" aria-label="Search activity" value="${esc(f.text ?? '')}" />
    </label>
    <label class="viz-field activity-field activity-trace-field">
      <span class="viz-field__label viz-signage">trace</span>
      <span class="activity-trace-input">
        <input id="activityTraceId" class="activity-trace-id viz-field__input viz-body viz-focusable" type="text" placeholder="entity / source / claim id…" aria-label="Trace lineage by id" />
        <button type="button" id="activityTraceGo" class="viz-btn viz-btn--sm viz-focusable activity-trace-go" data-act="trace-lookup" aria-label="Trace lineage of the entered id">trace</button>
      </span>
    </label>`;
}

interface BodyState {
  entries: ActivityFeedEntry[];
  total: number;
  truncated: boolean;
  expanded: Set<string>;
  loading: boolean;
  errorMsg: string;
}

export function bodyHtml(s: BodyState): string {
  if (s.loading) return skeletonFragmentHtml('rows');
  // #145: a failed/timed-out load is retryable, never an infinite spinner. The view's header +
  // controls stay mounted around this body, so a button here (not a full renderLoadError) suffices.
  if (s.errorMsg) return `<p class="activity-error error">Couldn’t load activity: ${esc(s.errorMsg)} <button type="button" class="viz-btn viz-btn--sm viz-focusable load-retry" data-act="retry-load">Retry</button></p>`;
  if (s.entries.length === 0) return `<p class="activity-note activity-empty">No activity yet — once your library starts processing, what it does shows up here.</p>`;
  const note = s.truncated
    ? `<p class="activity-note activity-truncation">Showing the ${s.entries.length} most recent of ${s.total} events.</p>`
    : `<p class="activity-note activity-count">${s.total} event${s.total === 1 ? '' : 's'}.</p>`;
  // ENG-15/16 per-item isolation: a single legacy/malformed entry must not blank the whole feed. Wrap
  // each row so a throw degrades to a skeleton <li> (the entry's own id when available) and its siblings
  // still render. (entryHtml/rawEventHtml are also field-guarded below; this is the belt over the braces.)
  return note + `<ul class="activity-feed">${s.entries.map((e) => safeEntryHtml(e, s.expanded.has(e?.id))).join('')}</ul>`;
}

/** Per-entry isolation wrapper — never throws into the feed `.map`. */
function safeEntryHtml(e: ActivityFeedEntry, open: boolean): string {
  try {
    return entryHtml(e, open);
  } catch {
    return `<li class="activity-entry activity-entry--skeleton"><div class="activity-entry-row"><span class="activity-ft activity-note">(unknown activity) — this entry couldn’t be shown.</span></div></li>`;
  }
}

/** A subject id to offer a lineage trace on (entity preferred, else source/claim). */
function traceableSubject(e: ActivityFeedEntry): string | null {
  const s = e.events?.[0]?.subjects ?? {}; // `?.` AFTER the index too: a legacy entry may lack `events`
  return s.entityId ?? s.sourceId ?? s.claimId ?? null;
}

/** Split a digest summary into a lead verb + the remaining body (presentation only; a one-word
 *  summary is all verb). NULL-SAFE (ENG-15/16): a missing summary yields empty parts, not a throw. */
export function splitSummary(summary: string | undefined): { verb: string; body: string } {
  const s = (summary ?? '').trim();
  const i = s.indexOf(' ');
  return i === -1 ? { verb: s, body: '' } : { verb: s.slice(0, i), body: s.slice(i + 1) };
}

export function entryHtml(e: ActivityFeedEntry, open: boolean): string {
  const trace = traceableSubject(e);
  const traceBtn = trace ? `<button class="activity-trace viz-btn viz-btn--ghost viz-btn--sm viz-focusable" data-act="lineage" data-id="${esc(trace)}" aria-label="Trace the origin of: ${esc(e.summary)}">trace origin</button>` : '';
  const raw = open
    ? `<div class="activity-raw">${(e.events ?? []).map(rawEventHtml).join('')}</div>`
    : '';
  // UX v2 row (DL-2 contract): glyph-TILE (hue typed by event kind, #184; oxide on a failed event;
  // never ember) · TEXT (`.ft` flex:1 min-width:0 + overflow-wrap → a long id wraps, never overflows
  // into the timestamp — the structural fix for the QD-2 overlap bug) · compact relative TIMESTAMP
  // (`.fw` flex:none nowrap → structurally immune). The trace action keeps its OWN flex:none slot.
  const g = glyphFor(e.actor, e.events?.[0]?.eventType);
  const { verb, body } = splitSummary(e.summary);
  return `
    <li class="activity-entry${open ? ' open' : ''}">
      <div class="activity-entry-row">
        <button class="activity-entry-head viz-focusable" data-act="toggle" data-id="${esc(e.id)}" aria-expanded="${open}">
          <span class="activity-gl gl ${g.cls}" title="${esc(stageDisplayName(e.actor))}" aria-hidden="true">${navIcon(g.icon)}</span>
          <span class="activity-ft ft">
            <span class="activity-verb">${esc(verb)}</span>${body ? ` <span class="activity-detail">${esc(body)}</span>` : ''}${e.eventCount > 1 ? ` <span class="activity-evcount">${e.eventCount} events</span>` : ''}
          </span>
          <span class="activity-fw fw" title="${esc(formatTimestamp(e.ts))}">${esc(relativeCompact(e.ts))}</span>
        </button>
        ${traceBtn}
      </div>
      ${raw}
    </li>`;
}

/** Drill-down: the raw canonical event behind a feed entry (AUDIT-5). */
export function rawEventHtml(ev: AuditEvent): string {
  const json = JSON.stringify({ ts: ev.ts, actor: ev.actor, eventType: ev.eventType, runId: ev.runId, model: ev.model, subjects: ev.subjects, payload: ev.payload }, null, 2);
  // A legacy audit event may lack `provenance` — guard so the drill-down degrades to the JSON without the
  // file:line footer rather than throwing (ENG-15/16).
  const src = ev.provenance ? `<div class="activity-event-src">${esc(ev.provenance.file)}:${esc(String(ev.provenance.line ?? ''))}</div>` : '';
  return `<pre class="activity-event"><code>${esc(json)}</code></pre>${src}`;
}

/** A source's sensitivity as a read-only chip (SENSE-10): the current label, tag-styled, with its origin
 *  in the tooltip. Read-only by design — the Activity view is the observatory (AUDIT-8); editing lives in
 *  a config surface (fast-follow). Omitted when the source has no readable label. */
function sensitivityChip(s: SourceSensitivity | undefined): string {
  if (!s) return '';
  return ` <span class="viz-chip sensitivity-chip" data-sensitivity="${esc(s.sensitivity)}" title="sensitivity: ${esc(s.sensitivity)} (set by ${esc(s.by)})">${esc(s.sensitivity)}</span>`;
}

export function lineageHtml(l: Lineage, sensitivities: Record<string, SourceSensitivity> = {}): string {
  if (l.events.length === 0) {
    return `<div class="lineage-panel"><div class="lineage-head"><strong>Lineage:</strong> <code>${esc(l.subjectId)}</code> <button class="viz-btn viz-btn--ghost viz-btn--sm viz-focusable" data-act="clear-lineage" aria-label="Close lineage panel">close</button></div><p class="activity-note">No lineage found for this id.</p></div>`;
  }
  const sources = l.sources.length
    ? `<div class="lineage-sources activity-note">From source${l.sources.length === 1 ? '' : 's'}: ${l.sources.map((s) => `<span class="lineage-source"><code>${esc(s)}</code>${sensitivityChip(sensitivities[s])}</span>`).join(', ')}</div>`
    : '';
  const timeline = l.events
    .map((e) => `<li class="lineage-step"><span class="activity-actor-badge viz-chip" title="${esc(e.actor)}">${esc(stageDisplayName(e.actor))}</span> <span>${esc(e.eventType)}</span> <span class="lineage-step-ts">${esc(formatTimestamp(e.ts))}</span></li>`)
    .join('');
  const decisions = l.decisions.length
    ? `<div class="lineage-decisions"><span class="lineage-decisions-label viz-signage">Decisions:</span><ul>${l.decisions.map((d) => `<li>${esc(d.eventType)}${typeof d.payload?.verdict === 'string' ? ` — ${esc(d.payload.verdict)}` : ''}${typeof d.payload?.question === 'string' ? ` (${esc(d.payload.question)})` : ''}</li>`).join('')}</ul></div>`
    : '';
  return `
    <div class="lineage-panel">
      <div class="lineage-head"><strong>Lineage:</strong> <code>${esc(l.subjectId)}</code> <span class="lineage-kind">(${esc(l.kind)})</span> <button class="viz-btn viz-btn--ghost viz-btn--sm viz-focusable" data-act="clear-lineage" aria-label="Close lineage panel">close</button></div>
      ${sources}
      <ol class="lineage-timeline">${timeline}</ol>
      ${decisions}
    </div>`;
}
