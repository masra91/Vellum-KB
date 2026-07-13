// The active-vault LIFECYCLE core (#574, fast-follow to #528/#572): the ActivePipeline singleton,
// startPipeline's full stage-graph boot sequence, QUIESCE (graceful shutdown), stopPipeline/
// stopPipelineForQuit, and Full Replay. Extracted out of pipeline.ts (which had grown past its
// #528 AC target of <800 lines even after #572's registry/decider-family extraction) — this is
// deliberately the LAST piece split out, since it's the riskiest code in the file (same class as
// #515/#517's canonical-lock hardening): the single source of truth for which stages run, and the
// only writer of the `active` singleton every other pipeline module reads through {@link getActivePipeline}.
//
// `pipeline.ts` re-exports everything below unchanged, so no importer (ipc.ts, tests) needs to change
// its import path — a pure extraction, `export { X } from './pipelineLifecycle'`, mirroring the
// `commitControlFile` re-export precedent #572 already established.
//
// `pipelineProjections.ts` (the maintained status/review/graph/Today stores) needs to (a) read the
// active pipeline and (b) start/stop alongside the stages. (a) is `getActivePipeline()`. (b) is NOT a
// direct import of the projection stores here — that would create a circular module dependency
// (lifecycle → projections → lifecycle, since projections needs `getActivePipeline`/`ActivePipeline`
// from here). Instead, `pipelineProjections.ts` self-registers its start/stop via
// {@link registerProjectionLifecycleHooks} at its own module-init time (its file is always loaded,
// since `pipeline.ts`'s barrel re-exports it) — a one-directional dependency inversion, no cycle.
import path from 'node:path';
import { createCoalescingPromoter, type CoalescingPromoter } from '../kb/coalescingPromoter';
import { Orchestrator, readQueue } from '../kb/orchestrator';
import { makeCopilotDecider } from '../kb/copilotAgent';
import { makeSensitivityClassifier } from '../kb/sensitivityClassifier';
import { DecomposeStage, readDecomposeQueue } from '../kb/decomposeStage';
import { makeDecomposeDecider } from '../kb/decomposeAgent';
import { ClaimsStage, readClaimsQueue, type SetAsideItem } from '../kb/claimsStage';
import { makeClaimsDecider } from '../kb/claimsAgent';
import { ComposeStage, readComposeQueue } from '../kb/composeStage';
import { makeComposeDecider } from '../kb/composeAgent';
import { ConnectStage, readConnectQueue, type ConnectSetAsideItem } from '../kb/connectStage';
import { makeConnectDecider } from '../kb/connectAgent';
import { Mutex } from '../kb/stageLock';
import { createVaultDevLog, type DevLog } from '../kb/devlog';
import { breadcrumbObserver } from '../kb/activityBreadcrumb';
import { commitControlFile } from './commitControlFile';
import { researchDepsOptions, intakeDepsOptions, mediaExtractOptions } from './researchWiring';
import { createVaultTracer } from '../kb/tracing';
import { ensureStagingWorktree } from '../kb/stagingWorktree';
import { reapEphemeralWorktrees, bumpReplayEpoch } from '../kb/canonicalAdvance';
import { fastHeadSha } from '../kb/gitHeadFast';
import { CanonicalQueueCache } from '../kb/queueCache';
import type { CandidateSet } from '../kb/connectAgent';
import type { ArchiveSetAsideItem } from '../kb/orchestrator';
import { reconcileStaleIndexLock, hasLiveIndexHolder, reconcileCherryPickSequencer } from '../kb/canonicalLockHeal';
import { promote } from '../kb/staging';
import { runFullReplay } from '../kb/replay';
import { JobScheduler } from '../kb/jobScheduler';
import { exampleJobBehavior, EXAMPLE_JOB_TYPE } from '../kb/exampleJob';
import { makeReflectJobBehavior, REFLECT_JOB_TYPE } from '../kb/reflectJob';
import { makeReflectDecider } from '../kb/reflectAgent';
import { readInstanceConfig, resolveStageCaps } from '../kb/instanceConfig';
import { applyCopilotCeiling } from '../kb/copilotConcurrency';
import { setAgentModelOverrides } from '../kb/copilotModel';
import { initLaunchModel } from '../kb/copilotModelProbe';
import { researcherRegistryPath } from '../kb/researcherRegistry';
import { seedDefaultResearcherIfAbsent } from '../kb/researcherSeed';
import { ResearcherScheduler } from '../kb/researcherScheduler';
import { IntakeScheduler } from '../kb/intakeScheduler';
import { WatchScheduler } from '../kb/watchScheduler';
import type { ConversionCounts } from '../kb/conversionCounts';
import type { JobBehavior } from '../kb/jobs';
import type { QuiesceStatus, FullReplayResult } from '../kb/types';

/** Factory to create a job behavior resolver with scoped vaultPath (SPEC-0023, Copilot context scope).
 *  v1 ships the deterministic example job and **Reflect** (SPEC-0024, the first real job);
 *  later job types register here as they land. An unknown type returns null and the scheduler skips it. */
function createJobBehaviorResolver(vaultPath: string): (type: string) => JobBehavior | null {
  return (type: string): JobBehavior | null => {
    if (type === EXAMPLE_JOB_TYPE) return exampleJobBehavior;
    if (type === REFLECT_JOB_TYPE) return makeReflectJobBehavior(makeReflectDecider({ vaultPath }));
    return null;
  };
}

