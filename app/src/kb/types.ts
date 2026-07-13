// Shell-agnostic KB types: the data shapes + the IPC contract between main & renderer.
// No electron/obsidian imports here — this module must stay reusable (STACK-6).
//
// The Audit & Activity DTOs (SPEC-0029) live in their domain modules; we re-export them via
// TYPE-ONLY imports so the renderer/preload get one import surface (`../../kb/types`) without
// pulling those modules' runtime deps (node:fs / simple-git) into the renderer bundle — `import
// type` is erased at build time.
import type { ExploreEntityRef, ExploreNeighborhood, ExploreProjection } from './explorePanel';
import type { HealthProjection } from './healthProjection';
import type { HealthRemediateRequest, HealthRemediateResult, HealthDismissRequest, HealthDismissResult } from './healthRemediation';
export type { HealthRemediateRequest, HealthRemediateResult, HealthDismissRequest, HealthDismissResult };
import type { SchedulePreset, AutonomyPosture, Facing } from './jobs';
import type { WorkDepthConfig } from './workDepth';
import type { EgressTier, ResearcherTemplate } from './researchers';
import type { IntakeConnectorType } from './intakeConnectors';
import type { SourceSensitivity } from './sensitivityRead';
import type { ReviewSubjectCandidate } from './reviews';
import type { AuditEvent, AuditActor, AuditSubjects } from './audit';
import type { ActivityFilter } from './activityIndex';
import type { ActivityFeedEntry } from './activityDigest';
import type { Lineage } from './lineage';
import type { PipelineStatusView, StageStatus, RecentError, WorktreeInfo, SetAsideView, ConversionCounts, InFlightItem, HealthReadout } from './pipelineStatusView';
import type { MemorySample, MemTrend } from './memorySampler';
import type { CrashBreadcrumb, RendererErrorReport } from './crashCapture';
import type { DevLogLevel, ScaleStage } from './instanceConfig';

export type { AuditEvent, AuditActor, AuditSubjects, ActivityFilter, ActivityFeedEntry, Lineage };
export type { SourceSensitivity };
export type { PipelineStatusView, StageStatus, RecentError, WorktreeInfo, SetAsideView, ConversionCounts, InFlightItem };
// OBS-22 health readout + its sub-types (memory sample, leak trend, crash breadcrumb) for the renderer.
export type { HealthReadout, MemorySample, MemTrend, CrashBreadcrumb };
// OBS-18 (renderer): the renderer→main error report shape.
export type { RendererErrorReport };
// REVIEW-16: per-candidate disambiguation context (name + gloss + source link), rendered as rows.
export type { ReviewSubjectCandidate };

export const KB_CONFIG_VERSION = 1;

/** Vault-level config, persisted at `<vault>/.kb/config.json`. */
export interface VaultConfig {
  schemaVersion: number;
  id: string; // stable unique id for this KB / Instance
  name: string;
  createdAt: string; // ISO timestamp
}

export interface CopilotStatus {
  available: boolean;
  detail: string; // human-readable: which binary, or why not found
}

/** Result of inspecting a candidate vault folder during setup. */
export interface PathInspection {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  gitInstalled: boolean; // system git on PATH (STACK-4)
  isGitRepo: boolean; // the folder is already a git repo
  alreadyKb: boolean; // already has a .kb/config.json
  copilot: CopilotStatus; // SETUP-4 (detect-only)
  /** Non-null when the path is inside a macOS TCC-protected location (Documents/Desktop/Downloads/
   *  iCloud Drive): the dir's friendly name. A vault here silently breaks the pipeline — git/copilot
   *  subprocess writes fail with `Operation not permitted` until the app is signed+entitled (STACK-10,
   *  BUG #56). Setup warns and steers the user to an unprotected location. Null elsewhere. */
  tccProtectedDir: string | null;
}

export interface CreateKbOptions {
  path: string;
  name?: string;
  initGitIfNeeded: boolean;
}

export interface CreateKbResult {
  ok: boolean;
  vaultConfig?: VaultConfig;
  committed?: boolean;
  message: string;
}

// --- macOS folder-permission UX (SPEC-0034 MACOS-7, "Asking for the keys") ---

/** Result of probing vault write-access (MACOS-7). The probe performs a benign write into the vault to
 *  trigger the macOS TCC grant dialog; `ok` = the app can write the vault, `denied` = the failure was a
 *  permission denial (TCC not granted) → route to the Blocked recovery vs a generic error. */
export interface ProbeVaultAccessResult {
  ok: boolean;
  denied: boolean;
  message: string;
}

/** Result of opening the macOS System Settings Privacy pane (MACOS-7 denied-recovery). `usedFallback`
 *  = the precise Files-and-Folders anchor didn't resolve, so the general Privacy & Security pane opened
 *  instead (never a no-op click). */
export interface OpenSettingsResult {
  ok: boolean;
  usedFallback?: boolean;
  message?: string;
}

/** What the renderer asks for on launch to decide Setup vs. loaded (SETUP-6). */
export interface AppState {
  activeVaultPath: string | null;
  vaultConfig: VaultConfig | null;
}

// --- Capture / ingestion (SPEC-0013 CAPTURE) ---

export interface CaptureTextInput {
  kind: 'text';
  text: string; // the captured payload (Markdown for a rich paste — RICHIN-1)
  /** Original clipboard HTML for a rich paste, preserved verbatim as an `original.html` sidecar
   *  (RICHIN-2). Present only when the paste's markup added structure over the plain text. */
  html?: string;
}
export interface CaptureFileInput {
  kind: 'file';
  name: string; // original filename
  data: Uint8Array; // raw bytes (read in the renderer from the dropped File)
}
/**
 * #512 PERF-R8: a dropped file staged by PATH, not bytes — the renderer resolves the drop's real
 * on-disk path (`webUtils.getPathForFile`, the documented replacement for the removed `File.path`)
 * instead of calling `file.arrayBuffer()`, so staging (and holding) a large dropped file costs the
 * renderer ~0 heap. Main reads the bytes itself on submit (`kb:capture`), same as it always read a
 * `CaptureFileInput`'s bytes — the difference is WHEN and WHERE the read happens, not the eventual
 * write. Preferred over `CaptureFileInput` whenever a real path is available (i.e., a genuine file
 * drop); `CaptureFileInput` stays for a pasted-image File, which the browser gives no path for.
 */
