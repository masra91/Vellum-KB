// Settings view (SPEC-0017 SHELL-7): surfaces the active KB (name + vault path) and Copilot
// availability, and hosts the Replay / Maintenance action (SPEC-0022 REPLAY-1/2) — a confirmed,
// Principal-initiated "clean & rebuild" of the KB. Editing config (e.g. switching the KB) is
// deferred (SHELL-8/10).
//
// WS3 migration (DESIGN-LEGACY-VIEWS §3): the autonomy + dev-log native <select>s are now the blessed
// SegmentedControl primitive (.viz-seg, a role=radiogroup of role=radio segments). That is an
// INTERACTION-CONTRACT change — the old `change` event is gone; selection is a click / Space-Enter on a
// segment, focus roves with arrow keys, and the choice is reflected via `aria-checked`. The autonomy
// confirm-gate (guarded↔autonomous) re-wires onto the segment, not a removed select.
import { esc } from '../html';
import { withTimeout, renderLoadError, paintSkeleton } from '../loadGuard';
import { mountAboutPanel } from '../aboutPanel';
import { mountWatchedFolders } from './watchedFolders';
import { readStoredTheme, setTheme, type Theme } from '../theme';
import type { ViewHandle } from '../viewLifecycle';
import type { InstanceSettings, QuiesceStatus } from '../../kb/types';
// SPEC-0048 SCALE Settings (Scale card). Imported from the PURE `scaleConstants` (no node import) so
// the renderer bundle never pulls the node-only `instanceConfig` (the renderer→node-builtin boundary).
import { SCALE_STAGES, STAGE_CAP_MAX, COPILOT_CEILING_MIN, COPILOT_CEILING_MAX, resolveStageCaps, type ScaleStage } from '../../kb/scaleConstants';
// SPEC-0026 ASK-19 "Recall & Ask" card — the recall budget bounds come from the PURE `recallConstants`
// (no node import) for the same renderer→node-builtin-boundary reason as `scaleConstants` above.
import { RECALL_BUDGET, RECALL_BUDGET_MS_MIN, RECALL_BUDGET_MS_MAX, DEFAULT_RECALL_BUDGET_MS } from '../../kb/recallConstants';

/** The recall time budget is edited in whole MINUTES (the ms bounds are clean multiples of a minute);
 *  convert at the UI boundary. A garbled stored value → the default, shown in minutes. */
const RECALL_MIN_MINUTES = Math.round(RECALL_BUDGET_MS_MIN / 60_000); // 1
const RECALL_MAX_MINUTES = Math.round(RECALL_BUDGET_MS_MAX / 60_000); // 10
const msToMinutes = (ms: number | undefined): number => {
  const m = Math.round((typeof ms === 'number' && Number.isFinite(ms) ? ms : DEFAULT_RECALL_BUDGET_MS) / 60_000);
  return Math.max(RECALL_MIN_MINUTES, Math.min(RECALL_MAX_MINUTES, m));
};
/** A sensible Manual seed when the Principal first switches "Search depth" off Auto (within bounds). */
const RECALL_DEPTH_MANUAL_SEED = 12;

// SPEC-0022 §3.3 — the confirmation copy MUST name the consequence before any destructive step (REPLAY-2).
const REPLAY_CONFIRM =
  'Completely clean and rebuild your library? This permanently deletes all derived knowledge — ' +
  'candidates, entities, claims, and review questions — and reprocesses every Source from scratch. ' +
  'Your Sources are preserved. This cannot be undone from the app.';

/** A SegmentedControl segment (DESIGN-LEGACY-VIEWS §3 a11y): role=radio + aria-checked, roving
 *  tabindex so the checked segment is the single tab stop (focus then roves with arrow keys). */
function segOpt(value: string, label: string, current: string): string {
  const on = value === current;
  return `<button type="button" role="radio" class="viz-seg-opt viz-signage viz-focusable" data-value="${esc(value)}" aria-checked="${on ? 'true' : 'false'}" tabindex="${on ? '0' : '-1'}">${esc(label)}</button>`;
}

/** SPEC-0048 SCALE: a −/value/+ STEPPER for an integer setting (per-stage caps + the manual ceiling).
 *  `id` keys the control + binds the value to its label (`<id>-label`). `disabled` pins it (Connect,
 *  SCALE-5). The `.viz-stepper` visual primitive is Design-Lead's design-system lane — authored CSS. */
function stepper(id: string, value: number, min: number, max: number, disabled = false): string {
  const dis = disabled ? ' disabled' : '';
  const btn = (step: number, label: string, glyph: string): string =>
    `<button type="button" class="viz-stepper__btn viz-focusable" data-step="${step}" aria-label="${esc(label)}"${dis}>${glyph}</button>`;
  return `<span class="viz-stepper" data-stepper="${esc(id)}" data-min="${min}" data-max="${max}" role="group" aria-labelledby="${esc(id)}-label">
        ${btn(-1, 'Decrease', '−')}
        <span class="viz-stepper__value" data-value="${value}" aria-live="polite">${value}</span>
        ${btn(1, 'Increase', '+')}
      </span>`;
}

/** Human label for a stage (the Scale card rows). */
const STAGE_LABELS: Record<ScaleStage, string> = {
  decompose: 'Decompose',
  claims: 'Claims',
  compose: 'Compose',
  archive: 'Archive',
  connect: 'Connect',
};

