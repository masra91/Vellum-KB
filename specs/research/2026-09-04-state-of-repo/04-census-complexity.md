# A2 — Measurement Census: complexity, import graph, module stats

Method: TypeScript compiler API (`typescript@5.9.3`, from `app/node_modules/typescript`) walking every
`.ts` file under `app/src` excluding `*.test.ts`/`*.d.ts` (237 prod files). Cyclomatic complexity (CC) =
1 + count of `if`/`else if`/`for`/`for-of`/`for-in`/`while`/`do`/`case`/`catch`/`&&`/`||`/`??`/`?:`/optional-chain
operators inside the function body (nested function bodies excluded from the parent's count and counted
separately). Full data: `A2_census_complexity.json`. Snapshot: origin/main @ 19bb68f.

## (a) Function complexity

- **3,313 named/anonymous function bodies** analyzed across 237 files.
- Distribution: CC≥10: **153** (4.6%) · CC≥15: **59** (1.8%) · CC≥25: **14** (0.4%) · CC≥40: **2** (0.06%).
- Per-directory averages (avgCC / avgLOC / avgMaxDepth / functionCount):
  - `kb`: 3.13 / 10.9 / 0.96 — **1,988** functions (maxCC 78, maxLOC 418)
  - `main`: 2.68 / 10.1 / 0.80 — **451** functions (maxCC 26, maxLOC 656)
  - `shell`: 2.75 / 11.0 / 0.79 — **741** functions (maxCC 23, maxLOC 228)
  - `qcap`: 2.41 / 15.9 / 0.88 — **17** functions (maxCC 10, maxLOC 168)
  - root (`main.ts`/`preload.ts`/`renderer.ts`): 1.28 / 3.0 / 0.18 — **116** functions
- **The two CC≥40 outliers:**
  - `prepare` in `app/src/kb/connectStage.ts:599` — **CC 78**, 365 LOC, depth 7, 1 param. By far the single
    most complex function in the codebase (next-highest is 48; median CC≥25 function is ~27). Confirmed
    real (not generated/table code) — it's the per-block connect prepare/decide/write critical path:
    disambiguation-decision replay, directive matching, merge/split branches, retry/set-aside handling,
    all inline in one closure.
  - `reconcileWatchFolder` in `app/src/kb/watchRun.ts:151` — **CC 48**, 177 LOC, **depth 10** (deepest
    nesting of any function measured), 3 params.
- Top 5 by LOC (not all high-CC — several are flat registration/factory bodies):
  `registerIpc` (`main/ipc.ts:193`, 656 LOC, CC 1) · `connectOne` (`kb/connectStage.ts:577`, 418 LOC, CC 1)
  · `prepare` (`kb/connectStage.ts:599`, 365 LOC, CC 78) · `startPipeline` (`main/pipelineLifecycle.ts:327`,
  267 LOC, CC 7) · `makeReadOnlyTools` (`kb/recallTools.ts:121`, 259 LOC, CC 1).
  `registerIpc` alone is **656 of `ipc.ts`'s 860 lines (76%)** — one function registering all IPC handlers.
- A second complexity cluster sits in `app/src/main/registries/*ControlPanel.ts` (config-patch validators):
  `setResearcherConfig` CC 26, `setWatchFolder` CC 24, `setIntakeConnectorConfig` CC 20, `patchExisting`
  CC 21, `insertNew` CC 19 — see finding CENSUS-2 below, this whole cluster has zero test execution.

## (b) Import graph

- 237 internal modules; longest acyclic dependency chain: **31 modules** deep
  (`main.ts → ipc.ts → pipeline.ts → pipelineProjections.ts → pipelineLifecycle.ts → researchWiring.ts →
  … → kb/workDepth.ts`).
- Electron imports (by design should be main-process-only): **root: 2** (`main.ts`, `preload.ts`), **main: 8**
  (`appConfig`, `conversationStore`, `ipc`, `quickCaptureElectron`, `quickCaptureScreenshot`, `quiesceTray`,
  `trayIcon`, `trayMenu`). **kb: 0, shell: 0, qcap: 0** — confirms the established "kb has zero Electron
  imports" claim independently via AST, not grep.
- Top imported (fan-in, "hub" modules): `kb/types.ts` (42) · `kb/devlog.ts` (33) · `kb/stageLock.ts` (29) ·
  `kb/researchers.ts` (24) · `kb/audit.ts` (23) · `kb/ulid.ts` (22) · `shell/html.ts` (22) ·
  `kb/canonicalAdvance.ts` (19) · `kb/jobs.ts` (19) · `shell/loadGuard.ts` (14).
