// Optimistic-concurrency canonical advance (SPEC-0014 ORCH-17/18/19). The shared writer lock used
// to guard a stage's WHOLE per-item cycle (sync → cognition → write → commit → ff-advance). This
// narrows it to ONLY the canonical ff-advance: a stage prepares its commit OFF a synced checkpoint
// outside the lock (ORCH-17), then advances UNDER the lock (ORCH-18). Conflict-freedom rides on
// globally-unique ULID write paths (ORCH-6): items almost always touch disjoint paths, so a moved
// canonical is reconciled by REPLAYING the item commit (cherry-pick) — no merge bubble, linear
// history (ORCH-3). The rare same-path collision (e.g. two Connect items resolving the same block)
// is detected and retried against the fresh canonical, bounded → set-aside (ORCH-19).
import path from 'node:path';
import { promises as fs } from 'node:fs';
import simpleGit from 'simple-git';
import { Mutex } from './stageLock';
import { ulid } from './ulid';
import { ensureGitIdentity } from './vault';
import { noopDevLog, type DevLog } from './devlog';
import { reconcileStaleIndexLock, hasLiveIndexHolder, withCanonicalIndexLock } from './canonicalLockHeal';

/** Default same-path collision retries before an item is set aside (ORCH-19). */
export const DEFAULT_MAX_COLLISION_RETRIES = 3;

/** Default per-stage concurrency cap (ORCH-20). cap=1 ⇒ the serial drain (output-identical to the
 *  pre-concurrency engine); a higher cap lets a stage run that many items' cognition at once,
 *  their advances still serialized by the shared lock. Raised deliberately by pipeline.ts. */
export const DEFAULT_STAGE_CAP = 1;

/** Cap any single git invocation in the worktree lifecycle / enumeration (#135 cascade): if a git
 *  child produces no output for this long it is killed, so a pathological worktree, lock, or
 *  prompt can never hang the pipeline or a status read indefinitely. Generous — normal ops are
 *  sub-second; this only ever fires on a genuine stall. */
export const WORKTREE_GIT_TIMEOUT_MS = 20_000;

/** A simple-git handle whose every command is time-bounded: simple-git kills the child if it goes
 *  `timeoutMs` with no output (a stalled fetch, a credential/editor prompt, a hung hook), so a
 *  blocked git op REJECTS instead of hanging forever. `timeoutMs` is overridable so callers under
 *  the canonical-writer lock can tune it and tests can drive the timeout fast (#163). */
export function boundedGit(dir: string, timeoutMs: number = WORKTREE_GIT_TIMEOUT_MS): ReturnType<typeof simpleGit> {
  return simpleGit(dir, { timeout: { block: timeoutMs } });
}

/** The stages that create EPHEMERAL per-item worktrees via {@link withEphemeralWorktree} (named
 *  `<stage>-<ULID>`). `connect` is included for when its cap migration lands (today it uses a fixed
 *  worktree). This is an explicit ALLOWLIST, NOT a `-<ULID>$` shape match — a shape match would also
 *  hit a persistent `job-<id>` worktree whose id is 26 chars (a ULID, which `isSafeJobId` permits) or
 *  the `staging` worktree, and reaping one of those is latent data loss. The allowlist fails safe: an
 *  unrecognized worktree (incl. a future persistent type) is left ALONE rather than destroyed; the
 *  cost is only that a NEW ephemeral stage must be added here to be reaped (a recoverable leak, not
 *  data loss). (KB-QD #151 gate; allowlist > denylist for a destructive guard.) */
const EPHEMERAL_STAGES = ['archive', 'claims', 'connect', 'decompose', 'consolidation'] as const;
const EPHEMERAL_WT_NAME = new RegExp(`^(${EPHEMERAL_STAGES.join('|')})-[0-9A-Za-z]{26}$`);

