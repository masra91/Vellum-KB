// @vitest-environment happy-dom
//
// SPEC-0035 HEALTH + SPEC-0058 STATE-3/13 — the Health view, component tier (happy-dom; IPC mocked).
// Asserts the projection-backed "health glance" (DL-2's render contract): the summary line, three
// always-present dimension rows (`.hrow`), the severity tile (#184: hue on `.hi`/`.hn`, not the label),
// the specific defect text per class, click-through (openCitation), "+N more", ENG-15/16 partial-data
// safety, the status-driven warming/unavailable faces, and load resilience. The mock returns the REAL
// `HealthProjection` (built via `toHealthProjection`) so the view + transform are exercised together.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountHealth } from './healthView';
import { TimeoutError } from '../loadGuard';
import type { KbApi } from '../../kb/types';
import type { HealthReport } from '../../kb/healthPanel';
import { toHealthProjection, warmingHealthProjection, unavailableHealthProjection, type HealthProjection } from '../../kb/healthProjection';

const ISO = '2026-06-28T00:00:00.000Z';
function report(over: Partial<HealthReport> = {}): HealthReport {
  return {
    scanned: 10,
    orphans: [{ rel: 'entities/x/lonely.md', id: 'l', name: 'Lonely', kind: 'concept' }],
    thin: [{ rel: 'entities/x/stub.md', id: 's', name: 'Stub', kind: 'person', chars: 42 }],
    dangling: [{ from: 'entities/person/ada.md', fromName: 'Ada Lovelace', target: 'entities/ghost/missing.md' }],
    counts: { orphans: 1, thin: 1, dangling: 1 },
    ...over,
  };
}
const proj = (over: Partial<HealthReport> = {}): HealthProjection => toHealthProjection(report(over), ISO);

let healthReport: ReturnType<typeof vi.fn>;
let openCitation: ReturnType<typeof vi.fn>;
let reportRendererError: ReturnType<typeof vi.fn>;
let healthRemediate: ReturnType<typeof vi.fn>;
let dismissHealthFinding: ReturnType<typeof vi.fn>;

function setApi(): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    healthReport: healthReport as unknown as KbApi['healthReport'],
    openCitation: openCitation as unknown as KbApi['openCitation'],
    reportRendererError: reportRendererError as unknown as KbApi['reportRendererError'],
    healthRemediate: healthRemediate as unknown as KbApi['healthRemediate'],
    dismissHealthFinding: dismissHealthFinding as unknown as KbApi['dismissHealthFinding'],
  };
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  healthReport = vi.fn(async () => proj());
  openCitation = vi.fn(async () => ({ ok: true as const }));
  reportRendererError = vi.fn(async () => {});
  healthRemediate = vi.fn(async () => ({ ok: true, message: 'done', changed: true }));
  dismissHealthFinding = vi.fn(async () => ({ ok: true, message: 'Dismissed.' }));
  setApi();
});
afterEach(() => {
  document.body.innerHTML = '';
});

async function mount(): Promise<HTMLElement> {
  const c = document.createElement('div');
  document.body.appendChild(c);
  // #510: mountHealth() now only builds the skeleton + returns lifecycle hooks; show() (which the
  // shell calls right after mount) is what actually scans + paints — mirror that here.
  mountHealth(c).show?.();
  await flush();
  return c;
}

const dimByLabel = (c: HTMLElement, label: string): Element =>
  Array.from(c.querySelectorAll('.health-dimension')).find((g) => g.querySelector('.hrow .ht b')?.textContent === label)!;

