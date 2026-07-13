// The orchestration engine (SPEC-0014 ORCH). A DETERMINISTIC loop that drains the inbox
// queue one item at a time, each archived in an isolated git worktree so the canonical
// vault tree only ever advances by clean, committed work (ORCH-2/3). Per item:
//   sync worktree → decide → move into sources/ + write source.md → commit → ff-advance.
// "Orchestration is deterministic; cognition is disposable" — the per-item decision comes
// from an injected `ArchivistDecider` (v1 = deterministic; Phase B = a Copilot session).
//
// v1 note: the loop runs in-process (serialized by a mutex) rather than a spawned OS
// process; "headless when the window is closed" holds because the main process stays
// alive. The worktree lives under the gitignored `.kb/cache/` (rebuildable) so no
// `.gitignore` churn is needed.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { dateShard } from './ulid';
import { deterministicDecider, type ArchivistDecider } from './archivist';
import { renderSourceMd, bodyFor } from './sourceDoc';
import { readSensitivityOverrides } from './sensitivityOverride';
import { applyClassification, classifierInputFrom, type SensitivityClassifier } from './sensitivityClassifier';
import { extractMediaText, isExtractableMedia, resolveMediaMimeType, type MediaExtractOptions } from './mediaExtract';
import { captureToInbox, readCapturedMeta, normalizeInbox, type CapturePayload, type CaptureOutcome } from './ingest';
import { Mutex } from './stageLock';
import { withConcurrentAdvance, DEFAULT_STAGE_CAP, type PrepareContext } from './canonicalAdvance';
import { noopDevLog, type DevLog } from './devlog';
import { noopTracer, noopActiveSpan, STAGE_RUN_OP, type Tracer, type ActiveSpan } from './tracing';

const STATUS_REL = path.join('.kb', 'cache', 'status.json');

export interface PipelineStatusData {
  queueDepth: number;
  processing: string | null;
  lastArchived: string | null;
  updatedAt: string | null;
}

/** The inbox queue: sorted ULID directories (ULIDs sort by capture time). ORCH-4. */
export async function readQueue(root: string): Promise<string[]> {
  const inbox = path.join(path.resolve(root), 'inbox');
  let entries: string[];
  try {
    entries = await fs.readdir(inbox);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const e of entries) {
    try {
      if ((await fs.stat(path.join(inbox, e))).isDirectory()) dirs.push(e);
    } catch {
      /* vanished mid-scan — skip */
    }
  }
  return dirs.sort();
}

/**
 * Archive one inbox unit, returning its new `sources/` path, under optimistic concurrency
 * (SPEC-0014 ORCH-17/18). The move + source.md + audit write happen OFF the lock, synced to a
 * canonical checkpoint; only the ff-advance runs under `lock`. Archive items write disjoint
 * `sources/<id>` paths (unique ULID, ORCH-6) and the archivist is the sole writer of `sources/`
 * on `staging`, so the advance is always a fast-forward or a clean disjoint replay — a collision
 * is not expected, and an (impossible) exhaustion throws so the drain leaves the unit in the inbox
 * (never half-applied, ORCH-12). `lock` defaults to a private mutex so standalone calls serialize.
 */
