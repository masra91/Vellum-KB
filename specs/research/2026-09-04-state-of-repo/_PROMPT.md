# State of the Repo Report — Vellum-KB (KB-App) — adapted prompt

> Adapted 2026-09-04 from the Goobers "State of the Repo Report" prompt. Differences from the Goobers
> version are marked **[adapted]**. Everything else is the original intent, kept verbatim in spirit.

Pull latest from main. **[adapted]** Repo is `masra91/Vellum-KB` (local folder `~/source/KB-App`; the
app lives in `app/`, Electron Forge + Vite + TypeScript; living specs in `specs/`). Work from the
`KB-Special-Agent` worktree; the report is read-only analysis — nothing in the repo is modified.

This project has grown significantly and evolved quickly — 506 commits in the six weeks from 2026-05-30
to 2026-07-13, two deep reviews, a whole-app UI rebuild, and a perf/reliability wave — but the vision has
remained constant. **[adapted]** Note that `main` has not moved since 2026-07-13 (seven weeks at the time
of this report); the nightly CI lane has run every day since. Become a neutral observer of the process and
the code and produce a findings report on the state of the repository.

The result is a folder `~/source/KB-App-Review/StateOfTheRepo_<YYYY-MM-DD>/` **[adapted: was
`~/source/Goobers-Review/`]** containing a series of markdown files with numbered names —
`00_ExecutiveSummary.md` first, then one file per focus area — plus an `appendix/` with raw findings
(JSON), measurements, and log excerpts.

Familiarize yourself with the goals of the repo (`CLAUDE.md`, `specs/INDEX.md`, SPEC-0002/0003/0004
product principles + vision, SPEC-0011 engineering rules, SPEC-0012 testing strategy, SPEC-0061 the
functional rethink) and the backlog and pending work (open GitHub issues, the 2026-07-12 deep review
under `specs/research/2026-07-12-deep-review/`, the "Reserved / planned" table in `specs/INDEX.md`,
SPEC-0059/0055/0056 drafts).

**[adapted]** There are no `observation_*` run reports for this repo. The observed-run analogs are:
- the running instance's data: `~/Library/Application Support/Vellum/` (`kb-app.config.json`,
  `logs/app.log` — memory samples 2026-06-28 → 2026-08-11, `conversations/`, Crashpad), and the older
  `~/Library/Application Support/kb-app/last-crash.json`;
- the dev vault it points at: `~/kb-test-1` (git history of promotes, `.kb/cache/spans.jsonl` stage
  spans, `.kb/ask/audit.jsonl`, `.kb/cache/ask/audit.jsonl`, entities/claims/sources counts);
- GitHub Actions history (`ci.yml`, `nightly.yml`, `release.yml`) and the closed-issue record.
Be mindful that the instance ran builds that were one or several days (later: weeks) stale from `main`
at the time of recording.

Areas to consider, but not limited to:

1. **Guiding principles** — **[adapted]** at its core the system is an AI-native second brain over a
   plain Obsidian/markdown vault: quick capture in, grounded recall out, autonomous librarians in
   between; minimal UI, mostly headless; Copilot-only egress. The **living specs are the source of
   intent** and the **vault (markdown + git) is the source of truth for data**; `.kb/` config,
   registries, and instance settings are the operational config surface. We must be vigilant in
   avoiding duplicate sources of truth or configurability (projections vs index vs ad-hoc walkers;
   settings in userData vs `.kb/`; spec vs code drift). UX and UI should be built cleanly against
   the same engine API (the typed `KbApi` IPC surface) that a headless run or daemon would use.
2. **Test coverage** — semantic coverage of user behaviors and requirements (`KEY-N` traceability),
   not line percentages; the three tiers (unit / component / e2e+packaged smoke); the eval lane.
3. **CI coverage** — usefulness of gates vs time and noise; the required ruleset; the nightly lane;
   the release workflow; what green actually proves.
4. **Code complexity** — meaningful simplifications that keep behavior; measured tradeoffs allowed.
5. **Future architecture support** — modular add/remove/modify; the daemon extraction (#531), the
   library index, the projection push channel; the per-feature "four-file tax".
6. **Design & documentation** — specs and READMEs accurate and understandable; **[adapted]** the
   canonical demo workflows here are the eval scenarios (`app/eval/`), the walkthrough/smoke e2e, and
   the first-run setup flow.
7. **Dead code** — orphaned code, unexercised branches, superseded features, dead CSS/tests.
8. **Reliability & correctness** — graceful, surfaced errors; data loss never acceptable; the git
   canonical-writer path; corruption risks.
9. **Performance & deadlocks** — judicious resource use, no hard locks; idle CPU, memory growth
   (the log's `mem.leak-suspected` warnings), lock contention, timers.
10. **User experience** — install/configure/use; simple flows simple; **[adapted]** first-run setup
    (SPEC-0009), About/guidance, the lexicon law, loading states, macOS TCC folders (#56).
11. **Latent bugs & risks** — ticking time bombs across all areas (dependency drift, Node/Electron
    version skew, timezone/date assumptions, pinned betas).
12. **Platform support** — Windows, Linux, macOS gaps (**[adapted]** macOS is the primary target;
    Windows has an e2e leg; Linux has makers but no runtime CI).
13. **[adapted] Headless-run, daemon readiness & provider surface** — replaces the Goobers
    "cloud-native / k8s / Azure" area, which does not apply. The ratified end state is an engine
    that runs without a window (headless-run, #531 RFC) behind the same API the UI uses, with
    Copilot SDK/CLI as the only egress (BYOA). Assess what exists for quality, correctness, and
    design; identify the gaps toward that story.

Also examine the **process**: the multi-agent Clubhouse workflow (14 agent personas, spec gates,
QA gates) as visible in commit/PR/issue history, and repo hygiene.

You are free to identify and pursue other areas, or coalesce or restructure the above. For items
that are well scoped with understood risk, label the GitHub issue `goobers:approved` and
`goobers:cloud`. When creating workflows always use the correct-sized model for the task — never
assume fable or leave a default unspecified. Fable for critical or far-reaching tasks, opus for
detailed and major tasks, sonnet for the vast majority of tasks, haiku for mechanical or simple tasks.

**[adapted] Release examination.** There is no tagged release yet (version frozen at `0.1.0`, zero
tags, zero GitHub releases; SPEC-0055 defines `vX.Y.Z-beta.N`, `release.yml` treats `-rc.N` as the
dry-run pre-release). Treat `main` at `19bb68f` as the de-facto beta: package it, run it, and examine
it for quality and undocumented bugs. File release-blocking items under a GitHub milestone for the
first tagged cut, **`v0.1.0-rc.1`**, and label them `release-blocker`, so they can be fixed before
promoting that tag.
