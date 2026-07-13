// @vitest-environment happy-dom
//
// SPEC-0029 AUDIT-5/6/7/8 — the Activity view, component tier (happy-dom, per-file env; node tier
// stays default). The IPC is mocked (`window.kbApi.activityFeed/activityLineage`); we assert the
// rendered DOM, the drill-down, the filter→re-query, lineage, and read-only/escaping behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountActivity, lineageHtml, entryHtml, rawEventHtml, SEARCH_DEBOUNCE_MS } from './activityView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { ActivityFeedResult, Lineage, KbApi } from '../../kb/types';

function feed(entries: ActivityFeedResult['entries'], total = entries.length, truncated = false): ActivityFeedResult {
  return { entries, total, truncated };
}

const ENTRIES: ActivityFeedResult['entries'] = [
  {
    id: 'C1',
    ts: '2026-01-01T00:02:00.000Z',
    actor: 'claims',
    summary: 'Claims derived 2 claims about E1',
    eventCount: 2,
    events: [
      { ts: '2026-01-01T00:01:00.000Z', actor: 'claims', eventType: 'start', subjects: { entityId: 'E1', sourceId: 'S1' }, payload: {}, provenance: { file: 'sources/2026/01/S1/audit.jsonl', line: 1 }, runId: 'C1' },
      { ts: '2026-01-01T00:02:00.000Z', actor: 'claims', eventType: 'claimed', subjects: { entityId: 'E1', sourceId: 'S1' }, payload: { claims: 2 }, provenance: { file: 'sources/2026/01/S1/audit.jsonl', line: 2 }, runId: 'C1' },
    ],
  },
  {
    id: 'A1',
    ts: '2026-01-01T00:00:00.000Z',
    actor: 'archivist',
    summary: 'Archived a new source',
    eventCount: 1,
    events: [{ ts: '2026-01-01T00:00:00.000Z', actor: 'archivist', eventType: 'archived', subjects: { sourceId: 'S1' }, payload: {}, provenance: { file: 'sources/2026/01/S1/audit.jsonl', line: 0 } }],
  },
];

let activityFeed: ReturnType<typeof vi.fn>;
let activityLineage: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Pick<KbApi, 'activityFeed' | 'activityLineage'> }).kbApi = {
    activityFeed: activityFeed as unknown as KbApi['activityFeed'],
    activityLineage: activityLineage as unknown as KbApi['activityLineage'],
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  activityFeed = vi.fn(async () => feed(ENTRIES, 3)); // 2 entries summarizing 3 raw events
  activityLineage = vi.fn(async () => ({ subjectId: 'E1', kind: 'entity', sources: ['S1'], events: ENTRIES[0].events, decisions: [] }) as Lineage);
  setApi();
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  mountActivity(c);
  await flush();
  return c;
}

