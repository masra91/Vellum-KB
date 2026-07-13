// Staging branch + promotion gate tests (SPEC-0021 STAGING). Real git against a throwaway
// temp vault (TEST-18). Proves: staging is created off main; the promotion gate publishes
// the evergreen path set to main and NEVER the working paths (the CANON invariant).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createKb, ensureGitIdentity } from './vault';
import { ensureStagingBranch, advanceStaging, promote, STAGING_BRANCH } from './staging';
import { resolveIndexLockPath } from './canonicalLockHeal';
import { writeLockMeta } from './canonicalLockMeta';
import type { DevLog } from './devlog';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function withTempVault(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    await fn(path.join(dir, 'vault'));
  } finally {
    await rmTempDir(dir);
  }
}

/** Commit `files` (relative path → contents) onto `staging` via a throwaway worktree, the way
 *  a stage would (staging is never checked out in the root). */
async function commitOnStaging(root: string, files: Record<string, string>): Promise<void> {
  const wt = path.join(root, '.kb', 'cache', 'test-staging-wt');
  const git = simpleGit(root);
  await git.raw('worktree', 'add', '--force', wt, STAGING_BRANCH);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
    await fs.writeFile(path.join(wt, rel), content, 'utf8');
  }
  const wtGit = simpleGit(wt);
  await ensureGitIdentity(wtGit);
  await wtGit.raw('add', '-A');
  await wtGit.commit('staging work');
  // Re-point staging to the worktree's new commit, then drop the worktree.
  const head = (await wtGit.revparse(['HEAD'])).trim();
  await git.raw('worktree', 'remove', '--force', wt);
  await advanceStaging(root, head);
}

/** Delete `rels` on `staging` (the way CONNECT deletes a merged-away loser node), via a throwaway
 *  worktree, and advance staging to the deletion commit. */
async function deleteOnStaging(root: string, rels: string[]): Promise<void> {
  const wt = path.join(root, '.kb', 'cache', 'test-staging-wt');
  const git = simpleGit(root);
  await git.raw('worktree', 'add', '--force', wt, STAGING_BRANCH);
  const wtGit = simpleGit(wt);
  await ensureGitIdentity(wtGit);
  for (const rel of rels) await fs.rm(path.join(wt, rel), { force: true });
  await wtGit.raw('add', '-A');
  await wtGit.commit('staging delete');
  const head = (await wtGit.revparse(['HEAD'])).trim();
  await git.raw('worktree', 'remove', '--force', wt);
  await advanceStaging(root, head);
}

describe.skipIf(!gitAvailable)('ensureStagingBranch (STAGING-1)', () => {
  it('creates a staging branch off HEAD, leaving the root on its current branch', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      const git = simpleGit(root);
      const before = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      await ensureStagingBranch(root);
      expect((await git.branchLocal()).all).toContain(STAGING_BRANCH);
      // Branch-name agnostic: root stays on whatever it was (main/master), never switched to staging.
      const after = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      expect(after).toBe(before);
      expect(after).not.toBe(STAGING_BRANCH);
    });
  });

  it('is idempotent — a second call does not error or move staging', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      await commitOnStaging(root, { 'sources/2026/05/31/A/source.md': 'a' });
      const before = (await simpleGit(root).revparse([STAGING_BRANCH])).trim();
      await ensureStagingBranch(root); // must NOT reset staging back to main
      expect((await simpleGit(root).revparse([STAGING_BRANCH])).trim()).toBe(before);
    });
  });
});

