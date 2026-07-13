// Control Panel · Sources — the unified Sources management view (SPEC-0027 PANEL-4: INTAKE-14 feed
// connectors + WATCH-9 watched folders, ONE surface). Built on the WS2 design-system primitives
// (shell/design-system.css `viz-*`), reusing the shared manage-view strip layout (`rdesk-*`, token-
// based + generic) for visual consistency with Researchers/Jobs. Both halves are live: Feeds manage
// INTAKE connectors; Watched folders manage WATCH folders (DEV-5's backend). Degrades gracefully — a
// section whose IPC fails still renders the other (PANEL-9), never a broken canvas.
import { esc, emptyState } from '../html';
import { withTimeout, renderLoadError, paintSkeleton } from '../loadGuard';
import {
  schedulePresetLabel,
  SCHEDULE_OPTIONS,
  INTAKE_CONNECTOR_CATALOG,
  isRiskyIntakeChange,
  intakeRunEligibility,
  intakeOutcomeLabel,
} from '../../kb/intakeSourcingPanel';
import type { IntakeConnectorView, IntakeConnectorConfigPatch } from '../../kb/types';
import type { IntakeConnectorConfig } from '../../kb/intakeConnectors';

/** A tokenized type mark per connector type (UX v2 §4 / #184): a small hue-carrying glyph, NOT an emoji —
 *  the hue reads the connector family, the typeLabel carries the words (label stays ink). */
const TYPE_MARK: Record<string, string> = { rss: '◈', 'm365-mail': '◇', folder: '▣' };
function typeMark(type: string): string {
  return `<span class="src-mark src-mark--${esc(type in TYPE_MARK ? type : 'other')}" aria-hidden="true">${TYPE_MARK[type] ?? '◌'}</span>`;
}

/** The armed-state switch (UX v2 §4 / #184): a hue-carrying dot + a sentence-case INK label — replaces the
 *  old UPPERCASE `◉ ENABLED` / `○ PAUSED`. sprout=active/watching, accent=enabled-idle, idle=paused. */
function armSwitch(cls: string, armed: boolean, active: boolean, label: string): string {
  const tone = armed ? (active ? 'src-arm-dot--active' : 'src-arm-dot--on') : 'src-arm-dot--off';
  return `<button type="button" class="rdesk-arm ${cls} src-arm viz-focusable" role="switch" aria-checked="${armed ? 'true' : 'false'}"><span class="src-arm-dot ${tone}" aria-hidden="true">●</span> ${esc(label)}</button>`;
}

// Spectral head (viz-voice), sentence-case copy. The `src-v2` marker scopes the material/voice override
// to Connectors only — the shared `rdesk-*` manage-view language is NOT restyled globally.
// SPEC-0060 IA: Connectors = the OUTWARD intake (feeds). Watched folders moved to Settings (mountWatchedFolders).
const HEADER = `<h1 class="rdesk-title src-title viz-voice">Connectors</h1><p class="rdesk-sub viz-body">Feeds you subscribe to — new items arrive as sources in your library.</p>`;

export async function mountSources(container: HTMLElement): Promise<void> {
  paintSkeleton(container, HEADER, 'cards');
  await render(container);
}

async function render(container: HTMLElement): Promise<void> {
  // #145: bound the read so a hung IPC can't leave an infinite spinner.
  let connectors: IntakeConnectorView[];
  try {
    connectors = await withTimeout(window.kbApi.listIntakeConnectors());
  } catch {
    renderLoadError(container, HEADER, () => void render(container));
    return;
  }
  // Empty-BY-DESIGN → compact .viz-empty (not a load error).
  const feeds = connectors.length
    ? `<ul class="rdesk-roster">${connectors.map(strip).join('')}</ul>`
    : emptyState({ compact: true, title: 'No feeds yet.', body: 'Add one from a template below.' });

  container.innerHTML = `<div class="rdesk viz-surface src-v2">${HEADER}
    <section class="src-section">
      <h2 class="src-section-head viz-voice">Feeds</h2>
      ${feeds}
      ${addDock()}
    </section>
  </div>`;
  wire(container, connectors);
  for (const r of Array.from(container.querySelectorAll<HTMLButtonElement>('.src-retry'))) r.addEventListener('click', () => void render(container));
}

