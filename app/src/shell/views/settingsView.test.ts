// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-5/7 — the elevated Settings view's autonomy-default control. IPC mocked; we assert
// the per-Instance default renders, that → Autonomous (risky) confirms before persisting and Guarded
// applies directly, and that cancel reverts. (The store + resolver logic is node-tested in
// instanceConfig.test.ts; Replay is covered by SPEC-0022's own tests.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountSettings } from './settingsView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { KbApi, InstanceSettings, ScaleRuntime } from '../../kb/types';

function setApi(autonomyDefault: 'guarded' | 'autonomous', setSpy?: KbApi['setInstanceSettings']): {
  set: ReturnType<typeof vi.fn>;
} {
  const set = vi.fn(setSpy ?? (async (s: InstanceSettings) => s));
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    getState: vi.fn(async () => ({ activeVaultPath: '/v', vaultConfig: { schemaVersion: 1, id: 'x', name: 'KB', createdAt: 't' } })),
    inspect: vi.fn(async () => ({ copilot: { available: true, detail: 'ok' } }) as Awaited<ReturnType<KbApi['inspect']>>),
    getInstanceSettings: vi.fn(async () => ({ autonomyDefault, devLogLevel: 'info' as const, quickCaptureAccelerator: 'Alt+Space' })),
    setInstanceSettings: set as KbApi['setInstanceSettings'],
  };
  return { set };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// WS3 (DESIGN-LEGACY-VIEWS §3): the autonomy + dev-log controls are SegmentedControls now — selecting
// is a CLICK (or Space/Enter) on a role=radio segment, not a <select> `change`. These helpers drive that.
const segOpt = (root: HTMLElement, groupId: string, value: string): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>(`#${groupId} [role="radio"][data-value="${value}"]`)!;
function pick(root: HTMLElement, groupId: string, value: string): void {
  segOpt(root, groupId, value).click();
}
/** The committed (aria-checked) value of a SegmentedControl. */
function checked(root: HTMLElement, groupId: string): string | null {
  const on = root.querySelector<HTMLElement>(`#${groupId} [role="radio"][aria-checked="true"]`);
  return on?.dataset.value ?? null;
}

describe('Settings · Autonomy default (SPEC-0027 PANEL-5/7)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the current Instance default posture', async () => {
    setApi('guarded');
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(checked(root, 'autonomy-default')).toBe('guarded');
  });

  it('UX v2 (SPEC-0058): scoped v2 material surface, Spectral head, no ⚙️ emoji', async () => {
    setApi('guarded');
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(root.querySelector('.settings-v2.viz-surface')).toBeTruthy(); // scoped material marker
    expect(root.querySelector('.settings-title.viz-voice')?.textContent).toBe('Settings'); // Spectral head, de-emoji'd
    expect(root.querySelector('.card')).toBeTruthy(); // sections still cards (now v2 material via scope)
    // no raw emoji in the rendered Settings (⚙️ head + ✅/⚠️ Copilot mark tokenized to a hue dot, #184)
    expect(/[\u{1F300}-\u{1FAFF}]|⚙️|✅|⚠️/u.test(root.textContent ?? '')).toBe(false);
  });

  it('SPEC-0058 theme-toggle: an Appearance Light/Dark control flips data-theme + persists, instantly', async () => {
    const store = new Map<string, string>(); // happy-dom localStorage is partial across versions
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string): string | null => store.get(k) ?? null, setItem: (k: string, v: string): void => void store.set(k, v), removeItem: (k: string): void => void store.delete(k), clear: (): void => store.clear() },
    });
    document.documentElement.removeAttribute('data-theme');
    setApi('guarded');
    mountSettings(root).show?.();
    await tick();
    await tick();
    // The Appearance segmented control renders with Light selected by default.
    const group = root.querySelector('#theme-select')!;
    expect(group).toBeTruthy();
    expect(group.querySelector('[role="radio"][data-value="light"]')?.getAttribute('aria-checked')).toBe('true');
    // Picking Dark flips the root data-theme + persists — no IPC, no confirm, instant.
    (group.querySelector('[role="radio"][data-value="dark"]') as HTMLButtonElement).click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('vellum.theme')).toBe('dark');
    expect(group.querySelector('[role="radio"][data-value="dark"]')?.getAttribute('aria-checked')).toBe('true');
    // Back to Light.
    (group.querySelector('[role="radio"][data-value="light"]') as HTMLButtonElement).click();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    document.documentElement.removeAttribute('data-theme'); // clean up the shared root for sibling tests
  });

  it('→ Autonomous confirms before persisting (PANEL-7)', async () => {
    const { set } = setApi('guarded');
    mountSettings(root).show?.();
    await tick();
    await tick();

    pick(root, 'autonomy-default', 'autonomous');
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(checked(root, 'autonomy-default')).toBe('guarded'); // not committed until confirmed

    (root.querySelector('#autonomy-go') as HTMLButtonElement).click();
    await tick();
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'autonomous', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' });
    expect(root.querySelector('#autonomy-status')?.textContent).toContain('Autonomous');
    expect(checked(root, 'autonomy-default')).toBe('autonomous'); // now committed
  });

  it('cancelling the confirm reverts the selection and does not persist', async () => {
    const { set } = setApi('guarded');
    mountSettings(root).show?.();
    await tick();
    await tick();
    pick(root, 'autonomy-default', 'autonomous');
    (root.querySelector('#autonomy-cancel') as HTMLButtonElement).click();
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(true);
    expect(checked(root, 'autonomy-default')).toBe('guarded'); // stayed on the saved posture
    expect(set).not.toHaveBeenCalled();
  });

  it('relaxing to Guarded applies directly (no confirm)', async () => {
    const { set } = setApi('autonomous');
    mountSettings(root).show?.();
    await tick();
    await tick();
    pick(root, 'autonomy-default', 'guarded');
    await tick();
    expect((root.querySelector('#autonomy-confirm') as HTMLElement).hidden).toBe(true);
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' });
    expect(checked(root, 'autonomy-default')).toBe('guarded');
  });
});

