// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-2/7 — the Jobs view, in the component tier (SPEC-0012 TEST-5; happy-dom via
// per-file env, node tier stays default). The IPC is mocked (`window.kbApi`); we assert the rendered
// DOM, that risky changes (enable, posture→Autonomous, Run now) gate behind a confirm before calling
// IPC, and that non-risky changes (disable, cadence) apply directly. The pure merge/risk logic is
// covered separately in `kb/jobsPanel.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountJobs } from './jobsView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { JobView, KbApi } from '../../kb/types';

function job(over: Partial<JobView> & Pick<JobView, 'id'>): JobView {
  return {
    type: over.id,
    label: 'Reflect',
    description: 'reviews your library',
    production: true,
    registered: false,
    enabled: false,
    schedule: 'off',
    posture: 'guarded',
    facing: 'internal',
    workDepth: null,
    lastRun: null,
    ...over,
  };
}

type JobsApi = Pick<KbApi, 'listJobs' | 'setJobConfig' | 'runJobNow'>;
function setApi(api: JobsApi): void {
  (window as unknown as { kbApi: JobsApi }).kbApi = api;
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function li(root: HTMLElement, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`.job[data-id="${id}"]`)!;
}

describe('Jobs view (SPEC-0027 PANEL-2/7)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  it('lists jobs with label, reference badge, and last-run summary (PANEL-2)', async () => {
    setApi({
      listJobs: vi.fn(async () => [
        job({ id: 'reflect', label: 'Reflect', production: true }),
        job({
          id: 'example',
          label: 'Entity census',
          production: false,
          registered: true,
          enabled: true,
          schedule: 'hourly',
          lastRun: { ts: '2026-06-02T07:00:00.000Z', inspected: 'entities/ (3 nodes)', applied: 1, deferred: 2 },
        }),
      ]),
      setJobConfig: vi.fn(),
      runJobNow: vi.fn(),
    });
    await mountJobs(root);

    expect(root.querySelector('.job-sub')?.textContent).toContain('Recurring'); // section sub-note (hub owns the "Schedules" title — WS-E)
    expect(root.querySelectorAll('.job')).toHaveLength(2);
    expect(li(root, 'reflect').querySelector('.job-label')?.textContent).toBe('Reflect');
    // The non-production reference job is badged (a viz-chip); the production one is not.
    expect(li(root, 'example').querySelector('.job-badge')).toBeTruthy();
    expect(li(root, 'reflect').querySelector('.job-badge')).toBeNull();
    expect(li(root, 'example').querySelector('.job-lastrun')?.textContent).toContain('1 applied, 2 deferred');
    expect(li(root, 'reflect').querySelector('.job-lastrun')?.textContent).toContain('Never run');
  });

  it('ENG-16: a legacy/partial last-run (missing JOBS-8 counts) renders neutral, never "undefined"', async () => {
    // Regression: the run detail read "inspected undefined; undefined applied, undefined deferred"
    // when a legacy journal entry reached the view without the counts. The render must default — a
    // missing count → 0, a missing/blank inspected → "—" — never the literal "undefined".
    setApi({
      listJobs: vi.fn(async () => [
        // A legacy entry that slipped past read-normalization — only ts/runId, no counts. Cast through
        // unknown to model the malformed shape the trust boundary must tolerate.
        job({ id: 'reflect', lastRun: { ts: '2026-06-01T00:00:00.000Z', runId: 'OLD' } as unknown as JobView['lastRun'] }),
      ]),
      setJobConfig: vi.fn(),
      runJobNow: vi.fn(),
    });
    await mountJobs(root);

    const text = li(root, 'reflect').querySelector('.job-lastrun')?.textContent ?? '';
    expect(text).not.toContain('undefined');
    expect(text).toContain('0 applied, 0 deferred');
    expect(text).toContain('inspected —');
  });

  it('shows a friendly empty state when there are no jobs (PANEL-9)', async () => {
    setApi({ listJobs: vi.fn(async () => []), setJobConfig: vi.fn(), runJobNow: vi.fn() });
    await mountJobs(root);
    expect(root.textContent).toContain('open a library');
  });

  it('enabling a job is risky: confirms first, then persists on confirm (PANEL-7)', async () => {
    const setJobConfig = vi.fn(async () => [job({ id: 'reflect', enabled: true, registered: true })]);
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig, runJobNow: vi.fn() });
    await mountJobs(root);

    const row = li(root, 'reflect');
    const arm = row.querySelector<HTMLButtonElement>('.job-enabled')!; // arm switch (role=switch), not a checkbox
    expect(arm.getAttribute('aria-checked')).toBe('false');
    arm.click();

    // Confirm is revealed; nothing persisted yet.
    expect(row.querySelector<HTMLElement>('.job-confirm')!.hidden).toBe(false);
    expect(setJobConfig).not.toHaveBeenCalled();

    row.querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();
    expect(setJobConfig).toHaveBeenCalledWith({ id: 'reflect', type: 'reflect', enabled: true });
  });

  it('PANEL-11 gate: a built-in job is DISABLE-ONLY — it has an enable/disable switch but NO delete/retire affordance', async () => {
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig: vi.fn(), runJobNow: vi.fn() });
    await mountJobs(root);
    const row = li(root, 'reflect');
    // Built-in entities (the autonomous-job catalog) are disable-forever, not deletable — the lifecycle-delete
    // gate (user-added → removable; built-in → disable-only) means no remove/retire/delete control here.
    expect(row.querySelector('.job-enabled')).toBeTruthy(); // can disable
    expect(row.querySelector('.job-remove, .job-delete, .job-retire')).toBeNull(); // cannot delete
  });

  it('cancelling a risky change reverts the control and does not persist (PANEL-7)', async () => {
    const setJobConfig = vi.fn();
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig, runJobNow: vi.fn() });
    await mountJobs(root);

    const row = li(root, 'reflect');
    const arm = row.querySelector<HTMLButtonElement>('.job-enabled')!;
    arm.click();
    row.querySelector<HTMLButtonElement>('.job-confirm-cancel')!.click();
    await tick();

    expect(setJobConfig).not.toHaveBeenCalled();
    // the switch never flips until an apply re-renders, so a cancelled change needs no revert
    expect(arm.getAttribute('aria-checked')).toBe('false');
    expect(row.querySelector<HTMLElement>('.job-confirm')!.hidden).toBe(true);
  });

  it('changing the schedule is not risky — persists directly (PANEL-2)', async () => {
    const setJobConfig = vi.fn(async () => [job({ id: 'reflect', schedule: 'daily' })]);
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig, runJobNow: vi.fn() });
    await mountJobs(root);

    const daily = li(root, 'reflect').querySelector<HTMLButtonElement>('.job-schedule .viz-seg-opt[data-value="daily"]')!;
    daily.click();
    await tick();
    expect(setJobConfig).toHaveBeenCalledWith({ id: 'reflect', type: 'reflect', schedule: 'daily' });
  });

  it('moving to Autonomous posture is risky — confirms first (PANEL-7)', async () => {
    const setJobConfig = vi.fn(async () => [job({ id: 'reflect', posture: 'autonomous' })]);
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig, runJobNow: vi.fn() });
    await mountJobs(root);

    const row = li(root, 'reflect');
    const auto = row.querySelector<HTMLButtonElement>('.job-posture .viz-seg-opt[data-value="autonomous"]')!;
    auto.click();
    expect(row.querySelector<HTMLElement>('.job-confirm')!.hidden).toBe(false);
    expect(setJobConfig).not.toHaveBeenCalled();

    row.querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();
    expect(setJobConfig).toHaveBeenCalledWith({ id: 'reflect', type: 'reflect', posture: 'autonomous' });
  });

  it('Run now confirms, calls IPC, and reports the outcome (PANEL-2/JOBS-11)', async () => {
    const runJobNow = vi.fn(async () => ({ ran: true as const, outcome: 'advanced' as const, applied: 2, deferred: 1 }));
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig: vi.fn(), runJobNow });
    await mountJobs(root);

    const row = li(root, 'reflect');
    row.querySelector<HTMLButtonElement>('.job-run')!.click();
    expect(row.querySelector<HTMLElement>('.job-confirm')!.hidden).toBe(false);
    expect(runJobNow).not.toHaveBeenCalled();

    row.querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();
    expect(runJobNow).toHaveBeenCalledWith('reflect');
    expect(li(root, 'reflect').querySelector('.job-status')?.textContent).toContain('2 applied, 1 deferred');
  });

  it('Run now shows a clear running state on the button (PANEL-10) then resets on completion', async () => {
    type RunOk = { ran: true; outcome: 'advanced'; applied: number; deferred: number };
    let resolveRun!: (v: RunOk) => void;
    const runJobNow = vi.fn((): Promise<RunOk> => new Promise<RunOk>((res) => (resolveRun = res)));
    setApi({ listJobs: vi.fn(async () => [job({ id: 'reflect' })]), setJobConfig: vi.fn(), runJobNow });
    await mountJobs(root);
    li(root, 'reflect').querySelector<HTMLButtonElement>('.job-run')!.click();
    li(root, 'reflect').querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();

    const runBtn = li(root, 'reflect').querySelector<HTMLButtonElement>('.job-run')!;
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.textContent).toBe('Running…');

    resolveRun({ ran: true, outcome: 'advanced', applied: 1, deferred: 0 });
    await tick();
    const after = li(root, 'reflect').querySelector<HTMLButtonElement>('.job-run')!;
    expect(after.disabled).toBe(false);
    expect(after.textContent).toBe('Run now');
  });

  it('renders an error instead of throwing if listing fails (PANEL-9)', async () => {
    setApi({
      listJobs: vi.fn(async () => {
        throw new Error('boom');
      }),
      setJobConfig: vi.fn(),
      runJobNow: vi.fn(),
    });
    await mountJobs(root);
    expect(root.querySelector('.load-error')?.textContent).toContain('Couldn’t load'); // retryable fallback (#145)
    expect(root.querySelector('.load-retry')).toBeTruthy();
  });
});