export function mountSettings(container: HTMLElement): ViewHandle {
  paintSkeleton(container, `<h1 class="settings-title viz-voice">Settings</h1>`, 'cards');
  // #510: re-read on every activation (STATE-8 AC1 — Settings was one of the 8 frozen views). `render()`
  // does one full innerHTML replace once its data is ready (no interim skeleton flash on a switch-back,
  // matching Today/Explore's pattern) — only mount()'s own initial paint above shows the skeleton.
  return {
    show: () => void render(container),
    hide: () => stopQuiescePoll(), // the shutdown-prep poll (if active) shouldn't tick on a hidden view
  };
}

async function render(container: HTMLElement): Promise<void> {
  // Settings must never error the shell. Any IPC failure (incl. a #145 hang — withTimeout bounds
  // every await below) degrades to a friendly, retryable message.
  try {
    // #512 PERF-R6: getState/getInstanceSettings are mutually independent (neither's input depends on
    // the other's output) but used to run sequentially anyway — Promise.all them so Settings paints on
    // whichever pair of 8s-bounded reads is slower, not their SUM. `inspect(vaultPath)` genuinely can't
    // join this pair (it needs `state.activeVaultPath` first) — instead of blocking the whole page on
    // it too, the page paints immediately with a "checking…" Copilot placeholder that a background
    // `inspect()` patches in-place once it resolves (AC: "Settings paints controls without waiting on
    // kb:inspect").
    const [state, instanceSettings] = await Promise.all([
      withTimeout(window.kbApi.getState()),
      withTimeout(window.kbApi.getInstanceSettings()).catch(() => null),
    ]);
    const name = state.vaultConfig?.name ?? '—';
    const vaultPath = state.activeVaultPath;

    const copilotLine = '<li class="settings-note" id="settings-copilot-line">Copilot — checking…</li>';

    // PANEL-5 / OBS-10: the editable per-Instance settings (autonomy default + dev-log verbosity).
    // Never errors the shell — falls back to safe defaults. Shared mutable object so each control
    // sends the full settings (the IPC contract takes the whole object) without clobbering the other.
    // quickCaptureAccelerator (QCAP-6) isn't edited here yet — it's loaded + sent back unchanged so
    // each control still sends the whole settings object without clobbering it (preserve-on-omission).
    const settings: InstanceSettings = { autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space' };
    if (instanceSettings) Object.assign(settings, instanceSettings);

    // SPEC-0048 SCALE view-model: effective per-stage caps, and the ceiling mode (Auto = let the app
    // decide / cores-derived; Manual = the Principal's value). The manual stepper seeds at the saved
    // value, else 4 (a sensible starting point on the cores-derived default).
    const caps = resolveStageCaps({ stageCaps: settings.stageCaps });
    const ceilingMode = settings.copilotCeiling === undefined ? 'auto' : 'manual';
    const ceilingValue = settings.copilotCeiling ?? 4;
    const scaleRowOrder: ScaleStage[] = ['decompose', 'connect', 'claims', 'compose', 'archive'];
    // Each cap row is a 2-column grid (label | stepper) so every stepper right-aligns into one column
    // regardless of label width (Design-Lead's alignment ruling). (SCALE-5: Connect is no longer
    // pinned/disabled — its ephemeral-worktree migration landed, so it's an editable cap like the rest.)
    const stageRow = (stage: ScaleStage): string => {
      return `<div class="settings-control scale-stage-row">
          <span class="viz-field__label" id="cap-${stage}-label">${STAGE_LABELS[stage]}</span>
          ${stepper(`cap-${stage}`, caps[stage], 1, STAGE_CAP_MAX)}
        </div>`;
    };

    // SPEC-0026 ASK-19 "Recall & Ask" view-model: the time budget (always set — minutes) + the
    // retrieval search-depth, which is Auto (scaled to KB size) unless the Principal pinned an override.
    const recallMinutes = msToMinutes(settings.recallBudgetMs);
    const recallDepthOverride = settings.recallMaxToolCalls ?? undefined; // null|undefined ⇒ Auto
    const recallDepthMode = recallDepthOverride === undefined ? 'auto' : 'manual';
    const recallDepthValue = recallDepthOverride ?? RECALL_DEPTH_MANUAL_SEED;

    // SPEC-0058 theme-toggle (Appearance card): the persisted Light/Dark choice (default light).
    const currentTheme = readStoredTheme();

    container.innerHTML = `
      <div class="settings-v2 viz-surface">
      <div class="card">
        <h1 class="settings-title viz-voice">Settings</h1>
        <dl class="settings">
          <dt>Library</dt>
          <dd>${esc(name)}</dd>
          <dt>Library path</dt>
          <dd><span class="path">${esc(vaultPath ?? '—')}</span></dd>
        </dl>
        <ul class="checks">
          ${copilotLine}
        </ul>
      </div>
      <div class="card">
        <h2>Appearance</h2>
        <p class="settings-note">Choose how Vellum looks. <strong>Light</strong> is the default cream study; <strong>Dark</strong> is the night-study variant. Your choice is remembered across launches.</p>
        <div class="settings-control">
          <span class="viz-field__label" id="theme-label">Theme</span>
          <span class="viz-seg" role="radiogroup" aria-labelledby="theme-label" id="theme-select">${segOpt('light', 'Light', currentTheme)}${segOpt('dark', 'Dark', currentTheme)}</span>
        </div>
      </div>
      <div class="card">
        <h2>Autonomy</h2>
        <p class="settings-note">Default posture for autonomous jobs in this library. Each job inherits this unless it sets its own. <strong>Guarded</strong> routes risky or low-confidence changes to Reviews; <strong>Autonomous</strong> lets the agent apply them directly.</p>
        <div class="settings-control">
          <span class="viz-field__label" id="autonomy-label">Default posture</span>
          <span class="viz-seg" role="radiogroup" aria-labelledby="autonomy-label" id="autonomy-default">${segOpt('guarded', 'Guarded', settings.autonomyDefault)}${segOpt('autonomous', 'Autonomous', settings.autonomyDefault)}</span>
        </div>
        <div id="autonomy-confirm" class="viz-confirm" hidden>
          <p class="viz-confirm__msg viz-body">Set the default to <strong>Autonomous</strong>? Jobs without their own posture will let the agent apply changes — including destructive ones — without routing to Reviews first.</p>
          <button id="autonomy-cancel" type="button" class="viz-btn viz-focusable">Cancel</button>
          <button id="autonomy-go" type="button" class="viz-btn viz-btn--danger viz-focusable">Set Autonomous</button>
        </div>
        <p id="autonomy-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Diagnostics</h2>
        <p class="settings-note">Diagnostic detail for this library. <strong>Info</strong> is the default; <strong>Debug</strong> adds verbose detail — and includes redaction-protected captured text / data sent to external services — to troubleshoot a stuck pipeline. Applies on the next pipeline start.</p>
        <div class="settings-control">
          <span class="viz-field__label" id="devlog-label">Diagnostic detail</span>
          <span class="viz-seg" role="radiogroup" aria-labelledby="devlog-label" id="devlog-level">${segOpt('info', 'Info', settings.devLogLevel)}${segOpt('debug', 'Debug', settings.devLogLevel)}</span>
        </div>
        <p id="verbosity-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Scale</h2>
        <p class="settings-note">How hard this library runs. <strong>Total at once</strong> caps how many AI sessions run concurrently across all stages; <strong>per-stage</strong> limits tune which stages get the slots. Higher is faster on a big backlog but loads your machine and the model more. Each stage always keeps at least one slot, so raising one never starves another. Applies live, on the next sweep.</p>
        <div class="settings-control">
          <span class="viz-field__label" id="ceiling-mode-label">Total at once</span>
          <span class="viz-seg" role="radiogroup" aria-labelledby="ceiling-mode-label" id="ceiling-mode">${segOpt('auto', 'Let the app decide', ceilingMode)}${segOpt('manual', 'Manual', ceilingMode)}</span>
        </div>
        <div class="settings-control" id="ceiling-manual-row"${ceilingMode === 'manual' ? '' : ' hidden'}>
          <span class="viz-field__label" id="ceiling-label">Max AI sessions at once</span>
          ${stepper('ceiling', ceilingValue, COPILOT_CEILING_MIN, COPILOT_CEILING_MAX)}
        </div>
        <p id="scale-throttle" class="settings-note scale-throttle" role="status" aria-live="polite" hidden></p>
        <p class="settings-note scale-stages-heading">Per-stage limits</p>
        ${scaleRowOrder.map(stageRow).join('\n        ')}
        <p id="scale-hint" class="settings-note scale-hint" role="note"${ceilingMode === 'manual' ? '' : ' hidden'}>Per-stage limits can total more than the cap — that's fine. Stages share the available slots fairly; none starves.</p>
        <p id="scale-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Recall &amp; Ask</h2>
        <p class="settings-note">How much room a question gets to find a complete, cited answer from this library. <strong>Answer time</strong> is how long recall may work before it returns its best grounded answer so far; <strong>search depth</strong> is how far it traverses entities, claims, and links to gather evidence. More is more thorough on a large library, but each question takes longer and more model work. Applies to your next question.</p>
        <div class="settings-control recall-budget-row">
          <span class="viz-field__label" id="recall-time-label">Answer time (minutes)</span>
          ${stepper('recall-time', recallMinutes, RECALL_MIN_MINUTES, RECALL_MAX_MINUTES)}
        </div>
        <div class="settings-control">
          <span class="viz-field__label" id="recall-depth-mode-label">Search depth</span>
          <span class="viz-seg" role="radiogroup" aria-labelledby="recall-depth-mode-label" id="recall-depth-mode">${segOpt('auto', 'Scale to library size', recallDepthMode)}${segOpt('manual', 'Manual', recallDepthMode)}</span>
        </div>
        <div class="settings-control recall-budget-row" id="recall-depth-manual-row"${recallDepthMode === 'manual' ? '' : ' hidden'}>
          <span class="viz-field__label" id="recall-depth-label">Search steps per question</span>
          ${stepper('recall-depth', recallDepthValue, RECALL_BUDGET.MIN, RECALL_BUDGET.MAX)}
        </div>
        <p id="recall-depth-hint" class="settings-note" role="note"${recallDepthMode === 'manual' ? ' hidden' : ''}>Recall scales how far it searches to the size of your library.</p>
        <p id="recall-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Watched folders</h2>
        <p class="settings-note">Folders Vellum watches — files dropped in are kept verbatim as sources. A watched folder drains like an inbox unless you set it to leave originals in place.</p>
        <div id="settings-watched"></div>
      </div>
      <div class="card">
        <h2>Replay / Maintenance</h2>
        <p class="settings-note">Delete all derived knowledge and reprocess every Source from scratch. Your Sources are preserved.</p>
        <button id="replay-btn" type="button" class="viz-btn viz-btn--danger viz-focusable"${vaultPath ? '' : ' disabled'}>Clean &amp; Rebuild Library…</button>
        <div id="replay-confirm" class="viz-confirm viz-confirm--danger" hidden>
          <p class="viz-confirm__msg viz-body">${esc(REPLAY_CONFIRM)}</p>
          <button id="replay-cancel" type="button" class="viz-btn viz-focusable">Cancel</button>
          <button id="replay-go" type="button" class="viz-btn viz-btn--danger viz-focusable">Clean &amp; Rebuild</button>
        </div>
        <p id="replay-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>
      <div class="card">
        <h2>Shutdown</h2>
        <p class="settings-note">Wind down before you quit: stop starting new work, let what's running finish, and tell you when it's safe to close the app. (Quitting unexpectedly is always safe too — this is just the tidy way.)</p>
        <button id="quiesce-btn" type="button" class="viz-btn viz-focusable"${vaultPath ? '' : ' disabled'}>Prepare for shutdown</button>
        <button id="resume-btn" type="button" class="viz-btn viz-focusable" hidden>Resume</button>
        <p id="quiesce-status" class="settings-note" role="status" aria-live="polite"></p>
      </div>
      <p class="settings-footer"><button type="button" id="about-link" class="viz-btn viz-btn--ghost viz-focusable">About Vellum</button></p>
      </div>`;

    // #512: Copilot availability comes from the same inspection the Setup flow uses (SETUP-4) — kicked
    // off only now, AFTER the page has already painted, so a slow/hung `inspect()` can never hold up
    // the rest of Settings. Patches ONLY the placeholder `<li>` in place once it resolves; a view
    // switch-away/re-render in the meantime just makes this a harmless no-op (the querySelector misses).
    // Isolated in its OWN try/catch (never the outer one) — same discipline as the pre-#512 inline
    // await had: a Copilot-status failure must only ever fall back to this one line, never blow away
    // the rest of an already-painted page (the outer catch's renderLoadError would do exactly that).
    try {
      if (vaultPath) {
        void withTimeout(window.kbApi.inspect(vaultPath))
          .then((ins) => {
            const el = container.querySelector('#settings-copilot-line');
            if (!el) return;
            // UX v2 (#184): a tokenized hue-dot, not an emoji — sprout when ready, brass (caution) when
            // not. The hue rides the aria-hidden dot; the label stays ink (state also reads via the text).
            const dot = `<span class="settings-status-dot ${ins.copilot.available ? 'settings-status-dot--ok' : 'settings-status-dot--warn'}" aria-hidden="true">●</span>`;
            el.outerHTML = `<li class="settings-copilot" id="settings-copilot-line">${dot} Copilot — <span class="settings-note">${esc(ins.copilot.detail)}</span></li>`;
          })
          .catch(() => {
            const el = container.querySelector('#settings-copilot-line');
            if (el) el.textContent = 'Copilot — status unavailable';
          });
      } else {
        const el = container.querySelector('#settings-copilot-line');
        if (el) el.textContent = 'Copilot — status unavailable';
      }
    } catch {
      const el = container.querySelector('#settings-copilot-line');
      if (el) el.textContent = 'Copilot — status unavailable';
    }

    container.querySelector<HTMLButtonElement>('#about-link')?.addEventListener('click', () => mountAboutPanel());
    wireTheme(container);
    wireAutonomy(container, settings);
    wireVerbosity(container, settings);
    wireScale(container, settings);
    void renderScaleRuntime(container);
    wireRecall(container, settings);
    wireReplay(container);
    void wireQuiesce(container);
    // SPEC-0060 IA: the Watched-folders section (moved here from Connectors) mounts itself into its
    // card container + owns its own re-render, so a folder change repaints just that section.
    const watchedEl = container.querySelector<HTMLElement>('#settings-watched');
    if (watchedEl) void mountWatchedFolders(watchedEl);
  } catch {
    // #145: failed/timed-out load → a retryable error, never an infinite spinner.
    renderLoadError(container, '<h1 class="settings-title viz-voice">Settings</h1>', () => void render(container));
  }
}

/** Reflect the committed value on a SegmentedControl: set `aria-checked` + the roving tab stop. */
function setSegChecked(group: HTMLElement, value: string): void {
  for (const o of Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'))) {
    const on = o.dataset.value === value;
    o.setAttribute('aria-checked', on ? 'true' : 'false');
    o.tabIndex = on ? 0 : -1;
  }
}

/** Wire a SegmentedControl's interaction contract (DESIGN-LEGACY-VIEWS §3 a11y). Selection does NOT
 *  follow focus — picking a posture can apply/confirm, so arrow keys ROVE focus (roving tabindex) and
 *  the choice commits on click or Space/Enter (a documented radiogroup variant for consequential
 *  choices). `onPick(value)` carries the gating logic (the caller applies or reveals the confirm). */
function wireSegmentedRadio(group: HTMLElement, onPick: (value: string) => void): void {
  const opts = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const focusAt = (i: number): void => {
    const n = (i + opts.length) % opts.length; // wrap
    for (const [j, o] of opts.entries()) o.tabIndex = j === n ? 0 : -1;
    opts[n].focus();
  };
  opts.forEach((opt, i) => {
    const pick = (): void => {
      if (opt.dataset.value) onPick(opt.dataset.value);
    };
    opt.addEventListener('click', pick);
    opt.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          focusAt(i + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          focusAt(i - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusAt(0);
          break;
        case 'End':
          e.preventDefault();
          focusAt(opts.length - 1);
          break;
        case ' ':
        case 'Enter':
          e.preventDefault();
          pick();
          break;
      }
    });
  });
}

