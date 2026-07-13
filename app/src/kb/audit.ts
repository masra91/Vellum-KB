// Canonical audit model + coverage registry (SPEC-0029 AUDIT-1/2/3/11).
//
// FORMALIZE, DON'T REWRITE (SPEC-0029 §2/§7): every stage/job/researcher already appends an
// append-only audit line, but the shapes differ — the archivist writes `{action:'archived',
// archivedAt, …}`, the stages write `{ts, stage, event, …}`, jobs write a journal entry with no
// `event`, recall writes `{event:'recall', …}`, and replay appends `{event:'replay-reset', …}`.
// This module owns the ONE canonical envelope (the type) and a NORMALIZING READER that maps each
// existing shape onto it. It does NOT touch the emitters (that would re-architect emission, which
// SPEC-0029 §7 puts out of scope and would collide with the hot stage/ORCH files).
//
// It also owns AUDIT_COVERAGE — the registry of what's audited (AUDIT-2). A feature is not "done"
// until it emits conforming audit (AUDIT-11); `audit.test.ts` turns that into a checked gate by
// scanning `src/kb` for emitters and asserting each is registered with the *why*.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Who acted. Stages, autonomous jobs, recall, replay, the archivist, and `panel` — the Control
 * Panel (SPEC-0027): Principal-initiated config changes (enable/disable a job, schedule, posture),
 * which are NOT a stage/job *run* and so don't fit `job`. New actors are added here; the coverage
 * gate (`audit.test.ts`) and the writer (`appendAuditEvent`) both key off this union.
 */
export const AUDIT_ACTORS = [
  'archivist',
  'decompose',
  'claims',
  'connect',
  'compose',
  'job',
  'recall',
  'replay',
  'panel',
  'researcher',
  'intake',
  'watch',
  'output',
  'maintenance',
  'enrich',
] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

/** The subject ids an event is about (sparse — only the ids that apply to the event). */
export interface AuditSubjects {
  sourceId?: string;
  entityId?: string;
  claimId?: string;
  reviewId?: string;
  jobId?: string;
  /** Researcher id + the research-request it answered (SPEC-0028). */
  researcherId?: string;
  requestId?: string;
  /** Intake connector id — the proactive feed pull a pass belongs to (SPEC-0041). */
  intakeId?: string;
  /** Folder-watch id — the watched-folder ingestion a pass belongs to (SPEC-0037). */
  watchId?: string;
  /** Connect keys its work by canonical block key, not a single entity id. */
  blockKey?: string;
}

/**
 * The canonical audit envelope (AUDIT-1). Rigid, orchestrator-owned fields wrap the freeform
 * `payload` — exactly the shape the stages already use, now made uniform across actors. `runId`
 * and `model` are optional because some conforming lines legitimately omit them (a `replay-reset`
 * marker has no run; a deterministic archive has no model).
 */
export interface AuditEvent {
  /** ISO-8601 timestamp the action happened. */
  ts: string;
  /** The run/correlation id, when the emitter tracks one. */
  runId?: string;
  /** Who acted. */
  actor: AuditActor;
  /** Which ids the event is about. */
  subjects: AuditSubjects;
  /** The model an agent ran, when one did. */
  model?: string;
  /** A short, stable event kind (e.g. 'archived', 'claimed', 'connected', 'recall'). */
  eventType: string;
  /** The freeform remainder — every field not hoisted into the envelope above. */
  payload: Record<string, unknown>;
  /** Where the raw line lives, for drill-down to the unmodified event (AUDIT-5). */
  provenance: AuditProvenance;
}

/** Locates the raw line behind an event: the vault-relative file and its 0-based line index. */
export interface AuditProvenance {
  /** Vault-relative path of the audit file (e.g. `sources/2026/01/<id>/audit.jsonl`). */
  file: string;
  /** 0-based index of the line within the file. */
  line: number;
}

/** Hints derived from the file path, since some lines can't self-identify their actor/subject. */
export interface NormalizeContext extends AuditProvenance {
  /** Source id, when the file lives under `sources/<shard>/<id>/`. */
  sourceId?: string;
  /** Job id, when the file is a `.kb/jobs/<jobId>/journal.jsonl`. */
  jobId?: string;
}

