// Recursive folder-watch tests (SPEC-0037 WATCH-12/13). Two layers:
//   • `collectWatchedFiles` (pure-ish, fs-only — no git): depth cap, relative-path keying, and the
//     security invariant that NO symlinked subdirectory is ever descended at any depth and a nested
//     symlink can never tunnel back into the vault (WATCH-13 no-symlink-follow depth-wide).
//   • `reconcileWatchFolder` (real FS + git, TEST-18): recursive ingest, same-basename files in
//     different subdirs both ingested (relative-path dedup, no collision), and a depth-bounded pass.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createKb } from './vault';
import { readEvents } from './activityIndex';
import { reconcileWatchFolder } from './watchRun';
import { collectWatchedFiles, type WatchFolderConfig } from './watchConnectors';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();
const T = () => '2025-06-03T12:00:00.000Z';
// #516 BUG-6: the stability gate skips a file whose mtime is within the last 2s (see watchRun.ts). These
// tests write a file and immediately reconcile — report every file as already 10s-settled instead.
const STABLE = {
  stat: async (p: string) => {
    const s = await fs.stat(p);
    return { mtimeMs: s.mtimeMs - 10_000, size: s.size };
  },
};

async function trySymlink(target: string, link: string, type: 'file' | 'dir'): Promise<boolean> {
  try {
    await fs.symlink(target, link, type);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return false; // symlink-restricted FS → skip
    throw e;
  }
}

