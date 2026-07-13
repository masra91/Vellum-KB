// Agents view (SPEC-0027 PANEL-3 · SPEC-0060 VUX-1) — the Librarians section of the Agents hub: the
// built-in librarian agents that run your pipeline, with live status + their model. v1 is **observe-only**
// (safe knobs / authoring deferred, PANEL §6) — the one interactive knob is the per-agent model picker
// (SPEC-0048). Thin DOM over the typed IPC (`listAgents`); the catalog + live status live in the main
// process. PANEL-9: a light poll keeps running/idle status fresh (updated in place to avoid flicker); it
// stops when the view is detached. Degrades to a friendly message when no KB / IPC fails (PANEL-9).
//
// v3: each librarian is a `.ag-card` (avatar · name/role · state pill) on the warm-vellum tokens; a live
// agent flies the LOOM mark (continuous work), an idle one a calm dot. The model is a quiet per-card
// "Advanced" disclosure (rarely needed). NO ember — agent activity is not a decision (sprout=active,
// slate=interactive). Status-first: the live `status` field drives the pill, no render-path vault scan.
import { esc } from '../html';
import { withTimeout, renderLoadError, paintSkeleton } from '../loadGuard';
import { createVisibilityPoll, type VisibilityPoll } from '../visibilityPoll';
import { drillChevronHtml, wireDrillIn, pastRunsPlaceholderHtml, detailRowHtml } from './agentDrillIn';
import type { ViewHandle } from '../viewLifecycle';
import type { AgentView, ModelCatalogView } from '../../kb/types';

// Mounted as the **Librarians** section of the Agents hub (SPEC-0053 WS-E) — the hub owns the group
// header/naming, so this section renders the librarian grid (the global default-model control above it).
export function mountAgents(container: HTMLElement): ViewHandle {
  paintSkeleton(container, '', 'cards');
  wireDrillIn(container); // VUX-17: delegated on the container (survives re-render) — wire once, not per-render.
  let poll: VisibilityPoll | null = null;
  // #509 fixed the wrong-element visibility bug (this container is the Librarians SECTION nested inside
  // the Agents hub, not the shell's outer `.view` — `createVisibilityPoll`'s ancestor-aware check handles
  // that). #510 layers the explicit shell-driven lifecycle on top: `hide()` fully `stop()`s the poll (not
  // just self-gating) so it matches every other view's contract, dispatched via the Agents-hub's own
  // aggregated handle.
  return {
    show: () => {
      void render(container); // full refresh (the catalog + status) on every activation
      if (poll == null) poll = createVisibilityPoll(container, 5000, () => refreshStatus(container));
    },
    hide: () => {
      poll?.stop();
      poll = null;
    },
  };
}

async function render(container: HTMLElement): Promise<void> {
  // #512 PERF-R7: listAgents/getModelCatalog are mutually independent (neither's input depends on the
  // other's output) but used to run sequentially anyway — the issue's own "worst-case 16s Loading…"
  // came from summing two 8s-bounded reads instead of overlapping them. Both are kicked off (and so
  // BOTH in flight) here, before either is awaited; each keeps its OWN error handling below, unchanged.
  const agentsPromise = withTimeout(window.kbApi.listAgents());
  // SPEC-0048: the model picker's data — best-effort, isolated (incl. against a SYNCHRONOUS throw from
  // the call itself, e.g. an older client without the IPC) so a probe miss never blocks the agent list;
  // the control just omits when absent (ENG-15/16). Wrapped in its own async IIFE (not the block below's
  // try/catch) precisely so this isolation holds even though it now starts concurrently with agentsPromise.
  const catalogPromise = (async (): Promise<ModelCatalogView | null> => {
    try {
      return await withTimeout(window.kbApi.getModelCatalog());
    } catch {
      return null;
    }
  })();

  let agents: AgentView[];
  try {
    // #145: bound the wait so a hung `listAgents` shows a retryable error, never an infinite spinner.
    agents = await agentsPromise;
  } catch {
    renderLoadError(container, '', () => void render(container));
    return;
  }
  const catalog = await catalogPromise;
  if (agents.length === 0) {
    container.innerHTML = `<p class="ag-empty viz-body">No librarians to show — open a library.</p>`;
    return;
  }
  container.innerHTML = `${modelControlHtml(catalog)}<div class="ag-grid">${agents.map((a) => agentCard(a, catalog)).join('')}</div>`;
  wireModelPicker(container);
  wireAgentPickers(container);
}

