// Explore view — "the knowledge, navigable" (SPEC-0039 EXPLORE). A read-only, in-app view over the
// evergreen `entities/` graph: a focused entity centered with its directly-linked (1-hop) neighbors,
// each click-to-re-center, with the center's claims inline so exploration leads back to reading
// (EXPLORE-4). Built in "The Line" instrument language (design-system.css primitives) — distinct from
// Obsidian's generic graph (EXPLORE-10). Thin DOM over the typed IPC; the neighborhood assembly is pure
// + node-tested in `kb/explorePanel`. v1 renders a DOM neighborhood (not a force-directed canvas) — the
// thinnest valuable slice (EXPLORE-2); whole-graph + timeline are deferred to v2.
//
// Interactions: search-to-focus + re-center + breadcrumb (EXPLORE-6); typed, confidence-bearing edges
// with a speculative distinction (EXPLORE-5); **filter** the neighborhood by entity kind / edge type /
// "hide speculative" (EXPLORE-9, client-side over the loaded bounded neighborhood); **expand-in-place**
// a neighbor's own links without changing focus (EXPLORE-7, lazy-fetched + cached). The expand reveal
// uses a CSS animation that degrades to instant under prefers-reduced-motion (EXPLORE-13), the same
// reduced-motion discipline as the rest of The Line.
import { esc, emptyState } from '../html';
import { renderLoadError, renderWarming, reportLoadFailure, paintSkeleton } from '../loadGuard';
import { NAVIGATE_EVENT, consumePendingFocus, setTopbarContext, type NavigateDetail } from '../nav';
import { navIcon } from '../icons';
import { VIEW_EXPLORE } from '../views';
import type { ExploreClaim, ExploreContradiction, ExploreEntityRef, ExploreNeighbor, ExploreNeighborhood, ExploreProjection } from '../../kb/explorePanel';

const HEADER = `<h1 class="explore-title viz-signage">Explore</h1><p class="explore-sub viz-body">Walk your knowledge graph — start at an entity and follow its relationships. Read-only.</p>`;

/** The active neighborhood filters (EXPLORE-9). Empty sets = no constraint on that axis. */
interface ExploreFilters {
  kinds: Set<string>; // entity-kind filter (OR within the set)
  edges: Set<string>; // edge-type filter (predicate when present, else the direction descriptor)
  hideSpeculative: boolean; // the optional confidence threshold — drop low-confidence edges
}

/** Per-mount navigation + view state: the focus, the breadcrumb trail, the filters, expanded rows, and
 *  the lazily-fetched data caches (so filter/expand toggles repaint without an IPC round-trip). */
interface ExploreState {
  focus?: string;
  trail: { rel: string; name: string }[];
  filters: ExploreFilters;
  expanded: Set<string>; // neighbor rels currently expanded-in-place
  cache?: { nb: ExploreNeighborhood; entities: readonly ExploreEntityRef[]; stale?: boolean };
  subCache: Map<string, ExploreNeighborhood>; // neighbor rel → its fetched neighborhood (for expand)
  warmTimer?: number; // re-poll handle while the projection is warming (cleared on ready/unmount)
}

function freshFilters(): ExploreFilters {
  return { kinds: new Set(), edges: new Set(), hideSpeculative: false };
}

const DIRECTION_LABEL: Record<ExploreNeighbor['direction'], string> = { out: 'links to', in: 'linked from', both: 'mutual link' };
const UNKINDED = 'untyped'; // display label for a neighbor with no kind (legacy/partial data)

/** An edge's type for labelling + filtering (EXPLORE-5/9): its relationship predicate when Connect wrote
 *  one, otherwise the direction descriptor — so every edge has a coherent, filterable type. */
function edgeTypeOf(n: ExploreNeighbor): string {
  const p = n.predicate?.trim();
  return p && p.length > 0 ? p : DIRECTION_LABEL[n.direction];
}

