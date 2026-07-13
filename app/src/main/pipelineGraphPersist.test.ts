// #508 item 4 — graph-projection persistence: body-stripped on disk, content-hash-gated writes, async
// load. These three helpers are pure given a `vaultPath` string (no `active` pipeline state), so they're
// directly testable without the heavy `startPipeline` machinery.
import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { graphProjectionPath, loadGraphProjection, saveGraphProjection, stripBodiesForPersist } from './pipeline';
import type { GraphProjection } from '../kb/graphProjection';

function fixture(overrides: Partial<GraphProjection> = {}): GraphProjection {
  return {
    entities: [{ rel: 'entities/person/ada.md', id: 'E1', kind: 'person', name: 'Ada', aliases: [], confidence: 0.9, tags: [], derivedFrom: [] }],
    entityMd: { 'entities/person/ada.md': '# Ada\n\nfull body markdown here' },
    backlinks: { 'entities/person/ada.md': [] },
    claims: [{ rel: 'claims/person/ada.md', id: 'C1', subject: 'entities/person/ada.md', status: 'fact', confidence: 0.8, statement: 'x', derivedFrom: [], mentions: [], relatesTo: [] }],
    sourceMd: { 'sources/2026/01/S1': '# Source\n\nfull source markdown here' },
    builtAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('stripBodiesForPersist', () => {
  it('empties entityMd/sourceMd, preserves everything else', () => {
    const g = fixture();
    const stripped = stripBodiesForPersist(g);
    expect(stripped.entityMd).toEqual({});
    expect(stripped.sourceMd).toEqual({});
    expect(stripped.entities).toEqual(g.entities);
    expect(stripped.claims).toEqual(g.claims);
    expect(stripped.backlinks).toEqual(g.backlinks);
  });
});

describe('saveGraphProjection / loadGraphProjection (#508 item 4)', () => {
  it('persists a BODY-STRIPPED graph — entities/claims/backlinks survive the round-trip, bodies do not', async () => {
    const dir = await makeTempDir('kb-graphpersist-');
    try {
      const g = fixture();
      await saveGraphProjection(dir, g);
      const onDisk = JSON.parse(await fs.readFile(graphProjectionPath(dir), 'utf8')) as GraphProjection;
      expect(onDisk.entityMd).toEqual({});
      expect(onDisk.sourceMd).toEqual({});
      expect(onDisk.entities).toEqual(g.entities);
      expect(onDisk.claims).toEqual(g.claims);

      const loaded = await loadGraphProjection(dir);
      expect(loaded).toEqual(onDisk);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('loadGraphProjection returns null for a missing or corrupt file', async () => {
    const dir = await makeTempDir('kb-graphpersist-');
    try {
      expect(await loadGraphProjection(dir)).toBeNull(); // never written
      await fs.mkdir(path.dirname(graphProjectionPath(dir)), { recursive: true });
      await fs.writeFile(graphProjectionPath(dir), 'not json', 'utf8');
      expect(await loadGraphProjection(dir)).toBeNull(); // corrupt
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a second save with IDENTICAL content (only builtAt differs) skips the write entirely (content-hash gate)', async () => {
    const dir = await makeTempDir('kb-graphpersist-');
    try {
      await saveGraphProjection(dir, fixture({ builtAt: 'T0' }));
      const mtime1 = (await fs.stat(graphProjectionPath(dir))).mtimeMs;

      const spy = vi.spyOn(fs, 'writeFile');
      try {
        // Same entities/claims/backlinks/bodies, only `builtAt` changed — the persisted (body-stripped,
        // builtAt-excluded) content hash is identical, so this must be a pure no-op.
        await saveGraphProjection(dir, fixture({ builtAt: 'T1' }));
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const mtime2 = (await fs.stat(graphProjectionPath(dir))).mtimeMs;
      expect(mtime2).toBe(mtime1); // untouched on disk
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a save whose STRUCTURAL content changed (e.g. a new entity) still writes', async () => {
    const dir = await makeTempDir('kb-graphpersist-');
    try {
      await saveGraphProjection(dir, fixture({ builtAt: 'T0' }));
      const changed = fixture({
        builtAt: 'T1',
        entities: [...fixture().entities, { rel: 'entities/person/bob.md', id: 'E2', kind: 'person', name: 'Bob', aliases: [], confidence: 0.5, tags: [], derivedFrom: [] }],
      });
      const spy = vi.spyOn(fs, 'writeFile');
      try {
        await saveGraphProjection(dir, changed);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      const onDisk = JSON.parse(await fs.readFile(graphProjectionPath(dir), 'utf8')) as GraphProjection;
      expect(onDisk.entities).toHaveLength(2);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('two different vault paths never share the content-hash gate (no cross-vault false skip)', async () => {
    const dirA = await makeTempDir('kb-graphpersist-a-');
    const dirB = await makeTempDir('kb-graphpersist-b-');
    try {
      await saveGraphProjection(dirA, fixture({ builtAt: 'T0' }));
      // Byte-identical content, but a DIFFERENT vault path — must still write (it's a distinct vault's
      // cache file, not yet on disk at dirB, regardless of dirA's hash).
      const spy = vi.spyOn(fs, 'writeFile');
      try {
        await saveGraphProjection(dirB, fixture({ builtAt: 'T0' }));
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(await loadGraphProjection(dirB)).not.toBeNull();
    } finally {
      await rmTempDir(dirA);
      await rmTempDir(dirB);
    }
  });
});
