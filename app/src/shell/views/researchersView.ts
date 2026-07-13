// Researchers / Manage view — "The Field Desk" (SPEC-0028 RESEARCH-15/17; design: researchers-manage.md).
// The roster of agents the Principal briefs + dispatches OUTSIDE the KB. Built on the shared design
// system ("The Line" — shell/design-system.css: --viz-* tokens, type-roles, flat-ink primitives), so
// the app reads as one instrument language (DESIGN-7). Thin DOM over the typed IPC; pure logic
// (view-build + risk gate + labels) lives in `kb/researchersPanel` (node-tested).
//
// Design language (§§1–6):
// - Each researcher is a flat **instrument strip** on a ruled spine — NO card chrome (§6 guardrails).
// - **Clearance = temperature**: egress tier is a 3-rung ladder (local=patina · internal=brass ·
//   public=ember), a custom spatial control, NOT a <select>. Widening confirms (RESEARCH-8 risky).
// - **Armed vs at-rest**: a custom arm switch (◉ ENABLED in clearance color / ○ PAUSED graphite).
// - **Brief → dispatch → report**: standing-orders box + a Run that dispatches + a TYPED report
//   (found=patina / nothing=calm / failed=oxide / paused-rate-limit=brass / escalation=brass), so
//   failure/blocked never masquerade as empty (#160/#180; RESEARCH-11).
// - schedule/autonomy + the add-kind picker are custom segmented/tile controls, never native <select>.
import { esc } from '../html';
import { withTimeout, renderLoadError, paintSkeleton } from '../loadGuard';
import { formatTimestamp } from '../formatTime';
import {
  schedulePresetLabel,
  SCHEDULE_OPTIONS,
  isRiskyResearcherChange,
  RESEARCHER_TEMPLATE_OPTIONS,
  EGRESS_TIER_LABELS,
  defaultEgressFor,
  researcherOutcomeLabel,
  researcherRunEligibility,
  workIqCardPresentation,
} from '../../kb/researchersPanel';
import { EGRESS_TIERS, MIN_TOOL_CALLS, MAX_TOOL_CALLS, MIN_SESSION_TIMEOUT_MS, MAX_SESSION_TIMEOUT_MS, MIN_MAX_DEPTH, MAX_MAX_DEPTH, MIN_ORIENT_BUDGET, MAX_ORIENT_BUDGET } from '../../kb/researchers';
import { navigateTo } from '../nav';
import { VIEW_REVIEWS } from '../views';
import type { ViewHandle } from '../viewLifecycle';
import type { EgressTier } from '../../kb/researchers';
import type { WorkIqStatus } from '../../kb/types'; // WORKIQ-UI contract — defined by DEV-3's WORKIQ-FIX
import type { WorkIqCardModel, WorkIqCardPresentation } from '../../kb/researchersPanel';
import type { ResearcherView, ResearcherConfigPatch } from '../../kb/types';

/** Source-kind glyph (design §2) — a named instrument, not a dropdown value. */
const KIND_GLYPH: Record<ResearcherView['template'], string> = { web: '◇', code: '◆', m365: '▣', custom: '＋' };
/** Clearance rung label (short) + the temperature it lights, per egress tier (design §3). */
const CLEARANCE: Record<EgressTier, { rung: string }> = {
  'local-only': { rung: 'LOCAL' },
  'internal-tenant': { rung: 'INTERNAL' },
  'public-web': { rung: 'PUBLIC' },
};
const POSTURE_OPTIONS = ['guarded', 'autonomous'] as const;
const POSTURE_LABEL: Record<string, string> = { guarded: 'Guarded', autonomous: 'Autonomous' };

const TEMPLATE_BY_KEY = new Map(RESEARCHER_TEMPLATE_OPTIONS.map((o) => [o.template, o]));
const templateLabel = (t: ResearcherView['template']): string => TEMPLATE_BY_KEY.get(t)?.label ?? t;
const templateDesc = (t: ResearcherView['template']): string => TEMPLATE_BY_KEY.get(t)?.description ?? '';

// Mounted as the **Researchers** section of the Agents hub (SPEC-0053 WS-E): the hub owns the group
// header/naming, so this section drops its own page-title h1 and renders the field desk directly.
const HEADER = `<p class="rdesk-sub viz-body">Agents you brief and dispatch outside your library — they bring back cited sources. Clearance shows how far each one's data can travel.</p>`;

