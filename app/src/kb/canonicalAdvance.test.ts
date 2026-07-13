// Deterministic interleaving tests for the optimistic canonical advance (SPEC-0014 ORCH-17/18/19).
// Real git against a throwaway repo (TEST-18). No agents — we drive the git mechanics directly and
// force the exact interleavings the lock would otherwise hide: two items prepared off the SAME base,
// advanced in sequence, so the second sees a moved canonical (disjoint→replay, same-path→collision).
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { ensureGitIdentity } from './vault';
import { canonicalHead, advanceOrCollide, withOptimisticAdvance, withConcurrentAdvance, withEphemeralWorktree, reapEphemeralWorktrees, type AdvanceOutcome } from './canonicalAdvance';
import { Mutex } from './stageLock';
import { ulid } from './ulid';

/** A canonical worktree (`root`) on branch `canon` with one initial commit. */
async function makeCanonicalRepo(dir: string): Promise<string> {
  const root = path.join(dir, 'repo');
  await fs.mkdir(root, { recursive: true });
  const git = simpleGit(root);
  await git.init(['--initial-branch=canon']);
  await ensureGitIdentity(git);
  await fs.writeFile(path.join(root, 'README'), 'seed\n');
  await git.raw('add', '-A');
  await git.commit('seed');
  return root;
}

/** Simulate a stage's OFF-lock prepare: a worktree synced to `base` on `branch`, writing `files`,
 *  committed there (the work branch then holds the prepared commit). Mirrors the real stages. */
async function prepareOnBranch(root: string, branch: string, base: string, files: Record<string, string>): Promise<void> {
  const wt = path.join(root, '.kb', 'cache', `wt-${branch.replace(/\W/g, '_')}`);
  const git = simpleGit(root);
  await git.raw('worktree', 'add', '--force', '-B', branch, wt, base);
  const wtGit = simpleGit(wt);
  await ensureGitIdentity(wtGit);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
    await fs.writeFile(path.join(wt, rel), content, 'utf8');
  }
  await wtGit.raw('add', '-A');
  await wtGit.commit(`work on ${branch}`);
  await git.raw('worktree', 'remove', '--force', wt);
}

/** Write `files` into a worktree + commit on its current branch — what a stage's `prepare` does. */
async function commitInWt(wt: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
    await fs.writeFile(path.join(wt, rel), content, 'utf8');
  }
  const g = simpleGit(wt);
  await ensureGitIdentity(g);
  await g.raw('add', '-A');
  await g.commit('work');
}

const headCount = async (root: string): Promise<number> =>
  Number((await simpleGit(root).raw('rev-list', '--count', 'HEAD')).trim());
const mergeCommitCount = async (root: string): Promise<number> =>
  Number((await simpleGit(root).raw('rev-list', '--merges', '--count', 'HEAD')).trim());
const exists = async (root: string, rel: string): Promise<boolean> =>
  fs.access(path.join(root, rel)).then(() => true).catch(() => false);

