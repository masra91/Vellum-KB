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
//
// #574 (fast-follow to #528/#572): the ActivePipeline singleton + startPipeline's boot sequence +
// QUIESCE + Full Replay live in `pipelineLifecycle.ts`; the four maintained projection stores (status/
// review/graph/Today) live in `pipelineProjections.ts` — both were split out once this file grew back
// past #528's <800-line AC even after #572's registry/decider extraction. This file re-exports both
// modules' full public surface (so no importer needs to change its path — mirrors the `commitControlFile`
// re-export precedent #572 established) and keeps the remaining IPC-facing action handlers: review
// answer/remediation, saveRecallOutput, the registry-CRUD delegators (thin wrappers over
// registries/*ControlPanel.ts, #572), and the compose-backlog / set-aside recovery actions.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listArchiveSetAsideItems, retryArchiveItem, dismissArchiveItem } from '../kb/orchestrator';
import { listSetAsideItems, retryClaimsItem, dismissClaimsItem } from '../kb/claimsStage';
import { reopenComposeSetAside, composeBacklogStats } from '../kb/composeStage';
import { listConnectSetAsideItems, retryConnectItem, dismissConnectItem } from '../kb/connectStage';
export { commitControlFile } from './commitControlFile';
import * as jobsControlPanel from './registries/jobsControlPanel';
import { readJournal } from '../kb/jobStage';
import * as watchControlPanel from './registries/watchControlPanel';
import * as researchersControlPanel from './registries/researchersControlPanel';
import * as intakeControlPanel from './registries/intakeControlPanel';
import * as sourceSensitivityControlPanel from './registries/sourceSensitivityControlPanel';
import * as instanceSettingsControlPanel from './registries/instanceSettingsControlPanel';
import * as modelsControlPanel from './registries/modelsControlPanel';
import { researchDepsOptions } from './researchWiring';
import { planSetAsideAction, type SetAsideTarget } from '../kb/pipelineControl';
import { boundedGit } from '../kb/canonicalAdvance';
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
import { defaultInstanceConfig } from '../kb/instanceConfig';
import { resolveCopilotModel } from '../kb/copilotModel';
import { appendAuditEvent } from '../kb/audit';
import type { WatchFolderView, WatchFolderPatch, IntakeConnectorView, IntakeConnectorConfigPatch, RunIntakeConnectorResult } from '../kb/types';
import { ulid } from '../kb/ulid';
import type { SourceSensitivity } from '../kb/sensitivityRead';
import { buildRecallOutput } from '../kb/outputDoc';
import type { Review } from '../kb/reviews';
import type { AskResult } from '../kb/recall';
import type { ComposeBacklogResult, JobView, JobConfigPatch, JobLastRun, RunJobResult, InstanceSettings, AgentView, ModelCatalogView, SetModelResult, ResearcherView, ResearcherConfigPatch, ResearcherLastRun, RunResearcherResult, SaveRecallOutputResult, PipelineControlRequest, PipelineControlResult } from '../kb/types';

// Re-export the lifecycle core (#574) — every external importer (ipc.ts, tests) keeps using './pipeline'
// unchanged; only this file + `pipelineLifecycle.ts` itself know the code actually moved.
export {
  MAX_QUIESCE_FLUSH_ATTEMPTS,
  activeSnapshotDir,
  activePipeline,
  activeStagingRoot,
  quiesceActive,
  resumeActive,
  isActiveQuiescing,
  quiesceFlushDecision,
  quiesceStatusForActive,
  startPipeline,
  stopPipeline,
  stopPipelineForQuit,
  fullReplay,
} from './pipelineLifecycle';
import { getActivePipeline, type ActivePipeline } from './pipelineLifecycle';

// Re-export the maintained projections (#574) — same barrel guarantee as above.
export {
  type ProjectionPushEvent,
  setProjectionPushSink,
  pipelineStatusForActive,
  refreshStatusSnapshot,
  reviewProjectionForActive,
  refreshReviewProjection,
  graphProjectionPath,
  loadGraphProjection,
  stripBodiesForPersist,
  saveGraphProjection,
  graphProjectionForActive,
  refreshGraphProjection,
  todayProjectionForActive,
  refreshTodayProjection,
} from './pipelineProjections';
import { refreshStatusSnapshot, refreshReviewProjection } from './pipelineProjections';

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
  const a = getActivePipeline();
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
    } else if (req.stage === 'archive') {
      // #516 BUG-3 / OBS-17: archive's set-aside handle IS the inbox ULID itself (no separate repo-
      // relative path like claims'/connect's node/block identity — the unit never moves).
      targets = (await listArchiveSetAsideItems(a.stagingWt)).map((i) => ({ id: i.id, handle: i.id, label: i.name || i.id }));
      doRetry = (h) => retryArchiveItem(a.stagingWt, h, a.lock);
      doDismiss = (h) => dismissArchiveItem(a.stagingWt, h, a.lock);
      pokeAfterRetry = () => void a.orch.poke();
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
  const active = getActivePipeline();
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
  const a = getActivePipeline();
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
  const a = getActivePipeline();
  if (!a) return { ok: false, message: 'No active library.' };
  return remediateHealthFindingInVault(a.stagingWt, a.vaultPath, a.lock, req, a.log);
}

