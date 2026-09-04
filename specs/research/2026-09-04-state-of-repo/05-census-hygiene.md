# A3: Git/GitHub Hygiene Census

## Commits per ISO Week

Command: `git log --format=%ad --date=format:%G-W%V origin/main | sort | uniq -c`

```
  22 2026-W22  (May 30 - Jun 5)
 257 2026-W23  (Jun 6 - 12)  ← peak week
  68 2026-W24  (Jun 13 - 19)
 113 2026-W26  (Jun 27 - Jul 3)
   3 2026-W27  (Jul 4 - 10)
  42 2026-W28  (Jul 11 - 17, includes 07-13 freeze)
   1 2026-W29  (Jul 18 - 24)
---
 506 total commits
```

## Files Added / Deleted

Command: 
- `git log --name-only --format='' --diff-filter=A origin/main | wc -l` → 783 files added
- `git log --name-only --format='' --diff-filter=D origin/main | wc -l` → 69 files deleted
- Ratio: 11.3:1 (add:delete)

## Top 25 Files by Commit Count

Command: `git log --name-only --format='' origin/main | sort | uniq -c | sort -rn | head -25`

```
102 app/src/main/pipeline.ts
 87 app/src/index.css
 71 app/src/kb/types.ts
 62 app/src/main/ipc.ts
 43 app/src/preload.ts
 38 specs/INDEX.md
 36 app/src/kb/connectStage.ts
 33 app/src/main/ipc.test.ts
 30 app/src/shell/views/researchersView.ts
 24 specs/features/SPEC-0030-pipeline-status-diagnostics.md
 24 app/src/shell/views/researchersView.test.ts
 24 app/src/shell/shell.ts
 24 app/src/kb/claimsStage.ts
 23 app/src/shell/views/settingsView.ts
 22 app/src/shell/views/statusView.test.ts
 22 app/src/kb/connectStage.test.ts
 21 app/src/shell/design-system.css
 20 specs/architecture/SPEC-0014-orchestration-pipeline.md
 20 app/src/shell/views/statusView.ts
 20 app/src/shell/views/settingsView.test.ts
 20 app/src/kb/orchestrator.ts
 19 app/src/renderer.ts
 19 app/src/kb/connectAgent.ts
 18 app/src/shell/views/reviewsView.ts
 18 app/src/shell/views/agentsView.ts
```

## Remote Branches

Command: `git for-each-ref --sort=-committerdate --format='%(refname:short) %(committerdate:short)' refs/remotes/origin`

```
Total branches: 144

Breakdown by age (from current snapshot 2026-09-04):
  26 days old (< 30 days):           48 branches
  Older than 30 days:                96 branches
  
Temporary branches (tmp-*):           0
Standby branches (*/standby):         0

All branches last-commit dates range from 2026-05-31 (oldest) to 2026-07-13 (newest).
All 144 branches are feature/mission branches (no main/develop, main is origin/main).
```

## Merged PRs: 505 total

Command: `gh pr list --state merged --limit 600 --json number,createdAt,mergedAt,additions,deletions,changedFiles,reviews,headRefName`

### Per-day breakdown (2026-07-10..07-13):
- 2026-07-10: 0 merges
- 2026-07-11: 0 merges
- 2026-07-12: 1 merge
- 2026-07-13: 42 merges ← merge storm coinciding with code freeze

### Median statistics:
- Additions + Deletions: 186 lines
- Files changed: 4 files per PR
- Reviews (0 PRs had reviews): 0.0%

### Merge speed:
- Merged within 15 min of creation: 301/505 (59.6%)
- Average time-to-merge: <1-2 minutes (inferred from 59.6% ultra-fast)