/** An entity's kind for the kind filter — empty/missing kinds collapse to a single UNKINDED bucket. */
function kindKeyOf(n: ExploreNeighbor): string {
  return n.kind && n.kind.trim() ? n.kind : UNKINDED;
}

/** The active mount's `kb:navigate` listener (module-scoped so a re-mount, e.g. a vault switch, removes
 *  the prior one first — mirrors shell.ts's navHandler pattern; never leaks / drives a stale closure). */
let focusNavHandler: ((e: Event) => void) | null = null;

export async function mountExplore(container: HTMLElement): Promise<void> {
  const state: ExploreState = { trail: [], filters: freshFilters(), expanded: new Set(), subCache: new Map() };
  paintSkeleton(container, HEADER, 'rows');

  // #519 §2 — a deep-link INTO Explore already-mounted (e.g. the ⌘K search overlay's Enter): the shell's
  // own mount-once model (SHELL-8) means mountExplore only runs once, so a jump from another view can't
  // rely on a re-mount to pick up the new focus. Listen for `kb:navigate` directly (mirrors how the shell
  // itself listens) for subsequent jumps; `consumePendingFocus` below covers the race where THIS mount is
  // itself the synchronous side effect of the very navigateTo() call that carried the focus (nav.ts).
  if (focusNavHandler) document.removeEventListener(NAVIGATE_EVENT, focusNavHandler);
  focusNavHandler = (e: Event): void => {
    const detail = (e as CustomEvent<NavigateDetail>).detail;
    const focus = detail?.view === VIEW_EXPLORE ? consumePendingFocus(VIEW_EXPLORE) : undefined;
    if (focus) {
      state.trail = [];
      state.focus = focus;
      void load(container, state);
    }
  };
  document.addEventListener(NAVIGATE_EVENT, focusNavHandler);

  const initialFocus = consumePendingFocus(VIEW_EXPLORE);
  if (initialFocus) state.focus = initialFocus;
  await load(container, state);
}

/** Read the maintained graph projection (SPEC-0058 STATE-2) and paint. ONE read serves the whole view —
 *  the precomputed neighborhood, no live O(N²) walk. `status` is FIRST-CLASS: warming → a calm "warming
 *  the graph" face (NOT the alarming error face, retiring slice-0's timeout-inference), and we re-poll
 *  until it's built; error / a thrown IPC → honest degrade (#160). */
async function load(container: HTMLElement, state: ExploreState): Promise<void> {
  let env: ExploreProjection;
  try {
    env = await window.kbApi.exploreProjection(state.focus);
  } catch (err) {
    reportLoadFailure('explore', err); // un-swallow to the app-log, then honest error face
    renderLoadError(container, HEADER, () => void load(container, state));
    return;
  }
  if (env.status === 'error') {
    // A genuine compute failure (STATE-9/10) — honest error face + Recheck, never a stuck spinner (#160).
    renderLoadError(container, HEADER, () => void load(container, state));
    return;
  }
  if (env.status === 'warming' || env.data === null) {
    // Still building (cold/large vault) — calm warming face + auto-recheck, never the alarming "broken" face.
    // (`data === null` on a non-error status is also warming — the projection hasn't produced data yet.)
    renderWarming(container, HEADER, () => void load(container, state));
    clearTimeout(state.warmTimer);
    state.warmTimer = setTimeout(() => {
      if (container.isConnected) void load(container, state);
    }, 2000) as unknown as number;
    return;
  }
  clearTimeout(state.warmTimer);
  state.cache = { nb: env.data.neighborhood, entities: env.data.entities, stale: env.stale };
  paint(container, state);
}

/** #519 §3 — the top-bar context fillers, verbatim markup from the mock (design-prototypes/vellum-v3.html
 *  CTX.explore), with the first two chips' labels reflecting `state.filters` LIVE (the view already owns
 *  this state — the slot is a projection of it, not a second store). Read-only status chips (unlike
 *  Health/Agents' actionable ones) — informational, no click wiring. Called from `paint()` so it stays in
 *  sync every time the view repaints (filter change, re-center, expand). */
