// The Review store + answer flow (SPEC-0018). Shell-agnostic: the main process (IPC) and the
// stages call these; no electron/obsidian import (STACK-6).
//
// Reviews live at `reviews/<dateShard(id)>/<id>/review.json` — canonical JSON (a workflow
// artifact the app reads, not Obsidian-native knowledge), so no bespoke YAML parser (ENG).
// Raising is done by the originating stage inside its worktree (so the review + park marker
// commit atomically with the stage's other effects). Answering runs in the main process and
// goes through the SHARED canonical-writer lock so it never races a stage's ff-advance (§5).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dateShard } from './ulid';
import { ensureGitIdentity } from './vault';
import { boundedGit } from './canonicalAdvance';
import { captureToInbox } from './ingest';
import { validReviewAnswerInput, type Review } from './reviews';
import { recordDisambiguationDecision, verdictToDisambiguation } from './disambiguationDecisions';
import { recordDisambiguationDirective, recordConsolidationDirective, recordContradictionDirective } from './directives';
import { blockKey as computeBlockKey } from './connect';
import { parseEntityNode } from './connectDoc';
import type { Mutex } from './stageLock';
import { walkVaultFiles } from './vaultWalk';

/** Repo-relative directory for a review id. */
export function reviewRel(id: string): string {
  return path.join('reviews', dateShard(id), id);
}

/** Write a review artifact as JSON into `dir` (its own directory). */
export async function writeReviewFile(dir: string, review: Review): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'review.json'), JSON.stringify(review, null, 2) + '\n', 'utf8');
}

async function readReviewFile(file: string): Promise<Review | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Review;
  } catch {
    return null;
  }
}

/** `git add <pathspec>` hard-fails (not a no-op) when a pathspec matches nothing on disk — so an
 *  optional/conditional path must be checked before it's added to a commit's pathspec list. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Every review (open + answered), parsed. A stage that RESUMES from an answered review reads this
 *  to act on the verdict — e.g. Connect's link pass renders a confirmed ambiguous-link Review and
 *  declines a rejected one (CONNECT-15), keyed by `raisedBy.markerKey`. */
export async function readAllReviews(root: string): Promise<Review[]> {
  return allReviews(root);
}

/** Recursively collect every `review.json` under `reviews/`, repo-relative dir + parsed.
 *  SPEC-0061 T1 / ENG-9: delegates to the shared `walkVaultFiles` walker (this file is not owned by
 *  another wave-1 lane, so it's one of the ad-hoc-walker retirements landing in this slice). */
async function allReviews(root: string): Promise<Review[]> {
  const resolvedRoot = path.resolve(root);
  const rels = await walkVaultFiles(resolvedRoot, 'reviews', { keep: (n) => n === 'review.json' });
  const out: Review[] = [];
  for (const rel of rels) {
    const r = await readReviewFile(path.join(resolvedRoot, rel));
    if (r) out.push(r);
  }
  return out;
}

