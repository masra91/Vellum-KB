// Serve the read-only `RecallTools` surface PURELY from a `LibraryIndexStore` — zero filesystem access
// (SPEC-0061 T1, #530 slice 1). Every filter/sort/match rule for the six granular tools is ported
// VERBATIM from `makeReadOnlyTools` (`recallTools.ts`) — same needle-matching, same "first match in scan
// order" entity resolution, same self-link exclusion on incoming traversal — so a projection-backed read
// is provably the SAME computation over the SAME parsed data, just sourced from the index instead of a
// live walk (the equivalence test in `libraryIndexTools.test.ts` pins this). Landed as a NEW file rather
// than a `recallTools.ts` edit (that file was Dev-5's active lane at the time #530 shipped).
//
// `search()` (#538, post-#530 follow-up) is genuinely NEW capability, not a ported one — the live vault
// walker has no equivalent (no FTS5), so there's nothing to port from. It's a composite, index-only
// capability: `RecallTools.search` is OPTIONAL, and `recall.ts`'s `buildRecallToolDefs` only registers
// it with the agent when present.
import path from 'node:path';
import type { RecallTools, EntityHit, ClaimHit, LinkHit, GrepHit, SearchResult, SearchEntityHit, SearchHit } from './recall';
import type { LibraryIndexStore, IndexedEntityRow, IndexedClaimRow } from './libraryIndexTypes';

const DEFAULT_ENTITY_LIMIT = 10;
const DEFAULT_CLAIM_LIMIT = 50;
const DEFAULT_GREP_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 8;
const SEARCH_CLAIMS_PER_ENTITY = 5;
const SEARCH_OVERFETCH_FACTOR = 3; // raw FTS hits fetched before entity-grouping/dedup collapses them

function toEntityHit(r: IndexedEntityRow): EntityHit {
  return { rel: r.rel, id: r.id, kind: r.kind, name: r.name, aliases: r.aliases, confidence: r.confidence, tags: r.tags, derivedFrom: r.derivedFrom };
}
function toClaimHit(r: IndexedClaimRow): ClaimHit {
  return {
    rel: r.rel,
    id: r.id,
    subject: r.subject,
    status: r.status,
    confidence: r.confidence,
    statement: r.statement,
    derivedFrom: r.derivedFrom,
    mentions: r.mentions,
    relatesTo: r.relatesTo,
  };
}

/** Same "rel-path OR name/alias" resolution as `recallTools.ts`'s private `resolveEntityRel`, minus the
 *  fs/containment check (a rel already present in the index was containment-checked when it was WRITTEN
 *  — see `libraryIndexBuild.ts`, which only ever reads via `walkVaultFiles` under `entities/`). */
function resolveEntityRel(store: LibraryIndexStore, entity: string): string | null {
  if (typeof entity !== 'string' || entity.length === 0) return null;
  if (entity.includes('/') && entity.endsWith('.md') && store.getEntity(entity)) return entity;
  const needle = entity.toLowerCase();
  const ents = store.allEntities();
  const match =
    ents.find((e) => e.name.toLowerCase() === needle || e.aliases.some((a) => a.toLowerCase() === needle)) ??
    ents.find((e) => e.name.toLowerCase().includes(needle));
  return match ? match.rel : null;
}

/** Turn a raw, untrusted user query into an FTS5-safe MATCH expression: each whitespace-delimited token
 *  is individually double-quoted (escaping any embedded quote), so FTS5's query syntax (`AND`/`OR`/`NOT`/
 *  `NEAR`/`-prefix`/`*suffix`/column filters) can never be injected by the query text — the query is
 *  always treated as literal terms, space-joined (FTS5's implicit AND across bare terms still applies to
 *  quoted phrase-tokens). Empty/whitespace-only input returns `''` (the caller short-circuits on that,
 *  matching `grep`'s empty-pattern behavior). Exported for the equivalence tests. */
