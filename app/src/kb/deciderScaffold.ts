// Shared decider launch scaffold (#528 ENG-8 — deep review 2026-07-12). Every thin Copilot decider
// (archivist, decompose, claims, compose, connect, reflect) reused the SAME ~120-line shape: an
// injectable single-shot `copilot -p` runner behind one process-wide concurrency slot, launched with
// self-repair (HEAL-1) wrapped in per-agent model-fallback (ORCH-16), timing + a per-invocation
// AgentTrace. Six independently-maintained copies drifted: compose never passed an `agentKey` (so its
// Settings model pin and the Agents-view catalog entry were both dead — #528 bug 1), and reflect never
// built an AgentTrace at all (no provenance on its findings — #528 bug 2). Factoring the shape out fixes
// both as a side effect of collapsing the duplication, not as a separate patch.
//
// Deliberately NOT shared: prompt-building, parsing/validation, and whether a failure THROWS (decompose/
// claims/compose/connect/reflect) or is CAUGHT to substitute a deterministic fallback (archivist, the one
// decider with a non-agent floor) — those stay in each decider file, which wraps this scaffold with its
// own try/catch when it wants the fallback behavior.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withCopilotSlot } from './copilotConcurrency';
import { resolveCopilotModel } from './copilotModel';
import { runWithModelFallback } from './copilotLaunch';
import { runWithSelfRepair, appendRepairInstruction } from './selfRepair';
import { COPILOT_OP, type SpanCtx } from './tracing';
import type { AgentTrace } from './archivist';

/** Injectable runner: given the composed prompt (+ optional working directory + model override),
 *  return the session's stdout. `cwd` scopes the Copilot subprocess to the staging worktree; `model`
 *  (when given) is the exact `--model` id to launch with — the model-fallback wrapper passes `auto`
 *  here on a retry. Shared shape every decider's `CopilotRunner` type already matched structurally. */
export type CopilotRunner = (prompt: string, cwd?: string, model?: string) => Promise<string>;

/** Launch flags (excludes `-p <prompt>`); recorded verbatim in the AgentTrace. The model is pinned
 *  in-app (ORCH-16) so prod never silently inherits `~/.copilot/settings.json`. `model` lets the
 *  fallback wrapper launch with `auto` when the pinned id is rejected (recorded as the real model). */
export function launchFlags(model: string = resolveCopilotModel()): string[] {
  return ['--no-ask-user', '--model', model];
}

const exec = promisify(execFile);

export interface DefaultCopilotRunnerOptions {
  /** SPEC-0048 SCALE-3: the pipeline stage tag for the concurrency semaphore's no-starvation
   *  reservation (`copilotConcurrency.ts`'s `AcquireOptions.stage`) — e.g. 'archive'/'decompose'/
   *  'claims'/'compose'/'connect'. Omit for an UNTAGGED background acquisition (reflect's existing,
   *  deliberate behavior — job-runner passes share the leftover pool, no reserved slot). */
  stage?: string;
  /** Copilot subprocess timeout (ms). Archivist's quick classification uses 60s; every content-
   *  reading/writing decider (decompose/claims/compose/connect/reflect) uses 120s. */
  timeoutMs?: number;
  /** Max stdout buffer. Archivist (a short JSON verdict) uses 4MB; the rest use 8MB. */
  maxBufferBytes?: number;
}

/** Build the production `CopilotRunner`: one process-wide concurrency slot (SCALE-3), the staging
 *  worktree as the subprocess `cwd` (COPILOT-CONTEXT-SCOPE-BUG — an unrooted cwd runaway-scans `/` in
 *  a packaged app), and the subprocess stderr folded into a thrown error's message (OBS-4). */
export function makeDefaultCopilotRunner(opts: DefaultCopilotRunnerOptions = {}): CopilotRunner {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBuffer = opts.maxBufferBytes ?? 8 * 1024 * 1024;
  const acquireOpts = opts.stage !== undefined ? { stage: opts.stage } : {};
  return async (prompt, cwd, model) =>
    withCopilotSlot(async () => {
      try {
        const { stdout } = await exec('copilot', ['-p', prompt, ...launchFlags(model)], { timeout: timeoutMs, maxBuffer, cwd });
        return stdout;
      } catch (err) {
        const stderr = (err as { stderr?: unknown }).stderr;
        if (err instanceof Error && stderr) err.message += `\n[copilot stderr] ${String(stderr).slice(0, 2000)}`;
        throw err;
      }
    }, acquireOpts);
}

