// @vitest-environment happy-dom
//
// #580 §6/§7 — MESH/RECURSE, the mechanical/clockwork replacement for the rejected organic dLoom/dChurn
// pulse+flip (Principal ruling on #402 §5.1: "no breathing, in either direction"). CSS-source regex
// guards (themeCohesion/clipping.test.ts-style) for the animation definitions, plus a real-DOM
// selector-reachability test for the #512 PERF-R8 shell-idle correction QA specifically flagged —
// happy-dom doesn't compute a full CSS cascade from an external stylesheet, but a CSS selector's
// descendant-matching behavior against real generated markup is exactly what QA's catch was about
// (the OLD selector matched an ancestor but never reached the animated child elements at all).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const designSystemCss = readFileSync(path.resolve(process.cwd(), 'src/shell/design-system.css'), 'utf8');
const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');

function keyframeBody(name: string): string {
  const marker = `@keyframes ${name} {`;
  const start = designSystemCss.indexOf(marker);
  expect(start, `@keyframes ${name} not found`).toBeGreaterThanOrEqual(0);
  // Keyframe blocks in this file are single-line — find the matching top-level closing brace.
  let depth = 0;
  for (let i = start; i < designSystemCss.length; i++) {
    if (designSystemCss[i] === '{') depth++;
    if (designSystemCss[i] === '}') {
      depth--;
      if (depth === 0) return designSystemCss.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated @keyframes ${name}`);
}

describe('#580 §6.1 — MESH (continuous, .is-working) counter-rotates in opposite directions', () => {
  it('the rejected organic dLoom/dChurn primitives are gone entirely', () => {
    expect(designSystemCss).not.toMatch(/\bdLoom\b/);
    expect(designSystemCss).not.toMatch(/\bdChurn\b/);
  });

  it('.dmk.is-working targets BOTH rings (.d-out and .d-mid), never .d-core', () => {
    expect(designSystemCss).toMatch(/\.dmk\.is-working \.d-out\s*\{[^}]*animation:\s*dMeshOut/);
    expect(designSystemCss).toMatch(/\.dmk\.is-working \.d-mid\s*\{[^}]*animation:\s*dMeshMid/);
    expect(designSystemCss).not.toMatch(/\.dmk\.is-working \.d-core/);
  });

  it('dMeshOut and dMeshMid rotate a full turn in OPPOSITE directions', () => {
    const out = keyframeBody('dMeshOut');
    const mid = keyframeBody('dMeshMid');
    expect(out).toMatch(/0%\s*\{\s*transform:\s*rotate\(0\)/);
    expect(out).toMatch(/100%\s*\{\s*transform:\s*rotate\(360deg\)/);
    expect(mid).toMatch(/0%\s*\{\s*transform:\s*rotate\(360deg\)/);
    expect(mid).toMatch(/100%\s*\{\s*transform:\s*rotate\(0\)/);
  });

  it('both rings run linear timing, infinitely, at differential (non-matching) speeds', () => {
    expect(designSystemCss).toMatch(/\.dmk\.is-working \.d-out\s*\{[^}]*dMeshOut 28s linear infinite/);
    expect(designSystemCss).toMatch(/\.dmk\.is-working \.d-mid\s*\{[^}]*dMeshMid 19s linear infinite/);
  });

  it('the sidebar watermark overrides to its own slower ambient rate (48s/33s), not the brand mark\'s (28s/19s)', () => {
    expect(indexCss).toMatch(/\.sidebar-wmark\.dmk\.is-working \.d-out\s*\{\s*animation-duration:\s*48s;/);
    expect(indexCss).toMatch(/\.sidebar-wmark\.dmk\.is-working \.d-mid\s*\{\s*animation-duration:\s*33s;/);
  });

  it('the watermark no longer runs the generic viz-drift pan — it meshes via its own rings instead', () => {
    const block = indexCss.slice(indexCss.indexOf('.sidebar-wmark {'), indexCss.indexOf('.sidebar-wmark {') + 300);
    expect(block).not.toMatch(/viz-drift/);
  });
});

describe('#580 §6.2 — RECURSE (episodic, .is-thinking) — one bounded step, then a hard snap', () => {
  it('.dmk.is-thinking targets both rings, one-shot (never infinite)', () => {
    expect(designSystemCss).toMatch(/\.dmk\.is-thinking \.d-out\s*\{[^}]*animation:\s*dRecurseOut 900ms[^;]*\s1;/);
    expect(designSystemCss).toMatch(/\.dmk\.is-thinking \.d-mid\s*\{[^}]*animation:\s*dRecurseMid 900ms[^;]*\s1;/);
    expect(designSystemCss).not.toMatch(/dRecurseOut[^;]*infinite/);
    expect(designSystemCss).not.toMatch(/dRecurseMid[^;]*infinite/);
  });

  it('dRecurseOut arrives at exactly the generator\'s halving ratio (0.5) before snapping back', () => {
    const body = keyframeBody('dRecurseOut');
    expect(body).toMatch(/45%\s*\{\s*transform:\s*scale\(0\.5\)/);
    expect(body).toMatch(/100%\s*\{\s*transform:\s*scale\(1\)/);
  });

  it('the reset is a HARD snap — two keyframe stops within 1 percentage point of each other, not an eased return', () => {
    const body = keyframeBody('dRecurseOut');
    const stops = Array.from(body.matchAll(/(\d+(?:\.\d+)?)%\s*\{\s*transform:\s*scale\(([\d.]+)\)/g)).map((m) => ({
      pct: Number(m[1]),
      scale: Number(m[2]),
    }));
    // find the transition from the held 0.5 scale back to 1
    const heldAt05 = stops.filter((s) => s.scale === 0.5).pop()!;
    const backTo1 = stops.find((s) => s.scale === 1 && s.pct > heldAt05.pct)!;
    expect(backTo1.pct - heldAt05.pct).toBeLessThanOrEqual(1);
  });

  it('dRecurseMid is dRecurseOut\'s shape shifted ~10 percentage points later (outward-to-inward propagation)', () => {
    // Compare by MEANING (first arrival at 0.5, and the snap-back point), not raw stop-count — dRecurseMid
    // legitimately has one extra stop (a flat hold-at-1 through its delayed start) that dRecurseOut doesn't
    // need, since dRecurseOut begins scaling down immediately at 0%.
    const stopsOf = (name: string): { pct: number; scale: number }[] =>
      Array.from(keyframeBody(name).matchAll(/(\d+(?:\.\d+)?)%\s*\{\s*transform:\s*scale\(([\d.]+)\)/g)).map((m) => ({
        pct: Number(m[1]),
        scale: Number(m[2]),
      }));
    const out = stopsOf('dRecurseOut');
    const mid = stopsOf('dRecurseMid');
    const firstArrival = (stops: { pct: number; scale: number }[]): number => stops.find((s) => s.scale === 0.5)!.pct;
    const snapBack = (stops: { pct: number; scale: number }[]): number => {
      const held = stops.filter((s) => s.scale === 0.5).pop()!;
      return stops.find((s) => s.scale === 1 && s.pct > held.pct)!.pct;
    };
    expect(firstArrival(mid) - firstArrival(out)).toBeGreaterThanOrEqual(9);
    expect(firstArrival(mid) - firstArrival(out)).toBeLessThanOrEqual(11);
    expect(snapBack(mid) - snapBack(out)).toBeGreaterThanOrEqual(9);
    expect(snapBack(mid) - snapBack(out)).toBeLessThanOrEqual(11);
  });

  it('RECURSE rules are declared AFTER MESH rules for the same rings (equal specificity — source order decides which wins while .is-thinking is present alongside .is-working)', () => {
    const meshOutIdx = designSystemCss.indexOf('.dmk.is-working .d-out');
    const meshMidIdx = designSystemCss.indexOf('.dmk.is-working .d-mid');
    const recurseOutIdx = designSystemCss.indexOf('.dmk.is-thinking .d-out');
    const recurseMidIdx = designSystemCss.indexOf('.dmk.is-thinking .d-mid');
    expect(meshOutIdx).toBeGreaterThanOrEqual(0);
    expect(recurseOutIdx).toBeGreaterThan(meshOutIdx);
    expect(recurseMidIdx).toBeGreaterThan(meshMidIdx);
  });
});

describe('#580 §6.4 — no breathing anywhere: zero opacity animation in the new keyframes', () => {
  it('none of the four new keyframes touch opacity — pure transform, per the "no breathing" ruling', () => {
    for (const name of ['dMeshOut', 'dMeshMid', 'dRecurseOut', 'dRecurseMid']) {
      expect(keyframeBody(name)).not.toMatch(/opacity/);
    }
  });

  it('reduced-motion resets both rings (.d-out and .d-mid) for the new primitives, dropping the stale .d-core entry', () => {
    // design-system.css has TWO `prefers-reduced-motion` blocks (a generic .viz-surface one earlier, this
    // .dmk-specific one later) — anchor on the LAST occurrence, not the first, to get the right one.
    const block = designSystemCss.slice(designSystemCss.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    const reset = block.slice(0, block.indexOf('}') + 1);
    expect(reset).toMatch(/\.dmk \.d-out/);
    expect(reset).toMatch(/\.dmk \.d-mid/);
    expect(reset).not.toMatch(/\.dmk \.d-core/); // d-core never animates now — nothing to reset
  });
});

describe('#580 §6.1 correction — the shell-idle perf-pause selector actually REACHES the generator\'s child elements', () => {
  it('the corrected selector targets .dmk .d-out/.d-mid (not the old ancestor-only .sidebar-wmark)', () => {
    expect(designSystemCss).toMatch(/body\.shell-idle \.dmk \.d-out,\s*body\.shell-idle \.dmk \.d-mid\s*\{\s*animation-play-state:\s*paused;/);
    // the exact class of bug QA caught: a selector hardcoded to the ancestor div alone
    expect(designSystemCss).not.toMatch(/body\.shell-idle \.sidebar-wmark\s*\{/);
  });

  it('DOM proof: querying the corrected selector (minus the body.shell-idle state prefix) actually finds real child elements in BOTH .dmk instances\' generated markup', async () => {
    // Import lazily so this file's own module-load doesn't require electron/main-only globals.
    const { latticeMotif } = await import('./latticeMotif');
    const brandDiamond =
      `<span class="dmk sidebar-brand-glyph brand-mark is-working" aria-hidden="true">` +
      latticeMotif({ size: 24, depth: 2, stroke: 'var(--gold)', strokeWidths: [1.4, 1.1], levelClassNames: ['d-out', 'd-mid'], core: 'dot', coreClassName: 'd-core' }) +
      `</span>`;
    const sidebarWmark =
      `<div class="sidebar-wmark dmk is-working" aria-hidden="true">` +
      latticeMotif({ size: 220, depth: 2, stroke: 'var(--gold)', strokeWidths: [0.5, 0.5], levelClassNames: ['d-out', 'd-mid'], crosshair: true, crosshairStrokeWidth: 0.5 }) +
      `</div>`;
    const host = document.createElement('div');
    host.innerHTML = brandDiamond + sidebarWmark;
    document.body.appendChild(host);
    try {
      // The selector body.shell-idle .dmk .d-out/.d-mid; strip the state-toggle ancestor (body.shell-idle
      // is a class on <body>, not part of the reachability question) and confirm it resolves to real nodes
      // in EACH .dmk instance — 2 rings × 2 instances = 4 total, matching the fix's own "covers both" claim.
      const outs = host.querySelectorAll('.dmk .d-out');
      const mids = host.querySelectorAll('.dmk .d-mid');
      expect(outs).toHaveLength(2); // BRAND_DIAMOND's + the watermark's
      expect(mids).toHaveLength(2);
      // the OLD buggy selector (.sidebar-wmark alone) matches the ancestor div, never a ring — confirming
      // why it silently missed every animated child, the exact failure mode QA caught.
      expect(host.querySelector('.sidebar-wmark')).not.toBeNull();
      expect(host.querySelector('.sidebar-wmark.d-out, .sidebar-wmark.d-mid')).toBeNull();
    } finally {
      host.remove();
    }
  });
});
