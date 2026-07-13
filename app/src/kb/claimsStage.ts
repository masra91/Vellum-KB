// The Claims stage runtime (SPEC-0016) — the THIRD user of the SPEC-0014 harness: the SAME
// deterministic pattern as the archivist + Decompose (worktree isolation, fresh disposable
// session per item, orchestrator-owns-effects, ff-advance under the shared canonical-writer
// lock), pointed at a different work-list + instruction file (ORCH-9 / CLAIMS-2).
//
// Work unit = an ENTITY (CLAIMS-5). For each entity we feed the agent the node + the WHOLE
// source it derives from, and record the claims the source makes ABOUT it.
//
// Queue model (v1): like Decompose, the durable work list is DERIVED, not a `queue/` folder
// (SPEC-0016 §3 note). An entity is "queued for claims" iff its source's append-only
// `audit.jsonl` has no terminal `claims` marker for that entityId yet. Committing the claim
// files + the regenerated entity block + the `claimed` marker in ONE commit IS the
// commit-to-dequeue (CLAIMS-16): the next sweep skips it. Idempotent restart for free
// (ORCH-13). A failed attempt appends a `failed` event (durable count); after K it appends a
// terminal `setaside` marker so a poison entity never head-of-line-blocks (CLAIMS-12/ORCH-12).
//
// Sources are NEVER mutated (CLAIMS-11): we only append to the source's append-only
// `audit.jsonl` (where Decompose already writes) and write NEW files under `claims/`. The one
// entity-node write is the regenerated, delimited claims block — never the identity (CLAIMS-9/11).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import { ulid, dateShard } from './ulid';
import { readCapturedMeta } from './ingest';
import { renderClaimMd, applyClaimsBlock, oneLine, CLAIMS_BLOCK_START, CLAIMS_BLOCK_END, type ClaimBacklink } from './claimDoc';
import { blockKey } from './connect';
import { readCorrectionDirectives, readRevokeDirectives, isClaimSuppressedActive } from './directives';
import type { ClaimStatus } from './claims';
import { makeClaimsDecider, type ClaimsDecider, type EntityInput, type AnsweredReview } from './claimsAgent';
import type { SourceInput } from './decomposeAgent';
import { reviewRel, writeReviewFile } from './reviewStore';
import type { Review } from './reviews';
import { Mutex } from './stageLock';
import { epochScopedLines } from './replayEpoch';
import { withConcurrentAdvance, withEphemeralWorktree, advanceOrCollide, canonicalHead, DEFAULT_STAGE_CAP, type PrepareContext } from './canonicalAdvance';
import { CanonicalQueueCache } from './queueCache';
import { noopDevLog, type DevLog } from './devlog';
import { noopTracer, noopActiveSpan, STAGE_RUN_OP, type Tracer, type ActiveSpan } from './tracing';
import { walkVaultFiles } from './vaultWalk';

const STAGE = 'claims';
/** Default attempts before a poison entity is set aside (CLAIMS-12). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default review rounds (parks) on one entity before it is set aside (REVIEW-8 cascade cap). */
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

/** A terminal marker means the entity has left the derived queue: `claimed` (success), `setaside`
 *  (poison, recoverable — CLAIMS-12), or `dismissed` (user-retired, CLAIMS-20). */
const TERMINAL_EVENTS = new Set(['claimed', 'setaside', 'dismissed']);

/** One parsed line of a source's audit.jsonl that this stage cares about (keyed by entityId). */
interface AuditLine {
  stage?: string;
  event?: string;
  entityId?: string;
  reviewId?: string;
  reviewIds?: string[];
  question?: string;
  verdict?: string;
  note?: string | null;
}

/** One review the Principal has answered for an entity (fed back on a resumed run; REVIEW-6). */
export interface AnsweredReviewState {
  reviewId: string;
  question: string;
  verdict: string;
  note?: string | null;
}

/** Which terminal marker an entity reached (CLAIMS-20): `setaside` is recoverable, `dismissed` is
 *  user-retired, `claimed` succeeded. Undefined when the entity is not terminal. */
export type ClaimsTerminalReason = 'claimed' | 'setaside' | 'dismissed';

export interface ClaimsState {
  terminal: boolean; // claimed / set aside / dismissed — leaves the queue for good
  terminalReason?: ClaimsTerminalReason; // which terminal marker (CLAIMS-20); undefined if not terminal
  failures: number; // failed attempts (CLAIMS-12)
  parked: boolean; // an open `awaiting-review` whose reviews aren't all answered (REVIEW-5)
  rounds: number; // number of review parks so far (REVIEW-8 cascade cap)
  answered: AnsweredReviewState[]; // answered reviews, to feed a resumed re-run (REVIEW-6)
}

/**
 * Read one entity's claims audit state from its SOURCE's append-only audit.jsonl. Exported so the
 * Status-view recovery surface (SPEC-0030 OBS-17) can read terminal/recoverable state through the
 * same reducer the queue uses — no parallel marker logic in the UI (CLAIMS-20).
 */
