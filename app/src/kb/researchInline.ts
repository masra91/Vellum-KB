// Inline research wiring (SPEC-0028 RESEARCH-2/3/4) — ties the cognition modules to the deterministic
// dispatcher. `makeResearchDeps` bundles the production self-nomination (thin CLI + heuristic) and the
// Web run-pass (SDK adapter behind the seam) into the dispatcher's `DispatchDeps`; `runInlineResearch`
// loads the enabled researchers and dispatches a batch of `research-request`s through them.
//
// Both cognition paths are injected (NominateRunner / WebResearchOptions.session), so this wiring is
// unit-testable end-to-end with fakes — no network — and production swaps in the live CLI + SDK.
// Egress + untrusted-content gates live in the modules this composes (researchWebAgent), enforced
// regardless of how dispatch is triggered.
import { readResearcherRegistry } from './researcherRegistry';
import { readEvents } from './activityIndex';
import { dispatchResearch, type DispatchDeps, type DispatchResult } from './researchDispatcher';
import { makeCliSelfNominate, type NominateRunner } from './researchNominate';
import { makeWebResearchFn, type WebResearchOptions } from './researchWebAgent';
import { makeCodeResearchFn, type CodeResearchOptions } from './researchCodeAgent';
import { makeM365ResearchFn, type M365ResearchOptions } from './researchM365Agent';
import { runResearcher, type ResearchFn, type RunResearcherDeps } from './researchRun';
import { orient, orientedRequest, makeNeighborhoodReader } from './researchOrient';
import { sensitivityAllowsOrientRead } from './sensitivity';
import { raiseResearchEscalation } from './researchEscalate';
import { RESEARCH_REQUEST_SIGNAL, dedupKeyFor, type ResearcherConfig, type ResearchRequest } from './researchers';
import { isEnrichmentGap } from './enrichGap';
import { flagEnrichmentGaps } from './enrichTrigger';
import type { Mutex } from './stageLock';

export interface ResearchDepsOptions {
  /** Thin-CLI relevance runtime for self-nomination (omit → deterministic heuristic only). */
  nominateRunner?: NominateRunner;
  /** Web SDK options (model + injectable session). Omit `session` → live SDK (CI/e2e). */
  web?: WebResearchOptions;
  /** Code researcher options (read-only git layer pass-through). */
  code?: CodeResearchOptions;
  /** M365 researcher options (injectable MCP server + session; OAuth in main, env-gated live). */
  m365?: M365ResearchOptions;
  /** Override the research cognition for EVERY researcher (tests). Wins over per-template selection. */
  researchFn?: ResearchFn;
  maxFanout?: number;
  globalCeiling?: number;
  /** #517: the shared canonical-writer lock — threaded into every dispatched `runResearcher`'s
   *  `RunResearcherDeps.lock` so its final capture commit is serialized against other writers. */
  lock?: Mutex;
}

/** A no-op cognition for templates whose behavior hasn't landed yet (m365/custom in Slice 2) — a
 *  graceful no-finding, never an error, so an enabled-but-unimplemented researcher just does nothing. */
const noResearchFn: ResearchFn = async (_r, req) => ({ found: false, note: '', citations: [], query: req.what });

/**
 * Select the cognition for ONE researcher by its template (RESEARCH-16) — the seam where Web/Code/M365
 * diverge. An explicit `opts.researchFn` (tests) overrides all templates. Bound to `root` so a code
 * researcher's sandbox + a web finding both land in this vault.
 */
export function selectResearchFn(root: string, r: ResearcherConfig, opts: ResearchDepsOptions = {}): ResearchFn {
  if (opts.researchFn) return opts.researchFn;
  switch (r.template) {
    case 'web':
      return makeWebResearchFn(opts.web);
    case 'code':
      return makeCodeResearchFn(root, opts.code);
    case 'm365':
      return makeM365ResearchFn(opts.m365);
    default:
      return noResearchFn; // custom — not yet implemented
  }
}

