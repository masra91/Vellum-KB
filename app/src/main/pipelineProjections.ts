// The active-vault's MAINTAINED PROJECTIONS (#574, fast-follow to #528/#572): the four background-
// refreshed, render-path-instant stores (status snapshot OBS-24, review queue SHELL-12, graph
// SPEC-0058 STATE-2, Today SPEC-0058 composite) + the main→renderer push-sink they share. Extracted
// out of pipeline.ts alongside `pipelineLifecycle.ts` (see that file's header for the full split
// rationale and why this module ONE-DIRECTIONALLY depends on it, never the reverse).
//
// `pipeline.ts` re-exports everything below unchanged, so no importer (ipc.ts, tests) needs to change
// its import path.
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStatusSnapshotStore, type StatusSnapshotStore } from './statusSnapshot';
import { createProjectionStore, type ProjectionStore, type Projection } from './projectionStore';
import { computeGraphProjection, type GraphProjection } from '../kb/graphProjection';
// SPEC-0058 Today: the maintained command-center projection composes the other maintained reads.
import { makeReadOnlyTools } from '../kb/recallTools'; // for the Today Health walk (buildHealthReport takes RecallTools)
import { assembleTodayProjection, type TodaySources } from '../kb/todayProjection';
import type { TodayProjection, TodayStation } from '../kb/types';
import { buildStations } from '../kb/lineStations'; // "one Line, one truth" — byte-identical Status stations
import { buildHealthReport } from '../kb/healthPanel';
import { toHealthProjection } from '../kb/healthProjection';
import { readContradictionDirectives } from '../kb/directives';
import { loadActivityIndex } from '../kb/activityIndex';
import { buildFeed, type ActivityFeedEntry } from '../kb/activityDigest';
import { readQueue, listArchiveSetAsideItems } from '../kb/orchestrator';
import { readDecomposeQueue } from '../kb/decomposeStage';
import { readClaimsQueue, listSetAsideItems } from '../kb/claimsStage';
import { readConnectQueue, listConnectSetAsideItems } from '../kb/connectStage';
import { readRecentDevLogEntries } from '../kb/devlog';
import { telemetryHealth } from './telemetry';
import { assemblePipelineStatus, toSetAsideViews, deriveStageError, buildInFlightRoster, type PipelineStatusView, type StageInput, type RecentError, type WorktreeInfo } from '../kb/pipelineStatusView';
import { displayItemName } from '../kb/pipelineStatusLabels';
import { readSourceTitles } from '../kb/sourceTitleRead';
import { readConversionCounts } from '../kb/conversionCounts';
import { fastHeadSha, fastHeadBranch } from '../kb/gitHeadFast';
import { CanonicalQueueCache } from '../kb/queueCache';
import { loadPerfIndex } from '../kb/perfIndex';
import { findOpenReviews } from '../kb/reviewStore';
import { reviewToSummary } from '../kb/reviewSummary';
import type { ReviewSummary } from '../kb/types';
import { getActivePipeline, registerProjectionLifecycleHooks } from './pipelineLifecycle';

// ── SPEC-0058 STATE-8 (#510): the maintained-projection PUSH sink ───────────────────────────────────
// `main.ts` sets this once (`setProjectionPushSink`) to broadcast `webContents.send('kb:projection-
// changed', event)` so a visible renderer view re-reads its (instant) projection immediately instead of
// waiting on its poll interval. Injected rather than importing Electron here directly, so this module
// stays node-testable without a real BrowserWindow. Best-effort + never load-bearing: a push is a "go
// re-read the cache" nudge — the render path's own IPC read is always the source of truth, so a dropped
// push (no window yet, a listener throwing) just means the view catches up on its own next poll/switch.
export type ProjectionPushEvent = { store: 'status' | 'review' | 'graph' | 'today'; builtAt: string };
let projectionPushSink: ((event: ProjectionPushEvent) => void) | null = null;

/** Register (or clear, with `null`) the push sink. Call once from `main.ts` after the window exists. */
export function setProjectionPushSink(sink: ((event: ProjectionPushEvent) => void) | null): void {
  projectionPushSink = sink;
}

