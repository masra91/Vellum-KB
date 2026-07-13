// @vitest-environment happy-dom
//
// "The Line" — the Pipeline Status view (SPEC-0032 / DESIGN-VIZ + SPEC-0030 OBS-5/6/7/9/11/15/17),
// component tier (TEST-5). The IPC is mocked (`window.kbApi.pipelineStatusView`); we assert the
// rendered DOM (the headline state badge, the stuck/stall alarm, the station spine + gauge-rails, the
// in-flight carriages, the set-aside siding, the secondary readout), that the OBS-17 Retry/Dismiss
// contract is unchanged, that it stays read-only (+ the new non-mutating pivot), that oxide never
// colours small text (Design-Lead cert), and the #145 hang-resilience.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mountStatus,
  stopStatusPolling,
  lineBodyHtml,
  overallHtml,
  alarmHtml,
  pivotHtml,
  spineHtml,
  carriagesHtml,
  sidingHtml,
  lockHtml,
  errorsHtml,
  latencyHtml,
  healthHtml,
} from './statusView';
import { buildStations, splitCarriages } from './theLineModel';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { PipelineStatusView, KbApi } from '../../kb/types';

const PERF: PipelineStatusView['perf'] = {
  version: 1, builtAt: 'T', source: null, spanCount: 4, truncated: false,
  copilot: { count: 4, avgMs: 250, p50Ms: 200, p95Ms: 400 },
  stages: [{ stage: 'decompose', runs: 2, avgMs: 1500, throughputPerMin: 30 }],
  whereTimeGoes: { totalMs: 3000, copilotMs: 1000, otherMs: 2000, copilotPct: 0.33 },
  slowest: [{ spanId: 's1', op: 'copilot.invoke', stage: 'claims', itemId: 'E9', durationMs: 87000, startTs: 'T' }],
};

const STALLED: PipelineStatusView = {
  overall: 'stalled',
  stalled: true,
  lastActivity: '2026-06-02T00:00:00.000Z',
  stages: [
    { stage: 'archive', state: 'idle', queueDepth: 0, setAside: 0 },
    { stage: 'decompose', state: 'blocked', queueDepth: 2, setAside: 1 },
    { stage: 'connect', state: 'error', queueDepth: 1, setAside: 0, currentItem: 'person|Ada' },
    { stage: 'claims', state: 'idle', queueDepth: 0, setAside: 0 },
  ],
  lock: { held: true, waiters: 1, holder: 'connect', since: '2026-06-02T00:01:00.000Z' },
  recentErrors: [
    { ts: '2026-06-02T00:02:00.000Z', level: 'error', event: 'decompose.failed', stage: 'decompose', itemId: 'SRC3', runId: 'R1', message: 'copilot exploded' },
  ],
  worktrees: [{ path: '.kb/cache/worktrees/staging', branch: 'staging' }],
  perf: PERF,
  setAsideItems: [{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace', reason: 'set aside after 3 failed attempts' }],
  conversion: { captured: 10, candidates: 30, entities: 7, claims: 22, promoted: 6 },
  inFlight: [{ itemId: 'SRC9', name: 'SRC9', stage: 'decompose', active: true, sinceTs: '2026-06-02T00:02:30.000Z' }],
  builtAt: '2026-06-02T00:03:00.000Z',
};

const NOW = Date.parse('2026-06-02T00:03:00.000Z');

function body(v: PipelineStatusView | null, extra: Partial<Parameters<typeof lineBodyHtml>[0]> = {}): string {
  return lineBodyHtml({ view: v, loading: false, errorMsg: '', expanded: new Set(), lens: 'stage', ...extra }, NOW);
}

function setApi(fn: KbApi['pipelineStatusView'], control?: KbApi['pipelineControl']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'pipelineStatusView' | 'pipelineControl'> }).kbApi = {
    pipelineStatusView: fn,
    pipelineControl: control ?? (vi.fn().mockResolvedValue({ ok: true }) as unknown as KbApi['pipelineControl']),
  };
}