export async function archiveOne(
  root: string,
  id: string,
  decider: ArchivistDecider = deterministicDecider,
  lock: Mutex = new Mutex(),
  span: ActiveSpan = noopActiveSpan,
  classify?: SensitivityClassifier,
  mediaExtract?: MediaExtractOptions,
): Promise<string> {
  root = path.resolve(root);
  const destRel = path.join('sources', dateShard(id), id);

  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt); // the ephemeral per-item worktree, fresh off the checkpoint

    const unitDir = path.join(wt, 'inbox', id);
    const meta = await readCapturedMeta(unitDir);
    const baseDecision = await decider(meta, { span });
    // The source body, read once at the ingest boundary (before the rename) — used both for the classifier
    // (SENSE-4, content in hand) and as the rendered source.md body, so we never read the bytes twice.
    let textContent = meta.kind === 'text' ? await fs.readFile(path.join(unitDir, meta.raw), 'utf8') : null;
    // SPEC-0052 MEDIA: a non-text (file) media source — PDF / image — gets a TEXT body extracted via the
    // Copilot multimodal path, woven into `textContent` HERE (before the rename, before the classifier) so
    // (a) the source is no longer a dead `![[raw.pdf]]` embed and flows decompose/claims, and (b) SENSE
    // classifies it on real content for free. FAIL-LOUD but non-blocking: any failure leaves `textContent`
    // null (→ embed-only body; the original binary is still preserved, MEDIA-4) and is recorded on the
    // source's audit (surfaced, never silent, MEDIA-5/6/7), never crashing the archive (binary not lost).
    let mediaOutcome: { ok: boolean; reason?: string; error?: string; chars?: number } | undefined;
    if (textContent === null && mediaExtract && meta.kind === 'file' && isExtractableMedia(meta.mimeType, meta.raw)) {
      const mime = resolveMediaMimeType(meta.mimeType, meta.raw)!; // defined: isExtractableMedia was true
      const data = new Uint8Array(await fs.readFile(path.join(unitDir, meta.raw)));
      const res = await extractMediaText(data, mime, meta.originalName ?? meta.raw, mediaExtract);
      if (res.ok) {
        textContent = res.text.length > 0 ? res.text : null; // empty transcription → keep embed-only (honest)
        mediaOutcome = { ok: true, chars: res.text.length };
      } else if ('reason' in res) {
        // non-strict tsconfig: narrow the failure variant via the in-operator, not `!res.ok`.
        mediaOutcome = { ok: false, reason: res.reason, error: res.error };
      }
    }
    // SENSE-4 Slice 2: classify sensitivity at the ingest boundary, but ONLY when no higher-priority signal
    // (connector default / pending Principal override) already set the label — `applyClassification` enforces
    // that. A confident `shareable` verdict re-opens public-web research egress (SENSE-9); a sub-threshold
    // lean records a `suggested` label for Review. Best-effort: a classifier throw must not fail the archive.
    let classifiedDecision = baseDecision;
    if (classify && baseDecision.sensitivityBy === 'default') {
      try {
        const verdict = await classify(classifierInputFrom(meta, textContent ?? ''));
        const applied = applyClassification({ sensitivity: baseDecision.sensitivity, sensitivityBy: baseDecision.sensitivityBy }, verdict);
        classifiedDecision = {
          ...baseDecision,
          sensitivity: applied.sensitivity,
          sensitivityBy: applied.sensitivityBy,
          ...(applied.confidence !== undefined ? { sensitivityConfidence: applied.confidence } : {}),
          ...(applied.suggested !== undefined ? { sensitivitySuggested: applied.suggested } : {}),
        };
      } catch {
        classifiedDecision = baseDecision; // classification is best-effort; never block the archive
      }
    }
    // SENSE-7: a Principal override wins over whatever the classifier/default decided, and re-applies on
    // EVERY archive (incl. Replay) — read from the worktree snapshot so a rebuild stays sticky and the
    // classifier never overwrites a `by: principal` label. An override also CLEARS any classifier confidence/
    // suggestion (SPEC-0043 §7). Absent an override, the classified decision stands.
    const override = (await readSensitivityOverrides(wt))[id];
    const decision = override
      ? { ...classifiedDecision, sensitivity: override.label, sensitivityBy: 'principal' as const, sensitivityAt: override.at || undefined, sensitivityConfidence: undefined, sensitivitySuggested: undefined }
      : classifiedDecision;

    const dest = path.join(wt, destRel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(unitDir, dest); // move the raw bytes verbatim — never rewritten (DATA-2)

    const archivedAt = new Date().toISOString();
    await fs.writeFile(path.join(dest, 'source.md'), renderSourceMd(meta, decision, archivedAt, bodyFor(meta, textContent)), 'utf8');
    // ORCH-16: record the agent invocation (runtime/model/params/outcome) for posterity.
    const { agent, ...coreDecision } = decision;
    await fs.appendFile(
      path.join(dest, 'audit.jsonl'),
      JSON.stringify({ action: 'archived', id, archivedAt, decision: coreDecision, agent: agent ?? { via: 'deterministic' }, ...(mediaOutcome ? { media: mediaOutcome } : {}) }) + '\n',
      'utf8',
    );

    await wtGit.raw('add', '-A');
    await wtGit.commit(`archive: ${id}`);
    return true;
  };

  const onExhausted = async (): Promise<void> => {
    // Unreachable in practice (disjoint sources/ paths, sole writer) — if it ever happens, fail so
    // the drain leaves the unit in the inbox for a later sweep rather than half-applying (ORCH-12).
    throw new Error(`archive: ${id} exhausted optimistic-advance retries (unexpected same-path collision)`);
  };

  // #508 item 2: archiveOne's ENTIRE read+write footprint is knowable before the worktree exists — the
  // one inbox unit being archived, its fixed destination (a pure function of `id`), and the fixed
  // sensitivity-overrides file. Sparse-checkout to just those instead of materializing the whole
  // checkpoint tree (on a large vault, thousands of unrelated `sources/`/`entities/`/`claims/` files).
  const sparsePaths = [path.join('inbox', id), destRel, path.join('.kb', 'sensitivity')];
  await withConcurrentAdvance({ root, lock, stage: 'archive', sparsePaths }, prepare, onExhausted);
  return destRel;
}

