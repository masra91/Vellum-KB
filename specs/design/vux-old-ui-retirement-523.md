---
design: VUX-RETIRE
implements: SPEC-0060
title: Old-UI retirement — qcap/setup/permission/About re-token + dead Status cluster deletion
type: design
status: draft
owners: [KB-Design-Lead-2, Principal]
created: 2026-07-12
updated: 2026-07-12
related: [SPEC-0060, SPEC-0038, "specs/design/terminology.md", "issue #523"]
gates:
  ai-patterns: approved     # GATE 1 — KB-AI-Detector, 2026-07-13 (PR #535)
  boundaries: not-yet-routed # GATE 2 — KB-QD, routed at dispatch
---

# Old-UI retirement

> Wave-2 pre-stage for issue **#523** (P1). The Principal's own framing — "places where the old ui
> still shows up." Four surfaces still wear an older visual identity than the rest of the app, plus
> a fully dead 2,467-line CSS/TS cluster still shipping in the bundle.

## 1. Intent

SPEC-0060 rebuilt the ten main views in the warm-vellum v3 language. It did not reach the surfaces
a user touches **before** or **around** the main app — first-run setup, the macOS permission gate,
Settings' watched-folders label, the About panel, and the qcap quick-capture window. Each of those
is a **daily- or first-touch surface**, so a visual seam there reads as loudly as a seam inside the
rail. This spec gives the concrete re-token per surface and — separately — design sign-off to
delete the dead Status cluster (§5), since "is it safe to delete this" is a product/design call
(is Status really retired for good), not just an engineering one.

## 2. Quick Capture (qcap) re-skin

**Decision:** re-skin qcap onto the v3 warm-vellum tokens, **keep its grid/behavior exactly as
built** (SPEC-0038's frameless-window/instant-launch constraints don't change). This is the one
surface in the batch that's already disciplined (`viz-surface`, `viz-btn`, `viz-field`,
`viz-signage`, `viz-chip`, `viz-focusable` — `qcapSheet.ts:38-61`) — the problem isn't sloppiness,
it's that it's disciplined in the **instrument** language while in-app Capture is disciplined in
the **warm** language. Same verb ("capture"), two visual identities.

