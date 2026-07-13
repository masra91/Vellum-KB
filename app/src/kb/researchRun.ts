// One researcher run pass (SPEC-0028 RESEARCH-5/6/8/12) — substrate-agnostic orchestration behind
// the cognition seam. The actual external research (web fetch / SDK Session) is INJECTED as a
// `ResearchFn`, so this module is unit-testable without a network/SDK and the SDK adapter stays the
// only place that imports the runtime (mirrors recall.ts ↔ recallAgent.ts).
//
// SECURITY POSTURE (KB-QD's Slice-1 gates):
// - RESEARCH-8 (request-only egress): the outbound `query` is built from the request's `what`/
//   `context` ONLY — never arbitrary KB content (D6a). The query is passed to the ResearchFn; this
//   module never reads KB content to feed egress.
// - RESEARCH-12 (untrusted-content-as-DATA): the fetched finding is only ever written as a SOURCE
//   BODY + an audit payload — never interpreted as instructions here. It re-enters the pipeline as a
//   normal secondary source (Decompose→Connect→Claims), marked externally-sourced via provenance.
// - Path-containment: the finding is written via `captureToInbox`, which mints a system-controlled
//   ULID path (`inbox/<ulid>/`). No LLM-derived string ever becomes a filesystem path (the #52/#61/
//   #77 class). The researcher id that reaches `.kb/researchers/<id>` is slug-validated upstream.
import { captureToInbox } from './ingest';
import { appendAuditEvent } from './audit';
import { admitResearchPass } from './researchCeiling';
import { deriveNotebook, writeNotebook } from './researchNotebook';
import { appendRun, type RunLedgerEntry } from './researchLedger';
import { isSafeResearcherId, RESEARCH_INSTANCE_CEILING, RESEARCH_INSTANCE_WINDOW_MS, type ResearcherConfig, type ResearchRequest, type ResearchProvenance } from './researchers';
import type { Mutex } from './stageLock';

/** RMEM-2: append one run to the researcher's durable ledger — the first-class run-memory the next pass
 *  consults to skip covered ground + resume the frontier. The pursued gap facet is the missing facet the
 *  chosen angle filled (when any). Best-effort: a ledger write must never fail the research pass. */
async function recordRun(root: string, r: ResearcherConfig, req: ResearchRequest, angle: string, outcome: RunLedgerEntry['outcome'], harvested: string[], tsMs: number): Promise<void> {
  const gapFacet = req.gap?.missing.find((f) => f.trim().length > 0 && angle.toLowerCase().includes(f.toLowerCase()));
  try {
    await appendRun(root, r.id, {
      target: req.what,
      ...(req.by.entityId ? { entityId: req.by.entityId } : {}),
      ...(gapFacet ? { gapFacet } : {}),
      angle,
      harvested,
      outcome,
      ts: tsMs,
    });
  } catch {
    /* the ledger is best-effort run-memory — never block the pass on it */
  }
}

/** What the injected cognition returns. `found:false` = nothing worth recording (audited no-op). */
export interface ResearchFindings {
  /** Did the research surface anything worth recording as a secondary source? */
  found: boolean;
  /** The grounded, cited findings-note (markdown) — becomes the secondary source body. */
  note: string;
  /** External sources the note cites (URLs / external refs) — RESEARCH-6. */
  citations: string[];
  /** The outbound query actually used (built from the request only — D6a; recorded for audit). */
  query: string;
  /**
   * The pass FAILED (SDK/CLI unavailable, session error) rather than legitimately finding nothing
   * (#160 / BUG #65 class). A failure MUST stay distinguishable from a no-finding — a packaged-app
   * that can't spawn the BYOA copilot should surface an error, not a silent "no new finding". The
   * cognition adapter sets this + logs the cause; `runResearcher` audits it as `research-failed`.
   */
  failed?: boolean;
  /** The failure cause (when `failed`) — recorded in the audit so it's never silent (OBS-4). */
  error?: string;
}

/** The cognition seam: run one external research pass for `r` answering `req`. Production = the Web
 *  SDK adapter (egress-gated, read-only, untrusted-content prompt); tests inject a deterministic fn. */