function pushProjectionChanged(store: ProjectionPushEvent['store'], builtAt: string): void {
  try {
    projectionPushSink?.({ store, builtAt });
  } catch {
    /* push is best-effort — a listener failure must never break the projection */
  }
}

/** Newest of a set of ISO timestamps (ignoring undefined/unparseable). Undefined if none. */
function newestTs(candidates: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const ts of candidates) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = ts;
    }
  }
  return best;
}

/** List the live worktrees under `<vault>/.kb/cache/worktrees/` + the branch each is on (OBS-7). */
async function listWorktrees(vaultPath: string): Promise<WorktreeInfo[]> {
  const root = path.join(vaultPath, '.kb', 'cache', 'worktrees');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorktreeInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const wt = path.join(root, e.name);
    let branch: string | undefined;
    try {
      // #506: was one git spawn PER worktree PER status tick (~2,500/hour at rest). `fastHeadBranch`
      // reads `.git/HEAD` directly and only falls back to the (still #135-bounded) git spawn on an
      // unrecognized on-disk shape.
      branch = await fastHeadBranch(wt);
    } catch {
      /* not a worktree / detached / timed-out — leave branch undefined */
    }
    out.push({ path: path.join('.kb', 'cache', 'worktrees', e.name), ...(branch ? { branch } : {}) });
  }
  return out;
}

/**
 * The EXPENSIVE status compute (SPEC-0030 OBS-5/6/7/11/15) — gathers per-stage queue depths + busy
 * flags, the canonical-writer lock state, recent dev-log errors, the perf index, conversion counts,
 * and the worktrees (git enumeration), then hands them to the pure {@link assemblePipelineStatus}.
 *
 * OBS-24: this is the work that must NEVER run on the render path — its git/file reads can block
 * behind the pipeline's own git ops and trip the 8s load-guard under load (#256). It is run ONLY on a
 * background cadence by {@link statusStore}; the render path ({@link pipelineStatusForActive}) reads
 * the maintained snapshot instantly. Read-only (OBS-9). Null when no KB is open.
 */
