---
design: VUX-EMPTY
implements: SPEC-0057
title: Branded empty states — closing BRAND-7 (composes SETUP, SPEC-0009)
type: design
status: draft
owners: [KB-Design-Lead-2, Principal]
created: 2026-07-13
updated: 2026-07-13
related: [SPEC-0057, SPEC-0009, SPEC-0060, "issue #406"]
gates:
  ai-patterns: pending      # GATE 1 — KB-AI-Detector
  boundaries: not-yet-routed # GATE 2 — KB-QD, routed at dispatch
---

# Branded empty states — closing BRAND-7

> Issue **#406** ("About panel + branded empty/first-run states"). The About panel (BRAND-4) and
> the first-run setup screen are **already fully built** — this spec covers only what's actually
> left: **BRAND-7**, "empty/first-run states carry the brand," audited surface by surface against
> the current committed tree (not a stale checkout — verified against `origin/main`, see §1).

## 1. What's already done (don't re-touch)

Before scoping new work, an audit turned up more prior progress than the issue title suggested:

- **About panel** (`aboutPanel.ts`) — fully built: mark, Spectral wordmark, tagline, defensive
  version (RELEASE-6), credits, dismissable modal, focus-trap, a11y. **BRAND-4 is done.**
- **First-run setup screen** (`renderer.ts` `renderSetup()`) — fully re-tokened under `.setup-view`
  (linen card, Spectral heading, bottom-rule field, monochrome status glyphs replacing the old
  colored emoji). **Not a gap** — a prior pass on this exact file already landed it.
- **The shared branded primitive itself** — `emptyState()` (`shell/html.ts`) + `.viz-empty` /
  `.viz-empty--compact` CSS already exist and are **already the right design** (a rationed
  crystalline `◇` mark + Spectral title for a primary "hero" empty state; a quieter Inter-only,
  no-glyph `compact` treatment for a secondary list-within-a-panel). Already adopted correctly on:
  **Reviews**, **Explore** (whole-graph-empty), **Today**'s activity panel, **Connectors**' feed
  list, **Settings**' watched-folders list. **Do not redesign this primitive** — the remaining work
  is *adopting* it where it's still missing (§2), not building something new.
- **Ask**'s bespoke seal glyph (`.ask-empty-seal`, parchment/viridian) predates the shared primitive
  and is a deliberately distinct, already-good design — like the About panel's inverted hero, this
  is a **sanctioned exception**, not a gap to homogenize away.
- **Health**'s zero-issue affirmation ("✓ Structurally sound," patina-toned) is already branded.

## 2. The actual gap — four surfaces still generic

| Surface | Current | Fix |
|---|---|---|
| **Activity** (`activityView.ts:304`) | One plain `<p class="activity-note activity-empty">` covering BOTH "no activity ever" and "filtered to zero results" identically — no glyph, no brand voice, no distinction between the two meaningfully-different states | Split into two `emptyState()` calls (hero variant — Activity is a primary rail view, matching Reviews/Explore's precedent, not a secondary in-panel list): **(a) true-empty** — `title: "Nothing has happened yet."`, `body: "As your library captures and connects, what it does shows up here."` (mirrors Today's parallel phrasing for the same concept). **(b) filtered-to-zero** — realizes the `vellum-v3.html:880-928` mock that was never shipped: `title: 'Nothing matches "{term}"'` (interpolated, escaped), `body: "No run summaries contain those words. Try a shorter term, an entity name, or a different source."`, `action:` a `.viz-btn` "Clear filters" button wired to the existing reset handler. |
| **Agents hub — Librarians** (`agentsView.ts:60`) | `<p class="ag-empty viz-body">No librarians to show — open a library.</p>` | `emptyState({ title: 'No librarians to show — open a library.', compact: true })`. **Compact, not hero** — this is a sub-panel nested inside the Agents hub's sectioned layout (matches the Connectors/Settings precedent for a secondary list-within-a-page), not a full-page empty. Copy preserved verbatim — no meaning change, just componentized. |
| **Agents hub — Schedules** (`jobsView.ts:79`) | `<p class="job-empty viz-body">No jobs available — open a library to manage its jobs.</p>` | Same pattern: `emptyState({ title: 'No jobs available — open a library to manage its jobs.', compact: true })`. |
| **Agents hub — Researchers** (`researchersView.ts:110`) | `` `<p class="rdesk-empty viz-body">No researchers yet — dispatch one from a template below.</p>` `` | Same pattern: `emptyState({ title: 'No researchers yet — dispatch one from a template below.', compact: true })`. |

