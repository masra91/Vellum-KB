// Health view — "is my vault structurally clean?" (SPEC-0035 HEALTH passive dashboard, HEALTH-8;
// SPEC-0058 STATE-3/13 projection-backed read). A read-only, deterministic readout of structural health —
// orphans, dangling/dead links, sparse/thin (stub) entities — scanned with NO model calls (HEALTH-1). v1 is
// **passive**: it surfaces findings + click-through to the node; it does NOT fix (HEALTH-2/3/5 deferred).
//
// STATE-13 (design-from-the-screens-inward): the view draws everything from ONE projection read — the typed
// `HealthProjection` (KB-Design-Lead-2's render contract), severity baked in. Built to DL-2's "health glance":
// each dimension is an `.hrow` — a severity icon-**tile** `.hi` (#184: hue rides the TILE + the mono count
// `.hn`, the label stays `--viz-ink` for AA) + title + scholarly desc — over its (click-through) findings.
// The glance container is a material `.viz-card` (depth/grain from #453). Three states (STATE-9/10): `ready`
// renders the glance; `warming` a calm "still preparing…" (never the scary error); `unavailable` the honest
// "couldn't scan — recheck". Thin DOM over the typed IPC; the transform is node-tested in `kb/healthProjection`.
import { esc } from '../html';
import { renderLoadError, renderWarming, loadGraphWithWarming, reportLoadFailure, isWarming } from '../loadGuard';
import { setTopbarContext } from '../nav';
import { navIcon } from '../icons';
import { isDanglingFinding, type HealthProjection, type HealthDimension, type ProjectedHealthFinding, type HealthSeverity } from '../../kb/healthProjection';
import type { HealthFinding, DanglingLink } from '../../kb/healthPanel';
import type { HealthFindingClass } from '../../kb/healthFindingKey';
import type { ViewHandle } from '../viewLifecycle';

const HEADER = `<h1 class="health-title viz-voice">Health</h1><p class="health-sub viz-body">Structural lint of your knowledge graph — orphans, dead links, and thin pages. Scanned without AI; fix or dismiss each one inline.</p>`;

// #511: a debounced background-rescan handle, module-scoped so a burst of dismiss/remediate clicks
// shares ONE pending rescan instead of firing `healthReport()` (a full live-vault scan) once per click.
const RESCAN_DEBOUNCE_MS = 1200;
let rescanTimer: ReturnType<typeof setTimeout> | undefined;

export function mountHealth(container: HTMLElement): ViewHandle {
  container.innerHTML = `<div class="health viz-surface">${HEADER}<p class="health-scanning viz-body">Scanning…</p></div>`;
  wireTopctxRescan(container);
  // #510: re-scan on every activation (STATE-8 AC1) — Health has no live/push-eligible store yet
  // (`kb:healthReport` is still a per-read scan, not projection-backed; see the STATE-3 note above), so
  // switching back is the freshness signal, same as before this change just without the freeze.
  return {
    show: () => void render(container),
    hide: () => clearTimeout(rescanTimer), // #511: a pending debounced rescan shouldn't fire while hidden
  };
}

/**
 * #519 §3 — the "Re-scan" chip, verbatim from the mock (CTX.health). Actionable: it must not silently
 * duplicate state, so it calls the exact same `render(container)` the view's own load/retry paths call —
 * one source of truth, no second copy of the re-scan logic. `#topctx` is a stable, persistent shell
 * element (never destroyed across view switches, only its innerHTML changes), so ONE delegated listener
 * bound here at mount survives every later `setTopbarContext`/cache-restore of this chip's markup.
 */
function wireTopctxRescan(container: HTMLElement): void {
  setTopbarContext(`<span class="topchip topchip--action" data-topctx-action="health-rescan">${navIcon('refresh')} Re-scan</span>`);
  document.querySelector('#topctx')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-topctx-action="health-rescan"]')) void render(container);
  });
}