export interface CaptureFilePathInput {
  kind: 'filePath';
  name: string; // original filename
  path: string; // the dropped file's real on-disk path
}
/**
 * SPEC-0038 QCAP-13: a screenshot / clipboard-image the main process captured to a temp PNG and
 * handed back as an opaque `handle`. The bytes NEVER pass through the renderer/DOM — on submit the
 * main process reads the temp file (validating the handle is one IT issued) → a file source on the
 * SPEC-0013 path, then deletes the temp. `name` is the suggested source filename.
 */
export interface CaptureScreenshotInput {
  kind: 'screenshot';
  handle: string;
  name: string;
}
export type CaptureInput = CaptureTextInput | CaptureFileInput | CaptureFilePathInput | CaptureScreenshotInput;

export interface CaptureRequest {
  inputs: CaptureInput[];
}
export interface CaptureResult {
  ok: boolean;
  ids: string[];
  captureBatch: string | null;
  committed: boolean;
  message: string;
  /** SPEC-0034 MACOS-7 / #56: the capture write hit a macOS folder-permission denial (TCC not granted)
   *  — so the capture UI routes to the Blocked recovery instead of surfacing the raw OS error string. */
  blocked?: boolean;
}

/**
 * macOS Accessibility grant state for selection-capture (SPEC-0038 QCAP-9, Slice 2). Drives the
 * sheet's permission UX: `granted` → the focused selection can prefill; `denied` → degrade to
 * clipboard-only + steer to Settings·Privacy·Accessibility; `unsupported` → no platform support.
 */
export type AccessibilityStatus = 'granted' | 'denied' | 'unsupported';

/**
 * Context the Quick Capture sheet pre-fills from (SPEC-0038 QCAP-7). Slice 1 = current clipboard text;
 * Slice 2 adds the focused-app `selection` (read at summon, before the sheet steals focus) and the
 * `accessibility` grant state so the sheet can steer to Settings on a denied grant (QCAP-9).
 */
export interface QuickCaptureContext {
  clipboard: string;
  /** The focused-app text selection at summon time, or null (denied/unsupported/empty) — QCAP-7. */
  selection: string | null;
  /** Accessibility grant state driving the sheet's permission UX (QCAP-9). */
  accessibility: AccessibilityStatus;
  /** QCAP-13: an image on the clipboard, captured by main to a temp PNG handle — the "paste an image"
   *  prefill + the Screen-Recording-denied degrade. Null when the clipboard holds no image. */
  clipboardImage: ScreenshotHandle | null;
  /** QCAP-13: whether screenshot capture is available (macOS only) — drives whether the cluster shows. */
  screenshotSupported: boolean;
}

/** SPEC-0038 QCAP-13: the three macOS `screencapture` modes (full `-x` / region `-i` / window `-w`). */
export type ScreenshotMode = 'full' | 'region' | 'window';

/** An opaque temp-PNG handle the main process issued (it alone can read it back to capture). */
export interface ScreenshotHandle {
  handle: string;
  name: string;
}

/**
 * SPEC-0038 QCAP-13: outcome of a screenshot capture. `granted` + an `image` handle on success;
 * `denied` (Screen-Recording TCC not granted → the sheet's brass steer + degrade to paste-image);
 * `unsupported` (non-macOS); `cancelled` (the user dismissed an interactive region/window pick — a
 * benign no-op, not an error). The captured PNG bytes stay in main (handle round-trip only).
 */
export interface ScreenshotResult {
  status: 'granted' | 'denied' | 'unsupported' | 'cancelled';
  image: ScreenshotHandle | null;
}

/** Minimal pipeline status for the capture panel (SPEC-0014 ORCH-10). */
export interface PipelineStatus {
  queueDepth: number;
  processing: string | null;
  lastArchived: string | null;
  updatedAt: string | null;
}

/** Graceful-shutdown drain status (SPEC-0045 QUIESCE-3). `quiescing` = new work paused + draining;
 *  `remaining` = tasks still to finish across stages + schedulers; `safe` = true once fully idle (queues
 *  empty + nothing in flight + writer lock free) so the user can quit cleanly; `detail` = a human line. */
export interface QuiesceStatus {
  quiescing: boolean;
  remaining: number;
  safe: boolean;
  detail: string;
}

// --- SHELL-12: the cached-projection envelope (the cross-boundary contract) ---

/** The uniform envelope every surface reads off the maintained cached-projection backbone (SHELL-12).
 *  `data` is the last-known-good view-model the surface renders INSTANTLY (the render path does zero
 *  git/fs/lock/recompute); `builtAt` is the "as of" ISO timestamp; `stale` is true when the most recent
 *  background refresh errored — the data is retained but may be behind. A consumer MUST honor `stale`
 *  with a visible "as of / updating…" affordance: stale-but-fast is honest, a frozen-but-looks-fresh UI
 *  is the failure mode SHELL-12 kills. The store (`main/projectionStore.ts`) owns the mechanics. */
export interface Projection<T> {
  data: T;
  builtAt: string;
  stale: boolean;
}

// --- Today (SPEC-0058 STATE-7) — the v2 command-center home's exact view data-contract ---
// "Design from the screens inward": Today draws everything below from ONE projection read (no
// supplementary live fetch). Built by `buildTodayProjection` (pure) by COMPOSING existing projections
// (graph/activity/registry/status) — never a new live vault scan (STATE-1). The renderer (todayView)
// wires this shape into Design-Lead's CSS/layout; the projection carries no more than Today consumes.

/** Time-of-day greeting + the Principal's name (when known). */
export interface TodayGreeting {
  salutation: string; // "Good morning" / "Good afternoon" / "Good evening"
  name?: string; // the Principal's name when set; the view omits the comma when absent
}

/** One pipeline-ribbon station ("The Line"). A slim subset of the Status view's `StationModel`, built
 *  from the SAME lifted `buildStations` (SPEC-0058 "one Line, one truth", DL-1) — so Today's ribbon is
 *  byte-identical to Status's. `state` is the native stage liveness (NOT a remapped done/active/idle;
 *  an already-passed station reads `idle`). The view renders the same station-state language as Status
 *  (running=sprout/breathe · blocked=brass · error=oxide · idle=neutral; state never colour-alone, #184). */
export interface TodayStation {
  name: string; // human stage label (stageDisplayName) — Capture · Archiving · Decompose · Connect · …
  stage: string; // canonical stage id (the lowercase routing id; display uses `name`)
  state: 'idle' | 'running' | 'blocked' | 'error';
  glyph: string; // the state glyph (○ idle · ▣ running · ◐ blocked · ✕ error)
  count: number; // items at this station now = queued + inProgress
}

