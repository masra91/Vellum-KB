// The Job runtime (SPEC-0023 JOBS) — a FIFTH user of the SPEC-0014 harness, generalized from
// "react to one new source" to "wake on a schedule, do one bounded pass." Like the Enrich stages
// it runs an agent in a disposable worktree synced to a canonical checkpoint, then advances the
// canonical under the shared lock via the optimistic-concurrency helper (ORCH-17/18/19) — so a job
// NEVER blocks live capture/Enrich (JOBS-3/5). It is single-flight (JOBS-6), keeps a per-job journal
// (JOBS-7), audits richly (JOBS-8), routes findings by disposition+posture (JOBS-9/15), and takes no
// external side-effecting action (JOBS-10 — behaviors are pure cognition; the runner owns all writes).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid } from './ulid';
import { ensureGitIdentity } from './vault';
import { Mutex } from './stageLock';
import { withOptimisticAdvance, advanceOrCollide, canonicalHead, DEFAULT_MAX_COLLISION_RETRIES } from './canonicalAdvance';
import { noopDevLog, type DevLog } from './devlog';
import { checkContainedRel } from './pathContainment';
import { reviewRel, writeReviewFile } from './reviewStore';
import { recordContradictionDirective } from './directives';
import { blockKey } from './connect';
import { parseEntityNode } from './connectDoc';
import type { Review } from './reviews';
import {
  effectiveDisposition,
  isSafeJobId,
  normalizeJournalEntry,
  type JobConfig,
  type JobBehavior,
  type JournalEntry,
  type AuditedFinding,
} from './jobs';

/** Per-job disposable worktree + work branch (kept distinct per job id so jobs never collide). */
function worktreeRel(jobId: string): string {
  return path.join('.kb', 'cache', 'worktrees', `job-${jobId}`);
}
function workBranch(jobId: string): string {
  return `kb/job-${jobId}-work`;
}
/** Per-job run-state journal (JOBS-7): tracked on `staging`, never promoted (not in EVERGREEN_PATHS). */
export function journalRel(jobId: string): string {
  return path.join('.kb', 'jobs', jobId, 'journal.jsonl');
}

/** Read an entity node's STABLE block identity (`kind|normalizedName`) from its rel — the content-derived
 *  key a contradiction flag is anchored on (survives the ULID rebirth a re-derive/replay inflicts;
 *  SPEC-0036 CONTRA). Null if the node is missing/foreign/unreadable (the flag is then skipped — the
 *  Review still raises; a vanished node never breaks the pass). */
async function nodeBlockIdentity(root: string, rel: string): Promise<string | null> {
  try {
    const { kind, name } = parseEntityNode(await fs.readFile(path.join(root, rel), 'utf8'));
    return blockKey(kind, name);
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Knowledge roots a job's auto-applied writes may target (SPEC-0023 JOBS-10 sink guard). DERIVED
 * knowledge only — entities/claims/outputs — never `sources/` (immutable ground truth, the forward
 * pipeline's domain; DECOMP-8/DATA-2) and never config/engine/repo paths. A DISTINCT constant from
 * `EVERGREEN_PATHS` (which includes `sources`): jobs READ evergreen but must never WRITE ground truth.
 */
export const JOB_WRITE_PATHS = ['entities', 'claims', 'outputs'] as const;

/**
 * Sink-side containment for an agent-emitted write set (JOBS-10) — defense-in-depth, independent of
 * disposition/posture, because `rel` is LLM output (a prompt-injection surface via node excerpts).
 * Returns a rejection reason for the FIRST offending write, or null if every write is safe. The
 * symlink-safe containment + allowlist live in the shared `checkContainedRel` helper (SPEC-0030); we
 * map its typed verdict back to this sink's exact reasons. Catches `..` traversal, absolute paths,
 * `entities/../sources/x`, and committed-symlink escapes; the allowlist (JOB_WRITE_PATHS) blocks
 * `.git/`, `.kb/`, `app/`, repo-root files, AND `sources/`. The caller treats any rejection as atomic
 * over the whole finding (no partial writes).
 */
export async function validateWrites(wt: string, writes: readonly { rel: string; content: string }[]): Promise<string | null> {
  for (const w of writes) {
    const r = await checkContainedRel(wt, w.rel, JOB_WRITE_PATHS);
    if ('kind' in r) {
      return r.kind === 'escape'
        ? `write escapes the worktree: ${w.rel}`
        : `write outside the knowledge roots (${JOB_WRITE_PATHS.join('/')}): ${w.rel}`;
    }
  }
  return null;
}

/** Read a job's journal (JOBS-7) from `root` (a worktree or vault root), oldest→newest. Missing → []. */
export async function readJournal(root: string, jobId: string): Promise<JournalEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(path.resolve(root), journalRel(jobId)), 'utf8');
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      // Normalize at the read boundary (JOBS-8): a legacy/partial line missing the run-summary fields
      // must not surface as "undefined" in the run detail — coerce to a well-formed entry.
      out.push(normalizeJournalEntry(JSON.parse(line)));
    } catch {
      /* skip a malformed line — never crash continuity on a bad journal entry */
    }
  }
  return out;
}