describe('Health view — projection-backed glance (HEALTH-8, SPEC-0058 STATE-13, DL-2 contract)', () => {
  it('renders the summary line with the total + scanned count (single projection read)', async () => {
    const c = await mount();
    const sum = c.querySelector('.health-summary')?.textContent ?? '';
    expect(sum).toMatch(/3 structural issues/);
    expect(sum).toMatch(/scanned/);
    expect(sum).toMatch(/10 entities/);
  });

  it('the glance container is a material card (STATE-13 / #453 depth), not flat chrome', async () => {
    const c = await mount();
    expect(c.querySelector('.health-glance')?.classList.contains('viz-card')).toBe(true);
  });

  it('always renders the three dimension rows (never a blank panel), in order with their labels', async () => {
    const c = await mount();
    const dims = Array.from(c.querySelectorAll('.health-dimension'));
    expect(dims).toHaveLength(3);
    expect(Array.from(c.querySelectorAll('.hrow .ht b')).map((l) => l.textContent)).toEqual(['Dead links', 'Orphans', 'Thin pages']);
  });

  it('renders the specific defect text per issue class', async () => {
    const c = await mount();
    const defects = Array.from(c.querySelectorAll('.health-defect')).map((d) => d.textContent);
    expect(defects).toContain('→ entities/ghost/missing.md (no node)'); // dead link
    expect(defects).toContain('0 in · 0 out'); // orphan
    expect(defects).toContain('stub · 42 chars'); // thin (uses the panel's char count)
  });

  it('severity is hue on the TILE only, not the label or count (#184): the tile carries the class, label/count stay ink', async () => {
    const c = await mount();
    const orphans = dimByLabel(c, 'Orphans');
    expect(orphans.querySelector('.hi')?.classList.contains('warn')).toBe(true); // orphans hit → warn tile (.hi.warn)
    const dead = dimByLabel(c, 'Dead links');
    expect(dead.querySelector('.hi')?.classList.contains('bad')).toBe(true); // dead links → bad tile (.hi.bad)
    // #184: the label `.ht b` and the count `.hn` never carry the severity class — the hue lives on the tile.
    expect(orphans.querySelector('.ht b')?.classList.contains('warn')).toBe(false);
    expect(orphans.querySelector('.hn')?.classList.contains('warn')).toBe(false);
  });

  it('a clean dimension shows the ok tile + desc, no issue list (never a blank/odd section)', async () => {
    healthReport = vi.fn(async () => proj({ dangling: [], counts: { orphans: 1, thin: 1, dangling: 0 } }));
    setApi();
    const c = await mount();
    const dead = dimByLabel(c, 'Dead links');
    expect(dead.querySelector('.hi')?.classList.contains('ok')).toBe(true); // clean → ok tile (.hi.ok)
    expect(dead.querySelector('.hn')?.textContent).toBe('0');
    expect(dead.querySelector('.health-row-list')).toBeNull(); // no rows when clean
  });

  it('clicking a finding opens the node via openCitation (leads back to reading)', async () => {
    const c = await mount();
    c.querySelector<HTMLButtonElement>('.health-open[data-rel="entities/x/lonely.md"]')!.click();
    expect(openCitation).toHaveBeenCalledWith('entities/x/lonely.md');
  });

  it('shows a "+N more" note when a dimension exceeds the shown findings', async () => {
    healthReport = vi.fn(async () => proj({ orphans: [{ rel: 'entities/x/a.md', id: 'a', name: 'A', kind: 'concept' }], counts: { orphans: 9, thin: 0, dangling: 0 }, thin: [], dangling: [] }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.health-more')?.textContent).toContain('+8 more');
  });

  it('the all-clear state: summary reads "structurally sound", every dimension shows an ok tile, no rows', async () => {
    healthReport = vi.fn(async () => proj({ orphans: [], thin: [], dangling: [], counts: { orphans: 0, thin: 0, dangling: 0 } }));
    setApi();
    const c = await mount();
    expect(c.querySelector('.health-summary')?.textContent).toMatch(/structurally sound/i);
    expect(c.querySelectorAll('.hi.ok')).toHaveLength(3);
    expect(c.querySelectorAll('.health-row')).toHaveLength(0);
  });

  it('partial data: a finding missing a name renders an "(untitled)" fallback without breaking siblings (ENG-15/16)', async () => {
    healthReport = vi.fn(async () =>
      proj({
        orphans: [
          { rel: 'entities/x/partial.md', id: 'p', name: '', kind: '' }, // legacy/partial row
          { rel: 'entities/x/lonely.md', id: 'l', name: 'Lonely', kind: 'concept' },
        ],
        thin: [],
        dangling: [],
        counts: { orphans: 2, thin: 0, dangling: 0 },
      }),
    );
    setApi();
    const c = await mount();
    expect(c.querySelectorAll('.health-row')).toHaveLength(2); // both render, no crash
    expect(c.querySelector('.health-open[data-rel="entities/x/partial.md"] .health-untitled')?.textContent).toBe('(untitled)');
  });

  it('STATE-9: a `warming` projection renders the calm warming face, never the error face', async () => {
    healthReport = vi.fn(async () => warmingHealthProjection());
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-warming')).not.toBeNull();
    expect(c.querySelector('.load-error, .error')).toBeNull();
  });

  it('STATE-10: an `unavailable` projection renders the retryable error face', async () => {
    healthReport = vi.fn(async () => unavailableHealthProjection());
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error, .error')).not.toBeNull();
  });

  it('degrades to a retryable error when the scan IPC throws a real error (no endless spinner)', async () => {
    healthReport = vi.fn(async () => {
      throw new Error('x');
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-error, .error')).not.toBeNull();
    expect(c.querySelector('.load-warming')).toBeNull(); // a real throw is an ERROR, not warming
  });

  // SPEC-0058 slice-0 — a slow cold-start scan (TimeoutError) must read as WARMING, not the alarming
  // "Couldn't load" error face (the packaged Health P0: a cold/large-vault scan flipped straight to error).
  it('shows the calm WARMING face (not the error face) when the scan times out', async () => {
    healthReport = vi.fn(async () => {
      throw new TimeoutError(30000);
    });
    setApi();
    const c = await mount();
    expect(c.querySelector('.load-warming')).not.toBeNull();
    expect(c.querySelector('.load-error, .error')).toBeNull();
    expect(c.textContent).not.toContain('Couldn’t load');
  });

  // SPEC-0058 slice-0 — the bare `catch {}` swallowed the real cause; both failure paths must now
  // un-swallow it to the app-log so a packaged-app walkthrough can tell timeout from throw.
  it('un-swallows BOTH a timeout and a real throw to the app-log (reportRendererError)', async () => {
    for (const err of [new TimeoutError(30000), new Error('boom')]) {
      reportRendererError = vi.fn(async () => {});
      healthReport = vi.fn(async () => {
        throw err;
      });
      setApi();
      await mount();
      expect(reportRendererError).toHaveBeenCalledTimes(1);
      expect((reportRendererError.mock.calls[0][0] as { message: string }).message).toMatch(/\[health\] load failed/);
      document.body.innerHTML = '';
    }
  });
});

// SPEC-0060 VUX-16 — the per-finding remediation affordances (relink / find-homes / dismiss) wired to the
// merged backend IPCs. The finding→action mapping (dangling→relink, orphan→find-homes, thin→dismiss-only),
// the apply→re-scan payoff, the immediate dismiss, and the calm working/error states.
describe('Health view — VUX-16 remediation affordances', () => {
  const rowFor = (c: HTMLElement, name: string): HTMLElement =>
    Array.from(c.querySelectorAll<HTMLElement>('.health-row')).find((r) => r.querySelector('.health-finding-name')?.textContent === name)!;

  it('maps finding → action: dangling=Relink, orphan=Find homes, thin=dismiss-only — and dismiss on all', async () => {
    const c = await mount();
    const dangling = rowFor(c, 'Ada Lovelace');
    const orphan = rowFor(c, 'Lonely');
    const thin = rowFor(c, 'Stub');
    expect(dangling.querySelector('.health-act--relink')).toBeTruthy();
    expect(dangling.querySelector('.health-act--find-homes')).toBeFalsy();
    expect(orphan.querySelector('.health-act--find-homes')).toBeTruthy();
    expect(thin.querySelector('.health-act')).toBeFalsy(); // thin = NO apply action (enrich held — no dead button)
    // dismiss ✕ on every finding
    for (const r of [dangling, orphan, thin]) expect(r.querySelector('.health-dismiss')).toBeTruthy();
    // no ember anywhere on the maintenance affordances (DL-1)
    expect(c.querySelector('.health-actions [class*="ember"]')).toBeNull();
  });

  it('Relink calls healthRemediate with the SOURCE node, then re-scans on ok (the finding resolves away)', async () => {
    const c = await mount();
    rowFor(c, 'Ada Lovelace').querySelector<HTMLButtonElement>('.health-act--relink')!.click();
    expect(healthRemediate).toHaveBeenCalledWith({ action: 'relink', nodeRel: 'entities/person/ada.md' });
    await flush();
    expect(healthReport.mock.calls.length).toBeGreaterThanOrEqual(2); // re-scan after the apply
  });

  it('Find homes calls healthRemediate find-homes with the orphan node', async () => {
    const c = await mount();
    rowFor(c, 'Lonely').querySelector<HTMLButtonElement>('.health-act--find-homes')!.click();
    expect(healthRemediate).toHaveBeenCalledWith({ action: 'find-homes', nodeRel: 'entities/x/lonely.md' });
  });

  it('Dismiss calls dismissHealthFinding with the content-stable key + kind, then re-scans (immediate, no confirm)', async () => {
    const c = await mount();
    rowFor(c, 'Lonely').querySelector<HTMLButtonElement>('.health-dismiss')!.click();
    expect(dismissHealthFinding).toHaveBeenCalledWith({ findingKey: 'orphan:concept|lonely', kind: 'orphan' });
    await flush();
    expect(healthReport.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a failed apply shows a calm inline (oxide) error on the row, re-enabled (retryable) — no re-scan', async () => {
    healthRemediate = vi.fn(async () => ({ ok: false, message: 'Couldn’t reach the vault.' }));
    setApi();
    const c = await mount();
    const row = rowFor(c, 'Ada Lovelace');
    row.querySelector<HTMLButtonElement>('.health-act--relink')!.click();
    await flush();
    expect(row.querySelector('.health-row-error')?.textContent).toContain('Couldn’t reach the vault.');
    expect(row.querySelector<HTMLButtonElement>('.health-act--relink')!.disabled).toBe(false); // re-enabled
    expect(healthReport.mock.calls.length).toBe(1); // NOT re-scanned on failure
  });

  it('the footnote is honest — names the WIRED actions, not merge/enrich', async () => {
    const c = await mount();
    const fn = c.querySelector('.health-footnote')?.textContent ?? '';
    expect(fn).toMatch(/dismiss/i);
    expect(fn).not.toMatch(/read-only/i); // the old passive copy is gone
  });
});

// SPEC-0060 VUX-1 — the Health CSS block is migrated OFF the instrument-panel `--viz-*` tokens onto the
// v3 warm-vellum set (consumed from design-system.css, never redefined here). Fails-before: the pre-v3
// block referenced `var(--viz-ink)` / `var(--viz-rule)` / `var(--viz-brass)` etc. — this guard keeps the
// migration complete and prevents a regression that re-introduces a retired token. CSS-content tier
// (mirrors themeCohesion): read index.css, isolate the `.health*`/`.hrow*` block, assert on it.
describe('Health v3 token migration (SPEC-0060 VUX-1)', () => {
  const css = readFileSync(path.join(__dirname, '..', '..', 'index.css'), 'utf8');
  // The block spans from the VUX-1 marker comment to the next view section (Agents hub).
  const start = css.indexOf('SPEC-0060 VUX-1 — Health migrated');
  const end = css.indexOf('Agents hub: direction-framed');
  const block = css.slice(start, end);
  // Drop comment lines so a `--viz-*` mention in prose (e.g. "retires --viz-*") doesn't mask a real ref.
  const declarations = block
    .split('\n')
    .filter((l) => !l.trim().startsWith('/*') && !l.trim().startsWith('*'))
    .join('\n');

  it('isolated a non-empty Health CSS block', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(declarations).toContain('.health-title');
    expect(declarations).toContain('.hrow');
  });

  it('references ZERO retired --viz-* tokens in its actual declarations (fully migrated)', () => {
    const leaks = declarations.match(/var\(--viz-[a-z0-9-]+\)/g) ?? [];
    expect(leaks).toEqual([]);
  });

  it('consumes the v3 warm-vellum tokens (ink/stone/hair/slate) + the severity hues (sprout/gold/oxide)', () => {
    for (const tok of ['var(--ink)', 'var(--stone)', 'var(--hair)', 'var(--slate)', 'var(--sprout)', 'var(--gold-deep)', 'var(--oxide)', 'var(--mono)']) {
      expect(declarations).toContain(tok);
    }
  });

  it('tokenizes hover washes (themeCohesion §: no hardcoded :hover background)', () => {
    // Every interactive hover background must be TOKENIZED — either the generic `--hover` wash, or a
    // tokenized `color-mix(var(--…))` tint (VUX-16's slate/oxide action washes, DL-1) — never a literal.
    const hovers = declarations.match(/:hover\s*\{[^}]*\}/g) ?? [];
    expect(hovers.length).toBeGreaterThan(0);
    for (const h of hovers) {
      if (h.includes('background')) expect(h).toMatch(/var\(--/); // tokenized (var(--hover) or color-mix(var(--…)))
      expect(h).not.toMatch(/#[0-9a-fA-F]{3,6}/); // no hex literal in a hover rule
      expect(h).not.toMatch(/rgba?\(\s*\d/); // no literal rgb(a) channel in a hover rule
    }
  });
});
