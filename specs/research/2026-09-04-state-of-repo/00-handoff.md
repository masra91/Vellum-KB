# State of the Repo — 2026-09-04 — hand-off

**Author:** KB-Special-Agent · **Snapshot:** `origin/main` @ `19bb68f` (2026-07-13; `main` dormant 7 weeks at review time) · **Status:** cut short on request — the audit ran, verification was interrupted by an API spend limit, the long-form report was not written. This folder is the hand-off so the work is not lost.

## What was done

1. Adapted the Goobers "State of the Repo" prompt for this repo (`_PROMPT.md`).
2. Established first-hand facts: CI/nightly history, local `npm ci` + typecheck + lint + unit (3,097 tests green), `npm audit`, `knip`, a local `npm run package` (298 MB unsigned .app, natives unpacked correctly), a local Playwright e2e run against that build (5 failed / 7 passed, then 4/4 smoke green in isolation), 22 per-view screenshots, and the running instance's field data (`~/Library/Application Support/Vellum`, `~/kb-test-1`). → `01-established-facts.md`.
3. Ran 19 parallel domain audits (principles, tests, CI, complexity, architecture, docs, dead code, reliability, performance, UX, latent risks, platform, headless/provider, release readiness, process, deps/security, observed runs, two censuses) plus a screenshot/DOM visual-QA lane. **252 findings**, every one with file:line evidence. → `findings.json`, `02-findings-index.md`.
4. Adversarial verification (3 independent lenses for P0/P1, 1 for P2/P3): **82 CONFIRMED, 30 PARTIAL (corrected), 1 REFUTED, 139 UNVERIFIED** — the unverified ones are the lanes whose verifier calls hit the spend limit (DEAD, DEP, HYG, MEAS, OBS, PERF, PLAT, PROC, REL, RLS, TEST). Treat those as evidence-backed claims, not confirmed facts. The completeness-critic round did not run.
5. Created GitHub milestone **`v0.1.0-rc.1`** (milestone 1) and labels `release-blocker`, `goobers:cloud`, `state-of-repo-0904`; filed the clearest release blockers (see below).

The full working folder with raw artifacts (npm audit JSON, screenshots, DOM error-contexts, packaged-bundle inventory, per-domain JSON) is at `~/source/KB-App-Review/StateOfTheRepo_2026-09-04/`.

## The short answer

The engine is in good shape and the July deep-review program largely landed (perf: median RSS ~445→210 MB, idle git spawns ~2,500→~480/hr; reliability: 12/15 BUG items closed; complexity: both big dedup refactors real; UX: the v3 shell is coherent and every view has loading/empty/error states). What is broken is everything *around* the code that would tell you when it breaks:

- **The nightly lane has been red every day since its first run (2026-07-13) and its own alert job cannot start** — `defaults.run.working-directory: app` applies to `report-red`, which has no checkout, so bash fails before the script runs; zero `nightly-red` issues were ever filed. Three e2e specs are deterministically stale (`.activity-empty`, `.ask-transcript`, `.agents-hub-title` no longer exist; the features do). CONFIRMED (CI-1, CI-2, COV-1, PROC-2, REL-5 in the CI/test lanes; first-hand in `01-established-facts.md`).
- **Release has never been exercised.** `release.yml` ran once (06-28, failed, wrong trigger). Tagging `v0.1.0-rc.1` on `19bb68f` fails the verify gate immediately because `tagVersion.mjs` requires the tag to equal `package.json` version, which is still `0.1.0` — bump to `0.1.0-rc.1` in a PR first. No LICENSE file on a public repo declaring MIT, no README, no CHANGELOG. (RLS lane; DOC-2 PARTIAL-confirmed.)
- **Distribution is a dead end for non-developers:** ad-hoc signed, unnotarized `.app` (Gatekeeper), no updater (SPEC-0056 unbuilt), the TCC-protected-vault MUST (#56) still open. Acceptable for a *private* rc dry run, blocking for anything public. (UX-1 PARTIAL, RLS REL-2/3 unverified.)
- **Two live reliability defects visible in the field data** (both need a verifier pass before acting): the compose stage's ephemeral worktrees are missing from the reap allowlist — the test vault holds **185 orphaned worktrees / 3.3 GB** (RISK-1 PARTIAL-confirmed, FIELD-1); and `connect:link` held the canonical-writer lock for up to 18 minutes in spans, timing out promotes (FIELD-2, PERF-3/REL-4 unverified). Separately, the REL lane claims `promote()` silently overwrites uncommitted user edits in the live Obsidian folder (REL-1, unverified — the edit-quarantine ruling from 07-05 was never implemented; this is the most important item to verify next).
- **Windows is formally a shipped target but unproven:** the PLAT lane claims the Windows nightly has never produced a working package (better-sqlite3 rebuild) — unverified and partly at odds with the macOS log reading; also no `build/icon.ico` (default Electron icon on Windows — first-hand), and the hand-rolled frontmatter parser is LF-only, so `core.autocrlf=true` checkouts break every source (RISK-4 PARTIAL-confirmed).
- **Supply chain:** 46 advisories (3 critical / 36 high; most are the electron-forge chain). Prod-reachable: js-yaml 4.1.0 (→4.3.2), dompurify 3.4.5 (→3.4.14), electron 42.2.0 (→42.11.2; RISK-3 PARTIAL). 44% of deps use carets against the repo's own exact-pin rule; Actions not SHA-pinned; no CSP (RISK-2 PARTIAL — real but not release-blocking).
- **Beta UI defects seen in the packaged build** (visual lane, screenshot evidence): Today shows 0 sources/claims/entities/connections on a populated library because it reads the per-session conversion counters (VIS-1); the Agents view prints source module paths (`kb/decomposeAgent.ts`) as chips (VIS-2); the rail "You" card shows the raw folder basename (VIS-3); plus 16 P2/P3 copy/layout items.

## Release-blocker triage for `v0.1.0-rc.1` (private dry run)

| # | Item | Findings | Verified? | Effort |
|---|---|---|---|---|
| 1 | Bump `package.json` to `0.1.0-rc.1` via PR before tagging (verify gate) | RLS REL-1 | by reading `scripts/release/tagVersion.mjs` | S |
| 2 | Fix `nightly.yml` `report-red` (add checkout or override `working-directory`) and the 3 stale e2e selectors; add `timeout-minutes`; raise walkthrough test timeout | CI-1, CI-2, VIS e2e table | CONFIRMED | S |
| 3 | Today counters read library contents, not conversion counters | VIS-1 | CONFIRMED (screenshots + `todayProjection.ts:76`) | M |
| 4 | Remove module-path chips from Agents; show library name in the rail card | VIS-2, VIS-3 | CONFIRMED | S |
| 5 | Add `LICENSE` (MIT per package.json), minimal `README.md`, `CHANGELOG.md` | DOC-2 | PARTIAL-confirmed | S |
| 6 | Bump js-yaml / dompurify / electron patch (honor the 7-day rule) | RISK-3, DEP-* | PARTIAL / unverified | S |
| 7 | Add `compose` to the ephemeral-worktree reap allowlist + a startup reap of leaked `kb/compose-work-*` | RISK-1, FIELD-1 | PARTIAL-confirmed | S |
| 8 | Verify REL-1 (promote vs live Obsidian edits); if real, it is a P0 for any release | REL-1 | UNVERIFIED | — |

Public-release additions: signing + notarization (SPEC-0034/0055), auto-update (SPEC-0056), #56 TCC, Windows icon + a green Windows package/e2e leg, CSP.

## Filed issues

Milestone `v0.1.0-rc.1`, label `state-of-repo-0904` + `release-blocker`:

- #584 — nightly `report-red` cannot start + 3 stale e2e selectors (goobers:approved, goobers:cloud)
- #585 — Today counters read the conversion projection → 0s on a populated library (goobers:approved, goobers:cloud)
- #586 — Agents view leaks module paths; rail card shows raw folder basename; lexicon stragglers (goobers:approved, goobers:cloud)
- #587 — v0.1.0-rc.1 dry run blocked: version bump, LICENSE/README/CHANGELOG, release.yml never exercised (goobers:approved, goobers:cloud)
- #588 — compose worktree leak (3.3 GB), lock stalls, and REL-1 (promote vs live edits) to verify first

## Files in this folder

- `00-handoff.md` — this document.
- `01-established-facts.md` — first-hand measurements (CI history, local validation, packaging, e2e, field data).
- `02-findings-index.md` — every finding (id, area, severity, verdict, evidence pointer).
- `03-visual-qa-packaged-build.md` — per-view screenshot QA + e2e failure classification.
- `04-census-complexity.md`, `05-census-hygiene.md` — measurement censuses (if produced by their lanes).
- `06-npm-audit.txt`, `07-knip.txt` — tool output.
- `findings.json` — the full structured result (domain summaries, measurements, strengths, open questions, findings with verifier votes and corrections). Domain summaries are 400–900 words each and are the best narrative source if the long-form report is ever written.
- `_PROMPT.md` — the adapted review prompt (re-runnable).

## If picking this up later

1. Re-run verification only for the UNVERIFIED lanes (the workflow script and run id are in the session; or simply verify the eight triage rows above by hand).
2. Write chapters from `findings.json` domain summaries + `01-established-facts.md`; the intended chapter list is in `_PROMPT.md`.
3. Do not trust `verdict: UNVERIFIED` findings for closure decisions without reading the cited lines.
