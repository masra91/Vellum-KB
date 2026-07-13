// @vitest-environment happy-dom
//
// SPEC-0053 AGENTSIA / WS-E · SPEC-0060 VUX-1 — the Agents hub, component tier (happy-dom; section IPC
// mocked). Asserts the direction-framed IA (AGENTSIA-1/2/3): one "Agents" surface with a Librarians
// group (inward) whose Schedules sub-group nests the former Jobs, and a Researchers group (outward);
// each group body is the existing section mounted in place; a section that fails to load is isolated
// (the others still render). v3: the hub frame is the warm-vellum `.ag-top` / `.ag-sec` language.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountAgentsHub } from './agentsHubView';
import type { KbApi } from '../../kb/types';

let listAgents: ReturnType<typeof vi.fn>;
let getModelCatalog: ReturnType<typeof vi.fn>;
let listJobs: ReturnType<typeof vi.fn>;
let listResearchers: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listAgents: listAgents as unknown as KbApi['listAgents'],
    getModelCatalog: getModelCatalog as unknown as KbApi['getModelCatalog'],
    listJobs: listJobs as unknown as KbApi['listJobs'],
    listResearchers: listResearchers as unknown as KbApi['listResearchers'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listAgents = vi.fn(async () => []);
  getModelCatalog = vi.fn(async () => null);
  listJobs = vi.fn(async () => []);
  listResearchers = vi.fn(async () => []);
  setApi();
});
afterEach(() => {
  document.body.innerHTML = '';
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  // #510: mountAgentsHub() now only builds the frame + mounts each section, returning an aggregated
  // lifecycle handle; show() (which the shell calls right after mount) is what triggers each section's
  // own load — mirror that here.
  mountAgentsHub(c).show?.();
  await flush();
  return c;
}

// The two top-level section heads (excludes the nested Schedules sub-head).
const sectionHeads = (c: HTMLElement): HTMLElement[] => Array.from(c.querySelectorAll<HTMLElement>('.ag-sec > .ag-sechead:not(.sub) h2'));

describe('Agents hub — direction-framed IA (SPEC-0053 WS-E · v3)', () => {
  it('renders one Agents surface with Librarians + Researchers groups and inward/outward descriptors', async () => {
    const c = await mount();
    expect(c.querySelector('.ag-top h1')?.textContent).toBe('Agents');
    const heads = sectionHeads(c).map((h) => h.textContent ?? '');
    expect(heads[0]).toMatch(/Librarians/);
    expect(heads[1]).toMatch(/Researchers/);
    const hints = Array.from(c.querySelectorAll<HTMLElement>('.ag-sec > .ag-sechead:not(.sub) .hint')).map((p) => p.textContent ?? '');
    expect(hints[0]).toMatch(/inside/i); // Librarians = inward
    expect(hints[1]).toMatch(/outside/i); // Researchers = outward
    expect(c.querySelectorAll('select')).toHaveLength(0); // hub itself composes no native control
  });

  it('marks the in/out axis with an aria-hidden direction glyph per group head (words still carry it)', async () => {
    const c = await mount();
    const glyphs = Array.from(c.querySelectorAll('.ag-sec > .ag-sechead:not(.sub) h2 .ti'));
    expect(glyphs.map((g) => g.textContent)).toEqual(['↻', '→']); // inward (Librarians) / outward (Researchers)
    for (const g of glyphs) expect(g.getAttribute('aria-hidden')).toBe('true'); // never glyph-alone — labels carry meaning
  });

  it('nests Schedules (formerly Jobs) under the Librarians group', async () => {
    const c = await mount();
    const librarians = c.querySelector('.ag-sec')!; // first section
    const sub = librarians.querySelector('.ag-sechead.sub h3');
    expect(sub?.textContent).toBe('Schedules');
    // the schedules section sub-container lives inside the Librarians group, not the Researchers one
    expect(librarians.querySelector('.agents-section[data-section="schedules"]')).not.toBeNull();
  });

  it('mounts each section in place (librarians, schedules, researchers each populated)', async () => {
    const c = await mount();
    for (const name of ['librarians', 'schedules', 'researchers']) {
      const sec = c.querySelector(`.agents-section[data-section="${name}"]`)!;
      expect(sec.innerHTML.length).toBeGreaterThan(0); // the existing view rendered into its sub-container
    }
    // the section IPCs were actually invoked (sections are live, not stubbed placeholders)
    expect(listAgents).toHaveBeenCalled();
    expect(listJobs).toHaveBeenCalled();
    expect(listResearchers).toHaveBeenCalled();
  });

  it('isolates a failing section — one section IPC throwing still renders the hub + the other sections', async () => {
    listResearchers = vi.fn(async () => {
      throw new Error('researchers ipc down');
    });
    setApi();
    const c = await mount();
    // hub framing intact
    const heads = sectionHeads(c).map((h) => h.textContent ?? '');
    expect(heads[0]).toMatch(/Librarians/);
    expect(heads[1]).toMatch(/Researchers/);
    // the healthy sections still rendered
    expect(c.querySelector('.agents-section[data-section="librarians"]')!.innerHTML.length).toBeGreaterThan(0);
    expect(c.querySelector('.agents-section[data-section="schedules"]')!.innerHTML.length).toBeGreaterThan(0);
    // the failing section degraded to its own retryable error, not a thrown/blank hub
    const researchers = c.querySelector('.agents-section[data-section="researchers"]')!;
    expect(researchers.querySelector('.load-error, .error')).not.toBeNull();
  });
});
