---
design: DESIGN-LATTICE
implements: SPEC-0057
title: Fractal-Lattice Motif — Reusable Generator + Color-Law Fix (#402)
type: design
status: draft   # awaiting SPEC-0033 gates: GATE 1 (AI-Detector) + GATE 2 (KB-QD)
owners: [KB-Design-Lead, KB-Lead, Principal]
created: 2026-07-13
updated: 2026-07-13
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

### 5.1 — Does Explore's center node get to breathe?

`BRAND-GUIDELINES.md` §6 states a general principle: *"focused node gently breathes."* But
`exploreView.ts:232-233`'s comment attributes a **specific, contrary ruling to the Principal**: *"STATIC
center crystalline node (Principal: no breathing ring)."* These read as a direct conflict on this exact
element. I am not overriding a cited Principal ruling on my own judgment — this needs an explicit word:
does §6's general "breathes" language apply here after all (superseding the code comment), or does the
code comment correctly capture a deliberate, standing exception for Explore's center specifically (in
which case §6 should perhaps gain a footnote carving out this exception, so the next spec author doesn't
hit the same apparent contradiction)? **No design work in this spec depends on this answer** — flagging
it now so it doesn't silently resurface as a "gap" in a future audit the way #406's false positives did.

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
readings. Flagging rather than deciding.

## 6. Test cases (for KB-QD gate-2 / dev test authoring, scoped to §2-§4 only — §5 is unscheduled)

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

## 7. Changelog

- 2026-07-13 — created. Audited current tree against the mock/BRAND-GUIDELINES before drafting (per the
  #406 sibling-spec lesson on trusting claimed gaps without verification) — found most of #402 already
  shipped. Scoped the real gap to one shared `latticeMotif()` generator consolidating 4 duplicate inline
  SVGs (§2), a color-law token bug on `SIDEBAR_WMARK` (§3), and a dark-mode opacity gap (§4). Flagged two
  open questions for the Principal (§5) rather than resolving them unilaterally. Routing to KB-AI-Detector
  for a gate-1 pass — expected light, since §2-§4 add no new visual language.