function topctxHtml(state: ExploreState): string {
  const kindCount = state.filters.kinds.size;
  const kindsLabel = kindCount === 0 ? 'All types' : `${kindCount} type${kindCount === 1 ? '' : 's'}`;
  const confidenceLabel = state.filters.hideSpeculative ? 'Confidence ≥ 0.6' : 'All confidence levels';
  return (
    `<span class="topchip">${navIcon('filter')} Filters</span>` +
    `<span class="topchip">${navIcon('category')} ${esc(kindsLabel)}</span>` +
    `<span class="topchip">${esc(confidenceLabel)}</span>`
  );
}

/** Render the current cached neighborhood as the UX v2 surface: a full-bleed radial graph (center +
 *  1-hop neighbors) on a drifting field, with a right rail carrying the focused entity's detail. No IPC. */
function paint(container: HTMLElement, state: ExploreState): void {
  setTopbarContext(topctxHtml(state));
  const cache = state.cache;
  if (!cache) return;
  const { nb, entities } = cache;
  if (!nb.found) {
    container.innerHTML = `<div class="explore viz-surface">${emptyState({
      title: 'No entities yet.',
      body: 'As you capture and the pipeline connects them, your knowledge graph appears here to explore.',
    })}</div>`;
    wire(container, state);
    return;
  }
  container.innerHTML = `<div class="explore explore-v2 viz-surface">
    <section class="exp-graph viz-grain">
      ${graphBar(entities, nb, state)}
      ${graphSvg(nb, state)}
      ${graphLegend(nb)}
    </section>
    <aside class="exp-rail">${railContent(nb)}</aside>
  </div>`;
  wire(container, state);
}

/** The floating control bar over the graph (UX v2): focus search + the filter chips, on `.viz-float`. */
function graphBar(entities: readonly ExploreEntityRef[], nb: ExploreNeighborhood, state: ExploreState): string {
  const opts = entities.map((e) => `<option value="${esc(e.name)}"></option>`).join('');
  return `<div class="exp-bar">
    <div class="exp-search viz-float">
      <label class="exp-search-label" for="exploreFocus" aria-label="Focus an entity">⌕</label>
      <input id="exploreFocus" class="explore-focus" type="text" list="exploreEntities" placeholder="Focus an entity…" autocomplete="off" />
      <datalist id="exploreEntities">${opts}</datalist>
    </div>
    ${trailBar(state)}
    ${filterBar(nb.neighbors, state.filters)}
  </div>`;
}

/** Radial graph layout (UX v2, SPEC-0039 EXPLORE-2): the focused entity is a STATIC center crystalline
 *  node (Principal: no breathing ring); its filtered 1-hop neighbors ring it, each a typed node on a
 *  gold edge whose weight reads confidence. Hover grows a node + lights its edge gold (CSS). Click =
 *  re-center. A DOM `<title>` per node keeps it keyboard-/SR-reachable (the node carries data-rel/name). */
