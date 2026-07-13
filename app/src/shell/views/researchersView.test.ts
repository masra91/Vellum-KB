// @vitest-environment happy-dom
//
// SPEC-0028 RESEARCH-15/17 — "The Field Desk" Researchers Manage view, component tier (happy-dom).
// IPC mocked; we assert the rendered instrument strips, the §6 anti-generic guardrails (custom
// clearance ladder + segmented selectors + tiles, NO native <select>), the risky-change confirm gate,
// the typed dispatch report (found/nothing/failed/paused), add-from-tile, and escaping.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountResearchers } from './researchersView';
import type { ResearcherView, KbApi } from '../../kb/types';

const base: Omit<ResearcherView, 'id' | 'template' | 'label' | 'egressTier'> = { prompt: 'find prior art', repoPath: '', prRepo: '', tenantId: '', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: ['atlas'], budget: { maxToolCalls: 8, maxDepth: 2 }, timeoutMs: 15 * 60_000, orientBudget: 5, allowedTools: [], lastRun: null };
const webRow: ResearcherView = { ...base, id: 'web-1', template: 'web', label: 'Prior art', egressTier: 'public-web' };
const codeRow: ResearcherView = { ...base, id: 'code-1', template: 'code', label: 'Repo', repoPath: '/repos/app', prRepo: 'octocat/hello-world', egressTier: 'local-only', topics: [] };
const m365Row: ResearcherView = { ...base, id: 'm365-1', template: 'm365', label: 'WorkIQ', tenantId: 'acme.onmicrosoft.com', egressTier: 'internal-tenant', topics: [] };

let listResearchers: ReturnType<typeof vi.fn>;
let setResearcherConfig: ReturnType<typeof vi.fn>;
let removeResearcher: ReturnType<typeof vi.fn>;
let runResearcherNow: ReturnType<typeof vi.fn>;
let listResearcherRuns: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listResearchers: listResearchers as unknown as KbApi['listResearchers'],
    setResearcherConfig: setResearcherConfig as unknown as KbApi['setResearcherConfig'],
    removeResearcher: removeResearcher as unknown as KbApi['removeResearcher'],
    runResearcherNow: runResearcherNow as unknown as KbApi['runResearcherNow'],
    listResearcherRuns: listResearcherRuns as unknown as KbApi['listResearcherRuns'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listResearchers = vi.fn(async () => [webRow]);
  setResearcherConfig = vi.fn(async () => [{ ...webRow, enabled: true }]);
  removeResearcher = vi.fn(async () => []);
  runResearcherNow = vi.fn(async () => ({ ran: true, sourceIds: ['SRC1'], note: 'ok' }));
  listResearcherRuns = vi.fn(async () => []);
  setApi();
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  // #510: mountResearchers() now only builds the skeleton + returns lifecycle hooks; show() (which the
  // shell calls right after mount) is what actually loads + paints — mirror that here.
  mountResearchers(c).show?.();
  await flush();
  return c;
}

describe('Field Desk — render (RESEARCH-15)', () => {
  it('renders one instrument strip per researcher: id + named kind + clearance ladder + reach readout', async () => {
    const c = await mount();
    expect(c.querySelectorAll('.rdesk-strip')).toHaveLength(1);
    expect(c.querySelector('.rdesk-id')?.textContent).toBe('web-1');
    expect(c.querySelector('.rdesk-kind')?.textContent).toContain('Public Web'); // named kind + glyph
    expect(c.querySelectorAll('.rdesk-rung')).toHaveLength(3); // clearance ladder: local · internal · public
    expect(c.querySelector<HTMLInputElement>('.rdesk-reach .researcher-maxcalls')?.value).toBe('8'); // editable budget (WS3)
    expect(c.querySelector<HTMLInputElement>('.rdesk-reach .researcher-maxdepth')?.value).toBe('2'); // editable depth (WS3 Slice-2)
    expect(c.querySelector('.rdesk-reach-ro')?.textContent).toContain('tools:'); // read-only tail = the tool allowlist
  });

  it('the clearance ladder lights the active tier rung (public-web here), others ghosted', async () => {
    const c = await mount();
    const active = c.querySelector('.rdesk-rung[aria-checked="true"]');
    expect(active?.getAttribute('data-tier')).toBe('public-web');
    expect(c.querySelectorAll('.rdesk-rung[aria-checked="true"]')).toHaveLength(1);
  });

  it('a disabled researcher reads Paused; the strip carries its clearance + armed state for styling', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip')!;
    expect(strip.getAttribute('data-armed')).toBe('false');
    expect(strip.getAttribute('data-clearance')).toBe('public-web');
    expect(c.querySelector('.rdesk-arm')?.textContent).toContain('Paused');
  });

  it('shows the empty state + the add dock when there are no researchers', async () => {
    listResearchers = vi.fn(async () => []);
    setApi();
    const c = await mount();
    expect(c.querySelector('.rdesk-empty')).not.toBeNull();
    expect(c.querySelectorAll('.rdesk-tile').length).toBeGreaterThan(0);
  });

  it('degrades to a retryable error when listing fails (PANEL-9)', async () => {
    listResearchers = vi.fn(async () => {
      throw new Error('x');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error, .error')).not.toBeNull();
  });

  it('renders the last-run as a typed, state-coded report (never a raw slug)', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, lastRun: { ts: '2026-06-02T01:00:00.000Z', eventType: 'research-failed', what: 'Atlas', citations: 0 } }]);
    setApi();
    const c = await mount();
    const report = c.querySelector('.rdesk-report');
    expect(report?.getAttribute('data-state')).toBe('failed'); // failed reads distinctly (oxide), not calm
    expect(report?.textContent).toContain('run failed');
    expect(report?.textContent).not.toContain('research-failed'); // no dev slug
    // AA (KB-Design-Lead #184): the state hue rides the GLYPH flag (a graphic, ≥3:1), not the small
    // 0.82rem body text (which stays --viz-ink at 4.5:1) — so failed is distinct AND legible.
    expect(report?.querySelector('.rdesk-report-flag')).not.toBeNull();
  });
});