/** SPEC-0060 VUX-16 slice-1: dismiss (or restore) a Health finding on the active vault — persisted as an
 *  evergreen directive, promoted to `main` where the Health scan's dismiss filter reads it. */
export async function dismissActiveHealthFinding(req: HealthDismissRequest): Promise<HealthDismissResult> {
  const a = getActivePipeline();
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
  const a = getActivePipeline();
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
// Full implementation lives in registries/jobsControlPanel.ts (#528 ENG-7); these are thin
// active-KB-guarded wrappers so the module above never needs the `active` singleton itself.

export async function listJobsForActive(): Promise<JobView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return jobsControlPanel.listJobs(active.stagingWt);
}

export async function setActiveJobConfig(patch: JobConfigPatch): Promise<JobView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return jobsControlPanel.setJobConfig(patch, { root: active.stagingWt, lock: active.lock, runNow: (id) => active.jobs.runNow(id) });
}

export async function runActiveJobNow(id: string): Promise<RunJobResult> {
  const active = getActivePipeline();
  if (!active) return { ran: false, reason: 'no-kb' };
  return jobsControlPanel.runJobNow(id, { root: active.stagingWt, lock: active.lock, runNow: (jobId) => active.jobs.runNow(jobId) });
}

/** VUX-17 (#524 §5 / #559): the Agents drill-in's past-runs timeline — a job's full journal
 *  (`.kb/jobs/<id>/journal.jsonl`), newest-first (readJournal returns oldest→newest; a timeline reads
 *  top-down as "most recent first", same convention as listResearcherRunsForActive below). */
export async function jobHistoryForActive(id: string): Promise<JobLastRun[]> {
  const active = getActivePipeline();
  if (!active) return [];
  const journal = await readJournal(active.stagingWt, id);
  return journal
    .slice()
    .reverse()
    .map((e) => ({ ts: e.ts, inspected: e.inspected, applied: e.applied, deferred: e.deferred, ...(e.note ? { note: e.note } : {}) }));
}

// --- Control Panel · Settings + Agents (SPEC-0027 PANEL-3/5) ---
// Full implementation lives in registries/instanceSettingsControlPanel.ts + registries/modelsControlPanel.ts (#528 ENG-7).

export async function getActiveInstanceSettings(): Promise<InstanceSettings> {
  return instanceSettingsControlPanel.getInstanceSettings(getActivePipeline()?.stagingWt ?? null);
}

export async function setActiveInstanceSettings(settings: InstanceSettings): Promise<InstanceSettings> {
  const active = getActivePipeline();
  if (!active) return defaultInstanceConfig();
  return instanceSettingsControlPanel.setInstanceSettings(settings, {
    root: active.stagingWt,
    lock: active.lock,
    log: active.log,
    applyLiveCaps: (caps) => {
      active.orch.setCap(caps.archive);
      active.decompose.setCap(caps.decompose);
      active.claims.setCap(caps.claims);
      active.compose.setCap(caps.compose);
      active.connect.setCap(caps.connect); // SCALE-5: Connect's resolve drain is now live-tunable too
    },
  });
}

export async function listAgentsForActive(): Promise<AgentView[]> {
  const active = getActivePipeline();
  return modelsControlPanel.listAgents(active ? { root: active.stagingWt, pipelineActive: true } : null);
}

export async function getModelCatalogForActive(): Promise<ModelCatalogView> {
  return modelsControlPanel.getModelCatalog(getActivePipeline()?.stagingWt ?? null);
}

export async function setActiveModel(id: string | null): Promise<SetModelResult> {
  const active = getActivePipeline();
  if (!active) return { ok: false, resolved: resolveCopilotModel() };
  return modelsControlPanel.setModel(id, { root: active.stagingWt, lock: active.lock, log: active.log });
}