export type ResearchFn = (r: ResearcherConfig, req: ResearchRequest) => Promise<ResearchFindings>;

export interface RunResearcherDeps {
  research: ResearchFn;
  /** Injectable ISO clock (deterministic tests). */
  now?: () => string;
  /** Override the global per-Instance egress ceiling (RESEARCH-11). Default RESEARCH_INSTANCE_CEILING. */
  instanceCeiling?: number;
  /** Override the per-Instance ceiling's rolling window in ms. Default RESEARCH_INSTANCE_WINDOW_MS. */
  instanceWindowMs?: number;
  /** Warm-start orient phase (RESEARCH-22) — runs LOCAL (non-egress) before the egress research call and
   *  returns the request with the chosen gap/angle folded into its context (the egress adapter's
   *  buildOutboundQuery then includes it). Opaque to keep runResearcher free of the orient/SENSE deps
   *  (the cycle): the caller (makeResearchDeps) binds the gate + neighborhood reader. Absent → cold start
   *  (unchanged behavior). Orient reads NEVER touch the egress fetch counter — they're a separate budget. */
  orient?: (r: ResearcherConfig, req: ResearchRequest) => Promise<{ orientedReq: ResearchRequest; reads: number; angle: string }>;
  /**
   * #517: the shared canonical-writer lock, serializing ONLY the final `captureToInbox` commit below —
   * never the (potentially slow, network) `deps.research()` egress call above it, which would otherwise
   * hold the lock for a whole research pass and starve every other capture/advance. Every production
   * caller (scheduler standing pass, inline sweep, Run-now, review-resume) supplies it; tests that don't
   * exercise concurrent writers may omit it (add-only unique ULID paths never content-collide, but an
   * omitted lock can still race another writer's `git add`/`commit` on the same index — the #517
   * mechanism).
   */
  lock?: Mutex;
}

export interface RunResearcherResult {
  /** Secondary source ids produced (empty when the pass found nothing). */
  sourceIds: string[];
  /** One-liner outcome for the dispatcher's summary / caller audit. */
  note: string;
  /** The pass failed (vs a legit no-finding) — so the caller/UI surfaces an error, not "no finding". */
  failed?: boolean;
  /** The failure cause, when `failed`. */
  error?: string;
  /** The pass was refused by the global per-Instance ceiling (RESEARCH-11) — a rate-limit pause, NOT a
   *  legit empty result. Kept distinct so the UI/audit don't report a runaway-backstop block as
   *  "no new finding" (the failed≠empty principle, applied to the ceiling). */
  ceilingReached?: boolean;
}

/**
 * Run `r` against `req`: research (injected) → on a finding, write a cited secondary source (ingest
 * path, contained ULID) that re-enters the pipeline, and emit a conforming `researcher` audit event;
 * on no finding, audit the no-op. Returns the source ids produced. Defensive: an unsafe researcher id
 * is refused before any path is touched (belt-and-suspenders over the registry guard).
 */
