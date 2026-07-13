// Main-process owner of the active vault's orchestration engine (SPEC-0014 / SPEC-0021).
//
// EVERGREEN MODEL (SPEC-0019/0021): the whole working pipeline runs on a persistent `staging`
// worktree (`.kb/cache/worktrees/staging`), never on the vault root. The stages are
// root-agnostic, so handing them the staging worktree as their "root" makes all their existing
// logic (queues, markers, isolation worktrees, ff-advance) operate on `staging`. The vault
// root stays on `main` for Obsidian; the archivist's `afterDrain` hook runs the promotion gate
// (`promote`) to publish freshly-archived `sources/` from `staging` → `main`. Working state
// (inbox, entities, claims, candidates, the Review queue) lives only on `staging`.
//
// All stages share ONE canonical-writer lock per vault (SPEC-0014 §5): promotion + every stage
// ref-advance serialize through it.
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStatusSnapshotStore, type StatusSnapshotStore } from './statusSnapshot';
import { createProjectionStore, type ProjectionStore, type Projection } from './projectionStore';
import { computeGraphProjection, type GraphProjection } from '../kb/graphProjection';
// SPEC-0058 Today: the maintained command-center projection composes the other maintained reads.
import { makeReadOnlyTools } from '../kb/recallTools'; // for the Today Health walk (buildHealthReport takes RecallTools)
import { assembleTodayProjection, type TodaySources } from '../kb/todayProjection';
import type { TodayProjection, TodayStation } from '../kb/types';
import { buildStations } from '../kb/lineStations'; // "one Line, one truth" — byte-identical Status stations
import { buildHealthReport } from '../kb/healthPanel';
import { toHealthProjection } from '../kb/healthProjection';
import { readContradictionDirectives } from '../kb/directives';
import { loadActivityIndex } from '../kb/activityIndex';
import { buildFeed, type ActivityFeedEntry } from '../kb/activityDigest';
import { createCoalescingPromoter, type CoalescingPromoter } from '../kb/coalescingPromoter';
import { Orchestrator, readQueue } from '../kb/orchestrator';
import { makeCopilotDecider } from '../kb/copilotAgent';
import { makeSensitivityClassifier } from '../kb/sensitivityClassifier';
import { DecomposeStage, readDecomposeQueue } from '../kb/decomposeStage';
import { makeDecomposeDecider } from '../kb/decomposeAgent';
import { ClaimsStage, readClaimsQueue, listSetAsideItems, retryClaimsItem, dismissClaimsItem, type SetAsideItem } from '../kb/claimsStage';
import { makeClaimsDecider } from '../kb/claimsAgent';
import { ComposeStage, readComposeQueue, reopenComposeSetAside, composeBacklogStats } from '../kb/composeStage';
import { makeComposeDecider } from '../kb/composeAgent';
import { ConnectStage, readConnectQueue, listConnectSetAsideItems, retryConnectItem, dismissConnectItem, type ConnectSetAsideItem } from '../kb/connectStage';
import { makeConnectDecider } from '../kb/connectAgent';
import { Mutex } from '../kb/stageLock';
import { createVaultDevLog, readRecentDevLogEntries, type DevLog } from '../kb/devlog';
import { breadcrumbObserver } from '../kb/activityBreadcrumb';
import { telemetryHealth } from './telemetry';
import { researchDepsOptions, intakeDepsOptions, mediaExtractOptions } from './researchWiring';
import { selectResearchFn } from '../kb/researchInline';
import { createVaultTracer } from '../kb/tracing';
import { loadPerfIndex } from '../kb/perfIndex';
import { assemblePipelineStatus, toSetAsideViews, deriveStageError, buildInFlightRoster, type PipelineStatusView, type StageInput, type RecentError, type WorktreeInfo } from '../kb/pipelineStatusView';
import { displayItemName } from '../kb/pipelineStatusLabels';
import { readSourceTitles } from '../kb/sourceTitleRead';
import { planSetAsideAction, type SetAsideTarget } from '../kb/pipelineControl';
import { readConversionCounts, type ConversionCounts } from '../kb/conversionCounts';
import { ensureStagingWorktree } from '../kb/stagingWorktree';
import { reapEphemeralWorktrees, boundedGit, bumpReplayEpoch } from '../kb/canonicalAdvance';
import { fastHeadSha, fastHeadBranch } from '../kb/gitHeadFast';
import { CanonicalQueueCache } from '../kb/queueCache';
import type { CandidateSet } from '../kb/connectAgent';
import { reconcileStaleIndexLock, hasLiveIndexHolder, reconcileCherryPickSequencer } from '../kb/canonicalLockHeal';
import { promote } from '../kb/staging';
import {
  remediateHealthFindingInVault,
  dismissHealthFindingInVault,
  type HealthRemediateRequest,
  type HealthRemediateResult,
  type HealthDismissRequest,
  type HealthDismissResult,
} from '../kb/healthRemediation';
import { findOpenReviews, answerReview as answerReviewInVault, type AnswerReviewResult } from '../kb/reviewStore';
import { executeApprovedConsolidation } from '../kb/executeApprovedConsolidation';
import { reviewResumeStage } from '../kb/reviewResume';
import { resumeApprovedResearchEscalation } from '../kb/researchResume';
import { runFullReplay } from '../kb/replay';
import { JobScheduler } from '../kb/jobScheduler';
import { exampleJobBehavior, EXAMPLE_JOB_TYPE } from '../kb/exampleJob';
import { makeReflectJobBehavior, REFLECT_JOB_TYPE } from '../kb/reflectJob';
import { makeReflectDecider } from '../kb/reflectAgent';
import { readJobRegistry, patchJob, upsertJob, jobRegistryPath } from '../kb/jobRegistry';
import { readJournal } from '../kb/jobStage';
import { JOB_CATALOG, catalogEntry, facingForType } from '../kb/jobCatalog';
import { buildJobViews, isSchedulePreset, isAutonomyPosture, jobConfigAuditEvents } from '../kb/jobsPanel';
import { readInstanceConfig, writeInstanceConfig, instanceConfigPath, resolveJobPosture, defaultInstanceConfig, clampRecallBudgetMs, resolveRecallMaxToolCallsWrite, resolveStageCaps, clampStageCap, resolveCeilingWrite, SCALE_STAGES, DEV_LOG_LEVELS, DEFAULT_DEV_LOG_LEVEL, DEFAULT_QUICK_CAPTURE_ACCELERATOR, DEFAULT_RECALL_BUDGET_MS, type DevLogLevel, type ScaleStage, type InstanceConfig } from '../kb/instanceConfig';
import { applyCopilotCeiling } from '../kb/copilotConcurrency';
import { getQuickCaptureAgent } from './quickCaptureService';
import { AGENT_CATALOG, buildAgentViews } from '../kb/agentCatalog';
import { resolveCopilotModel, setResolvedLaunchModel, setAgentModelOverrides } from '../kb/copilotModel';
import { initLaunchModel, probeAcceptedModels, validateModel } from '../kb/copilotModelProbe';
import { appendAuditEvent } from '../kb/audit';
import { readEvents } from '../kb/activityIndex';
import { readResearcherRegistry, upsertResearcher, patchResearcher, deleteResearcher, researcherRegistryPath } from '../kb/researcherRegistry';
import { seedDefaultResearcherIfAbsent } from '../kb/researcherSeed';
import { buildResearcherViews, isEgressTier, isResearcherTemplate, defaultEgressFor, researcherConfigAuditEvents } from '../kb/researchersPanel';
import { runResearcher } from '../kb/researchRun';
import { ResearcherScheduler } from '../kb/researcherScheduler';
import { IntakeScheduler, selectIntakeFn } from '../kb/intakeScheduler';
import { WatchScheduler } from '../kb/watchScheduler';
import { readWatchRegistry, writeWatchRegistry, upsertWatchFolder, patchWatchFolder, watchRegistryPath } from '../kb/watchRegistry';
import { checkWatchLoopSafe, isSafeWatchId, DEFAULT_WATCH_SCOPE, DEFAULT_WATCH_SENSITIVITY, WATCH_MAX_DEPTH_CAP } from '../kb/watchConnectors';
import { buildWatchFolderViews } from '../kb/watchPanel';
import { readIntakeRegistry, upsertIntakeConnector, patchIntakeConnector, deleteIntakeConnector, intakeRegistryPath } from '../kb/intakeRegistry';
import { runIntakeConnector } from '../kb/intakeRun';
import { DEFAULT_INTAKE_SCOPE, DEFAULT_INTAKE_SENSITIVITY, isSafeConnectorId, type IntakeConnectorConfig } from '../kb/intakeConnectors';
import { buildIntakeConnectorViews, isIntakeConnectorType, clampMaxItems, intakeConfigAuditEvents } from '../kb/intakeSourcingPanel';
import type { WatchFolderView, WatchFolderPatch, IntakeConnectorView, IntakeConnectorConfigPatch, RunIntakeConnectorResult } from '../kb/types';
import { isSafeGhRepo } from '../kb/ghRead';
import { DEFAULT_RESEARCHER_BUDGET, dedupKeyFor, researchWhatFor, clampToolCalls, clampTimeoutMs, clampMaxDepth, clampOrientBudget, isSafeResearcherId, type ResearchRequest, type ResearcherConfig } from '../kb/researchers';
import { ulid, dateShard, isUlid } from '../kb/ulid';
import { setSensitivityOverride, sensitivityOverridesPath } from '../kb/sensitivityOverride';
import { readSourceSensitivities, type SourceSensitivity } from '../kb/sensitivityRead';
import { applySensitivityOverrideToSourceMd } from '../kb/sourceDoc';
import { buildRecallOutput } from '../kb/outputDoc';
import { DEFAULT_POSTURE, type JobBehavior, type JobConfig, type JournalEntry } from '../kb/jobs';
import { asWorkDepthConfig } from '../kb/workDepth';
import type { Review } from '../kb/reviews';
import { reviewToSummary } from '../kb/reviewSummary';
import type { AuditEvent } from '../kb/audit';
import type { AskResult } from '../kb/recall';
import type { FullReplayResult, ComposeBacklogResult, JobView, JobConfigPatch, RunJobResult, InstanceSettings, AgentView, ModelCatalogView, SetModelResult, ResearcherView, ResearcherConfigPatch, ResearcherLastRun, RunResearcherResult, SaveRecallOutputResult, PipelineControlRequest, PipelineControlResult, QuiesceStatus, ReviewSummary } from '../kb/types';
import { lastRunFromEvent } from '../kb/researchersPanel';

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

interface ActivePipeline {
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
  };
}

// STAGING-12 promotion cadence — `main` is the live Obsidian vault, so promote in infrequent bursts,
// not per-drain. Debounce: promote once drains go quiet for QUIESCENT_MS; cap: publish at least every
// MAX_WAIT_MS under continuous processing so `main` isn't starved. (Tunable; an Obsidian-aware
// "calm-vault" backoff is the tracked follow-up.)
const PROMOTE_QUIESCENT_MS = 30_000; // 30s of quiet → promote
const PROMOTE_MAX_WAIT_MS = 180_000; // …but at least every 3 min under a continuous drain

let active: ActivePipeline | null = null;

// ── SPEC-0058 STATE-8 (#510): the maintained-projection PUSH sink ───────────────────────────────────
// `main.ts` sets this once (`setProjectionPushSink`) to broadcast `webContents.send('kb:projection-
// changed', event)` so a visible renderer view re-reads its (instant) projection immediately instead of
// waiting on its poll interval. Injected rather than importing Electron here directly, so pipeline.ts
// stays node-testable without a real BrowserWindow. Best-effort + never load-bearing: a push is a "go
// re-read the cache" nudge — the render path's own IPC read is always the source of truth, so a dropped
// push (no window yet, a listener throwing) just means the view catches up on its own next poll/switch.
export type ProjectionPushEvent = { store: 'status' | 'review' | 'graph' | 'today'; builtAt: string };
let projectionPushSink: ((event: ProjectionPushEvent) => void) | null = null;

/** Register (or clear, with `null`) the push sink. Call once from `main.ts` after the window exists. */
export function setProjectionPushSink(sink: ((event: ProjectionPushEvent) => void) | null): void {
  projectionPushSink = sink;
}

function pushProjectionChanged(store: ProjectionPushEvent['store'], builtAt: string): void {
  try {
    projectionPushSink?.({ store, builtAt });
  } catch {
    /* push is best-effort — a listener failure must never break the projection */
  }
}

/** The active vault's `.kb/cache` dir — where OBS-21 writes a heap snapshot (gitignored), or null
 *  when no vault is open (the sampler then skips the snapshot). Passed to the telemetry glue. */
export function activeSnapshotDir(): string | null {
  return active ? path.join(active.vaultPath, '.kb', 'cache') : null;
}

/** Start every active stage's poke/sweep loop. The SINGLE source of truth for "which stages run"
 *  — both `startPipeline` and `fullReplay`'s resume call this, so a replay can never diverge from
 *  normal startup (e.g. start a stage that startup deliberately leaves dormant). */
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
  statusStore.start(); // OBS-24: maintain the status snapshot off the render path (seed from persisted, then live)
  reviewStore.start(); // SHELL-12: maintain the review-queue projection off the render path
  graphStore.start(); // SPEC-0058 STATE-2: maintain the graph projection (Explore/Health) off the render path
  todayStore.start(); // SPEC-0058: maintain the Today home projection (composite) off the render path
}