describe('Jobs view · WS2 — composes the shared design-system primitives (no generic chrome)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  const oneJob = (): JobsApi => ({
    listJobs: vi.fn(async () => [job({ id: 'reflect', schedule: 'off', posture: 'guarded' })]),
    setJobConfig: vi.fn(),
    runJobNow: vi.fn(),
  });

  it('uses NO native <select> anywhere — schedule + autonomy are SegmentedControls (the generic-look fix)', async () => {
    setApi(oneJob());
    await mountJobs(root);
    expect(root.querySelectorAll('select')).toHaveLength(0);
    // schedule + autonomy are .viz-seg radiogroups of .viz-seg-opt radios
    const groups = Array.from(root.querySelectorAll('.viz-seg[role="radiogroup"]'));
    expect(groups.length).toBe(2);
    const sched = li(root, 'reflect').querySelector('.job-schedule')!;
    expect(sched.classList.contains('viz-seg')).toBe(true);
    expect(sched.getAttribute('role')).toBe('radiogroup');
    const opt = sched.querySelector('.viz-seg-opt')!;
    expect(opt.getAttribute('role')).toBe('radio');
    expect(opt.hasAttribute('aria-checked')).toBe(true);
    // the active schedule (off) reads via aria-checked, not color alone
    expect(sched.querySelector('.viz-seg-opt[data-value="off"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('enable is a role=switch arm (not a raw checkbox) reflecting the enabled state', async () => {
    setApi({ ...oneJob(), listJobs: vi.fn(async () => [job({ id: 'reflect', enabled: true })]) });
    await mountJobs(root);
    const arm = li(root, 'reflect').querySelector('.job-enabled')!;
    expect(arm.tagName).toBe('BUTTON');
    expect(arm.getAttribute('role')).toBe('switch');
    expect(arm.getAttribute('aria-checked')).toBe('true');
    expect(li(root, 'reflect').getAttribute('data-armed')).toBe('true'); // the strip carries armed state for the spine
  });

  it('Run now is a .viz-btn; the confirm composes .viz-confirm with a .viz-btn--danger confirm action', async () => {
    setApi(oneJob());
    await mountJobs(root);
    const row = li(root, 'reflect');
    expect(row.querySelector('.job-run')?.classList.contains('viz-btn')).toBe(true);
    expect(row.querySelector('.job-confirm')?.classList.contains('viz-confirm')).toBe(true);
    expect(row.querySelector('.job-confirm-msg')?.classList.contains('viz-confirm__msg')).toBe(true);
    const go = row.querySelector('.job-confirm-go')!;
    expect(go.classList.contains('viz-btn')).toBe(true);
    expect(go.classList.contains('viz-btn--danger')).toBe(true);
  });

  it('Run now toggles .viz-btn--busy while in-flight (then clears on completion)', async () => {
    type RunOk = { ran: true; outcome: 'advanced'; applied: number; deferred: number };
    let resolveRun!: (v: RunOk) => void;
    const runJobNow = vi.fn((): Promise<RunOk> => new Promise<RunOk>((res) => (resolveRun = res)));
    setApi({ ...oneJob(), runJobNow });
    await mountJobs(root);
    li(root, 'reflect').querySelector<HTMLButtonElement>('.job-run')!.click();
    li(root, 'reflect').querySelector<HTMLButtonElement>('.job-confirm-go')!.click();
    await tick();
    expect(li(root, 'reflect').querySelector('.job-run')?.classList.contains('viz-btn--busy')).toBe(true);
    resolveRun({ ran: true, outcome: 'advanced', applied: 1, deferred: 0 });
    await tick();
    expect(li(root, 'reflect').querySelector('.job-run')?.classList.contains('viz-btn--busy')).toBe(false);
  });
});