/** One headline stat card with a today-delta. */
export interface TodayStat {
  key: 'sources' | 'claims' | 'entities' | 'connections';
  label: string;
  value: number;
  delta: { dir: 'up' | 'flat'; text: string }; // "+6 today" / "stable"
}

/** One recent-activity feed row (from the curated activity projection). */
export interface TodayActivityItem {
  kind: 'composed' | 'connected' | 'extracted' | 'captured' | 'linked' | 'other';
  text: string; // human summary (the view esc()s it)
  ref?: string; // a [[wikilink]] / source basename the summary references
  when: string; // relative age, e.g. "6m"
}

/** One "Needs you" decision card (open review / surfaced contradiction). */
export interface TodayDecision {
  kind: 'contradiction' | 'review';
  title: string;
  body: string;
  action: string; // the CTA label ("Resolve" / "Review")
  targetView: string; // the view id to navigate to (e.g. "reviews")
}

/** One health-glance row — the SAME dimensions + severity enum as the real Health projection (SPEC-0058
 *  STATE-3), so a dimension reads identically (incl. oxide for a `bad` dead-link) on Today and Health.
 *  Grounding-coverage is deferred (not computed yet), so it's intentionally NOT a row here. */
export interface TodayHealthRow {
  key: 'dangling' | 'orphans' | 'thin';
  label: string;
  sub: string;
  value: string; // the count, e.g. "0" / "11"
  status: 'ok' | 'warn' | 'bad'; // bad=oxide (dangling/dead links), warn=brass (orphans/thin), ok=settled
}

/** The whole Today surface, served as one `Projection<TodayProjection>`. */
export interface TodayProjection {
  greeting: TodayGreeting;
  subtitle: string; // "Your library is quiet and current — 3 things moved while you were away."
  line: { meta: string; stations: TodayStation[] }; // "2 in flight · last composed 6m ago"
  stats: TodayStat[]; // exactly the 4 headline cards
  activity: TodayActivityItem[]; // most-recent first, capped for the panel
  decisions: TodayDecision[]; // empty → the calm "nothing needs you" rest state
  health: TodayHealthRow[]; // the 3 glance rows
}

/** The `kb:getTodayProjection` envelope (SPEC-0058 STATE-9/10), mirroring `ExploreProjection`. `status`
 *  is FIRST-CLASS — the Today view switches on it directly: a calm `warming` while the composite is still
 *  building its first snapshot (never the alarming error face), `ready` once built. `data` is null while
 *  `warming`; `builtAt`/`stale` carry the freshness envelope ("as of / updating…"). The live date/time
 *  clock is view-rendered (it ticks), not in `data`. `error` is reserved for the CORE's STATE-12 status. */
export interface TodayProjectionView {
  status: 'warming' | 'ready' | 'error';
  data: TodayProjection | null;
  builtAt: string | null;
  stale: boolean;
}

// --- Review / "needs you" queue (SPEC-0018 REVIEW) ---

/** One open review as the Reviews view needs it (REVIEW-10). */
export interface ReviewSummary {
  id: string;
  question: string; // the yes/no question
  detail: string; // expandable context (REVIEW-3)
  stage: string; // which stage raised it
  refs: string[]; // subject entity names / mentions
  // REVIEW-16: decision-grade per-candidate context for a disambiguation review — each row is a
  // distinguishing gloss + (when known) a working "Open in Obsidian" source link. Absent/empty on
  // ordinary (non-disambiguation) reviews. Gloss/name are agent-authored → the view MUST esc() them.
  candidates?: ReviewSubjectCandidate[];
  createdAt: string;
}

export interface AnswerReviewRequest {
  id: string;
  verdict: 'confirm' | 'reject';
  note?: string; // optional; captured as a primary source (REVIEW-7)
}
export interface AnswerReviewResult {
  ok: boolean;
  message: string;
}

// --- Pipeline recovery control (SPEC-0030 OBS-17) ---

/** A Principal-initiated recovery action on a set-aside/poison item (OBS-17). Stage-parameterized
 *  so decompose/connect are additive (claims-only handlers in v1); `itemId` is the entity id the
 *  Status view surfaced, resolved to its node path by the handler. */
export interface PipelineControlRequest {
  action: 'retry' | 'dismiss';
  stage: string;
  itemId: string;
}
export interface PipelineControlResult {
  ok: boolean;
  message?: string; // a human reason on failure / no-op (e.g. already recovered, unsupported stage)
}

// --- Replay & Reprocessing (SPEC-0022 REPLAY) ---

/** Result of a Principal-initiated full replay (clean & rebuild). */
export interface FullReplayResult {
  ok: boolean;
  replayId?: string; // the epoch minted for this replay (REPLAY-6)
  sourcesReset?: number; // how many Sources were epoch-reset for reprocessing
  purgedTrees?: string[]; // which derived trees were cleared (REPLAY-4)
  message: string;
}

// SPEC-0046 COMPOSE-9: the "backfill the vault" coverage + one-shot trigger result. `total` = entities
// with cited claims; `composed` = of those, how many already read as an article; `remaining` = still
// block-only. `reopened` (trigger only) = set-aside entities re-queued for a fresh attempt.
export interface ComposeBacklogResult {
  ok: boolean;
  total?: number;
  composed?: number;
  remaining?: number;
  reopened?: number;
  message: string;
}

// --- Ask & Recall (SPEC-0026 ASK) ---

// The recall engine owns these shapes; re-exported here so the renderer/IPC contract has one
// import surface. (types.ts stays electron/obsidian-free, STACK-6 — recall.ts is pure kb domain.)
export type { AskResult, Citation, RecallTurn, AskProgressEvent } from './recall';
import type { AskResult, RecallTurn, AskProgressEvent } from './recall';
import type { RecallEffort } from './recallConstants';
export type { RecallEffort };
import type { Conversation, ConversationTurn, ConversationSummary } from './conversation';
export type { Conversation, ConversationTurn, ConversationSummary };

/** A recall request from the Ask view: an NL question + the in-session history (ASK-8). */
export interface AskRequest {
  question: string;
  history?: RecallTurn[];
  /** SPEC-0060 VUX-11: the Ask "Quick vs Considered" depth toggle. Omitted ⇒ `considered` (the prior
   *  full-depth default), so existing callers and saved threads are unaffected. */
  effort?: RecallEffort;
}

/** Result of saving a recall answer as a KB Output (ASK-6). `rel` is the Output's repo path on success. */
export interface SaveRecallOutputResult {
  ok: boolean;
  rel?: string;
  message: string;
}

