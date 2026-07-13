// The fractal-lattice motif (#402 §2) — a self-similar nested-diamond shape, generated on a fixed
// 0–24 viewBox (the app mark's native coordinate system; `size` only sets the rendered width/height
// attributes, never the internal geometry). Replaces four hand-duplicated inline SVG literals
// (shell.ts's BRAND_DIAMOND + SIDEBAR_WMARK, aboutPanel.ts's MARK_SVG) with one parameterized source
// (`_design-system.md` §7: reused by a 2nd surface → belongs in the shared kit). Explore's center node
// (`exploreView.ts`'s `.exp-center-lattice`) stays OUT of scope — it's path-based, not polygon-based,
// and carries a standing Principal "no breathing ring" exception (#402 §5.1) unrelated to this generator.
//
// Each nested diamond halves the previous one's radius (R0=10, R1=5, R2=2.5 — the fractal's literal
// self-similarity). `strokeWidths`/`levelClassNames` are arrays outermost-first, one entry per `depth`
// level, since the four call sites genuinely differ here (BRAND_DIAMOND tapers 1.4→1.1 and classes each
// ring for the LOOM/CHURN motion selectors; SIDEBAR_WMARK uses a flat 0.5 and no classes at all).

const CENTER = 12; // fixed viewBox is 0 0 24 24 — the diamond math is relative to this center
const OUTER_RADIUS = 10; // the outermost ring's distance from center (matches the shipped shapes exactly)
const CORE_RADIUS = 1.9; // the center dot's radius (both existing dot instances use this exact value)

export interface LatticeMotifOptions {
  /** Rendered width/height attribute — omit to let the caller's CSS size the svg (About's mark does this). */
  size?: number;
  /** How many nested diamonds, each at half the previous radius. */
  depth: 1 | 2 | 3;
  /** Stroke (and, when `core` draws one, the dot's fill) color — a CSS custom-property reference or `currentColor`. */
  stroke: string;
  /** Per-level stroke-width, outermost first — length must equal `depth`. */
  strokeWidths: number[];
  /** Rounds line caps too (About's mark) — omit for miter-only joins (brand/sidebar marks). */
  roundCaps?: boolean;
  /** A class on each diamond level, outermost first (e.g. `['d-out','d-mid']`) — lets a caller's motion
   *  CSS (`.dmk.is-working .d-core` etc.) target a specific ring. Omit for a fully static instance. */
  levelClassNames?: string[];
  /** The center element: a filled dot (radius {@link CORE_RADIUS}), or none. */
  core?: 'dot' | 'none';
  /** A class on the center dot (e.g. `'d-core'`) — only meaningful when `core: 'dot'`. */
  coreClassName?: string;
  /** Full-bleed crosshair lines through the center, spanning the OUTER ring's extent (independent of
   *  `depth` — SIDEBAR_WMARK/About's mark both anchor the crosshair to the outermost diamond's points). */
  crosshair?: boolean;
  /** stroke-width on the crosshair lines — set explicitly (not inherited) since it commonly differs from
   *  the polygons' own widths (About's mark: 0.9 vs 1.5/1.2). Required when `crosshair` is true. */
  crosshairStrokeWidth?: number;
  /** Opacity on the crosshair lines only (e.g. About's mark dims them to 0.85). Omitted = fully opaque. */
  crosshairOpacity?: number;
}

/** One nested diamond's four points at `radius` from the fixed center, as an SVG `points` attribute value. */
function diamondPoints(radius: number): string {
  return `${CENTER},${CENTER - radius} ${CENTER + radius},${CENTER} ${CENTER},${CENTER + radius} ${CENTER - radius},${CENTER}`;
}

/** Build the lattice motif's SVG markup string (#402 §2). Trusted/static input only (design-system
 *  tokens + literal option values) — never renders user- or agent-derived content, so no escaping. */
export function latticeMotif(opts: LatticeMotifOptions): string {
  const { size, depth, stroke, strokeWidths, roundCaps, levelClassNames, core = 'none', coreClassName, crosshair, crosshairStrokeWidth, crosshairOpacity } = opts;

  const polygons = Array.from({ length: depth }, (_, i) => {
    const radius = OUTER_RADIUS / 2 ** i;
    const cls = levelClassNames?.[i] ? ` class="${levelClassNames[i]}"` : '';
    return `<polygon${cls} points="${diamondPoints(radius)}" stroke-width="${strokeWidths[i]}"/>`;
  }).join('');

  const crosshairLines = crosshair
    ? `<line x1="${CENTER - OUTER_RADIUS}" y1="${CENTER}" x2="${CENTER + OUTER_RADIUS}" y2="${CENTER}" stroke-width="${crosshairStrokeWidth}"${crosshairOpacity !== undefined ? ` opacity="${crosshairOpacity}"` : ''}/>` +
      `<line x1="${CENTER}" y1="${CENTER - OUTER_RADIUS}" x2="${CENTER}" y2="${CENTER + OUTER_RADIUS}" stroke-width="${crosshairStrokeWidth}"${crosshairOpacity !== undefined ? ` opacity="${crosshairOpacity}"` : ''}/>`
    : '';

  const coreEl = core === 'dot' ? `<circle${coreClassName ? ` class="${coreClassName}"` : ''} cx="${CENTER}" cy="${CENTER}" r="${CORE_RADIUS}" fill="${stroke}"/>` : '';

  const sizeAttrs = size !== undefined ? ` width="${size}" height="${size}"` : '';
  const linecapAttr = roundCaps ? ' stroke-linecap="round"' : '';

  return (
    `<svg${sizeAttrs} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">` +
    `<g fill="none" stroke="${stroke}" stroke-linejoin="round"${linecapAttr}>${polygons}${crosshairLines}</g>` +
    `${coreEl}</svg>`
  );
}
