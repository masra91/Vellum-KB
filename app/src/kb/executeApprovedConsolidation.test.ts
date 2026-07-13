// Approved-consolidation execution (SPEC-0024 REFLECT-5/7). Real FS + git: only an affirmatively-
// answered consolidation Review executes a merge (via the shared merge core), and the loser then
// promotes away from `main` via the deletion-aware gate.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createKb } from './vault';
import { Mutex } from './stageLock';
import { ensureStagingWorktree } from './stagingWorktree';
import { promote } from './staging';
import { reviewRel, writeReviewFile } from './reviewStore';
import { executeApprovedConsolidation } from './executeApprovedConsolidation';
import { ulid } from './ulid';
import type { Review, ReviewVerdict } from './reviews';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

const CANON = 'entities/person/steve-jobs.md';
const LOSER = 'entities/person/steven-jobs.md';

/** A consolidation Review answered with `verdict`, with the merge plan in the markerKey. */
function consolidationReview(id: string, verdict: ReviewVerdict): Review {
  return {
    id,
    status: 'answered',
    question: 'Merge Steven Jobs into Steve Jobs?',
    detail: 'Same person.',
    raisedBy: {
      stage: 'job:reflect',
      runId: '01R',
      item: { kind: 'job', ref: '.kb/jobs/reflect/journal.jsonl' },
      auditRel: '.kb/jobs/reflect/journal.jsonl',
      markerKey: { jobId: 'reflect', kind: 'consolidation', canonicalRel: CANON, loserRels: LOSER },
    },
    subject: {},
    createdAt: '2026-06-02T00:00:00Z',
    answer: { verdict, answeredAt: '2026-06-02T01:00:00Z' },
  };
}

async function seedKB(stagingWt: string, reviewId: string, verdict: ReviewVerdict): Promise<void> {
  const node = (name: string) => `---\nid: ${name}\nkind: person\nname: ${name}\n---\n# ${name}\n`;
  await fs.mkdir(path.join(stagingWt, 'entities', 'person'), { recursive: true });
  await fs.writeFile(path.join(stagingWt, CANON), node('Steve Jobs'), 'utf8');
  await fs.writeFile(path.join(stagingWt, LOSER), node('Steven Jobs'), 'utf8');
  await fs.mkdir(path.join(stagingWt, 'claims', '2026'), { recursive: true });
  await fs.writeFile(path.join(stagingWt, 'claims/2026/01C.md'), `---\nid: 01C\nsubject: ${LOSER}\nstatus: fact\nconfidence: 0.9\n---\n\nCo-founded Apple.\n`, 'utf8');
  await writeReviewFile(path.join(stagingWt, reviewRel(reviewId)), consolidationReview(reviewId, verdict));
  const g = simpleGit(stagingWt);
  await g.add('-A');
  await g.commit('seed nodes + answered review');
}

async function withVault(fn: (root: string, stagingWt: string, lock: Mutex) => Promise<void>): Promise<void> {
  const dir = await makeTempDir();
  try {
    const root = path.join(dir, 'vault');
    await createKb({ path: root, initGitIfNeeded: true });
    const stagingWt = await ensureStagingWorktree(root);
    await fn(root, stagingWt, new Mutex());
  } finally {
    await rmTempDir(dir);
  }
}