async function render(container: HTMLElement): Promise<void> {
  let projection: HealthProjection;
  try {
    // SPEC-0058 slice-0 transport: bound the read, but show a calm WARMING face (not a frozen "Scanning…")
    // once it's slow — a generous bound so a cold/large-vault scan completes instead of false-tripping the
    // old 8s deadline into an error face (the packaged Health P0).
    projection = await loadGraphWithWarming(
      () => window.kbApi.healthReport(),
      () => renderWarming(container, HEADER, () => void render(container)),
    );
  } catch (err) {
    // Un-swallow to the app-log (was a bare `catch {}`), then route honestly: a timeout = still WARMING
    // (calm, the scan just needs longer), any real throw = retryable error face.
    reportLoadFailure('health', err);
    if (isWarming(err)) renderWarming(container, HEADER, () => void render(container));
    else renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  // STATE-9/10: honor the projection's own status too (forward-compat with DEV-5's maintained projection,
  // which can report warming/unavailable directly) — the same calm/error faces, never a blank panel.
  if (projection.status === 'warming') {
    renderWarming(container, HEADER, () => void render(container));
    return;
  }
  if (projection.status === 'unavailable') {
    renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  container.innerHTML = `<div class="health viz-surface">${HEADER}<div class="health-glance viz-card">${summary(projection)}${rows(projection)}</div>${footnote()}</div>`;
  wire(container);
}

/** Pluralize a noun by count (numeric face applied by the caller). */
function plural(n: number, singular: string, p = `${singular}s`): string {
  return n === 1 ? singular : p;
}

/** A human "as of <time>" stamp from the projection's ISO build time (mono); '' when absent (degrade-safe). */
function asOf(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return ` <span class="health-asof viz-numeric">· as of ${esc(d.toLocaleString())}</span>`;
}

/** The glance summary line: calm "structurally sound" when clean, else the honest issue count — plus the
 *  scanned-entities readout + the build stamp. `overall:ok` is never a blank panel (a settled affirmation). */
function summary(p: HealthProjection): string {
  const reading =
    p.overall === 'ok'
      ? `<span class="health-tick viz-state-settled" aria-hidden="true">✓</span> Structurally sound`
      : `<span class="health-count viz-numeric viz-state-blocked">${p.totalIssues}</span> structural ${plural(p.totalIssues, 'issue')}`;
  return `<div class="health-summary" role="status">${reading} <span class="health-scanned">· scanned <span class="viz-numeric">${p.scanned}</span> ${plural(p.scanned, 'entity', 'entities')}</span>${asOf(p.generatedAt)}</div>`;
}

/** Severity → DL-2's tile class (`.hi.ok/.warn/.bad`) + an aria-hidden glyph fallback (#184: the hue lives
 *  ONLY on the tile via the class, DL-2's CSS maps it to the sprout/brass/oxide token; the glyph is the
 *  reduced-motion / no-CSS fallback). */
const TILE: Record<HealthSeverity, { cls: string; glyph: string }> = {
  ok: { cls: 'ok', glyph: '✓' },
  warn: { cls: 'warn', glyph: '⚠' },
  bad: { cls: 'bad', glyph: '✕' },
};

/** A name that's safe to render even when missing — a muted "(untitled)" fallback (ENG-15/16). */
function nameCell(name: string): string {
  return name && name.trim() ? `<span class="health-finding-name viz-body">${esc(name)}</span>` : `<span class="health-finding-name health-untitled viz-body">(untitled)</span>`;
}

/** VUX-16 — the secondary action zone on a finding row: an optional non-destructive APPLY action
 *  (relink / find-homes; slate, with a quiet line-glyph) + the always-present DISMISS (✕). These are
 *  MAINTENANCE actions, never decisions — no ember anywhere (DL-1). `nodeRel` is what the apply IPC
 *  operates on; `findingKey`/`kind` is what dismiss persists. A row-local status slot carries the
 *  working (loom) / inline-oxide-error states the handlers toggle. */
function actions(opts: { findingKey: string; kind: HealthFindingClass; apply?: { action: 'relink' | 'find-homes'; nodeRel: string; label: string; glyph: string } }): string {
  const apply = opts.apply
    ? `<button type="button" class="health-act health-act--${opts.apply.action} viz-focusable" data-action="${opts.apply.action}" data-rel="${esc(opts.apply.nodeRel)}"><span class="health-act-gl" aria-hidden="true">${opts.apply.glyph}</span>${esc(opts.apply.label)}</button>`
    : '';
  return `<span class="health-actions">
            <span class="health-row-status" role="status" aria-live="polite"></span>
            ${apply}
            <button type="button" class="health-dismiss viz-focusable" data-key="${esc(opts.findingKey)}" data-kind="${esc(opts.kind)}" title="Dismiss — hide this finding (restorable later)" aria-label="Dismiss this finding">✕</button>
          </span>`;
}

/** An entity finding row (orphan / thin): clickable name → open the node + the specific defect (muted),
 *  then the secondary action zone. `find-homes` on an orphan; thin gets dismiss-only (enrich is held). */
function findingRow(f: ProjectedHealthFinding & HealthFinding, cls: 'orphan' | 'thin', defect: string): string {
  const apply = cls === 'orphan' ? { action: 'find-homes' as const, nodeRel: f.rel ?? '', label: 'Find homes', glyph: '⊕' } : undefined;
  return `
        <li class="health-row" data-finding-key="${esc(f.key)}">
          <button type="button" class="health-open viz-no-chrome viz-focusable" data-rel="${esc(f.rel ?? '')}" title="Open ${esc(f.name) || '(untitled)'}">
            ${nameCell(f.name)}
            <span class="health-kind viz-chip">${esc(f.kind ?? '')}</span>
            <span class="health-defect viz-body">${esc(defect)}</span>
          </button>
          ${actions({ findingKey: f.key, kind: cls, apply })}
        </li>`;
}

/** A dead-link row: source entity (openable) → the unresolved target, then Relink (re-resolve the source
 *  node's links → the dead target drops) + dismiss. */
function danglingRow(d: ProjectedHealthFinding & DanglingLink): string {
  return `
        <li class="health-row" data-finding-key="${esc(d.key)}">
          <button type="button" class="health-open viz-no-chrome viz-focusable" data-rel="${esc(d.from ?? '')}" title="Open ${esc(d.fromName) || '(untitled)'}">
            ${nameCell(d.fromName)}
            <span class="health-defect viz-body">→ ${esc(d.target ?? '')} (no node)</span>
          </button>
          ${actions({ findingKey: d.key, kind: 'dangling', apply: { action: 'relink', nodeRel: d.from ?? '', label: 'Relink', glyph: '↻' } })}
        </li>`;
}

/** Render one finding — discriminating a dead-link from an entity finding (ENG-15/16: a malformed entry is
 *  degraded per-item via the nameCell fallback + `?? ''` guards, so one bad finding can't crash the glance). */
function renderFinding(key: HealthDimension['key'], f: ProjectedHealthFinding): string {
  if (key === 'dangling' || isDanglingFinding(f)) return danglingRow(f as ProjectedHealthFinding & DanglingLink);
  const ef = f as ProjectedHealthFinding & HealthFinding;
  return key === 'thin' ? findingRow(ef, 'thin', `stub · ${ef.chars ?? 0} chars`) : findingRow(ef, 'orphan', '0 in · 0 out');
}

/** One dimension: DL-2's `.hrow` glance row (severity tile `.hi` + `.ht` title/desc + mono `.hn` count),
 *  over its (capped) click-through findings. A clean dimension shows the ok tile + desc only (never a
 *  blank/odd empty list). The `.hrow` matches the prototype exactly; the findings list is a sibling. */
function dimensionRow(d: HealthDimension): string {
  const tile = TILE[d.severity] ?? TILE.ok;
  const list =
    d.count > 0
      ? `<ul class="health-row-list">${d.findings.map((f) => renderFinding(d.key, f)).join('')}</ul>${d.count > d.findings.length ? `<p class="health-more viz-body">+${d.count - d.findings.length} more not shown.</p>` : ''}`
      : '';
  return `
    <section class="health-dimension" data-key="${esc(d.key)}" data-severity="${esc(d.severity)}">
      <div class="hrow">
        <span class="hi ${tile.cls}" aria-hidden="true">${tile.glyph}</span>
        <span class="ht">
          <b>${esc(d.label)}</b>
          <span>${esc(d.desc)}</span>
        </span>
        <span class="hn viz-numeric">${d.count}</span>
      </div>
      ${list}
    </section>`;
}

/** The three dimension rows in display order — always all three (each with findings or a clean tile). */
function rows(p: HealthProjection): string {
  return p.dimensions.map(dimensionRow).join('');
}

/** Honest about what's wired: relink / find-homes / dismiss act now; merge + content repair are later. */
function footnote(): string {
  return `<p class="health-footnote viz-body">Relink, find homes, and dismiss apply directly. Merging duplicates and content repair land in a later slice.</p>`;
}

/** Set a row's status slot to a calm WORKING (loom) state and disable its action buttons (DL-1: loom =
 *  "it's humming"). Returns a restore fn that re-enables them (used on the error path). */
function setRowWorking(row: HTMLElement, label: string): () => void {
  const status = row.querySelector<HTMLElement>('.health-row-status');
  const btns = Array.from(row.querySelectorAll<HTMLButtonElement>('.health-act, .health-dismiss'));
  // #520 §10: disable-only surfaces get the same .is-busy visual on top of the existing disable — a
  // within-100ms visible state on the control itself, not just the row's status slot.
  for (const b of btns) {
    b.disabled = true;
    b.classList.add('is-busy');
  }
  if (status) status.innerHTML = `<span class="vmark loom" aria-hidden="true"></span> ${esc(label)}`;
  return () => {
    for (const b of btns) {
      b.disabled = false;
      b.classList.remove('is-busy');
    }
    if (status) status.textContent = '';
  };
}

/** Show a calm inline (oxide) error on the row + re-enable (retryable) — never a banner (DL-1). */
function setRowError(restore: () => void, row: HTMLElement, message: string): void {
  restore();
  const status = row.querySelector<HTMLElement>('.health-row-status');
  if (status) status.innerHTML = `<span class="health-row-error viz-body">${esc(message)}</span>`;
}

/** Minimal CSS.escape fallback (finding keys are simple derived strings; belt-and-suspenders — mirrors
 *  reviewsView.ts's `cssEscape` for the same reason: a data-attribute selector must never break on an
 *  unexpected character in agent/derived data). */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/**
 * #511: remove ONE row immediately on a successful dismiss/remediate — no full-list re-scan+repaint (the
 * old behavior reset scroll position and rebuilt every row for a one-row change). Mirrors reviewsView.ts's
 * `optimisticallyRemove`: fade the row out, remove it from the DOM once the transition ends (or a timeout
 * fallback for reduced-motion), and drop the whole dimension section to its clean/empty state if that was
 * the last finding in it. The severity tile + count are NOT recomputed client-side (that needs the same
 * rules `healthProjection.ts` already applies) — `scheduleBackgroundRescan` catches them up shortly after.
 */
function optimisticallyRemoveRow(container: HTMLElement, findingKey: string): void {
  const row = container.querySelector<HTMLElement>(`.health-row[data-finding-key="${cssEscape(findingKey)}"]`);
  if (!row) return;
  const dimension = row.closest<HTMLElement>('.health-dimension');
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    row.remove();
    // If that was the last visible row in its dimension's list, drop the (now-empty) `<ul>` too — an
    // empty `.health-row-list` would otherwise read as a structural glitch, not "all clear".
    if (dimension && !dimension.querySelector('.health-row')) dimension.querySelector('.health-row-list')?.remove();
  };
  row.classList.add('is-leaving');
  row.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 340); // matches --dur-settle; reduced-motion fallback
}

