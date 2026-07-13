// Control Panel · Researchers (SPEC-0028 RESEARCH-15; over the researcher registry). Extracted out of
// pipeline.ts (#528 ENG-7); pipeline.ts's thin `*ForActive` wrappers pass in exactly what this needs.
import type { Mutex } from '../../kb/stageLock';
import type { DevLog } from '../../kb/devlog';
import { readResearcherRegistry, upsertResearcher, patchResearcher, deleteResearcher, researcherRegistryPath } from '../../kb/researcherRegistry';
import { buildResearcherViews, isEgressTier, isResearcherTemplate, defaultEgressFor, researcherConfigAuditEvents, lastRunFromEvent } from '../../kb/researchersPanel';
import { isSchedulePreset, isAutonomyPosture } from '../../kb/jobsPanel';
import { isSafeGhRepo } from '../../kb/ghRead';
import { DEFAULT_RESEARCHER_BUDGET, dedupKeyFor, researchWhatFor, clampToolCalls, clampTimeoutMs, clampMaxDepth, clampOrientBudget, isSafeResearcherId, type ResearchRequest, type ResearcherConfig } from '../../kb/researchers';
import { ulid } from '../../kb/ulid';
import { DEFAULT_POSTURE } from '../../kb/jobs';
import { appendAuditEvent } from '../../kb/audit';
import { readEvents } from '../../kb/activityIndex';
import { runResearcher } from '../../kb/researchRun';
import { selectResearchFn } from '../../kb/researchInline';
import { researchDepsOptions } from '../researchWiring';
import type { ResearcherView, ResearcherConfigPatch, ResearcherLastRun, RunResearcherResult } from '../../kb/types';
import type { AuditEvent } from '../../kb/audit';
import { runRegistryWrite, runRegistryRemove } from './registryCrud';

export interface ResearchersCtx {
  root: string;
  lock: Mutex;
  log: DevLog;
}

/** List the active KB's researchers with each one's last-run (from its newest `researcher` audit
 *  event). Reads `staging` (registry + audit live there). */
export async function listResearchers(root: string): Promise<ResearcherView[]> {
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
export async function setResearcherConfig(patch: ResearcherConfigPatch, ctx: ResearchersCtx): Promise<ResearcherView[]> {
  const { root, lock } = ctx;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listResearchers(root);

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

  const { prior, applied } = await runRegistryWrite<ResearcherConfig>(root, {
    lock,
    lockLabel: 'researcher-config:write',
    registryPath: researcherRegistryPath,
    commitMessage: `researcher ${clean.id} config change`,
    read: (r) => readResearcherRegistry(r),
    findId: clean.id,
    patchExisting: (r, prior) =>
      patchResearcher(r, clean.id, {
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
      }),
    insertNew: async (r) => {
      // New researcher: derive a safe config from the (validated) template + defaults.
      const template = clean.template ?? 'custom';
      const egressTier = clean.egressTier ?? defaultEgressFor(template);
      clean.egressTier = egressTier; // record the actual created egress in the audit (from local-only)
      await upsertResearcher(r, {
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
      return true;
    },
  });
  if (applied) {
    // Conforming `panel` audit: one event per changed behavior-relevant field (from→to), validated
    // values only — never a dropped-invalid field, never a no-op re-assert (QA-2 #81 follow-up).
    for (const event of researcherConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listResearchers(root);
}

/**
 * Delete a researcher (PANEL-11 lifecycle delete): PURGE its config row from the registry, audit the
 * removal (`panel` actor, `removed: true`), and let the scheduler tear its standing pass down naturally
 * (it re-reads the registry each tick — PANEL-6 — so a removed researcher is simply never scheduled
 * again; no live handle to stop, unlike a watched folder's fs watcher). Already-produced sources +
 * findings + the full audit trail are RETAINED — ground truth is sacred (PANEL-11); only the config/
 * registration is purged. An unsafe id is a no-op (the registry guard rejects it anyway). Mirrors
 * `removeWatchFolder`.
 */
export async function removeResearcher(id: string, ctx: ResearchersCtx): Promise<ResearcherView[]> {
  const { root, lock } = ctx;
  if (!isSafeResearcherId(id)) return listResearchers(root);
  const removed = await runRegistryRemove(root, {
    lock,
    lockLabel: 'researcher-config:remove',
    registryPath: researcherRegistryPath,
    commitMessage: `researcher ${id} removed`,
    read: (r) => readResearcherRegistry(r),
    findId: id,
    remove: (r, removeId) => deleteResearcher(r, removeId),
  });
  if (removed) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'researcher-config-change', subjects: { researcherId: id }, payload: { removed: true, why: 'Principal removed a researcher via Control Panel (config purged; sources + audit retained)' } });
  }
  return listResearchers(root);
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
export async function runResearcherNow(id: string, ctx: ResearchersCtx): Promise<RunResearcherResult> {
  const { root, lock, log } = ctx;
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
  const opts = researchDepsOptions(log);
  const res = await runResearcher(root, r, req, { research: selectResearchFn(root, r, opts), lock });
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
export async function listResearcherRuns(root: string, id: string): Promise<ResearcherLastRun[]> {
  const events = await readEvents(root, { actors: ['researcher'], subjectId: id });
  return events.map((e) => lastRunFromEvent(e)).filter((x): x is ResearcherLastRun => x !== null);
}