describe('Activity feed (AUDIT-5)', () => {
  it('renders curated entries newest-first with an event count', async () => {
    const c = await mount();
    const items = c.querySelectorAll('.activity-entry');
    expect(items).toHaveLength(2);
    // UX v2 row: the summary is the `.activity-ft` text block (verb + detail), not the old `.activity-summary`.
    expect(c.querySelector('.activity-ft')?.textContent).toContain('Claims derived 2 claims about E1');
    expect(c.textContent).toContain('2 events'); // the multi-event run shows its count
    expect(c.querySelector('.activity-count')?.textContent).toContain('3 events'); // total, not entry count
  });

  // UX v2 Activity render contract (DL-2) — the gateable substance: glyph-tile hue typing, the
  // structural overlap fix, compact relative timestamps, oxide-on-failure / no-ember.
  describe('UX v2 row (DL-2 render contract)', () => {
    it('leads each row with a glyph-tile typed by event kind (#184 hue-on-tile)', async () => {
      const c = await mount();
      const heads = c.querySelectorAll('.activity-entry-head');
      // C1 = claims → gl--claim; A1 = archivist → gl--capture. Hue rides the tile; tile is aria-hidden.
      expect(heads[0].querySelector('.activity-gl')?.classList.contains('gl--claim')).toBe(true);
      expect(heads[1].querySelector('.activity-gl')?.classList.contains('gl--capture')).toBe(true);
      expect(c.querySelector('.activity-gl')?.getAttribute('aria-hidden')).toBe('true');
      // the tile renders the shared icons.ts line-icon SVG (navIcon), not an emoji/char
      expect(c.querySelector('.activity-gl svg')).not.toBeNull();
    });

    it('structurally prevents the id↔timestamp overlap: .activity-ft shrinks, .activity-fw is its own fixed slot', async () => {
      // A hostile long ULID in the summary must not be able to reach the timestamp (the QD-2 bug).
      activityFeed = vi.fn(async () =>
        feed([{ id: 'L1', ts: '2026-01-01T00:00:00.000Z', actor: 'enrich', summary: 'Enrich noted a signal on 01KW6CW289ZZZZZZZZZZZZZZZZ', eventCount: 1, events: [{ ts: '2026-01-01T00:00:00.000Z', actor: 'enrich', eventType: 'research-request', subjects: { entityId: '01KW6CW289ZZZZZZZZZZZZZZZZ' }, payload: {}, provenance: { file: '.kb/audit.jsonl', line: 0 } }] }]),
      );
      setApi();
      const c = await mount();
      const ft = c.querySelector('.activity-ft')!;
      const fw = c.querySelector('.activity-fw')!;
      expect(ft.className).toContain('activity-ft'); // the min-width:0 + overflow-wrap carrier (CSS)
      expect(fw.className).toContain('activity-fw'); // the flex:none + nowrap carrier — structurally immune
      // the long id lives inside .ft (can wrap), never as a bare sibling of the timestamp
      expect(ft.textContent).toContain('01KW6CW289ZZZZZZZZZZZZZZZZ');
      expect(fw.textContent).not.toContain('01KW6CW289');
    });

    it('renders a compact relative timestamp (not the verbose "min ago" form)', async () => {
      const justNow = new Date('2026-01-01T00:00:00.000Z').toISOString();
      activityFeed = vi.fn(async () => feed([{ id: 'T1', ts: justNow, actor: 'connect', summary: 'Connect merged 2', eventCount: 1, events: [{ ts: justNow, actor: 'connect', eventType: 'resolved', subjects: { entityId: 'E9' }, payload: {}, provenance: { file: 'x', line: 0 } }] }]));
      setApi();
      const c = await mount();
      const fw = c.querySelector('.activity-fw')?.textContent ?? '';
      expect(fw).not.toMatch(/ago|min|hr/); // compact form: "just now" / "6m" / "3h" / "2d", never "5 min ago"
    });

    it('tints a FAILED event oxide (honest failure) — and never ember anywhere on the feed', async () => {
      activityFeed = vi.fn(async () => feed([{ id: 'F1', ts: '2026-01-01T00:00:00.000Z', actor: 'claims', summary: 'Claims set aside an item', eventCount: 1, events: [{ ts: '2026-01-01T00:00:00.000Z', actor: 'claims', eventType: 'claims:setaside', subjects: { entityId: 'E1' }, payload: {}, provenance: { file: 'x', line: 0 } }] }]));
      setApi();
      const c = await mount();
      expect(c.querySelector('.activity-gl')?.classList.contains('gl--failed')).toBe(true);
      // no ember class anywhere in the feed (Activity logs the past — nothing needs a decision)
      expect(c.querySelector('[class*="ember"]')).toBeNull();
    });
  });

  it('surfaces truncation (never silently) when the window capped older events', async () => {
    activityFeed = vi.fn(async () => feed(ENTRIES, 500, true));
    setApi();
    const c = await mount();
    expect(c.querySelector('.activity-truncation')?.textContent).toContain('most recent of 500');
  });

  it('shows an empty state when there is no activity', async () => {
    activityFeed = vi.fn(async () => feed([]));
    setApi();
    const c = await mount();
    expect(c.querySelector('.activity-empty')).not.toBeNull();
  });

  // ENG-15/16: a legacy/partial audit entry (null actor, missing `events`/`provenance`/`payload`) must
  // NOT throw and blank the whole feed; one bad entry is isolated, its siblings still render.
  it('renders legacy/partial entries without crashing, and isolates a malformed entry from its siblings', async () => {
    type Entry = ActivityFeedResult['entries'][number];
    const legacy = { id: 'BAD', ts: '2026-01-01T00:03:00.000Z', actor: null, summary: 'legacy entry', eventCount: 1 } as unknown as Entry; // null actor + NO events array
    activityFeed = vi.fn(async () => feed([ENTRIES[0], legacy, ENTRIES[1]], 4));
    setApi();
    const c = await mount();
    // No throw + the feed isn't blanked: all three rows present (the malformed one degraded, not dropped).
    expect(c.querySelectorAll('.activity-entry')).toHaveLength(3);
    expect(c.textContent).toContain('Claims derived 2 claims about E1'); // good sibling intact
    expect(c.textContent).toContain('Archived a new source'); // good sibling intact
    expect(c.textContent).toContain('legacy entry'); // the malformed entry still shows its summary
  });

  it('ENG-15/16: entryHtml/rawEventHtml/lineageHtml tolerate missing events/provenance/payload (no throw)', () => {
    type Entry = ActivityFeedResult['entries'][number];
    const noEvents = { id: 'X', ts: '2026-01-01T00:00:00.000Z', actor: null, summary: 'no events', eventCount: 0 } as unknown as Entry;
    expect(() => entryHtml(noEvents, false)).not.toThrow();
    expect(() => entryHtml(noEvents, true)).not.toThrow(); // open → would map e.events (absent)
    // A raw event missing `provenance` → drill-down renders the JSON without the file:line footer.
    const noProv = { ts: '2026-01-01T00:00:00.000Z', actor: 'claims', eventType: 'x', subjects: {}, payload: {} } as unknown as Parameters<typeof rawEventHtml>[0];
    expect(() => rawEventHtml(noProv)).not.toThrow();
    expect(rawEventHtml(noProv)).not.toContain('activity-event-src');
    // A lineage decision missing `payload` → no throw (needs non-empty events to reach the decisions map).
    const lineage = { subjectId: 'E1', kind: 'entity', sources: [], events: ENTRIES[0].events, decisions: [{ eventType: 'reviewed' }] } as unknown as Lineage;
    expect(() => lineageHtml(lineage)).not.toThrow();
  });

  it('shows an error state when the feed fails to load', async () => {
    activityFeed = vi.fn(async () => {
      throw new Error('boom');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.activity-error')?.textContent).toContain('boom');
  });
});

describe('Drill-down to raw events (AUDIT-5)', () => {
  it('toggles the raw canonical events behind an entry on click', async () => {
    const c = await mount();
    const head = c.querySelector<HTMLButtonElement>('.activity-entry-head')!; // first entry (claims, C1)
    expect(c.querySelector('.activity-raw')).toBeNull();
    head.click();
    expect(c.querySelector('.activity-raw')).not.toBeNull();
    expect(c.querySelector('.activity-raw')?.textContent).toContain('"eventType": "claimed"');
    expect(c.querySelectorAll('.activity-event')).toHaveLength(2); // both raw events in the run
    expect(c.textContent).toContain('sources/2026/01/S1/audit.jsonl:2'); // provenance shown
    // re-query: the body innerHTML was swapped on toggle, so the prior node is detached.
    c.querySelector<HTMLButtonElement>('.activity-entry-head')!.click(); // collapse
    expect(c.querySelector('.activity-raw')).toBeNull();
  });
});

describe('Filter / search (AUDIT-7)', () => {
  it('debounces the text filter — no query on the keystroke, one query after the pause (VUX-14)', async () => {
    const c = await mount();
    const callsAfterMount = activityFeed.mock.calls.length;
    const search = c.querySelector<HTMLInputElement>('#activitySearch')!;
    // The Principal types fast: three keystrokes in quick succession.
    for (const v of ['a', 'at', 'atlas']) {
      search.value = v;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await flush();
    // Fails-before: the un-debounced view re-queried on every keystroke. Debounced, none fire yet.
    expect(activityFeed.mock.calls.length).toBe(callsAfterMount);
    // After the debounce window, exactly one query lands — with the final text.
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
    expect(activityFeed).toHaveBeenLastCalledWith({ text: 'atlas' });
    expect(activityFeed.mock.calls.length).toBe(callsAfterMount + 1);
  });

  it('re-queries with an actor filter; the dropdown is seeded from the loaded actors', async () => {
    const c = await mount();
    const sel = c.querySelector<HTMLSelectElement>('#activityActor')!;
    // options: "All" + the two actors present (archivist, claims), sorted.
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'archivist', 'claims']);
    sel.value = 'claims';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(activityFeed).toHaveBeenLastCalledWith({ actors: ['claims'] });
  });

  // VUX-CONFORM #524 §2/§8: a search that matches nothing is NOT the same empty state as "no
  // activity yet" — it names the search term and offers a working reset.
  it('shows the search-to-zero-results empty state naming the term, with a working Clear filters reset', async () => {
    activityFeed = vi.fn(async () => feed(ENTRIES, 3)).mockResolvedValueOnce(feed([], 0)).mockResolvedValue(feed([], 0));
    setApi();
    const c = await mount();
    const search = c.querySelector<HTMLInputElement>('#activitySearch')!;
    search.value = 'zzz-no-match';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(c.querySelector('.act-search')?.classList.contains('has-val')).toBe(true); // clear button appears immediately
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 50));
    const empty = c.querySelector('.act-empty');
    expect(empty).not.toBeNull();
    expect(empty?.querySelector('.term')?.textContent).toBe('zzz-no-match');
    expect(c.querySelector('.activity-empty')).toBeNull(); // NOT the "no activity yet" state

    activityFeed.mockResolvedValueOnce(feed(ENTRIES, 3));
    c.querySelector<HTMLButtonElement>('[data-act="clear-filters"]')!.click();
    await flush();
    expect(c.querySelector('.act-empty')).toBeNull();
    expect(c.querySelectorAll('.activity-entry')).toHaveLength(2);
    expect(c.querySelector<HTMLInputElement>('#activitySearch')?.value).toBe('');
  });
});

