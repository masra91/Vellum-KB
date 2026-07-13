// @vitest-environment happy-dom
//
// #402 §2/§6 — the fractal-lattice motif generator. Parses the generated markup via a real DOM parser
// (happy-dom) rather than string-matching, so attribute order/whitespace differences never matter.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { latticeMotif } from './latticeMotif';

function parse(svg: string): SVGSVGElement {
  const div = document.createElement('div');
  div.innerHTML = svg;
  return div.querySelector('svg')!;
}

describe('latticeMotif — depth', () => {
  it('depth 1 renders exactly one nested diamond', () => {
    const el = parse(latticeMotif({ depth: 1, stroke: 'var(--gold)', strokeWidths: [1] }));
    expect(el.querySelectorAll('polygon')).toHaveLength(1);
  });

  it('depth 2 renders two nested diamonds, each at half the previous radius', () => {
    const el = parse(latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1] }));
    const polys = el.querySelectorAll('polygon');
    expect(polys).toHaveLength(2);
    // outer: radius 10 from center (12,12) → topmost point (12, 12-10=2)
    expect(polys[0].getAttribute('points')).toBe('12,2 22,12 12,22 2,12');
    // inner: radius 5 → topmost point (12, 12-5=7)
    expect(polys[1].getAttribute('points')).toBe('12,7 17,12 12,17 7,12');
  });

  it('depth 3 renders three nested diamonds, the innermost at a quarter of the outer radius', () => {
    const el = parse(latticeMotif({ depth: 3, stroke: 'var(--gold)', strokeWidths: [1, 1, 1] }));
    const polys = el.querySelectorAll('polygon');
    expect(polys).toHaveLength(3);
    // radius 2.5 → topmost point (12, 9.5)
    expect(polys[2].getAttribute('points')).toBe('12,9.5 14.5,12 12,14.5 9.5,12');
  });
});

describe('latticeMotif — stroke / stroke-width / className threading', () => {
  it('threads stroke onto the group and per-level stroke-widths onto each polygon', () => {
    const el = parse(latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1] }));
    expect(el.querySelector('g')?.getAttribute('stroke')).toBe('var(--gold)');
    const polys = el.querySelectorAll('polygon');
    expect(polys[0].getAttribute('stroke-width')).toBe('1.4');
    expect(polys[1].getAttribute('stroke-width')).toBe('1.1');
  });

  it('threads levelClassNames onto each polygon, outermost first — omitting it leaves polygons unclassed', () => {
    const withClasses = parse(
      latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1], levelClassNames: ['d-out', 'd-mid'] }),
    );
    const polys = withClasses.querySelectorAll('polygon');
    expect(polys[0].getAttribute('class')).toBe('d-out');
    expect(polys[1].getAttribute('class')).toBe('d-mid');

    const bare = parse(latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [0.5, 0.5] }));
    for (const p of Array.from(bare.querySelectorAll('polygon'))) expect(p.hasAttribute('class')).toBe(false);
  });

  it('accepts currentColor as a valid stroke (About\'s mark recolors to its hero context)', () => {
    const el = parse(latticeMotif({ depth: 2, stroke: 'currentColor', strokeWidths: [1.5, 1.2] }));
    expect(el.querySelector('g')?.getAttribute('stroke')).toBe('currentColor');
  });
});

describe('latticeMotif — core dot', () => {
  it('core: "dot" renders a filled center circle using the stroke color', () => {
    const el = parse(latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1], core: 'dot', coreClassName: 'd-core' }));
    const circle = el.querySelector('circle');
    expect(circle).not.toBeNull();
    expect(circle?.getAttribute('class')).toBe('d-core');
    expect(circle?.getAttribute('fill')).toBe('var(--gold)');
    expect(circle?.getAttribute('cx')).toBe('12');
    expect(circle?.getAttribute('cy')).toBe('12');
    expect(circle?.getAttribute('r')).toBe('1.9');
  });

  it('omitting core (or "none") renders no circle', () => {
    const el = parse(latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [0.5, 0.5] }));
    expect(el.querySelector('circle')).toBeNull();
  });
});