describe.skipIf(!gitAvailable)('promote — the evergreen gate (STAGING-3/4/6)', () => {
  it('publishes sources/ to main but NEVER working paths, leaving main clean', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      // A stage advances staging with an evergreen source AND working candidates.
      await commitOnStaging(root, {
        'sources/2026/05/31/A/source.md': 'ground truth',
        'candidates/2026/05/31/C.json': '{"kind":"person"}',
      });

      const promoted = await promote(root);
      expect(promoted).toBe(true);

      // main got the source…
      expect(await pathExists(path.join(root, 'sources/2026/05/31/A/source.md'))).toBe(true);
      // …but NOT the working candidates (CANON: main never holds working paths).
      expect(await pathExists(path.join(root, 'candidates/2026/05/31/C.json'))).toBe(false);
      // …and main is clean (ORCH-3 / CANON-1).
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('is idempotent: re-promoting with no evergreen change is a no-op', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      await commitOnStaging(root, { 'sources/2026/05/31/A/source.md': 'a' });
      expect(await promote(root)).toBe(true);
      expect(await promote(root)).toBe(false); // nothing new to publish
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('a candidates-only staging change promotes nothing (entities/ empty until CONNECT)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      await commitOnStaging(root, { 'candidates/2026/05/31/C.json': '{}' });
      expect(await promote(root)).toBe(false); // candidates are working-only
      expect(await pathExists(path.join(root, 'candidates'))).toBe(false); // main never sees them
    });
  });

  it('publishes resolved entities/ and claims/ to main (CONNECT output joins the evergreen set; STAGING-11)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      // CONNECT resolved a candidate into an entity; Claims attached a claim — both evergreen now.
      await commitOnStaging(root, {
        'entities/person/steve-jobs.md': '---\nid: 01E\nname: Steve Jobs\n---\n\n# Steve Jobs\n',
        'claims/2026/05/31/01C.md': '---\nid: 01C\nsubject: entities/person/steve-jobs.md\n---\n\nFounded Apple.\n',
        'candidates/2026/05/31/C.json': '{"id":"01X"}', // working state alongside
      });

      expect(await promote(root)).toBe(true);
      expect(await pathExists(path.join(root, 'entities/person/steve-jobs.md'))).toBe(true);
      expect(await pathExists(path.join(root, 'claims/2026/05/31/01C.md'))).toBe(true);
      expect(await pathExists(path.join(root, 'candidates'))).toBe(false); // working state stays off main
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  // #508 item 1: promote used to `git rm -r` + full-recheckout EVERY evergreen path on EVERY promote,
  // even for a single-file change — a rescan storm on the live root Obsidian watches. Prove it now
  // touches only what actually changed: seed a bunch of unrelated sources, promote once (baseline),
  // then add ONE more source and promote again — the 20 unrelated files must be byte-for-byte untouched
  // (mtime-unchanged), not rewritten.
  it('a single-file staging change only touches that file on main, not the whole evergreen tree', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      const seedFiles: Record<string, string> = {};
      const UNRELATED_COUNT = 20;
      for (let i = 0; i < UNRELATED_COUNT; i++) seedFiles[`sources/2026/05/31/S${i}/source.md`] = `content ${i}`;
      await commitOnStaging(root, seedFiles);
      expect(await promote(root)).toBe(true);

      const mtimesBefore = new Map<string, number>();
      for (let i = 0; i < UNRELATED_COUNT; i++) {
        const p = path.join(root, `sources/2026/05/31/S${i}/source.md`);
        mtimesBefore.set(p, (await fs.stat(p)).mtimeMs);
      }
      await new Promise((r) => setTimeout(r, 20)); // so a re-write (if it happened) shows a later mtime

      await commitOnStaging(root, { 'sources/2026/06/01/SNEW/source.md': 'new content' });
      expect(await promote(root)).toBe(true);

      expect(await pathExists(path.join(root, 'sources/2026/06/01/SNEW/source.md'))).toBe(true); // the new file landed
      for (const [p, before] of mtimesBefore) {
        expect((await fs.stat(p)).mtimeMs).toBe(before); // untouched — no full-tree recheckout
      }
    });
  });

  it('mirrors deletions: a node CONNECT merged away on staging is removed from main (STAGING-10)', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      // Two same-name nodes resolved+promoted (pre-merge graph state).
      await commitOnStaging(root, {
        'entities/person/steve-jobs.md': '---\nid: 01A\nname: Steve Jobs\n---\n\n# Steve Jobs\n',
        'entities/person/steven-jobs.md': '---\nid: 01B\nname: Steven Jobs\n---\n\n# Steven Jobs\n',
      });
      expect(await promote(root)).toBe(true);
      expect(await pathExists(path.join(root, 'entities/person/steven-jobs.md'))).toBe(true);

      // CONNECT merges 01B into 01A and deletes the loser file on staging (CONNECT-10).
      await deleteOnStaging(root, ['entities/person/steven-jobs.md']);

      expect(await promote(root)).toBe(true); // the deletion is an evergreen change to publish
      // main now reflects the merge: the loser is gone, the canonical remains, tree clean.
      expect(await pathExists(path.join(root, 'entities/person/steven-jobs.md'))).toBe(false);
      expect(await pathExists(path.join(root, 'entities/person/steve-jobs.md'))).toBe(true);
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });
});