/** Stop every stage's sweep loop (shutdown, vault switch, or pre-replay pause). */
function stopAllStages(a: ActivePipeline): void {
  a.orch.stop();
  a.decompose.stop();
  a.connect.stop();
  a.claims.stop();
  a.compose.stop();
  a.jobs.stop();
  a.researchers.stop();
  a.intake.stop();
  a.watch.stop(); // SPEC-0037: close all live folder watchers
  a.promoter.stop(); // STAGING-12: cancel a pending promotion timer (no promotes while drains are stopped)
  statusStore.stop(); // OBS-24: halt the background status refresh (retains the in-memory snapshot)
  reviewStore.stop(); // SHELL-12: halt the review-queue projection refresh (retains the in-memory projection)
  graphStore.stop(); // SPEC-0058 STATE-2: halt the graph projection refresh (retains the in-memory projection)
  todayStore.stop(); // SPEC-0058: halt the Today projection refresh (retains the in-memory projection)
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
  const promotePending = active.promoter.pending();
  if (quiescing && remaining === 0 && promotePending) void active.promoter.flushNow();
  const safe = quiescing && remaining === 0 && !promotePending;
  const detail = !quiescing
    ? 'Running normally.'
    : safe
      ? 'Safe to shut down — all work finished.'
      : remaining === 0 && promotePending
        ? 'Publishing the last changes to your library…'
        : `Finishing up — ${remaining} item${remaining === 1 ? '' : 's'} remaining…`; // "items" matches Status/tray vocab (Design-Lead)
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
  const promoter = createCoalescingPromoter({
    promote: async () => {
      await lock.run(() => promote(vaultPath, undefined, undefined, log.child({ scope: 'promote' })), 'coalesced:promote'); // STAGING-12 coalesced; log surfaces ORCH-27 stale-lock heal
    },
    quiescentMs: PROMOTE_QUIESCENT_MS,
    maxWaitMs: PROMOTE_MAX_WAIT_MS,
    onError: (err) => log.child({ scope: 'promote' }).warn('promote.coalesced-failed', { itemId: vaultPath, err }),
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

/** Newest of a set of ISO timestamps (ignoring undefined/unparseable). Undefined if none. */
function newestTs(candidates: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const ts of candidates) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = ts;
    }
  }
  return best;
}

/** List the live worktrees under `<vault>/.kb/cache/worktrees/` + the branch each is on (OBS-7). */
async function listWorktrees(vaultPath: string): Promise<WorktreeInfo[]> {
  const root = path.join(vaultPath, '.kb', 'cache', 'worktrees');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorktreeInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const wt = path.join(root, e.name);
    let branch: string | undefined;
    try {
      // #506: was one git spawn PER worktree PER status tick (~2,500/hour at rest). `fastHeadBranch`
      // reads `.git/HEAD` directly and only falls back to the (still #135-bounded) git spawn on an
      // unrecognized on-disk shape.
      branch = await fastHeadBranch(wt);
    } catch {
      /* not a worktree / detached / timed-out — leave branch undefined */
    }
    out.push({ path: path.join('.kb', 'cache', 'worktrees', e.name), ...(branch ? { branch } : {}) });
  }
  return out;
}

/**
 * The EXPENSIVE status compute (SPEC-0030 OBS-5/6/7/11/15) — gathers per-stage queue depths + busy
 * flags, the canonical-writer lock state, recent dev-log errors, the perf index, conversion counts,
 * and the worktrees (git enumeration), then hands them to the pure {@link assemblePipelineStatus}.
 *
 * OBS-24: this is the work that must NEVER run on the render path — its git/file reads can block
 * behind the pipeline's own git ops and trip the 8s load-guard under load (#256). It is run ONLY on a
 * background cadence by {@link statusStore}; the render path ({@link pipelineStatusForActive}) reads
 * the maintained snapshot instantly. Read-only (OBS-9). Null when no KB is open.
 */
async function computePipelineStatus(): Promise<PipelineStatusView | null> {
  if (!active) return null;
  const { vaultPath, stagingWt, lock, orch, decompose, connect, claims, statusCache } = active;
  const [archiveQ, decompQ, connectQ, claimsQ, archiveStatus, recentRaw, perf, worktrees, claimsSetAside, connectSetAside, conversion] = await Promise.all([
    readQueue(stagingWt),
    // #506: these three raw readers each re-walk their whole tree; HEAD-key them so an idle tick (no
    // canonical commit since the last one) is a spawn-free sha read instead of a full re-walk.
    statusCache.decompose.read(stagingWt, () => readDecomposeQueue(stagingWt)),
    statusCache.connect.read(stagingWt, () => readConnectQueue(stagingWt)),
    statusCache.claims.read(stagingWt, () => readClaimsQueue(stagingWt)),
    orch.status(),
    readRecentDevLogEntries(vaultPath, { limit: 25 }),
    // OBS-12/13 path fix: the tracer WRITES spans to `vaultPath` (createVaultTracer(vaultPath), ~L288),
    // so the perf index must READ from the SAME root — reading `stagingWt` found an empty/absent index
    // and the Latency & Throughput panel showed "No Copilot calls recorded yet" while calls flowed.
    loadPerfIndex(vaultPath),
    listWorktrees(vaultPath),
    statusCache.claimsSetAside.read(stagingWt, () => listSetAsideItems(stagingWt)), // OBS-17: claims poison items (canonical claims-path reader, CLAIMS-20)
    statusCache.connectSetAside.read(stagingWt, () => listConnectSetAsideItems(stagingWt)), // OBS-17: connect poison blocks (CLAIMS-20 connect twin, #157)
    statusCache.conversion.read(stagingWt, () => readConversionCounts(stagingWt, vaultPath)), // SPEC-0032 VIZ-3: funnel counts (staging state + promoted on main)
  ]);
  // Union every stage's set-aside items into the view (claims + connect; future stages append here).
  // Each stage maps its item to the generic {itemId, name, failures, rounds} source shape.
  const setAsideItems = [
    ...toSetAsideViews(claimsSetAside.map((i) => ({ itemId: i.entityId, name: i.name, failures: i.failures, rounds: i.rounds })), 'claims'),
    ...toSetAsideViews(connectSetAside.map((i) => ({ itemId: i.blockKey, name: i.name, failures: i.failures, rounds: i.rounds })), 'connect'),
  ];

  const recentErrors: RecentError[] = recentRaw.map((e) => ({
    ts: e.ts,
    level: e.level,
    event: e.event,
    ...(typeof e.scope === 'string' ? { stage: e.scope } : {}),
    ...(typeof e.itemId === 'string' ? { itemId: e.itemId } : {}),
    ...(typeof e.runId === 'string' ? { runId: e.runId } : {}),
    ...(e.err?.message ? { message: e.err.message } : {}),
  }));
  const setAsideFor = (stage: string): number =>
    recentErrors.filter((e) => e.stage === stage && e.event.includes('setaside')).length;
  // #163: a stage is errored only if it has a FRESH error — a recovered stage's error ages out
  // (was unbounded: any error in the last-N log lines kept the badge red forever).
  const nowMs = Date.now();
  const hasErrorFor = (stage: string): boolean => deriveStageError(recentErrors, stage, nowMs);

  // PRIN-24: resolve the source-keyed stages' ids to human titles. Archive + decompose carry the
  // SOURCE ULID being processed; resolve each to its `source.md` title via the ONE shared derivation
  // (deriveSourceTitle / REVIEW-16). This is the fs title-LOAD the seam places HERE — in
  // computePipelineStatus, on OBS-24's background cadence (never the render path) — so the resolved
  // names bake into the cached snapshot and flow to The Line + the Status stations + the tray.
  // Connect/claims ids are block keys / entity ids (not ULIDs), so they don't resolve to a source and
  // the renderer guard (`displayItemName`) shows them as-is — never a raw ULID.
  // OBS-26: only treat archive's persisted `processing` as a live current-item when a worker actually
  // backs it (`orch.busy()`). The status file can retain `processing` if the orchestrator was killed
  // mid-item — without this gate it shows as a perpetual in-progress ghost (a growing-forever dwell).
  // No live drain ⇒ no current item / no in-flight carriage for it.
  const orchBusy = orch.busy();
  const archiveProcessing = orchBusy ? archiveStatus.processing : null;
  const sourceTitles = await readSourceTitles(vaultPath, [
    ...(archiveProcessing ? [archiveProcessing] : []),
    ...archiveQ,
    ...decompQ,
  ]);
  const archiveCurrent = archiveProcessing
    ? displayItemName(sourceTitles.get(archiveProcessing), archiveProcessing)
    : undefined;

  const stages: StageInput[] = [
    { stage: 'archive', queueDepth: archiveQ.length, setAside: setAsideFor('archive'), busy: orchBusy, hasError: hasErrorFor('archive'), ...(archiveCurrent ? { currentItem: archiveCurrent } : {}) },
    { stage: 'decompose', queueDepth: decompQ.length, setAside: setAsideFor('decompose'), busy: decompose.busy(), hasError: hasErrorFor('decompose') },
    { stage: 'connect', queueDepth: connectQ.length, setAside: setAsideFor('connect'), busy: connect.busy(), hasError: hasErrorFor('connect') },
    { stage: 'claims', queueDepth: claimsQ.length, setAside: setAsideFor('claims'), busy: claims.busy(), hasError: hasErrorFor('claims') },
  ];

  // SPEC-0032 VIZ-2: in-flight carriages — each stage's queue items, `active` = the draining batch
  // (`busy && index < cap`; the drain processes `queue[0..cap)`). Archive's active item is its
  // `processing` (prepended; cap=1, only when a live worker backs it — OBS-26); connect drains 1 block
  // at a time (cap=1); decompose/claims/archive carry their LIVE per-stage cap (SCALE-2, `stage.getCap()`).
  // Source-keyed items carry the resolved title (PRIN-24).
  const inFlight = buildInFlightRoster([
    {
      stage: 'archive',
      items: [...(archiveProcessing ? [{ id: archiveProcessing, name: sourceTitles.get(archiveProcessing) }] : []), ...archiveQ.map((id) => ({ id, name: sourceTitles.get(id) }))],
      busy: orchBusy, cap: orch.getCap(), since: archiveStatus.updatedAt ?? null,
    },
    { stage: 'decompose', items: decompQ.map((id) => ({ id, name: sourceTitles.get(id) })), busy: decompose.busy(), cap: decompose.getCap(), since: decompose.currentSince() },
    { stage: 'connect', items: connectQ.map((cs) => ({ id: cs.blockKey })), busy: connect.busy(), cap: 1, since: connect.currentSince() },
    { stage: 'claims', items: claimsQ.map((rel) => ({ id: path.basename(rel, '.md') })), busy: claims.busy(), cap: claims.getCap(), since: claims.currentSince() },
  ]);

  // Last activity: the newest of the archivist status, the spans-file mtime (any stage's last span),
  // and the newest dev-log entry — so a quietly-working pipeline isn't mistaken for stalled (OBS-11).
  const spansMtime = perf.source ? new Date(perf.source.mtimeMs).toISOString() : undefined;
  const lastActivity = newestTs([archiveStatus.updatedAt ?? undefined, spansMtime, recentErrors[0]?.ts]);

  // OBS-22: the memory/health readout (current RSS/heap + leak trend + last crash breadcrumb).
  const health = await telemetryHealth();

  return assemblePipelineStatus({ stages, lock: lock.state(), recentErrors, worktrees, perf, setAsideItems, conversion, inFlight, health, ...(lastActivity ? { lastActivity } : {}) });
}

// ── OBS-24: the maintained status snapshot ──────────────────────────────────────────────────────────
//
// The render path reads a continuously-maintained last-known-good snapshot instead of synchronously
// recomputing. The expensive `computePipelineStatus` runs only on a background cadence; reads are
// instant (no git/fs), so a status read can never block or trip the load-guard. The snapshot is
// persisted per-vault so launch shows last-known-good instantly, then goes live.

/** Background refresh cadence — matches the former render poll, now off the render path. */
const STATUS_REFRESH_MS = 2500;

/** Where the last-known-good status snapshot is persisted (gitignored cache; never promoted). */
function statusSnapshotPath(vaultPath: string): string {
  return path.join(vaultPath, '.kb', 'cache', 'status-snapshot.json');
}

/** Load the persisted last-known-good snapshot for `vaultPath` (sync — a small one-time read at
 *  activation, so launch can paint status instantly). Any error (missing/corrupt) → null. */
function loadStatusSnapshot(vaultPath: string): PipelineStatusView | null {
  try {
    return JSON.parse(readFileSync(statusSnapshotPath(vaultPath), 'utf8')) as PipelineStatusView;
  } catch {
    return null;
  }
}

/** Persist `view` as the new last-known-good snapshot (best-effort, off the render path). */
async function saveStatusSnapshot(vaultPath: string, view: PipelineStatusView): Promise<void> {
  const file = statusSnapshotPath(vaultPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(view), 'utf8');
}

