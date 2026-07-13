// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-8 — the Reviews "needs you" count badge on the nav rail, in the component tier.
// IPC mocked; we assert the badge reflects the open-review count (visible from the rail, hence from
// the Manage section) and that the Reviews item is the link to the queue. The badge text/label logic
// is node-tested in reviewBadge.test.ts; this covers the shell's DOM wiring + graceful degradation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountShell } from './shell';
import { VIEW_REVIEWS, VIEW_CAPTURE, VIEW_CONNECTORS } from './views';
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

  it('renders the top bar: global ⌘K search, the contextual filter slot, and Quick-add', async () => {
    mountShell(root, '/vault', 'KB');
    await tick();
    expect(root.querySelector('.bar')).not.toBeNull();
    const search = root.querySelector('#globalSearch');
    expect(search).not.toBeNull();
    expect(search!.querySelector('.kbd')?.textContent).toBe('⌘K');
    expect(root.querySelector('#topctx')).not.toBeNull(); // the per-view contextual slot exists (VUX-3)
    expect(root.querySelector('.quickadd')).not.toBeNull();
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
