// The Connect stage runtime (SPEC-0020) — the FOURTH user of the SPEC-0014 harness: the SAME
// deterministic pattern as archivist / Decompose / Claims (worktree isolation, fresh
// disposable session per item, orchestrator-owns-effects, ff-advance under the shared
// canonical-writer lock), pointed at a different work-list + instruction file (ORCH-9).
//
// Connect is the FIRST stage that reasons ACROSS items. The orchestrator does deterministic
// BLOCKING (group candidates by kind + normalized name; CONNECT-4); the thin agent does
// MATCHING on ONE bounded candidate set (CONNECT-5). Connect is the SOLE writer of evergreen
// `entities/` (CONNECT-3): it turns per-source CANDIDATES into born-resolved, human-named,
// deduped nodes.
//
// SCOPE (v1 resolver core): block / match / merge / dedup / born-resolved nodes + claim
// repoint on merge. Link-promotion ([[wikilinks]], CONNECT-12/13) is a DEFERRED later slice
// (a Connect re-pass after Claims). This file writes NO links block.
//
// INTEGRATION SEAM: per CANON, all stages work on the `staging` branch and a promotion gate
// advances `main`. The staging retarget (SPEC-0021) realizes this by running every stage on the
// persistent `staging` worktree — which is checked out ON `staging` (stagingWorktree.ts). Connect
// bases its worktree on the resolved base branch (`BASE_BRANCH` override, else the vault's CURRENT
// branch), so when pipeline.ts hands it the staging worktree the current branch IS `staging` and
// Connect targets it with NO override needed — exactly like Decompose/Claims, which hardcode
// nothing. `BASE_BRANCH` therefore stays `null` (see its doc below). pipeline.ts registers
// ConnectStage on the staging worktree.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import simpleGit from 'simple-git';
import { ulid, dateShard, isUlid } from './ulid';
import { ensureGitIdentity } from './vault';
import { validCandidate, blockKey, normalizeName, type Candidate } from './connect';
import {
  renderEntityNode,
  parseEntityNode,
  entityFileRel,
  unionOrdered,
  applyLinksBlock,
  type EntityNode,
  type NodeLink,
  type ParsedNode,
} from './connectDoc';
import { resolveProseWikilinks } from './composeDoc';
import { buildEntityGraph } from './cohesion';
import { planOrphanLinks, topicTagsOf, type AffinityEntity, type OrphanLinkOptions } from './entityAffinity';
import { mergeNodes } from './mergeNodes';
import { applyClaimDedup, type DedupReport } from './claimDedup';
import { typeTag, normalizeTag } from './metaVocab';
import { makeConnectDecider, type ConnectDecider, type CandidateSet, type ExistingNodeRef, type PriorDisambiguation } from './connectAgent';
import { reviewRel, writeReviewFile, readAllReviews } from './reviewStore';
import { readDisambiguationDecisions, decisionForPair } from './disambiguationDecisions';
import { readDisambiguationDirectives, directiveForIdentity } from './directives';
import { deriveSourceTitle } from './sourceDoc';
import { parseSensitivityFromSourceMd } from './sensitivityRead';
import { restrictiveness } from './sensitivity';
import { normalizeEventDates, type EventDate } from './eventDate';
import type { Review, ReviewSubjectCandidate } from './reviews';
import { Mutex } from './stageLock';
import { epochScopedLines } from './replayEpoch';
import { advanceOrCollide, boundedGit, canonicalHead, DEFAULT_MAX_COLLISION_RETRIES, DEFAULT_STAGE_CAP, withConcurrentAdvance, withEphemeralWorktree, type PrepareContext } from './canonicalAdvance';
import { CanonicalQueueCache } from './queueCache';
import { noopDevLog, type DevLog } from './devlog';
import { noopTracer, noopActiveSpan, STAGE_RUN_OP, type Tracer, type ActiveSpan } from './tracing';

/**
 * The branch Connect's worktree is based on and fast-forwards into.
 *
 * `null` (the v1 default) means "the vault's CURRENT branch" — resolved at runtime via
 * `rev-parse --abbrev-ref HEAD`, exactly as decomposeStage/claimsStage do. This is correct on
 * any vault regardless of its default branch name (`main`, `master`, a CI PR ref, …) — the
 * earlier hardcoded `'main'` broke on vaults whose branch wasn't literally `main`.
 *
 * The CANON staging retarget (SPEC-0019 / SPEC-0021) does NOT need to flip this: it runs every
 * stage on the persistent `staging` worktree (checked out on `staging`), so the current-branch
 * default already resolves to `staging` and Connect's ff-advance moves `staging`; the promotion
 * gate then advances `main`. Hardcoding `'staging'` here would be both redundant and wrong — it
 * would break on any vault without a literal `staging` branch (e.g. the connectStage unit tests),
 * the same hardcoded-branch hazard the `null` default was introduced to fix.
 */
export const BASE_BRANCH: string | null = null;

/** Resolve the base branch: the explicit override, else the vault's current branch. */
async function resolveBaseBranch(git: ReturnType<typeof simpleGit>): Promise<string> {
  if (BASE_BRANCH) return BASE_BRANCH;
  return (await git.raw('rev-parse', '--abbrev-ref', 'HEAD')).trim();
}

const WORKTREE_REL = path.join('.kb', 'cache', 'worktrees', 'connect');
const WORK_BRANCH = 'kb/connect-work';
const STAGE = 'connect';
/** Append-only stage audit (working zone; keyed by blockKey). The LINK/dedup sweeps (serial under the
 *  lock) still write here. The RESOLVE path writes PER-BLOCK (see {@link blockAuditRel}). */
const AUDIT_REL = path.join('connect', 'audit.jsonl');
/** SPEC-0048 SCALE-5: per-block resolve audit dir. With Connect running cap>1, two DISJOINT blocks'
 *  resolve commits must touch DISJOINT paths — else they'd same-path-collide on a shared `audit.jsonl`
 *  (concurrent EOF appends → cherry-pick conflict) → `withConcurrentAdvance` would re-run the whole
 *  prepare incl. the LLM decider on each collision (cost). So each block gets its own audit file (the
 *  decompose-per-source pattern that makes its single unchecked advance safe). */
const AUDIT_DIR_REL = path.join('connect', 'blocks');
/** The per-block resolve-audit file for a block key — a deterministic, filesystem-safe name (slug for
 *  readability + a short hash for collision-freedom, since a block name can be any string). */
function blockAuditRel(key: string): string {
  const slug = key.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'block';
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 8);
  return path.join(AUDIT_DIR_REL, `${slug}-${hash}.jsonl`);
}
/** Default attempts before a poison block is set aside (CONNECT-14). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Default review rounds (parks) on one block before it is set aside (REVIEW-8 cascade cap). */
export const DEFAULT_MAX_REVIEW_ROUNDS = 3;
/** In-pass retries for a link write that hits the bounded-git BLOCK TIMEOUT under bulk-writer
 *  contention (CONNECT-12). A transient timeout must be retried, not silently dropped — else the
 *  entity is left permanently unlinked. The lock is released between attempts so contention eases. */
export const LINK_WRITE_MAX_ATTEMPTS = 3;

// Terminal block markers (the block leaves the active queue). `setaside` is poison/recoverable
// (CONNECT-14); `dismissed` is user-retired (OBS-17, never re-queued). Resolution itself is recorded
// by candidate deletion, not a marker. A `reopened` marker (OBS-17 retry) supersedes a prior terminal.
const TERMINAL_EVENTS = new Set(['setaside', 'dismissed']);
/** Which terminal marker a block reached (OBS-17): `setaside` is recoverable, `dismissed` is not. */
export type ConnectTerminalReason = 'setaside' | 'dismissed';

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a candidate's `sourceId` to the repo-relative SOURCE DIR the archivist wrote it to
 * (`sources/<dateShard(id)>/<id>`, orchestrator.ts). A candidate carries only the source's ULID
 * (the frozen Candidate contract), but the node's `derivedFrom` must be a source-DIR path so the
 * downstream Claims stage can read the whole source from it (CLAIMS-5; `claimsOne` does
 * `path.join(root, derivedFrom)`). The layout is deterministic, so no directory walk is needed. A
 * non-ULID `sourceId` (only ever in unit fixtures) is passed through unchanged.
 */
function sourceDirRel(sourceId: string): string {
  return isUlid(sourceId) ? path.join('sources', dateShard(sourceId), sourceId) : sourceId;
}

/**
 * Resolve a candidate's `sourceId` to the repo-relative SOURCE FILE (`<dir>/source.md`) — the
 * readable note inside the source dir (every source dir holds exactly one `source.md`, the
 * orchestrator writes it; cf. claimDoc's `[[<dir>/source.md|…]]`). This is what an Obsidian
 * "Open in Obsidian" deep link must target: opening the bare DIR is "file not found" (PRIN-24).
 * Distinct from `sourceDirRel` on purpose — the Claims `derivedFrom` needs the DIR (CLAIMS-5),
 * the review's candidate link needs the FILE. A non-ULID `sourceId` (unit fixtures) passes through.
 */
function sourceFileRel(sourceId: string): string {
  return isUlid(sourceId) ? path.join(sourceDirRel(sourceId), 'source.md') : sourceId;
}

/**
 * The source's human-readable title for a review candidate row (REVIEW-16 / PRIN-24): read the
 * source's `source.md` from the stage's worktree (`wt`) — where it always exists at raise time,
 * before any promotion-lag — and derive a title. Persisted on the review so the display is durable +
 * offline and never a raw ULID. Any read/derive failure falls back to the candidate's `name` (a human
 * surface name, never a ULID), so the row always reads as a thing.
 */
async function resolveCandidateTitle(wt: string, cand: Candidate): Promise<string> {
  try {
    const content = await fs.readFile(path.join(wt, sourceFileRel(cand.sourceId)), 'utf8');
    return deriveSourceTitle(content);
  } catch {
    return cand.name;
  }
}

/** SPEC-0025 META S1b: the curated property VALUES a source carries — its `scope` + (SENSE-A) resolved
 *  `sensitivity:` label — read from its `source.md` in ONE pass (alongside the title). These ride onto the
 *  entity node's curated `properties` bag at resolve time (META-4: Connect is the authoritative writer).
 *  A missing/unreadable source → empty card (the caller folds what's present). The RESOLVED scalar is read,
 *  not the `suggested` (a sub-threshold Review hint isn't the source's label yet). */
