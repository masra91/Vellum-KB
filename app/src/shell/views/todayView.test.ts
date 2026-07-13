// @vitest-environment happy-dom
//
// SPEC-0058 STATE-7 — the UX v2 Today command-center home (happy-dom; IPC mocked). Asserts the surface
// renders from ONE maintained `kb:getTodayProjection` read (no live scan), the `status` faces
// (warming/error/thrown), the greeting comma rule, The Line station-state language, the four stats, the
// activity feed (with ref highlighting), the ONE ember "needs you" surface + its calm rest state, the
// health glance, the deep-link navigation (kb:navigate), and per-row partial-data isolation (ENG-15/16).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountToday } from './todayView';
import { NAVIGATE_EVENT, type NavigateDetail } from '../nav';
import type { KbApi, TodayProjection, TodayProjectionView } from '../../kb/types';

function projection(over: Partial<TodayProjection> = {}): TodayProjection {
  return {
    greeting: { salutation: 'Good morning', name: 'Mason' },
    subtitle: 'Your library is quiet and current — 3 things moved while you were away.',
    line: {
      meta: '2 in flight · last composed 6m ago',
      stations: [
        { name: 'Capture', stage: 'capture', state: 'idle', glyph: '○', count: 214 },
        { name: 'Decompose', stage: 'decompose', state: 'running', glyph: '▣', count: 2 },
        { name: 'Connect', stage: 'connect', state: 'blocked', glyph: '◐', count: 1 },
        { name: 'Compose', stage: 'compose', state: 'error', glyph: '✕', count: 0 },
      ],
    },
    stats: [
      { key: 'sources', label: 'Sources', value: 214, delta: { dir: 'up', text: '+6 today' } },
      { key: 'claims', label: 'Claims', value: 1847, delta: { dir: 'up', text: '+38 today' } },
      { key: 'entities', label: 'Entities', value: 392, delta: { dir: 'flat', text: 'stable' } },
      { key: 'connections', label: 'Connections', value: 1204, delta: { dir: 'up', text: '+21 today' } },
    ],
    activity: [
      { kind: 'composed', text: 'Composed a page for [[Project Atlas]] from 14 claims', ref: 'Project Atlas', when: '6m' },
      { kind: 'extracted', text: 'Extracted 38 claims from standup-notes.md', when: '41m' },
    ],
    decisions: [
      { kind: 'contradiction', title: 'A contradiction surfaced', body: 'Sources disagree. Pick the canonical claim.', action: 'Resolve', targetView: 'reviews' },
    ],
    health: [
      { key: 'dangling', label: 'Dangling links', sub: 'Links to nothing', value: '0', status: 'ok' },
      { key: 'orphans', label: 'Orphans', sub: 'Unlinked sources', value: '3', status: 'warn' },
      { key: 'thin', label: 'Thin stubs', sub: 'Entities with <2 claims', value: '11', status: 'warn' },
    ],
    ...over,
  };
}

/** A `ready` envelope over the given projection (the default happy path). */
function ready(over: Partial<TodayProjection> = {}): TodayProjectionView {
  return { status: 'ready', data: projection(over), builtAt: '2026-06-28T08:00:00Z', stale: false };
}

let getTodayProjection: ReturnType<typeof vi.fn>;
let reportRendererError: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    getTodayProjection: getTodayProjection as unknown as KbApi['getTodayProjection'],
    reportRendererError: reportRendererError as unknown as KbApi['reportRendererError'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  getTodayProjection = vi.fn(async () => ready());
  reportRendererError = vi.fn(async () => {});
  setApi();
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  // #510: mountToday() now only builds the skeleton + returns lifecycle hooks; show() (which the shell
  // calls right after mount) is what actually loads + paints — mirror that here.
  mountToday(c).show?.();
  await flush();
  return c;
}

