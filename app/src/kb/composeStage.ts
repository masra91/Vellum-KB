// The Compose stage runtime (SPEC-0046 COMPOSE-7) — the final Enrich stage, after Claims. The SAME
// SPEC-0014 harness as Decompose/Claims (worktree isolation, a fresh disposable session per item,
// orchestrator-owns-effects, ff-advance under the shared canonical-writer lock), pointed at a
// different work-list (ORCH-9). Work unit = an ENTITY: read its cited claims, compose grounded
// encyclopedic prose, and (re)write ONLY the entity node's prose region (COMPOSE-1..5,8).
//
// Idempotent, regenerated on claim change (COMPOSE-7): the entity's claims block has a content
// SIGNATURE; an entity is "queued for compose" iff it has claims AND its current signature has not
// yet been composed (no `composed` marker for that sig). Recomposing the SAME claims is a no-op.
// When the claims change the signature changes → it re-composes. State is the entity's append-only
// source audit (keyed by entityId, stage='compose'), exactly where Claims records — no new store.
//
// Deterministic fallback (COMPOSE-7): if the Compose agent is unavailable / errors / returns
// un-grounded prose, the attempt is recorded and the node is LEFT as the structured blocks alone
// (today's behaviour) — never a hard failure, and never fabricated/un-grounded prose. After K
// failures for a given signature the entity is set aside for that signature (it re-tries when the
// claims next change). Compose performs NO egress — it reads internal claims only (SPEC-0046 §3).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import simpleGit from 'simple-git';
import { ulid } from './ulid';
import { CLAIMS_BLOCK_START, CLAIMS_BLOCK_END, oneLine } from './claimDoc';
import { LINKS_BLOCK_START, LINKS_BLOCK_END } from './connectDoc';
import { deriveSourceTitle } from './sourceDoc';
import { parseEntityNode, parseClaimBacklink, findEntityFiles } from './claimsStage';
import { blockKey } from './connect';
import { readCorrectionDirectives, readRevokeDirectives, isClaimSuppressedActive, readGuidanceDirectives, activeGuidanceForIdentity, GLOBAL_GUIDANCE_KEY } from './directives';
import { applyProse, renderProse, hasProse } from './composeDoc';
import type { CitedClaim } from './compose';
import { makeComposeDecider, type ComposeDecider, type ComposeInput } from './composeAgent';
import { Mutex } from './stageLock';
import { epochScopedLines } from './replayEpoch';
import { withConcurrentAdvance, withEphemeralWorktree, advanceOrCollide, canonicalHead, DEFAULT_STAGE_CAP, type PrepareContext } from './canonicalAdvance';
import { noopDevLog, type DevLog } from './devlog';
import { noopTracer, noopActiveSpan, STAGE_RUN_OP, type Tracer, type ActiveSpan } from './tracing';
import { CanonicalQueueCache } from './queueCache';
import { fastHeadSha } from './gitHeadFast';

const STAGE = 'compose';
/** Default attempts (per claims-signature) before an un-composable entity is set aside (ORCH-12). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Max entities composed in ONE drain pass before yielding + re-poking (COMPOSE-9 bounded-per-pass):
 *  a large backfill drains across several bounded passes, never one giant uninterruptible sweep. */
export const BACKFILL_SWEEP_CAP = 50;

/** One parsed compose audit line we care about (keyed by entityId, scoped to a claims signature). */
interface ComposeAuditLine {
  stage?: string;
  event?: string;
  entityId?: string;
  sig?: string;
}

/** The compose state for one entity AT a given claims signature (sig-scoped so a claim change — a
 *  new sig — starts fresh, never blocked by the prior content's failures). */
export interface ComposeState {
  composed: boolean; // a `composed` marker exists for this exact signature → no re-compose needed
  failures: number; // `failed` attempts recorded for this signature
  setAside: boolean; // gave up on this signature after K failures (re-tries when claims change)
}

/** The content signature of an entity's claims (everything between the claims-block markers). A
 *  change to any claim — added/removed/edited — changes the block text → a new signature → a
 *  re-compose. Returns '' when the entity has no claims block at all. */
export function claimsBlockSig(entityMd: string): string {
  const start = entityMd.indexOf(CLAIMS_BLOCK_START);
  if (start === -1) return '';
  const endMarker = entityMd.indexOf(CLAIMS_BLOCK_END, start);
  const block = entityMd.slice(start, endMarker === -1 ? undefined : endMarker + CLAIMS_BLOCK_END.length);
  return createHash('sha256').update(block).digest('hex').slice(0, 16);
}