export function mountResearchers(container: HTMLElement): ViewHandle {
  paintSkeleton(container, HEADER, 'cards');
  return { show: () => void render(container) }; // #510: re-read on every activation (no timers here)
}

async function render(container: HTMLElement): Promise<void> {
  let researchers: ResearcherView[];
  try {
    // #145: bound the wait so a hung `listResearchers` shows a retryable error, never an infinite spinner.
    researchers = await withTimeout(window.kbApi.listResearchers());
  } catch {
    renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  const roster = researchers.length
    ? `<ul class="rdesk-roster">${researchers.map(strip).join('')}</ul>`
    : `<p class="rdesk-empty viz-body">No researchers yet — dispatch one from a template below.</p>`;
  container.innerHTML = `<div class="rdesk viz-surface">${HEADER}${roster}${addDock()}</div>`;
  wire(container, researchers);
}

/** Segmented instrument selector (§6) — custom radio-style control, NOT a native <select>. */
function segmented(cls: string, label: string, options: readonly { value: string; text: string }[], selected: string): string {
  const rungs = options
    .map((o) => `<button type="button" role="radio" class="rdesk-seg-opt viz-seg-opt viz-signage viz-focusable" data-value="${esc(o.value)}" aria-checked="${o.value === selected ? 'true' : 'false'}">${esc(o.text)}</button>`)
    .join('');
  return `<div class="rdesk-seg"><span class="rdesk-seg-label viz-signage">${esc(label)}</span><span class="viz-seg ${esc(cls)}" role="radiogroup" aria-label="${esc(label)}">${rungs}</span></div>`;
}

/** The clearance ladder (§2/§3) — 3 rungs, the active one lit in its temperature; a spatial exposure
 *  scale that replaces the egress <select>. Widening (toward public) triggers the confirm at wire-time. */
function clearanceLadder(active: EgressTier): string {
  const rungs = EGRESS_TIERS.map(
    (t) =>
      `<button type="button" role="radio" class="rdesk-rung viz-seg-opt viz-seg-opt--clearance viz-signage viz-focusable" data-tier="${esc(t)}" data-temp="${esc(t)}" aria-checked="${t === active ? 'true' : 'false'}" title="${esc(EGRESS_TIER_LABELS[t])}">${esc(CLEARANCE[t].rung)}</button>`,
  ).join('');
  return `<div class="rdesk-clearance"><span class="rdesk-clearance-label viz-signage">clearance</span><span class="rdesk-ladder viz-seg" role="radiogroup" aria-label="Data clearance">${rungs}</span></div>`;
}

/** The state glyph carried on the report flag (DESIGN-4: state via glyph + hue + fill, NEVER color
 *  alone — and the glyph is what carries oxide for `failed`, since oxide can't color the small report
 *  text at AA; the text stays --viz-ink). */
const REPORT_FLAG: Record<string, string> = { found: '✓', nothing: '·', paused: '◑', failed: '✕', never: '·' };

/** The dispatch report (§6) — typed + state-coded so failed/paused never read as a legit empty result.
 *  The state HUE rides the leading glyph + the strip flag (≥3:1 graphic), not the small body text
 *  (which stays --viz-ink at AA 4.5:1 — KB-Design-Lead's required fix on #184). */
function reportLine(r: ResearcherView): string {
  const flag = (state: string): string => `<span class="rdesk-report-flag" aria-hidden="true">${REPORT_FLAG[state]}</span> `;
  if (!r.lastRun) return `<span class="rdesk-report" data-state="never">${flag('never')}never dispatched</span>`;
  const lr = r.lastRun;
  const when = esc(formatTimestamp(lr.ts));
  const outcome = researcherOutcomeLabel(lr.eventType);
  const state =
    lr.eventType === 'researched' ? 'found' : lr.eventType === 'research-failed' ? 'failed' : lr.eventType === 'ceiling-reached' || lr.eventType === 'escalated' ? 'paused' : 'nothing';
  const detail =
    lr.eventType === 'researched'
      ? ` — brought back <span class="viz-numeric">${lr.citations}</span> cited source${lr.citations === 1 ? '' : 's'} on “${esc(lr.what)}”`
      : '';
  // A depth-limit escalation is ACTIONABLE — deep-link "needs your review" to the open Review so the
  // affordance isn't a dead status line (RESEARCH-11; resume-on-confirm closes the loop on confirm).
  const open =
    lr.eventType === 'escalated' && lr.reviewId
      ? ` <button type="button" class="rdesk-review-link viz-signage viz-focusable" data-review-id="${esc(lr.reviewId)}">open review →</button>`
      : '';
  return `<span class="rdesk-report" data-state="${state}">${flag(state)}last dispatch ${when} · ${esc(outcome)}${detail}</span>${open}`;
}

/** The reach readout (§2/§6). WS3 + warm-start: `reads/pass` (maxToolCalls), `orient/pass` (orientBudget —
 *  the non-egress awareness cap, RESEARCH-22), `timeout` (RESEARCH-15/18), and `depth` (maxDepth — the
 *  chain-depth safety bound, RESEARCH-11) are all EDITABLE on the WS2 EditableField primitive (`viz-field`);
 *  the tool allowlist (SECURITY surface) stays READ-ONLY. Edits persist via setResearcherConfig (clamped at
 *  the IPC boundary). */
function reachReadout(r: ResearcherView): string {
  // ENG-15/16 render safety: a legacy/partial row may be missing the derived `budget`/`allowedTools`/
  // numeric fields. Coalesce so a malformed row degrades to blanks (still wireable + still Retire-able —
  // PANEL-11's "remove a misconfigured entity") instead of THROWING inside the roster `.map` and blanking
  // the whole list (the ENG-16 `title:null` class). Production rows arrive complete via buildResearcherViews.
  const tools = (r.allowedTools ?? []).length ? r.allowedTools.join(' · ') : 'default';
  const timeoutMin = typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs) ? Math.max(1, Math.round(r.timeoutMs / 60_000)) : '';
  const maxCalls = r.budget?.maxToolCalls ?? '';
  const maxDepth = r.budget?.maxDepth ?? '';
  const orient = r.orientBudget ?? '';
  return `
    <div class="rdesk-reach viz-numeric">
      <label class="viz-field rdesk-reach-field">
        <span class="viz-field__label">Searches per run</span>
        <input type="number" class="viz-field__input viz-field__input--numeric researcher-maxcalls viz-focusable" min="${MIN_TOOL_CALLS}" max="${MAX_TOOL_CALLS}" step="1" value="${maxCalls}" aria-label="Max retrieval calls per pass" />
      </label>
      <label class="viz-field rdesk-reach-field">
        <span class="viz-field__label">Local reads per run</span>
        <input type="number" class="viz-field__input viz-field__input--numeric researcher-orient viz-focusable" min="${MIN_ORIENT_BUDGET}" max="${MAX_ORIENT_BUDGET}" step="1" value="${orient}" aria-label="Local orient/awareness reads per pass (non-egress)" />
      </label>
      <label class="viz-field rdesk-reach-field">
        <span class="viz-field__label">Gives up after (min)</span>
        <input type="number" class="viz-field__input viz-field__input--numeric researcher-timeout viz-focusable" min="${Math.ceil(MIN_SESSION_TIMEOUT_MS / 60_000)}" max="${Math.round(MAX_SESSION_TIMEOUT_MS / 60_000)}" step="1" value="${timeoutMin}" aria-label="Session timeout in minutes" />
      </label>
      <label class="viz-field rdesk-reach-field">
        <span class="viz-field__label">Max depth</span>
        <input type="number" class="viz-field__input viz-field__input--numeric researcher-maxdepth viz-focusable" min="${MIN_MAX_DEPTH}" max="${MAX_MAX_DEPTH}" step="1" value="${maxDepth}" aria-label="Max research chain depth" />
      </label>
      <span class="rdesk-reach-ro">tools: ${esc(tools)}</span>
    </div>`;
}

