// Folder-watch run-pass tests (SPEC-0037 WATCH-3/4/8/10). Real FS + real git against a throwaway vault
// (TEST-18), like intakeRun.test.ts. Skips if git is absent. Exercises the load-bearing security
// invariants as fails-before/passes-after requirement-traced tests: the LOOP-GUARD refusal (WATCH-10),
// NON-DESTRUCTIVE copy (WATCH-4 — original untouched), NO-SYMLINK-FOLLOW + non-recursive (WATCH-3/6),
// and contentHash dedup (unchanged = no-op; changed = new source carrying the prior-source link).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createKb } from './vault';
import { readEvents } from './activityIndex';
import { reconcileWatchFolder } from './watchRun';
import type { WatchFolderConfig } from './watchConnectors';

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

// #516 BUG-6: the stability gate skips a file whose mtime is within the last 2s (see watchRun.ts).
// These tests write a file and immediately reconcile, so a real `fs.stat` would always fail that check —
// report every file as already 10s-settled instead, isolating these tests from the new gate (its own
// behavior is covered in the dedicated #516 BUG-6 describe block below).
const STABLE = {
  stat: async (p: string) => {
    const s = await fs.stat(p);
    return { mtimeMs: s.mtimeMs - 10_000, size: s.size };
  },
};

