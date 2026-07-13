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
  ai-patterns: pending      # GATE 1 — re-review requested after §2 factual correction, 2026-07-13
  boundaries: pending       # GATE 2 — KB-Quality-Driver-2 REJECTED then re-review, 2026-07-13
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
- **Activity's filtered-to-zero state** (`activityView.ts:300-302`, `bodyHtml()`'s `s.filterActive`
  branch) — **already fully built**, realizing the `vellum-v3.html` mock exactly: a bespoke
  `.act-empty` div (`navIcon('search')` glyph, "Nothing matches *{term}*" naming the search term,
  the explanatory line, a wired "Clear filters" button), styled on-brand tokens throughout
  (`index.css:1467-1472` — `--gold` icon, `--deep`/`--stone`/`--ink-2` text). **Corrected 2026-07-13
  per KB-Quality-Driver-2's gate-2 catch** — an earlier draft of this spec claimed this state was
  unbuilt; it was verified against `origin/main` and found already done. Not touched by this spec.
- **Explore's inline graph text** (`exploreView.ts:278`) — **already styled**:
  `index.css:1010` sets `.exp-graph-empty { font-family: var(--ui); font-size: 12px; fill:
  var(--stone); }` — exactly the fix an earlier draft of this spec proposed adding. **Corrected
  2026-07-13 per the same gate-2 catch.** Not touched by this spec.

## 2. The actual gap — one surface, plus three componentization-only fixes

| Surface | Current | Fix |
|---|---|---|
| **Activity — true-empty only** (`activityView.ts:304`, the non-`filterActive` branch) | Plain `<p class="activity-note activity-empty">No activity yet…</p>` — no glyph, no brand voice. (The filtered-to-zero sibling state is already built — see §1, not touched here.) | One `emptyState()` call (hero variant — Activity is a primary rail view, matching Reviews/Explore's precedent): `title: "Nothing has happened yet."`, `body: "As your library captures and connects, what it does shows up here."` (mirrors Today's parallel phrasing for the same concept). |
| **Agents hub — Librarians** (`agentsView.ts:60`) | `<p class="ag-empty viz-body">No librarians to show — open a library.</p>` | `emptyState({ title: 'No librarians to show — open a library.', compact: true })`. **Compact, not hero** — this is a sub-panel nested inside the Agents hub's sectioned layout (matches the Connectors/Settings precedent for a secondary list-within-a-page), not a full-page empty. Copy preserved verbatim — no meaning change, just componentized. |
| **Agents hub — Schedules** (`jobsView.ts:79`) | `<p class="job-empty viz-body">No jobs available — open a library to manage its jobs.</p>` | Same pattern: `emptyState({ title: 'No jobs available — open a library to manage its jobs.', compact: true })`. |
| **Agents hub — Researchers** (`researchersView.ts:110`) | `` `<p class="rdesk-empty viz-body">No researchers yet — dispatch one from a template below.</p>` `` | Same pattern: `emptyState({ title: 'No researchers yet — dispatch one from a template below.', compact: true })`. |

**One remaining verify-only item** (not an assumed gap):

- **Today's pipeline-idle fragment** (`todayView.ts:147`, `<span class="today-flow-empty
  viz-body">The pipeline is idle.</span>`) — `.viz-body` only sets `font-family` (per
  `design-system.css`), not color, so this text inherits its container's color rather than
  resolving to a token — executor should confirm it reads as `--stone`/quiet, not full-strength
  `--ink`, and add an explicit color if it doesn't. Genuinely unverified either way (unlike the two
  items above, which gate-2 confirmed directly) — that's why this one stays hedged instead of
  asserted as done or as a gap.

## 3. Copy discipline check (SPEC-0060 §3)

Every new/changed string above was checked against the standing copy rules: calm, sparse, human, no
instructive AI-slop, no creator jargon. "Nothing has happened yet" / "Nothing matches" both read as
plain human observations, not app-speak. Activity's true-empty copy deliberately mirrors Today's
existing "Nothing has moved yet." phrasing for the same underlying concept ("your library hasn't
done anything yet"), rather than drafting an unrelated third variant.

## 4. Acceptance criteria

- [ ] Activity's true-empty state (no entries at all, not filtered) renders via `emptyState()`
      hero variant per §2's copy — the already-built filtered-to-zero state is untouched.
- [ ] All three Agents-hub sub-panels (Librarians/Schedules/Researchers) render their empty state
      via the shared `emptyState({ compact: true })` call, not a bespoke `<p>` — existing copy
      preserved verbatim.
- [ ] No behavior change to Reviews, Explore, Today's activity panel, Activity's filtered-to-zero
      state, Connectors, Settings/watched-folders, Ask, About, Health, or first-run setup — all
      already correct, out of scope for this spec.
- [ ] Today's pipeline-idle fragment resolves to `--stone` (add an explicit color if it currently
      inherits `--ink` instead).

## 5. Test cases

Activity: one unit for the true-empty render (no entries at all, `filterActive: false`) asserting
`emptyState()`'s hero markup + copy — a regression guard that also confirms the filtered-to-zero
branch (`filterActive: true`) is untouched by this change. Agents hub: one assertion per sub-panel
(Librarians/Schedules/Researchers) that the empty-state render uses `.viz-empty--compact` and
preserves the exact existing copy string (a regression guard against an accidental copy change
during componentization). Today's idle fragment: a computed-style check (or visual DL-1
spot-check) that the color resolves to `--stone`.

## 6. Changelog

- 2026-07-13 — created (draft). Dispatched to KB-Design-Lead-2 in `#wave2-brand-identity` as the
  natural continuation of the #523 About-panel re-token work. Audit against `origin/main` (not a
  stale local checkout) found About/first-run/the shared primitive already fully built — narrowed
  scope to the four surfaces still using ad-hoc plain-text empty states (Activity ×2, Agents-hub
  ×3) plus two small polish items.
- 2026-07-13 — **GATE 1 (KB-AI-Detector): APPROVED.** Cited as disciplined scoping (correctly
  protected the Ask seal + Health affirmation as sanctioned exceptions rather than homogenizing
  them) and correct hero/compact variant assignment matching existing precedent exactly. Routed to
  KB-Quality-Driver-2 for GATE 2.
- 2026-07-13 — **GATE 2 (KB-Quality-Driver-2): REJECTED**, correctly. Two of the four claimed gaps
  didn't match `origin/main` — Activity's filtered-to-zero state and Explore's inline graph text
  were both already fully built (verified directly, not asserted). Root cause: this draft trusted
  an Explore-subagent's research report on those two items without independently re-verifying
  against `origin/main` myself, unlike the other citations in this spec (which were checked
  directly and one stale-checkout discrepancy — the first-run setup screen — was already caught
  and corrected before this draft). §1/§2/§4/§5 revised: moved both corrected items into §1's
  "already done" list, narrowed Activity's fix to the true-empty case only, updated ACs/tests to
  match. Re-requesting both gates on the corrected scope.
