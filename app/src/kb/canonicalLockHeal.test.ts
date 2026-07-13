// SPEC-0014 ORCH-27 — stale-lock self-heal tests. The never-clear-a-live-lock cases are the
// GATE-OF-RECORD (KB-Lead): a live sidecar-pid, a fresh external lock, an inconclusive scan, and a
// live in-process op must EACH be left untouched — clearing a live lock corrupts the repo.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import {
  classifyIndexLock,
  reconcileStaleIndexLock,
  resolveIndexLockPath,
  resolveGitDir,
  reconcileCherryPickSequencer,
  GATE3_STALE_AGE_MS,
  type ClassifyInputs,
} from './canonicalLockHeal';
import simpleGit from 'simple-git';
import { writeLockMeta, readLockMeta, type CanonicalLockMeta } from './canonicalLockMeta';
import { advanceOrCollide } from './canonicalAdvance';
import { ensureGitIdentity } from './vault';

const NOW = 1_700_000_000_000;
const base = (over: Partial<ClassifyInputs> = {}): ClassifyInputs => ({
  lockExists: true,
  lockAgeMs: 0,
  meta: null,
  liveInProcHolder: false,
  selfPid: 1000,
  pidAlive: () => true,
  externalGitScan: 'none',
  now: NOW,
  ...over,
});
const meta = (over: Partial<CanonicalLockMeta> = {}): CanonicalLockMeta => ({ pid: 4242, startedAt: NOW, op: 'advance', timeoutMs: 20_000, ...over });
// A complete DevLog whose `warn` is a spy (the others noop). `child` returns self so scoped logging works.
const fakeLog = () => {
  const warn = vi.fn();
  const log = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn(), child: () => log, flush: async () => {} };
  return { log, warn };
};

describe('ORCH-27 classifyIndexLock (PURE triple-gate truth table)', () => {
  it('no lock on disk → absent (the healthy common case)', () => {
    expect(classifyIndexLock(base({ lockExists: false }))).toEqual({ action: 'absent' });
  });

  // GATE 1 — live in-process holder
  it('SAFETY gate-1: a live in-process index-op holds it → KEEP (even if a sidecar looks dead)', () => {
    const v = classifyIndexLock(base({ liveInProcHolder: true, meta: meta({ pid: 999999, startedAt: 0 }), pidAlive: () => false }));
    expect(v.action).toBe('keep');
  });

  // GATE 2 — sidecar present
  it('gate-2: sidecar pid is DEAD → clear', () => {
    const v = classifyIndexLock(base({ meta: meta({ pid: 4242 }), pidAlive: () => false }));
    expect(v.action).toBe('clear');
  });

  it('gate-2: sidecar pid == self with no live in-proc op → clear (our prior op leaked it)', () => {
    const v = classifyIndexLock(base({ selfPid: 1000, meta: meta({ pid: 1000 }), pidAlive: () => true }));
    expect(v.action).toBe('clear');
    if (v.action === 'clear') expect(v.reason).toContain('self');
  });

  it('gate-2: sidecar pid alive (other proc) but age > 2×timeout → clear (detached leak)', () => {
    const v = classifyIndexLock(base({ meta: meta({ pid: 4242, startedAt: NOW - 41_000, timeoutMs: 20_000 }), pidAlive: () => true, now: NOW }));
    expect(v.action).toBe('clear');
  });

  it('SAFETY gate-2: sidecar pid alive (other proc) AND within age → KEEP (a live op in another instance)', () => {
    const v = classifyIndexLock(base({ meta: meta({ pid: 4242, startedAt: NOW - 5_000, timeoutMs: 20_000 }), pidAlive: () => true, now: NOW }));
    expect(v.action).toBe('keep');
  });

  // GATE 3 — no sidecar (external holder)
  it('SAFETY gate-3: no sidecar + a LIVE external git process → KEEP', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'present', lockAgeMs: GATE3_STALE_AGE_MS * 10 })).action).toBe('keep');
  });

  it('SAFETY gate-3: no sidecar + INCONCLUSIVE scan → KEEP (fail safe, never clear on a scan we could not run)', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'inconclusive', lockAgeMs: GATE3_STALE_AGE_MS * 10 })).action).toBe('keep');
  });

  it('SAFETY gate-3: no sidecar + no live git but lock is FRESH (≤ threshold) → KEEP', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'none', lockAgeMs: GATE3_STALE_AGE_MS - 1 })).action).toBe('keep');
  });

  it('SAFETY gate-3: no sidecar + lock age UNKNOWN → KEEP (fail safe)', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'none', lockAgeMs: null })).action).toBe('keep');
  });

  it('gate-3: no sidecar + no live git + lock OLDER than threshold → clear', () => {
    expect(classifyIndexLock(base({ meta: null, externalGitScan: 'none', lockAgeMs: GATE3_STALE_AGE_MS + 1 })).action).toBe('clear');
  });
});

