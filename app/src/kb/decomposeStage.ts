// The Decompose stage runtime (SPEC-0015) — the second user of the SPEC-0014 harness:
// the SAME deterministic pattern as the archivist (worktree isolation, fresh disposable
// session per item, orchestrator-owns-effects, ff-advance under the shared canonical-writer
// lock), pointed at a different queue + instruction file (ORCH-9).
//
// Queue model (v1): the archivist does not yet enqueue an Enrich queue, so the durable work
// list is DERIVED — a source is "queued" iff its append-only `audit.jsonl` has no terminal
// `decompose` marker yet. Committing the candidates + the `decomposed` marker in one commit IS
// the commit-to-dequeue (DECOMP-13): next sweep skips it. Idempotent restart for free
// (ORCH-13). A failed attempt appends a `failed` event (durable count); after K it appends a
// terminal `setaside` marker so a poison source never head-of-line-blocks (DECOMP-6/ORCH-12).
//
// Sources are NEVER mutated (DECOMP-8): raw payload + `source.md` identity are untouched; we
// only append to the append-only `audit.jsonl` history (as the archivist already does) and
// write NEW CANDIDATE files under `candidates/`.
//
// CANON-4 / STAGING-5: Decompose does NOT write resolved `entities/` nodes. Each entity MENTION
// the agent finds becomes a per-mention CANDIDATE (`candidates/<dateShard>/<id>.json`, Connect's
// input contract) on the working `staging` branch; `entities/` stays empty until Connect resolves
// (SPEC-0020). Candidates are working state — never promoted to evergreen `main` (STAGING-6).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid } from './ulid';
import { readCapturedMeta } from './ingest';
import { renderCandidate, candidateFileRel } from './candidateDoc';
import type { Candidate } from './connect';
import { makeDecomposeDecider, type DecomposeDecider, type SourceInput } from './decomposeAgent';
import { Mutex } from './stageLock';
import { epochScopedLines } from './replayEpoch';
import { withConcurrentAdvance, withEphemeralWorktree, advanceOrCollide, canonicalHead, DEFAULT_STAGE_CAP, type PrepareContext } from './canonicalAdvance';
import { noopDevLog, type DevLog } from './devlog';
import { noopTracer, noopActiveSpan, STAGE_RUN_OP, type Tracer, type ActiveSpan, type SpanOutcome } from './tracing';
import { CanonicalQueueCache } from './queueCache';

const STAGE = 'decompose';

/** Map a per-item result to its stage-run span outcome (set-aside is distinct from a plain error). */
function spanOutcome(ok: boolean, setAside: boolean): SpanOutcome {
  return ok ? 'ok' : setAside ? 'setaside' : 'error';
}
/** Default attempts before a poison source is set aside (DECOMP-6). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** A terminal marker means the source has left the derived queue (success or set-aside). */
const TERMINAL_EVENTS = new Set(['decomposed', 'setaside']);

/** One parsed line of a source's audit.jsonl that this stage cares about. */
interface AuditLine {
  stage?: string;
  event?: string;
}

/** Read a source dir's decompose audit state from its append-only audit.jsonl. */
async function readDecomposeState(sourceDir: string): Promise<{ terminal: boolean; failures: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
  } catch {
    return { terminal: false, failures: 0 };
  }
  let terminal = false;
  let failures = 0;
  // Scope to the current replay epoch (REPLAY-6): markers from a superseded generation are
  // ignored, so a replayed source re-enters the decompose queue — without rewriting history.
  for (const line of epochScopedLines(raw)) {
    if (line.trim().length === 0) continue;
    let obj: AuditLine;
    try {
      obj = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (obj.stage !== STAGE) continue;
    if (obj.event && TERMINAL_EVENTS.has(obj.event)) terminal = true;
    if (obj.event === 'failed') failures += 1;
  }
  return { terminal, failures };
}

/**
 * Recursively find every archived source directory (one containing a `source.md`).
 *
 * SPEC-0061 T1 / ENG-9 (#539): deliberately NOT swapped to the shared `walkVaultFiles` — that helper
 * collects FILES matching a name filter, while this walk collects DIRECTORIES via leaf-detection
 * (stop descending the instant a `source.md` marker is found; the directories inside a source unit,
 * e.g. attachments, are never visited). The two are structurally different collection shapes, not a
 * config variant of the same one — same judgment call as `watchConnectors.ts`'s `collectWatchedFiles`
 * staying its own bespoke walker (the shared helper's own header cites it as the richer safety-model
 * template, not a retirement target). Symlinks are still never followed here, matching the safety
 * uplift applied everywhere else in this consolidation.
 */
