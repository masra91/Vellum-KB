// SPEC-0014 ORCH-27 — stale canonical `index.lock` self-heal. ORCH-25 releases OUR in-process lock on
// a bounded-git timeout, but a `.git/index.lock` LEFT ON DISK by a died/timed-out op (or a crashed
// process) wedges EVERY future canonical advance — the #256 wedge. This heals it, but the cardinal
// rule is: **NEVER clear a lock that could be LIVE** (clearing a live lock corrupts the repo). So a
// lock is declared stale + safe-to-clear ONLY via a triple-gate, and every clear is audited + surfaced.
//
// The decision (`classifyIndexLock`) is PURE — the safety truth table is unit-tested exhaustively, and
// it never returns `clear` for a lock that might be live. The impure `reconcileStaleIndexLock` gathers
// the on-disk facts and acts (clear + audit, or keep + surface the stall). Runs at startup-reconcile
// and at acquire-finds-stale (heal-then-retry-once), per KB-Lead's design ruling.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readLockMeta, writeLockMeta, clearLockMeta, type CanonicalLockMeta } from './canonicalLockMeta';
import { appendAuditEvent } from './audit';
import { noopDevLog, type DevLog } from './devlog';

const execFileP = promisify(execFile);

/** Roots with a LIVE in-process boundedGit index-op right now (gate-1). A Set keyed by resolved root —
 *  the canonical-writer Mutex serializes advances per vault, so at most one live holder per root. */
const liveIndexHolders = new Set<string>();

/** gate-1 predicate: is THIS process currently holding `root`'s index.lock via a live boundedGit op? */
export function hasLiveIndexHolder(root: string): boolean {
  return liveIndexHolders.has(path.resolve(root));
}

/**
 * Run `fn` (an index-touching boundedGit op, e.g. the ff/cherry-pick advance) as the registered live
 * holder of `root`'s `index.lock`: marks the in-process holder (gate-1) + writes the sidecar
 * {pid, startedAt, op, timeoutMs} so a crash/timeout mid-op leaves the evidence the heal needs.
 *
 * On SUCCESS the sidecar is cleared (a clean release leaves nothing stale). On FAILURE it is LEFT in
 * place on purpose: a boundedGit timeout that kills git can orphan `index.lock`, and the surviving
 * sidecar (pid==self) lets the NEXT acquire's gate-2 clear it immediately (leaked-by-self) — fast
 * within-session resume-on-heal — instead of waiting out the conservative no-sidecar age threshold.
 * The in-process holder flag is always released. The sidecar write is best-effort + never fails `fn`.
 */
export async function withCanonicalIndexLock<T>(root: string, op: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  const r = path.resolve(root);
  liveIndexHolders.add(r);
  await writeLockMeta(r, { pid: process.pid, startedAt: Date.now(), op, timeoutMs });
  try {
    const result = await fn();
    await clearLockMeta(r); // clean success → no stale sidecar left behind
    return result;
  } finally {
    liveIndexHolders.delete(r); // always release the in-process holder (gate-1); sidecar persists on failure
  }
}

/** KB-Lead Q2: a no-sidecar (external-held) `index.lock` is only assumed stale past this generous age.
 *  `index.lock` is short-lived even for external git (gc/clone use other locks), so 120s is safe. */
export const GATE3_STALE_AGE_MS = 120_000;

/**
 * Resolve the real GIT DIR for `root`, correct for BOTH a plain repo and a linked git worktree — the
 * canonical writer advances run in the `staging` worktree, whose `.git` is a FILE
 * (`gitdir: <main>/.git/worktrees/staging`), not a directory. Cheap fs reads (no git spawn): stat
 * `.git`; a dir → that IS the gitdir; a file → parse `gitdir:` → the target. Falls back to the plain
 * `<root>/.git` layout on any read error. Shared by `resolveIndexLockPath` (below) and the
 * CHERRY_PICK_HEAD sequencer reconcile (#515) — both need to find the SAME real gitdir a linked
 * worktree's sequencer/lock state actually lives in.
 */
export async function resolveGitDir(root: string): Promise<string> {
  const r = path.resolve(root);
  const dotGit = path.join(r, '.git');
  try {
    const st = await fs.stat(dotGit);
    if (st.isDirectory()) return dotGit;
    const content = await fs.readFile(dotGit, 'utf8'); // linked worktree → `.git` is a file
    const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (m) return path.isAbsolute(m[1]) ? m[1] : path.resolve(r, m[1]);
  } catch {
    /* fall through to the plain layout */
  }
  return dotGit;
}

/**
 * Resolve the canonical `index.lock` path for `root`, correct for BOTH a plain repo and a linked git
 * worktree — see `resolveGitDir`.
 */
export async function resolveIndexLockPath(root: string): Promise<string> {
  return path.join(await resolveGitDir(root), 'index.lock');
}

