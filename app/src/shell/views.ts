// The views the navigation shell registers in v1 (SPEC-0017 SHELL-3).
//
// This is pure metadata (no DOM) so it can be asserted in the node tier alongside
// navModel (SHELL-6). The DOM mount functions are wired by id in shell.ts.

import type { NavView } from './navModel';

/** Stable view ids — referenced by the shell's mount map and by tests. */
export const VIEW_TODAY = 'today'; // SPEC-0058 — the v2 command-center home (default on launch)
export const VIEW_CAPTURE = 'capture';
export const VIEW_REVIEWS = 'reviews';
export const VIEW_ACTIVITY = 'activity';
export const VIEW_ASK = 'ask';
export const VIEW_EXPLORE = 'explore'; // SPEC-0039 — read-only entity-neighborhood graph view
export const VIEW_HEALTH = 'health'; // SPEC-0035 — read-only structural-health lint readout
// Control Panel — the "Manage" section of sibling views (SPEC-0027 PANEL-1).
// SPEC-0053 WS-E: the former Jobs + Agents + Researchers rail items are consolidated into one **Agents
// hub** (`VIEW_AGENTS`) framed by direction (Librarians inward + their Schedules; Researchers outward).
// `VIEW_JOBS`/`VIEW_RESEARCHERS` ids are retained (deep-link/back-compat) but no longer rail entries.
export const VIEW_JOBS = 'jobs';
export const VIEW_AGENTS = 'agents';
export const VIEW_RESEARCHERS = 'researchers';
export const VIEW_SOURCES = 'sources';
// SPEC-0060 VUX-4 — "Sources" becomes "Connectors" (guided connect-a-source). The rail route is
// `connectors`; the view rebuild (warm connect-a-source cards) is its own per-view PR — until then the
// shell aliases `connectors` → the existing Sources mount, so the rename is real with no dead route.
export const VIEW_CONNECTORS = 'connectors';
export const VIEW_SETTINGS = 'settings';

/** The rail section heading the Control Panel views sit under (SPEC-0027 PANEL-1). */
export const GROUP_MANAGE = 'Manage';

/**
 * The views, in rail order — the SPEC-0060 v3 IA (VUX-4), "reach-for-most first". Today (the home,
 * default on launch — SPEC-0058, amending SHELL-4's Capture default; the "always a fixed home on launch"
 * behavior of SPEC-0017 §5 is preserved, only the home moved) · Ask · Capture · Reviews · Explore ·
 * Activity · Health — then a "Manage" section: Agents · Connectors · Settings.
 *
 * v3 IA moves (locked, SPEC-0060 §4):
 * - **Status DISSOLVED** — no standalone Status/"the Line" rail view, and no mount at all (VUX-RETIRE
 *   #523 §7 deleted the dead statusView/lineMotion/theLineModel cluster — it was unreachable + tree-
 *   shaken already). "What's moving" lives on Today's flow-strip; deep diagnostics fold into Health;
 *   stuck items route to Reviews — both already shipped SPEC-0060 replacements.
 * - **Sources → Connectors** — the rail entry is now `connectors` (the Sources mount is aliased until
 *   the Connectors view rebuild lands as its own PR). Watched-folders move into Settings (view content).
 * - Jobs/Researchers remain folded into the Agents hub (SPEC-0053 WS-E); their ids are deep-link-only.
 *
 * No dead "Coming soon" rail item (SPEC-0017 SHELL-3 amended) — every entry mounts a real view.
 */
export const NAV_VIEWS: NavView[] = [
  // icon = a key into the inline line-icon set (shell/icons.ts), NOT an emoji — v3 monochrome rail glyphs.
  { id: VIEW_TODAY, label: 'Today', icon: 'today' },
  { id: VIEW_ASK, label: 'Ask', icon: 'ask' },
  { id: VIEW_CAPTURE, label: 'Capture', icon: 'capture' },
  { id: VIEW_REVIEWS, label: 'Reviews', icon: 'reviews' },
  { id: VIEW_EXPLORE, label: 'Explore', icon: 'explore' },
  { id: VIEW_ACTIVITY, label: 'Activity', icon: 'activity' },
  { id: VIEW_HEALTH, label: 'Health', icon: 'health' },
  { id: VIEW_AGENTS, label: 'Agents', icon: 'agents', group: GROUP_MANAGE },
  { id: VIEW_CONNECTORS, label: 'Connectors', icon: 'connectors', group: GROUP_MANAGE },
  { id: VIEW_SETTINGS, label: 'Settings', icon: 'settings', group: GROUP_MANAGE },
];

/** The view active on launch (SPEC-0058 — the Today home, amending SHELL-4's Capture default). */
export const DEFAULT_VIEW_ID = VIEW_TODAY;
