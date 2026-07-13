---
design: DESIGN-SHELL-CHROME
implements: SPEC-0060
title: Shell Chrome & Motion — Top Bar (VUX-3) + Loading & Motion System (VUX-6)
type: design
status: draft   # awaiting SPEC-0033 gates: GATE 1 (AI-Detector / distinctiveness) + GATE 2 (KB-QD / flow coverage)
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-07-13
updated: 2026-07-13
related: [SPEC-0060, _design-system, terminology, deep-review-0712]
gates:
  ai-patterns: pending      # GATE 1 — KB-AI-Detector (distinctiveness) — shell-level, visible everywhere
  qa-flow-coverage: pending # GATE 2 — KB-Quality-Driver-2 (shadowing #wave1-shell-ux)
stage: Shell
---

# Shell Chrome & Motion — Top Bar (VUX-3) + Loading & Motion System (VUX-6)

> Design spec for GH **#519** (top bar) and **#520** (loading & motion system), the two P0s dispatched
> to `#wave1-shell-ux` (KB-Developer-7, paired with KB-Design-Lead). Both are **shell-level chrome** —
> they render on every view, every load, every action — so they get one interaction/motion pass before
> code, per the Deep Review 2026-07-12 findings (`02-usability.md` UX-1 through UX-11). This spec covers
> **only** the two issues' scope: making the top bar a real control, and unifying loading/motion into one
> system. It does not touch view-internal layout beyond the context-filler slot contents.
>
> **Grounding.** All code citations below were verified against the current tree
> (`app/src/index.css`, `app/src/shell/*.ts`, `app/src/main.ts`) on 2026-07-13, not just the issue text —
> two corrections from the issue reports are flagged inline (§1 window-file path, §2 duplicate-token count).

## 0. Color & lexicon law (binding, carried forward)

Both surfaces are built entirely on the **existing v3 token set** (`app/src/shell/design-system.css:318-335`
— `--vellum/--linen/--parchment/--viridian/--viridian-2/--deep/--slate/--mist/--gold/--gold-deep/--sprout/
--ember/--oxide/--ink/--ink-2/--stone/--faint/--hair`). No new colors are introduced by this spec.