/** The fields the envelope hoists out of a raw line; everything else becomes `payload`. */
const HOISTED = new Set([
  'ts',
  'stage',
  'runId',
  'event',
  'action',
  'archivedAt',
  'model',
  'sourceId',
  'entityId',
  'claimId',
  'reviewId',
  'jobId',
  'blockKey',
]);

const STAGE_ACTORS = new Set<AuditActor>(['decompose', 'claims', 'connect']);

/** Decide which actor a raw line belongs to, using the line shape first, then the file path. */
function actorOf(raw: Record<string, unknown>, ctx: NormalizeContext): AuditActor | null {
  const event = typeof raw.event === 'string' ? raw.event : undefined;
  if (event === 'replay-reset') return 'replay';
  if (event === 'recall' || ctx.file.includes(`${path.sep}ask${path.sep}`) || ctx.file.includes('/ask/')) {
    return 'recall';
  }
  const stage = typeof raw.stage === 'string' ? raw.stage : undefined;
  if (stage && STAGE_ACTORS.has(stage as AuditActor)) return stage as AuditActor;
  if (raw.action === 'archived') return 'archivist';
  // A journal entry has no `stage`/`event`/`action`; the path is the only signal.
  if (ctx.jobId !== undefined || ctx.file.endsWith('journal.jsonl')) return 'job';
  return null; // unknown shape — the walker skips it rather than guess
}

/** Pull the subject ids out of a raw line + path context. */
function subjectsOf(raw: Record<string, unknown>, ctx: NormalizeContext, actor: AuditActor): AuditSubjects {
  const s: AuditSubjects = {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

  // The archivist line carries the source id as `id`; everyone else uses explicit subject fields.
  s.sourceId = str(raw.sourceId) ?? (actor === 'archivist' ? str(raw.id) : undefined) ?? ctx.sourceId;
  s.entityId = str(raw.entityId);
  s.claimId = str(raw.claimId);
  s.reviewId = str(raw.reviewId);
  s.jobId = str(raw.jobId) ?? ctx.jobId;
  s.blockKey = str(raw.blockKey);

  // Connect's terminal `resolved` line names the canonical node by rel path — recover its entity id.
  if (!s.entityId && typeof raw.node === 'string' && raw.node.endsWith('.md')) {
    s.entityId = path.basename(raw.node, '.md');
  }
  // Drop empty keys so equality/serialization stays tight.
  for (const k of Object.keys(s) as (keyof AuditSubjects)[]) if (s[k] === undefined) delete s[k];
  return s;
}

/** Derive the event-type for a line; journal entries have no `event`, so synthesize 'job-run'. */
function eventTypeOf(raw: Record<string, unknown>, actor: AuditActor): string {
  if (typeof raw.event === 'string' && raw.event.length > 0) return raw.event;
  if (actor === 'archivist' && raw.action === 'archived') return 'archived';
  if (actor === 'job') return 'job-run';
  return 'unknown';
}

/** Build the freeform payload: the raw line minus every field hoisted into the envelope. */
function payloadOf(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!HOISTED.has(k)) out[k] = v;
  return out;
}

/** The model the line records, if any — explicit `model`, else an agent block's `model`. */
function modelOf(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.model === 'string') return raw.model;
  const agent = raw.agent;
  if (agent && typeof agent === 'object' && typeof (agent as { model?: unknown }).model === 'string') {
    return (agent as { model: string }).model;
  }
  return undefined;
}

/**
 * Map ONE raw audit line (already JSON-parsed) onto the canonical envelope (AUDIT-1). Returns null
 * for a line whose actor can't be determined — the reader treats that as a malformed/foreign line
 * and skips it rather than fabricate an event. `ctx` supplies the provenance and the path-derived
 * source/job hints that some lines (archivist, journal) need.
 */