/** A segmented control (role=radiogroup of buttons — no native &lt;select&gt;, the WS2 SegmentedControl). */
function segmented(cls: string, label: string, options: readonly { value: string; text: string }[], selected: string): string {
  const opts = options
    .map((o) => `<button type="button" role="radio" class="rdesk-seg-opt viz-seg-opt viz-signage viz-focusable" data-value="${esc(o.value)}" aria-checked="${o.value === selected ? 'true' : 'false'}">${esc(o.text)}</button>`)
    .join('');
  return `<div class="rdesk-seg"><span class="rdesk-seg-label viz-signage">${esc(label)}</span><span class="viz-seg ${esc(cls)}" role="radiogroup" aria-label="${esc(label)}">${opts}</span></div>`;
}

/** A labeled instrument field (caption + input) on the WS2 EditableField primitive. */
function field(label: string, cls: string, value: string, placeholder: string): string {
  return `<label class="rdesk-field viz-field"><span class="rdesk-field-label viz-field__label viz-signage">${esc(label)}</span><input type="text" class="${esc(cls)} rdesk-input viz-field__input viz-body viz-focusable" value="${esc(value)}" placeholder="${esc(placeholder)}" /></label>`;
}

const REPORT_FLAG: Record<string, string> = { intook: '✓', empty: '·', failed: '✕', never: '·' };

/** The last-pull report line — typed, jargon-free (never the raw audit slug). */
function reportLine(c: IntakeConnectorView): string {
  const flag = (state: string): string => `<span class="rdesk-report-flag" aria-hidden="true">${REPORT_FLAG[state]}</span> `;
  if (!c.lastRun) return `<span class="rdesk-report" data-state="never">${flag('never')}never pulled</span>`;
  const lr = c.lastRun;
  const state = lr.eventType === 'intook' ? 'intook' : lr.eventType === 'intake-failed' ? 'failed' : 'empty';
  const when = new Date(lr.ts).toLocaleString();
  const outcome = intakeOutcomeLabel(lr.eventType);
  const detail =
    state === 'intook'
      ? ` — brought in <span class="viz-numeric">${lr.count}</span> item${lr.count === 1 ? '' : 's'}`
      : state === 'failed' && lr.error
        ? ` — ${esc(lr.error)}`
        : '';
  return `<span class="rdesk-report" data-state="${state}">${flag(state)}last pull ${esc(when)} · ${esc(outcome)}${detail}</span>`;
}

/** Type-specific config fields: RSS = feed URL; M365-mail = tenant + folder. */
function configFields(c: IntakeConnectorView): string {
  if (c.type === 'rss') return field('Feed URL', 'intake-feedurl', c.feedUrl, 'https://example.com/feed.xml');
  if (c.type === 'm365-mail') return `${field('Tenant', 'intake-tenant', c.tenantId, 'your tenant id')}${field('Folder', 'intake-folder', c.folder, 'Inbox')}`;
  return '';
}