/** Wire the per-Instance autonomy default (PANEL-5/7): changing the default to Autonomous is risky and
 *  reveals a confirm before it applies + is audited; relaxing to Guarded applies directly. */
function wireAutonomy(container: HTMLElement, settings: InstanceSettings): void {
  const group = container.querySelector<HTMLElement>('#autonomy-default');
  const confirm = container.querySelector<HTMLElement>('#autonomy-confirm');
  const cancel = container.querySelector<HTMLButtonElement>('#autonomy-cancel');
  const go = container.querySelector<HTMLButtonElement>('#autonomy-go');
  const status = container.querySelector<HTMLElement>('#autonomy-status');
  if (!group || !confirm || !cancel || !go || !status) return;

  const apply = async (value: 'guarded' | 'autonomous'): Promise<void> => {
    status.textContent = 'Saving…';
    try {
      // Send the FULL settings (the IPC takes the whole object) so we never clobber devLogLevel.
      const saved = await window.kbApi.setInstanceSettings({ ...settings, autonomyDefault: value });
      Object.assign(settings, saved);
      setSegChecked(group, settings.autonomyDefault);
      status.textContent = `Default posture: ${settings.autonomyDefault === 'autonomous' ? 'Autonomous' : 'Guarded'}.`;
    } catch {
      setSegChecked(group, settings.autonomyDefault); // keep the control on the unchanged saved value
      status.textContent = 'Could not save the change.';
    }
  };

  wireSegmentedRadio(group, (value) => {
    if (value === 'autonomous') {
      if (settings.autonomyDefault === 'autonomous') return; // already autonomous — nothing to do
      status.textContent = '';
      confirm.hidden = false; // risky → confirm before applying (PANEL-7); aria-checked stays on the saved value
    } else {
      confirm.hidden = true; // picking Guarded dismisses any pending confirm
      if (settings.autonomyDefault !== 'guarded') void apply('guarded'); // apply only on an actual change
    }
  });
  cancel.addEventListener('click', () => {
    confirm.hidden = true;
    setSegChecked(group, settings.autonomyDefault); // revert any tentative focus to the saved posture
  });
  go.addEventListener('click', () => {
    confirm.hidden = true;
    void apply('autonomous');
  });
}