// VUX-17 (#524 §5) — every strip gets a chevron cue + click-to-open detail (identity + current config).
describe('Field Desk — VUX-17 drill-in shell', () => {
  it('clicking the chevron opens the detail with kind/clearance/schedule/autonomy/limits + most-recent-run', async () => {
    listResearchers = vi.fn(async () => [
      { ...webRow, schedule: 'daily', posture: 'autonomous', lastRun: { ts: '2026-06-02T01:00:00.000Z', eventType: 'researched', what: 'Atlas', citations: 3 } },
    ]);
    listResearcherRuns = vi.fn(async () => new Promise<never>(() => {})); // never resolves — assert the pre-fetch state
    setApi();
    const c = await mount();
    const strip = c.querySelector<HTMLElement>('.rdesk-strip[data-id="web-1"]')!;
    const chev = strip.querySelector<HTMLButtonElement>('.ag-drill')!;
    expect(chev.getAttribute('aria-expanded')).toBe('false');
    chev.click();
    const detail = strip.querySelector<HTMLElement>('.ag-detail')!;
    expect(detail.hidden).toBe(false);
    expect(chev.getAttribute('aria-expanded')).toBe('true');
    expect(detail.textContent).toContain('Public web'); // clearance
    expect(detail.textContent).toContain('Daily'); // schedule
    expect(detail.textContent).toContain('Autonomous'); // posture
    expect(detail.textContent).toContain('8'); // budget.maxToolCalls (base fixture)
    expect(detail.textContent).toContain('brought back'); // reportLine's real most-recent-run text
    chev.click();
    expect(detail.hidden).toBe(true);
  });

  it('does NOT open the detail when clicking an existing control (arm switch, clearance rung, Run button)', async () => {
    const c = await mount();
    const strip = c.querySelector<HTMLElement>('.rdesk-strip[data-id="web-1"]')!;
    strip.querySelector<HTMLButtonElement>('.rdesk-arm')!.click();
    expect(strip.querySelector<HTMLElement>('.ag-detail')?.hidden).toBe(true);
  });
});

