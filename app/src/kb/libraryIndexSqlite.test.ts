// The ONE test file that touches the real better-sqlite3 native module (ENG-17 item 5 — every other
// test drives the in-memory fake). This runs fine under vitest because vitest executes under the same
// Node ABI the module was installed/built against; the packaged app's Electron-ABI rebuild is a
// packaging-time concern (`vite.main.config.ts` externalization + the CI package-job assertion), not a
// test-time one.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { openSqliteLibraryIndexStore } from './libraryIndexSqlite';

describe('openSqliteLibraryIndexStore', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rmTempDir(dir);
  });

  it('creates the db file + schema, and round-trips every row shape', async () => {
    dir = await makeTempDir('kb-sqlite-');
    const dbPath = path.join(dir, 'library.db');
    const store = await openSqliteLibraryIndexStore(dbPath);
    try {
      expect(store.isEmpty()).toBe(true);

      store.upsertEntity({
        rel: 'entities/a.md',
        id: '01A',
        kind: 'person',
        name: 'Ada',
        aliases: ['A'],
        confidence: 0.9,
        tags: ['t'],
        derivedFrom: ['sources/x'],
        body: 'Ada body',
      });
      store.setLinksFrom('entities/a.md', ['entities/b.md']);
      store.upsertClaim({
        rel: 'claims/a.md',
        id: '01C',
        subject: 'entities/a.md',
        status: 'fact',
        confidence: 0.8,
        statement: 'stmt',
        derivedFrom: ['sources/x'],
        mentions: ['m'],
        relatesTo: ['r'],
        body: 'claim body',
      });
      store.upsertSourceFile({ rel: 'sources/x/source.md', body: 'source body', contentHash: 'abc' });
      store.setMeta('lastIndexedHead', 'deadbeef');

      expect(store.isEmpty()).toBe(false);
      expect(store.getEntity('entities/a.md')).toEqual({
        rel: 'entities/a.md',
        id: '01A',
        kind: 'person',
        name: 'Ada',
        aliases: ['A'],
        confidence: 0.9,
        tags: ['t'],
        derivedFrom: ['sources/x'],
        body: 'Ada body',
      });
      expect(store.linksFrom('entities/a.md')).toEqual(['entities/b.md']);
      expect(store.linksTo('entities/b.md')).toEqual(['entities/a.md']);
      expect(store.getClaim('claims/a.md')?.statement).toBe('stmt');
      expect(store.getSourceFile('sources/x/source.md')?.contentHash).toBe('abc');
      expect(store.getMeta('lastIndexedHead')).toBe('deadbeef');

      store.deleteEntity('entities/a.md');
      expect(store.getEntity('entities/a.md')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('clearAll empties every table without closing the store', async () => {
    dir = await makeTempDir('kb-sqlite-');
    const store = await openSqliteLibraryIndexStore(path.join(dir, 'library.db'));
    try {
      store.upsertEntity({ rel: 'entities/a.md', id: '1', kind: 'k', name: 'n', aliases: [], confidence: 0, tags: [], derivedFrom: [], body: 'b' });
      expect(store.isEmpty()).toBe(false);
      store.clearAll();
      expect(store.isEmpty()).toBe(true);
    } finally {
      store.close();
    }
  });

  it('recovers from a corrupt db file by deleting and recreating it', async () => {
    dir = await makeTempDir('kb-sqlite-');
    const dbPath = path.join(dir, 'library.db');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(dbPath, 'this is not a sqlite database\x00\x01\x02garbage', 'utf8');

    const store = await openSqliteLibraryIndexStore(dbPath);
    try {
      expect(store.isEmpty()).toBe(true); // recovered fresh, not thrown
      store.upsertEntity({ rel: 'entities/a.md', id: '1', kind: 'k', name: 'n', aliases: [], confidence: 0, tags: [], derivedFrom: [], body: 'b' });
      expect(store.getEntity('entities/a.md')?.name).toBe('n');
    } finally {
      store.close();
    }
  });

  it('re-opening an existing valid db preserves prior rows', async () => {
    dir = await makeTempDir('kb-sqlite-');
    const dbPath = path.join(dir, 'library.db');
    const s1 = await openSqliteLibraryIndexStore(dbPath);
    s1.upsertEntity({ rel: 'entities/a.md', id: '1', kind: 'k', name: 'persisted', aliases: [], confidence: 0, tags: [], derivedFrom: [], body: 'b' });
    s1.close();

    const s2 = await openSqliteLibraryIndexStore(dbPath);
    try {
      expect(s2.getEntity('entities/a.md')?.name).toBe('persisted');
    } finally {
      s2.close();
    }
  });
});
