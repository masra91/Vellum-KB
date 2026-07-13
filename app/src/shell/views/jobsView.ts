// Jobs view (SPEC-0027 PANEL-2) — the Control Panel's strongest, fully-backed Manage view. Lists the
// autonomous jobs (SPEC-0023) and lets the Principal enable/disable, set the schedule preset + autonomy
// posture, Run now, and see last-run state from the job journal. Thin DOM over the typed IPC (the pure
// merge/risk logic lives in `kb/jobsPanel`, node-tested); the main process owns the registry + scheduler.
//
// WS2 migration: this surface now reads in "The Line" instrument language — a flat ruled strip per job
// (no card chrome) composing the shared design-system primitives (shell/design-system.css): a switch
// (arm) for enable, SegmentedControl for schedule/autonomy (NOT native <select>), Button for Run now,
// and ConfirmInline for the consequence gate. One visual language across Manage (matches Researchers).
//
// PANEL-7: risky changes (enabling a job, going Autonomous, Run now) reveal an inline confirm before
// they apply + audit; read-only viewing needs none. PANEL-9: the view degrades to a friendly message
// when no KB is active or IPC fails.
import { esc } from '../html';
import { withTimeout, renderLoadError, paintSkeleton } from '../loadGuard';
import { schedulePresetLabel, SCHEDULE_OPTIONS, isRiskyJobChange } from '../../kb/jobsPanel';
import type { ViewHandle } from '../viewLifecycle';
import type { JobView, JobConfigPatch } from '../../kb/types';

const POSTURE_OPTIONS = ['guarded', 'autonomous'] as const;
const POSTURE_LABEL: Record<string, string> = { guarded: 'Guarded', autonomous: 'Autonomous' };

// Mounted as the **Schedules** section (nested under Librarians) of the Agents hub (SPEC-0053 WS-E):
// the hub owns the "Schedules" group header/naming, so this section drops its own page-title h1.
const HEADER = `<p class="job-sub viz-body">Recurring background tasks that keep your library healthy. Changes apply without a restart.</p>`;

export function mountJobs(container: HTMLElement): ViewHandle {
  paintSkeleton(container, HEADER, 'cards');
  return { show: () => void render(container) }; // #510: re-read on every activation (no timers here)
}

async function render(container: HTMLElement): Promise<void> {
  // #145/#205: bound the WHOLE load→render under one guard — not just the IPC await. #145 timed out a
  // hung `listJobs` so a degraded backend can't spin forever; #205 extends the same guard over building
  // and swapping the DOM. A throw while turning a *successfully-fetched* (but malformed/legacy) response
  // into rows — e.g. a journal entry whose `inspected` isn't a string (the registry/journal are parsed
  // off disk with an unchecked cast) — would otherwise escape this async fn (the shell mounts views
  // fire-and-forget, `void mountJobs(el)`) and strand "Loading…" forever, with the timeout already
  // cleared so #145 can't catch it. Under one guard the loading state is ALWAYS left: to the list, the
  // empty state, or a retryable error — never an infinite spinner.
  try {
    const jobs = await withTimeout(window.kbApi.listJobs());

    if (jobs.length === 0) {
      container.innerHTML = `<div class="jobs-view viz-surface">${HEADER}<p class="job-empty viz-body">No jobs available — open a library to manage its jobs.</p></div>`;
      return;
    }

    container.innerHTML = `<div class="jobs-view viz-surface">${HEADER}<ul class="job-list">${jobs.map(jobItem).join('')}</ul></div>`;
    wire(container, jobs);
  } catch {
    renderLoadError(container, HEADER, () => void render(container));
  }
}

/** SegmentedControl (DESIGN-SYS §4) — a role=radiogroup of ghosted segments; replaces a native <select>
 *  for a small bounded enum. `groupCls` is the per-control hook the wiring binds to. */
function segment(groupCls: string, label: string, options: readonly { value: string; text: string }[], selected: string): string {
  const opts = options
    .map((o) => `<button type="button" role="radio" class="viz-seg-opt viz-signage viz-focusable" data-value="${esc(o.value)}" aria-checked="${o.value === selected ? 'true' : 'false'}">${esc(o.text)}</button>`)
    .join('');
  return `<div class="job-field"><span class="job-field-label viz-signage">${esc(label)}</span><span class="viz-seg ${esc(groupCls)}" role="radiogroup" aria-label="${esc(label)}">${opts}</span></div>`;
}