/** The "needs you" queue: open reviews, newest first (REVIEW-9). */
export async function findOpenReviews(root: string): Promise<Review[]> {
  const open = (await allReviews(root)).filter((r) => r.status === 'open');
  return open.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Load one review by id (from its canonical location). */
export async function getReview(root: string, id: string): Promise<Review | null> {
  return readReviewFile(path.join(path.resolve(root), reviewRel(id), 'review.json'));
}

export interface AnswerReviewResult {
  ok: boolean;
  message: string;
  /** The stage to poke so the parked item resumes (REVIEW-6), when successful. */
  stage?: string;
  review?: Review;
}

/**
 * Read an entity node's STABLE block identity (`kind|normalizedName`) from its rel — the content-derived
 * key a directive is keyed on (survives the ULID rebirth that defeats the entity-ULID decision store,
 * SPEC-0050 slice-2). Null if the node is missing/foreign/unreadable (the directive is then skipped —
 * provenance, not correctness, so a vanished loser never breaks the answer).
 */
async function nodeBlockIdentity(root: string, rel: string): Promise<string | null> {
  try {
    const { kind, name } = parseEntityNode(await fs.readFile(path.join(root, rel), 'utf8'));
    return computeBlockKey(kind, name);
  } catch {
    return null;
  }
}

/**
 * Answer a review (REVIEW-6/7). Under the shared canonical-writer lock:
 *  1. (if a note) capture it as a PRIMARY source via Ingest — propagates independently (REVIEW-7);
 *  2. write the answer onto the review artifact (status → answered);
 *  3. append a `review-answered` marker to the parked item's audit — SUPERSEDING the park so
 *     the item re-enters its stage's derived queue (REVIEW-6);
 *  4. commit. Idempotent: answering an already-answered review is a no-op.
 * The caller (pipeline) pokes `result.stage` so the item resumes promptly.
 */
export async function answerReview(root: string, lock: Mutex, id: string, answerInput: unknown, timeoutMs?: number): Promise<AnswerReviewResult> {
  root = path.resolve(root);
  const { verdict, note } = validReviewAnswerInput(answerInput);
  return lock.run(async () => {
    const dir = path.join(root, reviewRel(id));
    const review = await readReviewFile(path.join(dir, 'review.json'));
    if (!review) return { ok: false, message: `review ${id} not found` };
    if (review.status === 'answered') return { ok: true, message: 'already answered', stage: review.raisedBy.stage, review };

    // 1. The note becomes a primary source (origin: principal), propagating on its own (REVIEW-7).
    let noteSourceId: string | undefined;
    if (note) {
      const cap = await captureToInbox(root, 'review-note', [{ kind: 'text', text: note }]);
      noteSourceId = cap.ids[0];
    }

    // 2. Record the answer on the artifact.
    const answeredAt = new Date().toISOString();
    review.status = 'answered';
    review.answer = { verdict, ...(note ? { note } : {}), ...(noteSourceId ? { noteSourceId } : {}), answeredAt };
    await writeReviewFile(dir, review);

    // 3. Supersede the park: a `review-answered` marker on the parked item's audit re-enqueues it.
    const auditAbs = path.join(root, review.raisedBy.auditRel);
    const marker =
      JSON.stringify({
        ts: answeredAt,
        stage: review.raisedBy.stage,
        event: 'review-answered',
        reviewId: id,
        question: review.question,
        verdict,
        note: note ?? null,
        ...review.raisedBy.markerKey,
      }) + '\n';
    await fs.appendFile(auditAbs, marker, 'utf8');

    // 3b. REVIEW-18: a disambiguation review (its markerKey carries the decided entity-PAIR) records a
    // DURABLE, REUSABLE per-pair decision at ANSWER time — `confirm`→same, `reject`→distinct — so the
    // matcher (CONNECT-21) never re-asks a decided pair. Recorded here, independent of whether a
    // same-verdict merge write has landed yet (ORCH-26 pending-merge is still "decided"); lands in the
    // same commit as the answer. Provenance = this reviewId (PRIN-5/6); a later opposite verdict revises.
    const { blockKey, pairA, pairB } = review.raisedBy.markerKey;
    if (pairA && pairB) {
      await recordDisambiguationDecision(root, {
        a: pairA,
        b: pairB,
        verdict: verdictToDisambiguation(verdict),
        reviewId: id,
        decidedAt: answeredAt,
      });
      // SPEC-0050 DIR-2/3/4: ALSO graduate the answer to a durable DIRECTIVE keyed on the STABLE
      // block identity (`blockKey`, e.g. `organization|disney`), not the entity ULIDs. The pair-keyed
      // decision above is reborn-stale on a re-derive/replay (entity ULIDs change); the block identity
      // is content-derived and stable, so the directive — stored evergreen under `directives/` and
      // promoted to `main` — keeps the question settled across a new same-name source AND a Full Replay.
      if (blockKey) {
        await recordDisambiguationDirective(root, {
          identityKey: blockKey,
          verdict: verdictToDisambiguation(verdict),
          reviewId: id,
          decidedAt: answeredAt,
          entities: [pairA, pairB],
        });
      }
    }

    // 3c. SPEC-0050 slice-2: a CONSOLIDATION review (Reflect "should these two SEPARATE entities merge?",
    // markerKey {kind:'consolidation', canonicalRel, loserRels}) graduates its answer to a durable
    // CONSOLIDATION DIRECTIVE keyed on the STABLE pair of BLOCK IDENTITIES — not the entity ULIDs the
    // legacy per-pair decision (REVIEW-18) uses, which are reborn on re-derive/replay and go blind. So a
    // settled merge/distinct stays settled across a Full Replay (the Reflect analogue of slice-1's Disney
    // fix). confirm→merge ("one entity"), reject→distinct ("keep separate"). One directive per
    // canonical↔loser pair; a vanished/foreign node is skipped (provenance, not correctness).
    if (review.raisedBy.markerKey.kind === 'consolidation' && review.raisedBy.markerKey.canonicalRel) {
      const canonicalIdentity = await nodeBlockIdentity(root, review.raisedBy.markerKey.canonicalRel);
      if (canonicalIdentity) {
        const loserRels = (review.raisedBy.markerKey.loserRels ?? '').split('\n').filter(Boolean);
        const consolidationVerdict = verdict === 'confirm' ? 'merge' : 'distinct';
        for (const loserRel of loserRels) {
          const loserIdentity = await nodeBlockIdentity(root, loserRel);
          // Skip a degenerate same-identity pair: two nodes sharing a block identity can't be told apart
          // by a content-derived key after rebirth, so the durable directive can't represent them — that
          // (rare) within-identity case stays on the per-pair ULID decision recorded above.
          if (loserIdentity && loserIdentity !== canonicalIdentity) {
            await recordConsolidationDirective(root, {
              identityA: canonicalIdentity,
              identityB: loserIdentity,
              verdict: consolidationVerdict,
              reviewId: id,
              decidedAt: answeredAt,
            });
          }
        }
      }
    }

    // 3d. SPEC-0036 CONTRA-3/4: a CONTRADICTION review (markerKey {kind:'contradiction', identityKey,
    // statementA, statementB}) transitions the durable entity flag at answer time. confirm → RESOLVED
    // (a newer/stronger claim superseded the other — the loser is RETAINED + marked, never deleted, per
    // CONTRA-4; we only clear the flag, the claim files are untouched); reject → ACCEPTED (both legitimately
    // stand, attributed). EITHER terminal state clears the OPEN flag (it leaves the needs-you queue);
    // `accepted` stays CONTESTED at recall (CONTRA-6), `resolved` does not. Keyed on the STABLE block
    // identity carried in the markerKey, so the transition lands on the same entity even after a rebirth.
    if (review.raisedBy.markerKey.kind === 'contradiction' && review.raisedBy.markerKey.identityKey) {
      const { identityKey, statementA, statementB } = review.raisedBy.markerKey;
      if (statementA && statementB) {
        await recordContradictionDirective(root, {
          identityKey,
          statementA,
          statementB,
          state: verdict === 'confirm' ? 'resolved' : 'accepted',
          reviewId: id,
          decidedAt: answeredAt,
        });
      }
    }

    // 4. Commit on the canonical tree (serialized by the lock, so no race with stage ff-advances).
    // #163/#515: bounded — an unbounded git op here would wedge the shared lock forever. Pathspec-scoped
    // to what this transaction can touch (reviews/, the parked item's audit FILE, directives/ if this
    // answer wrote one) — not `-A`, so a concurrent writer's leftover staged state never gets swept into
    // this commit. `directives/` is conditional: a plain confirm/reject with no pair/block/identity key
    // never creates it, and `git add` hard-fails (not a no-op) on a pathspec matching nothing.
    const git = boundedGit(root, timeoutMs);
    await ensureGitIdentity(git);
    const pathspecs = ['reviews', review.raisedBy.auditRel];
    if (await pathExists(path.join(root, 'directives'))) pathspecs.push('directives');
    await git.raw('add', ...pathspecs);
    await git.commit(`review answered: ${id} (${verdict})`);
    return { ok: true, message: 'answered', stage: review.raisedBy.stage, review };
  }, 'review:answer');
}