function strip(c: IntakeConnectorView): string {
  const armed = c.enabled;
  const elig = intakeRunEligibility(c);
  const scheduleOpts = SCHEDULE_OPTIONS.map((s) => ({ value: s, text: schedulePresetLabel(s) }));
  return `
    <li class="rdesk-strip ag-card" data-id="${esc(c.id)}" data-armed="${armed ? 'true' : 'false'}">
      <div class="rdesk-strip-head">
        <span class="rdesk-id viz-numeric">${esc(c.id)}</span>
        ${armSwitch('intake-arm', armed, false, armed ? 'Enabled' : 'Paused')}
      </div>
      <div class="rdesk-identity">
        <span class="rdesk-kind src-kind">${typeMark(c.type)} ${esc(c.typeLabel)}</span>
      </div>
      <div class="rdesk-orders">
        <div class="rdesk-fields">
          ${configFields(c)}
          ${field('Scope', 'intake-scope', c.scope, 'global')}
          ${field('Sensitivity', 'intake-sensitivity', c.sensitivity, 'internal')}
          <label class="rdesk-field viz-field"><span class="rdesk-field-label viz-field__label viz-signage">items / pull</span><input type="number" class="intake-maxitems viz-field__input viz-field__input--numeric viz-focusable" min="1" max="200" step="1" value="${c.maxItemsPerPass}" aria-label="Max items per pull" /></label>
          <button type="button" class="viz-btn intake-save rdesk-save">Save</button>
        </div>
      </div>
      <div class="rdesk-config">
        ${segmented('intake-schedule', 'Schedule', scheduleOpts, c.schedule)}
      </div>
      <p class="rdesk-eligibility intake-eligibility viz-body" data-will-run="${elig.willRun ? 'true' : 'false'}">${esc(elig.note)}</p>
      <div class="rdesk-footer viz-ruled">
        ${reportLine(c)}
        <button type="button" class="viz-btn intake-remove" title="Remove this feed — forget its configuration">Remove</button>
        <button type="button" class="viz-btn rdesk-run intake-run">▷ Pull now</button>
      </div>
      <div class="rdesk-confirm viz-confirm intake-confirm" hidden>
        <p class="rdesk-confirm-msg viz-confirm__msg intake-confirm-msg viz-body"></p>
        <button type="button" class="viz-btn intake-confirm-cancel">Cancel</button>
        <button type="button" class="viz-btn viz-btn--primary intake-confirm-go">Confirm</button>
      </div>
      <div class="rdesk-confirm viz-confirm viz-confirm--danger intake-remove-confirm" hidden>
        <p class="rdesk-confirm-msg viz-confirm__msg intake-remove-confirm-msg viz-body"></p>
        <button type="button" class="viz-btn intake-remove-confirm-cancel">Cancel</button>
        <button type="button" class="viz-btn viz-btn--danger intake-remove-confirm-go">Remove</button>
      </div>
      <p class="rdesk-status intake-status viz-body" role="status" aria-live="polite"></p>
    </li>`;
}

/** The add-dock — named template TILES (glyph + label), not a &lt;select&gt;. Each creates a PAUSED
 *  connector; enabling it later is the gated step (enabling starts an outbound pull). */
function addDock(): string {
  const tiles = INTAKE_CONNECTOR_CATALOG.map(
    (o) => `<button type="button" class="rdesk-tile viz-no-chrome viz-focusable" data-type="${esc(o.type)}" title="${esc(o.description)}"><span class="rdesk-tile-glyph">${typeMark(o.type)}</span><span class="rdesk-tile-label">${esc(o.label)}</span></button>`,
  ).join('');
  return `
    <div class="rdesk-add">
      <span class="rdesk-add-head viz-voice">Add a feed</span>
      <div class="rdesk-tiles" role="group" aria-label="Feed templates">${tiles}</div>
      <input class="intake-add-id rdesk-add-id viz-body viz-focusable" type="text" placeholder="Name it (e.g. Hacker News)" aria-label="feed name" />
      <p class="intake-add-status rdesk-add-status viz-body" role="status" aria-live="polite"></p>
    </div>`;
}

/** Minimal connector shape the pure risk gate needs from a view row. */
function asIntakeConfig(v: IntakeConnectorView): IntakeConnectorConfig {
  return { id: v.id, type: v.type, schedule: v.schedule, enabled: v.enabled, scope: v.scope, sensitivity: v.sensitivity };
}