function graphSvg(nb: ExploreNeighborhood, state: ExploreState): string {
  const all = applyFilters(nb.neighbors, state.filters);
  const shown = all.slice(0, 12); // bound the radial ring (DEFAULT_TOP_K) — never a hairball; "+N more" carries the rest
  const W = 760;
  const H = 560;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) * 0.34;
  const c = nb.center!;
  const edges: string[] = [];
  const nodes: string[] = [];
  shown.forEach((n, i) => {
    const ang = (i / shown.length) * 2 * Math.PI - Math.PI / 2;
    const x = +(cx + R * Math.cos(ang)).toFixed(1);
    const y = +(cy + R * Math.sin(ang)).toFixed(1);
    const spec = n.speculative;
    const w = (0.8 + n.confidence * 2.6).toFixed(1);
    edges.push(
      `<path class="exp-edge${spec ? ' exp-edge--spec' : ''}" data-rel="${esc(n.rel)}" d="M${cx} ${cy} L${x} ${y}" stroke-width="${w}" />`,
    );
    const kind = n.kind && n.kind.trim() ? n.kind : 'untyped';
    const label = n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name;
    const conf = `${spec ? '~' : ''}${n.confidence.toFixed(2)}`;
    nodes.push(
      `<g class="exp-node${spec ? ' exp-node--spec' : ''}" data-rel="${esc(n.rel)}" data-name="${esc(n.name)}" role="button" tabindex="0" aria-label="${esc(n.name)} — ${esc(kind)}, explore">
        <title>${esc(n.name)} (${esc(kind)})</title>
        <circle class="exp-node-dot" data-kind="${esc(kind)}" cx="${x}" cy="${y}" r="11" />
        <text class="exp-node-label" x="${x}" y="${(y + 26).toFixed(1)}" text-anchor="middle">${esc(label)}</text>
        <text class="exp-node-conf" x="${x}" y="${(y + 39).toFixed(1)}" text-anchor="middle">${esc(conf)}</text>
      </g>`,
    );
  });
  // Center node — static crystalline core (glow ring + gold ring + deep disc + lattice), no animation.
  const center = `<g class="exp-center" aria-label="${esc(c.name)} (focused)">
      <circle class="exp-center-glow" cx="${cx}" cy="${cy}" r="40" />
      <circle class="exp-center-disc" cx="${cx}" cy="${cy}" r="32" />
      <path class="exp-center-lattice" transform="translate(${cx} ${cy})" d="M0 -20 L20 0 L0 20 L-20 0 Z M0 -10 L10 0 L0 10 L-10 0 Z" />
      <circle class="exp-center-dot" cx="${cx}" cy="${cy}" r="3" />
      <text class="exp-center-name" x="${cx}" y="${(cy + 56).toFixed(1)}" text-anchor="middle">${esc(c.name)}</text>
    </g>`;
  const empty =
    shown.length === 0
      ? `<text class="exp-graph-empty" x="${cx}" y="${(cy + 92).toFixed(1)}" text-anchor="middle">No promoted relationships yet — Connect adds them as it finds them.</text>`
      : '';
  return `<svg class="exp-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Knowledge graph centered on ${esc(c.name)}">
    <g class="exp-edges">${edges.join('')}</g>
    <g class="exp-nodes">${nodes.join('')}${center}${empty}</g>
  </svg>`;
}

/** The graph legend (node-type key) + an overflow note, on a floating pill. */
function graphLegend(nb: ExploreNeighborhood): string {
  const more = nb.total > nb.shown ? `<span class="exp-legend-more">+${nb.total - nb.shown} more</span>` : '';
  return `<div class="exp-legend viz-float">
    <span><i class="exp-dot" data-kind="person"></i>Person</span>
    <span><i class="exp-dot" data-kind="concept"></i>Concept</span>
    <span><i class="exp-dot" data-kind="organization"></i>Org</span>
    <span><i class="exp-dot" data-kind="claim"></i>Claim</span>
    ${more}
  </div>`;
}

/** The right rail (UX v2): the focused entity's identity, tags, claims (with confidence bars), and the
 *  contested banner — Spectral voice head, the "leads back to reading" detail beside the graph. */