export async function readClaimsState(sourceDir: string, entityId: string): Promise<ClaimsState> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
  } catch {
    return { terminal: false, failures: 0, parked: false, rounds: 0, answered: [] };
  }
  let terminal = false;
  let terminalReason: ClaimsTerminalReason | undefined;
  let failures = 0;
  let rounds = 0;
  let parkRounds: string[][] = []; // reviewIds raised per `awaiting-review` round
  let answeredIds = new Set<string>();
  let answered: AnsweredReviewState[] = [];
  // Scope to the current replay epoch (REPLAY-6): a replayed source's prior `claimed`/park
  // markers are ignored so its (freshly re-derived) entities re-enter the claims queue.
  for (const line of epochScopedLines(raw)) {
    if (line.trim().length === 0) continue;
    let obj: AuditLine;
    try {
      obj = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (obj.stage !== STAGE || obj.entityId !== entityId) continue;
    if (obj.event === 'reopened') {
      // CLAIMS-20 (user retry, OBS-17): a per-entity `reopened` marker supersedes ALL prior claims
      // state for THIS entity (terminal/failures/park) so it re-enters the queue and re-derives.
      // Per-entity by construction — siblings of the same source (their own audit lines) are untouched.
      terminal = false;
      terminalReason = undefined;
      failures = 0;
      rounds = 0;
      parkRounds = [];
      answeredIds = new Set<string>();
      answered = [];
    } else if (obj.event && TERMINAL_EVENTS.has(obj.event)) {
      terminal = true;
      terminalReason = obj.event as ClaimsTerminalReason;
    } else if (obj.event === 'failed') failures += 1;
    else if (obj.event === 'awaiting-review') {
      rounds += 1;
      parkRounds.push(obj.reviewIds ?? []);
    } else if (obj.event === 'review-answered' && obj.reviewId) {
      answeredIds.add(obj.reviewId);
      answered.push({ reviewId: obj.reviewId, question: obj.question ?? '', verdict: obj.verdict ?? '', note: obj.note ?? null });
    }
  }
  // Parked iff any park round still has an unanswered review (REVIEW-5/6).
  const parked = !terminal && parkRounds.some((ids) => ids.some((id) => !answeredIds.has(id)));
  return { terminal, terminalReason, failures, parked, rounds, answered };
}

/** Recursively find every entity node file (`entities/.../<ULID>.md`), repo-relative.
 *  SPEC-0061 T1 / ENG-9 (#539): delegates to the shared `walkVaultFiles` (see recallTools.ts's swap
 *  for the symlink-safety + deterministic-order notes, which apply identically here). */
export async function findEntityFiles(root: string): Promise<string[]> {
  return walkVaultFiles(path.resolve(root), 'entities', { keep: (n) => n.endsWith('.md') });
}

interface EntityRef {
  kind: string;
  name: string;
  // ALL the sources the entity derives from (provenance; CLAIMS-5). Post-Connect a merged entity
  // spans MANY sources (CLAIMS-21) — Claims processes it per (entity × source), so every source's
  // facts are captured. Decompose's pre-merge nodes have exactly one. Never empty (parse throws).
  sources: string[];
}

function parseScalarValue(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t;
    }
  }
  return t;
}

/** Extract `kind`, `name`, and ALL of `provenance.derivedFrom` from an entity node's frontmatter.
 *  CLAIMS-21: a Connect-merged entity carries every source it spans — Claims must see them all, or
 *  the later sources' facts are silently dropped (the reproduced data-loss bug). */
export function parseEntityNode(md: string): EntityRef {
  const fmEnd = md.indexOf('\n---', 3);
  const fm = fmEnd === -1 ? md : md.slice(0, fmEnd);
  let kind = '';
  let name = '';
  let sources: string[] = [];
  for (const line of fm.split('\n')) {
    const k = line.match(/^kind:\s*(.+)$/);
    if (k) kind = parseScalarValue(k[1]);
    const n = line.match(/^name:\s*(.+)$/);
    if (n) name = parseScalarValue(n[1]);
    const d = line.match(/^\s+derivedFrom:\s*(\[.*\])\s*$/);
    if (d) {
      try {
        const arr = JSON.parse(d[1]) as unknown[];
        if (Array.isArray(arr)) sources = arr.map(String).filter((s) => s.length > 0);
      } catch {
        /* leave empty → caught below */
      }
    }
  }
  if (!kind || !name) throw new Error('claims: entity node missing kind/name');
  if (sources.length === 0) throw new Error('claims: entity node missing provenance.derivedFrom');
  return { kind, name, sources };
}

/** A source is "pending" for an entity when Claims hasn't yet reached a terminal/parked/exhausted
 *  outcome for that (entity × source) pair — the same predicate {@link readClaimsQueue} sorts on. */
function isPendingSource(state: ClaimsState, maxAttempts: number): boolean {
  return !state.terminal && !state.parked && state.failures < maxAttempts;
}