- **`--ember`** = decision-only (Reviews' "needs your decision" wash, `index.css:500-513`). Neither the
  top bar nor any loading/motion primitive may use ember — a search bar and a skeleton are not decisions.
- **`--slate`** = interactive (already used for the Reviews "why this matters" disclosure toggle,
  `index.css:517`). The ⌘K results list and any clickable context chip read in slate on hover/active, not
  a repurposed viridian or a new blue.
- **`--sprout`** = active/in-progress (already the busy-button color in `design-system.css:210`,
  `.viz-btn--busy`). This spec's busy-button state (§4) reuses that exact mapping — sprout, not ember,
  not a spinner.
- **`--gold` / `--gold-deep`** = rationed — already spent on the brand diamond stroke (`shell.ts:42-45`),
  the search/chip glyphs (`index.css:267,274`), and the Reviews kicker (`index.css:512`). This spec adds
  **zero** new gold usage; the warming face (§5) and skeletons (§3) stay achromatic (parchment/hair), not
  gold, so gold keeps reading as a deliberate, rare accent and not ambient decoration.
- **`--oxide`** = error only. The error face (§5) is the only place either issue touches oxide.
- **Lexicon** (`terminology.md`): "library" not "KB"/"vault"; stage names per §1; no new synonyms. The
  warming copy in §5 replaces "knowledge graph" with **"library"** per the §0 Library ruling — a live
  drift the code carries today (`loadGuard.ts:109`: *"Still preparing your knowledge graph"*) that this
  spec's rewrite fixes as part of the mechanical adoption, not a separate cleanup PR.

---

## PART A — #519: The top bar (VUX-3)

### 1. The problem, restated as a design brief

The bar is currently a facade dressed as a control: `.topsearch` is a `<button>` styled `cursor: text`
(`index.css:259-264`) that only ever calls `.focus()` (`shell.ts:192`) — there is no `<input>` to type
into, so ⌘K "focusing" a button does nothing observable, and Enter has no handler at all. The per-view
slot exists in markup (`shell.ts:55`, `.topctx`/`#topctx`) and has a clean event seam already built
(`nav.ts:33` `setTopbarContext`), but **zero views call it** — every view resets to the mock's intent
(`design-prototypes/vellum-v3.html:1301-1304`) never materializing. And the window itself ships a bare
`BrowserWindow({ width: 880, height: 660, webPreferences: {...} })` with no `titleBarStyle`
(`app/src/main.ts:26-32` — **correction to the issue's `main.ts:26-31` citation: the file is
`app/src/main.ts`, not `app/src/main/main.ts`**), so macOS draws its own native title bar directly above
the themed `.bar` — two toolbars stacked, not one.

The fix is not a redesign — the mock and the CSS scaffolding already say the right thing. The fix is
**wiring**: give the search a real input surface, give every rail view a context filler, and collapse
the window chrome to one band. This section specs the three pieces precisely enough that KB-Developer-7
can implement without more design back-and-forth.

### 2. Search: a real input + a minimal results overlay

**Replace, don't restyle.** Swap `<button id="globalSearch">` for a real `<input type="text">` carrying
the same `.topsearch` class and visual contents (search glyph, placeholder, `⌘K` kbd hint) — the CSS at
`index.css:259-269` already targets `.topsearch` generically enough to survive the tag change (`cursor:
text` becomes literal instead of aspirational; `appearance: none` already anticipates an input).

- **Placeholder → live value.** `<span class="ts-ph">Search entities, claims, sources…</span>` becomes
  the input's native `placeholder` attribute (same copy) — the kbd hint (`.kbd`⌘K) stays a sibling
  `<span>`, absolutely positioned or flex-ordered last exactly as today, and hides via `visibility:hidden`
  (not removed) once the field has a value, so the hint doesn't collide with typed text.
- **⌘K still focuses it** (`shell.ts:195-200` logic is unchanged, just now focuses a real field — select
  any existing text on focus via `.select()` so a repeat ⌘K re-summons for a fresh query, command-palette
  convention).
- **The results overlay — v1 scope, matching the AC's "Enter does something observable."** On keystroke
  (debounced ~150ms, reuse the debounce pattern already in `activityView.ts` search — do not invent a
  second one), do an **entity-name prefix match over the Explore projection** (per the issue's suggested
  approach — this is the only backend the AC requires for v1). Render a `role="listbox"` panel anchored
  directly under `.topsearch`, same `.topsearch` visual family (linen ground, hair border, `var(--r-chip)`
  corners) — **not** a new card/dropdown shape. Each result is a `role="option"` row: entity name (ink,
  body face) + entity type as a trailing `--stone` caption. Arrow keys move `aria-activedescendant`
  through options; **Enter navigates to Explore focused on that entity** (`navigateTo('explore')` per
  `nav.ts:15`, carrying the entity id — Explore's mount reads it the same way a deep-link from Reviews
  already does). Escape closes the overlay and returns focus to the input without clearing it.
- **Empty-query / no-match state:** no overlay renders on an empty field (nothing to show); a query with
  no matches shows one row of `--stone` text, "No matches in your library" (lexicon: library, not KB) —
  never a blank panel hanging open.
- **Interactive, not decorative → slate.** The active/hovered option row background is a very light
  slate wash (`color-mix(in srgb, var(--slate) 8%, var(--linen))` or equivalent low-alpha tint) — this is
  the ONE new visual rule this section adds, and it's the interactive-state law (§0), not a new pattern.
- **If v1 search is descoped instead** (PM/dev call, not mine to force): per the issue, remove the pill
  entirely rather than ship a permanently-dead affordance, and repoint ⌘K to Quick-add
  (`model.select(VIEW_CAPTURE)`, same call already at `shell.ts:190`). Do not ship a fourth intermediate
  state (styled-but-inert) — it's the exact facade this issue exists to remove.

### 3. Per-view context fillers — four call sites, verbatim from the mock

Wire `setTopbarContext(html)` (`nav.ts:33`) at each view's mount, using the mock's own markup
(`design-prototypes/vellum-v3.html:1301-1304`) as the literal source — this content is already
gate-1'd by virtue of being the shipped mock language (`.topchip` class, already styled at
`index.css:273-274`); no new visual is being invented, only wired:

| View | Filler (verbatim from mock) | Mount call site |
| --- | --- | --- |
| Explore | Filter / All types / Confidence ≥ 0.6 chips (`vellum-v3.html:1301`) | `exploreView.ts` mount, after its own filter-chip state initializes (chips reflect *current* filter state, not static) |
| Activity | "All activity" chip (`vellum-v3.html:1302`) | `activityView.ts` mount |
| Health | "Re-scan" chip — this one is actionable, not a filter: clicking it triggers the same re-scan the view's own control fires (`vellum-v3.html:1303`) | `healthView.ts` mount |
| Agents | "Add a researcher" chip — actionable, opens the same add-researcher flow the hub's own button fires (`vellum-v3.html:1304`) | `agentsHubView.ts` mount |

Every other rail view (Today, Ask, Capture, Reviews, Connectors, Settings) is the **documented empty
list** the AC asks for — the slot stays empty for these (already correct behavior via `shell.ts:177`'s
per-switch clear), because none of them have a mock-specified filler. Do not invent fillers for views
not listed here.

- **Actionable chips (Re-scan, Add-a-researcher) must not silently duplicate state** — they call the
  *same* handler the in-view button already calls (one source of truth), not a second copy of the logic.
- **Filter chips (Explore) reflect live state**, so re-rendering on filter change is the view's job (it
  already owns that state); the top bar slot is a projection of it, not a second store.
- Every filler keeps the `.topchip` glyph-then-label pattern already styled — no bare text chips.

### 4. Window chrome — one band

- `titleBarStyle: 'hiddenInset'` on the `BrowserWindow` constructor (`app/src/main.ts:26-32`), with
  `trafficLightPosition` tuned so the three lights sit **vertically centered** in the 3.1rem `.bar`
  (`index.css:255` — `flex: 0 0 3.1rem`). Compute the offset from that fixed height (traffic lights are
  a fixed ~12px diameter; center = `(3.1rem − 12px)/2` from the top, a small horizontal inset from the
  left matching the bar's existing `padding: 0 0.9rem`).
- `.bar` becomes the drag region: `-webkit-app-region: drag` on `.bar` itself, with `-webkit-app-region:
  no-drag` on `.topsearch`, `.topctx` (and its chip children), and `.quickadd` — the three interactive
  elements already in the bar — so the window remains draggable everywhere else on the band without
  swallowing clicks on those controls.
- Pair with the window's `minWidth` (referenced by the issue as coupled to the clipping issue, #518/
  related — out of this spec's scope beyond noting the two changes land in the same `main.ts` region and
  should be reviewed together, not sequenced to conflict).
- **One chrome band, not two** is the acceptance bar — verify visually (DL-1, §6) that no native title
  bar renders above `.bar` once `hiddenInset` lands.

### 5. Distinctiveness note (for GATE 1)

This section deliberately does **not** invent a new visual language — the entire top-bar fix is *making
the already-approved v3 chrome (mock + `index.css`) actually functional*. The one new pattern (§2's
results overlay) reuses the `.topsearch`/`.topchip` linen-and-hair family and the existing slate
interactive-state law, so it reads as the same instrument, not a bolted-on command-palette widget
(no rounded floating card, no blur backdrop, no indigo highlight row).

---

## PART B — #520: One loading & motion system (VUX-6)

### 6. The problem, restated as a design brief

Reviews already carries the **correct pattern** end-to-end: a shaped skeleton (`index.css:487-498`,
`.rev-skeleton-list`/`.rev-skeleton`/`@keyframes rev-shimmer`) and a live warming/error path via
`loadGuard.ts`. The other **ten** views (`statusView.ts:235`, `settingsView.ts:72`, `sourcesView.ts:40`,
`researchersView.ts:58`, `askView.ts:413`, `activityView.ts:220`, `exploreView.ts:61`, `todayView.ts:47`,
`jobsView.ts:27`, `agentsView.ts:19`) fall back to a bare `Loading…` text node instead of adopting it —
and the shared fallback face they all eventually hit (`loadGuard.ts:renderWarming`/`renderLoadError`,
lines 108-123) is still **legacy v2** chrome (`.card`, `.btn`, and copy that says "knowledge graph"
instead of "library" — a live lexicon drift, §0). Two shimmer keyframes already exist under different
names doing the same job (`rev-shimmer` at `index.css:497`, `askShimmer` at `index.css:667`), and two
identical 0.18s duration tokens exist under different names (`--t` at `design-system.css:334`,
`--viz-dur-quick` at `design-system.css:78`) with no single source of truth. Busy-state feedback is
inconsistent to absent: `captureView.ts`'s "Keep it" button (click handler at `captureView.ts:258`, the
`onCapture` await at `captureView.ts:176-227`) shows **nothing** during its await — a real double-capture
risk — while `.viz-btn--busy` (`design-system.css:210`) already solves exactly this for the older
instrument surfaces. And a resolved Reviews item exits with a synchronous, unanimated `.remove()`
(`reviewsView.ts:365-369`) though the mock specifies a 280ms fade/lift (`vellum-v3.html:702,810`).