/** Wire the Appearance Light/Dark toggle (SPEC-0058 theme-toggle). Benign + INSTANT (no confirm, no IPC):
 *  it flips the document `data-theme` and persists to localStorage on the spot — the user sees the theme
 *  change immediately as they pick. v1 is Light/Dark; System/`auto` is DL-1's separate foundation layer. */
function wireTheme(container: HTMLElement): void {
  const group = container.querySelector<HTMLElement>('#theme-select');
  if (!group) return;
  wireSegmentedRadio(group, (value) => {
    const theme: Theme = value === 'dark' ? 'dark' : 'light';
    setTheme(theme); // apply to <html data-theme> + persist — instant, no reload
    setSegChecked(group, theme); // reflect the new selection (aria-checked + roving tab stop)
  });
}

/** Wire the dev-log verbosity control (SPEC-0030 OBS-10): a benign info/debug toggle, applied
 *  directly (no confirm) — it only changes diagnostic detail. Sends the FULL settings so the
 *  autonomy default is preserved; the level takes effect on the next pipeline start. */
function wireVerbosity(container: HTMLElement, settings: InstanceSettings): void {
  const group = container.querySelector<HTMLElement>('#devlog-level');
  const status = container.querySelector<HTMLElement>('#verbosity-status');
  if (!group || !status) return;

  const apply = async (value: 'info' | 'debug'): Promise<void> => {
    status.textContent = 'Saving…';
    try {
      const saved = await window.kbApi.setInstanceSettings({ ...settings, devLogLevel: value });
      Object.assign(settings, saved);
      setSegChecked(group, settings.devLogLevel);
      status.textContent = `Dev-log level: ${settings.devLogLevel === 'debug' ? 'Debug' : 'Info'} (applies on the next pipeline start).`;
    } catch {
      setSegChecked(group, settings.devLogLevel); // keep the control on the unchanged saved value
      status.textContent = 'Could not save the change.';
    }
  };

  wireSegmentedRadio(group, (value) => {
    const v = value === 'debug' ? 'debug' : 'info';
    if (v === settings.devLogLevel) return; // no-op when unchanged
    void apply(v);
  });
}