describe('Today v2 — command-center home (SPEC-0058 STATE-7)', () => {
  it('reads the maintained projection once (one read, no live scan)', async () => {
    await mount();
    expect(getTodayProjection).toHaveBeenCalledTimes(1);
  });

  it('renders the greeting with the name comma + the subtitle', async () => {
    const c = await mount();
    const greet = c.querySelector('.today-greet')?.textContent ?? '';
    expect(greet).toContain('Good morning');
    expect(greet).toContain(', Mason');
    expect(c.querySelector('.today-sub')?.textContent).toContain('quiet and current');
  });

  it('omits the comma when no name is set', async () => {
    getTodayProjection = vi.fn(async () => ready({ greeting: { salutation: 'Good evening' } }));
    setApi();
    const c = await mount();
    const greet = c.querySelector('.today-greet')?.textContent ?? '';
    expect(greet.trim()).toBe('Good evening.');
    expect(c.querySelector('.today-greet-name')).toBeNull();
  });

  it('renders the v3 flow-strip (VUX-10): loom-marked lead, one stage per station, done/working/waiting reading', async () => {
    const c = await mount();
    // the continuous loom mark on the lead + the meta line
    expect(c.querySelector('.today-flow-lead .vmark.loom')).toBeTruthy();
    expect(c.querySelector('.today-flow-lead')?.textContent).toContain('in flight');
    const stations = Array.from(c.querySelectorAll('.today-fs-st'));
    expect(stations).toHaveLength(4);
    // the running stage reads "working"; the legend names done/working/waiting
    expect(c.querySelector('.today-fs-st[data-fs="working"]')).toBeTruthy();
    expect(c.querySelector('.today-fs-st[data-fs="error"]')).toBeTruthy();
    expect(c.querySelector('.today-flow-key')?.textContent).toContain('waiting');
    // the idle "Capture" stage (before the live frontier, with count) reads done
    expect(c.querySelector('.today-fs-st[data-fs="done"]')).toBeTruthy();
    // "See activity" deep-links to Activity
    expect(c.querySelector('.today-flow-go')?.getAttribute('data-target')).toBe('activity');
  });

  it('renders the four stat cards with values + deltas', async () => {
    const c = await mount();
    const stats = Array.from(c.querySelectorAll('.today-stat'));
    expect(stats).toHaveLength(4);
    // value is grouped with thousands separators
    expect(c.querySelector('.today-stats')?.textContent).toContain('1,847');
    expect(c.querySelector('.today-stat-d[data-dir="flat"]')?.textContent).toContain('stable');
  });

  it('renders the activity feed, highlighting [[refs]] and showing the age', async () => {
    const c = await mount();
    const rows = Array.from(c.querySelectorAll('.today-feed-row'));
    expect(rows).toHaveLength(2);
    expect(c.querySelector('.today-src')?.textContent).toBe('Project Atlas');
    expect(c.querySelector('.today-feed-when')?.textContent).toBe('6m');
  });

  it('renders the needs-you decision (the one ember surface) and navigates on its CTA', async () => {
    const c = await mount();
    const card = c.querySelector('.today-decide[data-kind="contradiction"]');
    expect(card).toBeTruthy();
    expect(c.querySelector('.today-needs')?.classList.contains('is-active')).toBe(true);
    let target: string | null = null;
    const handler = (e: Event): void => {
      target = (e as CustomEvent<NavigateDetail>).detail.view;
    };
    document.addEventListener(NAVIGATE_EVENT, handler);
    c.querySelector<HTMLButtonElement>('.today-go')?.click();
    document.removeEventListener(NAVIGATE_EVENT, handler);
    expect(target).toBe('reviews');
  });

  it('shows the calm (non-ember) rest state when nothing needs you', async () => {
    getTodayProjection = vi.fn(async () => ready({ decisions: [] }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.today-decide')).toBeNull();
    expect(c.querySelector('.today-rest')?.textContent).toContain('Nothing needs you');
    expect(c.querySelector('.today-needs')?.classList.contains('is-active')).toBe(false);
  });

  it('renders the health glance rows with their severity', async () => {
    const c = await mount();
    expect(c.querySelectorAll('.today-hrow')).toHaveLength(3);
    expect(c.querySelector('.today-hrow[data-status="ok"]')).toBeTruthy();
    expect(c.querySelectorAll('.today-hrow[data-status="warn"]')).toHaveLength(2);
  });

  // VUX-CONFORM #524 §3/§8 — a card title is not signage; the shared .viz-signage uppercase
  // treatment is the instrument tell (Researchers/Jobs) and must not leak onto v3 card titles.
  it('decision + health-row titles are sentence-case (no viz-signage uppercase, VUX-CONFORM #524)', async () => {
    const c = await mount();
    const decideTitle = c.querySelector('.today-decide-tx b');
    const healthTitle = c.querySelector('.today-ht b');
    expect(decideTitle).toBeTruthy();
    expect(healthTitle).toBeTruthy();
    expect(decideTitle?.classList.contains('viz-signage')).toBe(false);
    expect(healthTitle?.classList.contains('viz-signage')).toBe(false);
  });

  it('deep-links via the panel "View all" / "Full report" links', async () => {
    const c = await mount();
    const targets: string[] = [];
    const handler = (e: Event): void => void targets.push((e as CustomEvent<NavigateDetail>).detail.view);
    document.addEventListener(NAVIGATE_EVENT, handler);
    Array.from(c.querySelectorAll<HTMLButtonElement>('.today-panel-link')).forEach((b) => b.click());
    document.removeEventListener(NAVIGATE_EVENT, handler);
    expect(targets).toContain('activity');
    expect(targets).toContain('health');
  });

  it('shows the calm warming face (not the error face) while the projection warms, then auto-rechecks', async () => {
    getTodayProjection = vi.fn(async () => ({ status: 'warming' as const, data: null, builtAt: null, stale: false }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-warming')).toBeTruthy();
    expect(c.querySelector('.load-error')).toBeNull();
  });

  it('shows the honest error face on a genuine error status (never a stuck spinner)', async () => {
    getTodayProjection = vi.fn(async () => ({ status: 'error' as const, data: null, builtAt: null, stale: false }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error')).toBeTruthy();
    expect(c.querySelector('.load-warming')).toBeNull();
  });

  it('degrades to the error face (and un-swallows) when the IPC throws', async () => {
    getTodayProjection = vi.fn(async () => {
      throw new Error('boom');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error')).toBeTruthy();
    expect(reportRendererError).toHaveBeenCalled();
  });

  it('isolates partial data — a missing activity ref / empty feed never throws', async () => {
    getTodayProjection = vi.fn(async () => ready({ activity: [{ kind: 'other', text: 'Did a thing', when: 'now' }], decisions: [] }));
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('.today-feed-row')).toHaveLength(1);
    expect(c.querySelector('.today-src')).toBeNull(); // no [[ref]] in the text
  });

  describe('#510 lifecycle — data that changed while hidden repaints fresh on show()', () => {
    it('hide() stops the live clock + warming re-poll; a later show() re-reads and repaints the LATEST data, not what was cached at hide time', async () => {
      const c = document.createElement('div');
      document.body.appendChild(c);
      const handle = mountToday(c);

      handle.show?.(); // first activation
      await flush();
      expect(c.querySelector('.today-greet')?.textContent).toContain('Good morning');
      expect(getTodayProjection).toHaveBeenCalledTimes(1);

      handle.hide?.(); // switched away — no timer should keep ticking
      // The backend changed while hidden (e.g. a canonical advance) — the OLD design would never see
      // this until the next 8s poll tick; the view shouldn't even be polling while hidden at all.
      getTodayProjection = vi.fn(async () => ready({ greeting: { salutation: 'Good evening', name: 'Mason' } }));
      setApi();

      handle.show?.(); // switched back
      await flush();
      expect(getTodayProjection).toHaveBeenCalledTimes(1); // fresh read on THIS show(), not a stale cache
      expect(c.querySelector('.today-greet')?.textContent).toContain('Good evening'); // repainted with the NEW data
    });

    it('hide() clears the clock ticker and the warming timer — no leaked interval after switching away', async () => {
      vi.useFakeTimers();
      try {
        const c = document.createElement('div');
        document.body.appendChild(c);
        const handle = mountToday(c);
        handle.show?.();
        await vi.advanceTimersByTimeAsync(0); // let the mocked getTodayProjection resolve
        expect(vi.getTimerCount()).toBeGreaterThan(0); // the clock ticker is running while shown

        handle.hide?.();
        expect(vi.getTimerCount()).toBe(0); // no timer survives hide()
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // #512 PERF-R6: the shell can kick off Today's first read CONCURRENTLY with getState() (before this
  // container even exists) and hand the in-flight promise to mountToday — the FIRST show() should use
  // THAT read rather than firing a redundant second one, while every later show() (a switch-back) still
  // does its own fresh read.
  describe('#512 accepts a prefetched first read (PERF-R6)', () => {
    it('the FIRST show() consumes the prefetch instead of calling getTodayProjection again', async () => {
      const c = document.createElement('div');
      document.body.appendChild(c);
      const prefetch = Promise.resolve(ready({ greeting: { salutation: 'Good evening', name: 'Prefetched' } }));
      mountToday(c, prefetch).show?.();
      await flush();
      expect(getTodayProjection).not.toHaveBeenCalled(); // the mocked IPC was never invoked
      expect(c.textContent).toContain('Prefetched');
    });

    it('a SECOND show() (switch-back) does its OWN fresh read, not the stale prefetch', async () => {
      const c = document.createElement('div');
      document.body.appendChild(c);
      const prefetch = Promise.resolve(ready({ greeting: { salutation: 'Good evening', name: 'Prefetched' } }));
      const handle = mountToday(c, prefetch);
      handle.show?.();
      await flush();
      handle.hide?.();

      getTodayProjection.mockResolvedValueOnce(ready({ greeting: { salutation: 'Good morning', name: 'FreshRead' } }));
      handle.show?.();
      await flush();
      expect(getTodayProjection).toHaveBeenCalledTimes(1); // exactly one real IPC call, on the revisit
      expect(c.textContent).toContain('FreshRead');
    });

    it('a rejected prefetch degrades to the retryable error face, same as a failed live read', async () => {
      const c = document.createElement('div');
      document.body.appendChild(c);
      const prefetch = Promise.reject(new Error('boom'));
      mountToday(c, prefetch).show?.();
      await flush();
      expect(c.querySelector('.load-error')).toBeTruthy();
      expect(reportRendererError).toHaveBeenCalled();
    });
  });
});

// #406/BRAND-7 verify-only item: `.viz-body` (design-system.css) only sets `font-family`, not `color` —
// a class relying solely on it would inherit its container's ink color rather than resolving to the
// quiet `--stone` tone. Guard the CSS source directly (jsdom/happy-dom don't apply a real cascade) so a
// future edit that drops `.today-flow-empty`'s own explicit color rule doesn't silently regress it back
// to inheriting `--ink`.
describe('#406 verify-only — the pipeline-idle fragment resolves to --stone, not inherited --ink', () => {
  it('.today-flow-empty sets its own explicit color: var(--stone) (does not rely on .viz-body inheritance)', () => {
    const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    const rule = indexCss.match(/\.today-flow-empty\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('color: var(--stone)');
  });
});