async function readSourceCard(wt: string, cand: Candidate): Promise<{ title: string; scope?: string; sensitivity?: string }> {
  try {
    const content = await fs.readFile(path.join(wt, sourceFileRel(cand.sourceId)), 'utf8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const scope = fm.match(/^scope:[ \t]*(.+)$/m)?.[1].trim();
    const sensitivity = parseSensitivityFromSourceMd(content)?.sensitivity;
    return {
      title: deriveSourceTitle(content),
      ...(scope ? { scope } : {}),
      ...(sensitivity ? { sensitivity } : {}),
    };
  } catch {
    return { title: cand.name }; // unreadable source → fall back to the candidate's human name (never a ULID)
  }
}

// ── Reading the working zone: candidates + existing nodes ──────────────────────────────────

/** Walk `candidates/` and return every well-formed candidate (skips malformed files). */
export async function readCandidates(root: string): Promise<Candidate[]> {
  root = path.resolve(root);
  const out: Candidate[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(full);
      else if (e.isFile() && e.name.endsWith('.json')) {
        try {
          out.push(validCandidate(JSON.parse(await fs.readFile(full, 'utf8'))));
        } catch {
          /* malformed candidate — skip (not our well-formed unit) */
        }
      }
    }
  }
  await walk(path.join(root, 'candidates'));
  return out;
}

/** A located existing entity node: its parsed identity + repo-relative file path. */
export interface LocatedNode extends ParsedNode {
  rel: string;
}

/** Walk `entities/` and return every well-formed node with its repo-relative path. */
export async function readEntityNodes(root: string): Promise<LocatedNode[]> {
  root = path.resolve(root);
  const out: LocatedNode[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const parsed = parseEntityNode(await fs.readFile(full, 'utf8'));
          out.push({ ...parsed, rel: path.relative(root, full) });
        } catch {
          /* foreign / malformed node — skip */
        }
      }
    }
  }
  await walk(path.join(root, 'entities'));
  return out;
}

// ── Per-block state (from the stage audit; keyed by blockKey) ──────────────────────────────

interface AuditLine {
  stage?: string;
  event?: string;
  blockKey?: string;
  reviewIds?: string[];
  reviewId?: string;
}

export interface ConnectState {
  terminal: boolean; // set aside / dismissed — leaves the queue for good
  terminalReason?: ConnectTerminalReason; // which terminal marker (OBS-17: setaside is recoverable)
  failures: number;
  parked: boolean; // an open awaiting-review whose reviews aren't all answered (REVIEW-5)
  rounds: number;
}

async function readConnectState(root: string, key: string): Promise<ConnectState> {
  // SCALE-5: the block's events now live in its PER-BLOCK file; the legacy stage-wide file is also read
  // (back-compat for pre-migration vaults). Each file is epoch-scoped independently (replay writes the
  // reset to both), processed legacy-then-per-block so chronology holds (new resolve events go per-block).
  const readOr = async (rel: string): Promise<string> => {
    try {
      return await fs.readFile(path.join(root, rel), 'utf8');
    } catch {
      return '';
    }
  };
  const lines = [...epochScopedLines(await readOr(AUDIT_REL)), ...epochScopedLines(await readOr(blockAuditRel(key)))];
  let terminal = false;
  let terminalReason: ConnectTerminalReason | undefined;
  let failures = 0;
  let rounds = 0;
  let parkRounds: string[][] = [];
  let answered = new Set<string>();
  // Scope to the current replay epoch (REPLAY-6): a replayed block's prior terminal/park markers
  // are ignored so the (re-emitted) candidates re-resolve through the unmodified pipeline (REPLAY-14).
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let o: AuditLine;
    try {
      o = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (o.stage !== STAGE || o.blockKey !== key) continue;
    if (o.event === 'reopened') {
      // OBS-17 (user retry): a per-block `reopened` marker supersedes ALL prior state for THIS block
      // (terminal/failures/park) so it re-enters the queue and re-resolves on the next sweep.
      terminal = false;
      terminalReason = undefined;
      failures = 0;
      rounds = 0;
      parkRounds = [];
      answered = new Set<string>();
    } else if (o.event && TERMINAL_EVENTS.has(o.event)) {
      terminal = true;
      terminalReason = o.event as ConnectTerminalReason;
    } else if (o.event === 'failed') failures += 1;
    else if (o.event === 'awaiting-review') {
      rounds += 1;
      parkRounds.push(o.reviewIds ?? []);
    } else if (o.event === 'review-answered' && o.reviewId) answered.add(o.reviewId);
  }
  const parked = !terminal && parkRounds.some((ids) => ids.some((id) => !answered.has(id)));
  return { terminal, terminalReason, failures, parked, rounds };
}

// ── Blocking (deterministic; CONNECT-4) ────────────────────────────────────────────────────

/**
 * Group the working zone into candidate sets by block key (kind + normalized name), pulling
 * existing same-key nodes in for fold/merge. Returns only sets that are still actionable
 * (not terminal, not parked, under the failure cap) and that contain ≥1 candidate. Sorted by
 * block key for deterministic drains.
 */
export async function readConnectQueue(root: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<CandidateSet[]> {
  root = path.resolve(root);
  const candidates = await readCandidates(root);
  const nodes = await readEntityNodes(root);

  const byKey = new Map<string, CandidateSet>();
  for (const c of candidates) {
    const key = blockKey(c.kind, c.name);
    let set = byKey.get(key);
    if (!set) {
      set = { blockKey: key, kind: c.kind, candidates: [], existingNodes: [] };
      byKey.set(key, set);
    }
    set.candidates.push(c);
  }
  for (const n of nodes) {
    const key = blockKey(n.kind, n.name);
    const set = byKey.get(key); // only attach to blocks that have candidates to resolve
    if (set) set.existingNodes.push({ id: n.id, name: n.name });
  }

  const queued: CandidateSet[] = [];
  for (const set of byKey.values()) {
    const st = await readConnectState(root, set.blockKey);
    if (st.terminal || st.parked || st.failures >= maxAttempts) continue;
    set.candidates.sort((a, b) => (a.id < b.id ? -1 : 1));
    queued.push(set);
  }
  return queued.sort((a, b) => (a.blockKey < b.blockKey ? -1 : 1));
}

// ── Set-aside recovery (OBS-17, Connect half — mirrors claimsStage CLAIMS-20) ────────────────

/** One recoverable set-aside Connect block for the Status-view recovery panel (OBS-17). The handle
 *  is the **blockKey** — a set-aside block has NO entity node (it failed to resolve; its candidates
 *  remain). `name` is a representative human label from the block's candidates/nodes. */
export interface ConnectSetAsideItem {
  blockKey: string;
  kind: string;
  name: string;
  failures: number; // failed attempts recorded before set-aside
  rounds: number; // review-park rounds (REVIEW-8), if set aside on the review-cascade cap
}

/**
 * OBS-17 (Connect half) — the recoverable set-aside list: every candidate block whose CURRENT
 * connect state is terminal via `setaside` (NOT a user-`dismissed` block, NOT a resolved one).
 * Mirrors {@link listSetAsideItems} for claims; reads through {@link readConnectState} so it honors
 * retries/dismisses/replay-epochs with no parallel logic. The Status view offers retry/dismiss on each.
 */
export async function listConnectSetAsideItems(root: string): Promise<ConnectSetAsideItem[]> {
  root = path.resolve(root);
  const candidates = await readCandidates(root);
  const nodes = await readEntityNodes(root);
  const byKey = new Map<string, { kind: string; name: string }>();
  for (const c of candidates) {
    const key = blockKey(c.kind, c.name);
    if (!byKey.has(key)) byKey.set(key, { kind: c.kind, name: c.name }); // first candidate's spelling as the label
  }
  for (const n of nodes) {
    const key = blockKey(n.kind, n.name);
    if (!byKey.has(key)) byKey.set(key, { kind: n.kind, name: n.name });
  }
  const out: ConnectSetAsideItem[] = [];
  for (const [key, meta] of byKey) {
    const st = await readConnectState(root, key);
    if (st.terminal && st.terminalReason === 'setaside') {
      out.push({ blockKey: key, kind: meta.kind, name: meta.name, failures: st.failures, rounds: st.rounds });
    }
  }
  return out.sort((a, b) => (a.blockKey < b.blockKey ? -1 : 1));
}

/**
 * Append ONE per-block audit event to `connect/audit.jsonl` and commit it under the canonical-writer
 * lock via the shared optimistic-advance machinery (ORCH-17/18) — shared by the OBS-17 recovery
 * primitives. A rare same-path collision retries; exhaustion throws (a manual, one-at-a-time recovery
 * action shouldn't exhaust — surface it rather than silently drop).
 */
async function appendConnectAudit(
  root: string,
  key: string,
  fields: Record<string, unknown>,
  commitMessage: (key: string) => string,
  lock: Mutex,
): Promise<void> {
  root = path.resolve(root);
  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    const auditPath = path.join(wt, blockAuditRel(key)); // SCALE-5: per-block (keeps reopened/dismissed in chronological order with the resolve events)
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, auditLine({ runId: ulid(), blockKey: key, ...fields }), 'utf8');
    const wtGit = simpleGit(wt);
    await wtGit.raw('add', '-A');
    await wtGit.commit(commitMessage(key));
    return true;
  };
  const onExhausted = async (): Promise<void> => {
    throw new Error(`connect recovery: could not advance ${String(fields.event)} for ${key} — canonical too contended`);
  };
  await withConcurrentAdvance({ root, lock, stage: STAGE }, prepare, onExhausted);
}

/**
 * OBS-17 — user-driven **retry** of a set-aside Connect block. Appends a per-block `reopened` marker
 * that supersedes the prior `setaside`/`failed` count (see {@link readConnectState}), so the block
 * re-enters the queue and re-resolves on the next sweep. Idempotent-safe in the read-outside/act-
 * under-lock window: re-appending `reopened` is harmless, and a since-recovered block's marker is inert.
 */
export async function retryConnectItem(root: string, key: string, lock: Mutex = new Mutex(), log: DevLog = noopDevLog): Promise<void> {
  await appendConnectAudit(root, key, { event: 'reopened' }, (k) => `connect: reopened ${k} (retry)`, lock);
  log.info('connect.reopened', { itemId: key });
}

/**
 * OBS-17 — user-driven **dismiss** of a set-aside Connect block. Appends a TERMINAL `dismissed`
 * marker: the block leaves the recoverable list permanently and is never retried or re-resolved —
 * distinct from `setaside`, which stays recoverable.
 */
export async function dismissConnectItem(root: string, key: string, lock: Mutex = new Mutex(), log: DevLog = noopDevLog): Promise<void> {
  await appendConnectAudit(root, key, { event: 'dismissed' }, (k) => `connect: dismissed ${k}`, lock);
  log.info('connect.dismissed', { itemId: key });
}

// ── Worktree + audit helpers (mirror decomposeStage/claimsStage) ───────────────────────────

async function ensureWorktree(root: string): Promise<{ wt: string; base: string }> {
  const git = simpleGit(root);
  await ensureGitIdentity(git);
  const base = await resolveBaseBranch(git);
  const wt = path.join(root, WORKTREE_REL);
  try {
    await git.raw('worktree', 'prune');
  } catch {
    /* none yet */
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
    await git.raw('worktree', 'add', '-B', WORK_BRANCH, wt, base);
  }
  return { wt, base };
}