/** The maintained status projection (OBS-24). Started/stopped with the stage sweeps. */
const statusStore: StatusSnapshotStore = createStatusSnapshotStore({
  compute: computePipelineStatus,
  intervalMs: STATUS_REFRESH_MS,
  load: () => (active ? loadStatusSnapshot(active.vaultPath) : null),
  save: (view) => {
    if (active) void saveStatusSnapshot(active.vaultPath, view).catch(() => {});
  },
  onError: (err) => active?.log.child({ scope: 'status' }).warn('status.snapshot-refresh-failed', { err }),
  onUpdate: (view) => pushProjectionChanged('status', view.builtAt),
});

/**
 * The render-path status read (SPEC-0030 OBS-5/9, OBS-24). Returns the background-maintained
 * last-known-good snapshot **instantly** — no git/fs/compute here, so a status read can never block
 * or trip the 8s load-guard. The view's `builtAt` is its "as of" timestamp (a slightly-stale status
 * is honest; a timeout is not). Null until the first snapshot is computed/loaded.
 */
export async function pipelineStatusForActive(): Promise<PipelineStatusView | null> {
  return active ? statusStore.current() : null; // no active KB → null (don't serve a closed vault's stale snapshot)
}

/** OBS-24 test/diagnostic seam: force one background refresh + await it (e.g. an immediate post-action
 *  status update). Never called on the render path. */
export function refreshStatusSnapshot(): Promise<void> {
  return statusStore.refreshNow();
}

// ── SHELL-12: the maintained REVIEW-QUEUE projection ─────────────────────────────────────────────
// The render path (`kb:listReviews` + the rail badge) reads this last-known-good projection INSTANTLY
// — zero git/fs on the render path, so a busy stage or held canonical-writer lock can never stall the
// Reviews surface. SHELL-12 (c) "update by push" is satisfied by the existing cheap poll now reading
// the INSTANT projection (no live recompute the user waits on); a real main→renderer push is a ready
// follow-on via the spine's `onUpdate` hook. The answer path (REVIEW-20, DEV-6) calls
// `refreshReviewProjection()` after its fast verdict write so the next read sees fresh data.
const REVIEW_REFRESH_MS = 2500;

/** The review-queue compute (background cadence): the open "needs you" queue mapped to the view's
 *  summary shape. Null when no KB is open (the projection then shows nothing). */
async function computeReviewSummaries(): Promise<ReviewSummary[] | null> {
  if (!active) return null;
  const reviews = await listActiveReviews();
  return reviews.map(reviewToSummary); // pure, ENG-16-hardened fold (empty/missing subject can't throw)
}

/** The maintained review-queue projection (SHELL-12). Started/stopped with the stage sweeps. */
const reviewStore: ProjectionStore<ReviewSummary[]> = createProjectionStore<ReviewSummary[]>({
  compute: computeReviewSummaries,
  intervalMs: REVIEW_REFRESH_MS,
  onError: (err) => active?.log.child({ scope: 'reviews' }).warn('reviews.projection-refresh-failed', { err }),
  onUpdate: (projection) => pushProjectionChanged('review', projection.builtAt),
});

/** The render-path review-queue read (SHELL-12): the background-maintained last-known-good projection,
 *  INSTANT — no git/fs/compute, so a Reviews read can never block on the backend. Null until first build. */
export function reviewProjectionForActive(): Projection<ReviewSummary[]> | null {
  return active ? reviewStore.current() : null; // no active KB → null (don't serve a closed vault's queue)
}

/** Post-answer refresh seam (REVIEW-20 / DEV-6): re-read the queue + push, so the renderer's optimistic
 *  remove reconciles against fresh data. Mirrors `refreshStatusSnapshot`. Never on the render path. */
export function refreshReviewProjection(): Promise<void> {
  return reviewStore.refreshNow();
}

// ── SPEC-0058 STATE-2: the maintained GRAPH projection ───────────────────────────────────────────
// The shared knowledge-graph snapshot Explore + Health (+ Today) read INSTANTLY off the render path —
// killing the per-mount live `entities/`+`claims/` walk (Explore's O(N+M) backlink scan, Health's
// O(2N) re-walk) that made those views fail to load on a cold/large vault (the packaged P0). The
// expensive `computeGraphProjection` (one O(N+E) pass, precomputed backlinks; #457) runs on the
// background cadence; the render path serves the last-known-good snapshot, persisted for instant cold
// start (STATE-11). This instantiates DEV-3's STATE-2 compute on the existing SHELL-12 backbone (same
// store `statusStore`/`reviewStore` use); the CORE's STATE-6 canonical-advance invalidation + STATE-8
// push + STATE-12 formal `status` field layer ADDITIVELY onto this same instance (DEV-5) — no rebuild.
const GRAPH_REFRESH_MS = 5000; // richer compute than status/reviews → a calmer backstop cadence

/** Where the last-known-good graph projection is persisted (gitignored cache; never promoted). */
export function graphProjectionPath(vaultPath: string): string {
  return path.join(vaultPath, '.kb', 'cache', 'graph-projection.json');
}

/** Load the persisted last-known-good graph projection. Async (#508 item 4 — was a `readFileSync` at
 *  vault-activation time; on a large vault the persisted JSON is big enough that a synchronous read
 *  briefly blocked the main thread on launch). `projectionStore.start()` races this against the first
 *  live refresh and only uses it if the live one hasn't already landed, so the async hop costs nothing
 *  observable. Any error (missing/corrupt) → null. Exported for direct testing (pure given `vaultPath`). */
export async function loadGraphProjection(vaultPath: string): Promise<GraphProjection | null> {
  try {
    return JSON.parse(await fs.readFile(graphProjectionPath(vaultPath), 'utf8')) as GraphProjection;
  } catch {
    return null;
  }
}

// #508 item 4: `entityMd`/`sourceMd` (every entity's + cited source's full raw markdown) are the
// dominant byte-size of a GraphProjection — stringifying them on every 5s refresh was a synchronous
// main-thread block (50ms-1s+) that stalled ALL IPC, and rewriting that much JSON to disk repeatedly
// is real write amplification. The IN-MEMORY graph (served by graphProjectionForActive) keeps full
// bodies — the render path's "zero fs" guarantee (readNode/readSource/linkTraversal) is unaffected,
// only the ON-DISK snapshot shrinks. A cold-start load briefly serves body-less nodes (already-`stale`
// by construction) until the first live refresh fills them in — seconds, not user-visible.
export function stripBodiesForPersist(graph: GraphProjection): GraphProjection {
  return { ...graph, entityMd: {}, sourceMd: {} };
}

/** The sha256 of the last-WRITTEN (body-stripped, `builtAt`-excluded) persisted graph, per vault path
 *  — the content-hash gate below. Keyed per-path (like `activityIndex.ts`'s file-read cache) rather than
 *  a bare global so two different vaults' content can never collide/mask each other. */
const graphPersistedHash = new Map<string, string>();

/** Persist `graph` as the new last-known-good (best-effort, off the render path) — but ONLY when its
 *  content actually changed (#508 item 4: "persist on content-hash change only"). A canonical advance
 *  that HEAD-gating (#505) can't skip — e.g. compose rewriting an entity's PROSE body — still forces a
 *  recompute, but the body-stripped persisted shape is often byte-identical to what's already on disk
 *  (bodies are exactly what's stripped), so the write itself would be pure waste without this gate.
 *  Exported for direct testing (pure given `vaultPath`+`graph`). */
export async function saveGraphProjection(vaultPath: string, graph: GraphProjection): Promise<void> {
  const stripped = stripBodiesForPersist(graph);
  // builtAt always differs — exclude it from the hash (JSON.stringify drops an `undefined` value entirely).
  const hash = createHash('sha256').update(JSON.stringify({ ...stripped, builtAt: undefined })).digest('hex');
  if (graphPersistedHash.get(vaultPath) === hash) return;
  graphPersistedHash.set(vaultPath, hash);
  const file = graphProjectionPath(vaultPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(stripped), 'utf8');
}

// #505: the interval tick used to run the full O(N+M+S) `computeGraphProjection` walk every 5s
// regardless of whether anything changed. HEAD-gate it with the SAME well-tested `CanonicalQueueCache`
// primitive the stage drain loops already use (queueCache.test.ts covers hit/miss/HEAD-unreadable
// directly) — a spawn-free sha read (`fastHeadSha`) costs a couple of small fs reads, so an idle vault's
// 5s tick is nearly free instead of walking every entity/claim/source file for nothing. One instance,
// reset per vault activation (module-level `active` swap) since it's only ever touched from here.
const graphMemo = new CanonicalQueueCache<GraphProjection>(fastHeadSha);

/** The graph-projection compute (background cadence): one precomputed-backlink pass over the EVERGREEN
 *  graph at the active vault root (STATE-7 — the settled main tree, like the rest of Explore/recall,
 *  never the `staging` worktree mid-write). Null when no KB is open. Returns the SAME object reference
 *  as the prior call when the canonical HEAD hasn't moved (`projectionStore`'s no-op fast path then
 *  skips the restamp/save/push too — a true no-op tick, not just a skipped walk). */
async function computeGraph(): Promise<GraphProjection | null> {
  if (!active) {
    graphMemo.invalidate();
    return null;
  }
  const vaultPath = active.vaultPath;
  return graphMemo.read(vaultPath, () => computeGraphProjection(vaultPath));
}

/** The maintained graph projection (SPEC-0058 STATE-2). Started/stopped with the stage sweeps. */
const graphStore: ProjectionStore<GraphProjection> = createProjectionStore<GraphProjection>({
  compute: computeGraph,
  intervalMs: GRAPH_REFRESH_MS,
  load: () => (active ? loadGraphProjection(active.vaultPath) : null),
  save: (graph) => {
    if (active) void saveGraphProjection(active.vaultPath, graph).catch(() => {});
  },
  onError: (err) => active?.log.child({ scope: 'graph' }).warn('graph.projection-refresh-failed', { err }),
  onUpdate: (projection) => pushProjectionChanged('graph', projection.builtAt),
});

/** The render-path graph read (SPEC-0058 STATE-2): the background-maintained last-known-good projection,
 *  INSTANT — no git/fs/compute, so an Explore/Health read can never block on the backend. Null until the
 *  first snapshot is computed/loaded (the IPC layer maps that to a calm `warming` status). */
export function graphProjectionForActive(): Projection<GraphProjection> | null {
  return active ? graphStore.current() : null; // no active KB → null (don't serve a closed vault's graph)
}

/** Post-mutation refresh seam (mirrors `refreshReviewProjection`): re-read the graph + push. DEV-5's
 *  STATE-6 layer will also drive this off the canonical advance. Never on the render path. */
export function refreshGraphProjection(): Promise<void> {
  return graphStore.refreshNow();
}

// ── SPEC-0058 Today: the maintained command-center HOME projection ─────────────────────────────────
// "Today" is the v2 home — a calm one-glance state-of-the-library. It is a COMPOSITE of the reads the
// other surfaces already maintain: the pipeline status (conversion stats + the Line ribbon + in-flight),
// the graph projection (Connections), the review queue + open contradictions (the needs-you decisions),
// the activity feed, and Health (dangling/orphans/thin). Like every v2 surface it is a maintained
// projection (SPEC-0058 STATE-1/7) — the render path reads the INSTANT last-known-good snapshot, never
// a live vault scan. The expensive parts (the Health walk + the activity-index rebuild) run here on the
// background cadence; the three already-maintained projections (status/graph/reviews) are read instantly.
const TODAY_REFRESH_MS = 8000; // a glance surface — a calm backstop cadence (push delivers fresher updates)

/** One Line station → Today's slim ribbon shape (name/stage/state/glyph + a single pending count). The
 *  station model is byte-identical to the Status view's (shared `buildStations`); Today carries only the
 *  fields its compact ribbon renders. */
function toTodayStation(s: ReturnType<typeof buildStations>[number]): TodayStation {
  return { name: s.name, stage: s.stage, state: s.state, glyph: s.glyph, count: s.queued + s.inProgress };
}

/** The newest "composed" moment (compose/output actor) in the feed → ms-ago, else null (never composed). */
function lastComposedAgoFrom(entries: ActivityFeedEntry[], nowMs: number): number | null {
  const hit = entries.find((e) => e.actor === 'compose' || e.actor === 'output');
  if (!hit) return null;
  const ts = Date.parse(hit.ts);
  return Number.isFinite(ts) ? Math.max(0, nowMs - ts) : null;
}

/** Gather one source defensively: a scan/read that throws degrades to `fallback` so a single failing
 *  source can never blank the whole Today projection (it just shows that section as empty/warming). */
async function gatherSource<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    active?.log.child({ scope: 'today' }).warn('today.source-failed', { source: label, err });
    return fallback;
  }
}

/** The Today compute (background cadence): compose the maintained projections + the two background
 *  scans (health, activity) into the full Today projection. Reads the EVERGREEN vault root for health
 *  (STATE-7, like the rest of recall). Null when no KB is open. Every individual source is gathered
 *  defensively (graceful-degrade) and the pure `assembleTodayProjection` tolerates null/empty sources. */
