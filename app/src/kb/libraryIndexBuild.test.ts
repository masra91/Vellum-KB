import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildRecallVault, type RecallVault } from '../../test/recallVault';
import { rmTempDir } from '../../test/tempVault';
import { makeFakeLibraryIndexStore } from './libraryIndexFake';
import { rebuildLibraryIndexFull, applyVaultDiff } from './libraryIndexBuild';

describe('libraryIndexBuild — full rebuild', () => {
  let v: RecallVault;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
  });

  it('indexes entities, claims, sources, and outgoing links from the vault', async () => {
    v = await buildRecallVault();
    const store = makeFakeLibraryIndexStore();
    await rebuildLibraryIndexFull(store, v.root, 'HEAD1');

    expect(store.getMeta('lastIndexedHead')).toBe('HEAD1');
    expect(store.allEntities().map((e) => e.rel).sort()).toEqual([v.adaRel, v.engineRel].sort());
    expect(store.allClaims().map((c) => c.rel)).toEqual([v.claimRel]);
    expect(store.allSourceFiles().map((s) => s.rel)).toEqual([path.join(v.sourceDir, 'source.md')]);

    const ada = store.getEntity(v.adaRel)!;
    expect(ada.name).toBe('Ada Lovelace');
    expect(ada.aliases).toEqual(['Ada', 'Lovelace']);

    // Ada's node links to the engine — outgoing captured; engine links back — inverted incoming.
    expect(store.linksFrom(v.adaRel)).toContain(v.engineRel);
    expect(store.linksTo(v.adaRel)).toContain(v.engineRel);
  });

  it('skips a malformed entity file (no frontmatter) rather than throwing', async () => {
    v = await buildRecallVault();
    await fs.writeFile(path.join(v.root, 'entities', 'broken.md'), 'not a real node\n', 'utf8');
    const store = makeFakeLibraryIndexStore();
    await rebuildLibraryIndexFull(store, v.root, 'HEAD1');
    expect(store.getEntity(path.join('entities', 'broken.md'))).toBeNull();
    expect(store.allEntities().length).toBe(2); // ada + engine only
  });

  it('a rebuild clears stale rows from a previous build', async () => {
    v = await buildRecallVault();
    const store = makeFakeLibraryIndexStore();
    await rebuildLibraryIndexFull(store, v.root, 'HEAD1');
    await fs.rm(path.join(v.root, v.engineRel));
    await rebuildLibraryIndexFull(store, v.root, 'HEAD2');
    expect(store.getEntity(v.engineRel)).toBeNull();
    expect(store.allEntities().map((e) => e.rel)).toEqual([v.adaRel]);
  });
});

describe('libraryIndexBuild — incremental diff apply', () => {
  let v: RecallVault;
  afterEach(async () => {
    if (v) await rmTempDir(v.root);
  });

  it('re-indexes only the changed paths, leaving untouched rows intact', async () => {
    v = await buildRecallVault();
    const store = makeFakeLibraryIndexStore();
    await rebuildLibraryIndexFull(store, v.root, 'HEAD1');

    // Modify Ada's confidence via a raw rewrite (simulate a canonical-advance moving HEAD).
    const before = await fs.readFile(path.join(v.root, v.adaRel), 'utf8');
    await fs.writeFile(path.join(v.root, v.adaRel), before.replace('confidence: 0.92', 'confidence: 0.99'), 'utf8');

    await applyVaultDiff(store, v.root, [v.adaRel], 'HEAD2');

    expect(store.getEntity(v.adaRel)!.confidence).toBe(0.99);
    expect(store.getMeta('lastIndexedHead')).toBe('HEAD2');
    // The engine entity was never in the changed-paths list — untouched, still present.
    expect(store.getEntity(v.engineRel)).not.toBeNull();
  });

  it('a deleted file drops its row and its outgoing links', async () => {
    v = await buildRecallVault();
    const store = makeFakeLibraryIndexStore();
    await rebuildLibraryIndexFull(store, v.root, 'HEAD1');
    await fs.rm(path.join(v.root, v.engineRel));

    await applyVaultDiff(store, v.root, [v.engineRel], 'HEAD2');

    expect(store.getEntity(v.engineRel)).toBeNull();
    expect(store.linksFrom(v.engineRel)).toEqual([]);
    // Ada's own outgoing link to the (now-deleted) engine rel is untouched data (mirrors the live walk:
    // a dangling `[[target]]` isn't cleaned up by the target's removal — Health's dangling-link scan is
    // exactly what surfaces this).
    expect(store.linksFrom(v.adaRel)).toContain(v.engineRel);
  });

  it('a newly added file is picked up', async () => {
    v = await buildRecallVault();
    const store = makeFakeLibraryIndexStore();
    await rebuildLibraryIndexFull(store, v.root, 'HEAD1');

    const newSourceRel = path.join('sources', '2026', '06', '02', 'SRC2', 'source.md');
    await fs.mkdir(path.dirname(path.join(v.root, newSourceRel)), { recursive: true });
    await fs.writeFile(path.join(v.root, newSourceRel), '---\nid: SRC2\n---\n\nA new capture.\n', 'utf8');

    await applyVaultDiff(store, v.root, [newSourceRel], 'HEAD2');

    expect(store.getSourceFile(newSourceRel)?.body).toContain('A new capture.');
  });

  it('paths outside entities/claims/sources are ignored', async () => {
    v = await buildRecallVault();
    const store = makeFakeLibraryIndexStore();
    await rebuildLibraryIndexFull(store, v.root, 'HEAD1');
    await expect(applyVaultDiff(store, v.root, ['.kb/cache/foo.json', 'reviews/x/review.json'], 'HEAD2')).resolves.toBeUndefined();
    expect(store.getMeta('lastIndexedHead')).toBe('HEAD2');
  });
});