/** The claim-file paths an entity's claims block references (its `[[claims/…]]` wikilinks). */
function claimBlockPaths(entityMd: string): string[] {
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

/** Whether the entity actually has derived claims (a real `[[claims/…]]` row, not just the
 *  placeholder) — only such entities are worth composing. */
export function hasClaims(entityMd: string): boolean {
  return claimBlockPaths(entityMd).length > 0;
}

/** The display names of the entities this one links to (from the generated links block) — handed to
 *  the agent so it can weave `[[Name]]` cross-links into the prose (COMPOSE-4). Obsidian resolves a
 *  bare `[[Name]]` by basename, which post-COMPOSE-6 is the entity's human filename. */
export function linkedEntityNames(entityMd: string): string[] {
  const start = entityMd.indexOf(LINKS_BLOCK_START);
  if (start === -1) return [];
  const endMarker = entityMd.indexOf(LINKS_BLOCK_END, start);
  const block = entityMd.slice(start, endMarker === -1 ? undefined : endMarker);
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const target = m[1];
    // `path|Name` → Name; bare `path.md` → the human basename (the filename, post-COMPOSE-6).
    const name = target.includes('|') ? target.slice(target.indexOf('|') + 1).trim() : path.basename(target.trim(), '.md');
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Read one entity's compose state at a given claims signature from its source's append-only
 * audit.jsonl (keyed by entityId, scoped to `sig`). A claim change yields a NEW sig, so prior
 * failures/set-asides never block the fresh content (they were about the old claims).
 */
export async function readComposeState(sourceDir: string, entityId: string, sig: string): Promise<ComposeState> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sourceDir, 'audit.jsonl'), 'utf8');
  } catch {
    return { composed: false, failures: 0, setAside: false };
  }
  let composed = false;
  let failures = 0;
  let setAside = false;
  for (const line of epochScopedLines(raw)) {
    if (line.trim().length === 0) continue;
    let obj: ComposeAuditLine;
    try {
      obj = JSON.parse(line) as ComposeAuditLine;
    } catch {
      continue;
    }
    if (obj.stage !== STAGE || obj.entityId !== entityId || obj.sig !== sig) continue;
    if (obj.event === 'reopened') {
      // A user-triggered backfill re-attempt (COMPOSE-9 one-shot trigger): supersede prior
      // failed/setaside for THIS signature so a transiently-failed entity re-enters the queue. Does
      // NOT clear `composed` — an already-composed entity stays composed (reopen only un-sticks the
      // uncomposed backlog).
      failures = 0;
      setAside = false;
    } else if (obj.event === 'composed') composed = true;
    else if (obj.event === 'failed') failures += 1;
    else if (obj.event === 'setaside') setAside = true;
  }
  return { composed, failures, setAside };
}

/** An entity is pending compose iff it has claims AND its current claims signature hasn't been
 *  composed, isn't set aside, and hasn't exhausted its attempts. The audit home is the entity's
 *  first source (deterministic; node order). */
async function isPendingCompose(baseDir: string, entityRel: string, entityMd: string, maxAttempts: number): Promise<boolean> {
  if (!hasClaims(entityMd)) return false;
  const sig = claimsBlockSig(entityMd);
  let sources: string[];
  try {
    sources = parseEntityNode(entityMd).sources;
  } catch {
    return false;
  }
  const state = await readComposeState(path.join(baseDir, sources[0]), path.basename(entityRel, '.md'), sig);
  return !state.composed && !state.setAside && state.failures < maxAttempts;
}

/**
 * The compose work queue (COMPOSE-7): entity nodes whose current claims signature still needs prose
 * — they have claims and that signature hasn't been composed/exhausted. Repo-relative entity paths,
 * sorted by entity id so drains are deterministic.
 */
export async function readComposeQueue(root: string, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<string[]> {
  root = path.resolve(root);
  const files = await findEntityFiles(root);
  const queued: string[] = [];
  for (const rel of files) {
    let md: string;
    try {
      md = await fs.readFile(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (await isPendingCompose(root, rel, md, maxAttempts)) queued.push(rel);
  }
  return queued.sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1));
}

/** The rigid audit envelope (SPEC-0016 §3.4 / AUDIT-1) — orchestrator-owned fields wrap the payload. */
function auditLine(fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), stage: STAGE, ...fields }) + '\n';
}