describe('ORCH-27 reconcileStaleIndexLock (wiring + heal)', () => {
  let root: string;
  afterEach(async () => {
    if (root) await rmTempDir(root);
  });

  const makeIndexLock = async (r: string): Promise<string> => {
    await fs.mkdir(path.join(r, '.git'), { recursive: true });
    const p = await resolveIndexLockPath(r);
    await fs.writeFile(p, '', 'utf8');
    return p;
  };

  it('no lock → absent, nothing cleared', async () => {
    root = await makeTempDir('kb-heal-');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    const audit = vi.fn();
    expect(await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => false, audit })).toEqual({ action: 'absent' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('gate-2: a dead-pid sidecar lock is CLEARED — lock + sidecar removed, clear audited + dev-logged', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    await writeLockMeta(root, { pid: 4242, startedAt: NOW, op: 'advance', timeoutMs: 20_000 });
    const audit = vi.fn();
    const { log, warn } = fakeLog();

    const v = await reconcileStaleIndexLock(root, {
      isLiveInProcHolder: () => false,
      pidAlive: () => false, // the recorded pid is dead
      now: () => NOW,
      audit,
      log,
    });

    expect(v.action).toBe('clear');
    await expect(fs.access(lock)).rejects.toThrow(); // index.lock removed
    expect(await readLockMeta(root)).toBeNull(); // sidecar removed
    expect(audit).toHaveBeenCalledTimes(1); // every clear audited
    expect(warn).toHaveBeenCalledWith('orch.lock.healed', expect.objectContaining({ lock })); // visible, not silent
  });

  it('SAFETY: a live in-process holder → KEEP, the lock is NOT removed', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    await writeLockMeta(root, { pid: 4242, startedAt: NOW, op: 'advance', timeoutMs: 20_000 });
    const audit = vi.fn();
    const v = await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => true, pidAlive: () => false, now: () => NOW, audit });
    expect(v.action).toBe('keep');
    await expect(fs.access(lock)).resolves.toBeUndefined(); // lock untouched
    expect(audit).not.toHaveBeenCalled();
  });

  it('SAFETY: a live sidecar pid within age → KEEP, lock NOT removed (a live op in another instance)', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    await writeLockMeta(root, { pid: 4242, startedAt: NOW - 5_000, op: 'advance', timeoutMs: 20_000 });
    const v = await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => false, pidAlive: () => true, now: () => NOW });
    expect(v.action).toBe('keep');
    await expect(fs.access(lock)).resolves.toBeUndefined();
  });

  it('SAFETY: no sidecar + inconclusive external scan → KEEP + held-stall surfaced (visible)', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    const { log, warn } = fakeLog();
    const v = await reconcileStaleIndexLock(root, {
      isLiveInProcHolder: () => false,
      scanExternalGit: async () => 'inconclusive',
      now: () => NOW,
      log,
    });
    expect(v.action).toBe('keep');
    await expect(fs.access(lock)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('orch.lock.held', expect.anything()); // the stall is named, never silent
  });

  // REGRESSION (fails-before/passes-after, the CLASS = "a stale lock left by a crash wedges every
  // future advance until healed"): a leaked dead-pid lock must be cleared so a subsequent acquire can
  // proceed. Before ORCH-27 the lock persisted and every advance stayed wedged (#256).
  it('REGRESSION #256: a crash-leaked stale lock is healed so the next advance is unblocked', async () => {
    root = await makeTempDir('kb-heal-');
    const lock = await makeIndexLock(root);
    await writeLockMeta(root, { pid: 999_999, startedAt: NOW - 10 * 60_000, op: 'advance', timeoutMs: 20_000 }); // dead crashed proc
    const v = await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => false, pidAlive: () => false, now: () => NOW });
    expect(v.action).toBe('clear');
    await expect(fs.access(lock)).rejects.toThrow(); // wedge cleared → a fresh acquire can now take index.lock
  });
});