export function sanitizeFtsQuery(raw: string): string {
  return (raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/** Build the read-only recall tool surface PURELY from the library index — zero fs reads. */
export function makeIndexTools(store: LibraryIndexStore): RecallTools {
  return {
    async entityLookup({ query, kind, limit }): Promise<EntityHit[]> {
      const needle = (query ?? '').toLowerCase();
      return store
        .allEntities()
        .filter((e) => !kind || e.kind.toLowerCase() === kind.toLowerCase())
        .filter((e) => needle.length === 0 || e.name.toLowerCase().includes(needle) || e.aliases.some((a) => a.toLowerCase().includes(needle)))
        .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name))
        .slice(0, limit ?? DEFAULT_ENTITY_LIMIT)
        .map(toEntityHit);
    },

    async claimsForEntity({ entity, limit }): Promise<ClaimHit[]> {
      const rel = resolveEntityRel(store, entity);
      if (!rel) return [];
      return store
        .allClaims()
        .filter((c) => c.subject === rel)
        .slice(0, limit ?? DEFAULT_CLAIM_LIMIT)
        .map(toClaimHit);
    },

    async linkTraversal({ entity }): Promise<{ outgoing: LinkHit[]; incoming: LinkHit[] }> {
      const rel = resolveEntityRel(store, entity);
      if (!rel) return { outgoing: [], incoming: [] };
      const outgoing: LinkHit[] = store.linksFrom(rel).map((to) => ({ from: rel, to }));
      // Mirror the live walker's `if (fileRel === rel) continue` — a self-link never counts as incoming.
      const incoming: LinkHit[] = store
        .linksTo(rel)
        .filter((from) => from !== rel)
        .map((from) => ({ from, to: rel }));
      return { outgoing, incoming };
    },

    async readNode({ rel }): Promise<string | null> {
      const r = typeof rel === 'string' ? rel : '';
      if (r.startsWith('entities/') || r.startsWith('entities' + path.sep)) return store.getEntity(r)?.body ?? null;
      if (r.startsWith('claims/') || r.startsWith('claims' + path.sep)) return store.getClaim(r)?.body ?? null;
      return null; // read-only surface: only entity/claim docs via readNode
    },

    async readSource({ dir }): Promise<string | null> {
      if (typeof dir !== 'string' || dir.length === 0) return null;
      const rel = dir.endsWith('source.md') ? dir : path.join(dir, 'source.md');
      if (!(rel === 'sources' || rel.startsWith('sources/') || rel.startsWith('sources' + path.sep))) return null;
      return store.getSourceFile(rel)?.body ?? null;
    },

    async grep({ pattern, limit }): Promise<GrepHit[]> {
      const needle = (pattern ?? '').toLowerCase();
      if (needle.length === 0) return [];
      const cap = limit ?? DEFAULT_GREP_LIMIT;
      const hits: GrepHit[] = [];
      // Deterministic scan order (rel-sorted per group) — the live fs walker's `readdir` order is OS-
      // dependent/unspecified to begin with, so imposing a stable order here is a strict improvement,
      // not a behavior change a caller could observe as a regression.
      const bySources = [...store.allSourceFiles()].sort((a, b) => a.rel.localeCompare(b.rel));
      const byEntities = [...store.allEntities()].sort((a, b) => a.rel.localeCompare(b.rel));
      const byClaims = [...store.allClaims()].sort((a, b) => a.rel.localeCompare(b.rel));
      const groups: Array<{ rel: string; body: string }[]> = [bySources, byEntities, byClaims];
      outer: for (const group of groups) {
        for (const { rel, body } of group) {
          if (hits.length >= cap) break outer;
          const lines = body.split('\n');
          for (let i = 0; i < lines.length && hits.length < cap; i++) {
            if (lines[i].toLowerCase().includes(needle)) hits.push({ rel, line: i + 1, text: lines[i].trim() });
          }
        }
      }
      return hits;
    },

    async search({ query, limit }): Promise<SearchResult> {
      const ftsQuery = sanitizeFtsQuery(query ?? '');
      if (ftsQuery.length === 0) return { entities: [], claims: [], sources: [] };
      const cap = limit ?? DEFAULT_SEARCH_LIMIT;
      // Overfetch: raw hits collapse when several belong to the same entity (its body match + a claim
      // match that also gets folded in) or are skipped as stale index rows — fetch a multiple of `cap`
      // so the FINAL assembled result still has up to `cap` items, not fewer than requested.
      const raw = store.searchBodies(ftsQuery, cap * SEARCH_OVERFETCH_FACTOR);

      // Every entity the query matched at all (independent of the cap below) — a claim whose SUBJECT is
      // one of these gets folded into that entity's `.claims` instead of listed standalone, so the same
      // fact never appears twice in one result.
      const matchedEntityRels = new Set(raw.filter((h) => h.sourceKind === 'entity').map((h) => h.rel));

      const entities: SearchEntityHit[] = [];
      const seenEntityRels = new Set<string>();
      const claims: SearchHit[] = [];
      const sources: SearchHit[] = [];

      for (const hit of raw) {
        if (entities.length + claims.length + sources.length >= cap) break;
        if (hit.sourceKind === 'entity') {
          if (seenEntityRels.has(hit.rel)) continue;
          const row = store.getEntity(hit.rel);
          if (!row) continue; // stale FTS row (deleted since last index maintenance) — skip, don't throw
          seenEntityRels.add(hit.rel);
          const entityClaims = store
            .allClaims()
            .filter((c) => c.subject === hit.rel)
            .slice(0, SEARCH_CLAIMS_PER_ENTITY)
            .map(toClaimHit);
          const incoming = store
            .linksTo(hit.rel)
            .filter((from) => from !== hit.rel)
            .map((from) => ({ from, to: hit.rel }));
          entities.push({ entity: toEntityHit(row), snippet: hit.snippet, claims: entityClaims, incoming });
        } else if (hit.sourceKind === 'claim') {
          const row = store.getClaim(hit.rel);
          if (!row) continue;
          if (matchedEntityRels.has(row.subject)) continue; // already folded into (or covered by) an entity hit
          claims.push({ kind: 'claim', rel: hit.rel, label: row.statement, snippet: hit.snippet });
        } else {
          const row = store.getSourceFile(hit.rel);
          if (!row) continue;
          sources.push({ kind: 'source', rel: hit.rel, label: hit.rel, snippet: hit.snippet });
        }
      }
      return { entities, claims, sources };
    },
  };
}
