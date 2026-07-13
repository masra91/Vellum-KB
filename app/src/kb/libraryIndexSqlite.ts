// The real `LibraryIndexStore` — better-sqlite3-backed, SPEC-0061 T1 (#530 slice 1). This is the ONLY
// file in the index seam that imports `better-sqlite3`; everything else (build logic, tool surface)
// programs against `LibraryIndexStore` (`libraryIndexTypes.ts`) so tests run against the in-memory fake
// instead (ENG-17 packaging checklist item 5 — vitest's Node ABI can't load a binding built for
// Electron's ABI). `better-sqlite3` itself has zero Electron dependency (a plain Node native module),
// so this file keeps the "engine can run in a plain Node daemon" property (`04-engineering-health.md`
// extractability verdict) — it is packaging (native-module ABI/asar) that requires the seam, not a
// platform coupling.
//
// Schema (the issue's suggested shape, minus what slice 1 has no consumer for — see
// `libraryIndexTypes.ts`'s header): entities, claims, source_files (doubles as the issue's
// "source_hashes" via `content_hash`, dedup-ready for a future capture slice), links (+ the inverted
// `idx_links_to` that IS the backlink index), and an FTS5 virtual table over every body — unused by
// slice 1's `grep` (equivalence-tested as a literal substring scan, see `libraryIndexTools.ts`) but
// populated now so the AC's follow-up composite `search()` tool has real full-text to query.
//
// The DB is a REBUILDABLE CACHE (ENG-17 item 7): `.kb/cache/library.db`, already covered by the vault's
// blanket `.kb/cache/` gitignore (`vault.ts`), never promoted, never git-truth. Corruption or a schema
// version bump both resolve the same way — delete the file and rebuild from the vault (git is truth).
import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LIBRARY_INDEX_SCHEMA_VERSION,
  type IndexedEntityRow,
  type IndexedClaimRow,
  type IndexedSourceFileRow,
  type LibraryIndexStore,
  type SearchBodyHit,
} from './libraryIndexTypes';