export async function runResearcher(root: string, r: ResearcherConfig, req: ResearchRequest, deps: RunResearcherDeps): Promise<RunResearcherResult> {
  if (!isSafeResearcherId(r.id)) throw new Error(`runResearcher: refusing unsafe researcher id ${JSON.stringify(r.id)}`);
  const now = deps.now ?? (() => new Date().toISOString());

  // Global per-Instance egress ceiling (RESEARCH-11) — the cross-researcher HARD backstop, checked at
  // this single chokepoint so it bounds BOTH inline dispatch runs AND scheduled standing passes. Once the
  // rolling-window count is spent, REFUSE before any egress (no `deps.research`) + audit the no-op so the
  // backstop is never silent (AUDIT-2). Self-healing: capacity returns as passes age out of the window.
  const ceiling = deps.instanceCeiling ?? RESEARCH_INSTANCE_CEILING;
  const windowMs = deps.instanceWindowMs ?? RESEARCH_INSTANCE_WINDOW_MS;
  const admission = await admitResearchPass(root, Date.parse(now()) || Date.now(), ceiling, windowMs);
  if (!admission.allowed) {
    await appendAuditEvent(root, {
      actor: 'researcher',
      eventType: 'ceiling-reached',
      ts: now(),
      subjects: { researcherId: r.id, requestId: req.id, ...(req.by.entityId ? { entityId: req.by.entityId } : {}), ...(req.by.sourceId ? { sourceId: req.by.sourceId } : {}) },
      payload: { what: req.what, why: req.why, countInWindow: admission.countInWindow, ceiling: admission.ceiling, windowHours: windowMs / 3_600_000, egressTier: r.egressTier },
    });
    return { sourceIds: [], note: `per-Instance research ceiling reached (${admission.countInWindow}/${admission.ceiling} passes in ${windowMs / 3_600_000}h)`, ceilingReached: true };
  }

  // Warm-start orient (RESEARCH-22): a bounded, LOCAL pass before egress that folds the gap/angle into the
  // request context. Non-egress — runs after the ceiling check (it's not a pass against the ceiling) and
  // its reads never increment the egress fetch budget. A failure here must never block the research pass
  // (degrade to a cold start), so it's swallowed to a no-op.
  let researchReq = req;
  let chosenAngle = '';
  if (deps.orient) {
    try {
      const oriented = await deps.orient(r, req);
      researchReq = oriented.orientedReq;
      chosenAngle = oriented.angle; // recorded on the audit so the notebook can rotate the next run (RESEARCH-QUALITY)
    } catch {
      researchReq = req; // orient is best-effort awareness; never block egress on it
      chosenAngle = '';
    }
  }

  const findings = await deps.research(r, researchReq);

  if (findings.failed) {
    // The cognition FAILED (e.g. packaged-app can't spawn the BYOA copilot — #160 / BUG #65), not a
    // legit empty result. Audit it as a DISTINCT `research-failed` event (never the silent `no-finding`
    // that hid this in the live build) so the Activity feed + OBS surface the error (AUDIT-2, OBS-4).
    await appendAuditEvent(root, {
      actor: 'researcher',
      eventType: 'research-failed',
      ts: now(),
      subjects: { researcherId: r.id, requestId: req.id, ...(req.by.entityId ? { entityId: req.by.entityId } : {}), ...(req.by.sourceId ? { sourceId: req.by.sourceId } : {}) },
      payload: { what: req.what, why: req.why, query: findings.query, egressTier: r.egressTier, error: findings.error ?? 'unknown error' },
    });
    // RMEM-2: record the failed run (run-history/observability) — `coveredAngles` skips failed so the facet retries.
    await recordRun(root, r, req, chosenAngle, 'failed', [], Date.parse(now()) || Date.now());
    return { sourceIds: [], note: `research failed: ${findings.error ?? 'unknown error'}`, failed: true, ...(findings.error ? { error: findings.error } : {}) };
  }

  if (!findings.found || findings.note.trim().length === 0) {
    // RESEARCH-4: not relevant / nothing found → no-op, but audited (no silent actions, AUDIT-2).
    await appendAuditEvent(root, {
      actor: 'researcher',
      eventType: 'no-finding',
      ts: now(), // stamp with the pass's (injectable) clock — keeps audit ts == the run, not wall-clock
      subjects: { researcherId: r.id, requestId: req.id, ...(req.by.entityId ? { entityId: req.by.entityId } : {}), ...(req.by.sourceId ? { sourceId: req.by.sourceId } : {}) },
      // RESEARCH-QUALITY: stamp the drilled `angle` + the `gap` so the field notebook can mark this facet
      // targeted and rotate the NEXT pass to a different missing facet (a looked-and-found-nothing pass
      // still counts as drilled — don't immediately re-issue the same query).
      payload: { what: req.what, why: req.why, query: findings.query, egressTier: r.egressTier, ...(chosenAngle ? { angle: chosenAngle } : {}), ...(req.gap ? { gap: req.gap } : {}) },
    });
    // RMEM-2/3: a looked-and-found-nothing pass DID drill the facet → record it so the next run rotates away.
    await recordRun(root, r, req, chosenAngle, 'no-finding', [], Date.parse(now()) || Date.now());
    return { sourceIds: [], note: 'no finding' };
  }

  const fetchedAt = now();
  const provenance: ResearchProvenance = {
    researcherId: r.id,
    requestId: req.id,
    query: findings.query,
    citations: findings.citations,
    fetchedAt,
  };
  // Contained write: ULID path, agent supplies only the body. origin:'secondary' → re-enters Decompose.
  // #517: only THIS commit is lock-scoped — the egress call above already finished.
  const doCapture = () =>
    captureToInbox(root, `researcher:${r.id}`, [{ kind: 'text', text: findings.note }], Date.parse(fetchedAt) || Date.now(), {
      origin: 'secondary',
      research: provenance,
    });
  const out = deps.lock ? await deps.lock.run(doCapture, `researcher:${r.id}`) : await doCapture();

  await appendAuditEvent(root, {
    actor: 'researcher',
    eventType: 'researched',
    ts: fetchedAt, // == the pass clock (matches provenance.fetchedAt), not wall-clock
    subjects: { researcherId: r.id, requestId: req.id, sourceId: out.ids[0], ...(req.by.entityId ? { entityId: req.by.entityId } : {}) },
    // RESEARCH-QUALITY: `angle` (the facet drilled) + `gap` let deriveNotebook mark this facet targeted and
    // surface the still-uncovered facets as frontier leads — so the next pass on this entity rotates.
    payload: { what: req.what, why: req.why, query: findings.query, citations: findings.citations, egressTier: r.egressTier, externallySourced: true, ...(chosenAngle ? { angle: chosenAngle } : {}), ...(req.gap ? { gap: req.gap } : {}) },
  });

  // Warm-start (RESEARCH-21): refresh the field notebook from the audit (which now includes this
  // `researched` event) so the NEXT pass's orient sees the just-harvested sources + the drilled area.
  // Best-effort — a notebook write must never fail the pass (the audit is canonical; the notebook is a
  // derived cache, self-healing on the next read).
  try {
    await writeNotebook(root, r.id, await deriveNotebook(root, r.id, Date.parse(fetchedAt) || Date.now()));
  } catch {
    /* notebook is a derived cache — never block the pass on it */
  }

  // RMEM-2: durably record the run in the first-class ledger (target/facet/angle/harvested) so the next
  // pass skips this covered tuple and resumes the frontier — independent of the audit (RMEM-7 overlay).
  await recordRun(root, r, req, chosenAngle, 'finding', out.ids, Date.parse(fetchedAt) || Date.now());

  return { sourceIds: out.ids, note: `secondary source ${out.ids[0]} (${findings.citations.length} citation(s))` };
}