/** Read the entity's cited claims as CitedClaim[] (statement + source dir + human source title),
 *  reading ONLY the entity's own claim files (its block's `[[claims/…]]`), then resolving each
 *  source's human title via `deriveSourceTitle` (COMPOSE-8; never a ULID). Claims whose source can't
 *  be read still contribute (titled with the neutral generic the resolver returns for absent input). */
async function readCitedClaims(wt: string, entityMd: string, entityRel: string): Promise<CitedClaim[]> {
  const paths = Array.from(new Set(claimBlockPaths(entityMd)));
  // SPEC-0050 slice-2b/2c: exclude a durably-corrected claim from the composed prose + citations too (not
  // just the structured block) — retract OR reattribute (wrong subject); same content key (subject block
  // identity + statement), survives replay.
  const corrections = await readCorrectionDirectives(wt);
  const revokes = await readRevokeDirectives(wt); // SPEC-0050 slice-3: a REVOKED retract no longer suppresses
  const ref = parseEntityNode(entityMd);
  const identityKey = blockKey(ref.kind, ref.name);
  const titleCache = new Map<string, string>();
  const out: CitedClaim[] = [];
  for (const rel of paths) {
    let claimMd: string;
    try {
      claimMd = await fs.readFile(path.join(wt, rel), 'utf8');
    } catch {
      continue; // a referenced claim file is gone (e.g. dedup) — skip
    }
    const link = parseClaimBacklink(claimMd, rel, entityRel);
    if (!link || !link.source || link.statement.length === 0) continue;
    if (isClaimSuppressedActive(corrections, revokes, identityKey, link.statement)) continue; // retracted/reattributed (unless revoked) → omit from prose
    let title = titleCache.get(link.source);
    if (title === undefined) {
      let sourceMd = '';
      try {
        sourceMd = await fs.readFile(path.join(wt, link.source, 'source.md'), 'utf8');
      } catch {
        /* source.md absent — deriveSourceTitle('') returns the neutral generic, never a ULID */
      }
      title = deriveSourceTitle(sourceMd);
      titleCache.set(link.source, title);
    }
    out.push({ statement: link.statement, sourceRel: link.source, title });
  }
  // Deterministic order (replay-stable): by claim file path.
  return out.sort((a, b) => (a.sourceRel < b.sourceRel ? -1 : a.sourceRel > b.sourceRel ? 1 : 0));
}

export interface ComposeOneResult {
  entityId: string;
  ok: boolean;
  composed: boolean; // wrote prose
  setAside: boolean;
}

/**
 * Compose ONE entity under optimistic concurrency (SPEC-0014 ORCH-17/18/19). Cognition + the
 * prose write + the audit happen OFF the lock, synced to a canonical checkpoint; only the canonical
 * ff-advance runs under `lock`. Because Compose EDITS the entity node (its prose region only), it can
 * same-path-collide with a concurrent Connect/Claims rewrite of that node — the advance detects it and
 * retries against the fresh canonical, bounded → set aside (ORCH-19).
 */