describe.skipIf(!gitAvailable)('advanceOrCollide — optimistic canonical advance (ORCH-18)', () => {
  it('fast-forwards when the canonical has not moved (the cap=1 common path)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      await prepareOnBranch(root, 'kb/work-a', base, { 'sources/A/x': 'a' });

      expect(await advanceOrCollide(root, 'kb/work-a', base)).toBe('advanced');
      expect(await exists(root, 'sources/A/x')).toBe(true);
      expect(await headCount(root)).toBe(2); // seed + A, linear
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('replays a DISJOINT item onto a moved canonical (cherry-pick), keeping history linear', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      // Two items prepared off the SAME base, disjoint paths (unique-ULID keying, ORCH-6).
      await prepareOnBranch(root, 'kb/work-a', base, { 'sources/A/x': 'a' });
      await prepareOnBranch(root, 'kb/work-b', base, { 'sources/B/y': 'b' });

      expect(await advanceOrCollide(root, 'kb/work-a', base)).toBe('advanced'); // ff (head===base)
      // B still sees `base`, but canonical moved to A → must replay onto the new HEAD.
      expect(await advanceOrCollide(root, 'kb/work-b', base)).toBe('advanced'); // cherry-pick, disjoint
      expect(await exists(root, 'sources/A/x')).toBe(true);
      expect(await exists(root, 'sources/B/y')).toBe(true);
      expect(await headCount(root)).toBe(3); // seed + A + B(replayed), no merge bubble
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('detects a SAME-PATH collision and leaves the canonical untouched + clean', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      await prepareOnBranch(root, 'kb/work-a', base, { 'entities/p/steve.md': 'A wins' });
      await prepareOnBranch(root, 'kb/work-b', base, { 'entities/p/steve.md': 'B wins' }); // same path

      expect(await advanceOrCollide(root, 'kb/work-a', base)).toBe('advanced');
      const headAfterA = await canonicalHead(root);
      expect(await advanceOrCollide(root, 'kb/work-b', base)).toBe('collision'); // cherry-pick conflict
      // Canonical is unchanged by the collision and the worktree is clean (cherry-pick aborted).
      expect(await canonicalHead(root)).toBe(headAfterA);
      expect(await fs.readFile(path.join(root, 'entities/p/steve.md'), 'utf8')).toBe('A wins');
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('withOptimisticAdvance — prepare/advance/retry/set-aside (ORCH-17/19)', () => {
  it('advances on the happy path (no contention)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      const result = await withOptimisticAdvance(
        { root, lock: new Mutex(), workBranch: 'kb/work' },
        async (base) => {
          await prepareOnBranch(root, 'kb/work', base, { 'sources/A/x': 'a' });
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('advanced');
      expect(setAside).toBe(false);
      expect(await exists(root, 'sources/A/x')).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('returns noop when prepare commits nothing', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const result = await withOptimisticAdvance(
        { root, lock: new Mutex(), workBranch: 'kb/work' },
        async () => false, // nothing to advance
        async () => {},
      );
      expect(result).toBe('noop');
      expect(await headCount(root)).toBe(1); // canonical untouched
    } finally {
      await rmTempDir(dir);
    }
  });

  it('a disjoint racer is reconciled by replay on the first attempt (no set-aside)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      const result = await withOptimisticAdvance(
        { root, lock: new Mutex(), workBranch: 'kb/work' },
        async (base) => {
          await prepareOnBranch(root, 'kb/work', base, { 'sources/MINE/x': 'mine' });
          // A racing item lands a DISJOINT change on canonical between our base-capture and advance.
          await prepareOnBranch(root, 'kb/racer', base, { 'sources/RACER/y': 'race' });
          await advanceOrCollide(root, 'kb/racer', base);
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('advanced'); // replayed cleanly over the disjoint racer
      expect(setAside).toBe(false);
      expect(await exists(root, 'sources/MINE/x')).toBe(true);
      expect(await exists(root, 'sources/RACER/y')).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('sets aside after K same-path collisions — never dropped, canonical clean (ORCH-19)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      let attempts = 0;
      const result = await withOptimisticAdvance(
        { root, lock: new Mutex(), workBranch: 'kb/work', maxCollisionRetries: 2 },
        async (base) => {
          attempts++;
          await prepareOnBranch(root, 'kb/work', base, { 'entities/p/steve.md': `mine ${attempts}` });
          // A racing item lands a conflicting SAME-PATH change every attempt → always collides.
          await prepareOnBranch(root, 'kb/racer', base, { 'entities/p/steve.md': `racer ${attempts}` });
          await advanceOrCollide(root, 'kb/racer', base);
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('setaside');
      expect(setAside).toBe(true);
      expect(attempts).toBe(3); // maxCollisionRetries(2) + 1 initial attempt
      // The item was never half-applied: canonical holds only the racer's content, tree clean.
      expect(await fs.readFile(path.join(root, 'entities/p/steve.md'), 'utf8')).toContain('racer');
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('withEphemeralWorktree — per-item isolation for cap>1 (ORCH-17/20)', () => {
  it('runs fn in a fresh worktree on a unique branch off the checkpoint, then tears it down', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      let seenWt = '';
      let seenBranch = '';
      const advanced = await withEphemeralWorktree(root, 'decompose', base, async ({ wt, workBranch }) => {
        seenWt = wt;
        seenBranch = workBranch;
        await fs.mkdir(path.join(wt, 'sources/A'), { recursive: true });
        await fs.writeFile(path.join(wt, 'sources/A/x'), 'a');
        const g = simpleGit(wt);
        await ensureGitIdentity(g);
        await g.raw('add', '-A');
        await g.commit('work');
        return advanceOrCollide(root, workBranch, base); // advance in the canonical worktree
      });
      expect(advanced).toBe('advanced');
      expect(seenBranch).toMatch(/^kb\/decompose-work-/);
      expect(await exists(root, 'sources/A/x')).toBe(true);
      // Torn down: the worktree dir is gone and its branch deleted.
      expect(await exists('', seenWt)).toBe(false);
      expect((await simpleGit(root).branchLocal()).all).not.toContain(seenBranch);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('concurrent items get ISOLATED worktrees + branches; both land linearly (cap>1 core)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      const lock = new Mutex();
      const seen: Array<{ wt: string; branch: string }> = [];
      // Each item: own ephemeral worktree → write+commit → advance UNDER the lock (inside the
      // ephemeral scope, before teardown). Two run concurrently off the SAME base.
      const run = (name: string): Promise<AdvanceOutcome> =>
        withEphemeralWorktree(root, 'decompose', base, async ({ wt, workBranch }) => {
          seen.push({ wt, branch: workBranch });
          await fs.mkdir(path.join(wt, `sources/${name}`), { recursive: true });
          await fs.writeFile(path.join(wt, `sources/${name}/x`), name);
          const g = simpleGit(wt);
          await ensureGitIdentity(g);
          await g.raw('add', '-A');
          await g.commit(`work ${name}`);
          return lock.run(() => advanceOrCollide(root, workBranch, base));
        });
      const outcomes = await Promise.all([run('A'), run('B')]);
      expect(outcomes).toEqual(['advanced', 'advanced']); // ff then disjoint cherry-pick
      expect(seen[0].wt).not.toBe(seen[1].wt); // isolated worktrees
      expect(seen[0].branch).not.toBe(seen[1].branch); // unique per-item branches
      expect(await exists(root, 'sources/A/x')).toBe(true);
      expect(await exists(root, 'sources/B/x')).toBe(true);
      expect(await mergeCommitCount(root)).toBe(0); // linear (ORCH-3)
    } finally {
      await rmTempDir(dir);
    }
  });

  it('tears the worktree down even when fn throws', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      let seenWt = '';
      await expect(
        withEphemeralWorktree(root, 'claims', base, async ({ wt }) => {
          seenWt = wt;
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await exists('', seenWt)).toBe(false); // cleaned up despite the throw
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('reaps a stale kb/<stage>-work-* branch left by a failed teardown (QA #59 sweep)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      // Simulate an orphan branch from a rare failed teardown (worktree gone, branch -D swallowed).
      await simpleGit(root).raw('branch', 'kb/decompose-work-STALEULID', base);
      expect((await simpleGit(root).branchLocal()).all).toContain('kb/decompose-work-STALEULID');
      // A normal ephemeral run sweeps the orphan (and tears down its own branch after).
      const r = await withEphemeralWorktree(root, 'decompose', base, async () => 'ok');
      expect(r).toBe('ok');
      const branches = (await simpleGit(root).branchLocal()).all;
      expect(branches).not.toContain('kb/decompose-work-STALEULID');
      expect(branches.filter((b) => /^kb\/decompose-work-/.test(b))).toEqual([]); // none left behind
    } finally {
      await rmTempDir(dir);
    }
  });
});

// #508 item 2: an ephemeral worktree used to `worktree add` (full checkout) the ENTIRE checkpoint tree
// for every single item — on a large vault, thousands of unrelated files materialized per archive/
// decompose. `sparsePaths` (cone-mode sparse-checkout) is opt-in per call; prove it actually narrows
// what's on disk, that reads/writes WITHIN the sparse scope work normally (including a NEW file under a
// not-yet-existing nested path), and that a path OUTSIDE the scope is never materialized.
describe.skipIf(!gitAvailable)('withEphemeralWorktree sparsePaths — cone-mode sparse-checkout (#508 item 2)', () => {
  /** Recursively count files under `dir` (excluding `.git`). */
  async function countFiles(dir: string): Promise<number> {
    let n = 0;
    async function rec(d: string): Promise<void> {
      const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
      for (const e of entries) {
        if (e.name === '.git') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await rec(p);
        else n++;
      }
    }
    await rec(dir);
    return n;
  }

  it('materializes ONLY sparsePaths, not the whole large checkpoint tree', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      // Seed a "large vault": 200 unrelated files across many source dirs, PLUS the one this item cares about.
      const seedGit = simpleGit(root);
      for (let i = 0; i < 200; i++) {
        const p = path.join(root, `sources/bulk-${i}/source.md`);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, `bulk ${i}`);
      }
      await fs.mkdir(path.join(root, 'inbox/UNIT1'), { recursive: true });
      await fs.writeFile(path.join(root, 'inbox/UNIT1/raw.md'), 'raw content');
      await seedGit.raw('add', '-A');
      await seedGit.commit('seed 200 unrelated + 1 target');
      const base = await canonicalHead(root);

      let materializedCount = -1;
      let sawUnrelated = false;
      let sawTarget = false;
      const outcome = await withEphemeralWorktree(
        root,
        'archive',
        base,
        async ({ wt, workBranch }) => {
          materializedCount = await countFiles(wt);
          sawUnrelated = await exists('', path.join(wt, 'sources/bulk-0/source.md'));
          sawTarget = await exists('', path.join(wt, 'inbox/UNIT1/raw.md'));
          // Write a NEW file under a not-yet-existing nested path INSIDE the sparse scope.
          const dest = path.join(wt, 'sources/2026/01/NEWID');
          await fs.mkdir(dest, { recursive: true });
          await fs.writeFile(path.join(dest, 'source.md'), 'archived');
          const g = simpleGit(wt);
          await ensureGitIdentity(g);
          await g.raw('add', '-A');
          await g.commit('archive UNIT1');
          return advanceOrCollide(root, workBranch, base);
        },
        ['inbox/UNIT1', 'sources/2026/01/NEWID'],
      );

      expect(outcome).toBe('advanced');
      expect(sawUnrelated).toBe(false); // the 200 unrelated files were never materialized
      expect(sawTarget).toBe(true); // the item's own input WAS materialized
      expect(materializedCount).toBeLessThanOrEqual(3); // inbox/UNIT1/raw.md + audit-ish overhead, not 201+
      // The new write inside the sparse scope reached the canonical worktree.
      expect(await exists(root, 'sources/2026/01/NEWID/source.md')).toBe(true);
      // The 200 unrelated files are still there, untouched.
      expect(await exists(root, 'sources/bulk-0/source.md')).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('omitting sparsePaths keeps the full-checkout default (no regression for callers that need it)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const seedGit = simpleGit(root);
      await fs.mkdir(path.join(root, 'entities/x'), { recursive: true });
      await fs.writeFile(path.join(root, 'entities/x/e.md'), 'entity');
      await seedGit.raw('add', '-A');
      await seedGit.commit('seed entity');
      const base = await canonicalHead(root);

      let sawEntity = false;
      await withEphemeralWorktree(root, 'connect', base, async ({ wt }) => {
        sawEntity = await exists('', path.join(wt, 'entities/x/e.md'));
        return 'ok';
      }); // no sparsePaths — connect needs the broad scan, must see everything
      expect(sawEntity).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });

  // QA follow-up on #551: the silent-drop landmine (a write outside `sparsePaths` is dropped by `git
  // add`, not errored) had no test exercising the drop itself — only the correctness of a properly-
  // scoped call. Two shapes: (a) EVERY changed path is outside the sparse cone — `git add -A` itself
  // rejects (git's own behavior, already loud); (b) a MIXED write (some in-scope, some not) — `git add
  // -A` succeeds for the in-scope part and silently skips the rest, so a real stage's `prepare` (which
  // always ends `add -A` + commit) would return SUCCESS with the out-of-scope write quietly lost —
  // this is the actual landmine, and only the runtime guard in `withEphemeralWorktree` catches it.
  it('a write OUTSIDE the declared sparsePaths fails loudly — fully-outside case (git itself rejects)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      await expect(
        withEphemeralWorktree(
          root,
          'decompose',
          base,
          async ({ wt }) => {
            await fs.mkdir(path.join(wt, 'entities/oops'), { recursive: true });
            await fs.writeFile(path.join(wt, 'entities/oops/e.md'), 'dropped');
            await simpleGit(wt).raw('add', '-A'); // nothing in-scope changed → git add -A itself rejects
            return 'should not reach here';
          },
          ['sources/A'],
        ),
      ).rejects.toThrow(); // loud either way — git's own rejection or the guard, never a silent success
    } finally {
      await rmTempDir(dir);
    }
  });

  // `git add -A` turns out to reject the WHOLE add (loud, via simple-git) the instant it sees ANY
  // out-of-scope path, even mixed with valid ones — so real stages (which all use `add -A`) are
  // already protected at the git layer. The narrower gap the runtime guard exists for: a SCOPED `git
  // add <known-path>` that never even MENTIONS the out-of-scope path gets no warning from git at all
  // and commits cleanly — the out-of-scope write is left as untracked residue with the caller none the
  // wiser. That's the case only `withEphemeralWorktree`'s post-`fn` status check can catch.
  it('a write outside sparsePaths that a SCOPED `git add <path>` never mentions still fails loudly via the runtime guard', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      await expect(
        withEphemeralWorktree(
          root,
          'decompose',
          base,
          async ({ wt }) => {
            await fs.mkdir(path.join(wt, 'sources/A'), { recursive: true });
            await fs.writeFile(path.join(wt, 'sources/A/candidate.json'), '{}');
            // The BUG: a write outside the declared scope that the add call below never references.
            await fs.mkdir(path.join(wt, 'entities/oops'), { recursive: true });
            await fs.writeFile(path.join(wt, 'entities/oops/e.md'), 'dropped');
            const g = simpleGit(wt);
            await ensureGitIdentity(g);
            await g.raw('add', 'sources/A'); // scoped — never mentions entities/oops, so git raises nothing
            await g.commit('scoped commit'); // succeeds CLEANLY — entities/oops/e.md is untracked residue
            return 'looks like success to the caller';
          },
          ['sources/A'],
        ),
      ).rejects.toThrow(/sparsePaths.*left uncommitted paths|silently dropped/); // the runtime guard, not git, catches this one
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('withConcurrentAdvance — ephemeral-worktree wrapper for cap>1 (ORCH-20)', () => {
  it('advances on the happy path — prepare writes in the helper-provided ephemeral worktree', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      const result = await withConcurrentAdvance(
        { root, lock: new Mutex(), stage: 'decompose' },
        async ({ wt }) => {
          await commitInWt(wt, { 'sources/A/x': 'a' });
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('advanced');
      expect(setAside).toBe(false);
      expect(await exists(root, 'sources/A/x')).toBe(true);
      // The ephemeral worktree was torn down (no leak under .kb/cache/worktrees/decompose-*).
      const wtDir = path.join(root, '.kb', 'cache', 'worktrees');
      const leftover = (await fs.readdir(wtDir).catch(() => [] as string[])).filter((d) => d.startsWith('decompose-'));
      expect(leftover).toEqual([]);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('returns noop when prepare commits nothing', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const result = await withConcurrentAdvance({ root, lock: new Mutex(), stage: 'decompose' }, async () => false, async () => {});
      expect(result).toBe('noop');
      expect(await headCount(root)).toBe(1);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('sets aside after K same-path collisions — never dropped, canonical clean (ORCH-19)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      let setAside = false;
      let attempts = 0;
      const result = await withConcurrentAdvance(
        { root, lock: new Mutex(), stage: 'connect', maxCollisionRetries: 2 },
        async ({ wt, base }) => {
          attempts++;
          await commitInWt(wt, { 'entities/p/steve.md': `mine ${attempts}` });
          // A racing item lands a conflicting SAME-PATH change every attempt → always collides.
          await prepareOnBranch(root, 'kb/racer', base, { 'entities/p/steve.md': `racer ${attempts}` });
          await advanceOrCollide(root, 'kb/racer', base);
          return true;
        },
        async () => {
          setAside = true;
        },
      );
      expect(result).toBe('setaside');
      expect(setAside).toBe(true);
      expect(attempts).toBe(3); // maxCollisionRetries(2) + 1
      expect(await fs.readFile(path.join(root, 'entities/p/steve.md'), 'utf8')).toContain('racer');
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    } finally {
      await rmTempDir(dir);
    }
  });
});

describe.skipIf(!gitAvailable)('reapEphemeralWorktrees — #135 cascade recovery (leaked ephemeral worktrees)', () => {
  it('reaps leaked <stage>-<ULID> worktrees + kb/*-work-* branches; preserves staging + job worktrees', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      const git = simpleGit(root);
      const wtRoot = path.join(root, '.kb', 'cache', 'worktrees');
      const u1 = ulid();
      const u2 = ulid();
      // Two leaked ephemeral worktrees, as a crash/kill mid-item leaves them (dir + admin + branch).
      await git.raw('worktree', 'add', '--force', '-B', `kb/claims-work-${u1}`, path.join(wtRoot, `claims-${u1}`), base);
      await git.raw('worktree', 'add', '--force', '-B', `kb/decompose-work-${u2}`, path.join(wtRoot, `decompose-${u2}`), base);
      // Persistent worktrees that MUST survive a reap: the staging worktree + a per-job worktree.
      // The job worktree uses a 26-char-ULID id (`job-<ULID>`) so its name ALSO matches the ephemeral
      // ULID-shape regex — proving the explicit `job-`/`staging` exclusion is what protects it, not an
      // accident of short job ids (KB-QD's #1 adversarial concern: reaping a live job worktree).
      const jobId = ulid();
      await git.raw('worktree', 'add', '--force', '-B', 'staging', path.join(wtRoot, 'staging'), base);
      await git.raw('worktree', 'add', '--force', '-B', `kb/job-${jobId}`, path.join(wtRoot, `job-${jobId}`), base);
      // An UNKNOWN-prefix worktree whose name still matches the ULID shape — the allowlist must leave
      // it ALONE (fail-safe: never destroy a worktree we don't recognize, only a known stage's).
      const unkId = ulid();
      await git.raw('worktree', 'add', '--force', '-B', `kb/mystery-${unkId}`, path.join(wtRoot, `mystery-${unkId}`), base);

      const { worktrees, branches } = await reapEphemeralWorktrees(root);
      expect(worktrees).toBe(2); // only the two KNOWN-stage ephemerals — NOT staging/job/unknown
      expect(branches).toBe(2);
      // Ephemeral worktrees + their work branches are gone.
      expect(await exists(root, path.join('.kb/cache/worktrees', `claims-${u1}`))).toBe(false);
      expect(await exists(root, path.join('.kb/cache/worktrees', `decompose-${u2}`))).toBe(false);
      const local = (await git.branchLocal()).all;
      expect(local).not.toContain(`kb/claims-work-${u1}`);
      expect(local).not.toContain(`kb/decompose-work-${u2}`);
      // Persistent + unrecognized worktrees survive untouched — incl. the ULID-shaped `job-<ULID>`
      // and the unknown `mystery-<ULID>` (the allowlist's fail-safe: only known stages are reaped).
      expect(await exists(root, '.kb/cache/worktrees/staging')).toBe(true);
      expect(await exists(root, path.join('.kb/cache/worktrees', `job-${jobId}`))).toBe(true);
      expect(await exists(root, path.join('.kb/cache/worktrees', `mystery-${unkId}`))).toBe(true);
      expect(local).toContain('staging');
      expect(local).toContain(`kb/job-${jobId}`);
      expect(local).toContain(`kb/mystery-${unkId}`);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('is a no-op on a clean repo (nothing leaked)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      expect(await reapEphemeralWorktrees(root)).toEqual({ worktrees: 0, branches: 0 });
    } finally {
      await rmTempDir(dir);
    }
  });

  it('drives the kb/*-work-* sweep back to O(0) — locks the O(leaked-N)-per-add churn regression', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const base = await canonicalHead(root);
      const git = simpleGit(root);
      // Simulate the #135 accumulation: many leaked work branches — what EVERY `worktree add` then
      // sweeps one `git branch -D` at a time (`pruneStaleWorktreeBranches`). That O(leaked-N) cost
      // per item is the hang mechanism; the reaper must drive it back to ~0.
      const N = 40;
      for (let i = 0; i < N; i++) await git.raw('branch', `kb/claims-work-${ulid()}`, base);
      const workBranchCount = async (): Promise<number> =>
        (await git.raw('for-each-ref', '--format=%(refname:short)', 'refs/heads/kb/'))
          .split('\n')
          .filter((b) => /-work-[^/]+$/.test(b.trim())).length;
      expect(await workBranchCount()).toBe(N);

      const { branches } = await reapEphemeralWorktrees(root);
      expect(branches).toBe(N);
      expect(await workBranchCount()).toBe(0); // sweep cost now O(0), not O(N) — churn regression locked

      // A normal ephemeral run does NOT re-accumulate (teardown removes its own branch).
      await withEphemeralWorktree(root, 'claims', base, async () => 'ok');
      expect(await workBranchCount()).toBe(0);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('clears a leaked worktree DIR even when its git admin entry is broken (fs.rm fallback)', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeCanonicalRepo(dir);
      const u = ulid();
      const leaked = path.join(root, '.kb', 'cache', 'worktrees', `claims-${u}`);
      // A dir that looks ephemeral but is NOT a registered worktree (admin entry gone) — `git worktree
      // remove` can't handle it, so the raw fs.rm fallback must still clear it (else it piles up).
      await fs.mkdir(leaked, { recursive: true });
      await fs.writeFile(path.join(leaked, '.git'), 'gitdir: /nonexistent/.git/worktrees/claims-broken\n');
      await fs.writeFile(path.join(leaked, 'stale'), 'x');
      const { worktrees } = await reapEphemeralWorktrees(root);
      expect(worktrees).toBe(1);
      expect(await exists(root, path.join('.kb/cache/worktrees', `claims-${u}`))).toBe(false);
    } finally {
      await rmTempDir(dir);
    }
  });
});
