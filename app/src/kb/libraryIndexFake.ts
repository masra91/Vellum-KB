// In-memory `LibraryIndexStore` fake (ENG-17 packaging checklist item 5) — every unit test drives this,
// never the real better-sqlite3 store, so tests never depend on a native binding matching the runtime
// ABI. Deliberately dumb (plain `Map`s, linear scans on bulk reads): correctness over speed, since the
// business logic under test lives in `libraryIndexTools.ts`/`libraryIndexBuild.ts`, not here.
import type { IndexedEntityRow, IndexedClaimRow, IndexedSourceFileRow, LibraryIndexStore, SearchBodyHit } from './libraryIndexTypes';

/** Recover the plain tokens `sanitizeFtsQuery` (`libraryIndexTools.ts`) quoted, e.g. `"foo" "bar"` → `['foo','bar']`. */
function tokensFromFtsQuery(ftsQuery: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"]|"")*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ftsQuery)) !== null) out.push(m[1].replace(/""/g, '"').toLowerCase());
  return out;
}

/** A naive case-insensitive multi-token substring scorer + snippet builder — approximates bm25 well
 *  enough for tests to exercise the composite-assembly LOGIC in `libraryIndexTools.ts` (which
 *  entities/claims/sources get joined, in what shape). Ranking QUALITY itself is only meaningfully
 *  tested against the real sqlite store (`libraryIndexSqlite.test.ts`) — this fake follows the same
 *  "lower rank = more relevant" contract (negated hit count) purely so both implementations sort the
 *  same direction. */
function scoreAndSnippet(body: string, tokens: string[]): { rank: number; snippet: string } | null {
  const lower = body.toLowerCase();
  let hits = 0;
  let firstIdx = -1;
  let firstLen = 0;
  for (const t of tokens) {
    let idx = lower.indexOf(t);
    while (idx !== -1) {
      hits++;
      if (firstIdx === -1) {
        firstIdx = idx;
        firstLen = t.length;
      }
      idx = lower.indexOf(t, idx + 1);
    }
  }
  if (hits === 0) return null;
  const start = Math.max(0, firstIdx - 40);
  const end = Math.min(body.length, firstIdx + firstLen + 60);
  // '**'-wrap the matched span so the snippet carries the same highlight-marker contract the real
  // sqlite store's FTS5 `snippet()` produces (see libraryIndexSqlite.ts) — callers shouldn't have to
  // branch on which store is behind the tool surface.
  const before = body.slice(start, firstIdx);
  const match = body.slice(firstIdx, firstIdx + firstLen);
  const after = body.slice(firstIdx + firstLen, end);
  const snippet = `${start > 0 ? '…' : ''}${before}**${match}**${after}`.trim() + (end < body.length ? '…' : '');
  return { rank: -hits, snippet };
}

export function makeFakeLibraryIndexStore(): LibraryIndexStore {
  const meta = new Map<string, string>();
  const entities = new Map<string, IndexedEntityRow>();
  const claims = new Map<string, IndexedClaimRow>();
  const sources = new Map<string, IndexedSourceFileRow>();
  const linksFrom = new Map<string, string[]>();

  return {
    getMeta: (key) => meta.get(key) ?? null,
    setMeta: (key, value) => void meta.set(key, value),

    isEmpty: () => entities.size === 0 && claims.size === 0 && sources.size === 0,
    clearAll: () => {
      entities.clear();
      claims.clear();
      sources.clear();
      linksFrom.clear();
    },
    close: () => {},

    upsertEntity: (row) => void entities.set(row.rel, { ...row, aliases: [...row.aliases], tags: [...row.tags], derivedFrom: [...row.derivedFrom] }),
    deleteEntity: (rel) => void entities.delete(rel),
    upsertClaim: (row) =>
      void claims.set(row.rel, { ...row, derivedFrom: [...row.derivedFrom], mentions: [...row.mentions], relatesTo: [...row.relatesTo] }),
    deleteClaim: (rel) => void claims.delete(rel),
    upsertSourceFile: (row) => void sources.set(row.rel, { ...row }),
    deleteSourceFile: (rel) => void sources.delete(rel),

    setLinksFrom: (fromRel, toRefs) => void linksFrom.set(fromRel, [...toRefs]),
    clearLinksFrom: (fromRel) => void linksFrom.delete(fromRel),
    linksFrom: (fromRel) => [...(linksFrom.get(fromRel) ?? [])],
    linksTo: (toRef) => {
      const out: string[] = [];
      for (const [from, tos] of linksFrom) if (tos.includes(toRef)) out.push(from);
      return out;
    },

    getEntity: (rel) => entities.get(rel) ?? null,
    getClaim: (rel) => claims.get(rel) ?? null,
    getSourceFile: (rel) => sources.get(rel) ?? null,

    allEntities: () => [...entities.values()],
    allClaims: () => [...claims.values()],
    allSourceFiles: () => [...sources.values()],

    searchBodies: (ftsQuery, limit) => {
      const tokens = tokensFromFtsQuery(ftsQuery);
      if (tokens.length === 0) return [];
      const hits: SearchBodyHit[] = [];
      for (const e of entities.values()) {
        const s = scoreAndSnippet(e.body, tokens);
        if (s) hits.push({ rel: e.rel, sourceKind: 'entity', snippet: s.snippet, rank: s.rank });
      }
      for (const c of claims.values()) {
        const s = scoreAndSnippet(c.body, tokens);
        if (s) hits.push({ rel: c.rel, sourceKind: 'claim', snippet: s.snippet, rank: s.rank });
      }
      for (const src of sources.values()) {
        const s = scoreAndSnippet(src.body, tokens);
        if (s) hits.push({ rel: src.rel, sourceKind: 'source', snippet: s.snippet, rank: s.rank });
      }
      hits.sort((a, b) => a.rank - b.rank || a.rel.localeCompare(b.rel));
      return hits.slice(0, limit);
    },
  };
}