describe('Settings · Dev-log verbosity (SPEC-0030 OBS-10)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the current level and persists a change as the FULL settings (autonomy preserved)', async () => {
    const { set } = setApi('autonomous'); // devLogLevel defaults to info
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(checked(root, 'devlog-level')).toBe('info');

    pick(root, 'devlog-level', 'debug');
    await tick();
    // The whole settings object is sent — autonomyDefault not clobbered (no confirm; benign toggle).
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'autonomous', devLogLevel: 'debug', quickCaptureAccelerator: 'Alt+Space' });
    expect(root.querySelector('#verbosity-status')?.textContent).toContain('Debug');
    expect(checked(root, 'devlog-level')).toBe('debug');
  });
});

// WS3 migration (DESIGN-LEGACY-VIEWS §3): the native <select>s became SegmentedControls — an
// INTERACTION-CONTRACT change (change-event → role=radiogroup/aria-checked + arrow-key roving focus).
// These guard the contract itself (per the PM dispatch: regression-test it, not just restyle), plus the
// .viz-confirm / .viz-btn--danger composition and the no-legacy-primitive sweep.
describe('Settings · WS3 design-system migration (DESIGN-LEGACY-VIEWS §3 — onto The Line)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders both controls as blessed SegmentedControls (role=radiogroup of role=radio .viz-seg-opt), labelled', async () => {
    setApi('guarded');
    mountSettings(root).show?.();
    await tick();
    await tick();
    for (const [id, labelId] of [['autonomy-default', 'autonomy-label'], ['devlog-level', 'devlog-label']] as const) {
      const group = root.querySelector<HTMLElement>(`#${id}`)!;
      expect(group.classList.contains('viz-seg')).toBe(true);
      expect(group.getAttribute('role')).toBe('radiogroup');
      expect(group.getAttribute('aria-labelledby')).toBe(labelId);
      const radios = group.querySelectorAll('[role="radio"].viz-seg-opt');
      expect(radios).toHaveLength(2);
      radios.forEach((r) => expect(r.getAttribute('aria-checked')).toMatch(/^(true|false)$/));
    }
    expect(root.querySelector('select')).toBeNull(); // the native <select> interaction contract is gone
  });

  it('uses roving tabindex — only the checked segment is the tab stop (§3 a11y)', async () => {
    setApi('guarded');
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(segOpt(root, 'autonomy-default', 'guarded').tabIndex).toBe(0); // checked → in the tab order
    expect(segOpt(root, 'autonomy-default', 'autonomous').tabIndex).toBe(-1); // unchecked → roved out
  });

  it('roves focus with arrow keys WITHOUT committing; Space/Enter commits (selection ≠ focus)', async () => {
    const { set } = setApi('autonomous'); // devLogLevel = info
    mountSettings(root).show?.();
    await tick();
    await tick();
    const info = segOpt(root, 'devlog-level', 'info');
    const debug = segOpt(root, 'devlog-level', 'debug');
    info.focus();
    info.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // focus + roving tabindex moved to debug, but the selection has NOT changed yet (no save).
    expect(debug.tabIndex).toBe(0);
    expect(info.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(debug);
    expect(checked(root, 'devlog-level')).toBe('info');
    expect(set).not.toHaveBeenCalled();

    debug.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); // commit
    await tick();
    expect(set).toHaveBeenCalledWith({ autonomyDefault: 'autonomous', devLogLevel: 'debug', quickCaptureAccelerator: 'Alt+Space' });
    expect(checked(root, 'devlog-level')).toBe('debug');
  });

  it('composes the blessed .viz-confirm + .viz-btn--danger primitives (autonomy = caution, replay = danger)', async () => {
    setApi('guarded');
    mountSettings(root).show?.();
    await tick();
    await tick();
    const autoConfirm = root.querySelector<HTMLElement>('#autonomy-confirm')!;
    expect(autoConfirm.classList.contains('viz-confirm')).toBe(true);
    expect(autoConfirm.classList.contains('viz-confirm--danger')).toBe(false); // posture change = caution (brass)
    expect(root.querySelector('#autonomy-go')!.classList.contains('viz-btn--danger')).toBe(true);
    expect(root.querySelector('#autonomy-cancel')!.classList.contains('viz-btn')).toBe(true);

    const replayConfirm = root.querySelector<HTMLElement>('#replay-confirm')!;
    expect(replayConfirm.classList.contains('viz-confirm')).toBe(true);
    expect(replayConfirm.classList.contains('viz-confirm--danger')).toBe(true); // destructive → oxide
    expect(root.querySelector('#replay-go')!.classList.contains('viz-btn--danger')).toBe(true);
    expect(root.querySelector('#replay-btn')!.classList.contains('viz-btn--danger')).toBe(true);
  });

  it('carries NO legacy off-system primitives (.muted / legacy .confirm / .btn-danger / native select) on the success path', async () => {
    setApi('autonomous');
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(root.querySelector('.muted')).toBeNull(); // notes / copilot detail / dt all migrated
    expect(root.querySelector('.confirm')).toBeNull(); // confirms are .viz-confirm now (distinct token)
    expect([...root.querySelectorAll('button')].some((b) => b.classList.contains('btn-danger'))).toBe(false);
    expect([...root.querySelectorAll('button')].some((b) => b.classList.contains('btn'))).toBe(false); // .viz-btn ≠ .btn
    expect(root.querySelector('select')).toBeNull();
  });
});

