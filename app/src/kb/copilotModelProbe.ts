// Model-resilience probe (SPEC-0014 ORCH-28). A hard model pin is fragile: copilot validates
// `--model` PRE-FLIGHT and hard-rejects an unknown id, and model-id validity is COUPLED TO THE CLI
// VERSION (soak ran 0.0.373; a dev box runs 1.0.62 — the accepted set differs). So we never assume a
// pinned id is valid — we PROBE the live CLI's accepted set and resolve the first model from an
// ordered preference list that the CLI actually accepts, degrading gracefully (with a loud log) and
// falling to `auto` only as a last resort. Turns "model retired → dead pipeline" into "graceful
// degrade + visible signal".
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setResolvedLaunchModel, setStageDefaultModels, DEFAULT_COPILOT_MODEL } from './copilotModel';

const exec = promisify(execFile);

/** Minimal logger seam (a DevLog `.warn`/`.info` satisfies this) — kept structural to avoid a hard dep. */
export interface ModelProbeLog {
  info?: (event: string, fields?: Record<string, unknown>) => void;
  warn?: (event: string, fields?: Record<string, unknown>) => void;
}

/** Ordered launch-model preference (ORCH-28 item 1): newest-capable Opus first, then older Opus, then
 *  Sonnet, then — only if NONE of the above is accepted — `auto` (the CLI's own pick) as the last
 *  resort. NEVER lead with `auto`: that hands back the CLI default (possibly the weak/cheap model the
 *  pin escaped — the gpt-5.5 regression). Verified accepted on copilot-cli 1.0.62; the prod-target
 *  catalog is re-probed at runtime, so this is a preference, not an assumption. Override via Instance
 *  config (the catalog moves faster than our releases). */
export const DEFAULT_MODEL_PREFERENCES: readonly string[] = [
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-opus-4.5',
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
];

/** The last-resort fallback when no preferred id is accepted — let Copilot pick from its own catalog.
 *  Mirrors `copilotModel.COPILOT_MODEL_AUTO` (kept local to avoid a cycle; asserted equal in tests). */
export const LAST_RESORT_MODEL = 'auto';

// INGEST-PERF item 4 — per-stage model tiering. Right-size the DEFAULT model per stage by how much each
// must reason BEYOND the raw source (KB-Lead's cognitive-load table, validated against the live catalog):
// Archive normalizes/stores (~none) → cheapest; Decompose parses ONE self-contained source (no dedup/
// linking) → fast; Claims does bounded source-local extraction + subject attribution → mid (gated on the
// subject-attribution eval). Connect (dedup/entity-resolution/linking across the whole KB), Compose
// (grounded synthesis) and Research (multi-source) stay on the STRONG global default — no entry here, so
// they fall through to `resolvedLaunchModel`. Each list is ORDERED preference and ENDS with the strong
// Opus list, so an absent cheap-tier id degrades down to a known-good model (never `auto`/brick — the #340
// class) via the same `selectPreferredModel` path the global model uses. Keyed by AGENT_CATALOG key.
export const STAGE_MODEL_PREFERENCES: Readonly<Record<string, readonly string[]>> = {
  archivist: ['claude-haiku-4.5', 'claude-sonnet-4.6', 'claude-sonnet-4.5', ...DEFAULT_MODEL_PREFERENCES],
  decompose: ['claude-sonnet-4.6', 'claude-sonnet-4.5', ...DEFAULT_MODEL_PREFERENCES],
  claims: ['claude-sonnet-4.6', 'claude-sonnet-4.5', ...DEFAULT_MODEL_PREFERENCES],
};

/**
 * Resolve the per-stage DEFAULT model for each tiered stage from the live catalog (INGEST-PERF item 4).
 * Reuses `selectPreferredModel` per stage so each cheap-tier pick is validated against the SAME probed
 * `accepted` set as the global model and degrades down its list to a known-good id. Returns a map keyed by
 * AGENT_CATALOG key (only the tiered stages; strong stages are omitted ⇒ they keep the global default).
 * `prefs` is overridable for tests.
 */
export function resolveStageDefaultModels(
  accepted: readonly string[] | null,
  prefs: Readonly<Record<string, readonly string[]>> = STAGE_MODEL_PREFERENCES,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [stage, list] of Object.entries(prefs)) {
    out[stage] = selectPreferredModel(list, accepted).model;
  }
  return out;
}