/** #511: coalesce a burst of dismiss/remediate successes into ONE `healthReport()` re-scan (the AC's
 *  "≤1 healthReport call per burst of N dismissals") — each optimistic removal already updated the row
 *  the Principal is looking at; this background rescan just reconciles the tile severities/counts (and
 *  catches anything the optimistic remove got wrong) once the burst goes quiet, not once per click. */
function scheduleBackgroundRescan(container: HTMLElement): void {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => void render(container), RESCAN_DEBOUNCE_MS);
}

function wire(container: HTMLElement): void {
  // Click-through: open the node in Obsidian (HEALTH leads back to reading; reuses ASK-14 openCitation).
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.health-open'))) {
    btn.addEventListener('click', () => {
      const rel = btn.dataset.rel;
      if (rel) void window.kbApi.openCitation(rel);
    });
  }
  // VUX-16 APPLY (relink / find-homes): non-destructive, applies directly. Working (loom) → on a REAL
  // change (res.changed — #511: an idempotent no-op must NOT optimistically hide a still-open finding)
  // the row is removed immediately + a debounced rescan reconciles the tile/count; on error, inline
  // oxide, retryable.
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.health-act'))) {
    btn.addEventListener('click', () => {
      const row = btn.closest<HTMLElement>('.health-row');
      const action = btn.dataset.action;
      const nodeRel = btn.dataset.rel ?? '';
      const findingKey = row?.dataset.findingKey ?? '';
      if (!row || (action !== 'relink' && action !== 'find-homes')) return;
      const restore = setRowWorking(row, action === 'relink' ? 'Relinking…' : 'Finding homes…');
      void window.kbApi
        .healthRemediate({ action, nodeRel })
        .then((res) => {
          if (!res?.ok) {
            setRowError(restore, row, res?.message || 'Couldn’t apply — try again.');
            return;
          }
          if (res.changed) optimisticallyRemoveRow(container, findingKey);
          else restore(); // idempotent no-op — nothing to fix, leave the row exactly as it was
          scheduleBackgroundRescan(container);
        })
        .catch(() => setRowError(restore, row, 'Couldn’t apply — try again.'));
    });
  }
  // VUX-16 DISMISS (✕): immediate, non-destructive + restorable (DL-1 / #496 ruling — no confirm). #511:
  // the row is removed optimistically the instant the backend confirms — dismiss is unconditional (there's
  // no "no-op" case), so unlike apply it removes on every `ok`. A debounced rescan reconciles the tile.
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.health-dismiss'))) {
    btn.addEventListener('click', () => {
      const row = btn.closest<HTMLElement>('.health-row');
      const findingKey = btn.dataset.key ?? '';
      const kind = btn.dataset.kind ?? '';
      if (!row || !findingKey) return;
      const restore = setRowWorking(row, 'Dismissing…');
      void window.kbApi
        .dismissHealthFinding({ findingKey, kind })
        .then((res) => {
          if (res?.ok) {
            optimisticallyRemoveRow(container, findingKey);
            scheduleBackgroundRescan(container);
          } else setRowError(restore, row, res?.message || 'Couldn’t dismiss — try again.');
        })
        .catch(() => setRowError(restore, row, 'Couldn’t dismiss — try again.'));
    });
  }
}
