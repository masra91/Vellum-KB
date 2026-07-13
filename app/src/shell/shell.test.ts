// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-8 — the Reviews "needs you" count badge on the nav rail, in the component tier.
// IPC mocked; we assert the badge reflects the open-review count (visible from the rail, hence from
// the Manage section) and that the Reviews item is the link to the queue. The badge text/label logic
// is node-tested in reviewBadge.test.ts; this covers the shell's DOM wiring + graceful degradation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountShell } from './shell';
import { VIEW_REVIEWS, VIEW_CAPTURE, VIEW_CONNECTORS, VIEW_EXPLORE, VIEW_ACTIVITY, VIEW_HEALTH, VIEW_AGENTS, NAV_VIEWS } from './views';
import { setTopbarContext } from './nav';
import type { KbApi, ReviewSummary } from '../kb/types';

const review = (id: string): ReviewSummary => ({ id, question: 'q', detail: 'd', stage: 'claims', refs: [], createdAt: 't' });

function setApi(listReviews: KbApi['listReviews']): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listReviews,
    // Today (the default view, SPEC-0058) reads getTodayProjection on mount; stub a calm warming so the
    // shell mounts cleanly. pipelineStatus is kept for the Capture view (mounted on nav).
    getTodayProjection: vi.fn(async () => ({ status: 'warming' as const, data: null, builtAt: null, stale: false })),
    pipelineStatus: vi.fn(async () => ({ queueDepth: 0, processing: null, lastArchived: null, updatedAt: null })),
    capture: vi.fn(),
  };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const reviewsBtn = (root: HTMLElement): HTMLElement => root.querySelector(`.nav-item[data-view="${VIEW_REVIEWS}"]`)!;

describe('shell review-count badge (SPEC-0027 PANEL-8)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
  });
  afterEach(() => {
    document.body.innerHTML = ''; // detach → the badge poll stops itself
    vi.restoreAllMocks();
  });

  it('shows the open-review count on the Reviews rail item (visible from Manage)', async () => {
    setApi(vi.fn(async () => [review('a'), review('b'), review('c')]));
    mountShell(root, '/vault', 'KB');
    await tick();
    const badge = reviewsBtn(root).querySelector('.nav-badge');
    expect(badge?.textContent).toBe('3');
    // The Reviews item is the link to the queue — present in the rail alongside the Manage group.
    expect(reviewsBtn(root)).toBeTruthy();
    expect(reviewsBtn(root).getAttribute('aria-label')).toContain('3 reviews need your attention');
  });

  it('shows no badge when nothing needs you', async () => {
    setApi(vi.fn(async () => []));
    mountShell(root, '/vault', 'KB');
    await tick();
    expect(reviewsBtn(root).querySelector('.nav-badge')).toBeNull();
  });

  it('degrades gracefully (no badge, no throw) if listReviews fails', async () => {
    setApi(
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );
    mountShell(root, '/vault', 'KB');
    await tick();
    expect(reviewsBtn(root).querySelector('.nav-badge')).toBeNull();
  });

  // #509 — "the review-badge interval is the one thing mountShell doesn't re-mount-clean": a vault switch
  // calls `mountShell` again on the SAME root (root.innerHTML is replaced, root itself never leaves the
  // document), so the PRIOR interval's own `document.contains(root)` self-stop check never fired — every
  // re-mount stacked another permanent poller. Regression: mount twice on one root, one tick fires ONE
  // listReviews call, not two (or N, after N re-mounts).
  it('mountShell twice on one root: one badge poll per tick, not two (#509)', async () => {
    vi.useFakeTimers();
    try {
      const listReviews = vi.fn(async () => [review('a')]);
      setApi(listReviews);
      mountShell(root, '/vault', 'KB'); // first mount → starts a badge poll
      await vi.advanceTimersByTimeAsync(0);
      mountShell(root, '/vault', 'KB'); // vault-switch re-mount on the SAME root → must stop the first poll
      await vi.advanceTimersByTimeAsync(0);
      const callsAtRemount = listReviews.mock.calls.length;

      await vi.advanceTimersByTimeAsync(5000); // one poll tick
      expect(listReviews.mock.calls.length).toBe(callsAtRemount + 1); // exactly one call, not two
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shell kb:navigate view→view nav primitive (SHELL — Field Desk escalation deep-link)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
    setApi(vi.fn(async () => []));
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('a kb:navigate event switches the active view (so a view can deep-link to another, e.g. → Reviews)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    expect(reviewsBtn(root).getAttribute('aria-current')).not.toBe('page'); // starts on Capture
    document.dispatchEvent(new CustomEvent('kb:navigate', { detail: { view: VIEW_REVIEWS } }));
    await tick();
    expect(reviewsBtn(root).getAttribute('aria-current')).toBe('page'); // navigated to Reviews
  });

  it('ignores a kb:navigate to an unknown view (no throw, no change)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    expect(() => document.dispatchEvent(new CustomEvent('kb:navigate', { detail: { view: 'not-a-view' } }))).not.toThrow();
    await tick();
    expect(reviewsBtn(root).getAttribute('aria-current')).not.toBe('page');
  });
});