/** One researcher strip — a briefed instrument (design §2). */
function strip(r: ResearcherView): string {
  const armed = r.enabled;
  const elig = researcherRunEligibility(r); // WS1 #2: honest run-eligibility — "Off" ≠ won't run
  const fields = [
    r.template === 'code' ? field('repo', 'researcher-repopath', r.repoPath, '/absolute/path/to/local/repo') : '',
    r.template === 'code' ? field('PRs (read-only)', 'researcher-prrepo', r.prRepo, 'owner/name') : '',
    r.template === 'm365' ? field('tenant', 'researcher-tenant', r.tenantId, 'your-org.onmicrosoft.com') : '',
  ].join('');
  return `
    <li class="rdesk-strip ag-card" data-id="${esc(r.id)}" data-clearance="${esc(r.egressTier)}" data-armed="${armed ? 'true' : 'false'}">
      <div class="rdesk-strip-head">
        <span class="rdesk-id viz-numeric">${esc(r.id)}</span>
        <button type="button" class="rdesk-arm viz-focusable" role="switch" aria-checked="${armed ? 'true' : 'false'}"><span class="dot" aria-hidden="true"></span>${armed ? 'Enabled' : 'Paused'}</button>
      </div>
      <div class="rdesk-identity">
        <span class="rdesk-kind viz-signage" title="${esc(templateDesc(r.template))}">${esc(KIND_GLYPH[r.template])} ${esc(templateLabel(r.template))}</span>
        ${clearanceLadder(r.egressTier)}
      </div>
      ${r.template === 'm365' ? workIqCard() : ''}
      ${reachReadout(r)}
      <div class="rdesk-orders">
        <label class="rdesk-orders-label viz-field__label viz-signage">Standing orders</label>
        <textarea class="researcher-prompt rdesk-prompt viz-field__input viz-field__input--multiline viz-body viz-focusable" rows="3" placeholder="What should this researcher look for? Which sites, repo, or work surfaces?">${esc(r.prompt)}</textarea>
        <div class="rdesk-fields">
          ${field('scope', 'researcher-scope', r.scope, '')}
          ${fields}
          <button type="button" class="viz-btn researcher-save rdesk-save">Save orders</button>
        </div>
      </div>
      <div class="rdesk-config">
        ${segmented('researcher-schedule', 'schedule', SCHEDULE_OPTIONS.map((p) => ({ value: p, text: schedulePresetLabel(p) })), r.schedule)}
        ${segmented('researcher-posture', 'autonomy', POSTURE_OPTIONS.map((p) => ({ value: p, text: POSTURE_LABEL[p] })), r.posture)}
      </div>
      <p class="rdesk-eligibility researcher-eligibility viz-body" data-will-run="${elig.willRun ? 'true' : 'false'}">${esc(elig.note)}</p>
      <div class="rdesk-footer viz-ruled">
        ${reportLine(r)}
        <button type="button" class="viz-btn researcher-remove rdesk-remove" title="Retire this researcher — remove it from your roster">Retire</button>
        <button type="button" class="viz-btn rdesk-run researcher-run" data-clearance="${esc(r.egressTier)}">▷ Run</button>
      </div>
      <div class="rdesk-confirm viz-confirm researcher-confirm" hidden>
        <p class="rdesk-confirm-msg viz-confirm__msg researcher-confirm-msg viz-body"></p>
        <button type="button" class="viz-btn researcher-confirm-cancel">Cancel</button>
        <button type="button" class="viz-btn viz-btn--danger rdesk-confirm-go researcher-confirm-go">Confirm</button>
      </div>
      <p class="rdesk-status researcher-status viz-body" role="status" aria-live="polite"></p>
    </li>`;
}