export interface ActivePipeline {
  vaultPath: string; // the vault root — on `main`, what Obsidian sees (promotion target)
  stagingWt: string; // the staging worktree — where every stage operates
  orch: Orchestrator;
  decompose: DecomposeStage;
  connect: ConnectStage;
  claims: ClaimsStage;
  compose: ComposeStage; // SPEC-0046: the final Enrich stage — (re)writes entity prose from cited claims
  jobs: JobScheduler; // SPEC-0023: wakes autonomous jobs on a schedule (concurrent, single-flight)
  researchers: ResearcherScheduler; // SPEC-0028: wakes scheduled researchers (standing passes via ingest)
  intake: IntakeScheduler; // SPEC-0041: wakes proactive-intake connectors (feed pulls → primary sources)
  watch: WatchScheduler; // SPEC-0037: live folder watchers (stable files → primary sources, non-destructive)
  lock: Mutex;
  promoter: CoalescingPromoter; // STAGING-12: coalesces per-drain promotion into infrequent batched bursts
  // BUG-11 (#518): consecutive coalesced-promote failures + the last error, since we started force-
  // flushing for the current quiesce. Bounds `quiesceStatusForActive`'s auto-flush (below) so a
  // persistently-failing promote() doesn't get hammered every ~1s poll forever — after
  // MAX_QUIESCE_FLUSH_ATTEMPTS we stop forcing an immediate retry and surface the real cause instead of
  // an eternal "Publishing…". The underlying promoter still retries on its own quiescent/max-wait cadence
  // (`runPromote`'s `if (dirty) arm()`) — a later success resets this back to 0. A plain mutable object
  // (not fields directly on `active`) so the promoter's closures — created before `active` is assigned —
  // mutate ONE fixed target rather than the swappable `active` singleton.
  quiesceFlush: { attempts: number; error: string | null };
  log: DevLog; // the vault dev-log — reused by Run-now so a researcher failure is logged (#160)
  quiescing: boolean; // SPEC-0045 QUIESCE: true once "Prepare for shutdown" paused new work (drain in progress)
  // #506: the status tick used to re-walk decompose/connect/claims' queues + conversion counts + set-
  // asides from scratch every 2.5s even when nothing had changed. HEAD-keyed memos (own instances, not
  // shared with the stages' internal drain-loop caches) so an idle tick costs a spawn-free sha read
  // instead of a full tree walk. One instance per active vault (mirrors the per-stage `queueCache` fields).
  statusCache: {
    decompose: CanonicalQueueCache<string[]>;
    connect: CanonicalQueueCache<CandidateSet[]>;
    claims: CanonicalQueueCache<string[]>;
    conversion: CanonicalQueueCache<ConversionCounts>;
    claimsSetAside: CanonicalQueueCache<SetAsideItem[]>;
    connectSetAside: CanonicalQueueCache<ConnectSetAsideItem[]>;
    archiveSetAside: CanonicalQueueCache<ArchiveSetAsideItem[]>;
  };
}

// STAGING-12 promotion cadence — `main` is the live Obsidian vault, so promote in infrequent bursts,
// not per-drain. Debounce: promote once drains go quiet for QUIESCENT_MS; cap: publish at least every
// MAX_WAIT_MS under continuous processing so `main` isn't starved. (Tunable; an Obsidian-aware
// "calm-vault" backoff is the tracked follow-up.)
const PROMOTE_QUIESCENT_MS = 30_000; // 30s of quiet → promote
const PROMOTE_MAX_WAIT_MS = 180_000; // …but at least every 3 min under a continuous drain
// BUG-11 (#518): how many consecutive forced flushes `quiesceStatusForActive` will attempt before it
// gives up hammering promote() every poll and defers to the promoter's own (much slower) backoff.
export const MAX_QUIESCE_FLUSH_ATTEMPTS = 3;

let active: ActivePipeline | null = null;

/** The full active-pipeline record (internal — `pipelineProjections.ts` + `pipeline.ts`'s remaining
 *  IPC handlers read through this rather than a module-level `active` import, since `active` itself
 *  stays private to this module — the ONE writer). Null when no vault is open. */
export function getActivePipeline(): ActivePipeline | null {
  return active;
}

/** The active vault's `.kb/cache` dir — where OBS-21 writes a heap snapshot (gitignored), or null
 *  when no vault is open (the sampler then skips the snapshot). Passed to the telemetry glue. */
export function activeSnapshotDir(): string | null {
  return active ? path.join(active.vaultPath, '.kb', 'cache') : null;
}

/** The archivist orchestrator for the loaded KB, or null if none is active. */
export function activePipeline(): Orchestrator | null {
  return active?.orch ?? null;
}

/** The active vault's `staging` worktree — where the full working-zone audit lives (per-item
 *  audit.jsonl, connect/, .kb/jobs, .kb/cache/ask, .kb/audit.jsonl), a superset of the evergreen archive
 *  promoted to `main`. The read root for the Audit & Activity views (SPEC-0029). Null if no active KB. */
export function activeStagingRoot(): string | null {
  return active?.stagingWt ?? null;
}

/** Hooks {@link pipelineProjections.ts} registers (dependency inversion — see the file-header note on
 *  why this isn't a direct import) so its four maintained stores start/stop in lockstep with the
 *  stages, without this module ever importing from `./pipelineProjections`. */