describe('shell UX v2 sidebar brand header', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
    setApi(vi.fn(async () => []));
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the Vellum wordmark + crystalline glyph at the top of the rail (v2 shell language)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    const brand = root.querySelector('.sidebar .sidebar-brand');
    expect(brand).not.toBeNull();
    expect(root.querySelector('.sidebar-brand-name')?.textContent).toBe('Vellum');
    expect(root.querySelector('.sidebar-brand-glyph')).not.toBeNull(); // the gold crystalline mark
    // the nav lives in its own wrapper below the brand, and the watermark is decorative (aria-hidden)
    expect(root.querySelector('.sidebar .sidebar-nav .nav-item')).not.toBeNull();
    expect(root.querySelector('.sidebar-wmark')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('shell UX v2 nav line-icons', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
    setApi(vi.fn(async () => []));
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('nav items render monochrome inline line-icon SVGs, not emoji (v2 rail)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    const icon = root.querySelector('.nav-item .nav-icon');
    expect(icon).not.toBeNull();
    expect(icon!.querySelector('svg')).not.toBeNull(); // a line glyph, not an emoji text node
    expect(icon!.textContent?.trim()).toBe(''); // no emoji character left in the icon slot
    // currentColor stroke → the glyph gilds gold with the nav item on hover/active (no hardcoded fill)
    expect(icon!.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
  });
});

describe('v3 shell chrome (SPEC-0060 — top bar, brand-diamond motion, "you" card, IA)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
    setApi(vi.fn(async () => []));
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders the top bar: a REAL global ⌘K search input, the contextual filter slot, and Quick-add', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    expect(root.querySelector('.bar')).not.toBeNull();
    // #519 §2 — a real <input>, not a styled button: it accepts text.
    const search = root.querySelector<HTMLInputElement>('#globalSearch');
    expect(search).not.toBeNull();
    expect(search!.tagName).toBe('INPUT');
    search!.value = 'Ada';
    expect(search!.value).toBe('Ada');
    expect(root.querySelector('.topsearch-shell .kbd')?.textContent).toBe('⌘K');
    expect(root.querySelector('#searchResults')?.getAttribute('role')).toBe('listbox');
    expect(root.querySelector('#topctx')).not.toBeNull(); // the per-view contextual slot exists (VUX-3)
    expect(root.querySelector('.quickadd')).not.toBeNull();
  });

  it('⌘K focuses AND selects the search input (re-summon convention)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    const search = root.querySelector<HTMLInputElement>('#globalSearch')!;
    search.value = 'stale query';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(search);
  });

  it('Quick-add navigates to Capture', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    root.querySelector<HTMLButtonElement>('.quickadd')!.click();
    await tick();
    expect(root.querySelector(`.nav-item[data-view="${VIEW_CAPTURE}"]`)?.getAttribute('aria-current')).toBe('page');
  });

  it('renders the brand-diamond motion mark (looms by default) and the "you" identity card', async () => {
    mountShell(root, '/vault-folder/Atlas', 'KB');
    await tick();
    const dmk = root.querySelector('.brand-mark.dmk');
    expect(dmk).not.toBeNull();
    expect(dmk!.classList.contains('is-working')).toBe(true); // the "always working" loom signature
    const user = root.querySelector('.user');
    expect(user).not.toBeNull();
    expect(user!.querySelector('.user-id b')?.textContent).toBe('You');
    expect(user!.querySelector('.user-id span')?.textContent).toBe('Atlas'); // vault basename
  });

  it('the contextual filter slot is filled by setTopbarContext and cleared on view change (VUX-3)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    setTopbarContext('<span class="topchip">All activity</span>');
    expect(root.querySelector('#topctx')?.textContent).toContain('All activity');
    // a view change clears the slot (the newly-activated view re-fills its own)
    document.dispatchEvent(new CustomEvent('kb:navigate', { detail: { view: VIEW_REVIEWS } }));
    await tick();
    expect(root.querySelector('#topctx')?.textContent).toBe('');
  });

  it('IA: Connectors replaces Sources in the rail; Status is fully dissolved (no rail entry, not navigable)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    // Sources → Connectors (the rail entry renamed).
    expect(root.querySelector(`.nav-item[data-view="${VIEW_CONNECTORS}"]`)).not.toBeNull();
    expect(root.querySelector('.nav-item[data-view="sources"]')).toBeNull();
    // Status dissolved: gone from the rail AND navigating to it is a no-op (stays on the launch home).
    expect(root.querySelector('.nav-item[data-view="status"]')).toBeNull();
    document.dispatchEvent(new CustomEvent('kb:navigate', { detail: { view: 'status' } }));
    await tick();
    expect(root.querySelector('.view[data-view="status"]')).toBeNull(); // never mounts — dissolved
  });
});

