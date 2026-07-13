// #506 — spawn-free HEAD reads for hot-path gating. Real git against a throwaway repo (TEST-18):
// proves fastHeadSha/fastHeadBranch match the git-spawn ground truth in every shape they claim to
// handle (plain repo, linked worktree, packed-refs, detached HEAD), and that the fallback still
// gives a CORRECT answer (never a wrong one) when a shape isn't the fast path's to parse.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { ensureGitIdentity } from './vault';
import { canonicalHead } from './canonicalAdvance';
import { fastHeadSha, fastHeadBranch } from './gitHeadFast';

async function makeRepo(dir: string): Promise<string> {
  const root = path.join(dir, 'repo');
  await fs.mkdir(root, { recursive: true });
  const git = simpleGit(root);
  await git.init(['--initial-branch=main']);
  await ensureGitIdentity(git);
  await fs.writeFile(path.join(root, 'seed.txt'), 'seed\n');
  await git.raw('add', '-A');
  await git.commit('seed');
  return root;
}

describe.skipIf(!gitAvailable)('gitHeadFast (#506 — no git spawn for gating)', () => {
  it('fastHeadSha matches the real git-spawn HEAD on a plain repo', async () => {
    const dir = await makeTempDir('kb-githeadfast-');
    try {
      const root = await makeRepo(dir);
      expect(await fastHeadSha(root)).toBe(await canonicalHead(root));
    } finally {
      await rmTempDir(dir);
    }
  });

  it('fastHeadSha tracks a new commit (moves with HEAD, not stuck on the first read)', async () => {
    const dir = await makeTempDir('kb-githeadfast-');
    try {
      const root = await makeRepo(dir);
      const before = await fastHeadSha(root);
      await fs.writeFile(path.join(root, 'seed.txt'), 'changed\n');
      const git = simpleGit(root);
      await git.raw('add', '-A');
      await git.commit('second');
      const after = await fastHeadSha(root);
      expect(after).not.toBe(before);
      expect(after).toBe(await canonicalHead(root));
    } finally {
      await rmTempDir(dir);
    }
  });

  it('fastHeadSha resolves correctly inside a LINKED WORKTREE (`.git` is a file, not a dir)', async () => {
    const dir = await makeTempDir('kb-githeadfast-');
    try {
      const root = await makeRepo(dir);
      const wt = path.join(dir, 'wt');
      await simpleGit(root).raw('worktree', 'add', '-b', 'feature', wt, 'main');
      expect(await fs.stat(path.join(wt, '.git')).then((s) => s.isFile())).toBe(true); // sanity: really a linked worktree
      expect(await fastHeadSha(wt)).toBe(await canonicalHead(wt));
      await fs.writeFile(path.join(wt, 'wt-only.txt'), 'x\n');
      const wtGit = simpleGit(wt);
      await ensureGitIdentity(wtGit);
      await wtGit.raw('add', '-A');
      await wtGit.commit('advance feature');
      expect(await fastHeadSha(wt)).toBe(await canonicalHead(wt));
      expect(await fastHeadSha(wt)).not.toBe(await fastHeadSha(root)); // feature has diverged from main
    } finally {
      await rmTempDir(dir);
    }
  });

  it('fastHeadSha falls back to packed-refs after `git pack-refs`', async () => {
    const dir = await makeTempDir('kb-githeadfast-');
    try {
      const root = await makeRepo(dir);
      const git = simpleGit(root);
      await git.raw('pack-refs', '--all'); // moves refs/heads/main out of the loose-ref file
      expect(await fs.stat(path.join(root, '.git', 'refs', 'heads', 'main')).catch(() => null)).toBeNull(); // sanity: loose ref really gone
      expect(await fastHeadSha(root)).toBe(await canonicalHead(root));
    } finally {
      await rmTempDir(dir);
    }
  });

  it('fastHeadSha handles a DETACHED HEAD (the file itself IS the sha)', async () => {
    const dir = await makeTempDir('kb-githeadfast-');
    try {
      const root = await makeRepo(dir);
      const sha = await canonicalHead(root);
      await simpleGit(root).checkout(sha);
      expect(await fastHeadSha(root)).toBe(sha);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('fastHeadSha falls back to the git spawn (still correct) on a non-repo directory', async () => {
    const dir = await makeTempDir('kb-githeadfast-');
    try {
      await expect(fastHeadSha(dir)).rejects.toThrow(); // no repo → canonicalHead's own spawn also throws
    } finally {
      await rmTempDir(dir);
    }
  });

  it('fastHeadBranch matches `git rev-parse --abbrev-ref HEAD` on a plain repo + a linked worktree', async () => {
    const dir = await makeTempDir('kb-githeadfast-');
    try {
      const root = await makeRepo(dir);
      expect(await fastHeadBranch(root)).toBe('main');
      expect((await simpleGit(root).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('main');

      const wt = path.join(dir, 'wt');
      await simpleGit(root).raw('worktree', 'add', '-b', 'feature', wt, 'main');
      expect(await fastHeadBranch(wt)).toBe('feature');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('fastHeadBranch returns "HEAD" (git\'s own convention) when detached', async () => {
    const dir = await makeTempDir('kb-githeadfast-');
    try {
      const root = await makeRepo(dir);
      await simpleGit(root).checkout(await canonicalHead(root));
      expect(await fastHeadBranch(root)).toBe('HEAD');
      expect((await simpleGit(root).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('HEAD');
    } finally {
      await rmTempDir(dir);
    }
  });
});
