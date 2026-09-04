# A9 — Visual / Runtime QA

Packaged build of `origin/main @ 19bb68f`, macOS, seeded git-backed vault.
Evidence: 22 screenshots (`A8_e2e_local/shots/`), `e2e_output.txt` (5 failed / 2 skipped / 7 passed), 5 Playwright error-context DOM snapshots.
Structured findings: [`A9_visual_qa.json`](./A9_visual_qa.json).

**Headline:** the app boots and renders all ten rail views plus the showcase in both themes with no fail-to-load, stuck spinner or unthemed patch — the failure class this harness exists to catch is absent. One substantive product defect (Today reports an empty library), a cluster of internal-detail leaks into shipped copy, and a harness soundness problem that makes most of the sign-off frames unjudgeable. No P0.

---

## Per-view

| View | Light | Dark | Principal notes |
|---|:--:|:--:|---|
| today | ✗ | ✗ | All four headline counters read **0 / stable** on a populated library (VIS-1). Says "The pipeline is idle" while Agents shows every librarian Running (VIS-11). `today-light` is the only fully-settled light frame. |
| ask | ✓ | ✗ | Empty state well-composed and lexicon-clean. Dark hero body copy sits at low contrast — confounded by the mid-fade capture, moderate confidence. Grounded answer + citations confirmed correct in the error-context DOM. |
| capture | ✓ | ✓ | Clean composer, good parity. Both frames mid-fade so fine detail unjudged. |
| reviews | ✓ | ✓ | Correctly populated from the seed; strong decision-shaped copy. Graph jargon "node" in the question itself (VIS-19). |
| explore | ✗ | ✗ | Graph correct (focal + 4 confidence-weighted neighbours). Bottom node's confidence clipped and covered by the legend pill; raw `TYPE/PROJECT` tag chip (VIS-15). Best top-bar context in the app. |
| activity | ✗ | ✗ | Five rows read "Enrich noted a signal on **01M1P1H3…**" — raw ULIDs (VIS-10). "Trace by id" + repeated dead "TRACE ORIGIN" column + duplicated filter (VIS-17). Watermark crosses nav labels in dark (VIS-9). |
| health | ✗ | ✗ | Finds exactly the 3 seeded issues. Rows render as three ragged shrink-to-fit boxes (VIS-8); footnote ships "**land in a later slice**" (VIS-4); raw vault path + "(no node)". **Captured settled in both themes** — defects are real. |
| agents | ✗ | ✗ | Seven `kb/*Agent.ts` source paths shipped as user-visible chips, twice each (VIS-2). Header "runs as: claude-opus-4.8" contradicts every card (VIS-6). "No jobs available — open a library" with a library open (VIS-5). |
| connectors | ✓ | ✓ | Correct shared-primitive empty state. Sparse for a top-level rail slot post-SPEC-0060, but correct. |
| settings | ✗ | ✗ | "Library path" chip wraps into two mismatched background fragments in both themes (VIS-14). Appearance + Autonomy sections well-written. |
| showcase | ✓ | ✓ | **Captured settled in both themes** — the best evidence in this run that the dark token layer is genuinely sound across the full button matrix. Internal dev route shipped in the packaged binary with internal prose (VIS-12). |

Rail chrome is correct on all 20 frames: ⌘K search present, **Manage** group present with exactly Agents / Connectors / Settings, brand mark and Quick add stable.

---

## e2e failure classification