**Two minor polish items, not structural changes** (small in-context fragments, not page-level empty
states — don't force them into the `emptyState()` component, which renders a block `<div>`):

- **Explore's inline graph text** (`exploreView.ts:278`, `<text class="exp-graph-empty">No promoted
  relationships yet…</text>`) — currently unstyled (inherits default SVG fill, no token). Give it
  `fill: var(--stone)` so it reads as calm/quiet like every other secondary-note text in the app,
  not as an unstyled accident.
- **Today's pipeline-idle fragment** (`todayView.ts:147`, `<span class="today-flow-empty
  viz-body">The pipeline is idle.</span>`) — already has `.viz-body`; confirm it resolves to
  `var(--stone)` (not left to inherit `--ink`), consistent with every other idle/quiet note in the
  app. If it already does, no change — call this out as a verify-only item for the executor, not an
  assumed gap.

## 3. Copy discipline check (SPEC-0060 §3)

Every new/changed string above was checked against the standing copy rules: calm, sparse, human, no
instructive AI-slop, no creator jargon. "Nothing has happened yet" / "Nothing matches" both read as
plain human observations, not app-speak. The Activity filtered-zero body line is lifted verbatim
from the mock (already-approved copy, not newly invented) — reusing it here instead of drafting a
variant avoids a second copy fork for the same concept.

## 4. Acceptance criteria

- [ ] Activity distinguishes true-empty from filtered-zero with two distinct `emptyState()` calls
      per §2's copy; the filtered-zero case names the actual search term and its "Clear filters"
      button actually resets the filter/search state.
- [ ] All three Agents-hub sub-panels (Librarians/Schedules/Researchers) render their empty state
      via the shared `emptyState({ compact: true })` call, not a bespoke `<p>` — existing copy
      preserved verbatim.
- [ ] No behavior change to Reviews, Explore (whole-graph-empty), Today's activity panel,
      Connectors, Settings/watched-folders, Ask, About, Health, or first-run setup — all already
      correct, out of scope for this spec.
- [ ] Explore's inline "no relationships" SVG text and Today's pipeline-idle fragment read in
      `--stone` (verify Today's first — may already be correct).

## 5. Test cases

Activity: one unit for the true-empty render (no entries at all) asserting `emptyState()`'s hero
markup + copy; one for filtered-to-zero asserting the interpolated term appears in the title and
the reset button is present and functional (mirrors the existing #524 gate-2 test-shape pattern —
per-treatment, not a single shared assertion). Agents hub: one assertion per sub-panel (Librarians/
Schedules/Researchers) that the empty-state render uses `.viz-empty--compact` and preserves the
exact existing copy string (a regression guard against an accidental copy change during
componentization). Explore/Today polish items: a computed-style check (or visual DL-1 spot-check)
that the fill/color resolves to `--stone`.

## 6. Changelog

- 2026-07-13 — created (draft). Dispatched to KB-Design-Lead-2 in `#wave2-brand-identity` as the
  natural continuation of the #523 About-panel re-token work. Audit against `origin/main` (not a
  stale local checkout) found About/first-run/the shared primitive already fully built — narrowed
  scope to the four surfaces still using ad-hoc plain-text empty states (Activity ×2, Agents-hub
  ×3) plus two small polish items. Awaiting GATE 1 (KB-AI-Detector).