/** Vault-relative cache location (working zone — gitignored, never promoted; mirrors `perfIndex.ts`). */
export const LIBRARY_INDEX_REL = path.join('.kb', 'cache', 'library.db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS entities (
  rel TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL,
  confidence REAL NOT NULL,
  tags TEXT NOT NULL,
  derived_from TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  rel TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  statement TEXT NOT NULL,
  derived_from TEXT NOT NULL,
  mentions TEXT NOT NULL,
  relates_to TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_subject ON claims(subject);

CREATE TABLE IF NOT EXISTS source_files (
  rel TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  from_rel TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  PRIMARY KEY (from_rel, to_ref)
);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_ref);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_bodies USING fts5(rel UNINDEXED, source_kind UNINDEXED, body, tokenize='porter unicode61');
`;

function toJson(arr: string[]): string {
  return JSON.stringify(arr);
}
function fromJson(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

class SqliteLibraryIndexStore implements LibraryIndexStore {
  constructor(private readonly db: Database.Database) {}

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  isEmpty(): boolean {
    const row = this.db
      .prepare(
        'SELECT (SELECT COUNT(*) FROM entities) + (SELECT COUNT(*) FROM claims) + (SELECT COUNT(*) FROM source_files) AS n',
      )
      .get() as { n: number };
    return row.n === 0;
  }
  clearAll(): void {
    this.db.exec('DELETE FROM entities; DELETE FROM claims; DELETE FROM source_files; DELETE FROM links; DELETE FROM fts_bodies;');
  }
  close(): void {
    this.db.close();
  }

  upsertEntity(row: IndexedEntityRow): void {
    this.db
      .prepare(
        `INSERT INTO entities (rel, id, kind, name, aliases, confidence, tags, derived_from, body)
         VALUES (@rel, @id, @kind, @name, @aliases, @confidence, @tags, @derivedFrom, @body)
         ON CONFLICT(rel) DO UPDATE SET id=excluded.id, kind=excluded.kind, name=excluded.name, aliases=excluded.aliases,
           confidence=excluded.confidence, tags=excluded.tags, derived_from=excluded.derived_from, body=excluded.body`,
      )
      .run({ ...row, aliases: toJson(row.aliases), tags: toJson(row.tags), derivedFrom: toJson(row.derivedFrom) });
    this.db.prepare('DELETE FROM fts_bodies WHERE rel = ? AND source_kind = ?').run(row.rel, 'entity');
    this.db.prepare('INSERT INTO fts_bodies (rel, source_kind, body) VALUES (?, ?, ?)').run(row.rel, 'entity', row.body);
  }
  deleteEntity(rel: string): void {
    this.db.prepare('DELETE FROM entities WHERE rel = ?').run(rel);
    this.db.prepare('DELETE FROM fts_bodies WHERE rel = ? AND source_kind = ?').run(rel, 'entity');
  }

  upsertClaim(row: IndexedClaimRow): void {
    this.db
      .prepare(
        `INSERT INTO claims (rel, id, subject, status, confidence, statement, derived_from, mentions, relates_to, body)
         VALUES (@rel, @id, @subject, @status, @confidence, @statement, @derivedFrom, @mentions, @relatesTo, @body)
         ON CONFLICT(rel) DO UPDATE SET id=excluded.id, subject=excluded.subject, status=excluded.status,
           confidence=excluded.confidence, statement=excluded.statement, derived_from=excluded.derived_from,
           mentions=excluded.mentions, relates_to=excluded.relates_to, body=excluded.body`,
      )
      .run({ ...row, derivedFrom: toJson(row.derivedFrom), mentions: toJson(row.mentions), relatesTo: toJson(row.relatesTo) });
    this.db.prepare('DELETE FROM fts_bodies WHERE rel = ? AND source_kind = ?').run(row.rel, 'claim');
    this.db.prepare('INSERT INTO fts_bodies (rel, source_kind, body) VALUES (?, ?, ?)').run(row.rel, 'claim', row.body);
  }
  deleteClaim(rel: string): void {
    this.db.prepare('DELETE FROM claims WHERE rel = ?').run(rel);
    this.db.prepare('DELETE FROM fts_bodies WHERE rel = ? AND source_kind = ?').run(rel, 'claim');
  }

  upsertSourceFile(row: IndexedSourceFileRow): void {
    this.db
      .prepare(
        `INSERT INTO source_files (rel, body, content_hash) VALUES (@rel, @body, @contentHash)
         ON CONFLICT(rel) DO UPDATE SET body=excluded.body, content_hash=excluded.content_hash`,
      )
      .run(row);
    this.db.prepare('DELETE FROM fts_bodies WHERE rel = ? AND source_kind = ?').run(row.rel, 'source');
    this.db.prepare('INSERT INTO fts_bodies (rel, source_kind, body) VALUES (?, ?, ?)').run(row.rel, 'source', row.body);
  }
  deleteSourceFile(rel: string): void {
    this.db.prepare('DELETE FROM source_files WHERE rel = ?').run(rel);
    this.db.prepare('DELETE FROM fts_bodies WHERE rel = ? AND source_kind = ?').run(rel, 'source');
  }

  setLinksFrom(fromRel: string, toRefs: string[]): void {
    this.clearLinksFrom(fromRel);
    const insert = this.db.prepare('INSERT OR IGNORE INTO links (from_rel, to_ref) VALUES (?, ?)');
    for (const to of toRefs) insert.run(fromRel, to);
  }
  clearLinksFrom(fromRel: string): void {
    this.db.prepare('DELETE FROM links WHERE from_rel = ?').run(fromRel);
  }
  linksFrom(fromRel: string): string[] {
    return (this.db.prepare('SELECT to_ref FROM links WHERE from_rel = ?').all(fromRel) as { to_ref: string }[]).map((r) => r.to_ref);
  }
  linksTo(toRef: string): string[] {
    return (this.db.prepare('SELECT from_rel FROM links WHERE to_ref = ?').all(toRef) as { from_rel: string }[]).map((r) => r.from_rel);
  }

  getEntity(rel: string): IndexedEntityRow | null {
    const r = this.db.prepare('SELECT * FROM entities WHERE rel = ?').get(rel) as Record<string, unknown> | undefined;
    return r ? rowToEntity(r) : null;
  }
  getClaim(rel: string): IndexedClaimRow | null {
    const r = this.db.prepare('SELECT * FROM claims WHERE rel = ?').get(rel) as Record<string, unknown> | undefined;
    return r ? rowToClaim(r) : null;
  }
  getSourceFile(rel: string): IndexedSourceFileRow | null {
    const r = this.db.prepare('SELECT * FROM source_files WHERE rel = ?').get(rel) as Record<string, unknown> | undefined;
    return r ? rowToSourceFile(r) : null;
  }

  allEntities(): IndexedEntityRow[] {
    return (this.db.prepare('SELECT * FROM entities').all() as Record<string, unknown>[]).map(rowToEntity);
  }
  allClaims(): IndexedClaimRow[] {
    return (this.db.prepare('SELECT * FROM claims').all() as Record<string, unknown>[]).map(rowToClaim);
  }
  allSourceFiles(): IndexedSourceFileRow[] {
    return (this.db.prepare('SELECT * FROM source_files').all() as Record<string, unknown>[]).map(rowToSourceFile);
  }

  searchBodies(ftsQuery: string, limit: number): SearchBodyHit[] {
    // Column 2 = `body` (0=rel, 1=source_kind, both UNINDEXED) — the only column FTS5 actually indexes.
    // bm25() ascending IS "most relevant first" per FTS5's own documented convention; `rank` is stored
    // as-is so callers (and the fake store's approximation) share one "lower = better" contract.
    const rows = this.db
      .prepare(
        `SELECT rel, source_kind, snippet(fts_bodies, 2, '**', '**', '…', 12) AS snippet, bm25(fts_bodies) AS rank
         FROM fts_bodies WHERE fts_bodies MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as { rel: string; source_kind: 'entity' | 'claim' | 'source'; snippet: string; rank: number }[];
    return rows.map((r) => ({ rel: r.rel, sourceKind: r.source_kind, snippet: r.snippet, rank: r.rank }));
  }
}