// SPEC-0048 SCALE — the Scale card exposes the engine's stage-parallelism knobs (ORCH-20 caps +
// ORCH-23 ceiling) as live Settings. IPC mocked (echo); we assert the render reflects the resolved
// caps + ceiling mode, that the Auto/Manual toggle clears (null) vs sets the ceiling, that a stepper
// persists the FULL settings (preserve-on-omission), Connect is pinned/disabled (SCALE-5), and the
// bound-affordance + malformed-data tolerance (ENG-15/16) hold. (The clamp/merge is node-tested in
// instanceConfig + pipeline; here we cover the view + wiring contract.)
describe('Settings · Scale (SPEC-0048 SCALE — stage-parallelism knobs)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  function setScaleApi(instance: Partial<InstanceSettings> = {}, runtime: Partial<ScaleRuntime> = {}): { set: ReturnType<typeof vi.fn> } {
    const base: InstanceSettings = { autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' };
    const set = vi.fn(async (s: InstanceSettings) => s); // echo; the real backend merge is node-tested
    const rt: ScaleRuntime = { adaptive: true, effective: 4, reference: 4, throttled: false, backedOff: false, ...runtime };
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      getState: vi.fn(async () => ({ activeVaultPath: '/v', vaultConfig: { schemaVersion: 1, id: 'x', name: 'KB', createdAt: 't' } })),
      inspect: vi.fn(async () => ({ copilot: { available: true, detail: 'ok' } }) as Awaited<ReturnType<KbApi['inspect']>>),
      getInstanceSettings: vi.fn(async () => ({ ...base, ...instance })),
      setInstanceSettings: set as KbApi['setInstanceSettings'],
      getScaleRuntime: vi.fn(async () => rt),
    };
    return { set };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const stepper = (id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-stepper="${id}"]`)!;
  const stepperValue = (id: string): string => stepper(id).querySelector<HTMLElement>('.viz-stepper__value')!.textContent ?? '';
  const bump = (id: string, dir: 1 | -1): void => stepper(id).querySelector<HTMLButtonElement>(`[data-step="${dir}"]`)!.click();
  const btn = (id: string, dir: 1 | -1): HTMLButtonElement => stepper(id).querySelector<HTMLButtonElement>(`[data-step="${dir}"]`)!;

  it('renders Auto by default (no ceiling override): manual row + hint hidden, caps at defaults', async () => {
    setScaleApi(); // no copilotCeiling, no stageCaps
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(checked(root, 'ceiling-mode')).toBe('auto');
    expect((root.querySelector('#ceiling-manual-row') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('#scale-hint') as HTMLElement).hidden).toBe(true);
    // Effective per-stage caps (resolveStageCaps): today's defaults. SCALE adaptive-default (SPEC-0048
    // batch-2) raised the cap-stages 3→4; Connect stays serial (1) by default.
    expect(stepperValue('cap-decompose')).toBe('4');
    expect(stepperValue('cap-claims')).toBe('4');
    expect(stepperValue('cap-compose')).toBe('4');
    expect(stepperValue('cap-archive')).toBe('4');
  });

  it('Connect is an editable cap now — not pinned/disabled, and a bump persists it (SCALE-5 unpin)', async () => {
    const { set } = setScaleApi();
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(stepperValue('cap-connect')).toBe('1'); // today's default (serial) — but editable now
    expect(btn('cap-connect', 1).disabled).toBe(false); // increment enabled (was disabled when pinned)
    expect(btn('cap-connect', -1).disabled).toBe(true); // at the floor (1) → decrement disabled (bound affordance)
    expect(root.querySelector('.scale-pin-note')).toBeNull(); // the "pinned" note is gone
    bump('cap-connect', 1); // 1 → 2
    await tick();
    expect(stepperValue('cap-connect')).toBe('2');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ stageCaps: expect.objectContaining({ connect: 2 }) }));
  });

  it('cap rows align via a 2-col grid (label | stepper); 5 rows, no pinned-note row (SCALE-5)', async () => {
    setScaleApi();
    mountSettings(root).show?.();
    await tick();
    await tick();
    // Every cap row carries .scale-stage-row (the grid that right-aligns the steppers into one column).
    const rows = root.querySelectorAll('.scale-stage-row');
    expect(rows.length).toBe(5); // decompose / connect / claims / compose / archive
    for (const row of Array.from(rows)) {
      expect(row.querySelector('.viz-field__label')).toBeTruthy();
      expect(row.querySelector('.viz-stepper')).toBeTruthy();
    }
    expect(root.querySelector('.scale-pin-note')).toBeNull(); // Connect's pin note is gone (unpinned)
  });

  it('renders Manual when a ceiling override is set: row + hint visible, stepper at the value', async () => {
    setScaleApi({ copilotCeiling: 6 });
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(checked(root, 'ceiling-mode')).toBe('manual');
    expect((root.querySelector('#ceiling-manual-row') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('#scale-hint') as HTMLElement).hidden).toBe(false);
    expect(stepperValue('ceiling')).toBe('6');
  });

  it('Auto → Manual sets the ceiling to the stepper value + reveals the row (SCALE-1)', async () => {
    const { set } = setScaleApi(); // auto, ceiling stepper seeds at 4
    mountSettings(root).show?.();
    await tick();
    await tick();
    pick(root, 'ceiling-mode', 'manual');
    await tick();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ copilotCeiling: 4, autonomyDefault: 'guarded', devLogLevel: 'info' }));
    expect(checked(root, 'ceiling-mode')).toBe('manual');
    expect((root.querySelector('#ceiling-manual-row') as HTMLElement).hidden).toBe(false);
  });

  it('Manual → Auto CLEARS the ceiling (copilotCeiling: null) + hides the row', async () => {
    const { set } = setScaleApi({ copilotCeiling: 8 });
    mountSettings(root).show?.();
    await tick();
    await tick();
    pick(root, 'ceiling-mode', 'auto');
    await tick();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ copilotCeiling: null }));
    expect(checked(root, 'ceiling-mode')).toBe('auto');
    expect((root.querySelector('#ceiling-manual-row') as HTMLElement).hidden).toBe(true);
  });

  it('bumping a stage cap persists the FULL settings with the merged stageCaps (preserve-on-omission)', async () => {
    const { set } = setScaleApi({ stageCaps: { claims: 2 } });
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(stepperValue('cap-decompose')).toBe('4'); // SCALE adaptive-default: cap-stage default 3→4
    bump('cap-decompose', 1); // 4 → 5
    await tick();
    expect(stepperValue('cap-decompose')).toBe('5');
    // Full settings sent; the prior claims override is merged, not clobbered; autonomy preserved.
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ stageCaps: { claims: 2, decompose: 5 }, autonomyDefault: 'guarded', devLogLevel: 'info' }),
    );
  });

  it('the manual-ceiling stepper persists copilotCeiling on change', async () => {
    const { set } = setScaleApi({ copilotCeiling: 5 });
    mountSettings(root).show?.();
    await tick();
    await tick();
    bump('ceiling', 1); // 5 → 6
    await tick();
    expect(stepperValue('ceiling')).toBe('6');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ copilotCeiling: 6 }));
  });

  it('bound-affordance: a stepper at its minimum disables decrement; at its max disables increment', async () => {
    setScaleApi({ stageCaps: { decompose: 1 } }); // at the floor
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(btn('cap-decompose', -1).disabled).toBe(true); // can't go below 1
    expect(btn('cap-decompose', 1).disabled).toBe(false);
    bump('cap-decompose', 1); // 1 → 2
    await tick();
    expect(btn('cap-decompose', -1).disabled).toBe(false); // affordance re-enables off the bound
  });

  it('tolerates malformed legacy stageCaps without crashing the card (ENG-15)', async () => {
    // A hand-edited/old instance.json with a garbled cap — resolveStageCaps clamps to a safe default.
    setScaleApi({ stageCaps: { decompose: 'nope' as unknown as number, compose: 999 } });
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(root.querySelector('#scale-status')).toBeTruthy(); // card rendered, not a blank/crash
    expect(stepperValue('cap-decompose')).toBe('4'); // garbled → default (SCALE adaptive-default: 3→4)
    expect(stepperValue('cap-compose')).toBe('8'); // out-of-range → clamped to STAGE_CAP_MAX
  });

  it('renders the steppers as labelled groups (a11y): role=group + aria-labelledby + a live value', async () => {
    setScaleApi();
    mountSettings(root).show?.();
    await tick();
    await tick();
    const el = stepper('cap-decompose');
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-labelledby')).toBe('cap-decompose-label');
    expect(root.querySelector('#cap-decompose-label')?.textContent).toBe('Decompose');
    expect(el.querySelector('.viz-stepper__value')?.getAttribute('aria-live')).toBe('polite');
  });

  // SPEC-0048 SCALE-7/8: the AIMD throttled indicator (DL ruling — ink-muted "effective N of M",
  // render ONLY while backed off, ember-breathe dot while in the cooldown; never announce "not throttled").
  it('throttled indicator: shows "effective N of M" + the ember-breathe dot when backed off in cooldown', async () => {
    setScaleApi({}, { adaptive: true, effective: 2, reference: 4, backedOff: true, throttled: true });
    mountSettings(root).show?.();
    await tick();
    await tick();
    const el = root.querySelector<HTMLElement>('#scale-throttle')!;
    expect(el.hidden).toBe(false);
    expect(el.textContent).toMatch(/effective 2 of 4/);
    expect(el.textContent).toMatch(/easing off rate limits/i);
    expect(el.querySelector('.scale-throttle__dot')).toBeTruthy(); // active backing-off marker
  });

  it('throttled indicator: backed off but past the cooldown → caption, no breathe dot', async () => {
    setScaleApi({}, { adaptive: true, effective: 3, reference: 6, backedOff: true, throttled: false });
    mountSettings(root).show?.();
    await tick();
    await tick();
    const el = root.querySelector<HTMLElement>('#scale-throttle')!;
    expect(el.hidden).toBe(false);
    expect(el.textContent).toMatch(/effective 3 of 6/);
    expect(el.querySelector('.scale-throttle__dot')).toBeNull(); // not actively in cooldown
  });

  it('throttled indicator: ABSENT when healthy (effective === reference) — never announces "not throttled"', async () => {
    setScaleApi({}, { adaptive: true, effective: 4, reference: 4, backedOff: false, throttled: false });
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(root.querySelector<HTMLElement>('#scale-throttle')!.hidden).toBe(true);
  });

  it('throttled indicator: ABSENT in fixed mode (manual/env pin — not adaptive)', async () => {
    setScaleApi({ copilotCeiling: 6 }, { adaptive: false, effective: 6, reference: 6, backedOff: false });
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(root.querySelector<HTMLElement>('#scale-throttle')!.hidden).toBe(true);
  });
});

// SPEC-0026 ASK-19 — the "Recall & Ask" card exposes the recall work budget: the answer-TIME budget
// (edited in minutes, persisted as ms) + the retrieval SEARCH-DEPTH, Auto (scaled to KB size) unless
// the Principal pins a manual override (recallMaxToolCalls). IPC echo-mocked; the clamp/preserve merge
// is node-tested (recallConstants + instanceConfig + pipeline). Here we cover the view + wiring contract.
describe('Settings · Recall & Ask (SPEC-0026 ASK-19 — recall work-budget knobs)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  function setRecallApi(instance: Partial<InstanceSettings> = {}): { set: ReturnType<typeof vi.fn> } {
    const base: InstanceSettings = { autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' };
    const set = vi.fn(async (s: InstanceSettings) => s); // echo; the real backend merge is node-tested
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      getState: vi.fn(async () => ({ activeVaultPath: '/v', vaultConfig: { schemaVersion: 1, id: 'x', name: 'KB', createdAt: 't' } })),
      inspect: vi.fn(async () => ({ copilot: { available: true, detail: 'ok' } }) as Awaited<ReturnType<KbApi['inspect']>>),
      getInstanceSettings: vi.fn(async () => ({ ...base, ...instance })),
      setInstanceSettings: set as KbApi['setInstanceSettings'],
      getScaleRuntime: vi.fn(async () => ({ adaptive: true, effective: 4, reference: 4, throttled: false, backedOff: false })),
    };
    return { set };
  }
  const stepper = (id: string): HTMLElement => root.querySelector<HTMLElement>(`[data-stepper="${id}"]`)!;
  const stepperValue = (id: string): string => stepper(id).querySelector<HTMLElement>('.viz-stepper__value')!.textContent ?? '';
  const bump = (id: string, dir: 1 | -1): void => stepper(id).querySelector<HTMLButtonElement>(`[data-step="${dir}"]`)!.click();
  const btn = (id: string, dir: 1 | -1): HTMLButtonElement => stepper(id).querySelector<HTMLButtonElement>(`[data-step="${dir}"]`)!;

  it('renders the time budget in minutes + search depth Auto by default (no override): manual row + hint state', async () => {
    setRecallApi(); // no recallBudgetMs (legacy) → 4min default; no recallMaxToolCalls → Auto
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(stepperValue('recall-time')).toBe('4'); // DEFAULT_RECALL_BUDGET_MS (240000) → 4 minutes
    expect(checked(root, 'recall-depth-mode')).toBe('auto');
    expect((root.querySelector('#recall-depth-manual-row') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('#recall-depth-hint') as HTMLElement).hidden).toBe(false); // the "scaled to KB" reassurance
  });

  it('reflects a saved time budget in minutes (360000ms → 6)', async () => {
    setRecallApi({ recallBudgetMs: 360_000 });
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(stepperValue('recall-time')).toBe('6');
  });

  it('bumping the time stepper persists recallBudgetMs as ms (×60000), full settings (preserve-on-omission)', async () => {
    const { set } = setRecallApi(); // seeds at 4 min
    mountSettings(root).show?.();
    await tick();
    await tick();
    bump('recall-time', 1); // 4 → 5 minutes
    await tick();
    expect(stepperValue('recall-time')).toBe('5');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ recallBudgetMs: 300_000, autonomyDefault: 'guarded', devLogLevel: 'info' }));
  });

  it('time budget bound-affordance: at the 10-minute ceiling, increment is disabled', async () => {
    setRecallApi({ recallBudgetMs: 600_000 }); // RECALL_BUDGET_MS_MAX → 10 minutes
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(stepperValue('recall-time')).toBe('10');
    expect(btn('recall-time', 1).disabled).toBe(true); // can't exceed the 10-minute ceiling
    expect(btn('recall-time', -1).disabled).toBe(false);
  });

  it('renders Manual search depth when an override is set: row visible, hint hidden, stepper at the value', async () => {
    setRecallApi({ recallMaxToolCalls: 16 });
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(checked(root, 'recall-depth-mode')).toBe('manual');
    expect((root.querySelector('#recall-depth-manual-row') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('#recall-depth-hint') as HTMLElement).hidden).toBe(true);
    expect(stepperValue('recall-depth')).toBe('16');
  });

  it('Auto → Manual sets recallMaxToolCalls to the stepper seed + reveals the row (ASK-19 per-instance override)', async () => {
    const { set } = setRecallApi(); // Auto; depth stepper seeds at 12
    mountSettings(root).show?.();
    await tick();
    await tick();
    pick(root, 'recall-depth-mode', 'manual');
    await tick();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ recallMaxToolCalls: 12 }));
    expect(checked(root, 'recall-depth-mode')).toBe('manual');
    expect((root.querySelector('#recall-depth-manual-row') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('#recall-depth-hint') as HTMLElement).hidden).toBe(true);
  });

  it('Manual → Auto CLEARS the override (recallMaxToolCalls: null) + hides the row, restores the hint', async () => {
    const { set } = setRecallApi({ recallMaxToolCalls: 20 });
    mountSettings(root).show?.();
    await tick();
    await tick();
    pick(root, 'recall-depth-mode', 'auto');
    await tick();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ recallMaxToolCalls: null }));
    expect(checked(root, 'recall-depth-mode')).toBe('auto');
    expect((root.querySelector('#recall-depth-manual-row') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('#recall-depth-hint') as HTMLElement).hidden).toBe(false);
  });

  it('the manual search-depth stepper persists recallMaxToolCalls on change', async () => {
    const { set } = setRecallApi({ recallMaxToolCalls: 8 });
    mountSettings(root).show?.();
    await tick();
    await tick();
    bump('recall-depth', 1); // 8 → 9
    await tick();
    expect(stepperValue('recall-depth')).toBe('9');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ recallMaxToolCalls: 9 }));
  });

  it('search-depth bound-affordance: clamps at the raised MAX (24) — increment disabled at the cap', async () => {
    setRecallApi({ recallMaxToolCalls: 24 }); // RECALL_BUDGET.MAX
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(stepperValue('recall-depth')).toBe('24');
    expect(btn('recall-depth', 1).disabled).toBe(true); // never above the raised cap
  });

  it('tolerates a garbled/missing time budget without crashing the card (ENG-16)', async () => {
    setRecallApi({ recallBudgetMs: NaN as unknown as number }); // a hand-edited/old value
    mountSettings(root).show?.();
    await tick();
    await tick();
    expect(root.querySelector('#recall-status')).toBeTruthy(); // card rendered, not a blank/crash
    expect(stepperValue('recall-time')).toBe('4'); // garbled → the default, in minutes
  });

  it('renders the steppers as labelled a11y groups (role=group + aria-labelledby + a live value)', async () => {
    setRecallApi();
    mountSettings(root).show?.();
    await tick();
    await tick();
    const el = stepper('recall-time');
    expect(el.getAttribute('role')).toBe('group');
    expect(el.getAttribute('aria-labelledby')).toBe('recall-time-label');
    expect(el.querySelector('.viz-stepper__value')?.getAttribute('aria-live')).toBe('polite');
    expect(root.querySelector('#recall-depth-mode')?.getAttribute('role')).toBe('radiogroup');
  });
});

describe('Settings · #145 load resilience (no infinite spinner on a hung IPC)', () => {
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

  it('times out a hung getState → retryable error, and Retry re-loads successfully', async () => {
    const getState = vi.fn<KbApi['getState']>().mockReturnValueOnce(new Promise(() => {})); // hangs
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { getState };
    mountSettings(root).show?.();
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull(); // skeleton initially (#520)
    expect(root.textContent).not.toContain('Loading…'); // never bare "Loading…" (#520 §8)

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.querySelector('.load-error')).toBeTruthy();
    expect(root.querySelector('.load-retry')).toBeTruthy();

    // Retry succeeds → Settings renders.
    getState.mockResolvedValue({ activeVaultPath: '/v', vaultConfig: { schemaVersion: 1, id: 'x', name: 'My Library', createdAt: 't' } });
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      getState,
      inspect: vi.fn(async () => ({ copilot: { available: true, detail: 'ok' } }) as Awaited<ReturnType<KbApi['inspect']>>),
      getInstanceSettings: vi.fn(async () => ({ autonomyDefault: 'guarded' as const, devLogLevel: 'info' as const, quickCaptureAccelerator: 'Alt+Space' })),
      setInstanceSettings: vi.fn(async (s: InstanceSettings) => s) as KbApi['setInstanceSettings'],
    };
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.textContent).toContain('My Library');
  });
});

describe('Settings · Prepare for shutdown (SPEC-0045 QUIESCE-1/3/5/6)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  afterEach(() => vi.restoreAllMocks());

  function setQuiesceApi(over: Partial<KbApi> = {}): { quiesce: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> } {
    const quiesce = vi.fn(async () => ({ quiescing: true, remaining: 3, safe: false, detail: 'Finishing up — 3 items remaining…' }));
    const resume = vi.fn(async () => ({ quiescing: false, remaining: 0, safe: false, detail: 'Running normally.' }));
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      getState: vi.fn(async () => ({ activeVaultPath: '/v', vaultConfig: { schemaVersion: 1, id: 'x', name: 'KB', createdAt: 't' } })),
      inspect: vi.fn(async () => ({ copilot: { available: true, detail: 'ok' } }) as Awaited<ReturnType<KbApi['inspect']>>),
      getInstanceSettings: vi.fn(async () => ({ autonomyDefault: 'guarded' as const, devLogLevel: 'info' as const, quickCaptureAccelerator: 'Alt+Space' })),
      quiesceStatus: vi.fn(async () => ({ quiescing: false, remaining: 0, safe: false, detail: 'Running normally.' })) as KbApi['quiesceStatus'],
      quiesce: quiesce as KbApi['quiesce'],
      resume: resume as KbApi['resume'],
      ...over,
    };
    return { quiesce, resume };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('the "Prepare for shutdown" button is a modest, non-danger control (QUIESCE-6)', async () => {
    setQuiesceApi();
    mountSettings(root).show?.();
    await tick();
    await tick();
    const btn = root.querySelector('#quiesce-btn')!;
    expect(btn.textContent).toMatch(/Prepare for shutdown/i);
    expect(btn.classList.contains('viz-btn--danger')).toBe(false); // not destructive-styled
    expect((root.querySelector('#resume-btn') as HTMLElement).hidden).toBe(true);
  });

  it('clicking Prepare quiesces + shows the drain status + Resume (QUIESCE-1/3)', async () => {
    const { quiesce } = setQuiesceApi();
    mountSettings(root).show?.();
    await tick();
    await tick();
    (root.querySelector('#quiesce-btn') as HTMLButtonElement).click();
    await tick();
    expect(quiesce).toHaveBeenCalled();
    expect(root.querySelector('#quiesce-status')!.textContent).toMatch(/3 items remaining/i);
    expect((root.querySelector('#resume-btn') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('#quiesce-btn') as HTMLElement).hidden).toBe(true);
  });

  it('Resume un-pauses, restoring the Prepare button (QUIESCE-5)', async () => {
    const { resume } = setQuiesceApi();
    mountSettings(root).show?.();
    await tick();
    await tick();
    (root.querySelector('#quiesce-btn') as HTMLButtonElement).click();
    await tick();
    (root.querySelector('#resume-btn') as HTMLButtonElement).click();
    await tick();
    expect(resume).toHaveBeenCalled();
    expect((root.querySelector('#quiesce-btn') as HTMLElement).hidden).toBe(false);
    expect((root.querySelector('#resume-btn') as HTMLElement).hidden).toBe(true);
  });

  it('reflects an already-safe drain on mount: "Safe to shut down" (QUIESCE-3)', async () => {
    setQuiesceApi({ quiesceStatus: vi.fn(async () => ({ quiescing: true, remaining: 0, safe: true, detail: 'Safe to shut down — all work finished.' })) as KbApi['quiesceStatus'] });
    mountSettings(root).show?.();
    await tick();
    await tick();
    const statusEl = root.querySelector('#quiesce-status')!;
    expect(statusEl.textContent).toMatch(/Safe to shut down/i);
    expect(statusEl.textContent).not.toMatch(/✅|✔️/); // Design-Lead: monochrome voice, no colored emoji
    expect(statusEl.classList.contains('viz-state-settled')).toBe(true); // the settled state token instead
    expect((root.querySelector('#resume-btn') as HTMLElement).hidden).toBe(false);
  });
});

// SPEC-0060 VUX-1: the Settings CSS block migrates off the instrument-panel --viz-* names onto the
// warm-vellum v3 tokens. NO ember (settings aren't decisions). Guard on the CSS source.
describe('VUX-1 v3 token migration (SPEC-0060 — Settings, off --viz-*)', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  const block = indexCss.slice(
    indexCss.indexOf('Settings view — VELLUM v3'),
    indexCss.indexOf('Reviews view — VELLUM v3'),
  );

  it('isolated the Settings v3 block', () => {
    expect(block.length).toBeGreaterThan(400);
  });

  it('the v3 Settings block carries NO --viz-* tokens and NO ember', () => {
    expect(block).not.toMatch(/var\(--viz-/);
    expect(block).not.toMatch(/--ember|var\(--ember/);
  });

  it('uses v3 ground/ink + state tokens (ink/linen/sprout/gold)', () => {
    expect(block).toMatch(/var\(--ink\b/);
    expect(block).toMatch(/var\(--linen\b/);
    expect(block).toMatch(/var\(--sprout\b/); // copilot-ready dot
    expect(block).toMatch(/var\(--gold\b/); // copilot-caution dot
  });
});
