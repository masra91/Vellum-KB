---
design: VUX-CONFORM
implements: SPEC-0060
title: v3 conformance batch — Activity controls, uppercase de-drift, --faint AA fix, VUX-17 disposition
type: design
status: draft
owners: [KB-Design-Lead-2, KB-Lead, Principal]
created: 2026-07-12
updated: 2026-07-12
related: [SPEC-0060, "design-prototypes/vellum-v3.html", "issue #524"]
gates:
  ai-patterns: approved     # GATE 1 — KB-AI-Detector, 2026-07-13 (PR #535)
  boundaries: not-yet-routed # GATE 2 — KB-QD, routed at dispatch
---

# v3 conformance batch

> Wave-2 pre-stage for issue **#524** (P2 — scheduled behind P0/P1). Four residual gaps between the
> shipped v3 views and the `vellum-v3.html` prototype, plus one standing "must" (VUX-17) that's
> unmet and needs an explicit disposition, not silent drift.

## 1. Intent

Unlike #521-523, three of this batch's four items are **already fully designed** — the prototype
built them; the shipped view just didn't migrate onto them. This spec's job is mostly to **cite the
existing mock precisely** so an executor implements against a real reference instead of
re-deriving, plus resolve the one genuinely open call (VUX-17, §4).

## 2. Activity controls + empty state — cite the mock, don't reinvent

`activityView.ts:193-224` ships bare `.viz-field` inputs with uppercase `viz-signage` labels
("Filter" / "search" / "trace") and a plain-paragraph empty state. The mock already built the
target (`vellum-v3.html:847-917, 928`) — implement against it directly:

- **Search** → `.act-search` (`vellum-v3.html:848-850,914`): an icon + input pill on `var(--linen)`,
  `var(--hair)` border, `var(--r-chip)` radius, a clear button that only appears once there's a
  value (`.has-val .act-search__clear`). Replace the bare `viz-field` search input with this.
- **Filter** → `.act-filter` (`:915`): icon + `<select>` + chevron, options driven by the existing
  stage/agent list, default option reading **"All activity"** (already correct per terminology.md
  §5 — "Sources" is retired as a surface name; don't let a filter option resurrect it as a noun).
- **Empty state** → `.act-empty` (`:880-883,928`): centered glyph (`var(--gold)`, muted), a bold
  **named-term** headline ("Nothing matches *obsidian*" — the search term interpolated, not a
  generic "No results"), a one-line explanation, and a **"Clear filters"** reset button. This
  directly satisfies VUX-14's "search hits visible summary; descriptive" bar, which the current
  plain-paragraph state doesn't.
- **Trace lookup** (`activityTraceId`/`activityTraceGo`) has no mock equivalent — it's real,
  shipped functionality the prototype didn't model. Keep it, but move it out of the three-field row
  it currently shares with search/filter (that row is what the mock replaces) into its own
  secondary control, so the primary search/filter band matches the mock exactly and trace reads as
  the power-user affordance it is, not a fourth peer control crowding the band.

## 3. Uppercase de-drift — a systemic fix, not per-site overrides

**Root cause, not just symptom:** the shared `.viz-btn` primitive's uppercase (`design-system.css:180`)
is *correct* there — it's the documented instrument-language tell for Researchers/Jobs/Field Desk
(`_design-system.md` §3: "uppercase signage caps... is the instrument tell"). The drift is that v3
warm-vellum surfaces (Today, Reviews, Ask, Activity) also reach for the bare `.viz-btn` class and
then have to hand-override `text-transform: none` per call site (`.capture-submit`,
`.review-confirm.viz-btn`, `.review-reject.viz-btn` all do this already) — some sites forgot to
(Activity's `.activity-trace-go` / `.load-retry` didn't), so they render uppercase.

**Fix:** add one shared v3 pill-button class (e.g. `.v3-btn`, sentence-case, `var(--r-pill)`,
`var(--viridian)` primary / ghost variants — literally `.capture-submit`'s recipe promoted to a
name) and switch every v3-surface button currently borrowing bare `.viz-btn` onto it. This stops
the override-scatter pattern instead of adding one more override:

- `activityView.ts` — `.activity-trace-go`, `.load-retry` (currently plain `.viz-btn.viz-btn--sm`,
  no override — these are the ones actually shipping uppercase today).
- Today's decision-card title and health-row title (`todayView.ts:203,217`) — these aren't buttons,
  they're a bare `<b class="viz-signage">` wrapping a card title, which inherits `.viz-signage`'s
  uppercase (`design-system.css:120`) unconditionally. Drop `viz-signage` from the title element
  entirely (use `var(--voice)` or plain `var(--ui)` weight-600, matching how the mock's card titles
  read) — a card title is not signage.

**Explicitly keep uppercase** on the established eyebrow/kicker/stat-key pattern — this is the
"mock is sentence-case except eyebrows/stat-keys" carve-out the issue itself names, and it's
already used correctly and consistently: `.capture-eyebrow`, `.review-kicker`, `.ask-refs-h`,
`.review-candidate-name` (a small-caps section label above the actual title, not the title itself).
Don't flatten these — the eyebrow/title contrast (small uppercase label + larger sentence-case
title beneath it) is a real, deliberate typographic hierarchy, not drift.