function railContent(nb: ExploreNeighborhood): string {
  const c = nb.center!;
  const tags = c.tags.length ? `<div class="explore-tags">${c.tags.map((t) => `<span class="explore-tag viz-chip">${esc(t)}</span>`).join('')}</div>` : '';
  const claims = nb.claims.length
    ? `<div class="rail-sec viz-voice">Claims</div><ul class="explore-claims">${nb.claims.map(renderClaim).join('')}</ul>`
    : `<p class="explore-noclaims viz-body">No claims recorded for this entity yet.</p>`;
  return `
    <div class="rail-head" data-rel="${esc(c.rel)}">
      <span class="rail-mark" aria-hidden="true">◈</span>
      <div>
        <h2 class="rail-name viz-voice">${esc(c.name)}</h2>
        <div class="rail-kind">${esc(c.kind)} · <span class="explore-conf viz-numeric">${c.confidence.toFixed(2)}</span></div>
      </div>
      ${contestedFlag(nb.contradictions)}
    </div>
    ${tags}
    <button type="button" class="explore-open viz-btn viz-btn--ghost viz-focusable" title="Open this entity's note in Obsidian">Open in Obsidian ↗</button>
    ${contestedBanner(nb.contradictions)}
    ${claims}
    <p class="explore-cite-note viz-body" role="status" aria-live="polite"></p>`;
}

/** Search-to-focus (EXPLORE-6): an entity-name input with a datalist of all entities for autocomplete. */
function trailBar(state: ExploreState): string {
  if (state.trail.length === 0) return '';
  const crumbs = state.trail
    .map((t, i) => `<button type="button" class="explore-crumb viz-signage viz-focusable" data-rel="${esc(t.rel)}" data-i="${i}">${esc(t.name)}</button>`)
    .join('<span class="explore-crumb-sep" aria-hidden="true">›</span>');
  return `<nav class="explore-trail" aria-label="Explore breadcrumb">${crumbs}<span class="explore-crumb-sep" aria-hidden="true">›</span><span class="explore-crumb explore-crumb--current viz-signage" aria-current="true">here</span></nav>`;
}

/** A node's kind as a tag-colored chip + its confidence (numeric). Shared by the center + neighbors. */
function contestedFlag(contradictions: readonly ExploreContradiction[]): string {
  if (contradictions.length === 0) return '';
  const n = contradictions.length;
  const tip = `Unresolved disagreement${n > 1 ? 's' : ''} on this entity — pending your review`;
  return `<span class="explore-contested-flag viz-chip" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="explore-contested-mark" aria-hidden="true">⚠</span> contested${n > 1 ? ` <span class="viz-numeric">${n}</span>` : ''}</span>`;
}

/** SPEC-0036 CONTRA-6/7 — the conflicting statement pairs, shown plainly above the claims so the reader
 *  sees BOTH sides (never one asserted). Read-only; resolution happens in the needs-you queue. */
function contestedBanner(contradictions: readonly ExploreContradiction[]): string {
  if (contradictions.length === 0) return '';
  const rows = contradictions
    .map(
      (x) =>
        `<li class="explore-contested-item viz-body"><span class="explore-contested-side">${esc(x.statements[0])}</span><span class="explore-contested-vs" aria-hidden="true">⟷</span><span class="explore-contested-side">${esc(x.statements[1])}</span></li>`,
    )
    .join('');
  return `
    <div class="explore-contested" role="note" aria-label="Contested facts">
      <span class="explore-contested-head viz-signage"><span class="explore-contested-mark" aria-hidden="true">⚠</span> Sources disagree</span>
      <ul class="explore-contested-list">${rows}</ul>
      <p class="explore-contested-note viz-body">Both are kept and attributed until you resolve this in your review queue.</p>
    </div>`;
}

/** Truncate a source title for the inline citation chip (full title stays in the tooltip/aria-label). */
function clipTitle(s: string): string {
  return s.length > 32 ? s.slice(0, 31) + '…' : s;
}

/**
 * WS-A (SPEC-0046) — render a claim with its statement's `[[Name]]` refs linkified (click → re-center)
 * and its **clickable cited sources** appended (click → openSourceRef). ENG-15/16: a claim with no/empty
 * citations renders cleanly (just the statement); a citation missing a `ref` is skipped; per-claim, so
 * one malformed claim never breaks its siblings.
 */