export async function composeOne(
  root: string,
  entityRel: string,
  decider: ComposeDecider,
  lock: Mutex = new Mutex(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  log: DevLog = noopDevLog,
  span: ActiveSpan = noopActiveSpan,
): Promise<ComposeOneResult> {
  root = path.resolve(root);
  const entityId = path.basename(entityRel, '.md');
  let result: ComposeOneResult = { entityId, ok: false, composed: false, setAside: false };

  const prepare = async ({ wt, base }: PrepareContext): Promise<boolean> => {
    const wtGit = simpleGit(wt);
    const entityPathWt = path.join(wt, entityRel);
    const entityMd = await fs.readFile(entityPathWt, 'utf8');
    // Re-check pending off this fresh checkpoint — a concurrent writer may have composed it already.
    if (!(await isPendingCompose(wt, entityRel, entityMd, maxAttempts))) {
      result = { entityId, ok: true, composed: false, setAside: false };
      return false; // nothing to advance
    }
    const ref = parseEntityNode(entityMd);
    const sig = claimsBlockSig(entityMd);
    const sourceRel = ref.sources[0];
    const auditPath = path.join(wt, sourceRel, 'audit.jsonl');
    const runId = ulid();
    try {
      const cited = await readCitedClaims(wt, entityMd, entityRel);
      if (cited.length === 0) {
        // The block linked claims but none resolved (all deleted/empty) — nothing to ground prose in.
        result = { entityId, ok: true, composed: false, setAside: false };
        return false;
      }
      // SPEC-0050 slice-3: fold in the entity's ACTIVE guidance steer (revokes applied; an entity steer,
      // else the global one) — durable, rebirth-proof framing for the page. Absent → no steer line.
      const [guidanceMap, revokesMap] = await Promise.all([readGuidanceDirectives(wt), readRevokeDirectives(wt)]);
      const entityIdentity = blockKey(ref.kind, ref.name);
      const steer =
        activeGuidanceForIdentity(guidanceMap, revokesMap, entityIdentity) ??
        activeGuidanceForIdentity(guidanceMap, revokesMap, GLOBAL_GUIDANCE_KEY);
      const input: ComposeInput = {
        entityId,
        kind: ref.kind,
        name: ref.name,
        claims: cited.map((c) => ({ statement: c.statement, title: c.title })),
        links: linkedEntityNames(entityMd),
        ...(steer ? { guidance: steer.guidance } : {}),
      };
      const decision = await decider(input, { span });
      const model = decision.agent?.model ?? 'default';
      const prose = renderProse(decision, cited);
      // Write ONLY the prose region; the kb:links / kb:claims blocks stay below, untouched (COMPOSE-5).
      await fs.writeFile(entityPathWt, applyProse(entityMd, prose), 'utf8');

      let audit = auditLine({ runId, entityId, sig, model, event: 'start' });
      audit += auditLine({ runId, entityId, sig, model, event: 'composed', sections: decision.sections.length, claims: cited.length });
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, audit, 'utf8');

      await wtGit.raw('add', '-A');
      await wtGit.commit(`compose: ${entityId} (${decision.sections.length} section(s), ${cited.length} claim(s))`);
      result = { entityId, ok: true, composed: true, setAside: false };
      return true;
    } catch (err) {
      // Deterministic fallback (COMPOSE-7): never fabricate / write un-grounded prose. Discard any
      // partial write (the node stays blocks-only — today's behaviour), record the failed attempt,
      // and set aside (for THIS signature) after K so it can't churn forever. It re-tries when the
      // claims next change (a new sig) or copilot recovers and the sig is retried under the cap.
      await wtGit.raw('reset', '--hard', base);
      const error = err instanceof Error ? err.message : String(err);
      const prior = await readComposeState(path.join(wt, sourceRel), entityId, sig);
      const attempt = prior.failures + 1;
      const setAside = attempt >= maxAttempts;
      let audit = auditLine({ runId, entityId, sig, event: 'failed', attempt, error: oneLine(error) });
      if (setAside) audit += auditLine({ runId, entityId, sig, event: 'setaside', attempts: attempt });
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, audit, 'utf8');
      log.warn('compose.failed', { runId, itemId: entityId, attempt, setAside, err });
      await wtGit.raw('add', '-A');
      await wtGit.commit(`compose: failed ${entityId} (attempt ${attempt}${setAside ? ', set aside' : ''})`);
      result = { entityId, ok: false, composed: false, setAside };
      return true;
    }
  };

  // Same-path collision exhaustion (ORCH-19): set aside this entity for its current signature so it
  // can't head-of-line-block. It re-tries when the claims next change.
  const onExhausted = async (): Promise<void> => {
    const base = await canonicalHead(root);
    await withEphemeralWorktree(root, STAGE, base, async ({ wt, workBranch }) => {
      const entityMd = await fs.readFile(path.join(wt, entityRel), 'utf8');
      const ref = parseEntityNode(entityMd);
      const sig = claimsBlockSig(entityMd);
      const auditPath = path.join(wt, ref.sources[0], 'audit.jsonl');
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, auditLine({ runId: ulid(), entityId, sig, event: 'setaside', reason: 'collision-exhausted' }), 'utf8');
      const wtGit = simpleGit(wt);
      await wtGit.raw('add', '-A');
      await wtGit.commit(`compose: set aside ${entityId} (collision-exhausted)`);
      await lock.run(() => advanceOrCollide(root, workBranch, base), 'compose:setaside-advance');
    });
    log.warn('compose.setaside', { itemId: entityId, reason: 'collision-exhausted' });
    result = { ...result, ok: false, setAside: true };
  };

  await withConcurrentAdvance({ root, lock, stage: STAGE }, prepare, onExhausted);
  return result;
}