/** Result of opening a citation in Obsidian (ASK-14). `ok:false` carries a `reason` for inline surfacing
 *  (no active vault, the ref escaped containment, or the OS had no handler for the `obsidian://` scheme). */
export interface OpenCitationResult {
  ok: boolean;
  reason?: 'no-vault' | 'invalid-ref' | 'open-failed';
}

/**
 * Result of a WORKING-ZONE-AWARE source open (SPEC-0018 REVIEW-17 / PRIN-24). A review's source may be
 * staging-only (raised mid-pipeline, not yet promoted to the user's Obsidian vault), so the open
 * resolves the source's location at click-time and NEVER fires a dead `obsidian://` link:
 *  - `opened`   — the source is on `main`; the `obsidian://open` deep link was handed to the OS.
 *  - `staging`  — staging-only (not in the vault yet) → the caller shows an in-app / "still processing"
 *                 state (it already holds the human source title for that surface — PRIN-24).
 *  - `missing`  — not found in either zone (deleted / stale ref) → no open, no dead link.
 *  - `no-vault` / `invalid-ref` / `open-failed` — no active vault, a bad/escaping ref, or the OS had
 *                 no `obsidian://` handler. */
export interface OpenSourceRefResult {
  status: 'opened' | 'staging' | 'missing' | 'no-vault' | 'invalid-ref' | 'open-failed';
}

// --- Control Panel · Jobs (SPEC-0027 PANEL-2; over the SPEC-0023 registry) ---

/** Last-run summary for a job, derived from its run-state journal (JOBS-7/8) for display. */
export interface JobLastRun {
  ts: string; // ISO timestamp of the last run
  inspected: string; // what the pass looked at
  applied: number; // findings auto-applied
  deferred: number; // findings routed to Review
  note?: string; // e.g. 'collision-exhausted' (a set-aside run)
}

/** One manageable job as the Jobs view needs it (PANEL-2): catalog metadata + current config + last run. */
export interface JobView {
  id: string;
  type: string;
  label: string; // catalog label (or the type, for a registered job with no catalog entry)
  description: string;
  production: boolean; // false → a reference/non-production job (flagged in the UI)
  registered: boolean; // true once persisted in the registry (false = catalog-only, defaults shown)
  enabled: boolean;
  schedule: SchedulePreset;
  posture: AutonomyPosture;
  facing: Facing; // JOBS-16: internal (no egress) | external (researcher). Built-in's catalog facing.
  workDepth: WorkDepthConfig | null; // JOBS-17: stored per-item depth config; null = the kind's default
  lastRun: JobLastRun | null; // null = never run
}

/** A config change from the Jobs view (PANEL-2/6). `type` lets the main process seed a catalog-only
 *  job into the registry on first edit. Omitted fields are left unchanged. */
export interface JobConfigPatch {
  id: string;
  type: string;
  enabled?: boolean;
  schedule?: SchedulePreset;
  posture?: AutonomyPosture;
  /** JOBS-17: edit the per-item work-depth (level + optional explicit overrides). Sanitized + clamped
   *  main-side; absent leaves it unchanged. (Facing is catalog-fixed in slice 1 — authoring lands in JOBS-18.) */
  workDepth?: WorkDepthConfig;
}

/** Outcome of a manual "Run now" (PANEL-2; JOBS-11). `ran:false` carries why it didn't run. */
export type RunJobResult =
  | { ran: true; outcome: 'advanced' | 'noop' | 'setaside'; applied: number; deferred: number }
  | { ran: false; reason: 'skipped' | 'not-found' | 'unknown-type' | 'no-kb' };

// --- Control Panel · Researchers (SPEC-0028 RESEARCH-15; over the researcher registry) ---

/** Last-run summary for a researcher, derived from its newest `researcher` audit event, for display. */
export interface ResearcherLastRun {
  ts: string; // ISO timestamp of the last pass
  eventType: string; // 'researched' | 'no-finding' | 'research-failed' | 'ceiling-reached' | 'escalated'
  what: string; // the request term it answered
  sourceId?: string; // the secondary source produced (when it found something)
  citations: number; // external citations on the finding
  /** The depth-limit escalation Review this pass raised (RESEARCH-11) — present on an `escalated`
   *  event, so the Field Desk can deep-link "needs your review" to the open Review (no dead affordance). */
  reviewId?: string;
}

/** One manageable researcher as the Researchers view needs it (RESEARCH-15): config + last run. */
export interface ResearcherView {
  id: string;
  template: ResearcherTemplate;
  label: string;
  /** The researcher's standing instructions / prompt (RESEARCH-17) — editable in the Manage view. */
  prompt: string;
  /** Code-template config: the local repository path the researcher reads (`config.repoPath`); empty
   *  when unset (the Code researcher is inert until set). Shown only for `code` researchers. */
  repoPath: string;
  /** M365-template config: the tenant id the researcher reads (`config.tenantId`); empty when unset
   *  (the M365 researcher is inert until set). Shown only for `m365` researchers (SPEC-0028 Slice 3). */
  tenantId: string;
  /** Code-template config: the GitHub PR repo (`config.prRepo`, `owner/name`) the researcher scans;
   *  empty when unset (PR reads are inert until set). Shown only for `code` researchers (Slice 2b). */
  prRepo: string;
  egressTier: EgressTier;
  scope: string;
  enabled: boolean;
  schedule: SchedulePreset;
  posture: AutonomyPosture;
  topics: string[];
  /** Per-pass retrieval/chain bounds (RESEARCH-11). `maxToolCalls` is now EDITABLE (RESEARCH-15, WS3);
   *  `maxDepth` stays read-only (safety bound, editor deferred to Slice-2). */
  budget: { maxToolCalls: number; maxDepth: number };
  /** Effective per-pass session timeout in ms (RESEARCH-18) — the persisted value or the default; EDITABLE (WS3). */
  timeoutMs: number;
  /** Effective per-pass orient/awareness budget (RESEARCH-22) — the persisted value or the default;
   *  EDITABLE (warm-start). The non-egress awareness cap, separate from `budget.maxToolCalls`. */
  orientBudget: number;
  /** The researcher's tool/MCP allowlist (RESEARCH-12) — surfaced READ-ONLY in the reach readout so a
   *  researcher's reach is always legible. It is a SECURITY surface and stays non-editable (WS3). */
  allowedTools: string[];
  lastRun: ResearcherLastRun | null; // null = never run
}

/** A config change from the Researchers view (RESEARCH-15). Omitted fields are left unchanged. New
 *  researcher = include template + prompt + egressTier. `id` must be a bare slug (registry-guarded). */