This is a **dedupe-and-generalize** job, not a new-primitives job: promote what Reviews already proved,
fix the fallback face to match, and apply the one busy-button rule everywhere an async trigger exists.

### 7. Token consolidation (do this first — everything else depends on it)

One duration scale, defined once, consumed everywhere. `design-system.css` already has the right *values*
scattered under two names each; this is a rename/alias, not new numbers:

| Token (single source of truth) | Value | Replaces / aliases |
| --- | --- | --- |
| `--dur-quick` | `0.18s` | `--viz-dur-quick` (`design-system.css:78`) **and** `--t` (`design-system.css:334`) — same value, one name. Every current consumer of either (`.viz-card--lift`, `.topsearch`, `.quickadd`, `.reviews-v2 li.review`, etc.) repoints to `--dur-quick`; no visual change, since the number is identical. |
| `--dur-state` | `240ms` | Existing `--viz-dur-state` (`design-system.css:58`) — keep the name space consistent; this is the state-change crossfade duration for busy/leaving toggles (§8, §9). |
| `--dur-settle` | `340ms` | The existing `shellFadein` view-enter timing is `0.34s` (`index.css:401-402`) — name it as a token instead of a magic number baked into the keyframe rule, no numeric change. |
| `--dur-breathe` | `1.8s` | Existing `--viz-dur-breathe` (`design-system.css:55`) / the `viz-breathe`/`scale-throttle__dot` `1.8s` literal at `index.css:473` — same consolidation: name once, point both consumers at it. |

**Shimmer:** one keyframe, `@keyframes shimmer` (the `rev-shimmer` definition at `index.css:497` is
already correct and becomes canonical — `askShimmer` at `index.css:667` is deleted and `askView.ts`'s
skeleton repoints to `.skel`/`shimmer` per §8). Background-position sweep values and the 1.5s duration
stay as `rev-shimmer` already has them (that pattern is proven, not being redesigned).

**Reduced-motion:** the code carries **nine separate reduced-motion blocks** today (seven in `index.css`
at lines 206/383/403/498/699-701/831/866, two in `design-system.css` at 306-309/361-363), each resetting
one local animation. This spec does not mandate physically merging them into one CSS rule (a `.viz-surface
*` global reset already covers the design-system.css side, and the `index.css` side is per-feature-scoped
CSS that a dev may or may not want to consolidate mechanically) — but it DOES mandate that **every new
selector this spec introduces** (`.skel`, `.is-busy`, `.is-leaving`, `.vmark.loom`/`.churn`) is added to
whichever existing reduced-motion block is topically nearest (skeletons → the `index.css:498` block that
already resets `.rev-skeleton`; busy/leaving → a new shared block near `index.css:403`'s `shellFadein`
reset), not left un-reset. No net-new ninth-plus block; extend the nearest existing one.

### 8. The skeleton primitive

Promote the Reviews shape into a shared, container-shape-agnostic helper (implementation detail:
`paintSkeleton(container, 'cards' | 'rows' | 'prose')` in `loadGuard.ts`, since that's already the shared
view-agnostic module every view imports) — this spec fixes the **visual contract**, not the function
signature:

- **Same anatomy as Reviews today**, generalized: a `.skel` line (`background: linear-gradient(100deg,
  var(--parchment) 30%, rgba(255,255,255,.6) 50%, var(--parchment) 70%); background-size: 220% 100%;
  animation: shimmer 1.5s ease-in-out infinite;`), composed into three shapes matching the three view
  layouts in this codebase:
  - **`cards`** — the Reviews shape verbatim (`index.css:491-496`): a card-shaped skeleton (title line,
    short line, sub-caption line) repeated 2-3× as placeholder rows. Used by views whose loaded content is
    a card list (Sources/Connectors, Agents hub sub-sections, Settings sections).
  - **`rows`** — a flatter single-line-per-row shape (no card border/shadow), for table/list surfaces
    (Activity feed, Jobs/Schedules list).
  - **`prose`** — 3-4 varying-width text lines with no card chrome, for Today's flow-strip and Ask's
    conversation pane cold-start.
