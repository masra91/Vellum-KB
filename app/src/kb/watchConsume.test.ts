// Consume / move-out tests (SPEC-0037 WATCH-14) — the NON-DESTRUCTIVE move invariant as fails-before/
// passes-after requirement-traced tests. The contract: the copy into the KB happens FIRST (source
// preserved), THEN the original is MOVED (never deleted) to `<folder>/.kb-processed`; a FAILED ingest
// leaves the original untouched; an existing archive entry is NEVER clobbered; and the default (no
// consume) leaves the original in place (Slice-1 behavior unchanged).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createKb } from './vault';
import { reconcileWatchFolder } from './watchRun';
import { WATCH_ARCHIVE_DIRNAME, type WatchFolderConfig } from './watchConnectors';

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

const exists = async (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

describe.skipIf(!gitAvailable)('reconcileWatchFolder consume/move-out (WATCH-14)', () => {
  let dir: string;
  let vault: string;
  let watched: string;
  let archive: string;
  const cfg = (over: Partial<WatchFolderConfig> = {}): WatchFolderConfig => ({ id: 'drop', folderPath: watched, enabled: true, scope: 'global', sensitivity: 'internal', ...over });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-watchconsume-'));
    vault = path.join(dir, 'vault');
    watched = path.join(dir, 'watched');
    archive = path.join(watched, WATCH_ARCHIVE_DIRNAME);
    await createKb({ path: vault, initGitIfNeeded: true });
    await fs.mkdir(watched, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('WATCH-16 DEFAULT DRAINS: no flag → the original is MOVED out (folder empties like an inbox)', async () => {
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, 'hello');
    const res = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, ...STABLE }); // no consume flag
    expect(res.ingested).toBe(1);
    expect(res.movedOut).toBe(1); // drains by default now
    expect(await exists(file)).toBe(false); // the watch root visibly emptied
    expect(await exists(path.join(archive, 'note.md'))).toBe(true); // moved (never deleted) to .kb-processed
  });

  it('WATCH-16 copy opt-out (consume:false): the original is LEFT IN PLACE — non-destructive copy', async () => {
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, 'hello');
    const res = await reconcileWatchFolder(vault, cfg({ consume: false }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.ingested).toBe(1);
    expect(res.movedOut).toBeUndefined();
    expect(await exists(file)).toBe(true); // original untouched (opt-out honored)
    expect(await exists(archive)).toBe(false); // no archive created
  });

  it('consume: copy into the KB FIRST, THEN MOVE the original out (never deleted) (WATCH-14)', async () => {
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, 'hello consume');
    const res = await reconcileWatchFolder(vault, cfg({ consume: true }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.ingested).toBe(1); // the KB copy exists (source preserved)
    expect(res.movedOut).toBe(1);
    expect(await exists(file)).toBe(false); // original moved OUT of the watch root
    const archived = path.join(archive, 'note.md');
    expect(await exists(archived)).toBe(true); // …into the archive — NOT deleted
    expect(await fs.readFile(archived, 'utf8')).toBe('hello consume'); // bytes intact
  });

  it('consume preserves the relative path under the archive for a nested file (WATCH-12+14)', async () => {
    await fs.mkdir(path.join(watched, 'sub'), { recursive: true });
    const file = path.join(watched, 'sub', 'deep.md');
    await fs.writeFile(file, 'deep');
    const res = await reconcileWatchFolder(vault, cfg({ consume: true, recursive: true, maxDepth: 3 }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.movedOut).toBe(1);
    expect(await exists(file)).toBe(false);
    expect(await exists(path.join(archive, 'sub', 'deep.md'))).toBe(true); // relpath-preserving move
  });

  it('the archive dir is a dot-dir — a moved-out original is NEVER re-ingested on a later pass', async () => {
    await fs.writeFile(path.join(watched, 'one.md'), 'one');
    const first = await reconcileWatchFolder(vault, cfg({ consume: true }), { vaultRoot: vault, now: T, ...STABLE });
    expect(first.ingested).toBe(1);
    expect(first.movedOut).toBe(1);
    // Second pass: the only content left lives in `.kb-processed/` (a dot-dir) → skipped, nothing re-ingested.
    const second = await reconcileWatchFolder(vault, cfg({ consume: true }), { vaultRoot: vault, now: T, ...STABLE });
    expect(second.ingested).toBe(0);
  });

  it('NEVER clobbers an existing archive entry — a name collision is disambiguated (never-delete ⊇ never-overwrite)', async () => {
    await fs.mkdir(archive, { recursive: true });
    await fs.writeFile(path.join(archive, 'note.md'), 'PRE-EXISTING ARCHIVE — must survive');
    await fs.writeFile(path.join(watched, 'note.md'), 'new arrival');
    const res = await reconcileWatchFolder(vault, cfg({ consume: true }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.movedOut).toBe(1);
    // The pre-existing archived file is untouched…
    expect(await fs.readFile(path.join(archive, 'note.md'), 'utf8')).toBe('PRE-EXISTING ARCHIVE — must survive');
    // …and the new original landed under a disambiguated name (never overwrote it).
    expect(await fs.readFile(path.join(archive, 'note.1.md'), 'utf8')).toBe('new arrival');
  });

  it('a FAILED ingest leaves the original UNTOUCHED — the move only happens after success (WATCH-14)', async () => {
    // Point the ingest sink (root) at a NON-git dir so captureToInbox's commit throws — a deterministic
    // ingest failure. The loop-guard still passes (vaultRoot is a real vault). The original must NOT move.
    const nonGitRoot = path.join(dir, 'no-git');
    await fs.mkdir(nonGitRoot, { recursive: true });
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, 'should stay');
    const res = await reconcileWatchFolder(nonGitRoot, cfg({ consume: true }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.failed).toBe(true); // the ingest errored…
    expect(res.movedOut ?? 0).toBe(0); // …so nothing was moved
    expect(await exists(file)).toBe(true); // original left in place — not lost
    expect(await exists(path.join(archive, 'note.md'))).toBe(false);
  });
});