function renderClaim(cl: ExploreClaim): string {
  const cites = (cl.citations ?? []).filter((c) => c && typeof c.ref === 'string' && c.ref.length > 0);
  const citesHtml = cites.length
    ? ` <span class="explore-cites">${cites
        .map((c) => {
          const title = c.title || 'source';
          return `<button type="button" class="explore-cite viz-focusable" data-ref="${esc(c.ref)}" title="Open source: ${esc(title)}" aria-label="Open source ${esc(title)}"><span class="cite-mark" aria-hidden="true">↗</span> ${esc(clipTitle(title))}</button>`;
        })
        .join('')}</span>`
    : '';
  // SPEC-0036 CONTRA-6: a claim in an open/accepted contradiction wears a "disputed" badge — a non-color
  // signal (the ⚠ glyph + label) so recall never silently asserts a contested fact.
  const disputed = cl.contested
    ? ` <span class="explore-claim-disputed viz-chip" title="This claim is contested — sources disagree" aria-label="disputed — sources disagree"><span class="explore-contested-mark" aria-hidden="true">⚠</span> disputed</span>`
    : '';
  return `<li class="explore-claim viz-body${cl.contested ? ' explore-claim--disputed' : ''}"><span class="explore-claim-status viz-chip" data-status="${esc(cl.status)}">${esc(cl.status)}</span> ${linkifyStatement(cl.statement)} <span class="explore-conf viz-numeric">${cl.confidence.toFixed(2)}</span>${disputed}${citesHtml}</li>`;
}

/**
 * Linkify `[[Name]]` / `[[rel|Name]]` wikilinks in a claim statement into clickable re-center buttons
 * (the resolveProseWikilinks / CONNECT-13 discipline, in the view): the display name is whatever's
 * after a `|` (else the bare inner), and clicking focuses that name (the panel resolves it; an unknown
 * name lands gracefully). The surrounding text is escaped first, so the only HTML we emit is the button
 * around an already-escaped name — a malformed `[[` left in text is harmless (rendered as-is).
 */
function linkifyStatement(statement: string): string {
  return esc(statement).replace(/\[\[([^\]]+)\]\]/g, (whole, inner: string) => {
    const bar = inner.indexOf('|');
    const name = (bar === -1 ? inner : inner.slice(bar + 1)).trim();
    if (!name) return whole;
    return `<button type="button" class="explore-statement-link viz-focusable" data-name="${name}" title="Explore ${name}">${name}</button>`;
  });
}

/** Apply the active filters (EXPLORE-9) to the loaded neighborhood. Empty sets / off = no constraint. */
function applyFilters(neighbors: readonly ExploreNeighbor[], f: ExploreFilters): ExploreNeighbor[] {
  return neighbors.filter((n) => {
    if (f.hideSpeculative && n.speculative) return false;
    if (f.kinds.size > 0 && !f.kinds.has(kindKeyOf(n))) return false;
    if (f.edges.size > 0 && !f.edges.has(edgeTypeOf(n))) return false;
    return true;
  });
}

/** A toggle chip for a filter value (pressed → constraint active). Group + value ride on data attrs. */
function filterChip(group: string, value: string, label: string, pressed: boolean): string {
  return `<button type="button" class="explore-filter-chip viz-chip viz-focusable${pressed ? ' is-on' : ''}" data-group="${esc(group)}" data-value="${esc(value)}" aria-pressed="${pressed}">${esc(label)}</button>`;
}

/**
 * The filter bar (EXPLORE-9): chips for the distinct entity kinds and edge types present in the loaded
 * neighborhood, plus a "hide speculative" toggle. Options are drawn from the FULL loaded set so toggling
 * one never makes the others vanish. Rendered only when there's actually something to narrow (≥2
 * neighbors and a real choice on some axis) — a tiny neighborhood doesn't need a filter bar.
 */
