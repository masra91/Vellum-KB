// Main-process runtime for the library index (SPEC-0061 T1, #530 slice 1) — opens (or reuses) the
// on-disk sqlite store per vault root, brings it up to date with the canonical HEAD before every read
// (cheap when already fresh — one HEAD read + one meta lookup, see `libraryIndex.ts`), and hands back
// the index-backed `RecallTools` surface. Deliberately NOT wired into `pipeline.ts`'s
// `startActiveStages`/`stopAllStages` lifecycle in this slice — that file is the highest-churn file in
// the repo (92 commits/90d per the deep review) and several wave-1 lanes touch it; a store per open
// root, closed only at process exit, is a negligible resource cost (one sqlite file handle) worth
// accepting to avoid a cross-lane edit here. Wiring proper open/close to vault-switch is a tracked
// fast-follow.
import path from 'node:path';
import { openSqliteLibraryIndexStore, LIBRARY_INDEX_REL } from '../kb/libraryIndexSqlite';
import { ensureLibraryIndexFresh } from '../kb/libraryIndex';
import { makeIndexTools } from '../kb/libraryIndexTools';
import type { RecallTools } from '../kb/recall';
import type { LibraryIndexStore } from '../kb/libraryIndexTypes';

const openStores = new Map<string, Promise<LibraryIndexStore>>();

function storeFor(root: string): Promise<LibraryIndexStore> {
  const resolved = path.resolve(root);
  let p = openStores.get(resolved);
  if (!p) {
    p = openSqliteLibraryIndexStore(path.join(resolved, LIBRARY_INDEX_REL));
    p.catch(() => openStores.delete(resolved)); // a failed open must not poison future attempts
    openStores.set(resolved, p);
  }
  return p;
}

/**
 * Fresh index-backed `RecallTools` for `root`: opens/reuses the store, ensures it reflects the current
 * canonical HEAD, and returns tools serving entirely from it (zero fs reads once built — the tool
 * surface itself never touches the filesystem, see `libraryIndexTools.ts`).
 */
export async function libraryIndexToolsFor(root: string): Promise<RecallTools> {
  const store = await storeFor(root);
  await ensureLibraryIndexFresh(store, root);
  return makeIndexTools(store);
}

/** Test/reset hook — drop cached store handles (e.g. between IPC contract tests using different temp
 *  vault roots that could otherwise collide on a reused/stale root path across test runs). */
export function resetLibraryIndexRuntimeForTests(): void {
  for (const p of openStores.values()) p.then((s) => s.close()).catch(() => {});
  openStores.clear();
}
