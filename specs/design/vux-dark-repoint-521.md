---
design: VUX-DARK
implements: SPEC-0060
title: Dark re-point — the 18 v3 color tokens + hex-to-token conversion
type: design
status: draft
owners: [KB-Design-Lead-2, Principal]
created: 2026-07-12
updated: 2026-07-12
related: [SPEC-0060, SPEC-0057, "issue #521"]
gates:
  ai-patterns: pending      # GATE 1 — KB-AI-Detector
  boundaries: not-yet-routed # GATE 2 — KB-QD, routed at dispatch
---

# Dark re-point — v3 color tokens

> Wave-2 pre-stage for issue **#521** (P1, funded per the 2026-07-05 ruling). Closes the
> "half-dark patchwork" gap: Settings ships a working Light/Dark toggle, but the ~18 unprefixed
> v3 color tokens (`design-system.css:319-323`) have no `[data-theme='dark']` block, so every v3
> view still renders light-literal cards inside dark chrome the moment a user flips the toggle.

## 1. Intent

SPEC-0060 deferred dark ("night-study variant... a parallel pass off the new language, not this
cut," §2/§9) at v3's creation. The instrument layer (`--viz-*`) already forked a full,
brand-approved dark palette (`design-system.css:94-117`, brand/DARK-MODE-ADDENDUM.md). The v3
tokens are **literal copies of that same palette under new unprefixed names** (`design-system.css`
comment, line 315: "Values are identical to the warm `--viz-*` set... kept literal so the v3 layer
stands on its own"). Re-pointing dark is not a new design pass — it is **finishing a re-point that
already happened once**, plus deriving dark values for the handful of v3-only tokens that have no
`--viz-*` counterpart.

## 2. The token table (design decision — the color of record)

**Recommended implementation shape:** don't hand-duplicate a second dark palette. Everywhere a v3
token has a direct `--viz-*` counterpart, **alias it** (`--vellum: var(--viz-field);` etc. inside
the existing `:root` block, no new selector needed) — dark then falls out for free from the
`--viz-*` re-point that already exists at line 94. This is the DRY fix and prevents the two
palettes drifting again. For the four v3-only tokens with no `--viz-*` twin (`--parchment`,
`--ink-2`, `--gold-deep`, `--viridian-2`), add one new `:root[data-theme='dark']` block with the
literal values below (derived, not guessed — rationale per row).

| Token | Light (current) | Dark (spec) | Source / rationale |
|---|---|---|---|
| `--vellum` | `#f4efe3` | `#15242e` | = `--viz-field` (alias) |
| `--linen` | `#fbf7ec` | `#1e3340` | = `--viz-panel` (alias) |
| `--parchment` | `#ece4d2` | `#172631` | **New.** Light `--parchment` reads as a *recessed* fill inside a linen card (skeleton shimmer, chat bubbles, activity-event rows, segmented-control track) — one step **darker** than the ground, not lighter. On dark, "recessed within panel" means one step darker than `--viz-field` itself: `#172631`. Keeps the inset read (bubbles/skeletons/segment tracks sink, they don't float). |
| `--viridian` | `#2f6b5b` | `#4e9e86` | = `--viz-patina` (alias) |
| `--viridian-2` | `#3e9e82` | `#5bc09c` | **New.** Light `--viridian-2` is numerically identical to `--sprout` (`#3e9e82`) — same hue wears two names (CTA gradient vs. state). Preserve that identity on dark: alias to `--viz-sprout`'s dark value, `#5bc09c`. |
| `--deep` | `#1e3557` | `#1c3441` | = `--viz-deep` (alias) |
| `--slate` | `#3a6e88` | `#5e93b4` | = `--viz-accent` (alias) |
| `--mist` | `#bfd7e6` | `#5e93b4` | = `--viz-mist` (alias) |
| `--gold` | `#c9a35a` | `#c9a35a` | = `--viz-brass` (alias, unchanged — rationing is *stricter* on dark, not the hue) |
| `--gold-deep` | `#a8823c` | `#d9b872` | **New.** Light `--gold-deep` exists because bare `--gold` fails AA for small text/icons on cream, so it's a darker, more-saturated stand-in wherever gold needs to carry text/glyph contrast (topsearch icon, kicker labels, caution glyphs). On dark the failure mode inverts — a *darkened* gold is what would disappear against a near-black panel — so `--gold-deep` must **lift**, not deepen. `#d9b872` is `--gold` lightened toward `--parchment`'s dark value; verify ≥ 4.5:1 against `--viz-panel` (#1e3340) before shipping (DL-1 dark sweep, §4). |
| `--sprout` | `#3e9e82` | `#5bc09c` | = `--viz-sprout` (alias) |
| `--ember` | `#c8743c` | `#c8743c` | = `--viz-ember` (alias, unchanged — decision-only, reserved; "glows harder on dark" per the viz comment, no change needed) |
| `--oxide` | `#a8432a` | `#cf5238` | = `--viz-oxide` (alias) |
| `--ink` | `#2b2f36` | `#ece4d2` | = `--viz-ink` (alias) |
| `--ink-2` | `#4a4e55` | `#c9c2b0` | **New.** Light `--ink-2` sits between `--ink` and `--stone` (secondary headings, review-detail prose, job descriptions — stronger than a caption, lighter than a heading). Dark counterpart sits the same relative distance between `--viz-ink` dark (`#ece4d2`) and `--viz-ink-muted` dark (`#93a39e`): `#c9c2b0`. |
| `--stone` | `#6a6456` | `#93a39e` | = `--viz-ink-muted` (alias) |
| `--faint` | `#9a927e` | *(see §3 — coordinated with #524)* | Do not freeze this value yet — issue #524 (v3 conformance batch) is separately bumping `--faint`'s *light* small-text usage sites off this token for an AA failure. Land #524's disposition first (or in the same PR if sequenced together), then derive dark from whatever light value survives. |
| `--hair` | `#e0d6be` | `#2e4350` | = `--viz-rule` (alias) |

Shadows, radii, and easings (`--shadow-card/-raise/-win`, `--ring`, `--r-*`, `--e-*`, `--t`) **stay
shared, no dark variant** — alias the shadow/ring tokens to their `--viz-shadow-*` / `--viz-ring`
equivalents (which already re-point under dark, `design-system.css:112-116`) rather than
duplicating literal dark shadow values a second time. Radii and easings are geometry/timing, not
color — genuinely identical in both themes, per the issue's own scoping.

## 3. Dependency on #524 (`--faint` contrast)

Issue #524 flags `--faint` (#9a927e on linen, ≈2.8:1) as already failing AA for sub-0.8rem text in
**light** mode — timestamps, `.ask-hint`, `.ask-pastmeta`, `kbd`. This spec's companion doc
(`vux-v3-conformance-524.md` §3) rules: reassign those four small-text sites to `--stone`, and
narrow `--faint` to large-text/decorative/icon uses only (where AA's large-text 3:1 floor applies
and `--faint` already clears it). **Sequencing:** either land #524's `--faint` disposition before
this dark re-point locks its `--faint` dark value, or land both in the same PR — don't derive a
dark `--faint` against a light value that's about to move.

## 4. Hex-literal → token conversion (the "survival patch" sweep)

Ten call sites hard-code a v3 color as a literal hex instead of a token, so they can't inherit the
re-point above. Convert each to the token (or a `color-mix` where the literal is a tint/shade of a
token, not the token itself) — this is what makes the alias-based re-point actually reach every
surface:

| Site | Current | Fix |
|---|---|---|
| `index.css:256` (top-bar gradient) | `linear-gradient(180deg, #f3ead6, #e9dec6)` | `linear-gradient(180deg, var(--linen), var(--parchment))` |
| `index.css:318` (rail gradient) | `linear-gradient(160deg, #f0e7d3, #e7dcc3)` | `linear-gradient(160deg, var(--linen), var(--parchment))` |
| `index.css:288` (`.user` card bg) | `#fbf6ea` | `var(--linen)` |
| `index.css:179-180` (`.capture-submit` hover) | `#2a5f50` | `color-mix(in srgb, var(--viridian) 82%, black)` — keep the darkened-on-hover read, but derive it from the token so dark re-points automatically |
| `index.css:278` (quickadd border) | `#296253` | `color-mix(in srgb, var(--viridian) 78%, black)` |
| `index.css:883` (`.exp-center-disc` fill) | `#23553f` | `color-mix(in srgb, var(--viridian) 88%, black)` |
| `index.css:884` (dark override, now redundant) | `fill: #1e4a39` | **delete** — the light rule now re-points itself via the `--viridian` alias; no separate dark override needed |
| `index.css:885` (`.exp-center-lattice` stroke) | `#e6ce86` | `color-mix(in srgb, var(--gold) 70%, white)` |
| `index.css:998` (`.ag-av` avatar gradient) | `radial-gradient(circle at 40% 35%, var(--viridian-2), #1e5443)` | `radial-gradient(circle at 40% 35%, var(--viridian-2), color-mix(in srgb, var(--viridian) 70%, black))` |
| `index.css:527-528` (`.review-confirm` + hover) | `#f6f2e6` text, `#2a5f50` hover bg | text → `var(--linen)`; hover bg → same `color-mix` as `.capture-submit` above (identical component, keep it identical) |
| `index.css:1389` (flow-strip panel gradient) | `linear-gradient(180deg, #fcf8ef, var(--linen))` | `linear-gradient(180deg, color-mix(in srgb, var(--linen) 90%, white), var(--linen))` |

Once these land, delete the `index.css:296-307` "dark SURVIVAL for the new v3 chrome" comment
block and its four overrides (`.bar`, `.topsearch`, `.topsearch:hover`, `.topsearch .kbd`,
`.topchip`, `.user`, `.user-id b`) — they exist *only* because the v3 tokens they reference
(`--linen`, `--hair`) had no dark values; once §2's alias lands, those selectors already use
`var(--linen)`/`var(--hair)` and inherit dark for free. Grep for the enumerated hex literals above
should return 0 hits in view-reachable CSS (issue's own AC).

## 5. Acceptance criteria

- [ ] Flipping Dark yields no light-literal card/pill/input on any rail view (DL-1 dark sweep,
      one screenshot pass per view against the light baseline).
- [ ] `themeCohesion.test` extended to assert a dark counterpart exists for every v3 color token
      in §2's table (fails loudly if a future token ships light-only again).
- [ ] No `prefers-color-scheme` on bare `:root` (standing repo rule — `data-theme` only).
- [ ] The ten hand-hex survival-patch sites in §4 are gone; the four dark-only override lines
      (296-307, 884) are deleted, not just superseded.
- [ ] `--gold-deep` dark (`#d9b872`) measured ≥4.5:1 against `--viz-panel` dark (#1e3340) before
      merge — flag here if it needs adjusting; this is the one row in §2 without a shipped
      precedent to copy.
- [ ] `--faint`'s dark value is NOT hand-picked ahead of #524's light-mode disposition (§3).

## 6. Test cases

`themeCohesion` extension per §5; one DL-1 dark-mode walkthrough capture per view, diffed against
the existing light-mode capture set (the e2e walkthrough already captures dark per the issue, so
this is confirming coverage, not building new harness).

## 7. Changelog

- 2026-07-12 — created (draft). Pre-staged in `#wave2-ux-prep` while wave-1 is in flight (issue
  #521). Full 18-token dark table derived from the existing `--viz-*` dark palette
  (`design-system.css:94-117`) via alias, plus new literal derivations for the four v3-only tokens
  (`--parchment`, `--ink-2`, `--gold-deep`, `--viridian-2`) with rationale per row. Ten hex-literal
  survival-patch sites enumerated with concrete token/`color-mix` fixes. Flags the `--faint`
  sequencing dependency on #524. Awaiting GATE 1 (KB-AI-Detector).