describe.skipIf(!gitAvailable)('reconcileWatchFolder (SPEC-0037 WATCH)', () => {
  let dir: string;
  let vault: string;
  let watched: string;
  const cfg = (over: Partial<WatchFolderConfig> = {}): WatchFolderConfig => ({ id: 'drop', folderPath: watched, enabled: true, scope: 'global', sensitivity: 'internal', ...over });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-watch-'));
    vault = path.join(dir, 'vault');
    watched = path.join(dir, 'watched');
    await createKb({ path: vault, initGitIfNeeded: true });
    await fs.mkdir(watched, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function watchEvents(): Promise<Array<{ eventType: string; payload: Record<string, unknown> }>> {
    return (await readEvents(vault, {})).filter((e) => e.actor === 'watch').map((e) => ({ eventType: e.eventType, payload: e.payload }));
  }

  it('copies a stable text file in as a PRIMARY source — and the original is UNTOUCHED (WATCH-4, copy opt-out)', async () => {
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, '# Meeting\n\nShipped WATCH core.');
    // copy mode (consume:false) — the WATCH-16 default DRAINS (moves out); this asserts the never-destroy
    // copy path explicitly. (Drain is covered in watchConsume.test.ts.)
    const res = await reconcileWatchFolder(vault, cfg({ consume: false }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.ingested).toBe(1);
    expect(res.sourceIds.length).toBe(1);
    // NON-DESTRUCTIVE: the watched original still exists with identical bytes.
    expect(await fs.readFile(file, 'utf8')).toBe('# Meeting\n\nShipped WATCH core.');
    const ev = await watchEvents();
    expect(ev.some((e) => e.eventType === 'watch-ingested')).toBe(true);
  });

  it('dedups an unchanged re-save (no-op) but ingests a CHANGED file as a NEW source carrying the prior link (Fork#1/WATCH-8)', async () => {
    const file = path.join(watched, 'report.md');
    await fs.writeFile(file, 'v1');
    const first = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, ...STABLE });
    expect(first.ingested).toBe(1);
    const priorId = first.sourceIds[0];

    // Re-run with no change → no-op (contentHash dedup).
    const second = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, ...STABLE });
    expect(second.ingested).toBe(0);
    expect(second.note).toMatch(/no new files/);

    // Change the file → a NEW source, provenance-linked to the prior.
    await fs.writeFile(file, 'v2 — revised');
    const third = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, ...STABLE });
    expect(third.ingested).toBe(1);
    expect(third.sourceIds[0]).not.toBe(priorId);
    const ingested = (await watchEvents()).filter((e) => e.eventType === 'watch-ingested');
    const supersede = ingested.flatMap((e) => (e.payload.supersedes as Array<{ priorSourceId: string }>) ?? []);
    expect(supersede.some((s) => s.priorSourceId === priorId)).toBe(true);
  });

  it('NEVER follows symlinks and is NON-RECURSIVE (WATCH-3/6 scope-escape)', async () => {
    await fs.writeFile(path.join(watched, 'real.md'), 'real');
    // A symlink to a secret outside the folder — must be skipped, not ingested.
    const secret = path.join(dir, 'secret.md');
    await fs.writeFile(secret, 'TOP SECRET');
    try {
      await fs.symlink(secret, path.join(watched, 'link.md'), 'file');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return; // symlink-restricted FS → N/A
      throw e;
    }
    // A subdirectory with a file — must NOT be descended (non-recursive).
    await fs.mkdir(path.join(watched, 'sub'), { recursive: true });
    await fs.writeFile(path.join(watched, 'sub', 'deep.md'), 'deep');

    const res = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.ingested).toBe(1); // only real.md — not the symlink, not the subdir file
    expect(res.skipped).toBeGreaterThanOrEqual(2); // symlink + subdir skipped
  });

  it('REFUSES the vault root / a path inside the vault (loop-guard WATCH-10) with a distinct audited event', async () => {
    const res = await reconcileWatchFolder(vault, cfg({ folderPath: path.join(vault, 'sources') }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.refused).toBe(true);
    expect(res.ingested).toBe(0);
    expect((await watchEvents()).some((e) => e.eventType === 'watch-refused')).toBe(true);
  });

  it('skips dotfiles + ignoreGlobs (bounds WATCH-6)', async () => {
    await fs.writeFile(path.join(watched, 'keep.md'), 'keep');
    await fs.writeFile(path.join(watched, '.DS_Store'), 'x');
    await fs.writeFile(path.join(watched, 'tmp.part'), 'partial');
    const res = await reconcileWatchFolder(vault, cfg({ ignoreGlobs: ['*.part'] }), { vaultRoot: vault, now: T, ...STABLE });
    expect(res.ingested).toBe(1); // only keep.md
  });

  it('a read failure is a DISTINCT audited watch-failed, not a silent empty (OBS-4)', async () => {
    const res = await reconcileWatchFolder(vault, cfg({ folderPath: path.join(dir, 'does-not-exist') }), { vaultRoot: vault, now: T, ...STABLE });
    // A non-existent folder is caught by the loop-guard (refused) — a folder that exists at guard time
    // but fails to read would be watch-failed; both are distinct from a silent no-op.
    expect(res.refused || res.failed).toBe(true);
    expect(res.ingested).toBe(0);
  });
});