/**
 * Parse the accepted-model catalog out of `copilot help config` stdout. The CLI documents the valid
 * `model` values as a bulleted list of quoted ids under the `model:` config key, e.g.
 *   `model`: AI model to use ...
 *     - "claude-opus-4.8"
 *     - "claude-sonnet-4.5"
 * We collect the quoted ids that follow the `model` key until the next config key / blank gap. Returns
 * the ids in document order (empty if the section is absent / the format shifted — caller treats empty
 * as "probe inconclusive" and falls back to per-candidate validation).
 */
export function parseAcceptedModels(helpConfigStdout: string): string[] {
  const lines = helpConfigStdout.split('\n');
  const start = lines.findIndex((l) => /^\s*`?model`?\s*:/.test(l) && /AI model/i.test(l));
  if (start < 0) return [];
  const ids: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*-\s*"([^"]+)"\s*$/);
    if (m) {
      ids.push(m[1]);
      continue;
    }
    // A bullet list item we couldn't parse but that is still indented continues the section; a
    // non-indented / next-`key`: line ends it. Stop at the first clear section break once we've started.
    if (ids.length > 0 && /^\s*`?\w[\w.]*`?\s*:/.test(line)) break;
    if (ids.length > 0 && line.trim() === '' && (lines[i + 1] ?? '').trim().startsWith('`')) break;
  }
  return ids;
}

/** Probe the live copilot CLI for the set of model ids it accepts. One cheap `copilot help config`
 *  spawn (no per-candidate launches). Returns null when the CLI is unavailable OR the catalog can't be
 *  parsed — the caller then either falls back to per-candidate `--model` validation or to the floor. */
