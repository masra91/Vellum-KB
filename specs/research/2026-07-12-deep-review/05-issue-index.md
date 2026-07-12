# 05 — Issue Index (GitHub ↔ findings ↔ waves)

27 issues opened 2026-07-12 on `masra91/Vellum-KB`, all labeled `deep-review-0712` + one `area:*` + `P0|P1|P2`. Every issue carries problem, file:line evidence, suggested approach, acceptance criteria, and test cases. Findings vocabulary: `PERF-E*`/`PERF-R*`/`PERF-A*` (01), `UX-*` (02), `BUG-*` (03), `ENG-*` (04).

## The map

| # | Title (short) | Pri | Area | Covers | Wave |
|---|---|---|---|---|---|
| [#505](https://github.com/masra91/Vellum-KB/issues/505) | Graph projection O(N×M) + HEAD-gate | P0 | perf | PERF-E1/A1 | 0 |
| [#506](https://github.com/masra91/Vellum-KB/issues/506) | Idle engine compute batch | P0 | perf | PERF-E2, E10, E11, E12, BUG-14 | 0-1 |
| [#507](https://github.com/masra91/Vellum-KB/issues/507) | Connect sweep off the lock + capture priority | P0 | perf | PERF-E3 | 1 |
| [#508](https://github.com/masra91/Vellum-KB/issues/508) | Engine I/O & memory scaling batch | P1 | perf | PERF-E4, E5, E6, E7, E8 | 2 |
| [#509](https://github.com/masra91/Vellum-KB/issues/509) | Renderer poll hygiene | P0 | perf | PERF-R1, R2, R9, R15 | 0 |
| [#510](https://github.com/masra91/Vellum-KB/issues/510) | View lifecycle + projection push (STATE-8) | P1 | ux | PERF-R12 | 1 |
| [#511](https://github.com/masra91/Vellum-KB/issues/511) | Keyed/incremental list rendering | P1 | perf | PERF-R3, R4, R10, R11 | 1-2 |
| [#512](https://github.com/masra91/Vellum-KB/issues/512) | First-paint, waterfalls & renderer hygiene | P1 | perf | PERF-R5, R6, R7, R8, R13, R14 | 1-2 |
| [#513](https://github.com/masra91/Vellum-KB/issues/513) | Per-question recall memo + entity resolution | P0 | perf | PERF-A2, A7, A9 | 1 |
| [#514](https://github.com/masra91/Vellum-KB/issues/514) | Ask responsiveness batch | P1 | perf | PERF-A3, A4, A5, A6, A8 | 1 |
| [#515](https://github.com/masra91/Vellum-KB/issues/515) | Canonical-writer hardening (hang + corruption P0s) | P0 | reliability | BUG-1, BUG-2, BUG-15 | 0 |
| [#516](https://github.com/masra91/Vellum-KB/issues/516) | Ingest robustness | P1 | reliability | BUG-3, BUG-6, BUG-7, BUG-9 | 1 |
| [#517](https://github.com/masra91/Vellum-KB/issues/517) | Single-writer discipline | P1 | reliability | BUG-5, BUG-10 | 1 |
| [#518](https://github.com/masra91/Vellum-KB/issues/518) | Correctness & error-surface batch | P2 | reliability | BUG-4, BUG-8, BUG-11, BUG-12, BUG-13 | 2 |
| [#519](https://github.com/masra91/Vellum-KB/issues/519) | Make the top bar real | P0 | ux | UX-1, UX-4 | 1 |
| [#520](https://github.com/masra91/Vellum-KB/issues/520) | Loading & motion system | P0 | ux | UX-2, UX-3, UX-10, UX-11 | 1 |
| [#521](https://github.com/masra91/Vellum-KB/issues/521) | Dark re-point (funded ruling) | P1 | ux | UX-5 | 2 |
| [#522](https://github.com/masra91/Vellum-KB/issues/522) | Clipping batch + window minimum | P1 | ux | UX-6 (C1-C12) | 1 |
| [#523](https://github.com/masra91/Vellum-KB/issues/523) | Old-UI retirement + Status-cluster deletion | P1 | ux | UX-7, UX-8, UX-9, UX-16, ENG-10, ENG-16 | 0-1 |
| [#524](https://github.com/masra91/Vellum-KB/issues/524) | v3 conformance polish batch | P2 | ux | UX-12, UX-13, UX-14, UX-15 | 2 |
| [#525](https://github.com/masra91/Vellum-KB/issues/525) | CI gates + nightly lane + eval resurrection | P0 | eng-health | ENG-1, ENG-2, ENG-3, ENG-11, ENG-13 | 0 |
| [#526](https://github.com/masra91/Vellum-KB/issues/526) | Flip strict:true | P0 | eng-health | ENG-6 | 0 |
| [#527](https://github.com/masra91/Vellum-KB/issues/527) | Test rigor batch | P1 | eng-health | ENG-5, ENG-12, ENG-15 | 1 |
| [#528](https://github.com/masra91/Vellum-KB/issues/528) | Dedup refactors (registry CRUD + decider scaffold) | P1 | eng-health | ENG-7, ENG-8 | 1-2 |
| [#529](https://github.com/masra91/Vellum-KB/issues/529) | Release pipeline slice 1 | P1 | eng-health | ENG-4 | 2 |
| [#530](https://github.com/masra91/Vellum-KB/issues/530) | SQLite/FTS5 Library Index — slice 1 | P0 | perf/arch | Spine 1; ENG-9, ENG-17 | 1-2 |
| [#531](https://github.com/masra91/Vellum-KB/issues/531) | Engine daemon extraction (RFC, headless-run) | P1 | eng-health/arch | Spine 3 | 3 |

## Dependency notes

- **#505 and #506 first** — they remove the idle burn that contends with everything else and make all later measurements clean.
- **#513 (memo) does not wait for #530 (index)**: the memo is the one-week win; the index replaces its internals and inherits its equivalence tests. The composite `search()` tool rides #530.
- **#510 (push) unlocks deletion of the polls** that #509 merely disciplines; do #509 immediately anyway (one-line-class fixes).
- **#515 before #517** — the lock gains section deadlines first, then the schedulers join it.
- **#523's terminology rename and the smoke e2e assert must land in one commit** (mutually load-bearing).
- **#530's packaging checklist depends on #525's nightly** for the Windows ABI leg.
- **#531 (daemon) is deliberately Wave 3** — after index + push settle the topology it re-houses.
- The 07-05 trust spine (edit rescue, sensitivity ceiling, evidence verification, SPEC-0059 source deletion, Reviews-B2) is **not re-issued here** — it remains ratified direction tracked via SPEC-0061/#503 and the 07-05 proposal doc.

## Tracker hygiene — recommendations on pre-existing open issues (not acted on)

| Issue | Recommendation | Reason |
|---|---|---|
| #398 tokens / #399 typography / #400 rename / #401 icon / #404 Explore retheme | **Close as shipped** | Delivered by the v2 reskin + v3 rebuild (SPEC-0060, all views merged) |
| #403 "The Line" retheme | **Close as superseded** | The Status view was dissolved (VUX-4); its remains are deleted by #523 |
| #405 Motion & feel | **Close as superseded by #520** | Motion system now scoped with AC |
| #427 Dark mode 'night study' | **Close as superseded by #521** | Same goal, scoped to the funded token re-point |
| #406 About panel + branded empties | Keep; cross-link #523/#524 | Partially covered (About re-token in #523; empties in #524) |
| #402 Fractal-lattice motif | Keep (brand work, still valid) | Not addressed by this review |
| #205 Jobs view stuck "Loading…" | Keep until #512/#520 land, then verify & close | Root causes now identified (sequential probes, bare Loading, BUG-14 walk) |
| #192 set-aside items read as "stuck" | Keep; cross-link #516 | Quarantine surfacing gives it a home |
| #56 TCC-protected vaults | Keep | Still valid; untouched by this review |