describe('Jobs view · #205 load resilience (no infinite spinner when data arrives but render throws)', () => {
  // The #145/#149 timeout closes the IPC-HANG half of the infinite-spinner class. These cover the half
  // it can't: the response ARRIVES (no hang, no timeout) but turning it into rows throws — which would
  // escape the fire-and-forget `mountJobs` and strand "Loading…" with the timeout already cleared.
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  it('exits the loading state on a clean all-disabled response — renders the rows, never stuck on Loading', async () => {
    setApi({
      listJobs: vi.fn(async () => [
        job({ id: 'reflect', enabled: false }),
        job({ id: 'example', production: false, enabled: false }),
      ]),
      setJobConfig: vi.fn(),
      runJobNow: vi.fn(),
    });
    await mountJobs(root);
    expect(root.textContent).not.toContain('Loading…'); // the transition completed
    expect(root.querySelectorAll('.job')).toHaveLength(2);
  });

  it('renders a job whose journal field is a non-string (legacy/untyped journal) instead of stranding Loading', async () => {
    // The registry/journal are parsed off disk with an unchecked `as JournalEntry`, so a legacy entry
    // can carry a numeric `inspected`. Pre-#205 `esc(5)` → `(5).replace(...)` threw mid-render and the
    // view spun forever; now the field is coerced and the row renders the value as text.
    const bad = job({
      id: 'example',
      registered: true,
      enabled: true,
      lastRun: { ts: '2026-06-02T07:00:00.000Z', inspected: 5 as unknown as string, applied: 1, deferred: 0 },
    });
    setApi({ listJobs: vi.fn(async () => [bad]), setJobConfig: vi.fn(), runJobNow: vi.fn() });
    await mountJobs(root);
    expect(root.textContent).not.toContain('Loading…');
    expect(li(root, 'example').querySelector('.job-lastrun')?.textContent).toContain('inspected 5');
  });

  it('a render that throws on a fetched response falls back to a retryable error, never an infinite spinner', async () => {
    // Data arrives (no hang, no timeout) but rendering throws — the gap #149's IPC-only timeout can't
    // catch. The whole load→render is now guarded, so we land on a retryable error, not "Loading…".
    const exploding = job({ id: 'reflect' });
    Object.defineProperty(exploding, 'label', {
      get(): string {
        throw new Error('render boom');
      },
    });
    const listJobs = vi.fn<KbApi['listJobs']>().mockResolvedValueOnce([exploding]);
    setApi({ listJobs, setJobConfig: vi.fn(), runJobNow: vi.fn() });
    await mountJobs(root);

    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.querySelector('.load-error')?.textContent).toContain('Couldn’t load');
    expect(root.querySelector('.load-retry')).toBeTruthy();

    // Retry re-runs the load; a healthy response now renders the list (belt-and-suspenders recovery).
    listJobs.mockResolvedValueOnce([job({ id: 'reflect' })]);
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await tick();
    expect(root.querySelector('.job[data-id="reflect"]')).toBeTruthy();
  });
});

describe('Jobs view · #145 load resilience (no infinite spinner on a hung IPC)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('times out a hung listJobs → retryable error, and Retry re-loads successfully', async () => {
    const listJobs = vi.fn<KbApi['listJobs']>().mockReturnValueOnce(new Promise<JobView[]>(() => {})); // hangs
    setApi({ listJobs, setJobConfig: vi.fn(), runJobNow: vi.fn() });
    const mounted = mountJobs(root); // blocked on the hung load
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull(); // skeleton initially (#520)
    expect(root.textContent).not.toContain('Loading…'); // never bare "Loading…" (#520 §8)

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    await mounted;
    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.querySelector('.load-error')).toBeTruthy();

    // Retry succeeds → the list renders.
    listJobs.mockResolvedValueOnce([job({ id: 'reflect' })]);
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0); // flush the (resolved) reload
    expect(root.querySelector('.job[data-id="reflect"]')).toBeTruthy();
  });
});
