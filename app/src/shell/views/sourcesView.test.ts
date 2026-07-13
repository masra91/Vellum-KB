// @vitest-environment happy-dom
//
// SPEC-0027 PANEL-4 / INTAKE-14 — the unified Sources Manage view, component tier (happy-dom). IPC
// mocked; asserts the rendered feed strips, the WS2 guardrails (segmented schedule, NO native <select>),
// the enable-confirm gate (enabling starts an outbound pull), the typed pull report, add-from-tile, the
// Watched-folders "arriving" section, and HTML escaping of untrusted connector fields.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountSources } from './sourcesView';
import type { IntakeConnectorView, WatchFolderView, KbApi } from '../../kb/types';

const rss: IntakeConnectorView = {
  id: 'news', type: 'rss', typeLabel: 'RSS / Atom feed', label: 'news', enabled: false, schedule: 'off',
  scope: 'global', sensitivity: 'internal', maxItemsPerPass: 25, feedUrl: 'https://example.com/feed.xml', tenantId: '', folder: '', lastRun: null,
};
const folder: WatchFolderView = {
  id: 'inbox', folderPath: '/Users/me/KB-Inbox', label: 'inbox', enabled: true, scope: 'global', sensitivity: 'internal',
  ignoreGlobs: ['*.tmp'], recursive: false, maxDepth: 0, leaveOriginals: false, watching: true, lastEvent: { ts: '2025-06-03T09:00:00Z', kind: 'watch-ingested', path: 'note.md' },
};

let listIntakeConnectors: ReturnType<typeof vi.fn>;
let setIntakeConnectorConfig: ReturnType<typeof vi.fn>;
let removeIntakeConnector: ReturnType<typeof vi.fn>;
let runIntakeConnectorNow: ReturnType<typeof vi.fn>;
let listWatchFolders: ReturnType<typeof vi.fn>;
let setWatchFolder: ReturnType<typeof vi.fn>;
let removeWatchFolder: ReturnType<typeof vi.fn>;
let pickFolder: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    listIntakeConnectors: listIntakeConnectors as unknown as KbApi['listIntakeConnectors'],
    setIntakeConnectorConfig: setIntakeConnectorConfig as unknown as KbApi['setIntakeConnectorConfig'],
    removeIntakeConnector: removeIntakeConnector as unknown as KbApi['removeIntakeConnector'],
    runIntakeConnectorNow: runIntakeConnectorNow as unknown as KbApi['runIntakeConnectorNow'],
    listWatchFolders: listWatchFolders as unknown as KbApi['listWatchFolders'],
    setWatchFolder: setWatchFolder as unknown as KbApi['setWatchFolder'],
    removeWatchFolder: removeWatchFolder as unknown as KbApi['removeWatchFolder'],
    pickFolder: pickFolder as unknown as KbApi['pickFolder'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listIntakeConnectors = vi.fn(async () => [rss]);
  setIntakeConnectorConfig = vi.fn(async () => [{ ...rss, enabled: true }]);
  removeIntakeConnector = vi.fn(async () => []);
  runIntakeConnectorNow = vi.fn(async () => ({ ran: true, sourceIds: ['SRC1'], note: 'ok' }));
  listWatchFolders = vi.fn(async () => [folder]);
  setWatchFolder = vi.fn(async () => [folder]);
  removeWatchFolder = vi.fn(async () => []);
  pickFolder = vi.fn(async () => '/Users/me/Newsletters');
  setApi();
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  // #510: mountSources() now only builds the skeleton + returns lifecycle hooks; show() (which the
  // shell calls right after mount) is what actually loads + paints — mirror that here.
  mountSources(c).show?.();
  await flush();
  return c;
}