async function computePipelineStatus(): Promise<PipelineStatusView | null> {
  const active = getActivePipeline();
  if (!active) return null;
  const { vaultPath, stagingWt, lock, orch, decompose, connect, claims, statusCache } = active;
  const [archiveQ, decompQ, connectQ, claimsQ, archiveStatus, recentRaw, perf, worktrees, claimsSetAside, connectSetAside, archiveSetAside, conversion] = await Promise.all([
    readQueue(stagingWt),
    // #506: these three raw readers each re-walk their whole tree; HEAD-key them so an idle tick (no
    // canonical commit since the last one) is a spawn-free sha read instead of a full re-walk.
    statusCache.decompose.read(stagingWt, () => readDecomposeQueue(stagingWt)),
    statusCache.connect.read(stagingWt, () => readConnectQueue(stagingWt)),
    statusCache.claims.read(stagingWt, () => readClaimsQueue(stagingWt)),
    orch.status(),
    readRecentDevLogEntries(vaultPath, { limit: 25 }),
    // OBS-12/13 path fix: the tracer WRITES spans to `vaultPath` (createVaultTracer(vaultPath), ~L288),
    // so the perf index must READ from the SAME root — reading `stagingWt` found an empty/absent index
    // and the Latency & Throughput panel showed "No Copilot calls recorded yet" while calls flowed.
    loadPerfIndex(vaultPath),
    listWorktrees(vaultPath),
    statusCache.claimsSetAside.read(stagingWt, () => listSetAsideItems(stagingWt)), // OBS-17: claims poison items (canonical claims-path reader, CLAIMS-20)
    statusCache.connectSetAside.read(stagingWt, () => listConnectSetAsideItems(stagingWt)), // OBS-17: connect poison blocks (CLAIMS-20 connect twin, #157)
    statusCache.archiveSetAside.read(stagingWt, () => listArchiveSetAsideItems(stagingWt)), // #516 BUG-3 / OBS-17: archive poison units
    statusCache.conversion.read(stagingWt, () => readConversionCounts(stagingWt, vaultPath)), // SPEC-0032 VIZ-3: funnel counts (staging state + promoted on main)
  ]);
  // Union every stage's set-aside items into the view (claims + connect + archive; future stages
  // append here). Each stage maps its item to the generic {itemId, name, failures, rounds} source shape
  // (archive has no review-cascade `rounds` concept, so it's always 0).
  const setAsideItems = [
    ...toSetAsideViews(claimsSetAside.map((i) => ({ itemId: i.entityId, name: i.name, failures: i.failures, rounds: i.rounds })), 'claims'),
    ...toSetAsideViews(connectSetAside.map((i) => ({ itemId: i.blockKey, name: i.name, failures: i.failures, rounds: i.rounds })), 'connect'),
    ...toSetAsideViews(archiveSetAside.map((i) => ({ itemId: i.id, name: i.name, failures: i.failures, rounds: 0 })), 'archive'),
  ];

  const recentErrors: RecentError[] = recentRaw.map((e) => ({
    ts: e.ts,
    level: e.level,
    event: e.event,
    ...(typeof e.scope === 'string' ? { stage: e.scope } : {}),
    ...(typeof e.itemId === 'string' ? { itemId: e.itemId } : {}),
    ...(typeof e.runId === 'string' ? { runId: e.runId } : {}),
    ...(e.err?.message ? { message: e.err.message } : {}),
  }));
  const setAsideFor = (stage: string): number =>
    recentErrors.filter((e) => e.stage === stage && e.event.includes('setaside')).length;
  // #163: a stage is errored only if it has a FRESH error — a recovered stage's error ages out
  // (was unbounded: any error in the last-N log lines kept the badge red forever).
  const nowMs = Date.now();
  const hasErrorFor = (stage: string): boolean => deriveStageError(recentErrors, stage, nowMs);

  // PRIN-24: resolve the source-keyed stages' ids to human titles. Archive + decompose carry the
  // SOURCE ULID being processed; resolve each to its `source.md` title via the ONE shared derivation
  // (deriveSourceTitle / REVIEW-16). This is the fs title-LOAD the seam places HERE — in
  // computePipelineStatus, on OBS-24's background cadence (never the render path) — so the resolved
  // names bake into the cached snapshot and flow to The Line + the Status stations + the tray.
  // Connect/claims ids are block keys / entity ids (not ULIDs), so they don't resolve to a source and
  // the renderer guard (`displayItemName`) shows them as-is — never a raw ULID.
  // OBS-26: only treat archive's persisted `processing` as a live current-item when a worker actually
  // backs it (`orch.busy()`). The status file can retain `processing` if the orchestrator was killed
  // mid-item — without this gate it shows as a perpetual in-progress ghost (a growing-forever dwell).
  // No live drain ⇒ no current item / no in-flight carriage for it.
  const orchBusy = orch.busy();
  const archiveProcessing = orchBusy ? archiveStatus.processing : null;
  const sourceTitles = await readSourceTitles(vaultPath, [
    ...(archiveProcessing ? [archiveProcessing] : []),
    ...archiveQ,
    ...decompQ,
  ]);
  const archiveCurrent = archiveProcessing
    ? displayItemName(sourceTitles.get(archiveProcessing), archiveProcessing)
    : undefined;

  const stages: StageInput[] = [
    { stage: 'archive', queueDepth: archiveQ.length, setAside: setAsideFor('archive'), busy: orchBusy, hasError: hasErrorFor('archive'), ...(archiveCurrent ? { currentItem: archiveCurrent } : {}) },
    { stage: 'decompose', queueDepth: decompQ.length, setAside: setAsideFor('decompose'), busy: decompose.busy(), hasError: hasErrorFor('decompose') },
    { stage: 'connect', queueDepth: connectQ.length, setAside: setAsideFor('connect'), busy: connect.busy(), hasError: hasErrorFor('connect') },
    { stage: 'claims', queueDepth: claimsQ.length, setAside: setAsideFor('claims'), busy: claims.busy(), hasError: hasErrorFor('claims') },
  ];

  // SPEC-0032 VIZ-2: in-flight carriages — each stage's queue items, `active` = the draining batch
  // (`busy && index < cap`; the drain processes `queue[0..cap)`). Archive's active item is its
  // `processing` (prepended; cap=1, only when a live worker backs it — OBS-26); connect drains 1 block
  // at a time (cap=1); decompose/claims/archive carry their LIVE per-stage cap (SCALE-2, `stage.getCap()`).
  // Source-keyed items carry the resolved title (PRIN-24).
  const inFlight = buildInFlightRoster([
    {
      stage: 'archive',
      items: [...(archiveProcessing ? [{ id: archiveProcessing, name: sourceTitles.get(archiveProcessing) }] : []), ...archiveQ.map((id) => ({ id, name: sourceTitles.get(id) }))],
      busy: orchBusy, cap: orch.getCap(), since: archiveStatus.updatedAt ?? null,
    },
    { stage: 'decompose', items: decompQ.map((id) => ({ id, name: sourceTitles.get(id) })), busy: decompose.busy(), cap: decompose.getCap(), since: decompose.currentSince() },
    { stage: 'connect', items: connectQ.map((cs) => ({ id: cs.blockKey })), busy: connect.busy(), cap: 1, since: connect.currentSince() },
    { stage: 'claims', items: claimsQ.map((rel) => ({ id: path.basename(rel, '.md') })), busy: claims.busy(), cap: claims.getCap(), since: claims.currentSince() },
  ]);

  // Last activity: the newest of the archivist status, the spans-file mtime (any stage's last span),
  // and the newest dev-log entry — so a quietly-working pipeline isn't mistaken for stalled (OBS-11).
  const spansMtime = perf.source ? new Date(perf.source.mtimeMs).toISOString() : undefined;
  const lastActivity = newestTs([archiveStatus.updatedAt ?? undefined, spansMtime, recentErrors[0]?.ts]);

  // OBS-22: the memory/health readout (current RSS/heap + leak trend + last crash breadcrumb).
  const health = await telemetryHealth();

  return assemblePipelineStatus({ stages, lock: lock.state(), recentErrors, worktrees, perf, setAsideItems, conversion, inFlight, health, ...(lastActivity ? { lastActivity } : {}) });
}