/** A labeled instrument field (caption + input) — flat, captioned, not a loose input (§2). */
function field(label: string, cls: string, value: string, placeholder: string): string {
  return `<label class="rdesk-field viz-field"><span class="rdesk-field-label viz-field__label viz-signage">${esc(label)}</span><input type="text" class="${esc(cls)} rdesk-input viz-field__input viz-body viz-focusable" value="${esc(value)}" placeholder="${esc(placeholder)}" /></label>`;
}

/** WORKIQ-UI — the m365/WorkIQ connector install/status card (only on m365 strips). The connector CLI
 *  is the prerequisite the researcher reaches the tenant through; absent, WORKIQ-FIX's wire has nothing
 *  to call (silent no-finding). Renders an initial `Checking…` shell with a STABLE `role=status` live
 *  region (so a state change announces) — `wireWorkIq` fills it from the global IPC detect and drives
 *  Install/Retry/Recheck. State rides the DOT (a graphic ≥3:1), not the small text (the #184 AA rule,
 *  same as `.rdesk-report`). The action button + detail live in-DOM (hidden) so only text/tone/attrs
 *  mutate — never the live-region node itself. */
function workIqCard(): string {
  const p = workIqCardPresentation({ state: 'checking' });
  return `
      <div class="rdesk-workiq" data-state="checking">
        <span class="rdesk-workiq-label viz-field__label viz-signage">WorkIQ connector</span>
        <span class="rdesk-workiq-status viz-body" role="status" aria-live="polite" data-tone="${p.tone}">
          <span class="rdesk-workiq-dot" aria-hidden="true"></span>
          <span class="rdesk-workiq-text">${esc(workIqLine(p))}</span>
        </span>
        <button type="button" class="viz-btn viz-btn--sm rdesk-workiq-action viz-focusable" hidden></button>
        <span class="rdesk-workiq-detail viz-body" hidden></span>
      </div>`;
}

