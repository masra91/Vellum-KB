// Staging branch + promotion gate (SPEC-0021 STAGING) — realizes the SPEC-0019 evergreen
// invariant. Stages work on the `staging` branch; `main` is advanced ONLY by the promotion
// gate, which copies the evergreen path set (sources/ … ) staging→main. `main` therefore
// never contains working paths (inbox/, candidates/, queue/, reviews/) — by construction,
// not cleanup (CANON-1/2/8; STAGING-3/6). All canonical writes stay serialized by the shared
// stageLock Mutex (SPEC-0014 §5); these helpers are the ref-level mechanics under it.
import path from 'node:path';
import simpleGit from 'simple-git';
import { boundedGit, WORKTREE_GIT_TIMEOUT_MS } from './canonicalAdvance';
import { reconcileStaleIndexLock, hasLiveIndexHolder, withCanonicalIndexLock } from './canonicalLockHeal';
import { noopDevLog, type DevLog } from './devlog';
import { ensureGitIdentity } from './vault';

export const STAGING_BRANCH = 'staging';

/**
 * The active evergreen path set promoted to `main` — the single source of truth for what reaches
 * `main` (STAGING-3/11). It **grows with its producers**: `sources/` is evergreen the moment it
 * exists (immutable ground truth, DATA-2); `entities/` + `claims/` join now that CONNECT
 * (SPEC-0020) resolves candidates into born-resolved nodes on `staging` and Claims attaches to
 * them — evergreen once resolved (CANON-10). `outputs/` is **synthesis** (DATA-4) — it joins now
 * that autonomous Jobs (SPEC-0023) produce it (the first `outputs/` producer; STAGING-11 grows
 * with producers). Working paths (`inbox/`, `candidates/`, `queue/`, `reviews/`, `.kb/…` incl. the
 * per-job `.kb/jobs/` journals) are never listed, so `main` can never hold them (STAGING-6).
 */
// `directives/` is durable human INTERPRETATION (SPEC-0050) — a settled disambiguation verdict keyed
// on STABLE block identity. It is evergreen so it is promoted to `main` AND survives reset/replay (it
// is deliberately NOT in replay's PURGE_DIRS), so an answered "Disney is one org" never re-asks across
// a new same-name source or a Full Replay (DIR-4).
export const EVERGREEN_PATHS = ['sources', 'entities', 'claims', 'outputs', 'directives'] as const;

/** Ensure a long-lived `staging` branch exists, created off the vault's current branch (HEAD)
 *  if absent (STAGING-1). Created off HEAD — never a hardcoded `main`, so vaults whose default
 *  branch is `master` work too. staging is NOT checked out — the root worktree stays on its
 *  evergreen branch for Obsidian; stages run in their own worktrees. */
export async function ensureStagingBranch(root: string): Promise<void> {
  const git = simpleGit(path.resolve(root));
  await ensureGitIdentity(git);
  const branches = await git.branchLocal();
  if (!branches.all.includes(STAGING_BRANCH)) {
    await git.raw('branch', STAGING_BRANCH); // off current HEAD (branch-name agnostic)
  }
}

/** Advance `staging` to `ref` (a stage's committed work branch). Because `staging` is never
 *  checked out (stages live in worktrees on their own work branches), a force-update is the
 *  safe, simple way to move the ref (STAGING-2). */
export async function advanceStaging(root: string, ref: string): Promise<void> {
  await simpleGit(path.resolve(root)).raw('branch', '-f', STAGING_BRANCH, ref);
}

/** One `git diff --name-status` line: a change needed to turn the FIRST commit's tree into the
 *  SECOND's, at `file`. `status` is git's raw single-letter code (A/M/D — renames are suppressed by
 *  `--no-renames` at the call site, so only these three ever appear). */
interface NameStatusChange {
  status: string;
  file: string;
}

/** Parse `git diff --name-status`'s tab-separated `<status>\t<path>` lines. Blank lines skipped. */
function parseNameStatus(raw: string): NameStatusChange[] {
  const out: NameStatusChange[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const tab = t.indexOf('\t');
    if (tab === -1) continue; // malformed — never a real diff line
    out.push({ status: t.slice(0, tab), file: t.slice(tab + 1) });
  }
  return out;
}