/** True iff `name` is an ephemeral per-item worktree dir safe to reap — i.e. `<known-stage>-<ULID>`.
 *  The persistent `staging` + `job-<id>` worktrees never match (they are not stage prefixes). */
function isReapableEphemeralWorktree(name: string): boolean {
  return EPHEMERAL_WT_NAME.test(name);
}

/**
 * Run `fn` against a FRESH, isolated git worktree for ONE in-flight item (ORCH-17/20): a unique
 * work branch `kb/<stage>-work-<ulid>` checked out off `checkpoint`, torn down afterward. This is
 * what lets a stage run cap>1 items concurrently — each prepares in its own worktree+branch instead
 * of clobbering a single shared one. The teardown is best-effort + prune-guarded so a crash mid-item
 * can't leak a worktree (a `worktree prune` on the next call reaps any orphan).
 */
/**
 * Reap stale ephemeral work branches (`kb/*-work-<ulid>`) left behind by a failed teardown (a rare
 * `branch -D` that was swallowed). Runs AFTER `worktree prune`, so an orphan branch whose worktree
 * dir is already gone is now deletable; a branch still checked out in a LIVE worktree (a concurrent
 * in-flight item) refuses `-D` and is skipped — so this is safe to run on every call (QA #59 note).
 */
async function pruneStaleWorktreeBranches(git: ReturnType<typeof simpleGit>): Promise<void> {
  const out = await git.raw('for-each-ref', '--format=%(refname:short)', 'refs/heads/kb/').catch(() => '');
  for (const branch of out.split('\n').map((s) => s.trim()).filter((b) => /-work-[^/]+$/.test(b))) {
    await git.raw('branch', '-D', branch).catch(() => {}); // skips branches still checked out in a live worktree
  }
}

/**
 * #508 item 2: materialize ONLY `sparsePaths` in the ephemeral worktree instead of the whole
 * `checkpoint` tree. `git worktree add --no-checkout` + cone-mode `sparse-checkout set` before the
 * first real checkout — verified empirically (not just per git's docs) that a NEW file written under
 * a path NOT covered by the sparse patterns is silently refused by `git add` ("outside of your
 * sparse-checkout definition"), so `sparsePaths` MUST include every directory `fn` will WRITE to as
 * well as every one it reads from — a narrower-than-needed list doesn't error, it silently drops the
 * write. Precise, provably-safe callers only (see call sites); anything uncertain omits `sparsePaths`
 * and gets the full checkout (the safe default, unchanged).
 */
async function checkoutWorktree(git: ReturnType<typeof simpleGit>, wt: string, workBranch: string, checkpoint: string, sparsePaths?: readonly string[]): Promise<void> {
  if (!sparsePaths || sparsePaths.length === 0) {
    await git.raw('worktree', 'add', '--force', '-B', workBranch, wt, checkpoint);
    return;
  }
  await git.raw('worktree', 'add', '--force', '--no-checkout', '-B', workBranch, wt, checkpoint);
  const wtGit = boundedGit(wt);
  await wtGit.raw('sparse-checkout', 'init', '--cone');
  await wtGit.raw('sparse-checkout', 'set', ...sparsePaths);
  await wtGit.raw('checkout', workBranch);
}

