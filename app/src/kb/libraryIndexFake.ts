// In-memory `LibraryIndexStore` fake (ENG-17 packaging checklist item 5) — every unit test drives this,
// never the real better-sqlite3 store, so tests never depend on a native binding matching the runtime
// ABI. Deliberately dumb (plain `Map`s, linear scans on bulk reads): correctness over speed, since the
// business logic under test lives in `libraryIndexTools.ts`/`libraryIndexBuild.ts`, not here.
import type { IndexedEntityRow, IndexedClaimRow, IndexedSourceFileRow, LibraryIndexStore } from './libraryIndexTypes';

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
  };
}