describe('latticeMotif — crosshair (SIDEBAR_WMARK / About\'s mark)', () => {
  it('crosshair renders two full-bleed lines through the center, anchored to the OUTER ring regardless of depth', () => {
    const el = parse(latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [0.5, 0.5], crosshair: true, crosshairStrokeWidth: 0.5 }));
    const lines = el.querySelectorAll('line');
    expect(lines).toHaveLength(2);
    expect(lines[0].getAttribute('x1')).toBe('2');
    expect(lines[0].getAttribute('x2')).toBe('22');
    expect(lines[0].getAttribute('y1')).toBe('12');
    expect(lines[1].getAttribute('y1')).toBe('2');
    expect(lines[1].getAttribute('y2')).toBe('22');
    for (const l of Array.from(lines)) expect(l.getAttribute('stroke-width')).toBe('0.5');
  });

  it('crosshairOpacity applies to the lines only, not the polygons (About\'s mark dims its crosshair to 0.85)', () => {
    const el = parse(
      latticeMotif({ depth: 2, stroke: 'currentColor', strokeWidths: [1.5, 1.2], crosshair: true, crosshairStrokeWidth: 0.9, crosshairOpacity: 0.85 }),
    );
    for (const l of Array.from(el.querySelectorAll('line'))) expect(l.getAttribute('opacity')).toBe('0.85');
    for (const p of Array.from(el.querySelectorAll('polygon'))) expect(p.hasAttribute('opacity')).toBe(false);
  });

  it('omitting crosshair renders no lines', () => {
    const el = parse(latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1] }));
    expect(el.querySelectorAll('line')).toHaveLength(0);
  });
});

