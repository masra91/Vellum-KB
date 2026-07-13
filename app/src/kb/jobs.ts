// Autonomous Jobs — shared types, journal, and disposition rules (SPEC-0023 JOBS).
//
// A "job" is a recurring, agent-driven pass the scheduler wakes on a cadence to do bounded,
// KB-wide work (Reflect is the first; SPEC-0024). This module holds the contract the engine
// (`jobRegistry` / `jobScheduler` / `jobStage`) and any job *behavior* share — it owns no I/O
// beyond the per-job journal. Behavior of a specific job lives in its own module + spec.
import type { WorkDepthConfig } from './workDepth';
import type { AgentTrace } from './archivist';

/** Named schedule presets (JOBS-2). Raw cron / event-driven are later extensions the registry
 *  must not preclude — `schedule` is an open string at the storage layer, validated to a preset. */
export const SCHEDULE_PRESETS = ['off', 'daily', 'hourly', 'several-daily'] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

/** Approximate cadence of each preset, in milliseconds (the scheduler's "is it due?" interval).
 *  `off` never fires. Deliberately coarse — finer/cron cadence is a later escape hatch (JOBS-2). */
export const PRESET_INTERVAL_MS: Record<Exclude<SchedulePreset, 'off'>, number> = {
  'several-daily': 6 * 60 * 60 * 1000, // ~4×/day
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
};

/** Per-job autonomy posture (JOBS-15) with a safe default. Guarded: additive auto, destructive /
 *  low-confidence → Review. Autonomous: the agent's proposed disposition governs. */
export const AUTONOMY_POSTURES = ['guarded', 'autonomous'] as const;
export type AutonomyPosture = (typeof AUTONOMY_POSTURES)[number];
export const DEFAULT_POSTURE: AutonomyPosture = 'guarded';

/** Which way a job faces (JOBS-16) — the ONLY thing that distinguishes a researcher from a cron.
 *  `internal` = inward (operates on the KB itself: Reflect, reconcile, maintenance) — JOBS-10's
 *  no-external-egress holds. `external` = a researcher (SPEC-0028) reaching outside the KB under an
 *  egress tier + scope/sensitivity gates (SPEC-0043) — JOBS-10 relaxes to read-only egress within
 *  the granted tier (still no side-effecting writes to the world). Both facings share the SAME
 *  registry / scheduler / single-flight / journal / autonomy / audit / config surface; `facing` is
 *  the only difference (it gates egress). Safe default `internal` (no egress). */
export const FACINGS = ['internal', 'external'] as const;
export type Facing = (typeof FACINGS)[number];
export const DEFAULT_FACING: Facing = 'internal';

/** One registered job (JOBS-1/16). `type` selects the behavior; `facing` gates egress (JOBS-16);
 *  `workDepth` is the per-item effort knob (JOBS-17, resolved via {@link WorkDepthSpec}); `config` is
 *  behavior-specific. A researcher is just an `external` job on this same shape. */
export interface JobConfig {
  id: string;
  type: string;
  schedule: SchedulePreset;
  enabled: boolean;
  posture: AutonomyPosture;
  /** JOBS-16: internal (no egress) | external (researcher — egress within tier). Default internal. */
  facing: Facing;
  /** JOBS-17: the Principal-configurable per-item work-depth (level + optional explicit overrides).
   *  Absent = the work-kind's safe default. Resolved against the kind's `WorkDepthSpec` at run time. */
  workDepth?: WorkDepthConfig;
  config?: Record<string, unknown>;
}

/**
 * A job `id` MUST be a bare slug — a letter/digit then letters/digits/hyphens — because it is
 * consumed DIRECTLY into filesystem paths: the per-job journal `journalRel(id)` (`.kb/jobs/<id>/…`),
 * the disposable worktree (`.kb/cache/worktrees/job-<id>`), and the work branch (`kb/job-<id>-work`).
 * An `id` containing path separators or `..` (`../x`, `../../../tmp/x`) would escape `.kb/jobs` and
 * turn a hand-/foreign-edited `registry.json` into an arbitrary-write vector — same class as JOBS-10's
 * write-sink, different vector. Validate at EVERY boundary an id enters (registry read + write + the
 * run sink) so no single bypass reaches a path (SPEC-0023 JOBS-10 / #29).
 */
export function isSafeJobId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(v);
}

/** Disposition of a single finding (JOBS-9): auto-apply on `staging`, or route to the Review queue. */
export type Disposition = 'auto' | 'review';

/**
 * One actionable thing a bounded pass found. The behavior proposes a `disposition` + `kind`; the
 * runner ENFORCES posture (guarded downgrades destructive / low-confidence to `review`). `writes`
 * are additive file effects applied on `staging` when auto; `review` raises an SPEC-0018 Review.
 */
export interface JobFinding {
  summary: string; // human/audit one-liner of what + why (AUTO-8)
  kind: 'additive' | 'destructive';
  confidence: number; // 0..1
  proposed: Disposition; // the behavior's proposed disposition (honored under `autonomous`)
  writes?: { rel: string; content: string }[]; // additive effects (relative to the worktree root)
  // raised when the finding routes to Review. A `consolidation` target carries the merge plan an
  // approved Review executes (SPEC-0024 REFLECT-7) — propagated into the Review's markerKey so the
  // dispatch can run it via the entity-merge core; absent for non-consolidation reviews. A
  // `contradiction` target (SPEC-0036 CONTRA) carries the entity + two conflicting statements so the
  // runner flags the entity durably and answerReview can transition the flag; absent otherwise.
  review?: {
    question: string;
    detail?: string;
    consolidation?: { canonicalRel: string; loserRels: string[] };
    contradiction?: { entityRel: string; statementA: string; statementB: string };
  };
}

