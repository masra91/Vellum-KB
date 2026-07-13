// Health remediation (SPEC-0060 VUX-16 slice-1) — the BACKEND of "remediation-first" Health: apply a
// non-destructive fix to a structural finding, or dismiss/ignore it. Shell-agnostic (the IPC layer in
// pipeline.ts passes the active context's staging worktree + vault path + lock). Mirrors the
// review-answer seam (reviewStore.answerReview): everything runs under the shared canonical-writer lock,
// then promotes so the effect lands on `main` — where the Health scan (`buildHealthReport` over
// `makeReadOnlyTools(vaultPath)`) and the dismiss filter (`readHealthDismissals(vaultPath)`) read.
//
// Slice-1 is NON-DESTRUCTIVE ONLY (additive, applies directly — no review needed):
//   - relink     — re-resolve ONE node's links via `linkOne` → a dead `[[target]]` (no node) is dropped.
//   - find-homes — the affinity orphan-linker pass (`linkOrphansOnce`) → reconnects degree-0 nodes.
// HELD for a later slice: merge (DESTRUCTIVE — needs the guarded→working→review confirm model) and
// enrich (its directive is consumed nowhere yet — a dead action today; excluded per the no-fake bar).
import { Mutex } from './stageLock';
import { ensureGitIdentity } from './vault';
import { boundedGit } from './canonicalAdvance';
import { noopDevLog, type DevLog } from './devlog';
import { linkOne, linkOrphansOnce } from './connectStage';
import { promote } from './staging';
import { recordHealthDismissal } from './directives';

/** The non-destructive remediation actions wired in slice-1. */
export type HealthRemediationAction = 'relink' | 'find-homes';

export interface HealthRemediateRequest {
  action: HealthRemediationAction;
  /** The finding's source-node rel-path (the dangling link's `from`, or the orphan node). */
  nodeRel: string;
}
export interface HealthRemediateResult {
  ok: boolean;
  message: string;
  changed?: boolean; // false ⇒ idempotent no-op (already resolved / nothing to reconnect)
}

export interface HealthDismissRequest {
  findingKey: string; // the content-stable key (healthFindingKey)
  kind: string; // 'orphan' | 'thin' | 'dangling'
  dismissed?: boolean; // false = un-dismiss / restore; default/omitted = dismiss
  reason?: string;
}
export interface HealthDismissResult {
  ok: boolean;
  message: string;
}

/**
 * Apply a non-destructive remediation, then promote so the fix shows on `main`. The fix + promote run in
 * ONE lock hold so a stage drain can't interleave between them. Errors return `ok:false` (never throw to
 * the IPC layer). `linkOne`/`linkOrphansOnce` already do their own canonical advance under the lock.
 */
export async function remediateHealthFindingInVault(
  stagingWt: string,
  vaultPath: string,
  lock: Mutex,
  req: HealthRemediateRequest,
  log: DevLog = noopDevLog,
): Promise<HealthRemediateResult> {
  try {
    if (req.action === 'relink') {
      if (!req.nodeRel) return { ok: false, message: 'Relink needs a node.' };
      return await lock.run(async () => {
        const res = await linkOne(stagingWt, req.nodeRel, log);
        await promote(vaultPath, undefined, undefined, log);
        return {
          ok: true,
          changed: res.changed,
          message: res.changed ? `Re-resolved links — ${res.links} kept, ${res.unresolved.length} unresolved dropped` : 'No change — this node’s links were already resolved.',
        };
      }, 'health:relink');
    }
    // find-homes — the affinity orphan-linker (reconnects degree-0 nodes, incl. this one).
    return await lock.run(async () => {
      const res = await linkOrphansOnce(stagingWt, log);
      await promote(vaultPath, undefined, undefined, log);
      return {
        ok: true,
        changed: res.committed,
        message: res.linked > 0 ? `Reconnected ${res.linked} of ${res.orphans} orphan${res.orphans === 1 ? '' : 's'} (${res.links} link${res.links === 1 ? '' : 's'}).` : 'No confident connections found — left as-is.',
      };
    }, 'health:find-homes');
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Persist a dismiss (or restore, `dismissed:false`) under the lock, commit, and promote so it lands on
 * `main`'s evergreen `directives/` — where the next Health scan's dismiss filter reads it. Mirrors
 * `answerReview`'s commit (`add -A` + commit on the staging worktree, then promote).
 */
export async function dismissHealthFindingInVault(
  stagingWt: string,
  vaultPath: string,
  lock: Mutex,
  req: HealthDismissRequest,
  decidedAt: string,
  log: DevLog = noopDevLog,
  timeoutMs?: number,
): Promise<HealthDismissResult> {
  if (!req.findingKey) return { ok: false, message: 'A finding key is required.' };
  try {
    await lock.run(async () => {
      await recordHealthDismissal(stagingWt, { findingKey: req.findingKey, kind: req.kind, dismissed: req.dismissed, reason: req.reason, decidedAt });
      // #163/#515: bounded — was raw unbounded `simpleGit`, able to wedge the shared lock forever.
      // Pathspec-scoped to `directives/` (all `recordHealthDismissal` writes), not `-A`.
      const git = boundedGit(stagingWt, timeoutMs);
      await ensureGitIdentity(git);
      await git.raw('add', 'directives');
      await git.commit(`health: ${req.dismissed === false ? 'restore' : 'dismiss'} ${req.findingKey}`);
      await promote(vaultPath, undefined, undefined, log);
    }, 'health:dismiss');
    return { ok: true, message: req.dismissed === false ? 'Restored.' : 'Dismissed.' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