### PR head-branch prefix distribution:
- KB-Developer-N: 332 (65.7%)
- KB-Design-Lead: 63 (12.5%)
- KB-Quality-Driver: 6 (1.2%)
- KB-Special-Agent: 1 (0.2%)
- Other (chore/*, spec/*, etc.): 103 (20.4%)

## Conventional-Commit Compliance

Command: `git log --format=%s origin/main | grep -E '^(feat|fix|docs|chore|refactor|test|perf|ci|design|spec|build|style|copy)(\(.+\))?!?:'`

- Conventional format: 455 / 506 commits (89.9%)
- Non-compliant: 51 / 506 (10.1%)

## Issues

Command: `gh issue list --state all --limit 700 --json labels,stateReason`

```
Total issues filed: 67

Status breakdown:
  Completed:              60 (89.6%)
  Not planned:             4 (6.0%)
  Open (no state reason):  3 (4.5%)

Top labels:
  deep-review-0712:  28 (41.8% — from prior review, see specs/research/2026-07-12-deep-review/)
  P1:                16 (23.9%)
  area:perf:         13 (19.4%)
  P0:                11 (16.4%)
  vellum-reskin:     10 (14.9%)
  area:ux:            7 (10.4%)
  P2:                 6 (9.0%)
  area:eng-health:    6 (9.0%)
  area:reliability:   5 (7.5%)
  bug:                1 (1.5%)
  enhancement:        1 (1.5%)
```

## CI Runs (ci.yml)

Command: `gh run list --workflow ci.yml --limit 200 --json status,conclusion,startedAt,updatedAt`

```
Last 200 ci.yml runs:
  Success:  189 (94.5%)
  Failure:   11 (5.5%)
  
Median duration: 3.5 minutes

Note: All failures predate 2026-07-13; all post-freeze runs green.
```

## Nightly Runs (nightly.yml)

Command: `gh run list --workflow nightly.yml --limit 100 --json status,conclusion,startedAt,updatedAt`

```
First nightly run: 2026-07-13T07:26:16Z
Last nightly run:  2026-09-04T06:40:14Z (today)

Status: RED every single day for 53+ days (100% failure rate)
  Total runs: 53+ (daily cadence)
  Successful: 0
  Failed: 53+

All nightly runs fail at the e2e matrix step (deterministic IA drift):
  - e2e/activity.e2e.ts:52 selector `.activity-empty` missing (now shared emptyState())
  - e2e/jobs.e2e.ts:53 selector `.sidebar .nav-group` toHaveText 'Manage' missing
  - e2e/ask.e2e.ts:51 selector `.ask-citations .cite-ref` missing

PLUS: report-red job itself errors before running due to workflow config (no checkout on a job with defaults.run.working-directory: app).
```

## Tracked Files & Bytes

Command: `git ls-files | wc -l` → 714 files

File breakdown by directory:
```
Total tracked: 714 files
Most files in: specs/, app/src/kb, app/src/shell, app/src/main
```

## Lines of Code (prod)

Commands:
- `find app/src/kb -name "*.ts" -not -name "*.test.ts" -not -name "*.d.ts" | xargs wc -l` → 31,897 LOC (engine)
- `find app/src/shell -name "*.ts" -not -name "*.test.ts" | xargs wc -l` → 8,281 LOC (shell/renderer)
- `find app/src/main -name "*.ts" -not -name "*.test.ts" | xargs wc -l` → 5,313 LOC (Electron main)
- `find app/src -name "*.css" | xargs wc -l` → 2,600 LOC (CSS)

**Total prod LOC: ~46,129** (confirms prior context)
Plus: test LOC ~43,643 (0.95:1 ratio)

---

## Summary

- Repository is **7 weeks dormant** (main @ 2026-07-13, today is 2026-09-04)
- **All dev work stopped immediately after merge surge on 2026-07-13**
- **Nightly CI has been RED for 53 consecutive days** with no fix attempts
- **0 open PRs, 0 releases, 0 tags** (v0.1.0 in package.json)
- **89.9% conventional-commit compliance** (good)
- **59.6% ultra-fast merges** (< 15 min) with **0% peer reviews** (high velocity, zero quality gates)
- **144 remote branches**, 96 stale (>30 days), all abandoned feature/mission branches
- **All 27 issues from prior deep-review (07-12) closed by 07-13**, 18 without linked PRs (merged as issue-closes, not PR-attached)