// ORCH-27 stale `index.lock` self-heal on the canonical writer to `main` (the vault ROOT — the live
// repo Obsidian has open). A crashed/timed-out prior root git op orphans `<root>/.git/index.lock` and
// wedges EVERY future promote (the Jun-10 orphan lock blocked a build). `promote` now heals a
// PROVEN-stale (no-live-holder) root lock first — but NEVER stomps a not-proven-stale (possibly-live)
// lock. fails-before/passes-after, on the class.
describe.skipIf(!gitAvailable)('promote — stale index.lock self-heal (STAGING-12 / ORCH-27)', () => {
  /** A DevLog that records events so the heal can be asserted as surfaced (acceptance: clear + LOG). */
  function captureLog(sink: Array<{ event: string }>): DevLog {
    const rec = (event: string): void => {
      sink.push({ event });
    };
    const self: DevLog = { debug: rec, info: rec, warn: rec, error: rec, child: () => self, flush: () => Promise.resolve() };
    return self;
  }

  it('heals a stale no-live-holder root index.lock + proceeds — was: orphan lock wedges every promote', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      await commitOnStaging(root, { 'sources/2026/05/31/A/source.md': 'ground truth' });

      // Simulate a crashed prior promote: an orphan index.lock at the vault root + a self-pid sidecar
      // with no live in-proc op → ORCH-27 gate-2(a) "leaked by self" → proven stale, safe to clear.
      const lockPath = await resolveIndexLockPath(root);
      await fs.writeFile(lockPath, '', 'utf8');
      await writeLockMeta(root, { pid: process.pid, startedAt: Date.now() - 5_000, op: 'promote', timeoutMs: 20_000 });

      const events: Array<{ event: string }> = [];
      const promoted = await promote(root, undefined, undefined, captureLog(events));

      expect(promoted).toBe(true); // proceeded — the orphan lock no longer wedges promote (fails-before)
      expect(await pathExists(lockPath)).toBe(false); // the stale lock was cleared
      expect(await pathExists(path.join(root, 'sources/2026/05/31/A/source.md'))).toBe(true); // evergreen reached main
      expect(events.some((e) => e.event === 'orch.lock.healed')).toBe(true); // the self-heal is LOGGED (acceptance)
    });
  });

  it('NEVER stomps a not-proven-stale (possibly-live) root lock — leaves it + fails rather than corrupting a live write', async () => {
    await withTempVault(async (root) => {
      await createKb({ path: root, initGitIfNeeded: true });
      await ensureStagingBranch(root);
      await commitOnStaging(root, { 'sources/2026/05/31/A/source.md': 'ground truth' });

      // A FRESH root index.lock with NO sidecar — gate-3 treats it as possibly-live (too fresh to assume
      // stale, fail-safe) → KEEP. The heal must NOT clear it; promote then fails on the held lock.
      const lockPath = await resolveIndexLockPath(root);
      await fs.writeFile(lockPath, '', 'utf8');

      await expect(promote(root)).rejects.toThrow(); // git can't take the held index.lock → surfaces, never stomps
      expect(await pathExists(lockPath)).toBe(true); // the live/unproven lock is UNTOUCHED (no corruption)
    });
  });
});