async function computeTodayProjection(): Promise<TodayProjection | null> {
  const a = active;
  if (!a) return null;
  const nowMs = Date.now();
  // Instant maintained reads (no scan) — the snapshots the status/graph/review stores already keep warm.
  const status = statusStore.current(); // PipelineStatusView | null (instant, envelope already unwrapped)
  const graph = graphProjectionForActive()?.data ?? null;
  const openReviews = reviewProjectionForActive()?.data?.length ?? 0;
  // Background scans (off the render path). DEV-2's Health re-point will later derive these off the graph
  // projection, retiring the walk here; the composite shape is unchanged when it does.
  const activity = await gatherSource<ActivityFeedEntry[]>(
    'activity',
    async () => buildFeed((await loadActivityIndex(a.stagingWt)).events),
    [],
  );
  const health = await gatherSource(
    'health',
    async () => toHealthProjection(await buildHealthReport(makeReadOnlyTools(a.vaultPath)), new Date(nowMs).toISOString()),
    null,
  );
  const contradictions = await gatherSource('contradictions', async () => (await readContradictionDirectives(a.stagingWt)).size, 0);
  const sources: TodaySources = {
    status,
    graph,
    health,
    activity,
    stations: status ? buildStations(status).map(toTodayStation) : ([] as TodayStation[]),
    openReviews,
    contradictions,
    inFlight: status?.inFlight?.length ?? 0,
    lastComposedAgoMs: lastComposedAgoFrom(activity, nowMs),
    movedRecently: activity.length, // the curated recent feed IS the "moved through" window (honest v1)
  };
  return assembleTodayProjection(sources, nowMs);
}

/** The maintained Today projection (SPEC-0058). Started/stopped with the stage sweeps. */
const todayStore: ProjectionStore<TodayProjection> = createProjectionStore<TodayProjection>({
  compute: computeTodayProjection,
  intervalMs: TODAY_REFRESH_MS,
  onError: (err) => active?.log.child({ scope: 'today' }).warn('today.projection-refresh-failed', { err }),
  onUpdate: (projection) => pushProjectionChanged('today', projection.builtAt),
});

/** The render-path Today read (SPEC-0058): the background-maintained last-known-good projection, INSTANT
 *  — no git/fs/compute, so a Today read can never block on the backend. Null until the first snapshot is
 *  computed (the IPC layer maps that to a calm warming state). */
export function todayProjectionForActive(): Projection<TodayProjection> | null {
  return active ? todayStore.current() : null; // no active KB → null (don't serve a closed vault's home)
}

/** Post-mutation refresh seam (mirrors `refreshGraphProjection`): re-read Today + push. Never on the
 *  render path. */
export function refreshTodayProjection(): Promise<void> {
  return todayStore.refreshNow();
}

/**
 * OBS-17 — act on a set-aside (poison) item from the Status view: **retry** (re-enqueue to re-derive)
 * or **dismiss** (retire from the recoverable list). Stage-dispatched (claims + connect today); a new
 * stage is one more branch here — the planner + view stay stage-agnostic. Each branch builds the
 * stage's *live* `{id, handle, label}` list (the `handle` is **server-derived**, never the renderer's
 * `itemId` — the #153/#157 trust boundary) and binds the stage-owned primitives, which write under
 * the shared canonical-writer lock. Retry pokes the stage drain so the item re-processes promptly.
 * Best-effort + honest: a stale/already-recovered item returns `{ok:false}` with a reason, never throws.
 */