export interface StageLifecycleHooks {
  onStart: () => void;
  onStop: () => void;
}
let projectionHooks: StageLifecycleHooks = { onStart: () => {}, onStop: () => {} };
export function registerProjectionLifecycleHooks(hooks: StageLifecycleHooks): void {
  projectionHooks = hooks;
}

/** Start every active stage's poke/sweep loop (+ the maintained projection stores, via the registered
 *  hook). The SINGLE source of truth for "which stages run" — both `startPipeline` and `fullReplay`'s
 *  resume call this, so a replay can never diverge from normal startup (e.g. start a stage that startup
 *  deliberately leaves dormant). */
function startActiveStages(a: ActivePipeline): void {
  a.orch.start();
  a.decompose.start();
  a.connect.start();
  a.claims.start();
  a.compose.start(); // SPEC-0046: the Compose Enrich stage (entity prose from cited claims)
  a.jobs.start(); // SPEC-0023: the autonomous-job scheduler tick (named-preset cadence)
  a.researchers.start(); // SPEC-0028: the scheduled-researcher tick (standing external research)
  a.intake.start(); // SPEC-0041: the proactive-intake tick (scheduled feed pulls → primary sources)
  a.watch.start(); // SPEC-0037: live folder watchers (startup reconcile + chokidar stable-file events)
  projectionHooks.onStart(); // OBS-24/SHELL-12/SPEC-0058: the maintained status/review/graph/Today stores
}

/** Stop every stage's sweep loop (+ the maintained projection stores) — shutdown, vault switch, or
 *  pre-replay pause. */
function stopAllStages(a: ActivePipeline): void {
  a.orch.stop();
  a.decompose.stop();
  a.connect.stop();
  a.claims.stop();
  a.compose.stop();
  a.jobs.stop();
  a.researchers.stop();
  a.intake.stop(); // SPEC-0041
  a.watch.stop(); // SPEC-0037: close all live folder watchers
  a.promoter.stop(); // STAGING-12: cancel a pending promotion timer (no promotes while drains are stopped)
  projectionHooks.onStop();
}

// ── SPEC-0045 QUIESCE — graceful shutdown (drain, don't kill) ───────────────────────────────────
//
// Quiesce stops the NEW-WORK PRODUCERS (the 4 schedulers + capture enqueue) but leaves the pipeline
// DRAINERS (orchestrator + decompose/connect/claims) running, so already-captured work flows to clean
// completion + commit (QUIESCE-2) — leaning entirely on the existing fault-tolerance floor (QUIESCE-4:
// no new correctness code). It is a convenience: an abrupt stop mid-drain is just another restart the
// reconcile/idempotency guarantees already cover.

/** Stop only the new-work producers — the scheduled triggers. An in-flight run finishes (the scheduler
 *  `busy()` stays true until it does); only NEW runs are halted. The drainers keep processing the queue. */
function stopProducers(a: ActivePipeline): void {
  a.jobs.stop(); // SPEC-0023 — no new scheduled jobs
  a.researchers.stop(); // SPEC-0028 — no new scheduled researcher passes
  a.intake.stop(); // SPEC-0041 — no new feed pulls
  a.watch.stop(); // SPEC-0037 — no new folder watching (restart-reconcile catches anything that lands while down)
}

/** Restart the new-work producers (Resume / normal start). */
function startProducers(a: ActivePipeline): void {
  a.jobs.start();
  a.researchers.start();
  a.intake.start();
  a.watch.start();
}

/** Enter QUIESCING (QUIESCE-1): pause new ingestion + scheduled work; the pipeline keeps draining. */
export async function quiesceActive(): Promise<QuiesceStatus> {
  if (!active) return { quiescing: false, remaining: 0, safe: false, detail: 'No library is open.' };
  if (!active.quiescing) {
    active.quiescing = true;
    // BUG-11 (#518): a fresh quiesce gets a fresh bounded-retry budget — a failure from a PRIOR
    // shutdown attempt (that the Principal then resumed from) shouldn't poison this one.
    active.quiesceFlush.attempts = 0;
    active.quiesceFlush.error = null;
    stopProducers(active);
    active.log.child({ scope: 'quiesce' }).info('quiesce.start', { why: 'Principal requested Prepare for shutdown' });
  }
  return (await quiesceStatusForActive())!;
}

/** Leave QUIESCING (QUIESCE-5, reversible): un-pause — restart producers, resume normal running. */
export async function resumeActive(): Promise<QuiesceStatus> {
  if (!active) return { quiescing: false, remaining: 0, safe: false, detail: 'No library is open.' };
  if (active.quiescing) {
    active.quiescing = false;
    startProducers(active);
    active.log.child({ scope: 'quiesce' }).info('quiesce.resume', { why: 'Principal resumed before quitting' });
  }
  return (await quiesceStatusForActive())!;
}

/** Is the active pipeline quiescing? (the capture path checks this to pause new ingestion, QUIESCE-1). */
export function isActiveQuiescing(): boolean {
  return active?.quiescing === true;
}

/**
 * BUG-11 (#518): the flush-bounding + `detail` decision, pulled out pure (no I/O) so it's directly
 * testable without spinning up a whole pipeline. See the call site below for the retry-storm history.
 */