/** Ensure a healthy per-job worktree on the job's work branch; recreate if broken (mirrors the stages). */
async function ensureJobWorktree(root: string, jobId: string): Promise<string> {
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  const branch = (await git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const wt = path.join(root, worktreeRel(jobId));
  try {
    await git.raw('worktree', 'prune');
  } catch {
    /* none registered yet */
  }
  const healthy =
    (await pathExists(wt)) &&
    (await simpleGit(wt)
      .revparse(['--is-inside-work-tree'])
      .then(() => true)
      .catch(() => false));
  if (!healthy) {
    if (await pathExists(wt)) await fs.rm(wt, { recursive: true, force: true });
    await fs.mkdir(path.dirname(wt), { recursive: true });
    await git.raw('worktree', 'add', '-B', workBranch(jobId), wt, branch);
  }
  return wt;
}

export interface JobRunResult {
  jobId: string;
  runId: string;
  outcome: 'advanced' | 'noop' | 'setaside';
  inspected: string;
  applied: number; // findings auto-applied
  deferred: number; // findings routed to Review
}

/**
 * Run ONE bounded pass of `job` under optimistic concurrency (JOBS-3/4/5). The behavior's cognition
 * + all writes happen OFF the lock (synced to a canonical checkpoint); only the canonical ff-advance
 * runs under `lock`. A pass ALWAYS commits at least its journal/audit line, so it always advances
 * (records that it ran — even a no-find run, JOBS-7/8). Disjoint job writes (unique ULID paths +
 * the per-job journal) replay cleanly onto a moved canonical; a same-path collision retries against
 * the fresh canonical and, on exhaustion, records a set-aside (ORCH-19) — never half-applied.
 */
export async function runJobOnce(
  root: string,
  job: JobConfig,
  behavior: JobBehavior,
  lock: Mutex = new Mutex(),
  log: DevLog = noopDevLog,
): Promise<JobRunResult> {
  // #29 sink guard (last line of defense): `job.id` is composed DIRECTLY into the journal path,
  // the per-job worktree, and the work branch below — assert it's a bare slug before ANY of that,
  // so even a future caller that bypasses the registry read/write guards can never drive a
  // traversal id (`../x`) into a filesystem path. Throws (never half-runs) — caller treats as a
  // failed pass; the registry read already drops such ids, so this only fires on a direct misuse.
  if (!isSafeJobId(job.id)) throw new Error(`refusing to run job with unsafe id: ${JSON.stringify(job.id)}`);
  root = path.resolve(root);
  const runId = ulid();
  const branch = workBranch(job.id);
  let result: JobRunResult = { jobId: job.id, runId, outcome: 'noop', inspected: '', applied: 0, deferred: 0 };

  const prepare = async (base: string): Promise<boolean> => {
    const wt = await ensureJobWorktree(root, job.id);
    const wtGit = simpleGit(wt);
    await wtGit.raw('reset', '--hard', base); // sync to the canonical checkpoint (ORCH-17)

    const journal = await readJournal(wt, job.id);
    const pass = await behavior({ root: wt, posture: job.posture, config: job.config, journal });

    const audited: AuditedFinding[] = [];
    let applied = 0;
    let deferred = 0;
    const now = new Date().toISOString();
    for (const finding of pass.findings) {
      const posed = effectiveDisposition(finding, job.posture);
      const writes = finding.writes ?? [];
      // Sink guard (JOBS-10): even an auto disposition only applies if EVERY write is contained +
      // allowlisted. A rejection forces the WHOLE finding to Review (atomic — no partial writes).
      const rejection = posed === 'auto' ? await validateWrites(wt, writes) : null;
      const disposition: typeof posed = rejection ? 'review' : posed;
      const rec: AuditedFinding = { summary: finding.summary, kind: finding.kind, confidence: finding.confidence, disposition };
      if (disposition === 'auto') {
        // Additive, high-confidence, contained → apply the writes on `staging`, audited.
        for (const w of writes) {
          const dest = path.join(wt, w.rel);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, w.content, 'utf8');
        }
        applied += 1;
      } else {
        // Destructive / low-confidence / sink-rejected → raise a Review (SPEC-0018), apply NO
        // effect (JOBS-9/10). A sink rejection records the reason in the audit (no silent drop).
        const id = ulid();
        // SPEC-0036 CONTRA-1/5: a contradiction finding flags its entity on a STABLE block identity (so
        // the flag survives rebirth) and routes the yes/no question to Review. Resolve the identity from
        // the entity node now (inside the worktree, where it exists); a missing node degrades to a plain
        // review (no durable flag) rather than failing the pass.
        const contra = finding.review?.contradiction;
        const contraIdentity = contra ? await nodeBlockIdentity(wt, contra.entityRel) : null;
        const review: Review = {
          id,
          status: 'open',
          question: rejection ? `Job write rejected — needs review: ${finding.summary}` : finding.review?.question ?? finding.summary,
          detail: rejection ? `${finding.summary} — rejected: ${rejection}` : finding.review?.detail ?? finding.summary,
          raisedBy: {
            stage: `job:${job.id}`,
            runId,
            item: { kind: 'job', ref: journalRel(job.id) },
            auditRel: journalRel(job.id),
            // A consolidation finding carries its merge plan into the markerKey so an APPROVED Review can
            // be executed by the dispatch (REFLECT-7). A contradiction finding carries the entity's STABLE
            // block identity + the two statements so answerReview can transition the durable flag at answer
            // time WITHOUT re-reading the (possibly reborn) node (CONTRA-3). markerKey values are strings.
            markerKey:
              contra && contraIdentity
                ? { jobId: job.id, runId, kind: 'contradiction', identityKey: contraIdentity, statementA: contra.statementA, statementB: contra.statementB }
                : finding.review?.consolidation
                  ? { jobId: job.id, runId, kind: 'consolidation', canonicalRel: finding.review.consolidation.canonicalRel, loserRels: finding.review.consolidation.loserRels.join('\n') }
                  : { jobId: job.id, runId },
          },
          subject: {},
          createdAt: now,
        };
        await writeReviewFile(path.join(wt, reviewRel(id)), review);
        // Record the durable ENTITY FLAG in `needs-you` state — committed in the SAME commit as the
        // Review (atomic) and promoted to `main` (evergreen `directives/`). It persists until the human
        // resolves the review (CONTRA-7). A sink-rejected finding is NOT a contradiction → never flags.
        if (contra && contraIdentity && !rejection) {
          await recordContradictionDirective(wt, {
            identityKey: contraIdentity,
            statementA: contra.statementA,
            statementB: contra.statementB,
            state: 'needs-you',
            reviewId: id,
            decidedAt: now,
          });
        }
        rec.reviewId = id;
        if (rejection) rec.rejection = rejection;
        deferred += 1;
      }
      audited.push(rec);
    }

    // Append the rich journal/audit line for this run (JOBS-7/8) — always, even a no-find run.
    const entry: JournalEntry = {
      ts: now,
      runId,
      inspected: pass.inspected,
      applied,
      deferred,
      ...(audited.length > 0 ? { findings: audited } : {}),
      ...(pass.cursor ? { cursor: pass.cursor } : {}),
      // #528 fast-follow: persist an agent-backed pass's ORCH-16 provenance onto the journal — the
      // durable audit trail other stages' AgentTrace already lands in.
      ...(pass.agent ? { agent: pass.agent } : {}),
    };
    const journalPath = path.join(wt, journalRel(job.id));
    await fs.mkdir(path.dirname(journalPath), { recursive: true });
    await fs.appendFile(journalPath, JSON.stringify(entry) + '\n', 'utf8');

    await wtGit.raw('add', '-A');
    await wtGit.commit(`job ${job.id}: run ${runId} (${applied} applied, ${deferred} deferred)`);
    result = { jobId: job.id, runId, outcome: 'advanced', inspected: pass.inspected, applied, deferred };
    return true;
  };

  // Same-path collision exhaustion (ORCH-19): record a set-aside journal line, never half-apply.
  // The set-aside advance is itself bounded-retried against a moving canonical (mirrors #47's
  // hardened Connect path) so it can't be silently dropped — though for a job it's effectively
  // always ff/replay (the per-job journal path is disjoint + single-flight).
  const onExhausted = async (): Promise<void> => {
    for (let attempt = 0; attempt <= DEFAULT_MAX_COLLISION_RETRIES; attempt++) {
      const wt = await ensureJobWorktree(root, job.id);
      const wtGit = simpleGit(wt);
      const base = await canonicalHead(root);
      await wtGit.raw('reset', '--hard', base);
      const entry: JournalEntry = { ts: new Date().toISOString(), runId, inspected: result.inspected, applied: 0, deferred: 0, note: 'collision-exhausted' };
      const journalPath = path.join(wt, journalRel(job.id));
      await fs.mkdir(path.dirname(journalPath), { recursive: true });
      await fs.appendFile(journalPath, JSON.stringify(entry) + '\n', 'utf8');
      await wtGit.raw('add', '-A');
      await wtGit.commit(`job ${job.id}: set aside run ${runId} (collision-exhausted)`);
      if ((await lock.run(() => advanceOrCollide(root, branch, base), `job:${job.id}:setaside-advance`)) === 'advanced') break;
      // The set-aside advance itself collided — re-sync to the moved canonical and retry (bounded).
    }
    log.warn('job.setaside', { runId, itemId: job.id, reason: 'collision-exhausted' });
    result = { ...result, outcome: 'setaside' };
  };

  try {
    await withOptimisticAdvance({ root, lock, workBranch: branch }, prepare, onExhausted);
  } catch (err) {
    // OBS-4: a job behavior/run failure (e.g. the job's agent threw) — surface the cause. The run
    // didn't advance; the scheduler retries on its next tick. Never a silent dead job.
    log.error('job.failed', { runId, itemId: job.id, err });
    throw err;
  }
  return result;
}