export async function withEphemeralWorktree<T>(
  root: string,
  stage: string,
  checkpoint: string,
  fn: (ctx: { wt: string; workBranch: string }) => Promise<T>,
  sparsePaths?: readonly string[],
): Promise<T> {
  root = path.resolve(root);
  const id = ulid();
  const workBranch = `kb/${stage}-work-${id}`;
  const wt = path.join(root, '.kb', 'cache', 'worktrees', `${stage}-${id}`);
  const git = boundedGit(root);
  await ensureGitIdentity(git);
  await git.raw('worktree', 'prune'); // reap any orphan worktree dir from a prior crash before adding
  await pruneStaleWorktreeBranches(git); // …then reap orphan work branches a failed teardown left
  await fs.mkdir(path.dirname(wt), { recursive: true });
  await checkoutWorktree(git, wt, workBranch, checkpoint, sparsePaths);
  try {
    const result = await fn({ wt, workBranch });
    // #508 item 2 hardening (QA follow-up on #551): every current `sparsePaths` caller ends `fn` with
    // `git add -A` + commit, so a CLEAN tree is the invariant once `fn` returns. If anything is still
    // untracked/modified, that's either a real bug in `fn` or the sparse-checkout silent-drop landmine
    // (a write outside the declared `sparsePaths` that `git add` silently skipped instead of erroring —
    // verified this is real, not hypothetical: see `canonicalAdvance.test.ts`). Fail LOUD here, before
    // teardown discards the dropped write forever, instead of leaving a future dev to discover it via
    // missing data. Only checked when `sparsePaths` was actually used — the full-checkout default has
    // no such landmine to guard against.
    if (sparsePaths && sparsePaths.length > 0) {
      const status = await boundedGit(wt).status();
      if (status.files.length > 0) {
        throw new Error(
          `withEphemeralWorktree(${stage}): sparsePaths=[${sparsePaths.join(', ')}] left uncommitted paths after prepare — ` +
            `likely a write outside the declared sparse scope was silently dropped by git add: ${status.files.map((f) => f.path).join(', ')}`,
        );
      }
    }
    return result;
  } finally {
    // #135 cascade — cleanup-on-failure MUST NOT leak the worktree dir. `worktree remove --force`
    // can fail (concurrent git state, a half-broken admin entry); when it does, fall back to a raw
    // `fs.rm` of the dir so the ephemeral worktree never accumulates — then `prune` reconciles the
    // now-missing dir's admin entry. (A leaked dir is what `worktree prune` can't reap, so it would
    // pile up and degrade every later add.) All best-effort + time-bounded so teardown can't hang.
    await git.raw('worktree', 'remove', '--force', wt).catch(() => {});
    await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
    await git.raw('branch', '-D', workBranch).catch(() => {});
    await git.raw('worktree', 'prune').catch(() => {});
  }
}

/**
 * Reap LEAKED ephemeral per-item worktrees + their work branches under `<root>/.kb/cache/worktrees/`
 * (#135 cascade recovery). An ephemeral `<stage>-<ULID>` worktree must never outlive the item that
 * created it — but a crash or kill mid-item (e.g. the #135 poison-loop being force-stopped while
 * worktrees were live) leaves the dir + its git admin entry behind, and `worktree prune` will NOT
 * reap it (the dir still exists). They then accumulate, and because every `worktree add` first runs
 * {@link pruneStaleWorktreeBranches} (one `git branch -D` per leaked `kb/*-work-*` branch), each new
 * item gets slower as the leak grows — eventually starving the pipeline / the IPC event loop so the
 * Jobs UI reads as hung. Run this at a QUIESCENT point (boot / staging provision) where no ephemeral
 * worktree is legitimately in flight, so removing them all is safe.
 *
 * NEVER touches the persistent `staging` or per-job `job-<id>` worktrees (only `<stage>-<ULID>` names
 * match {@link EPHEMERAL_WT_NAME}). Best-effort + time-bounded so a broken entry can't hang boot:
 * `worktree remove --force` then a raw `fs.rm` fallback (the dir is what prune can't reap), then one
 * `worktree prune` to reconcile admin entries, then delete the now-orphan `kb/*-work-*` branches.
 */