- Top importing (fan-out, "god modules"): `main/pipelineLifecycle.ts` (**41**) · `main/ipc.ts` (33) ·
  `main/pipeline.ts` (33) · `main/pipelineProjections.ts` (28) · `kb/connectStage.ts` (26) ·
  `shell/shell.ts` (22) · `kb/types.ts` (20) · `kb/claimsStage.ts` (17) · `kb/composeStage.ts` (17) ·
  `main/registries/researchersControlPanel.ts` (16).
- **Cycle detection, corrected for type-only imports**: a naive SCC pass over *all* import edges (including
  `import type`) finds one 43-file strongly-connected component spanning most of `kb/`. Re-running with
  type-only edges excluded (the practically meaningful question — `import type` never creates a runtime
  cycle, and `kb/types.ts` is a pure type-aggregator hub pulling `import type` from ~19 files, which is what
  manufactures that 43-file "cycle") drops this to **exactly one real 2-file value-import cycle**:
  `kb/researchFetch.ts ⇄ kb/researchWebAgent.ts` (`researchFetch` imports `isPublicHost`/`isAllowedUrl` from
  `researchWebAgent`; `researchWebAgent` imports `makeGatedFetch`/`GatedFetchResponse` back). Small, almost
  certainly load-order-safe in practice, but genuinely circular and worth a one-line note (CENSUS-6).
  **The type-discipline (near-universal `import type` for cross-module type references) is a real strength** —
  it is what keeps a 165-file engine with a 42-fan-in shared types module from actually being a circular mess.

## (c) Export census

- **1,758 total exported symbols** (functions/classes/interfaces/types/enums/consts/re-exports) across 237
  files, via AST (not text grep).
- Cross-referenced against `A5_knip_report.txt`: **~30 unused exported values, 51 unused exported types, 3
  duplicate exports** (knip). Spot-verified 6 by hand-grep across all of `app/src` (`buildAppearanceConfig`,
  `watchLedgerPath`, `refreshStatusSnapshot`, `listActiveReviews`, `VIEW_JOBS`, `controlsHtml`) — all
  confirmed genuinely unreferenced outside their own file (`listActiveReviews` in particular has zero call
  sites anywhere, including tests — pure dead code). The "duplicate exports" are intentional aliases
  (`archivist.ts`: `deterministicDecider = deterministicDecide`; `researchers.ts`: `MAX_TOOL_CALLS =
  RESEARCH_INSTANCE_CEILING`), not accidental duplication — non-issue.
- 1,758 exports / 3,313 functions ≈ every other function is exported, consistent with the file-per-concern
  style (most files are small, single-purpose modules re-exported by name rather than hidden behind a facade).

## (d) Test:prod pairing