/** The first source (in node order) still needing claims for this entity, or null if all are done.
 *  CLAIMS-21: the work unit is one (entity × source) pair; the drain re-queues the entity until every
 *  source is terminal, so each call advances exactly one pending source. `baseDir` is the vault root
 *  (or a worktree synced to a canonical checkpoint). */
async function firstPendingSource(baseDir: string, ref: EntityRef, entityId: string, maxAttempts: number): Promise<string | null> {
  for (const src of ref.sources) {
    const state = await readClaimsState(path.join(baseDir, src), entityId);
    if (isPendingSource(state, maxAttempts)) return src;
  }
  return null;
}

/** The entity's sources currently terminal via a recoverable `setaside` (NOT `claimed`/`dismissed`).
 *  The retry/dismiss escape hatch (CLAIMS-20) acts on exactly these — a multi-source entity may have
 *  one poison source set aside while its siblings claimed cleanly. */
async function setAsideSources(baseDir: string, ref: EntityRef, entityId: string): Promise<string[]> {
  const out: string[] = [];
  for (const src of ref.sources) {
    const state = await readClaimsState(path.join(baseDir, src), entityId);
    if (state.terminal && state.terminalReason === 'setaside') out.push(src);
  }
  return out;
}

/** Parse one claim file into a back-link IF it is a claim about `entityRel` (else null). Used to
 *  regenerate an entity's claims block from the UNION of its claim files (CLAIMS-9/21): the claim
 *  files under `claims/` are canonical, the node block is their regenerable index — so a per-source
 *  run never clobbers a sibling source's already-written rows. */
export function parseClaimBacklink(md: string, claimPath: string, entityRel: string): ClaimBacklink | null {
  const fmEnd = md.indexOf('\n---', 3);
  const fm = fmEnd === -1 ? md : md.slice(0, fmEnd);
  const body = fmEnd === -1 ? '' : md.slice(fmEnd + 4);
  let subject = '';
  let status = '';
  let confidence = NaN;
  let source = '';
  for (const line of fm.split('\n')) {
    const s = line.match(/^subject:\s*(.+)$/);
    if (s) subject = parseScalarValue(s[1]);
    const st = line.match(/^status:\s*(.+)$/);
    if (st) status = st[1].trim();
    const c = line.match(/^confidence:\s*(.+)$/);
    if (c) confidence = Number(c[1].trim());
    const d = line.match(/^\s+derivedFrom:\s*(\[.*\])\s*$/);
    if (d) {
      try {
        const arr = JSON.parse(d[1]) as unknown[];
        if (Array.isArray(arr) && arr.length > 0) source = String(arr[0]);
      } catch {
        /* leave empty */
      }
    }
  }
  if (subject !== entityRel) return null;
  const statement = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('Source:')) ?? '';
  return { claimPath, statement, status: status as ClaimStatus, confidence, source };
}

/** The claim-file paths an entity's existing block already references — its `[[claims/…]]` wikilinks.
 *  Each Claims run regenerates the block from the union, so the block is the entity's CUMULATIVE claim
 *  index; recovering the paths here lets block regen read only the entity's OWN claims instead of
 *  scanning all of `claims/` (CLAIMS-21 perf — O(entity claims), not O(vault)). Only the path LIST is
 *  taken from the block; the claim DATA is re-read from the canonical files (see {@link entityBacklinks}),
 *  so a hand-edited block is overwritten by the correct regeneration, never trusted as state. */