export interface DeciderScaffoldOptions<TResult> {
  /** SPEC-0048 per-agent model pin key AND the resolveCopilotModel/runWithModelFallback selector
   *  (e.g. 'archivist'/'decompose'/'claims'/'compose'/'connect'/'reflect'). This is the field #528
   *  bug 1 found missing on Compose — every decider adopting this scaffold gets it by construction. */
  agentKey: string;
  /** Build the FULL base prompt for this input. Called once; `runWithSelfRepair` appends a repair
   *  instruction to it on a retry round, never re-derives it. */
  buildPrompt: () => string;
  /** Parse + validate one session's stdout into the decider's result shape. Throws on a bad shape —
   *  `runWithSelfRepair` re-prompts (bounded) before the error propagates to the caller. */
  parse: (stdout: string) => TResult;
  /** The injected (or production) runner — typically `makeDefaultCopilotRunner(...)` in prod, a fake in tests. */
  run: CopilotRunner;
  /** Working directory for the Copilot subprocess (the staging worktree). */
  cwd?: string;
  /** The stage's tracing span, for the OBS-13 Copilot-call child span. Optional — a decider with no
   *  span support (reflect, historically) simply omits it and gets no child span, not an error. */
  ctx?: SpanCtx;
  /** Called with the same model/params/timing/repair bookkeeping the success path would have stamped,
   *  right before the (unrepaired) error is re-thrown. Lets a caller that wants a non-throwing floor
   *  (the archivist's deterministic fallback) build its OWN `AgentTrace` on failure without
   *  reimplementing this bookkeeping — the only decider that needs it. */
  onFailure?: (info: DeciderFailureInfo) => void;
}

/** One decider launch's outcome: the parsed result plus its ORCH-16 `AgentTrace`. */
export interface DeciderScaffoldResult<TResult> {
  value: TResult;
  agent: AgentTrace;
}

/** The bookkeeping `onFailure` receives — everything the success path would have folded into an
 *  `AgentTrace` except `via`/`ok`/`error` (those are caller-specific: the archivist's fallback trace
 *  uses `via: 'deterministic'`, decompose/claims/compose/connect/reflect never see this at all). */
export interface DeciderFailureInfo {
  model: string;
  params: string[];
  ms: number;
  at: string;
  repairs: number;
}

/**
 * Run ONE decider invocation: self-repair (HEAL-1, bounded re-prompt on a parse/validation failure)
 * wrapping per-agent model-fallback (ORCH-16, one retry with `--model auto` on a rejected pin), timed
 * as a child of the caller's span, and stamped into an `AgentTrace`. THROWS on any un-repaired failure
 * (a launch/timeout error, or a parse failure that exhausts the repair budget) — the caller decides
 * whether that propagates (decompose/claims/compose/connect/reflect all set the item aside / retry) or
 * is caught to substitute a deterministic fallback (archivist is the one decider with a non-agent floor;
 * it wraps this call in its own try/catch rather than getting special-cased in here).
 */
export async function runDeciderScaffold<TResult>(opts: DeciderScaffoldOptions<TResult>): Promise<DeciderScaffoldResult<TResult>> {
  // ORCH-16: `modelUsed` starts at the pin and is rewritten to `auto` if the pinned id is rejected and
  // we fall back — so the trace records the model that ACTUALLY ran (a silent pin-drift is visible).
  let modelUsed = resolveCopilotModel(undefined, opts.agentKey);
  const at = new Date().toISOString();
  const t0 = Date.now();
  // OBS-13: time this Copilot invocation as a child of the stage's run span (OBS-12 nesting), capturing
  // failures too. `ctx?.span` may be undefined (no tracing wired) — `cs` then stays undefined and every
  // `cs?.end(...)` below is a no-op, matching how each pre-scaffold decider already handled an absent ctx.
  const cs = opts.ctx?.span?.child(COPILOT_OP);
  const basePrompt = opts.buildPrompt();
  // Tracked via `onRepair` (not just the success-path return value) so a failure that exhausts the
  // repair budget still reports how many rounds it took, in `onFailure`.
  let repairs = 0;
  try {
    const { value } = await runWithSelfRepair(
      (repair) =>
        runWithModelFallback((m) => opts.run(repair ? appendRepairInstruction(basePrompt, repair) : basePrompt, opts.cwd, m), {
          agentKey: opts.agentKey,
          onFallback: (_from, to) => {
            modelUsed = to;
          },
        }),
      opts.parse,
      { onRepair: () => { repairs += 1; } },
    );
    cs?.end('ok');
    const agent: AgentTrace = { via: 'copilot', runtime: 'copilot', model: modelUsed, params: launchFlags(modelUsed), ok: true, ms: Date.now() - t0, at, ...(repairs > 0 ? { repairs } : {}) };
    return { value, agent };
  } catch (e) {
    cs?.end('error');
    opts.onFailure?.({ model: modelUsed, params: launchFlags(modelUsed), ms: Date.now() - t0, at, repairs });
    throw e;
  }
}

/**
 * A tiny lazy-memoized availability gate: `detectCopilot()` runs at most once (per decider instance,
 * not per call), and a failed detection is treated as unavailable (never throws). Every decider except
 * the archivist THROWS when unavailable; the archivist falls back to its deterministic decision instead
 * — that branch stays in each decider file, this only memoizes the detection itself.
 */
export function makeAvailabilityGate(initial: boolean | undefined, detect: () => Promise<{ available: boolean }>): () => Promise<boolean> {
  let available: boolean | null = initial ?? null;
  return async () => {
    if (available === null) {
      try {
        available = (await detect()).available;
      } catch {
        available = false;
      }
    }
    return available;
  };
}