export function normalizeAuditLine(raw: unknown, ctx: NormalizeContext): AuditEvent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  // Already-canonical line (written by `appendAuditEvent` — e.g. the Control Panel). Recognized by
  // a registered `actor` + an `eventType`; pass it through, attaching read-side provenance.
  if (typeof obj.actor === 'string' && (AUDIT_ACTORS as readonly string[]).includes(obj.actor) && typeof obj.eventType === 'string' && typeof obj.ts === 'string') {
    const subjects = obj.subjects && typeof obj.subjects === 'object' && !Array.isArray(obj.subjects) ? (obj.subjects as AuditSubjects) : {};
    const e: AuditEvent = {
      ts: obj.ts,
      actor: obj.actor as AuditActor,
      subjects,
      eventType: obj.eventType,
      payload: obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload) ? (obj.payload as Record<string, unknown>) : {},
      provenance: { file: ctx.file, line: ctx.line },
    };
    if (typeof obj.runId === 'string') e.runId = obj.runId;
    if (typeof obj.model === 'string') e.model = obj.model;
    return e;
  }

  const actor = actorOf(obj, ctx);
  if (actor === null) return null;

  const ts = typeof obj.ts === 'string' ? obj.ts : typeof obj.archivedAt === 'string' ? obj.archivedAt : undefined;
  if (ts === undefined) return null; // an event with no timestamp can't be placed on the timeline

  const event: AuditEvent = {
    ts,
    actor,
    subjects: subjectsOf(obj, ctx, actor),
    eventType: eventTypeOf(obj, actor),
    payload: payloadOf(obj),
    provenance: { file: ctx.file, line: ctx.line },
  };
  if (typeof obj.runId === 'string') event.runId = obj.runId;
  const model = modelOf(obj);
  if (model !== undefined) event.model = model;
  return event;
}

// ── Canonical writer (AUDIT-1/2) ───────────────────────────────────────────────────────────────
//
// The emit side of the canonical model, for NEW emitters that have no legacy line shape (the
// Control Panel today). It does NOT touch the existing stage/job emitters — re-architecting their
// emission is out of scope (§7). New emitters call this so their lines are born canonical (the
// reader's already-canonical fast-path picks them up) AND conformant: the writer refuses an actor
// that isn't registered in AUDIT_COVERAGE, so "emit conforming audit with the why" (AUDIT-2/11) is
// enforced at the point of emission, not just in review.

/** Cross-cutting working-zone audit log (gitignored under .kb, never promoted) for actors not tied
 *  to a single item — e.g. the Control Panel's Principal-initiated config changes. */
export const CONTROL_AUDIT_REL = path.join('.kb', 'audit.jsonl');

/** The fields a caller supplies to {@link appendAuditEvent} — the envelope minus read-side provenance. */
export type AuditEventInput = Omit<AuditEvent, 'provenance' | 'ts'> & { ts?: string };

/**
 * Append a conforming canonical event to an append-only audit log (AUDIT-1). `relFile` is
 * vault-relative and defaults to the cross-cutting control log. Throws if `event.actor` is not a
 * registered actor (AUDIT-2/11) — a feature cannot emit unregistered/uncovered audit. `ts` defaults
 * to now; pass it for deterministic tests.
 */
export async function appendAuditEvent(root: string, event: AuditEventInput, relFile: string = CONTROL_AUDIT_REL): Promise<void> {
  if (coverageFor(event.actor) === undefined) {
    throw new Error(`appendAuditEvent: actor "${event.actor}" is not registered in AUDIT_COVERAGE — register it with the why (AUDIT-2/11)`);
  }
  const line: Record<string, unknown> = {
    ts: event.ts ?? new Date().toISOString(),
    actor: event.actor,
    subjects: event.subjects,
    eventType: event.eventType,
    payload: event.payload,
  };
  if (event.runId !== undefined) line.runId = event.runId;
  if (event.model !== undefined) line.model = event.model;
  const abs = path.join(path.resolve(root), relFile);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.appendFile(abs, JSON.stringify(line) + '\n', 'utf8');
}