// #559 — the real past-runs timeline (VUX-17 fast-follow), lazy-fetched via the (previously unwired)
// listResearcherRuns IPC.
describe('Field Desk — #559 past-runs timeline backfill', () => {
  it('the detail panel starts with no "Loading…"/placeholder text before it has ever been opened', async () => {
    const c = await mount();
    const strip = c.querySelector<HTMLElement>('.rdesk-strip[data-id="web-1"]')!;
    expect(strip.querySelector('.ag-detail')?.textContent).not.toContain('Loading…');
    expect(listResearcherRuns).not.toHaveBeenCalled(); // never opened → never fetched
  });

  it('renders a populated timeline (newest-first, per the audit stream) once the fetch resolves', async () => {
    listResearcherRuns = vi.fn(async () => [
      { ts: '2026-06-03T00:00:00.000Z', eventType: 'researched', what: 'Atlas licensing', citations: 2 },
      { ts: '2026-06-01T00:00:00.000Z', eventType: 'no-finding', what: 'Atlas licensing', citations: 0 },
    ]);
    setApi();
    const c = await mount();
    const strip = c.querySelector<HTMLElement>('.rdesk-strip[data-id="web-1"]')!;
    strip.querySelector<HTMLButtonElement>('.ag-drill')!.click();
    await flush();
    expect(listResearcherRuns).toHaveBeenCalledWith('web-1');
    const rows = strip.querySelectorAll('.ag-detail-run');
    expect(rows).toHaveLength(2);
    // Timestamp rendering is locale/timezone-dependent (formatTimestamp → shortDate); assert ordering via
    // the outcome text instead of the formatted date, which differs between local dev and UTC CI.
    expect(rows[0].textContent).toContain('brought back 2 cited sources'); // newest first (researched, 2026-06-03)
    expect(rows[1].textContent).toContain('no new findings'); // the older, second run (no-finding, 2026-06-01)
    expect(strip.querySelector('.ag-detail')?.textContent).not.toContain('Loading…');
  });

  it('renders an honest "No runs yet" empty state for a researcher that has never dispatched', async () => {
    listResearcherRuns = vi.fn(async () => []);
    setApi();
    const c = await mount();
    const strip = c.querySelector<HTMLElement>('.rdesk-strip[data-id="web-1"]')!;
    strip.querySelector<HTMLButtonElement>('.ag-drill')!.click();
    await flush();
    expect(strip.querySelectorAll('.ag-detail-run')).toHaveLength(0);
    expect(strip.textContent).toContain('No runs yet.');
  });

  it('fetches at most once across repeated open/close cycles on the same render', async () => {
    const c = await mount();
    const strip = c.querySelector<HTMLElement>('.rdesk-strip[data-id="web-1"]')!;
    const chev = strip.querySelector<HTMLButtonElement>('.ag-drill')!;
    chev.click(); // open (fetches)
    await flush();
    chev.click(); // close
    chev.click(); // open again (should NOT re-fetch)
    await flush();
    expect(listResearcherRuns).toHaveBeenCalledTimes(1);
  });
});

describe('Field Desk — escalation deep-link (RESEARCH-11; no dead affordance)', () => {
  const escalatedRow: ResearcherView = { ...webRow, lastRun: { ts: '2026-06-02T01:00:00.000Z', eventType: 'escalated', what: 'Atlas', citations: 0, reviewId: 'REV123' } };

  it('an escalated last-run renders an actionable "open review" link; a non-escalated one does NOT', async () => {
    listResearchers = vi.fn(async () => [escalatedRow]);
    setApi();
    const c = await mount();
    const link = c.querySelector<HTMLButtonElement>('.rdesk-review-link');
    expect(link).not.toBeNull(); // the escalation is actionable, not just a status line
    expect(link?.dataset.reviewId).toBe('REV123');
    // a ceiling-reached pause has no Review to open → no link
    listResearchers = vi.fn(async () => [{ ...webRow, lastRun: { ts: '2026-06-02T01:00:00.000Z', eventType: 'ceiling-reached', what: 'Atlas', citations: 0 } }]);
    setApi();
    const c2 = await mount();
    expect(c2.querySelector('.rdesk-review-link')).toBeNull();
  });

  it('clicking "open review" navigates to the Reviews view (dispatches kb:navigate)', async () => {
    listResearchers = vi.fn(async () => [escalatedRow]);
    setApi();
    const c = await mount();
    let navigatedTo: string | null = null;
    document.addEventListener('kb:navigate', (e) => (navigatedTo = (e as CustomEvent).detail?.view), { once: true });
    c.querySelector<HTMLButtonElement>('.rdesk-review-link')!.click();
    expect(navigatedTo).toBe('reviews'); // VIEW_REVIEWS — opens the queue where the Review awaits
  });
});

describe('Field Desk — §6 anti-generic guardrails (GATE-1 watch-items)', () => {
  it('uses NO native <select> anywhere — kind, clearance, schedule, autonomy are all custom components', async () => {
    listResearchers = vi.fn(async () => [webRow, codeRow]);
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('select')).toHaveLength(0); // the whole point of the redesign
  });

  it('the clearance ladder + segmented selectors are radio-style custom controls', async () => {
    const c = await mount();
    expect(c.querySelector('.rdesk-ladder[role="radiogroup"]')).not.toBeNull();
    expect(c.querySelectorAll('.rdesk-seg [role="radiogroup"]').length).toBe(2); // schedule + autonomy
  });
});

