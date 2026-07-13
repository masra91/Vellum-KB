// @vitest-environment happy-dom
//
// SPEC-0039 EXPLORE / SPEC-0058 STATE-13 — the UX v2 Explore view (happy-dom; IPC mocked). Asserts the
// radial graph (center + neighbor nodes), the right rail (focused entity + claims), click-to-re-center,
// the projection `status` states (warming/error/empty), partial-data isolation, and the instrument-
// language composition (no native <select>). Data comes from the maintained `kb:exploreProjection`
// envelope (STATE-2) — one read, no live walk.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountExplore } from './exploreView';
import type { KbApi } from '../../kb/types';
import type { ExploreEntityRef, ExploreNeighborhood, ExploreProjection } from '../../kb/explorePanel';

const ENTITIES: ExploreEntityRef[] = [
  { rel: 'entities/project/atlas.md', id: 'a', name: 'Project Atlas', kind: 'project', confidence: 0.9 },
  { rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7 },
];

function neighborhood(over: Partial<ExploreNeighborhood> = {}): ExploreNeighborhood {
  return {
    found: true,
    center: { rel: 'entities/project/atlas.md', id: 'a', name: 'Project Atlas', kind: 'project', confidence: 0.9, tags: ['type/project', 'topic/q3'] },
    claims: [{ statement: 'Funded for Q3', status: 'fact', confidence: 0.8, citations: [], contested: false }],
    neighbors: [
      { rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7, direction: 'out', predicate: 'funds', speculative: false },
      { rel: 'entities/person/steve.md', id: 's', name: 'Steve Park', kind: 'person', confidence: 0.6, direction: 'in', speculative: true },
    ],
    shown: 2,
    total: 2,
    contradictions: [],
    ...over,
  };
}

/** A `ready` projection envelope over the given neighborhood (the default happy path). */
function ready(over: Partial<ExploreNeighborhood> = {}): ExploreProjection {
  return { status: 'ready', data: { neighborhood: neighborhood(over), entities: ENTITIES }, builtAt: '2026-06-28T00:00:00Z', stale: false };
}