// ── Coverage registry (AUDIT-2/11) ────────────────────────────────────────────────────────────
//
// The single source of truth for "what is audited, and does it carry the why." `audit.test.ts`
// asserts (a) every actor in the union is registered, (b) every src/kb module that appends to an
// audit/journal file maps to a registered actor — so a NEW feature that emits audit but forgets to
// register here fails the gate — and (c) every `mutating` actor carries the why (AUDIT-2). This IS
// the AUDIT-2/11 coverage gate.

export interface AuditCoverageEntry {
  /** The actor this entry covers. */
  actor: AuditActor;
  /** Human note on what it audits. */
  what: string;
  /** The `src/kb` modules that emit this actor's audit (filenames, no extension). */
  emitters: readonly string[];
  /** Where the lines land, relative to the vault (a glob-ish description, for humans + the gate). */
  auditPath: string;
  /** Does the action mutate the KB / act for the Principal? Mutating actors MUST carry the why. */
  mutating: boolean;
  /** Does the emitted event record the *why*, not just the *what* (AUDIT-2)? */
  carriesWhy: boolean;
  /** Requirement ids this coverage traces to. */
  traces: readonly string[];
}

export const AUDIT_COVERAGE: readonly AuditCoverageEntry[] = [
  {
    actor: 'archivist',
    what: 'Archives a captured source verbatim and records the archivist decision (ORCH-16). ingest.ts additionally records a `capture-refused` event (#516 BUG-3) when a foreign folder-drop is skipped during normalize — oversized (>2GiB) or otherwise unreadable — into the cross-cutting control log, so a refusal is never silent (OBS-4).',
    emitters: ['orchestrator', 'ingest'],
    auditPath: 'sources/<shard>/<id>/audit.jsonl (archived) · ' + CONTROL_AUDIT_REL + ' (capture-refused)',
    mutating: true,
    carriesWhy: true, // payload.decision records the routing rationale; capture-refused records the reason
    traces: ['AUDIT-1', 'AUDIT-2', 'ORCH-16', 'DATA-10', 'ORCH-14'],
  },
  {
    actor: 'decompose',
    what: 'Extracts candidate entities from a source; records signals + outcome (DECOMP-11).',
    emitters: ['decomposeStage'],
    auditPath: 'sources/<shard>/<id>/audit.jsonl',
    mutating: true,
    carriesWhy: true, // signal events carry the why; decomposed carries the count
    traces: ['AUDIT-1', 'AUDIT-2', 'DECOMP-11'],
  },
  {
    actor: 'claims',
    what: 'Derives claims for an entity and raises reviews; records the why per claim (CLAIMS-14). reviewStore appends the `review-answered` re-enqueue marker (stage:claims) when a human answers.',
    emitters: ['claimsStage', 'reviewStore'],
    auditPath: 'sources/<shard>/<id>/audit.jsonl',
    mutating: true,
    carriesWhy: true, // review-raised carries the question; review-answered carries the verdict
    traces: ['AUDIT-1', 'AUDIT-2', 'CLAIMS-14', 'REVIEW-6'],
  },
  {
    actor: 'connect',
    what: 'Resolves candidates into canonical entities + links them; records merges + signals. reviewStore appends the `review-answered` re-enqueue marker (stage:connect) when a human answers.',
    emitters: ['connectStage', 'reviewStore'],
    auditPath: 'connect/audit.jsonl',
    mutating: true,
    carriesWhy: true, // resolved carries merged/candidates; review-answered carries the verdict
    traces: ['AUDIT-1', 'AUDIT-2', 'CONNECT-10', 'CONNECT-11', 'REVIEW-6'],
  },
  {
    actor: 'compose',
    what: 'Composes an entity\'s encyclopedic prose from its cited claims (SPEC-0046); records the composed claims-signature (the why = which claims grounded it) + failed/setaside attempts.',
    emitters: ['composeStage'],
    auditPath: 'sources/<shard>/<id>/audit.jsonl',
    mutating: true,
    carriesWhy: true, // the `composed` marker records the claims signature it synthesized from
    traces: ['AUDIT-1', 'AUDIT-2', 'COMPOSE-7'],
  },
  {
    actor: 'job',
    what: 'Autonomous job run: what it inspected, applied, and deferred, with per-finding why (JOBS-7/8).',
    emitters: ['jobStage'],
    auditPath: '.kb/jobs/<jobId>/journal.jsonl',
    mutating: true,
    carriesWhy: true, // findings record the why each was applied/deferred
    traces: ['AUDIT-1', 'AUDIT-2', 'JOBS-7', 'JOBS-8'],
  },
  {
    actor: 'recall',
    what: 'A grounded recall: the question, retrieval, citations, and answer summary (ASK-11).',
    emitters: ['recall'],
    auditPath: '.kb/cache/ask/audit.jsonl',
    mutating: false, // read-only; recorded for transparency, not because it mutates
    carriesWhy: true, // records the question + grounding behind the answer
    traces: ['AUDIT-1', 'AUDIT-2', 'ASK-11'],
  },
  {
    actor: 'replay',
    what: 'A full/partial replay appends an epoch marker; never rewrites history (REPLAY-6). replayEpoch builds the marker line; replay appends it.',
    emitters: ['replay'],
    auditPath: '<any>/audit.jsonl (epoch marker)',
    mutating: true, // resets derived queues — a Principal-initiated action
    carriesWhy: true, // the replayId ties the reset to its replay run
    traces: ['AUDIT-1', 'AUDIT-3', 'REPLAY-6'],
  },
  {
    actor: 'panel',
    what: 'Control Panel (SPEC-0027 PANEL-7): Principal-initiated config changes (job enable/disable, schedule, posture) — emitted via appendAuditEvent into the cross-cutting control audit.',
    emitters: [], // emitted via the canonical writer by SPEC-0027 (no literal emitter file in src/kb)
    auditPath: CONTROL_AUDIT_REL,
    mutating: true,
    carriesWhy: true, // payload must record field/from/to + the why (Principal change)
    traces: ['AUDIT-1', 'AUDIT-2', 'PANEL-7'],
  },
  {
    actor: 'researcher',
    what: 'Researcher pass (SPEC-0028): what was researched + why, the request answered, external origin/citations, and the secondary source(s) produced (or a no-op); a `research-failed` event when the cognition errors (e.g. packaged-app cannot spawn the BYOA copilot — #160) so a failure is never a silent no-finding (OBS-4); a `ceiling-reached` no-op when the global per-Instance egress ceiling is hit; and an `escalated` event when a research→finding→request chain hits its depth limit and is routed to Review instead of run (RESEARCH-11) — emitted via appendAuditEvent into the cross-cutting control log (so it surfaces in the Activity feed).',
    emitters: ['researchRun', 'researchEscalate'], // researchRun emits per pass (researched / no-finding / research-failed / ceiling-reached); researchEscalate emits the depth-limit escalation
    auditPath: CONTROL_AUDIT_REL,
    mutating: true, // reaches outside the KB + produces immutable secondary sources
    carriesWhy: true, // records the request (what + why) + citations behind each finding
    traces: ['AUDIT-1', 'AUDIT-2', 'RESEARCH-6'],
  },
  {
    actor: 'intake',
    what: 'Proactive Intake pass (SPEC-0041): a scheduled feed pull (RSS / M365-mail) that brings new external items into the KB as immutable PRIMARY sources via the ingest spine — records what feed was inspected, which external items were pulled (their ids/links) and the source ids produced (`intook`), an audited `no-new-items` no-op, and a distinct `intake-failed` when the fetch/auth errors (failed ≠ empty, so a broken feed is never a silent no-op; OBS-4). Read-only w.r.t. the world (INTAKE-7) — no remote mutation. Emitted via appendAuditEvent into the cross-cutting control log.',
    emitters: ['intakeRun'],
    auditPath: CONTROL_AUDIT_REL,
    mutating: true, // brings external items in as immutable primary sources (promoted to main)
    carriesWhy: true, // records the connector, the items pulled (ids/links), and why (scheduled feed pull)
    traces: ['AUDIT-1', 'AUDIT-2', 'INTAKE-10', 'INTAKE-12'],
  },
  {
    actor: 'watch',
    what: 'Folder-Watch Ingestion pass (SPEC-0037): a watched local folder whose stable files are COPIED (non-destructive, WATCH-4) into the KB as immutable PRIMARY sources via the ingest spine (`surface=watch:<folder-id>`) — records the folder inspected and the files ingested with their source ids (`watch-ingested`, carrying the prior-source link when a changed file supersedes a prior version), an audited `watch-no-new` no-op when contentHash dedup finds nothing changed, a distinct `watch-failed` on a read error (failed ≠ empty; OBS-4), and a `watch-refused` when the loop-guard rejects the folder (the vault/.kb/.git or an ancestor — never a silent skip; WATCH-10). Read-only w.r.t. the watched source (the original file is never moved/deleted in v1). Emitted via appendAuditEvent into the cross-cutting control log.',
    emitters: ['watchRun'],
    auditPath: CONTROL_AUDIT_REL,
    mutating: true, // copies external files in as immutable primary sources (promoted to main)
    carriesWhy: true, // records the folder, files ingested (+ prior-source link), and why (folder-watch arrival)
    traces: ['AUDIT-1', 'AUDIT-2', 'WATCH-3', 'WATCH-4', 'WATCH-10'],
  },
  {
    actor: 'output',
    what: 'Recall save-as-Output (SPEC-0026 ASK-6): the Principal saved a grounded recall answer as a KB Output — records the question, whether it was grounded, and the cited evidence behind it — emitted via appendAuditEvent into the cross-cutting control log (so it surfaces in the Activity feed).',
    emitters: [], // emitted via the canonical writer by SPEC-0026 slice 3 (no literal emitter file in src/kb)
    auditPath: CONTROL_AUDIT_REL,
    mutating: true, // writes an Output note to outputs/ (promoted to main)
    carriesWhy: true, // payload records the question + citations + "Principal saved a recall answer"
    traces: ['AUDIT-1', 'AUDIT-2', 'ASK-6'],
  },
  {
    actor: 'maintenance',
    what: 'ORCH-27 stale canonical `index.lock` self-heal: records every lock CLEAR with the why — which lock, why it was declared stale (dead pid / leaked-by-self / over-age / external+old), and the sidecar pid/op. Only emitted when a lock is actually cleared (a kept/live lock is dev-log-surfaced, not audited as a mutation). Emitted via appendAuditEvent into the cross-cutting control log so a self-heal surfaces in Activity, never an invisible repository mutation.',
    emitters: ['canonicalLockHeal'],
    auditPath: CONTROL_AUDIT_REL,
    mutating: true, // removes a stale .git/index.lock — a repository-state repair
    carriesWhy: true, // payload records why-stale (the gate that fired) + the lock path + pid/op/age
    traces: ['AUDIT-1', 'AUDIT-2', 'AUDIT-11', 'ORCH-27'],
  },
  {
    actor: 'enrich',
    what: 'SPEC-0028 enrichment trigger (WS-B): records each `research-request` auto-emitted for a SPARSE ("little reference") entity — the entity (subject id), the term researched (what), and the why (corroborated by only N source(s)). The producer that makes the research pipeline non-inert; the dispatcher reads these back via collectResearchRequests. Non-mutating (emits a request signal, writes no KB content) — emitted via appendAuditEvent into the cross-cutting control log so an auto-request surfaces in Activity.',
    emitters: ['enrichTrigger'],
    auditPath: CONTROL_AUDIT_REL,
    mutating: false, // emits a research-request signal only; produces no KB content of its own
    carriesWhy: true, // payload records why the entity is sparse (the source count) behind each request
    traces: ['AUDIT-1', 'AUDIT-2', 'RESEARCH-3'],
  },
] as const;

/** Look up the coverage entry for an actor (undefined if somehow unregistered — the gate catches it). */
export function coverageFor(actor: AuditActor): AuditCoverageEntry | undefined {
  return AUDIT_COVERAGE.find((c) => c.actor === actor);
}
