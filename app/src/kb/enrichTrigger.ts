// SPEC-0028 RESEARCH-3 / WS-B + RESEARCH-QUALITY — the enrichment TRIGGER: the missing producer that
// makes the research pipeline non-inert. The dispatcher, the persistent dedup ledger, and the warm-start
// orient all work — but NOTHING ever emitted a `research-request`, so a registered+enabled researcher had
// no work and `outputs/` stayed empty. This scans the resolved entity graph and emits one
// `research-request` per entity that WANTS enrichment, attaching a structured GAP descriptor so orient
// can target the missing facets.
//
// Enrichment-worthy is no longer COUNT-ONLY (the Principal's "researchers are generic, no understanding of
// gaps" defect). An entity is flagged when it is either:
//   - SPARSE by corroboration count (≤1 source — a stub the KB can't cross-corroborate, the original WS-B
//     signal), OR
//   - FACET-THIN (`isFacetThin`) — it covers fewer of its kind's expected facets than it's missing, even if
//     several sources mention it (a person with three sources but no birth date / education / role). This is
//     the QUALITATIVE gap the count-only check was blind to.
// Either way the emitted signal carries the per-kind {present, missing} gap so the warm-start orient steers
// the outbound query at what the KB actually lacks (gap-filling), not the bare topic.
//
// Deterministic by design (no LLM → no brittle-JSON parse failure, matching the SPEC-0049 robustness
// ethos). Idempotent: an entity already carrying a pending `research-request` (same dedupKey) is
// skipped, and the dispatcher's `seen.json` ledger backstops cross-sweep dedup — so re-running the
// sweep never re-fans research nor bloats the audit. The emitted signal lands in the cross-cutting
// control audit (`.kb/audit.jsonl`) as the `enrich` actor, where `collectResearchRequests` reads it
// back into a `ResearchRequest` for the dispatcher (the same path a stage-emitted signal travels).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendAuditEvent } from './audit';
import { parseEntityNode, type ParsedNode } from './connectDoc';
import { claimStatementsFromMd } from './claimDoc';
import { computeEnrichmentGap, isFacetThin, type EnrichmentGap } from './enrichGap';
import { RESEARCH_REQUEST_SIGNAL, dedupKeyFor } from './researchers';
import { walkVaultFiles } from './vaultWalk';

/**
 * The max corroborating-source count at which an entity is "sparse" / a "little reference" worth
 * enriching (WS-B). `<= 1` = mentioned by only a single source — a stub the KB can't yet
 * cross-corroborate; the natural enrichment target. A named constant so the SPEC-0028 amendment can
 * tune the threshold without hunting the logic.
 */
export const SPARSE_SOURCE_MAX = 1;

/** Is this resolved entity sparse (a "little reference" wanting external enrichment)? */
export function isSparseEntity(node: Pick<ParsedNode, 'derivedFrom'>): boolean {
  return node.derivedFrom.length <= SPARSE_SOURCE_MAX;
}

/** Why an entity was flagged for enrichment — drives the request's `why` (human-facing, no jargon). */
export interface EnrichmentNeed {
  needed: boolean;
  why: string;
}

/**
 * Decide whether `node` (with its computed `gap`) wants an enrichment pass, and the human-facing reason
 * (RESEARCH-QUALITY). Count-sparse OR facet-thin → needed. The reason names the actual deficit so the
 * Activity feed reads honestly ("covered 2 of 6 expected facets") rather than a generic "sparse". The
 * sparse-count reason takes precedence when both hold (it's the stronger corroboration signal).
 */
export function enrichmentNeed(node: Pick<ParsedNode, 'derivedFrom'>, gap: EnrichmentGap): EnrichmentNeed {
  if (isSparseEntity(node)) {
    return { needed: true, why: `sparse entity — corroborated by only ${node.derivedFrom.length} source(s); enrich with an external reference` };
  }
  if (isFacetThin(gap)) {
    const total = gap.present.length + gap.missing.length;
    return { needed: true, why: `thin coverage — only ${gap.present.length} of ${total} expected facets known; research the missing ones (${gap.missing.join(', ')})` };
  }
  return { needed: false, why: '' };
}

/** Recursively collect every entity node markdown file under `entities/` (vault-relative paths).
 *  Skips dotfiles/dirs and the `.gitkeep` scaffold; tolerant of a missing tree (empty result).
 *  SPEC-0061 T1 / ENG-9: delegates to the shared `walkVaultFiles` walker (this file is not owned by
 *  another wave-1 lane, so it's one of the ad-hoc-walker retirements landing in this slice). */
async function walkEntityFiles(root: string): Promise<string[]> {
  return walkVaultFiles(root, 'entities', { keep: (n) => n.endsWith('.md') });
}

export interface FlagSparseOptions {
  /** Inject the emitted-signal timestamp (tests/determinism); defaults to now via appendAuditEvent. */
  ts?: string;
}

/**
 * Scan the resolved entity graph and emit a `research-request` for each entity that WANTS enrichment and
 * does not already have one pending (RESEARCH-3, WS-B + RESEARCH-QUALITY). Enrichment-worthy is no longer
 * count-only: an entity is flagged when it is sparse by corroboration count OR facet-thin (its claims
 * cover fewer expected facets than they miss — see {@link enrichmentNeed}). `existingKeys` is the set of
 * dedupKeys already in flight (the caller passes `collectResearchRequests`' keys) so we never re-emit a
 * request the dispatcher would only dedup away — that keeps the control audit from growing every sweep. A
 * malformed/foreign node is skipped (ENG-16 per-item isolation), never crashes the scan. Returns the
 * number of new requests emitted.
 */
export async function flagEnrichmentGaps(
  root: string,
  existingKeys: Set<string>,
  opts: FlagSparseOptions = {},
): Promise<number> {
  const rels = await walkEntityFiles(root);
  let emitted = 0;
  for (const rel of rels) {
    let md: string;
    let node: ParsedNode;
    try {
      md = await fs.readFile(path.join(root, rel), 'utf8');
      node = parseEntityNode(md);
    } catch {
      continue; // malformed/foreign node — skip, don't crash the sweep (ENG-16)
    }
    // RESEARCH-24: compute the per-kind enrichment GAP from the entity's present claims FIRST — it both
    // decides whether a multi-source entity is facet-thin enough to flag (RESEARCH-QUALITY) and rides on
    // the signal so orient can steer the outbound query toward the MISSING facets (gap-filling).
    const gap = computeEnrichmentGap(node.kind, claimStatementsFromMd(md));
    const need = enrichmentNeed(node, gap);
    if (!need.needed) continue;
    const by = { entityId: node.id };
    const dedupKey = dedupKeyFor({ what: node.name, by });
    if (existingKeys.has(dedupKey)) continue; // already requested (this sweep or a prior one)
    existingKeys.add(dedupKey); // guard against duplicate entity files within one sweep
    await appendAuditEvent(root, {
      actor: 'enrich',
      subjects: { entityId: node.id },
      eventType: 'signal',
      payload: {
        type: RESEARCH_REQUEST_SIGNAL,
        what: node.name,
        why: need.why,
        context: `${node.kind}: ${node.name}`,
        gap,
      },
      ...(opts.ts ? { ts: opts.ts } : {}),
    });
    emitted++;
  }
  return emitted;
}