describe('The Line — headline + alarm (OBS-5/11, VIZ-1)', () => {
  it('overallHtml shows the state badge with its glyph + state class, friendly last-activity (no raw ISO)', () => {
    const h = overallHtml(STALLED);
    expect(h).toContain('line-overall-stalled');
    expect(h).toContain('>✕</span> Stalled'); // OVERALL_GLYPH.stalled glyph + label
    expect(h).not.toContain('2026-06-02T00:00:00.000Z'); // raw ISO replaced by a friendly time (#3)
  });

  it('alarmHtml raises a STUCK write lock as the primary oxide alarm, naming holder + held duration (#163)', () => {
    const stuck: PipelineStatusView = { ...STALLED, lock: { held: true, waiters: 0, holder: 'claims:advance', stuck: true, heldMs: 125000 } };
    const h = alarmHtml(stuck);
    expect(h).toContain('line-alarm-stuck');
    expect(h).toContain('Claim extraction (advance)'); // holderLabel — stage display name + op suffix
    expect(h).toContain('2m 5s'); // heldFor(125000)
    expect(h).toContain('wedged');
  });

  it('alarmHtml raises the BRASS vault-blocked recovery (MACOS-7/#56) when a write hit a permission denial — above lock/stall', () => {
    const blocked: PipelineStatusView = { ...STALLED, recentErrors: [{ ts: 't', level: 'error', event: 'claims.failed', message: 'fatal: could not write: Operation not permitted' }] };
    const h = alarmHtml(blocked);
    expect(h).toContain('line-alarm-blocked'); // brass (waiting on you), not the oxide stuck/stall alarm
    expect(h).toContain('can’t write to your vault folder');
    expect(h).toContain('data-act="open-settings"');
    expect(h).not.toContain('line-alarm-stuck'); // a vault denial out-prioritizes the lock/stall alarm
  });

  it('the vault-blocked alarm clears once the denial ages out (a since-fixed grant — #56 freshness)', () => {
    const denied: PipelineStatusView = { ...STALLED, overall: 'running', stalled: false, lock: { held: false, waiters: 0 }, recentErrors: [{ ts: '2026-06-02T00:00:00.000Z', level: 'error', event: 'claims.failed', message: 'Operation not permitted' }] };
    const fresh = Date.parse('2026-06-02T00:01:00.000Z'); // within the 2-min window → still blocked
    const aged = Date.parse('2026-06-02T01:00:00.000Z'); // an hour later → grant fixed → alarm clears
    expect(alarmHtml(denied, fresh)).toContain('line-alarm-blocked');
    expect(alarmHtml(denied, aged)).not.toContain('line-alarm-blocked');
    expect(alarmHtml(denied, aged)).toBe(''); // healthy now (no lock/stall either)
  });

  it('alarmHtml raises a generic stall (queued, no progress) — but not when healthy', () => {
    expect(alarmHtml(STALLED)).toContain('line-alarm-stall'); // stalled, not stuck
    expect(alarmHtml(STALLED)).toContain('looks stuck');
    const healthy: PipelineStatusView = { ...STALLED, overall: 'running', stalled: false, lock: { held: false, waiters: 0 } };
    expect(alarmHtml(healthy)).toBe(''); // quiet when nothing's wrong
  });

  it('oxide colours only the alarm glyph (large) — the reason text stays ink (§3 / Design-Lead cert)', () => {
    const stuck: PipelineStatusView = { ...STALLED, lock: { held: true, waiters: 0, holder: 'connect:afterDrain', stuck: true, heldMs: 60000 } };
    const h = alarmHtml(stuck);
    expect(h).toContain('line-alarm-glyph viz-state-error'); // the GLYPH carries oxide
    expect(h).toContain('line-alarm-text viz-body'); // the TEXT is ink/body
    // the oxide state class never lands on the small reason text
    expect(h).not.toContain('line-alarm-text viz-state-error');
  });
});

describe('The Line — station spine + gauge-rails (§2/§6, VIZ-3/4)', () => {
  const spine = (): string => spineHtml(buildStations(STALLED));

  it('renders all six stations with their state glyph + hue (state never colour alone)', () => {
    const h = spine();
    for (const name of ['Capture', 'Archiving', 'Decompose', 'Connect', 'Claim extraction', 'Promote']) expect(h).toContain(name);
    expect(h).toContain('line-station-error'); // connect is error
    expect(h).toContain('line-station-glyph viz-state-error'); // its glyph carries oxide (large element — allowed)
  });

  it('the station volume count carries the per-stage odometer hook (VIZ-1 roll, not snap)', () => {
    const h = spine();
    // The volume number is its own [data-odo] span keyed per stage, so lineMotion rolls it from its
    // prior value across a repaint (fixing the "0 → sudden numbers" jank) — not the wrapping noun.
    expect(h).toContain('<span class="line-num" data-odo data-odo-key="vol-decompose">');
    expect(h).toContain('data-odo-key="vol-promote"');
  });

  it('gauge-rail shows the role-declaring conversion projections (→ −deduped, → +×ratio fan-out, completion ratio · complete)', () => {
    const h = spine(); // conversion 10/30/7/22/6
    expect(h).toContain('→ −23 deduped'); // decompose candidates(30) → connect entities(7)
    expect(h).toContain('→ +15 ×3.1 fan-out'); // connect entities(7) → claims(22)
    expect(h).toContain('6/10 · 60% complete'); // PROMOTE completion ratio + complete signifier
  });

  it('the conversion captions are tabular numerics, never the oxide state class on small text', () => {
    const h = spine();
    expect(h).toContain('line-rail-caption line-cap-reduction viz-numeric');
    // the slowest-station rail tints oxide via a bar class, not by colouring the caption text
    expect(h).not.toContain('line-rail-caption line-cap-reduction viz-state-error');
  });

  it('a set-aside count under a station uses an oxide-bordered badge (not oxide-coloured text)', () => {
    const h = spine();
    expect(h).toContain('line-station-setaside line-badge-error'); // decompose has 1 set aside
    expect(h).toContain('set aside');
  });
});