function priorClaimPaths(entityMd: string): string[] {
  const start = entityMd.indexOf(CLAIMS_BLOCK_START);
  if (start === -1) return [];
  const endMarker = entityMd.indexOf(CLAIMS_BLOCK_END, start);
  const block = entityMd.slice(start, endMarker === -1 ? undefined : endMarker);
  const out: string[] = [];
  const re = /\[\[(claims\/[^\]|]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(m[1]);
  return out;
}

/** The entity's claims block back-links, built from the UNION of its prior claim files (referenced by
 *  the existing block) + this run's newly-written claim files — reading ONLY those files, never the whole
 *  `claims/` tree (CLAIMS-21 perf). The claim data comes from the canonical files via the hardened
 *  {@link parseClaimBacklink} (claims/ is the source of truth, CLAIMS-9), so a corrupted/hand-edited block
 *  can't drift the result. Deleted files (e.g. CLAIMS-19 dedup) are skipped. Sorted by claim id so the
 *  regenerated block is deterministic / replay-stable (VAULT-10). */
async function entityBacklinks(wt: string, entityMd: string, newClaimRels: string[], entityRel: string): Promise<ClaimBacklink[]> {
  const paths = Array.from(new Set([...priorClaimPaths(entityMd), ...newClaimRels]));
  // SPEC-0050 slice-2b/2c: a durable correction (keyed on the subject's stable block identity +
  // statement) suppresses the claim from the regenerated block — `retract` (it's wrong) or `reattribute`
  // (it's on the wrong subject). Survives re-derive/replay (the correction outlives the claim file's
  // reborn ULID). Read once; identity from the node's own frontmatter.
  const corrections = await readCorrectionDirectives(wt);
  const revokes = await readRevokeDirectives(wt); // SPEC-0050 slice-3: a REVOKED correction no longer suppresses
  const ref = parseEntityNode(entityMd);
  const identityKey = blockKey(ref.kind, ref.name);
  const out: ClaimBacklink[] = [];
  for (const rel of paths) {
    let md: string;
    try {
      md = await fs.readFile(path.join(wt, rel), 'utf8');
    } catch {
      continue; // referenced file no longer exists (e.g. collapsed by CLAIMS-19 dedup) — skip
    }
    const link = parseClaimBacklink(md, rel, entityRel);
    if (link && !isClaimSuppressedActive(corrections, revokes, identityKey, link.statement)) out.push(link);
  }
  return out.sort((a, b) => (path.basename(a.claimPath) < path.basename(b.claimPath) ? -1 : 1));
}

/**
 * The claims work queue (CLAIMS-16): entity nodes with at least one source still pending claims —
 * no terminal marker (for that entityId, in that source's audit), not parked, fewer than
 * `maxAttempts` failures. CLAIMS-21: a Connect-merged entity stays queued until EVERY source it
 * spans has a terminal marker, so each source contributes (no data loss). Returned as repo-relative
 * entity paths, sorted by entity id (the file name) so drains are deterministic.
 */
export async function readClaimsQueue(root: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<string[]> {
  root = path.resolve(root);
  const files = await findEntityFiles(root);
  const queued: string[] = [];
  for (const rel of files) {
    const entityId = path.basename(rel, '.md');
    let ref: EntityRef;
    try {
      ref = parseEntityNode(await fs.readFile(path.join(root, rel), 'utf8'));
    } catch {
      continue; // unreadable/foreign node — skip (not our well-formed unit)
    }
    // Queued iff ANY source still needs claims — the entity leaves the queue only once all are done.
    if (await firstPendingSource(root, ref, entityId, maxAttempts)) queued.push(rel);
  }
  return queued.sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1));
}

/** The rigid audit envelope (SPEC-0016 §3.4) — orchestrator-owned fields wrap freeform payloads. */
function auditLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), stage: STAGE, ...fields }) + '\n';
}

/** Build the agent's view of the source from its captured meta + raw text (text only in v1). */
async function readSourceInput(sourceDir: string): Promise<SourceInput> {
  const meta = await readCapturedMeta(sourceDir);
  const text = meta.kind === 'text' ? await fs.readFile(path.join(sourceDir, meta.raw), 'utf8') : null;
  return { sourceId: meta.id, kind: meta.kind, originalName: meta.originalName, mimeType: meta.mimeType, text };
}

export interface ClaimsOneResult {
  entityId: string;
  ok: boolean;
  claimIds: string[];
  setAside: boolean;
  /** True when the agent raised a review and the item was parked (REVIEW-5), not claimed. */
  parked?: boolean;
  /** On a failed/set-aside outcome, the failure message — threaded onto the stage's error span so a
   *  failed entity is diagnosable from the span alone (SPEC-0030 robustness batch). */
  error?: string;
}

/**
 * Derive claims for ONE entity under optimistic concurrency (SPEC-0014 ORCH-17/18/19). Cognition +
 * the claim/entity-block/audit writes happen OFF the lock, synced to a canonical checkpoint; only
 * the canonical ff-advance runs under `lock`. Because Claims EDITS the entity node's claims block,
 * it can same-path-collide with a concurrent Connect rewrite of that node — the advance detects it
 * and retries against the fresh canonical (re-reading the updated entity), bounded → set-aside
 * (ORCH-19). `lock` defaults to a private mutex so standalone calls (tests) still serialize.
 */