function filterBar(neighbors: readonly ExploreNeighbor[], f: ExploreFilters): string {
  const kinds = [...new Set(neighbors.map(kindKeyOf))].sort((a, b) => a.localeCompare(b));
  const edges = [...new Set(neighbors.map(edgeTypeOf))].sort((a, b) => a.localeCompare(b));
  const anySpeculative = neighbors.some((n) => n.speculative);
  const hasChoice = kinds.length > 1 || edges.length > 1 || anySpeculative;
  if (neighbors.length < 2 || !hasChoice) return '';
  const groups: string[] = [];
  if (kinds.length > 1) {
    groups.push(
      `<div class="explore-filter-group"><span class="explore-filter-label viz-signage">Kind</span>${kinds.map((k) => filterChip('kind', k, k, f.kinds.has(k))).join('')}</div>`,
    );
  }
  if (edges.length > 1) {
    groups.push(
      `<div class="explore-filter-group"><span class="explore-filter-label viz-signage">Edge</span>${edges.map((e) => filterChip('edge', e, e, f.edges.has(e))).join('')}</div>`,
    );
  }
  if (anySpeculative) {
    groups.push(
      `<div class="explore-filter-group">${filterChip('spec', 'hide', 'Hide speculative', f.hideSpeculative)}</div>`,
    );
  }
  const active = f.kinds.size > 0 || f.edges.size > 0 || f.hideSpeculative;
  const clear = active ? `<button type="button" class="explore-filter-clear viz-focusable" title="Clear all filters">clear</button>` : '';
  return `<div class="explore-filters" role="group" aria-label="Filter relationships">${groups.join('')}${clear}</div>`;
}

/** One neighbor row (EXPLORE-5/7): direction glyph + relationship label, name, kind chip, confidence
 *  (speculative-aware), an expand-in-place toggle, and — when expanded — its own links nested inline. */
function wire(container: HTMLElement, state: ExploreState): void {
  const focusTo = (rel: string | undefined, name: string): void => {
    // Record the current center on the trail before moving (retrace, EXPLORE-6), then re-center.
    const headEl = container.querySelector<HTMLElement>('.rail-head');
    const curRel = headEl?.dataset.rel;
    const curName = container.querySelector('.rail-name')?.textContent ?? '';
    if (curRel && curName) state.trail.push({ rel: curRel, name: curName });
    state.focus = rel ?? name;
    resetViewState(state);
    void load(container, state);
  };

  // Search-to-focus: pick from the datalist or type a name + Enter.
  const search = container.querySelector<HTMLInputElement>('.explore-focus');
  const submitSearch = (): void => {
    const v = search?.value.trim();
    if (v) {
      state.trail = []; // a fresh search starts a new path
      state.focus = v;
      resetViewState(state);
      void load(container, state);
    }
  };
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitSearch();
  });
  search?.addEventListener('change', submitSearch); // datalist selection fires change

  // Re-center on a clicked graph node (EXPLORE-6 navigate) — keyboard-reachable (Enter/Space).
  // Hover/focus a node → light ITS incident edge gold (§3 hover-life signature): the edge shares the
  // node's data-rel, so we toggle `.exp-edge--hot` on the matching edge (they live in separate <g>s).
  for (const node of Array.from(container.querySelectorAll<SVGGElement>('.exp-node'))) {
    const rel = node.dataset.rel ?? '';
    const go = (): void => focusTo(node.dataset.rel, node.dataset.name ?? '');
    const edge = container.querySelector<SVGPathElement>(`.exp-edge[data-rel="${CSS.escape(rel)}"]`);
    const gild = (on: boolean): void => {
      edge?.classList.toggle('exp-edge--hot', on);
    };
    node.addEventListener('click', go);
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
    node.addEventListener('mouseenter', () => gild(true));
    node.addEventListener('mouseleave', () => gild(false));
    node.addEventListener('focus', () => gild(true));
    node.addEventListener('blur', () => gild(false));
  }

  // Filter chips (EXPLORE-9): toggle a value in its group, repaint from cache (no IPC round-trip).
  for (const chip of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-filter-chip'))) {
    chip.addEventListener('click', () => {
      toggleFilter(state, chip.dataset.group ?? '', chip.dataset.value ?? '');
      paint(container, state);
    });
  }
  for (const clr of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-filter-clear'))) {
    clr.addEventListener('click', () => {
      state.filters = freshFilters();
      paint(container, state);
    });
  }

  // Breadcrumb: jump back to a prior focus (truncates the trail to that point).
  for (const crumb of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-crumb[data-rel]'))) {
    crumb.addEventListener('click', () => {
      const i = Number(crumb.dataset.i);
      const target = state.trail[i];
      if (!target) return;
      state.trail = state.trail.slice(0, i);
      state.focus = target.rel;
      resetViewState(state);
      void load(container, state);
    });
  }

  // Open the focused entity's note in Obsidian (EXPLORE-4 click-through; reuses ASK-14 openCitation).
  const openBtn = container.querySelector<HTMLButtonElement>('.explore-open');
  const centerRel = container.querySelector<HTMLElement>('.rail-head')?.dataset.rel;
  openBtn?.addEventListener('click', () => {
    if (centerRel) void window.kbApi.openCitation(centerRel);
  });

  // WS-A: a claim's cited source → open it working-zone-aware (REVIEW-17 openSourceRef); a staging /
  // missing / failed open surfaces an inline note rather than a dead link.
  for (const cite of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-cite'))) {
    cite.addEventListener('click', () => void openSource(container, cite.dataset.ref));
  }

  // WS-A: a `[[Name]]` woven into a claim → re-center on that entity (resolved by name in the panel).
  for (const link of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-statement-link'))) {
    link.addEventListener('click', () => focusTo(undefined, link.dataset.name ?? ''));
  }
}

