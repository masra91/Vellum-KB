---
design: DESIGN-VIZ
implements: SPEC-0032
title: Pipeline Visualization — Visual Design ("The Line")
type: design
status: active   # both SPEC-0033 gates cleared 2026-06-02 → checked in as a living design spec
owners: [KB-Design-Lead, KB-Design-Lead-2, KB-Lead, Principal]
created: 2026-06-02
updated: 2026-07-13
related: [SPEC-0032, SPEC-0033, SPEC-0030, SPEC-0017, SPEC-0031]
gates:
  ai-patterns: approved     # GATE 1 — KB-AI-Detector (distinctiveness) — 2026-06-02, no rejections
  qa-flow-coverage: approved # GATE 2 — KB-Quality-Driver (all key flows) — 2026-06-02
stage: Cross-cutting
---

# Pipeline Visualization — Visual Design ("The Line")

> The design language for the SPEC-0032 surface. Authored per SPEC-0033: it documents
> **structure · color · theme · typography · motion · visual language** and the **key user
> flows** it covers, then passes the two gates before check-in. Implementation is downstream
> (a dev builds against this); this is the pixels and the rationale, not the code.

## 1. The concept — a refinery line, not a dashboard

The pipeline is a **machine that refines raw capture into structured knowledge** (Capture →
Archive → Decompose → Connect → Claims → Promote). The design makes that machine literal: a
**precision conveyor line** seen in cross-section, like the schematic of a working instrument.

A captured source is a **billet** — a piece of worked material that travels left-to-right along
the line, getting cut, linked, and stamped at each station, and emerges as **promoted** (settled,
archival) knowledge. You watch your billet ride the line. The funnel is the line seen end-on: the
stream narrows as candidates dedup into entities.

This earns the app a recognizable identity: **an engineered instrument panel**, warm where work
is happening and cool where it rests. Idle is calm graphite; active work glows **ember**. Your eye
goes straight to the heat.

### What this is deliberately NOT (anti-generic-AI — GATE 1 / VIZ-8 / DESIGN-3)

| Generic AI-app tell | What we do instead |
| --- | --- |
| Indigo/violet 500 + purple gradient | Cool **graphite** field; one warm **ember** signal for live work; **verdigris** for settled |
| Inter / generic geometric sans everywhere | **Condensed industrial grotesque** for station signage (uppercase, tracked); **monospaced tabular** for every number |
| Glass cards, soft drop-shadows, a rounded card grid | One **horizontal spine** with stations; flat ink, thin structural rules, registration ticks |
| Chat bubbles / assistant avatar | No conversation metaphor — this is a machine readout |
| Shimmer, floating particles, parallax, motion-for-its-own-sake | **One** signature motion (stepper *index*) + **one** ambient (ember breathe) + odometer counts. Nothing decorative |
| Counts that snap 0 → 47 | **Odometer roll** on tabular figures; conversion shown as billets **merging**, not a number jump |

## 2. Structure & layout

One organizing element — **the Line** — replaces the stacked `<h2>` lists of today's Status view.
It reads at a glance and is the same structure under both lenses (VIZ-5).

```
┌─ PIPELINE ───────────────────────────────────────────────────  ◐ RUNNING ──┐
│                                                                              │
│   CAPTURE ─────● ARCHIVE ─────● DECOMPOSE ════▣ CONNECT ─────○ CLAIMS ───○ PROMOTE
│      │            │              │ (ember pulse)   │            │           │
│   ▓▓▓▓▓        ▓▓▓▓           ▓▓▓░░          ▓▓░░░       ▓▓▓▓▓▓     ▓▓░    ← gauge-rail
│    10           10             8              7            22        5      ← tabular counts
│                              −2 deduped                +15 (×3.1)            ← directional delta
│                                                                              │
│   IN FLIGHT ──────────────────────────────────────────────────────────────│
│   ▸ ada-lovelace.md      [██████▣·····]  Decompose ⟳   12s on Copilot       │
│   ▸ turing-1936.md       [███▣········]  Archive  ✓ → Decompose             │
│   ▸ kb-notes.md          [█████████▣··]  Claims   ⟳                          │
│                                                                              │
│   ◑ NEEDS YOUR DECISION (2)                                                  │
│   ▸ napier-bones.md · Claims · set aside · 3 attempts [ Retry ]  [ Dismiss ] │
│   ▸ "Mercury" → 2 entities · Connect · ambiguous link  [ Pick… ]             │
└──────────────────────────────────────────────────────────────────────────────┘
        per-item ◉──○ per-stage          (pivot toggle — same data, shifted weight)
```