async function writeStatus(root: string, status: PipelineStatusData): Promise<void> {
  const file = path.join(path.resolve(root), STATUS_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(status, null, 2) + '\n', 'utf8');
}

/** Live status for the UI: queue depth from the filesystem, the rest from `status.json`. */
export async function readStatus(root: string): Promise<PipelineStatusData> {
  const queueDepth = (await readQueue(root)).length;
  let saved: Partial<PipelineStatusData> = {};
  try {
    saved = JSON.parse(await fs.readFile(path.join(path.resolve(root), STATUS_REL), 'utf8')) as Partial<PipelineStatusData>;
  } catch {
    /* no status yet */
  }
  return {
    queueDepth,
    processing: saved.processing ?? null,
    lastArchived: saved.lastArchived ?? null,
    updatedAt: saved.updatedAt ?? null,
  };
}

/**
 * Owns one vault's pipeline: capture (under the lock) + a poke/sweep drain loop. Capture
 * and archiving share the mutex, so the canonical repo is never written by two paths at
 * once. Restartable: a new instance re-reads the inbox and resumes (ORCH-13).
 */
export class Orchestrator {
  private readonly root: string;
  private readonly decider: ArchivistDecider;
  private readonly lock: Mutex;
  private readonly afterDrain?: () => Promise<void>;
  private cap: number; // mutable for SPEC-0048 SCALE-4 live-apply (see setCap)
  private readonly log: DevLog;
  private readonly tracer: Tracer;
  private readonly classify?: SensitivityClassifier;
  private readonly mediaExtract?: MediaExtractOptions;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;
  private lastArchived: string | null = null;