// ── OBS-24: the maintained status snapshot ──────────────────────────────────────────────────────────
//
// The render path reads a continuously-maintained last-known-good snapshot instead of synchronously
// recomputing. The expensive `computePipelineStatus` runs only on a background cadence; reads are
// instant (no git/fs), so a status read can never block or trip the load-guard. The snapshot is
// persisted per-vault so launch shows last-known-good instantly, then goes live.

/** Background refresh cadence — matches the former render poll, now off the render path. */
const STATUS_REFRESH_MS = 2500;

/** Where the last-known-good status snapshot is persisted (gitignored cache; never promoted). */
function statusSnapshotPath(vaultPath: string): string {
  return path.join(vaultPath, '.kb', 'cache', 'status-snapshot.json');
}

/** Load the persisted last-known-good snapshot for `vaultPath` (sync — a small one-time read at
 *  activation, so launch can paint status instantly). Any error (missing/corrupt) → null. */
function loadStatusSnapshot(vaultPath: string): PipelineStatusView | null {
  try {
    return JSON.parse(readFileSync(statusSnapshotPath(vaultPath), 'utf8')) as PipelineStatusView;
  } catch {
    return null;
  }
}

/** Persist `view` as the new last-known-good snapshot (best-effort, off the render path). */
async function saveStatusSnapshot(vaultPath: string, view: PipelineStatusView): Promise<void> {
  const file = statusSnapshotPath(vaultPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(view), 'utf8');
}

/** The maintained status projection (OBS-24). Started/stopped with the stage sweeps. */
const statusStore: StatusSnapshotStore = createStatusSnapshotStore({
  compute: computePipelineStatus,
  intervalMs: STATUS_REFRESH_MS,
  load: () => {
    const active = getActivePipeline();
    return active ? loadStatusSnapshot(active.vaultPath) : null;
  },
  save: (view) => {
    const active = getActivePipeline();
    if (active) void saveStatusSnapshot(active.vaultPath, view).catch(() => {});
  },
  onError: (err) => getActivePipeline()?.log.child({ scope: 'status' }).warn('status.snapshot-refresh-failed', { err }),
  onUpdate: (view) => pushProjectionChanged('status', view.builtAt),
});

/**
 * The render-path status read (SPEC-0030 OBS-5/9, OBS-24). Returns the background-maintained
 * last-known-good snapshot **instantly** — no git/fs/compute here, so a status read can never block
 * or trip the 8s load-guard. The view's `builtAt` is its "as of" timestamp (a slightly-stale status
 * is honest; a timeout is not). Null until the first snapshot is computed/loaded.
 */
