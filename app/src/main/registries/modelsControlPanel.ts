// Control Panel · Agents view + model picker (SPEC-0048). Extracted out of pipeline.ts (#528 ENG-7).
// NOT a list registry — `AGENT_CATALOG` is a static in-code catalog, not a persisted registry, and
// there's no per-row audit at all here (validated via a live CLI probe instead) — bespoke, matching the
// issue's own read of this section ("models ... NOT a true registry").
import type { Mutex } from '../../kb/stageLock';
import type { DevLog } from '../../kb/devlog';
import { readInstanceConfig, writeInstanceConfig, instanceConfigPath } from '../../kb/instanceConfig';
import { AGENT_CATALOG, buildAgentViews } from '../../kb/agentCatalog';
import { resolveCopilotModel, setResolvedLaunchModel, setAgentModelOverrides } from '../../kb/copilotModel';
import { initLaunchModel, probeAcceptedModels, validateModel } from '../../kb/copilotModelProbe';
import { commitControlFile } from '../commitControlFile';
import type { AgentView, ModelCatalogView, SetModelResult } from '../../kb/types';

export interface ModelsCtx {
  root: string;
  lock: Mutex;
  log: DevLog;
}

/** The librarian/stage agents for observe-only display (PANEL-3): the static catalog overlaid with
 *  the resolved model (env-requested or Copilot default) + live running/idle status (PANEL-9). */
export async function listAgents(ctx: { root: string; pipelineActive: boolean } | null): Promise<AgentView[]> {
  // SPEC-0048: per-agent resolution — each row shows the model THAT agent launches with (its own pin
  // → global → floor) + its configured pick (for the picker). `agentModels` read from the persisted
  // config so the view reflects the saved picks even before a restart re-applies the override cache.
  const configuredModels = ctx ? (await readInstanceConfig(ctx.root)).agentModels : undefined;
  return buildAgentViews(AGENT_CATALOG, {
    resolveModel: (agentKey) => resolveCopilotModel(undefined, agentKey),
    configuredModels,
    pipelineActive: ctx?.pipelineActive ?? false,
  });
}

/** SPEC-0048 — the model picker's data: the live CLI accepted catalog (probed), the currently-resolved
 *  launch model, the persisted global pick (if any), and whether that pick is stale (no longer accepted
 *  by this CLI version → the brass note). Best-effort: a probe miss leaves `accepted` null (the picker
 *  shows the resolved/configured value but can't offer a fresh list). */
export async function getModelCatalog(root: string | null): Promise<ModelCatalogView> {
  const accepted = await probeAcceptedModels();
  const resolved = resolveCopilotModel();
  const configured = root ? (await readInstanceConfig(root)).model : undefined;
  const staleConfigured = !!configured && accepted !== null && !accepted.includes(configured);
  return { accepted, resolved, configured, staleConfigured };
}

/** SPEC-0048 — persist the Principal's global model pick (Agents-view picker), validated against the
 *  live CLI catalog first so a stale/rejected id is REFUSED (never persisted into a hard-break). An
 *  empty/null id clears the override (→ the preference-list probe re-resolves). Applies live via
 *  `setResolvedLaunchModel` so new launches use it without a restart. */
export async function setModel(id: string | null, ctx: ModelsCtx): Promise<SetModelResult> {
  const { root, lock, log } = ctx;
  const trimmed = (id ?? '').trim();

  if (trimmed.length === 0) {
    // Clear the override → re-resolve from the preference list against the live catalog.
    let prefs: string[] | undefined;
    await lock.run(async () => {
      const prior = await readInstanceConfig(root);
      prefs = prior.modelPreferences;
      const { model: _drop, ...rest } = prior;
      void _drop;
      await writeInstanceConfig(root, rest);
      await commitControlFile(root, instanceConfigPath(root), 'instance model=cleared');
    }, 'instance-model:write');
    await initLaunchModel({ preferences: prefs, log: log.child({ scope: 'model' }) }).catch(() => {});
    return { ok: true, resolved: resolveCopilotModel() };
  }

  // Validate the pick against the live catalog: a rejected id is refused (resolution unchanged). An
  // `unknown` (un-probable CLI) is allowed — the per-call `auto` net still guards a real launch reject.
  const { result } = await validateModel(trimmed);
  if (result === 'rejected') return { ok: false, resolved: resolveCopilotModel(), reason: 'rejected' };

  await lock.run(async () => {
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
export async function setAgentModel(agentKey: string, id: string | null, ctx: ModelsCtx): Promise<SetModelResult> {
  const { root, lock } = ctx;
  const key = agentKey.trim();
  const trimmed = (id ?? '').trim();
  if (key.length === 0) return { ok: false, resolved: resolveCopilotModel() };

  // A non-empty pick must be catalog-accepted (rejected → refuse, leave the agent on its current model).
  if (trimmed.length > 0) {
    const { result } = await validateModel(trimmed);
    if (result === 'rejected') return { ok: false, resolved: resolveCopilotModel(undefined, agentKey), reason: 'rejected' };
  }

  let next: Record<string, string> = {};
  await lock.run(async () => {
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
