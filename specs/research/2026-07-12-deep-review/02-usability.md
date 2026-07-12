# 02 — Usability & Visual Quality (v3 vs the mock)

Deep Review 2026-07-12. Static analysis at `origin/main` (`8e8ec5b`) against the visual source of truth `design-prototypes/vellum-v3.html` (SPEC-0060) and terminology law (`specs/design/terminology.md`). Finding IDs `UX-1..16` shared with `05-issue-index.md`.

**Headline:** the v3 rebuild is real view-by-view; the **connective tissue is not**. The top bar is inert chrome, ten surfaces cold-start on bare "Loading…" against a spec that mandates skeletons (VUX-6 must), the shared warming/error faces every view falls back to are still v2, the window ships native chrome the mock designed away, and a live Dark toggle drops users into a half-dark patchwork because the ~30 v3 tokens were never re-pointed. Each Principal-reported pain — (a) old UI shows up, (b) top bar isn't there, (c) clipping, (d) motion inconsistent/missing — traces to concrete code below.

---

## The four pains, chased down

### (b) "The top bar isn't there" → UX-1 + UX-4 — **P0**
- **UX-1 — the bar is a facade.** It renders (`app/src/shell/shell.ts:51-58,128`), but `#globalSearch` is a `<button>` styled `cursor:text` like an input (`index.css:259-262`); ⌘K and click only `.focus()` it — typing inserts nothing, Enter re-clicks the button. The per-view contextual slot `#topctx` is cleared on every switch (`shell.ts:177`) and `setTopbarContext` (`shell/nav.ts:33`) has **zero callers**; `.topctx:empty{display:none}` (`index.css:272`) means the slot never visually exists. The mock fills it per view (`vellum-v3.html:1301-1306`: Explore = Filters/type/confidence chips, Activity = "All activity", Health = "Re-scan", Agents = "Add a researcher"). VUX-3 (must) is chrome-only today.
- **UX-4 — native title bar above the themed bar.** `main.ts:26-31` creates a default-frame `BrowserWindow`; the mock integrates traffic lights into the warm bar (`vellum-v3.html:60-68`). Shipped, a stock macOS title bar sits above the beige `.bar`, which then reads as a second toolbar — a plausible root of the "isn't there" perception in itself.
- **Fix (one "top bar is real" PR):** real `<input>` + minimal results overlay for ⌘K (entity-prefix match over the Explore projection is enough for v1 — or remove the pill until search exists; a permanently dead affordance is worse than none); wire the four ctx fillers via each view's mount; `titleBarStyle:'hiddenInset'` + tuned `trafficLightPosition` + `.bar` as drag region.
- **AC:** every rail view fills `#topctx` or is on a documented-empty list; ⌘K puts a caret in a field that accepts text and Enter does something observable; one chrome band with traffic lights centered in the bar.

