// Control Panel · Sources — INTAKE feed connectors (SPEC-0027 PANEL-4 / INTAKE-14). Extracted out of
// pipeline.ts (#528 ENG-7); pipeline.ts's thin `*ForActive` wrappers pass in exactly what this needs.
import type { Mutex } from '../../kb/stageLock';
import { readIntakeRegistry, upsertIntakeConnector, patchIntakeConnector, deleteIntakeConnector, intakeRegistryPath } from '../../kb/intakeRegistry';
import { runIntakeConnector } from '../../kb/intakeRun';
import { DEFAULT_INTAKE_SCOPE, DEFAULT_INTAKE_SENSITIVITY, isSafeConnectorId, type IntakeConnectorConfig } from '../../kb/intakeConnectors';
import { buildIntakeConnectorViews, isIntakeConnectorType, clampMaxItems, intakeConfigAuditEvents } from '../../kb/intakeSourcingPanel';
import { isSchedulePreset } from '../../kb/jobsPanel';
import { selectIntakeFn } from '../../kb/intakeScheduler';
import { appendAuditEvent } from '../../kb/audit';
import { readEvents } from '../../kb/activityIndex';
import type { AuditEvent } from '../../kb/audit';
import type { IntakeConnectorView, IntakeConnectorConfigPatch, RunIntakeConnectorResult } from '../../kb/types';
import { runRegistryWrite, runRegistryRemove } from './registryCrud';

export interface IntakeCtx {
  root: string;
  lock: Mutex;
}

/** The intake connector registry as the Sources view needs it, with each connector's last pull. */
export async function listIntakeConnectors(root: string): Promise<IntakeConnectorView[]> {
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
export async function setIntakeConnectorConfig(patch: IntakeConnectorConfigPatch, ctx: IntakeCtx): Promise<IntakeConnectorView[]> {
  const { root, lock } = ctx;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listIntakeConnectors(root);

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

  const { prior, applied } = await runRegistryWrite<IntakeConnectorConfig>(root, {
    lock,
    lockLabel: 'intake-config:write',
    registryPath: intakeRegistryPath,
    commitMessage: `intake ${clean.id} config change`,
    read: (r) => readIntakeRegistry(r),
    findId: clean.id,
    patchExisting: (r, prior) =>
      patchIntakeConnector(r, clean.id, {
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
      }),
    insertNew: async (r) => {
      // New connector: derive a safe config from the (validated) type + conservative defaults.
      const type = clean.type ?? 'rss';
      clean.type = type;
      await upsertIntakeConnector(r, {
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
      return true;
    },
  });
  if (applied) {
    // Conforming `panel` audit: one event per changed behavior-relevant field (validated values only).
    for (const event of intakeConfigAuditEvents(prior, clean)) await appendAuditEvent(root, event);
  }
  return listIntakeConnectors(root);
}

/**
 * Delete an intake feed connector (PANEL-11 lifecycle delete): PURGE its config row from the registry,
 * audit the removal (`panel` actor, `removed: true`), and let the scheduler tear its standing pull down
 * naturally (it re-reads the registry each tick — PANEL-6). Already-produced sources + the full audit
 * trail are RETAINED — only the config/registration is purged (ground truth is sacred, PANEL-11). An
 * unsafe id is a no-op (the registry guard rejects it anyway). Mirrors `removeResearcher`.
 */
export async function removeIntakeConnector(id: string, ctx: IntakeCtx): Promise<IntakeConnectorView[]> {
  const { root, lock } = ctx;
  if (!isSafeConnectorId(id)) return listIntakeConnectors(root);
  const removed = await runRegistryRemove(root, {
    lock,
    lockLabel: 'intake-config:remove',
    registryPath: intakeRegistryPath,
    commitMessage: `intake ${id} removed`,
    read: (r) => readIntakeRegistry(r),
    findId: id,
    remove: (r, removeId) => deleteIntakeConnector(r, removeId),
  });
  if (removed) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'intake-config-change', subjects: { intakeId: id }, payload: { removed: true, why: 'Principal removed an intake feed via Control Panel (config purged; sources + audit retained)' } });
  }
  return listIntakeConnectors(root);
}

/**
 * Manual "Run now" for an intake connector (INTAKE-14, "run-now to test") — a single on-demand pull
 * via the real run-pass + the real per-type fetch (RSS = the SSRF-safe gated fetch; M365 = env-gated,
 * surfaces a clear `intake-failed` until wired). Never ingests synthetic scaffolding. The Principal's
 * trigger is audited as a `panel` event; the pull's own work is audited by the run-pass (actor `intake`).
 */
export async function runIntakeConnectorNow(id: string, root: string): Promise<RunIntakeConnectorResult> {
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