/** A focus change drops the per-neighborhood view state — filters + expansions are scoped to one center. */
function resetViewState(state: ExploreState): void {
  state.filters = freshFilters();
  state.expanded = new Set();
}

/** Toggle a value in/out of a multi-select filter set. */
function toggleInSet(set: Set<string>, value: string): void {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

/** Toggle a filter value in its group (kind/edge are multi-select sets; spec is a boolean). */
function toggleFilter(state: ExploreState, group: string, value: string): void {
  const f = state.filters;
  if (group === 'kind') toggleInSet(f.kinds, value);
  else if (group === 'edge') toggleInSet(f.edges, value);
  else if (group === 'spec') f.hideSpeculative = !f.hideSpeculative;
}

/**
 * Toggle a neighbor's expand-in-place (EXPLORE-7). Opening lazily fetches its neighborhood once (cached)
 * — a failed fetch degrades to an "unavailable" cache entry rather than throwing (the row stays usable).
 */
const CITE_STATUS: Record<string, string> = {
  staging: 'That source is still processing — it’ll be in your library shortly.',
  missing: 'That source isn’t in your library (it may have been removed).',
  'invalid-ref': 'That source link is invalid.',
  'no-vault': 'No active library — open one to view sources.',
  'open-failed': 'Couldn’t open that source.',
};

/**
 * Open a claim's cited source via the working-zone-aware seam (`openSourceRef` — REVIEW-17): on `main`
 * it opens in Obsidian; staging/missing/failed surface a calm inline note (never a dead link). Never
 * throws — a rejected IPC degrades to the note (ENG-16).
 */
async function openSource(container: HTMLElement, ref: string | undefined): Promise<void> {
  const slot = container.querySelector('.explore-cite-note');
  if (!ref) return;
  let note = '';
  try {
    const res = await window.kbApi.openSourceRef(ref);
    if (res.status !== 'opened') note = CITE_STATUS[res.status] ?? 'Couldn’t open that source.';
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (slot) slot.textContent = note; // cleared (empty) on a successful open
}
