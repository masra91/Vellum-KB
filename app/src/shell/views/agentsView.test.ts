// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-3 · SPEC-0060 VUX-1 — the Agents view (Librarians section, observe-only) in the
// component tier. IPC mocked (`listAgents`); we assert the rendered v3 card grid + graceful degradation.
// The catalog/model/status logic is covered in the node tier (agentCatalog.test.ts). The live-status
// poll is the same `listAgents` call on a timer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountAgents } from './agentsView';
import type { AgentView, KbApi, ModelCatalogView } from '../../kb/types';

const AGENTS: AgentView[] = [
  { key: 'decompose', label: 'Decompose', role: 'Extracts candidates.', model: 'Copilot (default)', instructions: 'kb/decomposeAgent.ts', status: 'running' },
  { key: 'reflect', label: 'Reflect', role: 'Rumination.', model: 'gpt-x', instructions: 'kb/reflectAgent.ts', status: 'idle' },
];

function setApi(
  listAgents: KbApi['listAgents'],
  getModelCatalog?: KbApi['getModelCatalog'],
  setModel?: KbApi['setModel'],
  setAgentModel?: KbApi['setAgentModel'],
): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { listAgents, getModelCatalog, setModel, setAgentModel };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('Agents view (SPEC-0027 PANEL-3 · v3)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => {
    document.body.innerHTML = ''; // detach → the status poll stops itself on next tick
    vi.restoreAllMocks();
  });

  it('lists librarians as v3 cards with state, model, and instruction pointer', async () => {
    setApi(vi.fn(async () => AGENTS));
    mountAgents(root).show?.();
    await tick();
    await tick();
    expect(root.querySelectorAll('.ag-card')).toHaveLength(2);
    const decompose = root.querySelector('.ag-card[data-key="decompose"]')!;
    expect(decompose.querySelector('.ag-name')?.textContent).toBe('Decompose');
    expect(decompose.querySelector('.ag-kind')?.textContent).toBe('Extracts candidates.');
    expect(decompose.querySelector('.ag-state')?.textContent).toContain('Running');
    expect(decompose.textContent).toContain('Copilot (default)');
    expect(decompose.textContent).toContain('kb/decomposeAgent.ts');
    expect(root.querySelector('.ag-card[data-key="reflect"] .ag-state')?.textContent).toContain('Idle');
  });

  it('renders an error instead of throwing if listing fails (PANEL-9)', async () => {
    setApi(vi.fn(async () => {
      throw new Error('boom');
    }));
    mountAgents(root).show?.();
    await tick();
    await tick();
    expect(root.querySelector('.load-error')?.textContent).toContain('Couldn’t load'); // retryable fallback (#145)
    expect(root.querySelector('.load-retry')).toBeTruthy();
  });

  it('shows a friendly empty state when there are no agents', async () => {
    setApi(vi.fn(async () => []));
    mountAgents(root).show?.();
    await tick();
    await tick();
    expect(root.textContent).toContain('open a library');
  });

  // SPEC-0060 VUX-1 — the v3 card language: status-first state pill (running flies the LOOM mark, idle a
  // calm dot), the warm-vellum tokens, and NO ember anywhere (agent activity is not a decision).
  describe('v3 card language (SPEC-0060 VUX-1)', () => {
    it('renders a state pill that is status-first: running = loom mark, idle = calm dot', async () => {
      setApi(vi.fn(async () => AGENTS));
      mountAgents(root).show?.();
      await tick();
      await tick();
      const run = root.querySelector<HTMLElement>('.ag-card[data-key="decompose"] .ag-state')!;
      expect(run.classList.contains('run')).toBe(true);
      expect(run.querySelector('.vmark.loom')).toBeTruthy(); // continuous-work signature on a live agent
      const idle = root.querySelector<HTMLElement>('.ag-card[data-key="reflect"] .ag-state')!;
      expect(idle.classList.contains('on')).toBe(true);
      expect(idle.querySelector('.dot')).toBeTruthy();
      expect(idle.querySelector('.vmark.loom')).toBeNull(); // idle does NOT loom
    });

    it('updates the state pill in place on the poll refresh, keeping the v3 pill structure (PANEL-9)', async () => {
      vi.useFakeTimers();
      try {
        // running → idle on the second call, so the poll rewrites the pill in place.
        const listAgents = vi
          .fn<KbApi['listAgents']>()
          .mockResolvedValueOnce(AGENTS)
          .mockResolvedValue([{ ...AGENTS[0], status: 'idle' }, AGENTS[1]]);
        setApi(listAgents);
        mountAgents(root).show?.();
        await vi.advanceTimersByTimeAsync(5000); // one poll → refreshStatus rewrites the pill
        const pill = root.querySelector<HTMLElement>('.ag-card[data-key="decompose"] .ag-state')!;
        expect(pill.textContent).toContain('Idle'); // status updated in place
        expect(pill.classList.contains('on')).toBe(true); // rebuilt to the idle pill
        expect(pill.classList.contains('run')).toBe(false);
        expect(pill.querySelector('.vmark.loom')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('carries NO ember + NO legacy off-system primitives (.muted) on any render path', async () => {
      setApi(vi.fn(async () => AGENTS));
      mountAgents(root).show?.();
      await tick();
      await tick();
      expect(root.querySelector('[class*="ember"]')).toBeNull(); // agent activity is not a decision
      expect(root.querySelector('.muted')).toBeNull();
      // empty state too
      setApi(vi.fn(async () => []));
      mountAgents(root).show?.();
      await tick();
      await tick();
      expect(root.querySelector('.muted')).toBeNull();
    });
  });

  // VUX-17 (#524 §5) — every card gets a chevron cue + click-to-open detail (identity + current config).
  describe('VUX-17 drill-in shell', () => {
    it('renders a chevron cue and an initially-closed detail panel per card', async () => {
      setApi(vi.fn(async () => AGENTS));
      mountAgents(root).show?.();
      await tick();
      await tick();
      const card = root.querySelector('.ag-card[data-key="decompose"]')!;
      const chev = card.querySelector<HTMLButtonElement>('.ag-drill')!;
      expect(chev).toBeTruthy();
      expect(chev.getAttribute('aria-expanded')).toBe('false');
      expect(card.querySelector<HTMLElement>('.ag-detail')?.hidden).toBe(true);
    });

    it('clicking the chevron opens the detail panel with identity + current config; clicking again closes it', async () => {
      setApi(vi.fn(async () => AGENTS));
      mountAgents(root).show?.();
      await tick();
      await tick();
      const card = root.querySelector('.ag-card[data-key="decompose"]')!;
      const chev = card.querySelector<HTMLButtonElement>('.ag-drill')!;
      chev.click();
      const detail = card.querySelector<HTMLElement>('.ag-detail')!;
      expect(detail.hidden).toBe(false);
      expect(chev.getAttribute('aria-expanded')).toBe('true');
      expect(detail.textContent).toContain('Extracts candidates.'); // role
      expect(detail.textContent).toContain('kb/decomposeAgent.ts'); // instructions
      expect(detail.textContent).toContain('available yet'); // the disclosed past-runs placeholder
      chev.click();
      expect(detail.hidden).toBe(true);
      expect(chev.getAttribute('aria-expanded')).toBe('false');
    });

    it('clicking elsewhere on the card also opens the detail (not just the chevron)', async () => {
      setApi(vi.fn(async () => AGENTS));
      mountAgents(root).show?.();
      await tick();
      await tick();
      const card = root.querySelector('.ag-card[data-key="decompose"]')!;
      card.querySelector<HTMLElement>('.ag-name')!.click(); // an inert part of the card, not a control
      expect(card.querySelector<HTMLElement>('.ag-detail')?.hidden).toBe(false);
    });

    it('does NOT open the detail when clicking the existing Model disclosure (own interaction preserved)', async () => {
      setApi(vi.fn(async () => AGENTS));
      mountAgents(root).show?.();
      await tick();
      await tick();
      const card = root.querySelector('.ag-card[data-key="decompose"]')!;
      card.querySelector<HTMLElement>('.ag-adv summary')!.click();
      expect(card.querySelector<HTMLElement>('.ag-detail')?.hidden).toBe(true);
    });
  });

  // SPEC-0048 — the global "Default model" picker over the live CLI catalog.
  describe('SPEC-0048 model picker', () => {
    const CATALOG: ModelCatalogView = {
      accepted: ['claude-opus-4.8', 'claude-sonnet-4.5', 'gpt-5.5'],
      resolved: 'claude-opus-4.8',
      configured: 'claude-opus-4.8',
      staleConfigured: false,
    };

    it('renders a .viz-select picker over the catalog with the configured model selected + a "runs as" caption', async () => {
      setApi(vi.fn(async () => AGENTS), vi.fn(async () => CATALOG), vi.fn());
      mountAgents(root).show?.();
      await tick();
      await tick();
      const select = root.querySelector<HTMLSelectElement>('select.viz-select#model-default')!;
      expect(select).toBeTruthy();
      expect(select.querySelectorAll('option')).toHaveLength(4); // an "Auto" clear option + one per accepted model
      expect(select.value).toBe('claude-opus-4.8'); // the configured pick is selected
      expect(root.querySelector('.ag-modelbar .model-runs')?.textContent).toContain('claude-opus-4.8'); // runs-as caption
      expect(root.querySelector('.model-stale')).toBeNull(); // not stale → no gold note
    });

    it('shows a stale note (gold mark, not oxide) when the persisted pick is no longer in the live catalog', async () => {
      const stale: ModelCatalogView = { accepted: ['claude-opus-4.8'], resolved: 'claude-opus-4.8', configured: 'claude-opus-4', staleConfigured: true };
      setApi(vi.fn(async () => AGENTS), vi.fn(async () => stale), vi.fn());
      mountAgents(root).show?.();
      await tick();
      await tick();
      const note = root.querySelector<HTMLElement>('.model-stale')!;
      expect(note).toBeTruthy();
      expect(note.getAttribute('role')).toBe('status');
      expect(note.textContent).toContain('claude-opus-4'); // names the unavailable id
      // #184 a11y: the needs-you hue rides an aria-hidden ◆ mark (the label text reads AA in --ink).
      const mark = note.querySelector('.model-stale-mark')!;
      expect(mark).toBeTruthy();
      expect(mark.getAttribute('aria-hidden')).toBe('true');
    });

    it('persists a pick via setModel on change and updates the runs-as caption in place', async () => {
      const setModel = vi.fn(async () => ({ ok: true, resolved: 'gpt-5.5' }));
      setApi(vi.fn(async () => AGENTS), vi.fn(async () => CATALOG), setModel);
      mountAgents(root).show?.();
      await tick();
      await tick();
      const select = root.querySelector<HTMLSelectElement>('#model-default')!;
      select.value = 'gpt-5.5';
      select.dispatchEvent(new Event('change'));
      await tick();
      expect(setModel).toHaveBeenCalledWith('gpt-5.5');
      expect(root.querySelector('.ag-modelbar .model-runs .path')?.textContent).toBe('gpt-5.5'); // caption reflects the new resolved
    });

    it('degrades to the card grid with NO picker when the catalog IPC is unavailable (ENG-15/16)', async () => {
      // getModelCatalog omitted → the call throws → catalog null → control omitted, list still renders.
      setApi(vi.fn(async () => AGENTS));
      mountAgents(root).show?.();
      await tick();
      await tick();
      expect(root.querySelector('#model-default')).toBeNull();
      expect(root.querySelectorAll('.ag-card')).toHaveLength(2); // the list never blocks on the picker
    });

    it('shows a resolved-only readout (no dropdown) when the CLI catalog could not be probed (accepted=null)', async () => {
      const unprobed: ModelCatalogView = { accepted: null, resolved: 'claude-opus-4.8', configured: undefined, staleConfigured: false };
      setApi(vi.fn(async () => AGENTS), vi.fn(async () => unprobed), vi.fn());
      mountAgents(root).show?.();
      await tick();
      await tick();
      expect(root.querySelector('#model-default')).toBeNull(); // can't offer a list
      expect(root.querySelector('.ag-modelbar .model-runs')?.textContent).toContain('claude-opus-4.8'); // but shows what runs
    });

    // SPEC-0048 per-agent override (the SHOULD): each agent-backed card gets its own picker (in the
    // per-card "Model" disclosure).
    it('renders a per-agent picker per agent-backed card with "Use default" + the configured pick selected', async () => {
      const agents: AgentView[] = [
        { key: 'connect', label: 'Connect', role: 'r', model: 'claude-sonnet-4.5', configuredModel: 'claude-sonnet-4.5', instructions: 'kb/connectAgent.ts', status: 'idle' },
        { key: 'decompose', label: 'Decompose', role: 'r', model: 'claude-opus-4.8', instructions: 'kb/decomposeAgent.ts', status: 'idle' },
      ];
      setApi(vi.fn(async () => agents), vi.fn(async () => CATALOG), vi.fn(), vi.fn());
      mountAgents(root).show?.();
      await tick();
      await tick();
      const connectSel = root.querySelector<HTMLSelectElement>('.ag-card[data-key="connect"] .agent-model-select')!;
      expect(connectSel).toBeTruthy();
      expect(connectSel.querySelector('option')?.textContent).toContain('Use default'); // clear-override option
      expect(connectSel.querySelector('option[value="claude-sonnet-4.5"]')?.hasAttribute('selected')).toBe(true);
      const decSel = root.querySelector<HTMLSelectElement>('.ag-card[data-key="decompose"] .agent-model-select')!;
      expect(decSel.querySelector('option[value=""]')?.hasAttribute('selected')).toBe(true);
      expect(root.querySelector('.ag-card[data-key="connect"] .agent-model-runs')?.textContent).toContain('claude-sonnet-4.5');
    });

    it('persists a per-agent pick via setAgentModel(key,id) on change and updates that card in place', async () => {
      const agents: AgentView[] = [{ key: 'connect', label: 'Connect', role: 'r', model: 'claude-opus-4.8', instructions: 'kb/connectAgent.ts', status: 'idle' }];
      const setAgentModel = vi.fn(async () => ({ ok: true, resolved: 'claude-sonnet-4.5' }));
      setApi(vi.fn(async () => agents), vi.fn(async () => CATALOG), vi.fn(), setAgentModel);
      mountAgents(root).show?.();
      await tick();
      await tick();
      const sel = root.querySelector<HTMLSelectElement>('.ag-card[data-key="connect"] .agent-model-select')!;
      sel.value = 'claude-sonnet-4.5';
      sel.dispatchEvent(new Event('change'));
      await tick();
      expect(setAgentModel).toHaveBeenCalledWith('connect', 'claude-sonnet-4.5');
      expect(root.querySelector('.ag-card[data-key="connect"] .agent-model-runs .path')?.textContent).toBe('claude-sonnet-4.5');
    });

    it('folds the per-agent model into a quiet "Model" disclosure (select + caption stacked together)', async () => {
      const agents: AgentView[] = [{ key: 'connect', label: 'Connect', role: 'r', model: 'claude-sonnet-4.5', configuredModel: 'claude-sonnet-4.5', instructions: 'kb/connectAgent.ts', status: 'idle' }];
      setApi(vi.fn(async () => agents), vi.fn(async () => CATALOG), vi.fn(), vi.fn());
      mountAgents(root).show?.();
      await tick();
      await tick();
      const adv = root.querySelector<HTMLElement>('.ag-card[data-key="connect"] details.ag-adv')!;
      expect(adv).toBeTruthy();
      expect(adv.querySelector('summary')?.textContent).toContain('Model');
      const select = adv.querySelector<HTMLElement>('.agent-model-select')!;
      const runs = adv.querySelector<HTMLElement>('.agent-model-runs')!;
      expect(select).toBeTruthy();
      expect(runs).toBeTruthy();
      // select precedes the caption (caption stacks beneath via the .agent-model-runs block rule)
      expect(select.compareDocumentPosition(runs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  // #509 regression: the Librarians section (this `root`) lives NESTED inside the Agents hub's `.view`
  // wrapper — the shell toggles `.hidden` on that ANCESTOR, never on this container directly. The old
  // guard checked `root`'s own class (never matched in production → the poll never paused); test the
  // real shape, a `.view.hidden` parent, so this fails-before/passes-after on the actual bug. This
  // exercises `createVisibilityPoll`'s OWN self-gating (independent of #510's explicit hide()/show()
  // below) — the poll keeps ticking but skips the IPC while its ancestor `.view` is hidden.
  it('pauses the status poll while its ANCESTOR `.view` is hidden, resumes when shown (#509 / PANEL-9)', async () => {
    vi.useFakeTimers();
    try {
      const view = document.createElement('div');
      view.className = 'view';
      document.body.appendChild(view);
      view.appendChild(root); // root (the Librarians section) is nested inside the `.view`, not it

      const listAgents = vi.fn(async () => AGENTS);
      setApi(listAgents);
      mountAgents(root).show?.(); // initial activation → one listAgents call
      await vi.advanceTimersByTimeAsync(0);
      const initial = listAgents.mock.calls.length;

      view.classList.add('hidden'); // the shell toggles `.hidden` on the `.view` ancestor
      await vi.advanceTimersByTimeAsync(5000);
      expect(listAgents.mock.calls.length).toBe(initial); // no IPC while hidden — the poll self-gated

      view.classList.remove('hidden');
      await vi.advanceTimersByTimeAsync(5000);
      expect(listAgents.mock.calls.length).toBeGreaterThan(initial); // resumes when shown

      view.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  // #510: the shell drives visibility EXPLICITLY via the returned lifecycle handle, rather than relying
  // solely on the poll's own class-based self-gating — `hide()` fully `stop()`s the poll (zero live
  // timers once hidden, the fake-timer sweep's contract), not just skip-while-hidden.
  it('#510: hide() stops the status poll; show() resumes it (efficiency — PANEL-9)', async () => {
    vi.useFakeTimers();
    try {
      const view = document.createElement('div');
      view.className = 'view';
      document.body.appendChild(view);
      view.appendChild(root);

      const listAgents = vi.fn(async () => AGENTS);
      setApi(listAgents);
      const handle = mountAgents(root);
      handle.show?.(); // initial activation → one listAgents call
      await vi.advanceTimersByTimeAsync(0);
      const initial = listAgents.mock.calls.length;

      handle.hide?.(); // the shell calls this on switch-away
      await vi.advanceTimersByTimeAsync(5000);
      expect(listAgents.mock.calls.length).toBe(initial); // no IPC while hidden — the poll timer was cleared

      handle.show?.(); // switch back
      await vi.advanceTimersByTimeAsync(5000);
      expect(listAgents.mock.calls.length).toBeGreaterThan(initial); // resumes when shown

      view.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a container with no `.view` ancestor at all still polls normally (e.g. mounted standalone in a test harness)', async () => {
    vi.useFakeTimers();
    try {
      const listAgents = vi.fn(async () => AGENTS);
      setApi(listAgents);
      mountAgents(root).show?.(); // #510: mount() no longer self-loads — show() does (mirrors the shell)
      await vi.advanceTimersByTimeAsync(0);
      const initial = listAgents.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(listAgents.mock.calls.length).toBeGreaterThan(initial);
    } finally {
      vi.useRealTimers();
    }
  });

  // SPEC-0060 VUX-1: the librarian card CSS is on the warm-vellum v3 tokens, not the instrument-panel
  // --viz-* names. Guard on the CSS source (happy-dom applies no stylesheet).
  it('the v3 .ag-card block uses v3 tokens, not --viz-* (VUX-1)', () => {
    const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    const block = indexCss.slice(indexCss.indexOf('Agents view — VELLUM v3'), indexCss.indexOf('/* --- Control Panel: Manage section'));
    expect(block.length).toBeGreaterThan(500);
    expect(block).not.toMatch(/var\(--viz-/); // retired in the v3 block
    expect(block).toMatch(/var\(--viridian\b/);
    expect(block).toMatch(/var\(--ink\b/);
  });
});