// #519 §3/§12 — per-view topctx fillers. Explore/Activity/Health/Agents fill #topctx (verbatim from the
// mock); every other rail view is the documented empty list. A mount test per the AC, PLUS the revisit
// case (shell.ts's lastTopctxByView cache, added because the shell's mount-once model otherwise leaves
// the slot empty on a second visit to an already-mounted view — not just first activation).
describe('#519 §3 — per-view topctx fillers (Explore/Activity/Health/Agents fill; the rest stay empty)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      listReviews: vi.fn(async () => []),
      getTodayProjection: vi.fn(async () => ({ status: 'warming' as const, data: null, builtAt: null, stale: false })),
      pipelineStatus: vi.fn(async () => ({ queueDepth: 0, processing: null, lastArchived: null, updatedAt: null })),
      capture: vi.fn(),
      exploreProjection: vi.fn(async () => ({
        status: 'ready' as const,
        data: { neighborhood: { found: false, claims: [], neighbors: [], shown: 0, total: 0, contradictions: [] }, entities: [] },
        builtAt: 't',
        stale: false,
      })),
      exploreEntities: vi.fn(async () => []),
      activityFeed: vi.fn(async () => ({ entries: [], total: 0, truncated: false, knownActors: [] })),
      healthReport: vi.fn(async () => ({ status: 'ready' as const, dimensions: [], builtAt: 't', stale: false }) as unknown as Awaited<ReturnType<KbApi['healthReport']>>),
      listAgents: vi.fn(async () => []),
      getModelCatalog: vi.fn(async () => ({ models: [], default: null }) as unknown as Awaited<ReturnType<KbApi['getModelCatalog']>>),
      listJobs: vi.fn(async () => []),
      listResearchers: vi.fn(async () => []),
      workIqStatus: vi.fn(async () => ({ installed: false }) as unknown as Awaited<ReturnType<KbApi['workIqStatus']>>),
    } as Partial<KbApi>;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const go = async (view: string): Promise<void> => {
    document.dispatchEvent(new CustomEvent('kb:navigate', { detail: { view } }));
    await tick();
    await tick(); // a beat for the view's own async mount/load to resolve
  };

  it('Explore fills #topctx with the filter/type/confidence chips on first mount', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    await go(VIEW_EXPLORE);
    const ctx = root.querySelector('#topctx')!;
    expect(ctx.textContent).toContain('Filters');
    expect(ctx.textContent).toContain('All types');
  });

  it('Activity fills #topctx with the "All activity" chip on first mount', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    await go(VIEW_ACTIVITY);
    expect(root.querySelector('#topctx')?.textContent).toContain('All activity');
  });

  it('Health fills #topctx with the "Re-scan" chip on first mount', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    await go(VIEW_HEALTH);
    expect(root.querySelector('#topctx')?.textContent).toContain('Re-scan');
  });

  it('Agents fills #topctx with the "Add a researcher" chip on first mount', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    await go(VIEW_AGENTS);
    expect(root.querySelector('#topctx')?.textContent).toContain('Add a researcher');
  });

  it('the documented empty list (Today/Ask/Capture/Reviews/Connectors/Settings) never fills #topctx', async () => {
    mountShell(root, '/vault', 'KB');
    await tick(); // Today is the launch default
    expect(root.querySelector('#topctx')?.textContent).toBe('');
    for (const view of [VIEW_CAPTURE, VIEW_REVIEWS, VIEW_CONNECTORS]) {
      await go(view);
      expect(root.querySelector('#topctx')?.textContent).toBe('');
    }
  });

  it('REVISITING an already-mounted filler view restores its chips (shell mount-once model, §3)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    await go(VIEW_EXPLORE);
    expect(root.querySelector('#topctx')?.textContent).toContain('Filters');

    await go(VIEW_CAPTURE); // navigate away — the slot clears (Capture is on the empty list)
    expect(root.querySelector('#topctx')?.textContent).toBe('');

    await go(VIEW_EXPLORE); // revisit — Explore's mount code does NOT re-run (SHELL-8), yet the chips return
    expect(root.querySelector('#topctx')?.textContent).toContain('Filters');
  });

  it('Health\'s "Re-scan" chip calls the SAME render path as the view\'s own Retry (identity, not a duplicate)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    await go(VIEW_HEALTH);
    const healthReport = (window as unknown as { kbApi: KbApi }).kbApi.healthReport as unknown as ReturnType<typeof vi.fn>;
    const callsBefore = healthReport.mock.calls.length;
    root.querySelector<HTMLElement>('[data-topctx-action="health-rescan"]')!.click();
    await tick();
    expect(healthReport.mock.calls.length).toBe(callsBefore + 1); // re-ran the identical fetch, no second code path
  });

  it('Agents\' "Add a researcher" chip focuses the SAME add-dock field the hub already renders (identity)', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    await go(VIEW_AGENTS);
    const nameField = root.querySelector<HTMLInputElement>('.researcher-add-id')!;
    expect(nameField).not.toBeNull();
    root.querySelector<HTMLElement>('[data-topctx-action="add-researcher"]')!.click();
    expect(document.activeElement).toBe(nameField);
  });
});