/** Best-effort answer to "is a live git process touching this repo?" for the no-sidecar gate-3. */
export type ExternalGitScan = 'none' | 'present' | 'inconclusive';

/** The triple-gate verdict for a present `index.lock`. `clear` is reached ONLY when proven stale. */
export type LockVerdict =
  | { action: 'absent' }
  | { action: 'keep'; reason: string }
  | { action: 'clear'; reason: string };

export interface ClassifyInputs {
  /** Does `.git/index.lock` exist right now? */
  lockExists: boolean;
  /** mtime age of the lock file (ms), or null if unknown — gate-3 only. */
  lockAgeMs: number | null;
  /** The sidecar, or null (absent/corrupt → the no-sidecar gate-3 path). */
  meta: CanonicalLockMeta | null;
  /** Is THIS process currently running a boundedGit index-op that legitimately holds the lock? (gate-1) */
  liveInProcHolder: boolean;
  /** This process's pid — to spot a sidecar our OWN prior (now-dead) op leaked (pid==self, no live op). */
  selfPid: number;
  /** Is the sidecar's pid alive? (`kill(pid,0)`) — consulted only when the sidecar names another pid. */
  pidAlive: (pid: number) => boolean;
  /** Best-effort external-git scan — gate-3 only (no sidecar). */
  externalGitScan: ExternalGitScan;
  /** now (epoch ms) — injected for deterministic tests. */
  now: number;
}

/**
 * The ORCH-27 triple-gate decision (PURE, exhaustively tested). Ordered most-conservative first; it
 * returns `clear` ONLY when the lock is PROVEN not-a-live-holder. Any uncertainty → `keep` (fail safe).
 */
export function classifyIndexLock(inp: ClassifyInputs): LockVerdict {
  if (!inp.lockExists) return { action: 'absent' };

  // GATE 1 — a LIVE in-process boundedGit op legitimately holds it right now → never clear.
  if (inp.liveInProcHolder) {
    return { action: 'keep', reason: 'gate-1: a live in-process index-op holds the lock' };
  }

  if (inp.meta) {
    // GATE 2 — sidecar present (we / our lineage took it). Past gate-1 there is NO live in-proc op, so:
    const ageMs = inp.now - inp.meta.startedAt;
    // (a) pid is THIS process but no live op → our own prior op died/leaked the lock → stale.
    if (inp.meta.pid === inp.selfPid) {
      return { action: 'clear', reason: `gate-2: sidecar pid is self (${inp.meta.pid}) with no live in-proc op — leaked by a prior op (op=${inp.meta.op}, age=${ageMs}ms)` };
    }
    // (b) the recorded pid is dead → the holder is gone → stale.
    if (!inp.pidAlive(inp.meta.pid)) {
      return { action: 'clear', reason: `gate-2: sidecar pid ${inp.meta.pid} is dead (op=${inp.meta.op}, age=${ageMs}ms)` };
    }
    // (c) pid alive but the op ran past 2× its own timeout → ORCH-25 would have cleaned a live op; it
    //     didn't, so this is a leak from a still-running but detached process → stale.
    if (ageMs > 2 * inp.meta.timeoutMs) {
      return { action: 'clear', reason: `gate-2: sidecar age ${ageMs}ms > 2×timeout ${inp.meta.timeoutMs}ms (pid ${inp.meta.pid}, op=${inp.meta.op})` };
    }
    // pid alive AND within age → a genuinely live op is in flight (another Vellum instance) → keep.
    return { action: 'keep', reason: `gate-2: sidecar pid ${inp.meta.pid} alive within age (${ageMs}ms ≤ 2×${inp.meta.timeoutMs}ms)` };
  }

  // GATE 3 — no sidecar: held by something we don't own (user `git`, Obsidian, IDE). Most dangerous —
  // clear ONLY if the lock is BOTH old AND no live git process, and FAIL SAFE on an inconclusive scan.
  if (inp.externalGitScan === 'present') {
    return { action: 'keep', reason: 'gate-3: no sidecar + a live external git process on the repo' };
  }
  if (inp.externalGitScan === 'inconclusive') {
    return { action: 'keep', reason: 'gate-3: no sidecar + external-git scan inconclusive → fail safe (leave + surface)' };
  }
  if (inp.lockAgeMs === null) {
    return { action: 'keep', reason: 'gate-3: no sidecar + lock age unknown → fail safe' };
  }
  if (inp.lockAgeMs > GATE3_STALE_AGE_MS) {
    return { action: 'clear', reason: `gate-3: no sidecar + no live git + lock age ${inp.lockAgeMs}ms > ${GATE3_STALE_AGE_MS}ms` };
  }
  return { action: 'keep', reason: `gate-3: no sidecar + lock age ${inp.lockAgeMs}ms ≤ ${GATE3_STALE_AGE_MS}ms (too fresh to assume stale)` };
}