export async function pipelineStatusForActive(): Promise<PipelineStatusView | null> {
  return getActivePipeline() ? statusStore.current() : null; // no active KB → null (don't serve a closed vault's stale snapshot)
}

/** OBS-24 test/diagnostic seam: force one background refresh + await it (e.g. an immediate post-action
 *  status update). Never called on the render path. */
export function refreshStatusSnapshot(): Promise<void> {
  return statusStore.refreshNow();
}

// ── SHELL-12: the maintained REVIEW-QUEUE projection ─────────────────────────────────────────────
// The render path (`kb:listReviews` + the rail badge) reads this last-known-good projection INSTANTLY
// — zero git/fs on the render path, so a busy stage or held canonical-writer lock can never stall the
// Reviews surface. SHELL-12 (c) "update by push" is satisfied by the existing cheap poll now reading
// the INSTANT projection (no live recompute the user waits on); a real main→renderer push is a ready
// follow-on via the spine's `onUpdate` hook. The answer path (REVIEW-20, DEV-6) calls
// `refreshReviewProjection()` after its fast verdict write so the next read sees fresh data.
const REVIEW_REFRESH_MS = 2500;

/** The review-queue compute (background cadence): the open "needs you" queue mapped to the view's
 *  summary shape. Null when no KB is open (the projection then shows nothing). */
async function computeReviewSummaries(): Promise<ReviewSummary[] | null> {
  const active = getActivePipeline();
  if (!active) return null;
  const reviews = await findOpenReviews(active.stagingWt);
  return reviews.map(reviewToSummary); // pure, ENG-16-hardened fold (empty/missing subject can't throw)
}

/** The maintained review-queue projection (SHELL-12). Started/stopped with the stage sweeps. */
const reviewStore: ProjectionStore<ReviewSummary[]> = createProjectionStore<ReviewSummary[]>({
  compute: computeReviewSummaries,
  intervalMs: REVIEW_REFRESH_MS,
  onError: (err) => getActivePipeline()?.log.child({ scope: 'reviews' }).warn('reviews.projection-refresh-failed', { err }),
  onUpdate: (projection) => pushProjectionChanged('review', projection.builtAt),
});

/** The render-path review-queue read (SHELL-12): the background-maintained last-known-good projection,
 *  INSTANT — no git/fs/compute, so a Reviews read can never block on the backend. Null until first build. */
export function reviewProjectionForActive(): Projection<ReviewSummary[]> | null {
  return getActivePipeline() ? reviewStore.current() : null; // no active KB → null (don't serve a closed vault's queue)
}

/** Post-answer refresh seam (REVIEW-20 / DEV-6): re-read the queue + push, so the renderer's optimistic
 *  remove reconciles against fresh data. Mirrors `refreshStatusSnapshot`. Never on the render path. */
export function refreshReviewProjection(): Promise<void> {
  return reviewStore.refreshNow();
}

// ── SPEC-0058 STATE-2: the maintained GRAPH projection ───────────────────────────────────────────
// The shared knowledge-graph snapshot Explore + Health (+ Today) read INSTANTLY off the render path —
// killing the per-mount live `entities/`+`claims/` walk (Explore's O(N+M) backlink scan, Health's
// O(2N) re-walk) that made those views fail to load on a cold/large vault (the packaged P0). The
// expensive `computeGraphProjection` (one O(N+E) pass, precomputed backlinks; #457) runs on the
// background cadence; the render path serves the last-known-good snapshot, persisted for instant cold
// start (STATE-11). This instantiates DEV-3's STATE-2 compute on the existing SHELL-12 backbone (same
// store `statusStore`/`reviewStore` use); the CORE's STATE-6 canonical-advance invalidation + STATE-8
// push + STATE-12 formal `status` field layer ADDITIVELY onto this same instance (DEV-5) — no rebuild.
const GRAPH_REFRESH_MS = 5000; // richer compute than status/reviews → a calmer backstop cadence

/** Where the last-known-good graph projection is persisted (gitignored cache; never promoted). */
export function graphProjectionPath(vaultPath: string): string {
  return path.join(vaultPath, '.kb', 'cache', 'graph-projection.json');
}