export async function claimsOne(
  root: string,
  entityRel: string,
  decider: ClaimsDecider,
  lock: Mutex = new Mutex(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxReviewRounds = DEFAULT_MAX_REVIEW_ROUNDS,
  log: DevLog = noopDevLog,
  span: ActiveSpan = noopActiveSpan,
): Promise<ClaimsOneResult> {
  root = path.resolve(root);
  const entityId = path.basename(entityRel, '.md');
  let result: ClaimsOneResult = { entityId, ok: false, claimIds: [], setAside: false };

  // OFF-lock (ORCH-17): sync to the canonical checkpoint, read the entity off it, run cognition,
  // write claims / park / record failure, and commit on the work branch. Returns true — every
  // branch commits something to advance (claims, the park marker, or a failed/setaside marker).
  const prepare = async ({ wt, base }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt); // the ephemeral per-item worktree, fresh off the checkpoint
    const entityPathWt = path.join(wt, entityRel);
    const entityMd = await fs.readFile(entityPathWt, 'utf8');
    const ref = parseEntityNode(entityMd);
    // CLAIMS-21: process ONE pending (entity × source) pair per call — the first source still owed
    // claims, re-read off this fresh checkpoint. The drain re-queues the entity until every source is
    // terminal, so all sources contribute. If none are pending (a concurrent writer finished the last
    // one), there's nothing to advance → noop.
    const sourceRel = await firstPendingSource(wt, ref, entityId, maxAttempts);
    if (!sourceRel) {
      result = { entityId, ok: true, claimIds: [], setAside: false };
      return false;
    }
    const sourceDirWt = path.join(wt, sourceRel);
    const auditPath = path.join(sourceDirWt, 'audit.jsonl');
    const runId = ulid();
    try {
      const source = await readSourceInput(sourceDirWt);
      const sourceId = source.sourceId;
      // Feed any already-answered reviews back to the resumed run as authoritative context (REVIEW-6).
      const priorState = await readClaimsState(sourceDirWt, entityId);
      const priorReviews: AnsweredReview[] = priorState.answered.map((a) => ({ question: a.question, verdict: a.verdict, note: a.note }));
      const input: EntityInput = { entityId, kind: ref.kind, name: ref.name, source, ...(priorReviews.length > 0 ? { priorReviews } : {}) };
      const decision = await decider(input, { span });
      const model = decision.agent?.model ?? 'default';

      // REVIEW-5: if the agent raised any reviews, PARK this item — apply NO claims until answered.
      if (decision.reviews && decision.reviews.length > 0) {
        // Cascade cap (REVIEW-8): too many parks on one item → set aside, never loop forever.
        if (priorState.rounds >= maxReviewRounds) {
          let audit = auditLine({ runId, entityId, sourceId, model, event: 'start' });
          audit += auditLine({ runId, entityId, event: 'setaside', reason: 'review-cascade-cap', rounds: priorState.rounds });
          await fs.appendFile(auditPath, audit, 'utf8');
          await wtGit.raw('add', '-A');
          await wtGit.commit(`claims: set aside ${entityId} (review cascade cap)`);
          log.warn('claims.setaside', { runId, itemId: entityId, reason: 'review-cascade-cap', rounds: priorState.rounds });
          result = { entityId, ok: false, claimIds: [], setAside: true };
          return true;
        }
        const createdAtR = new Date().toISOString();
        const reviewIds: string[] = [];
        let audit = auditLine({ runId, entityId, sourceId, model, event: 'start' });
        for (const req of decision.reviews) {
          const id = ulid();
          const review: Review = {
            id,
            status: 'open',
            question: req.question,
            detail: req.detail,
            raisedBy: {
              stage: STAGE,
              runId,
              item: { kind: 'entity', ref: entityRel },
              auditRel: path.join(sourceRel, 'audit.jsonl'),
              markerKey: { entityId },
            },
            subject: { ...(req.refs ? { refs: req.refs } : {}), sources: [sourceRel] },
            createdAt: createdAtR,
          };
          await writeReviewFile(path.join(wt, reviewRel(id)), review);
          reviewIds.push(id);
          audit += auditLine({ runId, entityId, sourceId, model, event: 'review-raised', reviewId: id, question: req.question });
        }
        // The non-terminal park marker: skips just this item until every raised review is answered.
        audit += auditLine({ runId, entityId, event: 'awaiting-review', reviewIds, round: priorState.rounds + 1 });
        await fs.appendFile(auditPath, audit, 'utf8');
        await wtGit.raw('add', '-A');
        await wtGit.commit(`claims: parked ${entityId} for review (${reviewIds.length})`);
        result = { entityId, ok: true, claimIds: [], setAside: false, parked: true };
        return true;
      }

      // Mint claim ULIDs + write claim files (orchestrator-owned effects; CLAIMS-3/6). Each claim's
      // provenance is THIS single source (CLAIMS-21: clean per-claim provenance, never derivedFrom[0]).
      const createdAt = new Date().toISOString();
      const claimIds: string[] = [];
      const newClaimRels: string[] = [];
      for (const claim of decision.claims) {
        const id = ulid();
        const rel = path.join('claims', dateShard(id), `${id}.md`);
        const dest = path.join(wt, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(
          dest,
          renderClaimMd(claim, { id, subject: entityRel, derivedFrom: sourceRel, createdAt, agent: decision.agent }),
          'utf8',
        );
        claimIds.push(id);
        newClaimRels.push(rel);
      }

      // Regenerate the entity node's delimited claims block (CLAIMS-9) from the UNION of ALL claim
      // files about this entity — this source's just-written claims PLUS any sibling source's already
      // on the checkpoint (CLAIMS-21). Scoped to the entity's OWN claim files (prior paths recovered
      // from the existing block; data re-read from the canonical files) — O(entity claims), never a
      // full `claims/` scan. canonical data lives in claims/; the block is its regenerable index, so a
      // per-source run never clobbers another source's rows. Identity untouched (CLAIMS-11).
      const backlinks = await entityBacklinks(wt, entityMd, newClaimRels, entityRel);
      await fs.writeFile(entityPathWt, applyClaimsBlock(entityMd, backlinks), 'utf8');

      let audit = auditLine({ runId, entityId, sourceId, model, event: 'start' });
      for (const sig of decision.signals ?? []) {
        audit += auditLine({ runId, entityId, sourceId, model, event: 'signal', type: sig.type, note: sig.note, refs: sig.refs });
      }
      audit += auditLine({ runId, entityId, sourceId, model, event: 'claimed', claims: claimIds.length });
      await fs.appendFile(auditPath, audit, 'utf8');

      await wtGit.raw('add', '-A');
      await wtGit.commit(`claims: ${claimIds.length} about ${entityId} from ${sourceId}`);
      result = { entityId, ok: true, claimIds, setAside: false };
      return true;
    } catch (err) {
      // CLAIMS-12 / ORCH-12: never lose the entity. Discard any partial worktree writes, then
      // record the failed attempt durably; set aside after K so it can't head-of-line-block.
      await wtGit.raw('reset', '--hard', base);
      const error = err instanceof Error ? err.message : String(err);
      const priorFailures = (await readClaimsState(sourceDirWt, entityId)).failures;
      const attempt = priorFailures + 1;
      const setAside = attempt >= maxAttempts;
      let audit = auditLine({ runId, entityId, event: 'failed', attempt, error: oneLine(error) });
      if (setAside) audit += auditLine({ runId, entityId, event: 'setaside', attempts: attempt });
      // BUG #135: the failure may BE an incomplete/missing source dir (e.g. `readSourceInput` ENOENT on
      // a source whose audit.jsonl/dir isn't present). Writing the failed/set-aside marker straight to
      // `auditPath` then ENOENTs itself (appendFile creates the file, not parent dirs) → the marker never
      // persists → `failures` never increments → the entity retries FOREVER (the 172× poison-loop) instead
      // of setting aside (ORCH-12). Ensure the dir exists so the durable failure record always lands.
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, audit, 'utf8');
      // OBS-4: verbose cause for the structured failed/setaside audit, cross-linked by runId (OBS-3).
      log.error('claims.failed', { runId, itemId: entityId, attempt, setAside, err });
      await wtGit.raw('add', '-A');
      await wtGit.commit(`claims: failed ${entityId} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
      result = { entityId, ok: false, claimIds: [], setAside, error };
      return true;
    }
  };

  // Same-path collision exhaustion (ORCH-19): set the pending (entity × source) pair aside so it
  // can't head-of-line-block. Targets the same source `prepare` was working (the first pending one);
  // siblings already claimed are untouched (CLAIMS-21).
  const onExhausted = async (): Promise<void> => {
    const base = await canonicalHead(root);
    await withEphemeralWorktree(root, STAGE, base, async ({ wt, workBranch }) => {
      const ref = parseEntityNode(await fs.readFile(path.join(wt, entityRel), 'utf8'));
      const sourceRel = (await firstPendingSource(wt, ref, entityId, maxAttempts)) ?? ref.sources[0];
      const auditPath = path.join(wt, sourceRel, 'audit.jsonl');
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(
        auditPath,
        auditLine({ runId: ulid(), entityId, event: 'setaside', reason: 'collision-exhausted' }),
        'utf8',
      );
      const wtGit = simpleGit(wt);
      await wtGit.raw('add', '-A');
      await wtGit.commit(`claims: set aside ${entityId} (collision-exhausted)`);
      await lock.run(() => advanceOrCollide(root, workBranch, base), 'claims:setaside-advance');
    });
    log.warn('claims.setaside', { itemId: entityId, reason: 'collision-exhausted' });
    result = { ...result, ok: false, setAside: true };
  };

  await withConcurrentAdvance({ root, lock, stage: STAGE }, prepare, onExhausted);
  return result;
}

/**
 * Append ONE per-entity audit event to EACH currently-set-aside source of the entity, and commit
 * under the canonical-writer lock via the same optimistic-advance machinery as a normal claims
 * commit (CLAIMS-15, ORCH-17/18). Shared by the CLAIMS-20 recovery primitives. CLAIMS-21: a merged
 * entity may have a poison source set aside while siblings claimed cleanly — retry/dismiss act on the
 * set-aside pairs only, never re-opening a cleanly-claimed source. If none are set aside it's a noop.
 * Each source dir is `mkdir -p`'d first because a set-aside item's source may be incomplete/absent
 * (BUG #135). A rare same-path collision retries; exhaustion throws (a manual, one-at-a-time recovery
 * action shouldn't exhaust — surface it rather than silently drop).
 */
async function appendEntityAudit(
  root: string,
  entityRel: string,
  fields: Record<string, unknown>,
  commitMessage: (entityId: string) => string,
  lock: Mutex,
): Promise<void> {
  root = path.resolve(root);
  const entityId = path.basename(entityRel, '.md');
  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    const ref = parseEntityNode(await fs.readFile(path.join(wt, entityRel), 'utf8'));
    const targets = await setAsideSources(wt, ref, entityId);
    if (targets.length === 0) return false; // nothing set aside → nothing to recover (noop)
    for (const src of targets) {
      const auditPath = path.join(wt, src, 'audit.jsonl');
      await fs.mkdir(path.dirname(auditPath), { recursive: true }); // BUG #135: source dir may be absent
      await fs.appendFile(auditPath, auditLine({ runId: ulid(), entityId, ...fields }), 'utf8');
    }
    const wtGit = simpleGit(wt);
    await wtGit.raw('add', '-A');
    await wtGit.commit(commitMessage(entityId));
    return true;
  };
  const onExhausted = async (): Promise<void> => {
    throw new Error(`claims recovery: could not advance ${String(fields.event)} for ${entityId} — canonical too contended`);
  };
  await withConcurrentAdvance({ root, lock, stage: STAGE }, prepare, onExhausted);
}

/**
 * CLAIMS-20 (OBS-17 escape hatch) — user-driven **retry** of a set-aside claims item. Appends a
 * per-entity `reopened` marker that supersedes the prior `setaside`/`failed` count (see
 * {@link readClaimsState}), so the entity re-enters the claims queue and re-derives on the next
 * sweep. Per-ENTITY by construction — siblings of the same source are untouched (deliberately NOT
 * a source-wide `replay-reset` epoch, which would re-derive every entity of that source).
 */
export async function retryClaimsItem(root: string, entityRel: string, lock: Mutex = new Mutex(), log: DevLog = noopDevLog): Promise<void> {
  await appendEntityAudit(root, entityRel, { event: 'reopened' }, (id) => `claims: reopened ${id} (retry)`, lock);
  log.info('claims.reopened', { itemId: path.basename(entityRel, '.md') });
}

/**
 * CLAIMS-20 (OBS-17 escape hatch) — user-driven **dismiss** of a set-aside claims item. Appends a
 * TERMINAL `dismissed` marker: the entity leaves the recoverable (set-aside) list permanently and
 * is never retried or re-derived — distinct from `setaside`, which stays recoverable. Sources are
 * unmutated beyond the append-only audit (CLAIMS-11).
 */
export async function dismissClaimsItem(root: string, entityRel: string, lock: Mutex = new Mutex(), log: DevLog = noopDevLog): Promise<void> {
  await appendEntityAudit(root, entityRel, { event: 'dismissed' }, (id) => `claims: dismissed ${id}`, lock);
  log.info('claims.dismissed', { itemId: path.basename(entityRel, '.md') });
}

/** One recoverable set-aside item for the Status-view recovery panel (CLAIMS-20 / OBS-17). */
export interface SetAsideItem {
  entityRel: string; // repo-relative entity node path (the handle for retry/dismiss)
  entityId: string;
  kind: string;
  name: string;
  derivedFrom: string; // the source dir it derives from (provenance)
  failures: number; // failed attempts recorded before set-aside
  rounds: number; // review-park rounds (REVIEW-8), if it was set aside on the review-cascade cap
}

/**
 * CLAIMS-20 (OBS-17) — the recoverable set-aside list: every entity whose CURRENT claims state is
 * terminal via `setaside` (NOT a `claimed` success, NOT a user-`dismissed` item). The Status view
 * renders these and offers {@link retryClaimsItem} / {@link dismissClaimsItem} on each. Reads through
 * {@link readClaimsState} so it honors retries/dismisses/replay-epochs with no parallel logic.
 */
export async function listSetAsideItems(root: string): Promise<SetAsideItem[]> {
  root = path.resolve(root);
  const out: SetAsideItem[] = [];
  for (const rel of await findEntityFiles(root)) {
    let ref: EntityRef;
    try {
      ref = parseEntityNode(await fs.readFile(path.join(root, rel), 'utf8'));
    } catch {
      continue; // unreadable/foreign node — not our well-formed unit
    }
    const entityId = path.basename(rel, '.md');
    // CLAIMS-21: an entity is recoverable if ANY of its sources is set aside — one row per entity
    // (retry/dismiss reopen every set-aside pair). `derivedFrom`/`failures`/`rounds` report the first.
    const setAside = await setAsideSources(root, ref, entityId);
    if (setAside.length === 0) continue;
    const state = await readClaimsState(path.join(root, setAside[0]), entityId);
    out.push({ entityRel: rel, entityId, kind: ref.kind, name: ref.name, derivedFrom: setAside[0], failures: state.failures, rounds: state.rounds });
  }
  return out.sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
}

/**
 * Owns a vault's Claims stage: a poke/sweep drain loop sharing the canonical-writer lock with
 * the archivist + Decompose (SPEC-0014 §5). Restartable: re-reads the derived queue and resumes.
 */
export class ClaimsStage {
  private readonly root: string;
  private readonly decider: ClaimsDecider;
  private readonly lock: Mutex;
  private readonly maxAttempts: number;
  private readonly afterDrain?: () => Promise<void>;
  private cap: number; // mutable for SPEC-0048 SCALE-4 live-apply (see setCap)
  private readonly log: DevLog;
  private readonly tracer: Tracer;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;
  private drainStartedAt: string | null = null; // when the active drain began (OBS/VIZ in-flight dwell)
  // INGEST-PERF item 1: memoize the O(N) entity-tree walk against the canonical HEAD sha — both call
  // sites share it, and an idle sweep on an unchanged canonical skips the walk entirely.
  private readonly queueCache = new CanonicalQueueCache<string[]>();

  /**
   * @param afterDrain optional hook run (serialized under the shared lock) after a drain that
   *   wrote claims to ≥1 entity. The pipeline passes the promotion gate here so the entity nodes'
   *   newly-attached claims blocks (+ `claims/` files) are published `staging`→`main`
   *   (STAGING-3/11). Mirrors the Orchestrator's + ConnectStage's `afterDrain`.
   */
  constructor(
    root: string,
    decider: ClaimsDecider = makeClaimsDecider(),
    lock: Mutex = new Mutex(),
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    afterDrain?: () => Promise<void>,
    cap: number = DEFAULT_STAGE_CAP,
    log: DevLog = noopDevLog,
    tracer: Tracer = noopTracer,
  ) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.maxAttempts = maxAttempts;
    this.afterDrain = afterDrain;
    this.cap = Math.max(1, Math.floor(cap));
    this.log = log.child({ scope: 'claims' });
    this.tracer = tracer;
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

  /** Live-set the per-stage concurrency cap (SPEC-0048 SCALE-4): read on the NEXT batch (drainOnce
   *  slices `this.cap` per pass), so a Settings change applies without a restart. */
  setCap(cap: number): void {
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** The current per-stage concurrency cap (for Status display / SPEC-0048 Settings). */
  getCap(): number {
    return this.cap;
  }

  /** INGEST-PERF item 1 perf proof/telemetry: queue reads served from the canonical-HEAD memo
   *  (`hits` = O(N) walks skipped) vs recomputed (`misses` = walks actually run). */
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
    this.pending = true;
    if (!this.draining) {
      this.draining = true;
      this.drainStartedAt = new Date().toISOString();
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
      // A SYSTEMIC drain failure (e.g. the queue read / canonical writer is wedged) must NOT escape as
      // an unhandledRejection through a fire-and-forget `void poke()` (SPEC-0030 robustness). Surface it
      // loudly; a later poke/sweep retries. Per-item failures are isolated in drainOnce and never reach here.
      this.log.error('claims.drain-fatal', { err });
    } finally {
      this.draining = false;
      this.drainStartedAt = null;
      this.current = null;
    }
  }

  private async drainOnce(): Promise<void> {
    let queue = await this.queueCache.read(this.root, () => readClaimsQueue(this.root, this.maxAttempts));
    let worked = false;
    while (queue.length > 0) {
      // ORCH-17/18/20: process up to `cap` entities concurrently (each in its own ephemeral worktree;
      // cap=1 ⇒ serial). claimsOne handles its own failures + same-source-audit collisions (re-sync +
      // retry), so a settled batch never rejects.
      const batch = queue.slice(0, this.cap);
      try {
        // OBS-12: each entity gets a `stage.run` span wrapping its decider's `copilot.invoke` child.
        // LOCUS DISTINCTION: claimsOne RETURNS for a per-item failure it could record (set aside after
        // K) — its message rides onto the error span (robustness batch). It THROWS only when it could
        // NOT record (a wedged writer — systemic), handled by the catch.
        await Promise.all(
          batch.map((entityRel) => {
            const itemId = path.basename(entityRel, '.md');
            const span = this.tracer.start(STAGE_RUN_OP, { stage: STAGE, itemId });
            return claimsOne(this.root, entityRel, this.decider, this.lock, this.maxAttempts, DEFAULT_MAX_REVIEW_ROUNDS, this.log, span).then(
              (r) => {
                // A park (review raised) is a successful outcome, not an error.
                span.end(r.ok || r.parked ? 'ok' : r.setAside ? 'setaside' : 'error', r.error);
                worked = true;
              },
              (err) => {
                // Systemic (wedged writer): end the span WITH the message, then propagate to the catch.
                span.end('error', err instanceof Error ? err.message : String(err));
                throw err;
              },
            );
          }),
        );
      } catch (err) {
        this.log.error('claims.drain-error', { err }); // systemic — stop this pass; a later poke/sweep retries
        return;
      }
      queue = await this.queueCache.read(this.root, () => readClaimsQueue(this.root, this.maxAttempts));
    }
    // Publish entity nodes' newly-attached claims staging→main (STAGING-3/11), serialized under
    // the shared lock. Gated on `worked` so idle sweeps don't churn the gate (it's idempotent).
    if (worked && this.afterDrain) await this.lock.run(() => this.afterDrain!(), 'claims:afterDrain');
  }
}