/** One job's row: a flat instrument strip — identity + arm switch + last-run + segmented controls and a
 *  Run-now Button, with the ConfirmInline consequence gate. */
function jobItem(j: JobView): string {
  const badge = j.production ? '' : ` <span class="viz-chip job-badge" title="A reference/non-production job">reference</span>`;
  // #205 / ENG-16: the journal is parsed off disk with an unchecked `JSON.parse(...) as JournalEntry`,
  // so a legacy/partial entry may carry a non-string field (a numeric `inspected` → `esc` throws,
  // stranding the view on "Loading…") OR be missing the JOBS-8 run-summary counts entirely (which
  // rendered as the literal "inspected undefined; undefined applied, undefined deferred"). Coerce +
  // default at this trust boundary so a stray entry renders as neutral text — never a crash, never
  // "undefined". (Read-side `normalizeJournalEntry` already coerces these; this is the last defense.)
  const lr = j.lastRun;
  const inspectedLabel = lr && String(lr.inspected ?? '').trim() ? esc(String(lr.inspected)) : '—';
  const appliedCount = lr && Number.isFinite(lr.applied) ? lr.applied : 0;
  const deferredCount = lr && Number.isFinite(lr.deferred) ? lr.deferred : 0;
  const last = lr
    ? `Last run ${esc(String(lr.ts))} — inspected ${inspectedLabel}; ${appliedCount} applied, ${deferredCount} deferred${
        lr.note ? ` (${esc(String(lr.note))})` : ''
      }`
    : 'Never run';

  return `
    <li class="job ag-card" data-id="${esc(j.id)}" data-type="${esc(j.type)}" data-armed="${j.enabled ? 'true' : 'false'}">
      <div class="job-head">
        <span class="job-label">${esc(j.label)}</span>${badge}
        <button type="button" class="job-enabled viz-focusable" role="switch" aria-checked="${j.enabled ? 'true' : 'false'}"><span class="dot" aria-hidden="true"></span>${j.enabled ? 'Enabled' : 'Paused'}</button>
      </div>
      <p class="job-desc viz-body">${esc(j.description)}</p>
      <div class="job-controls">
        ${segment('job-schedule', 'schedule', SCHEDULE_OPTIONS.map((p) => ({ value: p, text: schedulePresetLabel(p) })), j.schedule)}
        ${segment('job-posture', 'autonomy', POSTURE_OPTIONS.map((p) => ({ value: p, text: POSTURE_LABEL[p] })), j.posture)}
        <button type="button" class="viz-btn job-run">Run now</button>
      </div>
      <p class="job-lastrun viz-body">${last}</p>
      <div class="job-confirm viz-confirm" hidden>
        <p class="job-confirm-msg viz-confirm__msg viz-body"></p>
        <button type="button" class="viz-btn job-confirm-cancel">Cancel</button>
        <button type="button" class="viz-btn viz-btn--danger job-confirm-go">Confirm</button>
      </div>
      <p class="job-status viz-body" role="status" aria-live="polite"></p>
    </li>`;
}