/**
 * The promotion gate (STAGING-3/4), **deletion-aware** (STAGING-10): advance `main` to be an
 * EXACT MIRROR of `staging`'s evergreen subset — adds, edits, AND removals. `sources/` is
 * append-only, so mirroring never removes ground truth. Working paths are never named, so `main`
 * cannot contain them (STAGING-6). Idempotent: a no-op (returns false) when nothing evergreen
 * changed.
 *
 * #508 item 1: applies ONLY the actual delta between `main`'s current tree and `staging`'s evergreen
 * subset (`git diff --name-status`), not a blind clear-then-restore of every evergreen path on every
 * promote — that touched (`git rm -r` + full re-checkout of) potentially thousands of files even for
 * a single-file change, on the LIVE root Obsidian watches (rescan storms, SSD churn). Same end state:
 * `git diff --name-status` between two trees is BY CONSTRUCTION the exact add/modify/delete set that
 * turns one into the other, so applying "checkout staging for every A/M path, rm for every D path"
 * mirrors `staging` exactly, just without touching anything that didn't change. The one-time bootstrap
 * case (main has no commits yet — the very first promote of a brand-new vault) falls back to the
 * original full clear-then-restore, since there's no prior tree to diff against.
 *
 * MUST be called serialized via the shared canonical-writer lock so it never races a stage's
 * ref advance.
 *
 * ORCH-27 stale-lock self-heal: `promote` is the canonical writer to `main` — the LIVE repo Obsidian
 * has open at the vault ROOT. A crashed / boundedGit-timed-out prior root git op can orphan
 * `<root>/.git/index.lock`, which makes every future promote fatal and silently WEDGES THE WHOLE VAULT
 * until someone manually `rm`s it (the Jun-10 orphan lock blocked a build). So before the index ops we
 * heal a PROVEN-stale (no-live-holder) root lock — and run the index ops as the registered live holder
 * so a crash mid-promote leaves the sidecar evidence the next heal needs. The triple-gate NEVER clears
 * a live lock; a genuinely-live one is KEPT and the bounded op below fails + surfaces (the stuck-section
 * watchdog) rather than corrupting a live write. Mirrors `advanceOrCollide`'s acquire-finds-stale heal.
 */
export async function promote(root: string, paths: readonly string[] = EVERGREEN_PATHS, timeoutMs?: number, log: DevLog = noopDevLog): Promise<boolean> {
  root = path.resolve(root);
  const effectiveTimeout = timeoutMs ?? WORKTREE_GIT_TIMEOUT_MS;
  // Heal a stale root `index.lock` (no live holder) BEFORE the index-touching ops — else an orphan lock
  // makes every promote fatal and wedges the live vault. Never clears a live lock (ORCH-27 triple-gate).
  await reconcileStaleIndexLock(root, { isLiveInProcHolder: () => hasLiveIndexHolder(root), log });
  // The whole index-touching promote runs as the registered live holder: writes the {pid,op} sidecar so
  // a crash mid-promote is identifiable (gate-2 self-leak fast-path) + clears it on clean success.
  return withCanonicalIndexLock(root, 'promote', effectiveTimeout, async () => {
    // Time-bounded (#163): promote is the sole writer of `main` and ALWAYS runs under the canonical-
    // writer lock (afterDrain / consolidation / recall / replay). A git op that blocks indefinitely
    // here would wedge the lock forever and silently. A bounded client makes a hang throw → the
    // section releases → the watchdog surfaces it, rather than a permanent deadlock.
    const git = boundedGit(root, timeoutMs);
    await ensureGitIdentity(git);

    let mainHead: string | null;
    try {
      mainHead = (await git.revparse(['HEAD'])).trim();
    } catch {
      mainHead = null; // unborn branch — a brand-new vault's very first promote, nothing to diff against
    }

    if (mainHead === null) {
      // Bootstrap-only: no prior tree on main, so there's no delta to compute — restore everything.
      for (const p of paths) {
        await git.raw('rm', '-r', '-f', '--ignore-unmatch', '--quiet', '--', p);
        try {
          await git.raw('checkout', STAGING_BRANCH, '--', p);
        } catch {
          /* p absent on staging too — nothing to publish */
        }
      }
    } else {
      const diffOut = await git.raw('diff', '--name-status', '--no-renames', mainHead, STAGING_BRANCH, '--', ...paths);
      const changes = parseNameStatus(diffOut);
      if (changes.length === 0) return false; // idempotent: nothing evergreen changed — zero file ops
      const toRemove = changes.filter((c) => c.status === 'D').map((c) => c.file);
      const toRestore = changes.filter((c) => c.status !== 'D').map((c) => c.file);
      // `--ignore-unmatch` even though these paths came straight off the diff: a prior partial/aborted
      // promote could have already removed one, and this must stay idempotent-safe, not fatal.
      if (toRemove.length > 0) await git.raw('rm', '-f', '--ignore-unmatch', '--quiet', '--', ...toRemove);
      if (toRestore.length > 0) await git.raw('checkout', STAGING_BRANCH, '--', ...toRestore);
    }

    const status = await git.status();
    if (status.files.length === 0) return false; // idempotent: nothing evergreen changed
    await git.commit('promote: evergreen → main'); // commits the staged add/update/delete set
    return true;
  });
}
