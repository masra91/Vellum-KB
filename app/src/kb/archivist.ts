// The archivist's "decision" — the per-item cognition the orchestrator feeds one fresh
// session at a time (SPEC-0014 ORCH-5/7). In v1 it is a DETERMINISTIC stand-in: the thin
// agent is cognition-only and the orchestrator owns all effects (ORCH-7). Phase B swaps in
// a single-shot Copilot session implementing the same `ArchivistDecider` interface — the
// orchestrator code does not change.
import type { CapturedMeta } from './ingest';
import type { SpanCtx } from './tracing';
import { DEFAULT_SENSITIVITY, type SensitivityBy } from './sensitivity';

export interface ArchiveDecision {
  kind: 'text' | 'file';
  class: 'primary' | 'secondary';
  /** Conservative default `global`/`internal` (CAPTURE-10), but a producing surface may declare a
   *  higher-confidence classification (SCOPE-14 / INTAKE-9 connector defaults) which the decider
   *  honors — so the field is a string, not the bare default literal. */
  scope: string;
  sensitivity: string;
  /** How the sensitivity label was assigned (SENSE-8 provenance). A connector-declared default is a
   *  high-confidence `connector` signal (SENSE-5); the bare fallback is `default` (SENSE-2); `classifier`
   *  is the SENSE-4 agentic/heuristic classifier (Slice 2). */
  sensitivityBy: SensitivityBy;
  /** When the label was assigned (SENSE-7 §7 `sensitivityMeta.at`). Set for a Principal override so the
   *  override time survives a Replay re-archive; absent → the renderer uses `archivedAt`. */
  sensitivityAt?: string;
  /** The classifier's confidence (SPEC-0043 §7) — present only when `sensitivityBy === 'classifier'`. */
  sensitivityConfidence?: number;
  /** A sub-threshold label the classifier leaned toward (SENSE-4) — present only while a Review suggestion
   *  is open; routes the uncertain case to Review. Cleared by a Principal override. */
  sensitivitySuggested?: string;
  /** Provenance of the decision itself — see AgentTrace (ORCH-16). */
  agent?: AgentTrace;
}

/**
 * Record of how a decision was reached, for auditing non-deterministic steps (ORCH-16).
 * Captures *what we launched and what happened* — never tokens/cost.
 */
export interface AgentTrace {
  via: 'copilot' | 'deterministic'; // which decision was actually used
  runtime?: 'copilot'; // model runtime attempted, if any
  model?: string; // model we launched with ('default' when unpinned — see note in copilotAgent)
  params?: string[]; // launch flags (excludes the prompt body)
  ok?: boolean; // did the runtime call succeed + parse
  error?: string; // fallback / error reason
  ms?: number; // call duration
  at?: string; // ISO timestamp of the invocation
  repairs?: number; // SPEC-0049 HEAL-1: self-repair rounds taken before a parseable response (0 = first try)
  effort?: string; // #514: the tier that actually ran (e.g. recall's 'quick' | 'considered') — honest, not assumed
}

/** A decider maps a captured unit's metadata to an archival decision. */
export type ArchivistDecider = (meta: CapturedMeta, ctx?: SpanCtx) => ArchiveDecision | Promise<ArchiveDecision>;

/**
 * v1 deterministic decision. Conservative defaults (CAPTURE-10): everything captured by the
 * Principal is a `primary` source, `global`/`internal` — UNLESS the producing surface declared a
 * higher-confidence classification (SCOPE-14 / SPEC-0041 INTAKE-9: an intake connector's configured
 * scope/sensitivity), which is preferred so a `confidential` feed isn't silently down-classified.
 * Richer LLM classification + Review routing remain Enrich's job, deferred.
 */
export function deterministicDecide(meta: CapturedMeta): ArchiveDecision {
  // SENSE-2/5/8: a connector-declared sensitivity is a high-confidence `connector` signal; absent any
  // signal, the source lands at the conservative `internal` default with `by: default`. (The classifier —
  // `by: classifier` — is Slice 2.) A Principal override is re-applied upstream (SENSE-7), not here.
  return {
    kind: meta.kind,
    class: 'primary',
    scope: meta.scope ?? 'global',
    sensitivity: meta.sensitivity ?? DEFAULT_SENSITIVITY,
    sensitivityBy: meta.sensitivity ? 'connector' : 'default',
    agent: { via: 'deterministic' },
  };
}

/** The injectable decider the orchestrator feeds per item (Phase B swaps in a Copilot
 *  session implementing the same interface). */
export const deterministicDecider: ArchivistDecider = deterministicDecide;