export async function reapEphemeralWorktrees(root: string, log: DevLog = noopDevLog): Promise<{ worktrees: number; branches: number }> {
  root = path.resolve(root);
  const git = boundedGit(root);
  const wtRoot = path.join(root, '.kb', 'cache', 'worktrees');
  // Missing worktrees dir → no dirs to reap, but leaked work BRANCHES can still exist (and are the
  // O(leaked-N)-per-add churn), so fall through to the branch sweep rather than returning early.
  const entries = await fs.readdir(wtRoot, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
  let worktrees = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !isReapableEphemeralWorktree(e.name)) continue; // skip `staging`, `job-<id>`, files
    const wt = path.join(wtRoot, e.name);
    await git.raw('worktree', 'remove', '--force', wt).catch(() => {});
    await fs.rm(wt, { recursive: true, force: true }).catch(() => {}); // fallback when remove failed
    worktrees++;
  }
  await git.raw('worktree', 'prune').catch(() => {});
  // Delete leaked ephemeral work branches (skips any still checked out in a LIVE worktree).
  const refs = await git.raw('for-each-ref', '--format=%(refname:short)', 'refs/heads/kb/').catch(() => '');
  let branches = 0;
  for (const b of refs.split('\n').map((s) => s.trim()).filter((s) => /-work-[^/]+$/.test(s))) {
    await git
      .raw('branch', '-D', b)
      .then(() => {
        branches++;
      })
      .catch(() => {});
  }
  if (worktrees > 0 || branches > 0) log.info('worktree.reaped-leaked', { worktrees, branches });
  return { worktrees, branches };
}

/** Read the canonical worktree's current HEAD commit — the checkpoint a stage prepares off.
 *  #515: bounded — this runs off-lock at the top of every prepare loop, so an unbounded read against
 *  a wedged repo (e.g. mid-cherry-pick, contended index.lock) would hang the calling stage silently. */
export async function canonicalHead(root: string, timeoutMs?: number): Promise<string> {
  return (await boundedGit(root, timeoutMs).revparse(['HEAD'])).trim();
}

export type AdvanceOutcome = 'advanced' | 'collision';

/**
 * Advance the canonical branch to include the work committed on `workBranch` (prepared off `base`).
 * MUST be called inside `lock.run(...)` — this is the ONLY region the canonical-writer lock guards
 * (ORCH-18). Three cases:
 *  - canonical HEAD === `base` (unchanged) → fast-forward (the common, cap=1 path);
 *  - canonical moved, item paths DISJOINT → cherry-pick (replay) `base..workBranch` onto HEAD;
 *  - same-path collision (cherry-pick conflicts) → abort and return `'collision'` (caller re-syncs
 *    + retries the item against the new canonical).
 * Either way canonical history stays LINEAR (ff or replayed commits, never a merge; ORCH-3).
 *
 * Runs in the canonical worktree (`root`), which is clean + on the canonical branch (stages commit
 * in their own disposable worktrees, never here).
 */
export async function advanceOrCollide(root: string, workBranch: string, base: string, timeoutMs?: number, healLog?: DevLog): Promise<AdvanceOutcome> {
  // Time-bounded (#163): this runs UNDER the canonical-writer lock, so a git op that blocks
  // indefinitely (root-repo `index.lock` from a zombie git, a credential/editor prompt, a stalled
  // network) would hold the lock forever and wedge the whole pipeline silently. A bounded client
  // turns that into a thrown error → the section's `finally` releases the lock → the stuck-section
  // watchdog (#170) surfaces it, instead of a permanent silent deadlock.
  const effectiveTimeout = timeoutMs ?? WORKTREE_GIT_TIMEOUT_MS;
  const git = boundedGit(root, effectiveTimeout);
  const head = (await git.revparse(['HEAD'])).trim();
  // ORCH-27 acquire-finds-stale: heal a STALE root `index.lock` left by a crashed / boundedGit-timed-out
  // prior op BEFORE we attempt the index-touching op — otherwise that orphaned lock makes every future
  // ff/cherry-pick fatal (the #256 wedge). The heal NEVER clears a LIVE lock (triple-gate); a genuinely
  // live one is kept and our bounded op below fails + surfaces rather than hanging. This is what makes
  // the systemic-wedge back-off (refined ORCH-26) actually RESUME within a session, not just on restart.
  await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => hasLiveIndexHolder(root), log: healLog });
  // Each index-touching op runs as the registered live holder (writes the sidecar so a crash mid-op is
  // identifiable + clears it on clean success; ORCH-27 gate-1/2).
  if (head === base) {
    await withCanonicalIndexLock(root, 'advance:ff', effectiveTimeout, () => git.raw('merge', '--ff-only', workBranch)); // base unchanged → clean fast-forward
    return 'advanced';
  }
  // Canonical moved since the checkpoint — replay the item's commits onto the new HEAD.
  try {
    await withCanonicalIndexLock(root, 'advance:cherry-pick', effectiveTimeout, () => git.raw('cherry-pick', `${base}..${workBranch}`));
    return 'advanced';
  } catch {
    // Same-path collision: abort to leave the canonical untouched, then signal a retry. A FAILED
    // abort would leave the sole canonical worktree mid-cherry-pick (dirty) — surface it, never
    // swallow, so the stage stops rather than advancing on a corrupt tree (QA #45 note).
    try {
      await withCanonicalIndexLock(root, 'advance:abort', effectiveTimeout, () => git.raw('cherry-pick', '--abort'));
    } catch (abortErr) {
      throw new Error(
        `canonicalAdvance: cherry-pick conflict could not be aborted — canonical worktree may be left dirty: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`,
      );
    }
    return 'collision';
  }
}