| Site | Current | v3 target |
|---|---|---|
| `.qcap-sheet` (`qcapSheet.ts:38`, `qcap.css:9-16`) | `viz-surface` (dark-default instrument field) + `viz-sprout` top hairline | `background: var(--vellum)`, `border: 1px solid var(--hair)`, keep the sprout top-hairline (it's the right state semantic — capture is powered/listening — just re-point the color var, don't remove it) |
| `.qcap-mark` label (`:40`) | `viz-signage` (uppercase) | sentence-case "Capture" in `var(--ui)`, `var(--stone)` — matches the v3 uppercase de-drift ruling in the companion #524 spec; don't let qcap re-introduce the uppercase tell this batch is retiring elsewhere |
| `#qcapText` composer (`:55`) | `viz-field viz-field__input--multiline` (boxed instrument input) | the **in-app Capture composer treatment** (`index.css:171`, `.capture-composer` — linen surface, hairline, `var(--r-card)`, `var(--shadow-card)`, lifts + rings on focus-within). This is the actual fix for "two identities" — same composer chrome as the in-app Capture view, not a re-themed instrument field. |
| `#qcapSave` ghost button (`:61`) | `viz-btn viz-btn--ghost` | v3 ghost Button: `var(--stone)` label, no border, `var(--viridian)` on hover — matches `.capture-submit`'s sibling states in the in-app view, not a re-colored instrument ghost |
| Screenshot icon buttons (`:43-45`) | `viz-btn viz-btn--ghost qcap-shot` | keep icon-only + `aria-label`/`title` (already correct — a11y here doesn't change), re-point hover ink to `var(--viridian)` |
| `.qcap-hint` / `.qcap-note` (`:59-60`) | `viz-numeric` (mono, instrument) | keep IBM Plex Mono for the keybinding hint (`⏎ save · ⇧⏎ newline`) — mono is correct here, it's reading as a keycap, not prose; just re-point the color token to `var(--stone)`/`var(--faint)` per state |

## 3. First-run setup (`renderer.ts:44-93`)

This is the **oldest** layer in the batch — pre-v2 generic chrome (`.card`, `.primary`, `.field`,
`class="muted"`), not even the instrument language. Full re-token, not a patch:

- **Container:** `.card` → a v3 linen surface (`background: var(--linen); border: 1px solid
  var(--hair); border-radius: var(--r-card); box-shadow: var(--shadow-card)`), same recipe as
  `.capture-composer` — first-run should look like it belongs to the app it's setting up.
- **`#choose` / `#create` buttons:** `.primary` (generic filled-indigo pill, exactly what SPEC-0033
  killed everywhere else) → the v3 primary Button: `background: var(--viridian)`, `var(--r-pill)`,
  matching `.capture-submit`.
- **`.field` (Name input):** re-token onto the EditableField `text` pattern (`_design-system.md`
  §6) — bottom-rule input, not a boxed generic field.
- **Status markers (`mark()`, lines 44-47):** `✅ / ⚠️ / ❌` colored emoji is a **standing violation**
  of the terminology glossary's own rule ("Status markers are monochrome glyphs, never coloured
  emoji," `terminology.md` §3 / `design-system.css` comment). Replace with a monochrome glyph +
  state hue on the glyph only (text stays ink, per the contrast contract): git-installed / is-repo /
  Copilot-available → `--sprout` check glyph when true, `--gold-deep` caution glyph when
  false-but-recoverable (`warnIfFalse`), `--oxide` glyph only for a genuine blocker (none of the
  current three conditions are — recheck if any should escalate there).
- **Copy (terminology.md §0, exact strings):**
  - `"Set up your Knowledge Base"` → **`"Set up your Library"`**
  - `"It becomes a git-versioned vault you can also open directly in Obsidian"` → keep "vault" here
    — this is the one context where "vault" correctly means the *Obsidian* vault concept, not a
    Library synonym (terminology.md §0's carve-out: "Obsidian vault" is allowed). Reword slightly
    for clarity: **"…a git-versioned folder you can also open directly in Obsidian."**
  - `"This folder already contains a Vellum config"` → fine as-is (no banned term).
  - **Load-bearing pairing:** `renderer.ts:51`'s exact string is asserted verbatim by
    `smoke.e2e.ts:58` — rename both in the **same commit**, or the smoke test breaks on a string
    it no longer finds.

## 4. Permission gate (`permissionGate.ts`)

Full `viz-*` sheet (`.perm-panel.viz-no-chrome`, `.perm-title.viz-signage`, `.perm-body.viz-body`,
`.viz-btn`). Re-token the same way as qcap (§2's table) — this surface is a modal-style gate, not a
composer, so it maps closer to a v3 dialog treatment: `var(--linen)` surface, `var(--hair)` border,
sentence-case (not `viz-signage` uppercase) headings in `var(--voice)`.

**Copy fixes (exact strings):**
- `"Vellum needs access to your vault folder"` → **"Vellum needs access to your library folder"**
- `"Vellum can't reach your vault folder"` → **"Vellum can't reach your library folder"**
- `"Your vault is in iCloud Drive"` → **"Your library is in iCloud Drive"**
- `"Access to ... is turned off"` prose — no other banned terms present.

## 5. Settings (`settingsView.ts:141`, `index.css:413-419`)

- `"Vault path"` label → **`"Library path"`** (matches SPEC-0060 §4's watched-folders-in-Settings
  move and the terminology glossary's §7 "Source"/Library nouns).
- `.settings-v2 .settings dt` uppercase styling (`index.css:413-419`) → sentence-case, `var(--stone)`.
  This is the same uppercase-drift finding as the companion #524 spec (§4 there) — **fix both in
  the same PR if they land together**, or Settings' `dt` labels will visibly disagree with whatever
  #524 does to Activity/Today in the interim.

## 6. About panel (small re-token)

`aboutPanel.css` already uses `--viz-*` tokens throughout (not the oldest layer — it's instrument,
not generic). The fix here is narrow: re-point the prefixed `--viz-*` references to their v3
unprefixed equivalents (`--viz-rule` → `--hair`, `--viz-brass` → `--gold`, `--viz-deep` →
`--deep`/`--viz-field-gradient`) so it's visually and structurally the same v2 instrument look
becoming v3-native, not a redesign.

**Do NOT touch the inverted-text hero** (`about-mark`/`about-wordmark`/`about-tagline` in cream on
the dark gradient hero, `aboutPanel.css:20-30`) — its own file comment marks this as "the one
sanctioned exception to 'body text stays --viz-ink'" (DL-1-approved). An executor re-tokening this
file should re-point the *token names*, not "fix" the hero back to ink-on-cream; that would
regress a decision already made.

**Out of scope, don't conflate:** issue #402 (Vellum motif) and #406 (About panel, deeper pass) are
deliberately backlogged legacy issues, separate from this small re-token. This spec's About-panel
line item is the naming cleanup only.

## 7. Dead Status cluster — design sign-off to delete

SPEC-0060 §4 dissolved Status as a standalone view (ratified 2026-06-28, shipped, IA-locked — "no
standalone Status/'the Line' view"). `statusView.ts` is unreachable and tree-shaken, but its CSS
(`theLine.css`, 558 lines) still ships in the bundle, and `views.ts:42-43` incorrectly claims the
mount is retained.

**Design sign-off: full deletion is correct, no future dependency.** Status is retired product
direction, not a paused feature — there is no roadmap item that resurrects "the Line" as a
standalone view (what's moving lives on Today's flow-strip; diagnostics live in Health, per
SPEC-0060 §4, both already shipped). Delete in one PR:

- `statusView.ts` + `statusView.test.ts` (692 lines)
- `lineMotion.ts` + `lineMotion.test.ts` (138 + 195 lines)
- `theLineModel.test.ts` (280 lines) + the `theLineModel.ts` shim
- `theLine.css` (558 lines)
- the `VIEW_STATUS` constant and its `views.ts` mount claim

**Keep `kb/lineStations.ts`** — Today's flow-strip (SPEC-0060's shipped replacement) calls
`buildStations` from it (`pipeline.ts:840`); this file is live infrastructure, not part of the dead
cluster, despite the naming overlap.

**One verification task for the executor, not a design call:** check whether
`kb/audit.ts:388-424`'s actor strings (e.g. "into the KB") reach any rendered surface. If they do,
scrub per terminology.md §0 (KB→Library); if they're audit-log-internal only, leave them (canonical
ids/actors are explicitly out of the glossary's scope).

## 8. Acceptance criteria

- [ ] No `--viz-*` token remains in `qcap.css` (all re-pointed to v3 unprefixed tokens); qcap
      side-by-side with in-app Capture reads as one product (DL-1 visual check).
- [ ] `renderer.ts`, `permissionGate.ts`, `settingsView.ts` contain zero banned terms
      (`\bKB\b`, generic "vault" outside the Obsidian-vault carve-out) — extend the terminology
      grep-test to cover these three files.
- [ ] `renderer.ts:51` and `smoke.e2e.ts:58` are renamed together in the same commit (verify via
      `git show` on the merge commit, not the working tree — rename-completeness rule).
- [ ] No colored emoji status markers remain in first-run setup; glyphs are monochrome, hue rides
      the glyph only (contrast contract preserved).
- [ ] `git grep -l 'statusView\|theLine\|lineMotion'` → 0 hits. `kb/lineStations.ts` still present
      and still called from `pipeline.ts`.
- [ ] Bundle size drops by the ~700+ CSS lines from the deleted cluster (spot-check, not a hard gate).
- [ ] Smoke e2e green with the renamed first-run heading.

## 9. Test cases

Terminology grep-test extension to the three named files (§8); qcap class assertions (no
`viz-*` prefix survives) via `qcapSheet.test.ts`; build-check + `themeCohesion` (any CSS touch runs
it) + one DL-1 gate pass comparing qcap to in-app Capture side by side.

## 10. Changelog

- 2026-07-12 — created (draft). Pre-staged in `#wave2-ux-prep` while wave-1 is in flight (issue
  #523). Ruled qcap's composer/button re-skin should copy the in-app Capture treatment exactly
  (not a re-colored instrument), preserved the About panel's sanctioned inverted-hero exception
  explicitly so it isn't "fixed" away, and gave explicit design sign-off that the dead Status
  cluster has no future dependency and is safe to delete in full (keeping `lineStations.ts`).
  Flagged the uppercase-`dt` fix should land alongside #524's uppercase de-drift if sequenced
  together.
- 2026-07-13 — **GATE 1 (KB-AI-Detector): APPROVED.** Cited as actively enforcing the anti-generic
  bar (removing the `.primary` filled-indigo pill), not drifting toward it. Dev-ready pending
  GATE 2 (KB-QD) routing at dispatch.