describe('Lineage (AUDIT-6)', () => {
  it('traces a subject and renders its provenance + timeline, then closes', async () => {
    const c = await mount();
    const traceBtn = c.querySelector<HTMLButtonElement>('.activity-trace')!; // claims entry → entityId E1
    traceBtn.click();
    await flush();
    expect(activityLineage).toHaveBeenCalledWith('E1');
    const panel = c.querySelector('.lineage-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('From source');
    expect(panel?.querySelectorAll('.lineage-step').length).toBeGreaterThan(0);
    c.querySelector<HTMLButtonElement>('[data-act="clear-lineage"]')!.click();
    expect(c.querySelector('.lineage-panel')).toBeNull();
  });

  // Regression (WS3 P1, KB-Lead defect): the "trace origin" action was an orphan <li> child flush to the
  // entry's left edge, off-center from the padded head. It must sit in the shared, aligned header row.
  it('keeps the trace-origin action in the aligned header row, not orphaned on the entry', async () => {
    const c = await mount();
    const row = c.querySelector('.activity-entry-row');
    expect(row).not.toBeNull();
    const traceBtn = c.querySelector<HTMLButtonElement>('.activity-trace')!;
    // trace lives inside the header row next to the toggle — not a bare child of the <li>.
    expect(traceBtn.closest('.activity-entry-row')).toBe(row);
    expect(traceBtn.parentElement).not.toBe(traceBtn.closest('.activity-entry'));
    expect(row!.querySelector('.activity-entry-head')).not.toBeNull();
  });
});

// AUDIT-6/7: lineage as a first-class addressable surface. The feed's per-entry "trace origin" only
// reaches subjects in the recent window; the lookup traces ANY entity/source/claim id the Principal
// holds (e.g. one copied from Explore) — the "per-entity lineage" + "per-source trace" surfaces.
describe('Trace-by-id lookup (AUDIT-6/7 — per-entity lineage + per-source trace)', () => {
  it('traces the entered id on the trace button, rendering the lineage panel', async () => {
    activityLineage = vi.fn(async () => ({ subjectId: 'S2', kind: 'source', sources: ['S2'], events: ENTRIES[0].events, decisions: [] }) as Lineage);
    setApi();
    const c = await mount();
    const input = c.querySelector<HTMLInputElement>('#activityTraceId')!;
    input.value = 'S2';
    c.querySelector<HTMLButtonElement>('[data-act="trace-lookup"]')!.click();
    await flush();
    expect(activityLineage).toHaveBeenCalledWith('S2'); // the typed id, not a feed subject
    expect(c.querySelector('.lineage-panel')).not.toBeNull();
  });

  it('submits on Enter in the input (keyboard-first), trimming surrounding whitespace', async () => {
    const c = await mount();
    const input = c.querySelector<HTMLInputElement>('#activityTraceId')!;
    input.value = '  E1  '; // a stray copy-paste space must not miss
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(activityLineage).toHaveBeenCalledWith('E1');
  });

  it('is a no-op for a blank/whitespace id (no empty traces)', async () => {
    const c = await mount();
    const input = c.querySelector<HTMLInputElement>('#activityTraceId')!;
    input.value = '   ';
    c.querySelector<HTMLButtonElement>('[data-act="trace-lookup"]')!.click();
    await flush();
    expect(activityLineage).not.toHaveBeenCalled();
  });

  // VUX-CONFORM #524 §2: trace-by-id is real shipped functionality with no mock equivalent — it
  // moved into its own .act-trace secondary control (out of the primary search/filter band) and
  // onto the v3-conformant .v3-btn ghost pill (§3), superseding the earlier WS3 .viz-field/.viz-btn.
  it('renders the lookup in its own .act-trace control with an accessible name + read-only chrome', async () => {
    const c = await mount();
    const input = c.querySelector<HTMLInputElement>('#activityTraceId')!;
    expect(input.closest('.act-trace')).not.toBeNull();
    expect(input.getAttribute('aria-label')).toBe('Trace lineage by id');
    const go = c.querySelector<HTMLButtonElement>('[data-act="trace-lookup"]')!;
    expect(go.classList.contains('v3-btn')).toBe(true);
    expect(go.classList.contains('v3-btn--ghost')).toBe(true);
    expect(go.getAttribute('aria-label')).toBe('Trace lineage of the entered id');
  });
});

describe('Read-only + XSS-safety (AUDIT-8)', () => {
  it('escapes hostile content in summaries/payloads and renders no mutating controls', async () => {
    const hostile: ActivityFeedResult['entries'] = [
      {
        id: 'X1',
        ts: '2026-01-01T00:00:00.000Z',
        actor: 'recall',
        summary: 'Answered a question: "<img src=x onerror=alert(1)>"',
        eventCount: 1,
        events: [{ ts: '2026-01-01T00:00:00.000Z', actor: 'recall', eventType: 'recall', subjects: {}, payload: { question: '<script>alert(1)</script>' }, provenance: { file: '.kb/cache/ask/audit.jsonl', line: 0 } }],
      },
    ];
    activityFeed = vi.fn(async () => feed(hostile));
    setApi();
    const c = await mount();
    expect(c.querySelector('img')).toBeNull(); // summary not parsed as HTML
    c.querySelector<HTMLButtonElement>('.activity-entry-head')!.click();
    expect(c.querySelector('.activity-raw script')).toBeNull(); // raw payload not parsed as HTML
    expect(c.textContent).toContain('<script>alert(1)</script>'); // shown as text
    // read-only: no buttons that mutate (only toggle/lineage/clear — all read affordances)
    expect(c.querySelector('button.primary')).toBeNull();
  });
});

// WS3 migration (DESIGN-LEGACY-VIEWS §2): Activity moved off the legacy off-system primitives
// (.muted / button.link / native unstyled controls) onto The Line's blessed .viz-* primitives, plus the
// a11y sweep (aria-labels on the icon-ish trace + close actions). These are the fails-before/passes-after
// guards on the CLASS — a regression to .link/.muted, a dropped aria-label, or a broken lineage drill-down
// (DEV-2's SENSE-1c sensitivity chip hangs on that structure) all trip here.
describe('WS3 design-system migration (DESIGN-LEGACY-VIEWS §2 — onto The Line)', () => {
  // VUX-CONFORM #524 §2: the bare .viz-field controls are replaced by the mock-cited .act-search /
  // .act-filter band (vellum-v3.html:848-928) — superseding the earlier WS3 .viz-field migration.
  it('renders the filter controls as the v3 .act-search / .act-filter band, accessible names preserved (§7)', async () => {
    const c = await mount();
    const actor = c.querySelector<HTMLSelectElement>('#activityActor')!;
    const search = c.querySelector<HTMLInputElement>('#activitySearch')!;
    expect(search.closest('.act-search')).not.toBeNull();
    expect(actor.closest('.act-filter')).not.toBeNull();
    expect(actor.getAttribute('aria-label')).toBe('Filter by stage or agent'); // v3 de-jargon (was "Filter by actor")
    expect(search.getAttribute('aria-label')).toBe('Search activity summaries');
  });

  it('renders the trace-origin action as a .viz-btn--ghost with a summary-naming aria-label (a11y §2)', async () => {
    const c = await mount();
    const trace = c.querySelector<HTMLButtonElement>('.activity-trace')!;
    expect(trace.classList.contains('viz-btn')).toBe(true);
    expect(trace.classList.contains('viz-btn--ghost')).toBe(true);
    // "trace origin" alone is ambiguous to a screen reader → name it with the entry summary.
    expect(trace.getAttribute('aria-label')).toBe('Trace the origin of: Claims derived 2 claims about E1');
  });

  it('renders the lineage close action as a .viz-btn--ghost with an aria-label', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.activity-trace')!.click();
    await flush();
    const close = c.querySelector<HTMLButtonElement>('[data-act="clear-lineage"]')!;
    expect(close.classList.contains('viz-btn--ghost')).toBe(true);
    expect(close.getAttribute('aria-label')).toBe('Close lineage panel');
  });

  it('preserves the lineage drill-down structure the SENSE sensitivity chip hangs on (DEV-2 SENSE-1c)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.activity-trace')!.click();
    await flush();
    // The panel → head → per-event steps are the stable anchor SENSE-1c will mount the .viz-chip into.
    expect(c.querySelector('.lineage-panel')).not.toBeNull();
    expect(c.querySelector('.lineage-head')).not.toBeNull();
    expect(c.querySelectorAll('.lineage-step').length).toBeGreaterThan(0);
    expect(c.querySelector('.lineage-step .activity-actor-badge')).not.toBeNull();
  });

  it('carries NO legacy off-system primitives (.muted / button.link / bare .btn) on any render path', async () => {
    const c = await mount();
    // Exercise every render path: expand a raw drill-down AND open the lineage panel.
    c.querySelector<HTMLButtonElement>('.activity-entry-head')!.click();
    c.querySelector<HTMLButtonElement>('.activity-trace')!.click();
    await flush();
    expect(c.querySelector('.muted')).toBeNull(); // header note / ts / evcount / event-src / lineage meta all migrated
    expect(c.querySelector('button.link')).toBeNull(); // trace + lineage close are .viz-btn--ghost now
    // .btn is the legacy button class — distinct from .viz-btn (classList token match won't conflate them).
    expect([...c.querySelectorAll('button')].some((b) => b.classList.contains('btn'))).toBe(false);
  });
});

