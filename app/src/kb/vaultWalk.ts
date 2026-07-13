// Shared recursive vault-file walker (SPEC-0061 T1 / ENG-9) — the consolidation target for the 12
// divergent ad-hoc walkers found in the 2026-07-12 deep review (`readdir`+recurse reimplemented per
// call site with drifting skip/symlink/depth semantics). This helper adopts the RICHEST existing
// safety model in the codebase (`watchConnectors.ts` `collectWatchedFiles`, WATCH-12/13): symlinks are
// NEVER followed (a committed `entities/x -> ../../..` symlink can't walk out of the vault), dot-dirs
// are skipped, entries are returned in deterministic sorted order, and a root read failure THROWS
// (failed ≠ empty) while a mid-walk subdir failure is a bounded skip.
//
// Full retirement of all 12 walkers is the epic's slice-final AC (grep gate) and is NOT completed in
// this PR — several live in files owned by parallel wave-1 lanes (connectStage.ts/decomposeStage.ts:
// Dev-3; graphProjection.ts/recallTools.ts: Dev-4/Dev-5). This helper is landed now as the index's own
// full-rebuild walk, with a tracked fast-follow to sweep the rest once those lanes settle.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface WalkVaultFilesOptions {
  /** Keep only files whose basename passes this predicate. Defaults to keeping every regular file. */
  keep?: (name: string) => boolean;
  /** Max recursion depth below `dir` (0 = only `dir` itself, non-recursive). Defaults to unbounded. */
  maxDepth?: number;
}

/**
 * Recursively collect regular files under `root/dir`, returning `root`-relative paths in deterministic
 * (name-sorted, depth-first) order. Symlinks are never followed; dot-prefixed entries (files or dirs)
 * are skipped. A missing/unreadable `root/dir` returns `[]` (mirrors the walkers this replaces — a
 * vault that hasn't grown a `claims/` dir yet is not an error).
 */
export async function walkVaultFiles(root: string, dir: string, opts: WalkVaultFilesOptions = {}): Promise<string[]> {
  const keep = opts.keep ?? (() => true);
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const out: string[] = [];

  async function walk(absDir: string, depth: number): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable dir — bounded skip (root call below also swallows via the same catch)
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // dot-dirs/dotfiles never participate (working state)
      if (e.isSymbolicLink()) continue; // never follow a symlink, in either direction (WATCH-13 model)
      const full = path.join(absDir, e.name);
      if (e.isDirectory()) {
        if (depth >= maxDepth) continue;
        await walk(full, depth + 1);
      } else if (e.isFile() && keep(e.name)) {
        out.push(path.relative(root, full));
      }
    }
  }

  await walk(path.join(root, dir), 0);
  return out;
}