/** Default pid-liveness probe: `kill(pid, 0)` throws ESRCH for a dead pid, EPERM for a live one we
 *  can't signal (still alive). Anything else → assume alive (fail safe — never declare a pid dead on
 *  an ambiguous error, since that could greenlight clearing a live lock). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'; // EPERM (alive) / anything ambiguous → assume alive
  }
}

/** Default best-effort external-git scan (gate-3): is any live `git` process referencing this repo?
 *  Uses `ps`; ANY failure / unparseable output → `inconclusive` (KB-Lead: fail safe, never clear on
 *  a scan we couldn't run). Matches a `git` argv that mentions the repo root path. */
export async function scanExternalGitProcess(root: string): Promise<ExternalGitScan> {
  const resolved = path.resolve(root);
  try {
    const { stdout } = await execFileP('ps', ['-axo', 'command'], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const hit = lines.some((l) => /(^|\/)git(\s|$)/.test(l) && l.includes(resolved));
    return hit ? 'present' : 'none';
  } catch {
    return 'inconclusive'; // ps unavailable / errored → we cannot confirm no-live-git → fail safe
  }
}

export interface ReconcileDeps {
  /** gate-1: is a live boundedGit index-op running in THIS process right now? */
  isLiveInProcHolder: () => boolean;
  /** Override the pid-liveness probe (tests). */
  pidAlive?: (pid: number) => boolean;
  /** Override the external-git scan (tests). */
  scanExternalGit?: (root: string) => Promise<ExternalGitScan>;
  /** Override the clock (tests). */
  now?: () => number;
  /** Override this process's pid (tests). */
  selfPid?: number;
  /** Audit sink for a heal — every clear is recorded (lock path, why-stale, pid/age). */
  audit?: (event: { lock: string; reason: string; meta: CanonicalLockMeta | null }) => void | Promise<void>;
  /** Dev-log/OBS surface — a heal AND a held-stall are both made VISIBLE, never silent. */
  log?: DevLog;
}

/**
 * Detect + (if proven stale) heal a root `index.lock`, returning the verdict. Gathers the on-disk
 * facts, runs the pure `classifyIndexLock`, and acts: `clear` → remove the lock + sidecar, audit, and
 * dev-log a visible "healed a stale lock" event; `keep` with a present lock → surface the held stall
 * (so a genuinely-live or fail-safe-kept lock reads as a NAMED state, not an invisible wedge — ORCH-25
 * watchdog parity). Safe to call at startup-reconcile and at acquire-finds-stale.
 */
export async function reconcileStaleIndexLock(root: string, deps: ReconcileDeps): Promise<LockVerdict> {
  const log = deps.log ?? noopDevLog;
  const now = deps.now ?? (() => Date.now());
  const lockPath = await resolveIndexLockPath(root);

  let lockExists = false;
  let lockAgeMs: number | null = null;
  try {
    const st = await fs.stat(lockPath);
    lockExists = true;
    lockAgeMs = now() - st.mtimeMs;
  } catch {
    return { action: 'absent' }; // no lock → nothing to do (the common, healthy case)
  }

  const meta = await readLockMeta(root);
  // Only run the (cost-bearing) external scan on the no-sidecar gate-3 path.
  const externalGitScan: ExternalGitScan = meta ? 'none' : await (deps.scanExternalGit ?? scanExternalGitProcess)(root);

  const verdict = classifyIndexLock({
    lockExists,
    lockAgeMs,
    meta,
    liveInProcHolder: deps.isLiveInProcHolder(),
    selfPid: deps.selfPid ?? process.pid,
    pidAlive: deps.pidAlive ?? isPidAlive,
    externalGitScan,
    now: now(),
  });

  if (verdict.action === 'clear') {
    await fs.rm(lockPath, { force: true });
    await clearLockMeta(root);
    log.warn('orch.lock.healed', { lock: lockPath, reason: verdict.reason, pid: meta?.pid ?? null, op: meta?.op ?? null });
    // AUDIT-11: a clear is a repository-state repair → audit it with the why (default → the canonical
    // control audit log; injectable for tests). Best-effort: an audit failure must not undo the heal.
    const auditFn =
      deps.audit ??
      ((e) =>
        appendAuditEvent(root, {
          actor: 'maintenance',
          subjects: {},
          eventType: 'lock-healed',
          payload: { lock: e.lock, reason: e.reason, pid: e.meta?.pid ?? null, op: e.meta?.op ?? null, startedAt: e.meta?.startedAt ?? null },
        }));
    try {
      await auditFn({ lock: lockPath, reason: verdict.reason, meta });
    } catch {
      /* audit best-effort — the lock is already healed; a logging failure must not re-wedge */
    }
  } else if (verdict.action === 'keep') {
    // A present-but-kept lock is a live op or a fail-safe hold — surface it so it's never a silent wedge.
    log.warn('orch.lock.held', { lock: lockPath, reason: verdict.reason });
  }
  return verdict;
}

// ── #515 BUG-2 — startup CHERRY_PICK_HEAD / sequencer heal ──────────────────────────────────────
//
// A SIGKILL (crash, or a force-quit before the #515 `before-quit` fix) mid `advanceOrCollide` cherry-
// pick — after the pick itself starts but before its `catch`'s `cherry-pick --abort` runs, or when that
// abort itself times out — leaves the canonical worktree's gitdir in a CHERRY_PICK_HEAD/sequencer state.
// Nothing detects this today: the NEXT capture's plain `add inbox` + commit silently CONCLUDES the
// stale cherry-pick with a half-applied (possibly conflict-markered) tree under a "capture:" message —
// silent vault corruption — or every future `merge --ff-only`/cherry-pick fails until manual git surgery.
//
// Unlike `index.lock` there is no sidecar recording WHO holds a sequencer state, so gate-1/gate-2 from
// the triple-gate above don't apply — the only signal available is gate-3's external-git-process scan.
// Called at startup, before any stage drains: no advance from THIS process can be in flight yet, so
// "live" can only mean "some OTHER process is genuinely mid-pick on this repo" — fail safe (`keep`) on
// `present`/`inconclusive`, heal only when the scan proves no live git process is touching the repo.

export type CherryPickVerdict = 'absent' | 'cleared' | 'kept';

export interface CherryPickReconcileDeps {
  /** Override the external-git scan (tests) — see `scanExternalGitProcess`. */
  scanExternalGit?: (root: string) => Promise<ExternalGitScan>;
  /** Override the `git` invocation used to abort/reset (tests drive a fake that never actually shells out). */
  runGit?: (root: string, args: string[]) => Promise<void>;
  /** Audit sink for a heal (mirrors `reconcileStaleIndexLock`'s `audit`). */
  audit?: (event: { root: string }) => void | Promise<void>;
  log?: DevLog;
}

async function defaultRunGit(root: string, args: string[]): Promise<void> {
  await execFileP('git', ['-C', root, ...args], { timeout: 10_000 });
}

/**
 * Detect + (if provably safe) heal a stuck `CHERRY_PICK_HEAD`/sequencer state in `root`'s gitdir before
 * the first stage drain. Safe to call unconditionally at startup — a no-op (`absent`) in the overwhelming
 * common case where no cherry-pick is in progress.
 */
export async function reconcileCherryPickSequencer(root: string, deps: CherryPickReconcileDeps = {}): Promise<CherryPickVerdict> {
  const log = deps.log ?? noopDevLog;
  const gitDir = await resolveGitDir(root);
  const cherryPickHeadPath = path.join(gitDir, 'CHERRY_PICK_HEAD');

  try {
    await fs.stat(cherryPickHeadPath);
  } catch {
    return 'absent'; // no sequencer state → nothing to do (the common, healthy case)
  }

  const externalGitScan = await (deps.scanExternalGit ?? scanExternalGitProcess)(root);
  if (externalGitScan !== 'none') {
    log.warn('orch.cherry-pick.held', { root, scan: externalGitScan });
    return 'kept'; // fail-safe: a live or inconclusive-live external git process could be the one mid-pick
  }

  const runGit = deps.runGit ?? defaultRunGit;
  try {
    await runGit(root, ['cherry-pick', '--abort']);
  } catch {
    // `--abort` can itself fail on a corrupt sequencer (e.g. killed mid-abort). Startup means no advance
    // from THIS process is in flight yet — committed staging state is the durable truth by design (a
    // half-applied cherry-pick tree was never promoted) — so a hard reset to HEAD is safe here
    // specifically because we're pre-drain, unlike the mid-advance abort in `advanceOrCollide`.
    try {
      await runGit(root, ['reset', '--hard', 'HEAD']);
      await fs.rm(cherryPickHeadPath, { force: true });
      await fs.rm(path.join(gitDir, 'sequencer'), { recursive: true, force: true });
    } catch (err) {
      log.error('orch.cherry-pick.heal-failed', { root, err });
      return 'kept';
    }
  }

  log.warn('orch.cherry-pick.healed', { root });
  const auditFn = deps.audit ?? ((e) => appendAuditEvent(root, { actor: 'maintenance', subjects: {}, eventType: 'cherry-pick-healed', payload: { root: e.root } }));
  try {
    await auditFn({ root });
  } catch {
    /* audit best-effort — the sequencer is already healed; a logging failure must not re-wedge */
  }
  return 'cleared';
}
