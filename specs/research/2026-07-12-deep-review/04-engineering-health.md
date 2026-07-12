# 04 — Engineering Health & Extractability

Deep Review 2026-07-12. Static analysis + read-only CI queries at `origin/main` (`8e8ec5b`). IDs `ENG-1..17` shared with `05-issue-index.md`. This doc also carries the evidence base for the architecture verdict in `00-executive-summary.md` §3.

---

## A. Where the codebase stands (census)

**Tests.** 41,418 prod LOC / 37,429 test LOC (0.90:1); 2,621 `it` blocks. kb 0.88, shell 0.94 (all 19 view modules have colocated happy-dom tests), main 0.64, qcap 0.82. `ipc.test.ts` (851 lines) is a genuine contract test — registers real handlers against a real git vault. e2e: 12 Playwright specs driving the packaged app (smoke, light+dark walkthrough, ask, recall wiring, TCC), `workers:1`, 60s timeout.

**CI (one workflow).** The **only required check** is `typecheck · lint · unit (ubuntu-latest)`. The package build-check (31s) and gitleaks (7s) run on every PR but **red is mergeable**. e2e is label/dispatch-only — zero dispatches in the last 100 runs; `skipped` everywhere sampled. No `schedule:` trigger exists. Full PR round-trip ≈ **3.5 minutes** — there is real headroom to gate more. What green proves: Linux typecheck+lint+units+kb coverage. What it doesn't: the app packages, boots, contains no secrets, works on macOS/Windows, or meets any eval bar.

**Size/modularity.** Only `main/pipeline.ts` (2,089 lines, 50 exports) is pathological; engine grain is healthy (156 modules, ~190 LOC avg). Import graph spot-check: strictly leaf-ward, no cycles. Preload: 71 methods, a thin typed 1:1 channel mirror — the god-object criticism applies to the surface, not the implementation. Churn (90d): pipeline.ts 92 commits, types.ts 67, ipc.ts 57, preload.ts 39 — **every feature pays a four-file tax**, which is the mechanical cause of the god-file.

## B. Findings