| Spec | Class | Why | Current selector / copy | Source |
|---|---|---|---|---|
| `activity.e2e.ts` | **TEST-DRIFT** | DOM snapshot shows the empty state fully rendered: *"Nothing has happened yet."* / *"As your library captures and connects, what it does shows up here."* `.activity-empty` was replaced by the shared `emptyState()` primitive (#406); `activityView.test.ts:135` already documents the swap. | `.viz-empty__title` / `.viz-empty__body` | `app/src/shell/views/activityView.ts:307` |
| `ask.e2e.ts` | **TEST-DRIFT** | DOM snapshot shows the complete grounded answer — *"Ada Lovelace is regarded as the first computer programmer."* + `link "Citation 1"` + a References block + "Save to Library". `.ask-transcript` does not exist anywhere in `src/`. | `#askTranscript` (`.ask-col`); refs are `.ask-refs`, not `.ask-citations` | `app/src/shell/views/askView.ts:99` |
| `jobs.e2e.ts` | **TEST-DRIFT** | DOM snapshot shows the hub mounted per WS-E: `heading "Agents"`, `region "Librarians built-in"` with all 7 articles, `heading "Schedules"`, `region "Researchers"`. Earlier rail assertions passed. `.agents-hub-title` no longer exists. (The next line, `.job-sub`, would likely have failed too.) | `.ag-top > h1` = "Agents" | `app/src/shell/views/agentsHubView.ts:25` |
| `smoke.e2e.ts` SETUP-1 | **ENVIRONMENT** | Setup wizard rendered correctly and the `backgroundColor` assertion passed, so both PERF-R5 window options are right in the shipped build. The failing line polls `isVisible()` **once**, right after `domcontentloaded`, but `show()` fires off `ready-to-show` — strictly later. Racy by construction; run notes record CPU saturation. Fix: `expect.poll`. | `mainWindow.once('ready-to-show', () => mainWindow?.show())` | `app/src/main.ts:72` |
| `walkthrough.e2e.ts` | **ENVIRONMENT** | The body **succeeded** (`[walkthrough] wrote 22 screenshots`); the shared 60s budget expired during `afterEach`. `playwright.config.ts:16` sets one global `timeout: 60_000` with no per-test override, while the body drives a packaged app through 22 captures (reported at 1.1m). Quit path itself looks sound — `stopPipelineForQuit` races the flush against a 2000ms unref'd timer (`pipelineLifecycle.ts:616-628`). A seeded git-backed vault does make teardown slower than the minimal-vault specs, so a slow-quit contribution can't be fully excluded, but the budget is the proximate cause. Fix: `test.setTimeout()`. | `timeout: 60_000` on a 22-capture walkthrough | `app/playwright.config.ts:16` |

**3 of 5 are stale selectors against refactors that already landed and are covered at the component tier. 2 of 5 are flaky-by-construction harness bugs. None indicates a shipping regression.**

---

## Findings by severity

| ID | Severity | Title | Blocking |
|---|:--:|---|:--:|
| VIS-1 | **P1** | Today reports an empty library (0/0/0/0) on a fully populated one | **yes** |
| VIS-2 | **P1** | Agents ships `kb/*Agent.ts` source paths as user-visible chips, ungated | **yes** |
| VIS-3 | **P1** | Rail "You" card shows the raw vault folder basename on every screen | **yes** |
| VIS-4 | P2 | Health footnote ships "…land in a later slice" | no |
| VIS-5 | P2 | Schedules empty state says "open a library" while one is open | no |
| VIS-6 | P2 | "runs as: \<model\>" contradicts every per-agent card, never refreshes | no |
| VIS-7 | P2 | Gate-of-record screenshots capture mid-transition | no |
| VIS-8 | P2 | Health finding rows render as three misaligned shrink-to-fit boxes | no |
| VIS-9 | P2 | Dark rail watermark crosses nav labels and bleeds off-canvas | no |
| VIS-10 | P2 | Activity prints raw truncated ULIDs as the human summary | no |
| VIS-11 | P2 | Today "idle" vs Agents "Running"; "pipeline" in user copy | no |
| VIS-12 | P3 | `#showcase` dev route ships in the packaged binary | no |
| VIS-13 | P3 | Five views bypass the shared empty-state primitive | no |
| VIS-14 | P3 | Settings "Library path" chip wraps into two mismatched fragments | no |
| VIS-15 | P3 | Explore clips a node's confidence under the legend pill | no |
| VIS-16 | P3 | Top-bar per-view context on only 4 of 10 views *(not well-scoped — needs a design ruling)* | no |
| VIS-17 | P3 | Activity trace controls require internal ids; dead "TRACE ORIGIN" column | no |
| VIS-18 | P3 | Remaining "KB" / "Knowledge Base" leaks (`.kb-processed`, folder-picker title) | no |
| VIS-19 | P3 | Graph vocabulary "node" in user copy across three views | no |

---

## Caveat on this run's confidence

`--dur-settle` is **340ms** (`index.css:499`) and the nav-item crossfade **180ms** (`index.css:431`), but `walkthrough.e2e.ts:133` screenshots as soon as `aria-busy` detaches with no settle wait. **14 of 20 rail frames are captured mid-fade** — main panes at ~15–25% opacity, and in four dark frames two rail items appear selected at once (the outgoing item's `aria-current` background still fading). Those artifacts are *not* product defects.

Judgements below are therefore graded: **VIS-1, 2, 4, 5, 6, 8, 10, 12, 14, 17, 18, 19** rest on settled frames or on source, and are high confidence. **VIS-9** (watermark) and the ask-dark contrast note are provisional and should be re-judged after VIS-7 is fixed. Recommended fix: set `prefers-reduced-motion` in the harness context — `index.css:511` already disables `shellFadein` under it, making capture deterministic.
