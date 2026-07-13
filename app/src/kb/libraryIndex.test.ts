// The freshness orchestrator (`ensureLibraryIndexFresh`) against a REAL git vault — the diff/rebuild
// branching only means anything relative to real commits and a real HEAD. Business-logic parsing is
// covered by `libraryIndexBuild.test.ts`'s fake-store tests; this file proves the seam: unchanged HEAD
// is a no-op, a moved HEAD applies an incremental diff (not a full rebuild), and version/empty triggers
// a full rebuild — via `clearAll()` call counts (rebuild always clears first; incremental diff never
// does), the cleanest signal that doesn't require mocking the module graph.
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { ensureGitIdentity } from './vault';
import { makeFakeLibraryIndexStore } from './libraryIndexFake';
import { ensureLibraryIndexFresh } from './libraryIndex';
import { META_SCHEMA_VERSION, META_LAST_INDEXED_HEAD } from './libraryIndexTypes';

/** A minimal committed vault: one entity, one commit — mirrors `canonicalAdvance.test.ts`'s fixture. */
async function makeGitVault(dir: string): Promise<string> {
  const root = path.join(dir, 'vault');
  await fs.mkdir(path.join(root, 'entities'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'entities', 'ada.md'),
    '---\nid: 01A\nkind: person\nname: Ada Lovelace\nconfidence: 0.9\naliases: []\n---\n\nAda.\n',
  );
  const git = simpleGit(root);
  await git.init(['--initial-branch=canon']);
  await ensureGitIdentity(git);
  await git.raw('add', '-A');
  await git.commit('seed');
  return root;
}

/** Wrap a fake store, counting `clearAll()` calls — the rebuild-vs-diff tell. */
function countingStore() {
  const inner = makeFakeLibraryIndexStore();
  let clearAllCalls = 0;
  return {
    store: { ...inner, clearAll: () => { clearAllCalls++; inner.clearAll(); } },
    clearAllCalls: () => clearAllCalls,
  };
}

describe.skipIf(!gitAvailable)('ensureLibraryIndexFresh', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rmTempDir(dir);
  });

  it('an empty store triggers a full rebuild and stamps schemaVersion + lastIndexedHead', async () => {
    dir = await makeTempDir('kb-libidx-');
    const root = await makeGitVault(dir);
    const { store, clearAllCalls } = countingStore();

    await ensureLibraryIndexFresh(store, root);

    expect(clearAllCalls()).toBe(1);
    expect(store.getMeta(META_SCHEMA_VERSION)).not.toBeNull();
    const head = (await simpleGit(root).revparse(['HEAD'])).trim();
    expect(store.getMeta(META_LAST_INDEXED_HEAD)).toBe(head);
    expect(store.getEntity(path.join('entities', 'ada.md'))?.name).toBe('Ada Lovelace');
  });

  it('an unchanged HEAD is a no-op — zero additional rebuilds or writes', async () => {
    dir = await makeTempDir('kb-libidx-');
    const root = await makeGitVault(dir);
    const { store, clearAllCalls } = countingStore();
    await ensureLibraryIndexFresh(store, root);
    expect(clearAllCalls()).toBe(1);

    await ensureLibraryIndexFresh(store, root);
    await ensureLibraryIndexFresh(store, root);
    expect(clearAllCalls()).toBe(1); // still just the first-ever rebuild
  });

  it('a moved HEAD applies an incremental diff, not a full rebuild', async () => {
    dir = await makeTempDir('kb-libidx-');
    const root = await makeGitVault(dir);
    const { store, clearAllCalls } = countingStore();
    await ensureLibraryIndexFresh(store, root);
    expect(clearAllCalls()).toBe(1);

    // A second commit that adds a new entity.
    await fs.writeFile(
      path.join(root, 'entities', 'engine.md'),
      '---\nid: 01B\nkind: concept\nname: Analytical Engine\nconfidence: 0.8\naliases: []\n---\n\nEngine.\n',
    );
    const git = simpleGit(root);
    await git.raw('add', '-A');
    await git.commit('add engine');
    const newHead = (await git.revparse(['HEAD'])).trim();

    await ensureLibraryIndexFresh(store, root);

    expect(clearAllCalls()).toBe(1); // NOT a rebuild — the diff path applied instead
    expect(store.getMeta(META_LAST_INDEXED_HEAD)).toBe(newHead);
    expect(store.getEntity(path.join('entities', 'engine.md'))?.name).toBe('Analytical Engine');
    expect(store.getEntity(path.join('entities', 'ada.md'))?.name).toBe('Ada Lovelace'); // untouched, still present
  });

  it('a stale/unreachable lastIndexedHead (history rewrite) falls back to a full rebuild', async () => {
    dir = await makeTempDir('kb-libidx-');
    const root = await makeGitVault(dir);
    const { store, clearAllCalls } = countingStore();
    await ensureLibraryIndexFresh(store, root);
    store.setMeta(META_LAST_INDEXED_HEAD, '0000000000000000000000000000000000000000'); // unreachable sha

    await ensureLibraryIndexFresh(store, root);

    expect(clearAllCalls()).toBe(2); // diff failed → recovered via rebuild
    expect(store.getEntity(path.join('entities', 'ada.md'))?.name).toBe('Ada Lovelace');
  });

  it('a non-git root is a silent no-op (nothing to index yet)', async () => {
    dir = await makeTempDir('kb-libidx-');
    const root = path.join(dir, 'not-a-repo');
    await fs.mkdir(root, { recursive: true });
    const { store, clearAllCalls } = countingStore();
    await expect(ensureLibraryIndexFresh(store, root)).resolves.toBeUndefined();
    expect(clearAllCalls()).toBe(0);
  });
});