- **Law: skeleton on first frame at mount, always** — no view may render bare text (`Loading…` or
  otherwise) even for a single frame; the skeleton shape appears synchronously with the container, before
  the async read starts, not after a check.
- **`aria-busy="true"` on the skeleton's container**, removed when real content replaces it — this is the
  AC's accessibility bar, not optional polish.
- **>3s → the warming face** (§9) replaces the skeleton, not stacks with it, per `loadGuard.ts`'s existing
  `WARMING_AFTER_MS` (`loadGuard.ts:22`, already 3000 — no change to the constant, just now every view
  routes through it instead of some views bare-`Loading…`ing past it).
- **The Agents hub triple-stack** (`agentsHubView.ts:61-65`, three concurrent `Promise.all` sub-mounts)
  gets three independent `cards`-shape skeletons, one per sub-section (Librarians / Schedules /
  Researchers) — each resolves and replaces its own skeleton independently; they are not gated on each
  other (a fast sub-section shouldn't wait on a slow sibling to stop looking loading).

### 9. Warming & error faces — restyled to v3, lexicon-fixed

`loadGuard.ts:renderWarming`/`renderLoadError` (lines 108-123) are the shared fallback every view already
routes through (correct architecture, wrong skin). Restyle both, in place, to v3:

- **Ground:** `var(--linen)` card, `var(--hair)` border, `var(--r-card)` radius — matching every other
  v3 card (`index.css:438-444` is the reference rule), not the legacy `.card` these currently use.
- **Warming copy fix (lexicon, §0):** *"Still preparing your knowledge graph — this can take a moment the
  first time on a large library."* → **"Still preparing your library — this can take a moment the first
  time on a large one."** (drop "knowledge graph" entirely; "library" already appears once in the
  sentence, so the second clause references it pronomially rather than repeating the banned term).
- **Warming mark:** the brand-diamond's existing `.is-thinking`/churn state (`shell.ts:37-45,173-176`)
  supplies the "still working" signal — reuse it at small scale next to the warming copy (a mini churn
  glyph), rather than inventing a second loading mark. This is the "`.vmark.loom/.churn` as the only
  working marks" rule from the issue: **loom** = the ambient always-working idle state (already the brand
  diamond's default `is-working`, `shell.ts:41`), **churn** = the brief "something just changed" pulse
  (already `is-thinking`, `shell.ts:174-176`). The warming face's mini-mark is a churn, looping instead of
  timing out at 1100ms, for as long as warming persists.
- **Error face:** oxide reads on the border only (`1px solid var(--oxide)`), copy stays `--ink` (contrast
  contract, §0/`_design-system.md` §2) — "Couldn't load — the app may be busy or still starting up." copy
  is unchanged (no lexicon issue there).