/** SPEC-0048 — the global "Default model" picker (the MUST): a styled native `<select>` over the live
 *  CLI catalog + a quiet "runs as: ‹resolved›" caption + a GOLD note when the persisted pick is stale
 *  (no longer in the catalog). Null-tolerant (ENG-15/16): a missing/empty catalog degrades to a
 *  resolved-only readout (no dropdown) rather than throwing. */
function modelControlHtml(catalog: ModelCatalogView | null): string {
  if (!catalog) return ''; // no catalog data → omit the control (the agent cards still show the model)
  const accepted = Array.isArray(catalog.accepted) ? catalog.accepted : [];
  const configured = catalog.configured ?? '';
  const resolved = catalog.resolved || '—';
  // The CLI couldn't be probed → can't offer a fresh list; show the resolved readout only.
  if (accepted.length === 0) {
    return `<div class="ag-modelbar"><span class="model-label">Default model</span>` +
      `<p class="model-runs">runs as: <span class="path">${esc(resolved)}</span></p></div>`;
  }
  const options = [`<option value=""${configured ? '' : ' selected'}>Auto (in-app default)</option>`]
    .concat(accepted.map((m) => `<option value="${esc(m)}"${m === configured ? ' selected' : ''}>${esc(m)}</option>`))
    .join('');
  // #184 a11y: the note text reads AA in --ink; the gold needs-you hue rides the aria-hidden ◆ mark
  // (.model-stale-mark), not the label — never oxide (this is a caution, not an error).
  const stale = catalog.staleConfigured
    ? `<p class="model-stale" role="status"><span class="model-stale-mark" aria-hidden="true">◆</span>${esc(configured)} isn't available on this CLI — running ${esc(resolved)}.</p>`
    : '';
  return `<div class="ag-modelbar">
    <label class="model-label" for="model-default">Default model</label>
    <select id="model-default" class="viz-select model-select">${options}</select>
    <p class="model-runs">runs as: <span class="path">${esc(resolved)}</span></p>
    ${stale}
  </div>`;
}

/** Wire the global picker: on change, persist via `setModel` (validated server-side) and update the
 *  "runs as" caption + clear the stale note in place. Re-renders on a rejected pick. */
function wireModelPicker(container: HTMLElement): void {
  const select = container.querySelector<HTMLSelectElement>('#model-default');
  if (!select) return;
  select.addEventListener('change', () => {
    const id = select.value; // '' = clear the override (Auto)
    select.disabled = true;
    select.classList.add('is-busy'); // #520 §10
    void window.kbApi
      .setModel(id.length > 0 ? id : null)
      .then((res) => {
        const runs = container.querySelector<HTMLElement>('.ag-modelbar .model-runs .path');
        if (runs) runs.textContent = res.resolved;
        if (res.ok) container.querySelector('.model-stale')?.remove();
      })
      .catch((): void => {
        void render(container); // IPC failure → reload to a known state
      })
      .finally(() => {
        select.disabled = false;
        select.classList.remove('is-busy');
      });
  });
}

/** SPEC-0048 — wire the per-agent pickers: on change, persist via `setAgentModel(key, id)` (validated
 *  server-side) and update THAT agent's "runs as" caption in place. `''` clears the override. */
function wireAgentPickers(container: HTMLElement): void {
  for (const select of Array.from(container.querySelectorAll<HTMLSelectElement>('.agent-model-select'))) {
    select.addEventListener('change', () => {
      const key = select.dataset.agent ?? '';
      const id = select.value; // '' = clear → use the global default
      if (!key) return;
      select.disabled = true;
      select.classList.add('is-busy'); // #520 §10
      void window.kbApi
        .setAgentModel(key, id.length > 0 ? id : null)
        .then((res) => {
          const runs = container.querySelector<HTMLElement>(`.ag-card[data-key="${key}"] .agent-model-runs .path`);
          if (runs) runs.textContent = res.resolved;
        })
        .catch((): void => {
          void render(container);
        })
        .finally(() => {
          select.disabled = false;
          select.classList.remove('is-busy');
        });
    });
  }
}