/** The status line text: label + the trailing glyph (✓) when present. */
function workIqLine(p: WorkIqCardPresentation): string {
  return p.glyph ? `${p.label} ${p.glyph}` : p.label;
}

/** Paint one m365 card from a presentation — mutates text/tone/state/affordance in place (keeps the
 *  `role=status` node stable so aria-live announces the change). */
function applyWorkIq(card: HTMLElement, p: WorkIqCardPresentation): void {
  card.dataset.state = p.state;
  const status = card.querySelector<HTMLElement>('.rdesk-workiq-status');
  const text = card.querySelector<HTMLElement>('.rdesk-workiq-text');
  const btn = card.querySelector<HTMLButtonElement>('.rdesk-workiq-action');
  const detail = card.querySelector<HTMLElement>('.rdesk-workiq-detail');
  if (status) status.dataset.tone = p.tone;
  if (text) text.textContent = workIqLine(p);
  if (btn) {
    if (p.action) {
      btn.textContent = p.action.label;
      btn.hidden = false;
      btn.disabled = p.action.busy;
      btn.classList.toggle('viz-btn--busy', p.action.busy);
    } else {
      btn.hidden = true;
      btn.disabled = false;
      btn.classList.remove('viz-btn--busy');
    }
  }
  if (detail) {
    detail.textContent = p.detail;
    detail.hidden = !p.detail;
  }
}

/** Wire the m365 connector card(s). Status is GLOBAL (one connector CLI), so a single detect updates
 *  every m365 strip. Degrades to an honest "Status unavailable / Recheck" if the IPC handler isn't
 *  present yet (WORKIQ-FIX backend not landed) — never a silent dead control (#160 class). */
function wireWorkIq(container: HTMLElement): void {
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.rdesk-workiq'));
  if (!cards.length) return;
  const paint = (m: WorkIqCardModel): void => {
    const p = workIqCardPresentation(m);
    for (const c of cards) applyWorkIq(c, p);
  };
  // Map the IPC contract → the card's view-state. Installed shows the resolved CLI path; not-installed
  // surfaces the install command the Install button will run (so the Principal sees what happens first).
  const toModel = (s: WorkIqStatus): WorkIqCardModel =>
    s.installed
      ? { state: 'installed', detail: s.cliPath }
      : { state: 'not-installed', detail: s.installCommand };
  const refresh = async (): Promise<void> => {
    paint({ state: 'checking' });
    try {
      paint(toModel(await window.kbApi.workIqStatus()));
    } catch {
      paint({ state: 'error' });
    }
  };
  const install = async (): Promise<void> => {
    paint({ state: 'installing' });
    try {
      const res = await window.kbApi.installWorkIq();
      // The result is a discriminated union; this repo's tsconfig is non-strict, where truthiness
      // narrowing on `res.ok` doesn't refine the union — so distinguish the failure arm via `'error' in
      // res`, the same idiom the RunResearcherResult union uses below.
      if ('error' in res) paint({ state: 'install-failed', detail: res.error });
      else paint(toModel(res.status));
    } catch {
      paint({ state: 'install-failed' });
    }
  };
  for (const c of cards) {
    const btn = c.querySelector<HTMLButtonElement>('.rdesk-workiq-action');
    btn?.addEventListener('click', () => {
      // The action is Recheck in the detect-error state, else Install/Retry.
      if (c.dataset.state === 'error') void refresh();
      else void install();
    });
  }
  void refresh();
}

/** The add-dock (§2) — named template TILES (glyph + label), not a <select>. Each creates a disarmed
 *  researcher; arming it later is the gated step. */
function addDock(): string {
  const tiles = RESEARCHER_TEMPLATE_OPTIONS.map(
    (o) => `<button type="button" class="rdesk-tile viz-no-chrome viz-focusable" data-template="${esc(o.template)}" title="${esc(o.description)}"><span class="rdesk-tile-glyph">${esc(KIND_GLYPH[o.template])}</span><span class="rdesk-tile-label">${esc(o.label)}</span></button>`,
  ).join('');
  return `
    <div class="rdesk-add">
      <span class="rdesk-add-head viz-signage">Dispatch a new researcher</span>
      <div class="rdesk-tiles" role="group" aria-label="Researcher templates">${tiles}</div>
      <input class="researcher-add-id rdesk-add-id viz-body viz-focusable" type="text" placeholder="Name it (e.g. Prior-art web search)" aria-label="researcher name" />
      <p class="researcher-add-status rdesk-add-status viz-body" role="status" aria-live="polite"></p>
    </div>`;
}