/** Load the persisted last-known-good graph projection. Async (#508 item 4 — was a `readFileSync` at
 *  vault-activation time; on a large vault the persisted JSON is big enough that a synchronous read
 *  briefly blocked the main thread on launch). `projectionStore.start()` races this against the first
 *  live refresh and only uses it if the live one hasn't already landed, so the async hop costs nothing
 *  observable. Any error (missing/corrupt) → null. Exported for direct testing (pure given `vaultPath`). */
export async function loadGraphProjection(vaultPath: string): Promise<GraphProjection | null> {
  try {
    return JSON.parse(await fs.readFile(graphProjectionPath(vaultPath), 'utf8')) as GraphProjection;
  } catch {
    return null;
  }
}

// #508 item 4: `entityMd`/`sourceMd` (every entity's + cited source's full raw markdown) are the
// dominant byte-size of a GraphProjection — stringifying them on every 5s refresh was a synchronous
// main-thread block (50ms-1s+) that stalled ALL IPC, and rewriting that much JSON to disk repeatedly
// is real write amplification. The IN-MEMORY graph (served by graphProjectionForActive) keeps full
// bodies — the render path's "zero fs" guarantee (readNode/readSource/linkTraversal) is unaffected,
// only the ON-DISK snapshot shrinks. A cold-start load briefly serves body-less nodes (already-`stale`
// by construction) until the first live refresh fills them in — seconds, not user-visible.
export function stripBodiesForPersist(graph: GraphProjection): GraphProjection {
  return { ...graph, entityMd: {}, sourceMd: {} };
}

/** The sha256 of the last-WRITTEN (body-stripped, `builtAt`-excluded) persisted graph, per vault path
 *  — the content-hash gate below. Keyed per-path (like `activityIndex.ts`'s file-read cache) rather than
 *  a bare global so two different vaults' content can never collide/mask each other. */
const graphPersistedHash = new Map<string, string>();

/** Persist `graph` as the new last-known-good (best-effort, off the render path) — but ONLY when its
 *  content actually changed (#508 item 4: "persist on content-hash change only"). A canonical advance
 *  that HEAD-gating (#505) can't skip — e.g. compose rewriting an entity's PROSE body — still forces a
 *  recompute, but the body-stripped persisted shape is often byte-identical to what's already on disk
 *  (bodies are exactly what's stripped), so the write itself would be pure waste without this gate.
 *  Exported for direct testing (pure given `vaultPath`+`graph`). */
export async function saveGraphProjection(vaultPath: string, graph: GraphProjection): Promise<void> {
  const stripped = stripBodiesForPersist(graph);
  // builtAt always differs — exclude it from the hash (JSON.stringify drops an `undefined` value entirely).
  const hash = createHash('sha256').update(JSON.stringify({ ...stripped, builtAt: undefined })).digest('hex');
  if (graphPersistedHash.get(vaultPath) === hash) return;
  graphPersistedHash.set(vaultPath, hash);
  const file = graphProjectionPath(vaultPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(stripped), 'utf8');
}

// #505: the interval tick used to run the full O(N+M+S) `computeGraphProjection` walk every 5s
// regardless of whether anything changed. HEAD-gate it with the SAME well-tested `CanonicalQueueCache`
// primitive the stage drain loops already use (queueCache.test.ts covers hit/miss/HEAD-unreadable
// directly) — a spawn-free sha read (`fastHeadSha`) costs a couple of small fs reads, so an idle vault's
// 5s tick is nearly free instead of walking every entity/claim/source file for nothing. One instance,
// reset per vault activation (module-level `active` swap) since it's only ever touched from here.
const graphMemo = new CanonicalQueueCache<GraphProjection>(fastHeadSha);

/** The graph-projection compute (background cadence): one precomputed-backlink pass over the EVERGREEN
 *  graph at the active vault root (STATE-7 — the settled main tree, like the rest of Explore/recall,
 *  never the `staging` worktree mid-write). Null when no KB is open. Returns the SAME object reference
 *  as the prior call when the canonical HEAD hasn't moved (`projectionStore`'s no-op fast path then
 *  skips the restamp/save/push too — a true no-op tick, not just a skipped walk). */