/**
 * Owns a vault's Compose stage: a poke/sweep drain loop sharing the canonical-writer lock with the
 * other Enrich stages (SPEC-0014 §5). Restartable: re-reads the derived queue and resumes.
 */
export class ComposeStage {
  private readonly root: string;
  private readonly decider: ComposeDecider;
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
  private drainStartedAt: string | null = null;
  // #506: compose was the one Enrich stage without its sibling claims/connect/decompose's HEAD-keyed
  // queue memo — every drain pass re-walked the full compose queue even when idle. Both call sites in
  // drainOnce share it (mirrors DecomposeStage.queueCache). Uses the spawn-free `fastHeadSha` (not the
  // sibling stages' default git-spawn `canonicalHead`) — compose's poke() fires fire-and-forget from
  // `start()`, so a git spawn here directly widens the async window other code (e.g. quiesce status)
  // treats as "settles almost instantly"; fs-only reads keep that margin intact.
  private readonly queueCache = new CanonicalQueueCache<string[]>(fastHeadSha);

  /**
   * @param afterDrain optional hook run (serialized under the shared lock) after a drain that
   *   composed ≥1 entity. The pipeline passes the promotion gate here so the entity nodes' newly
   *   (re)written prose is published `staging`→`main` (entities/ are evergreen; STAGING-3/11).
   */
  constructor(
    root: string,
    decider: ComposeDecider = makeComposeDecider(),
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
    this.log = log.child({ scope: 'compose' });
    this.tracer = tracer;
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

  /** Live-set the per-stage concurrency cap (SPEC-0048 SCALE-4): read on the NEXT batch, so a Settings
   *  change applies without a restart. */
  setCap(cap: number): void {
    this.cap = Math.max(1, Math.floor(cap));
  }

  /** The current per-stage concurrency cap (for Status display / SPEC-0048 Settings). */
  getCap(): number {
    return this.cap;
  }

  busy(): boolean {
    return this.draining;
  }

  currentSince(): string | null {
    return this.drainStartedAt;
  }

  /** #506 perf proof/telemetry: how many queue reads were served from the canonical-HEAD memo
   *  (`hits` = walks skipped) vs recomputed (`misses` = a real walk ran). Mirrors the sibling stages. */
  queueCacheStats(): { hits: number; misses: number } {
    return { hits: this.queueCache.hits, misses: this.queueCache.misses };
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
    } finally {
      this.draining = false;
      this.drainStartedAt = null;
      this.current = null;
    }
  }

  private async drainOnce(): Promise<void> {
    let queue = await this.queueCache.read(this.root, () => readComposeQueue(this.root, this.maxAttempts));
    // A backlog sweep (COMPOSE-9) vs a live poke: more than one batch's worth pending ⇒ we're
    // backfilling the existing corpus, so emit progress.
    const backfill = queue.length > this.cap;
    let composedTotal = 0;
    let processed = 0;
    // COMPOSE-9 bounded-per-pass: compose at most BACKFILL_SWEEP_CAP entities in one drain, then yield
    // and re-poke to continue — a large backlog drains across several bounded passes rather than one
    // giant uninterruptible sweep (each pass still publishes incrementally via the coalesced promote).
    while (queue.length > 0 && processed < BACKFILL_SWEEP_CAP) {
      const batch = queue.slice(0, this.cap);
      processed += batch.length;
      let batchComposed = 0;
      try {
        const results = await Promise.all(
          batch.map((entityRel) => {
            const span = this.tracer.start(STAGE_RUN_OP, { stage: STAGE, itemId: path.basename(entityRel, '.md') });
            return composeOne(this.root, entityRel, this.decider, this.lock, this.maxAttempts, this.log, span).then(
              (r) => {
                span.end(r.composed ? 'ok' : r.setAside ? 'setaside' : 'ok');
                return r;
              },
              (err) => {
                span.end('error');
                throw err;
              },
            );
          }),
        );
        batchComposed = results.filter((r) => r.composed).length;
        composedTotal += batchComposed;
      } catch (err) {
        this.log.error('compose.drain-error', { err });
        return;
      }
      // STAGING-12 / COMPOSE-9: request a COALESCED promotion after EACH batch (not once at the very
      // end), so a large backfill publishes to `main` INCREMENTALLY — the Principal sees articles
      // appear progressively rather than nothing until all ~700 entities finish. The coalescingPromoter
      // debounces these requests into infrequent bursts (afterDrain = `promoter.request()`), so this is
      // never a per-entity promotion storm against the live Obsidian vault (the #319 P1).
      if (batchComposed > 0 && this.afterDrain) await this.lock.run(() => this.afterDrain!(), 'compose:afterDrain');
      queue = await this.queueCache.read(this.root, () => readComposeQueue(this.root, this.maxAttempts));
      if (backfill) this.log.info('compose.backfill-progress', { composed: composedTotal, remaining: queue.length });
    }
    // Bounded-per-pass: a backlog remains (we hit the sweep cap) → continue on the next drain pass
    // (runDrains loops while `pending`), so the corpus finishes to completion across passes (COMPOSE-9).
    if (queue.length > 0) this.pending = true;
  }
}