export function quiesceFlushDecision(
  quiescing: boolean,
  remaining: number,
  promotePending: boolean,
  flush: { attempts: number; error: string | null },
): { shouldFlush: boolean; safe: boolean; detail: string } {
  const flushExhausted = flush.attempts >= MAX_QUIESCE_FLUSH_ATTEMPTS;
  const shouldFlush = quiescing && remaining === 0 && promotePending && !flushExhausted;
  const safe = quiescing && remaining === 0 && !promotePending;
  const detail = !quiescing
    ? 'Running normally.'
    : safe
      ? 'Safe to shut down — all work finished.'
      : remaining === 0 && promotePending && flushExhausted
        ? `Couldn't publish — ${flush.error ?? 'the last changes to your library are stuck.'}` // BUG-11: honest failure instead of an eternal "Publishing…"
        : remaining === 0 && promotePending
          ? 'Publishing the last changes to your library…'
          : `Finishing up — ${remaining} item${remaining === 1 ? '' : 's'} remaining…`; // "items" matches Status/tray vocab (Design-Lead)
  return { shouldFlush, safe, detail };
}

/**
 * The live drain status (QUIESCE-3): `remaining` = queued items across stages + anything in flight
 * (a busy stage or scheduler counts its current item); `safe` = quiescing AND fully idle — every stage
 * queue empty, no stage/scheduler in flight, AND the canonical writer lock free (so the last commit is
 * done). The same primitives the Status view reads — no separate source of truth.
 */
export async function quiesceStatusForActive(): Promise<QuiesceStatus | null> {
  if (!active) return null;
  const { stagingWt, lock, orch, decompose, connect, claims, compose, jobs, researchers, intake, watch, quiescing } = active;
  const [archiveQ, decompQ, connectQ, claimsQ, composeQ] = await Promise.all([
    readQueue(stagingWt),
    readDecomposeQueue(stagingWt),
    readConnectQueue(stagingWt),
    readClaimsQueue(stagingWt),
    readComposeQueue(stagingWt),
  ]);
  const queued = archiveQ.length + decompQ.length + connectQ.length + claimsQ.length + composeQ.length;
  const stagesBusy = [orch, decompose, connect, claims, compose].filter((s) => s.busy()).length;
  const schedulersBusy = [jobs, researchers, intake, watch].filter((s) => s.busy()).length;
  const lockBusy = lock.state().held ? 1 : 0;
  // `remaining` counts queued items + everything in flight; the lock being held means a commit is still
  // landing, so it must clear before "safe" even if the queues read empty mid-write.
  const inFlight = stagesBusy + schedulersBusy + lockBusy;
  const remaining = queued + inFlight;
  // STAGING-12: a pending coalesced promotion means `main` still owes its last batch — NOT safe to quit
  // yet. When everything else is idle, flush it now (don't wait the debounce window) so the vault is
  // current and "safe" is reached promptly + honestly.
  //
  // BUG-11 (#518): settingsView polls this every ~1s while quiescing, and `flushNow()` never throws (a
  // failed promote() is swallowed internally — see coalescingPromoter's onError/dirty-retry). Calling it
  // unconditionally forced an IMMEDIATE retry on every single poll — bypassing the promoter's own
  // debounce/cap backoff entirely — with the failure never surfaced beyond a dev-log line, so a
  // persistently-failing promote() looked like a permanently-stuck "Publishing…" and hammered promote()
  // forever. Now bounded: stop forcing an immediate retry after MAX_QUIESCE_FLUSH_ATTEMPTS consecutive
  // failures (the promoter still retries on its own slower cadence in the background) and report the
  // real cause instead of pretending it's still in progress.
  const promotePending = active.promoter.pending();
  const { shouldFlush, safe, detail } = quiesceFlushDecision(quiescing, remaining, promotePending, active.quiesceFlush);
  if (shouldFlush) void active.promoter.flushNow();
  return { quiescing, remaining, safe, detail };
}

/**
 * Start (or reuse) the pipeline for `vaultPath`, replacing any prior one. The stages run on the
 * vault's persistent `staging` worktree; the archivist promotes `sources/` to `main` after each
 * drain. All stages share one canonical-writer lock (§5). Async because it provisions the
 * staging worktree before the stages start.
 */