describe('Sources view (PANEL-4 / INTAKE-14)', () => {
  it('renders a feed strip with id, type label, enable switch, feed-url field, segmented schedule — no native <select>', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    expect(strip).toBeTruthy();
    expect(strip.querySelector('.rdesk-id')!.textContent).toBe('news');
    expect(strip.querySelector('.rdesk-kind')!.textContent).toContain('RSS / Atom feed');
    expect(strip.querySelector('.intake-arm')!.textContent).toContain('Paused'); // UX v2 §4: sentence-case ink label + hue dot (was UPPERCASE ◉/○)
    expect((strip.querySelector('.intake-feedurl') as HTMLInputElement).value).toBe('https://example.com/feed.xml');
    expect(strip.querySelector('.intake-schedule[role="radiogroup"]')).toBeTruthy();
    expect(c.querySelector('select')).toBeNull(); // WS2: segmented control, never a native select
  });

  it('UX v2 (SPEC-0058): material-carded sections + tokenized marks, no emoji glyphs leaked (#184)', async () => {
    const c = await mount();
    // scoped material marker present (so the shared rdesk-* language isn't restyled globally)
    expect(c.querySelector('.rdesk.src-v2')).toBeTruthy();
    // v3: the Feeds section is a headed BAND (the strips inside are the cards), not v2 viz-card chrome
    const sections = Array.from(c.querySelectorAll('.src-section'));
    expect(sections.length).toBe(1); // Connectors = Feeds only (watched-folders moved to Settings)
    expect(sections.every((s) => !s.classList.contains('viz-card'))).toBe(true);
    expect(c.querySelector('.rdesk-strip.ag-card')).toBeTruthy(); // each connector is a v3 card
    // type marks are tokenized (hue-class), and the armed switch carries a hue dot — both aria-hidden
    expect(c.querySelector('.src-mark--rss')).toBeTruthy();
    expect(c.querySelector('.intake-arm .src-arm-dot')).toBeTruthy();
    // NO raw emoji glyphs anywhere in the rendered Sources view (the v2 tokenization, #184) — the marks
    // are GEOMETRIC symbols (◈/▣/●), never pictographic emoji. Guards the specific removed glyphs + the
    // emoji pictographic blocks (not the geometric U+25xx symbol block the tokenized marks legitimately use).
    expect(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F0FF}]|📰|📂|✉|🔌/u.test(c.textContent ?? '')).toBe(false);
  });

  it('Connectors = the Feeds section only — watched-folders moved to Settings (SPEC-0060 IA)', async () => {
    const c = await mount();
    const heads = Array.from(c.querySelectorAll('.src-section-head')).map((h) => h.textContent);
    expect(heads).toEqual(['Feeds']); // no Watched-folders section here anymore
    expect(c.querySelector('.rdesk-strip[data-watch-id]')).toBeNull(); // no watched-folder strips in Connectors
    expect(c.querySelector('.watch-add-pick')).toBeNull();
  });

  it('enabling a paused feed asks to confirm (it starts an outbound pull), then applies on confirm', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    (strip.querySelector('.intake-arm') as HTMLButtonElement).click();
    await flush();
    const confirm = strip.querySelector('.intake-confirm') as HTMLElement;
    expect(confirm.hidden).toBe(false);
    expect(strip.querySelector('.intake-confirm-msg')!.textContent).toMatch(/Enable .*pull from RSS/i);
    expect(setIntakeConnectorConfig).not.toHaveBeenCalled(); // gated — not applied yet
    (strip.querySelector('.intake-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(setIntakeConnectorConfig).toHaveBeenCalledWith({ id: 'news', enabled: true });
  });

  it('schedule change applies directly (no confirm — steering)', async () => {
    const c = await mount();
    const opts = Array.from(c.querySelectorAll<HTMLButtonElement>('.intake-schedule .rdesk-seg-opt'));
    const daily = opts.find((o) => o.dataset.value === 'daily')!;
    daily.click();
    await flush();
    expect(setIntakeConnectorConfig).toHaveBeenCalledWith({ id: 'news', schedule: 'daily' });
  });

  it('"Pull now" runs the connector and shows the typed item count', async () => {
    runIntakeConnectorNow = vi.fn(async () => ({ ran: true, sourceIds: ['A', 'B'], note: 'ok' }));
    setApi();
    const c = await mount();
    (c.querySelector('.rdesk-strip[data-id="news"] .intake-run') as HTMLButtonElement).click();
    await flush();
    (c.querySelector('.intake-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(runIntakeConnectorNow).toHaveBeenCalledWith('news');
    expect(c.querySelector('.rdesk-strip[data-id="news"] .intake-status')!.textContent).toContain('Brought in 2 new items');
  });

  it('a failed pull surfaces the error (failed ≠ empty), not "no items"', async () => {
    runIntakeConnectorNow = vi.fn(async () => ({ ran: true, sourceIds: [], note: 'x', failed: true, error: 'feed unreachable' }));
    setApi();
    const c = await mount();
    (c.querySelector('.intake-run') as HTMLButtonElement).click();
    await flush();
    (c.querySelector('.intake-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(c.querySelector('.intake-status')!.textContent).toMatch(/Couldn't pull — feed unreachable/);
  });

  it('add-from-tile: RSS + M365 tiles, then naming + re-click creates a PAUSED connector', async () => {
    const c = await mount();
    const tiles = Array.from(c.querySelectorAll<HTMLButtonElement>('.rdesk-tile[data-type]')); // feed tiles only
    expect(tiles.map((t) => t.dataset.type)).toEqual(['rss', 'm365-mail']);
    tiles[0].click(); // choose RSS
    (c.querySelector('.intake-add-id') as HTMLInputElement).value = 'Hacker News';
    tiles[0].click(); // re-click = create
    await flush();
    expect(setIntakeConnectorConfig).toHaveBeenCalledWith({ id: 'hacker-news', type: 'rss', enabled: false });
  });

  it('escapes untrusted connector fields (no HTML injection via feedUrl)', async () => {
    listIntakeConnectors = vi.fn(async () => [{ ...rss, id: 'x', feedUrl: '"><img src=x onerror=alert(1)>' }]);
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull(); // the payload is escaped, never parsed as a tag
  });

  it('renders the branded compact empty state (#406) when there are no feeds', async () => {
    listIntakeConnectors = vi.fn(async () => []);
    setApi();
    const c = await mount();
    const empty = c.querySelector('.src-section .viz-empty--compact');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toMatch(/No feeds yet/);
    expect(c.querySelector('.rdesk-tile[data-type]')).toBeTruthy(); // feed add-dock still present
  });

  // PANEL-11 lifecycle delete — a user-added feed is REMOVABLE behind a destructive confirm; the produced
  // items + audit are retained (the copy explains it), only the config is purged.
  it('a feed has a Remove affordance with its OWN destructive (danger) confirm', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    const removeBtn = strip.querySelector('.intake-remove') as HTMLButtonElement;
    expect(removeBtn).toBeTruthy();
    // The remove confirm is its own block with a danger-styled Confirm — not the primary enable/pull confirm.
    expect(strip.querySelector('.intake-remove-confirm .viz-btn--danger')).toBeTruthy();
    // ...and the confirm frame itself is oxide (viz-confirm--danger) to match the danger button (DL coherence).
    expect(strip.querySelector('.intake-remove-confirm')?.classList.contains('viz-confirm--danger')).toBe(true);
  });

  it('Remove gates behind a confirm (items kept), then calls removeIntakeConnector only on confirm', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    (strip.querySelector('.intake-remove') as HTMLButtonElement).click();
    await flush();
    const confirm = strip.querySelector('.intake-remove-confirm') as HTMLElement;
    expect(confirm.hidden).toBe(false);
    expect(strip.querySelector('.intake-remove-confirm-msg')!.textContent).toMatch(/Items already brought in.*stay in your library/i);
    expect(removeIntakeConnector).not.toHaveBeenCalled(); // gated — not removed yet
    (strip.querySelector('.intake-remove-confirm-go') as HTMLButtonElement).click();
    await flush();
    expect(removeIntakeConnector).toHaveBeenCalledWith('news');
  });

  it('Remove can be cancelled — nothing is removed', async () => {
    const c = await mount();
    const strip = c.querySelector('.rdesk-strip[data-id="news"]')!;
    (strip.querySelector('.intake-remove') as HTMLButtonElement).click();
    await flush();
    (strip.querySelector('.intake-remove-confirm-cancel') as HTMLButtonElement).click();
    await flush();
    expect((strip.querySelector('.intake-remove-confirm') as HTMLElement).hidden).toBe(true);
    expect(removeIntakeConnector).not.toHaveBeenCalled();
  });

  // ENG-15/16 render safety: legacy/partial connector rows must not crash the view, and per-row isolation
  // means a malformed row never takes out a well-formed neighbor's Remove affordance.
  it('renders partial/legacy connector rows without crashing, keeping per-row Remove', async () => {
    const partial = { id: 'legacy', type: 'rss' } as unknown as IntakeConnectorView; // missing typeLabel/label/feedUrl/etc.
    listIntakeConnectors = vi.fn(async () => [partial, rss]);
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('.rdesk-strip[data-id]').length).toBe(2); // both rows rendered, neither crashed
    expect(c.querySelector('.rdesk-strip[data-id="legacy"] .intake-remove')).toBeTruthy();
    expect(c.querySelector('.rdesk-strip[data-id="news"] .intake-remove')).toBeTruthy();
  });
});

// SPEC-0060 VUX-1: the Connectors (.src-*) CSS block migrates off the instrument-panel --viz-* names onto
// the warm-vellum v3 tokens. NO ember (a passive intake list isn't a decision). Guard on the CSS source.
describe('VUX-1 v3 token migration (SPEC-0060 — Connectors, off --viz-*)', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  const block = indexCss.slice(
    indexCss.indexOf('Connectors view — VELLUM v3'),
    indexCss.indexOf('Activity view — VELLUM v3'),
  );

  it('isolated the Connectors v3 block', () => {
    expect(block.length).toBeGreaterThan(400);
  });

  it('the v3 Connectors block carries NO --viz-* tokens and NO ember', () => {
    expect(block).not.toMatch(/var\(--viz-/);
    expect(block).not.toMatch(/--ember|var\(--ember/);
  });

  it('uses v3 ground/ink + interactive/state tokens (ink/slate/viridian/sprout)', () => {
    expect(block).toMatch(/var\(--ink\b/);
    expect(block).toMatch(/var\(--slate\b/); // interactive (feeds/mail mark, arm)
    expect(block).toMatch(/var\(--viridian\b/); // folder mark / armed card
    expect(block).toMatch(/var\(--sprout\b/); // active dot
  });
});