// VIZ-12 (SPEC-0032, #336 design) — the rail's primary fill is the two-segment PENDING bar: an ember
// in-progress BASE (breathing — the Principal's "fade") + a still slate queued CAP (brass only when
// stuck), heights scaled to the peak pending across stations; plus a `▣ N active` count beside `queue N`
// in the ink live-state lane. Live off `view.inFlight` (never the stale cumulative end-state).
describe('The Line — VIZ-12 pending-work bar (queued vs in-progress)', () => {
  // decompose: 1 active + 2 queued = 3 pending (the peak); connect (blocked): 1 queued → brass cap.
  const PENDING_VIEW: PipelineStatusView = {
    ...STALLED,
    overall: 'running',
    stalled: false,
    lock: { held: false, waiters: 0 },
    stages: [
      { stage: 'decompose', state: 'running', queueDepth: 2, setAside: 0 },
      { stage: 'connect', state: 'blocked', queueDepth: 1, setAside: 0 },
      { stage: 'claims', state: 'idle', queueDepth: 0, setAside: 0 },
    ],
    inFlight: [
      { itemId: 'a', name: 'A', stage: 'decompose', active: true, sinceTs: 'T' },
      { itemId: 'b', name: 'B', stage: 'decompose' },
      { itemId: 'c', name: 'C', stage: 'decompose' },
      { itemId: 'd', name: 'D', stage: 'connect' },
    ],
  };
  const spine = (): string => spineHtml(buildStations(PENDING_VIEW));

  it('the rail fill is a two-segment pending bar — ember in-progress base + slate queued cap, scaled to peak pending', () => {
    const h = spine();
    expect(h).toContain('line-rail-fill');
    // decompose is the peak (3 pending) → its bar fills the track: ember base 1/3, queued cap 2/3
    expect(h).toContain('line-pending-active" style="height:33.3'); // 1 active of peak 3
    expect(h).toContain('line-pending-queued" style="height:66.6'); // 2 queued of peak 3 (calm — running)
    // the cumulative end-state volume bar is no longer the rail's primary fill (demoted to funnel, #336)
    expect(h).not.toContain('line-rail-bar');
  });

  it('the in-progress count joins the queue in the ink live-state lane: `▣ N active` (ember glyph) + the existing `queue N`', () => {
    const h = spine();
    expect(h).toContain('line-station-active'); // the new active readout
    expect(h).toContain('line-active-glyph'); // the ▣ glyph carries ember (a glyph — hue allowed)
    expect(h).toContain('▣');
    expect(h).toContain('title="1 actively being worked at Decompose"');
    expect(h).toContain('line-station-queue'); // `queue N` (queueDepth) unchanged — VIZ-12 only ADDS active
  });

  it('the queued cap tints brass only when the backlog is actually STUCK (queueConcerning)', () => {
    // connect is blocked WITH a queued item → its queued segment takes needs-you brass.
    expect(spine()).toContain('line-pending-queued line-queue-concern');
  });

  it('a deep but DRAINING queue stays calm slate (no brass) — the cry-wolf guard', () => {
    const draining: PipelineStatusView = {
      ...PENDING_VIEW,
      stages: [{ stage: 'decompose', state: 'running', queueDepth: 250, setAside: 0 }],
      inFlight: [
        { itemId: 'a', name: 'A', stage: 'decompose', active: true, sinceTs: 'T' },
        ...Array.from({ length: 9 }, (_, i) => ({ itemId: `q${i}`, name: `q${i}`, stage: 'decompose' as const })),
      ],
    };
    const h = spineHtml(buildStations(draining));
    expect(h).toContain('line-pending-queued'); // a queued segment exists
    expect(h).not.toContain('line-pending-queued line-queue-concern'); // but stays slate — healthy draining
  });

  it('idle/empty stations show no pending fill (calm track) — a frozen pending bar would be the bug, not the feature', () => {
    const idle: PipelineStatusView = {
      ...PENDING_VIEW,
      stages: [{ stage: 'claims', state: 'idle', queueDepth: 0, setAside: 0 }],
      inFlight: [],
    };
    const h = spineHtml(buildStations(idle));
    expect(h).toContain('line-rail-fill'); // the rail track still renders…
    expect(h).not.toContain('line-pending-active'); // …but no ember (nothing genuinely active)
    expect(h).not.toContain('line-pending-queued'); // …and no slate (nothing queued)
  });
});