/** Read a stepper's current integer value (`null` if absent/garbled — ENG-15 tolerant). */
function readStepperValue(el: HTMLElement | null): number | null {
  const raw = el?.querySelector<HTMLElement>('.viz-stepper__value')?.dataset.value;
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Reflect a stepper's value + bound-affordance (disable −/+ at min/max). Pinned steppers stay
 *  disabled either way. The value node is `aria-live=polite`, so a screen reader announces it. */
function setStepperValue(el: HTMLElement, v: number): void {
  const valEl = el.querySelector<HTMLElement>('.viz-stepper__value');
  if (valEl) {
    valEl.dataset.value = String(v);
    valEl.textContent = String(v);
  }
  const min = Number(el.dataset.min);
  const max = Number(el.dataset.max);
  const dec = el.querySelector<HTMLButtonElement>('[data-step="-1"]');
  const inc = el.querySelector<HTMLButtonElement>('[data-step="1"]');
  // A pinned stepper (Connect, min===max) keeps both disabled; otherwise disable only at the bound.
  if (dec) dec.disabled = Number.isFinite(min) && v <= min;
  if (inc) inc.disabled = Number.isFinite(max) && v >= max;
}

/** Wire a −/value/+ stepper (SPEC-0048). Native `<button>`s carry the click + keyboard (Enter/Space)
 *  for free. The display updates optimistically, then `onChange(next, prev)` persists — the caller
 *  reverts via {@link setStepperValue} on failure. Disabled (pinned) buttons no-op. */
function wireStepper(el: HTMLElement, onChange: (next: number, prev: number) => void): void {
  const min = Number(el.dataset.min);
  const max = Number(el.dataset.max);
  setStepperValue(el, readStepperValue(el) ?? min); // initialize the bound-affordance
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.viz-stepper__btn');
    if (!btn || btn.disabled) return;
    const cur = readStepperValue(el) ?? min;
    const next = Math.max(min, Math.min(max, cur + Number(btn.dataset.step)));
    if (next === cur) return;
    setStepperValue(el, next);
    onChange(next, cur);
  });
}