export interface ResearcherConfigPatch {
  id: string;
  template?: ResearcherTemplate;
  label?: string;
  prompt?: string;
  /** Code-template config: the local repo path to read (merged into `config.repoPath`). */
  repoPath?: string;
  /** M365-template config: the tenant id to read (merged into `config.tenantId`). */
  tenantId?: string;
  /** Code-template config: the GitHub PR repo `owner/name` to scan (merged into `config.prRepo`). */
  prRepo?: string;
  egressTier?: EgressTier;
  scope?: string;
  enabled?: boolean;
  schedule?: SchedulePreset;
  posture?: AutonomyPosture;
  topics?: string[];
  /** Editable per-pass retrieval budget (RESEARCH-15, WS3) — clamped/validated at the IPC boundary. */
  maxToolCalls?: number;
  /** Editable per-pass session timeout in ms (RESEARCH-18, WS3) — clamped/validated at the IPC boundary. */
  timeoutMs?: number;
  /** Editable chain-depth safety bound (RESEARCH-11, WS3 Slice-2) — clamped/validated at the IPC boundary. */
  maxDepth?: number;
  /** Editable per-pass orient/awareness budget (RESEARCH-22, warm-start) — clamped/validated at the IPC boundary. */
  orientBudget?: number;
}

/** A watched folder's most-recent activity, folded into the view from the `watch` audit (SPEC-0037). */
export interface WatchFolderLastEvent {
  ts: string;
  /** The audit event kind: 'watch-ingested' | 'watch-no-new' | 'watch-refused' | 'watch-failed'. */
  kind: string;
  /** A representative file the event concerns (an ingested file's name), when one applies. */
  path?: string;
}

/** A watched-folder display row for the unified Sources view (SPEC-0037 WATCH-9). One `kb:listWatchFolders`
 *  read per render carries the config + live `watching` flag + the folded `lastEvent` (no separate status read). */
export interface WatchFolderView {
  id: string;
  folderPath: string;
  /** Human label; falls back to the id. */
  label: string;
  enabled: boolean;
  scope: string;
  sensitivity: string;
  ignoreGlobs: string[];
  /** Opt-in recursive watch (WATCH-12); default false = non-recursive. */
  recursive: boolean;
  /** Effective recursion depth cap shown/edited in the view (WATCH-12); 0 when non-recursive. */
  maxDepth: number;
  /** WATCH-16: the folder DRAINS (consume/move-out) by default; this is the **copy opt-out** state — true
   *  iff the folder is in "leave originals in place" mode (the original is NOT moved out after ingest). */
  leaveOriginals: boolean;
  /** True iff a live watcher is currently active for this folder (enabled + loop-safe). */
  watching: boolean;
  lastEvent: WatchFolderLastEvent | null;
}

/** A Sources-view edit to a watched folder (SPEC-0037). `folderPath` (on create/change) is loop-guarded
 *  + validated at the IPC boundary; an unsafe id is rejected by the registry guard. */
export interface WatchFolderPatch {
  id: string;
  folderPath?: string;
  enabled?: boolean;
  scope?: string;
  sensitivity?: string;
  label?: string;
  ignoreGlobs?: string[];
  /** Opt into recursive watch (WATCH-12). */
  recursive?: boolean;
  /** Recursion depth cap (WATCH-12); clamped at the IPC boundary. */
  maxDepth?: number;
  /** WATCH-16 drain/copy mode: `true`/absent → drains (move-out); `false` → copy (leave originals). */
  consume?: boolean;
}

/** Outcome of a manual researcher "Run now" (RESEARCH-15). `ran:false` carries why it didn't run;
 *  `ran:true` + `failed` means the pass ERRORED (e.g. packaged-app can't spawn copilot, #160); `ran:true`
 *  + `ceilingReached` means it was paused by the per-Instance rate-limit (RESEARCH-11) — both distinct
 *  from a legit "no new finding" (failed/blocked ≠ empty). */
export type RunResearcherResult =
  | { ran: true; sourceIds: string[]; note: string; failed?: boolean; error?: string; ceilingReached?: boolean }
  | { ran: false; reason: 'not-found' | 'no-kb' };

/** WORKIQ-FIX (SPEC-0028 Slice 3): the WorkIQ/M365 researcher's CLI setup status for the Sources card.
 *  When `installed:false` the m365 researcher FAILS LOUD (a `research-failed` needs-setup audit event)
 *  rather than the old silent no-finding — the card prompts the Principal to install the CLI. */
export interface WorkIqStatus {
  /** Is the `workiq` CLI resolvable on the (PATH-ensured) login-shell PATH? */
  installed: boolean;
  /** Resolved absolute path to the CLI when installed (provenance/debug; omitted when missing). */
  cliPath?: string;
  /** Principal-facing install command the card surfaces (and its button runs), e.g. `npm install -g …`. */
  installCommand: string;
}

/** Outcome of the WorkIQ install command run from the setup card. `ok:true` ⇒ re-detected installed;
 *  `ok:false` carries the cause + the (still-current) status so the card renders the failure inline. */
export type InstallWorkIqResult =
  | { ok: true; status: WorkIqStatus }
  | { ok: false; error: string; status: WorkIqStatus };

// --- Control Panel · Sources (SPEC-0027 PANEL-4 — INTAKE-14 + WATCH-9, the unified Sources view) ---

/** A connector's last pull, derived from its newest `intake` audit event (or null = never run). */
export interface IntakeConnectorLastRun {
  ts: string; // ISO timestamp of the last pass
  eventType: string; // 'intook' | 'no-new-items' | 'intake-failed'
  count: number; // items ingested this pass (0 for a no-op / failure)
  error?: string; // present on an `intake-failed` event (failed≠empty surfaced)
}

/** One manageable INTAKE connector as the Sources view needs it (INTAKE-4/14): config + last run. */
export interface IntakeConnectorView {
  id: string;
  type: IntakeConnectorType;
  /** Catalog label for the connector's type (e.g. "RSS / Atom feed"), Principal-facing. */
  typeLabel: string;
  /** Principal-facing label, falling back to the id. */
  label: string;
  enabled: boolean;
  schedule: SchedulePreset;
  scope: string;
  sensitivity: string;
  /** Max items pulled per bounded pass (INTAKE-11) — editable. */
  maxItemsPerPass: number;
  /** Type-specific config the Principal steers: RSS `feedUrl`; M365 `tenantId`/`folder`. Empty when unset. */
  feedUrl: string;
  tenantId: string;
  folder: string;
  lastRun: IntakeConnectorLastRun | null; // null = never run
}