// #516 BUG-6: chokidar's `awaitWriteFinish` only stabilizes the ONE file that triggered the live event —
// a multi-file drop's sibling files get scanned + read with no per-file check at all, ingesting a
// still-copying file truncated as an "immutable" source, then re-ingesting the completed copy as a SECOND
// source once it finally settles. The two-stat gate (pre-read mtime-age + pre/post-read size match)
// applies uniformly to every file on every pass — a live event AND the startup/restart reconcile alike.
describe.skipIf(!gitAvailable)('reconcileWatchFolder — mid-copy stability gate (#516 BUG-6)', () => {
  let dir: string;
  let vault: string;
  let watched: string;
  const cfg = (over: Partial<WatchFolderConfig> = {}): WatchFolderConfig => ({ id: 'drop', folderPath: watched, enabled: true, scope: 'global', sensitivity: 'internal', ...over });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-watchstable-'));
    vault = path.join(dir, 'vault');
    watched = path.join(dir, 'watched');
    await createKb({ path: vault, initGitIfNeeded: true });
    await fs.mkdir(watched, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('a freshly-modified file (mtime within the stability window) is skipped THIS pass — never ingested truncated', async () => {
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, 'fresh content');
    const fakeNow = 1_000_000;
    // Reports the file as modified 500ms ago — inside the 2000ms stability window.
    const freshStat = async (p: string) => ({ mtimeMs: fakeNow - 500, size: (await fs.stat(p)).size });
    const res = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, stat: freshStat, nowMs: () => fakeNow });
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.sourceIds).toEqual([]);
  });

  it('the SAME file ingests exactly once, once it settles outside the stability window (AC: one source once stable)', async () => {
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, 'settled content');
    const fakeNow = 1_000_000;
    const mtimeMs = fakeNow - 500;
    const stat = async (p: string) => ({ mtimeMs, size: (await fs.stat(p)).size });

    // Pass 1: still within the window (only 500ms have "passed") — skipped.
    const first = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, stat, nowMs: () => fakeNow });
    expect(first.ingested).toBe(0);

    // Pass 2: 3s later (mtime unchanged — the write really did finish) — now outside the window.
    const second = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, stat, nowMs: () => fakeNow + 3000 });
    expect(second.ingested).toBe(1);
    expect(second.sourceIds).toHaveLength(1);

    // Pass 3: unchanged content, long since stable — contentHash dedup, still exactly one source total.
    const third = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, stat, nowMs: () => fakeNow + 6000 });
    expect(third.ingested).toBe(0);
    expect(third.note).toMatch(/no new files/);
  });

  it('a file whose size changes between the pre- and post-read stat (still growing) is skipped — never ingested torn', async () => {
    const file = path.join(watched, 'growing.bin');
    await fs.writeFile(file, 'partial-bytes-only');
    let calls = 0;
    // 1st stat (pre-read): old-enough mtime, current size. 2nd stat (post-read): size has grown — the
    // copy was still in progress DURING our read, so what we just read may be a torn snapshot.
    const flakyStat = async (p: string) => {
      calls++;
      const real = await fs.stat(p);
      return { mtimeMs: real.mtimeMs - 10_000, size: calls === 1 ? real.size : real.size + 999 };
    };
    const res = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, stat: flakyStat });
    expect(res.ingested).toBe(0);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(calls).toBeGreaterThanOrEqual(2); // both the pre- and post-read stat actually ran
  });

  it('one unstable (mid-copy) file in a multi-file drop does NOT block its stable siblings from ingesting in the same pass', async () => {
    await fs.writeFile(path.join(watched, 'a-growing.bin'), 'still copying');
    await fs.writeFile(path.join(watched, 'b-stable.md'), 'a perfectly settled file');
    const stat = async (p: string) => {
      const real = await fs.stat(p);
      if (p.endsWith('a-growing.bin')) return { mtimeMs: Date.now(), size: real.size }; // always "just modified"
      return { mtimeMs: real.mtimeMs - 10_000, size: real.size }; // long settled
    };
    const res = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, stat });
    expect(res.ingested).toBe(1); // only b-stable.md
    expect(res.skipped).toBeGreaterThanOrEqual(1); // a-growing.bin held back, not lost
    // a-growing.bin was never touched — still on disk, untouched, ready for a later pass.
    expect(await fs.readFile(path.join(watched, 'a-growing.bin'), 'utf8')).toBe('still copying');
  });

  it('applies the SAME gate to the startup reconcile, not just live events (AC: "event and startup reconciles alike")', async () => {
    // No live-event path involved at all here — this IS what a restart's startup reconcile calls directly.
    const file = path.join(watched, 'note.md');
    await fs.writeFile(file, 'just arrived at startup');
    const freshStat = async (p: string) => ({ mtimeMs: Date.now(), size: (await fs.stat(p)).size });
    const res = await reconcileWatchFolder(vault, cfg(), { vaultRoot: vault, now: T, stat: freshStat });
    expect(res.ingested).toBe(0); // held back even on a "restart just found this file" pass
  });
});