/** The rigid audit envelope (SPEC-0020 §3.9) — orchestrator-owned fields wrap freeform payloads. */
function auditLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), stage: STAGE, ...fields }) + '\n';
}

async function appendAudit(wt: string, text: string): Promise<void> {
  const file = path.join(wt, AUDIT_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text, 'utf8');
}

/** SCALE-5: append a RESOLVE-path audit event to the block's PER-BLOCK file (disjoint path → two
 *  concurrent disjoint blocks never collide on a shared audit, so their advances replay cleanly). */
async function appendBlockAudit(wt: string, key: string, text: string): Promise<void> {
  const file = path.join(wt, blockAuditRel(key));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, text, 'utf8');
}

/** Test/diagnostic: the concatenated content of ALL per-block resolve audits (SCALE-5) — the resolve
 *  events that used to live in the single `connect/audit.jsonl` now span `connect/blocks/*.jsonl`. */
export async function readResolveAudit(root: string): Promise<string> {
  const dir = path.join(path.resolve(root), AUDIT_DIR_REL);
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    return (await Promise.all(files.map((f) => fs.readFile(path.join(dir, f), 'utf8')))).join('');
  } catch {
    return '';
  }
}

// ── Claim repoint (CONNECT-11): point a loser node's claims at the canonical node ──────────

/** Minimal claim view for repointing + regenerating the canonical node's claims block, plus the
 *  soft `relatesTo` hints Connect promotes into links (CONNECT-12). */
interface ClaimRef {
  rel: string; // repo-relative claim file path
  subject: string; // current subject (entity rel path)
  statement: string;
  status: string;
  confidence: number;
  relatesTo: string[]; // unresolved target-name hints Claims left for Connect (CLAIMS-10)
}

function parseClaim(md: string, rel: string): ClaimRef | null {
  const fmEnd = md.indexOf('\n---', 3);
  if (fmEnd === -1) return null;
  const fm = md.slice(0, fmEnd);
  const body = md.slice(fmEnd + 4).trim();
  let subject = '';
  let status = '';
  let confidence = 0;
  let relatesTo: string[] = [];
  for (const line of fm.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^subject:\s*(.+)$/))) subject = m[1].trim().replace(/^"|"$/g, '');
    else if ((m = line.match(/^status:\s*(.+)$/))) status = m[1].trim();
    else if ((m = line.match(/^confidence:\s*(.+)$/))) confidence = Number(m[1].trim()) || 0;
    else if ((m = line.match(/^relatesTo:\s*(\[.*\])\s*$/))) {
      try {
        const arr = JSON.parse(m[1]) as unknown[];
        if (Array.isArray(arr)) relatesTo = arr.map(String).filter((s) => s.trim().length > 0);
      } catch {
        /* malformed hint list — ignore (links are best-effort, never a dangling guess) */
      }
    }
  }
  if (!subject) return null;
  // Statement = the body's FIRST line. A claim body may carry a trailing "Source: [[…]]" citation
  // (VAULT-13) that is provenance, not the assertion — exclude it so merge-regenerated claims
  // blocks show the statement, not the citation. (Statements are always single-line `oneLine`.)
  const statement = body.split('\n', 1)[0]?.trim() ?? '';
  return { rel, subject, statement, status, confidence, relatesTo };
}

async function readClaims(wtRoot: string): Promise<ClaimRef[]> {
  const out: ClaimRef[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) {
        const c = parseClaim(await fs.readFile(full, 'utf8'), path.relative(wtRoot, full));
        if (c) out.push(c);
      }
    }
  }
  await walk(path.join(wtRoot, 'claims'));
  return out;
}

// Claim repoint + canonical claims-block regeneration on merge now live in the shared `mergeNodes`
// core (./mergeNodes) — one impl for Connect's resolve-time merge AND Reflect's approved
// consolidation (SPEC-0024 REFLECT-7). `readClaims`/`parseClaim` above stay here because the
// link-promotion pass (linkOne/readLinkQueue) needs the `relatesTo` hints they parse, which the
// merge core doesn't carry.

// ── Resolve ONE block ──────────────────────────────────────────────────────────────────────

export interface ConnectOneResult {
  blockKey: string;
  ok: boolean;
  nodeRels: string[]; // canonical node files written/updated
  deletedNodeRels: string[]; // loser node files deleted on merge
  setAside: boolean;
  parked?: boolean;
  /** On a failed/set-aside outcome, the failure message — threaded onto the stage's error span so a
   *  failed block is diagnosable from the span alone (SPEC-0030 robustness batch). */
  error?: string;
}

/**
 * Resolve ONE candidate set under optimistic concurrency (SPEC-0014 ORCH-17/18/19). Cognition +
 * the node/candidate/audit writes happen OFF the lock, synced to the canonical checkpoint; only the
 * ff-advance runs under `lock`. As the SOLE writer of `entities/` (and an editor of nodes Claims
 * also touches), Connect can same-path-collide — the advance then re-syncs and retries the whole
 * block against the fresh canonical, bounded → set aside (ORCH-19). Uses an inline bounded retry
 * (recursion via `collisionAttempt`) rather than the shared `withOptimisticAdvance` wrapper because
 * the resolve body is large; the semantics are identical. `lock` defaults to a private mutex so a
 * standalone call (tests) still serializes its own advance; the stage passes the shared lock.
 */
