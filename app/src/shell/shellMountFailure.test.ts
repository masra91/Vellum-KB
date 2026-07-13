// @vitest-environment happy-dom
//
// BUG-12 (#518): the shell cached a view's container BEFORE its (possibly async) mount settled, via a
// bare `void Promise.resolve(mounts[activeId]?.(el)).then(...)` with no `.catch`. A rejecting (or
// synchronously throwing) mount was telemetry-silent AND left the view a PERMANENTLY blank pane: since
// `containers.has(activeId)` stayed true forever, every later revisit fell into the "already mounted"
// branch and found no registered handle. Regression: a mount failure (either shape) must un-swallow to
// the app-log, render the shared retryable error face into the already-appended container, and Retry
// must re-invoke the mount against that SAME container (no relaunch required).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ViewHandle } from './viewLifecycle';
import type { KbApi, RendererErrorReport } from '../kb/types';

const h = vi.hoisted(() => ({ mountToday: vi.fn<(container: HTMLElement) => ViewHandle | void | Promise<ViewHandle | void>>() }));
vi.mock('./views/todayView', () => ({ mountToday: h.mountToday }));

import { mountShell } from './shell';
import { VIEW_TODAY } from './views';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function setApi(reportRendererError: KbApi['reportRendererError']): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listReviews: vi.fn(async () => []),
    pipelineStatus: vi.fn(async () => ({ queueDepth: 0, processing: null, lastArchived: null, updatedAt: null })),
    capture: vi.fn(),
    reportRendererError,
  };
}

function todayContainer(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>(`.view[data-view="${VIEW_TODAY}"]`)!;
}

describe('shell mount-failure recovery (BUG-12 #518)', () => {
  let root: HTMLElement;
  const reportRendererError = vi.fn<(report: RendererErrorReport) => Promise<void>>(async () => undefined);

  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    root = document.getElementById('app')!;
    reportRendererError.mockClear();
    h.mountToday.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('a mount that REJECTS (async) is un-swallowed to the app-log and renders a retryable error face, not a blank pane', async () => {
    setApi(reportRendererError);
    h.mountToday.mockImplementationOnce(async () => {
      throw new Error('today projection read failed');
    });
    mountShell(root, '/vault', 'KB');
    await tick();

    expect(reportRendererError).toHaveBeenCalledTimes(1);
    expect(reportRendererError.mock.calls[0][0].message).toContain('today projection read failed');

    const container = todayContainer(root);
    const retryBtn = container.querySelector<HTMLButtonElement>('.load-retry');
    expect(retryBtn).toBeTruthy(); // the retry affordance — never an empty/blank pane
    expect(container.innerHTML).not.toBe(''); // not a permanently blank pane
  });

  it('a mount that THROWS SYNCHRONOUSLY (never returns a promise) gets the SAME retryable fallback', async () => {
    setApi(reportRendererError);
    h.mountToday.mockImplementationOnce(() => {
      throw new Error('synchronous boom');
    });
    mountShell(root, '/vault', 'KB');
    await tick();

    expect(reportRendererError).toHaveBeenCalledTimes(1);
    expect(reportRendererError.mock.calls[0][0].message).toContain('synchronous boom');
    expect(todayContainer(root).querySelector('.load-retry')).toBeTruthy();
  });

  it('clicking Retry re-invokes the mount against the SAME container — a later success recovers the view (no relaunch needed)', async () => {
    setApi(reportRendererError);
    h.mountToday.mockImplementationOnce(async () => {
      throw new Error('first attempt fails');
    });
    mountShell(root, '/vault', 'KB');
    await tick();

    const container = todayContainer(root);
    const retryBtn = container.querySelector<HTMLButtonElement>('.load-retry')!;
    expect(retryBtn).toBeTruthy();

    h.mountToday.mockImplementationOnce((c: HTMLElement) => {
      c.innerHTML = '<div class="today-recovered"></div>';
      return { show: () => {}, hide: () => {} };
    });
    retryBtn.click();
    await tick();

    expect(h.mountToday).toHaveBeenCalledTimes(2); // retry genuinely re-invoked the mount
    expect(container.querySelector('.today-recovered')).toBeTruthy(); // the view is now usable
    expect(container.querySelector('.load-retry')).toBeFalsy(); // the error face is gone
  });

  it('a successful mount never touches the error/telemetry path (no false positives)', async () => {
    setApi(reportRendererError);
    h.mountToday.mockImplementationOnce((c: HTMLElement) => {
      c.innerHTML = '<div class="today-ok"></div>';
      return { show: () => {}, hide: () => {} };
    });
    mountShell(root, '/vault', 'KB');
    await tick();

    expect(reportRendererError).not.toHaveBeenCalled();
    expect(todayContainer(root).querySelector('.today-ok')).toBeTruthy();
    expect(todayContainer(root).querySelector('.load-retry')).toBeFalsy();
  });
});