let exploreProjection: ReturnType<typeof vi.fn>;
let openCitation: ReturnType<typeof vi.fn>;
let openSourceRef: ReturnType<typeof vi.fn>;
let reportRendererError: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    exploreProjection: exploreProjection as unknown as KbApi['exploreProjection'],
    openCitation: openCitation as unknown as KbApi['openCitation'],
    openSourceRef: openSourceRef as unknown as KbApi['openSourceRef'],
    reportRendererError: reportRendererError as unknown as KbApi['reportRendererError'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  exploreProjection = vi.fn(async () => ready());
  openCitation = vi.fn(async () => ({ ok: true as const }));
  openSourceRef = vi.fn(async () => ({ status: 'opened' as const }));
  reportRendererError = vi.fn(async () => {});
  setApi();
});
afterEach(() => {
  document.body.innerHTML = '';
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  // #510: mountExplore() now only builds the skeleton + returns lifecycle hooks; show() (which the
  // shell calls right after mount) is what actually loads + paints — mirror that here.
  mountExplore(c).show?.();
  await flush();
  return c;
}

describe('Explore v2 — radial graph + rail (SPEC-0039 / STATE-13)', () => {
  it('reads the maintained projection (one read, no live neighborhood/entities walk)', async () => {
    await mount();
    expect(exploreProjection).toHaveBeenCalledTimes(1);
  });

  it('renders the radial graph: an SVG, the static center node, and one node per neighbor', async () => {
    const c = await mount();
    expect(c.querySelector('.exp-svg')).not.toBeNull();
    expect(c.querySelector('.exp-center-name')?.textContent).toBe('Project Atlas');
    const nodeNames = Array.from(c.querySelectorAll('.exp-node')).map((n) => (n as HTMLElement).dataset.name);
    expect(nodeNames).toEqual(['Finance Team', 'Steve Park']);
    // typed node color rides a data-kind on the disc (CSS maps it; #184 — not the only signal, label carries the name)
    expect(c.querySelector('.exp-node[data-name="Finance Team"] .exp-node-dot')?.getAttribute('data-kind')).toBe('organization');
  });

  it('marks a speculative neighbor distinctly (~conf, dashed edge class) — non-color signal kept', async () => {
    const c = await mount();
    const steve = c.querySelector('.exp-node[data-name="Steve Park"]')!;
    expect(steve.classList.contains('exp-node--spec')).toBe(true);
    expect(steve.querySelector('.exp-node-conf')?.textContent).toBe('~0.60');
    expect(c.querySelector('.exp-edge[data-rel="entities/person/steve.md"]')?.classList.contains('exp-edge--spec')).toBe(true);
  });

  it('renders the right rail: focused entity (Spectral name + kind), tags, and claims', async () => {
    const c = await mount();
    expect(c.querySelector('.exp-rail .rail-name')?.textContent).toBe('Project Atlas');
    expect(c.querySelector('.rail-kind')?.textContent).toContain('project');
    expect(c.querySelectorAll('.explore-tag').length).toBe(2);
    expect(c.querySelector('.explore-claim')?.textContent).toContain('Funded for Q3');
  });

  it('clicking a graph node re-centers on it (re-reads the projection for that focus)', async () => {
    const c = await mount();
    exploreProjection.mockClear();
    const node = c.querySelector('.exp-node[data-rel="entities/org/finance.md"]')!;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(exploreProjection).toHaveBeenCalledWith('entities/org/finance.md');
  });

  it('composes the instrument language — no native <select> anywhere (EXPLORE-10)', async () => {
    const c = await mount();
    expect(c.querySelectorAll('select')).toHaveLength(0);
    expect(c.querySelector('.explore.explore-v2.viz-surface')).not.toBeNull();
  });
});

describe('Explore v2 — projection status states (SPEC-0058 STATE-9/10)', () => {
  it('status=warming → a calm warming face (not the error face), then auto-rechecks', async () => {
    exploreProjection = vi.fn(async () => ({ status: 'warming', data: null, builtAt: null, stale: false }) as ExploreProjection);
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-warming')).not.toBeNull();
    expect(c.querySelector('.load-error')).toBeNull();
    expect(c.querySelector('.exp-svg')).toBeNull();
  });

  it('status=error → honest degrade (error face with Recheck), never a stuck spinner (#160)', async () => {
    exploreProjection = vi.fn(async () => ({ status: 'error', data: null, builtAt: null, stale: true }) as ExploreProjection);
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error')).not.toBeNull();
  });

  it('a thrown IPC degrades to the error face (un-swallowed), not a crash', async () => {
    exploreProjection = vi.fn(async () => {
      throw new Error('ipc down');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error')).not.toBeNull();
    expect(reportRendererError).toHaveBeenCalled();
  });

  it('an empty graph (found:false) renders the branded empty hero, not a broken canvas', async () => {
    exploreProjection = vi.fn(
      async () =>
        ({ status: 'ready', data: { neighborhood: { found: false, claims: [], neighbors: [], shown: 0, total: 0, contradictions: [] }, entities: [] }, builtAt: 't', stale: false }) as ExploreProjection,
    );
    setApi();
    const c = await mount();
    expect(c.querySelector('.viz-empty')).not.toBeNull();
    expect(c.querySelector('.exp-svg')).toBeNull();
  });
});

describe('Explore v2 — render safety + sparse (ENG-15/16, EXPLORE-11)', () => {
  it('a neighbor missing kind/predicate renders a node without breaking its sibling', async () => {
    exploreProjection = vi.fn(async () =>
      ready({
        neighbors: [
          { rel: 'entities/x/partial.md', id: 'p', name: 'Partial Node', kind: '', confidence: 0.5, direction: 'both', speculative: true },
          { rel: 'entities/org/finance.md', id: 'f', name: 'Finance Team', kind: 'organization', confidence: 0.7, direction: 'out', predicate: 'funds', speculative: false },
        ],
        shown: 2,
        total: 2,
      }),
    );
    setApi();
    const c = await mount();
    const names = Array.from(c.querySelectorAll('.exp-node')).map((n) => (n as HTMLElement).dataset.name);
    expect(names).toEqual(['Partial Node', 'Finance Team']);
  });

  it('a focused entity with no neighbors renders the center + an in-graph "no relationships" note', async () => {
    exploreProjection = vi.fn(async () => ready({ neighbors: [], shown: 0, total: 0 }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.exp-center-name')?.textContent).toBe('Project Atlas');
    expect(c.querySelector('.exp-graph-empty')).not.toBeNull();
    expect(c.querySelectorAll('.exp-node')).toHaveLength(0);
  });
});

describe('Explore v2 — click-throughs (EXPLORE-4 / WS-A / REVIEW-17, retained from v1)', () => {
  // A center claim carrying both a cited source and a woven [[Name]] link, so the rail renders
  // an .explore-cite and an .explore-statement-link to exercise the two click handlers.
  function withRichClaim(): ExploreProjection {
    return {
      status: 'ready',
      data: {
        neighborhood: neighborhood({
          claims: [
            {
              statement: 'Funded by [[Finance Team]] for Q3',
              status: 'fact',
              confidence: 0.8,
              contested: false,
              citations: [{ ref: 'sources/budget.md', title: 'Budget Doc' }],
            },
          ],
        }),
        entities: ENTITIES,
      },
      builtAt: 't',
      stale: false,
    };
  }

  it('Open in Obsidian opens the focused entity (EXPLORE-4 click-through)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.explore-open')!.click();
    await flush();
    expect(openCitation).toHaveBeenCalledWith('entities/project/atlas.md');
  });

  it('a claim’s cited source opens working-zone-aware (WS-A / REVIEW-17)', async () => {
    exploreProjection = vi.fn(async () => withRichClaim());
    setApi();
    const c = await mount();
    const cite = c.querySelector<HTMLButtonElement>('.explore-cite[data-ref="sources/budget.md"]')!;
    expect(cite).not.toBeNull();
    cite.click();
    await flush();
    expect(openSourceRef).toHaveBeenCalledWith('sources/budget.md');
  });

  it('a woven [[Name]] in a claim re-centers on that entity (WS-A)', async () => {
    exploreProjection = vi.fn(async () => withRichClaim());
    setApi();
    const c = await mount();
    exploreProjection.mockClear();
    const link = c.querySelector<HTMLButtonElement>('.explore-statement-link[data-name="Finance Team"]')!;
    expect(link).not.toBeNull();
    link.click();
    await flush();
    expect(exploreProjection).toHaveBeenCalledWith('Finance Team');
  });
});

// SPEC-0060 VUX-1: the Explore CSS block migrates its COLOUR/material/font/radius tokens off --viz-*
// onto the v3 warm-vellum set. The ambient-field MOTION utilities (--viz-field-gradient / --viz-dur-* /
// viz-drift) are intentionally KEPT — they're pure motion with no v3 equivalent, not colour. NO ember
// (graph exploration isn't a decision; contested/speculative = gold caution). Guard on the CSS source.
describe('VUX-1 v3 token migration (SPEC-0060 — Explore, colour off --viz-*)', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  const block = indexCss.slice(
    indexCss.indexOf('Explore view — VELLUM v3'),
    indexCss.indexOf('Health view: structural-lint'),
  );

  it('isolated the Explore v3 block', () => {
    expect(block.length).toBeGreaterThan(1000);
  });

  it('the COLOUR/material/font tokens are off --viz-* (only motion utilities remain) + NO ember', () => {
    for (const t of ['--viz-ink', '--viz-accent', '--viz-brass', '--viz-patina', '--viz-idle', '--viz-panel', '--viz-rule', '--viz-font-']) {
      expect(block.includes(`var(${t}`)).toBe(false);
    }
    expect(block).not.toMatch(/--ember|var\(--ember/);
    // the only surviving --viz-* are the pure-motion utilities (no v3 equivalent)
    const survivors = [...block.matchAll(/var\(--viz-[a-z-]+/g)].map((m) => m[0]);
    expect(survivors.every((s) => s.includes('--viz-dur-') || s.includes('--viz-field-gradient'))).toBe(true);
  });

  it('uses v3 colour tokens (ink/slate/gold/viridian/faint)', () => {
    expect(block).toMatch(/var\(--ink\b/);
    expect(block).toMatch(/var\(--slate\b/); // focus / interactive
    expect(block).toMatch(/var\(--gold\b/); // contested / speculative caution
    expect(block).toMatch(/var\(--viridian\b/);
  });
});