/** A claim-bearing entity's compose status for the backfill (COMPOSE-9 "ship the whole vault"
 *  observability): how many entities WITH cited claims have a composed article vs still need one. An
 *  entity with no claims isn't counted (nothing to compose). `composed` is measured by the presence of
 *  a prose body (not just a marker), so it reflects what a human opening the vault actually sees. */
export interface ComposeBacklogStats {
  total: number; // entities with cited claims (the universe Compose should cover)
  composed: number; // of those, how many already read as an article (have a prose body)
  remaining: number; // total - composed (claim-bearing entities still block-only)
}

export async function composeBacklogStats(root: string): Promise<ComposeBacklogStats> {
  root = path.resolve(root);
  let total = 0;
  let composed = 0;
  for (const rel of await findEntityFiles(root)) {
    let md: string;
    try {
      md = await fs.readFile(path.join(root, rel), 'utf8');
    } catch {
      continue;
    }
    if (!hasClaims(md)) continue;
    total += 1;
    if (hasProse(md)) composed += 1;
  }
  return { total, composed, remaining: total - composed };
}

/**
 * COMPOSE-9 one-shot backfill re-attempt: append a per-entity `reopened` marker (for the current
 * claims signature) to every entity whose compose is currently SET ASIDE — so a transiently-failed
 * entity (e.g. Compose was unavailable during the autonomous sweep) re-enters the queue and composes
 * on the next drain. This is what makes the "backfill the vault" trigger GUARANTEE completion rather
 * than leaving a stuck remnant. Idempotent: an entity that isn't set aside is untouched; if none are
 * set aside it's a no-op. One commit, advanced under the canonical-writer lock. Returns the count.
 */
export async function reopenComposeSetAside(root: string, lock: Mutex = new Mutex()): Promise<number> {
  root = path.resolve(root);
  let reopened = 0;
  const prepare = async ({ wt }: PrepareContext): Promise<boolean> => {
    reopened = 0;
    for (const rel of await findEntityFiles(wt)) {
      let md: string;
      try {
        md = await fs.readFile(path.join(wt, rel), 'utf8');
      } catch {
        continue;
      }
      if (!hasClaims(md)) continue;
      let sources: string[];
      try {
        sources = parseEntityNode(md).sources;
      } catch {
        continue;
      }
      const sig = claimsBlockSig(md);
      const entityId = path.basename(rel, '.md');
      const state = await readComposeState(path.join(wt, sources[0]), entityId, sig);
      if (!state.setAside) continue;
      const auditPath = path.join(wt, sources[0], 'audit.jsonl');
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.appendFile(auditPath, auditLine({ runId: ulid(), entityId, sig, event: 'reopened' }), 'utf8');
      reopened += 1;
    }
    if (reopened === 0) return false; // nothing set aside → nothing to recover (noop)
    const wtGit = simpleGit(wt);
    await wtGit.raw('add', '-A');
    await wtGit.commit(`compose: reopened ${reopened} set-aside entit${reopened === 1 ? 'y' : 'ies'} for backfill`);
    return true;
  };
  const onExhausted = async (): Promise<void> => {
    throw new Error('compose: could not advance reopen-backfill — canonical too contended');
  };
  await withConcurrentAdvance({ root, lock, stage: STAGE }, prepare, onExhausted);
  return reopened;
}