- **The Line (top)** — six stations on a single horizontal spine. Each station node shows its
  state (idle/running/blocked/error) and, beneath, a **gauge-rail**: a short vertical bar of
  current volume plus the **conversion delta** to the next station. This *is* the funnel,
  integrated into the line rather than a separate chart (VIZ-3, VIZ-4).
  - **The delta is directional** — the line is not monotonic. A *reduction* (e.g. Decompose
    dedup) reads `−N (deduped)`; a *fan-out* (e.g. Connect→**Claims**, where 7 entities expand to
    22 claims) reads `+N` or the `×ratio`, never a confusing negative where volume grows. The
    gauge-rail bar scales to the stage's own volume so a fan-out reads as the stream *widening*,
    not overflowing. (Resolves the GATE-2 fan-out-caption note.)
  - **Funnel unit logic** (resolves the #169 `promoted`-semantics question). The funnel is a
    **source-throughput spine with intermediate transformation yields**: `captured` and `promoted`
    are the **same unit (sources)** — sources in → sources fully landed on `main`; their ratio is
    the **completion rate**, the primary "is it working" signal. `candidates` / `entities` /
    `claims` are the **intermediate transformation volumes** (extract → dedup → claim), which fan
    out / narrow via the directional deltas above. So **`promoted` = sources-on-main**, not
    entities-on-main (which would break the in/out unit spine). Because the last segment crosses
    units (claims-volume → sources-promoted), the **PROMOTE caption is a completion ratio**
    (`5/10 · 50%`), **not** a delta from claims; only the mid-funnel segments are directional deltas.
- **In-flight (middle)** — each live source is a **carriage**: a compact stepper across the six
  stations, current step lit + animated, completed filled, with its current Copilot dwell time.
  This is the "pizza tracker" (VIZ-2). Click a carriage → expand to its full per-hop trace
  (OBS-16 `spansForItem`).
- **"Needs your decision" queue (below)** — the actionable queue of items **waiting on a human
  call**, pulled **off the line** onto a siding (VIZ-7, OBS-17, #192). This is **not framed as
  failure** — a pending decision is normal workflow, not an error. It is **count-led and
  actionable** ("**3 need your decision**"), each item carrying its decision affordance:
  - **set-aside item** → **Retry / Dismiss** (a source the pipeline gave up on after K attempts),
  - **ambiguous-link review** → answer the disambiguation (SPEC-0018),
  - **researcher escalation** → **Continue? / Stop** (a depth-cap "continue?" — RESEARCH-11).

  Treatment is **brass** (waiting-on-*you*), **not oxide** — oxide is reserved for the *broken*
  alarm (stuck lock / errored stage, below). The distinction is the whole point of #192: "the
  machine needs a decision from you" reads calm + actionable; "the machine is broken" reads as the
  alarm. (A set-aside item's *cause* is shown as quiet context, not as the headline.)
  - **Single source of truth — `N` == the list, always (no #110-class drift).** This queue is the
    **one unified** needs-you surface; it does not run parallel to (and drift from) the per-flow
    badges. **`N` is the actual count of actionable items aggregated across ALL needs-you flows**
    (set-aside OBS-17 + ambiguous-link Reviews SPEC-0018 + researcher escalations RESEARCH-11), and
    it MUST equal the number of rows shown — never "badge says 1, list says nothing needs you"
    (the #110 bug). Each row **deep-links** to its decision affordance. If a flow has zero items it
    contributes zero; when all are zero the queue is calm-empty/absent.
- **Pivot toggle (footer)** — flips emphasis between **per-item** (carriages foreground, stations
  dim to context) and **per-stage** (station gauges foreground, carriages collapse to counts).
  Same Line, same data — only where the visual weight sits (VIZ-5).

**Responsive:** below a narrow breakpoint the horizontal Line rotates to a **vertical** spine
(stations top-to-bottom), carriages become rows. Hierarchy is preserved; nothing is hidden.

**Default landing lens — `per-stage`.** Rationale: the most frequent job is "is it alive / where's
the bottleneck," answered at a glance by the Line + gauges; "follow my capture" is the per-item
moment you opt into by watching a carriage or pivoting. (Resolves SPEC-0032 §9 "primary lens".)

## 3. Color & theme

Semantic, not decorative. State maps to temperature: **work is warm, rest is cool.** Tokens are
named by role so dark/light and future surfaces stay coherent (DESIGN-7).

| Role | Token | Dark (default) | Light ("draughting paper") | Meaning |
| --- | --- | --- | --- | --- |
| Field | `--viz-field` | `#15171A` warm graphite | `#F4F1EA` warm paper | The line's ground |
| Structure | `--viz-rule` | `#2B2F35` | `#CFC9BC` | Spine, ticks, registration marks |
| Idle/at-rest | `--viz-idle` | `#6B7178` slate | `#8A8473` | Stations with nothing moving |
| **Active (work)** | `--viz-ember` | `#E8743B` ember | `#C2541F` | The signature heat — running stage / lit step |
| Settled/promoted | `--viz-patina` | `#5FA38C` verdigris | `#3E7D67` | Completed / promoted material |
| Blocked / **needs-you** | `--viz-brass` | `#C7A24A` brass | `#9A7B2E` | Queued/waiting on lock/sweep, **and the "needs your decision" queue** (#192) — waiting on *you*, not broken |
| Error / **broken** | `--viz-oxide` | `#D2452F` oxide red | `#B02A18` | The *broken* alarm only — stuck lock / errored stage (NOT a pending decision) |
| Text primary | `--viz-ink` | `#E6E3DC` | `#1C1B18` | Labels, body |
| Text muted | `--viz-ink-muted` | `#9298A0` | `#6A6557` | Secondary, units |

- **Brass carries two meanings — disambiguate by context, not hue** (resolves KB-QD's GATE-2
  brass-overload note). `--viz-brass` marks both **system-waiting** (a stage queued on the lock/sweep
  — resolves itself, *no* user action) and **human-waiting** (the "needs your decision" queue — *act
  now*). They are told apart by **location + label + affordance**, never by hue alone: human-waiting
  lives in the `◑ NEEDS YOUR DECISION (N)` block with a **decision affordance** (Retry/Pick/Continue)
  on each row; system-waiting is inline at a station with **no** affordance. **Never render a bare
  brass dot where the two could be confused** — a brass item that demands action must sit in the
  needs-you queue with its button + the block's header glyph/label.
- **Contrast (measured on dark, vs `--viz-field` `#15171A`):** ink `14.0:1`, brass `7.4:1`,
  patina `6.1:1`, ember `6.0:1`, **oxide `3.96:1`**. Rule that follows from this:
  - **State hues color fills, glyphs, borders, and large/display elements only** — all clear the
    `≥3:1` WCAG bar for graphics + large text.
  - **Small body text stays `--viz-ink`** (14:1). In particular **oxide must NOT color normal-size
    text** (3.96 < 4.5 AA) — the set-aside *reason* line renders in ink; oxide carries the badge
    fill, the `✕` glyph, and the siding's left border. (Resolves the GATE-1 ember/contrast
    watch-item — and catches that oxide, not ember, was the actual sub-AA case.)
- **State is never carried by color alone** — each state also has a glyph (`◐ ▣ ○ ✓ ⟳ ✕`) and a
  fill pattern, so it survives color-blindness and grayscale (accessibility, DESIGN-4 adjacent).
- **Theme** follows the app shell's existing dark/light setting (SPEC-0017); both palettes above
  are first-class, not an afterthought.

## 4. Typography

| Role | Typeface (named — bundle it) | Treatment |
| --- | --- | --- |
| Station signage | **Saira Condensed** (SemiBold) | **UPPERCASE**, letter-spaced `+0.08em` — reads like stencilled station labels |
| Numerics (all counts, latency, throughput) | **IBM Plex Mono** | `font-variant-numeric: tabular-nums`; fixed-width so odometer rolls and live updates never reflow the layout |
| Body / descriptions | **IBM Plex Sans** | Sentence case, generous line-height |
| Reason / status notes | IBM Plex Sans, muted | e.g. "set aside after 3 failed attempts" |

All three are **OFL-licensed and MUST be self-hosted/bundled** with the app and declared via
`@font-face` — **not** loaded from a CDN and **never** left to a system fallback. The fallback
stacks are shape-matched so a load failure degrades gracefully without collapsing the identity:
`'Saira Condensed','Arial Narrow',sans-serif` · `'IBM Plex Mono',ui-monospace,monospace` ·
`'IBM Plex Sans',system-ui,sans-serif`. **If these fall back to `system-ui`/Inter the whole
identity is lost** (GATE-1 watch-item 1) — the bundled faces are a hard requirement, not a
preference.

Type scale (4-step, restrained): `12 / 14 / 18 / 28`px. The headline state badge (`RUNNING`) is
the only 28px element. **Tabular numerics are non-negotiable** — they are why animated counts feel
mechanical and precise rather than jittery.

## 5. Motion

The motion vocabulary is tiny and purposeful (VIZ-1, VIZ-6, VIZ-9). Three verbs, nothing else:

1. **Index** (signature) — when an item advances a station, its carriage step *indexes* forward:
   a quick weighted settle, `transform: translateX` over **220ms, `cubic-bezier(.2,.8,.2,1)`**
   (ease-out with a hint of overshoot, like a stepper motor seating). This is the "it moved" beat.
2. **Ember breathe** (ambient) — the single active station/step pulses its ember glow,
   **opacity 0.6↔1.0 over 1.8s**, `ease-in-out`, infinite. Only the *currently working* step
   breathes; everything else is still. When the line goes idle, the ember **cools** to `--viz-idle`
   over 600ms and the breathing stops — that cooling *is* the "work finished, at rest" signal.
3. **Odometer** — counts and conversion deltas roll digit-by-digit to their new value
   (**400ms, ease-out**) on tabular figures; the gauge-rail bar tweens height in the same window.
   Conversion (10→7) additionally **merges** the absorbed billets into their neighbor before the
   count settles — dedup made visible, not a silent decrement.

- **Calm idle:** at rest the Line is static graphite with one slow "ready" tick on the spine
  (a 2px mark fading 4s). No flashing, no looping motion competing for attention.
- **Reduced-motion (`prefers-reduced-motion`):** every transition becomes an **instant state
  change** — index → snap, breathe → static ember fill, odometer → snap to value. **Full
  functional parity**; nothing is conveyed by motion alone (state also has glyph + color + fill).
- **Performance (VIZ-9):** animate **only `transform`/`opacity`** (no layout-triggering props);
  pushed updates are **coalesced into one rAF frame** and debounced (~120ms) so a burst of stage
  transitions paints once; carriages beyond **N=12** visible collapse into an aggregated
  "+K more in flight" row (virtualize) so motion stays at 60fps with many items.
  (Resolves SPEC-0032 §9 "scale" and "motion budget".)

## 6. Component anatomy

- **Station node** — `◐/▣/○/✓/✕` glyph + UPPERCASE signage + gauge-rail. State = glyph + color +
  fill. The one *running* station embers + breathes.
- **Gauge-rail** — vertical fill bar with a **directional** conversion-delta caption to
  the next station (`−N (deduped)` at reductions, `+N (×ratio)` at fan-outs like Connect→Claims);
  the **terminal PROMOTE rail shows a completion ratio** (`promoted/captured`, e.g. `5/10 · 50%`),
  not a delta — see §2 funnel unit logic. The slowest station's rail tints toward oxide and shows
  its `p95` Copilot latency (VIZ-4, the spatial "where time goes"). **The bar's primary fill is the
  pending-work bar (below, VIZ-12); the cumulative conversion *volume* is the secondary lens** — its
  count + projection caption stay in the rail's number lane (VIZ-10), and the cumulative *bar* reads
  in the funnel/per-stage pivot, not as the live headline.

- **Pending-work bar (VIZ-12) — the live headline fill.** The Principal's model: *"what I want in
  the bars is pending items — a bar that shows all pending, with a slight fade / colour difference
  for the in-progress ones."* So the rail's primary fill is **work-in-motion**, not the cumulative
  end-state total (which read as a stuck/stale final tally). Per station, from
  `pendingForStage(view.inFlight, stage)` → `{queued, inProgress}`:
  - **The bar is a two-segment stack of *pending* (`queued + inProgress`).** Its **total height
    scales to the peak pending across all six stations** (relative backlog — the fullest stage reads
    tallest, so "where's it piling up" is a glance), `0` pending → empty rail track (calm, no fill).
  - **In-progress segment = the warm base**, anchored at the spine: **`--viz-ember` + the ember
    *breathe*** (the existing ambient, opacity `0.6↔1.0 / 1.8s` — *this is the Principal's "fade"*).
    It is the items the stage is actively draining (`InFlightItem.active`), so it is alive on three
    channels at once — **hue (ember), motion (breathe), and position (the base segment)** — never
    colour alone (§3).
  - **Queued segment = stacked above, still + cool**: `--viz-idle` slate, no motion (waiting, not
    worked). It tints **`--viz-brass`** *only* when the station is **`queueConcerning`** (stuck/
    errored stage, or pipeline `stalled`, with a backlog — the VIZ-10/OBS-11 rule), **never on depth
    alone** (a deep-but-draining queue stays calm slate — the cry-wolf guard).
  - This makes the read **emergent + legible**: ember base + thin cool cap = healthy draining;
    **tall cool, little/no ember = a backlog not moving** (brass when stuck); pure ember = working,
    nothing waiting; empty = idle. The in-progress is distinct *because* it embers + breathes while
    the queued sits still.
  - **Numbers stay in the live-state lane (ink, §3):** the existing `queue N` (queued) gains a
    sibling **`▣ N active`** (the `▣` glyph carries ember; the count is ink-numeric, `active` is
    signage) — both in the LIVE-STATE cluster (the only *actionable, sitting-here* numbers), apart
    from the rail's cumulative volume+projection (which is a *projection*, never live work — VIZ-10).
  - **Live + never stale-stuck (the whole point):** the segments read the maintained snapshot off
    `view.inFlight` and update by push (SHELL-12/OBS-24); the ember segment is present **iff**
    something is genuinely `active`, so a frozen breathing bar with no live worker can't appear (a
    stale pending bar is the bug, not the feature). **Null/partial-tolerant (ENG-15/16):** an absent/
    empty `inFlight`, or a legacy item missing `active`, collapses to `queued` (no false ember) — a
    malformed item never breaks the bar or the station row.
  - **Reduced-motion (§5 parity):** breathe → a static ember fill; in-progress stays distinct by
    hue + segment + the `▣ active` count. Full functional parity, nothing by motion alone.
- **Carriage** — `▸ name` + a six-cell stepper `[██████▣·····]` + current dwell ("12s on Copilot").
  Filled = done (patina), `▣` lit = current (ember), `·` = pending. Expandable to the per-hop
  trace.
- **"Needs your decision" queue** (#192) — a **count-led, brass, actionable** list ("3 need your
  decision"), **not** an error panel. Each row = a name + the **decision affordance** for its kind
  (set-aside → **Retry/Dismiss**; review → **Pick…**; escalation → **Continue?/Stop**) + the **stage**
  it belongs to + the *cause*, both as quiet muted context (not the headline) — e.g.
  `napier-bones.md · Claims · set aside · 3 attempts`. The **stage label is required** so items
  across different stages stay triageable (which stage gave up on this source), preserving the
  OBS-17 read-side's `stage · name` locus (resolves KB-QD's GATE-2 should-fix). Brass
  (`--viz-brass`, waiting-on-you), **never oxide**
  — oxide is the *broken* alarm only. Single-flight (affordances disable while acting); destructive
  picks (Dismiss) confirm first. Reuses the existing OBS-17 `kb:pipelineControl` + review contracts
  — no new mutation surface. **Calm-empty:** when the queue is empty it's quiet/absent (nothing
  "needs you" is the good state), never a flashing zero.
- **Stuck-lock alarm** (the headline "silent stall, made loud" — OBS-11/VIZ-1). A stuck
  canonical-writer lock is *the* silent-stall case (it was the #163 P0). When the view-model reports
  `lock.stuck` (held past the watchdog threshold — `LockState.stuck`/`heldMs`/holder, shipped in
  #170), The Line raises it as the **primary alarm**: **oxide**, prominent, reading **"stuck — held
  by `<holder>` for `<heldMs→Ns>`"** with the holder label real (e.g. `connect:afterDrain`, not "a
  stage") and the elapsed in tabular mono. It pairs with the **overall=stalled** state — a stalled
  pipeline points straight at *what* is wedged, not just *that* it is. A healthy held-but-moving lock
  and calm idle stay quiet; only `stuck` escalates to the alarm. (Turns a silent P0-class wedge into
  a named, surfaced state — the whole reason this surface exists.)

### Reading the numbers — funnel-caption legibility (clarity pass)

> Principal-reported confusion: the Linking gauge-rail's `399` + `+1116 (×3.8)` was read as **queue
> depth / backlog**. It is not — `399` is the *volume* that reached Connect and `+1116 (×3.8)` is the
> *fan-out projection* into Claims (`theLineModel.ts:directionalDelta`). The station stacks **four
> distinct number-roles** (volume · projection · queue · latency) and two of them were bare, adjacent
> numerics — so they blurred. This pass makes each number **declare its role at a glance**, and ensures
> a **projection can never read as a backlog**. No new tokens — signage micro-labels + the existing
> badge/`title` patterns; small text stays ink/ink-muted per the §3 contrast rule.

The four number-roles and their fixed treatment:

1. **Volume** (`line-rail-count`) — items that *reached* this station. Carry the station's **bucket
   noun** as a quiet signage micro-unit so the bare count self-describes: `399 entities` (capture →
   `captured`, decompose → `candidates`, connect → `entities`, claims → `claims`, promote → `promoted`).
2. **Projection / conversion** (`line-rail-caption`, `+N (×r)` / `−N deduped`) — a **derived projection**
   of how this bucket fans out / reduces into the **next** stage; it is *not* live work sitting here.
   Tie it to the next station with a leading **`→`** and a quiet `fan-out` / `deduped` signifier (e.g.
   `→ +1116 ×3.8 fan-out` , `→ −40 deduped`) so it reads as *flows-to-next*, never *waiting-here*. Stays
   ink-muted (§3); the terminal PROMOTE completion ratio (`5/10 · 50%`) gets a `complete` signifier.
3. **Load / queue** (`line-station-queue`) — the **only real backlog number**: items *waiting* to be
   processed at this station, and the only number that can be **actionable**. Keep the `queue N` label
   but pull it into the **live-state cluster** (with current-item / set-aside), a distinct typographic
   lane from the rail's volume+projection. When it crosses a concern threshold it may take **`--viz-brass`**
   (needs-you, consistent with the #192 queue + the system semantic) — never confusable with the muted
   projection.
4. **Latency** (`line-station-latency`, `slowest · p95`) — already labeled + carries a `title`; keep.

Plus two cross-cutting affordances:

- **A spine legend (progressive disclosure).** One small, always-available **legend key** under the
  spine that decodes the caption grammar *once*: `→ fan-out/deduped projection to next · vol = reached
  here · queue = waiting · set aside = pulled off`. Quiet signage (a `details`/`title` affordance), not
  a loud banner — the dense engineered captions get a key without cluttering every station.
- **Decode-on-hover.** Extend the existing `title=` pattern (latency already has one) to the **volume
  count** and the **projection caption** — e.g. `title="399 entities reached Connect"` /
  `title="projected fan-out ×3.8 into Claims"` — so the exact meaning is one hover/focus away (and the
  legend keeps it glanceable without the hover).

**Net:** volume, projection, queue and latency each announce their role; the **queue (real backlog) is
visually + semantically separated from the conversion fan-out (projection)** — the exact confusion
reported. Reuses blessed primitives + the §3 contrast contract; net-new affordance → KB-Lead HYBRID
classify, with any VIZ requirement delta KB-Lead specs.

### Implementation guardrails — keep it from regressing to generic (GATE-1 watch-item 2)

The fastest way "The Line" reverts to a generic AI app is a component-library default sneaking
back in. The implementer MUST hold these:
- **Flat ink, no card chrome** — no `border-radius` on structural surfaces (small radius only on
  buttons, ≤4px), **no drop-shadows / elevation**, no glass/blur. The structure is ruled lines +
  registration ticks, not floating cards.
- **Focus rings use `--viz-ember`** (a 2px outline), **never the framework's default indigo**.
- **No bundled UI-kit Card/Paper/Chip surfaces** — they re-introduce the rounded-shadow tells.
- **Selection / hover / active states** tint with the state hues (ember/brass), not a default blue.

## 7. Key user flows covered (GATE 2 — KB-Quality-Driver)

Every flow in SPEC-0032 §7, mapped to the design:

| # | Flow (SPEC-0032 §7) | How the design serves it |
| --- | --- | --- |
| 1 | Open Status → see funnel (10 captured → 7 entities → 22 claims → promoted) + in-flight trackers | The Line lands in **per-stage** lens: station counts + gauge-rail conversion deltas = the funnel; in-flight carriages listed below |
| 2 | Capture a note → its tracker appears and **advances step-by-step**, active stage pulsing | A new carriage enters at CAPTURE; **indexes** station-by-station; the active step **embers + breathes** |
| 3 | A source **set aside** → **Retry / Dismiss** | Joins the **"Needs your decision" queue** (brass, actionable — *not* error-red); Retry/Dismiss present (OBS-17, #192) |
| 4 | **Pivot to per-stage** → Connect 22/min, p95 14s | Pivot toggle foregrounds station gauges: throughput/min + Copilot p95 per station |

Plus the cross-cutting requirements: real-time/event-driven + animated (VIZ-1), light purposeful
motion with calm idle (VIZ-6), smooth at scale (VIZ-9), and the distinct identity (VIZ-8).

## 8. Requirements traceability

| Req | Where served |
| --- | --- |
| VIZ-1 real-time + animated, no "0→sudden" jank | §5 odometer + event-coalesced rAF; §10 push channel |
| VIZ-2 per-item "pizza tracker" stepper | §2 carriage, §6 |
| VIZ-3 funnel + conversion | §2 gauge-rail conversion deltas |
| VIZ-4 per-stage bars + Copilot latency | §6 gauge-rail, slowest-station tint + p95 |
| VIZ-5 pivot per-item ↔ per-stage | §2 pivot toggle (one structure, two weightings) |
| VIZ-6 purposeful motion, calm idle | §5 (3 verbs; ember cools at idle) |
| VIZ-7 set-aside prominent + Retry/Dismiss; **#192 needs-you queue** | §2 "Needs your decision" queue, §6 (actionable brass queue, not failure) |
| VIZ-8 distinct identity, not generic AI | §1 concept + anti-tell table |
| VIZ-9 smooth/performant | §5 transform/opacity-only, coalesce, virtualize >12 |
| DESIGN-2 authored: structure/color/type/motion/language | §§2–6 |
| DESIGN-5 checked in as a living design spec | this file (`specs/design/`) |

## 9. Data dependencies (what the implementer needs — NOT yet in the OBS view-model)

The design presents over SPEC-0030's `PipelineStatusView` + `PerfIndex`, but a few inputs the design
requires are **not yet exposed** — flagged for the implementer + KB-Lead/PM (these gate
*implementation*, not this design):

1. **In-flight item roster with current stage** — carriages (VIZ-2) need an enumerated list of
   live sources and each one's current station. Today the model has a single `currentItem` per
   stage + queue depths only. Needs either an added `inFlight: {itemId, name, stage, sinceTs}[]`
   on the view-model, or derivation from open `stage.run` spans / the jobs table.
2. **Funnel conversion counts** — captured → candidates → deduped entities → claims → promoted as
   **cumulative** counts (VIZ-3). Today there's per-stage `queueDepth` + perf `throughput`, but no
   cumulative conversion. Needs a counts source (likely from the activity/status index).
3. **Event push channel (VIZ-1)** — current view polls every 2500ms. Smooth motion wants pushed
   stage transitions (SPEC-0032 §4). **Graceful degradation:** absent push, the design still works
   — odometer/index interpolate between polls; push just removes the residual latency.
   (Resolves SPEC-0032 §9 "push mechanism": prefer a dedicated IPC event channel; poll is the
   fallback, not a blocker.)
4. **Unified needs-you roster (#192) — the gate on the brass "Needs your decision" queue.** The §2/§6
   queue is the *one* surface aggregating all human-decision items with `N == list` across flows;
   that requires a single view-model field unifying **set-aside (OBS-17) + ambiguous-link Reviews
   (SPEC-0018) + researcher escalations (RESEARCH-11)** into one `N`-counted, deep-linkable list. It
   does not exist yet (a DEV-3 + Reviews/researcher-owner coordination). **Until it lands, the
   implementation ships the VIZ-7 *baseline* — the oxide set-aside siding + Retry/Dismiss (#196)** —
   NOT a partial brass relabel of only set-aside (which would make `N` count set-aside alone and
   break the `N == list` anti-#110 invariant). So: design = the brass unified queue (target); #196 =
   the baseline (now); the brass reframe is a **tracked follow-up** gated on this field, owned by
   DEV-4. (Documents the design-ahead-of-impl gap; no silent divergence.)
   **IA home (2026-07-13 addendum, KB-Design-Lead-2):** this section was written pre-SPEC-0060 and
   assumed the baseline siding lives in the standalone Status/"The Line" view. That view is
   **dissolved** (SPEC-0060 §4: "stuck/set-aside items route to Reviews") — the baseline's home is
   **Reviews**, not a resurrected Status view or Today's ember panel. Build it as its own distinct,
   oxide-toned section inside Reviews, visually separate from Reviews' existing ember decision
   cards (so there's no premature `N`-count collision with the still-not-built unified roster
   above). Resolved for issue #192's implementation (KB-Developer-1, 2026-07-13).

## 10. Out of scope

- The knowledge-graph view (Obsidian / VAULT, SPEC-0031) — VIZ is the **pipeline** tracker.
- Historical replay of past runs (Activity, SPEC-0029) — VIZ is **now**.
- The full cross-surface design system — this is the **first** surface; a shared system emerges
  from it over time (DESIGN-7).

## 11. Decisions (rationale → `decisions` topic per role)

- **Primary lens = per-stage** (§2) — at-a-glance health is the more frequent JTBD.
- **One signature motion (index) + one ambient (breathe)** — distinctiveness without
  motion-for-its-own-sake; survives reduced-motion.
- **Ember-for-work / cool-for-rest temperature mapping** — the core of the "alive" feeling and the
  anti-generic-AI identity; warmth, not purple, signals activity.
- **Funnel integrated into the Line as gauge-rails** rather than a separate chart — keeps one
  organizing structure and makes conversion spatial.

## 12. Changelog

- 2026-06-02 — created (draft). Visual design for SPEC-0032 Pipeline Visualization: **"The Line"** —
  a refinery-conveyor instrument panel (stations + carriages + gauge-rail funnel + set-aside
  siding), ember-for-work color semantics, condensed signage + tabular numerics, a three-verb
  motion vocabulary (index / breathe / odometer) with full reduced-motion parity, and the
  anti-generic-AI identity. Flags two OBS data dependencies (in-flight roster, conversion counts) +
  the event-push channel for the implementer. Pending GATE 1 (KB-AI-Detector) + GATE 2 (KB-QD).
- 2026-06-02 — **GATE 1 (KB-AI-Detector) APPROVED**, no rejections. Hardened against the three
  non-blocking implementation watch-items: named + bundled typefaces (Saira Condensed / IBM Plex
  Mono / IBM Plex Sans, self-hosted, shape-matched fallbacks — §4); explicit "flat ink, no card
  chrome" implementation guardrails (§6); concrete measured contrast ratios + the rule that state
  hues never color small text — which caught that **oxide** (3.96:1), not ember, was the actual
  sub-AA case (§3). Awaiting GATE 2 (KB-QD, flow coverage).
- 2026-06-02 — **#192 "Needs your decision" queue** — reframed the set-aside siding from a *failure*
  read into an actionable, count-led **brass** queue ("N need your decision") that aggregates the
  human-decision items (set-aside Retry/Dismiss, ambiguous-link reviews, researcher "continue?"
  escalations). Pending decisions are normal workflow, **not** errors — so they read calm + actionable
  (brass, waiting-on-*you*), distinct from the **broken alarm** (oxide; stuck lock / errored stage).
  §2/§6/§7 + color table updated; calm-empty when nothing needs you. Routing through GATE 1 + GATE 2.
  **GATE 2 (KB-QD) PASS** — all affordances preserved; folded in their should-fix: the row keeps the
  **stage label** (`name · stage · cause`) so items across stages stay triageable (OBS-17 locus).
  Plus `N == list` single-source-of-truth (anti-#110 drift, per PM). Awaiting GATE 1 (KB-AI-Detector).
- 2026-06-02 — **Stuck-lock alarm added** (§6) now that #170 (`f2ae987`) shipped
  `LockState.stuck`/`heldMs`/holder-label: a stuck canonical-writer lock (the #163 P0 class) renders
  as the primary oxide alarm — "stuck — held by `<holder>` for `<Ns>`" — paired with overall=stalled,
  realizing the surface's headline "silent stall, made loud" (OBS-11/VIZ-1). Renders an
  existing-and-now-enriched view-model field; no change to the inFlight/conversion/push contract.
- 2026-06-02 — **Funnel unit semantics clarified** (§2/§6) resolving DEV-3's #169 question:
  `captured`/`promoted` are the same unit (sources) = the throughput spine + completion rate;
  candidates/entities/claims are intermediate transformation yields; **`promoted` = sources-on-main**
  (not entities-on-main); the PROMOTE caption is a completion ratio (`promoted/captured`), not a
  delta. Recorded in `decisions`.
- 2026-06-02 — **GATE 2 (KB-Quality-Driver, flow-coverage) PASS** — all four key flows + per-item
  drill-down covered; OBS-17 Retry/Dismiss confirmed first-class (siding is a persistent region, not
  hidden under pivot). Folded in KB-QD's non-blocking note: the conversion-delta caption is now
  **directional** — `−N (deduped)` at reductions, `+N (×ratio)` at fan-outs (Connect→Claims), so the
  funnel stays legible where volume grows (§2/§6, mock updated). **Both gates GREEN → status `active`,
  checked in as the living design spec.** Implementation mission carries the §9 data deps + the
  watch-items.
- 2026-06-02 — **"The Line" surface IMPLEMENTED (DEV-4).** The Status view (`app/src/shell/views/
  statusView.ts` + the pure model `theLineModel.ts` + surface CSS `theLine.css`) now renders The Line
  on the shared `_design-system` foundation (#179), binding to `pipelineStatusView()` on the 2.5s poll
  (no mocks; the three §9 data fields — `inFlight` #175, `conversion` #169, `STAGE_ORDER` #168 — are
  live). **Built:** the six-station spine + gauge-rail funnel (directional `−deduped`/`+×ratio` deltas
  with the bucket→station map documented in `theLineModel.ts`; PROMOTE completion-ratio with the
  `0/0 · 0%` guard; bars scaled to the peak bucket so a fan-out reads as widening); in-flight carriages
  (six-cell `stageIndex` stepper + active-only dwell, `>12` virtualized to "+K more"); the set-aside
  siding (OBS-17 Retry/Dismiss, contract verbatim); the **stuck-lock alarm** as the primary oxide
  call-out (#170 `lock.stuck`/`heldMs`/holder); the per-stage↔per-item **pivot** (default per-stage);
  ember-breathe on the active station/step with the **reduced-motion parity** reset (`.viz-surface`
  root) and tabular numerics; the §6 flat-ink guardrails (no card chrome, ember focus) and the §3
  contrast rule (**oxide only on glyphs/borders/large + the badge fill — never small text**). **Deferred
  fast-follows (each gated on an input not yet present, not a scope cut):** (1) the §9 **event-push
  channel** (`kb:pipelineEvent`) — poll is the floor (DEV-3 owns it); (2) the **keyed cross-poll
  odometer/index digit-roll** — the tabular-nums + ember-breathe land now; the literal digit-roll rides
  the push channel / keyed-DOM diffing; a change-guard keeps the ambient motion smooth across unchanged
  polls (VIZ-9); (3) the **carriage → per-hop trace drill-down** (VIZ-2 expand) — needs an OBS-16
  `spansForItem` IPC not yet exposed. Tests trace to VIZ-1/2/3/4/5/6/7/9 + OBS-5/6/7/11/15/17.
- 2026-06-13 — **VIZ-12 pending-work bar authored** (§6) — re-orients the rail's primary fill from the
  cumulative end-state volume (which read as a stuck/stale final total) to **work-in-motion**: a
  two-segment **pending** bar (`queued + inProgress` from `pendingForStage`), height scaled to the peak
  pending across stations. **In-progress = ember base + breathe** (the Principal's "fade" = the existing
  ambient pulse; distinct by hue + motion + position, never colour alone); **queued = still slate**,
  brass only when `queueConcerning` (VIZ-10/OBS-11 stuck-gate, never on depth). Cumulative volume demoted
  to the secondary funnel/pivot lens; a `▣ N active` count joins `queue N` in the ink live-state lane.
  Live off the maintained snapshot (SHELL-12/OBS-24) so it's never stale-stuck; ENG-15/16 null-tolerant;
  reduced-motion → static ember parity. **Net-new visual → KB-Lead HYBRID**; the queued-vs-in-progress
  **bars** are KB-Developer-6's build (consuming `view.inFlight`), the funnel/pivot/carriages/motion stay
  KB-Developer-4's — DEV-6 owns the bar *fill geometry* + the `▣ active` count, DEV-4 owns the rail
  *caption numbers* + cumulative funnel, so they don't double-edit the station render. Gates: Design-Lead
  visual + KB-QD-2 code.
- 2026-06-08 — **Funnel-caption legibility clarity pass added** (§6) — Principal read the Linking
  gauge-rail `399` + `+1116 (×3.8)` as *queue depth*; it's volume + a fan-out *projection*. The station
  stacks four number-roles (volume · projection · queue · latency) and two were bare adjacent numerics.
  The pass makes each declare its role at a glance — **volume** carries its bucket noun (`399 entities`),
  the **projection** caption ties to the next stage with a `→` + `fan-out`/`deduped` signifier (so it
  can't read as backlog), the **queue** (the only real backlog, brass when concerning) moves into the
  live-state cluster apart from the projection, **latency** stays labeled — plus a once-per-spine **legend**
  and `title=` decode-on-hover. No new tokens; §3 contrast contract held. Net-new affordance → **KB-Lead
  HYBRID classify** (+ any VIZ requirement delta KB-Lead specs). Authored for the Status clarity-pass ask.
- 2026-07-13 — **§9 item 4 IA-home addendum (KB-Design-Lead-2).** This section predates SPEC-0060 and
  assumed the VIZ-7 baseline (oxide set-aside siding + Retry/Dismiss) lives in the standalone
  Status/"The Line" view — that view is now dissolved (deleted entirely in #523) and SPEC-0060 §4
  already routes "stuck/set-aside items" to **Reviews**. Added the explicit cross-reference so the
  IA gap doesn't recur: the baseline lives in Reviews as its own distinct, oxide-toned section,
  separate from Reviews' existing ember decision cards. Resolved for KB-Developer-1's #192
  implementation, which found the backend (`pipelineStatusView`/`pipelineControl`) fully built with
  zero renderer call sites since Status's deletion. Documentation-only amendment (no new visual
  language) — reconciling two already-gated specs, not re-opening GATE 1.