### (d) "Motion for progress/loading is inconsistent and missing" → UX-2, UX-3, UX-10, UX-11 — **P0/P1**
- **UX-2 — ten bare "Loading…" surfaces** (`sourcesView.ts:40`, `settingsView.ts:72`, `researchersView.ts:58`, `activityView.ts:220`, `exploreView.ts:61`, `todayView.ts:47`, `jobsView.ts:27`, `agentsView.ts:19`, `askView.ts:413`, + the Agents hub stacking **three at once** for up to 8s, `agentsHubView.ts:61-65`) vs VUX-6 (must): "no blank async — skeletons while loading." Only Reviews and Ask in-flight have skeletons. Zero spinner primitives exist anywhere — which is correct per the mock's loom/churn language; the gap is skeletons.
- **UX-3 — the shared warming/error faces are v2** — legacy `.card` + `.btn` + `--viz-ink-muted`, copy "Still preparing your knowledge graph" (`shell/loadGuard.ts:108-123`). These are what Today/Explore/Health show on every cold start or failure: the old UI literally appears whenever the app is slow.
- **UX-10 — async triggers without pending state:** Capture's "Keep it" does nothing visible while in flight (double-capture risk, `captureView.ts:199-226,258`); Health remediation, Settings replay, Agents model select are disable-only. Good exemplars exist (`.viz-btn--busy` breathe on Sources/Jobs/Researchers).
- **UX-11 — no exit motion:** the mock resolves a review with a 280ms fade/lift (`vellum-v3.html:700-702,810`); shipped rows vanish synchronously (`reviewsView.ts:365-369`), Health dismiss likewise.
- **Proposed motion system (one PR-sized design-system change):**
  - Tokens: `--dur-quick: .18s` (alias `--t` and `--viz-dur-quick`, which are today the same value under two names), `--dur-state: 240ms` (crossfades, list exit), `--dur-settle: 340ms` (entrances — already `shellFadein`'s value), `--dur-breathe: 1.8s`; easings stay `--e-out`/`--e-spring`.
  - Primitives: (1) one `.skel` shimmer block + one `@keyframes shimmer` (dedupe `rev-shimmer`/`askShim`); (2) `.vmark.loom/.churn` as the only "working" marks; (3) `.is-busy` button state (port `.viz-btn--busy`); (4) `.is-leaving` exit; (5) `paintSkeleton(container, 'cards'|'rows'|'prose')` helper in `loadGuard.ts` + restyled v3 warming face.
  - Law: skeleton on first frame at mount; >3s → warming face; every async trigger flips `.is-busy`; no spinners; `prefers-reduced-motion` collapses everything (existing resets already thorough).
- **AC:** `grep '>Loading…<' app/src/shell` returns 0; every view's cold face is a shaped skeleton with a loom/churn status line; every async trigger shows a within-100ms state change.

### (c) "Visual clipping in areas" → UX-6 — **P1**
Clipping census (dynamic content only):
| # | Where | What clips | Fix |
|---|---|---|---|
| C1 | `index.css:1010` + `agentsView.ts:152` | agent instructions forced to one clipped line — overrides base `.path` wrap, no title | drop override or title |
| C2 | `index.css:539` + `reviewsView.ts:312-315` | candidate source title: `nowrap`, **no ellipsis**, `flex:0 0 auto` → overflows the card | `min-width:0` + ellipsis + title |
| C3 | `index.css:188-190` + `captureView.ts:59` | staged filename — flex child missing `min-width:0` | `min-width:0` + `title` |
| C4/C5 | `index.css:559,594` + `askView.ts:318,451-453` | conversation/past-chat titles ellipsized, no revealing title | title attrs |
| C6 | `index.css:645` + `askView.ts:517` | citation ref title shows `c.ref`, not display name | title = display name |
| C7 | `index.css:294` + `shell.ts:134-136` | library name in the "you" card | append to `.user` title |
| C8 | `index.css:271` | future topctx chips hard-clip | design slot overflow with UX-1 |
| C9 | `index.css:842` | Explore SVG node labels clip at viewport edge | label-side flip near edges |
| C10 | `index.css:576` vs `:393` | Ask past-chats panel (22rem) cut at narrow widths | with C12 |
| C11 | `qcap.css:149` | qcap status note `nowrap` pushes the header | ellipsis + title |
| C12 | `main.ts:26-28` + `index.css:312` | **no window `minWidth`**; rail fixed 13.25rem never collapses — everything above compounds <~700px | `minWidth:760, minHeight:560` |
**AC:** every `text-overflow:ellipsis` carrying dynamic text has a `title` revealing the full value; no horizontal scroll or overlap at 760px. Test per the ENG-15/16 bar: render each emitter with a 120-char value.

### (a) "Old UI still shows up" → UX-3, UX-7, UX-8, UX-9, UX-12, UX-14, UX-16 — **P1/P2**
Remnant inventory (surface × reachability):
| Surface | Reachable via | What looks old |
|---|---|---|
| Warming/error faces | any slow/failed load | v2 card/btn + "knowledge graph" copy (UX-3) |
| First-run setup | fresh install | legacy `.card`, emoji glyphs, banned copy (`renderer.ts:44-93`) |
| Permission gate | TCC-protected vault | full `--viz-*` sheet + "vault" headlines (`permissionGate.ts:19,32,45`) |
| qcap sheet | every menubar capture | 100% v2 flat-instrument language (`qcap.css`) — a daily-touch surface where the same "capture" verb has two visual identities (UX-8) |
| About panel | Help/About | `--viz-*` sheet |
| Status/"Line" cluster | **unreachable** | 604-line view dead; its 558-line `theLine.css` still bundled (`renderer.ts:17`); `views.ts:42-43` comment falsely claims the mount is retained (UX-9; full delete list in `04` §ENG-10) |
| Settings `<dl>` terms | Settings | uppercase v2 `dt` + "Vault path" label |
| `.viz-signage`/`.viz-btn` UPPERCASE | Today decision/health titles, Activity labels, TRACE/RETRY buttons | v2 instrument shouting inside v3 surfaces (UX-12) |
| Activity controls/empty | Activity | bare v2 fields vs the mock's designed search/filter/count band and designed empty state (UX-14) |
| Sidebar/rail + 5 sheets | always | still on `--viz-*` names (sanctioned carry-forward, but blocks VUX-1 completion; UX-16) |

**Terminology stragglers (UX-7, P1 — law, trivial):** `permissionGate.ts:19,32,45` ("vault folder", "Your vault is in iCloud Drive"), `settingsView.ts:141` ("Vault path"), `renderer.ts:51,53-54` ("Set up your **Knowledge Base**", "git-versioned vault") — note `renderer.ts:51` is mutually load-bearing with `smoke.e2e.ts:58` (exact-string assert): rename both in one commit. Verify whether `kb/audit.ts:388-424` actor strings ("into the KB") reach any surface.

### Dark mode → UX-5 — **P1 (the funded re-point, scoped)**
Settings ships a **working** Light/Dark toggle (`settingsView.ts:150-153,358-368`; applied pre-paint) but the ~30 unprefixed v3 tokens (`design-system.css:318-335`) have **no `[data-theme='dark']` block** — dark re-points only the legacy `--viz-*` and `--bg/--card` sets, so every v3 view renders light-literal linen inside dark chrome. 18 color-hue tokens need re-pointing; ~60 hand-coded hexes must convert to tokens first (worst offenders enumerated: top-bar/sidebar gradients `index.css:256,318`, `.user :288`, capture submit `:179-180`, quickadd `:278`, Explore center `:883-885`, agent avatars `:998`, Today glyph washes `:1434-1471`, review-confirm `:527-528`, flow strip `:1389`). Until it lands, the toggle is a visible path to a broken-looking app — hide it or label "(preview)".
**AC:** flipping Dark yields no light-literal card/pill on any rail view; themeCohesion extended to assert a dark counterpart for every v3 color token; DL-1 dark sweep per view.

---

## Other findings

- **UX-13 — Agents hub vs mock (VUX-17 must):** no drill-in anywhere, no paused card state, thin cards (`agentsView.ts:142-155` vs mock `#agent-detail` + `.ag-drill` cue). Either schedule the drill-in slice (needs the run-history store SPEC-0061 flags) or formally de-scope VUX-17 — currently it's an unacknowledged spec violation.
- **UX-15 — a11y quick pass:** genuinely good reduced-motion coverage and rail aria. Gaps: `--faint` (#9a927e on linen ≈ 2.8:1) used for sub-0.8rem text (timestamps, hints, kbd) — below AA; view swaps have no `aria-live` announcement; the fake-input search button misleads AT (fixed by UX-1); a few interactive elements rely on the UA focus ring — verify it isn't suppressed.
- **Top-bar contract table** (shipped vs mock) and the full motion inventory live in the review working notes; the per-view summary: **every** view currently has an empty ctx slot and an inert search; mock expects ctx chips on Explore/Activity/Health/Agents.

## Execution order (matches issue priorities)
1. UX-1 + UX-4 — one "top bar is real" PR (P0).
2. UX-2 + UX-3 + motion tokens/primitives — one loading-language PR (P0; biggest per-pain payoff).
3. UX-6 + C12 — clipping batch (P1).
4. UX-7 — lexicon stragglers incl. the e2e-coupled rename (P1, trivial).
5. UX-5 — the funded dark re-point (P1).
6. UX-8 + UX-9 + UX-16 — old-UI retirement: qcap reskin, sheet re-tokens, Status-cluster deletion (P1/P2).
7. UX-10 + UX-11 + UX-12 + UX-14 — v3 conformance polish batch (P2).
