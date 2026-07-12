# 03 — Reliability (bug hunt)

Deep Review 2026-07-12. Static analysis at `origin/main` (`8e8ec5b`). Fifteen new, read-verified bugs with concrete failure scenarios; the known 07-05 items (promote checkout-swallow `kb/staging.ts:97-101`, `commitControlFile` shared-worktree commit `main/pipeline.ts:1983-1990`, human-edit clobber, unparseable-doc vanishing, reflect parse-seam containment, connect's missing circuit breaker) were spot-checked — all still present — and are **not** restated. IDs `BUG-1..15` shared with `05-issue-index.md`. Repo bar applies to every fix: fails-before/passes-after regression test of the **class**.

---

## P0 — hang and corruption class

### BUG-1 — Raw, unbounded git inside the canonical-writer lock; the watchdog only logs → one stalled git = app-wide permanent hang
- `kb/reviewStore.ts:233-236` — `answerReview`'s critical section runs `simpleGit(root)` + `git add -A` + commit with **no timeout**, violating the repo's own #163 boundedGit rule honored everywhere else.
- `kb/healthRemediation.ts:103-106` — health dismiss: same pattern.
- `kb/stageLock.ts:87-97` — the watchdog only `log.warn('lock.stuck')`; it never times out, rejects, or evicts. FIFO chaining (`:109`) queues every later section forever.
- Everything queues behind the same mutex: capture (`kb/orchestrator.ts:265`), all registry/settings writes, promote; `ipc.ts:242-276` awaits capture with no timeout.
**Scenario:** vault on iCloud/Dropbox with a not-yet-materialized file, a user-installed git hook, or a huge dirty tree → `git add -A` stalls inside the section. From then on every capture, review answer, settings save, and promotion hangs until relaunch — exactly the reported "hangs, needs restart." Note `add -A` also scoops unrelated dirt into "review answered" commits (same family as BUG-10).
**Fix:** boundedGit with the effective timeout in both sites + pathspec-scoped adds; give `Mutex.run` an optional `sectionTimeoutMs` that **rejects** the holder (not just logs) and releases the chain.
**AC:** greppable invariant — no `simpleGit(` without a timeout inside any `lock.run` closure; a stalled section past threshold rejects and the next queued section runs.
**Test:** inject a never-resolving git fn as a section: assert `lock.stuck` fires, the caller rejects at the deadline, and a subsequently queued capture completes.

### BUG-2 — macOS quit never stops the pipeline; an interrupted cherry-pick is never healed; the next capture can silently commit a half-applied tree
- `main.ts:131-133` — `will-quit` stops only the quick-capture agent; `stopPipeline()` lives in `window-all-closed`, which darwin never fires on Cmd-Q (`lifecycle.ts:14-16`). Quit kills git children mid-advance.
- `kb/canonicalAdvance.ts:198` — collision cherry-picks run in the **staging worktree**; abort exists only on the in-process error branch (`:205`). SIGKILL mid-pick leaves `CHERRY_PICK_HEAD` + a part-applied index.
- Startup heal covers **only** `index.lock` (`kb/canonicalLockHeal.ts`; `pipeline.ts:346-349`); the staging health check is just `rev-parse --is-inside-work-tree` (`stagingWorktree.ts:42-47`) — a mid-cherry-pick worktree passes. No `cherry-pick --abort`/sequencer handling exists anywhere else (grep-verified).
- `kb/ingest.ts:162-165` — the next capture runs plain `git add inbox` + `commit` in that same worktree, **concluding** the stale cherry-pick with whatever half-applied (possibly conflict-markered) tree was in the index, under a "capture:" message; promote then mirrors it to main. Alternative outcome: every `merge --ff-only` fails until manual git surgery — a restart-doesn't-fix wedge.
**Fix:** (1) startup reconcile: detect sequencer state (`CHERRY_PICK_HEAD` etc.) in the staging gitdir and abort/reset before stages start — committed staging state is the durable truth by design; (2) `before-quit`: stop the pipeline + best-effort ≤2s lock flush, then `app.exit()`.
**AC:** simulated `CHERRY_PICK_HEAD` at startup is cleared before the first drain; a capture after an interrupted pick commits only `inbox/` paths.

## P1 — wedges, races, data integrity

### BUG-3 — Archive has no poison quarantine: one bad inbox unit permanently stalls the stage (cap=1 ⇒ ingestion halts); crashes can mint such units
Any item failure in `drainOnce` logs and `return`s — the item stays queued (no set-aside exists for archive, unlike claims/connect) and, being ULID-sorted, re-heads the batch every 30s forever; `afterDrain` promotion is skipped every pass (`kb/orchestrator.ts:319,340-352`). Three poison mints: (a) crash between unit-write and commit (`ingest.ts:156→165`) — the partial unit is later rescue-committed by the next capture's `git add inbox`; (b) torn first line of `audit.jsonl` → uncaught `JSON.parse` throw (`ingest.ts:175`); (c) a >2GiB file → `ERR_FS_FILE_TOO_LARGE` **inside** `lock.run('normalize')` (`ingest.ts:207`; `orchestrator.ts:312`) → the whole stage dead-loops `drain-fatal` every sweep.
**Fix:** per-item failure counter → after K failures move to `inbox/.setaside/` + audit event surfaced in the existing set-aside UI; treat meta/oversize errors as item-level (skip, continue batch); size-cap normalize/capture reads with an audited `capture-refused`.
**AC:** a corrupt unit is quarantined after K sweeps while the rest drains and promotion resumes; a 3GiB drop yields an audited refusal, not a loop.

### BUG-4 — Approved-consolidation effects share one fixed worktree/branch with `reset --hard`, and run concurrently per answered review → "executed" without landing
`void runAnsweredReviewEffects` per answer (`pipeline.ts:1004`, deliberately unawaited) → `executeApprovedConsolidation` uses a **fixed** worktree/branch and `reset --hard` in `prepare`, off-lock (`kb/executeApprovedConsolidation.ts:18-19,47-67,95-112`; `canonicalAdvance.ts:256` locks only the advance). Confirming two consolidations back-to-back: B's reset discards A's not-yet-advanced commit; A ff-merges an ancestor ("already up to date" ⇒ `advanced`), reports `executed:true`, records the durable merge directive — **but nothing merged**; loser nodes silently survive.
**Fix:** serialize effects per vault (promise chain) or run under `withConcurrentAdvance` with an ephemeral per-run worktree (the primitive exists).
**AC:** two concurrent approvals both land; `executed:true` ⇒ loser paths absent at staging HEAD.

### BUG-5 — Watch/intake/researcher ingestion commits to the staging repo **outside** the canonical lock — a second, uncoordinated git writer
`captureToInbox` commits on the staging root (`ingest.ts:162-165`); its "runs under the canonical-writer lock" comment is true only for the orchestrator caller. Unlocked callers: `watchRun.ts:111-112` (no lock at all), `intakeRun.ts:154` (scheduler constructed without a lock, `pipeline.ts:475`), `researchRun.ts:188` (`researcherScheduler.ts:56` takes `_lock` and ignores it). Concurrent with stage advances/promotes on the same index ⇒ intermittent `index.lock: File exists` failures (random red stages, watch-pass retries), and worse, ingest-staged entries interleaving into an ff-merged index snapshot. These unlocked ops also never register the ORCH-27 pid sidecar, so a kill mid-op leaves an anonymous `index.lock` the heal only clears after 120s.
**Fix:** thread the vault mutex into all three schedulers (or route them through `orch.capture()`); greppable invariant: no `captureToInbox` call site outside `lock.run`.

### BUG-6 — Watched-folder reconcile ingests files mid-copy → truncated "immutable" sources, forever
chokidar's `awaitWriteFinish` stabilizes only the **triggering event**; every event rescans the whole folder and plain-reads every file with no per-file stability check (`watchScheduler.ts:33`; `watchRun.ts:181-202`; `watchConnectors.ts:140`); the startup reconcile has no stability layer at all (`watchScheduler.ts:120`). Drag 10 files: file 1 completes → scan reads files 2-10 mid-copy → truncated bytes are minted as immutable primary sources (ledger hash recorded), cognition decomposes garbage, and the completed copies later re-ingest as *new* sources. Sources are append-only by design and SPEC-0059 delete is still a draft — the damage is permanent today.
**Fix:** two-stat stability gate (skip if `mtime` within N seconds or size changed between probes); the trailing coalesced pass picks up skipped files.
**AC:** a file whose size changes between stats is not ingested that pass; exactly one source once stable; startup reconcile obeys the same gate.

### BUG-7 — `Promise.all` batch abort leaves sibling `archiveOne`s running unawaited → duplicate cognition and re-dispatch races
One rejection aborts the batch await while survivors keep running (holding worktrees, later taking the lock) unobserved; a pending poke can re-enter `drainOnce`, re-dispatching ids whose originals are still in flight — duplicate copilot spend, add/add cherry-pick conflicts, `busy()` under-reporting (`kb/orchestrator.ts:271,295,324-339`). **Fix:** `Promise.allSettled` + per-item error handling; never leave batch promises unobserved.

### BUG-8 — Full Replay races in-flight cognition: pre-epoch derived data can land after the purge
`stopAllStages` stops sweep **timers** only; nothing awaits in-flight items (`pipeline.ts:2021`; `:181-196`). An item mid-cognition finishes after the purge commit and its advance cherry-picks pre-epoch derived files onto the cleaned tree (`replay.ts:134-199`; `canonicalAdvance.ts:198`) — no epoch check exists at the advance seam. Result: stale + freshly-re-derived duplicates in the "rebuilt" vault. **Fix:** in-memory replay epoch captured at prepare-start, checked (noop-drop) under the advance lock; or await stage idleness before purging. **AC:** an advance prepared before the purge cannot land after it.

## P2 — robustness batch

- **BUG-9 — half-succeeded capture → duplicate sources:** unit files written before a failing commit are rescue-committed later while the UI said "failed" — the user re-captures (`ingest.ts:104-167`). Fix: rm just-written unit dirs on commit failure (bytes are still in the user's hands at this surface), or dedupe by contentHash at archive.
- **BUG-10 — unscoped commits under the lock:** `commitControlFile` and capture commit whatever is staged, folding a crashed prior op's leftovers into "control-panel:"/"capture:" commits (`pipeline.ts:1983-1990`; `ingest.ts:164`). Fix: pathspec-scoped commits (`git commit -- <rel>` / `-- inbox`).
- **BUG-11 — quiesce can hang at "Publishing the last changes…" with a 1Hz retry storm:** every status poll fires `void promoter.flushNow()` while `promotePending`; a persistently failing promote keeps `dirty=true` and the Settings 1s poll re-triggers it forever with no surfaced error (`pipeline.ts:278`; `coalescingPromoter.ts:79`; `settingsView.ts:716`). Fix: bounded attempts + an honest failure detail; the readout must be able to say *failed*.
- **BUG-12 — no mount error boundary:** the view container is cached **before** the fire-and-forget mount; a mount rejection is telemetry-only and the view is a permanently blank pane until relaunch (`shell.ts:153-159`; `renderer.ts:144-150`). Fix: catch → drop the cached container → render the retry face.
- **BUG-13 — non-atomic `appConfig` write can forget the active vault** (crash mid-write → JSON parse fallback `{activeVaultPath:null}` → first-run setup; looks like data loss). The tmp+rename idiom already exists in `conversationStore.ts:50-54`. Fix: reuse it.
- **BUG-14 — `isResearcherDue` walks every `audit.jsonl` per researcher per 60s** (`researcherScheduler.ts:28` → `readAllAuditEvents`), and the same full walk backs the Connectors/Agents panel reads (`pipeline.ts:1464,1577,1785`) — seconds of IO per minute forever and 8s-timeout "Couldn't load" trips on populated vaults. Fix: due-check off the registry's own `lastRunAt`; panel lastEvent from the HEAD-keyed cache. (The concrete scheduler-side cost of the no-index gap.)
- **BUG-15 — `canonicalHead`/`readHead` are unbounded git spawns on hot paths** (`canonicalAdvance.ts:156-158`; `activityIndex.ts:189-195`) — off-lock, so a stall silently wedges that stage/feed (`busy()` true forever blocks quiesce-safe). Fix: boundedGit both; same greppable invariant as BUG-1.

---

## Systemic patterns (what the classes have in common)

1. **One mutex, observability-only supervision.** Watchdogs log; nothing enforces deadlines or evicts. BUG-1/5/11/15 are all "one stuck or bypassing writer poisons everything." Structural fix: lock-layer section deadlines + a registry of **all** repo writers (schedulers included).
2. **No transactional boundary around multi-step git state.** Capture, consolidation, cherry-pick advance, and promote each have crash windows whose halves are individually fine and jointly corrupting (BUG-2/3/9). Startup healing covers exactly one artifact (index.lock); it should become a general sequencer/uncommitted-unit/worktree reconcile pass.
3. **Fire-and-forget without single-flight ownership** (BUG-4/7/11): decoupling heavy effects from UI acks is right; doing it without per-resource serialization isn't.
4. **Poison-item handling is per-stage folklore, not a spine guarantee** (BUG-3): claims/connect earned set-asides from incidents #135/#157; archive never did. A shared "K failures → quarantine + surface" contract at the drain spine closes the class.
5. **Renderer error strategy is telemetry-only** (BUG-12): faults are logged to main and never rendered; combined with mount-once caching, any renderer fault means restart.

These five patterns — not the fifteen individual bugs — are what the reliability issues in `05-issue-index.md` are scoped around.
