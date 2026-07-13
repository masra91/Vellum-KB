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

// ── Archive poison quarantine (#516 BUG-3) ─────────────────────────────────────────────────────
//
// archiveOne previously had no try/catch at all: any throw (a torn audit.jsonl, an unreadable/
// oversized file, a decider throw, …) propagated straight out of the batch, and the poison unit
// stayed in the inbox forever — every poke/sweep re-hit the SAME failure, and at cap=1 this wedged
// archiving (and therefore the whole pipeline) permanently. Mirrors claims'/connect's own
// audit-log-derived set-aside convention exactly (no directory move — the unit stays in place; an
// append-only marker on its OWN `audit.jsonl` is what stops it being redrained), rather than
// inventing a new quarantine mechanism.

/** Default attempts before a poison inbox unit is set aside (#516 BUG-3). Each stage owns its own
 *  constant (mirrors claims'/connect's independent `DEFAULT_MAX_ATTEMPTS`), not a shared import. */
export const DEFAULT_ARCHIVE_MAX_ATTEMPTS = 3;

type ArchiveTerminalReason = 'archive-setaside' | 'archive-dismissed';
const ARCHIVE_TERMINAL_ACTIONS: ReadonlySet<string> = new Set<ArchiveTerminalReason>(['archive-setaside', 'archive-dismissed']);

export interface ArchiveUnitState {
  /** Left the queue for good: set aside (poison, recoverable) or dismissed (user-retired). */
  terminal: boolean;
  terminalReason?: ArchiveTerminalReason;
  /** Failed attempts recorded on this unit's own audit trail (#516 BUG-3). */
  failures: number;
}

interface ArchiveAuditLine {
  action?: string;
}

/** Read one inbox unit's archive-attempt state from its own append-only `audit.jsonl` (#516 BUG-3) —
 *  the SAME reducer both the drain queue ({@link readQueue}) and the Status-view recovery surface
 *  (OBS-17) read through, mirroring claims'/connect's `readClaimsState`/equivalent. A unit with no
 *  (or an unreadable) audit.jsonl is simply not-yet-attempted — never a hard error here. */
export async function readArchiveUnitState(unitDir: string): Promise<ArchiveUnitState> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(unitDir, 'audit.jsonl'), 'utf8');
  } catch {
    return { terminal: false, failures: 0 };
  }
  let terminal = false;
  let terminalReason: ArchiveTerminalReason | undefined;
  let failures = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let obj: ArchiveAuditLine;
    try {
      obj = JSON.parse(line) as ArchiveAuditLine;
    } catch {
      continue; // a torn/corrupt line is skipped, not fatal — the reducer stays best-effort
    }
    if (obj.action === 'archive-reopened') {
      // OBS-17 retry (#516): supersedes ALL prior failure/terminal state for this unit — it re-enters
      // the queue fresh, mirroring claims'/connect's `reopened` marker semantics.
      terminal = false;
      terminalReason = undefined;
      failures = 0;
    } else if (obj.action && ARCHIVE_TERMINAL_ACTIONS.has(obj.action)) {
      terminal = true;
      terminalReason = obj.action as ArchiveTerminalReason;
    } else if (obj.action === 'archive-failed') {
      failures += 1;
    }
  }
  return { terminal, terminalReason, failures };
}

/** The inbox queue: sorted ULID directories (ULIDs sort by capture time, ORCH-4), EXCLUDING any unit
 *  set aside or dismissed (#516 BUG-3) — mirrors claims'/connect's queue functions, which filter
 *  terminal items the same way, so the drain loop and the Status "N in queue" readout always agree. */
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
    if (e.startsWith('.')) continue; // hidden/system entries are never a queue item
    try {
      if ((await fs.stat(path.join(inbox, e))).isDirectory()) dirs.push(e);
    } catch {
      /* vanished mid-scan — skip */
    }
  }
  dirs.sort();
  const out: string[] = [];
  for (const id of dirs) {
    if (!(await readArchiveUnitState(path.join(inbox, id))).terminal) out.push(id);
  }
  return out;
}

/** Every set-aside (poison, recoverable) inbox unit (#516 / OBS-17) — the Status-view recovery
 *  surface reads this the same way claims'/connect's `listSetAsideItems` work. Best-effort display
 *  metadata: a unit whose OWN meta is unreadable (the very failure that set it aside, e.g. a torn
 *  `audit.jsonl`) still lists with its id as the label — never dropped from the list. */
export interface ArchiveSetAsideItem {
  id: string;
  name: string;
  failures: number;
}