function wire(container: HTMLElement, researchers: ResearcherView[]): void {
  const byId = new Map(researchers.map((r) => [r.id, r]));
  wireWorkIq(container); // WORKIQ-UI: drive the m365 connector install/status card(s)

  // Add-from-tile: a tile selects the template (highlights) — the Name input + Enter (or re-click) creates.
  let chosenTemplate: ResearcherConfigPatch['template'] | null = null;
  const tiles = Array.from(container.querySelectorAll<HTMLButtonElement>('.rdesk-tile'));
  const addId = container.querySelector<HTMLInputElement>('.researcher-add-id');
  for (const tile of tiles) {
    tile.addEventListener('click', () => {
      const t = tile.dataset.template as ResearcherConfigPatch['template'];
      if (chosenTemplate === t) {
        void addResearcher(container, t); // re-click a chosen tile = dispatch
        return;
      }
      chosenTemplate = t;
      for (const x of tiles) x.setAttribute('aria-pressed', x === tile ? 'true' : 'false');
      addId?.focus();
    });
  }
  addId?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && chosenTemplate) void addResearcher(container, chosenTemplate);
  });

  for (const li of Array.from(container.querySelectorAll<HTMLElement>('.rdesk-strip'))) {
    const id = li.dataset.id!;
    const current = byId.get(id)!;
    const armEl = li.querySelector<HTMLButtonElement>('.rdesk-arm')!;
    const promptEl = li.querySelector<HTMLTextAreaElement>('.researcher-prompt')!;
    const scopeEl = li.querySelector<HTMLInputElement>('.researcher-scope')!;
    const repoPathEl = li.querySelector<HTMLInputElement>('.researcher-repopath'); // code only
    const prRepoEl = li.querySelector<HTMLInputElement>('.researcher-prrepo'); // code only
    const tenantEl = li.querySelector<HTMLInputElement>('.researcher-tenant'); // m365 only
    const saveBtn = li.querySelector<HTMLButtonElement>('.researcher-save')!;
    const maxCallsEl = li.querySelector<HTMLInputElement>('.researcher-maxcalls')!; // WS3 editable budget
    const timeoutEl = li.querySelector<HTMLInputElement>('.researcher-timeout')!; // WS3 editable session timeout
    const maxDepthEl = li.querySelector<HTMLInputElement>('.researcher-maxdepth')!; // WS3 Slice-2 editable chain-depth bound
    const orientEl = li.querySelector<HTMLInputElement>('.researcher-orient')!; // warm-start editable orient budget
    const runBtn = li.querySelector<HTMLButtonElement>('.researcher-run')!;
    const removeBtn = li.querySelector<HTMLButtonElement>('.researcher-remove')!; // PANEL-11 lifecycle delete
    const reviewLink = li.querySelector<HTMLButtonElement>('.rdesk-review-link'); // only on an escalated last-run
    const confirm = li.querySelector<HTMLElement>('.researcher-confirm')!;
    const confirmMsg = li.querySelector<HTMLElement>('.researcher-confirm-msg')!;
    const confirmGo = li.querySelector<HTMLButtonElement>('.researcher-confirm-go')!;
    const confirmCancel = li.querySelector<HTMLButtonElement>('.researcher-confirm-cancel')!;
    const status = li.querySelector<HTMLElement>('.researcher-status')!;

    let pending: (() => Promise<void>) | null = null;
    let revert: (() => void) | null = null;
    const hideConfirm = (): void => {
      confirm.hidden = true;
      confirm.classList.remove('viz-confirm--danger'); // reset the frame hue so the next (benign) confirm isn't left oxide
      confirmMsg.textContent = ''; // WS1 #1: clear the prompt on dismiss so a stale message can't linger
      pending = null;
      revert = null;
    };
    // `danger` paints the confirm frame oxide to match a destructive go-button (DL ConfirmInline: danger=oxide).
    // The shared confirm serves both the destructive Retire (danger) and the egress-caution arm/widen prompts,
    // so the hue is per-invocation — set here, cleared in hideConfirm.
    const askConfirm = (message: string, run: () => Promise<void>, undo: () => void, danger = false): void => {
      pending = run;
      revert = undo;
      confirmMsg.textContent = message;
      confirm.classList.toggle('viz-confirm--danger', danger);
      confirm.hidden = false;
    };
    const apply = async (patch: ResearcherConfigPatch): Promise<void> => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setResearcherConfig(patch);
        await render(container);
      } catch {
        status.textContent = 'Could not save the change.';
      }
    };

    // Arm switch (enable/disable) — enabling reaches outside the KB → consequence-worded confirm.
    armEl.addEventListener('click', () => {
      const next = !current.enabled;
      const patch: ResearcherConfigPatch = { id, enabled: next };
      if (isRiskyResearcherChange(asConfig(current), patch)) {
        askConfirm(
          `Arm “${current.label}”? It will reach ${EGRESS_TIER_LABELS[current.egressTier]} on its ${schedulePresetLabel(current.schedule)} schedule.`,
          () => apply(patch),
          () => {},
        );
      } else void apply(patch);
    });

    // Clearance ladder — set egress by rung; WIDENING (more exposure) confirms (RESEARCH-8).
    for (const rung of Array.from(li.querySelectorAll<HTMLButtonElement>('.rdesk-rung'))) {
      rung.addEventListener('click', () => {
        const egressTier = rung.dataset.tier as ResearcherConfigPatch['egressTier'];
        if (!egressTier || egressTier === current.egressTier) return;
        const patch: ResearcherConfigPatch = { id, egressTier };
        if (isRiskyResearcherChange(asConfig(current), patch)) {
          askConfirm(
            `Widen where “${current.label}” can send data to ${EGRESS_TIER_LABELS[egressTier]}? More of your library can leave to a less-trusted destination.`,
            () => apply(patch),
            () => {},
          );
        } else void apply(patch);
      });
    }

    // Autonomy segmented — → Autonomous confirms (findings applied without Review).
    wireSegment(li, '.researcher-posture', (value) => {
      const posture = value as ResearcherConfigPatch['posture'];
      if (posture === current.posture) return;
      const patch: ResearcherConfigPatch = { id, posture };
      if (isRiskyResearcherChange(asConfig(current), patch)) {
        askConfirm(`Set “${current.label}” to Autonomous? Its findings will be applied without routing to Reviews first.`, () => apply(patch), () => {});
      } else void apply(patch);
    });

    // Schedule segmented — steering, not risky → applies directly.
    wireSegment(li, '.researcher-schedule', (value) => {
      if (value === current.schedule) return;
      void apply({ id, schedule: value as ResearcherConfigPatch['schedule'] });
    });

    // Standing orders + scope — steering, saved on an explicit button, no confirm. The backend keeps the
    // prior value on a blank save, so a stray empty save can't wipe a researcher's instructions.
    saveBtn.addEventListener('click', () => void apply({ id, prompt: promptEl.value, scope: scopeEl.value, ...(repoPathEl ? { repoPath: repoPathEl.value } : {}), ...(prRepoEl ? { prRepo: prRepoEl.value } : {}), ...(tenantEl ? { tenantId: tenantEl.value } : {}) }));

    // Editable budget + timeout (WS3, RESEARCH-15/18) — steering, applies directly on change (no confirm).
    // The IPC clamps/validates; the re-render reflects the persisted (clamped) value, so an out-of-range
    // entry round-trips back to the pinned bound. A blank/non-numeric entry is dropped (field unchanged).
    maxCallsEl.addEventListener('change', () => {
      const n = Number(maxCallsEl.value);
      if (Number.isFinite(n)) void apply({ id, maxToolCalls: n });
      else void render(container); // restore the field to its persisted value
    });
    timeoutEl.addEventListener('change', () => {
      const min = Number(timeoutEl.value);
      if (Number.isFinite(min)) void apply({ id, timeoutMs: Math.round(min * 60_000) });
      else void render(container);
    });
    maxDepthEl.addEventListener('change', () => {
      const n = Number(maxDepthEl.value);
      if (Number.isFinite(n)) void apply({ id, maxDepth: n });
      else void render(container); // restore the field to its persisted value
    });
    orientEl.addEventListener('change', () => {
      const n = Number(orientEl.value);
      if (Number.isFinite(n)) void apply({ id, orientBudget: n });
      else void render(container); // restore the field to its persisted value
    });

    runBtn.addEventListener('click', () => {
      askConfirm(
        `Dispatch “${current.label}” now? It performs one bounded research pass.`,
        async () => {
          // PANEL-10 state machine: idle → DISPATCHING (button disabled + breathing) → typed report.
          status.textContent = '';
          runBtn.disabled = true;
          runBtn.textContent = 'DISPATCHING…';
          runBtn.classList.add('viz-btn--busy'); // §3 busy state — ember breathe on the Button primitive
          try {
            const res = await window.kbApi.runResearcherNow(id);
            let msg: string;
            if ('reason' in res) msg = `Couldn't run (${res.reason}).`;
            else if (res.failed) msg = `Couldn't run${res.error ? ` — ${res.error}` : ''}.`; // failed ≠ empty (#160)
            else if (res.ceilingReached) msg = 'Paused — research rate limit reached for now; try again later.'; // ceiling ≠ empty (RESEARCH-11)
            else msg = res.sourceIds.length ? `Brought back ${res.sourceIds.length} cited source${res.sourceIds.length === 1 ? '' : 's'}.` : 'Nothing new this pass.';
            await render(container);
            const after = container.querySelector<HTMLElement>(`.rdesk-strip[data-id="${id}"] .researcher-status`);
            if (after) after.textContent = msg;
          } catch {
            status.textContent = "Couldn't run.";
            runBtn.disabled = false;
            runBtn.textContent = '▷ Run';
            runBtn.classList.remove('viz-btn--busy');
          }
        },
        () => {},
      );
    });

    // Retire (PANEL-11 lifecycle delete) — DESTRUCTIVE: purges the researcher's config. Confirm via the
    // shared danger-styled affordance, flagged `danger` so the frame goes oxide to match the go-button
    // (DL ConfirmInline coherence). Sources it already brought back + its full activity trail are RETAINED
    // — only the config/registration is removed.
    removeBtn.addEventListener('click', () => {
      askConfirm(
        `Retire “${current.label}”? Its configuration is removed and it stops running. Sources it already brought in — and its full activity trail — stay in your library.`,
        async () => {
          status.textContent = 'Retiring…';
          try {
            await window.kbApi.removeResearcher(id);
            await render(container);
          } catch {
            status.textContent = 'Could not retire this researcher.';
          }
        },
        () => {},
        true, // destructive → oxide confirm frame
      );
    });

    confirmGo.addEventListener('click', () => {
      const run = pending;
      hideConfirm();
      status.textContent = '';
      if (run) void run();
    });
    confirmCancel.addEventListener('click', () => {
      const undo = revert;
      hideConfirm();
      undo?.();
    });

    // Escalation deep-link — "open review →" navigates to the Reviews queue where this researcher's
    // depth-limit Review awaits the Principal's confirm/reject (RESEARCH-11; no dead affordance).
    reviewLink?.addEventListener('click', () => navigateTo(VIEW_REVIEWS));
  }
}

