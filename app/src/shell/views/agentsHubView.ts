// Agents hub (SPEC-0053 AGENTSIA / "WS-E") — one "Agents" surface that makes the three previously
// confusable Manage views legible by framing them by DIRECTION (AGENTSIA-1/2/3):
//
//   • Librarians — work *inside* your KB (the pipeline workers; built-in → disable-only), with their
//     Schedules (recurring librarian work, formerly "Jobs") nested underneath as *when these run*.
//   • Researchers — reach *outside* your KB (egress-gated; user-added → removable).
//
// This is IA + naming + composition only — **no engine change** (AGENTSIA-5). Each group body is the
// existing view mounted into a sub-container, so every behavior, poll, and existing test stays intact;
// the hub just owns the group headers + inward/outward descriptors + the built-in/user-added framing.
import { mountAgents } from './agentsView';
import { mountJobs } from './jobsView';
import { mountResearchers } from './researchersView';
import { setTopbarContext } from '../nav';
import { navIcon } from '../icons';
import type { ViewHandle } from '../viewLifecycle';

export function mountAgentsHub(container: HTMLElement): ViewHandle {
  // v3 (SPEC-0060 VUX-1): the hub frame on the warm-vellum language — a calm top head + headed sections.
  // The continuous LOOM signature lives on each live librarian/researcher card (honest, per-agent), not a
  // synthetic hub pulse (that would need a render-path status aggregate). IA-lock: the three sections
  // (Librarians + nested Schedules + Researchers) stay folded into this ONE Agents surface (WS-E).
  container.innerHTML = `
    <div class="agents-hub">
      <header class="ag-top">
        <h1>Agents</h1>
        <p>Everything that works on your knowledge — grouped by where it reaches.</p>
      </header>

      <section class="ag-sec" aria-labelledby="agents-grp-librarians">
        <div class="ag-sechead">
          <h2 id="agents-grp-librarians"><span class="ti" aria-hidden="true">↻</span> Librarians <span class="ct">built-in</span></h2>
          <span class="hint">Work inside your library — pause them, not remove them.</span>
        </div>
        <div class="agents-section" data-section="librarians"></div>
        <div class="ag-subsec">
          <div class="ag-sechead sub">
            <h3>Schedules</h3>
            <span class="hint">When recurring librarian work runs — e.g. Reflect rumination.</span>
          </div>
          <div class="agents-section" data-section="schedules"></div>
        </div>
      </section>

      <section class="ag-sec" aria-labelledby="agents-grp-researchers">
        <div class="ag-sechead">
          <h2 id="agents-grp-researchers"><span class="ti" aria-hidden="true">→</span> Researchers</h2>
          <span class="hint">Reach outside your library — egress-gated; you add and remove these.</span>
        </div>
        <div class="agents-section" data-section="researchers"></div>
      </section>
    </div>`;

  const sec = (name: string): HTMLElement => container.querySelector<HTMLElement>(`.agents-section[data-section="${name}"]`)!;
  // Mount each existing view into its group sub-container (Schedules nested under Librarians). Each owns
  // its own load/poll/teardown + #145/#160 guards, so normal load failures degrade in place. This outer
  // catch is the catastrophic backstop: if a sub-view ever threw PAST its own guard it'd otherwise leave
  // a stuck "Loading…" — instead we paint a calm per-section fallback (DL-2 hardening), isolated to that
  // section so the others (and the hub framing) still render.
  const mountSection = (name: string, mount: (c: HTMLElement) => ViewHandle): ViewHandle | null => {
    try {
      return mount(sec(name));
    } catch {
      sec(name).innerHTML = `<p class="agents-section-error viz-body">Couldn’t load this section — reopen Agents to retry.</p>`;
      return null;
    }
  };
  const librarians = mountSection('librarians', mountAgents);
  const schedules = mountSection('schedules', mountJobs);
  const researchers = mountSection('researchers', mountResearchers);
  wireTopctxAddResearcher(container);
  // #510: the hub's own show()/hide() fan out to whichever sub-sections actually mounted (a failed
  // section's null handle is simply skipped) — so the shell driving ONE Agents view id correctly starts/
  // stops all three sections' live behavior together, including agentsView's poll (fixing the wrong-
  // element visibility bug: hide() now genuinely stops it instead of a self-check that never engaged).
  return {
    show: () => {
      librarians?.show?.();
      schedules?.show?.();
      researchers?.show?.();
    },
    hide: () => {
      librarians?.hide?.();
      schedules?.hide?.();
      researchers?.hide?.();
    },
  };
}

/**
 * #519 §3 — the "Add a researcher" chip, verbatim from the mock (CTX.agents). Actionable: researchersView
 * (the Researchers sub-section) already renders an always-present add-dock (template tiles + name field,
 * `researchersView.ts:addDock`) rather than a separate "Add" button to click — so "the hub's own button
 * fires" is, honestly, bringing that dock into view and focusing its name field, not duplicating any
 * create-researcher logic (there's exactly one: the dock itself, still the single source of truth).
 */
function wireTopctxAddResearcher(container: HTMLElement): void {
  setTopbarContext(`<span class="topchip topchip--action" data-topctx-action="add-researcher">${navIcon('plus')} Add a researcher</span>`);
  document.querySelector('#topctx')?.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('[data-topctx-action="add-researcher"]')) return;
    const nameField = container.querySelector<HTMLInputElement>('.researcher-add-id');
    nameField?.scrollIntoView({ block: 'center' });
    nameField?.focus();
  });
}