export async function listArchiveSetAsideItems(root: string): Promise<ArchiveSetAsideItem[]> {
  root = path.resolve(root);
  const inbox = path.join(root, 'inbox');
  let entries: string[];
  try {
    entries = await fs.readdir(inbox);
  } catch {
    return [];
  }
  const out: ArchiveSetAsideItem[] = [];
  for (const id of entries.filter((e) => !e.startsWith('.')).sort()) {
    const unitDir = path.join(inbox, id);
    try {
      if (!(await fs.stat(unitDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const state = await readArchiveUnitState(unitDir);
    if (!state.terminal || state.terminalReason !== 'archive-setaside') continue;
    let name = id;
    try {
      const meta = await readCapturedMeta(unitDir);
      name = meta.originalName ?? (meta.kind === 'text' ? 'note' : meta.raw);
    } catch {
      /* meta unreadable — the id is still a usable label */
    }
    out.push({ id, name, failures: state.failures });
  }
  return out;
}

/** Append a durable marker to a unit's own `audit.jsonl` under the same optimistic-concurrency
 *  ceremony {@link archiveOne} uses, so retry/dismiss are real, git-committed vault state changes
 *  (#516 / OBS-17) — never a silent local-only side effect. A unit that's vanished (already archived
 *  by a race, or never existed) is a clean no-op. */
async function markArchiveUnit(root: string, id: string, lock: Mutex, action: 'archive-reopened' | 'archive-dismissed', commitVerb: string): Promise<void> {
  root = path.resolve(root);
  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    const unitDir = path.join(wt, 'inbox', id);
    try {
      await fs.access(unitDir);
    } catch {
      return false; // gone — nothing to mark
    }
    await fs.appendFile(path.join(unitDir, 'audit.jsonl'), JSON.stringify({ action, id, at: new Date().toISOString() }) + '\n', 'utf8');
    const wtGit = simpleGit(wt);
    await wtGit.raw('add', '-A');
    await wtGit.commit(`archive: ${commitVerb} ${id}`);
    return true;
  };
  const onExhausted = async (): Promise<void> => {
    throw new Error(`archive: ${commitVerb} ${id} exhausted optimistic-advance retries (unexpected same-path collision)`);
  };
  await withConcurrentAdvance({ root, lock, stage: 'archive' }, prepare, onExhausted);
}

/** Retry a set-aside inbox unit (#516 / OBS-17): the NEXT drain re-attempts it fresh. */
export function retryArchiveItem(root: string, id: string, lock: Mutex = new Mutex()): Promise<void> {
  return markArchiveUnit(root, id, lock, 'archive-reopened', 'reopened');
}

/** Permanently retire a set-aside inbox unit (#516 / OBS-17). The unit itself is never destroyed
 *  (DATA-2) — only marked; it just leaves the queue for good. */
export function dismissArchiveItem(root: string, id: string, lock: Mutex = new Mutex()): Promise<void> {
  return markArchiveUnit(root, id, lock, 'archive-dismissed', 'dismissed');
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
  maxAttempts: number = DEFAULT_ARCHIVE_MAX_ATTEMPTS,
): Promise<string> {
  root = path.resolve(root);
  const destRel = path.join('sources', dateShard(id), id);
  // #516 BUG-3: set when the catch branch below recorded a failure (whether or not it crossed the
  // set-aside threshold) — read AFTER withConcurrentAdvance resolves to decide whether to still throw
  // (preserving archiveOne's existing throw-on-failure contract for its one caller, drainOnce) even
  // though the underlying advance itself succeeded (it committed a failure-recording marker, not a
  // no-op — see the catch branch). A boxed object (not a bare `let`) so reading it after the closure
  // runs isn't subject to TS's closure narrowing.
  const failureBox: { current: { attempt: number; setAside: boolean } | null } = { current: null };

  const prepare = async ({ wt, base }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt); // the ephemeral per-item worktree, fresh off the checkpoint
    const unitDir = path.join(wt, 'inbox', id);
    try {
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
    } catch (err) {
      // #516 BUG-3: never let a poison unit (a torn/missing audit.jsonl, an unreadable or oversized raw
      // file, a decider throw, …) wedge the WHOLE archive drain forever. Discard any partial worktree
      // writes (mirrors claims' CLAIMS-12 reset-then-record pattern), then durably record the failed
      // attempt on the unit's OWN audit.jsonl — and set it aside after `maxAttempts` — so a later
      // poke/sweep (readQueue) naturally stops redraining it instead of retrying it every 30s forever
      // (the "ingestion halts entirely" failure mode this bug produced at cap=1).
      await wtGit.raw('reset', '--hard', base);
      const error = err instanceof Error ? err.message : String(err);
      const priorFailures = (await readArchiveUnitState(unitDir)).failures;
      const attempt = priorFailures + 1;
      const setAside = attempt >= maxAttempts;
      failureBox.current = { attempt, setAside };
      const at = new Date().toISOString();
      let audit = JSON.stringify({ action: 'archive-failed', id, attempt, error, at }) + '\n';
      if (setAside) audit += JSON.stringify({ action: 'archive-setaside', id, attempts: attempt, at }) + '\n';
      // The unit dir may not exist at all yet if the failure happened before any write (e.g. a
      // missing/torn audit.jsonl on readCapturedMeta) — mkdir-safe, mirrors claims' BUG #135 fix so the
      // durable failure record always lands instead of the unit retrying forever.
      await fs.mkdir(unitDir, { recursive: true });
      await fs.appendFile(path.join(unitDir, 'audit.jsonl'), audit, 'utf8');
      await wtGit.raw('add', '-A');
      await wtGit.commit(`archive: failed ${id} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
      return true; // the FAILURE-RECORDING advance itself succeeds — the drain is never wedged by it
    }
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
  // #516 BUG-3's failure-recording branch writes into the SAME `inbox/<id>` path already covered here.
  const sparsePaths = [path.join('inbox', id), destRel, path.join('.kb', 'sensitivity')];
  await withConcurrentAdvance({ root, lock, stage: 'archive', sparsePaths }, prepare, onExhausted);
  const outcome = failureBox.current;
  if (outcome) {
    throw new Error(`archive: ${id} ${outcome.setAside ? `set aside after ${outcome.attempt} failed attempt(s)` : `failed (attempt ${outcome.attempt})`}`);
  }
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

  /** Fire-and-forget capture (CAPTURE-2): preserve+commit under the lock, then poke. #507 item 4:
   *  priority — a capture must never queue behind a long bulk/sweep pass (Connect's link/orphan/dedup
   *  tail, PERF-E3); it only needs to wait for whatever section is ALREADY running, never for every
   *  background section already queued ahead of it. */
  async capture(surface: string, payloads: CapturePayload[]): Promise<CaptureOutcome> {
    const res = await this.lock.run(() => captureToInbox(this.root, surface, payloads), 'capture', { priority: true });
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
      // ephemeral worktree, advances UNDER the shared lock (cap=1 ⇒ serial).
      //
      // #516 BUG-7: this used to be a plain `Promise.all` — ONE item's rejection aborted the whole
      // batch while its siblings kept running UNAWAITED (a leaked promise per sibling: re-dispatch
      // races on the next pass, duplicate copilot spend, add/add cherry-pick conflicts, `busy()`
      // under-reporting once the leaked promise finally settled outside this function's view).
      // `Promise.allSettled` awaits every sibling to completion before this pass considers itself
      // done, and a failure is isolated to just that one item — never a batch-wide abort, exactly one
      // attempt per id this pass. A failed-but-not-yet-set-aside item stays in the inbox (ORCH-12) and
      // `readQueue` naturally re-offers it on the next iteration/sweep; #516 BUG-3's per-item
      // attempt-counter (in archiveOne) is what eventually excludes a truly poison one.
      const batch = queue.slice(0, this.cap);
      await this.updateStatus(queue.length, batch[0]);
      // OBS-12: each item gets a `stage.run` span (wraps the archivist's copilot child once Phase B
      // lands; v1's deterministic decider emits no child, so this just times the archive op).
      const results = await Promise.allSettled(
        batch.map((id) => {
          const span = this.tracer.start(STAGE_RUN_OP, { stage: 'archive', itemId: id });
          return archiveOne(this.root, id, this.decider, this.lock, span, this.classify, this.mediaExtract).then(
            () => {
              span.end('ok');
              this.lastArchived = id;
            },
            (err) => {
              // Surface the cause on the span (robustness batch); rethrow so allSettled records THIS
              // item as rejected without affecting any sibling's own promise.
              span.end('error', err instanceof Error ? err.message : String(err));
              throw err;
            },
          );
        }),
      );
      // OBS-4: a failed item is never a silent "N in queue, nothing happened" stall (the bug that
      // motivated SPEC-0030) — log each rejection with its own id, not just the batch's first item.
      const failedThisPass = new Set<string>();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'rejected') {
          failedThisPass.add(batch[i]);
          this.log.error('archive.item-failed', { itemId: batch[i], err: r.reason });
        }
      }
      // #516 BUG-3: an item that just failed (but isn't yet set aside) stays in the inbox and WILL be
      // retried — but on the NEXT poke/sweep, not immediately again within this SAME pass. Without this
      // exclusion the while-loop would re-offer the same still-queued failing id every iteration and
      // burn through `maxAttempts` in one poke() instead of across separate drain passes (ORCH-12: a
      // single failing decider must still leave the item queued, not silently escalate to set-aside).
      queue = (await readQueue(this.root)).filter((id) => !failedThisPass.has(id));
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