/** Wire the Scale card (SPEC-0048 SCALE): the Auto/Manual total-concurrency toggle, the manual-ceiling
 *  stepper, and the per-stage cap steppers. Every change sends the FULL settings (preserve-on-omission,
 *  #102) and applies live (next sweep). Auto sends `copilotCeiling: null` to CLEAR the override back to
 *  the cores-derived default. Connect's stepper is pinned/disabled (SCALE-5). ENG-16: a missing control
 *  degrades the card, never throws. */
function wireScale(container: HTMLElement, settings: InstanceSettings): void {
  const modeGroup = container.querySelector<HTMLElement>('#ceiling-mode');
  const manualRow = container.querySelector<HTMLElement>('#ceiling-manual-row');
  const ceilingStepper = container.querySelector<HTMLElement>('[data-stepper="ceiling"]');
  const hint = container.querySelector<HTMLElement>('#scale-hint');
  const status = container.querySelector<HTMLElement>('#scale-status');
  if (!modeGroup || !status) return;

  // Persist a partial change over the full settings; re-sync the scale fields from the saved config
  // (Object.assign can't delete a now-omitted key — a cleared ceiling must reflect as undefined).
  const save = async (patch: Partial<InstanceSettings>, onOk: () => void, onErr: () => void): Promise<void> => {
    status.textContent = 'Saving…';
    try {
      const saved = await window.kbApi.setInstanceSettings({ ...settings, ...patch });
      Object.assign(settings, saved);
      settings.copilotCeiling = saved.copilotCeiling; // may be undefined ⇒ cleared (Auto)
      settings.stageCaps = saved.stageCaps; // may be undefined ⇒ all defaults
      onOk();
    } catch {
      onErr();
      status.textContent = 'Could not save the change.';
    }
  };

  // The Auto/Manual toggle: Manual pins the ceiling to the stepper's value; Auto clears it (→ the app
  // decides). Selection doesn't follow focus (wireSegmentedRadio) — only an actual pick commits.
  wireSegmentedRadio(modeGroup, (value) => {
    const wantManual = value === 'manual';
    const isManual = settings.copilotCeiling !== undefined && settings.copilotCeiling !== null;
    if (wantManual === isManual) return; // no-op when unchanged
    if (wantManual) {
      const val = readStepperValue(ceilingStepper) ?? 4;
      void save(
        { copilotCeiling: val },
        () => {
          setSegChecked(modeGroup, 'manual');
          manualRow?.removeAttribute('hidden');
          hint?.removeAttribute('hidden');
          status.textContent = `Total at once: manual — ${val} session${val === 1 ? '' : 's'} (applies on the next sweep).`;
        },
        () => setSegChecked(modeGroup, isManual ? 'manual' : 'auto'),
      );
    } else {
      void save(
        { copilotCeiling: null },
        () => {
          setSegChecked(modeGroup, 'auto');
          manualRow?.setAttribute('hidden', '');
          hint?.setAttribute('hidden', '');
          status.textContent = 'Total at once: the app decides, based on your machine (applies on the next sweep).';
        },
        () => setSegChecked(modeGroup, isManual ? 'manual' : 'auto'),
      );
    }
  });

  // The manual-ceiling stepper.
  if (ceilingStepper) {
    wireStepper(ceilingStepper, (next, prev) => {
      void save(
        { copilotCeiling: next },
        () => {
          status.textContent = `Total at once: ${next} session${next === 1 ? '' : 's'} (applies on the next sweep).`;
        },
        () => setStepperValue(ceilingStepper, prev),
      );
    });
  }

  // The per-stage cap steppers (SCALE-5: Connect is now editable like the rest — its pin lifted).
  for (const stage of SCALE_STAGES) {
    const el = container.querySelector<HTMLElement>(`[data-stepper="cap-${stage}"]`);
    if (!el) continue;
    wireStepper(el, (next, prev) => {
      const stageCaps = { ...(settings.stageCaps ?? {}), [stage]: next };
      void save(
        { stageCaps },
        () => {
          status.textContent = `${STAGE_LABELS[stage]} limit: ${next} (applies on the next sweep).`;
        },
        () => setStepperValue(el, prev),
      );
    });
  }
}