describe('The Line — funnel-caption legibility, each number declares its role (VIZ-10, Principal-reported)', () => {
  const spine = (): string => spineHtml(buildStations(STALLED));

  it('volume carries its bucket noun + a decode-on-hover title so a bare count self-describes (role 1)', () => {
    const h = spine(); // connect (Connect) volume = entities(7)
    expect(h).toContain('line-rail-noun viz-signage'); // the bucket-noun micro-unit renders
    expect(h).toContain('>entities</span>'); // Connect's volume names its bucket
    expect(h).toContain('title="7 entities reached Connect"'); // decode-on-hover
  });

  it('the conversion projection is tied to the NEXT stage (→ + signifier + title) so it can never read as a backlog (role 2)', () => {
    const h = spine();
    expect(h).toContain('→ +15 ×3.1 fan-out'); // Connect entities(7) → Claim extraction(22)
    expect(h).toContain('title="projected fan-out ×3.1 into Claim extraction"'); // hover decodes it as flows-to-next
  });

  it('the real queue (the only actionable backlog) sits in its own live-state lane, visually + semantically apart from the projection (role 3)', () => {
    const h = spine();
    // the projection lives in the rail lane; the queue lives in the live-state cluster — distinct lanes.
    expect(h).toContain('line-station-rail-lane');
    expect(h).toContain('line-station-live');
    expect(h).toContain('line-station-queue'); // connect has queueDepth 1
    expect(h).toContain('title="1 waiting to be processed at Connect"'); // queue = waiting-here, not flowing
  });

  it('a STUCK stage with backlog takes brass (needs-you); a deep but draining queue stays calm — cry-wolf guard (role 3)', () => {
    // STALLED has blocked/error stations with a backlog → the real backlog goes brass.
    expect(spine()).toContain('line-station-queue viz-body line-queue-concern');
    // a deep queue in a RUNNING (draining) stage of a healthy pipeline is normal work → never brass.
    const draining: PipelineStatusView = {
      ...STALLED,
      overall: 'running',
      stalled: false,
      lock: { held: false, waiters: 0 },
      stages: [{ stage: 'connect', state: 'running', queueDepth: 250, setAside: 0 }],
    };
    expect(spineHtml(buildStations(draining))).not.toContain('line-queue-concern');
  });

  it('a once-per-spine legend decodes the caption grammar (progressive disclosure, not per-station clutter)', () => {
    const h = spine();
    expect(h).toContain('line-legend');
    expect(h).toContain('Reading the numbers');
    expect(h).toContain('vol = reached here · queue = waiting');
    expect(h.match(/line-legend-body/g)?.length).toBe(1); // exactly once for the whole spine
  });
});

describe('The Line — in-flight carriages (VIZ-2/9)', () => {
  it('renders a carriage with its six-cell stepper, lit current step + dwell on the active one', () => {
    const { shown, more } = splitCarriages(STALLED.inFlight, NOW);
    const h = carriagesHtml(shown, more);
    expect(h).toContain('▸ SRC9');
    expect(h).toContain('line-cell-current line-cell-breathe'); // active → the lit step breathes
    expect(h).toContain('30s on Copilot'); // dwell from sinceTs (00:02:30) to NOW (00:03:00)
    // VIZ-1: the in-flight total carries the odometer hook so it rolls (not snaps); the carriage
    // carries its id + stepper position for the §5 index motion.
    expect(h).toContain('In flight (<span class="viz-numeric" data-odo data-odo-key="inflight-total">1</span>)');
    expect(h).toContain('data-carriage-id="SRC9" data-step="2"');
  });

  it('collapses a large roster into a "+K more in flight" row (VIZ-9 virtualization)', () => {
    const many: PipelineStatusView['inFlight'] = Array.from({ length: 15 }, (_, i) => ({ itemId: `i${i}`, name: `n${i}`, stage: 'archive' as const }));
    const { shown, more } = splitCarriages(many, NOW);
    const h = carriagesHtml(shown, more);
    expect(h).toContain('more in flight');
    expect(h).toContain('In flight (<span class="viz-numeric" data-odo data-odo-key="inflight-total">15</span>)'); // total still honest, now odometer-rolled
  });

  it('shows a calm empty state when nothing is on the line', () => {
    expect(carriagesHtml([], 0)).toContain('Nothing on the line');
  });
});