## 4. `--faint` AA contrast

`--faint` (#9a927e on `--linen`/`--vellum`, ≈2.8:1) is used below AA on four sub-0.8rem sites:
timestamps (`index.css:1356-1361`), `.ask-hint` (`:696`), `.ask-pastmeta` (`:595`), `kbd`
(`:269`).

**Decision: reassign the four small-text sites to `--stone`, don't change `--faint`'s hex.**
`--faint` is legitimately used elsewhere for large-text/decorative/icon roles where AA's 3:1
large-text floor already clears (section glyphs, watermarks, placeholder text ≥1rem) — mutating the
token's value to fix four sites would needlessly re-tune everything else that already reads
correctly. Codify the boundary going forward: **`--faint` is decorative/large-only; any sub-1rem
text uses `--stone`.** This mirrors the existing state-hue contrast contract (`_design-system.md`
§2 — small text never carries a hue that fails AA at that size) applied to a neutral tone, not just
state hues.

This decision feeds `vux-dark-repoint-521.md` §2/§3 — that spec intentionally left `--faint`'s dark
value undefined pending this call; now that `--faint` keeps its current hex and role, its dark
counterpart is derived the normal way (no `--viz-*` twin exists for it, so it needs its own dark
literal — flagged back to that spec, not re-derived here to avoid two specs disagreeing on one
token).

## 5. VUX-17 — Agents drill-in disposition

**RESOLVED 2026-07-13 — SCHEDULED (not de-scoped).** PM approved this recommendation in
`#wave2-ux-prep`, standing in for KB-Lead sign-off per the issue's acceptance bar ("VUX-17 has an
explicit disposition — scheduled slice or spec de-scope with KB-Lead sign-off"). §5 below is the
approved sequencing; #524 is clear on this front.

**My recommendation: schedule it, don't de-scope.** The mock already fully specifies the drill-in
— a quiet chevron cue in the card head (`.ag-drill`, `vellum-v3.html:1048-1050`), wired so every
agent card (Librarian/Schedule/Researcher) is clickable and drills into a detail view
(`:1158-1161`). This isn't a gap in *design* — SPEC-0060 §6/§8 already called it a "must," the
prototype already built it, and the reason it's unshipped is a backend dependency (the issue notes
it "needs the run-history store SPEC-0061 flags" — the humanized past-runs timeline needs queryable
run history that SPEC-0061 T1's SQLite/FTS index (wave-1 #530) is landing now). De-scoping a
*designed and prototyped* requirement because its richest data source is mid-flight would be
walking back a ratified decision, not right-sizing scope.

**Approved sequencing (confirmed 2026-07-13):**
1. **Ship the drill-in shell now**, matching the mock exactly: the chevron cue, the click target,
   and a detail view showing identity + current config (schedule cadence, autonomy, clearance —
   data that already exists per-agent today, no new store needed).
2. **Backfill the past-runs timeline** as a fast-follow once SPEC-0061 T1 lands (wave-1 #530) and
   run history is queryable — the detail view's timeline section shows a calm "history not
   available yet" placeholder in the interim, not a broken/empty look.

This satisfies VUX-17's "must" (every agent drills in, with a visible cue) on wave-2's own
timeline, without hard-blocking the rest of #524 on a separate spine's completion.

## 6. View-swap announcements (aria-live)

No mock precedent (a static prototype can't demo screen-reader behavior), so this is a straight
a11y requirement: add one `aria-live="polite"` region in the shell, updated with "{View name} view"
on every route change. This mirrors the pattern already established for ConfirmInline
(`_design-system.md` §5 — "inline variant is an `aria-live='polite'` region") — reuse that
convention rather than inventing a second live-region pattern.

## 7. Acceptance criteria

- [ ] Activity's search-to-zero state shows the designed `.act-empty` naming the search term, with
      a working "Clear filters" reset; controls match the mock's `.act-search`/`.act-filter` band.
- [ ] No `text-transform: uppercase` on any v3 card title (Today decision, health-row) or any
      button rendered on a v3 warm surface (Activity trace/retry included). Eyebrow/kicker labels
      keep their uppercase deliberately (§3) — verify the distinction is preserved, not flattened.
- [ ] `--faint` no longer appears on any sub-1rem text node; the four named sites (§4) use `--stone`.
- [x] VUX-17 carries an explicit, confirmed disposition (§5 — SCHEDULED, PM sign-off 2026-07-13).
- [ ] View changes are announced via one shared `aria-live="polite"` region (§6), not a screen-reader
      trap or silence.

## 8. Test cases

Activity: a search-to-zero-results unit asserting the empty state renders with the interpolated
term and a working reset. Today/Activity: a snapshot or class assertion confirming no
`text-transform: uppercase` computed style on card titles/buttons on v3 surfaces (regression guard
so a future PR can't quietly reintroduce it). `--faint` usage: a grep-based lint (or extend
`themeCohesion`) asserting `--faint` doesn't appear in any rule also setting `font-size` below
`1rem`. VUX-17: now that disposition is confirmed (§5), a per-agent-card test asserting the drill
cue is present and the click target navigates to the detail view. **View-swap announcements (§6):**
a test asserting the shared `aria-live="polite"` region's text content updates to "{View name} view"
on each route change — this is its own §7 AC item and needs its own assertion, not just a visual
check that the region exists.

## 9. Changelog

- 2026-07-12 — created (draft). Pre-staged in `#wave2-ux-prep` while wave-1 is in flight (issue
  #524). Activity controls/empty-state spec'd directly against the existing
  `vellum-v3.html` mock (no new design needed, just precise citation). Diagnosed the uppercase
  drift's actual root cause (`.viz-btn`'s instrument-correct default reused unmodified on v3
  surfaces) and proposed a shared `.v3-btn` sentence-case pill class instead of more scattered
  overrides; explicitly preserved the eyebrow/kicker uppercase carve-out. Ruled `--faint`'s AA fix
  as a usage-boundary correction (reassign 4 sites to `--stone`), not a token-value change — feeds
  back into #521's dark-repoint sequencing. **Recommended VUX-17 be scheduled (drill-in shell now,
  history timeline as a SPEC-0061-T1 fast-follow), not de-scoped** — flagged to KB-Lead for the
  sign-off the issue's own AC requires. Awaiting GATE 1 (KB-AI-Detector).