/** Wire the "Recall & Ask" card (SPEC-0026 ASK-19): the answer-time stepper (minutes ↔ ms at the
 *  boundary) and the search-depth Auto/Manual toggle + override stepper. Every change sends the FULL
 *  settings (preserve-on-omission, #102). Auto sends `recallMaxToolCalls: null` to CLEAR the override
 *  back to the graph-size-scaled default. ENG-16: a missing control degrades the card, never throws. */
function wireRecall(container: HTMLElement, settings: InstanceSettings): void {
  const timeStepper = container.querySelector<HTMLElement>('[data-stepper="recall-time"]');
  const depthMode = container.querySelector<HTMLElement>('#recall-depth-mode');
  const depthRow = container.querySelector<HTMLElement>('#recall-depth-manual-row');
  const depthStepper = container.querySelector<HTMLElement>('[data-stepper="recall-depth"]');
  const depthHint = container.querySelector<HTMLElement>('#recall-depth-hint');
  const status = container.querySelector<HTMLElement>('#recall-status');
  if (!status) return;

  const save = async (patch: Partial<InstanceSettings>, onOk: () => void, onErr: () => void): Promise<void> => {
    status.textContent = 'Saving…';
    try {
      const saved = await window.kbApi.setInstanceSettings({ ...settings, ...patch });
      Object.assign(settings, saved);
      settings.recallMaxToolCalls = saved.recallMaxToolCalls; // may be undefined ⇒ cleared (Auto)
      onOk();
    } catch {
      onErr();
      status.textContent = 'Could not save the change.';
    }
  };

  // Answer time — a whole-minutes stepper; persist as ms (×60000).
  if (timeStepper) {
    wireStepper(timeStepper, (next, prev) => {
      void save(
        { recallBudgetMs: next * 60_000 },
        () => {
          status.textContent = `Answer time: ${next} minute${next === 1 ? '' : 's'} (applies to your next question).`;
        },
        () => setStepperValue(timeStepper, prev),
      );
    });
  }

  // Search depth — Auto (scale to KB size) clears the override; Manual pins the stepper's value.
  if (depthMode) {
    wireSegmentedRadio(depthMode, (value) => {
      const wantManual = value === 'manual';
      const isManual = settings.recallMaxToolCalls !== undefined && settings.recallMaxToolCalls !== null;
      if (wantManual === isManual) return; // no-op when unchanged
      if (wantManual) {
        const val = readStepperValue(depthStepper) ?? RECALL_DEPTH_MANUAL_SEED;
        void save(
          { recallMaxToolCalls: val },
          () => {
            setSegChecked(depthMode, 'manual');
            depthRow?.removeAttribute('hidden');
            depthHint?.setAttribute('hidden', '');
            status.textContent = `Search depth: up to ${val} step${val === 1 ? '' : 's'} per question (applies to your next question).`;
          },
          () => setSegChecked(depthMode, isManual ? 'manual' : 'auto'),
        );
      } else {
        void save(
          { recallMaxToolCalls: null },
          () => {
            setSegChecked(depthMode, 'auto');
            depthRow?.setAttribute('hidden', '');
            depthHint?.removeAttribute('hidden');
            status.textContent = 'Search depth: scaled to the size of your library (applies to your next question).';
          },
          () => setSegChecked(depthMode, isManual ? 'manual' : 'auto'),
        );
      }
    });
  }

  // The Manual search-depth stepper.
  if (depthStepper) {
    wireStepper(depthStepper, (next, prev) => {
      void save(
        { recallMaxToolCalls: next },
        () => {
          status.textContent = `Search depth: up to ${next} step${next === 1 ? '' : 's'} per question (applies to your next question).`;
        },
        () => setStepperValue(depthStepper, prev),
      );
    });
  }
}

/** SPEC-0048 SCALE-7/8: the AIMD "throttled" indicator. Fetch the live scale runtime and, ONLY when the
 *  adaptive controller is backed off below its healthy reference (a recent rate-limit reduced the live
 *  ceiling), show an ink-muted "effective N of M — easing off rate limits" caption (NOT brass — it's
 *  transient self-healing the user can't act on, so informational, per the VIZ-10 cry-wolf rule), with
 *  an ember-breathe dot while actively in the cooldown. Absent otherwise (never announces "not
 *  throttled"). A snapshot at mount (like the model picker's "runs as:"); ENG-16: any failure is silent. */
