// Control Panel · Jobs (SPEC-0027 PANEL-2/6/7) — read/manage the per-vault job registry. Extracted out
// of pipeline.ts (#528 ENG-7); pipeline.ts's thin `*ForActive` wrappers pass in exactly what this
// needs (root/lock/scheduler) rather than this module importing the `active` singleton directly.
import type { Mutex } from '../../kb/stageLock';
import type { JobRunResult } from '../../kb/jobStage';
import { readJobRegistry, patchJob, upsertJob, jobRegistryPath } from '../../kb/jobRegistry';
import { readJournal } from '../../kb/jobStage';
import { JOB_CATALOG, catalogEntry, facingForType } from '../../kb/jobCatalog';
import { buildJobViews, isSchedulePreset, isAutonomyPosture, jobConfigAuditEvents } from '../../kb/jobsPanel';
import { readInstanceConfig, resolveJobPosture } from '../../kb/instanceConfig';
import { appendAuditEvent } from '../../kb/audit';
import { asWorkDepthConfig } from '../../kb/workDepth';
import type { JournalEntry } from '../../kb/jobs';
import type { JobView, JobConfigPatch, RunJobResult } from '../../kb/types';
import { commitControlFile } from '../commitControlFile';
import { runRegistryWrite } from './registryCrud';

export interface JobsCtx {
  root: string;
  lock: Mutex;
  runNow: (id: string) => Promise<JobRunResult | 'skipped' | 'not-found' | 'unknown-type'>;
}

/**
 * List the manageable jobs for the active KB (PANEL-2): the known-job catalog merged with the
 * registry, each row carrying its last-run summary from the journal. Reads `staging` (where the
 * registry + journals live).
 */
export async function listJobs(root: string): Promise<JobView[]> {
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
export async function setJobConfig(patch: JobConfigPatch, ctx: JobsCtx): Promise<JobView[]> {
  const { root, lock } = ctx;
  if (typeof patch.id !== 'string' || patch.id.length === 0 || typeof patch.type !== 'string' || patch.type.length === 0) {
    return listJobs(root);
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

  const { prior, applied } = await runRegistryWrite(root, {
    lock,
    lockLabel: 'job-config:write',
    registryPath: jobRegistryPath,
    commitMessage: summarizeJobChange(clean),
    read: readJobRegistry,
    findId: clean.id,
    patchExisting: (r) =>
      patchJob(r, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.schedule !== undefined ? { schedule: clean.schedule } : {}),
        ...(clean.posture !== undefined ? { posture: clean.posture } : {}),
        ...(clean.workDepth !== undefined ? { workDepth: clean.workDepth } : {}),
      }),
    insertNew: async (r) => {
      // Refuse an unknown job (not in the catalog and not already registered) from untrusted input.
      if (catalogEntry(clean.type) === undefined) return false;
      // New job: an explicit per-job posture wins; otherwise inherit the Instance default (AUTO-12
      // cascade — `resolveJobPosture` is the single swap point if the ruling lands differently).
      // JOBS-16: facing comes from the catalog (the built-in's fixed facing; `internal` default).
      const instanceCfg = await readInstanceConfig(r);
      await upsertJob(r, {
        id: clean.id,
        type: clean.type,
        enabled: clean.enabled ?? false,
        schedule: clean.schedule ?? 'off',
        posture: resolveJobPosture(instanceCfg.autonomyDefault, clean.posture),
        facing: facingForType(clean.type),
        ...(clean.workDepth !== undefined ? { workDepth: clean.workDepth } : {}),
      });
      return true;
    },
  });
  if (applied) {
    // Conforming audit (PANEL-7 / AUDIT-2/11): one `panel` event per changed field, carrying the why.
    // Appends to the gitignored `.kb/audit.jsonl` (not canonical) — fine outside the lock.
    for (const event of jobConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listJobs(root);
}

/**
 * Manual "Run now" for one job (PANEL-2; JOBS-11) — one bounded pass on demand, respecting
 * single-flight. Run-now is independent of enable/schedule, so a catalog-only job is seeded
 * (off/guarded) and committed before running, letting the Principal test a job without turning it on.
 * The Principal's trigger is itself audited as a `panel` event (PANEL-7); the run's own work is
 * audited by the job journal (actor `job`).
 */
export async function runJobNow(id: string, ctx: JobsCtx): Promise<RunJobResult> {
  const { root, lock } = ctx;
  const registry = await readJobRegistry(root);
  if (!registry.some((j) => j.id === id)) {
    const entry = catalogEntry(id); // v1: catalog id === type
    if (!entry) return { ran: false, reason: 'not-found' };
    await lock.run(async () => {
      const instanceCfg = await readInstanceConfig(root);
      await upsertJob(root, { id, type: entry.type, enabled: false, schedule: 'off', posture: resolveJobPosture(instanceCfg.autonomyDefault, undefined), facing: facingForType(entry.type) });
      await commitControlFile(root, jobRegistryPath(root), `seed job ${id} for run-now`);
    }, 'job:seed-for-run-now');
  }
  const res = await ctx.runNow(id);
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
