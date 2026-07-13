// The library index orchestrator (SPEC-0061 T1, #530 slice 1) — a `ProjectionStore` SIBLING (per the
// issue title), not a `ProjectionStore<T>` instance: `ProjectionStore` holds one in-memory JSON blob on
// a fixed refresh cadence, while this maintains an on-disk, queryable (SQL + FTS5) index that must stay
// correct incrementally at vault scale (a year vault is ~18k sources — too large to serialize as one
// JSON blob every tick, PERF-E7/E8's exact complaint). It borrows the same freshness discipline
// (`ProjectionStore`'s HEAD-gated ideal, `activityIndex.ts`'s existing "key off HEAD, not a timer"
// pattern) but self-drives it: `ensureFresh()` is idempotent and cheap when already fresh (one HEAD
// read, one meta lookup, no vault I/O), so callers invoke it before every read rather than the index
// running its own interval loop.
//
// Deliberately NOT hooked into `canonicalAdvance.ts`'s advance seam (`advanceOrCollide`) even though
// that's the architecturally obvious push point — that file is Dev-3's active lane this wave (#515/#517/
// #507, the canonical-lock hang-class fixes) and a hook there would be a second writer racing their
// changes. Lazy HEAD-diff on read achieves the same end state (the index reflects the canonical HEAD by
// the time any consumer reads it) without a shared edit; wiring a genuine push-on-advance hook is a
// natural fast-follow once that lane settles.
import simpleGit from 'simple-git';
import { canonicalHead } from './canonicalAdvance';
import { rebuildLibraryIndexFull, applyVaultDiff } from './libraryIndexBuild';
import { LIBRARY_INDEX_SCHEMA_VERSION, META_SCHEMA_VERSION, META_LAST_INDEXED_HEAD, type LibraryIndexStore } from './libraryIndexTypes';

/** Repo-relative paths that changed between two commits, via `git diff --name-only` (read-only; not
 *  under the canonical-writer lock — mirrors `canonicalHead`'s own unguarded `revparse`). Throws if
 *  either ref is no longer reachable (e.g. the canonical branch was reset/rewritten since the last
 *  index build) — the caller treats that as "can't diff, fall back to a full rebuild". */
async function diffChangedPaths(root: string, oldHead: string, newHead: string): Promise<string[]> {
  const raw = await simpleGit(root).raw(['diff', '--name-only', oldHead, newHead]);
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Bring `store` up to date with the vault's current canonical HEAD, choosing the cheapest correct path:
 *  - no git repo yet / no commits: no-op (nothing to index).
 *  - store empty, or its DDL/shape version doesn't match: full rebuild (also the first-ever build).
 *  - `lastIndexedHead` already equals the current HEAD: no-op (the common case — most reads hit this).
 *  - otherwise: `git diff --name-only` between the two and apply just that delta; if the diff itself
 *    fails (history rewrite, shallow clone missing the old commit), fall back to a full rebuild rather
 *    than surface an error — git is truth, a full rebuild is always a valid recovery (ENG-17 item 7).
 */
export async function ensureLibraryIndexFresh(store: LibraryIndexStore, root: string): Promise<void> {
  let head: string;
  try {
    head = await canonicalHead(root);
  } catch {
    return; // not a git repo / no HEAD yet (e.g. vault not initialized) — nothing to index
  }

  if (store.isEmpty()) {
    await rebuildLibraryIndexFull(store, root, head);
    store.setMeta(META_SCHEMA_VERSION, String(LIBRARY_INDEX_SCHEMA_VERSION));
    return;
  }

  const lastHead = store.getMeta(META_LAST_INDEXED_HEAD);
  if (lastHead === head) return; // already fresh — the common case, zero vault I/O

  if (!lastHead) {
    await rebuildLibraryIndexFull(store, root, head);
    store.setMeta(META_SCHEMA_VERSION, String(LIBRARY_INDEX_SCHEMA_VERSION));
    return;
  }

  try {
    const changed = await diffChangedPaths(root, lastHead, head);
    await applyVaultDiff(store, root, changed, head);
  } catch {
    await rebuildLibraryIndexFull(store, root, head);
    store.setMeta(META_SCHEMA_VERSION, String(LIBRARY_INDEX_SCHEMA_VERSION));
  }
}