describe('Field Desk — WS2: composes the shared design-system primitives (DESIGN-SYS)', () => {
  // The migration hoists the inline controls onto the canonical shared primitives (one source of
  // truth) WITHOUT changing behavior — so Jobs/Reviews compose the same kit. These assert the
  // primitive classes + their a11y contracts (the §9 GATE-2 watch-items) are on the rendered markup.
  it('SegmentedControl — schedule/autonomy are .viz-seg-opt in a .viz-seg radiogroup (neutral variant)', async () => {
    const c = await mount();
    const groups = Array.from(c.querySelectorAll('.viz-seg[role="radiogroup"]'));
    // ladder + schedule + autonomy all use the shared .viz-seg group
    expect(groups.length).toBe(3);
    const schedule = c.querySelector('.researcher-schedule');
    expect(schedule?.classList.contains('viz-seg')).toBe(true);
    expect(schedule?.getAttribute('role')).toBe('radiogroup');
    const opt = schedule?.querySelector('.viz-seg-opt');
    expect(opt).not.toBeNull();
    expect(opt?.getAttribute('role')).toBe('radio'); // proper radio semantics, not a <select>
    expect(opt?.hasAttribute('aria-checked')).toBe(true);
    // neutral segments are NOT clearance-tinted
    expect(c.querySelector('.researcher-schedule .viz-seg-opt--clearance')).toBeNull();
  });

  it('SegmentedControl — clearance ladder rungs are .viz-seg-opt--clearance carrying data-temp (hue+position, not color-only)', async () => {
    const c = await mount();
    const rungs = Array.from(c.querySelectorAll('.rdesk-ladder .viz-seg-opt--clearance'));
    expect(rungs).toHaveLength(3);
    // the active rung reads via aria-checked AND data-temp (consequence hue reinforced by the checked state)
    const active = c.querySelector('.rdesk-ladder .viz-seg-opt[aria-checked="true"]');
    expect(active?.getAttribute('data-temp')).toBe('public-web');
  });

  it('ConfirmInline — the confirm box composes .viz-confirm / __msg, and the confirm action is a .viz-btn--danger', async () => {
    const c = await mount();
    const confirm = c.querySelector('.researcher-confirm');
    expect(confirm?.classList.contains('viz-confirm')).toBe(true);
    expect(c.querySelector('.researcher-confirm-msg')?.classList.contains('viz-confirm__msg')).toBe(true);
    const go = c.querySelector('.researcher-confirm-go');
    expect(go?.classList.contains('viz-btn')).toBe(true);
    expect(go?.classList.contains('viz-btn--danger')).toBe(true); // destructive = oxide border (text stays ink, §2)
  });

  it('EditableField — the orders box is a .viz-field__input--multiline; captioned fields are .viz-field with .viz-field__input', async () => {
    listResearchers = vi.fn(async () => [codeRow]); // code row renders repo/PR fields too
    setApi();
    const c = await mount();
    const prompt = c.querySelector('.researcher-prompt');
    expect(prompt?.classList.contains('viz-field__input')).toBe(true);
    expect(prompt?.classList.contains('viz-field__input--multiline')).toBe(true);
    const field = c.querySelector('.rdesk-field.viz-field');
    expect(field).not.toBeNull();
    expect(field?.querySelector('.viz-field__label')).not.toBeNull(); // a real labelled control
    expect(field?.querySelector('input.viz-field__input')).not.toBeNull();
  });

  it('Button busy — dispatching toggles .viz-btn--busy on the run Button (then clears on completion)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    const run = c.querySelector<HTMLButtonElement>('.researcher-run')!;
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click(); // dispatch starts
    expect(run.classList.contains('viz-btn--busy')).toBe(true); // ember breathe while in-flight
    await flush(); // dispatch resolves → re-render; the fresh run button is no longer busy
    expect(c.querySelector('.researcher-run')?.classList.contains('viz-btn--busy')).toBe(false);
  });
});