function wire(container: HTMLElement, connectors: IntakeConnectorView[]): void {
  const byId = new Map(connectors.map((c) => [c.id, c]));

  // Add-from-tile: a tile selects the type (highlights); the Name input + Enter (or re-click) creates.
  let chosenType: IntakeConnectorConfigPatch['type'] | null = null;
  const tiles = Array.from(container.querySelectorAll<HTMLButtonElement>('.rdesk-tile'));
  const addId = container.querySelector<HTMLInputElement>('.intake-add-id');
  for (const tile of tiles) {
    tile.addEventListener('click', () => {
      const t = tile.dataset.type as IntakeConnectorConfigPatch['type'];
      if (chosenType === t) {
        void addConnector(container, t);
        return;
      }
      chosenType = t;
      for (const x of tiles) x.setAttribute('aria-pressed', x === tile ? 'true' : 'false');
      addId?.focus();
    });
  }
  addId?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && chosenType) void addConnector(container, chosenType);
  });

  for (const li of Array.from(container.querySelectorAll<HTMLElement>('.rdesk-strip[data-id]'))) {
    const id = li.dataset.id!;
    const current = byId.get(id)!;
    const armEl = li.querySelector<HTMLButtonElement>('.intake-arm')!;
    const feedUrlEl = li.querySelector<HTMLInputElement>('.intake-feedurl'); // rss only
    const tenantEl = li.querySelector<HTMLInputElement>('.intake-tenant'); // m365 only
    const folderEl = li.querySelector<HTMLInputElement>('.intake-folder'); // m365 only
    const scopeEl = li.querySelector<HTMLInputElement>('.intake-scope')!;
    const sensitivityEl = li.querySelector<HTMLInputElement>('.intake-sensitivity')!;
    const maxItemsEl = li.querySelector<HTMLInputElement>('.intake-maxitems')!;
    const saveBtn = li.querySelector<HTMLButtonElement>('.intake-save')!;
    const runBtn = li.querySelector<HTMLButtonElement>('.intake-run')!;
    const removeBtn = li.querySelector<HTMLButtonElement>('.intake-remove')!; // PANEL-11 lifecycle delete
    const confirm = li.querySelector<HTMLElement>('.intake-confirm')!;
    const confirmMsg = li.querySelector<HTMLElement>('.intake-confirm-msg')!;
    const confirmGo = li.querySelector<HTMLButtonElement>('.intake-confirm-go')!;
    const confirmCancel = li.querySelector<HTMLButtonElement>('.intake-confirm-cancel')!;
    const status = li.querySelector<HTMLElement>('.intake-status')!;

    let pending: (() => Promise<void>) | null = null;
    const hideConfirm = (): void => {
      confirm.hidden = true;
      confirmMsg.textContent = '';
      pending = null;
    };
    const askConfirm = (message: string, run: () => Promise<void>): void => {
      pending = run;
      confirmMsg.textContent = message;
      confirm.hidden = false;
    };
    const apply = async (patch: IntakeConnectorConfigPatch): Promise<void> => {
      status.textContent = 'Saving…';
      try {
        await window.kbApi.setIntakeConnectorConfig(patch);
        await render(container);
      } catch {
        status.textContent = 'Could not save the change.';
      }
    };

    // Enable/disable — enabling starts an outbound pull (egress to the feed/tenant) → consequence-worded confirm.
    armEl.addEventListener('click', () => {
      const next = !current.enabled;
      const patch: IntakeConnectorConfigPatch = { id, enabled: next };
      if (isRiskyIntakeChange(asIntakeConfig(current), patch)) {
        askConfirm(`Enable “${current.label}”? It will pull from ${current.typeLabel} on its ${schedulePresetLabel(current.schedule)} schedule.`, () => apply(patch));
      } else void apply(patch);
    });

    // Schedule segmented — steering, not risky → applies directly.
    for (const opt of Array.from(li.querySelectorAll<HTMLButtonElement>('.intake-schedule .rdesk-seg-opt'))) {
      opt.addEventListener('click', () => {
        const v = opt.dataset.value;
        if (v && v !== current.schedule) void apply({ id, schedule: v as IntakeConnectorConfigPatch['schedule'] });
      });
    }

    // Config + scope/sensitivity — steering, saved on an explicit button (blank fields are dropped backend-side).
    saveBtn.addEventListener('click', () =>
      void apply({
        id,
        scope: scopeEl.value,
        sensitivity: sensitivityEl.value,
        ...(feedUrlEl ? { feedUrl: feedUrlEl.value } : {}),
        ...(tenantEl ? { tenantId: tenantEl.value } : {}),
        ...(folderEl ? { folder: folderEl.value } : {}),
      }),
    );

    // Editable items-per-pull (INTAKE-11) — applies on change; the IPC clamps, the re-render reflects the
    // persisted (clamped) value, so an out-of-range entry round-trips back to the pinned bound.
    maxItemsEl.addEventListener('change', () => {
      const n = Number(maxItemsEl.value);
      if (Number.isFinite(n)) void apply({ id, maxItemsPerPass: Math.round(n) });
      else void render(container);
    });

    runBtn.addEventListener('click', () => {
      askConfirm(`Pull “${current.label}” now? It performs one bounded pull.`, async () => {
        status.textContent = '';
        runBtn.disabled = true;
        runBtn.textContent = 'PULLING…';
        runBtn.classList.add('viz-btn--busy');
        try {
          const res = await window.kbApi.runIntakeConnectorNow(id);
          let msg: string;
          if ('reason' in res) msg = `Couldn't pull (${res.reason}).`;
          else if (res.failed) msg = `Couldn't pull${res.error ? ` — ${res.error}` : ''}.`; // failed ≠ empty (INTAKE-12)
          else msg = res.sourceIds.length ? `Brought in ${res.sourceIds.length} new item${res.sourceIds.length === 1 ? '' : 's'}.` : 'No new items this pull.';
          await render(container);
          const after = container.querySelector<HTMLElement>(`.rdesk-strip[data-id="${id}"] .intake-status`);
          if (after) after.textContent = msg;
        } catch {
          status.textContent = "Couldn't pull.";
          runBtn.disabled = false;
          runBtn.textContent = '▷ Pull now';
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
    confirmCancel.addEventListener('click', () => hideConfirm());

    // Remove (PANEL-11 lifecycle delete) — DESTRUCTIVE: purges the feed's config. Its own dedicated
    // danger-styled confirm (the shared intake confirm is primary-styled for benign enable/pull). Items it
    // already brought in — and the audit trail — are RETAINED; only the configuration is forgotten.
    const removeConfirm = li.querySelector<HTMLElement>('.intake-remove-confirm')!;
    const removeConfirmMsg = li.querySelector<HTMLElement>('.intake-remove-confirm-msg')!;
    const removeConfirmGo = li.querySelector<HTMLButtonElement>('.intake-remove-confirm-go')!;
    const removeConfirmCancel = li.querySelector<HTMLButtonElement>('.intake-remove-confirm-cancel')!;
    removeBtn.addEventListener('click', () => {
      removeConfirmMsg.textContent = `Remove “${current.label}”? Its configuration is forgotten and it stops pulling. Items already brought in — and its activity trail — stay in your library.`;
      removeConfirm.hidden = false;
    });
    removeConfirmGo.addEventListener('click', async () => {
      removeConfirm.hidden = true;
      status.textContent = 'Removing…';
      try {
        await window.kbApi.removeIntakeConnector(id);
        await render(container);
      } catch {
        status.textContent = 'Could not remove this feed.';
      }
    });
    removeConfirmCancel.addEventListener('click', () => {
      removeConfirm.hidden = true;
    });
  }
}

async function addConnector(container: HTMLElement, type: IntakeConnectorConfigPatch['type']): Promise<void> {
  const idEl = container.querySelector<HTMLInputElement>('.intake-add-id')!;
  const status = container.querySelector<HTMLElement>('.intake-add-status')!;
  const id = slugifyId(idEl.value.trim());
  if (!id) {
    status.textContent = 'Give the feed a name (letters or digits).';
    idEl.focus();
    return;
  }
  status.textContent = 'Adding…';
  try {
    // Created PAUSED — safe; enabling it later is the confirm gate (it starts an outbound pull).
    await window.kbApi.setIntakeConnectorConfig({ id, type, enabled: false });
    await render(container);
  } catch {
    status.textContent = 'Could not add — try a simpler name (letters, digits, spaces).';
  }
}

/** Slugify a friendly name into a canonical connector id ([a-z0-9-], no leading/trailing dashes). */
function slugifyId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