/**
 * Owns one job's execution with **single-flight** (JOBS-6): a scheduled fire (or "run now",
 * JOBS-11) while a run is in progress is skipped, not stacked. After a run advances `staging`, the
 * optional `afterRun` hook publishes evergreen findings to `main` via the promotion gate (JOBS-12);
 * it is a no-op when the run only touched the (non-evergreen) journal.
 */
export class JobRunner {
  private readonly root: string;
  readonly job: JobConfig;
  private readonly behavior: JobBehavior;
  private readonly lock: Mutex;
  private readonly afterRun?: () => Promise<void>;
  private readonly log: DevLog;
  private running = false;

  constructor(
    root: string,
    job: JobConfig,
    behavior: JobBehavior,
    lock: Mutex = new Mutex(),
    afterRun?: () => Promise<void>,
    log: DevLog = noopDevLog,
  ) {
    this.root = path.resolve(root);
    this.job = job;
    this.behavior = behavior;
    this.lock = lock;
    this.afterRun = afterRun;
    this.log = log.child({ scope: `job:${job.id}` });
  }

  /** True while a run is in flight (single-flight guard). */
  get inFlight(): boolean {
    return this.running;
  }

  /**
   * Run one bounded pass now (scheduled tick or manual "run now"), respecting single-flight: a call
   * while a run is in progress returns `'skipped'` (JOBS-6/11). Resolves with the run outcome.
   */
  async runNow(): Promise<JobRunResult | 'skipped'> {
    if (this.running) return 'skipped';
    this.running = true;
    try {
      const res = await runJobOnce(this.root, this.job, this.behavior, this.lock, this.log);
      if (this.afterRun) await this.afterRun(); // promote evergreen findings → main (no-op if journal-only)
      return res;
    } finally {
      this.running = false;
    }
  }
}