/** A config change from the Sources view (INTAKE-14). Omitted fields are left unchanged. A new
 *  connector = include `type`. `id` must be a bare slug (registry-guarded). */
export interface IntakeConnectorConfigPatch {
  id: string;
  type?: IntakeConnectorType;
  label?: string;
  enabled?: boolean;
  schedule?: SchedulePreset;
  scope?: string;
  sensitivity?: string;
  maxItemsPerPass?: number;
  /** RSS: the feed URL (merged into `config.feedUrl`). */
  feedUrl?: string;
  /** M365-mail: the tenant id (merged into `config.tenantId`). */
  tenantId?: string;
  /** M365-mail: the mail folder (merged into `config.folder`). */
  folder?: string;
}

/** Outcome of a manual INTAKE connector "Run now" (INTAKE-14). `ran:false` carries why; `ran:true` +
 *  `failed` means the pull ERRORED (e.g. unreachable feed / unconfigured M365) — distinct from a legit
 *  "no new items" (failed≠empty). */
export type RunIntakeConnectorResult =
  | { ran: true; sourceIds: string[]; note: string; failed?: boolean; error?: string }
  | { ran: false; reason: 'not-found' | 'no-kb' };

// --- Control Panel · Settings + Agents (SPEC-0027 PANEL-3/5) ---

/** Editable per-Instance settings surfaced in Settings (PANEL-5 / AUTO-12). */
export interface InstanceSettings {
  autonomyDefault: AutonomyPosture;
  /** Dev-log verbosity (SPEC-0030 OBS-10): `info` (default) or `debug` to troubleshoot. */
  devLogLevel: DevLogLevel;
  /** Quick Capture global hotkey accelerator (SPEC-0038 QCAP-6), e.g. `Alt+Space`. */
  quickCaptureAccelerator: string;
  /** Recall interactive work budget in ms (ASK-17 / JOBS-17): how long a grounded query may run
   *  before returning its best partial. Optional in the edit contract (preserve-on-omission). */
  recallBudgetMs?: number;
  /** Recall's explicit retrieval tool-call override (ASK-19 / JOBS-17): how far a grounded query may
   *  search per question. A number sets the manual override (clamped); `null` CLEARS it back to the
   *  graph-size-scaled default ("scale to KB size"); omitted (`undefined`) preserves the prior value
   *  (the #102 preserve-on-omission rule). */
  recallMaxToolCalls?: number | null;
  /** SPEC-0048 SCALE-2: per-stage concurrency cap overrides. Absent keys ⇒ today's default; Connect
   *  is pinned to 1 (SCALE-5). Optional in the edit contract (preserve-on-omission). */
  stageCaps?: Partial<Record<ScaleStage, number>>;
  /** SPEC-0048 SCALE-1: the global Copilot concurrency ceiling override. A number sets the manual
   *  override (clamped); `null` explicitly CLEARS it back to the cores-derived default ("let the app
   *  decide"); omitted (`undefined`) preserves the prior value (the #102 preserve-on-omission rule).
   *  Env `KB_COPILOT_MAX_CONCURRENCY` still wins over any of these. */
  copilotCeiling?: number | null;
}

/** Live scale/concurrency runtime (SPEC-0048 SCALE-7/8) for the Settings "Scale" card's throttled
 *  indicator. `adaptive` = the Auto/AIMD controller is driving (vs a fixed env/manual pin). `effective`
 *  = the live global ceiling; `reference` = the healthy high-water it climbs back toward; `backedOff` =
 *  `effective < reference` (a rate-limit has us reduced → show "effective N of M — easing off rate
 *  limits"); `throttled` = inside the post-429 cooldown (the actively-easing window, drives the dot). */
export interface ScaleRuntime {
  adaptive: boolean;
  effective: number;
  reference: number;
  throttled: boolean;
  backedOff: boolean;
}

/** One librarian/stage agent as the Agents view needs it (PANEL-3) — observe + key config. */
export interface AgentView {
  key: string; // stable agent key (e.g. 'decompose')
  label: string; // Principal-facing name
  role: string; // one-line description of what it does
  model: string; // the model it ACTUALLY runs (per-agent pin → global → floor; or 'deterministic')
  /** SPEC-0048: this agent's persisted per-agent model pick, or undefined when it uses the global
   *  default — drives the per-agent picker's selected value + "Use default" detection. */
  configuredModel?: string;
  instructions: string; // pointer to its instruction source (file/built-in)
  status: 'running' | 'idle'; // live: running when the pipeline is active, else idle (PANEL-9)
}

/** SPEC-0048 — the model picker's view data. `accepted` is the live CLI catalog (null = couldn't probe;
 *  the picker then shows the resolved/configured value but can't offer a fresh list). `resolved` is what
 *  actually launches after override/probe/floor (the ORCH-28 "runs as" value). `configured` is the
 *  persisted global pick, if any. `staleConfigured` flags a persisted pick the live CLI no longer
 *  accepts (a brass "isn't available — running ‹resolved›" note; never hard-breaks — resolution fell back). */
export interface ModelCatalogView {
  accepted: string[] | null;
  resolved: string;
  configured?: string;
  staleConfigured: boolean;
}

/** SPEC-0048 — the result of persisting a model pick. */
export interface SetModelResult {
  ok: boolean;
  resolved: string; // the model that now launches (the pick if accepted, else the fallback)
  reason?: 'rejected'; // set when `id` wasn't in the live catalog (pick refused, resolution unchanged)
}