/** Wire a segmented control: clicking an option fires `onPick(value)` (the caller applies/confirms). */
function wireSegment(li: HTMLElement, groupCls: string, onPick: (value: string) => void): void {
  for (const opt of Array.from(li.querySelectorAll<HTMLButtonElement>(`${groupCls} .rdesk-seg-opt`))) {
    opt.addEventListener('click', () => {
      const v = opt.dataset.value;
      if (v) onPick(v);
    });
  }
}

/** Build the minimal ResearcherConfig-shaped object the pure risk gate needs from a strip's view row. */
function asConfig(v: ResearcherView): import('../../kb/researchers').ResearcherConfig {
  return { id: v.id, template: v.template, prompt: '', egressTier: v.egressTier, scope: v.scope, budget: { maxToolCalls: 0, maxDepth: 0 }, schedule: v.schedule, posture: v.posture, enabled: v.enabled, topics: v.topics };
}

async function addResearcher(container: HTMLElement, template: ResearcherConfigPatch['template']): Promise<void> {
  const idEl = container.querySelector<HTMLInputElement>('.researcher-add-id')!;
  const status = container.querySelector<HTMLElement>('.researcher-add-status')!;
  // #6: the user types a friendly NAME; we slugify it into the canonical id behind the scenes.
  const id = slugifyId(idEl.value.trim());
  if (!id) {
    status.textContent = 'Give the researcher a name (letters or digits).';
    idEl.focus();
    return;
  }
  status.textContent = 'Adding…';
  try {
    // Created DISARMED with the template's default clearance — safe; arming it later is the confirm gate.
    await window.kbApi.setResearcherConfig({ id, template, egressTier: template ? defaultEgressFor(template) : undefined, enabled: false });
    await render(container);
  } catch {
    status.textContent = 'Could not add — try a simpler name (letters, digits, spaces).';
  }
}

/** Slugify a friendly name into a canonical researcher id ([a-z0-9-], no leading/trailing dashes). */
function slugifyId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