/**
 * Build the dispatcher's `DispatchDeps` from the production cognition (RESEARCH-4): self-nomination =
 * CLI-refined heuristic; run = the per-pass research that writes a cited secondary source + audit.
 * `run` is bound to `root` and selects the cognition PER-RESEARCHER by template (Web/Code), so a
 * mixed registry routes each researcher to its own runtime behind the one `ResearchFn` seam.
 */
export function makeResearchDeps(root: string, opts: ResearchDepsOptions = {}): DispatchDeps {
  const orientRunner = makeOrientRunner(root);
  return {
    selfNominate: makeCliSelfNominate(opts.nominateRunner),
    run: (r, req) => runResearcher(root, r, req, { research: selectResearchFn(root, r, opts), orient: orientRunner, lock: opts.lock }),
    escalate: (r, req, depth) => raiseResearchEscalation(root, r, req, depth),
    ...(opts.maxFanout !== undefined ? { maxFanout: opts.maxFanout } : {}),
    ...(opts.globalCeiling !== undefined ? { globalCeiling: opts.globalCeiling } : {}),
  };
}

/**
 * Bind the warm-start orient runner (RESEARCH-22) for `root`: each pass reads the researcher's field
 * notebook + the subject's KB neighborhood (the structural floor; content gated by SENSE's
 * `sensitivityAllowsOrientRead`, D8) and folds the chosen gap/angle into the request context (bounded —
 * the egress adapter's buildOutboundQuery then includes it). Non-egress (a separate orientBudget); degrades
 * to a cold start on a sparse KB. The recall tools are built once per dispatch (reused across the fan-out).
 */
function makeOrientRunner(root: string): NonNullable<RunResearcherDeps['orient']> {
  const readNeighborhood = makeNeighborhoodReader(root);
  return async (r, req) => {
    const res = await orient(root, r, req, { readNeighborhood, gate: sensitivityAllowsOrientRead });
    return { orientedReq: orientedRequest(req, res.angle), reads: res.reads, angle: res.angle };
  };
}

/**
 * Run a batch of inline `research-request`s (RESEARCH-2/3): load the enabled researchers and route the
 * requests through the deterministic dispatcher (dedup → eligibility → self-nomination → bounded run).
 * Disabled researchers are skipped (the registry holds enabled+disabled; only enabled research).
 * Returns the dispatch summary for the caller to audit/journal.
 */
export async function runInlineResearch(root: string, requests: readonly ResearchRequest[], opts: ResearchDepsOptions = {}): Promise<DispatchResult> {
  const researchers = (await readResearcherRegistry(root)).filter((r) => r.enabled);
  return dispatchResearch(root, requests, researchers, makeResearchDeps(root, opts));
}

/**
 * Walk the research-chain lineage to count how many research passes already sit *beneath* a source
 * (RESEARCH-11 depth). A PRIMARY source (not produced by a researcher) is 0; a research-produced
 * finding is one deeper than the source its triggering request rested on. Pure over two lineage maps
 * derived from the audit: `producedBy` (a research-produced sourceId → the requestId that produced
 * it) and `requestSource` (a requestId → the sourceId it was *about*, i.e. its `by.sourceId`). A
 * visited-set guards against a malformed cyclic lineage. Exported for direct unit testing — the chain
 * DEPTH of a request that rests on source `s` is `1 + chainDepthOfSource(s, …)`.
 */
export function chainDepthOfSource(
  sourceId: string | undefined,
  producedBy: Map<string, string>,
  requestSource: Map<string, string | undefined>,
  visited: Set<string> = new Set(),
): number {
  if (!sourceId || visited.has(sourceId)) return 0;
  visited.add(sourceId);
  const parentRequestId = producedBy.get(sourceId);
  if (!parentRequestId) return 0; // a primary (non-research) source — the chain root
  return 1 + chainDepthOfSource(requestSource.get(parentRequestId), producedBy, requestSource, visited);
}

