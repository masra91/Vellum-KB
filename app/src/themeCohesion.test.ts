// Guard for SPEC-0057 theming. Light is the DEFAULT Vellum identity (brand §3 — "the cream study is the
// product"): the bare :root is fixed-light cream and there is NO prefers-color-scheme auto-switch (#214's
// OS-tracking stays removed, Principal-confirmed). Dark is an OPT-IN "night-study" variant
// (brand/DARK-MODE-ADDENDUM.md) activated only when the app sets `data-theme="dark"` on the root — it
// re-points the SAME tokens to the dark values (zero call-site churn), never inverts the default.
// Fails-before/passes-after: the dark layer asserts the opt-in block exists with the addendum's values
// AND that none of it leaks into the light default.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, 'index.css'), 'utf8'); // CJS module target → __dirname, not import.meta
const ds = readFileSync(path.join(__dirname, 'shell', 'design-system.css'), 'utf8');

describe('app shell light is the DEFAULT (SPEC-0057, supersedes #214)', () => {
  it('the default is fixed-light: bare :root is light-only with NO prefers-color-scheme auto-switch', () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*light\s*;/);
    expect(css).not.toMatch(/color-scheme:\s*light dark/);
    expect(css).not.toMatch(/@media \(prefers-color-scheme/); // dark is opt-in via data-theme, never OS-auto
  });

  it('the default :root uses the Vellum cream palette, aligned to the --viz-* tokens', () => {
    expect(css).toContain('--bg: #f4efe3');     // Vellum cream  (= --viz-field)
    expect(css).toContain('--fg: #2b2f36');     // Slate Ink     (= --viz-ink)
    expect(css).toContain('--border: #e0d6be'); // Hairline      (= --viz-rule)
    expect(css).toContain('--accent: #3a6e88'); // slate-blue    (= --viz-accent), not framework indigo
    expect(css).toContain('--hover: rgba(0, 0, 0, 0.05)');
  });

  it('the pre-Vellum palette is gone — no framework-indigo accent, no dark-default ground', () => {
    expect(css).not.toContain('#6c8cff');       // framework indigo accent → replaced by slate-blue
    expect(css).not.toContain('--bg: #1e1e22'); // old dark-default ground → gone (light is the default)
  });

  it('hover washes are tokenized — no hardcoded white :hover background (would die on cream)', () => {
    // A literal rgba(255,255,255,…) :hover background is invisible on the cream ground; route via var(--hover).
    expect(css).not.toMatch(/:hover\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255/);
  });
});

describe('dark "night-study" is an OPT-IN data-theme variant (brand/DARK-MODE-ADDENDUM.md)', () => {
  it('the shell ships a [data-theme="dark"] mirror with the addendum values', () => {
    expect(css).toMatch(/:root\[data-theme=['"]dark['"]\]/);
    expect(css).toContain('--bg: #15242e');   // dark canvas   (= dark --viz-field)
    expect(css).toContain('--fg: #ece4d2');   // parchment ink (= dark --viz-ink; cream becomes the ink)
    expect(css).toContain('--accent: #5e93b4'); // mid-blue lifted (= dark --viz-accent)
    expect(css).toContain('--border: #2c4150'); // window border (addendum)
  });

  it('the design-system re-points the SAME --viz-* role names under [data-theme="dark"] (zero call-site churn)', () => {
    expect(ds).toMatch(/:root\[data-theme=['"]dark['"]\]/);
    expect(ds).toContain('--viz-field: #15242e');
    expect(ds).toContain('--viz-ink: #ece4d2');
    expect(ds).toContain('--viz-accent: #5e93b4');
  });

  it('rationed gold + reserved ember are UNCHANGED on dark (discipline holds, brand §3)', () => {
    // Both hues are unchanged between light and dark — assert they remain the brand values in the dark block.
    const darkBlock = ds.slice(ds.indexOf("[data-theme='dark']"));
    expect(darkBlock).toContain('--viz-brass: #c9a35a'); // rationed gold, unchanged
    expect(darkBlock).toContain('--viz-ember: #c8743c'); // reserved decision, unchanged
  });

  it('no dark value leaks into the light default :root', () => {
    // The dark canvas only appears inside the data-theme block, never in the bare light :root.
    const lightRoot = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    expect(lightRoot).not.toContain('#15242e');
    expect(lightRoot).toContain('#f4efe3');
  });
});

describe('VUX-DARK #521 — every v3 token has a dark counterpart, hex-literal survival patches swept', () => {
  const V3_TOKENS = [
    'vellum', 'linen', 'parchment', 'viridian', 'viridian-2', 'deep', 'slate', 'mist',
    'gold', 'gold-deep', 'sprout', 'ember', 'oxide', 'ink', 'ink-2', 'stone', 'faint', 'hair',
  ];
  const darkRegion = ds.slice(ds.indexOf("[data-theme='dark']"));

  it('every v3 color token declared in the light :root is re-pointed under [data-theme="dark"] (§5 — fails loudly if a future token ships light-only)', () => {
    for (const token of V3_TOKENS) {
      expect(darkRegion, `--${token} has no dark counterpart`).toMatch(new RegExp(`--${token}:\\s`));
    }
  });

  it('the ten hand-hex survival-patch sites are gone (§4 sweep) — no light-literal card ships light-on-dark', () => {
    const SURVIVAL_HEXES = ['#f3ead6', '#e9dec6', '#f0e7d3', '#e7dcc3', '#fbf6ea', '#2a5f50', '#296253', '#23553f', '#1e4a39', '#e6ce86', '#1e5443', '#fcf8ef'];
    for (const hex of SURVIVAL_HEXES) {
      expect(css, `${hex} should have been converted to a token/color-mix`).not.toContain(hex);
    }
  });

  it('--gold-deep dark clears AA (≥4.5:1) against --viz-panel dark (§5 AC — no shipped precedent to copy)', () => {
    // #d9b872 on #1e3340 ≈ 6.9:1 (measured via WCAG relative-luminance contrast). Locks the literal so a
    // future edit to either value re-triggers this check rather than silently drifting under AA.
    expect(darkRegion).toMatch(/--gold-deep:\s*#d9b872/);
  });
});

describe('.warning caution is tokenized (SPEC-0057 dark-coverage + #184)', () => {
  // .warning was a hardcoded amber (background:#fff8e1) that wouldn't flip under the [data-theme=dark]
  // role-token re-point → a glaring light island on the dark ground (it was also off-brand in light).
  // Now the Vellum caution language: --viz-ink label + --viz-brass border/wash → adapts to dark for free.
  const rule = css.slice(css.indexOf('.warning {'), css.indexOf('}', css.indexOf('.warning {')));

  it('drops the hardcoded amber (won’t-flip light-island) values', () => {
    expect(rule).not.toContain('#fff8e1'); // old light-yellow bg
    expect(rule).not.toContain('#8a6d00'); // old amber text
    expect(rule).not.toContain('#f0d98c'); // old amber border
  });

  it('hue rides the --viz-brass role token; the label stays --viz-ink (AA, #184)', () => {
    expect(rule).toContain('var(--viz-brass)'); // border/wash carry the caution hue → re-themes on dark
    expect(rule).toContain('var(--viz-ink)'); // readable label stays ink, never the sub-AA brass
  });
});