describe('Field Desk — confirm gate (RESEARCH-8/15)', () => {
  it('arming (enable) reveals the consequence-worded confirm, then calls setResearcherConfig', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.rdesk-arm')!.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(false);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toMatch(/reach Public web/i);
    expect(setResearcherConfig).not.toHaveBeenCalled();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', enabled: true });
  });

  it('cancel on arm does not apply', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.rdesk-arm')!.click();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!.click();
    expect(setResearcherConfig).not.toHaveBeenCalled();
  });

  it('WIDENING clearance (a less-trusted rung) confirms; clicking the active rung is a no-op', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, egressTier: 'local-only' }]);
    setApi();
    const c = await mount();
    // click the active (local) rung → nothing
    c.querySelector<HTMLButtonElement>('.rdesk-rung[data-tier="local-only"]')!.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(true);
    // widen to public → confirm
    c.querySelector<HTMLButtonElement>('.rdesk-rung[data-tier="public-web"]')!.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(false);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toMatch(/widen/i);
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', egressTier: 'public-web' });
  });

  it('schedule change applies directly (steering, no confirm)', async () => {
    const c = await mount();
    const daily = Array.from(c.querySelectorAll<HTMLButtonElement>('.researcher-schedule .rdesk-seg-opt')).find((b) => b.dataset.value === 'daily')!;
    daily.click();
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', schedule: 'daily' });
  });

  it('autonomy → Autonomous confirms', async () => {
    const c = await mount();
    const auto = Array.from(c.querySelectorAll<HTMLButtonElement>('.researcher-posture .rdesk-seg-opt')).find((b) => b.dataset.value === 'autonomous')!;
    auto.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.hidden).toBe(false);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toMatch(/autonomous/i);
  });

  // WS1 #1: cancelling/confirming must DISMISS the confirm box and CLEAR its message. (The CSS `[hidden]`
  // guard that lets `hidden` actually hide it is asserted in confirmDismissCss.test.ts — happy-dom
  // applies no stylesheet, so the renderer contract verified here is the `hidden` attribute + cleared text.)
  it('REGRESSION (#1): cancelling the confirm hides it AND clears the stale prompt text', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.rdesk-arm')!.click();
    const confirm = c.querySelector<HTMLElement>('.researcher-confirm')!;
    expect(confirm.hidden).toBe(false);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).not.toBe('');
    c.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!.click();
    expect(confirm.hidden).toBe(true);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toBe(''); // no lingering message
  });
});

describe('Field Desk — WS1 fixes (#2 honest eligibility, #6 real-name confirm)', () => {
  it("REGRESSION (#2): an enabled researcher with schedule 'off' surfaces that it still runs on demand", async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, enabled: true, schedule: 'off' as const }]);
    setApi();
    const c = await mount();
    const elig = c.querySelector('.researcher-eligibility');
    expect(elig?.getAttribute('data-will-run')).toBe('true');
    expect(elig?.textContent).toMatch(/on demand/i);
    expect(elig?.textContent).not.toMatch(/won't run/i);
  });

  it('a disabled (PAUSED) researcher surfaces that it will not run', async () => {
    const c = await mount(); // webRow is enabled:false
    const elig = c.querySelector('.researcher-eligibility');
    expect(elig?.getAttribute('data-will-run')).toBe('false');
    expect(elig?.textContent).toMatch(/won't run|paused/i);
  });

  it("REGRESSION (#6): the run-now confirm names the researcher, not the generic template word", async () => {
    // A bare code researcher whose name (id) the panel surfaced as the label — the confirm must say its
    // name, never "code". (webRow-style row with a code template + name-as-label.)
    listResearchers = vi.fn(async () => [{ ...codeRow, label: 'azure-sdk-repo' }]);
    setApi();
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    const msg = c.querySelector('.researcher-confirm-msg')?.textContent ?? '';
    expect(msg).toContain('azure-sdk-repo');
    expect(msg).not.toMatch(/“code”|"code"/); // not the generic template word
  });
});

describe('Field Desk — dispatch → typed report (RESEARCH-15; #160/#180)', () => {
  async function dispatch(c: HTMLElement): Promise<void> {
    c.querySelector<HTMLButtonElement>('.researcher-run')!.click();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
  }

  it('found → "brought back N cited sources"', async () => {
    const c = await mount();
    await dispatch(c);
    expect(runResearcherNow).toHaveBeenCalledWith('web-1');
    expect(c.querySelector('.researcher-status')?.textContent).toMatch(/brought back 1 cited source/i);
  });

  it('a ceiling-blocked dispatch reads PAUSED, never "nothing new" (ceiling ≠ empty, RESEARCH-11)', async () => {
    runResearcherNow = vi.fn(async () => ({ ran: true, sourceIds: [], note: 'ceiling', ceilingReached: true }));
    setApi();
    const c = await mount();
    await dispatch(c);
    const s = c.querySelector('.researcher-status')?.textContent ?? '';
    expect(s).toMatch(/paused/i);
    expect(s).toMatch(/rate limit/i);
    expect(s).not.toMatch(/nothing new/i);
  });

  it('a failed dispatch reads as an error, never empty (failed ≠ empty, #160)', async () => {
    runResearcherNow = vi.fn(async () => ({ ran: true, sourceIds: [], note: 'fail', failed: true, error: 'spawn copilot ENOENT' }));
    setApi();
    const c = await mount();
    await dispatch(c);
    const s = c.querySelector('.researcher-status')?.textContent ?? '';
    expect(s).toMatch(/couldn't run/i);
    expect(s).toMatch(/ENOENT/);
    expect(s).not.toMatch(/nothing new/i);
  });
});

describe('Field Desk — add via named tile', () => {
  it('pick a tile + name + re-click creates a DISARMED researcher with the chosen template + slug id', async () => {
    listResearchers = vi.fn(async () => []);
    setApi();
    const c = await mount();
    const codeTile = c.querySelector<HTMLButtonElement>('.rdesk-tile[data-template="code"]')!;
    codeTile.click(); // select
    expect(codeTile.getAttribute('aria-pressed')).toBe('true');
    (c.querySelector<HTMLInputElement>('.researcher-add-id')!).value = 'My Repo Reader';
    codeTile.click(); // re-click the chosen tile = dispatch
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'my-repo-reader', template: 'code', egressTier: 'local-only', enabled: false });
  });

  it('add with an empty name asks for one (no IPC call)', async () => {
    listResearchers = vi.fn(async () => []);
    setApi();
    const c = await mount();
    const tile = c.querySelector<HTMLButtonElement>('.rdesk-tile[data-template="web"]')!;
    tile.click();
    tile.click(); // re-click with empty name
    await flush();
    expect(setResearcherConfig).not.toHaveBeenCalled();
    expect(c.querySelector('.researcher-add-status')?.textContent).toMatch(/name/i);
  });
});

