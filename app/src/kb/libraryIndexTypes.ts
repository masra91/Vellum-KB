// The `LibraryIndexStore` abstraction (SPEC-0061 T1, #530 slice 1) — the ONE interface every consumer
// (build logic, the read-only tool surface) programs against. Two implementations exist:
// `libraryIndexSqlite.ts` (the real better-sqlite3-backed store) and `libraryIndexFake.ts` (a plain
// in-memory fake used by every unit test). This wrap is deliberate (ENG-17 packaging checklist item 5):
// vitest runs under the Node ABI while the packaged app runs under the Electron ABI, so a native
// `.node` binding compiled for one cannot load under the other — tests that went straight at
// better-sqlite3 would need a matching rebuild per ABI just to run. Programming to this interface means
// no test ever touches the native module, and it doubles as the seam that keeps the engine able to run
// in a plain Node daemon (the extractability verdict, `04-engineering-health.md`): swap the store, not
// the engine.
//
// Row shapes mirror the parsed vault types (`EntityHit`/`ClaimHit` in `recall.ts`, `ParsedClaim` in
// `recallTools.ts`) plus the raw `body` text each row was parsed from (so `readNode`/`readSource`/`grep`
// serve from the index with zero fs reads). `contested` (claim dispute state, SPEC-0036 CONTRA) and
// `audit_events` from the issue's suggested schema are deliberately OUT of slice 1: no slice-1 consumer
// (recall tools, Health) reads either, and audit_events is explicitly called out as slice-2 scope in the
// issue body — adding unused columns/tables now would be schema debt with no consumer to prove it against.

export interface IndexedEntityRow {
  rel: string;
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  confidence: number;
  tags: string[];
  derivedFrom: string[];
  body: string;
}

export interface IndexedClaimRow {
  rel: string;
  id: string;
  subject: string; // entity rel-path
  status: string;
  confidence: number;
  statement: string;
  derivedFrom: string[];
  mentions: string[];
  relatesTo: string[];
  body: string;
}

/** One `.md`/`.txt` file under `sources/` (usually `<dir>/source.md`, but the live `grep` walker
 *  scans every matching file in the subtree, not just `source.md` — this mirrors that exactly). */
export interface IndexedSourceFileRow {
  rel: string; // repo-relative path, e.g. `sources/2026-07-01-foo/source.md`
  body: string;
  contentHash: string; // sha256 of body — capture-dedup ready (the issue's "source_hashes"), unused by slice 1 reads
}

/** The store's persisted DB-shape version. Bump on any schema change so an old on-disk cache is
 *  discarded (delete+rebuild) instead of silently misread. */
export const LIBRARY_INDEX_SCHEMA_VERSION = 1;

/** Reserved `meta` keys every store implementation must honor. */
export const META_SCHEMA_VERSION = 'schemaVersion';
export const META_LAST_INDEXED_HEAD = 'lastIndexedHead';

/**
 * DB-agnostic read/write surface over the library index. Every method is SYNCHRONOUS (both
 * implementations are: better-sqlite3 is sync-only by design; the in-memory fake trivially is too) —
 * keeping the interface sync avoids implying I/O concurrency semantics neither implementation has.
 */
export interface LibraryIndexStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  /** True iff the store holds no entity/claim/source rows (a fresh or just-cleared DB). */
  isEmpty(): boolean;
  /** Wipe every row (entities/claims/sources/links) but keep the store open. Meta is NOT cleared by
   *  this alone — callers reset `lastIndexedHead`/`schemaVersion` explicitly after a full rebuild. */
  clearAll(): void;
  close(): void;

  upsertEntity(row: IndexedEntityRow): void;
  deleteEntity(rel: string): void;
  upsertClaim(row: IndexedClaimRow): void;
  deleteClaim(rel: string): void;
  upsertSourceFile(row: IndexedSourceFileRow): void;
  deleteSourceFile(rel: string): void;

  /** Replace the full outgoing-link set for `fromRel` (an entity or claim body's `[[targets]]`, as
   *  literally written — unresolved). Powers both outgoing (`linksFrom`) and the inverted incoming
   *  index (`linksTo`). */
  setLinksFrom(fromRel: string, toRefs: string[]): void;
  /** Remove every link row sourced from `fromRel` (called before delete/re-index of that file). */
  clearLinksFrom(fromRel: string): void;
  linksFrom(fromRel: string): string[];
  linksTo(toRef: string): string[];

  getEntity(rel: string): IndexedEntityRow | null;
  getClaim(rel: string): IndexedClaimRow | null;
  getSourceFile(rel: string): IndexedSourceFileRow | null;

  /** Bulk reads — the tool surface applies the SAME filter/sort/match logic `recallTools.ts` uses, in
   *  JS, over these; keeping that logic in one place (not duplicated into SQL) is what makes the
   *  equivalence tests a straightforward byte-for-byte comparison instead of two implementations of
   *  the same matching rules that can quietly drift. */
  allEntities(): IndexedEntityRow[];
  allClaims(): IndexedClaimRow[];
  allSourceFiles(): IndexedSourceFileRow[];

  /**
   * Ranked full-text search over EVERY indexed body — entities, claims, and source files together
   * (SPEC-0061 T1 follow-up, #538). `ftsQuery` is caller-sanitized (token-quoted so raw user input can't
   * inject FTS5 query syntax — see `libraryIndexTools.ts`'s `sanitizeFtsQuery`); this method just runs
   * it. `rank` follows bm25 convention (LOWER = more relevant); the fake store's naive approximation
   * follows the same convention so callers never branch on which store they're talking to.
   */
  searchBodies(ftsQuery: string, limit: number): SearchBodyHit[];
}

/** One ranked hit from `searchBodies` — a rel-keyed row (entity/claim/source) plus a rendered snippet
 *  showing the matched text in context. */
export interface SearchBodyHit {
  rel: string;
  sourceKind: 'entity' | 'claim' | 'source';
  snippet: string;
  rank: number;
}