- **ENG-1 (HIGH)** — Single required check; the two cheap merge-poison catchers (package build-check, secret scan) don't gate. Fix: add both to the ruleset — config-only, zero new CI cost. AC: a PR with a broken `vite.main.config.ts` external cannot merge.
- **ENG-2 (HIGH)** — The e2e lane never runs (opt-in, rotting by design — and its own promotion plan in `ci.yml` has no trigger that can ever satisfy it). Fix: nightly `schedule:` running the e2e matrix + `package-macos`; auto-file an issue on red; promote `smoke` to required after 7 green nights.
- **ENG-3 (MED)** — No scheduled home for rot-prone checks (visual snapshots, eval scorecards, dep audit, knip). Same nightly vehicle as ENG-2.
- **ENG-4 (HIGH)** — No release pipeline at all: version frozen at 0.1.0, zero tags, zero releases, makers but no publishers, no updater wiring. Fix: tag-triggered make (mac+win) → draft GitHub release; version bumps via `npm version` PR; signing stays env-gated. AC: pushing `v0.2.0` yields a release with artifacts.
- **ENG-5 (MED)** — Coverage floor is kb-only (`vitest.config.ts:26`); main (4,357 LOC) and shell (8,455 LOC) have real suites but no floor; pipeline.ts — the #1 churn file — is exercised via six boundary suites covering ~15 of 50 exports; the six registry-CRUD suites and projection computes lack direct tests. Fix: per-directory thresholds at measured-minus-2%, ratcheted.
- **ENG-6 (MED)** — `strict: false` (only `noImplicitAny`). The flip was **measured at 4 errors** (07-05, same HEAD); today's census corroborates: 8 `: any` in prod, 1 `as any`, ~4 non-null assertions, fully-typed `KbApi`. The 8 `'prop' in x` narrowing workarounds are the visible tax. Fix: flip `strict` in one PR; add `ok` discriminants to the 3 result types lacking them. `noUncheckedIndexedAccess` is a separate, materially larger lift — defer, don't bundle.
- **ENG-7 (MED)** — pipeline.ts god-file: six copy-pasted registry CRUD suites (~850 lines of parallel validate→lock→read→patch→commit→audit). Fix: `makeRegistryCrud<TView,TPatch>` + split into registries/projections/lifecycle modules. AC: <800 lines; a new registry costs a config object. The existing boundary suites are the regression harness.
- **ENG-8 (MED)** — Decider scaffold ×6 with verified behavioral drift: compose calls model-fallback **without `agentKey`** (Settings pin can never target it) and is **absent from `AGENT_CATALOG`** (invisible in the Agents UI); reflect returns **no `AgentTrace`** (ORCH-16 provenance silently missing). Fix: one `runDeciderScaffold` + catalog-completeness and trace-presence tests per decider.
- **ENG-9 (LOW)** — **12** ad-hoc recursive walkers (not 4 as previously recorded) with divergent skip/symlink/depth semantics — a latent bug class and the index migration's blocker-multiplier. Fix: one `walkVaultFiles`; retiring all 12 is the index's acceptance criterion.
- **ENG-10 (MED)** — Dead Status cluster: **2,467 lines** shipping (statusView 604 + its test 692 + lineMotion 138+195 + theLineModel.test 280 + `theLine.css` 558 still imported at `renderer.ts:17` + shims), fully unreachable; `views.ts:42-43` comment falsely claims the mount is retained. Keep `kb/lineStations.ts` (Today's flow-strip uses it). Delete tests in the same PR; run themeCohesion.
- **ENG-11 (LOW)** — 74 exports with zero non-test external references; 312 test-only exports (the deliberate seam idiom — which makes knip-style tooling mandatory before any purge). Fix: knip in the nightly, report-only first.
- **ENG-12 (LOW)** — IPC channel parity (71 preload ↔ 71 handlers) holds by convention only; a preload method without a handler compiles clean and fails at runtime. Fix: a 10-line set-equality test. AC: removing a handler reds CI.
- **ENG-13 (MED)** — The eval lane cannot regress anything: scenarios self-skip without `KB_EVAL=1`; baselines are gitignored and never promoted (no last-known-good exists anywhere); and the judge≠SUT guard — improved since 07-05 — is still **vacuous by default** because `resolveSutModel()` returns the literal placeholder `'copilot-default'` when unset (`eval/runner/judge.ts:29,39-46`), which can never equal the judge id even when the SDK's actual default *is* the judge model. Fix: resolve the real SUT default via `copilotModelProbe` before the equality check; weekly scheduled eval job (BYOA-gated, non-required) uploading scorecards + diffing a committed baseline.
- **ENG-14 (LOW)** — Dependencies: current lines for electron/forge/TS/playwright/vitest. Behind: vite 5 (forge-coupled; schedule with a forge bump), **chokidar 3 → 4 removes the fsevents optional native** (deletes the #247 regression class and one externalize entry). `@github/copilot-sdk` correctly pinned exact. Native handling is exemplary (`vite.main.config.ts:26` externals + AutoUnpackNatives). Zero unused deps.
- **ENG-15 (LOW)** — e2e flake-by-design: fixed sleeps (`walkthrough.e2e.ts:119,141`) instead of terminal-state selectors; smoke asserts an exact copy string.
- **ENG-16 (INFO)** — `renderer.ts:51` "Set up your Knowledge Base" survived scrub #502 and is mutually load-bearing with `smoke.e2e.ts:58` — rename both in one commit (also listed as UX-7).
- **ENG-17 (MED, prospective)** — **better-sqlite3 packaging checklist** for the ratified index: (1) prod dep; (2) externalize in `vite.main.config.ts` (`.node` cannot bundle — the exact fsevents failure mode); (3) assert `app.asar.unpacked/**/better_sqlite3.node` in the package job; (4) the ubuntu package job becomes the ABI-rebuild canary; there is **no Windows CI leg** — add to the nightly; (5) dual-ABI hazard: vitest runs under Node, the packaged module under Electron — wrap the index behind an interface with an in-memory fake for unit tests (preferred; also preserves engine purity); (6) verify `.node` signing in a `KB_OSX_SIGN=1` build pre-release; (7) the index is a rebuildable cache under `.kb/cache/`, gitignored — vault portability and git-canonical truth untouched.

## C. Extractability (the verdict's evidence base)

**Engine↔Electron coupling: zero.** `from 'electron'` across `src/kb` (156 modules, 29.8k LOC): **0 occurrences** — every hit is a comment asserting shell-agnosticism (STACK-6 discipline); Electron-shaped needs are structural interfaces main injects. kb→main imports: 1, test-only. `pipeline.ts`: 0 Electron imports, direct or transitive — 100% pure orchestration. `src/shell`/`src/qcap`: 0 (world reached only via `window.kbApi`). **The engine can run in a plain Node daemon today** modulo a config-dir shim (2 files use `app.getPath('userData')`) and a transport.

**Seam quality:**
| Seam | Coupling today | Cost | Notes |
|---|---|---|---|
| Engine → plain Node lib | none | **S** | already true |
| Engine-as-daemon (headless-run) | 71 request/response channels, **0 push**; ~8-10 OS-bound channels (dialog, clipboard, screenshot, `obsidian://`, system-settings deep-links) stay app-side | **M** | `ipc.ts` bodies = server, `KbApi` = IDL; poll-freshness ports unchanged; build push on the daemon transport |
| Renderer framework swap | `window.kbApi` at 3-13 sites/view; no shared store; event-shaped cross-view state | **L** big-bang / M per view | rewrites 8.5k prod + invalidates ~8k test LOC; pure models survive; **buys little** |
| SQLite index slot-in | `ProjectionStore<T>` is exactly the slot; 12 walkers to retire | **S-M** (+ENG-17) | index as projection sibling; no consumer contract changes; git write path untouched |
| Git behind a full VaultStore interface | 40 `simple-git` imports, all via the boundedGit choke-point | **L** | mechanical; only needed if git-as-truth were revisited — it should not be |
| Full rewrite | — | **XL** | see below |

**Rewrite calculus.** Crown jewels verified by reading, not reputation: `canonicalAdvance.ts` (optimistic lock; allowlist-guarded reaping; stale-lock heal inside the acquire; every git call bounded — multi-writer git done carefully, encoding ~15 fixed incidents), `canonicalLockHeal.ts` (triple-gated), `audit.ts` (one envelope + a **CI-enforced emitter-coverage gate** a rewrite would silently lose), `recall.ts` citation verification, `selfRepair.ts` (parse-only repair boundary from #256), `pathContainment.ts` (Class-A/B separation encoding three fixed injection bugs) — plus 37.4k lines of tests encoding the behaviors. A rewrite would buy strict-from-day-1 (~4 compiler errors today), a query read path (achievable as a projection), a registry framework (~850 lines), and ~2.5k dead lines — generously **~5-6k LOC of liability, all addressable by targeted refactor** — against losing ~30k LOC of incident-hardened engine + the tests + the gates. It would spend the budget re-earning the scars, not escaping them.

## D. Recommendations (feed `05-issue-index.md`)

1. Make green mean something (ENG-1/2/3/5/12): require the two already-running jobs, one nightly lane, coverage floors, channel-parity test. Near-zero new per-PR cost.
2. Flip `strict: true` now (ENG-6) — the cheapest high-value change in the repo.
3. Fund the two dedup refactors (ENG-7 registry CRUD, ENG-8 decider scaffold) — the second fixes two user-visible defects (compose un-pinnable/invisible; reflect provenance-less) as side effects.
4. Delete the Status cluster (ENG-10) and adopt the walker consolidation (ENG-9) as the index's on-ramp.
5. Resurrect the eval lane (ENG-13) before the index migration — equivalence testing is the migration's safety net and deserves a working scorecard.
6. Stand up release slice 1 (ENG-4); the packaged-app class of bugs (TCC, natives, signing) is otherwise invisible until a human runs a build.