  /**
   * @param lock the shared per-vault canonical-writer lock (SPEC-0014 §5). Pass the SAME
   *   instance to every stage of a vault so their canonical-ref advances serialize. Defaults
   *   to a private lock for standalone use (e.g. tests with only the archivist).
   * @param afterDrain optional hook run (serialized under the lock) after a drain settles —
   *   used by the staging pipeline to promote freshly-archived sources to `main` (SPEC-0021).
   */
  constructor(
    root: string,
    decider: ArchivistDecider = deterministicDecider,
    lock: Mutex = new Mutex(),
    afterDrain?: () => Promise<void>,
    cap: number = DEFAULT_STAGE_CAP,
    log: DevLog = noopDevLog,
    tracer: Tracer = noopTracer,
    classify?: SensitivityClassifier,
    mediaExtract?: MediaExtractOptions,
  ) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.afterDrain = afterDrain;
    this.cap = Math.max(1, Math.floor(cap));
    this.log = log.child({ scope: 'archive' });
    this.tracer = tracer;
    this.classify = classify; // SENSE-4 Slice 2: optional ingest-boundary sensitivity classifier
    this.mediaExtract = mediaExtract; // SPEC-0052 MEDIA: optional PDF/image text extraction at archive
  }

  /** Live-set the per-stage concurrency cap (SPEC-0048 SCALE-4): the new value is read on the NEXT
   *  batch (`drainOnce` slices `this.cap` per pass), so a Settings change applies without a restart. */
  setCap(cap: number): void {
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** The current per-stage concurrency cap (for Status display / SPEC-0048 Settings). */
  getCap(): number {
    return this.cap;
  }

  /** Initial drain + a periodic safety-net sweep (ORCH-15: poke + sweep). */
  start(sweepMs = 30_000): void {
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

  /** Fire-and-forget capture (CAPTURE-2): preserve+commit under the lock, then poke. */
  async capture(surface: string, payloads: CapturePayload[]): Promise<CaptureOutcome> {
    const res = await this.lock.run(() => captureToInbox(this.root, surface, payloads), 'capture');
    void this.poke();
    return res;
  }

  /** Is the archivist actively draining right now? (OBS-5 per-stage `running` state.) */
  busy(): boolean {
    return this.draining;
  }

  status(): Promise<PipelineStatusData> {
    return readStatus(this.root);
  }

  /**
   * Drain the queue. Coalesces concurrent pokes: a poke during an active drain re-runs the
   * loop, and the returned promise resolves only once the pipeline is fully idle — so
   * callers (and tests) can deterministically await all pending work.
   */
  poke(): Promise<void> {
    this.pending = true;
    if (!this.draining) {
      this.draining = true;
      this.current = this.runDrains();
    }
    return this.current ?? Promise.resolve();
  }

  private async runDrains(): Promise<void> {
    try {
      while (this.pending) {
        this.pending = false;
        await this.drainOnce();
      }
    } catch (err) {
      // A SYSTEMIC drain failure (e.g. the inbox normalize / queue read is wedged) must NOT escape as an
      // unhandledRejection through a fire-and-forget `void poke()` (SPEC-0030 robustness). Surface it
      // loudly; a later poke/sweep retries. Per-item failures are isolated in drainOnce and never reach here.
      this.log.error('archive.drain-fatal', { err });
    } finally {
      this.draining = false;
      this.current = null;
    }
  }

  private async drainOnce(): Promise<void> {
    // #506: an idle sweep took the canonical lock for `normalize` even with a totally empty inbox. A
    // cheap unlocked readdir first: nothing on disk (no canonical units, no foreign drops) means
    // normalize has nothing to adopt, so skip that lock.run + the (then-guaranteed-empty) queue read.
    // afterDrain below is INTENTIONALLY still unconditional — it is the STAGING-8/9 promotion backstop
    // (a restart's missed-promotion recovery runs with an empty inbox, e.g. stagingCrashRestart.test.ts
    // 'orchestrator restart after a crashed promotion recovers main and does NOT re-archive') and has
    // nothing to do with inbox contents; skipping it here would silently break that recovery path.
    let precheck: string[];
    try {
      precheck = await fs.readdir(path.join(path.resolve(this.root), 'inbox'));
    } catch {
      precheck = [];
    }
    let queue: string[];
    if (precheck.length === 0) {
      queue = [];
      await this.updateStatus(0, null);
    } else {
      // ORCH-14: adopt any foreign drops into canonical units before draining.
      await this.lock.run(() => normalizeInbox(this.root), 'normalize');
      queue = await readQueue(this.root);
      await this.updateStatus(queue.length, null);
    }
    while (queue.length > 0) {
      // ORCH-17/18/20: archive up to `cap` items concurrently — each prepares OFF the lock in its own
      // ephemeral worktree, advances UNDER the shared lock (cap=1 ⇒ serial). A failing item throws and
      // stays in the inbox (ORCH-12); the batch's other items still land, and a later sweep retries.
      const batch = queue.slice(0, this.cap);
      await this.updateStatus(queue.length, batch[0]);
      try {
        // OBS-12: each item gets a `stage.run` span (wraps the archivist's copilot child once Phase B
        // lands; v1's deterministic decider emits no child, so this just times the archive op).
        await Promise.all(
          batch.map((id) => {
            const span = this.tracer.start(STAGE_RUN_OP, { stage: 'archive', itemId: id });
            return archiveOne(this.root, id, this.decider, this.lock, span, this.classify, this.mediaExtract).then(
              () => {
                span.end('ok');
                this.lastArchived = id;
              },
              (err) => {
                // Surface the cause on the span (robustness batch), then propagate to stop this pass.
                span.end('error', err instanceof Error ? err.message : String(err));
                throw err;
              },
            );
          }),
        );
      } catch (err) {
        // OBS-4: archive failed — the item stays in the inbox (ORCH-12). Surface the cause so this is
        // never a silent "N in queue, nothing happened" stall (the bug that motivated SPEC-0030).
        this.log.error('archive.drain-error', { itemId: batch[0], err });
        await this.updateStatus(queue.length, null);
        return;
      }
      queue = await readQueue(this.root);
    }
    await this.updateStatus(0, null);
    // SPEC-0021: publish freshly-archived evergreen sources from `staging` to `main`,
    // serialized under the shared lock so it never races a stage's ref advance.
    if (this.afterDrain) await this.lock.run(() => this.afterDrain!(), 'archive:afterDrain');
  }

  private async updateStatus(queueDepth: number, processing: string | null): Promise<void> {
    await writeStatus(this.root, {
      queueDepth,
      processing,
      lastArchived: this.lastArchived,
      updatedAt: new Date().toISOString(),
    });
  }
}