export async function pipelineControlForActive(req: PipelineControlRequest): Promise<PipelineControlResult> {
  const a = active;
  if (!a) return { ok: false, message: 'No library open.' };
  try {
    let targets: SetAsideTarget[];
    let doRetry: (handle: string) => Promise<void>;
    let doDismiss: (handle: string) => Promise<void>;
    let pokeAfterRetry: () => void;
    if (req.stage === 'claims') {
      targets = (await listSetAsideItems(a.stagingWt)).map((i) => ({ id: i.entityId, handle: i.entityRel, label: i.name || i.entityId }));
      doRetry = (h) => retryClaimsItem(a.stagingWt, h, a.lock);
      doDismiss = (h) => dismissClaimsItem(a.stagingWt, h, a.lock);
      pokeAfterRetry = () => void a.claims.poke();
    } else if (req.stage === 'connect') {
      targets = (await listConnectSetAsideItems(a.stagingWt)).map((i) => ({ id: i.blockKey, handle: i.blockKey, label: i.name || i.blockKey }));
      doRetry = (h) => retryConnectItem(a.stagingWt, h, a.lock);
      doDismiss = (h) => dismissConnectItem(a.stagingWt, h, a.lock);
      pokeAfterRetry = () => void a.connect.poke();
    } else {
      return { ok: false, message: `Recovery for the “${req.stage}” stage isn’t supported yet.` };
    }
    // Plan against the live list (pure): validate the action + resolve itemId→handle, or a no-op reason.
    const plan = planSetAsideAction(targets, req);
    if ('error' in plan) return { ok: false, message: plan.error };
    if (req.action === 'retry') {
      await doRetry(plan.handle);
      pokeAfterRetry(); // re-drain promptly (don't wait for the periodic sweep)
      // HEAL-8: push the status projection so the renderer's optimistic removal reconciles against fresh
      // data (the item drops off the siding) without waiting for the 2.5s poll. Mirrors REVIEW-20's
      // refreshReviewProjection seam; best-effort, off the UI ack path.
      void refreshStatusSnapshot().catch(() => {});
      return { ok: true, message: `Retrying ${plan.label}.` };
    }
    await doDismiss(plan.handle);
    void refreshStatusSnapshot().catch(() => {}); // HEAL-8: reconcile the siding projection (see above)
    return { ok: true, message: `Dismissed ${plan.label}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The open "needs you" queue (SPEC-0018) — read from `staging`, where review state lives. */
export async function listActiveReviews(): Promise<Review[]> {
  return active ? findOpenReviews(active.stagingWt) : [];
}

/**
 * Answer an open review (REVIEW-6) on `staging`. REVIEW-20: the UI NEVER waits on the backend. The
 * answer resolves on the **fast, bounded verdict write** alone — record the verdict (+ optional note
 * → primary source), supersede the park, commit — and then we:
 *  1. push the review-queue projection (SHELL-12) so the renderer's optimistic remove reconciles
 *     against fresh data the instant it re-reads (the answered item drops from the queue);
 *  2. poke the owning stage so the parked item resumes promptly (REVIEW-6);
 *  3. run the **heavy effects DECOUPLED in the background** (a Reflect-approved consolidation merge +
 *     promote; a confirmed research depth-escalation continuation) — these used to run *inside* this
 *     awaited call, holding the canonical-writer lock while the Principal's confirm/deny "took forever
 *     to disappear" (the #322 P1). They now run after the ack returns; failures are logged + surface
 *     via the pipeline's own telemetry, never on the (already-returned) UI path.
 */
export async function answerActiveReview(id: string, answerInput: unknown): Promise<AnswerReviewResult> {
  const a = active;
  if (!a) return { ok: false, message: 'No active library.' };
  const result = await answerReviewInVault(a.stagingWt, a.lock, id, answerInput);
  if (result.ok) {
    // SHELL-12 seam: re-read + push the queue so the next instant read (the renderer's reconcile poll
    // / the rail badge) no longer shows the answered item. Best-effort — the 2.5s cadence also catches up.
    void refreshReviewProjection().catch(() => {});
    // Resume the parked item PROMPTLY (REVIEW-6) by poking the stage that raised the review (#46).
    const resume = reviewResumeStage(result.stage);
    if (resume === 'claims') void a.claims.poke();
    else if (resume === 'connect') void a.connect.poke();
    // Heavy effects run in the background — the UI ack has already returned (REVIEW-20).
    void runAnsweredReviewEffects(a, id);
  }
  return result;
}

/** SPEC-0060 VUX-16 slice-1: apply a non-destructive Health remediation (relink / find-homes) on the
 *  active vault — under the canonical-writer lock, promoted so the next Health scan shows the fix. */
export async function remediateActiveHealthFinding(req: HealthRemediateRequest): Promise<HealthRemediateResult> {
  const a = active;
  if (!a) return { ok: false, message: 'No active library.' };
  return remediateHealthFindingInVault(a.stagingWt, a.vaultPath, a.lock, req, a.log);
}

/** SPEC-0060 VUX-16 slice-1: dismiss (or restore) a Health finding on the active vault — persisted as an
 *  evergreen directive, promoted to `main` where the Health scan's dismiss filter reads it. */
export async function dismissActiveHealthFinding(req: HealthDismissRequest): Promise<HealthDismissResult> {
  const a = active;
  if (!a) return { ok: false, message: 'No active library.' };
  return dismissHealthFindingInVault(a.stagingWt, a.vaultPath, a.lock, req, new Date().toISOString(), a.log);
}

/**
 * REVIEW-20 — the heavy, DECOUPLED effects of answering a review, run in the background so the UI
 * never waits (they hold the canonical-writer lock; awaiting them is what made confirm/deny "take
 * forever to disappear"). Both are self-gating no-ops for an ordinary review, so calling them for
 * every answered review is correct. Errors are logged (and reflected in pipeline telemetry / set-aside)
 * but never reach the already-returned answer ack. The active instance is passed in explicitly so a
 * later KB close/swap can't repoint `active` out from under the background work.
 */
async function runAnsweredReviewEffects(a: ActivePipeline, id: string): Promise<void> {
  // SPEC-0024 REFLECT-5/7: a Reflect-proposed consolidation the Principal just APPROVED — the ONLY
  // point a Reflect destructive merge ever runs (never autonomously). Promote ONLY when it actually
  // merged, so the loser-node deletions mirror to `main` via the deletion-aware gate (STAGING-10).
  // Promote under the shared lock, like the stages' afterDrain.
  try {
    const consolidation = await executeApprovedConsolidation(a.stagingWt, id, a.lock);
    if (consolidation.executed) {
      await a.lock.run(() => promote(a.vaultPath), 'consolidation:promote');
      // A merge can re-shape the open queue (loser reviews retired) → push the fresh projection.
      void refreshReviewProjection().catch(() => {});
    }
  } catch (err) {
    a.log.child({ scope: 'reviews' }).warn('reviews.consolidation-effect-failed', { reviewId: id, err });
  }
  // SPEC-0028 RESEARCH-11 (D7 fast-follow): a CONFIRMED research depth-limit escalation continues the
  // chain one level deeper, so "Continue researching X?" actually continues (no dead affordance).
  // Self-gating (no-op for any other review). Same cliPath+dev-log wiring as the scheduler/Run-now (#160).
  try {
    const resumed = await resumeApprovedResearchEscalation(a.stagingWt, id, researchDepsOptions(a.log), { lock: a.lock });
    if (resumed.resumed) a.log.child({ scope: 'research' }).info('research.resumed-after-confirm', { reviewId: id, sources: resumed.sourceIds?.length ?? 0 });
  } catch (err) {
    a.log.child({ scope: 'research' }).warn('research.resume-effect-failed', { reviewId: id, err });
  }
}

/**
 * Save a grounded recall answer as a KB Output (SPEC-0026 ASK-6). Writes `outputs/recall/<ulid>.md`
 * on the `staging` worktree, commits + promotes to `main` under the canonical-writer lock (the
 * evergreen gate — never the vault root directly), then emits a conforming `output` audit event
 * (AUDIT-2/11 — a Principal-initiated mutation). The Output is **inert** (F2): it lives in `outputs/`
 * with `generated: recall`, so the autonomous stages (which queue off `sources/`) never re-enrich it.
 * An ungrounded answer is allowed (F4) — the doc carries `grounded:false` + a prominent banner.
 */
export async function saveRecallOutput(result: AskResult): Promise<SaveRecallOutputResult> {
  const a = active;
  if (!a) return { ok: false, message: 'No active library.' };
  if (typeof result?.answer !== 'string' || result.answer.trim().length === 0) {
    return { ok: false, message: 'Nothing to save — the answer is empty.' };
  }
  const root = a.stagingWt;
  const id = ulid();
  const built = buildRecallOutput(result, id, new Date().toISOString());
  await a.lock.run(async () => {
    const abs = path.join(root, built.rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, built.markdown, 'utf8');
    const git = boundedGit(root); // #163: bounded — runs under the canonical-writer lock
    await git.add(built.rel);
    await git.commit(`recall: save output ${id}`);
    await promote(a.vaultPath); // mirror the new outputs/ note to main (evergreen, deletion-aware gate)
  }, 'recall-output:save');
  // Conforming audit — appends to the gitignored cross-cutting control log (not canonical); fine off-lock.
  await appendAuditEvent(root, {
    actor: 'output',
    eventType: 'recall-output-saved',
    subjects: {},
    payload: { rel: built.rel, question: result.question, grounded: result.grounded, citations: result.citations.length, why: 'Principal saved a recall answer' },
  });
  return { ok: true, rel: built.rel, message: `Saved to ${built.rel}` };
}

// --- Control Panel · Jobs (SPEC-0027 PANEL-2/6/7) — read/manage the per-vault job registry ---

/**
 * List the manageable jobs for the active KB (PANEL-2): the known-job catalog merged with the
 * registry, each row carrying its last-run summary from the journal. Reads `staging` (where the
 * registry + journals live). No active KB → empty list (the view degrades gracefully, PANEL-9).
 */
export async function listJobsForActive(): Promise<JobView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  const registry = await readJobRegistry(root);
  const instance = await readInstanceConfig(root); // a catalog-only job displays its inherited posture
  // Gather the newest journal entry for every job we will show (catalog types ∪ registered ids).
  const ids = new Set<string>([...JOB_CATALOG.map((c) => c.type), ...registry.map((j) => j.id)]);
  const lastEntryByJobId: Record<string, JournalEntry | undefined> = {};
  for (const id of ids) {
    const journal = await readJournal(root, id);
    lastEntryByJobId[id] = journal[journal.length - 1];
  }
  return buildJobViews(JOB_CATALOG, registry, lastEntryByJobId, instance.autonomyDefault);
}

/**
 * Apply a Jobs-view config change (PANEL-2/6) and return the refreshed list. A catalog-only job is
 * seeded into the registry on first edit. The registry write + git commit run under the shared
 * canonical-writer lock so they never race a stage's ff-advance — the commit is the durable record
 * that survives a staging reset. After the write, a **conforming `panel` audit event** is emitted per
 * changed field (PANEL-7 / AUDIT-2/11 — carries field/from/to + the why, via the SPEC-0029 writer
 * which enforces actor registration at emit). The scheduler reads the registry fresh each tick and
 * rebuilds a job's runner when its config signature changes, so the edit takes effect with no
 * restart (PANEL-6).
 *
 * Untrusted IPC input is validated at this trust boundary: id/type required, `schedule`/`posture`
 * are dropped unless they are known enum values (the existing `isSchedulePreset`/`isAutonomyPosture`
 * validators), and an unknown job (not in the catalog and not already registered) is refused — never
 * create a job for an arbitrary/unresolvable type.
 */
export async function setActiveJobConfig(patch: JobConfigPatch): Promise<JobView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  if (typeof patch.id !== 'string' || patch.id.length === 0 || typeof patch.type !== 'string' || patch.type.length === 0) {
    return listJobsForActive();
  }
  // Sanitize: keep only valid enum fields (fail-safe — drop anything unrecognized).
  const clean: JobConfigPatch = { id: patch.id, type: patch.type };
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (isSchedulePreset(patch.schedule)) clean.schedule = patch.schedule;
  if (isAutonomyPosture(patch.posture)) clean.posture = patch.posture;
  // JOBS-17: the editable per-item work-depth (sanitized — drops junk). Absent leaves the prior/default.
  if (patch.workDepth !== undefined) {
    const wd = asWorkDepthConfig(patch.workDepth);
    if (wd) clean.workDepth = wd;
  }

  let prior: JobConfig | undefined;
  let applied = false;
  await active.lock.run(async () => {
    const registry = await readJobRegistry(root);
    prior = registry.find((j) => j.id === clean.id);
    // Refuse an unknown job (not in the catalog and not already registered) from untrusted input.
    if (!prior && catalogEntry(clean.type) === undefined) return;
    applied = true;
    if (prior) {
      await patchJob(root, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.schedule !== undefined ? { schedule: clean.schedule } : {}),
        ...(clean.posture !== undefined ? { posture: clean.posture } : {}),
        ...(clean.workDepth !== undefined ? { workDepth: clean.workDepth } : {}),
      });
    } else {
      // New job: an explicit per-job posture wins; otherwise inherit the Instance default (AUTO-12
      // cascade — `resolveJobPosture` is the single swap point if the ruling lands differently).
      // JOBS-16: facing comes from the catalog (the built-in's fixed facing; `internal` default).
      const instanceCfg = await readInstanceConfig(root);
      await upsertJob(root, {
        id: clean.id,
        type: clean.type,
        enabled: clean.enabled ?? false,
        schedule: clean.schedule ?? 'off',
        posture: resolveJobPosture(instanceCfg.autonomyDefault, clean.posture),
        facing: facingForType(clean.type),
        ...(clean.workDepth !== undefined ? { workDepth: clean.workDepth } : {}),
      });
    }
    await commitRegistryChange(root, summarizeJobChange(clean));
  }, 'job-config:write');
  if (applied) {
    // Conforming audit (PANEL-7 / AUDIT-2/11): one `panel` event per changed field, carrying the why.
    // Appends to the gitignored `.kb/audit.jsonl` (not canonical) — fine outside the lock.
    for (const event of jobConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listJobsForActive();
}

/**
 * Manual "Run now" for one job (PANEL-2; JOBS-11) — one bounded pass on demand, respecting
 * single-flight. Run-now is independent of enable/schedule, so a catalog-only job is seeded
 * (off/guarded) and committed before running, letting the Principal test a job without turning it on.
 * The Principal's trigger is itself audited as a `panel` event (PANEL-7); the run's own work is
 * audited by the job journal (actor `job`).
 */
export async function runActiveJobNow(id: string): Promise<RunJobResult> {
  if (!active) return { ran: false, reason: 'no-kb' };
  const root = active.stagingWt;
  const registry = await readJobRegistry(root);
  if (!registry.some((j) => j.id === id)) {
    const entry = catalogEntry(id); // v1: catalog id === type
    if (!entry) return { ran: false, reason: 'not-found' };
    await active.lock.run(async () => {
      const instanceCfg = await readInstanceConfig(root);
      await upsertJob(root, { id, type: entry.type, enabled: false, schedule: 'off', posture: resolveJobPosture(instanceCfg.autonomyDefault, undefined), facing: facingForType(entry.type) });
      await commitRegistryChange(root, `seed job ${id} for run-now`);
    }, 'job:seed-for-run-now');
  }
  const res = await active.jobs.runNow(id);
  const outcome = res === 'skipped' || res === 'not-found' || res === 'unknown-type' ? res : res.outcome;
  // Audit the Principal-initiated trigger (PANEL-7) — the trigger happened regardless of outcome.
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'job-run-now',
    subjects: { jobId: id },
    payload: { outcome, why: 'Principal manual run via Control Panel' },
  });
  if (res === 'skipped' || res === 'not-found' || res === 'unknown-type') return { ran: false, reason: res };
  return { ran: true, outcome: res.outcome, applied: res.applied, deferred: res.deferred };
}

/** A short, human commit summary of a job-config change (the conforming audit event carries from/to). */
function summarizeJobChange(patch: JobConfigPatch): string {
  const parts: string[] = [];
  if (patch.enabled !== undefined) parts.push(`enabled=${patch.enabled}`);
  if (patch.schedule !== undefined) parts.push(`schedule=${patch.schedule}`);
  if (patch.posture !== undefined) parts.push(`posture=${patch.posture}`);
  return `job ${patch.id}${parts.length ? ` set ${parts.join(', ')}` : ' config change'}`;
}

// --- Control Panel · Settings + Agents (SPEC-0027 PANEL-3/5) ---

/** The per-Instance settings for the active KB (PANEL-5). No active KB → safe defaults. */
export async function getActiveInstanceSettings(): Promise<InstanceSettings> {
  if (!active) return defaultInstanceConfig();
  return readInstanceConfig(active.stagingWt);
}

/**
 * Persist the per-Instance settings (PANEL-5/6): write `.kb/instance.json` + git-commit on `staging`
 * under the lock (durability), then emit a conforming `panel` audit event when the autonomy default
 * changed (PANEL-7 / AUDIT-2/11 — `→ Autonomous` is a risky, audited change). An invalid posture is
 * refused (fail-safe). Takes effect immediately (new jobs inherit it via `resolveJobPosture`).
 */
export async function setActiveInstanceSettings(settings: InstanceSettings): Promise<InstanceSettings> {
  if (!active) return defaultInstanceConfig();
  const root = active.stagingWt;
  if (!isAutonomyPosture(settings.autonomyDefault)) return readInstanceConfig(root); // reject invalid
  let prior: InstanceConfig = defaultInstanceConfig();
  let devLogLevel: DevLogLevel = DEFAULT_DEV_LOG_LEVEL;
  let quickCaptureAccelerator: string = DEFAULT_QUICK_CAPTURE_ACCELERATOR;
  let recallBudgetMs: number = DEFAULT_RECALL_BUDGET_MS;
  let recallMaxToolCalls: number | undefined;
  let stageCaps: Partial<Record<ScaleStage, number>> | undefined;
  let copilotCeiling: number | undefined;
  let priorCfg = defaultInstanceConfig();
  await active.lock.run(async () => {
    prior = await readInstanceConfig(root);
    priorCfg = prior as typeof priorCfg;
    // OBS-10: keep a valid level. Server-side merge (QA-2 hardening / the #102 lesson): an
    // omitted/invalid level PRESERVES the prior — no caller can clobber a field by omission.
    devLogLevel = (DEV_LOG_LEVELS as readonly string[]).includes(settings.devLogLevel) ? settings.devLogLevel : prior.devLogLevel;
    // QCAP-6: preserve-on-omission (the #102 merge lesson) — an empty/omitted accelerator keeps prior.
    quickCaptureAccelerator =
      typeof settings.quickCaptureAccelerator === 'string' && settings.quickCaptureAccelerator.trim().length > 0
        ? settings.quickCaptureAccelerator
        : prior.quickCaptureAccelerator;
    // ASK-17: preserve-on-omission — an omitted recall budget keeps prior; a provided one is clamped to
    // the sane bounds. (prior.recallBudgetMs is always set: readInstanceConfig fills it.)
    recallBudgetMs = settings.recallBudgetMs === undefined ? (prior.recallBudgetMs ?? DEFAULT_RECALL_BUDGET_MS) : clampRecallBudgetMs(settings.recallBudgetMs);
    // ASK-19: the retrieval tool-call override — `undefined` preserves prior (#102), `null` CLEARS it
    // back to the graph-size-scaled default ("scale to KB size"), a number is clamped (pure +
    // unit-tested in recallConstants). Omitted from the write below ⇒ no override key persisted.
    recallMaxToolCalls = resolveRecallMaxToolCallsWrite(priorCfg.recallMaxToolCalls, settings.recallMaxToolCalls);
    // SCALE-1/2 preserve-on-omission (#102): a wholly-omitted `stageCaps`/`copilotCeiling` keeps prior;
    // a provided one is merged key-by-key + clamped (Connect pinned to 1, SCALE-5). The model override
    // + preference list (#345) are likewise preserved on the write below — InstanceSettings carries
    // them but an omitted value must keep prior, never wipe the Principal's pick.
    if (settings.stageCaps === undefined) {
      stageCaps = priorCfg.stageCaps;
    } else {
      const merged: Partial<Record<ScaleStage, number>> = { ...(priorCfg.stageCaps ?? {}) };
      for (const stage of SCALE_STAGES) {
        if (settings.stageCaps[stage] !== undefined) merged[stage] = clampStageCap(stage, settings.stageCaps[stage]);
      }
      stageCaps = Object.keys(merged).length > 0 ? merged : undefined;
    }
    // `undefined` preserves prior (#102); `null` is the Auto toggle's explicit CLEAR (→ cores-derived);
    // a number is clamped (see resolveCeilingWrite — pure + unit-tested in scaleConstants).
    copilotCeiling = resolveCeilingWrite(priorCfg.copilotCeiling, settings.copilotCeiling);
    await writeInstanceConfig(root, {
      autonomyDefault: settings.autonomyDefault,
      devLogLevel,
      quickCaptureAccelerator,
      recallBudgetMs,
      ...(recallMaxToolCalls !== undefined ? { recallMaxToolCalls } : {}), // ASK-19: omitted ⇒ scaled default
      ...(priorCfg.modelPreferences ? { modelPreferences: priorCfg.modelPreferences } : {}), // preserve MODEL (#345)
      ...(priorCfg.model ? { model: priorCfg.model } : {}),
      ...(priorCfg.agentModels ? { agentModels: priorCfg.agentModels } : {}), // preserve per-agent picks (SPEC-0048)
      ...(stageCaps ? { stageCaps } : {}),
      ...(copilotCeiling !== undefined ? { copilotCeiling } : {}),
    });
    await commitControlFile(root, instanceConfigPath(root), `instance autonomyDefault=${settings.autonomyDefault} devLogLevel=${devLogLevel} quickCaptureAccelerator=${quickCaptureAccelerator} recallBudgetMs=${recallBudgetMs} recallMaxToolCalls=${recallMaxToolCalls ?? 'scaled'} ceiling=${copilotCeiling ?? 'default'} caps=${JSON.stringify(stageCaps ?? {})}`);
  }, 'instance-settings:write');
  // QCAP-6: apply a changed hotkey live (no restart) — conflict-aware via the agent; degrades to the
  // menubar if the new accelerator clashes (QCAP-9). No-op when running headless without an agent.
  if (prior.quickCaptureAccelerator !== quickCaptureAccelerator) {
    getQuickCaptureAgent()?.setAccelerator(quickCaptureAccelerator);
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'quickCaptureAccelerator', from: prior.quickCaptureAccelerator, to: quickCaptureAccelerator, why: 'Principal change via Control Panel' },
    });
  }
  if (prior.autonomyDefault !== settings.autonomyDefault) {
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'autonomyDefault', from: prior.autonomyDefault, to: settings.autonomyDefault, why: 'Principal change via Control Panel' },
    });
  }
  // OBS-10 + AUDIT-2: audit a verbosity change too — `→ debug` is security-relevant (it logs
  // redaction-protected `sensitive` fields verbatim), so it's never silent (QA-2 #2).
  if (prior.devLogLevel !== devLogLevel) {
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'devLogLevel', from: prior.devLogLevel, to: devLogLevel, why: 'Principal change via Control Panel' },
    });
  }
  // SPEC-0048 SCALE-4: apply scale changes LIVE (no restart). Resize the global ceiling (env still
  // wins) and live-set each stage's cap — the new cap is read on the stage's NEXT batch (`setCap`),
  // so a "run harder/softer" change takes effect within a sweep without rebuilding the pipeline.
  const effectiveCeiling = applyCopilotCeiling(copilotCeiling);
  const liveCaps = resolveStageCaps({ stageCaps });
  active.orch.setCap(liveCaps.archive);
  active.decompose.setCap(liveCaps.decompose);
  active.claims.setCap(liveCaps.claims);
  active.compose.setCap(liveCaps.compose);
  active.connect.setCap(liveCaps.connect); // SCALE-5: Connect's resolve drain is now live-tunable too
  const priorCeiling = priorCfg.copilotCeiling;
  const priorCaps = JSON.stringify(priorCfg.stageCaps ?? {});
  if (priorCeiling !== copilotCeiling || priorCaps !== JSON.stringify(stageCaps ?? {})) {
    active.log.info('scale.applied', { ceiling: effectiveCeiling, caps: liveCaps });
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'scale', ceiling: copilotCeiling ?? 'default', caps: stageCaps ?? {}, why: 'Principal change via Control Panel' },
    });
  }
  return readInstanceConfig(root);
}

/** The librarian/stage agents for observe-only display (PANEL-3): the static catalog overlaid with
 *  the resolved model (env-requested or Copilot default) + live running/idle status (PANEL-9). */
export async function listAgentsForActive(): Promise<AgentView[]> {
  // SPEC-0048: per-agent resolution — each row shows the model THAT agent launches with (its own pin
  // → global → floor) + its configured pick (for the picker). `agentModels` read from the persisted
  // config so the view reflects the saved picks even before a restart re-applies the override cache.
  const configuredModels = active ? (await readInstanceConfig(active.stagingWt)).agentModels : undefined;
  return buildAgentViews(AGENT_CATALOG, {
    resolveModel: (agentKey) => resolveCopilotModel(undefined, agentKey),
    configuredModels,
    pipelineActive: active !== null,
  });
}

/** SPEC-0048 — the model picker's data: the live CLI accepted catalog (probed), the currently-resolved
 *  launch model, the persisted global pick (if any), and whether that pick is stale (no longer accepted
 *  by this CLI version → the brass note). Best-effort: a probe miss leaves `accepted` null (the picker
 *  shows the resolved/configured value but can't offer a fresh list). */
export async function getModelCatalogForActive(): Promise<ModelCatalogView> {
  const accepted = await probeAcceptedModels();
  const resolved = resolveCopilotModel();
  const configured = active ? (await readInstanceConfig(active.stagingWt)).model : undefined;
  const staleConfigured = !!configured && accepted !== null && !accepted.includes(configured);
  return { accepted, resolved, configured, staleConfigured };
}

/** SPEC-0048 — persist the Principal's global model pick (Agents-view picker), validated against the
 *  live CLI catalog first so a stale/rejected id is REFUSED (never persisted into a hard-break). An
 *  empty/null id clears the override (→ the preference-list probe re-resolves). Applies live via
 *  `setResolvedLaunchModel` so new launches use it without a restart. */
export async function setActiveModel(id: string | null): Promise<SetModelResult> {
  if (!active) return { ok: false, resolved: resolveCopilotModel() };
  const root = active.stagingWt;
  const trimmed = (id ?? '').trim();

  if (trimmed.length === 0) {
    // Clear the override → re-resolve from the preference list against the live catalog.
    let prefs: string[] | undefined;
    await active.lock.run(async () => {
      const prior = await readInstanceConfig(root);
      prefs = prior.modelPreferences;
      const { model: _drop, ...rest } = prior;
      void _drop;
      await writeInstanceConfig(root, rest);
      await commitControlFile(root, instanceConfigPath(root), 'instance model=cleared');
    }, 'instance-model:write');
    await initLaunchModel({ preferences: prefs, log: active.log.child({ scope: 'model' }) }).catch(() => {});
    return { ok: true, resolved: resolveCopilotModel() };
  }

  // Validate the pick against the live catalog: a rejected id is refused (resolution unchanged). An
  // `unknown` (un-probable CLI) is allowed — the per-call `auto` net still guards a real launch reject.
  const { result } = await validateModel(trimmed);
  if (result === 'rejected') return { ok: false, resolved: resolveCopilotModel(), reason: 'rejected' };

  await active.lock.run(async () => {
    const prior = await readInstanceConfig(root);
    await writeInstanceConfig(root, { ...prior, model: trimmed });
    await commitControlFile(root, instanceConfigPath(root), `instance model=${trimmed}`);
  }, 'instance-model:write');
  setResolvedLaunchModel(trimmed); // apply live — new launches use it immediately
  return { ok: true, resolved: resolveCopilotModel() };
}

/** SPEC-0048 — set/clear ONE agent's per-agent model pick (Agents-view per-agent picker). Validated
 *  against the live catalog (rejected → refused). Empty/null clears that agent's pick (→ global default).
 *  Persists `instance.agentModels` under the lock + applies live via `setAgentModelOverrides`. Returns
 *  that agent's now-resolved model. */
export async function setActiveAgentModel(agentKey: string, id: string | null): Promise<SetModelResult> {
  if (!active) return { ok: false, resolved: resolveCopilotModel(undefined, agentKey) };
  const root = active.stagingWt;
  const key = agentKey.trim();
  const trimmed = (id ?? '').trim();
  if (key.length === 0) return { ok: false, resolved: resolveCopilotModel() };

  // A non-empty pick must be catalog-accepted (rejected → refuse, leave the agent on its current model).
  if (trimmed.length > 0) {
    const { result } = await validateModel(trimmed);
    if (result === 'rejected') return { ok: false, resolved: resolveCopilotModel(undefined, agentKey), reason: 'rejected' };
  }

  let next: Record<string, string> = {};
  await active.lock.run(async () => {
    const prior = await readInstanceConfig(root);
    const map = { ...(prior.agentModels ?? {}) };
    if (trimmed.length > 0) map[key] = trimmed;
    else delete map[key]; // clear → fall back to the global default
    next = map;
    const { agentModels: _drop, ...rest } = prior;
    void _drop;
    await writeInstanceConfig(root, { ...rest, ...(Object.keys(map).length > 0 ? { agentModels: map } : {}) });
    await commitControlFile(root, instanceConfigPath(root), `instance agentModels.${key}=${trimmed || 'cleared'}`);
  }, 'instance-agent-model:write');
  setAgentModelOverrides(next); // apply live
  return { ok: true, resolved: resolveCopilotModel(undefined, agentKey) };
}

// --- Control Panel · Watched folders (SPEC-0037 WATCH-9; over the watch registry) ---

/** List the active KB's watched folders for the unified Sources view (WATCH-9): config + the live
 *  `watching` flag (from the scheduler) + each folder's newest `watch` audit folded as `lastEvent`.
 *  Reads `staging` (registry + audit live there). No active KB → empty (PANEL-9 degrade). */
export async function listWatchFoldersForActive(): Promise<WatchFolderView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  const registry = await readWatchRegistry(root, active.log);
  const events = await readEvents(root, { actors: ['watch'] }); // newest-first
  const lastByWatch: Record<string, (typeof events)[number] | undefined> = {};
  for (const f of registry) lastByWatch[f.id] = events.find((e) => e.subjects.watchId === f.id);
  return buildWatchFolderViews(registry, active.watch.watchingIds(), lastByWatch);
}

/**
 * Apply a Sources-view edit to a watched folder (WATCH-9) + return the refreshed list. Untrusted IPC
 * input is validated at this boundary; a `folderPath` being set/changed is **loop-guarded** against the
 * REAL vault (WATCH-10) — a loop-unsafe folder (the vault/.kb/.git or an ancestor) is REFUSED and never
 * persisted (the change is dropped, fail-safe). The write + git commit run under the shared lock
 * (durability); a conforming `panel` audit records the change (AUDIT-2); then the scheduler re-syncs so a
 * newly-enabled folder starts watching (and a disabled one stops).
 */
export async function setActiveWatchFolder(patch: WatchFolderPatch): Promise<WatchFolderView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listWatchFoldersForActive();

  const clean: WatchFolderPatch = { id: patch.id };
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (typeof patch.scope === 'string' && patch.scope.trim()) clean.scope = patch.scope.trim();
  if (typeof patch.sensitivity === 'string' && patch.sensitivity.trim()) clean.sensitivity = patch.sensitivity.trim();
  if (typeof patch.label === 'string') clean.label = patch.label;
  if (Array.isArray(patch.ignoreGlobs)) clean.ignoreGlobs = patch.ignoreGlobs.filter((g): g is string => typeof g === 'string');
  if (typeof patch.folderPath === 'string' && patch.folderPath.trim()) clean.folderPath = patch.folderPath.trim();
  // Slice-2 opt-ins (WATCH-12/14): coerce to safe values at the boundary — maxDepth clamped to [0, cap].
  if (typeof patch.recursive === 'boolean') clean.recursive = patch.recursive;
  if (typeof patch.maxDepth === 'number' && Number.isFinite(patch.maxDepth)) clean.maxDepth = Math.min(Math.max(0, Math.floor(patch.maxDepth)), WATCH_MAX_DEPTH_CAP);
  if (typeof patch.consume === 'boolean') clean.consume = patch.consume;

  // WATCH-10 loop-guard at the IPC boundary: a folderPath set/change must be loop-safe vs the REAL vault,
  // else REFUSE the whole change (never persist a folder that would re-ingest the vault into itself).
  if (clean.folderPath !== undefined) {
    const guard = await checkWatchLoopSafe(active.vaultPath, clean.folderPath);
    if (!guard.ok) {
      active.log.child({ scope: 'watch' }).warn('watch.config-refused', { watchId: clean.id, folderPath: clean.folderPath, reason: guard.reason });
      await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: clean.id }, payload: { refused: true, folderPath: clean.folderPath, reason: guard.reason, why: 'folder-watch loop-guard refused the folder (WATCH-10)' } });
      return listWatchFoldersForActive(); // fail-safe: nothing persisted
    }
  }

  let applied = false;
  await active.lock.run(async () => {
    const existing = (await readWatchRegistry(root)).find((f) => f.id === clean.id);
    if (existing) {
      await patchWatchFolder(root, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.folderPath !== undefined ? { folderPath: clean.folderPath } : {}),
        ...(clean.scope !== undefined ? { scope: clean.scope } : {}),
        ...(clean.sensitivity !== undefined ? { sensitivity: clean.sensitivity } : {}),
        ...(clean.label !== undefined ? { label: clean.label } : {}),
        ...(clean.ignoreGlobs !== undefined ? { ignoreGlobs: clean.ignoreGlobs } : {}),
        ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}),
        ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
        ...(clean.consume !== undefined ? { consume: clean.consume } : {}),
      });
    } else {
      // New watched folder requires a folderPath (already loop-guarded above).
      if (clean.folderPath === undefined) return;
      await upsertWatchFolder(root, {
        id: clean.id,
        folderPath: clean.folderPath,
        enabled: clean.enabled ?? false,
        scope: clean.scope ?? DEFAULT_WATCH_SCOPE,
        sensitivity: clean.sensitivity ?? DEFAULT_WATCH_SENSITIVITY,
        ...(clean.label !== undefined ? { label: clean.label } : {}),
        ...(clean.ignoreGlobs !== undefined ? { ignoreGlobs: clean.ignoreGlobs } : {}),
        ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}),
        ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
        ...(clean.consume !== undefined ? { consume: clean.consume } : {}),
      });
    }
    applied = true;
    await commitControlFile(root, watchRegistryPath(root), `watch ${clean.id} config change`);
  }, 'watch-config:write');

  if (applied) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: clean.id }, payload: { ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}), ...(clean.folderPath !== undefined ? { folderPath: clean.folderPath } : {}), ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}), ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}), ...(clean.consume !== undefined ? { consume: clean.consume } : {}), why: 'Principal edited a watched folder via Control Panel' } });
    await active.watch.refresh(); // start/stop live watchers to match the new config
  }
  return listWatchFoldersForActive();
}

/** Remove a watched folder (WATCH-9): drop it from the registry, audit the removal, and stop its live
 *  watcher. An unsafe id is a no-op (the registry guard would reject it anyway). */
export async function removeActiveWatchFolder(id: string): Promise<WatchFolderView[]> {
  if (!active) return [];
  if (!isSafeWatchId(id)) return listWatchFoldersForActive();
  const root = active.stagingWt;
  let removed = false;
  await active.lock.run(async () => {
    const folders = await readWatchRegistry(root);
    if (!folders.some((f) => f.id === id)) return;
    await writeWatchRegistry(root, folders.filter((f) => f.id !== id));
    removed = true;
    await commitControlFile(root, watchRegistryPath(root), `watch ${id} removed`);
  }, 'watch-config:remove');
  if (removed) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: id }, payload: { removed: true, why: 'Principal removed a watched folder via Control Panel' } });
    await active.watch.refresh(); // tear down the removed folder's live watcher
  }
  return listWatchFoldersForActive();
}

// --- Control Panel · Researchers (SPEC-0028 RESEARCH-15; over the researcher registry) ---

/** List the active KB's researchers with each one's last-run (from its newest `researcher` audit
 *  event). Reads `staging` (registry + audit live there). No active KB → empty (PANEL-9 degrade). */
export async function listResearchersForActive(): Promise<ResearcherView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  const registry = await readResearcherRegistry(root);
  const events = await readEvents(root, { actors: ['researcher'] }); // newest-first
  const lastByResearcher: Record<string, AuditEvent | undefined> = {};
  for (const r of registry) lastByResearcher[r.id] = events.find((e) => e.subjects.researcherId === r.id);
  return buildResearcherViews(registry, lastByResearcher);
}

/**
 * Apply a Researchers-view config change (RESEARCH-15) + return the refreshed list. Untrusted IPC
 * input is validated at this boundary (template/egress/schedule/posture dropped unless known enums;
 * an unsafe `id` is rejected by the registry guard). The write + git commit run under the shared
 * lock (durability); then a conforming `panel` audit event records the change (PANEL-7-style).
 */
export async function setActiveResearcherConfig(patch: ResearcherConfigPatch): Promise<ResearcherView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listResearchersForActive();

  // Validate untrusted IPC input into a `clean` patch (drop unknown enums; the rest is fail-safe).
  // apply + audit both use `clean`, so a dropped-invalid field is never recorded as applied
  // (QA-2 #81 follow-up — audit accuracy matters for the egress-relevant fields).
  const clean: ResearcherConfigPatch = { id: patch.id };
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (isSchedulePreset(patch.schedule)) clean.schedule = patch.schedule;
  if (isAutonomyPosture(patch.posture)) clean.posture = patch.posture;
  if (isEgressTier(patch.egressTier)) clean.egressTier = patch.egressTier;
  if (isResearcherTemplate(patch.template)) clean.template = patch.template;
  if (typeof patch.label === 'string') clean.label = patch.label;
  if (typeof patch.prompt === 'string' && patch.prompt.trim()) clean.prompt = patch.prompt;
  if (typeof patch.scope === 'string' && patch.scope.trim()) clean.scope = patch.scope;
  if (typeof patch.repoPath === 'string' && patch.repoPath.trim()) clean.repoPath = patch.repoPath.trim();
  if (typeof patch.tenantId === 'string' && patch.tenantId.trim()) clean.tenantId = patch.tenantId.trim();
  // prRepo is owner/name — validated at the boundary (drop a flag-like/garbage value, never store it).
  if (typeof patch.prRepo === 'string' && isSafeGhRepo(patch.prRepo.trim())) clean.prRepo = patch.prRepo.trim();
  if (Array.isArray(patch.topics)) clean.topics = patch.topics;
  // Editable budget/timeout (RESEARCH-15/18, WS3): clamp valid numbers to the sane range; reject garbage
  // (non-numeric / ≤0 / non-integer calls) by dropping it (field unchanged). The allowlist is NOT editable.
  const cleanMaxCalls = clampToolCalls(patch.maxToolCalls);
  if (cleanMaxCalls !== undefined) clean.maxToolCalls = cleanMaxCalls;
  const cleanTimeout = clampTimeoutMs(patch.timeoutMs);
  if (cleanTimeout !== undefined) clean.timeoutMs = cleanTimeout;
  const cleanMaxDepth = clampMaxDepth(patch.maxDepth); // WS3 Slice-2: the chain-depth safety bound (RESEARCH-11)
  if (cleanMaxDepth !== undefined) clean.maxDepth = cleanMaxDepth;
  const cleanOrient = clampOrientBudget(patch.orientBudget); // RESEARCH-22 warm-start: non-egress awareness cap
  if (cleanOrient !== undefined) clean.orientBudget = cleanOrient;

  let prior: ResearcherConfig | undefined;
  let applied = false;
  await active.lock.run(async () => {
    const registry = await readResearcherRegistry(root);
    prior = registry.find((r) => r.id === clean.id);
    if (prior) {
      await patchResearcher(root, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.schedule !== undefined ? { schedule: clean.schedule } : {}),
        ...(clean.posture !== undefined ? { posture: clean.posture } : {}),
        ...(clean.egressTier !== undefined ? { egressTier: clean.egressTier } : {}),
        ...(clean.prompt !== undefined ? { prompt: clean.prompt } : {}),
        ...(clean.scope !== undefined ? { scope: clean.scope } : {}),
        ...(clean.topics !== undefined ? { topics: clean.topics } : {}),
        // WS3: maxToolCalls + maxDepth (Slice-2) merge into the existing budget (each preserved if unset);
        // timeoutMs is top-level.
        ...(clean.maxToolCalls !== undefined || clean.maxDepth !== undefined
          ? {
              budget: {
                ...prior.budget,
                ...(clean.maxToolCalls !== undefined ? { maxToolCalls: clean.maxToolCalls } : {}),
                ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
              },
            }
          : {}),
        ...(clean.timeoutMs !== undefined ? { timeoutMs: clean.timeoutMs } : {}),
        ...(clean.orientBudget !== undefined ? { orientBudget: clean.orientBudget } : {}), // RESEARCH-22 warm-start (top-level)
        // Template config: merge repoPath (Code) / tenantId (M365) into the existing config,
        // preserving other config keys.
        ...(clean.repoPath !== undefined || clean.tenantId !== undefined || clean.prRepo !== undefined
          ? {
              config: {
                ...(prior.config ?? {}),
                ...(clean.repoPath !== undefined ? { repoPath: clean.repoPath } : {}),
                ...(clean.tenantId !== undefined ? { tenantId: clean.tenantId } : {}),
                ...(clean.prRepo !== undefined ? { prRepo: clean.prRepo } : {}),
              },
            }
          : {}),
      });
    } else {
      // New researcher: derive a safe config from the (validated) template + defaults.
      const template = clean.template ?? 'custom';
      const egressTier = clean.egressTier ?? defaultEgressFor(template);
      clean.egressTier = egressTier; // record the actual created egress in the audit (from local-only)
      await upsertResearcher(root, {
        id: clean.id,
        template,
        label: clean.label,
        prompt: clean.prompt ?? `Research ${template} sources relevant to the request.`,
        egressTier,
        scope: clean.scope ?? 'global',
        budget: {
          ...DEFAULT_RESEARCHER_BUDGET,
          ...(clean.maxToolCalls !== undefined ? { maxToolCalls: clean.maxToolCalls } : {}),
          ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
        },
        ...(clean.timeoutMs !== undefined ? { timeoutMs: clean.timeoutMs } : {}),
        ...(clean.orientBudget !== undefined ? { orientBudget: clean.orientBudget } : {}),
        schedule: clean.schedule ?? 'off',
        posture: clean.posture ?? DEFAULT_POSTURE,
        enabled: clean.enabled ?? false,
        ...(clean.topics ? { topics: clean.topics } : {}),
        ...(clean.repoPath || clean.tenantId || clean.prRepo
          ? { config: { ...(clean.repoPath ? { repoPath: clean.repoPath } : {}), ...(clean.tenantId ? { tenantId: clean.tenantId } : {}), ...(clean.prRepo ? { prRepo: clean.prRepo } : {}) } }
          : {}),
      });
    }
    applied = true;
    await commitControlFile(root, researcherRegistryPath(root), `researcher ${clean.id} config change`);
  }, 'researcher-config:write');
  if (applied) {
    // Conforming `panel` audit: one event per changed behavior-relevant field (from→to), validated
    // values only — never a dropped-invalid field, never a no-op re-assert (QA-2 #81 follow-up).
    for (const event of researcherConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listResearchersForActive();
}

/**
 * Delete a researcher (PANEL-11 lifecycle delete): PURGE its config row from the registry, audit the
 * removal (`panel` actor, `removed: true`), and let the scheduler tear its standing pass down naturally
 * (it re-reads the registry each tick — PANEL-6 — so a removed researcher is simply never scheduled
 * again; no live handle to stop, unlike a watched folder's fs watcher). Already-produced sources +
 * findings + the full audit trail are RETAINED — ground truth is sacred (PANEL-11); only the config/
 * registration is purged. An unsafe id is a no-op (the registry guard rejects it anyway). Mirrors
 * `removeActiveWatchFolder`.
 */
export async function removeActiveResearcher(id: string): Promise<ResearcherView[]> {
  if (!active) return [];
  if (!isSafeResearcherId(id)) return listResearchersForActive();
  const root = active.stagingWt;
  let removed = false;
  await active.lock.run(async () => {
    const registry = await readResearcherRegistry(root);
    if (!registry.some((r) => r.id === id)) return;
    await deleteResearcher(root, id);
    removed = true;
    await commitControlFile(root, researcherRegistryPath(root), `researcher ${id} removed`);
  }, 'researcher-config:remove');
  if (removed) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'researcher-config-change', subjects: { researcherId: id }, payload: { removed: true, why: 'Principal removed a researcher via Control Panel (config purged; sources + audit retained)' } });
  }
  return listResearchersForActive();
}

/**
 * Manual "Run now" for a researcher (RESEARCH-15, "run-now to test") — a single on-demand pass via
 * the run-pass against a synthetic request derived from the researcher's config. It runs the REAL
 * cognition (`makeWebResearchFn` — egress-gated + SSRF-safe), the same adapter the scheduler uses, so
 * "Run now" can never ingest synthetic scaffolding into the Principal's vault. Until the live SDK
 * web-fetch session is wired (gated separately), the gated adapter yields a graceful no-finding rather
 * than fabricate a source. The Principal's trigger is audited as a `panel` event; the run's own work
 * is audited by the run-pass (actor `researcher`).
 */
export async function runActiveResearcherNow(id: string): Promise<RunResearcherResult> {
  if (!active) return { ran: false, reason: 'no-kb' };
  const root = active.stagingWt;
  const r = (await readResearcherRegistry(root)).find((x) => x.id === id);
  if (!r) return { ran: false, reason: 'not-found' };
  const what = researchWhatFor(r); // WS1 #6: the researcher's real name, never the generic template word ("code")
  const req: ResearchRequest = {
    id: ulid(),
    ts: new Date().toISOString(),
    by: { stage: 'panel' },
    what,
    why: 'on-demand test run via Control Panel',
    context: '',
    dedupKey: dedupKeyFor({ what, by: {} }),
  };
  // Same cliPath+dev-log wiring + per-template cognition as the scheduler (one seam, #160) — so Run-now
  // can't silently no-op in the packaged app, and a code/m365 researcher tests its OWN adapter.
  const opts = researchDepsOptions(active.log);
  const res = await runResearcher(root, r, req, { research: selectResearchFn(root, r, opts), lock: active.lock });
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'researcher-run-now',
    subjects: { researcherId: id },
    payload: { outcome: res.failed ? 'failed' : res.ceilingReached ? 'ceiling-reached' : res.sourceIds.length > 0 ? 'researched' : 'no-finding', why: 'Principal manual run via Control Panel' },
  });
  return {
    ran: true,
    sourceIds: res.sourceIds,
    note: res.note,
    ...(res.failed ? { failed: true, ...(res.error ? { error: res.error } : {}) } : {}),
    ...(res.ceilingReached ? { ceilingReached: true } : {}),
  };
}

/** Recent runs for a researcher (RESEARCH-15) — its `researcher` audit events, newest-first. */
export async function listResearcherRunsForActive(id: string): Promise<ResearcherLastRun[]> {
  if (!active) return [];
  const events = await readEvents(active.stagingWt, { actors: ['researcher'], subjectId: id });
  return events.map((e) => lastRunFromEvent(e)).filter((x): x is ResearcherLastRun => x !== null);
}

// --- Control Panel · Sources — INTAKE feed connectors (SPEC-0027 PANEL-4 / INTAKE-14) ---

/** The intake connector registry as the Sources view needs it, with each connector's last pull. */
export async function listIntakeConnectorsForActive(): Promise<IntakeConnectorView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  const registry = await readIntakeRegistry(root);
  const events = await readEvents(root, { actors: ['intake'] }); // newest-first
  const lastByConnector: Record<string, AuditEvent | undefined> = {};
  for (const c of registry) lastByConnector[c.id] = events.find((e) => e.subjects.intakeId === c.id);
  return buildIntakeConnectorViews(registry, lastByConnector);
}

/**
 * Apply a Sources-view connector config change (INTAKE-14) + return the refreshed list. Untrusted IPC
 * input is validated at this boundary (type/schedule dropped unless known enums; `maxItemsPerPass`
 * clamped; an unsafe `id` is rejected by the registry guard). The write + git commit run under the
 * shared lock; then a conforming `panel` audit event records the change (PANEL-7-style).
 */
export async function setActiveIntakeConnectorConfig(patch: IntakeConnectorConfigPatch): Promise<IntakeConnectorView[]> {
  if (!active) return [];
  const root = active.stagingWt;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listIntakeConnectorsForActive();

  // Validate untrusted IPC into a `clean` patch (drop unknown enums; clamp the item cap). apply + audit
  // both use `clean`, so a dropped-invalid field is never recorded as applied (mirrors researchers #81).
  const clean: IntakeConnectorConfigPatch = { id: patch.id };
  if (isIntakeConnectorType(patch.type)) clean.type = patch.type;
  if (typeof patch.label === 'string') clean.label = patch.label;
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (isSchedulePreset(patch.schedule)) clean.schedule = patch.schedule;
  if (typeof patch.scope === 'string' && patch.scope.trim()) clean.scope = patch.scope.trim();
  if (typeof patch.sensitivity === 'string' && patch.sensitivity.trim()) clean.sensitivity = patch.sensitivity.trim();
  const cleanMax = clampMaxItems(patch.maxItemsPerPass);
  if (cleanMax !== undefined) clean.maxItemsPerPass = cleanMax;
  if (typeof patch.feedUrl === 'string' && patch.feedUrl.trim()) clean.feedUrl = patch.feedUrl.trim();
  if (typeof patch.tenantId === 'string' && patch.tenantId.trim()) clean.tenantId = patch.tenantId.trim();
  if (typeof patch.folder === 'string' && patch.folder.trim()) clean.folder = patch.folder.trim();

  let prior: IntakeConnectorConfig | undefined;
  let applied = false;
  await active.lock.run(async () => {
    const registry = await readIntakeRegistry(root);
    prior = registry.find((c) => c.id === clean.id);
    if (prior) {
      await patchIntakeConnector(root, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.schedule !== undefined ? { schedule: clean.schedule } : {}),
        ...(clean.scope !== undefined ? { scope: clean.scope } : {}),
        ...(clean.sensitivity !== undefined ? { sensitivity: clean.sensitivity } : {}),
        ...(clean.label !== undefined ? { label: clean.label } : {}),
        ...(clean.maxItemsPerPass !== undefined ? { maxItemsPerPass: clean.maxItemsPerPass } : {}),
        // Merge type-specific config (RSS feedUrl / M365 tenantId+folder), preserving other keys.
        ...(clean.feedUrl !== undefined || clean.tenantId !== undefined || clean.folder !== undefined
          ? {
              config: {
                ...(prior.config ?? {}),
                ...(clean.feedUrl !== undefined ? { feedUrl: clean.feedUrl } : {}),
                ...(clean.tenantId !== undefined ? { tenantId: clean.tenantId } : {}),
                ...(clean.folder !== undefined ? { folder: clean.folder } : {}),
              },
            }
          : {}),
      });
    } else {
      // New connector: derive a safe config from the (validated) type + conservative defaults.
      const type = clean.type ?? 'rss';
      clean.type = type;
      await upsertIntakeConnector(root, {
        id: clean.id,
        type,
        ...(clean.label ? { label: clean.label } : {}),
        enabled: clean.enabled ?? false,
        schedule: clean.schedule ?? 'off',
        scope: clean.scope ?? DEFAULT_INTAKE_SCOPE,
        sensitivity: clean.sensitivity ?? DEFAULT_INTAKE_SENSITIVITY,
        ...(clean.maxItemsPerPass !== undefined ? { maxItemsPerPass: clean.maxItemsPerPass } : {}),
        ...(clean.feedUrl || clean.tenantId || clean.folder
          ? { config: { ...(clean.feedUrl ? { feedUrl: clean.feedUrl } : {}), ...(clean.tenantId ? { tenantId: clean.tenantId } : {}), ...(clean.folder ? { folder: clean.folder } : {}) } }
          : {}),
      });
    }
    applied = true;
    await commitControlFile(root, intakeRegistryPath(root), `intake ${clean.id} config change`);
  }, 'intake-config:write');
  if (applied) {
    // Conforming `panel` audit: one event per changed behavior-relevant field (validated values only).
    for (const event of intakeConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listIntakeConnectorsForActive();
}

/**
 * Delete an intake feed connector (PANEL-11 lifecycle delete): PURGE its config row from the registry,
 * audit the removal (`panel` actor, `removed: true`), and let the scheduler tear its standing pull down
 * naturally (it re-reads the registry each tick — PANEL-6). Already-produced sources + the full audit
 * trail are RETAINED — only the config/registration is purged (ground truth is sacred, PANEL-11). An
 * unsafe id is a no-op (the registry guard rejects it anyway). Mirrors `removeActiveResearcher`.
 */
export async function removeActiveIntakeConnector(id: string): Promise<IntakeConnectorView[]> {
  if (!active) return [];
  if (!isSafeConnectorId(id)) return listIntakeConnectorsForActive();
  const root = active.stagingWt;
  let removed = false;
  await active.lock.run(async () => {
    const registry = await readIntakeRegistry(root);
    if (!registry.some((c) => c.id === id)) return;
    await deleteIntakeConnector(root, id);
    removed = true;
    await commitControlFile(root, intakeRegistryPath(root), `intake ${id} removed`);
  }, 'intake-config:remove');
  if (removed) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'intake-config-change', subjects: { intakeId: id }, payload: { removed: true, why: 'Principal removed an intake feed via Control Panel (config purged; sources + audit retained)' } });
  }
  return listIntakeConnectorsForActive();
}

/**
 * Principal override of a source's sensitivity label (SENSE-7/8). Validates the id is a real archived
 * source; under the canonical-writer lock it (1) persists the override to the Replay-sticky store so a
 * rebuild re-applies it (the classifier never overwrites a `by: principal` label), (2) re-stamps the
 * source's `source.md` frontmatter to the new label + `by: principal` (committing both atomically), then
 * (3) audits the change (`panel` event, from→to + why, SENSE-8). An empty label CLEARS the override (back
 * to the classifier/default). A custom label is accepted verbatim (SENSE-1); the comparator handles unknowns.
 */
export async function setActiveSourceSensitivity(sourceId: string, label: string): Promise<{ ok: boolean; reason?: string; sensitivity?: string }> {
  if (!active) return { ok: false, reason: 'no-kb' };
  if (typeof sourceId !== 'string' || !isUlid(sourceId)) return { ok: false, reason: 'bad-id' }; // #29: only a real ULID → a real source path
  const clean = typeof label === 'string' ? label.trim() : '';
  const root = active.stagingWt;
  const srcMdRel = path.join('sources', dateShard(sourceId), sourceId, 'source.md');
  const srcMdAbs = path.join(root, srcMdRel);
  try {
    await fs.access(srcMdAbs); // early not-found before taking the lock
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  const at = new Date().toISOString();
  let fromLabel = '';
  await active.lock.run(async () => {
    // Read the authoritative base INSIDE the lock so a concurrent archive of the same source can't make
    // the re-stamp clobber a stale base (KB-QD-2 #267).
    const before = await fs.readFile(srcMdAbs, 'utf8');
    fromLabel = (before.match(/^sensitivity: (.*)$/m)?.[1] ?? '').trim();
    await setSensitivityOverride(root, sourceId, clean, at); // clean === '' clears the override
    // Setting: re-stamp the live source.md now so the Panel reflects it without a rebuild. Clearing: leave
    // the frontmatter as-is (a later Replay re-derives the classifier/default label).
    if (clean.length > 0) await fs.writeFile(srcMdAbs, applySensitivityOverrideToSourceMd(before, clean, at), 'utf8');
    const git = boundedGit(root);
    await git.add([path.relative(root, sensitivityOverridesPath(root)), srcMdRel]);
    const staged = (await git.diff(['--cached', '--name-only'])).trim();
    if (staged.length > 0) await git.commit(`control-panel: sensitivity ${sourceId} → ${clean || '(cleared)'}`);
  }, 'sensitivity-override:write');
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'sensitivity-override',
    subjects: { sourceId },
    payload: { field: 'sensitivity', from: fromLabel, to: clean || '(cleared → classifier/default)', by: 'principal', why: 'Principal overrode a source sensitivity via Control Panel' },
  });
  return { ok: true, sensitivity: clean || fromLabel };
}

/** Read the current sensitivity label + provenance for a set of sources (SENSE-10) — for the Control
 *  Panel (the Activity-lineage drill-down) to show a chip + offer the Principal an edit. Read-only. */
export async function getActiveSourceSensitivities(sourceIds: string[]): Promise<Record<string, SourceSensitivity>> {
  if (!active || !Array.isArray(sourceIds)) return {};
  return readSourceSensitivities(active.stagingWt, sourceIds.filter((s): s is string => typeof s === 'string'));
}

/**
 * Manual "Run now" for an intake connector (INTAKE-14, "run-now to test") — a single on-demand pull
 * via the real run-pass + the real per-type fetch (RSS = the SSRF-safe gated fetch; M365 = env-gated,
 * surfaces a clear `intake-failed` until wired). Never ingests synthetic scaffolding. The Principal's
 * trigger is audited as a `panel` event; the pull's own work is audited by the run-pass (actor `intake`).
 */
export async function runActiveIntakeConnectorNow(id: string): Promise<RunIntakeConnectorResult> {
  if (!active) return { ran: false, reason: 'no-kb' };
  const root = active.stagingWt;
  const c = (await readIntakeRegistry(root)).find((x) => x.id === id);
  if (!c) return { ran: false, reason: 'not-found' };
  const res = await runIntakeConnector(root, c, { fetch: selectIntakeFn(c) });
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'intake-run-now',
    subjects: { intakeId: id },
    payload: { outcome: res.failed ? 'failed' : res.sourceIds.length > 0 ? 'intook' : 'no-new-items', why: 'Principal manual run via Control Panel' },
  });
  return { ran: true, sourceIds: res.sourceIds, note: res.note, ...(res.failed ? { failed: true, ...(res.error ? { error: res.error } : {}) } : {}) };
}

/** Commit a job-registry change on `staging` — the durability record (audit is a separate `panel` event). */
async function commitRegistryChange(root: string, message: string): Promise<void> {
  await commitControlFile(root, jobRegistryPath(root), message);
}

/**
 * Commit one Control-Panel working file on the `staging` root — the **durability record**: these
 * files (`.kb/jobs/registry.json`, `.kb/instance.json`) are tracked on `staging`, never promoted, so
 * a commit is durable and protects them from a stray staging reset (the *conforming* audit is the
 * separate `panel` event the caller emits). MUST be called inside `lock.run` (it advances the
 * canonical branch directly; under the lock it is just another linear advance that stages cherry-pick
 * their disjoint work onto). A no-op write (identical bytes) commits nothing.
 */
// Exported for the #163 regression gate (boundedGit under the lock); `timeoutMs` defaults to the
// standard bound and is overridable so the test can drive the timeout fast.
export async function commitControlFile(root: string, absPath: string, message: string, timeoutMs?: number): Promise<void> {
  const git = boundedGit(root, timeoutMs); // #163: bounded — runs under the canonical-writer lock
  const rel = path.relative(root, absPath);
  await git.add(rel);
  // #517 BUG-10: scope BOTH the staged-check and the commit to `rel` — an unscoped `diff --cached` /
  // `commit` would (a) short-circuit `return` on someone ELSE's leftover staged file even when `rel`
  // itself has no change, or (b) silently sweep that leftover into this "control-panel: ..." commit.
  const staged = (await git.diff(['--cached', '--name-only', '--', rel])).trim();
  if (staged.length === 0) return; // nothing actually changed for THIS file
  await git.commit(`control-panel: ${message}`, rel);
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

function composeCoverageMessage(stats: { total: number; composed: number; remaining: number }): string {
  if (stats.total === 0) return 'No entities with claims to compose yet.';
  return stats.remaining === 0
    ? `All ${stats.total} entities with claims read as articles.`
    : `${stats.composed} of ${stats.total} entities composed, ${stats.remaining} to go.`;
}

/**
 * SPEC-0046 COMPOSE-9 — read-only "is the whole vault composed yet?" coverage (no side effects). Reads
 * the staging worktree (the compose source of truth) so it reflects work composed but not yet promoted.
 */
export async function composeBacklogStatus(): Promise<ComposeBacklogResult> {
  if (!active) return { ok: false, message: 'No active library.' };
  try {
    const stats = await composeBacklogStats(active.stagingWt);
    return { ok: true, ...stats, message: composeCoverageMessage(stats) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * SPEC-0046 COMPOSE-9 — the one-shot "backfill the vault" trigger: re-attempt any set-aside entities
 * (so a transient Compose outage doesn't leave a stuck remnant), then kick the Compose stage to drain
 * the uncomposed backlog (bounded per pass, coalesced promotion — never a per-entity storm). Returns
 * the CURRENT coverage immediately; the backfill then runs in the background.
 */
export async function composeBacklog(): Promise<ComposeBacklogResult> {
  if (!active) return { ok: false, message: 'No active library.' };
  const { stagingWt, lock, compose } = active;
  try {
    const reopened = await reopenComposeSetAside(stagingWt, lock);
    void compose.poke(); // drain the backlog (bounded, coalesced); runs in the background
    const stats = await composeBacklogStats(stagingWt);
    const tail = reopened > 0 ? ` (re-queued ${reopened} that had stalled)` : '';
    return {
      ok: true,
      ...stats,
      reopened,
      message: stats.remaining > 0 ? `${composeCoverageMessage(stats)} Composing…${tail}` : composeCoverageMessage(stats),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
