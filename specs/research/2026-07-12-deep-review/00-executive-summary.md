# Deep Review 2026-07-12 — Executive Summary & Architecture Verdict

**Author:** KB-Special-Agent
**Method:** six parallel deep-read lanes over `origin/main` (`8e8ec5b`), static analysis only — engine perf/memory, renderer perf/leaks, Ask latency trace, UX/visual vs the v3 mock, reliability bug hunt, engineering health + extractability. Every finding carries file:line evidence read this session. Companion docs: `01-performance.md`, `02-usability.md`, `03-reliability.md`, `04-engineering-health.md`, `05-issue-index.md`.
**Relation to the 07-05 review:** builds on `2026-07-05-deep-review-current-state.md` and its seven ratified rulings (SQLite/FTS5 index, edit-quarantine, annotate-then-gate, source-delete P0, Reviews-B2, dark re-point, UI-forward identity). Those rulings stand; nothing here re-opens them. Only two spec-only commits landed since, so all 07-05 code findings were re-verifiable — most held; six were corrected by deeper reading (see §7).
**Charter for this pass (Principal, 2026-07-12):** all four pain lanes bite (ingest/indexing, everyday UI, Ask latency, long-session bloat); old UI still surfaces; the top bar "isn't there"; visual clipping; progress/loading motion inconsistent and missing. Broad structural change **up to and including a full rewrite is on the table** if it better reaches the end state: an LLM-powered library with internal librarians and external researchers.

---

## 1. The opinion

Vellum's conception is right and its hardest engineering is already good. The write spine — optimistic canonical advance, crash-safe audit-marker queues, verified citations, incident-hardened git handling, containment at every trust boundary — is the part most products never get right, and it is genuinely strong here (§6). The product's felt problems live in three places the write spine's discipline never reached:

1. **The read side derives everything by re-walking the vault on timers.** Not once, but in five independent loops (graph 5s, status 2.5s, Today 8s, connect sweep 30s, compose sweep 30s) plus per-request walks for Ask tools, Health, Activity, and registries.
2. **Nothing pushes.** The backend can't tell the UI anything changed; the UI polls or freezes. All "live" surfaces are hand-rolled renderer intervals of varying correctness; eight of ten views show first-visit data forever.
3. **The finish layer was never systematized.** Loading/progress/motion, the top bar, dark mode, clipping, error surfaces — each view solved (or didn't solve) these locally. The v3 rebuild made every view *individually* good and the connective tissue between them is where "half-finished" now lives.

The four reported pains are not four problems. They are these three causes wearing four costumes — and every one of them is fixable inside the current architecture at a small fraction of rewrite cost.

## 2. Why the app feels the way it does (headline numbers)

All figures static-derived at a reference vault of 1k entities / ~3k claims / ~1.5k sources; evidence in the pillar docs.

- **Idle CPU:** the graph projection rebuild calls `claimsForEntity` once per entity, and each call re-reads **every claim file** — ~**2-3 million file reads per rebuild**, scheduled every 5s, with coalescing that makes an over-budget rebuild run back-to-back forever (PERF-E1/A1). The 2.5s status tick re-walks every stage queue raw — bypassing the HEAD-keyed queue caches the stages themselves already use — plus up to a 5MB log read per tick (PERF-E2). Net: an *idle* Vellum burns ~1.5-2 cores continuously and spawns ~2,500 git processes/hour (PERF-E11). This is the fans-spinning complaint, mechanically.
- **Ingest hangs:** connect's 30s maintenance sweep does whole-vault work per queued node **while holding the single FIFO canonical-writer lock**, and its link queue never shrinks; captures, review answers, and settings saves queue FIFO behind it (PERF-E3). One captured item costs ~**200 git spawns and ~17 full-tree checkouts** (PERF-E5); each promote deletes and re-checkouts the **entire** evergreen tree, triggering Obsidian rescan storms (PERF-E4).
- **Ask latency:** a default question runs the deepest pass (Considered, 24 tool calls) on the slowest model (Opus-first, no recall tier), each tool call re-walks the vault with zero reuse even within one question, behind a static skeleton with no progress — and every question spawns a fresh Copilot CLI server **that is never stopped** (a process leak). LLM round-trips are ~65-75% of wall-clock, so the index alone will not fix Ask; it needs fewer calls, session reuse, an honest Quick tier, and progress push (PERF-A1..A9).
- **Long-session bloat:** the graph projection holds every entity and source body in main-process memory and re-allocates a full copy plus its JSON string every refresh; the status tick allocates 2-7MB per 2.5s; V8 old-space ratchets under sawtooth churn without a classic leak — which is precisely the shape the OBS-21 leak detector (strictly-monotonic test) cannot see (PERF-E8). Renderer side: a 1.5s Capture poll runs forever even minimized with an error-amplification loop, an Agents poll whose visibility guard checks the wrong element, an O(n²) Ask transcript re-render, and unbounded staged-file bytes (PERF-R1..R8).
- **"The top bar isn't there":** it literally is a facade — the search pill is a `<button>` that cannot accept text, the per-view contextual slot has **zero** fillers app-wide, and the native macOS title bar sits above the themed bar making it read as a second toolbar, not the top bar (UX-1, UX-4).
- **"Old UI shows up":** the shared warming/error faces every view falls back to are still v2; the quick-capture sheet, permission gate, first-run setup, and About panel are 100% v2 tokens; a dead 2,467-line Status cluster still ships its CSS; banned lexicon survives in five user-visible strings (UX-3, UX-7, UX-8, UX-9, UX-16).
- **"Motion inconsistent and missing":** the mock defines a complete loom/churn/skeleton system; shipped, only Reviews and Ask have skeletons while **ten** surfaces cold-start on bare "Loading…", async buttons mostly have no pending state, and resolved items vanish with no exit motion (UX-2, UX-10, UX-11).
- **Hangs that need restart:** two review-lane writers run **raw unbounded git inside the canonical lock**, and the lock watchdog only logs — one stalled `git add -A` (iCloud vault, git hook, huge tree) permanently wedges every write in the app (BUG-1). macOS quit never stops the pipeline; an interrupted cherry-pick is never healed and the next capture can silently commit a half-applied tree (BUG-2). Three schedulers commit to the repo outside the lock entirely (BUG-5).

## 3. The architecture verdict

**Question on the table:** keep-and-fix, restructure, or full rewrite, judged against the end state (LLM-powered library, internal librarians, external researchers, quick-capture-in / effortless-recall-out, headless-capable, Copilot-only egress).

**Verdict: keep the engine, extract its housing, rebuild the connective tissue. A full rewrite is rejected on evidence.**

The extractability audit settles it:

- The 30k-line engine (`app/src/kb`) has **zero Electron imports** — every "electron" hit is a comment asserting shell-agnosticism. `pipeline.ts` is 0% Electron-bound. The engine already *is* the headless daemon's library; making it one is an assembly job (config-dir shim + a transport in front of the existing exports), not a refactor.
- The UI↔engine contract is already an RPC surface: 71 typed request/response channels, zero push, ~8-10 OS-bound channels that must stay app-side. `ipc.ts` handler bodies are the server; `KbApi` is the IDL.
- What a rewrite would shed is generously ~5-6k LOC of liability (god-file, six duplicated scaffolds, dead cluster, 12 ad-hoc walkers) — all addressable by targeted refactors under a 0.90:1 test:prod harness. What it would lose is ~30k LOC encoding **20+ fixed production incidents** (the wedge defenses, the containment seams, the citation verifier, the crash-safe queues), 37k LOC of tests, and the CI-enforced audit-coverage gate. A rewrite spends the budget re-earning the scars, not escaping them.
- The renderer's problems are policy bugs (wrong guard element, no teardown contract, no push, sequential awaits), not rendering-model limits — the codebase's own best views already demonstrate the correct patterns. A framework migration would rewrite 8.5k prod + invalidate 8k test LOC and leave the #1 structural problem (100% pull IPC) untouched.
- The one place the substrate itself is genuinely indicted is **git-as-runtime-I/O**: full-tree checkouts per item and whole-tree promotes. That is fixed *within* the git model (sparse/`--no-checkout` worktrees, diff-driven promote) — git-as-source-of-truth is the product's provenance story and stays.

### The program: three spines + a hardening wave

**Spine 1 — Read (index + change detection).** Land the ratified SQLite/FTS5 index as a **ProjectionStore sibling** maintained at the canonical-advance seam (rebuildable cache under `.kb/cache/`, packaging per the better-sqlite3 checklist in `04-engineering-health.md` §ENG-17). Acceptance criterion: the 12 ad-hoc vault walkers are retired. **Do not wait for it**: the O(N×M) graph rebuild has a ~40-line algorithmic fix (single claims walk) and every interval loop gains a HEAD-changed gate now — these two patches alone remove most idle CPU this week.

**Spine 2 — State (push + lifecycle).** One `projection-changed` push channel end-to-end (the `onUpdate` hook exists unwired), a view lifecycle contract (`show/hide/unmount`), a shared visibility-gated poll helper as backstop, and a keyed list-patch helper for the three list-heavy surfaces. ~500-800 LOC total; kills the frozen views, the poll census, and most render jank in one move. This completes SPEC-0058 STATE-8.

**Spine 3 — Process (daemon extraction).** Promote the 71-channel surface to a transport-agnostic server (engine in a `utilityProcess` first, separable daemon after), Electron shell + qcap as clients, the ~8-10 OS channels staying app-side. This is what makes UI hangs *structurally impossible* rather than fixed-by-discipline, delivers the ratified headless-run requirement, isolates engine crashes/memory from the window, and gives librarians/researchers a supervised home that matches the end-state shape. Cost M. Sequenced third deliberately: Spines 1-2 fix today's fires; Spine 3 changes the topology those fixes land in — do it when the index has settled, not before.

**Hardening wave (parallel, mostly small):** bounded git everywhere inside the lock + lock section deadlines (BUG-1/15), quit/startup reconcile incl. cherry-pick sequencer heal (BUG-2), archive poison quarantine (BUG-3/7/9), single-writer discipline for the three bypassing schedulers (BUG-5/10), watch stability gate (BUG-6), consolidation serialization (BUG-4), replay epoch fencing (BUG-8), renderer mount error boundary (BUG-12).

**Finish-layer wave (UX):** the "top bar is real" PR (⌘K input + ctx fillers + hiddenInset chrome), the loading-language PR (skeleton primitive + v3 warming faces + motion tokens), the funded dark re-point (18 tokens + enumerated hex conversions), the clipping batch, old-UI retirement (qcap/setup/permission/About + Status-cluster deletion), and Ask progress + honest Quick tier. Each is a scoped issue in `05-issue-index.md`.

**Gate wave (make green mean something):** require the already-running package + secrets jobs, add one nightly schedule (e2e matrix, macOS package, eval scorecard, knip), flip `strict: true` (measured ~4 errors), add main/shell coverage floors, and stand up the tag-triggered release pipeline. Near-zero new per-PR cost.

## 4. What this buys against the end state

With the three spines landed: an idle Vellum does approximately nothing (compute tracks mutation); capture acks in milliseconds regardless of background sweeps; Ask answers in seconds at Quick and shows its work at any depth; views reflect reality push-fresh without polls; the window can close while the librarians keep working; and the engine that runs headless is the same tested library, not a fork. That is the end-state product — reached by closing loops, not by starting over.

## 5. Sequencing sanity

Wave 0 (days): E1 single-walk fix + HEAD gates, BUG-1 bounded git + BUG-2 quit reconcile, renderer poll hygiene (R1/R2), strict flip, required checks, Status-cluster deletion, lexicon stragglers.
Wave 1 (1-2 weeks, parallel lanes): index slice 1 (recall tools + Health), push channel + lifecycle, top-bar PR, loading-language PR, Ask quick-tier + progress, ingest robustness batch.
Wave 2: index slices 2-3 (Activity, registries, Explore), dark re-point, delta promote + sparse worktrees, composite search tool + session reuse, release pipeline, nightly lane.
Wave 3: daemon extraction, then the 07-05 trust spine (edit rescue, sensitivity ceiling, evidence verification) continues per its own ratified plan.

## 6. What is genuinely strong (invariants for every wave)

Verified by reading, not reputation: `canonicalAdvance.ts` (optimistic lock, allowlist reaping, in-acquire lock heal), `canonicalLockHeal.ts` (triple-gated), `audit.ts` (one envelope + a CI-enforced emitter-coverage gate), `recall.ts` citation verification (grounded is earned, never assumed), `selfRepair.ts` (parse-only repair boundary), `pathContainment.ts` (Class-A/B separation encoding three fixed injection bugs), the copilot semaphore's priority lane, reduced-motion coverage in the renderer, and a 0.90:1 test:prod ratio with genuine IPC contract tests. Anything in the program that would weaken one of these is mis-implemented.

## 7. Corrections to the 07-05 record (so it stays trustworthy)

- Capture drop-listener "leak": **not a leak** — guarded one-shot install. The real Capture issues are its timer and staged bytes (PERF-R1/R8).
- "~1,900-line dead Status cluster ships": JS is tree-shaken out of the bundle; what ships is its **CSS** (`theLine.css`, 558 lines) plus the showcase view. Full safe-delete list is 2,467 lines incl. tests (ENG-10).
- "pipeline.ts has zero tests": stale — six boundary suites cover ~15 of its 50 exports (the floor gap stands, the zero doesn't).
- "views untested": false — all 19 view modules have colocated happy-dom tests.
- Walker duplication: **worse** than reported — 12 implementations, not 4.
- Judge≠SUT guard: improved since 07-05 (compares resolved ids) but still vacuous in default config (`'copilot-default'` placeholder short-circuit, ENG-13).

## 8. Reading map

- `01-performance.md` — engine (PERF-E1..E12), renderer (PERF-R1..R15), Ask (PERF-A1..A9), with idle/ingest/memory budget tables.
- `02-usability.md` — UX-1..16, the four pain chase-downs, remnant/top-bar/clipping/motion inventory tables, proposed motion system.
- `03-reliability.md` — BUG-1..15 with failure scenarios, plus the systemic patterns.
- `04-engineering-health.md` — ENG-1..17, test/CI census, extractability seam analysis, rewrite calculus.
- `05-issue-index.md` — GitHub issue ↔ finding ↔ priority map, plus tracker-hygiene recommendations for the stale June reskin issues.