export async function findSourceDirs(root: string): Promise<string[]> {
  const sourcesRoot = path.join(path.resolve(root), 'sources');
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'source.md')) {
      out.push(dir);
      return; // a source unit is a leaf; don't descend into it
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
    }
  }
  await walk(sourcesRoot);
  return out;
}

/**
 * The decompose work queue (DECOMP-13): archived sources with no terminal decompose marker
 * and fewer than `maxAttempts` failures. Returned as repo-relative source dirs, sorted by
 * id (ULID dir name) so drains are deterministic.
 */
export async function readDecomposeQueue(root: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<string[]> {
  root = path.resolve(root);
  const dirs = await findSourceDirs(root);
  const queued: string[] = [];
  for (const dir of dirs) {
    const { terminal, failures } = await readDecomposeState(dir);
    if (terminal || failures >= maxAttempts) continue;
    queued.push(path.relative(root, dir));
  }
  return queued.sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1));
}

/** The rigid audit envelope (SPEC-0015 §3.4) — orchestrator-owned fields wrap freeform payloads. */
function auditLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), stage: STAGE, ...fields }) + '\n';
}

/** Build the agent's view of a source from its captured meta + raw text (text only in v1). */
async function readSourceInput(sourceDir: string): Promise<SourceInput> {
  const meta = await readCapturedMeta(sourceDir);
  const text = meta.kind === 'text' ? await fs.readFile(path.join(sourceDir, meta.raw), 'utf8') : null;
  return { sourceId: meta.id, kind: meta.kind, originalName: meta.originalName, mimeType: meta.mimeType, text };
}

export interface DecomposeOneResult {
  sourceId: string;
  ok: boolean;
  candidateIds: string[]; // ULIDs of the candidate files written on `staging` (STAGING-5)
  setAside: boolean;
  /** On a failed/set-aside outcome, the failure message — threaded onto the stage's error span so a
   *  failed source is diagnosable from the span alone (SPEC-0030 robustness batch). */
  error?: string;
}

/**
 * Decompose ONE source under optimistic concurrency (SPEC-0014 ORCH-17/18/19). Cognition + the
 * candidate/audit writes happen OFF the lock, synced to a canonical checkpoint; only the canonical
 * ff-advance runs under `lock`. Disjoint items (unique candidate ULIDs + per-source audit; ORCH-6)
 * replay cleanly onto a moved canonical; the same-path case retries against the fresh canonical and,
 * on exhaustion, sets the source aside (ORCH-19) — never dropped. `lock` defaults to a private mutex
 * so a standalone call (tests) still serializes its own advance; the stage passes the shared lock.
 */