/** What a bounded pass returns (JOBS-4/8): what it looked at, what it found, and a cursor for the
 *  next run's continuity (JOBS-7). A pass that finds nothing returns an empty `findings` — a normal
 *  outcome. MUST NOT take external side-effecting action (JOBS-10) — behaviors are pure cognition. */
export interface JobPassResult {
  inspected: string; // what the pass looked at this run (bounded; for audit + journal)
  findings: JobFinding[];
  cursor?: Record<string, unknown>; // opaque continuity state persisted to the journal
  /** ORCH-16 provenance for an agent-backed behavior's pass (model/timing/repairs) — absent for a
   *  deterministic behavior. Persisted onto the JournalEntry by the runner (jobStage.ts). */
  agent?: AgentTrace;
}

/** The context a bounded pass reads (JOBS-4/7): the synced worktree root + prior journal entries. */
export interface JobPassContext {
  root: string; // the job's worktree, synced to the canonical checkpoint
  posture: AutonomyPosture;
  config?: Record<string, unknown>;
  journal: JournalEntry[]; // prior run-state, newest last (continuity / awareness)
}

/** A job behavior: one bounded, read-only-w.r.t.-the-world pass. Pluggable by `JobConfig.type`. */
export type JobBehavior = (ctx: JobPassContext) => Promise<JobPassResult>;

/** A per-finding audit record (JOBS-8) carried in the journal line — the *what + why*. */
export interface AuditedFinding {
  summary: string;
  kind: 'additive' | 'destructive';
  confidence: number;
  disposition: Disposition; // the disposition the runner actually applied (post-posture)
  reviewId?: string; // set when routed to Review
  rejection?: string; // set when an auto write was rejected by the sink guard → forced to Review (JOBS-10)
}

/** A persisted run-state journal line (JOBS-7) — operational memory, NOT KB content. One line per
 *  run; doubles as the JOBS-8 rich audit event (it records what was inspected, applied, deferred,
 *  and per-finding reasoning). Read by the next run for continuity/awareness. */
export interface JournalEntry {
  ts: string; // ISO timestamp (run completion)
  runId: string;
  inspected: string;
  applied: number; // findings auto-applied this run
  deferred: number; // findings routed to Review this run
  findings?: AuditedFinding[]; // per-finding audit detail (JOBS-8)
  cursor?: Record<string, unknown>; // continuity state for the next run
  note?: string; // e.g. 'collision-exhausted' set-aside
  /** ORCH-16 provenance carried over from the pass result (model/timing/repairs) — absent for a
   *  deterministic behavior or a pass that skipped/failed before the agent ran. */
  agent?: AgentTrace;
}

/**
 * Coerce a journal line parsed off disk into a well-formed {@link JournalEntry} (JOBS-8). The journal
 * is read with an unchecked `JSON.parse(...)`, so a **legacy or partial** line (written before the
 * JOBS-8 run-summary fields existed, or hand-edited) may be missing `inspected`/`applied`/`deferred`
 * — which surfaced as a literal **"undefined"** in the Jobs run detail. Normalizing here means every
 * consumer (the run-detail view AND the next run's continuity read) sees real values: a missing/wrong-
 * typed count becomes `0`, a missing `inspected` becomes `''` (the render shows a neutral dash). The
 * write path already populates these; this protects the READ against any non-conforming entry.
 */
export function normalizeJournalEntry(raw: unknown): JournalEntry {
  const e = (raw && typeof raw === 'object' ? raw : {}) as Partial<JournalEntry> & Record<string, unknown>;
  return {
    ts: typeof e.ts === 'string' ? e.ts : '',
    runId: typeof e.runId === 'string' ? e.runId : '',
    inspected: typeof e.inspected === 'string' ? e.inspected : '',
    applied: typeof e.applied === 'number' && Number.isFinite(e.applied) ? e.applied : 0,
    deferred: typeof e.deferred === 'number' && Number.isFinite(e.deferred) ? e.deferred : 0,
    ...(Array.isArray(e.findings) ? { findings: e.findings as AuditedFinding[] } : {}),
    ...(e.cursor && typeof e.cursor === 'object' ? { cursor: e.cursor as Record<string, unknown> } : {}),
    ...(typeof e.note === 'string' ? { note: e.note } : {}),
    ...(e.agent && typeof e.agent === 'object' ? { agent: e.agent as AgentTrace } : {}),
  };
}

/**
 * Enforce posture on a finding's disposition (JOBS-9/15). Guarded: only additive + high-confidence
 * auto-applies; everything else (destructive, or low-confidence) → Review, never guessed. Autonomous:
 * the behavior's proposed disposition governs. The single source of truth for "auto vs Review".
 */
export const HIGH_CONFIDENCE = 0.8;
export function effectiveDisposition(finding: JobFinding, posture: AutonomyPosture): Disposition {
  if (posture === 'autonomous') return finding.proposed;
  // Guarded (the safe default): additive + high-confidence may auto-apply; else route to Review.
  return finding.kind === 'additive' && finding.confidence >= HIGH_CONFIDENCE ? 'auto' : 'review';
}
