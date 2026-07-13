// VUX-CLIP #522 §2/§6 — the three-treatment dynamic-text overflow contract. Most sites (C2-C7) are
// markup fixes verified by their own view's component tests (a `title` attribute + `.v3-clip` class on
// a real rendered node). The sites below are pure CSS-rule fixes with no markup signal to assert in a
// component test, so — per the themeCohesion.test.ts precedent — this reads the raw stylesheet text.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, 'index.css'), 'utf8');
const qcapCss = readFileSync(path.join(__dirname, 'qcap', 'qcap.css'), 'utf8');

/** Extract a single CSS rule's body by its exact selector (first match). */
function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

describe('C1 — agent instructions WRAP (not clip); the base .path wrap is no longer overridden', () => {
  it('.ag-last .path carries no overflow/ellipsis/nowrap override', () => {
    const rule = ruleBody(css, '.ag-last .path');
    expect(rule).not.toMatch(/white-space:\s*nowrap/);
    expect(rule).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).not.toMatch(/overflow:\s*hidden/);
  });
});

describe('C10 — the Ask past-chats panel shrinks with the window instead of clipping off-edge', () => {
  it('.ask-pastpanel is capped to the viewport, not a bare fixed 22rem', () => {
    const rule = ruleBody(css, '.ask-pastpanel');
    expect(rule).not.toMatch(/width:\s*22rem\s*;/); // bare fixed width is gone
    expect(rule).toMatch(/width:\s*min\(/); // responsive cap present
    expect(rule).toMatch(/100vw/);
  });
});

describe('C11 — a long qcap permission-steer note wraps within the head row, never widens the sheet', () => {
  it('.qcap-head and .qcap-head__meta allow wrapping', () => {
    expect(ruleBody(qcapCss, '.qcap-head')).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleBody(qcapCss, '.qcap-head__meta')).toMatch(/flex-wrap:\s*wrap/);
  });
});

// C9 (Explore SVG node-label flip/reflow at the viewport edge) is deliberately DEFERRED, not silently
// dropped: the current fixed 12-node radial layout (R≈190 of a 760×560 viewBox) has enough built-in
// margin that genuine edge-clipping is unlikely under today's node count/radius math, and the issue's
// own spec marks it "lowest priority... an edge case, not an everyday occurrence." Flagging here so a
// future pass has a landing spot, rather than a silent gap this suite would otherwise imply is covered.
describe.skip('C9 — Explore SVG node-label flip/reflow at the viewport edge (DEFERRED, see comment above)', () => {
  it.todo('mirrors a node label to the opposite side of its anchor when it would clip the viewport edge');
});
