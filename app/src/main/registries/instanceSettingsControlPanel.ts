// Control Panel · Instance settings (SPEC-0027 PANEL-5). Extracted out of pipeline.ts (#528 ENG-7).
// NOT a list registry (there's one singleton `.kb/instance.json` doc, not rows to find/patch/upsert) —
// so this stays bespoke rather than using the registryCrud helper, matching the issue's own read of
// this section ("instance ... NOT a true registry").
import type { Mutex } from '../../kb/stageLock';
import type { DevLog } from '../../kb/devlog';
import {
  readInstanceConfig,
  writeInstanceConfig,
  instanceConfigPath,
  defaultInstanceConfig,
  clampRecallBudgetMs,
  resolveRecallMaxToolCallsWrite,
  resolveStageCaps,
  clampStageCap,
  resolveCeilingWrite,
  SCALE_STAGES,
  DEV_LOG_LEVELS,
  DEFAULT_DEV_LOG_LEVEL,
  DEFAULT_QUICK_CAPTURE_ACCELERATOR,
  DEFAULT_RECALL_BUDGET_MS,
  type DevLogLevel,
  type ScaleStage,
  type InstanceConfig,
} from '../../kb/instanceConfig';
import { isAutonomyPosture } from '../../kb/jobsPanel';
import { applyCopilotCeiling } from '../../kb/copilotConcurrency';
import { getQuickCaptureAgent } from '../quickCaptureService';
import { appendAuditEvent } from '../../kb/audit';
import { commitControlFile } from '../commitControlFile';
import type { InstanceSettings } from '../../kb/types';

export interface LiveStageCaps {
  archive: number;
  decompose: number;
  claims: number;
  compose: number;
  connect: number;
}

export interface InstanceSettingsCtx {
  root: string;
  lock: Mutex;
  log: DevLog;
  /** Live-apply the resolved per-stage caps (SCALE-4) — the caller owns the actual stage instances. */
  applyLiveCaps: (caps: LiveStageCaps) => void;
}

/** The per-Instance settings for the active KB (PANEL-5). No active KB → safe defaults. */
export async function getInstanceSettings(root: string | null): Promise<InstanceSettings> {
  if (!root) return defaultInstanceConfig();
  return readInstanceConfig(root);
}

/**
 * Persist the per-Instance settings (PANEL-5/6): write `.kb/instance.json` + git-commit on `staging`
 * under the lock (durability), then emit a conforming `panel` audit event when the autonomy default
 * changed (PANEL-7 / AUDIT-2/11 — `→ Autonomous` is a risky, audited change). An invalid posture is
 * refused (fail-safe). Takes effect immediately (new jobs inherit it via `resolveJobPosture`).
 */
export async function setInstanceSettings(settings: InstanceSettings, ctx: InstanceSettingsCtx): Promise<InstanceSettings> {
  const { root, lock, log } = ctx;
  if (!isAutonomyPosture(settings.autonomyDefault)) return readInstanceConfig(root); // reject invalid
  let prior: InstanceConfig = defaultInstanceConfig();
  let devLogLevel: DevLogLevel = DEFAULT_DEV_LOG_LEVEL;
  let quickCaptureAccelerator: string = DEFAULT_QUICK_CAPTURE_ACCELERATOR;
  let recallBudgetMs: number = DEFAULT_RECALL_BUDGET_MS;
  let recallMaxToolCalls: number | undefined;
  let stageCaps: Partial<Record<ScaleStage, number>> | undefined;
  let copilotCeiling: number | undefined;
  let priorCfg = defaultInstanceConfig();
  await lock.run(async () => {
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
  ctx.applyLiveCaps(liveCaps);
  const priorCeiling = priorCfg.copilotCeiling;
  const priorCaps = JSON.stringify(priorCfg.stageCaps ?? {});
  if (priorCeiling !== copilotCeiling || priorCaps !== JSON.stringify(stageCaps ?? {})) {
    log.info('scale.applied', { ceiling: effectiveCeiling, caps: liveCaps });
    await appendAuditEvent(root, {
      actor: 'panel',
      eventType: 'instance-config-change',
      subjects: {},
      payload: { field: 'scale', ceiling: copilotCeiling ?? 'default', caps: stageCaps ?? {}, why: 'Principal change via Control Panel' },
    });
  }
  return readInstanceConfig(root);
}
