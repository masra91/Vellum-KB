---
design: VUX-CLIP
implements: SPEC-0060
title: Clipping batch — dynamic-text overflow contract + window minimum size
type: design
status: draft
owners: [KB-Design-Lead-2, Principal]
created: 2026-07-12
updated: 2026-07-12
related: [SPEC-0060, "issue #522"]
gates:
  ai-patterns: approved     # GATE 1 — KB-AI-Detector, 2026-07-13 (PR #535)
  boundaries: not-yet-routed # GATE 2 — KB-QD, routed at dispatch
---

# Clipping batch — the dynamic-text overflow contract

> Wave-2 pre-stage for issue **#522** (P1). Twelve verified clip sites (C1-C12) where dynamic,
> user/agent/library-authored text can exceed its container with no recovery — plus no window
> minimum size, so every site compounds below ~700px. This is a **contract**, not twelve bespoke
> fixes: one small set of rules, applied per site.

## 1. Intent

SPEC-0060 §3 promises "no clipping/overlap" as part of the surface language; it was never made
concrete as a rule any dynamic-text site can be built against. This closes that gap: a single
overflow contract (§2) plus a per-site application table (§3), so the next feature that renders an
unbounded string (a library name, an entity title, a claim) has a pattern to reach for instead of
re-deriving flex/ellipsis behavior from scratch each time.

## 2. The contract (design decision)

Every dynamic-text span falls into exactly one of three treatments — pick by what truncation would
cost the user, not by convenience:

| Treatment | When | Behavior |
|---|---|---|
| **Ellipsis + reveal** | A single-line label where the full value is useful but not required to keep working (titles, filenames, citation names) | `text-overflow: ellipsis; overflow: hidden; white-space: nowrap;` on a flex child that also has `min-width: 0` (the flex default of `min-width: auto` is what defeats ellipsis in a flex row — this is the root cause of C2/C3/C4/C5/C6/C7) — **plus a native `title` attribute carrying the untruncated value.** No custom tooltip component; the browser-native title is sufficient and keeps this a CSS-only fix at every site. |
| **Wrap** | Free text meant to be *read*, not scanned (agent standing-instructions, review notes) | `overflow-wrap: anywhere;` with no `nowrap` override — this is C1: the base `.path` class already wraps correctly at `index.css:73-78`; the agent-instructions site is force-overriding it to one clipped line for no reason anyone can name. Remove the override, don't add a new pattern. |
| **Flip / reflow** | A label anchored to a fixed point that can run past the *viewport*, not just its own container (graph node labels at the edge) | Flip the label to the opposite side of its anchor when it would clip the viewport edge — this is C9 only; it's a layout decision, not a text-overflow one. |

**One naming rule so this doesn't re-fragment per surface:** name the ellipsis-and-reveal pairing
as a single utility, e.g. `.v3-clip` (`min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`), applied alongside the existing `title` attribute at the call site. A future
dynamic-text span reaches for `.v3-clip` + `title`, not a bespoke rule.

## 3. Per-site application (C1-C12)

| ID | Site | Treatment | Note |
|---|---|---|---|
| C1 | Agent instructions (`agentsView.ts:152`, `index.css:1010` vs base `.path:73-78`) | **Wrap** | Remove the one-line override; instructions read as prose, clipping them hides the thing the user most needs to check. |
| C2 | Review candidate title (`reviewsView.ts:312-315`, `index.css:539`) | **Ellipsis + reveal** | Currently `nowrap` with no ellipsis at all and `flex: 0 0 auto` — worst of both: it overflows the card *and* has no truncation. Fix `flex` to allow shrinking (`flex: 1 1 auto; min-width: 0`) before applying `.v3-clip`. |
| C3 | Staged filename (`captureView.ts:59`, `index.css:188-190`) | **Ellipsis + reveal** | Flex child missing `min-width: 0` — the classic cause of "ellipsis CSS is present but does nothing." |
| C4/C5 | Ask conversation + past-chat titles (`askView.ts:318,451-453`, `index.css:559,594`) | **Ellipsis + reveal** | Ellipsis already applied; only the `title` reveal is missing. |
| C6 | Citation button title (`askView.ts:517`, `index.css:645`) | **Ellipsis + reveal** | `title` should show the **display name**, not the raw ref — a raw ref in a tooltip is exactly the kind of internal-id leak the terminology glossary exists to prevent. |
| C7 | Library name in the "you" card (`shell.ts:134-136`, `index.css:294`) | **Ellipsis + reveal** | Same pattern; this is the first-class "you" identity surface (SPEC-0060 §7) so it should look deliberate, not accidentally-clipped. |
| C9 | Explore SVG node labels at the viewport edge (`index.css:842`) | **Flip / reflow** | Detect proximity to the graph's right/bottom bound and mirror the label to the opposite side of the node. Lowest priority of the twelve — Explore is already full-bleed (VUX-15) so this is an edge case, not a everyday occurrence. |
| C10 | Ask past-chats panel cut at narrow widths (`index.css:576` vs `:393`) | **Container fix, not text** | The panel is fixed at 22rem while its ancestor sets `overflow-x: hidden` — below ~22rem+content width the panel itself is what clips, not a text node. Fix: the panel should shrink with its container (`max-width: 100%` inside a `min-width: 0` ancestor chain) before the window-minimum fix in §4 makes 22rem always available; don't paper over it by just raising the window floor. |
| C11 | qcap status note (`qcap.css:149`) | **Wrap or ellipsis** | Qcap is a frameless narrow window (SPEC-0038) — a status note pushing the header is a layout bug, not a text-overflow one. Give the note its own row (`grid-template-rows` already used in `qcap-sheet`, `qcap.css:9`) so a long note wraps within its row instead of widening the header. |
| C12 | No window minimum + non-collapsing rail (`main.ts:26-28`; `index.css:312`) | **Window floor** | See §4. |