/**
 * Collect the `research-request` signals a producer emitted (RESEARCH-3, D1) from the audit into
 * `ResearchRequest`s ready for dispatch. A producer (a pipeline stage that hit an unknown term, or
 * Reflect) emits `signals: [{ type: 'research-request', what, why, context?, refs? }]`, which lands
 * as a `signal` audit event whose payload carries those fields. We read them back here; the
 * dispatcher's persistent dedup ledger then ensures the same request isn't fanned out twice across
 * sweeps, so re-collecting old signals is safe + idempotent.
 *
 * Each request is stamped with its CHAIN DEPTH (RESEARCH-11): depth 1 for a request off a primary
 * source, +1 for each research→finding→request hop beneath it, derived from the `researched` audit
 * lineage. The dispatcher enforces it against `budget.maxDepth` so a runaway research→finding→
 * research chain escalates to Review instead of fetching unboundedly.
 */
export async function collectResearchRequests(root: string): Promise<ResearchRequest[]> {
  const events = await readEvents(root, {}); // newest-first
  // Lineage maps for the depth walk: which request produced a given research source, and which
  // source a given request rested on. Built from the same audit read (no extra I/O).
  const producedBy = new Map<string, string>(); // research-produced sourceId → producing requestId
  const requestSource = new Map<string, string | undefined>(); // requestId → its by.sourceId
  const out: ResearchRequest[] = [];
  for (const e of events) {
    if (e.actor === 'researcher' && e.eventType === 'researched' && e.subjects.sourceId && e.subjects.requestId) {
      producedBy.set(e.subjects.sourceId, e.subjects.requestId);
      continue;
    }
    if (e.eventType !== 'signal') continue;
    const p = e.payload;
    if (p.type !== RESEARCH_REQUEST_SIGNAL || typeof p.what !== 'string' || p.what.length === 0) continue;
    const by = {
      stage: e.actor,
      ...(e.subjects.sourceId ? { sourceId: e.subjects.sourceId } : {}),
      ...(e.subjects.entityId ? { entityId: e.subjects.entityId } : {}),
    };
    // Stable id from provenance so re-collecting the same signal yields the same request.
    const id = `${e.provenance.file}:${e.provenance.line}`;
    requestSource.set(id, by.sourceId);
    out.push({
      id,
      ts: e.ts,
      by,
      what: p.what,
      // The signal's `note` is the *why* (D1); accept an explicit `why` too for forward-compat.
      why: typeof p.why === 'string' ? p.why : typeof p.note === 'string' ? p.note : '',
      context: typeof p.context === 'string' ? p.context : '',
      ...(typeof p.egressHint === 'string' ? { egressHint: p.egressHint as ResearchRequest['egressHint'] } : {}),
      dedupKey: dedupKeyFor({ what: p.what, by }),
      // RESEARCH-24: the enrichment gap the producer stamped (shape-guarded — legacy signals lack it).
      ...(isEnrichmentGap(p.gap) ? { gap: p.gap } : {}),
    });
  }
  // Second pass: stamp chain depth now that both lineage maps are complete.
  for (const req of out) {
    req.depth = 1 + chainDepthOfSource(req.by.sourceId, producedBy, requestSource, new Set());
  }
  return out;
}

/**
 * One inline-research sweep (RESEARCH-2/3): collect the pending `research-request` signals + route
 * them through the dispatcher. Intended to be poked after a stage drain (where unknown-term signals
 * arise) or on the researcher tick; the dedup ledger makes repeated sweeps cheap.
 *
 * WS-B + RESEARCH-QUALITY: before collecting, run the enrichment trigger — scan the resolved entity graph
 * and emit a `research-request` for every entity that wants enrichment (sparse by count OR facet-thin) and
 * is not already requested. This is the producer that makes the pipeline non-inert; flagged entities then
 * travel the exact same collect→dispatch path as a stage-emitted signal. We collect once up front to pass
 * the in-flight dedupKeys (so we never re-emit), then collect again to include the freshly-flagged requests.
 */
export async function runInlineResearchSweep(root: string, opts: ResearchDepsOptions = {}): Promise<DispatchResult> {
  const existing = await collectResearchRequests(root);
  await flagEnrichmentGaps(root, new Set(existing.map((r) => r.dedupKey)));
  return runInlineResearch(root, await collectResearchRequests(root), opts);
}