function wire(container: HTMLElement, jobs: JobView[]): void {
  const byId = new Map(jobs.map((j) => [j.id, j]));

  for (const li of Array.from(container.querySelectorAll<HTMLElement>('.job'))) {
    const id = li.dataset.id!;
    const type = li.dataset.type!;
    const current = byId.get(id)!;
    const armEl = li.querySelector<HTMLButtonElement>('.job-enabled')!;
    const runBtn = li.querySelector<HTMLButtonElement>('.job-run')!;
    const confirm = li.querySelector<HTMLElement>('.job-confirm')!;
    const confirmMsg = li.querySelector<HTMLElement>('.job-confirm-msg')!;
    const confirmGo = li.querySelector<HTMLButtonElement>('.job-confirm-go')!;
    const confirmCancel = li.querySelector<HTMLButtonElement>('.job-confirm-cancel')!;
    const status = li.querySelector<HTMLElement>('.job-status')!;

    // A single pending action per row: either an apply(patch) or a run-now. Confirm runs it; Cancel
    // hides the panel. (The segmented/switch controls don't change visually until apply re-renders, so
    // there's nothing to revert on cancel — unlike the old native select/checkbox.)
    let pending: (() => Promise<void>) | null = null;

    const hideConfirm = (): void => {
      confirm.hidden = true;
      confirmMsg.textContent = ''; // WS1 #1: clear the prompt on dismiss so a stale message can't linger
      pending = null;
    };
    const askConfirm = (message: string, run: () => Promise<void>): void => {
      pending = run;
      confirmMsg.textContent = message;
      confirm.hidden = false;
    };

    const apply = async (patch: JobConfigPatch): Promise<void> => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setJobConfig(patch);
        await render(container); // re-render with the persisted list (also refreshes last-run)
      } catch {
        status.textContent = 'Could not save the change.';
      }
    };

    // Arm switch (enable/disable): enabling is risky (the job starts running) → confirm; disabling
    // applies directly. The switch shows `current.enabled` and only flips when apply re-renders.
    armEl.addEventListener('click', () => {
      const next = !current.enabled;
      const patch: JobConfigPatch = { id, type, enabled: next };
      if (isRiskyJobChange(current, patch)) {
        // Name the posture it will run at — and that it's inherited from the Instance default for a
        // not-yet-registered job: enabling is the consent moment for inherited Autonomous (PANEL-7).
        const inherited = current.registered ? '' : ' (inherited from the Instance default)';
        const postureNote =
          current.posture === 'autonomous'
            ? ` It will run with Autonomous autonomy${inherited} — the agent applies changes, including destructive ones, without routing to Reviews first.`
            : ` It will run Guarded${inherited}.`;
        askConfirm(`Enable “${current.label}”? It runs on its ${schedulePresetLabel(current.schedule)} schedule.${postureNote}`, () => apply(patch));
      } else {
        void apply(patch);
      }
    });

    // Autonomy segmented — → Autonomous is risky (agent judgment governs destructive actions) → confirm.
    wireSegment(li, 'job-posture', (value) => {
      const posture = value as JobConfigPatch['posture'];
      if (posture === current.posture) return;
      const patch: JobConfigPatch = { id, type, posture };
      if (isRiskyJobChange(current, patch)) {
        askConfirm(`Set “${current.label}” to Autonomous? The agent’s judgment will govern all actions, including destructive ones.`, () => apply(patch));
      } else {
        void apply(patch);
      }
    });

    // Schedule cadence is not risky — apply directly.
    wireSegment(li, 'job-schedule', (value) => {
      if (value === current.schedule) return;
      void apply({ id, type, schedule: value as JobConfigPatch['schedule'] });
    });

    // Run now: a manual bounded pass — confirm, then run and surface the outcome.
    runBtn.addEventListener('click', () => {
      askConfirm(`Run “${current.label}” now? It performs one bounded pass.`, async () => {
        // PANEL-10 state machine: idle → running (disabled + "Running…" + busy breathe on the Button) →
        // idle (the re-render restores "Run now"), or reset in place on failure so the user can retry.
        status.textContent = 'Running…';
        runBtn.disabled = true;
        runBtn.textContent = 'Running…';
        runBtn.classList.add('viz-btn--busy');
        try {
          const res = await window.kbApi.runJobNow(id);
          const msg = !('reason' in res)
            ? res.outcome === 'noop'
              ? 'Ran — nothing to do this pass.'
              : `Ran — ${res.applied} applied, ${res.deferred} deferred${res.outcome === 'setaside' ? ' (set aside)' : ''}.`
            : res.reason === 'skipped'
              ? 'Already running — skipped.'
              : `Could not run (${res.reason}).`;
          // Re-render to refresh last-run (rebuilds the DOM), then show the outcome on the new row.
          await render(container);
          const after = container.querySelector<HTMLElement>(`.job[data-id="${id}"] .job-status`);
          if (after) after.textContent = msg;
        } catch {
          status.textContent = 'Run failed.';
          runBtn.disabled = false;
          runBtn.textContent = 'Run now';
          runBtn.classList.remove('viz-btn--busy');
        }
      });
    });

    confirmGo.addEventListener('click', () => {
      const run = pending;
      hideConfirm();
      status.textContent = '';
      if (run) void run();
    });
    confirmCancel.addEventListener('click', () => {
      hideConfirm();
    });
  }
}

/** Wire a segmented control: clicking an option fires `onPick(value)` (the caller applies/confirms). */
function wireSegment(li: HTMLElement, groupCls: string, onPick: (value: string) => void): void {
  for (const opt of Array.from(li.querySelectorAll<HTMLButtonElement>(`.${groupCls} .viz-seg-opt`))) {
    opt.addEventListener('click', () => {
      const v = opt.dataset.value;
      if (v) onPick(v);
    });
  }
}
