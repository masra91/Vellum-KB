// #517 BUG-10 regression: `commitControlFile`'s `git.add(rel)` was already pathspec-scoped, but its
// `git.commit(message)` had NO pathspec — so a foreign file staged by a concurrent/leftover writer got
// silently swept into the "control-panel: ..." commit (misattributed history), and an unscoped
// `diff --cached` staged-check could short-circuit `return` on someone ELSE's staged change even when
// `rel` itself had nothing new. The fix scopes BOTH to `rel`.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { gitAvailable } from '../../test/gitEnv';
import { ensureGitIdentity } from '../kb/vault';
import { commitControlFile } from './pipeline';

async function makeRepo(dir: string): Promise<string> {
  const root = path.join(dir, 'repo');
  await fs.mkdir(root, { recursive: true });
  const git = simpleGit(root);
  await git.init(['--initial-branch=main']);
  await ensureGitIdentity(git);
  await fs.writeFile(path.join(root, 'README'), 'seed\n');
  await git.raw('add', '-A');
  await git.commit('seed');
  return root;
}

describe.skipIf(!gitAvailable)('#517 BUG-10: commitControlFile pathspec-scoped commit', () => {
  it('a foreign file staged by another writer is NOT swept into the control-panel commit', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeRepo(dir);
      const git = simpleGit(root);

      // Simulate a concurrent/leftover writer's staged-but-not-committed change.
      const foreign = path.join(root, 'foreign.txt');
      await fs.writeFile(foreign, 'someone else was here\n');
      await git.add('foreign.txt');

      const ctl = path.join(root, '.kb', 'instance.json');
      await fs.mkdir(path.dirname(ctl), { recursive: true });
      await fs.writeFile(ctl, '{"v":1}\n');

      await commitControlFile(root, ctl, 'test change');

      const committed = (await git.raw('show', '--stat', '--format=', 'HEAD')).trim();
      expect(committed).toContain('.kb/instance.json'); // the intended file landed
      expect(committed).not.toContain('foreign.txt'); // the foreign staged file was NOT swept in

      // The foreign file is still staged (untouched), not lost — just not part of THIS commit.
      const stagedAfter = (await git.diff(['--cached', '--name-only'])).trim();
      expect(stagedAfter).toBe('foreign.txt');
    } finally {
      await rmTempDir(dir);
    }
  });

  it('no-op (no commit) when `rel` has no staged change, even if something else is staged', async () => {
    const dir = await makeTempDir();
    try {
      const root = await makeRepo(dir);
      const git = simpleGit(root);
      const headBefore = (await git.revparse(['HEAD'])).trim();

      // Something else is staged…
      await fs.writeFile(path.join(root, 'foreign.txt'), 'someone else\n');
      await git.add('foreign.txt');

      // …but the control file itself is UNCHANGED (already committed, identical content).
      const ctl = path.join(root, 'README'); // reuse the already-committed, unchanged seed file
      await commitControlFile(root, ctl, 'should not commit');

      expect((await git.revparse(['HEAD'])).trim()).toBe(headBefore); // no new commit
      const stagedAfter = (await git.diff(['--cached', '--name-only'])).trim();
      expect(stagedAfter).toBe('foreign.txt'); // the foreign stage is left exactly as it was
    } finally {
      await rmTempDir(dir);
    }
  });
});