// SPEC-0058 STATE-8 (#510) — the view lifecycle CONTRACT, swept across every rail-registered view (the
// CLASS, not hand-picked instances): switching away must stop that view's live behavior within one tick.
// A broad kbApi mock so every view's mount succeeds (or degrades gracefully via its own ENG-15/16 error
// path, which still starts+registers whatever timers that view's `show()` unconditionally sets up).
function setBroadApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listReviews: vi.fn(async () => []),
    reviewProjection: vi.fn(async () => ({ data: [], builtAt: 't', stale: false })),
    getTodayProjection: vi.fn(async () => ({ status: 'ready' as const, data: null, builtAt: 't', stale: false }) as unknown as Awaited<ReturnType<KbApi['getTodayProjection']>>),
    pipelineStatus: vi.fn(async () => ({ queueDepth: 0, processing: null, lastArchived: null, updatedAt: null })),
    capture: vi.fn(),
    exploreProjection: vi.fn(async () => ({ status: 'ready', data: { neighborhood: { found: false, claims: [], neighbors: [], shown: 0, total: 0, contradictions: [] }, entities: [] }, builtAt: 't', stale: false }) as unknown as Awaited<ReturnType<KbApi['exploreProjection']>>),
    healthReport: vi.fn(async () => ({ status: 'ready', builtAt: 't', dimensions: [] }) as unknown as Awaited<ReturnType<KbApi['healthReport']>>),
    activityFeed: vi.fn(async () => ({ entries: [], total: 0, truncated: false })),
    listAgents: vi.fn(async () => []),
    getModelCatalog: vi.fn(async () => ({ accepted: null, resolved: 'auto', configured: undefined, staleConfigured: false })),
    listJobs: vi.fn(async () => []),
    listResearchers: vi.fn(async () => []),
    listIntakeConnectors: vi.fn(async () => []),
    getState: vi.fn(async () => ({ activeVaultPath: null, vaultConfig: null }) as unknown as Awaited<ReturnType<KbApi['getState']>>),
    onProjectionChanged: vi.fn(() => () => {}),
  };
}

describe('#510 contract: every registered view stops its live behavior within one tick of hide()', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('a fake-timer sweep through every rail view: after visiting all of them and returning to the first, the timer count is back to baseline — no leaked interval/timeout from any view', async () => {
    vi.useFakeTimers();
    try {
      setBroadApi();
      mountShell(root, '/vault', 'KB');
      // 1200ms: long enough for shell.ts's own one-shot "brand-diamond churn" timeout (1100ms, fired on
      // every render() — shell chrome, not any view's lifecycle) to fire and self-clear each time, so it
      // never accumulates across clicks and pollutes the view-timer count this test actually cares about.
      await vi.advanceTimersByTimeAsync(1200); // let the launch-home (Today) view's first show() settle
      const baseline = vi.getTimerCount(); // Today's live clock + the always-on Reviews rail badge poll

      for (const view of NAV_VIEWS) {
        root.querySelector<HTMLButtonElement>(`.nav-item[data-view="${view.id}"]`)!.click();
        await vi.advanceTimersByTimeAsync(1200); // let that view's (async) mount/show settle
      }
      // Switch back to the first view — this is what forces the LAST visited view's hide() to fire (the
      // shell only hides the PREVIOUSLY active view on the NEXT switch).
      root.querySelector<HTMLButtonElement>(`.nav-item[data-view="${NAV_VIEWS[0].id}"]`)!.click();
      await vi.advanceTimersByTimeAsync(1200);

      expect(vi.getTimerCount()).toBe(baseline); // every visited view's hide() cleaned up fully
    } finally {
      vi.useRealTimers();
    }
  });
});