describe.skipIf(!gitAvailable)('executeApprovedConsolidation (REFLECT-5/7)', () => {
  it('an APPROVED (confirm) consolidation merges the loser; promote removes it from main', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const id = ulid();
      await seedKB(stagingWt, id, 'confirm');
      const res = await executeApprovedConsolidation(stagingWt, id, lock);
      expect(res.executed).toBe(true);
      expect(res.deleted).toEqual([LOSER]);

      expect(await pathExists(path.join(stagingWt, LOSER))).toBe(false); // loser gone on staging
      const claimMd = await fs.readFile(path.join(stagingWt, 'claims/2026/01C.md'), 'utf8');
      expect(claimMd).toContain(`subject: ${CANON}`); // claim repointed to the survivor

      await promote(root); // deletion-aware gate mirrors the removal to main (REFLECT-7 / STAGING-10)
      expect(await pathExists(path.join(root, CANON))).toBe(true);
      expect(await pathExists(path.join(root, LOSER))).toBe(false); // loser removed from main
      expect((await simpleGit(root).status()).isClean()).toBe(true);
    });
  });

  it('a REJECTED review executes NOTHING (safety: only explicit approval acts; REFLECT-5)', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const id = ulid();
      await seedKB(stagingWt, id, 'reject');
      const res = await executeApprovedConsolidation(stagingWt, id, lock);
      expect(res).toMatchObject({ executed: false, reason: 'not-approved' });
      expect(await pathExists(path.join(stagingWt, LOSER))).toBe(true); // loser untouched
    });
  });

  it('is idempotent: a second execution after the merge is a no-op', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const id = ulid();
      await seedKB(stagingWt, id, 'confirm');
      expect((await executeApprovedConsolidation(stagingWt, id, lock)).executed).toBe(true);
      const again = await executeApprovedConsolidation(stagingWt, id, lock);
      expect(again).toMatchObject({ executed: false, reason: 'already-merged' });
    });
  });

  it('a non-consolidation or missing review is a safe no-op', async () => {
    await withVault(async (root, stagingWt, lock) => {
      expect(await executeApprovedConsolidation(stagingWt, ulid(), lock)).toMatchObject({ executed: false, reason: 'not-found' });
    });
  });

  // BUG-4 (#518): the OLD implementation shared ONE fixed worktree+branch across every call —
  // `prepare()` ran OFF the lock, so a second concurrent call's `reset --hard` (or its commit
  // overwriting the shared branch ref before the first's advance ever read it) could DISCARD the
  // first's merge while it still reported `executed:true`. Prove the fix on two DISJOINT
  // consolidations (different canonical/loser pairs, so both are legitimately mergeable — no
  // same-path collision expected) fired via Promise.all: both must report executed:true AND both
  // losers must actually be gone from the FINAL committed tree, not just "no exception thrown".
  it('two CONCURRENT disjoint consolidations both land — neither silently discards the other (BUG-4)', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const CANON2 = 'entities/person/tim-cook.md';
      const LOSER2 = 'entities/person/timothy-cook.md';
      const node = (name: string) => `---\nid: ${name}\nkind: person\nname: ${name}\n---\n# ${name}\n`;

      const id1 = ulid();
      const id2 = ulid();
      await seedKB(stagingWt, id1, 'confirm'); // Steve/Steven Jobs
      await fs.writeFile(path.join(stagingWt, CANON2), node('Tim Cook'), 'utf8');
      await fs.writeFile(path.join(stagingWt, LOSER2), node('Timothy Cook'), 'utf8');
      const review2: Review = {
        id: id2,
        status: 'answered',
        question: 'Merge Timothy Cook into Tim Cook?',
        detail: 'Same person.',
        raisedBy: {
          stage: 'job:reflect',
          runId: '01R2',
          item: { kind: 'job', ref: '.kb/jobs/reflect/journal.jsonl' },
          auditRel: '.kb/jobs/reflect/journal.jsonl',
          markerKey: { jobId: 'reflect', kind: 'consolidation', canonicalRel: CANON2, loserRels: LOSER2 },
        },
        subject: {},
        createdAt: '2026-06-02T00:00:00Z',
        answer: { verdict: 'confirm', answeredAt: '2026-06-02T01:00:00Z' },
      };
      await writeReviewFile(path.join(stagingWt, reviewRel(id2)), review2);
      const g = simpleGit(stagingWt);
      await g.add('-A');
      await g.commit('seed second disjoint consolidation pair');

      // Genuinely concurrent — this is exactly what `void runAnsweredReviewEffects` firing twice does.
      const [res1, res2] = await Promise.all([
        executeApprovedConsolidation(stagingWt, id1, lock),
        executeApprovedConsolidation(stagingWt, id2, lock),
      ]);

      expect(res1).toMatchObject({ executed: true, deleted: [LOSER] });
      expect(res2).toMatchObject({ executed: true, deleted: [LOSER2] });

      // The real proof: BOTH losers are actually gone from staging, not just "no throw".
      expect(await pathExists(path.join(stagingWt, LOSER))).toBe(false);
      expect(await pathExists(path.join(stagingWt, LOSER2))).toBe(false);
      expect(await pathExists(path.join(stagingWt, CANON))).toBe(true);
      expect(await pathExists(path.join(stagingWt, CANON2))).toBe(true);
      expect((await simpleGit(stagingWt).status()).isClean()).toBe(true);

      await promote(root);
      expect(await pathExists(path.join(root, LOSER))).toBe(false);
      expect(await pathExists(path.join(root, LOSER2))).toBe(false);
      expect(await pathExists(path.join(root, CANON))).toBe(true);
      expect(await pathExists(path.join(root, CANON2))).toBe(true);
    });
  });

  // QA follow-up on BUG-4: two DIFFERENT reviews concurrently proposing to merge the SAME loser into
  // the SAME canonical (a genuine same-path overlap, not disjoint). `withConcurrentAdvance`'s existing
  // collision-retry already proves the generic "never a false advanced" guarantee (canonicalAdvance.test.ts
  // — "sets aside after K same-path collisions"); this confirms the CONSOLIDATION-SPECIFIC mapping is
  // honest too: exactly one call executes the real merge, and the loser (which retries against the now-
  // fresh canonical, where mergeNodes finds the node already gone) reports `executed:false,
  // reason:'already-merged'` — never a false `executed:true` for a merge that didn't actually happen.
  it('two reviews proposing the SAME merge concurrently — exactly one executes, the other honestly reports already-merged', async () => {
    await withVault(async (root, stagingWt, lock) => {
      const idA = ulid();
      const idB = ulid();
      // Both reviews propose the identical canonical/loser pair — a genuine same-path overlap.
      await fs.mkdir(path.join(stagingWt, 'entities', 'person'), { recursive: true });
      const node = (name: string) => `---\nid: ${name}\nkind: person\nname: ${name}\n---\n# ${name}\n`;
      await fs.writeFile(path.join(stagingWt, CANON), node('Steve Jobs'), 'utf8');
      await fs.writeFile(path.join(stagingWt, LOSER), node('Steven Jobs'), 'utf8');
      await writeReviewFile(path.join(stagingWt, reviewRel(idA)), consolidationReview(idA, 'confirm'));
      await writeReviewFile(path.join(stagingWt, reviewRel(idB)), consolidationReview(idB, 'confirm'));
      const g = simpleGit(stagingWt);
      await g.add('-A');
      await g.commit('seed one pair, two reviews approving the same merge');

      const [resA, resB] = await Promise.all([executeApprovedConsolidation(stagingWt, idA, lock), executeApprovedConsolidation(stagingWt, idB, lock)]);

      // Exactly one honestly executed the real merge; the other honestly reports it found nothing left
      // to do — never BOTH claiming executed:true (that would mean one silently discarded the other's
      // work while still reporting success), and never a false executed:true for a no-op merge.
      const executedCount = [resA, resB].filter((r) => r.executed).length;
      expect(executedCount).toBe(1);
      const [winner, loser] = resA.executed ? [resA, resB] : [resB, resA];
      expect(winner).toMatchObject({ executed: true, deleted: [LOSER] });
      expect(loser).toMatchObject({ executed: false, reason: 'already-merged' });

      // The real proof: the loser node is gone exactly once — not double-deleted, not silently un-done.
      expect(await pathExists(path.join(stagingWt, LOSER))).toBe(false);
      expect(await pathExists(path.join(stagingWt, CANON))).toBe(true);
      expect((await simpleGit(stagingWt).status()).isClean()).toBe(true);
    });
  });
});