## 4. Window minimum size

Set `minWidth: 760, minHeight: 560` on the `BrowserWindow` constructor (`main.ts:26-28`). This is
the floor below which the 13.25rem rail (`index.css:312`) plus a comfortable reading column
(SPEC-0060 §3's clamp-removal intent) can no longer coexist — rather than let every view degrade
unpredictably past that point, stop the window there. **Rail auto-collapse below ~60rem (icon-only
rail) is explicitly a follow-up, not part of this batch** — flagging it here so it isn't lost, per
the issue's own scoping ("optional... as a follow-up").

## 5. Acceptance criteria

- [ ] Every `text-overflow: ellipsis` site carrying dynamic text has a `title` attribute with the
      full, untruncated, **display-facing** value (not a raw internal ref — see C6).
- [ ] No horizontal scrollbar or overlapping text at 760px width on Agents, Reviews, Capture, Ask,
      and the "you" card.
- [ ] A 120-character entity/file/claim name renders contained (ellipsized or wrapped per §2's
      contract) at every site in §3, not just the ones already partially fixed.
- [ ] `.v3-clip` (or equivalent single utility) exists and is the thing new dynamic-text call
      sites reach for — not a re-derivation per view.

## 6. Test cases

An ENG-15/16-style unit per text-emitting call site with a 120-char value, asserting the `title`
attribute is present and equal to the full value, and that the container carries `.v3-clip` (or the
wrap/flip treatment per §3's table). This covers the **ellipsis + reveal** sites (C2-C7) — the other
two treatments need their own test shape, not a reuse of the title-attribute assertion:
- **Wrap** (C1): a unit asserting the agent-instructions container has no `nowrap`/single-line
  override and that a long value actually renders on multiple lines (or at least doesn't truncate).
- **Flip / reflow** (C9): a unit placing a node near the graph's right/bottom bound and asserting
  its label renders on the mirrored side, not clipped at the viewport edge.
- **Container shrink** (C10): a unit asserting the past-chats panel's rendered width tracks its
  container below 22rem, rather than asserting anything about the text nodes inside it.
- **Qcap note wrap** (C11): a unit asserting a long status note doesn't push `.qcap-head` to grow
  (the header row's height stays fixed regardless of note length).

One narrow-width (760px) DL-1 capture across the five named
views.

## 7. Changelog

- 2026-07-12 — created (draft). Pre-staged in `#wave2-ux-prep` while wave-1 is in flight (issue
  #522). Codified the three-treatment overflow contract (§2) so C1-C12 stop being twelve bespoke
  fixes; named the `.v3-clip` utility; ruled C1 is a wrap-override removal (not a new pattern), C6's
  reveal must show the display name (terminology discipline), and C10 is a container-shrink bug the
  window-minimum fix must not paper over. Rail auto-collapse confirmed out of scope (follow-up).
- 2026-07-13 — **GATE 1 (KB-AI-Detector): APPROVED** (one non-blocking typo fixed, §2). Dev-ready
  pending GATE 2 (KB-QD) routing at dispatch.