export async function decomposeOne(
  root: string,
  sourceRel: string,
  decider: DecomposeDecider,
  lock: Mutex = new Mutex(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  log: DevLog = noopDevLog,
  span: ActiveSpan = noopActiveSpan,
): Promise<DecomposeOneResult> {
  root = path.resolve(root);
  let result: DecomposeOneResult = { sourceId: path.basename(sourceRel), ok: false, candidateIds: [], setAside: false };

  // OFF-lock (ORCH-17): sync the worktree to the canonical checkpoint, run cognition, write the
  // candidates + audit, and commit on the work branch. Returns true — there is always work to
  // advance (the candidates+marker on success, or the failed/setaside marker on error).
  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt); // the ephemeral per-item worktree, fresh off the checkpoint
    const sourceDirWt = path.join(wt, sourceRel);
    const runId = ulid();
    const auditPath = path.join(sourceDirWt, 'audit.jsonl');
    try {
      // DECOMP-6 / robustness: read the source INSIDE the set-aside try — a dangling/missing file-ref
      // (`meta.raw` ENOENT) must be a per-item set-aside-after-K, NOT an escape that trips the stage's
      // systemic circuit-breaker. `result.sourceId` defaults to the source basename, so the catch can
      // still record a failed/setaside marker even when the read itself threw (no `input` yet).
      const input = await readSourceInput(sourceDirWt);
      result.sourceId = input.sourceId;
      const decision = await decider(input, { span });
      const model = decision.agent?.model ?? 'default';

      // Mint candidate ULIDs + write candidate files (orchestrator-owned effects; DECOMP-3/5).
      // Each entity MENTION becomes one CANDIDATE on `staging` (STAGING-5 / CANON-4); we write NO
      // `entities/` node — resolution into evergreen entities is Connect's job (SPEC-0020).
      const candidateIds: string[] = [];
      for (const entity of decision.entities) {
        const id = ulid();
        const candidate: Candidate = {
          id,
          sourceId: input.sourceId,
          kind: entity.kind,
          name: entity.name,
          confidence: entity.confidence,
          mentions: entity.mentions,
        };
        const dest = path.join(wt, candidateFileRel(id));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, renderCandidate(candidate), 'utf8');
        candidateIds.push(id);
      }

      let audit = auditLine({ runId, sourceId: input.sourceId, model, event: 'start' });
      for (const sig of decision.signals ?? []) {
        // Carry the research-request fields (what/context) when present so the dispatcher can read a
        // structured request from the signal (SPEC-0028 RESEARCH-3); other signals omit them.
        audit += auditLine({ runId, sourceId: input.sourceId, model, event: 'signal', type: sig.type, note: sig.note, refs: sig.refs, ...(sig.what ? { what: sig.what } : {}), ...(sig.context ? { context: sig.context } : {}) });
      }
      audit += auditLine({ runId, sourceId: input.sourceId, model, event: 'decomposed', candidates: candidateIds.length });
      await fs.appendFile(auditPath, audit, 'utf8');

      await wtGit.raw('add', '-A');
      await wtGit.commit(`decompose: ${candidateIds.length} candidates from ${input.sourceId}`);
      result = { sourceId: input.sourceId, ok: true, candidateIds, setAside: false };
      return true;
    } catch (err) {
      // DECOMP-6 / ORCH-12: never lose the source. Record the failed attempt durably; set aside
      // after K so it can't head-of-line-block. No candidates are written on failure.
      const error = err instanceof Error ? err.message : String(err);
      // `result.sourceId` (the source basename, or the parsed id once the read succeeded) — never
      // `input.sourceId`, which is undefined when `readSourceInput` itself threw (the dangling-ref case).
      const sourceId = result.sourceId;
      const priorFailures = (await readDecomposeState(sourceDirWt)).failures;
      const attempt = priorFailures + 1;
      const setAside = attempt >= maxAttempts;
      let audit = auditLine({ runId, sourceId, event: 'failed', attempt, error });
      if (setAside) audit += auditLine({ runId, sourceId, event: 'setaside', attempts: attempt });
      // BUG #135 / dangling-ref: the failure may BE a missing source dir/file — ensure the audit dir
      // exists so the durable failed/setaside marker always lands (else the count never increments).
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, audit, 'utf8');
      // OBS-4: the structured audit above gets its verbose cause in the dev-log, cross-linked by runId (OBS-3).
      log.error('decompose.failed', { runId, itemId: sourceId, attempt, setAside, err });
      await wtGit.raw('add', '-A');
      await wtGit.commit(`decompose: failed ${sourceId} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
      result = { sourceId, ok: false, candidateIds: [], setAside, error };
      return true;
    }
  };

  // Same-path collision exhaustion (ORCH-19) — set the source aside so it can't head-of-line-block.
  // Rare for Decompose (disjoint candidate paths + per-source audit); never drop the item.
  const onExhausted = async (): Promise<void> => {
    const base = await canonicalHead(root);
    // #508 item 2: this pass only ever appends to sourceRel's own audit — narrower than the main
    // prepare (no candidates write here).
    await withEphemeralWorktree(
      root,
      STAGE,
      base,
      async ({ wt, workBranch }) => {
        await fs.appendFile(
          path.join(wt, sourceRel, 'audit.jsonl'),
          auditLine({ runId: ulid(), sourceId: result.sourceId, event: 'setaside', reason: 'collision-exhausted' }),
          'utf8',
        );
        const wtGit = simpleGit(wt);
        await wtGit.raw('add', '-A');
        await wtGit.commit(`decompose: set aside ${result.sourceId} (collision-exhausted)`);
        await lock.run(() => advanceOrCollide(root, workBranch, base), 'decompose:setaside-advance');
      },
      [sourceRel],
    );
    log.error('decompose.setaside', { itemId: result.sourceId, reason: 'collision-exhausted' });
    result = { ...result, ok: false, setAside: true };
  };

  // #508 item 2: decomposeOne's read scope is exactly the ONE source dir passed in (sourceRel), known
  // before the worktree is created. Its writes are new `candidates/<shard>/<id>.json` files — the
  // ids are minted during cognition, not knowable in advance, so the write target is the whole
  // `candidates/` dir (still far narrower than the full evergreen tree on a large vault).
  await withConcurrentAdvance({ root, lock, stage: STAGE, sparsePaths: [sourceRel, 'candidates'] }, prepare, onExhausted);
  return result;
}

/**
 * Owns a vault's Decompose stage: a poke/sweep drain loop sharing the canonical-writer lock
 * with the archivist (SPEC-0014 §5). Restartable: re-reads the derived queue and resumes.
 */
export class DecomposeStage {
  private readonly root: string;
  private readonly decider: DecomposeDecider;
  private readonly lock: Mutex;
  private readonly maxAttempts: number;
  private cap: number; // mutable for SPEC-0048 SCALE-4 live-apply (see setCap)
  private readonly log: DevLog;
  private readonly tracer: Tracer;
  private readonly nowMs: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;
  private drainStartedAt: string | null = null; // when the active drain began (OBS/VIZ in-flight dwell)
  // INGEST-PERF item 1: memoize the O(N) queue walk against the canonical HEAD sha — both call sites
  // below share it, and an idle sweep on an unchanged canonical skips the walk entirely.
  private readonly queueCache = new CanonicalQueueCache<string[]>();
  // #256 circuit-breaker: a wedged canonical writer makes every drain fail; back the stage off
  // (exponential, capped) instead of re-attempting on every sweep forever (which spins cognition +
  // grows the spans file → the heap-exhaustion crash). A clean drain resets it; items are NOT set
  // aside (they're recoverable, deferred until the writer heals — e.g. the #163 stale-lock fix).
  private backoffUntilMs = 0;
  private consecutiveDrainErrors = 0;
  private sweepMs = 30_000; // base backoff = one sweep interval; set in start()
  private static readonly DRAIN_BACKOFF_CAP_MS = 5 * 60_000;

  constructor(
    root: string,
    decider: DecomposeDecider = makeDecomposeDecider(),
    lock: Mutex = new Mutex(),
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    cap: number = DEFAULT_STAGE_CAP,
    log: DevLog = noopDevLog,
    tracer: Tracer = noopTracer,
    nowMs: () => number = () => Date.now(),
  ) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.maxAttempts = maxAttempts;
    this.cap = Math.max(1, Math.floor(cap));
    this.log = log.child({ scope: 'decompose' });
    this.tracer = tracer;
    this.nowMs = nowMs;
  }

  /** Initial drain + a periodic safety-net sweep (ORCH-15: poke + sweep). */
  start(sweepMs = 30_000): void {
    this.sweepMs = sweepMs;
    void this.poke();
    if (this.sweepTimer == null) {
      this.sweepTimer = setInterval(() => void this.poke(), sweepMs);
      this.sweepTimer.unref?.();
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Live-set the per-stage concurrency cap (SPEC-0048 SCALE-4): read on the NEXT batch (drainOnce
   *  slices `this.cap` per pass), so a Settings change applies without a restart. */
  setCap(cap: number): void {
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** The current per-stage concurrency cap (for Status display / SPEC-0048 Settings). */
  getCap(): number {
    return this.cap;
  }

  /** INGEST-PERF item 1 perf proof/telemetry: how many queue reads were served from the canonical-HEAD
   *  memo (`hits` = O(N) walks skipped) vs recomputed (`misses` = walks actually run). */
  queueCacheStats(): { hits: number; misses: number } {
    return { hits: this.queueCache.hits, misses: this.queueCache.misses };
  }

  /** Is this stage actively draining right now? (OBS-5 per-stage `running` state.) */
  busy(): boolean {
    return this.draining;
  }

  /** When the current drain began (ISO), or null when idle (SPEC-0032 VIZ-2 in-flight dwell). */
  currentSince(): string | null {
    return this.drainStartedAt;
  }

  /** Drain the queue, coalescing concurrent pokes; resolves only once fully idle. */
  poke(): Promise<void> {
    // #256: while backing off from a wedged canonical writer, a poke is a no-op (no queue read, no
    // cognition, no spans) — draining can't make progress anyway. The backoff auto-expires so the
    // stage retries (and resumes cleanly once the writer recovers).
    if (this.nowMs() < this.backoffUntilMs) return this.current ?? Promise.resolve();
    this.pending = true;
    if (!this.draining) {
      this.draining = true;
      this.drainStartedAt = new Date().toISOString();
      this.current = this.runDrains();
    }
    return this.current ?? Promise.resolve();
  }

  private async runDrains(): Promise<void> {
    let errored = false;
    try {
      while (this.pending) {
        this.pending = false;
        if (!(await this.drainOnce())) errored = true;
      }
      // #256 circuit-breaker: a drain that errored (e.g. the shared canonical writer is wedged so the
      // advance throws for every item) backs the stage off exponentially (capped) instead of
      // re-attempting on every 30s sweep forever; a clean drain resets it.
      if (errored) {
        this.consecutiveDrainErrors += 1;
        const backoffMs = Math.min(DecomposeStage.DRAIN_BACKOFF_CAP_MS, this.sweepMs * 2 ** (this.consecutiveDrainErrors - 1));
        this.backoffUntilMs = this.nowMs() + backoffMs;
        this.log.warn('decompose.writer-backoff', { consecutiveDrainErrors: this.consecutiveDrainErrors, backoffMs });
      } else {
        this.consecutiveDrainErrors = 0;
        this.backoffUntilMs = 0;
      }
    } finally {
      this.draining = false;
      this.drainStartedAt = null;
      this.current = null;
    }
  }

  /** Drain the queue once. Returns false if the pass errored out (e.g. a wedged canonical writer) so
   *  {@link runDrains} can back off, true on a clean pass. */
  private async drainOnce(): Promise<boolean> {
    try {
      let queue = await this.queueCache.read(this.root, () => readDecomposeQueue(this.root, this.maxAttempts));
      while (queue.length > 0) {
        // ORCH-17/18/20: process up to `cap` sources concurrently — each prepares OFF the lock in its
        // own ephemeral worktree, advances UNDER the shared lock (cap=1 ⇒ serial; cross-stage cognition
        // overlaps regardless). decomposeOne handles its own failures, so a settled batch never rejects.
        const batch = queue.slice(0, this.cap);
        // OBS-12: each item gets a `stage.run` span that wraps its decider's `copilot.invoke` child.
        // LOCUS DISTINCTION (the per-item ≠ systemic rule, #263/#282): decomposeOne RETURNS for a
        // per-item failure it could RECORD (e.g. a dangling/missing file-ref ENOENT → set aside after K,
        // the writer is fine) — that drains on, never trips the breaker. decomposeOne THROWS only when
        // it could NOT record (the canonical writer/advance is wedged — a SYSTEMIC failure affecting
        // every item) — that propagates to the catch → #256 back-off (don't retry-forever-spin).
        await Promise.all(
          batch.map((rel) => {
            const itemId = path.basename(rel);
            const span = this.tracer.start(STAGE_RUN_OP, { stage: STAGE, itemId });
            return decomposeOne(this.root, rel, this.decider, this.lock, this.maxAttempts, this.log, span).then(
              (r) => {
                // Per-item: an internally-handled failure (set aside / not-yet-exhausted) carries its
                // message onto the error span (robustness batch — a failed source is diagnosable).
                span.end(spanOutcome(r.ok, r.setAside), r.error);
              },
              (err) => {
                // Systemic (wedged writer): end the span WITH the message, then propagate to back off.
                span.end('error', err instanceof Error ? err.message : String(err));
                throw err;
              },
            );
          }),
        );
        queue = await this.queueCache.read(this.root, () => readDecomposeQueue(this.root, this.maxAttempts));
      }
      return true;
    } catch (err) {
      // SYSTEMIC failure (the queue read, or a wedged canonical writer — affects EVERY item, not one):
      // surface it + return false so runDrains' #256 circuit-breaker backs the stage off (ORCH-26). A
      // per-item ENOENT is handled by decomposeOne (it RETURNS), so it never reaches here / trips the breaker.
      this.log.error('decompose.drain-error', { err });
      return false;
    }
  }
}