/** A librarian as a v3 card: monogram avatar · name + role · live state pill · the model disclosure. */
function agentCard(a: AgentView, catalog: ModelCatalogView | null): string {
  const monogram = esc((a.label.trim()[0] ?? '·').toUpperCase());
  return `
    <article class="ag-card" data-key="${esc(a.key)}">
      <div class="ag-chead">
        <div class="ag-av lib" aria-hidden="true">${monogram}</div>
        <div class="ag-idblock">
          <div class="ag-name">${esc(a.label)}</div>
          <div class="ag-kind">${esc(a.role)}</div>
        </div>
        ${statePill(a.status)}
        ${drillChevronHtml(a.label)}
      </div>
      <div class="ag-foot">
        <span class="ag-last"><span class="path">${esc(a.instructions)}</span></span>
      </div>
      ${modelDisclosure(a, catalog)}
      ${agentDetailHtml(a)}
    </article>`;
}

/** VUX-17 detail panel — identity + current config, all from AgentView's existing fields (nothing
 *  fabricated). Librarians have the thinnest data of the three hub sections; everything here already
 *  shows on the card face too — the drill-in exists for interaction CONSISTENCY across Librarians/
 *  Schedules/Researchers (the ratified design decision), not because this item type hides anything. */
function agentDetailHtml(a: AgentView): string {
  return `<div class="ag-detail" hidden>
    <div class="ag-detail-rows">
      ${detailRowHtml('Role', a.role)}
      ${detailRowHtml('Status', a.status === 'running' ? 'Running' : 'Idle')}
      ${detailRowHtml('Model', a.model)}
      ${detailRowHtml('Instructions', a.instructions)}
    </div>
    ${pastRunsPlaceholderHtml()}
  </div>`;
}

/** The live state pill (status-first, PANEL-9): running flies the continuous LOOM mark; idle is a calm
 *  dot. Two states only — that's all `AgentView.status` carries; nothing invented. NO ember. */
function statePill(status: AgentView['status']): string {
  if (status === 'running') {
    return `<span class="ag-state run"><span class="vmark loom" aria-hidden="true"></span> Running</span>`;
  }
  return `<span class="ag-state on"><span class="dot" aria-hidden="true"></span> Idle</span>`;
}

/** The per-agent model — a quiet "Advanced" disclosure (rarely needed; PANEL is observe-first). Holds the
 *  SPEC-0048 picker over the live catalog, or the plain resolved-model text when deterministic / no
 *  catalog (ENG-15/16). */
function modelDisclosure(a: AgentView, catalog: ModelCatalogView | null): string {
  return `<details class="ag-adv">
    <summary><span class="chev" aria-hidden="true">›</span> Model <span class="sub">${esc(a.model)}</span></summary>
    <div class="ag-adv-body">${agentModelCell(a, catalog)}</div>
  </details>`;
}

/** SPEC-0048 — the per-agent Model cell: a `.viz-select` over the live catalog (first option "Use
 *  default (‹global›)") + a "runs as: ‹resolved›" caption. ENG-15/16 degradation: a deterministic agent,
 *  or a missing/empty catalog, falls back to the plain resolved-model text — never a broken control. */
function agentModelCell(a: AgentView, catalog: ModelCatalogView | null): string {
  const accepted = catalog && Array.isArray(catalog.accepted) ? catalog.accepted : [];
  if (a.model === 'deterministic' || accepted.length === 0) return `<span class="agent-model-text">${esc(a.model)}</span>`;
  const configured = a.configuredModel ?? '';
  const options = [`<option value=""${configured ? '' : ' selected'}>Use default (${esc(catalog?.resolved ?? '—')})</option>`]
    .concat(accepted.map((m) => `<option value="${esc(m)}"${m === configured ? ' selected' : ''}>${esc(m)}</option>`))
    .join('');
  return `<select class="viz-select agent-model-select" data-agent="${esc(a.key)}" aria-label="Model for ${esc(a.label)}">${options}</select>` +
    `<span class="model-runs agent-model-runs">runs as: <span class="path">${esc(a.model)}</span></span>`;
}

/** PANEL-9: refresh only the state pills in place (no full re-render → no flicker, picker focus kept). */
async function refreshStatus(container: HTMLElement): Promise<void> {
  let agents: AgentView[];
  try {
    agents = await window.kbApi.listAgents();
  } catch {
    return; // leave the last-known status
  }
  for (const a of agents) {
    const el = container.querySelector<HTMLElement>(`.ag-card[data-key="${a.key}"] .ag-state`);
    if (el) el.outerHTML = statePill(a.status);
  }
}
