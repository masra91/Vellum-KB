# KB-App

An AI-native **second brain** over an Obsidian/markdown vault: quick capture in,
effortless grounded recall out, autonomous agents in between. Cross-platform desktop
(Electron + TypeScript), minimal UI, mostly headless. The user is **the Principal**.

## Source of intent — read the specs first

`specs/` holds **living specs** — the source of truth for *what* and *why*. Code is
downstream of them. Start at `specs/INDEX.md`. Key ones:
- `SPEC-0000` — the living-spec system (requirements as a semantic test surface).
- `SPEC-0002` — product principles (the KB's values). `SPEC-0003/0004` — vision + lifecycle.
- `SPEC-0007` — data model (Sources/Entities/Outputs; git-backed). `SPEC-0010` — tech stack.
- **`SPEC-0011` — Engineering Principles & Rules (canonical; the rules below are its summary).**

When behavior changes, update the relevant spec in the **same** change (SPECSYS-7).
Requirements have stable IDs (`KEY-N`) and a `Verify:` method — keep them honest.

## Engineering rules (hard, always-on — see SPEC-0011 for detail)

**Dependencies / supply-chain (E1):**
- Only **well-established, widely-used, reputable** packages. Treat every dep as attack surface.
- A version MUST be **published ≥7 days ago** before adoption (active package-injection wave).
  Shorter **only** for an important CVE, with justification.
- **Pin** versions (exact/lockfile) so carets can't pull unreviewed/<7-day releases.
- Check peer-dependency compatibility. Prefer **fewer** deps; justify each one.

**Testing (E2) — invest heavily, prevent regression:**
- Every story has clear, addressable **requirements**; **tests trace to requirements**.
- **Very high coverage** (target ≥90% lines on domain/core). Test volume ~1:1 with prod LOC
  — but **never tests for their own sake**; assert real, requirement-backed behavior.
- A story is **done only when its `must` requirements have tests** (`Verify: none-yet → test:`).
- Every **bug fix adds a regression test**. Three levels: unit, component, e2e (Playwright +
  packaged-app smoke).

## Workflows (skills — use them)

Standard playbooks live in `.claude/skills/`. These are **not tracked in git** — Clubhouse
materializes them (and each agent's persona/instructions) locally per worktree, so all
(incl. parallel) agents still get the same playbooks without the repo owning that state:
- **`/mission`** — implement a story end-to-end: branch → implement against its spec →
  requirement-traced tests → `/validate` until green → `/kb-code-review` → open a PR.
  (Invoking it authorizes the full commit/push/PR loop for that work.)
- **`/validate`** — run local checks (typecheck, lint, tests/e2e when present); honest green/red.
- **`/kb-code-review`** — review the diff for bugs, regressions, and SPEC-0011 compliance.
- **`/merge`** — squash-merge **any** PR (by #/URL/branch) into `main` + delete the branch.
  Works for PRs you didn't author (multi-agent: implementer ≠ tester ≠ merger).
- **`/auto-mission`** — like `/mission` but authorized to go all the way through `/merge`.

## Build / repo

- The app lives in `app/` (Electron Forge + Vite + TS). `cd app`, then: `npm start` (dev),
  `npm run typecheck`, `npm run lint`, `npm run package` (build the `.app`).
- **This repo is the app source, NOT a KB.** A KB is a separate user-chosen vault (its own
  git repo). For dev, point the app at a throwaway vault **outside** this repo.
- Bundle node deps into the Vite **main** bundle (don't externalize) or the packaged
  `app.asar` can't find them.
- Don't `git push`/`commit` unless the Principal asks. Commit trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