describe('Field Desk — XSS safety', () => {
  it('escapes a hostile researcher label/id', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, id: 'web-1', label: '<img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull();
  });
});

describe('Field Desk — WS3/warm-start editable budget + timeout + orient + depth (RESEARCH-15/18/22/11)', () => {
  it('renders editable reads/pass + orient/pass + timeout + depth fields seeded from the view-model', async () => {
    const c = await mount(); // webRow: budget.maxToolCalls 8, maxDepth 2, timeoutMs 15min, orientBudget 5
    const calls = c.querySelector<HTMLInputElement>('.researcher-maxcalls');
    const orient = c.querySelector<HTMLInputElement>('.researcher-orient');
    const timeout = c.querySelector<HTMLInputElement>('.researcher-timeout');
    const depth = c.querySelector<HTMLInputElement>('.researcher-maxdepth');
    expect(calls?.value).toBe('8');
    expect(orient?.value).toBe('5'); // orient budget (warm-start)
    expect(timeout?.value).toBe('15'); // 15 min
    expect(depth?.value).toBe('2'); // maxDepth (WS3 Slice-2)
    // They use the WS2 EditableField primitive (viz-field__input), not bespoke chrome.
    expect(calls?.classList.contains('viz-field__input')).toBe(true);
    expect(orient?.classList.contains('viz-field__input')).toBe(true);
    expect(timeout?.classList.contains('viz-field__input')).toBe(true);
    expect(depth?.classList.contains('viz-field__input')).toBe(true);
  });

  it('editing orient/pass persists via setResearcherConfig({orientBudget}) (warm-start, RESEARCH-22)', async () => {
    const c = await mount();
    const orient = c.querySelector<HTMLInputElement>('.researcher-orient')!;
    orient.value = '8';
    orient.dispatchEvent(new Event('change'));
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', orientBudget: 8 });
  });

  it('editing reads/pass persists via setResearcherConfig({maxToolCalls})', async () => {
    const c = await mount();
    const calls = c.querySelector<HTMLInputElement>('.researcher-maxcalls')!;
    calls.value = '40';
    calls.dispatchEvent(new Event('change'));
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', maxToolCalls: 40 });
  });

  it('editing timeout persists via setResearcherConfig({timeoutMs}) — minutes → ms', async () => {
    const c = await mount();
    const timeout = c.querySelector<HTMLInputElement>('.researcher-timeout')!;
    timeout.value = '25';
    timeout.dispatchEvent(new Event('change'));
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', timeoutMs: 25 * 60_000 });
  });

  it('editing depth persists via setResearcherConfig({maxDepth}) (WS3 Slice-2, RESEARCH-11)', async () => {
    const c = await mount();
    const depth = c.querySelector<HTMLInputElement>('.researcher-maxdepth')!;
    depth.value = '4';
    depth.dispatchEvent(new Event('change'));
    await flush();
    expect(setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', maxDepth: 4 });
  });

  it('the tool allowlist stays READ-ONLY — reads/pass + orient + timeout + depth are editable (security/scope)', async () => {
    listResearchers = vi.fn(async () => [{ ...webRow, allowedTools: ['fetch', 'web_search'], budget: { maxToolCalls: 8, maxDepth: 2 } }]);
    setApi();
    const c = await mount();
    // FOUR editable number inputs in the reach readout (reads/pass + orient + timeout + depth) — never one for tools.
    expect(c.querySelectorAll('.rdesk-reach input').length).toBe(4);
    const ro = c.querySelector('.rdesk-reach-ro');
    expect(ro?.textContent).toMatch(/tools: fetch · web_search/); // allowlist shown as read-only text
    expect(ro?.querySelector('input')).toBeNull(); // no editable control for the tool allowlist (security surface)
  });
});

describe('Field Desk — WorkIQ connector install/status card (WORKIQ-UI)', () => {
  // The card drives DEV-3's WORKIQ-FIX IPC. We set window.kbApi directly so we can add the two new
  // channels alongside listResearchers (which serves an m365 strip).
  function setWorkIqApi(over: Partial<KbApi>): void {
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      listResearchers: vi.fn(async () => [m365Row]) as unknown as KbApi['listResearchers'],
      setResearcherConfig: vi.fn(async () => [m365Row]) as unknown as KbApi['setResearcherConfig'],
      runResearcherNow: vi.fn(async () => ({ ran: true, sourceIds: [], note: 'ok' })) as unknown as KbApi['runResearcherNow'],
      ...over,
    };
  }

  it('renders the card ONLY on the m365 strip — not on web/code strips', async () => {
    setWorkIqApi({
      listResearchers: vi.fn(async () => [webRow, codeRow]) as unknown as KbApi['listResearchers'],
      workIqStatus: vi.fn(async () => ({ installed: true, installCommand: 'npm install -g @workiq/cli', cliPath: '/bin/workiq' })) as unknown as KbApi['workIqStatus'],
    });
    const c = await mount();
    await flush();
    expect(c.querySelectorAll('.rdesk-workiq')).toHaveLength(0); // no m365 strip ⇒ no card
  });

  it('installed → patina (ok) dot, ✓ in the line, NO action button', async () => {
    setWorkIqApi({ workIqStatus: vi.fn(async () => ({ installed: true, installCommand: 'npm install -g @workiq/cli', cliPath: '/bin/workiq' })) as unknown as KbApi['workIqStatus'] });
    const c = await mount();
    await flush();
    const card = c.querySelector('.rdesk-workiq')!;
    expect(card.getAttribute('data-state')).toBe('installed');
    expect(card.querySelector('.rdesk-workiq-status')?.getAttribute('data-tone')).toBe('ok');
    expect(card.querySelector('.rdesk-workiq-text')?.textContent).toContain('✓');
    expect(card.querySelector<HTMLButtonElement>('.rdesk-workiq-action')?.hidden).toBe(true);
    expect(card.querySelector('.rdesk-workiq-detail')?.textContent).toBe('/bin/workiq'); // resolved CLI path
  });

  it('not-installed → BRASS (wait) dot (not oxide) + a visible Install button (the actionable state)', async () => {
    setWorkIqApi({ workIqStatus: vi.fn(async () => ({ installed: false, installCommand: 'npm install -g @workiq/cli', detail: 'connector CLI not found' })) as unknown as KbApi['workIqStatus'] });
    const c = await mount();
    await flush();
    const card = c.querySelector('.rdesk-workiq')!;
    expect(card.querySelector('.rdesk-workiq-status')?.getAttribute('data-tone')).toBe('wait');
    const btn = card.querySelector<HTMLButtonElement>('.rdesk-workiq-action')!;
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toBe('Install');
  });

  it('clicking Install drives installing → installed via installWorkIq (live feedback, not silent)', async () => {
    const installWorkIq = vi.fn(async () => ({ ok: true, status: { installed: true as const, installCommand: 'npm install -g @workiq/cli', cliPath: '/bin/workiq' } }));
    setWorkIqApi({
      workIqStatus: vi.fn(async () => ({ installed: false, installCommand: 'npm install -g @workiq/cli', detail: 'not found' })) as unknown as KbApi['workIqStatus'],
      installWorkIq: installWorkIq as unknown as KbApi['installWorkIq'],
    });
    const c = await mount();
    await flush();
    const card = c.querySelector('.rdesk-workiq')!;
    card.querySelector<HTMLButtonElement>('.rdesk-workiq-action')!.click();
    await flush();
    expect(installWorkIq).toHaveBeenCalledOnce();
    expect(card.getAttribute('data-state')).toBe('installed');
    expect(card.querySelector('.rdesk-workiq-status')?.getAttribute('data-tone')).toBe('ok');
  });

  it('a failed install → OXIDE (error) + a Retry button + the surfaced failure detail (#160: never silent)', async () => {
    setWorkIqApi({
      workIqStatus: vi.fn(async () => ({ installed: false, installCommand: 'npm install -g @workiq/cli', detail: 'not found' })) as unknown as KbApi['workIqStatus'],
      installWorkIq: vi.fn(async () => ({ ok: false, error: 'npm exited 1', status: { installed: false as const, installCommand: 'npm install -g @workiq/cli' } })) as unknown as KbApi['installWorkIq'],
    });
    const c = await mount();
    await flush();
    const card = c.querySelector('.rdesk-workiq')!;
    card.querySelector<HTMLButtonElement>('.rdesk-workiq-action')!.click();
    await flush();
    expect(card.getAttribute('data-state')).toBe('install-failed');
    expect(card.querySelector('.rdesk-workiq-status')?.getAttribute('data-tone')).toBe('error');
    expect(card.querySelector('.rdesk-workiq-action')?.textContent).toBe('Retry');
    expect(card.querySelector('.rdesk-workiq-detail')?.textContent).toBe('npm exited 1');
  });

  it('degrades honestly when the IPC handler is absent (WORKIQ-FIX not landed) → error + Recheck, never a dead control', async () => {
    setWorkIqApi({}); // no workIqStatus ⇒ window.kbApi.workIqStatus is undefined → call throws
    const c = await mount();
    await flush();
    const card = c.querySelector('.rdesk-workiq')!;
    expect(card.getAttribute('data-state')).toBe('error');
    expect(card.querySelector('.rdesk-workiq-status')?.getAttribute('data-tone')).toBe('error');
    expect(card.querySelector('.rdesk-workiq-action')?.textContent).toBe('Recheck');
  });
});