describe('The Line — set-aside siding (VIZ-7 / OBS-17, contract unchanged)', () => {
  it('lists poison items as stage · name + reason (name preferred over id)', () => {
    const h = sidingHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace', reason: 'set aside after 3 failed attempts' }]);
    expect(h).toContain('Set aside — needs attention');
    expect(h).toContain('Claim extraction · Ada Lovelace'); // display name (#4) + friendly name
    expect(h).toContain('set aside after 3 failed attempts');
  });

  it('falls back to the item id when no name is known', () => {
    expect(sidingHtml([{ stage: 'claims', itemId: '01NONAME' }])).toContain('Claim extraction · 01NONAME');
  });

  it('keeps the OBS-17 Retry/Dismiss control contract verbatim (data-act / data-stage / data-id)', () => {
    const h = sidingHtml([{ stage: 'connect', itemId: 'block:engine', name: 'Analytical Engine' }]);
    expect(h).toContain('data-act="setaside-retry"');
    expect(h).toContain('data-act="setaside-dismiss"');
    expect(h).toContain('data-stage="connect"'); // raw id intact → action dispatches to the right stage
    expect(h).toContain('data-id="block:engine"');
  });

  it('the reason line stays ink — the siding never colours small text with the oxide state class', () => {
    const h = sidingHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace', reason: 'set aside after 3 failed attempts' }]);
    expect(h).toContain('line-siding-reason viz-body'); // ink/body reason
    expect(h).not.toContain('viz-state-error'); // oxide rides the badge fill + the siding's CSS border, not the text
  });

  it('HEAL-8: a re-surfaced item whose async action failed shows a per-item retryable error (no global disable)', () => {
    const failures = new Map([['claims:01ADAID', 'Couldn’t complete that — please try again.']]);
    const h = sidingHtml([{ stage: 'claims', itemId: '01ADAID', name: 'Ada Lovelace' }], { failures });
    expect(h).toContain('line-siding-error');
    expect(h).toContain('role="alert"');
    expect(h).toContain('try again');
    expect(h).not.toContain('disabled'); // buttons stay enabled so the Principal can retry
  });

  it('HEAL-8: lineBodyHtml suppresses an optimistically-acted item even when the view still lists it (no flicker-back)', () => {
    // STALLED still lists the claims set-aside item; `actedKeys` (the Principal just clicked Retry/Dismiss)
    // must keep it off the siding so a reconcile poll can't bounce it back before the backend catches up.
    const actedKeys = new Set(['claims:01ADAID']);
    const html = lineBodyHtml({ view: STALLED, loading: false, errorMsg: '', expanded: new Set(), lens: 'stage', actedKeys, failedActs: new Map() }, NOW);
    expect(html).not.toContain('line-siding'); // its only set-aside item is suppressed → no siding section
  });

  it('is empty when nothing is set aside (clean → no siding)', () => {
    expect(sidingHtml([])).toBe('');
  });

  it('escapes interpolated values (XSS-safe)', () => {
    const h = sidingHtml([{ stage: 'claims', itemId: 'x', name: '<img src=x onerror=alert(1)>', reason: '<b>x</b>' }]);
    expect(h).not.toContain('<img src=x');
    expect(h).not.toContain('<b>x</b>');
    expect(h).toContain('&lt;img');
  });

  it('ENG-15: a malformed set-aside item (null name, missing reason) renders without crashing — name falls back to itemId', () => {
    // The live siding can carry a partial item (a poison entry whose name never resolved); a data-render
    // surface must degrade the item, never crash the whole siding (REVIEW-19 / ENG-15/16 hard bar).
    const malformed = [{ stage: 'claims', itemId: '01MALFORMED', name: null }] as unknown as Parameters<typeof sidingHtml>[0];
    const h = sidingHtml(malformed);
    expect(h).toContain('Claim extraction · 01MALFORMED'); // null name → itemId fallback, no throw
    expect(h).not.toContain('undefined'); // never esc(undefined) → the "title:null" crash class
    expect(h).toContain('line-siding-retry'); // still actionable
    // bonus — the same malformed item carrying a re-surfaced failure still renders safely
    const withErr = sidingHtml(malformed, { failures: new Map([['claims:01MALFORMED', 'please try again']]) });
    expect(withErr).toContain('line-siding-error');
    expect(withErr).toContain('Claim extraction · 01MALFORMED');
  });
});

