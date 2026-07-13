// The Copilot-backed archivist (SPEC-0014 ORCH-8). Each item gets a fresh, disposable
// single-shot `copilot -p` session (ORCH-5) reusing the user's existing Copilot
// credentials — no auth in our flow. The session is THIN (ORCH-7): it returns a JSON
// decision and the orchestrator does all effects. Any failure (no CLI, timeout, bad
// output) falls back to the deterministic decision so archival never stalls.
//
// v1 is harness-focused: the decision stays conservative (confirm kind + defaults,
// CAPTURE-10) — the point is to PROVE the disposable-session + parse + fallback pattern
// that Enrich's richer agents will reuse. The subprocess is injectable so CI stays
// deterministic and never needs real credentials.
import { extractBalancedJson } from './jsonExtract';
import type { CapturedMeta } from './ingest';
import { type ArchiveDecision, type ArchivistDecider, deterministicDecide } from './archivist';
import { detectCopilot } from './copilot';
import {
  makeDefaultCopilotRunner,
  runDeciderScaffold,
  makeAvailabilityGate,
  launchFlags,
  type CopilotRunner,
  type DeciderFailureInfo,
} from './deciderScaffold';

const COPILOT_TIMEOUT_MS = 60_000;

export type { CopilotRunner };

/** The versioned per-stage instruction template (SPEC-0014 Q9), composed per item. */
export function buildPrompt(meta: CapturedMeta): string {
  return [
    'You are the Vellum archivist. Classify ONE captured item for preservation.',
    'It is a primary source from the Principal. Use conservative defaults unless an',
    'explicit, high-confidence signal says otherwise. v1 supports only scope "global"',
    'and sensitivity "internal".',
    '',
    `kind: ${meta.kind}`,
    meta.originalName ? `originalName: ${meta.originalName}` : '',
    meta.mimeType ? `mimeType: ${meta.mimeType}` : '',
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"kind":"text|file","class":"primary","scope":"global","sensitivity":"internal"}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Parse + validate the session output into a v1 ArchiveDecision (throws on anything off). */
export function parseDecision(stdout: string, meta: CapturedMeta): ArchiveDecision {
  const json = extractBalancedJson(stdout); // HEAL-2: tolerate fences/leading/trailing prose
  if (json === null) throw new Error('copilot: no JSON object in output');
  const obj = JSON.parse(json) as Record<string, unknown>;
  const kind = obj.kind === 'text' || obj.kind === 'file' ? obj.kind : meta.kind;
  if (obj.class !== 'primary' && obj.class !== 'secondary') throw new Error('copilot: invalid class');
  if (obj.scope !== 'global') throw new Error('copilot: invalid scope');
  if (obj.sensitivity !== 'internal') throw new Error('copilot: invalid sensitivity');
  // v1 copilot stub asserts the conservative defaults; it does not classify sensitivity (that's SENSE
  // Slice 2's classifier → `by: classifier`). So this path lands at the default with `by: default`.
  return { kind, class: obj.class, scope: 'global', sensitivity: 'internal', sensitivityBy: 'default' };
}

export interface CopilotDeciderOptions {
  /** Force availability (skips detection). Tests set this; production detects lazily. */
  available?: boolean;
  /** Injected runner (tests). Defaults to shelling out to `copilot -p`. */
  run?: CopilotRunner;
  /** Working directory for the Copilot subprocess (the staging worktree, threaded from the
   *  pipeline). Set as the execFile `cwd` so Copilot's workspace scan stays scoped here, not the
   *  filesystem root — `--add-dir` only widens permissions, it does NOT move the cwd. */
  vaultPath?: string;
}

/**
 * Build the production archivist decider: a fresh Copilot session per item, falling back
 * to the deterministic decision whenever Copilot is unavailable or misbehaves. Never
 * throws — always yields a decision so the orchestrator proceeds. This is the one decider
 * that WRAPS the shared scaffold in its own try/catch (rather than letting a failure
 * propagate) — the archivist is the only decider with a non-agent floor (ORCH-8).
 */
export function makeCopilotDecider(opts: CopilotDeciderOptions = {}): ArchivistDecider {
  const run = opts.run ?? makeDefaultCopilotRunner({ stage: 'archive', timeoutMs: COPILOT_TIMEOUT_MS, maxBufferBytes: 4 * 1024 * 1024 });
  const cwd = opts.vaultPath; // staging worktree → Copilot subprocess cwd (COPILOT-CONTEXT-SCOPE-BUG)
  const isAvailable = makeAvailabilityGate(opts.available, detectCopilot);
  return async (meta, ctx) => {
    if (!(await isAvailable())) {
      return { ...deterministicDecide(meta), agent: { via: 'deterministic', error: 'copilot unavailable' } };
    }
    // `onFailure` hands back the same model/params/timing/repair bookkeeping the success path would
    // have stamped, so the deterministic-fallback trace below is just as informative as before —
    // without the archivist reimplementing that bookkeeping itself.
    let failure: DeciderFailureInfo | undefined;
    try {
      const { value: decision, agent } = await runDeciderScaffold({
        agentKey: 'archivist',
        buildPrompt: () => buildPrompt(meta),
        parse: (stdout) => parseDecision(stdout, meta),
        run,
        cwd,
        ctx,
        onFailure: (info) => {
          failure = info;
        },
      });
      return { ...decision, agent };
    } catch (err) {
      // ORCH-8 resilience: fall back, but record the failure for posterity.
      const error = err instanceof Error ? err.message : String(err);
      return {
        ...deterministicDecide(meta),
        agent: {
          via: 'deterministic',
          runtime: 'copilot',
          model: failure?.model ?? '',
          params: failure?.params ?? launchFlags(),
          ok: false,
          error,
          ms: failure?.ms ?? 0,
          at: failure?.at ?? new Date().toISOString(),
          ...(failure && failure.repairs > 0 ? { repairs: failure.repairs } : {}),
        },
      };
    }
  };
}