function rowToEntity(r: Record<string, unknown>): IndexedEntityRow {
  return {
    rel: String(r.rel),
    id: String(r.id),
    kind: String(r.kind),
    name: String(r.name),
    aliases: fromJson(String(r.aliases)),
    confidence: Number(r.confidence),
    tags: fromJson(String(r.tags)),
    derivedFrom: fromJson(String(r.derived_from)),
    body: String(r.body),
  };
}
function rowToClaim(r: Record<string, unknown>): IndexedClaimRow {
  return {
    rel: String(r.rel),
    id: String(r.id),
    subject: String(r.subject),
    status: String(r.status),
    confidence: Number(r.confidence),
    statement: String(r.statement),
    derivedFrom: fromJson(String(r.derived_from)),
    mentions: fromJson(String(r.mentions)),
    relatesTo: fromJson(String(r.relates_to)),
    body: String(r.body),
  };
}
function rowToSourceFile(r: Record<string, unknown>): IndexedSourceFileRow {
  return { rel: String(r.rel), body: String(r.body), contentHash: String(r.content_hash) };
}

/**
 * Open (creating if absent) the sqlite-backed library index at `dbPath`. If the file exists but isn't a
 * valid/openable sqlite database (corruption — a killed write, disk fault, or a foreign file at that
 * path), it's deleted and recreated fresh: git is truth, so a corrupt CACHE is never worth preserving
 * or diagnosing, only replacing (ENG-17 item 7). A fresh store is empty, which `ensureLibraryIndexFresh`
 * (`libraryIndex.ts`) reads as "needs a full rebuild" — no special-casing needed here.
 */
export async function openSqliteLibraryIndexStore(dbPath: string): Promise<LibraryIndexStore> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  try {
    return openOnce(dbPath);
  } catch {
    await fs.rm(dbPath, { force: true });
    await fs.rm(dbPath + '-wal', { force: true });
    await fs.rm(dbPath + '-shm', { force: true });
    return openOnce(dbPath);
  }
}

function openOnce(dbPath: string): LibraryIndexStore {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // `quick_check` catches structural corruption a bare `new Database()` open can miss (SQLite opens
  // lazily) — surfaced here so the caller's catch-and-recreate above fires on a truly bad file, not
  // just a missing one.
  const check = db.pragma('quick_check', { simple: true }) as string;
  if (check !== 'ok') {
    db.close();
    throw new Error(`library index db failed quick_check: ${check}`);
  }
  db.exec(SCHEMA_SQL);
  const store = new SqliteLibraryIndexStore(db);
  const version = store.getMeta('__schemaDdlVersion');
  if (version !== String(LIBRARY_INDEX_SCHEMA_VERSION)) {
    // A DDL-shape bump with existing rows from an older shape: wipe rows (the DDL itself is additive/
    // idempotent via `IF NOT EXISTS` and won't pick up column changes across a real shape change — a
    // future bump that alters columns should ship a real migration; today's version 1 has none yet).
    store.clearAll();
    store.setMeta('__schemaDdlVersion', String(LIBRARY_INDEX_SCHEMA_VERSION));
  }
  return store;
}