describe('ORCH-27 acquire-finds-stale through the REAL advanceOrCollide path (integration, real git)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rmTempDir(dir);
  });

  const seedRepo = async (): Promise<string> => {
    const root = path.join(dir, 'repo');
    await fs.mkdir(root, { recursive: true });
    const git = simpleGit(root);
    await git.init(['--initial-branch=canon']);
    await ensureGitIdentity(git);
    await fs.writeFile(path.join(root, 'README'), 'seed\n');
    await git.raw('add', '-A');
    await git.commit('seed');
    return root;
  };

  // The #256 wedge end-to-end: a stale index.lock present at advance time would make `merge --ff-only`
  // fatal forever. With ORCH-27's acquire-finds-stale pre-check, advanceOrCollide heals the leaked lock
  // (gate-2: sidecar pid==self with no live op) and the advance SUCCEEDS. A leaked-by-self sidecar is a
  // deterministic stale signal (no dependence on pid-liveness probing or the ps scan).
  it('REGRESSION #256: a leaked index.lock present before the advance is healed → advance succeeds', async () => {
    dir = await makeTempDir('kb-heal-int-');
    const root = await seedRepo();
    const git = simpleGit(root);
    const base = (await git.revparse(['HEAD'])).trim();

    // A prepared work branch one commit ahead of base (what a stage's off-lock prepare produces).
    const wt = path.join(root, '.kb', 'cache', 'wt-work');
    await git.raw('worktree', 'add', '--force', '-B', 'kb/work', wt, base);
    const wtGit = simpleGit(wt);
    await ensureGitIdentity(wtGit);
    await fs.writeFile(path.join(wt, 'a.txt'), 'hello\n');
    await wtGit.raw('add', '-A');
    await wtGit.commit('work commit');
    await git.raw('worktree', 'remove', '--force', wt);

    // Plant a STALE lock + a leaked-by-self sidecar (pid==self, old) — the post-crash on-disk state.
    const lockPath = await resolveIndexLockPath(root);
    await fs.writeFile(lockPath, '', 'utf8');
    await writeLockMeta(root, { pid: process.pid, startedAt: Date.now() - 10 * 60_000, op: 'advance', timeoutMs: 20_000 });

    // The REAL advance path: pre-check heals the leaked lock, then the ff-advance succeeds.
    const outcome = await advanceOrCollide(root, 'kb/work', base);

    expect(outcome).toBe('advanced');
    await expect(fs.access(lockPath)).rejects.toThrow(); // the stale lock is gone (healed, then cleanly released)
    expect(await readLockMeta(root)).toBeNull(); // sidecar cleared after the clean advance
    // HEAD advanced to include the work commit (the wedge is resolved, not merely cleared).
    expect((await git.revparse(['HEAD'])).trim()).not.toBe(base);
    expect((await git.raw('log', '--oneline')).includes('work commit')).toBe(true);
  });
});