export interface OptimisticAdvanceOptions {
  /** Canonical worktree (on the canonical branch). */
  root: string;
  /** The shared per-vault canonical-writer lock (§5). Only the advance runs under it. */
  lock: Mutex;
  /** The stage's work branch (e.g. `kb/decompose-work`) holding the prepared commit. */
  workBranch: string;
  /** Same-path collision retries before set-aside (ORCH-19). Defaults to DEFAULT_MAX_COLLISION_RETRIES. */
  maxCollisionRetries?: number;
  /** OBS-7 / #163 watchdog label naming the holder of the canonical-writer lock during the advance. */
  label?: string;
  /** Dev-log for the ORCH-27 acquire-finds-stale heal to surface a `orch.lock.healed`/`held` event. */
  log?: DevLog;
}

export type OptimisticAdvanceResult = 'advanced' | 'noop' | 'setaside';

/**
 * Drive one item through optimistic concurrency (ORCH-17/18/19):
 *  1. read the canonical checkpoint `base`;
 *  2. `prepare(base)` OFF the lock — sync a worktree to `base`, run cognition, write, commit on
 *     `workBranch`; returns `true` if it committed work to advance, `false` for a no-op (e.g. the
 *     item turned out already-terminal / nothing to write);
 *  3. advance UNDER the lock via `advanceOrCollide`.
 * A same-path collision re-runs from step 1 against the fresh canonical, bounded to K retries; on
 * exhaustion `onExhausted()` records the set-aside (ORCH-19) — the item is never dropped or
 * half-applied. When this item is the only writer between its prepare and advance the advance is a
 * fast-forward; but even with a stage's own drain serial (cap=1), CROSS-STAGE concurrency (or
 * cap>1) can move the canonical in that window, exercising the replay/collision paths. Either way
 * the canonical state is the same — linear history (ORCH-3), only the interleaving differs.
 */
export async function withOptimisticAdvance(
  opts: OptimisticAdvanceOptions,
  prepare: (base: string) => Promise<boolean>,
  onExhausted: () => Promise<void>,
): Promise<OptimisticAdvanceResult> {
  const maxRetries = opts.maxCollisionRetries ?? DEFAULT_MAX_COLLISION_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const base = await canonicalHead(opts.root);
    const committed = await prepare(base);
    if (!committed) return 'noop';
    const outcome = await opts.lock.run(() => advanceOrCollide(opts.root, opts.workBranch, base, undefined, opts.log), opts.label ?? 'advance');
    if (outcome === 'advanced') return 'advanced';
    // 'collision' → re-sync to the moved canonical and retry the whole item.
  }
  await onExhausted();
  return 'setaside';
}