// ── collectWatchedFiles: depth cap + no-symlink-follow (WATCH-12/13), no git needed ──────────────
describe('collectWatchedFiles (WATCH-12/13)', () => {
  let dir: string;
  let vault: string;
  let watched: string;
  const cfg = (over: Partial<WatchFolderConfig> = {}): WatchFolderConfig => ({ id: 'drop', folderPath: watched, enabled: true, scope: 'global', sensitivity: 'internal', ...over });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-watchrec-'));
    vault = path.join(dir, 'vault');
    watched = path.join(dir, 'watched');
    await fs.mkdir(path.join(vault, '.kb'), { recursive: true });
    await fs.writeFile(path.join(vault, '.kb', 'secret.md'), 'VAULT INTERNALS — must never be ingested');
    await fs.mkdir(watched, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('non-recursive (default) collects only top-level files, never descends a subdir (WATCH-12 default)', async () => {
    await fs.writeFile(path.join(watched, 'top.md'), 'top');
    await fs.mkdir(path.join(watched, 'sub'), { recursive: true });
    await fs.writeFile(path.join(watched, 'sub', 'deep.md'), 'deep');
    const scan = await collectWatchedFiles(vault, cfg());
    expect(scan.files.map((f) => f.relPath)).toEqual(['top.md']);
    expect(scan.skipped).toBeGreaterThanOrEqual(1); // the subdir
  });

  it('recursive descends to nested files with RELATIVE-PATH keys (WATCH-12)', async () => {
    await fs.writeFile(path.join(watched, 'a.md'), 'a');
    await fs.mkdir(path.join(watched, 'x', 'y'), { recursive: true });
    await fs.writeFile(path.join(watched, 'x', 'b.md'), 'b');
    await fs.writeFile(path.join(watched, 'x', 'y', 'c.md'), 'c');
    const scan = await collectWatchedFiles(vault, cfg({ recursive: true, maxDepth: 5 }));
    expect(scan.files.map((f) => f.relPath).sort()).toEqual(['a.md', 'x/b.md', 'x/y/c.md']);
  });

  it('honors the depth cap: maxDepth 1 takes depth-1 files but NOT depth-2 (WATCH-12)', async () => {
    await fs.mkdir(path.join(watched, 'l1', 'l2'), { recursive: true });
    await fs.writeFile(path.join(watched, 'root.md'), '0');
    await fs.writeFile(path.join(watched, 'l1', 'one.md'), '1');
    await fs.writeFile(path.join(watched, 'l1', 'l2', 'two.md'), '2');
    const scan = await collectWatchedFiles(vault, cfg({ recursive: true, maxDepth: 1 }));
    expect(scan.files.map((f) => f.relPath).sort()).toEqual(['l1/one.md', 'root.md']); // l1/l2/two.md beyond cap
  });

  it('SECURITY (WATCH-13): never descends a symlinked subdirectory — a nested symlink to the vault cannot tunnel in', async () => {
    await fs.writeFile(path.join(watched, 'real.md'), 'real');
    await fs.mkdir(path.join(watched, 'sub'), { recursive: true });
    await fs.writeFile(path.join(watched, 'sub', 'ok.md'), 'ok');
    // A symlinked dir INSIDE a real subdir, pointing at the vault's internals — must never be followed.
    const made = await trySymlink(path.join(vault, '.kb'), path.join(watched, 'sub', 'into-vault'), 'dir');
    if (!made) return; // symlink-restricted FS → invariant N/A here
    const scan = await collectWatchedFiles(vault, cfg({ recursive: true, maxDepth: 10 }));
    const rels = scan.files.map((f) => f.relPath).sort();
    expect(rels).toEqual(['real.md', 'sub/ok.md']); // never sub/into-vault/secret.md
    expect(rels.some((r) => r.includes('secret') || r.includes('into-vault'))).toBe(false);
  });

  it('SECURITY (WATCH-13): a symlinked subdir at the TOP level is skipped, not followed', async () => {
    await fs.writeFile(path.join(watched, 'keep.md'), 'keep');
    const made = await trySymlink(path.join(vault, '.kb'), path.join(watched, 'shortcut'), 'dir');
    if (!made) return;
    const scan = await collectWatchedFiles(vault, cfg({ recursive: true, maxDepth: 10 }));
    expect(scan.files.map((f) => f.relPath)).toEqual(['keep.md']);
  });
});

// ── reconcileWatchFolder recursive ingest (real git) ─────────────────────────────────────────────
describe.skipIf(!gitAvailable)('reconcileWatchFolder recursive (WATCH-12)', () => {
  let dir: string;
  let vault: string;
  let watched: string;
  const cfg = (over: Partial<WatchFolderConfig> = {}): WatchFolderConfig => ({ id: 'drop', folderPath: watched, enabled: true, scope: 'global', sensitivity: 'internal', ...over });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-watchrec-git-'));
    vault = path.join(dir, 'vault');
    watched = path.join(dir, 'watched');
    await createKb({ path: vault, initGitIfNeeded: true });
    await fs.mkdir(watched, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('ingests nested files when recursive (and the default non-recursive run does not)', async () => {
    await fs.mkdir(path.join(watched, 'reports'), { recursive: true });
    await fs.writeFile(path.join(watched, 'top.md'), 'top');
    await fs.writeFile(path.join(watched, 'reports', 'q1.md'), 'q1');

    const flat = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, ...STABLE });
    expect(flat.ingested).toBe(1); // only top.md — subdir not descended

    const rec = await reconcileWatchFolder(vault, cfg({ recursive: true, maxDepth: 5 }), { vaultRoot: vault, now: T, ...STABLE });
    expect(rec.ingested).toBe(1); // reports/q1.md picked up now (top.md already deduped)
    expect(rec.sourceIds.length).toBe(1);
  });

  it('same-basename, DIFFERENT-content files in different subdirs BOTH ingest — relpath change-tracking (WATCH-12)', async () => {
    await fs.mkdir(path.join(watched, 'a'), { recursive: true });
    await fs.mkdir(path.join(watched, 'b'), { recursive: true });
    await fs.writeFile(path.join(watched, 'a', 'notes.md'), 'A notes');
    await fs.writeFile(path.join(watched, 'b', 'notes.md'), 'B notes');
    const res = await reconcileWatchFolder(vault, cfg({ recursive: true, maxDepth: 3 }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.ingested).toBe(2); // distinct content at distinct paths → two sources

    // Re-run unchanged → no-op (each path's content is unchanged in its relpath ledger).
    const again = await reconcileWatchFolder(vault, cfg({ recursive: true, maxDepth: 3 }), { vaultRoot: vault, now: T, ...STABLE });
    expect(again.ingested).toBe(0);
    // The ingested provenance carries the relative path, not a bare basename.
    const ingested = (await readEvents(vault, {})).filter((e) => e.actor === 'watch' && e.eventType === 'watch-ingested');
    const files = ingested.flatMap((e) => (e.payload.files as string[]) ?? []);
    expect(files).toContain('a/notes.md');
    expect(files).toContain('b/notes.md');
  });

  it('contentHash is the dedup-of-record: IDENTICAL bytes at two paths = ONE source, not two (WATCH-12 refinement)', async () => {
    await fs.mkdir(path.join(watched, 'a'), { recursive: true });
    await fs.mkdir(path.join(watched, 'b'), { recursive: true });
    // Byte-identical content at two distinct relative paths.
    await fs.writeFile(path.join(watched, 'a', 'dup.md'), 'IDENTICAL BYTES');
    await fs.writeFile(path.join(watched, 'b', 'dup.md'), 'IDENTICAL BYTES');
    const res = await reconcileWatchFolder(vault, cfg({ recursive: true, maxDepth: 3 }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.ingested).toBe(1); // ONE source for the shared content…
    expect(res.sourceIds.length).toBe(1);
    expect(res.skipped).toBeGreaterThanOrEqual(1); // …the second path deduped to it (no second source)
    const ingested = (await readEvents(vault, {})).filter((e) => e.actor === 'watch' && e.eventType === 'watch-ingested');
    const allSourceIds = ingested.flatMap((e) => (e.payload.sourceIds as string[]) ?? []);
    expect(new Set(allSourceIds).size).toBe(1); // exactly one distinct source minted across the pass
  });
});