describe('The Line — pivot toggle (VIZ-5) + secondary readout (OBS-6/7/15)', () => {
  it('pivotHtml renders both lenses, marking the active one (non-mutating, data-act=pivot)', () => {
    const h = pivotHtml('stage');
    expect(h).toContain('data-act="pivot"');
    expect(h).toContain('data-lens="stage"');
    expect(h).toContain('data-lens="item"');
    expect(h).toContain('line-pivot-on" data-act="pivot" data-lens="stage" aria-pressed="true"'); // stage active
  });

  it('lineBodyHtml weights the core by lens (default per-stage)', () => {
    expect(body(STALLED, { lens: 'stage' })).toContain('line-core line-lens-stage');
    expect(body(STALLED, { lens: 'item' })).toContain('line-core line-lens-item');
  });

  it('lockHtml surfaces a STUCK lock loudly in the readout, with the held-duration (#163 OBS-7)', () => {
    const h = lockHtml({ held: true, waiters: 1, holder: 'claims:advance', stuck: true, heldMs: 125000 });
    expect(h).toContain('line-lock-stuck');
    expect(h).toContain('2m 5s');
    expect(h).toContain('wedged');
  });

  it('lockHtml shows holder + waiters + held-duration on a normal hold; free when unheld', () => {
    const held = lockHtml({ held: true, waiters: 1, holder: 'connect', since: '2026-06-02T00:01:00.000Z', heldMs: 3000 });
    expect(held).toContain('held by <strong>Connect</strong>'); // display name (#4)
    expect(held).toContain('1 waiting');
    expect(held).toContain('3s');
    expect(held).not.toContain('Stuck');
    expect(lockHtml({ held: false, waiters: 0 })).toContain('free');
  });

  it('errorsHtml drills down to the cause when expanded (OBS-6)', () => {
    const collapsed = errorsHtml(STALLED.recentErrors, new Set());
    expect(collapsed).toContain('decompose.failed');
    expect(collapsed).not.toContain('copilot exploded'); // hidden until expanded
    const open = errorsHtml(STALLED.recentErrors, new Set([0]));
    expect(open).toContain('copilot exploded'); // the dev-log cause
    expect(open).toContain('runId <span class="viz-numeric">R1</span>'); // OBS-3 cross-link
  });

  it('latencyHtml surfaces Copilot p50/p95 + where-time-goes + throughput (OBS-15)', () => {
    const h = latencyHtml(STALLED);
    expect(h).toContain('p50 <span class="viz-numeric">200ms</span>');
    expect(h).toContain('p95 <span class="viz-numeric">400ms</span>');
    expect(h).toContain('33%</span> Copilot');
    expect(h).toContain('Decompose:'); // display name throughput row
    expect(h).toContain('87000ms'); // slowest op
  });

  it('escapes interpolated values in the error drill-down (XSS-safe)', () => {
    const evil: PipelineStatusView = { ...STALLED, recentErrors: [{ ts: 't', level: 'error', event: 'e', message: '<script>alert(1)</script>' }] };
    const h = errorsHtml(evil.recentErrors, new Set([0]));
    expect(h).not.toContain('<script>alert(1)</script>');
    expect(h).toContain('&lt;script&gt;');
  });
});

describe('The Line — body states', () => {
  it('renders loading / no-KB / error states', () => {
    expect(lineBodyHtml({ view: null, loading: true, errorMsg: '', expanded: new Set(), lens: 'stage' }, NOW)).not.toContain('Loading…'); // #520: shaped skeleton, never bare text
    expect(lineBodyHtml({ view: null, loading: true, errorMsg: '', expanded: new Set(), lens: 'stage' }, NOW)).toContain('skel-row');
    expect(body(null)).toContain('No library open');
    expect(lineBodyHtml({ view: null, loading: false, errorMsg: 'boom', expanded: new Set(), lens: 'stage' }, NOW)).toContain('boom');
  });

  it('ENG-15/16: a legacy/partial view missing inFlight + setAsideItems renders the Line without crashing', () => {
    // load()/buildStations already coalesce these; the lineBodyHtml derefs were the lone unguarded outliers
    // (splitCarriages spreads inFlight; siding filters setAsideItems) — a null payload threw and blanked the Line.
    const partial = { ...STALLED, inFlight: undefined, setAsideItems: undefined } as unknown as PipelineStatusView;
    expect(() => body(partial)).not.toThrow();
    expect(body(partial)).toContain('line-core'); // the Line still renders
  });

  it('#160 leave-last-known: a transient poll error with a prior snapshot keeps the Line, not the error banner', () => {
    // After a successful first paint, `view` holds the last-known snapshot; a 2.5s poll blip sets errorMsg
    // but must NOT wipe a healthy Line (the poll self-heals). Only a COLD failure (no view) shows the banner.
    const withView = body(STALLED, { errorMsg: 'copilot blip' });
    expect(withView).toContain('line-core'); // last-known Line preserved
    expect(withView).not.toContain('Couldn’t load status'); // no banner over a healthy snapshot
    // ...but with no prior snapshot, the cold-failure banner still surfaces.
    expect(body(null, { errorMsg: 'cold boom' })).toContain('Couldn’t load status');
  });

  it('the full body wraps the Line in a .viz-surface root (so the reduced-motion reset catches it)', () => {
    // mountStatus sets the .viz-surface root; the body itself carries the spine + siding + readout.
    const h = body(STALLED);
    expect(h).toContain('line-spine'); // stations
    expect(h).toContain('line-siding'); // siding
    expect(h).toContain('line-readout'); // OBS depth
  });
});

