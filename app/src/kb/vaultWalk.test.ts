import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import { walkVaultFiles } from './vaultWalk';

describe('walkVaultFiles (SPEC-0061 T1 / ENG-9 walker consolidation)', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rmTempDir(root);
  });

  it('returns root-relative paths, recursively, sorted deterministically', async () => {
    root = await makeTempDir('kb-walk-');
    await fs.mkdir(path.join(root, 'entities', 'person'), { recursive: true });
    await fs.writeFile(path.join(root, 'entities', 'b.md'), 'b');
    await fs.writeFile(path.join(root, 'entities', 'person', 'a.md'), 'a');
    await fs.writeFile(path.join(root, 'entities', 'ignored.txt'), 'x');

    const rels = await walkVaultFiles(root, 'entities', { keep: (n) => n.endsWith('.md') });
    expect(rels).toEqual([path.join('entities', 'b.md'), path.join('entities', 'person', 'a.md')]);
  });

  it('skips dot-dirs and dotfiles', async () => {
    root = await makeTempDir('kb-walk-');
    await fs.mkdir(path.join(root, 'entities', '.trash'), { recursive: true });
    await fs.writeFile(path.join(root, 'entities', '.trash', 'ghost.md'), 'x');
    await fs.writeFile(path.join(root, 'entities', '.hidden.md'), 'x');
    await fs.writeFile(path.join(root, 'entities', 'real.md'), 'ok');

    const rels = await walkVaultFiles(root, 'entities', { keep: (n) => n.endsWith('.md') });
    expect(rels).toEqual([path.join('entities', 'real.md')]);
  });

  it('never follows a symlinked directory or file', async () => {
    root = await makeTempDir('kb-walk-');
    await fs.mkdir(path.join(root, 'entities'), { recursive: true });
    await fs.mkdir(path.join(root, 'outside'), { recursive: true });
    await fs.writeFile(path.join(root, 'outside', 'secret.md'), 'leak');
    await fs.symlink(path.join(root, 'outside'), path.join(root, 'entities', 'linked-dir'));
    await fs.writeFile(path.join(root, 'entities', 'real.md'), 'ok');
    await fs.symlink(path.join(root, 'entities', 'real.md'), path.join(root, 'entities', 'linked-file.md'));

    const rels = await walkVaultFiles(root, 'entities', { keep: (n) => n.endsWith('.md') });
    expect(rels).toEqual([path.join('entities', 'real.md')]);
  });

  it('honors maxDepth', async () => {
    root = await makeTempDir('kb-walk-');
    await fs.mkdir(path.join(root, 'entities', 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(root, 'entities', 'top.md'), 'x');
    await fs.writeFile(path.join(root, 'entities', 'a', 'mid.md'), 'x');
    await fs.writeFile(path.join(root, 'entities', 'a', 'b', 'deep.md'), 'x');

    const rels = await walkVaultFiles(root, 'entities', { keep: (n) => n.endsWith('.md'), maxDepth: 1 });
    expect(rels).toEqual([path.join('entities', 'a', 'mid.md'), path.join('entities', 'top.md')]);
  });

  it('a missing directory returns [] rather than throwing', async () => {
    root = await makeTempDir('kb-walk-');
    await expect(walkVaultFiles(root, 'nope', {})).resolves.toEqual([]);
  });
});