describe('Activity view · #145 load resilience (no infinite spinner on a hung IPC)', () => {
  let c: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    c = document.createElement('div');
    document.body.appendChild(c);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    c.remove();
  });

  it('times out a hung activityFeed → retryable error, and Retry re-loads successfully', async () => {
    const activityFeed = vi.fn<KbApi['activityFeed']>().mockReturnValueOnce(new Promise<ActivityFeedResult>(() => {})); // hangs
    (window as unknown as { kbApi: Pick<KbApi, 'activityFeed'> }).kbApi = { activityFeed: activityFeed as unknown as KbApi['activityFeed'] };
    mountActivity(c);
    expect(c.textContent).toContain('Loading…'); // spinner initially

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    expect(c.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(c.querySelector('.activity-error')).toBeTruthy();
    expect(c.querySelector('.load-retry')).toBeTruthy();
    // VUX-CONFORM #524 §3/§8 — v3-surface buttons use the sentence-case .v3-btn pill, not bare
    // .viz-btn (whose uppercase instrument tell is correct on Researchers/Jobs, wrong here).
    expect(c.querySelector('.load-retry')?.classList.contains('viz-btn')).toBe(false);
    expect(c.querySelector('.load-retry')?.classList.contains('v3-btn')).toBe(true);

    // Retry succeeds → the feed renders.
    activityFeed.mockResolvedValueOnce(feed(ENTRIES, 3));
    c.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.querySelectorAll('.activity-entry')).toHaveLength(2);
  });
});