describe('mountStatus (OBS-8/9 — live + read-only; VIZ-5 pivot)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    stopStatusPolling();
    root.remove();
    vi.restoreAllMocks();
  });

  it('mounts a .viz-surface root, loads via IPC, renders the Line; error rows toggle on click (OBS-6)', async () => {
    setApi(vi.fn().mockResolvedValue(STALLED));
    mountStatus(root);
    await Promise.resolve();
    await Promise.resolve();

    expect(root.querySelector('.viz-surface.the-line')).not.toBeNull(); // reduced-motion root
    expect(root.querySelector('.the-line.status-v2')).not.toBeNull(); // SPEC-0058 v2 material marker (scopes the pipeline/in-flight cards)
    expect(root.querySelector('.line-overall-stalled')).not.toBeNull();
    const head = root.querySelector<HTMLButtonElement>('.line-err-head');
    expect(head).not.toBeNull();
    expect(root.textContent).not.toContain('copilot exploded'); // collapsed

    head!.click();
    expect(root.textContent).toContain('copilot exploded'); // expanded the cause
  });

  it('is read-only except the OBS-17 recovery actions + the non-mutating pivot', async () => {
    setApi(vi.fn().mockResolvedValue(STALLED));
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    const acts = [...root.querySelectorAll<HTMLElement>('[data-act]')].map((e) => e.dataset.act);
    // toggle-err (drill-down) + pivot (lens) are non-mutating; only retry/dismiss mutate.
    expect(new Set(acts)).toEqual(new Set(['toggle-err', 'pivot', 'setaside-retry', 'setaside-dismiss']));
  });

  it('the pivot toggle flips the lens (per-stage ↔ per-item) without an IPC call', async () => {
    const statusFn = vi.fn().mockResolvedValue(STALLED);
    setApi(statusFn);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    expect(root.querySelector('.line-lens-stage')).not.toBeNull(); // default

    const calls = statusFn.mock.calls.length;
    root.querySelector<HTMLButtonElement>('[data-act="pivot"][data-lens="item"]')!.click();
    expect(root.querySelector('.line-lens-item')).not.toBeNull(); // flipped
    expect(statusFn.mock.calls.length).toBe(calls); // pure view change, no re-fetch
  });

  it('the vault-blocked alarm Open System Settings button calls the deep-link IPC (MACOS-7)', async () => {
    const blockedView: PipelineStatusView = { ...STALLED, recentErrors: [{ ts: 't', level: 'error', event: 'claims.failed', message: 'Operation not permitted' }] };
    const openSettings = vi.fn().mockResolvedValue({ ok: true });
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      pipelineStatusView: vi.fn().mockResolvedValue(blockedView),
      pipelineControl: vi.fn().mockResolvedValue({ ok: true }) as unknown as KbApi['pipelineControl'],
      openSystemSettingsPrivacy: openSettings,
    };
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    const btn = root.querySelector<HTMLButtonElement>('.line-open-settings');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  // HEAL-8 (SPEC-0049) — Retry/Dismiss is OPTIMISTIC: the item leaves the siding the INSTANT the
  // Principal clicks; the IPC fires async; on failure the item is restored with a retryable error.
  it('HEAL-8: Retry removes the item from the siding IMMEDIATELY — before the IPC resolves (UI never waits)', async () => {
    const statusFn = vi.fn().mockResolvedValue(STALLED); // one set-aside item (claims 01ADAID)
    let resolveCtl!: (v: { ok: boolean; message: string }) => void;
    const control = vi.fn(() => new Promise((res) => { resolveCtl = res; })); // pending until we resolve
    setApi(statusFn, control as unknown as KbApi['pipelineControl']);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    expect(root.querySelector('.line-siding-retry')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('.line-siding-retry')!.click();
    // Synchronously after the click — the siding is gone though the IPC promise is still PENDING.
    expect(control).toHaveBeenCalledWith({ action: 'retry', stage: 'claims', itemId: '01ADAID' });
    expect(root.querySelector('.line-siding')).toBeNull(); // the only item left instantly → no siding
    resolveCtl({ ok: true, message: 'Retrying Ada Lovelace.' });
    await Promise.resolve(); await Promise.resolve();
    expect(root.querySelector('.line-siding')).toBeNull(); // stays gone
  });

  it('HEAL-8: a failed (ok:false) action restores the item with a retryable error affordance', async () => {
    const control = vi.fn().mockResolvedValue({ ok: false, message: 'canonical lock busy' });
    setApi(vi.fn().mockResolvedValue(STALLED), control as unknown as KbApi['pipelineControl']);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    root.querySelector<HTMLButtonElement>('.line-siding-retry')!.click();
    expect(root.querySelector('.line-siding')).toBeNull(); // optimistically gone
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // Restored — back on the siding, carrying an honest alert, still actionable.
    expect(root.querySelector('.line-siding-item')).not.toBeNull();
    expect(root.querySelector('.line-siding-error')?.getAttribute('role')).toBe('alert');
    expect(root.textContent).toContain('canonical lock busy');
    expect(root.querySelector('.line-siding-retry')).not.toBeNull();
  });

  it('HEAL-8: a thrown IPC also restores the item (honest rollback, not a silent drop)', async () => {
    const control = vi.fn().mockRejectedValue(new Error('ipc channel died'));
    setApi(vi.fn().mockResolvedValue(STALLED), control as unknown as KbApi['pipelineControl']);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    root.querySelector<HTMLButtonElement>('.line-siding-retry')!.click(); // retry path (no confirm)
    expect(root.querySelector('.line-siding')).toBeNull(); // optimistically gone
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(root.querySelector('.line-siding-item')).not.toBeNull(); // restored
    expect(root.querySelector('.line-siding-error')).not.toBeNull();
    expect(root.textContent).toContain('ipc channel died');
  });

  it('Dismiss confirms first; cancelling does nothing, confirming dispatches the action (stage-agnostic)', async () => {
    const control = vi.fn().mockResolvedValue({ ok: true, message: 'Dismissed Ada Lovelace.' });
    setApi(vi.fn().mockResolvedValue(STALLED), control as unknown as KbApi['pipelineControl']);
    mountStatus(root);
    await Promise.resolve(); await Promise.resolve();
    const dismiss = (): HTMLButtonElement => root.querySelector<HTMLButtonElement>('.line-siding-dismiss')!;

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    dismiss().click();
    await Promise.resolve();
    expect(control).not.toHaveBeenCalled(); // cancelled → not even optimistically removed
    expect(root.querySelector('.line-siding-item')).not.toBeNull();

    confirmSpy.mockReturnValue(true);
    dismiss().click();
    expect(root.querySelector('.line-siding')).toBeNull(); // optimistically removed on confirm
    await Promise.resolve(); await Promise.resolve();
    expect(control).toHaveBeenCalledWith({ action: 'dismiss', stage: 'claims', itemId: '01ADAID' });
  });

  it('renders the no-KB state when the pipeline is inactive', async () => {
    setApi(vi.fn().mockResolvedValue(null));
    mountStatus(root);
    await Promise.resolve();
    await Promise.resolve();
    expect(root.textContent).toContain('No library open');
  });
});

