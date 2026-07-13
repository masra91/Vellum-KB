---
design: DESIGN-LATTICE
implements: SPEC-0057
title: Fractal-Lattice Motif — Reusable Generator + Color-Law Fix (#402)
type: design
status: draft   # §6 is NEW Principal-directed motion work — re-opens GATE 1 for a real (not light) pass
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-07-13
updated: 2026-07-13b
related: [SPEC-0057, _design-system, brand/BRAND-GUIDELINES, brand/DARK-MODE-ADDENDUM]
gates:
  ai-patterns: pending      # GATE 1 — KB-AI-Detector; expect a LIGHT pass, this rides ratified identity
  qa-flow-coverage: pending # GATE 2 — KB-Quality-Driver-2
stage: Brand
---

# Fractal-Lattice Motif — Reusable Generator + Color-Law Fix (#402)

> GH **#402**: "Build the self-similar fractal-lattice motif as a reusable component: nested diamonds →
> luminous center node. Used as the Explore center node (a fractal of the app mark) and as a faint
> drifting node-field texture behind graphs/heroes." Dispatched via `#wave2-brand-identity`.
>
> **Before drafting anything, I audited the current tree against the mock and `BRAND-GUIDELINES.md`
> §2/§5/§6** — the same discipline KB-Quality-Driver-2 had to enforce on the sibling #406 spec this
> morning, after that spec claimed two gaps that were already shipped. I am not repeating that mistake:
> most of what #402 describes **already exists**, in more than one place, at different quality levels.
> This spec documents what's shipped (§1), defines the one real actionable gap — consolidating four
> hand-duplicated inline SVG literals into one shared, parameterized generator (§2) — fixes one concrete
> color-law bug found during the audit (§3), and flags two genuine open questions for the Principal
> rather than resolving them unilaterally (§5), per the dispatch's own invitation to do so.

## 1. What's already shipped (verified against origin/main — don't rebuild)

- **Explore's center node** (`app/src/shell/views/exploreView.ts:268-274`, styled `app/src/index.css:882-887`)
  already has the exact shape the mock/#402 describe: a faint glow ring (`.exp-center-glow`, r40, linen
  @0.4 opacity), a filled gold-stroked disc (`.exp-center-disc`, r32, `#23553f`/`--gold`, with a `dark`
  override at `index.css:884`), a 2-level nested-diamond lattice (`.exp-center-lattice`, a single `path`,
  not polygons), and a center dot. **It is deliberately static — no animation, no keyframe anywhere
  references it.** The code comment is explicit and attributed: *"STATIC center crystalline node
  (Principal: no breathing ring)"* (`exploreView.ts:232-233`). This is a **standing Principal ruling on
  this exact element**, not an oversight — see §5.1 before touching it.
