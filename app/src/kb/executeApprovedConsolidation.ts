// Execute a Principal-APPROVED Reflect consolidation (SPEC-0024 REFLECT-5/7) — the testable core
// the main-process `answerActiveReview` dispatches to (thin glue). Reflect only ever PROPOSES a
// merge (a destructive→Review finding, slice 1); the actual merge runs ONLY when the Principal
// answers that Review with an explicit affirmative verdict — never autonomously. The merge reuses
// the shared entity-merge core (`mergeNodes`) and advances the canonical under the shared lock via
// the optimistic-advance helper; the caller promotes (the loser's deletion mirrors to `main` via
// the deletion-aware gate, STAGING-10). Idempotent: an already-merged plan is a clean no-op.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid } from './ulid';
import { ensureGitIdentity } from './vault';
import { Mutex } from './stageLock';
import { withConcurrentAdvance, type PrepareContext } from './canonicalAdvance';
import { getReview } from './reviewStore';
import { mergeNodes } from './mergeNodes';

const STAGE = 'consolidation';
// Sink-inventory note (SPEC-0030 #30): `jobId` here is a path SEGMENT, not a rel — this is the
// **Class B** id-injection axis, guarded by `isSafeJobId` (charset, no separators/traversal) at the
// registry READ/WRITE/SINK boundaries (#73/#29), NOT by the Class-A `assertContainedRel` rel-
// containment helper (they don't substitute for each other). The `jobId` flows from a Review's
// `markerKey` (an internal record raised by the reflect job, whose id is registry-validated upstream),
// so it's a validated segment by the time it reaches here.
/** Per-job consolidation audit (tracked on staging, never promoted — like the job journal). */
function consolidationAuditRel(jobId: string): string {
  return path.join('.kb', 'jobs', jobId, 'consolidations.jsonl');
}

export interface ConsolidationResult {
  reviewId: string;
  executed: boolean;
  /** Why it didn't execute (when `executed` is false). */
  reason?: 'not-found' | 'not-approved' | 'not-a-consolidation' | 'already-merged';
  deleted?: string[]; // loser node rels removed (when executed)
}

/**
 * Execute the consolidation a Review (`reviewId`) describes — but ONLY if it is an affirmatively-
 * answered (`verdict === 'confirm'`) consolidation Review (its merge plan rides in the markerKey).
 * Any other state (not found / not approved / not a consolidation / already merged) is a safe no-op
 * with a `reason`. MUST be called on the staging worktree; serializes its canonical advance through
 * `lock`. Returns what (if anything) it merged — the caller then promotes to mirror the deletion.
 *
 * BUG-4 (#518): used to `prepare` in ONE fixed, reused worktree/branch (`reset --hard` + commit) — a
 * stage-owned "shared worktree" pattern. `pipeline.ts` fires `runAnsweredReviewEffects` unawaited per
 * answered review, so two Principal approvals answered close together ran two concurrent calls here,
 * sharing that ONE worktree+branch OFF the lock (only the advance itself is locked): the second call's
 * `reset --hard` could wipe the first's in-flight merge, or its commit could overwrite the first's on
 * the shared branch ref before the first's advance (which reads the branch by NAME, not a captured
 * sha) ever ran — so the first call could report `executed:true` while its merge was silently
 * discarded. Now uses {@link withConcurrentAdvance} — the SAME per-item ephemeral-worktree primitive
 * decompose/claims/connect/archive already use (#508), one fresh worktree + unique branch per call, no
 * sharing possible. Not a new pattern for `mergeNodes` specifically: `connectOne`'s own merge path
 * already calls it from inside a `withConcurrentAdvance`-provided worktree. No `sparsePaths` — like
 * connect, `mergeNodes`' write footprint (every claim pointing at a loser, potentially) isn't bounded
 * in advance. Concurrency safety now rides on `advanceOrCollide`'s existing collision handling: two
 * DISJOINT consolidations both land (cherry-pick replay); two touching the SAME node retry against the
 * fresh canonical, bounded, before falling back to `already-merged` (never a silent half-merge).
 */
export async function executeApprovedConsolidation(stagingWt: string, reviewId: string, lock: Mutex): Promise<ConsolidationResult> {
  stagingWt = path.resolve(stagingWt);
  const review = await getReview(stagingWt, reviewId);
  if (!review) return { reviewId, executed: false, reason: 'not-found' };
  // Safety envelope (REFLECT-5): nothing executes without an explicit affirmative answer.
  if (review.answer?.verdict !== 'confirm') return { reviewId, executed: false, reason: 'not-approved' };
  const mk = review.raisedBy.markerKey;
  if (mk.kind !== 'consolidation' || !mk.canonicalRel || !mk.loserRels) return { reviewId, executed: false, reason: 'not-a-consolidation' };
  const canonicalRel = mk.canonicalRel;
  const loserRels = mk.loserRels.split('\n').filter((r) => r.length > 0);
  const jobId = mk.jobId ?? 'reflect';
  const runId = ulid();

  let result: ConsolidationResult = { reviewId, executed: false, reason: 'already-merged' };

  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt); // the ephemeral per-call worktree, fresh off the checkpoint — no reset needed
    await ensureGitIdentity(wtGit);
    const { deleted } = await mergeNodes(wt, canonicalRel, loserRels);
    if (deleted.length === 0) {
      result = { reviewId, executed: false, reason: 'already-merged' }; // idempotent: nothing to do
      return false;
    }
    // Rich audit (AUTO-8 / AUDIT-2,11): what merged into what + the approving reviewId (the why).
    const auditPath = path.join(wt, consolidationAuditRel(jobId));
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(
      auditPath,
      JSON.stringify({ ts: new Date().toISOString(), runId, event: 'consolidated', reviewId, canonicalRel, merged: deleted }) + '\n',
      'utf8',
    );
    await wtGit.raw('add', '-A');
    await wtGit.commit(`reflect: consolidate ${deleted.length} into ${canonicalRel} (review ${reviewId})`);
    result = { reviewId, executed: true, deleted };
    return true;
  };
  // Same-path collision exhaustion leaves the canonical untouched (no half-merge); the Principal's
  // approval persists on the Review, so a later poke/dispatch can retry.
  const onExhausted = async (): Promise<void> => {
    result = { reviewId, executed: false, reason: 'already-merged' };
  };

  await withConcurrentAdvance({ root: stagingWt, lock, stage: STAGE }, prepare, onExhausted);
  return result;
}
