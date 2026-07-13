// The graph projection (SPEC-0058 STATE-2) — the maintained, precomputed knowledge-graph snapshot that
// Explore and Health read INSTEAD of walking the git vault live on every mount.
//
// The packaged-app P0 (#451 stopped the bleed) was that Explore + Health scanned `entities/`+`claims/`
// LIVE per render: Explore's incoming-link backlink scan is O(N+M) PER focus, Health re-walks every
// node — so a cold/large vault blew the load budget and the views failed to load. This module moves that
// work OFF the render path: `computeGraphProjection` does ONE pass on the settled tree (read each entity
// node once, extract its outgoing `[[wikilinks]]`, and INVERT them into precomputed backlinks), producing
// a `GraphProjection`. `makeProjectionTools` then serves the existing read-only `RecallTools` surface
// PURELY from that in-memory snapshot — so the proven `buildNeighborhood` (Explore) and `buildHealthReport`
// (Health) assembly runs unchanged, with zero filesystem access and an O(degree) backlink lookup.
//
// Lane (SPEC-0058 scale-up): graph-projection AUTHORSHIP is DEV-3's (STATE-2); it is the shared substrate
// Health (STATE-3, DEV-2) derives from read-only. The generic ProjectionStore backbone + envelope +
// invalidation + push + persistence are the CORE's (DEV-5, STATE-1/6/7/8/11/12) — this module is a PURE
// function `(RecallTools) → GraphProjection` plus its read adapter, plugged into that store as `compute`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseEntityNode } from './connectDoc';
import { parseClaimMd, makeReadOnlyTools } from './recallTools';
import { walkVaultFiles } from './vaultWalk';
import type { RecallTools, EntityHit, ClaimHit, LinkHit, GrepHit } from './recall';

/** A precomputed, serializable snapshot of the evergreen knowledge graph (STATE-2). Carries exactly what
 *  the Explore + Health surfaces consume — entities, per-node markdown (predicates / thin-detection),
 *  PRECOMPUTED backlinks (the O(N²)-once that kills the per-mount re-walk), claims, and cited-source
 *  markdown (for citation titles). Plain records (no Map) so it persists to JSON for instant cold start. */
export interface GraphProjection {
  /** Every entity node (the same `EntityHit` shape `entityLookup` returns), unsorted. */
  entities: EntityHit[];
  /** entity rel-path → its raw node markdown (serves `readNode`: center predicates + Health thin/link scan). */
  entityMd: Record<string, string>;
  /** entity rel-path → its PRECOMPUTED incoming backlinks (every entity/claim file literally containing
   *  `[[<rel>]]`). This is the inverted edge index — the live O(N+M) per-focus scan, done once. */
  backlinks: Record<string, LinkHit[]>;
  /** Every claim (the `ClaimHit` shape `claimsForEntity` returns). */
  claims: ClaimHit[];
  /** source dir → its `source.md` text (serves `readSource` for citation-title derivation). */
  sourceMd: Record<string, string>;
  /** ISO timestamp the snapshot was computed (provenance; the store's envelope also stamps `builtAt`). */
  builtAt?: string;
}

/** Extract `[[target]]` wikilink targets from a node body. Replicated verbatim from `recallTools` (kept
 *  local to avoid a cross-file export edit in the parallel rewrite); the equivalence test pins it identical. */