export async function startPipeline(vaultPath: string): Promise<Orchestrator> {
  if (active?.vaultPath === vaultPath) return active.orch;
  if (active) stopAllStages(active);

  // OBS-1/2: per-vault diagnostic dev-log (<vault>/.kb/cache/logs/, gitignored, never promoted).
  // Passed to every stage so failures land here with their cause (OBS-3/4); also captures the
  // worktree-provision failure below — the silent-stall cause that motivated SPEC-0030.
  // OBS-10: verbosity comes from the Instance config (Settings; default info, debug to troubleshoot).
  // The config lives on the persistent `staging` worktree; read best-effort (absent first-run → info).
  // A level change applies on the next pipeline start (vault switch / app restart).
  const stagingInstance = await readInstanceConfig(path.join(vaultPath, '.kb', 'cache', 'worktrees', 'staging'));
  // OBS-18: the breadcrumb observer records the last {stage,runId,itemId} a pipeline line carried, so
  // a crash handler can name what we were mid-flight on. Best-effort + never throws into logging.
  const log = createVaultDevLog(vaultPath, { level: stagingInstance.devLogLevel, onEmit: breadcrumbObserver });
  // OBS-12/13: per-vault latency tracer (<vault>/.kb/cache/spans.jsonl, never promoted). Threaded
  // into every stage so each per-item `stage.run` span + its `copilot.invoke` child are recorded;
  // the perf index (perfIndex.ts) aggregates them. Spans also mirror to the dev log at `debug`.
  const tracer = createVaultTracer(vaultPath, { log });
  // ORCH-28 model-resilience: probe the live copilot CLI's accepted-model catalog and resolve the
  // launch model from the (config-overridable) preference list BEFORE any decider is built, so every
  // stage launches with a model THIS CLI version accepts — never a stale hardcoded pin that would
  // reject pre-flight and kill the pipeline. Best-effort + never throws (a probe failure leaves the
  // floor pin in place); a below-top-tier pick is logged loud (no silent downgrade). The eval
  // `KB_COPILOT_MODEL` override still wins over the probed model.
  await initLaunchModel({ preferences: stagingInstance.modelPreferences, override: stagingInstance.model, log: log.child({ scope: 'model' }) }).catch((err) =>
    log.child({ scope: 'model' }).warn('model.probe-failed', { itemId: vaultPath, err }),
  );
  // SPEC-0048 per-agent overrides: apply the persisted picks (validated at set-time via the picker IPC).
  // A stale per-agent id is caught at launch by the per-call `auto` fallback — narrower blast radius than
  // the global, so we trust the stored value here rather than re-probe.
  setAgentModelOverrides(stagingInstance.agentModels ?? {});
  // SPEC-0048 SCALE-1/2: apply the configured global ceiling (env > Settings > cores-derived) to the
  // shared semaphore, and resolve the per-stage caps (today's defaults overlaid with any overrides;
  // Connect pinned to 1, SCALE-5) — each stage is sized below, live-adjustable via setActiveInstanceSettings.
  const effectiveCeiling = applyCopilotCeiling(stagingInstance.copilotCeiling);
  const stageCaps = resolveStageCaps(stagingInstance);
  log.info('scale.applied', { ceiling: effectiveCeiling, caps: stageCaps });
  const startedAt = Date.now();
  let stagingWt: string;
  try {
    stagingWt = await ensureStagingWorktree(vaultPath); // working surface (on `staging`)
  } catch (err) {
    log.child({ scope: 'pipeline' }).error('startup.worktree-provision-failed', { itemId: vaultPath, err });
    throw err; // unchanged behavior — but no longer silent
  }
  // ORCH-27 STARTUP-RECONCILE: heal a STALE canonical `index.lock` left by a prior crash/timed-out op
  // BEFORE any stage drains — otherwise that orphaned lock makes every advance fatal (the #256 wedge).
  // At startup no advance is in flight, so a present lock is never our live op; the triple-gate still
  // refuses to clear a genuinely-live external lock (fail safe). Best-effort: a heal failure (or a
  // kept live lock) must never block startup — the draining advance will surface a still-held lock.
  await reconcileStaleIndexLock(stagingWt, {
    isLiveInProcHolder: () => hasLiveIndexHolder(stagingWt),
    log: log.child({ scope: 'lock' }),
  }).catch((err) => log.child({ scope: 'lock' }).error('startup.lock-reconcile-failed', { itemId: vaultPath, err }));
  // #515 BUG-2: heal a stuck CHERRY_PICK_HEAD/sequencer left by a crash/kill mid-advance — BEFORE any
  // stage drains, so the first capture's plain `add inbox` + commit never silently concludes a stale,
  // possibly half-applied cherry-pick under a "capture:" message.
  await reconcileCherryPickSequencer(stagingWt, { log: log.child({ scope: 'lock' }) }).catch((err) =>
    log.child({ scope: 'lock' }).error('startup.cherry-pick-reconcile-failed', { itemId: vaultPath, err }),
  );
  // The shared serialized canonical writer for this vault (§5). The watchdog logs a loud `lock.stuck`
  // (scope `lock`) + flips the OBS-7 `stuck` flag if any section is held past the threshold — so a
  // deadlocked/hung critical section surfaces (named by its label) instead of silently wedging (#163).
  // #515: `Mutex.sectionTimeoutMs`/`RunOptions.timeoutMs` (stageLock.ts) give any FUTURE section a hard
  // reject-and-release backstop, but deliberately NOT wired here as a blanket default (KB-QD review):
  // this ONE lock is shared by every stage's heterogeneous sections (connect's linkOne/linkOrphansOnce,
  // claims, compose, decompose, orchestrator…), each chaining a different number of `boundedGit` calls —
  // there's no single constant that's provably ABOVE every section's git-call budget yet BELOW "actually
  // wedged", and a timeout firing WHILE a git call is still in flight would let the next waiter start a
  // concurrent write on the same working tree/index — the exact single-writer violation this issue
  // fixes, not a mitigation of it. The safe, already-proven mechanism is `boundedGit`'s own per-call
  // timeout: every git op in a `lock.run` section now goes through it, so a blocked call rejects on its
  // OWN bound and the chain's `finally` releases normally — no orphaned in-flight write is possible. A
  // per-section timeout is legitimate future work IF paired with a derived (not guessed) budget per
  // section; until then this stays off.
  const lock = new Mutex({ log: log.child({ scope: 'lock' }) });
  // SPEC-0028 RESEARCH-1 / WS-B: seed a default Web researcher on a virgin (or pre-feature) vault so
  // the research pipeline isn't INERT — an empty registry means nothing dispatches even once a
  // `research-request` is emitted. Keyed on the registry FILE's absence (not emptiness), so a
  // Principal who deliberately cleared all researchers is never re-seeded. Write + commit run under
  // the canonical-writer lock (durability — the `.kb/researchers/` registry is tracked on `staging`
  // and would otherwise be wiped by a staging reset; mirrors the jobs registry). Best-effort: a seed
  // failure must never block startup.
  try {
    await lock.run(async () => {
      if (await seedDefaultResearcherIfAbsent(stagingWt)) {
        await commitControlFile(stagingWt, researcherRegistryPath(stagingWt), 'seed default web researcher (SPEC-0028)');
        log.child({ scope: 'pipeline' }).info('startup.researcher-seeded', { templates: ['web'] });
      }
    }, 'seed:default-researcher');
  } catch (err) {
    log.child({ scope: 'pipeline' }).warn('startup.researcher-seed-failed', { itemId: vaultPath, err });
  }
  // STAGING-12: `main` IS the live Obsidian vault folder. Promoting on EVERY drain (~14–46s) made
  // Obsidian's watcher re-index endlessly → nav/files/indexing HANG. So a stage's afterDrain no longer
  // promotes directly — it REQUESTS a promotion, and the coalescer publishes in infrequent batched
  // bursts (debounced by a quiescent window; capped so continuous processing still publishes), each a
  // single commit run serialized under the canonical-writer lock (STAGING-3). Obsidian settles between.
  // BUG-11 (#518): tracks consecutive promote() failures + the last cause, so `quiesceStatusForActive`
  // can bound its forced-flush retries and surface an honest "Couldn't publish — <cause>" instead of
  // hammering promote() every ~1s poll forever. A fixed object (not `active.quiesceFlush` directly) —
  // this closure is created before `active` is assigned below.
  const quiesceFlush: { attempts: number; error: string | null } = { attempts: 0, error: null };
  const promoter = createCoalescingPromoter({
    promote: async () => {
      await lock.run(() => promote(vaultPath, undefined, undefined, log.child({ scope: 'promote' })), 'coalesced:promote'); // STAGING-12 coalesced; log surfaces ORCH-27 stale-lock heal
      quiesceFlush.attempts = 0;
      quiesceFlush.error = null;
    },
    quiescentMs: PROMOTE_QUIESCENT_MS,
    maxWaitMs: PROMOTE_MAX_WAIT_MS,
    onError: (err) => {
      log.child({ scope: 'promote' }).warn('promote.coalesced-failed', { itemId: vaultPath, err });
      quiesceFlush.attempts += 1;
      quiesceFlush.error = err instanceof Error ? err.message : String(err);
    },
  });
  // The promotion gate: publish the evergreen subset staging→main (SPEC-0021 STAGING-3/4). A stage
  // runs it after a drain that changed an evergreen path (archive→sources; connect→entities); per
  // STAGING-12 the per-drain calls coalesce into infrequent bursts (the actual `promote` runs later,
  // under the lock, inside the coalescer) so `main` tracks the resolved graph without a watcher storm.
  const promoteEvergreen = async (): Promise<void> => {
    promoter.request();
  };
  // SENSE-4 Slice 2: classify each source's sensitivity at the ingest boundary so a confidently-public source
  // lands `shareable` and public-web research egress lights up (SENSE-9). Wired with the deterministic,
  // provenance-driven classifier (the safe default — no per-source egress, can't parse-fail, matching the
  // enrich-trigger robustness ethos); the Copilot-backed classifier is built behind the same seam and enabled
  // by passing a `run` to makeSensitivityClassifier.
  const classify = makeSensitivityClassifier();
  // SPEC-0052 MEDIA: extract a text body from dropped PDFs/images at the archive boundary (Copilot
  // multimodal), so a dropped PDF actually enters the KB instead of a dead `![[raw.pdf]]` embed.
  const orch = new Orchestrator(stagingWt, makeCopilotDecider({ vaultPath: stagingWt }), lock, promoteEvergreen, stageCaps.archive, log, tracer, classify, mediaExtractOptions());
  // The four stages run on the staging worktree (root-agnostic) and serialize their canonical
  // advances through the one shared lock (§5). Pipeline order is Decompose→Connect→Claims
  // (SPEC-0020 reorder): Decompose emits candidates, Connect resolves them into evergreen
  // `entities/` (carrying source-dir provenance Claims can read), Claims attaches claims to the
  // resolved graph. They drain independently; the lock keeps their staging ff-advances from
  // racing. Connect + Claims each carry the promotion gate as their afterDrain so resolved
  // entities and their claims become visible on `main` (the archivist already promotes sources/).
  // Per-stage concurrency cap (ORCH-20 / SPEC-0048 SCALE-2): >1 lets a stage run that many items'
  // cognition concurrently, cutting wall-time on a backlog (claims/decompose dominate it). The
  // process-wide `copilotConcurrency` semaphore bounds the TOTAL in-flight copilot subprocesses across
  // all stages + jobs + researchers, so a higher cap can never fan out past the global ceiling. Each
  // stage is sized from `stageCaps` (instance.json overrides over today's defaults) and live-adjustable
  // via setActiveInstanceSettings. Connect now runs cap>1 too (SCALE-5 ephemeral-worktree migration);
  // its resolve drain is per-item-ephemeral, while its link/dedup sweeps stay serial under the lock.
  const decompose = new DecomposeStage(stagingWt, makeDecomposeDecider({ vaultPath: stagingWt }), lock, undefined, stageCaps.decompose, log, tracer);
  // SPEC-0046 COMPOSE: the FINAL Enrich stage (after Claims). It (re)writes each entity node's
  // encyclopedic prose body from that entity's cited claims — idempotent on the claims signature,
  // with a deterministic blocks-only fallback. Declared first so Claims/Connect can poke it when
  // the claims/links they own change. Its afterDrain promotes the (re)composed entity nodes to main.
  const compose = new ComposeStage(stagingWt, makeComposeDecider({ vaultPath: stagingWt }), lock, undefined, promoteEvergreen, stageCaps.compose, log, tracer);
  // Connect's afterDrain promotes the resolved/linked nodes, then pokes Compose: a links change
  // means the prose's woven cross-links (COMPOSE-4) should be regenerated.
  const connect = new ConnectStage(
    stagingWt,
    makeConnectDecider({ vaultPath: stagingWt }),
    lock,
    undefined,
    async () => {
      await promoteEvergreen();
      void compose.poke();
    },
    log,
    tracer,
    stageCaps.connect, // SCALE-5: resolve-stage concurrency (no longer pinned to 1)
  );
  // Claims' afterDrain promotes the new claims, then pokes Connect: now that the entity's claims
  // carry `relatesTo` hints, Connect's link-promotion pass turns them into `[[wikilinks]]`
  // (CONNECT-12) and promotes the linked nodes. (Connect's own 30s sweep is the backstop.) It also
  // pokes Compose: new claims → (re)compose the entity's prose (COMPOSE-7).
  const claims = new ClaimsStage(
    stagingWt,
    makeClaimsDecider({ vaultPath: stagingWt }),
    lock,
    undefined,
    async () => {
      await promoteEvergreen();
      void connect.poke();
      void compose.poke();
    },
    stageCaps.claims,
    log,
    tracer,
  );
  // The autonomous-job scheduler (SPEC-0023): wakes registered jobs on their named-preset cadence,
  // each a bounded, single-flight pass in its own worktree sharing the canonical-writer lock (a
  // job's ff-advance never races a stage's; ORCH-18) and the promotion gate (evergreen job outputs
  // reach `main`). Jobs run concurrently with the live pipeline (ORCH-17) — never blocking
  // capture/Enrich. Inert until the Principal enables a job in the registry.
  const jobs = new JobScheduler(stagingWt, createJobBehaviorResolver(stagingWt), lock, promoteEvergreen, log);
  // SPEC-0028 RESEARCH-2/3: the researcher tick. Each tick first runs an inline sweep (routes any
  // pending `research-request` signals a stage emitted through the dedup dispatcher), then a standing
  // pass for every due scheduled researcher. Both execute via runResearcher — output is a cited
  // secondary source via the ingest path (NOT the JobBehavior write-sink — Option (a), JOBS-10
  // intact). The cognition is the Web SDK adapter behind the seam (egress-gated + SSRF-safe), wired
  // with the resolved BYOA copilot cliPath so it runs in the packaged app, and the dev-log so a
  // session failure is logged + surfaced as `research-failed` (#160), not a silent no-finding.
  // Reaching outside the KB is read-only-world (AUTO-6).
  // Wire the resolved BYOA copilot cliPath + the dev-log into BOTH researcher entry points via the one
  // shared seam (#160 / BUG #65): without cliPath the packaged app can't spawn copilot → the SDK throws.
  const researchers = new ResearcherScheduler(stagingWt, researchDepsOptions(log), lock, log);
  // SPEC-0041 INTAKE: the proactive-intake tick. Each tick pulls every due connector's feed (RSS in
  // Slice 1; M365-mail in Slice 2) and writes new items as immutable PRIMARY sources via the ingest
  // path (origin:'external') — reusing the JOBS scheduling shape but NOT the JobBehavior write-sink
  // (the researcherScheduler seam; JOBS-10 intact). Read-only w.r.t. the world (INTAKE-7). Inert
  // until the Principal registers + enables a connector in `.kb/intake/registry.json`.
  const intake = new IntakeScheduler(stagingWt, intakeDepsOptions(), lock, log);
  // SPEC-0037 WATCH: live folder watchers. Each enabled, loop-safe folder gets a startup reconcile +
  // a chokidar watcher whose stable-file events drive a non-destructive copy → INGEST. The loop-guard
  // checks watched folders against the REAL vault root (vaultPath), never staging. Inert until the
  // Principal registers + enables a folder in `.kb/watch/registry.json`.
  const watch = new WatchScheduler(stagingWt, vaultPath, log, { lock });
  active = {
    vaultPath,
    stagingWt,
    orch,
    decompose,
    connect,
    claims,
    compose,
    jobs,
    researchers,
    intake,
    watch,
    lock,
    promoter,
    quiesceFlush,
    log,
    quiescing: false,
    statusCache: {
      decompose: new CanonicalQueueCache(fastHeadSha),
      connect: new CanonicalQueueCache(fastHeadSha),
      claims: new CanonicalQueueCache(fastHeadSha),
      // Conversion counts read BOTH roots (staging + the promoted-to main) — key on both shas so a
      // promotion-only change (main's HEAD moves, staging's doesn't) still busts the memo.
      conversion: new CanonicalQueueCache(async () => `${await fastHeadSha(stagingWt)}:${await fastHeadSha(vaultPath)}`),
      claimsSetAside: new CanonicalQueueCache(fastHeadSha),
      connectSetAside: new CanonicalQueueCache(fastHeadSha),
      archiveSetAside: new CanonicalQueueCache(fastHeadSha),
    },
  };
  const readyMs = Date.now() - startedAt; // when the Jobs/read IPC went live — independent of the reap
  // #135 cascade recovery: at boot no ephemeral per-item worktree is legitimately in flight, so reap
  // any leaked `<stage>-<ULID>` worktrees + their `kb/*-work-*` branches left by a crash/kill (the
  // poison-loop's leak that degraded staging + wedged the Jobs UI). Best-effort. Runs AFTER `active`
  // is set — so the read-only IPC (listJobs, getState) is live immediately and the reap no longer
  // strands the Jobs UI behind an O(leaked-N) sequence of git spawns — but BEFORE startActiveStages,
  // so live stages can't race the cleanup by spawning fresh ephemeral worktrees mid-sweep.
  const reapStartedAt = Date.now();
  const reaped = await reapEphemeralWorktrees(stagingWt, log.child({ scope: 'pipeline' })).catch((err) => {
    log.child({ scope: 'pipeline' }).warn('startup.worktree-reap-failed', { itemId: vaultPath, err });
    return { worktrees: 0, branches: 0 };
  });
  // OBS: startup latency, split so a slow reap (its O(leaked-N) git spawns) is attributable and never
  // misread as a slow vault open. `readyMs` is the UI-live time; `reapMs` is the off-UI-path cleanup.
  log.child({ scope: 'pipeline' }).info('startup.ready', {
    itemId: vaultPath,
    readyMs,
    reapMs: Date.now() - reapStartedAt,
    reapedWorktrees: reaped.worktrees,
    reapedBranches: reaped.branches,
  });
  startActiveStages(active); // single source of truth for which loops run (shared with fullReplay)
  return orch;
}