/**
 * The hard cap on how much request `context` may ride outbound (D6a / RESEARCH-8). `context` is meant
 * to be the *surrounding sentence/phrase* a request rests on — the soft "one sentence" limit is only
 * prompt-instructed upstream, so this is the deterministic backstop: even if a producer (or an
 * injection) packs a long span into `context`, only this many characters can ever leave the process.
 * Generous enough for a real sentence, tight enough that unbounded source text can't be exfiltrated.
 */
export const MAX_OUTBOUND_CONTEXT_CHARS = 500;

/**
 * Build the outbound query for a request — the ONLY KB-derived material a Slice-1 researcher may send
 * outbound (D6a / RESEARCH-8). Deliberately tiny + pure: the request's `what`, lightly grounded by
 * its `context` **hard-capped to {@link MAX_OUTBOUND_CONTEXT_CHARS}** (KB-QD #96 flag — the egress
 * chokepoint, so an over-long/injected context can't leak unbounded source text). Never reads
 * entities/claims/sources. The SDK adapter calls this; exported for the egress test that proves no
 * arbitrary KB content leaks into the query.
 */
export function buildOutboundQuery(req: ResearchRequest): string {
  const what = req.what.trim();
  let ctx = req.context.trim();
  if (ctx.length > MAX_OUTBOUND_CONTEXT_CHARS) ctx = `${ctx.slice(0, MAX_OUTBOUND_CONTEXT_CHARS)}…`;
  return ctx ? `${what} — ${ctx}` : what;
}