// PANEL-11 lifecycle delete — a user-added researcher is REMOVABLE (not merely disable-forever): a Retire
// affordance behind a DESTRUCTIVE confirm. Sources it produced + its audit trail are RETAINED — the
// confirm copy makes that explicit; only the config is purged.
describe('Field Desk — lifecycle delete / Retire (PANEL-11)', () => {
  it('every researcher strip carries a Retire affordance', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="web-1"]')!;
    expect(strip.querySelector('.researcher-remove')).toBeTruthy();
    // The strip's shared confirm action is the danger-styled affordance the destructive Retire reuses.
    expect(strip.querySelector('.researcher-confirm-go')?.classList.contains('viz-btn--danger')).toBe(true);
  });

  it('Retire reveals a destructive confirm worded to RETAIN already-produced sources; gated until confirm', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-remove')!.click();
    const confirm = c.querySelector<HTMLElement>('.researcher-confirm')!;
    expect(confirm.hidden).toBe(false);
    // Destructive → the frame goes oxide to match the danger go-button (DL ConfirmInline coherence).
    expect(confirm.classList.contains('viz-confirm--danger')).toBe(true);
    expect(c.querySelector('.researcher-confirm-msg')?.textContent).toMatch(/Retire .*stay in your library/i);
    expect(removeResearcher).not.toHaveBeenCalled(); // gated — not purged yet
    c.querySelector<HTMLButtonElement>('.researcher-confirm-go')!.click();
    await flush();
    expect(removeResearcher).toHaveBeenCalledWith('web-1');
  });

  it('the danger frame is per-action — a benign arm confirm is NOT oxide, and Retire→cancel→arm resets it', async () => {
    const c = await mount();
    // Retire shows the oxide frame...
    c.querySelector<HTMLButtonElement>('.researcher-remove')!.click();
    expect(c.querySelector<HTMLElement>('.researcher-confirm')!.classList.contains('viz-confirm--danger')).toBe(true);
    // ...cancel, then arm (egress caution, not destructive) → frame must be back to the brass default.
    c.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!.click();
    c.querySelector<HTMLButtonElement>('.rdesk-arm')!.click();
    const confirm = c.querySelector<HTMLElement>('.researcher-confirm')!;
    expect(confirm.hidden).toBe(false);
    expect(confirm.classList.contains('viz-confirm--danger')).toBe(false);
  });

  it('cancelling Retire purges nothing', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.researcher-remove')!.click();
    c.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!.click();
    await flush();
    expect(removeResearcher).not.toHaveBeenCalled();
  });

  // ENG-15/16 render safety: a legacy/partial researcher row must not crash the view, and per-row
  // isolation keeps a well-formed neighbor's Retire affordance intact.
  it('renders a partial/legacy researcher row without crashing, keeping per-row Retire', async () => {
    const partial = { id: 'legacy', template: 'web', label: 'Legacy' } as unknown as ResearcherView; // missing budget/topics/etc.
    listResearchers = vi.fn(async () => [partial, webRow]);
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('.rdesk-strip[data-id]').length).toBe(2); // both rows rendered, neither crashed
    expect(c.querySelector('.rdesk-strip[data-id="legacy"] .researcher-remove')).toBeTruthy();
    expect(c.querySelector('.rdesk-strip[data-id="web-1"] .researcher-remove')).toBeTruthy();
  });
});