// #515 BUG-2 — startup CHERRY_PICK_HEAD / sequencer heal: a SIGKILL mid cherry-pick leaves the
// canonical worktree in a sequencer state nothing detected before. Without this, the NEXT capture's
// plain `add inbox` + commit silently CONCLUDES the stale cherry-pick under a "capture:" message
// (possibly with conflict markers) — the exact silent-corruption mechanism the issue describes.
describe('#515 reconcileCherryPickSequencer (startup heal)', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rmTempDir(dir);
  });

  it('no CHERRY_PICK_HEAD → absent, no git invoked (the healthy common case)', async () => {
    dir = await makeTempDir('kb-cp-heal-');
    const root = path.join(dir, 'repo');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    const runGit = vi.fn();
    const v = await reconcileCherryPickSequencer(root, { runGit });
    expect(v).toBe('absent');
    expect(runGit).not.toHaveBeenCalled();
  });

  it('SAFETY: CHERRY_PICK_HEAD present + a live external git process → KEEP, nothing touched', async () => {
    dir = await makeTempDir('kb-cp-heal-');
    const root = path.join(dir, 'repo');
    const gitDir = await resolveGitDir(root); // no .git yet → falls back to <root>/.git
    await fs.mkdir(gitDir, { recursive: true });
    const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD');
    await fs.writeFile(cherryPickHead, 'deadbeef\n', 'utf8');
    const runGit = vi.fn();
    const v = await reconcileCherryPickSequencer(root, { runGit, scanExternalGit: async () => 'present' });
    expect(v).toBe('kept');
    expect(runGit).not.toHaveBeenCalled();
    await expect(fs.access(cherryPickHead)).resolves.toBeUndefined(); // untouched — fail safe
  });

  it('SAFETY: CHERRY_PICK_HEAD present + inconclusive scan → KEEP (never clear on a scan we could not run)', async () => {
    dir = await makeTempDir('kb-cp-heal-');
    const root = path.join(dir, 'repo');
    const gitDir = await resolveGitDir(root);
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, 'CHERRY_PICK_HEAD'), 'deadbeef\n', 'utf8');
    const runGit = vi.fn();
    const v = await reconcileCherryPickSequencer(root, { runGit, scanExternalGit: async () => 'inconclusive' });
    expect(v).toBe('kept');
    expect(runGit).not.toHaveBeenCalled();
  });

  it('present + no live external git → CLEARED via `cherry-pick --abort`', async () => {
    dir = await makeTempDir('kb-cp-heal-');
    const root = path.join(dir, 'repo');
    const gitDir = await resolveGitDir(root);
    await fs.mkdir(gitDir, { recursive: true });
    const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD');
    await fs.writeFile(cherryPickHead, 'deadbeef\n', 'utf8');
    const runGit = vi.fn(async (_root: string, args: string[]) => {
      if (args[0] === 'cherry-pick' && args[1] === '--abort') await fs.rm(cherryPickHead, { force: true });
    });
    const audit = vi.fn();
    const v = await reconcileCherryPickSequencer(root, { runGit, scanExternalGit: async () => 'none', audit });
    expect(v).toBe('cleared');
    expect(runGit).toHaveBeenCalledWith(root, ['cherry-pick', '--abort']);
    expect(audit).toHaveBeenCalledTimes(1);
    await expect(fs.access(cherryPickHead)).rejects.toThrow();
  });

  it('present + `--abort` itself fails → falls back to a hard reset, still CLEARED', async () => {
    dir = await makeTempDir('kb-cp-heal-');
    const root = path.join(dir, 'repo');
    const gitDir = await resolveGitDir(root);
    await fs.mkdir(gitDir, { recursive: true });
    const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD');
    await fs.writeFile(cherryPickHead, 'deadbeef\n', 'utf8');
    await fs.mkdir(path.join(gitDir, 'sequencer'), { recursive: true });
    const runGit = vi.fn(async (_root: string, args: string[]) => {
      if (args[0] === 'cherry-pick') throw new Error('abort failed — corrupt sequencer');
      // 'reset --hard HEAD' succeeds — the function itself removes CHERRY_PICK_HEAD/sequencer after.
    });
    const v = await reconcileCherryPickSequencer(root, { runGit, scanExternalGit: async () => 'none' });
    expect(v).toBe('cleared');
    expect(runGit).toHaveBeenCalledWith(root, ['reset', '--hard', 'HEAD']);
    await expect(fs.access(cherryPickHead)).rejects.toThrow();
    await expect(fs.access(path.join(gitDir, 'sequencer'))).rejects.toThrow();
  });

  // REGRESSION (real git, end-to-end): an interrupted CONFLICTING cherry-pick leaves CHERRY_PICK_HEAD;
  // the heal clears it, and — the actual #515 acceptance criterion — a subsequent commit only contains
  // the files it explicitly stages (an `inbox/`-only pathspec commit, mirroring a real capture), never
  // any half-applied content the abandoned cherry-pick had staged.
  it('REGRESSION #515: an interrupted CONFLICTING cherry-pick is healed; a later scoped commit stays clean', async () => {
    dir = await makeTempDir('kb-cp-heal-int-');
    const root = path.join(dir, 'repo');
    await fs.mkdir(root, { recursive: true });
    const git = simpleGit(root);
    await git.init(['--initial-branch=canon']);
    await ensureGitIdentity(git);
    await fs.writeFile(path.join(root, 'shared.txt'), 'base\n');
    await git.raw('add', '-A');
    await git.commit('seed');
    const base = (await git.revparse(['HEAD'])).trim();

    // A work branch that conflicts with canon on the same file.
    await git.checkoutBranch('kb/work', base);
    await fs.writeFile(path.join(root, 'shared.txt'), 'work-change\n');
    await git.raw('add', '-A');
    await git.commit('work change');
    const workHead = (await git.revparse(['HEAD'])).trim();
    await git.checkout('canon');
    await fs.writeFile(path.join(root, 'shared.txt'), 'canon-change\n');
    await git.raw('add', '-A');
    await git.commit('canon change');

    // Start (and deliberately abandon, mid-conflict) a cherry-pick — simulates a SIGKILL leaving the
    // sequencer state on disk, exactly what a crash mid-`advanceOrCollide` would produce.
    await git.raw('cherry-pick', workHead).catch(() => {}); // conflicts → leaves CHERRY_PICK_HEAD, no throw needed for the test
    const gitDir = await resolveGitDir(root);
    await expect(fs.access(path.join(gitDir, 'CHERRY_PICK_HEAD'))).resolves.toBeUndefined(); // sequencer state confirmed present

    const v = await reconcileCherryPickSequencer(root, { scanExternalGit: async () => 'none' });
    expect(v).toBe('cleared');
    await expect(fs.access(path.join(gitDir, 'CHERRY_PICK_HEAD'))).rejects.toThrow(); // sequencer cleared

    // A subsequent capture-shaped commit — add only `inbox/`, nothing else — must NOT pick up any
    // leftover conflict-markered content from the abandoned pick (there is none to pick up: the reset
    // restored the pre-pick tree exactly).
    await fs.mkdir(path.join(root, 'inbox'), { recursive: true });
    await fs.writeFile(path.join(root, 'inbox', 'note.md'), 'a capture\n');
    await git.raw('add', 'inbox');
    await git.commit('capture: 1 item(s) [test]');
    const committed = (await git.raw('show', '--stat', '--format=', 'HEAD')).trim();
    expect(committed).toContain('inbox/note.md');
    expect(committed).not.toContain('shared.txt'); // the conflicted file was never re-touched by capture
    expect((await fs.readFile(path.join(root, 'shared.txt'), 'utf8')).trim()).toBe('canon-change'); // canon's own content, no conflict markers
  });
});