export async function probeAcceptedModels(
  run: (args: string[]) => Promise<string> = defaultHelpConfigRunner,
): Promise<string[] | null> {
  try {
    const stdout = await run(['help', 'config']);
    const ids = parseAcceptedModels(stdout);
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

const defaultHelpConfigRunner = async (args: string[]): Promise<string> => {
  const { stdout } = await exec('copilot', args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
};

/** The outcome of resolving the launch model against the live catalog (ORCH-28 items 1–3). */
export interface ModelSelection {
  model: string; // the id to launch with
  degraded: boolean; // true when we did NOT get the top preference (a visible-signal trigger)
  reason: 'preferred' | 'degraded' | 'last-resort'; // preferred=top pick; degraded=lower pick; last-resort=auto
  /** When degraded/last-resort: the top preference we wanted but the CLI didn't accept (for the log). */
  wanted?: string;
}

/**
 * Select the launch model from an ordered preference list given the CLI's accepted set (ORCH-28).
 * - Top preference accepted → `preferred` (no degradation).
 * - A LOWER preference accepted (top absent) → `degraded` (visible signal: we ran below the top tier).
 * - NONE accepted → `last-resort` `auto`.
 * `accepted === null` (probe inconclusive) → trust the top preference (can't prove it invalid; the
 * per-call `auto` safety net (ORCH-28) still catches a genuine launch-time rejection).
 */
export function selectPreferredModel(
  preferences: readonly string[],
  accepted: readonly string[] | null,
): ModelSelection {
  const prefs = preferences.length > 0 ? preferences : DEFAULT_MODEL_PREFERENCES;
  const top = prefs[0];
  if (accepted === null) return { model: top, degraded: false, reason: 'preferred' };
  const acceptedSet = new Set(accepted);
  for (let i = 0; i < prefs.length; i++) {
    if (acceptedSet.has(prefs[i])) {
      return i === 0
        ? { model: prefs[i], degraded: false, reason: 'preferred' }
        : { model: prefs[i], degraded: true, reason: 'degraded', wanted: top };
    }
  }
  return { model: LAST_RESORT_MODEL, degraded: true, reason: 'last-resort', wanted: top };
}

/**
 * Resolve the launch model ONCE at startup (ORCH-28) and publish it via `setResolvedLaunchModel` so
 * every decider's `resolveCopilotModel()` picks it up. Probes the live CLI's accepted catalog, selects
 * the best available preference, and emits a VISIBLE signal when we ran below the top tier (no silent
 * downgrade). Best-effort + never throws — a probe failure leaves the floor (`DEFAULT_COPILOT_MODEL`)
 * in place rather than blocking startup. Returns the selection (for the caller's own logging/tests).
 *
 * `preferences` is the (config-overridable) ordered list; omit for the in-app default. `run`/`log` are
 * injectable for tests.
 */
export async function initLaunchModel(opts: {
  preferences?: readonly string[];
  /** SPEC-0048: a user-configured global model override (Agents-view picker → instance.json). When set
   *  AND accepted by the live CLI it wins over the preference list; an UNACCEPTED override is rejected
   *  (WARN) and we fall back to the preference-list resolution — never hard-break on a stale config. */
  override?: string;
  run?: (args: string[]) => Promise<string>;
  log?: ModelProbeLog;
} = {}): Promise<ModelSelection> {
  const preferences = opts.preferences && opts.preferences.length > 0 ? opts.preferences : DEFAULT_MODEL_PREFERENCES;
  const accepted = await probeAcceptedModels(opts.run ?? defaultHelpConfigRunner);

  // SPEC-0048 — honor a validated user override first. Validate against the live catalog so a stale
  // picked id (a model retired by a CLI upgrade — the #340 class) can't silently break the pipeline:
  // accepted (or unprovable when the probe is inconclusive) → use it; rejected → WARN + fall through.
  const override = opts.override && opts.override.trim().length > 0 ? opts.override.trim() : undefined;
  if (override) {
    if (accepted === null || accepted.includes(override)) {
      setResolvedLaunchModel(override);
      // INGEST-PERF item 4: an explicit user GLOBAL pick wins WHOLESALE — defer to it for every stage
      // (clear the per-stage cheap defaults) rather than silently overriding the Principal's choice.
      setStageDefaultModels({});
      opts.log?.info?.('model.resolved', { model: override, source: 'config-override', probed: accepted !== null });
      return { model: override, degraded: false, reason: 'preferred' };
    }
    opts.log?.warn?.('model.override-rejected', { wanted: override, reason: 'not-in-catalog', acceptedCount: accepted.length });
  }

  const selection = selectPreferredModel(preferences, accepted);
  setResolvedLaunchModel(selection.model);
  // INGEST-PERF item 4: no user global override → publish the right-sized per-stage defaults (cheap tier
  // for Archive/Decompose/Claims), resolved against the SAME probed catalog so each degrades gracefully.
  const stageDefaults = resolveStageDefaultModels(accepted);
  setStageDefaultModels(stageDefaults);
  opts.log?.info?.('model.stage-defaults', { stageDefaults, probed: accepted !== null });
  // ORCH-28 item 3 — visible degradation, never silent. A clean top-preference pick is info; running
  // below the top tier (or all the way to `auto`) is a WARN naming what we wanted vs what we got.
  if (selection.reason === 'preferred') {
    opts.log?.info?.('model.resolved', { model: selection.model, probed: accepted !== null });
  } else {
    opts.log?.warn?.('model.degraded', {
      model: selection.model,
      wanted: selection.wanted,
      reason: selection.reason,
      floor: DEFAULT_COPILOT_MODEL,
      acceptedCount: accepted?.length ?? null,
    });
  }
  return selection;
}

/** SPEC-0048 — the model-validation result the Agents-view picker needs before accepting a choice. */
export type ModelValidation = 'accepted' | 'rejected' | 'unknown';

/**
 * Validate a user-picked model id against the live CLI's accepted catalog (SPEC-0048). `accepted` = the
 * CLI lists it; `rejected` = the CLI lists models but NOT this one (would hard-reject pre-flight — the
 * #340 class, so the picker must refuse it); `unknown` = the catalog couldn't be probed (CLI absent /
 * format shift) → the caller decides (we allow-with-caveat, since the per-call `auto` net still guards).
 */
export async function validateModel(
  id: string,
  run: (args: string[]) => Promise<string> = defaultHelpConfigRunner,
): Promise<{ result: ModelValidation; accepted: string[] | null }> {
  const accepted = await probeAcceptedModels(run);
  if (accepted === null) return { result: 'unknown', accepted: null };
  return { result: accepted.includes(id.trim()) ? 'accepted' : 'rejected', accepted };
}
