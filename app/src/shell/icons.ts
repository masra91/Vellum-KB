// UX v2 nav icon set (vellum-ux-v2-language §3 / "Shell language"). Monochrome inline-SVG line glyphs in
// the Tabler `ti-*` idiom — INLINED (no CDN / webfont; packaged-safe) and stroked with `currentColor`, so
// each icon inherits the nav item's color and gilds gold on hover/active (the prototype's behavior). This
// replaces the multicolor emoji that clashed with the polished rail (worst on the night-study ground).
//
// Each entry is the inner markup of a 24×24 line glyph; `navIcon` wraps it in the shared <svg> shell.
// All static, trusted strings — safe to inject without escaping (no user data).
const ICON_PATHS: Record<string, string> = {
  // home
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>', // sun (v3 — the command-center home, SPEC-0060)
  // do
  capture: '<path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M8 11l4 4 4-4"/><path d="M12 4v11"/>', // tray + down-arrow (inbox/capture)
  ask: '<path d="M21 11.5a8.38 8.38 0 0 1-9 8.3 8.5 8.5 0 0 1-3.4-.7L3 21l1.9-5.1A8.38 8.38 0 0 1 4 11.5a8.5 8.5 0 0 1 17 0z"/>', // speech bubble
  explore: '<circle cx="6" cy="6" r="2.1"/><circle cx="18" cy="6" r="2.1"/><circle cx="12" cy="18" r="2.1"/><path d="M7.6 7.4 11 15.6M16.4 7.4 13 15.6M8 6h8"/>', // affiliate (graph)
  // pipeline
  reviews: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 11l1.4 1.4L13 10M9 16h5"/>', // checkup-list (clipboard + check)
  activity: '<path d="M3 12h4l2.5 7 4-14 2.5 7H21"/>', // activity heartbeat line
  health: '<path d="M5 4v5a4 4 0 0 0 8 0V4"/><path d="M5 4H3.5M13 4h1.5"/><path d="M9 17a4.5 4.5 0 0 0 9 0v-2"/><circle cx="18" cy="13" r="2"/>', // stethoscope
  // manage
  agents: '<rect x="4" y="8" width="16" height="11" rx="2"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 16h6"/>', // robot
  sources: '<rect x="4" y="3" width="11" height="14" rx="2"/><path d="M8 20h9a2 2 0 0 0 2-2V8"/>', // files
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M5.8 5.8l1.4 1.4M16.8 16.8l1.4 1.4M18.2 5.8l-1.4 1.4M7.2 16.8l-1.4 1.4"/>', // gear
  status: '<path d="M5 19V11M12 19V5M19 19V14"/><path d="M4 20h16"/>', // chart-bar
  connectors: '<path d="M9 2v6M15 2v6"/><path d="M7 8h10v3a5 5 0 0 1-10 0z"/><path d="M12 16v6"/>', // plug (v3 Connectors — connect-a-source, SPEC-0060)
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>', // the "you" identity (v3 rail user card, SPEC-0060)

  // Activity feed event-kind glyphs (DL-2's table; consumed by activityView via the tile, hue per kind).
  // `capture` (above) is reused for the capture event. Same line idiom → they gild with the tile color.
  link: '<path d="M9.5 14.5l5-5"/><path d="M11 6.5l1-1a3.5 3.5 0 0 1 5 5l-1 1"/><path d="M13 17.5l-1 1a3.5 3.5 0 0 1-5-5l1-1"/>', // connect → chain link
  quote: '<path d="M10 11H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2.5-1.3 4.1-4 4.8"/><path d="M19 11h-4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6c0 2.5-1.3 4.1-4 4.8"/>', // claim → quotation mark
  sparkles: '<path d="M12 3l1.8 5L19 10l-5.2 2L12 17l-1.8-5L5 10l5.2-2z"/><path d="M19 14l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>', // enrich → sparkles
  search: '<circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/>', // research → magnifier
  book: '<path d="M12 6c-2-1.4-5-1.4-7 0v12c2-1.4 5-1.4 7 0M12 6c2-1.4 5-1.4 7 0v12c-2-1.4-5-1.4-7 0M12 6v12"/>', // compose → book
  'arrow-up-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 16V8M8.5 11.5L12 8l3.5 3.5"/>', // promote → up-arrow in circle
  split: '<circle cx="7" cy="6" r="1.8"/><circle cx="7" cy="18" r="1.8"/><circle cx="17" cy="9" r="1.8"/><path d="M7 7.8v8.4M7 12h6a4 4 0 0 0 4-4v-.2"/>', // decompose → branch
  'alert-triangle': '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>', // failed → warning triangle (pairs with oxide)
  'circle-check': '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>', // settled / ok health row (pairs with patina)

  // #519 §3 — top-bar context-chip glyphs (Explore/Activity/Health/Agents), verbatim keys from the mock's
  // ti-filter/ti-category/ti-stack-2/ti-refresh/ti-plus, redrawn in this set's own line idiom.
  filter: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>', // funnel
  category: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>', // 2x2 grid (entity kinds)
  'stack-2': '<rect x="4" y="4" width="16" height="6" rx="1"/><rect x="4" y="14" width="16" height="6" rx="1"/>', // stacked bands (activity feed)
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>', // one clockwise arrow → re-scan
  plus: '<path d="M12 5v14M5 12h14"/>', // add-a-researcher
};

/** Render an inline line-icon SVG (1em, currentColor) for ANY ICON_PATHS key — nav OR activity event-kind.
 *  Inherits the host's color (gilds gold on a gilded row; takes the tile hue on a feed glyph-tile).
 *  Unknown key → empty string (graceful). (Name kept `navIcon` for the shell call site; serves all keys.) */
export function navIcon(key: string): string {
  const inner = ICON_PATHS[key];
  if (!inner) return '';
  return (
    `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
  );
}