export async function connectOne(
  root: string,
  key: string,
  decider: ConnectDecider,
  lock: Mutex = new Mutex(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxReviewRounds = DEFAULT_MAX_REVIEW_ROUNDS,
  collisionAttempt = 0,
  log: DevLog = noopDevLog,
  span: ActiveSpan = noopActiveSpan,
): Promise<ConnectOneResult> {
  root = path.resolve(root);
  void collisionAttempt; // SCALE-5: collision retry is now owned by withConcurrentAdvance (was inline recursion)
  const runId = ulid();
  let result: ConnectOneResult = { blockKey: key, ok: true, nodeRels: [], deletedNodeRels: [], setAside: false };

  // SCALE-5: resolve OFF the lock in a FRESH per-item EPHEMERAL worktree (was a SHARED fixed worktree,
  // which forced cap=1 — two concurrent resolves on `entities/` would clobber its working tree). Connect
  // now joins the cap>1 stages: withConcurrentAdvance creates the wt synced to `base`, runs this prepare,
  // then advances UNDER the lock via the SAME advanceOrCollide primitive (ff / disjoint-replay / same-path
  // collision → bounded retry on the moved canonical → onExhausted set-aside, ORCH-18/19). The resolve/
  // merge body below is UNCHANGED — only the worktree source + the advance/retry wrapper moved.
  const prepare = async ({ wt, base }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt);
    const checkpoint = base; // the canonical commit this block prepared off (for the catch's discard-partial)

    // Re-derive the set INSIDE the worktree (authoritative view at this commit).
    const allCandidates = await readCandidates(wt);
  const setCandidates = allCandidates.filter((c) => blockKey(c.kind, c.name) === key).sort((a, b) => (a.id < b.id ? -1 : 1));
  const nodes = await readEntityNodes(wt);
  const sameKeyNodes = nodes.filter((n) => blockKey(n.kind, n.name) === key);
  const kind = setCandidates[0]?.kind ?? sameKeyNodes[0]?.kind ?? key.split('|')[0];

  if (setCandidates.length === 0) {
    result = { blockKey: key, ok: true, nodeRels: [], deletedNodeRels: [], setAside: false };
    return false; // nothing to do → no-op (nothing committed; withConcurrentAdvance skips the advance)
  }

  try {
    // CONNECT-21: load the durable disambiguation decisions so they inform BOTH the decider (the
    // matcher resolves new mentions against known verdicts instead of re-opening) and the post-decision
    // suppression below. Surface the ones among THIS block's same-key existing nodes as decided pairs.
    const decisions = await readDisambiguationDecisions(wt);
    // SPEC-0050 DIR-3: also load the durable DIRECTIVES — disambiguation verdicts keyed on the STABLE
    // block identity (this block's `key`, e.g. `organization|disney`). Unlike the pair-keyed decisions
    // above (whose entity ULIDs go stale on a re-derive/replay), a directive matches by block identity,
    // so a settled "Disney is one org" still applies to the freshly-minted nodes after a Full Replay.
    //
    // Slice 1 acts on the MERGE directive only (`same`): it means "this identity is ONE entity", a
    // per-block fact that survives rebirth — so it auto-resolves every same-key pair and suppresses the
    // re-ask (the felt Disney/Microsoft bug). A `distinct` verdict is inherently PER-PAIR ("these two
    // are different"), so it must NOT blanket-suppress the block — a genuinely new, never-decided pair
    // still raises (REVIEW-18 per-pair memory). Distinct's durable cross-rebirth treatment rides the
    // SPEC-0047 confidence line in a later slice; here it stays on the exact pair-keyed store.
    const directives = await readDisambiguationDirectives(wt);
    const directive = directiveForIdentity(directives, key);
    const mergeDirective = directive?.verdict === 'same' ? directive : undefined;
    const priorDecisions: PriorDisambiguation[] = [];
    for (let i = 0; i < sameKeyNodes.length; i++) {
      for (let j = i + 1; j < sameKeyNodes.length; j++) {
        const a = sameKeyNodes[i].id;
        const b = sameKeyNodes[j].id;
        // The exact pair-keyed decision wins when present (it may carry a later, revised per-pair
        // verdict); otherwise a `same` directive on the block identity resolves the pair as merged.
        const verdict = decisionForPair(decisions, a, b)?.verdict ?? (mergeDirective ? 'same' : undefined);
        if (verdict) priorDecisions.push({ a, b, verdict });
      }
    }
    // PRIN-24 / "never surface ULIDs": resolve each candidate's source ULID → human title so the
    // Connect prompt references sources by TITLE, not the raw id. connectAgent fed `source: <ULID>`,
    // which the model parroted into the disambiguation gloss ("Ciaran — sole mention, from source
    // 01KTJH…"). resolveCandidateTitle never returns a ULID (falls back to the candidate name). Dedupe
    // the read per source so a many-candidate block reads each source.md at most once.
    const sourceTitles: Record<string, string> = {};
    // SPEC-0025 META S1b: per-source curated property values (scope/sensitivity), read in the SAME pass
    // as the titles (one source.md read per source) so the node can carry them at resolve time.
    const sourceProps: Record<string, { scope?: string; sensitivity?: string }> = {};
    for (const c of setCandidates) {
      if (c.sourceId in sourceTitles) continue;
      const card = await readSourceCard(wt, c);
      sourceTitles[c.sourceId] = card.title;
      sourceProps[c.sourceId] = { ...(card.scope ? { scope: card.scope } : {}), ...(card.sensitivity ? { sensitivity: card.sensitivity } : {}) };
    }
    const set: CandidateSet = {
      blockKey: key,
      kind,
      candidates: setCandidates,
      existingNodes: sameKeyNodes.map((n): ExistingNodeRef => ({ id: n.id, name: n.name })),
      sourceTitles,
      ...(priorDecisions.length > 0 ? { priorDecisions } : {}),
    };
    const decision = await decider(set, { span });
    const model = decision.agent?.model ?? 'default';
    const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
    const candidateById = new Map(setCandidates.map((c) => [c.id, c] as const));

    // CONNECT-21: consult durable disambiguation decisions BEFORE raising. A "same entity?" review
    // whose entity-PAIR already has a recorded verdict (REVIEW-18) is NEVER re-asked — drop it. This is
    // the missing durable half of CONNECT-15's "resume with the verdict as context": a decided pair
    // (Leavenworth-company ≠ Leavenworth-WA, …) re-blocked on every later mention and re-raised the
    // identical Review (the Principal's "the same review over and over"). Suppressing the decided re-asks
    // lets the queue converge; a genuinely new/undecided pair still raises. Only an undecided review parks.
    const liveReviews = (decision.reviews ?? []).filter((req) => {
      if (req.pair) {
        const decided = decisionForPair(decisions, req.pair[0], req.pair[1]);
        if (decided) {
          log.info('connect.disambiguation-suppressed', {
            runId,
            itemId: key,
            pair: req.pair.join(' · '),
            verdict: decided.verdict,
            reviewId: decided.reviewId,
          });
          return false; // decided pair → don't re-ask (CONNECT-21)
        }
        // SPEC-0050 DIR-3/4/8: no exact pair-keyed decision, but a MERGE DIRECTIVE on this block
        // identity settles the question durably (it survives the re-derive/replay that reissued the
        // entity ULIDs the pair-keyed decision was lost to): the identity is one entity, so any "are
        // these two the same?" re-ask is auto-resolved via the priorDecision fed to the decider above —
        // don't re-raise. (Only `same`; a `distinct` verdict is per-pair and never blanket-suppresses,
        // so a genuinely new pair still raises. Confidence-nudge framing per SPEC-0047: new conflicting
        // evidence would drop confidence below the line and re-surface a review — a later slice.)
        if (mergeDirective) {
          log.info('connect.directive-suppressed', {
            runId,
            itemId: key,
            identityKey: key,
            pair: req.pair.join(' · '),
            verdict: mergeDirective.verdict,
            reviewId: mergeDirective.reviewId,
          });
          return false; // settled by merge directive → don't re-ask (SPEC-0050 DIR-4)
        }
      }
      return true;
    });

    // REVIEW-5 / CONNECT-15: if any review survives the decision check, PARK the whole block — apply
    // NO resolution until answered. Cascade cap (REVIEW-8): too many parks → set aside.
    if (liveReviews.length > 0) {
      const prior = await readConnectState(wt, key);
      let audit = auditLine({ runId, blockKey: key, model, event: 'start' });
      if (prior.rounds >= maxReviewRounds) {
        audit += auditLine({ runId, blockKey: key, event: 'setaside', reason: 'review-cascade-cap', rounds: prior.rounds });
        await appendBlockAudit(wt, key, audit);
        await wtGit.raw('add', '-A');
        await wtGit.commit(`connect: set aside ${key} (review cascade cap)`);
        log.warn('connect.setaside', { runId, itemId: key, reason: 'review-cascade-cap', rounds: prior.rounds });
        result = { blockKey: key, ok: false, nodeRels: [], deletedNodeRels: [], setAside: true };
        return true;
      }
      const createdAt = new Date().toISOString();
      const reviewIds: string[] = [];
      for (const req of liveReviews) {
        const id = ulid();
        // REVIEW-16: enrich the agent's per-candidate glosses into decision-grade subject context —
        // join each {id, gloss} to its candidate's name + resolved source title (PRIN-24: shown, never
        // the ULID) + source-FILE rel (the working Obsidian link — `<dir>/source.md`, the readable note;
        // a bare dir is "file not found"). Unknown ids (an agent naming a candidate outside its set) are
        // dropped, never surfaced as a bare ULID-as-name. The agent authors the gloss; the stage owns the
        // name, the deterministic file path, and the persisted title.
        const subjectCandidates = (
          await Promise.all(
            (req.candidates ?? []).map(async (rc): Promise<ReviewSubjectCandidate | null> => {
              const cand = candidateById.get(rc.id);
              if (!cand) return null;
              return {
                name: cand.name,
                gloss: rc.gloss,
                title: await resolveCandidateTitle(wt, cand),
                sourceRel: sourceFileRel(cand.sourceId),
              };
            }),
          )
        ).filter((c): c is ReviewSubjectCandidate => c !== null);
        const review: Review = {
          id,
          status: 'open',
          question: req.question,
          detail: req.detail,
          raisedBy: {
            stage: STAGE,
            runId,
            item: { kind: 'block', ref: key },
            auditRel: blockAuditRel(key), // SCALE-5: the answer path appends `review-answered` to the per-block file

            // REVIEW-18: a disambiguation review carries the decided entity-PAIR on its markerKey so the
            // answer path records a durable per-pair decision (`confirm`→same, `reject`→distinct) keyed by it.
            markerKey: { blockKey: key, ...(req.pair ? { pairA: req.pair[0], pairB: req.pair[1] } : {}) },
          },
          subject: {
            ...(req.refs ? { refs: req.refs } : {}),
            ...(subjectCandidates.length > 0 ? { candidates: subjectCandidates } : {}),
          },
          createdAt,
        };
        await writeReviewFile(path.join(wt, reviewRel(id)), review);
        reviewIds.push(id);
        audit += auditLine({ runId, blockKey: key, model, event: 'review-raised', reviewId: id, question: req.question });
      }
      audit += auditLine({ runId, blockKey: key, event: 'awaiting-review', reviewIds, round: prior.rounds + 1 });
      await appendBlockAudit(wt, key, audit);
      await wtGit.raw('add', '-A');
      await wtGit.commit(`connect: parked ${key} for review (${reviewIds.length})`);
      result = { blockKey: key, ok: true, nodeRels: [], deletedNodeRels: [], setAside: false, parked: true };
      return true;
    }

    const now = new Date().toISOString();
    const takenRels = new Set(nodes.map((n) => n.rel));
    const nodeRels: string[] = [];
    const deletedNodeRels: string[] = [];
    const consumedCandidateIds: string[] = [];
    let audit = auditLine({ runId, blockKey: key, model, event: 'start' });

    for (const cluster of decision.clusters) {
      const members = cluster.memberCandidateIds.map((id) => candidateById.get(id)).filter((c): c is Candidate => !!c);
      const memberSources = members.map((m) => sourceDirRel(m.sourceId)); // source-DIR paths (CLAIMS-5)
      consumedCandidateIds.push(...members.map((m) => m.id));

      // Merge targets: the fold-into node + any explicit merge-existing nodes (CONNECT-9/10).
      const mergeIds = unionOrdered(cluster.existingNodeId ? [cluster.existingNodeId] : [], cluster.mergeExistingNodeIds ?? []);
      const mergeTargets = mergeIds.map((id) => nodeById.get(id)).filter((n): n is LocatedNode => !!n);
      // Canonical = the fold-into node if given & present, else the oldest (smallest id) merge node, else new.
      const canonical: LocatedNode | undefined =
        (cluster.existingNodeId ? nodeById.get(cluster.existingNodeId) : undefined) ??
        [...mergeTargets].sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      const losers = mergeTargets.filter((n) => !canonical || n.id !== canonical.id);

      const id = canonical?.id ?? ulid();

      // SPEC-0025 META S1b: the curated scope/sensitivity property VALUES, carried from the node's member
      // sources (Connect is the authoritative metadata writer, META-4). Regenerated WHOLE each resolve so
      // re-pokes/merges converge (idempotent):
      //  • sensitivity = MOST-RESTRICTIVE across the member sources AND the prior canonical value (SENSE-3
      //    `restrictiveness`; monotonic → once `internal`/higher it stays, so it converges). Unknown labels
      //    already resolve most-restrictive in the comparator (unknown ≠ safe).
      //  • scope = the value shared by ALL member sources when they're uniform; else the prior canonical
      //    scope (best-effort — an ambiguous mix keeps the settled value rather than thrashing).
      const priorProps = canonical?.properties ?? {};
      const memberSensitivities = members.map((m) => sourceProps[m.sourceId]?.sensitivity).filter((s): s is string => !!s);
      // SECURITY (QD-2): include the LOSERS' sensitivity in the most-restrictive pool. A merge folds the
      // loser nodes into the canonical (their sources land in `resolvedFrom`), so a loser's `internal` must
      // survive — else merging an internal entity into a shareable one would DOWN-classify the result and
      // over-share internal-sourced material on the egress facet. Monotonic-converges holds along the
      // canonical's lineage; this closes the cross-merge gap where the restrictive value sits on a loser.
      const loserSensitivities = losers.map((l) => l.properties?.sensitivity).filter((s): s is string => !!s);
      const sensPool = [...memberSensitivities, ...loserSensitivities, ...(priorProps.sensitivity ? [priorProps.sensitivity] : [])];
      const sensitivity = sensPool.length > 0 ? sensPool.reduce((a, b) => (restrictiveness(b) > restrictiveness(a) ? b : a)) : undefined;
      const memberScopes = [...new Set(members.map((m) => sourceProps[m.sourceId]?.scope).filter((s): s is string => !!s))];
      const scope = memberScopes.length === 1 ? memberScopes[0] : priorProps.scope;

      // SPEC-0025 META S2: entity event dates. The agent coins fresh `{label,value}` (normalized →
      // full-date + inferred precision); folded WHOLE by label across re-resolves/merges (idempotent —
      // canonical's existing date for a label wins/sticks, fresh adds new labels, losers fill the rest, so
      // a merge keeps both nodes' dates). Like tags: regenerated each pass, no extra agent call.
      const freshDates = normalizeEventDates(cluster.dates ?? []);
      const dateByLabel = new Map<string, EventDate>();
      for (const d of [...(canonical?.dates ?? []), ...freshDates, ...losers.flatMap((l) => l.dates ?? [])]) {
        if (!dateByLabel.has(d.label)) dateByLabel.set(d.label, d);
      }
      const dates = [...dateByLabel.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

      const node: EntityNode = {
        id,
        kind,
        name: cluster.canonicalName,
        confidence: cluster.confidence,
        aliases: unionOrdered(
          canonical?.aliases ?? [id],
          unionOrdered(
            losers.flatMap((l) => unionOrdered([l.id], l.aliases)),
            // fold prior canonical name + loser names as alias breadcrumbs (skip the new name)
            [canonical?.name ?? '', ...losers.map((l) => l.name)].filter((n) => n && n !== cluster.canonicalName),
          ),
        ),
        derivedFrom: unionOrdered(
          canonical?.derivedFrom ?? [],
          unionOrdered(losers.flatMap((l) => l.derivedFrom), memberSources),
        ),
        resolvedFrom: unionOrdered(
          canonical?.resolvedFrom ?? [],
          unionOrdered(losers.flatMap((l) => l.resolvedFrom), members.map((m) => m.id)),
        ),
        // SPEC-0025 META-2/4: the node's `tags:` = the deterministic curated core (`type/<kind>`)
        // + emergent topic tags the agent coined (normalized; META-3), folded over any prior/merged
        // tags. Regenerated WHOLE here so re-resolves/merges converge (idempotent).
        tags: unionOrdered(
          canonical?.tags ?? [],
          unionOrdered(
            losers.flatMap((l) => l.tags),
            [typeTag(kind), ...(cluster.tags ?? []).map(normalizeTag)].filter((t) => t.length > 0),
          ),
        ),
        // SPEC-0025 META v1/S1b: dynamic curated key-value Properties (scope/status/sensitivity). Carried
        // WHOLE across re-resolves/merges (idempotent): loser props fill gaps, canonical's prior wins, then
        // the freshly source-derived scope/sensitivity (computed above) layer on top. `status` is still
        // unpopulated (no value source yet) — only ride through if a prior value carried it.
        properties: {
          ...losers.reduce((acc, l) => ({ ...l.properties, ...acc }), {}),
          ...priorProps,
          ...(scope ? { scope } : {}),
          ...(sensitivity ? { sensitivity } : {}),
        },
        ...(dates.length > 0 ? { dates } : {}),
        createdAt: canonical?.createdAt || now,
        updatedAt: now,
        agent: decision.agent,
      };

      const rel = canonical?.rel ?? entityFileRel(kind, cluster.canonicalName, id, takenRels);
      takenRels.add(rel);
      const dest = path.join(wt, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // Preserve any existing generated blocks (claims) on the canonical node; we only (re)write identity.
      let body = '';
      if (canonical) {
        const existing = await fs.readFile(path.join(wt, canonical.rel), 'utf8');
        const afterFm = existing.indexOf('\n---', 3);
        const bodyAfterHeading = afterFm === -1 ? '' : existing.slice(afterFm + 4).replace(/^\s*#[^\n]*\n?/, '');
        body = bodyAfterHeading.trim();
      }
      const rendered = renderEntityNode(node);
      await fs.writeFile(dest, body ? `${rendered}\n${body}\n` : rendered, 'utf8');
      nodeRels.push(rel);

      // CONNECT-10/11: repoint losers' claims to the canonical node, regenerate its claims block,
      // then delete the loser files — via the shared `mergeNodes` core (one impl, also used by
      // Reflect's approved consolidation, SPEC-0024 REFLECT-7). Losers here are located nodes that
      // exist, so `deleted` mirrors the loser set; the deletion-aware gate propagates it to `main`.
      if (losers.length > 0) {
        const { deleted } = await mergeNodes(wt, rel, losers.map((l) => l.rel));
        deletedNodeRels.push(...deleted);
      }

      audit += auditLine({
        runId,
        blockKey: key,
        model,
        event: 'resolved',
        node: rel,
        candidates: members.length,
        merged: losers.length,
        tags: node.tags, // SPEC-0025 META-10: provenance — which tags this resolve set on the node
      });
    }

    // Consume candidates: delete their files (commit-to-dequeue; CONNECT-17). Lineage survives
    // in each node's resolvedFrom + git history.
    for (const id of consumedCandidateIds) {
      const cand = candidateById.get(id);
      if (cand) await fs.rm(path.join(wt, 'candidates', dateShard(cand.id), `${cand.id}.json`), { force: true });
    }

    for (const sig of decision.signals ?? []) {
      audit += auditLine({ runId, blockKey: key, model, event: 'signal', type: sig.type, note: sig.note, refs: sig.refs });
    }
    audit += auditLine({ runId, blockKey: key, model, event: 'connected', clusters: decision.clusters.length });
    await appendBlockAudit(wt, key, audit);

    await wtGit.raw('add', '-A');
    await wtGit.commit(`connect: ${key} → ${nodeRels.length} node(s)${deletedNodeRels.length ? `, merged ${deletedNodeRels.length}` : ''}`);
    result = { blockKey: key, ok: true, nodeRels, deletedNodeRels, setAside: false };
    return true;
  } catch (err) {
    // CONNECT-14 / ORCH-12: never lose candidates. Discard partial worktree writes, record the
    // failed attempt durably; set aside after K so a poison block can't head-of-line-block.
    try {
      await wtGit.raw('reset', '--hard', checkpoint);
      await wtGit.raw('clean', '-fd');
    } catch {
      /* best-effort cleanup; the failed/setaside commit below is what matters */
    }
    const error = err instanceof Error ? err.message : String(err);
    const attempt = (await readConnectState(wt, key)).failures + 1;
    const setAside = attempt >= maxAttempts;
    let audit = auditLine({ runId, blockKey: key, event: 'failed', attempt, error });
    if (setAside) audit += auditLine({ runId, blockKey: key, event: 'setaside', attempts: attempt });
    await appendBlockAudit(wt, key, audit);
    // OBS-4: verbose cause for the structured failed/setaside audit, cross-linked by runId (OBS-3).
    log.error('connect.failed', { runId, itemId: key, attempt, setAside, err });
    await wtGit.raw('add', '-A');
    await wtGit.commit(`connect: failed ${key} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
    result = { blockKey: key, ok: false, nodeRels: [], deletedNodeRels: [], setAside, error };
    return true;
  }
  };

  // ORCH-19 collision exhaustion: the block lost the same-path race past K retries. Persist a set-aside
  // marker (a disjoint PER-BLOCK audit append → converges) and advance it, so the poison block can't
  // head-of-line-block. CHECK the advance outcome + retry against a fresh checkpoint; NEVER report
  // setAside without the marker landing (QA #45 / the "never silently swallowed" gate condition) — if it
  // truly can't persist, THROW so the systemic failure surfaces instead of a poison block silently
  // re-queuing on inaccurate `setAside:true` telemetry.
  const onExhausted = async (): Promise<void> => {
    for (let i = 0; i <= DEFAULT_MAX_COLLISION_RETRIES; i++) {
      const base = await canonicalHead(root);
      const outcome = await withEphemeralWorktree(root, STAGE, base, async ({ wt, workBranch }) => {
        const wtGit = simpleGit(wt);
        await appendBlockAudit(wt, key, auditLine({ runId, blockKey: key, event: 'setaside', reason: 'collision-exhausted' }));
        await wtGit.raw('add', '-A');
        await wtGit.commit(`connect: set aside ${key} (collision-exhausted)`);
        return lock.run(() => advanceOrCollide(root, workBranch, base), 'connect:setaside-advance');
      });
      if (outcome === 'advanced') {
        log.warn('connect.setaside', { runId, itemId: key, reason: 'collision-exhausted' });
        result = { blockKey: key, ok: false, nodeRels: [], deletedNodeRels: [], setAside: true };
        return;
      }
      // 'collision' → the per-block marker raced the canonical moving; re-sync + retry.
    }
    throw new Error(`connect: could not persist collision-exhausted set-aside for ${key}`);
  };

  // cap>1 safe: each attempt prepares in its own ephemeral worktree; the advance serializes under `lock`.
  await withConcurrentAdvance({ root, lock, stage: STAGE, label: 'connect:advance', log }, prepare, onExhausted);
  return result;
}

// ── Link promotion (CONNECT-12/13): relatesTo hints → real Obsidian [[wikilinks]] ───────────

export interface LinkOneResult {
  nodeRel: string;
  changed: boolean; // false when the node was byte-identical AND no review was raised (idempotent no-op)
  links: number; // resolved [[wikilink]]s rendered
  unresolved: string[]; // hints left as `note` signals: zero-match unknowns + reject-declined ambiguities (CONNECT-13)
  reviewsRaised: number; // ambiguous (>1 match) hints escalated to a yes/no Review this pass (CONNECT-15)
}

/**
 * The link-promotion queue (CONNECT-12): canonical nodes whose claims carry ≥1 `relatesTo` hint.
 * Idempotency (no churn on already-linked nodes) is NOT enforced here — `linkOne` is a no-op when
 * the regenerated node is unchanged, so re-queuing a done node is cheap. Sorted for deterministic
 * drains. A hint whose subject points at a since-merged loser node is dropped (node must exist).
 */
export async function readLinkQueue(root: string): Promise<string[]> {
  root = path.resolve(root);
  const claims = await readClaims(root);
  const subjects = new Set<string>();
  for (const c of claims) if (c.relatesTo.length > 0) subjects.add(c.subject);
  const existing = new Set((await readEntityNodes(root)).map((n) => n.rel));
  return [...subjects].filter((rel) => existing.has(rel)).sort();
}

/** The pure read+compute half of `linkOne` (#507 item 2): given ANY readable root reflecting the
 *  canonical tree (the linked link-worktree post-reset, or the canonical worktree itself for an
 *  off-lock check), works out whether the node needs anything done at all — with zero writes. Factored
 *  out so the off-lock prefilter (`linkOneWouldChange`) and the real on-lock write path (`linkOne`)
 *  share ONE implementation — they can never drift out of sync on what counts as "byte-stable". */
interface LinkOnePlan {
  nodeExists: boolean;
  nodeChanged: boolean;
  newMd: string; // meaningful only when nodeChanged
  links: NodeLink[];
  unresolved: string[]; // zero-match unknowns + reject-declined ambiguities → note (CONNECT-13)
  toRaise: { hint: string; targetRel: string; nodeName: string; targetName: string; candidateNames: string }[];
}

async function planLinkOne(readRoot: string, nodeRel: string): Promise<LinkOnePlan> {
  const nodePath = path.join(readRoot, nodeRel);
  let nodeMd: string;
  try {
    nodeMd = await fs.readFile(nodePath, 'utf8');
  } catch {
    return { nodeExists: false, nodeChanged: false, newMd: '', links: [], unresolved: [], toRaise: [] }; // node gone (merged away)
  }

  // Collect this node's claims' relatesTo hints (de-duped, order-preserved).
  const claims = await readClaims(readRoot);
  const hints = unionOrdered(
    [],
    claims.filter((c) => c.subject === nodeRel).flatMap((c) => c.relatesTo),
  );

  // Index every OTHER canonical node by normalized name (target resolution) + every node by rel
  // (display names + existence checks). Sort each name group so the "first match" we propose for an
  // ambiguous hint is deterministic across runs.
  const byName = new Map<string, string[]>();
  const nameByRel = new Map<string, string>();
  for (const n of await readEntityNodes(readRoot)) {
    nameByRel.set(n.rel, n.name);
    if (n.rel === nodeRel) continue; // never self-link
    // COHERE-1: index canonical name AND aliases — a hint/woven link naming an entity by an alias
    // (e.g. a nickname) resolves too (coverage). A collision across nodes stays AMBIGUOUS → review,
    // never a wrong-guess (CONNECT-13 preserved by the existing multi-match handling below).
    const keys = new Set([normalizeName(n.name), ...n.aliases.map(normalizeName)].filter((k) => k.length > 0));
    for (const key of keys) {
      const arr = byName.get(key);
      if (arr) {
        if (!arr.includes(n.rel)) arr.push(n.rel);
      } else byName.set(key, [n.rel]);
    }
  }
  for (const arr of byName.values()) arr.sort();

  // CONNECT-15: this node's existing link-Reviews, keyed by hint — so an ambiguous hint already
  // asked is never re-raised, an answered one renders/declines, and an open one stays parked.
  const reviewByHint = new Map<string, Review>();
  for (const r of await readAllReviews(readRoot)) {
    const mk = r.raisedBy.markerKey;
    if (mk.kind === 'link' && mk.nodeRel === nodeRel && mk.hint) reviewByHint.set(mk.hint, r);
  }

  const links: NodeLink[] = [];
  const unresolved: string[] = [];
  const toRaise: LinkOnePlan['toRaise'] = [];
  const linkedTargets = new Set<string>();
  const addLink = (rel: string): void => {
    if (!linkedTargets.has(rel)) {
      // VAULT-12: carry the target's display name so the block renders `[[path|Name]]` (the path
      // resolves collision-safe; the human sees the entity name, not the raw path).
      links.push({ targetRel: rel, name: nameByRel.get(rel) });
      linkedTargets.add(rel);
    }
  };
  for (const hint of hints) {
    const matches = byName.get(normalizeName(hint)) ?? [];
    if (matches.length === 1) {
      addLink(matches[0]);
    } else if (matches.length === 0) {
      unresolved.push(hint); // unknown target → note, never a dangling guess (CONNECT-13)
    } else {
      // Ambiguous: >1 entity shares this normalized name (e.g. two distinct "John Smith"). Never
      // guess which — escalate to a yes/no Review (CONNECT-15), resuming from any answer.
      const existing = reviewByHint.get(hint);
      if (existing?.status === 'answered') {
        const target = existing.raisedBy.markerKey.targetRel;
        if (existing.answer?.verdict === 'confirm' && target && target !== nodeRel && nameByRel.has(target)) {
          addLink(target); // Principal confirmed the proposed target (still present) → render it
        } else {
          unresolved.push(hint); // rejected, or the confirmed target has since merged away → note
        }
      } else if (existing?.status === 'open') {
        // parked — awaiting the Principal; render nothing, raise nothing
      } else {
        // first encounter → ask (names resolved now so the write path never needs `nameByRel` again)
        toRaise.push({
          hint,
          targetRel: matches[0],
          nodeName: nameByRel.get(nodeRel) ?? nodeRel,
          targetName: nameByRel.get(matches[0]) ?? matches[0],
          candidateNames: matches.map((r) => nameByRel.get(r) ?? r).join(', '),
        });
      }
    }
  }
  links.sort((a, b) => (a.targetRel < b.targetRel ? -1 : 1)); // deterministic block order

  // COHERE-1: resolve BARE woven `[[Name]]` links in the prose (Compose writes display-name links that
  // Obsidian can't resolve to the kind-subdir entity path → they render dead). Rewrite to `[[rel|Name]]`
  // on a UNIQUE entity match; unknown/ambiguous stay bare (CONNECT-13). Uses the same name+alias index.
  const resolveBare = (name: string): string | null => {
    const matches = byName.get(normalizeName(name)) ?? [];
    return matches.length === 1 ? matches[0] : null; // unique → path; unknown/ambiguous → leave bare
  };
  const proseResolved = resolveProseWikilinks(nodeMd, resolveBare);
  const newMd = applyLinksBlock(proseResolved, links);
  return { nodeExists: true, nodeChanged: newMd !== nodeMd, newMd, links, unresolved, toRaise };
}

/**
 * #507 item 2: off-lock, read-only byte-stable check — is there ANYTHING for `linkOne` to actually do
 * for this node? Reads directly from `root` (the canonical worktree, which always reflects the last-
 * committed state — no worktree-ensure/reset needed since this never mutates). Lets a drain skip taking
 * the shared lock entirely for a node that would just no-op, instead of paying a full worktree-ensure +
 * O(N) entity/claims/review read UNDER the lock only to find nothing changed — the mechanism behind
 * "capture queues behind the sweep" (PERF-E3). `linkOne` re-verifies fresh right before committing, so a
 * stale off-lock read only ever costs a missed skip (still correct), never a wrong write.
 */
export async function linkOneWouldChange(root: string, nodeRel: string): Promise<boolean> {
  const plan = await planLinkOne(path.resolve(root), nodeRel);
  return plan.nodeExists && (plan.nodeChanged || plan.toRaise.length > 0);
}

/**
 * Promote ONE canonical node's claims' `relatesTo` hints into a regenerated `[[wikilinks]]` block
 * (CONNECT-12). DETERMINISTIC (no agent): each hint name is resolved by normalized name to a
 * canonical node — exactly-one match → a wikilink; zero match (unknown) → a `note` signal, never a
 * dangling guess (CONNECT-13). An **ambiguous** hint (>1 same-named entity) is never guessed: it
 * escalates to a yes/no Review proposing the first match (CONNECT-15) and renders nothing until the
 * Principal answers — confirm → render that target, reject → leave a `note`. The Review's plan rides
 * in its `markerKey` ({kind:'link', nodeRel, hint, targetRel}); this pass is idempotent — it reads
 * the node's existing link-Reviews and never re-raises a hint already asked. The block is
 * regenerated WHOLE, so the node is byte-stable across re-pokes: nothing-to-do is a no-op.
 * MUST be called serialized via the shared canonical-writer lock so the base branch is steady.
 * NOTE: unlike the other stages, the link pass stays COARSE-LOCKED (whole cycle under the lock) —
 * it CONSUMES Claims' `relatesTo` output, so making it optimistic/concurrent with Claims is a
 * producer-consumer ordering concern that needs its own design (deferred slice-2 follow-up).
 */
export async function linkOne(root: string, nodeRel: string, log: DevLog = noopDevLog): Promise<LinkOneResult> {
  root = path.resolve(root);
  const { wt, base } = await ensureWorktree(root);
  const wtGit = boundedGit(wt); // #163: bounded — runs under the canonical-writer lock
  await wtGit.raw('reset', '--hard', base); // sync to the base branch HEAD
  await wtGit.raw('clean', '-fd', 'entities', 'claims'); // drop stray files from a prior aborted run

  const plan = await planLinkOne(wt, nodeRel);
  if (!plan.nodeExists) {
    return { nodeRel, changed: false, links: 0, unresolved: [], reviewsRaised: 0 }; // node gone (merged away) — nothing to do
  }
  if (!plan.nodeChanged && plan.toRaise.length === 0) {
    return { nodeRel, changed: false, links: plan.links.length, unresolved: plan.unresolved, reviewsRaised: 0 }; // byte-stable + nothing to ask
  }

  const nodePath = path.join(wt, nodeRel);
  const runId = ulid();
  if (plan.nodeChanged) await fs.writeFile(nodePath, plan.newMd, 'utf8');
  let audit = auditLine({ runId, event: 'links-start', node: nodeRel });

  // Escalate each newly-ambiguous hint to a yes/no Review proposing the first match (CONNECT-15);
  // the markerKey carries the plan so a later (post-answer) link pass renders or declines it.
  for (const { hint, targetRel, nodeName, targetName, candidateNames } of plan.toRaise) {
    const id = ulid();
    const review: Review = {
      id,
      status: 'open',
      question: `Should "${nodeName}" link to "${targetName}"?`,
      detail: `"${nodeName}" relates to "${hint}", which matches multiple entities: ${candidateNames}. Confirm to link it to "${targetName}" (${targetRel}); reject to leave it unlinked.`,
      raisedBy: { stage: STAGE, runId, item: { kind: 'link', ref: nodeRel }, auditRel: AUDIT_REL, markerKey: { kind: 'link', nodeRel, hint, targetRel } },
      subject: {},
      createdAt: new Date().toISOString(),
    };
    await writeReviewFile(path.join(wt, reviewRel(id)), review);
    audit += auditLine({ runId, event: 'link-review-raised', node: nodeRel, hint, target: targetRel, reviewId: id });
  }
  for (const u of plan.unresolved) {
    audit += auditLine({ runId, event: 'signal', type: 'note', note: `unresolved link target: ${u}`, node: nodeRel });
  }
  audit += auditLine({ runId, event: 'linked', node: nodeRel, links: plan.links.length, unresolved: plan.unresolved.length, reviewsRaised: plan.toRaise.length });
  await appendAudit(wt, audit);
  await wtGit.raw('add', '-A');
  await wtGit.commit(
    `connect: links ${nodeRel} → ${plan.links.length} link(s)${plan.toRaise.length ? `, ${plan.toRaise.length} ambiguous→review` : ''}${plan.unresolved.length ? `, ${plan.unresolved.length} unresolved` : ''}`,
  );
  // Serialized canonical advance through the SAME ORCH-27 discipline every other writer uses (#256
  // second symptom): a raw `merge --ff-only` here bypassed the stale-`index.lock` self-heal +
  // sidecar guard, so a stale lock (the #256 wedge) made every link advance throw `connect.link-error`
  // — links never rendered — while decompose/connect self-healed. We're coarse-locked single-writer, so
  // head === checkpoint and advanceOrCollide takes the guarded ff path (heal-then-advance).
  const checkpoint = await canonicalHead(root);
  await advanceOrCollide(root, WORK_BRANCH, checkpoint, undefined, log);
  return { nodeRel, changed: true, links: plan.links.length, unresolved: plan.unresolved, reviewsRaised: plan.toRaise.length };
}

/**
 * Connect's post-Claims **within-source claim-dedup** pass (SPEC-0016 CLAIMS-19). Collapses
 * near-duplicate claims that share a source's provenance (the "same assertion restated per-entity"
 * over-extraction dogfooding surfaced) — deterministic, idempotent, grouped strictly by source so
 * cross-source claims are never merged (CLAIMS-17); the symmetric-relationship residual is left for
 * typed links (CONNECT-20) and only counted. Mirrors `linkOne`'s worktree discipline: reset to base,
 * run the pure pass on the worktree, then (only if it changed anything) commit + ff-merge the
 * canonical advance. A no-dupe vault is a byte-stable no-op. MUST be called serialized via the shared
 * canonical-writer lock. Returns the report (for the drain's audit/log) + whether it committed.
 */
export async function dedupClaimsOnce(root: string, log: DevLog = noopDevLog): Promise<DedupReport & { committed: boolean }> {
  root = path.resolve(root);
  const { wt, base } = await ensureWorktree(root);
  const wtGit = boundedGit(wt); // #163: bounded — runs under the canonical-writer lock
  await wtGit.raw('reset', '--hard', base);
  await wtGit.raw('clean', '-fd', 'entities', 'claims');

  const report = await applyClaimDedup(wt); // delete dropped claim files + regenerate affected blocks
  if (report.dropped === 0) return { ...report, committed: false }; // nothing collapsed → byte-stable no-op

  const runId = ulid();
  await appendAudit(
    wt,
    auditLine({
      runId,
      event: 'claim-dedup',
      dropped: report.dropped,
      kept: report.kept,
      affected: report.affectedSubjects.length,
      // The deferred symmetric-relationship residual → CONNECT-20 (logged, not acted on; PM ruling).
      relationalResidual: report.suspectedRelationalResidual,
    }),
  );
  await wtGit.raw('add', '-A');
  await wtGit.commit(`connect: dedup ${report.dropped} within-source duplicate claim(s)`);
  // Serialized canonical advance through the ORCH-27 discipline (heal stale `index.lock` + sidecar
  // guard), same as linkOne — a raw `merge --ff-only` here had the same #256-wedge blind spot.
  const checkpoint = await canonicalHead(root);
  await advanceOrCollide(root, WORK_BRANCH, checkpoint, undefined, log);
  return { ...report, committed: true };
}

export interface OrphanLinkReport {
  /** Orphan nodes considered (degree-0, not owned by the link-promotion pass). */
  orphans: number;
  /** Orphan nodes that received ≥1 discovered link this pass. */
  linked: number;
  /** Total discovered `[[wikilink]]` edges rendered. */
  links: number;
  /** Whether the pass committed + advanced (false ⇒ byte-stable no-op). */
  committed: boolean;
}

/** Tunable knobs for the orphan linker (anti-hairball precision gates) — defaults in `entityAffinity`.
 *  `blocked` is the SPEC-0050 suppression seam (DEV-7): a predicate forbidding a settled-`distinct`
 *  pair. When DEV-7's `pairDirective` store lands, the wiring reads it once + closes over it here;
 *  until then it's absent (link freely). */
export type OrphanLinkConfig = Pick<OrphanLinkOptions, 'minScore' | 'maxLinksPerOrphan' | 'blocked'>;

/**
 * SPEC-0051 slice-2 — the **orphan-RAG linker** ("the prize"). The link-promotion pass (`linkOne`)
 * only wires entities that Claims gave a `relatesTo` hint; the long tail of entities with NO stated
 * relationship stays orphaned (degree-0 islands — ~89% of the vault at dispatch). This pass recovers
 * that tail by RETRIEVING grounded candidate relations and rendering them as `[[wikilinks]]`:
 * co-mention (shared `derivedFrom` source provenance) + shared `topic/` tags, rarity-weighted so a
 * broad source/tag can't manufacture a hairball (`entityAffinity`). It is deterministic (no agent →
 * no hallucinated edge), conservative (an orphan with no qualifying evidence stays unlinked — the
 * don't-false-link bar), and capped (≤ `maxLinksPerOrphan` per node → bounded degree growth).
 *
 * Domain boundary (no clobber): we SKIP any node carrying `relatesTo` hints — those belong to
 * `linkOne`, which owns and regenerates their link block (and leaving a stated-but-unresolved
 * relationship unlinked is correct per CONNECT-13, not something to override with a guess). So the
 * two passes write disjoint sets of nodes and neither stomps the other's block.
 *
 * Idempotent: once an orphan gets a discovered link it is no longer degree-0, so a later pass skips
 * it and the block is byte-stable. Mirrors `dedupClaimsOnce`'s bulk worktree discipline — one reset,
 * one commit, one ORCH-27 canonical advance (never a raw ff — the #256/#293 wedge class). MUST be
 * called serialized via the shared canonical-writer lock.
 */
export async function linkOrphansOnce(root: string, log: DevLog = noopDevLog, config: OrphanLinkConfig = {}): Promise<OrphanLinkReport> {
  root = path.resolve(root);
  const { wt, base } = await ensureWorktree(root);
  const wtGit = boundedGit(wt); // #163: bounded — runs under the canonical-writer lock
  await wtGit.raw('reset', '--hard', base);
  await wtGit.raw('clean', '-fd', 'entities', 'claims');

  // Read every entity node ONCE (body + parsed fields). The body feeds the existing-graph build
  // (so we orphan-detect against the real current link structure) AND the per-orphan block rewrite.
  const nodes = await readEntityNodes(wt);
  const bodyByRel = new Map<string, string>();
  await Promise.all(
    nodes.map(async (n) => {
      try {
        bodyByRel.set(n.rel, await fs.readFile(path.join(wt, n.rel), 'utf8'));
      } catch {
        /* node vanished mid-pass — drop it; the next sweep re-reads */
      }
    }),
  );
  const present = nodes.filter((n) => bodyByRel.has(n.rel));
  if (present.length === 0) return { orphans: 0, linked: 0, links: 0, committed: false };

  const { edges } = buildEntityGraph(present.map((n) => ({ path: n.rel, body: bodyByRel.get(n.rel)! })));
  const affEntities: AffinityEntity[] = present.map((n) => ({
    id: n.rel,
    name: n.name,
    kind: n.kind,
    derivedFrom: n.derivedFrom,
    topicTags: topicTagsOf(n.tags),
  }));
  const nameByRel = new Map(present.map((n) => [n.rel, n.name]));

  // SKIP nodes the link-promotion pass owns (any with a `relatesTo` hint) — disjoint domains, no clobber.
  const skip = new Set(await readLinkQueue(root));

  const plans = planOrphanLinks(affEntities, edges, { ...config, skip });
  // Count the orphans we actually considered (degree-0 ∧ not skipped) for the report/audit.
  const incident = new Set<string>();
  for (const e of edges) {
    incident.add(e.from);
    incident.add(e.to);
  }
  const orphanCount = present.filter((n) => !incident.has(n.rel) && !skip.has(n.rel)).length;

  if (plans.length === 0) return { orphans: orphanCount, linked: 0, links: 0, committed: false };

  let totalLinks = 0;
  let audit = '';
  const runId = ulid();
  for (const plan of plans) {
    const body = bodyByRel.get(plan.orphan);
    if (body === undefined) continue;
    const links: NodeLink[] = plan.links.map((c) => ({ targetRel: c.id, name: nameByRel.get(c.id) }));
    links.sort((a, b) => (a.targetRel < b.targetRel ? -1 : 1)); // deterministic block order (matches linkOne)
    const newMd = applyLinksBlock(body, links);
    if (newMd === body) continue; // already carries exactly these links — byte-stable
    await fs.writeFile(path.join(wt, plan.orphan), newMd, 'utf8');
    totalLinks += links.length;
    for (const c of plan.links) {
      audit += auditLine({
        runId,
        event: 'orphan-linked',
        node: plan.orphan,
        target: c.id,
        score: Number(c.score.toFixed(3)),
        sources: c.sharedSources.length,
        topics: c.sharedTopicTags.length,
      });
    }
  }
  if (totalLinks === 0) return { orphans: orphanCount, linked: 0, links: 0, committed: false };

  audit = auditLine({ runId, event: 'orphan-link-start', orphans: orphanCount, linked: plans.length }) + audit;
  await appendAudit(wt, audit);
  await wtGit.raw('add', '-A');
  await wtGit.commit(`connect: orphan-link ${plans.length} node(s) → ${totalLinks} discovered link(s)`);
  // Serialized canonical advance through the SAME ORCH-27 discipline every other writer uses (#256
  // second symptom) — a raw `merge --ff-only` here had the stale-`index.lock` wedge blind spot.
  const checkpoint = await canonicalHead(root);
  await advanceOrCollide(root, WORK_BRANCH, checkpoint, undefined, log);
  return { orphans: orphanCount, linked: plans.length, links: totalLinks, committed: true };
}

/**
 * Owns a vault's Connect stage: a poke/sweep drain loop sharing the canonical-writer lock with
 * the other stages (SPEC-0014 §5). Restartable: re-reads the derived queue and resumes.
 */
export class ConnectStage {
  private readonly root: string;
  private readonly decider: ConnectDecider;
  private readonly lock: Mutex;
  private readonly maxAttempts: number;
  private cap: number; // SPEC-0048 SCALE-1/5: mutable for live-apply (see setCap); resolve drain slices `cap` per pass
  private readonly afterDrain?: () => Promise<void>;
  private readonly log: DevLog;
  private readonly tracer: Tracer;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private pending = false;
  private current: Promise<void> | null = null;
  private drainStartedAt: string | null = null; // when the active drain began (OBS/VIZ in-flight dwell)
  // INGEST-PERF item 1: memoize the O(N) candidate/node walk against the canonical HEAD sha — both
  // call sites share it, and an idle sweep on an unchanged canonical skips the walk entirely.
  private readonly queueCache = new CanonicalQueueCache<CandidateSet[]>();
  // #507: same HEAD-memo pattern for the link-promotion queue (readLinkQueue) — it's an O(N)
  // claims+entities walk called at least once per sweep (plus again inside linkOrphansOnce's skip-set).
  private readonly linkQueueCache = new CanonicalQueueCache<string[]>();
  // #507: the canonical HEAD at which the link/orphan/dedup tail last found NOTHING to do. All three
  // are pure functions of the canonical tree (same invariant as queueCache above) — every mutation any
  // of them could make lands as a canonical commit, so an unchanged HEAD since the last fully-converged
  // pass guarantees there is still nothing to do, and the WHOLE tail (readLinkQueue's O(N) walk +
  // linkOrphansOnce/dedupClaimsOnce's own worktree-ensure+reads) can be skipped — not just cached, SKIPPED
  // entirely (0 git spawns, 0 entity/claim reads) — the PERF-E3 fix (was ~600 spawns + ~1.2M reads per
  // idle sweep at 1k entities, every 30s, forever).
  private lastConvergedConnectSweepHead: string | null = null;
  private tailSkips = 0; // #507 telemetry: sweeps that skipped the tail outright (see connectSweepTailStats)
  private tailRuns = 0;

  /**
   * @param afterDrain optional hook run (serialized under the shared lock) after a drain that
   *   resolved ≥1 block. The pipeline passes the promotion gate here so newly-resolved evergreen
   *   `entities/` are published `staging`→`main` (STAGING-3/11) — otherwise resolved nodes would
   *   sit on `staging`, invisible to Obsidian/`main`. Mirrors the Orchestrator's `afterDrain`.
   */
  constructor(
    root: string,
    decider: ConnectDecider = makeConnectDecider(),
    lock: Mutex = new Mutex(),
    maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
    afterDrain?: () => Promise<void>,
    log: DevLog = noopDevLog,
    tracer: Tracer = noopTracer,
    cap: number = DEFAULT_STAGE_CAP, // SPEC-0048 SCALE-5: resolve-stage concurrency (appended so existing call sites are unaffected)
  ) {
    this.root = path.resolve(root);
    this.decider = decider;
    this.lock = lock;
    this.maxAttempts = maxAttempts;
    this.cap = Math.max(1, Math.floor(cap));
    this.afterDrain = afterDrain;
    this.log = log.child({ scope: 'connect' });
    this.tracer = tracer;
  }

  /** Live-apply the resolve-stage concurrency cap (SPEC-0048 SCALE-4): the next drain pass slices this
   *  many blocks per batch, so a Settings change applies without a restart. The link/dedup sweeps stay
   *  serial under the lock regardless (SCALE-5 — they still share a fixed worktree). */
  setCap(cap: number): void {
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** The current resolve-stage cap (Status VIZ-2 / diagnostics). */
  getCap(): number {
    return this.cap;
  }

  /** INGEST-PERF item 1 perf proof/telemetry: queue reads served from the canonical-HEAD memo
   *  (`hits` = O(N) walks skipped) vs recomputed (`misses` = walks actually run). */
  queueCacheStats(): { hits: number; misses: number } {
    return { hits: this.queueCache.hits, misses: this.queueCache.misses };
  }

  /** #507 perf proof/telemetry: how many sweeps skipped the WHOLE link/orphan/dedup tail outright
   *  (canonical HEAD unchanged since it last converged) vs actually ran it. */
  connectSweepTailStats(): { skipped: number; ran: number } {
    return { skipped: this.tailSkips, ran: this.tailRuns };
  }

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

  /** Is this stage actively draining right now? (OBS-5 per-stage `running` state.) */
  busy(): boolean {
    return this.draining;
  }

  /** When the current drain began (ISO), or null when idle (SPEC-0032 VIZ-2 in-flight dwell). */
  currentSince(): string | null {
    return this.drainStartedAt;
  }

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
      this.log.error('connect.drain-fatal', { err });
    } finally {
      this.draining = false;
      this.drainStartedAt = null;
      this.current = null;
    }
  }

  private async drainOnce(): Promise<void> {
    let worked = false;
    try {
      let queue = await this.queueCache.read(this.root, () => readConnectQueue(this.root, this.maxAttempts));
      while (queue.length > 0) {
        // SCALE-5: resolve up to `cap` blocks CONCURRENTLY — each connectOne prepares OFF the lock in its
        // own ephemeral worktree (was a shared fixed worktree → cap pinned at 1), advances UNDER the shared
        // lock (cap=1 ⇒ serial, output-identical). OBS-12: each item's `stage.run` span wraps its decider's
        // `copilot.invoke` child (incl. collision re-runs).
        const batch = queue.slice(0, this.cap);
        // LOCUS DISTINCTION (#256): connectOne RETURNS for a per-item failure it could RECORD (set aside
        // after K — the writer is fine) → that item's span ends, the batch drains on. It THROWS only when
        // it could NOT record (a wedged writer/advance — SYSTEMIC) → the batch rejects → the catch stops
        // this pass (a later poke/sweep retries). A settled per-item failure never reaches the catch.
        await Promise.all(
          batch.map((item) => {
            const key = item.blockKey;
            const span = this.tracer.start(STAGE_RUN_OP, { stage: STAGE, itemId: key });
            return connectOne(this.root, key, this.decider, this.lock, this.maxAttempts, DEFAULT_MAX_REVIEW_ROUNDS, 0, this.log, span).then(
              (r) => {
                span.end(r.ok ? 'ok' : r.setAside ? 'setaside' : 'error', r.error);
                worked = true;
              },
              (err) => {
                span.end('error', err instanceof Error ? err.message : String(err));
                throw err; // systemic — propagate to stop the pass
              },
            );
          }),
        );
        queue = await this.queueCache.read(this.root, () => readConnectQueue(this.root, this.maxAttempts));
      }
    } catch (err) {
      // Systemic/unexpected (the queue read or canonical writer is wedged — affects EVERY item, not one).
      // Log it (a failed stage must be diagnosable, never a silent "N in queue, nothing happened") + stop
      // this pass; a later poke/sweep retries. Per-item failures are handled in connectOne (it RETURNS).
      this.log.error('connect.drain-error', { err });
      return;
    }
    // #507: HEAD-gate the ENTIRE link/orphan/dedup tail — skip it outright when the canonical HEAD is
    // unchanged since the last pass that found nothing to do (see `lastConvergedConnectSweepHead`
    // above). An idle vault then costs exactly one cheap HEAD read per sweep, not the full O(N)
    // claims/entities walk + per-node worktree-ensure that PERF-E3 measured at ~600 spawns + ~1.2M
    // reads every 30s at 1k entities.
    let headForGate: string | null;
    try {
      headForGate = await canonicalHead(this.root);
    } catch {
      headForGate = null; // unreadable → don't trust the gate, run the tail
    }
    if (headForGate === null || headForGate !== this.lastConvergedConnectSweepHead) {
      this.tailRuns += 1;
      // Set only when a node/pass couldn't be completed (retry-exhausted or a caught error) — i.e. we
      // genuinely don't know the post-pass state, so we must NOT cache a convergence point below and
      // must re-run in full next time, regardless of HEAD. A COMPLETED pass — whether or not it
      // committed anything — is always safe to cache: it fully re-derived + processed the ENTIRE queue
      // this call saw, so the fresh post-pass HEAD (re-read below) truly reflects "nothing left to do".
      let tailErrored = false;
      // Link-promotion pass (CONNECT-12): once blocks are resolved and Claims has left `relatesTo`
      // hints, promote them into `[[wikilinks]]`. Process each queued node once; `linkOne` is a
      // no-op when unchanged, so idle sweeps don't churn. Per-node failures are best-effort (a
      // later poke/sweep retries) and never abort the whole pass.
      for (const nodeRel of await this.linkQueueCache.read(this.root, () => readLinkQueue(this.root))) {
        // #507 item 2: off-lock byte-stable prefilter — most queued nodes are already fully linked
        // (linkOne would just no-op), so check WITHOUT the lock first; only a node that actually has
        // something to do pays for the lock hold. `linkOne` re-verifies fresh right before committing,
        // so a stale prefilter read only ever costs a missed skip, never a wrong write.
        if (!(await linkOneWouldChange(this.root, nodeRel))) continue;
        // A link write that hits the bounded-git BLOCK TIMEOUT under bulk-writer contention must NOT be
        // silently dropped — that leaves the entity permanently unlinked (no `[[wikilink]]` edge) until a
        // re-derive. Retry the node a bounded number of times in-pass (the lock is released between
        // attempts, so a transient contention spike eases); on exhaustion surface it LOUDLY (`error`, not
        // a swallowed `warn`) so it's visible + reconcilable (REFLECT-3/4). The node stays in the derived
        // link queue while unlinked, so the next sweep retries it once load drops.
        let landed = false;
        for (let attempt = 1; attempt <= LINK_WRITE_MAX_ATTEMPTS; attempt++) {
          try {
            const res = await this.lock.run(() => linkOne(this.root, nodeRel, this.log), 'connect:link');
            if (res.changed) worked = true;
            landed = true;
            break; // landed (or a byte-stable no-op) — done with this node
          } catch (err) {
            if (attempt < LINK_WRITE_MAX_ATTEMPTS) {
              this.log.warn('connect.link-retry', { itemId: nodeRel, attempt, err }); // transient (e.g. block timeout) → retry
            } else {
              this.log.error('connect.link-error', { itemId: nodeRel, attempt, err }); // exhausted; stays queued for the next sweep
            }
          }
        }
        if (!landed) tailErrored = true; // exhausted — this node still needs a retry, don't cache convergence
      }
      // Orphan-RAG linker (SPEC-0051 slice-2): once `linkOne` has wired every stated relationship,
      // recover the degree-0 tail by retrieving grounded candidate relations (co-mention + shared
      // topic tags, rarity-weighted) and rendering them as `[[wikilinks]]`. Coarse-locked + bulk like
      // dedup (one reset/commit/advance), deterministic, idempotent (a linked node is no longer an
      // orphan → skipped next sweep). Best-effort: a failure is logged and a later sweep retries — it
      // never aborts the rest of the drain.
      try {
        const orphan = await this.lock.run(() => linkOrphansOnce(this.root, this.log), 'connect:orphan-link');
        if (orphan.committed) {
          worked = true;
          this.log.info('connect.orphan-link', { orphans: orphan.orphans, linked: orphan.linked, links: orphan.links });
        }
      } catch (err) {
        tailErrored = true; // an error means we don't actually know convergence — don't cache a skip
        this.log.warn('connect.orphan-link-error', { err }); // best-effort; a later poke/sweep retries
      }
      // Within-source claim dedup (CLAIMS-19): collapse the "same assertion restated per-entity"
      // over-extraction once Claims has settled. Coarse-locked like link-promotion (it sweeps all
      // claims), deterministic (no copilot slot), idempotent. A drop must promote (deletions mirror to
      // `main` via the deletion-aware gate), so set `worked` when it committed. Best-effort: a failure
      // is logged and a later poke/sweep retries — it never aborts the rest of the drain.
      try {
        const dedup = await this.lock.run(() => dedupClaimsOnce(this.root, this.log), 'connect:dedup');
        if (dedup.committed) {
          worked = true;
          this.log.info('connect.claim-dedup', {
            dropped: dedup.dropped,
            affected: dedup.affectedSubjects.length,
            relationalResidual: dedup.suspectedRelationalResidual,
          });
        }
      } catch (err) {
        tailErrored = true; // an error means we don't actually know convergence — don't cache a skip
        this.log.warn('connect.claim-dedup-error', { err }); // best-effort; a later poke/sweep retries
      }
      if (tailErrored) {
        this.lastConvergedConnectSweepHead = null; // don't trust a skip until a clean pass re-verifies
      } else {
        // A COMPLETE pass (committed or not) — the fresh post-pass HEAD (any of the three above may
        // have advanced it) is the point we've converged to; cache it so an unchanged HEAD next sweep
        // skips the ENTIRE tail outright.
        try {
          this.lastConvergedConnectSweepHead = await canonicalHead(this.root);
        } catch {
          this.lastConvergedConnectSweepHead = null;
        }
      }
    } else {
      this.tailSkips += 1;
    }
    // Publish the now-resolved evergreen entities (+ repointed claims + links) staging→main
    // (STAGING-3/11), serialized under the shared lock so promotion never races a stage ref
    // advance. Gated on `worked` so idle sweeps don't churn the gate; promotion is idempotent.
    if (worked && this.afterDrain) await this.lock.run(() => this.afterDrain!(), 'connect:afterDrain');
  }
}