- **Retry button:** becomes the standard v3 Button (whatever the shared button class resolves to on this
  surface — `index.css` doesn't yet have a promoted v3 button primitive the way `design-system.css` does
  for the instrument surfaces; if none exists, use the closest existing v3 action-button treatment rather
  than the legacy `.btn` these currently use — flag this as an open question, §11, since it may reveal a
  missing v3 Button primitive this pair of issues didn't scope to create).

### 10. Busy buttons & exit motion

- **`.is-busy`** — one class, applied to any button firing an async action, for the duration of that
  await: label stays legible, border/label take **`--sprout`** (§0 — active, not ember/decision) and pulse
  via the existing `viz-breathe` keyframe at `--dur-breathe` (already how `.viz-btn--busy` works,
  `design-system.css:210` — this generalizes that exact rule from the instrument surfaces to the v3 shell
  surfaces, same visual, new consumers). Disable the button (`disabled` attribute, not just visual) while
  `.is-busy` so a second click can't double-fire.
  - **Capture's "Keep it"** (`captureView.ts:258` click handler, `onCapture` await at `176-227`) is the
    headline fix: add `.is-busy` + `disabled` for the duration of the `window.kbApi.capture` await
    (`captureView.ts:201`), removed in the `finally` alongside the existing `setNote(...)` calls
    (`203,211,224`) — this directly closes the double-capture risk the issue names.
  - Health/Settings/Agents controls the issue calls "disable-only" get the same `.is-busy` visual added on
    top of their existing disable (no behavior change, just a within-100ms visible state per the AC).
- **`.is-leaving`** — the exit-motion class for a resolved/removed item: `opacity: 0; transform:
  translateY(-6px) scale(0.99); margin-bottom: -[the item's own bottom margin]` over `--dur-settle`
  (340ms — the mock's own 280ms, rounded to this spec's consolidated settle token rather than kept as a
  fourth one-off number; the visual difference between 280ms and 340ms on a single card exit is not
  perceptible enough to warrant a fifth duration token). The removing code (`reviewsView.ts:365-369`
  today) adds the class, awaits the transition's `transitionend` (or a `setTimeout` matching
  `--dur-settle`, matching the mock's own implementation pattern at `vellum-v3.html:810`), *then* calls
  `.remove()` — never a synchronous removal once this lands. Generalize the same pattern to any other
  view that removes a resolved/dismissed item (Health's per-finding dismiss, per VUX-16 — already shipped
  per-finding affordances that should adopt this exit rather than re-deriving their own).
- **Reduced-motion:** both collapse to instant (busy still reads via the static sprout hue + disabled
  state, no pulse; leaving still removes, no transform/fade) — extend the nearest existing reduced-motion
  block per §7's rule.

### 11. Open questions (flag, don't block)

- **No promoted v3 Button primitive exists yet** in `index.css`'s token family the way `design-system.css`
  has `.viz-btn` for the instrument surfaces (§9's Retry button surfaces this). Out of scope for #519/#520
  to create one from scratch — dev's call whether to reuse the closest existing v3 action-button styling
  (`.quickadd`'s family, scaled down) or flag a follow-up design ticket. Don't block this pair of issues on
  it.
- **Explore's context-filler chips reflecting live filter state** (§3) assumes Explore already has
  addressable filter state to project into the chip labels — if it doesn't yet, wiring "confidence ≥ 0.6"
  as a *static* label until Explore's own filter UI lands is an acceptable interim (still satisfies the
  AC's "fills #topctx" bar), not a blocker.

---

## 12. Test cases (per both issues' AC, for KB-Quality-Driver-2 / dev test authoring)

**#519:**
- Per-view mount test asserting the `kb:topbar-context` (`TOPBAR_CONTEXT_EVENT`, `nav.ts:24`) event fires
  with the four documented fillers on the four named views, and does NOT fire (slot stays empty) on the
  other rail views.
- Keyboard test: ⌘K → input receives focus + selection → type → results overlay renders `role="listbox"`
  → arrow-key moves `aria-activedescendant` → Enter navigates (assert `kb:navigate` dispatch to Explore
  with the entity id).
- DL-1 visual of the bar per view (confirms filler + empty-list views both read correctly).
- Packaged walkthrough screenshot confirming one chrome band (no native title bar above `.bar`) + traffic
  lights vertically centered + window remains draggable.

**#520:**
- Static guard test (themeCohesion-style, per existing convention) asserting `grep '>Loading…<'
  app/src/shell` returns zero matches.
- Per-view test: skeleton shape renders synchronously on mount (before the mocked IPC resolves) with
  `aria-busy="true"`; on resolution, `aria-busy` is removed and real content replaces the skeleton.
- Busy-state test: click an async trigger (fake unresolved promise) → assert `.is-busy` + `disabled`
  within one tick, before the promise resolves — the "click before mocked IPC resolves" case named in the
  issue, applied first to Capture's "Keep it".
- Fake-timer exit-motion test: trigger a resolve/dismiss → assert `.is-leaving` applied → advance fake
  timers past `--dur-settle` → assert `.remove()` fires only after, not synchronously; a parallel
  reduced-motion-branch run of the same test asserts immediate removal.
- Token-dedupe regression: assert `--dur-quick` is defined once and no CSS rule still references
  `--viz-dur-quick` or bare `--t` after the migration (a grep guard, mirroring the `Loading…` guard).

## 13. Changelog

- 2026-07-13 — created. Design pass for #519 (top bar) + #520 (loading & motion system), dispatched via
  `#wave1-shell-ux` (KB-Project-Manager, paired KB-Developer-7 + KB-Design-Lead), ahead of implementation
  per PM's explicit request. Grounded in current-tree citations (not just issue text); two corrections
  noted (`main.ts` path, actual reduced-motion-block count). Routing to KB-AI-Detector for GATE 1 before
  KB-Developer-7 begins implementation.