/** The API surface exposed to the renderer via contextBridge (preload). */
export interface KbApi {
  /** SPEC-0055 RELEASE-6: the running app version (matches the release tag), for the About panel. */
  getAppVersion(): Promise<string>;
  getState(): Promise<AppState>;
  pickFolder(): Promise<string | null>;
  inspect(path: string): Promise<PathInspection>;
  create(opts: CreateKbOptions): Promise<CreateKbResult>;
  // SPEC-0034 MACOS-7: probe vault write-access (triggers the macOS TCC dialog) + open the System
  // Settings Privacy pane for the denied-recovery flow ("Asking for the keys").
  probeVaultAccess(vaultPath: string): Promise<ProbeVaultAccessResult>;
  openSystemSettingsPrivacy(): Promise<OpenSettingsResult>;
  capture(req: CaptureRequest): Promise<CaptureResult>;
  // SPEC-0038 QCAP-1/2/5: fire-and-forget quick capture (text+clipboard) onto the SPEC-0013 path
  // (surface=quick-capture); quickCaptureClose dismisses the sheet + restores prior-app focus (QCAP-2);
  // quickCaptureContext supplies the clipboard prefill (QCAP-7).
  quickCapture(req: CaptureRequest): Promise<CaptureResult>;
  quickCaptureClose(): Promise<void>;
  quickCaptureContext(): Promise<QuickCaptureContext>;
  // SPEC-0038 QCAP-9 (Slice 2): open System Settings → Privacy & Security → Accessibility for the
  // denied-selection-capture recovery (the SPEC-0034 steer-to-Settings pattern; never a no-op).
  openAccessibilitySettings(): Promise<OpenSettingsResult>;
  // SPEC-0038 QCAP-13: capture a screenshot (full/region/window) to a temp PNG handle; open the
  // Screen-Recording Privacy pane for the denied-recovery steer (brass). Bytes stay in main.
  quickCaptureScreenshot(mode: ScreenshotMode): Promise<ScreenshotResult>;
  openScreenRecordingSettings(): Promise<OpenSettingsResult>;
  pipelineStatus(): Promise<PipelineStatus>;
  // SPEC-0030 OBS-5/6/7/11/15: the live Pipeline Status view-model (null when no KB is open).
  pipelineStatusView(): Promise<PipelineStatusView | null>;
  // SPEC-0030 OBS-18 (renderer): forward a renderer-side uncaught error / unhandled rejection to the
  // main app-log (the isolated renderer can't write it itself). Fire-and-forget.
  reportRendererError(report: RendererErrorReport): Promise<void>;
  listReviews(): Promise<ReviewSummary[]>;
  /** SHELL-12: the review queue WITH its freshness envelope (`builtAt`/`stale`) so the surface can show
   *  an "as of / updating…" affordance. `listReviews` stays the plain instant queue read. */
  reviewProjection(): Promise<Projection<ReviewSummary[]> | null>;
  answerReview(req: AnswerReviewRequest): Promise<AnswerReviewResult>;
  // SPEC-0030 OBS-17: retry / dismiss a set-aside (poison) item from the Status view (claims-only v1).
  pipelineControl(req: PipelineControlRequest): Promise<PipelineControlResult>;
  fullReplay(): Promise<FullReplayResult>;
  // SPEC-0046 COMPOSE-9 — backfill the vault: kick a bounded, coalesced recompose of the uncomposed
  // backlog (re-attempting any set-aside) and report coverage; the read-only status just reports it.
  composeBacklog(): Promise<ComposeBacklogResult>;
  composeBacklogStatus(): Promise<ComposeBacklogResult>;
  // SPEC-0045 QUIESCE — graceful "Prepare for shutdown": pause new work + drain, resume, poll drain status.
  quiesce(): Promise<QuiesceStatus>;
  resume(): Promise<QuiesceStatus>;
  quiesceStatus(): Promise<QuiesceStatus | null>;
  ask(req: AskRequest): Promise<AskResult>;
  // #514: live progress during an in-flight ask (kb:askProgress, pushed from main on the same channel
  // the invoking kb:ask ran on). Subscribe just before calling ask(), unsubscribe once it settles —
  // returns the unsubscribe fn. Fires 0+ times per ask; never fires outside an in-flight call.
  onAskProgress(cb: (evt: AskProgressEvent) => void): () => void;
  // SPEC-0026 ASK-6: save a grounded recall answer as a KB Output.
  saveRecallOutput(result: AskResult): Promise<SaveRecallOutputResult>;
  // SPEC-0060 VUX-11 (past-chats): persist/list/load Ask threads in app userData (NOT the vault). The id
  // a save returns can be passed back to UPDATE the same thread; load is ULID-contained in the store.
  saveConversation(req: { turns: ConversationTurn[]; id?: string; title?: string }): Promise<{ id: string }>;
  listConversations(): Promise<ConversationSummary[]>;
  loadConversation(id: string): Promise<Conversation | null>;
  // Past-chats per-row remove. ULID-contained; idempotent (ok:true whether removed or already absent).
  deleteConversation(id: string): Promise<{ ok: boolean }>;
  // SPEC-0026 ASK-14: open a citation's canonical target in Obsidian (obsidian:// deep-link). The
  // renderer passes the citation's vault-relative `ref`; main resolves + contains it, then opens it.
  openCitation(ref: string): Promise<OpenCitationResult>;
  // SPEC-0018 REVIEW-17: open a review candidate's SOURCE, working-zone-aware — Obsidian if it's on
  // `main`, else a `staging`/`missing` status the view surfaces (never a dead `obsidian://` link).
  openSourceRef(ref: string): Promise<OpenSourceRefResult>;
  // Control Panel · Jobs (SPEC-0027 PANEL-2)
  listJobs(): Promise<JobView[]>;
  setJobConfig(patch: JobConfigPatch): Promise<JobView[]>;
  runJobNow(id: string): Promise<RunJobResult>;
  // VUX-17 (#524 §5 / #559): the Agents drill-in's past-runs timeline — a job's full journal, newest-first.
  jobHistory(id: string): Promise<JobLastRun[]>;
  // SPEC-0029 Audit & Activity (read-only): the curated feed, raw events (drill-down/search), lineage.
  activityFeed(filter?: ActivityFilter): Promise<ActivityFeedResult>;
  activityEvents(filter?: ActivityFilter): Promise<AuditEvent[]>;
  activityLineage(id: string): Promise<Lineage>;
  // Control Panel · Settings + Agents (SPEC-0027 PANEL-3/5)
  getInstanceSettings(): Promise<InstanceSettings>;
  setInstanceSettings(settings: InstanceSettings): Promise<InstanceSettings>;
  /** Live scale runtime for the Scale card's throttled indicator (SCALE-7/8). */
  getScaleRuntime(): Promise<ScaleRuntime>;
  listAgents(): Promise<AgentView[]>;
  /** SPEC-0048: the model picker's data — the live CLI's accepted catalog, the currently-resolved
   *  model (after override/probe/floor), and the persisted global pick (if any). */
  getModelCatalog(): Promise<ModelCatalogView>;
  /** SPEC-0048: persist the Principal's global model pick (validated against the live catalog first).
   *  `null`/'' clears the override (→ preference-list probe drives). Returns the new resolved model +,
   *  on a rejected id, why (the picker stays catalog-valid, so this guards a programmatic/stale call). */
  setModel(id: string | null): Promise<SetModelResult>;
  /** SPEC-0048: set/clear ONE agent's per-agent model pick (validated). `null`/'' clears it → global. */
  setAgentModel(agentKey: string, id: string | null): Promise<SetModelResult>;
  // SPEC-0028 Researchers (Control Panel · Manage): manage the registry + on-demand run.
  listResearchers(): Promise<ResearcherView[]>;
  setResearcherConfig(patch: ResearcherConfigPatch): Promise<ResearcherView[]>;
  /** PANEL-11 lifecycle delete: purge a (user-added) researcher's config + audit the removal. Already-
   *  produced sources/findings + the audit trail are RETAINED. Returns the refreshed roster. */
  removeResearcher(id: string): Promise<ResearcherView[]>;
  runResearcherNow(id: string): Promise<RunResearcherResult>;
  listResearcherRuns(id: string): Promise<ResearcherLastRun[]>;
  // WORKIQ-FIX (SPEC-0028 Slice 3): the WorkIQ/M365 researcher CLI setup card — read status on mount,
  // and run the "simple workiq via CLI" install from the button (shells out in main, then re-detects).
  workIqStatus(): Promise<WorkIqStatus>;
  installWorkIq(): Promise<InstallWorkIqResult>;
  // SPEC-0037 WATCH-9: the unified Sources view's watched-folder rows. One list read folds config +
  // live `watching` + `lastEvent`; set (create/edit, loop-guarded at the IPC boundary) + remove.
  listWatchFolders(): Promise<WatchFolderView[]>;
  setWatchFolder(patch: WatchFolderPatch): Promise<WatchFolderView[]>;
  removeWatchFolder(id: string): Promise<WatchFolderView[]>;
  // SPEC-0027 PANEL-4 · Sources (INTAKE-14): manage intake feed connectors + on-demand run.
  listIntakeConnectors(): Promise<IntakeConnectorView[]>;
  setIntakeConnectorConfig(patch: IntakeConnectorConfigPatch): Promise<IntakeConnectorView[]>;
  /** PANEL-11 lifecycle delete: purge a (user-added) intake feed's config + audit the removal. Already-
   *  produced sources + the audit trail are RETAINED. Returns the refreshed list. */
  removeIntakeConnector(id: string): Promise<IntakeConnectorView[]>;
  runIntakeConnectorNow(id: string): Promise<RunIntakeConnectorResult>;
  // SPEC-0043 SENSE-7: Principal override of a source's sensitivity label (audited + Replay-sticky).
  // An empty `label` clears the override. Returns the applied label (or a reason when it couldn't apply).
  setSourceSensitivity(sourceId: string, label: string): Promise<{ ok: boolean; reason?: string; sensitivity?: string }>;
  /** SPEC-0043 SENSE-10: read sources' current sensitivity (+ provenance) for the Control-Panel display. */
  getSourceSensitivities(sourceIds: string[]): Promise<Record<string, SourceSensitivity>>;
  // SPEC-0039 EXPLORE: the read-only entity-neighborhood view over the evergreen `entities/` graph.
  // `exploreEntities` feeds the search-to-focus picker; `exploreNeighborhood` returns the focused
  // entity + its bounded 1-hop neighborhood (click-through to a node's page reuses `openCitation`).
  exploreEntities(): Promise<ExploreEntityRef[]>;
  exploreNeighborhood(focus?: string): Promise<ExploreNeighborhood>;
  // SPEC-0058 STATE-2: the single Explore read — {status, data:{neighborhood, entities}, builtAt, stale}
  // from the maintained graph projection (warming|ready; the view switches on status, no live walk).
  exploreProjection(focus?: string): Promise<ExploreProjection>;
  // SPEC-0035 HEALTH + SPEC-0058 STATE-3: the maintained Health PROJECTION (DL-2's render contract) — the
  // structural-lint glance (orphans / dead links / thin stubs) the view draws from one read, severity baked in.
  healthReport(): Promise<HealthProjection>;
  // SPEC-0060 VUX-16 slice-1: non-destructive Health remediation + dismiss/restore a finding.
  healthRemediate(req: HealthRemediateRequest): Promise<HealthRemediateResult>;
  dismissHealthFinding(req: HealthDismissRequest): Promise<HealthDismissResult>;
  // SPEC-0058 Today: the single home read — {status, data, builtAt, stale} from the maintained Today
  // projection (warming|ready; the view switches on status, no live scan). The live clock is view-rendered.
  getTodayProjection(): Promise<TodayProjectionView>;
  // SPEC-0058 STATE-8 (#510): subscribe to the main→renderer projection-changed push (`store` names one
  // of the four maintained stores — 'status'|'review'|'graph'|'today'). Unlike every other member here,
  // this is a SUBSCRIPTION, not a request/response call — it returns an unsubscribe function so a view's
  // `hide()` can stop listening (no leaked IPC listener across a view switch).
  onProjectionChanged(cb: (event: { store: string; builtAt: string }) => void): () => void;
  // #512 PERF-R7: the qcap sheet window is now kept alive (hidden, not destroyed) across summons so a
  // re-summon is instant — no BrowserWindow re-creation, no bundle re-parse. Since the page itself isn't
  // reloaded, main pushes this on every re-summon so the already-mounted sheet resets its own state
  // (re-fetches quickCaptureContext, clears the field) exactly as a fresh page load used to. A
  // SUBSCRIPTION like `onProjectionChanged`/`onAskProgress` — returns an unsubscribe fn, though the qcap
  // route's own single mount never needs to call it (the sheet lives for the window's lifetime).
  onQuickCaptureResummoned(cb: () => void): () => void;
  /** #512 PERF-R8: resolve a dropped File's real on-disk path (Electron's `webUtils.getPathForFile`,
   *  the documented replacement for the removed `File.path`) — lets Capture stage a `CaptureFilePathInput`
   *  by reference instead of reading the whole file into the renderer's heap. Synchronous (no IPC round
   *  trip — `webUtils` runs directly in the preload context) and never throws: an unresolvable File (not
   *  from a real drop, e.g. a pasted-image File) returns `''`, and the caller falls back to reading bytes. */
  getPathForFile(file: File): string;
}

/** The curated Activity feed + its window-cap signal. Consumers key off `total`/`truncated`, NOT
 *  `entries.length` (the feed is capped to the recent window — SPEC-0029 AUDIT-4/5, QA carry-forward). */
export interface ActivityFeedResult {
  /** Curated, human-friendly entries (one per run), newest-first, within the recent window. */
  entries: ActivityFeedEntry[];
  /** Total conforming events seen across the audit before the window cap. */
  total: number;
  /** True when older events were dropped from this window (never silently — surface in the UI). */
  truncated: boolean;
}