- **The brand diamond's two-signature motion system** (`BRAND_DIAMOND`, `shell.ts:40-45`, styled
  `design-system.css:396-415`) is a fully-built, already-correct realization of BRAND-GUIDELINES §6's
  "ambient drift" + "breathing, not blinking" language: `.dmk.is-working .d-core` runs `dLoom` (2.8s,
  opacity 0.35→1→0.35 + scale 0.6→1.05→0.6 — the continuous "always working" pulse) and
  `.dmk.is-thinking .d-mid` runs `dChurn` (2.6s, a 360° rotate + scale dip — the episodic "just changed"
  flip), both documented in a comment block at `design-system.css:396-408` ("LOOM = continuous work...
  CHURN = episodic thinking"), both reduced-motion-reset. This is good prior art for any future
  work-state motion — reuse the LOOM/CHURN vocabulary, don't invent a third signature.
- **A "faint drifting node-field texture behind graphs/heroes" already exists** — twice — as a soft
  4-stop color-gradient wash (`--viz-field-gradient`, `design-system.css:40` light / `:108` dark),
  animated via the shared `.viz-drift`/`@keyframes viz-drift` utility (`design-system.css:296-297`) at
  either `--viz-dur-drift` (24s) or `--viz-dur-field` (48s): `.explore::before` behind the whole Explore
  view (`index.css:714-718`, opacity 0.045) and `.exp-graph::before` behind the graph specifically
  (`index.css:845-851`, opacity 0.05). `shell/aboutPanel.ts:40` also rides the same `.viz-drift` utility
  on its hero. **Important nuance (see §5.2):** this is a color-gradient wash, not literally
  lattice-shaped — it doesn't carry the fractal geometry itself, just an ambient tint that drifts.
- **The sidebar watermark** (`SIDEBAR_WMARK`, `shell.ts:60-63`, styled `index.css:382-383`) is the one
  place that IS the literal lattice geometry (2-level nested diamond + crosshair lines, matching
  `brand/assets/motif/fractal-lattice.svg`'s construction) rendered as ambient background texture, and it
  **already drifts** (`animation: viz-drift var(--viz-dur-field) ease-in-out infinite`, reduced-motion
  reset present) — contrary to what its name alone suggests, it is not static.

## 2. The real gap: one shared generator, not four hand-rolled copies

The nested-diamond lattice shape is currently **hand-written inline as raw SVG four separate times**,
with no shared source:

| Site | Construction | Purpose | Motion |
| --- | --- | --- | --- |
| `shell.ts:41-45` `BRAND_DIAMOND` | 2 `<polygon>` + `<circle>` core, classed `.d-out`/`.d-mid`/`.d-core` | the working app-mark (top bar + sidebar) | LOOM/CHURN (`.is-working`/`.is-thinking`) |
| `shell.ts:61-63` `SIDEBAR_WMARK` | 2 unclassed `<polygon>` + crosshair `<line>`s | ambient background texture | drift only |
| `aboutPanel.ts:21` `MARK_SVG` | 2 `<polygon>`, `currentColor` strokes | the About panel's static mark | none |
| `exploreView.ts:177` `.exp-center-lattice` | a single `<path>` (not polygons) | Explore's center node | none (Principal ruling, §5.1) |

Per this codebase's own established boundary rule (`_design-system.md` §7: "reused by a 2nd surface → it
belongs in the shared kit"), four independent hand-copies of the same self-similar shape — with one of
them (`SIDEBAR_WMARK`) carrying a color-law bug (§3) that a shared source would have caught — is exactly
the drift a shared primitive prevents. This is the "reusable component" #402 actually asks for.

**Proposal: a parameterized SVG-string generator, not a forced single DOM component.** The four sites
have genuinely different needs (work-state classes vs. none, polygon vs. path construction, different
sizes/opacities) — unifying them into one literal reused element would be the wrong kind of consolidation
(over-fitting four different jobs into one shape). Instead:

- A new function, e.g. `latticeMotif(opts: { size: number; depth: 1 | 2 | 3; stroke: string; core?:
  'dot' | 'disc' | 'none'; className?: string })` returning the SVG markup string — depth controls how
  many nested diamonds recurse inward (the fractal's self-similarity is literally "repeat the diamond at
  half scale, N times"), `stroke` takes a CSS custom-property reference (e.g. `'var(--gold)'`) so callers
  keep token control, `className` lets a caller attach its own motion classes (`.d-out`/`.d-mid`/`.d-core`
  for the brand mark's LOOM/CHURN, nothing for a static instance).
- **Home:** a new small module (`shell/latticeMotif.ts`), not `shell/icons.ts` — `icons.ts` is a flat
  `key → fixed SVG string` lookup (`navIcon(key: string)`, `icons.ts:55`); this generator takes a
  parameter surface icons.ts's pattern doesn't fit. (Dev's call if a different home reads better;
  presentation-agnostic, same as the WS2 primitives spec's own open question on file layout.)
- **Migrate the four sites onto it**, each keeping its own current visual result (this is a
  de-duplication of the *generator*, not a redesign of any instance — `BRAND_DIAMOND` still gets its
  `.d-out`/`.d-mid`/`.d-core` classes for LOOM/CHURN, `SIDEBAR_WMARK` still gets the crosshair lines,
  `MARK_SVG` stays static, Explore's center node **is explicitly out of scope for the generator** since
  it's path-based and carries a name label the other three don't — leave `exp-center-lattice` as-is
  unless/until §5.1 resolves toward giving it shared-generator treatment).
- **Distinctiveness note (for GATE 1):** this section adds no new visual language at all — it is a
  literal, pixel-identical hoist of an already-shipped, already-approved shape into one source. Expect a
  light gate-1 pass, consistent with how the wave-2 UX batch's adoption-only specs cleared.

## 3. Color-law bug found during the audit: fix independent of everything else

`SIDEBAR_WMARK`'s stroke color is `var(--viz-brass)` (`index.css:383`: `.sidebar-wmark { ... color:
var(--viz-brass); ... }`). Per `terminology.md` §3, `--viz-brass` is the **"needs you / caution"**
semantic state hue — reserved for a user-actionable hold, explicitly **never** for "reassurance,
transient self-healing, informational notes," let alone pure decorative chrome. Per `BRAND-GUIDELINES.md`
§3, the motif itself is **gold-only** (rationed, lines/nodes/hairlines). A silent, purely-decorative
background watermark has no business wearing a state-semantic hue — this is a real, if invisible-at-0.1-
opacity, bug: **change `.sidebar-wmark`'s `color` to `var(--gold)`** (matching `BRAND_DIAMOND`'s stroke
and the source `fractal-lattice.svg`'s gold gradient). No visual-language question here, just a token
correction — bundle it into whichever PR migrates `SIDEBAR_WMARK` onto the shared generator (§2).

## 4. Dark-mode gap (small, mechanical)

`brand/DARK-MODE-ADDENDUM.md:48` calls for the field/watermark opacity to rise to **~0.16** in dark mode
("so the faint fractal field reads on dark") — but no `[data-theme='dark']` override exists yet for
`.sidebar-wmark` (light: `opacity: 0.1`), `.explore::before` (light: `0.045`), or `.exp-graph::before`
(light: `0.05`); only `.exp-center-disc` has a dark override today (`index.css:884`). Add a
`:root[data-theme='dark']` block raising each to the addendum's ~0.16 (scaled proportionally per surface
if a single flat value reads wrong at review — DL-1 visual call, not a numeric requirement here).

## 5. Open questions — flagging for the Principal/PM, not resolving unilaterally

Per the dispatch's own instruction ("If SPEC-0057 §2 + the mockup don't give you enough to resolve an
open question... flag here or ping the Principal directly — this was explicitly co-designed with them"):

### 5.1 — RESOLVED (Principal, via PM, 2026-07-13): not actually a conflict, and a bigger ruling besides

The cited `exploreView.ts:232-233`/`:268` comment is scoped specifically to **SPEC-0039 EXPLORE-2** —
Explore center-node *readability* behavior in that older spec — not a general brand-motion rule. Since
Explore's center node is already out of this spec's scope (§2, §4's migration table), there was never an
actual contradiction with BRAND-GUIDELINES §6. No change to Explore.

**The bigger ruling, for #402's actual in-scope motion (`BRAND_DIAMOND`/`SIDEBAR_WMARK`):** organic
"breathing" is rejected outright — the Principal wants **mechanical/clockwork** motion instead: a fractal
loop (self-similar recursive zoom), gear-like meshing/turning, folding/unfolding. This is genuine new
creative direction, not a constraint to design around — **see §6**, which finalizes this as real primitive
specs rather than leaving it as an open question.

### 5.2 — Is the gradient-wash "field" the intended node-field, or does #402 want the literal pattern?

The shipped `.explore::before`/`.exp-graph::before` (§1) satisfy "a faint drifting texture behind
graphs/heroes" **literally**, but as an abstract 4-stop color gradient — it carries no lattice/diamond
geometry at all. `BRAND-GUIDELINES.md` §5 says: *"DIAL UP: ...faint drifting node fields... For texture,
use **a faint fractal field** — never a decorative illustration."* The word "fractal" there arguably means
the texture should carry the lattice shape (as the mock's `brand/mockups/explore.html:104-107` `.field`
layer literally does — scattered small diamond/line/dot fragments, not a gradient), not just an
on-brand-colored gradient. Two paths, meaningfully different cost:
- **(a) Ship as-is** — the existing gradient wash is "close enough" to the brand intent, #402 closes with
  just §2's generator + §3's token fix + §4's dark pass, no new texture work.
- **(b) Build the literal pattern** — a new, genuinely fractal node-field (small lattice fragments at
  low opacity, loosely scattered, using the §2 generator at small `depth`/`size` so it's built FROM the
  shared primitive rather than a fifth hand-rolled instance) replacing or layering over the gradient wash
  behind Explore's graph and other hero surfaces. This is real net-new visual work, not adoption, and
  would need its own DL-1 pass before landing.

I'd lean toward (a) for now — the gradient wash already reads as calm/on-brand and re-theming it is a
larger, separate effort — but this is explicitly the kind of visual call SPEC-0057 §2 reserves for the
Principal, and the guidelines' own wording ("fractal field") is genuinely ambiguous between the two
readings. Flagging rather than deciding. **Still open** as of this update — no answer yet.

## 6. Mechanical motion — Principal-directed (NEW, resolves §5.1)

`BRAND_DIAMOND`/`SIDEBAR_WMARK` currently run `dLoom`/`dChurn` (`design-system.css:412-415`) — an organic
opacity/scale pulse and a rotate-scale-dip flip. Per §5.1, these are **rejected outright**: no breathing,
in either direction. This section defines their mechanical replacements. **Scope discipline:** this
touches only `.dmk` (the brand-diamond/watermark instances) — the general-purpose `.vmark.loom`/
`.vmark.churn` primitive (used for loading/warming faces elsewhere, #520) is a **different consumer of
the same semantic names** and is explicitly untouched; the Principal's direction is a brand-identity
statement about the mark itself, not a request to re-theme every loading spinner in the app.

**The information architecture stays exactly as-is** — only the *look* of each signature changes, not
*when* it fires: continuous "always working" vs. episodic "something just happened" is still the right
split (design-system.css:396-398's own framing), just re-authored in clockwork vocabulary instead of
organic pulse/flip.

### 6.1 — MESH (replaces LOOM — continuous, `.dmk.is-working`)

The clearest literal "clockwork" primitive available on a 2-ring diamond lattice: **the two rings
continuously counter-rotate at different constant speeds**, like meshed gears turning against each other.

- `.d-out` (outer ring): `rotate` 0→360°, linear, infinite, **28s** (slow — this is the ambient "always on"
  layer, should read as barely-there unless watched closely, matching the existing LOOM's low-key
  presence).
- `.d-mid` (mid ring): `rotate` 360°→0° (**opposite direction**), linear, infinite, **19s** — a different,
  non-integer-multiple period so the two rings' relative alignment keeps drifting rather than resolving
  into a repeating beat; the differential speed + opposing direction is what reads as *meshing* rather
  than "one thing spinning."
- `.d-core` (center dot): **stays static** — no continuous animation at all. A steady, unmoving luminous
  center while structure turns around it is thematically apt ("the fragment that linked itself into
  structure," `BRAND-GUIDELINES.md` §2) and is the cleanest way to honor "no breathing in either
  direction" — zero ambiguity about whether a static-but-present pulse still counts as breathing.
- Both rotations are pure `transform: rotate(...)`, `linear` timing (no ease — constant angular velocity
  is what makes it read as *mechanical* rather than organic; easing back toward 0 velocity at the loop
  seam is exactly the "breathing" quality being rejected). A `linear infinite` rotation has no seam to
  begin with — this is also the simplest possible seamless loop, a bonus.
- Compatible with the existing `.shell-idle`/`animation-play-state` perf pause (`index.css:469`,
  #512 PERF-R8) with no changes needed — that mechanism pauses whatever animation is running on the
  selector, generically.

### 6.2 — RECURSE (replaces CHURN — episodic, `.dmk.is-thinking`)

The literal "fractal loop / recursive zoom" the Principal named: **one bounded step of the lattice
recursing one level deeper into itself, then resetting** — not a smooth organic ease, a quantized
mechanical *step*.

- `.d-out`: scales from 1 → 0.5 over the first ~45% of the animation (0.5 is deliberately exact — the
  generator's own halving ratio between nesting levels, §2, so the outer ring visually arrives at
  *exactly* where the mid ring already sits — the self-similar "one level deeper" read), holds briefly,
  then **snaps back to 1 in a single frame** (a hard cut, not an eased return) — the reset that makes it
  loop-ready, reading as a mechanical tick/reset rather than a bounce-back.
- `.d-mid`: runs the same shape, phase-delayed (starts its own scale-down slightly after `.d-out` begins,
  so the recursion visibly propagates outward-to-inward rather than both rings moving in lockstep) —
  concretely, `.d-mid`'s keyframe percentages shift ~10% later than `.d-out`'s.
- `.d-core`: unchanged (stays static, per §6.1 — the episodic gesture is carried entirely by the two rings
  recursing, the center never moves).
- Total duration: **~900ms**, one-shot (`animation-iteration-count: 1`), not looping — this needs to
  complete cleanly within whichever window the shell's `is-thinking` toggle holds the class (currently
  ~1100ms per `shell.ts`'s view-change handler; the dev should confirm that window comfortably covers the
  full ~900ms cycle rather than cutting it mid-step, since a chopped mechanical snap reads far worse than
  a chopped organic ease did).
- Timing function: a stepped/snapped curve for the scale-down phase (e.g. `cubic-bezier(0.5, 0, 0.9, 0.4)`
  — a curve that arrives fast and holds, not a smooth ease-in-out), then the reset frame is instant (0%
  duration, a literal keyframe jump). Exact curve is a DL-1 tuning call, not a hard requirement — the
  *shape* (arrive-hold-snap, not ease-there-ease-back) is the requirement.

### 6.3 — SIDEBAR_WMARK gets MESH too, at its existing ambient rate

Per BRAND-GUIDELINES §5's self-similarity principle ("the icon, the Explore center node, and the whole
graph are the same lattice motif at different zoom"), the ambient background watermark should read as
the **same mechanism**, not a different motion vocabulary — it currently runs the generic `viz-drift`
pan/alpha utility (`index.css:382-383`), unrelated to the lattice's own geometry. Retarget it onto §6.1's
MESH counter-rotation, at its existing slow ambient cadence (**48s**/**33s** outer/mid — scaling §6.1's
28s/19s brand-mark rate down proportionally to match the watermark's current `--viz-dur-field` 48s
baseline) rather than the brand mark's faster rate — it's wallpaper, not a focal working-indicator, and
should stay closer to unnoticeable. No RECURSE analog for the watermark — it has no episodic
"something-just-happened" trigger the way the brand mark's `.is-thinking` does.

### 6.4 — Reduced motion

Both MESH and RECURSE collapse to a fully static lattice under `prefers-reduced-motion: reduce` — extend
the existing `.dmk` reduced-motion reset (`design-system.css:359-361`, currently resetting
`dLoom`/`dChurn`) to the new keyframe names. No functional loss: the work-state semantics (LOOM = "in
progress," CHURN = "just changed") are carried by *triggering* the class at all, not by the animation
itself — same contract every other reduced-motion reset in this codebase already honors.

### 6.5 — Distinctiveness note (for GATE 1 — this section genuinely needs the real pass)

Unlike §2-§4 (adoption-only, light gate-1), this section **is** new visual language and should be
reviewed as such: a continuous counter-rotating gear-mesh + a quantized recursive-zoom-and-snap are a
real departure from the generic "pulse/glow/spin-forever" AI-app idiom (no breathing, no soft glow pulse,
no smooth infinite spin in one direction, no gratuitous bounce/spring easing) — pull-quote-worthy vocabulary
words to check against: *mechanical, clockwork, gear-mesh, fractal-loop, recursive-zoom, light arcane*.

## 7. Test cases (for KB-QD gate-2 / dev test authoring — §2-§4 scope + new §6 coverage)

- `latticeMotif()` unit tests: depth 1/2/3 produce the expected nested-polygon count; `stroke`/`className`
  params thread through to the output markup; a snapshot test pinning `BRAND_DIAMOND`'s and
  `SIDEBAR_WMARK`'s exact rendered markup is unchanged pre/post migration (pixel-identical hoist, §2).
- Static guard: `.sidebar-wmark`'s CSS no longer references `--viz-brass` (grep guard, mirrors the
  existing `Loading…`/duration-token guards from #520).
  `.sidebar-wmark { color: var(--gold); }` renders the same gold as `BRAND_DIAMOND`.
- Dark-mode DL-1: `.sidebar-wmark`/`.explore::before`/`.exp-graph::before` visibly read at the raised
  dark-mode opacity next to the existing `.exp-center-disc` dark override, without over-brightening.
- Reduced-motion: unchanged behavior for all three (already correctly reset today) — regression-only,
  not new coverage.
- **New for §6:** a fake-timer test asserting `.d-out`/`.d-mid` rotate in *opposite* directions under
  `.is-working` (not just "some rotation exists"); a RECURSE test asserting the one-shot completes within
  its own duration and does not repeat (`animation-iteration-count: 1`, or the JS-driven equivalent);
  a visual DL-1 comparing MESH/RECURSE side-by-side with the old `dLoom`/`dChurn` to confirm the "no
  breathing" bar is actually met (no opacity pulse anywhere in the new keyframes — a grep guard on the
  `.dmk`-scoped CSS for a bare `opacity:` animation property would catch a regression back toward pulsing);
  reduced-motion parity test for the new keyframe names, mirroring the existing one for the old names.

## 8. Changelog

- 2026-07-13 — created. Audited current tree against the mock/BRAND-GUIDELINES before drafting (per the
  #406 sibling-spec lesson on trusting claimed gaps without verification) — found most of #402 already
  shipped. Scoped the real gap to one shared `latticeMotif()` generator consolidating 4 duplicate inline
  SVGs (§2), a color-law token bug on `SIDEBAR_WMARK` (§3), and a dark-mode opacity gap (§4). Flagged two
  open questions for the Principal (§5) rather than resolving them unilaterally. Routing to KB-AI-Detector
  for a gate-1 pass — expected light, since §2-§4 add no new visual language.
- 2026-07-13b — **§6 added.** PM relayed the Principal's ruling on both §5 open questions: 5.1 wasn't
  actually a conflict (the cited ruling is scoped to Explore's center node specifically, already
  out-of-scope here); 5.2 is still open, no answer yet. The Principal also gave new, unprompted direction
  for #402's actual in-scope motion (`BRAND_DIAMOND`/`SIDEBAR_WMARK`): reject organic "breathing" outright,
  go mechanical/clockwork instead. §6 finalizes that as two concrete primitives — **MESH** (continuous,
  replaces LOOM: two counter-rotating rings at differential constant speed, gear-mesh vocabulary) and
  **RECURSE** (episodic, replaces CHURN: a bounded, snapped one-level fractal zoom-and-reset) — plus
  extending MESH to `SIDEBAR_WMARK` at its existing ambient rate for self-similarity across instances.
  Scope discipline: only `.dmk` (this component), not the general `.vmark.loom`/`.vmark.churn` primitive
  used elsewhere (#520) — a brand-identity motion statement about the mark itself, not an app-wide
  re-theme. This is genuinely new visual language (unlike §2-§4's adoption-only scope) — **re-opening
  GATE 1 for a real pass on §6 specifically**, not the light one §2-§4 already cleared. PR #578 (the
  §2-§4 implementation) is unaffected and can proceed/merge independently — this is additive scope on the
  same spec/PR #573 (still open at time of writing), not a blocker on already-reviewed work.