async function renderScaleRuntime(container: HTMLElement): Promise<void> {
  const el = container.querySelector<HTMLElement>('#scale-throttle');
  if (!el) return;
  let rt;
  try {
    rt = await withTimeout(window.kbApi.getScaleRuntime());
  } catch {
    return; // leave it hidden — the indicator is non-essential
  }
  if (!rt || !rt.adaptive || !rt.backedOff || rt.effective >= rt.reference) {
    el.setAttribute('hidden', '');
    return;
  }
  const dot = rt.throttled ? '<span class="scale-throttle__dot" aria-hidden="true"></span>' : '';
  el.innerHTML = `${dot}effective ${esc(String(rt.effective))} of ${esc(String(rt.reference))} — easing off rate limits`;
  el.removeAttribute('hidden');
}

/** Wire the Clean & Rebuild flow: reveal a confirm panel (REPLAY-2), then run the replay and
 *  reflect progress (REPLAY-12: the action is disabled while it runs so a second can't start). */
function wireReplay(container: HTMLElement): void {
  const btn = container.querySelector<HTMLButtonElement>('#replay-btn');
  const confirm = container.querySelector<HTMLElement>('#replay-confirm');
  const cancel = container.querySelector<HTMLButtonElement>('#replay-cancel');
  const go = container.querySelector<HTMLButtonElement>('#replay-go');
  const status = container.querySelector<HTMLElement>('#replay-status');
  if (!btn || !confirm || !cancel || !go || !status) return;

  const showConfirm = (show: boolean): void => {
    confirm.hidden = !show;
    btn.hidden = show;
  };

  btn.addEventListener('click', () => {
    status.textContent = '';
    showConfirm(true);
  });
  cancel.addEventListener('click', () => showConfirm(false)); // nothing happens — pipeline keeps running

  go.addEventListener('click', async () => {
    go.disabled = true;
    cancel.disabled = true;
    go.classList.add('is-busy'); // #520 §10 — disable-only surfaces get the same visible busy state
    status.textContent = 'Cleaning & rebuilding…';
    try {
      const res = await window.kbApi.fullReplay();
      status.textContent = res.message;
    } catch {
      status.textContent = 'Replay failed to start. Please try again.';
    } finally {
      showConfirm(false);
      go.disabled = false;
      cancel.disabled = false;
      go.classList.remove('is-busy');
    }
  });
}

// SPEC-0045 QUIESCE — "Prepare for shutdown": a modest control + a live drain readout. Module-scoped poll
// handle so a re-mount (view toggle) never leaks a second interval.
let quiescePoll: ReturnType<typeof setInterval> | null = null;
function stopQuiescePoll(): void {
  if (quiescePoll) {
    clearInterval(quiescePoll);
    quiescePoll = null;
  }
}

async function wireQuiesce(container: HTMLElement): Promise<void> {
  const btn = container.querySelector<HTMLButtonElement>('#quiesce-btn');
  const resumeBtn = container.querySelector<HTMLButtonElement>('#resume-btn');
  const status = container.querySelector<HTMLElement>('#quiesce-status');
  if (!btn || !resumeBtn || !status) return;
  stopQuiescePoll(); // re-mount: drop any prior interval

  const render = (s: QuiesceStatus | null): void => {
    if (!s || !s.quiescing) {
      btn.hidden = false;
      resumeBtn.hidden = true;
      status.textContent = '';
      status.classList.remove('viz-state-settled');
      stopQuiescePoll();
      return;
    }
    btn.hidden = true;
    resumeBtn.hidden = false;
    status.textContent = s.detail;
    // Design-Lead: the "safe" readout reads in the calm MONOCHROME viz voice — the settled state token,
    // never a colored emoji.
    status.classList.toggle('viz-state-settled', s.safe);
    if (s.safe) stopQuiescePoll(); // idle — nothing left to poll for
  };
  const startPoll = (): void => {
    stopQuiescePoll();
    quiescePoll = setInterval(async () => {
      try {
        render(await window.kbApi.quiesceStatus());
      } catch {
        /* keep the last readout */
      }
    }, 1000);
    quiescePoll.unref?.();
  };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.classList.add('is-busy'); // #520 §10
    try {
      const s = await window.kbApi.quiesce();
      render(s);
      if (s.quiescing && !s.safe) startPoll();
    } catch {
      status.textContent = 'Could not start shutdown preparation.';
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  });
  resumeBtn.addEventListener('click', async () => {
    resumeBtn.disabled = true;
    resumeBtn.classList.add('is-busy'); // #520 §10
    try {
      render(await window.kbApi.resume());
    } catch {
      status.textContent = 'Could not resume.';
    } finally {
      resumeBtn.disabled = false;
      resumeBtn.classList.remove('is-busy');
    }
  });

  // Reflect current state on mount (e.g. quiesce was started, then the user navigated away + back).
  try {
    const s = await window.kbApi.quiesceStatus();
    render(s);
    if (s?.quiescing && !s.safe) startPoll();
  } catch {
    /* leave the default Prepare button */
  }
}