describe('lineageHtml — SENSE-10 read-only sensitivity chip (AUDIT-8-safe)', () => {
  const base: Lineage = { subjectId: 'E1', kind: 'entity', sources: ['01JSRC1', '01JSRC2'], events: [{ ts: 't', actor: 'archivist', eventType: 'archived', subjects: {}, payload: {}, provenance: { file: 'x', line: 0 } } as never], decisions: [] };

  it('renders a read-only .viz-chip with the label + provenance per source that has one', () => {
    const html = lineageHtml(base, { '01JSRC1': { sensitivity: 'confidential', by: 'connector' } });
    expect(html).toContain('class="viz-chip sensitivity-chip"');
    expect(html).toContain('>confidential<');
    expect(html).toContain('set by connector'); // provenance in the tooltip
    // no edit control — the observatory stays read-only (AUDIT-8)
    expect(html).not.toMatch(/data-act="(edit|set)-sensitivity"/);
    expect(html).not.toContain('<input');
  });

  it('omits the chip for a source with no readable label (degrades cleanly)', () => {
    const html = lineageHtml(base, { '01JSRC1': { sensitivity: 'internal', by: 'default' } }); // 01JSRC2 absent
    expect((html.match(/sensitivity-chip/g) ?? []).length).toBe(1); // only the source that had one
  });

  it('escapes an untrusted custom label (no HTML injection)', () => {
    const html = lineageHtml(base, { '01JSRC1': { sensitivity: '"><img src=x onerror=alert(1)>', by: 'principal' } });
    expect(html).not.toContain('<img');
  });
});

// SPEC-0060 VUX-1: the Activity CSS block migrates off the instrument-panel --viz-* names onto the
// warm-vellum v3 tokens. NO ember (activity is a log, not a decision). Guard on the CSS source.
describe('VUX-1 v3 token migration (SPEC-0060 — off --viz-*)', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  const block = indexCss.slice(
    indexCss.indexOf('Activity view — VELLUM v3'),
    indexCss.indexOf('Vellum v3 Today'),
  );

  it('isolated the Activity v3 block', () => {
    expect(block.length).toBeGreaterThan(500);
  });

  it('the v3 Activity block carries NO --viz-* tokens and NO ember (it is a log, not a decision)', () => {
    expect(block).not.toMatch(/var\(--viz-/);
    expect(block).not.toMatch(/--ember|var\(--ember/);
  });

  it('uses v3 ground/ink + event-kind hue tokens', () => {
    expect(block).toMatch(/var\(--ink\b/);
    expect(block).toMatch(/var\(--sprout\b/); // active-kind glyph hue
    expect(block).toMatch(/var\(--oxide\b/); // honest failure
  });
});