async function computeGraph(): Promise<GraphProjection | null> {
  const active = getActivePipeline();
  if (!active) {
    graphMemo.invalidate();
    return null;
  }
  const vaultPath = active.vaultPath;
  return graphMemo.read(vaultPath, () => computeGraphProjection(vaultPath));
}

/** The maintained graph projection (SPEC-0058 STATE-2). Started/stopped with the stage sweeps. */
const graphStore: ProjectionStore<GraphProjection> = createProjectionStore<GraphProjection>({
  compute: computeGraph,
  intervalMs: GRAPH_REFRESH_MS,
  load: () => {
    const active = getActivePipeline();
    return active ? loadGraphProjection(active.vaultPath) : null;
  },
  save: (graph) => {
    const active = getActivePipeline();
    if (active) void saveGraphProjection(active.vaultPath, graph).catch(() => {});
  },
  onError: (err) => getActivePipeline()?.log.child({ scope: 'graph' }).warn('graph.projection-refresh-failed', { err }),
  onUpdate: (projection) => pushProjectionChanged('graph', projection.builtAt),
});

/** The render-path graph read (SPEC-0058 STATE-2): the background-maintained last-known-good projection,
 *  INSTANT — no git/fs/compute, so an Explore/Health read can never block on the backend. Null until the
 *  first snapshot is computed/loaded (the IPC layer maps that to a calm `warming` status). */
export function graphProjectionForActive(): Projection<GraphProjection> | null {
  return getActivePipeline() ? graphStore.current() : null; // no active KB → null (don't serve a closed vault's graph)
}

/** Post-mutation refresh seam (mirrors `refreshReviewProjection`): re-read the graph + push. DEV-5's
 *  STATE-6 layer will also drive this off the canonical advance. Never on the render path. */
export function refreshGraphProjection(): Promise<void> {
  return graphStore.refreshNow();
}

// ── SPEC-0058 Today: the maintained command-center HOME projection ─────────────────────────────────
// "Today" is the v2 home — a calm one-glance state-of-the-library. It is a COMPOSITE of the reads the
// other surfaces already maintain: the pipeline status (conversion stats + the Line ribbon + in-flight),
// the graph projection (Connections), the review queue + open contradictions (the needs-you decisions),
// the activity feed, and Health (dangling/orphans/thin). Like every v2 surface it is a maintained
// projection (SPEC-0058 STATE-1/7) — the render path reads the INSTANT last-known-good snapshot, never
// a live vault scan. The expensive parts (the Health walk + the activity-index rebuild) run here on the
// background cadence; the three already-maintained projections (status/graph/reviews) are read instantly.
const TODAY_REFRESH_MS = 8000; // a glance surface — a calm backstop cadence (push delivers fresher updates)

/** One Line station → Today's slim ribbon shape (name/stage/state/glyph + a single pending count). The
 *  station model is byte-identical to the Status view's (shared `buildStations`); Today carries only the
 *  fields its compact ribbon renders. */
function toTodayStation(s: ReturnType<typeof buildStations>[number]): TodayStation {
  return { name: s.name, stage: s.stage, state: s.state, glyph: s.glyph, count: s.queued + s.inProgress };
}

/** The newest "composed" moment (compose/output actor) in the feed → ms-ago, else null (never composed). */
function lastComposedAgoFrom(entries: ActivityFeedEntry[], nowMs: number): number | null {
  const hit = entries.find((e) => e.actor === 'compose' || e.actor === 'output');
  if (!hit) return null;
  const ts = Date.parse(hit.ts);
  return Number.isFinite(ts) ? Math.max(0, nowMs - ts) : null;
}

/** Gather one source defensively: a scan/read that throws degrades to `fallback` so a single failing
 *  source can never blank the whole Today projection (it just shows that section as empty/warming). */
async function gatherSource<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    getActivePipeline()?.log.child({ scope: 'today' }).warn('today.source-failed', { source: label, err });
    return fallback;
  }
}

/** The Today compute (background cadence): compose the maintained projections + the two background
 *  scans (health, activity) into the full Today projection. Reads the EVERGREEN vault root for health
 *  (STATE-7, like the rest of recall). Null when no KB is open. Every individual source is gathered
 *  defensively (graceful-degrade) and the pure `assembleTodayProjection` tolerates null/empty sources. */
