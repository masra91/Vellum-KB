// Serve the read-only `RecallTools` surface PURELY from a `LibraryIndexStore` — zero filesystem access
// (SPEC-0061 T1, #530 slice 1). Every filter/sort/match rule below is ported VERBATIM from
// `makeReadOnlyTools` (`recallTools.ts`) — same needle-matching, same "first match in scan order" entity
// resolution, same self-link exclusion on incoming traversal — so a projection-backed read is provably
// the SAME computation over the SAME parsed data, just sourced from the index instead of a live walk
// (the equivalence test in `libraryIndexTools.test.ts` pins this). Deliberately landed as a NEW file
// rather than a `recallTools.ts` edit: that file is Dev-5's active lane this wave (#513's per-question
// memo). The production call-site swap (where `recall.ts` builds its tools) is a tracked fast-follow
// once that lane lands — see the PR description.
import path from 'node:path';
import type { RecallTools, EntityHit, ClaimHit, LinkHit, GrepHit } from './recall';
import type { LibraryIndexStore, IndexedEntityRow, IndexedClaimRow } from './libraryIndexTypes';

const DEFAULT_ENTITY_LIMIT = 10;
const DEFAULT_CLAIM_LIMIT = 50;
const DEFAULT_GREP_LIMIT = 50;

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
  };
}
