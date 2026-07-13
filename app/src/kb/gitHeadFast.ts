// Cheap, spawn-free reads of a git worktree's current HEAD (#506 — idle status ticks were spawning
// ~2,500 git processes/hour just to learn "did anything change"). These are for GATING/memoization
// ONLY (skip a recompute when nothing moved) — never for correctness-critical checkpoints, which stay
// on the bounded `canonicalHead` git spawn. On ANY unrecognized on-disk shape (packed-refs edge case,
// corrupt state, non-repo) these fall back to the git spawn — a wrong gate value must never silently
// wedge a projection/queue memo, so correctness always wins over the optimization.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalHead, boundedGit } from './canonicalAdvance';

const SHA_RE = /^[0-9a-f]{40}$/;

/** Resolve the real git dir for `root`, correct for BOTH a plain repo (`.git` is a directory) and a
 *  linked worktree (`.git` is a file: `gitdir: <path>`) — mirrors `canonicalLockHeal.resolveIndexLockPath`. */
async function resolveGitDir(root: string): Promise<string> {
  const dotGit = path.join(root, '.git');
  const st = await fs.stat(dotGit);
  if (st.isDirectory()) return dotGit;
  const content = await fs.readFile(dotGit, 'utf8');
  const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) throw new Error('gitHeadFast: unrecognized .git file');
  return path.isAbsolute(m[1]) ? m[1] : path.resolve(root, m[1]);
}

/** Resolve a ref path (e.g. `refs/heads/main`) to its sha: try the loose ref file first, then fall
 *  back to `packed-refs` (git packs loose refs away after gc). Throws if neither has it. */
async function readRefSha(gitDir: string, refPath: string): Promise<string> {
  try {
    return (await fs.readFile(path.join(gitDir, refPath), 'utf8')).trim();
  } catch {
    const packed = await fs.readFile(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      if (!line || line[0] === '#' || line[0] === '^') continue;
      const sp = line.indexOf(' ');
      if (sp === -1) continue;
      if (line.slice(sp + 1).trim() === refPath) return line.slice(0, sp).trim();
    }
    throw new Error(`gitHeadFast: ref not found: ${refPath}`);
  }
}

/** Fast HEAD sha for GATING (fs reads only, no git spawn). Falls back to `canonicalHead` (git spawn)
 *  on any unrecognized shape — detached HEAD, corrupt/missing files, or a non-repo root. */
export async function fastHeadSha(root: string): Promise<string> {
  try {
    const r = path.resolve(root);
    const gitDir = await resolveGitDir(r);
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    if (SHA_RE.test(head)) return head; // detached HEAD — the file itself IS the sha
    const m = head.match(/^ref:\s*(refs\/.+)$/);
    if (!m) throw new Error('gitHeadFast: unrecognized HEAD shape');
    const sha = await readRefSha(gitDir, m[1]);
    if (!SHA_RE.test(sha)) throw new Error('gitHeadFast: unrecognized ref shape');
    return sha;
  } catch {
    return canonicalHead(root);
  }
}

/** Fast current branch name for GATING/display (fs reads only, no git spawn) — mirrors
 *  `git rev-parse --abbrev-ref HEAD` (returns the literal `'HEAD'` when detached). Falls back to a
 *  bounded git spawn on any unrecognized shape. */
export async function fastHeadBranch(root: string): Promise<string> {
  try {
    const r = path.resolve(root);
    const gitDir = await resolveGitDir(r);
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    if (SHA_RE.test(head)) return 'HEAD'; // detached
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (!m) throw new Error('gitHeadFast: unrecognized HEAD shape');
    return m[1];
  } catch {
    return (await boundedGit(root).revparse(['--abbrev-ref', 'HEAD'])).trim();
  }
}