async function computeTodayProjection(): Promise<TodayProjection | null> {
  const a = getActivePipeline();
  if (!a) return null;
  const nowMs = Date.now();
  // Instant maintained reads (no scan) — the snapshots the status/graph/review stores already keep warm.
  const status = statusStore.current(); // PipelineStatusView | null (instant, envelope already unwrapped)
  const graph = graphProjectionForActive()?.data ?? null;
  const openReviews = reviewProjectionForActive()?.data?.length ?? 0;
  // Background scans (off the render path). DEV-2's Health re-point will later derive these off the graph
  // projection, retiring the walk here; the composite shape is unchanged when it does.
  const activity = await gatherSource<ActivityFeedEntry[]>(
    'activity',
    async () => buildFeed((await loadActivityIndex(a.stagingWt)).events),
    [],
  );
  const health = await gatherSource(
    'health',
    async () => toHealthProjection(await buildHealthReport(makeReadOnlyTools(a.vaultPath)), new Date(nowMs).toISOString()),
    null,
  );
  const contradictions = await gatherSource('contradictions', async () => (await readContradictionDirectives(a.stagingWt)).size, 0);
  const sources: TodaySources = {
    status,
    graph,
    health,
    activity,
    stations: status ? buildStations(status).map(toTodayStation) : ([] as TodayStation[]),
    openReviews,
    contradictions,
    inFlight: status?.inFlight?.length ?? 0,
    lastComposedAgoMs: lastComposedAgoFrom(activity, nowMs),
    movedRecently: activity.length, // the curated recent feed IS the "moved through" window (honest v1)
  };
  return assembleTodayProjection(sources, nowMs);
}

/** The maintained Today projection (SPEC-0058). Started/stopped with the stage sweeps. */
const todayStore: ProjectionStore<TodayProjection> = createProjectionStore<TodayProjection>({
  compute: computeTodayProjection,
  intervalMs: TODAY_REFRESH_MS,
  onError: (err) => getActivePipeline()?.log.child({ scope: 'today' }).warn('today.projection-refresh-failed', { err }),
  onUpdate: (projection) => pushProjectionChanged('today', projection.builtAt),
});

/** The render-path Today read (SPEC-0058): the background-maintained last-known-good projection, INSTANT
 *  — no git/fs/compute, so a Today read can never block on the backend. Null until the first snapshot is
 *  computed (the IPC layer maps that to a calm warming state). */
export function todayProjectionForActive(): Projection<TodayProjection> | null {
  return getActivePipeline() ? todayStore.current() : null; // no active KB → null (don't serve a closed vault's home)
}

/** Post-mutation refresh seam (mirrors `refreshGraphProjection`): re-read Today + push. Never on the
 *  render path. */
export function refreshTodayProjection(): Promise<void> {
  return todayStore.refreshNow();
}

// Self-register with pipelineLifecycle.ts so this module's four stores start/stop in lockstep with the
// stages, WITHOUT lifecycle.ts ever importing from here (the circular-dependency-avoiding inversion —
// see this file's + pipelineLifecycle.ts's header notes). This module is always loaded (pipeline.ts's
// barrel re-exports it), so the registration is guaranteed to run before `startPipeline()` is ever called.
registerProjectionLifecycleHooks({
  onStart: () => {
    statusStore.start(); // OBS-24: maintain the status snapshot off the render path (seed from persisted, then live)
    reviewStore.start(); // SHELL-12: maintain the review-queue projection off the render path
    graphStore.start(); // SPEC-0058 STATE-2: maintain the graph projection (Explore/Health) off the render path
    todayStore.start(); // SPEC-0058: maintain the Today home projection (composite) off the render path
  },
  onStop: () => {
    statusStore.stop(); // OBS-24: halt the background status refresh (retains the in-memory snapshot)
    reviewStore.stop(); // SHELL-12: halt the review-queue projection refresh (retains the in-memory projection)
    graphStore.stop(); // SPEC-0058 STATE-2: halt the graph projection refresh (retains the in-memory projection)
    todayStore.stop(); // SPEC-0058: halt the Today projection refresh (retains the in-memory projection)
  },
});