export async function setActiveAgentModel(agentKey: string, id: string | null): Promise<SetModelResult> {
  const active = getActivePipeline();
  if (!active) return { ok: false, resolved: resolveCopilotModel(undefined, agentKey) };
  return modelsControlPanel.setAgentModel(agentKey, id, { root: active.stagingWt, lock: active.lock, log: active.log });
}

// --- Control Panel · Watched folders (SPEC-0037 WATCH-9; over the watch registry) ---
// Full implementation lives in registries/watchControlPanel.ts (#528 ENG-7).

function watchCtx(a: ActivePipeline): watchControlPanel.WatchCtx {
  return { root: a.stagingWt, lock: a.lock, vaultPath: a.vaultPath, log: a.log, watchingIds: () => a.watch.watchingIds(), refresh: () => a.watch.refresh() };
}

export async function listWatchFoldersForActive(): Promise<WatchFolderView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return watchControlPanel.listWatchFolders(watchCtx(active));
}

export async function setActiveWatchFolder(patch: WatchFolderPatch): Promise<WatchFolderView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return watchControlPanel.setWatchFolder(patch, watchCtx(active));
}

export async function removeActiveWatchFolder(id: string): Promise<WatchFolderView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return watchControlPanel.removeWatchFolder(id, watchCtx(active));
}

// --- Control Panel · Researchers (SPEC-0028 RESEARCH-15; over the researcher registry) ---
// Full implementation lives in registries/researchersControlPanel.ts (#528 ENG-7).

function researchersCtx(a: ActivePipeline): researchersControlPanel.ResearchersCtx {
  return { root: a.stagingWt, lock: a.lock, log: a.log };
}

export async function listResearchersForActive(): Promise<ResearcherView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return researchersControlPanel.listResearchers(active.stagingWt);
}

export async function setActiveResearcherConfig(patch: ResearcherConfigPatch): Promise<ResearcherView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return researchersControlPanel.setResearcherConfig(patch, researchersCtx(active));
}

export async function removeActiveResearcher(id: string): Promise<ResearcherView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return researchersControlPanel.removeResearcher(id, researchersCtx(active));
}

export async function runActiveResearcherNow(id: string): Promise<RunResearcherResult> {
  const active = getActivePipeline();
  if (!active) return { ran: false, reason: 'no-kb' };
  return researchersControlPanel.runResearcherNow(id, researchersCtx(active));
}

export async function listResearcherRunsForActive(id: string): Promise<ResearcherLastRun[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return researchersControlPanel.listResearcherRuns(active.stagingWt, id);
}

// --- Control Panel · Sources — INTAKE feed connectors (SPEC-0027 PANEL-4 / INTAKE-14) ---
// Full implementation lives in registries/intakeControlPanel.ts + registries/sourceSensitivityControlPanel.ts (#528 ENG-7).

export async function listIntakeConnectorsForActive(): Promise<IntakeConnectorView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return intakeControlPanel.listIntakeConnectors(active.stagingWt);
}

export async function setActiveIntakeConnectorConfig(patch: IntakeConnectorConfigPatch): Promise<IntakeConnectorView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return intakeControlPanel.setIntakeConnectorConfig(patch, { root: active.stagingWt, lock: active.lock });
}

export async function removeActiveIntakeConnector(id: string): Promise<IntakeConnectorView[]> {
  const active = getActivePipeline();
  if (!active) return [];
  return intakeControlPanel.removeIntakeConnector(id, { root: active.stagingWt, lock: active.lock });
}

export async function runActiveIntakeConnectorNow(id: string): Promise<RunIntakeConnectorResult> {
  const active = getActivePipeline();
  if (!active) return { ran: false, reason: 'no-kb' };
  return intakeControlPanel.runIntakeConnectorNow(id, active.stagingWt);
}

export async function setActiveSourceSensitivity(sourceId: string, label: string): Promise<{ ok: boolean; reason?: string; sensitivity?: string }> {
  const active = getActivePipeline();
  if (!active) return { ok: false, reason: 'no-kb' };
  return sourceSensitivityControlPanel.setSourceSensitivity(sourceId, label, { root: active.stagingWt, lock: active.lock });
}

export async function getActiveSourceSensitivities(sourceIds: string[]): Promise<Record<string, SourceSensitivity>> {
  const active = getActivePipeline();
  if (!active) return {};
  return sourceSensitivityControlPanel.getSourceSensitivities(active.stagingWt, sourceIds);
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
  const active = getActivePipeline();
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
  const active = getActivePipeline();
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