- 237 prod files, **46,347 prod LOC**; 236 test files, **43,879 test LOC** → ratio **0.947** test:prod LOC
  (matches the orchestrator's reported 0.95:1).
- **197 prod files have a colocated `X.test.ts`; 40 do not; 39 test files have no 1:1-named prod module**
  (i.e. many tests are scenario/boundary-named rather than file-mirrored — e.g. `pipelineStartupOrder.test.ts`,
  `quiesceBoundary.test.ts`, `lifecycleDeleteBoundary.test.ts` exercise `main/pipeline.ts` +
  `pipelineLifecycle.ts` without being named after either).
- Of the 40 prod files with no colocated test, cross-checking actual test-file imports (not just filename
  pairing) found **17 with zero reference from any test file at all**, most notably the entire
  `app/src/main/registries/*ControlPanel.ts` cluster (8 files + `registryCrud.ts`, 1,085 LOC combined) — see
  CENSUS-2.
- Lowest test:prod LOC ratio (least-tested-relative-to-size, excluding zero-test files): `m365MailConnector.ts`
  0.35 · `watchConnectors.ts` 0.38 · `reviews.ts` 0.40 · `audit.ts` 0.42 · `jobs.ts` 0.42.
- Highest ratio (most heavily tested relative to size): `replay.ts` 2.60 (208 prod / 540 test) ·
  `reflectJob.ts` 2.24 (216/483) · `executeApprovedConsolidation.ts` 2.13 (106/226) · `gitHeadFast.ts` 2.38.

## (e) `index.css`

- 1,705 lines, **857 rule blocks / 920 individual (comma-split) selectors**, 901 of which contain ≥1 class
  selector, referencing **583 distinct class names**.
- 13 `@`-rules: 9 `@media`, 4 `@keyframes`. **Zero `@media (prefers-color-scheme)` blocks** — confirmed by
  grep and by the file's own header comment: SPEC-0057 fixed the shell to fixed-light-only, superseding the
  earlier OS-dark-mode tracking; dark mode is opt-in via `:root[data-theme='dark']` only (10 such blocks,
  mostly 1-line overrides plus one 11-line block at the top).
- `index.css` itself defines only **8 `--custom-property` tokens** (`--bg/--card/--fg/--muted/--accent/
  --border/--error/--hover`) — all 8 are referenced via `var()`. This is *not* the full design-token set:
  `index.css` is loaded *after* `app/src/shell/design-system.css` (462 lines, **77 tokens**, the `--viz-*`
  foundation + semantic aliases like `--slate`/`--gold`/`--viridian`) in `shell/appRoute.ts`'s import order,
  and index.css's 8 tokens are a small shell-chrome layer mirroring a subset of design-system's palette by
  hardcoded hex (with a comment cross-referencing which `--viz-*` each matches) rather than deriving from it
  via `var()`. Two-file token architecture, not a bug, but worth knowing before reading "8 tokens" as the
  whole story — see CENSUS-7.
- **51 of 583 classes referenced in `index.css` have no textual match anywhere in `app/src/**/*.ts`
  (non-test) or `app/index.html`** — candidate unreferenced/dead CSS. List in JSON; notable clusters:
  10 `explore-*` classes (`explore-center`, `explore-neighbor-row`, `explore-sub-*`, …), 11 `gl--*` glyph
  classes (`gl--capture`, `gl--claim`, `gl--compose`, …), a `src-mark--*` trio. This is a *textual* absence
  check (string search, not a real CSS-usage analyzer — misses class names built via template-literal
  concatenation, e.g. `` `gl--${kind}` ``), so treat as a candidate list, not a certified-dead list — the
  `gl--*` and `src-mark--*` families in particular look exactly like the kind of name that's built from a
  runtime variable rather than written literally (worth a 10-minute follow-up grep for the template-literal
  prefix, not a blind delete).

## (f) Git churn (2026-05-30 → 2026-07-13, 506 commits on `origin/main`)

- Top files by commit count: `main/pipeline.ts` **102** · `index.css` 87 · `kb/types.ts` 71 · `main/ipc.ts`
  62 · `preload.ts` 43 · `specs/INDEX.md` 38 · `kb/connectStage.ts` 36 · `main/ipc.test.ts` 33 ·
  `shell/views/researchersView.ts` 30. `pipeline.ts` is the single hottest file in the repository's history
  by a wide margin.
- Per-ISO-week commits: W22:22, **W23:257** (peak, matches established fact), W24:68, *(W25: 0 — a full
  gap week between the two waves)*, W26:113, W27:3, W28:42, W29:1 (last commit 07-13 lands in W28's tail /
  W29's start — 506 total commits, 783 files added, 69 deleted; overall reclamation ratio (deleted/added)
  **0.088** — the codebase has grown almost monotonically, very little file-level cleanup/deletion relative
  to creation, consistent with the "0.1.0, never released, main dormant 7 weeks" snapshot.
- Co-change pairs (≥8 shared commits), top cluster is exactly the IPC contract spine: `kb/types.ts ⇄
  main/ipc.ts` (47) · `kb/types.ts ⇄ main/pipeline.ts` (46) · `kb/types.ts ⇄ preload.ts` (43) ·
  `main/ipc.ts ⇄ preload.ts` (41) · `main/ipc.ts ⇄ main/pipeline.ts` (32) — confirms via independent git
  history what the import-graph fan-out numbers already show: `types.ts`/`ipc.ts`/`pipeline.ts`/`preload.ts`
  are one tightly-coupled core that changes together on essentially every IPC-surface change. 131 pairs
  total meet the ≥8 threshold.

## Caveats on method

- CC formula is a standard McCabe approximation, not a certified tool (no eslint-complexity cross-check run).
- Import-graph resolution is relative-specifier-only (no `tsconfig` path aliases were in use, confirmed none
  needed); external/npm imports are excluded from fan-in/fan-out by design.
- The unreferenced-CSS-class check is textual, see (e) caveat above — likely overcounts true dead classes
  because template-literal-built class names won't match.
- "Zero test reference" in (d) is import-specifier text matching across all `*.test.ts` file contents, not a
  coverage/instrumentation run — sufficient to show a file is never *imported* by a test, not proven to
  execute 0% of lines if it were somehow imported indirectly through a barrel (grep confirmed no barrel
  re-exports these particular registries files, so the conclusion holds here).