/** Stop and clear the active pipeline (used on shutdown / vault switch). */
export function stopPipeline(): void {
  if (active) {
    const { promoter } = active;
    stopAllStages(active); // also cancels the promotion timer
    // STAGING-12: publish any pending coalesced batch best-effort (it captures vaultPath + lock, so it
    // completes independent of `active`). Staging is the durable source of truth — if it doesn't land,
    // the next session's first drain re-promotes (idempotent + additive), so nothing is lost.
    void promoter.flushNow();
  }
  active = null;
}

/**
 * #515 BUG-2: stop the pipeline for an actual app quit, AWAITING the pending coalesced promote flush —
 * bounded by `timeoutMs` — before returning, so `main.ts`'s `before-quit` handler can hold the quit open
 * just long enough for an in-flight commit/promote to land cleanly instead of being SIGKILLed mid-write.
 * Best-effort past the deadline: staging is the durable source of truth, so an abandoned flush is simply
 * re-promoted (idempotent + additive) on the next session's first drain — never a correctness gap, only
 * a missed opportunity to publish a moment sooner.
 */
export async function stopPipelineForQuit(timeoutMs = 2000): Promise<void> {
  if (!active) return;
  const { promoter } = active;
  stopAllStages(active);
  active = null;
  await Promise.race([
    promoter.flushNow().catch(() => {}),
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

let replaying = false;

/**
 * Full Replay (SPEC-0022 REPLAY): clean & rebuild the active KB. Principal-initiated only —
 * the IPC layer surfaces it behind a confirm dialog (REPLAY-1/2). Pauses the stage sweeps so
 * nothing re-derives mid-purge (an in-flight item's commit lands under the shared lock, then the
 * purge runs), performs the purge + epoch reset + promotion on `staging`→`main` (REPLAY-4/6/8),
 * then resumes the sweeps so the pipeline re-derives every Source from the start (REPLAY-9).
 * A second concurrent replay is refused (REPLAY-12).
 *
 * BUG-8 (#518): stopping the sweeps only cancels their TIMERS — it never awaits an item whose
 * off-lock `prepare()` was already mid-flight (e.g. a slow decompose/claims copilot call). Such an
 * item's advance could otherwise land AFTER this purge, applying now-stale, pre-epoch derived work
 * onto the freshly-reset tree. `bumpReplayEpoch()` is called FIRST, before anything else, so every
 * in-flight `prepare()` (which captures the epoch at its own start) is fenced: its advance — checked
 * inside the canonical-writer lock, the same lock `runFullReplay`'s purge holds — is dropped as
 * superseded rather than applied. The purged/reset source is already back in the queue regardless, so
 * dropping a stale advance never loses work, only avoids a redundant/stale duplicate.
 */
export async function fullReplay(): Promise<FullReplayResult> {
  if (!active) return { ok: false, message: 'No active library.' };
  if (replaying) return { ok: false, message: 'A replay is already in progress.' };
  replaying = true;
  bumpReplayEpoch();
  const { vaultPath, stagingWt, lock } = active;
  // Pause every sweep before the purge; the in-flight commit (if any) drains as we take the lock.
  stopAllStages(active);
  try {
    const counts = await runFullReplay(vaultPath, stagingWt, lock);
    return {
      ok: true,
      replayId: counts.replayId,
      sourcesReset: counts.sourcesReset,
      purgedTrees: counts.purgedTrees,
      message:
        counts.sourcesReset > 0
          ? `Cleaning & rebuilding — reset ${counts.sourcesReset} source(s) for reprocessing.`
          : 'Nothing to rebuild — your library has no sources yet.',
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  } finally {
    // Auto-resume (REPLAY-9): restart the sweeps whether the replay succeeded or failed, so the
    // pipeline is never left paused. Uses the SAME startActiveStages() as startPipeline, so the
    // post-replay stage set always mirrors normal startup (no dormant-stage divergence).
    if (active) startActiveStages(active);
    replaying = false;
  }
}