describe('latticeMotif — size / linecap / viewBox', () => {
  it('sets width/height attributes when size is given', () => {
    const el = parse(latticeMotif({ size: 24, depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1] }));
    expect(el.getAttribute('width')).toBe('24');
    expect(el.getAttribute('height')).toBe('24');
  });

  it('omits width/height when size is not given (caller\'s CSS sizes it, e.g. About\'s mark)', () => {
    const el = parse(latticeMotif({ depth: 2, stroke: 'currentColor', strokeWidths: [1.5, 1.2] }));
    expect(el.hasAttribute('width')).toBe(false);
    expect(el.hasAttribute('height')).toBe(false);
  });

  it('the viewBox is always the fixed 0 0 24 24 regardless of size', () => {
    const el = parse(latticeMotif({ size: 220, depth: 2, stroke: 'var(--gold)', strokeWidths: [0.5, 0.5] }));
    expect(el.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('roundCaps adds stroke-linecap:round to the group; omitting it leaves miter-only joins', () => {
    const rounded = parse(latticeMotif({ depth: 2, stroke: 'currentColor', strokeWidths: [1.5, 1.2], roundCaps: true }));
    expect(rounded.querySelector('g')?.getAttribute('stroke-linecap')).toBe('round');
    const notRounded = parse(latticeMotif({ depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1] }));
    expect(notRounded.querySelector('g')?.hasAttribute('stroke-linecap')).toBe(false);
  });
});

// #402 §6 — regression pin: the migrated call sites (shell.ts's BRAND_DIAMOND/SIDEBAR_WMARK,
// aboutPanel.ts's MARK_SVG) must render VISUALLY unchanged from their pre-migration hand-written markup
// (points/colors/widths/structure) — not a byte-for-byte string snapshot (the generator's exact
// attribute ORDER/grouping legitimately differs, e.g. per-polygon vs group-level stroke-width, which is
// visually identical either way), but every meaningful rendered property.
describe('#402 §6 — visual-parity regression pins for the three migrated call sites', () => {
  it('BRAND_DIAMOND shape: 2 rings classed d-out/d-mid, gold stroke, tapered widths, a d-core gold dot', () => {
    const el = parse(
      latticeMotif({ size: 24, depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1], levelClassNames: ['d-out', 'd-mid'], core: 'dot', coreClassName: 'd-core' }),
    );
    expect(el.getAttribute('width')).toBe('24');
    const polys = el.querySelectorAll('polygon');
    expect(polys[0].outerHTML).toContain('class="d-out"');
    expect(polys[0].getAttribute('points')).toBe('12,2 22,12 12,22 2,12');
    expect(polys[0].getAttribute('stroke-width')).toBe('1.4');
    expect(polys[1].getAttribute('points')).toBe('12,7 17,12 12,17 7,12');
    expect(polys[1].getAttribute('stroke-width')).toBe('1.1');
    const core = el.querySelector('circle')!;
    expect(core.getAttribute('class')).toBe('d-core');
    expect(core.getAttribute('fill')).toBe('var(--gold)');
  });

  it('SIDEBAR_WMARK shape: 220x220, 2 unclassed rings + a crosshair, gold (not brass) — the #402 §3 fix', () => {
    const el = parse(latticeMotif({ size: 220, depth: 2, stroke: 'var(--gold)', strokeWidths: [0.5, 0.5], crosshair: true, crosshairStrokeWidth: 0.5 }));
    expect(el.getAttribute('width')).toBe('220');
    expect(el.querySelector('g')?.getAttribute('stroke')).toBe('var(--gold)');
    expect(el.querySelectorAll('polygon')).toHaveLength(2);
    expect(el.querySelectorAll('line')).toHaveLength(2);
    expect(el.querySelector('circle')).toBeNull(); // no core dot on the watermark
  });

  it('MARK_SVG shape: currentColor, round caps, tapered widths, dimmed crosshair, a currentColor dot', () => {
    const el = parse(
      latticeMotif({ depth: 2, stroke: 'currentColor', strokeWidths: [1.5, 1.2], roundCaps: true, core: 'dot', crosshair: true, crosshairStrokeWidth: 0.9, crosshairOpacity: 0.85 }),
    );
    expect(el.hasAttribute('width')).toBe(false); // CSS-sized, matches the original MARK_SVG
    expect(el.querySelector('g')?.getAttribute('stroke-linecap')).toBe('round');
    const polys = el.querySelectorAll('polygon');
    expect(polys[0].getAttribute('stroke-width')).toBe('1.5');
    expect(polys[1].getAttribute('stroke-width')).toBe('1.2');
    for (const l of Array.from(el.querySelectorAll('line'))) {
      expect(l.getAttribute('stroke-width')).toBe('0.9');
      expect(l.getAttribute('opacity')).toBe('0.85');
    }
    expect(el.querySelector('circle')?.getAttribute('fill')).toBe('currentColor');
  });
});

// #402 §3/§4/§6 — CSS-source guards (themeCohesion/clipping.test.ts-style static assertions).
describe('#402 §3 — the sidebar watermark color-law fix (grep guard)', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  const block = indexCss.slice(indexCss.indexOf('.sidebar-wmark {'), indexCss.indexOf('.sidebar-wmark {') + 400);

  it('.sidebar-wmark no longer references the state-semantic --viz-brass token', () => {
    expect(block).not.toMatch(/--viz-brass/);
  });

  it('.sidebar-wmark now colors gold, matching the motif elsewhere (BRAND_DIAMOND)', () => {
    expect(block).toMatch(/color:\s*var\(--gold\)/);
  });
});

describe('#402 §4 — dark-mode field/watermark opacity pass', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');

  it('each of the three field/watermark surfaces gets a dark-mode opacity override (~0.16 per DARK-MODE-ADDENDUM)', () => {
    for (const selector of ['.sidebar-wmark', '.explore::before', '.exp-graph::before']) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`:root\\[data-theme='dark'\\]\\s*${escaped}\\s*\\{[^}]*opacity:\\s*0\\.16`);
      expect(indexCss).toMatch(re);
    }
  });
});