function extractWikilinks(md: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Compute the graph projection from the evergreen vault `root` (STATE-2). Runs the expensive work ONCE
 * (off the render path, on the store's cadence / canonical-advance): reads every entity node + claim once
 * for the served data, then precomputes each entity's incoming backlinks by the SAME literal-`[[rel]]` test
 * the live `linkTraversal` uses, over the SAME source set — so a projection-backed read is byte-identical to
 * the live one, minus the per-mount cost. `now` is injectable for deterministic tests.
 */
export async function computeGraphProjection(root: string, now: () => string = () => new Date().toISOString()): Promise<GraphProjection> {
  root = path.resolve(root);
  const tools = makeReadOnlyTools(root);

  // ONE walk of entities/ + claims/, each file read EXACTLY ONCE (#505 — collectAllClaims used to call
  // claimsForEntity per entity, and EACH call re-walked + re-parsed every claim file: O(N·M) reads. The
  // old code also re-read every entity/claim file a THIRD time for the backlink source set. Here the
  // raw content backs BOTH the parsed entity/claim data AND the backlink scan below — total reads are
  // exactly N (entities) + M (claims) + S (cited sources), never N×M.
  const rawEntities: Array<{ rel: string; md: string }> = [];
  for (const rel of await walkMdFiles(root, 'entities')) {
    try {
      rawEntities.push({ rel, md: await fs.readFile(path.join(root, rel), 'utf8') });
    } catch {
      /* unreadable — skip */
    }
  }
  const rawClaims: Array<{ rel: string; md: string }> = [];
  for (const rel of await walkMdFiles(root, 'claims')) {
    try {
      rawClaims.push({ rel, md: await fs.readFile(path.join(root, rel), 'utf8') });
    } catch {
      /* unreadable — skip */
    }
  }

  // Parse entities (foreign/malformed nodes skipped, mirrors recallTools' allEntities), sorted + capped
  // EXACTLY like the live `entityLookup({query:'', limit: ENTITY_SCAN_LIMIT})` scan (equivalence, #468).
  const parsedEntities: EntityHit[] = [];
  for (const { rel, md } of rawEntities) {
    try {
      const node = parseEntityNode(md);
      parsedEntities.push({
        rel,
        id: node.id,
        kind: node.kind,
        name: node.name,
        aliases: node.aliases,
        confidence: node.confidence,
        tags: node.tags,
        derivedFrom: node.derivedFrom,
      });
    } catch {
      /* foreign / malformed node — skip, matches allEntities() */
    }
  }
  const entities = parsedEntities
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
    .slice(0, ENTITY_SCAN_LIMIT);

  const rawEntityMdByRel = new Map(rawEntities.map((f) => [f.rel, f.md]));
  const entityMd: Record<string, string> = {};
  for (const e of entities) {
    const md = rawEntityMdByRel.get(e.rel);
    if (md !== undefined) entityMd[e.rel] = md;
  }

  // Parse claims (malformed skipped, matches allClaims()) — one pass, no per-entity re-walk.
  const claims: ClaimHit[] = [];
  for (const { rel, md } of rawClaims) {
    try {
      const c = parseClaimMd(md);
      claims.push({
        rel,
        id: c.id,
        subject: c.subject,
        status: c.status,
        confidence: c.confidence,
        statement: c.statement,
        derivedFrom: c.derivedFrom,
        mentions: c.mentions,
        relatesTo: c.relatesTo,
      });
    } catch {
      /* malformed claim — skip, matches allClaims() */
    }
  }

  // PRECOMPUTE backlinks against the SAME source set the live `linkTraversal.incoming` walks: EVERY `.md`
  // under entities/+claims/, RAW (not just the parsed entities/claims). This is the QD fast-follow on
  // #468: a `[[validEntity]]` inside a MALFORMED entity (skipped by `entityLookup`) or an ORPHAN claim
  // (subject merged away, so `claimsForEntity` never returns it) is an incoming backlink the live walk counts
  // — the projection must too, or it diverges on a large/merged vault. Reuses the raw content already read
  // above instead of a second walk (was a full third re-read of every entity/claim file — #505).
  const sourceFiles = [...rawEntities, ...rawClaims];
  const backlinks: Record<string, LinkHit[]> = {};
  for (const e of entities) {
    const target = `[[${e.rel}]]`;
    backlinks[e.rel] = sourceFiles.filter((f) => f.rel !== e.rel && f.md.includes(target)).map((f) => ({ from: f.rel, to: e.rel }));
  }

  // Cited sources: read each unique `derivedFrom` source dir's source.md once (for citation titles).
  const sourceMd: Record<string, string> = {};
  const sourceDirs = new Set<string>();
  for (const c of claims) for (const d of c.derivedFrom ?? []) if (typeof d === 'string' && d.trim()) sourceDirs.add(d);
  for (const dir of sourceDirs) {
    const md = await tools.readSource({ dir });
    if (typeof md === 'string') sourceMd[dir] = md;
  }

  return { entities, entityMd, backlinks, claims, sourceMd, builtAt: now() };
}

/** Recursively list `.md` rel-paths under `root/dir` (skips dotdirs; a missing dir → []). Mirrors the
 *  private `walkFiles` in recallTools so the backlink-source set matches the live scan exactly.
 *  SPEC-0061 T1 / ENG-9 (#539): delegates to the shared `walkVaultFiles` (see recallTools.ts's own
 *  swap for the two behavior-improvement notes — symlink-safe, deterministic order — that apply
 *  identically here). */
async function walkMdFiles(root: string, dir: string): Promise<string[]> {
  return walkVaultFiles(root, dir, { keep: (n) => n.endsWith('.md') });
}

/** The same generous entity cap the live read surface uses (recallTools/explorePanel ENTITY_SCAN_LIMIT). */
const ENTITY_SCAN_LIMIT = 2000;

/** A high per-entity claim cap for `claimsForEntity` reads (well above any real entity's claim count). */
const CLAIM_COLLECT_LIMIT = 1000;

/**
 * Serve the read-only `RecallTools` surface PURELY from a precomputed {@link GraphProjection} — zero
 * filesystem, O(degree) backlink lookup. Drop-in for `makeReadOnlyTools(root)` so `buildNeighborhood`
 * (Explore) and `buildHealthReport` (Health) run VERBATIM against the projection (no logic divergence; the
 * equivalence test proves identical output). `grep` is a no-op (Explore/Health never call it).
 */
export function makeProjectionTools(graph: GraphProjection): RecallTools {
  const entities = graph.entities;
  const byRelName = (entity: string): string | null => {
    if (typeof entity !== 'string' || entity.length === 0) return null;
    // A rel-path that is a known entity resolves to itself (mirrors resolveEntityRel's rel branch).
    if (entity.includes('/') && entity.endsWith('.md') && Object.prototype.hasOwnProperty.call(graph.entityMd, entity)) return entity;
    const needle = entity.toLowerCase();
    const match =
      entities.find((e) => e.name.toLowerCase() === needle || e.aliases.some((a) => a.toLowerCase() === needle)) ??
      entities.find((e) => e.name.toLowerCase().includes(needle));
    return match ? match.rel : null;
  };

  return {
    async entityLookup({ query, kind, limit }) {
      const needle = (query ?? '').toLowerCase();
      return entities
        .filter((e) => !kind || e.kind.toLowerCase() === kind.toLowerCase())
        .filter((e) => needle.length === 0 || e.name.toLowerCase().includes(needle) || e.aliases.some((a) => a.toLowerCase().includes(needle)))
        .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
        .slice(0, limit ?? ENTITY_SCAN_LIMIT);
    },
    async claimsForEntity({ entity, limit }) {
      const rel = byRelName(entity);
      if (!rel) return [];
      return graph.claims.filter((c) => c.subject === rel).slice(0, limit ?? CLAIM_COLLECT_LIMIT);
    },
    async linkTraversal({ entity }) {
      const rel = byRelName(entity);
      if (!rel) return { outgoing: [], incoming: [] };
      const md = graph.entityMd[rel] ?? '';
      const outgoing: LinkHit[] = extractWikilinks(md).map((to) => ({ from: rel, to }));
      const incoming = graph.backlinks[rel] ?? [];
      return { outgoing, incoming };
    },
    async readNode({ rel }) {
      return graph.entityMd[rel] ?? null;
    },
    async readSource({ dir }) {
      const key = dir.endsWith('source.md') ? dir.slice(0, -'/source.md'.length) : dir;
      return graph.sourceMd[dir] ?? graph.sourceMd[key] ?? null;
    },
    async grep(): Promise<GrepHit[]> {
      return [];
    },
  };
}