export interface ConcurrentAdvanceOptions {
  /** Canonical worktree (on the canonical branch). */
  root: string;
  /** The shared per-vault canonical-writer lock (§5). Only the advance runs under it. */
  lock: Mutex;
  /** Stage name (e.g. `decompose`) — namespaces the per-item ephemeral work branch + worktree. */
  stage: string;
  /** Same-path collision retries before set-aside (ORCH-19). Defaults to DEFAULT_MAX_COLLISION_RETRIES. */
  maxCollisionRetries?: number;
  /** OBS-7 / #163 watchdog label naming the lock holder during the advance. Defaults to `<stage>:advance`. */
  label?: string;
  /** Dev-log for the ORCH-27 acquire-finds-stale heal to surface a `orch.lock.healed`/`held` event. */
  log?: DevLog;
  /** #508 item 2: materialize ONLY these paths in the ephemeral worktree (cone-mode sparse-checkout)
   *  instead of the whole checkpoint tree. MUST include every path `prepare` reads OR writes — a path
   *  outside this list is silently dropped on `git add`, not a loud failure (see `checkoutWorktree`).
   *  Only set this when the item's full read+write path set is provably known BEFORE `prepare` runs
   *  (e.g. archive/decompose, whose target is a function of the item id); omit for anything that scans
   *  an unbounded/unpredictable part of the tree (e.g. connect's cross-vault blocking) — the default
   *  (omitted) is the full checkout, always correct. */
  sparsePaths?: readonly string[];
}

/** Context handed to a `prepare` callback under {@link withConcurrentAdvance}: its PRIVATE ephemeral
 *  worktree (fresh off `base`, on a per-item branch) and the checkpoint it was created off. The
 *  callback writes its effects in `wt` and commits there; it does NOT manage the worktree or advance. */
export interface PrepareContext {
  wt: string;
  base: string;
}

/**
 * Like {@link withOptimisticAdvance}, but for stages that run **cap>1 items concurrently** (ORCH-20):
 * each attempt gets a FRESH ephemeral per-item worktree off the checkpoint (via
 * {@link withEphemeralWorktree}), so concurrent prepares within a stage never clobber a shared
 * worktree. `prepare({ wt, base })` runs OFF the lock (cognition + writes + commit in `wt`); the
 * advance runs UNDER the lock via the SAME {@link advanceOrCollide} primitive (ff / disjoint replay /
 * same-path collision → bounded retry → set-aside). cap=1 ⇒ one ephemeral worktree at a time, output-
 * identical to the serial drain. (`withOptimisticAdvance` — caller-managed fixed worktree/branch —
 * stays for JOBS's per-job persistent-worktree model; both share `advanceOrCollide`.)
 */
export async function withConcurrentAdvance(
  opts: ConcurrentAdvanceOptions,
  prepare: (ctx: PrepareContext) => Promise<boolean>,
  onExhausted: () => Promise<void>,
): Promise<OptimisticAdvanceResult> {
  const maxRetries = opts.maxCollisionRetries ?? DEFAULT_MAX_COLLISION_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const base = await canonicalHead(opts.root);
    const outcome = await withEphemeralWorktree(
      opts.root,
      opts.stage,
      base,
      async ({ wt, workBranch }) => {
        const committed = await prepare({ wt, base });
        if (!committed) return 'noop' as const;
        return opts.lock.run(() => advanceOrCollide(opts.root, workBranch, base, undefined, opts.log), opts.label ?? `${opts.stage}:advance`);
      },
      opts.sparsePaths,
    );
    if (outcome === 'noop') return 'noop';
    if (outcome === 'advanced') return 'advanced';
    // 'collision' → retry the whole item in a fresh worktree against the moved canonical.
  }
  await onExhausted();
  return 'setaside';
}