describe('mountStatus · #145 hang resilience', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    stopStatusPolling();
    vi.clearAllTimers();
    vi.useRealTimers();
    root.remove();
  });

  it('shows an error instead of an infinite "Loading…" when pipelineStatusView hangs (#145)', async () => {
    setApi(vi.fn(() => new Promise<PipelineStatusView>(() => {}))); // hangs
    mountStatus(root);
    await vi.advanceTimersByTimeAsync(0); // initial paint
    expect(root.querySelector('[aria-busy="true"]')).not.toBeNull(); // skeleton initially (#520)
    expect(root.textContent).not.toContain('Loading…'); // never bare "Loading…" (#520 §8)

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    expect(root.textContent).not.toContain('Loading…'); // no infinite spinner
    expect(root.querySelector('.line-error')).not.toBeNull(); // surfaced; the poll auto-retries (no button — read-only)
  });
});

describe('healthHtml — memory/health readout (OBS-22)', () => {
  const MB = 1024 * 1024;
  const withHealth = (health: PipelineStatusView['health']): PipelineStatusView => ({ ...STALLED, health });

  it('renders nothing when no health is present (telemetry not wired)', () => {
    expect(healthHtml(STALLED)).toBe('');
  });

  it('shows current RSS/heap when a sample exists', () => {
    const html = healthHtml(withHealth({ memory: { ts: 'T', rss: 200 * MB, heapUsed: 40 * MB, heapTotal: 55 * MB, external: 3 * MB, arrayBuffers: 0 }, trend: null, lastCrash: null }));
    expect(html).toContain('Memory &amp; health');
    expect(html).toContain('200 MB');
    expect(html).toContain('40/55 MB');
  });

  it('raises a loud "Memory climbing" alarm when the trend is leaking (OBS-21 surfaced)', () => {
    const html = healthHtml(withHealth({
      memory: { ts: 'T', rss: 600 * MB, heapUsed: 80 * MB, heapTotal: 90 * MB, external: 3 * MB, arrayBuffers: 0 },
      trend: { samples: 6, windowMin: 6, rssDeltaMb: 150, heapDeltaMb: 40, rssSlopeMbPerMin: 25, leaking: true },
      lastCrash: null,
    }));
    expect(html).toContain('line-alarm');
    expect(html).toContain('Memory climbing');
    expect(html).toContain('+150 MB');
  });

  it('shows a steady trend (no alarm) when not leaking', () => {
    const html = healthHtml(withHealth({ memory: null, trend: { samples: 6, windowMin: 6, rssDeltaMb: 2, heapDeltaMb: 1, rssSlopeMbPerMin: 0.3, leaking: false }, lastCrash: null }));
    expect(html).toContain('steady');
    expect(html).not.toContain('Memory climbing');
  });

  it('shows the last crash breadcrumb — kind + when + where (OBS-18 surfaced)', () => {
    const html = healthHtml(withHealth({
      memory: null,
      trend: null,
      lastCrash: { ts: '2026-06-07T22:00:00.000Z', kind: 'uncaughtException', reason: 'worker trap', stage: 'decompose', itemId: 'SRC9' },
    }));
    expect(html).toContain('Last crash');
    expect(html).toContain('uncaughtException');
    expect(html).toContain('decompose');
    expect(html).toContain('SRC9');
    expect(html).toContain('worker trap');
  });

  it('escapes crash fields (XSS-safe)', () => {
    const html = healthHtml(withHealth({ memory: null, trend: null, lastCrash: { ts: 'T', kind: 'uncaughtException', reason: '<img src=x onerror=alert(1)>', stage: 's', itemId: 'i' } }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
