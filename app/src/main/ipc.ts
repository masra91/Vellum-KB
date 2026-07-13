// IPC handlers — the main-process side of the KbApi contract (preload mirrors it).
import { app, ipcMain, dialog, shell, BrowserWindow, clipboard, type OpenDialogOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { inspectPath, createKb } from '../kb/vault';
import { ensureObsidianConfig } from '../kb/obsidianConfig';
import { isPermissionDeniedError } from '../kb/permissions';
import { readAppConfig, writeAppConfig } from './appConfig';
import {
  startPipeline,
  activePipeline,
  activeStagingRoot,
  pipelineStatusForActive,
  pipelineControlForActive,
  reviewProjectionForActive,
  answerActiveReview,
  remediateActiveHealthFinding,
  dismissActiveHealthFinding,
  saveRecallOutput,
  fullReplay,
  composeBacklog,
  composeBacklogStatus,
  listJobsForActive,
  setActiveJobConfig,
  runActiveJobNow,
  getActiveInstanceSettings,
  setActiveInstanceSettings,
  listAgentsForActive,
  getModelCatalogForActive,
  setActiveModel,
  setActiveAgentModel,
  listResearchersForActive,
  setActiveResearcherConfig,
  removeActiveResearcher,
  runActiveResearcherNow,
  listResearcherRunsForActive,
  listWatchFoldersForActive,
  setActiveWatchFolder,
  removeActiveWatchFolder,
  listIntakeConnectorsForActive,
  setActiveIntakeConnectorConfig,
  removeActiveIntakeConnector,
  runActiveIntakeConnectorNow,
  setActiveSourceSensitivity,
  getActiveSourceSensitivities,
  quiesceActive,
  resumeActive,
  quiesceStatusForActive,
  isActiveQuiescing,
  graphProjectionForActive,
  todayProjectionForActive,
} from './pipeline';
import { getQuickCaptureAgent } from './quickCaptureService';
import { captureScreenshot, consumeScreenshotHandle, clipboardImageHandle } from './quickCaptureScreenshot';
import { noteRendererError } from './telemetry';
import { recall, type RecallClient, type AskProgressEvent } from '../kb/recall';
import { makeSdkRecallClient } from '../kb/recallAgent';
import { recallEffortLevers, DEFAULT_RECALL_BUDGET_MS } from '../kb/recallConstants';
import { saveConversation, listConversations, loadConversation, deleteConversation } from './conversationStore';
import type { Conversation, ConversationTurn, ConversationSummary } from '../kb/conversation';
import { resolveCopilotModel } from '../kb/copilotModel';
import { copilotScaleRuntime } from '../kb/copilotConcurrency';
import { makeReadOnlyTools } from '../kb/recallTools';
import { makeProjectionTools } from '../kb/graphProjection';
import { buildNeighborhood, listExploreEntities, type ExploreEntityRef, type ExploreNeighborhood, type ExploreProjection } from '../kb/explorePanel';
import { buildHealthReport } from '../kb/healthPanel';
import { readHealthDismissals } from '../kb/directives';
import type { HealthRemediateRequest, HealthRemediateResult, HealthDismissRequest, HealthDismissResult } from '../kb/healthRemediation';
import { toHealthProjection, type HealthProjection } from '../kb/healthProjection';
import { readContradictionDirectives } from '../kb/directives';
import { resolveContainedRel } from '../kb/pathContainment';
import { obsidianOpenUri } from '../kb/citationLink';
import { locateSourceRef } from '../kb/sourceOpen';
import { loadActivityIndex, readEvents, filterEvents } from '../kb/activityIndex';
import { buildFeed, filterFeedByText } from '../kb/activityDigest';
import { traceLineage } from '../kb/lineage';
import { resolveExecutable } from './resolvePath';
import type { CapturePayload } from '../kb/ingest';
import type {
  AppState,
  VaultConfig,
  CreateKbOptions,
  ProbeVaultAccessResult,
  OpenSettingsResult,
  CaptureRequest,
  CaptureResult,
  QuickCaptureContext,
  ScreenshotMode,
  ScreenshotResult,
  PipelineStatus,
  PipelineStatusView,
  RendererErrorReport,
  ReviewSummary,
  Projection,
  AnswerReviewRequest,
  AnswerReviewResult,
  PipelineControlRequest,
  PipelineControlResult,
  QuiesceStatus,
  FullReplayResult,
  ComposeBacklogResult,
  AskRequest,
  AskResult,
  SaveRecallOutputResult,
  OpenCitationResult,
  OpenSourceRefResult,
  JobView,
  JobConfigPatch,
  RunJobResult,
  ActivityFilter,
  ActivityFeedResult,
  AuditEvent,
  Lineage,
  InstanceSettings,
  ScaleRuntime,
  AgentView,
  ModelCatalogView,
  SetModelResult,
  ResearcherView,
  ResearcherConfigPatch,
  ResearcherLastRun,
  RunResearcherResult,
  WatchFolderView,
  WatchFolderPatch,
  IntakeConnectorView,
  IntakeConnectorConfigPatch,
  RunIntakeConnectorResult,
  WorkIqStatus,
  InstallWorkIqResult,
  TodayProjectionView,
} from '../kb/types';
import { workIqStatus, installWorkIq } from './researchWiring';

async function loadVaultConfig(vaultPath: string): Promise<VaultConfig | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(vaultPath, '.kb', 'config.json'), 'utf8')) as VaultConfig;
  } catch {
    return null; // vault moved/deleted/invalid
  }
}

const NO_PIPELINE: CaptureResult = {
  ok: false,
  ids: [],
  captureBatch: null,
  committed: false,
  message: 'No active library.',
};

// #514: a fresh RecallClient was built on EVERY kb:ask (recall.ts:257's `opts.client ?? makeSdkRecallClient`
// default) and never disconnected — `RecallClient.disconnect` had no production caller — so every question
// cold-booted (~1.5-3s) a NEW `copilot` CLI server process that then leaked for the app's lifetime. Build
// ONE process-wide client lazily on first ask and reuse it for every subsequent question (the underlying
// CopilotClient inside makeSdkRecallClient is itself created lazily + held, so passing the SAME RecallClient
// instance here is what makes the 2nd+ question skip the server boot). `stopRecallClient` releases it —
// wired to `app.on('will-quit', …)` in main.ts, mirroring the QuickCaptureAgent shutdown pattern.
let recallClient: RecallClient | null = null;

function getRecallClient(): RecallClient {
  if (!recallClient) {
    // BUG #65: point the SDK at the resolved BYOA `copilot` CLI so it spawns in the packaged app —
    // resolved ONCE here (deterministic per launch), not per-question.
    recallClient = makeSdkRecallClient({ cliPath: resolveExecutable('copilot') ?? undefined });
  }
  return recallClient;
}

/** Stop the process-wide RecallClient (releases its CLI server), if one was ever created. Idempotent. */
export async function stopRecallClient(): Promise<void> {
  if (!recallClient) return;
  const client = recallClient;
  recallClient = null;
  await client.disconnect?.();
}

/** Start the orchestrator if a valid KB is already configured (called on app launch). */
export async function initPipeline(): Promise<void> {
  const cfg = await readAppConfig();
  if (cfg.activeVaultPath && (await loadVaultConfig(cfg.activeVaultPath))) {
    const root = path.resolve(cfg.activeVaultPath);
    // SPEC-0031 VAULT-5/6: maintain the `.obsidian/` config on launch so EXISTING vaults (created
    // before this shipped) also get it. Idempotent + non-destructive (write-if-absent); best-effort —
    // a config-write hiccup must never block the pipeline from starting.
    await ensureObsidianConfig(root).catch(() => {});
    await startPipeline(root);
  }
}

export function registerIpc(): void {
  // SPEC-0055 RELEASE-6: report the running app version (from the packaged Info.plist / package.json,
  // matching the release tag) so a build is identifiable at runtime — the About panel renders this.
  ipcMain.handle('kb:getAppVersion', async (): Promise<string> => app.getVersion());

  ipcMain.handle('kb:getState', async (): Promise<AppState> => {
    const cfg = await readAppConfig();
    const vaultConfig = cfg.activeVaultPath ? await loadVaultConfig(cfg.activeVaultPath) : null;
    return { activeVaultPath: cfg.activeVaultPath, vaultConfig };
  });

  ipcMain.handle('kb:pickFolder', async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: OpenDialogOptions = {
      title: 'Choose a folder for your Knowledge Base',
      properties: ['openDirectory', 'createDirectory'],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle('kb:inspect', async (_e, p: string) => inspectPath(p));

  ipcMain.handle('kb:create', async (_e, opts: CreateKbOptions) => {
    const result = await createKb(opts);
    if (result.ok) {
      const vaultPath = path.resolve(opts.path);
      await writeAppConfig({ activeVaultPath: vaultPath });
      await startPipeline(vaultPath); // the KB is live — start draining captures immediately
    }
    return result;
  });

  // SPEC-0034 MACOS-7: probe vault write-access. A benign write+delete of a hidden marker under the
  // vault's `.kb/` — the app's own first protected-folder access — so the macOS TCC grant dialog fires
  // THEN (coupled to the pre-prompt's Continue), not later, decoupled, mid-pipeline (MACOS-5). The
  // marker is removed immediately so nothing pollutes the user's vault. `denied` distinguishes a
  // permission failure (→ the Blocked recovery) from a generic one.
  ipcMain.handle('kb:probeVaultAccess', async (_e, vaultPath: string): Promise<ProbeVaultAccessResult> => {
    // Defense-in-depth (KB-QD #201): this handler writes to a renderer-supplied path, so confine it to
    // the ACTIVE vault — never probe (write into) an arbitrary off-config path. Mirrors the path-
    // containment posture at every fs-touching IPC boundary.
    const resolved = path.resolve(vaultPath);
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath || resolved !== cfg.activeVaultPath) {
      return { ok: false, denied: false, message: 'That folder isn’t the active library.' };
    }
    const marker = path.join(resolved, '.kb', '.permission-probe');
    try {
      await fs.writeFile(marker, '', 'utf8');
      await fs.rm(marker, { force: true });
      return { ok: true, denied: false, message: 'Vault folder is accessible.' };
    } catch (err) {
      await fs.rm(marker, { force: true }).catch(() => {}); // best-effort cleanup if the write half-landed
      return { ok: false, denied: isPermissionDeniedError(err), message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0034 MACOS-7: open macOS System Settings → Privacy & Security → Files and Folders for the
  // denied-recovery flow. The precise sub-anchor is historically flaky across macOS versions, so a
  // reject falls back to the general Privacy & Security pane — never a no-op click (the dead-end the
  // design forbids).
  ipcMain.handle('kb:openSystemSettingsPrivacy', async (): Promise<OpenSettingsResult> => {
    const FILES = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';
    const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy';
    try {
      await shell.openExternal(FILES);
      return { ok: true };
    } catch {
      try {
        await shell.openExternal(PRIVACY);
        return { ok: true, usedFallback: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  // SPEC-0013 CAPTURE-1/2: fire-and-forget capture of text + dropped files. The renderer
  // sends file bytes; we hand them to the active orchestrator, which preserves+commits.
  ipcMain.handle('kb:capture', async (_e, req: CaptureRequest): Promise<CaptureResult> => {
    const orch = activePipeline();
    if (!orch) return NO_PIPELINE;
    // SPEC-0045 QUIESCE-1: new ingestion is paused while preparing for shutdown — surface a clear reason,
    // never a silent drop. The user can Resume to capture again.
    if (isActiveQuiescing()) {
      return { ...NO_PIPELINE, message: 'Preparing to shut down — new capture is paused. Resume to capture again.' };
    }

    const payloads: CapturePayload[] = [];
    for (const input of req.inputs) {
      if (input.kind === 'text') {
        // RICHIN-2: carry the original clipboard HTML (if any) so ingest writes the verbatim sidecar.
        if (input.text.trim().length > 0) payloads.push({ kind: 'text', text: input.text, ...(input.html ? { html: input.html } : {}) });
      } else if (input.kind === 'file') {
        payloads.push({ kind: 'file', name: input.name, data: new Uint8Array(input.data) });
      }
      // (a `screenshot` input is QCAP-only — resolved in kb:quickCapture, never reaches the in-app panel)
    }
    if (payloads.length === 0) {
      return { ...NO_PIPELINE, message: 'Nothing to capture.' };
    }

    try {
      const out = await orch.capture('in-app-panel', payloads);
      return { ok: true, ids: out.ids, captureBatch: out.captureBatch, committed: out.committed, message: `Captured ${out.ids.length} item(s).` };
    } catch (err) {
      // #56 / MACOS-7: a folder-permission denial (TCC not granted) must route to the Blocked recovery,
      // never surface the raw `Operation not permitted` to the user (no dev jargon, no silent stall).
      if (isPermissionDeniedError(err)) {
        return { ...NO_PIPELINE, blocked: true, message: 'Vellum can’t write to your vault folder — access is turned off.' };
      }
      return { ...NO_PIPELINE, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0038 QCAP-1/2/5: fire-and-forget quick capture (text + clipboard + screenshot) onto the SAME
  // SPEC-0013 capture path, recording provenance surface='quick-capture'. QCAP adds NO preservation
  // logic — it hands payloads to the active orchestrator, which returns on preserve+commit and never
  // blocks on Enrich (CAPTURE-2 fast-out). QCAP-13: a `screenshot` input is a temp-PNG handle main
  // issued — read it (validating it's ours) into a file payload; the bytes never came through the DOM.
  ipcMain.handle('kb:quickCapture', async (_e, req: CaptureRequest): Promise<CaptureResult> => {
    const orch = activePipeline();
    if (!orch) return NO_PIPELINE;

    const payloads: CapturePayload[] = [];
    for (const input of req.inputs) {
      if (input.kind === 'text' && input.text.trim().length > 0) {
        payloads.push({ kind: 'text', text: input.text });
      } else if (input.kind === 'screenshot') {
        const bytes = await consumeScreenshotHandle(input.handle); // null if not a handle WE issued
        if (bytes) payloads.push({ kind: 'file', name: input.name, data: bytes });
      }
    }
    if (payloads.length === 0) return { ...NO_PIPELINE, message: 'Nothing to capture.' };

    try {
      const out = await orch.capture('quick-capture', payloads); // QCAP-5: provenance surface=quick-capture
      return { ok: true, ids: out.ids, captureBatch: out.captureBatch, committed: out.committed, message: `Captured ${out.ids.length} item(s).` };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        return { ...NO_PIPELINE, blocked: true, message: 'Vellum can’t write to your vault folder — access is turned off.' };
      }
      return { ...NO_PIPELINE, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // QCAP-2: the sheet asks the agent to dismiss + restore focus to the prior app after submit/cancel.
  ipcMain.handle('kb:quickCaptureClose', async (): Promise<void> => {
    getQuickCaptureAgent()?.close();
  });

  // QCAP-7: the sheet pre-fills so "save what I'm looking at" is one gesture. Slice 1 = the current
  // clipboard; Slice 2 folds in the focused-app `selection` the agent read at summon time (before the
  // sheet stole focus) + the Accessibility grant state. No agent / no summon → clipboard-only (the
  // selection is null + unsupported), so this path also serves the non-macOS + headless-test cases.
  ipcMain.handle('kb:quickCaptureContext', async (): Promise<QuickCaptureContext> => {
    const sel = getQuickCaptureAgent()?.takeSelectionContext();
    return {
      clipboard: clipboard.readText(),
      selection: sel?.text ?? null,
      accessibility: sel?.status ?? 'unsupported',
      clipboardImage: await clipboardImageHandle(), // QCAP-13: "paste an image" prefill / denied-degrade
      screenshotSupported: process.platform === 'darwin', // QCAP-13: the cluster shows only where capture works
    };
  });

  // SPEC-0038 QCAP-13: capture a screenshot (full/region/window) to a temp PNG handle. The bytes stay
  // in main; the sheet gets only the handle + submits it back. denied → the sheet's brass steer.
  ipcMain.handle('kb:quickCaptureScreenshot', async (_e, mode: ScreenshotMode): Promise<ScreenshotResult> => {
    return captureScreenshot(mode);
  });

  // SPEC-0038 QCAP-13: open System Settings → Privacy & Security → Screen Recording for the denied
  // recovery steer (the SPEC-0034 / QCAP-9 pattern). Exact anchor → general Privacy fallback, never a no-op.
  ipcMain.handle('kb:openScreenRecordingSettings', async (): Promise<OpenSettingsResult> => {
    const SCREEN = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy';
    try {
      await shell.openExternal(SCREEN);
      return { ok: true };
    } catch {
      try {
        await shell.openExternal(PRIVACY);
        return { ok: true, usedFallback: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  // SPEC-0038 QCAP-9 (Slice 2): open macOS System Settings → Privacy & Security → Accessibility for the
  // denied-selection-capture recovery. Mirrors kb:openSystemSettingsPrivacy (SPEC-0034 pattern): the
  // precise Accessibility sub-anchor can be flaky across macOS versions, so a reject falls back to the
  // general Privacy & Security pane — never a no-op click (the dead-end the design forbids, QCAP-9).
  ipcMain.handle('kb:openAccessibilitySettings', async (): Promise<OpenSettingsResult> => {
    const ACCESSIBILITY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
    const PRIVACY = 'x-apple.systempreferences:com.apple.preference.security?Privacy';
    try {
      await shell.openExternal(ACCESSIBILITY);
      return { ok: true };
    } catch {
      try {
        await shell.openExternal(PRIVACY);
        return { ok: true, usedFallback: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
  });

  ipcMain.handle('kb:pipelineStatus', async (): Promise<PipelineStatus> => {
    const orch = activePipeline();
    return orch ? orch.status() : { queueDepth: 0, processing: null, lastArchived: null, updatedAt: null };
  });

  // SPEC-0030 OBS-5/6/7/11/15: the live Status view-model (read-only). Null when no KB is open.
  ipcMain.handle('kb:pipelineStatusView', async (): Promise<PipelineStatusView | null> => {
    return pipelineStatusForActive();
  });

  // SPEC-0030 OBS-18 (renderer): the renderer forwards its uncaught errors / unhandled rejections
  // here (the isolated renderer can't write the app-log); the telemetry glue logs them loudly.
  ipcMain.handle('kb:reportRendererError', async (_e, report: RendererErrorReport): Promise<void> => {
    noteRendererError(report);
  });

  // SPEC-0018 REVIEW-10/11 + SHELL-12: the "needs you" queue, served from the maintained projection —
  // INSTANT, never blocks on the backend (zero git/fs on the render path; a busy stage / held lock
  // can't stall the Reviews surface or the rail badge). The compute + summary mapping live in the
  // pipeline's `reviewStore` (background cadence); here we just hand back the last-known-good.
  ipcMain.handle('kb:listReviews', async (): Promise<ReviewSummary[]> => {
    return reviewProjectionForActive()?.data ?? [];
  });

  // SHELL-12: the review queue WITH its freshness envelope (`builtAt`/`stale`) for the "as of /
  // updating…" affordance — so a surface honors staleness visibly, never renders stale-as-live. The
  // plain `kb:listReviews` above stays the instant queue read; this is additive (also instant).
  ipcMain.handle('kb:reviewProjection', async (): Promise<Projection<ReviewSummary[]> | null> => {
    return reviewProjectionForActive();
  });

  ipcMain.handle('kb:answerReview', async (_e, req: AnswerReviewRequest): Promise<AnswerReviewResult> => {
    const { ok, message } = await answerActiveReview(req.id, { verdict: req.verdict, note: req.note });
    return { ok, message };
  });

  // SPEC-0030 OBS-17: retry / dismiss a set-aside (poison) item from the Status view (claims-only v1).
  // The one mutating action the Status surface offers; it delegates to the stage-owned recovery
  // primitives under the canonical-writer lock (no mutation logic here).
  ipcMain.handle('kb:pipelineControl', async (_e, req: PipelineControlRequest): Promise<PipelineControlResult> => {
    return pipelineControlForActive(req);
  });

  // SPEC-0022 REPLAY-1/2: Principal-initiated "clean & rebuild". The renderer gates this behind a
  // confirm dialog; here we just run it (purge + epoch reset on staging, republish main, resume).
  ipcMain.handle('kb:fullReplay', async (): Promise<FullReplayResult> => {
    try {
      return await fullReplay();
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0046 COMPOSE-9: backfill the vault — kick a bounded, coalesced recompose of the uncomposed
  // backlog (re-attempting any set-aside); the read-only status just reports coverage.
  ipcMain.handle('kb:composeBacklog', async (): Promise<ComposeBacklogResult> => {
    try {
      return await composeBacklog();
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle('kb:composeBacklogStatus', async (): Promise<ComposeBacklogResult> => {
    try {
      return await composeBacklogStatus();
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0026 ASK-1/2/8: grounded NL recall (pull-only — only on the Principal's ask). Runs the
  // recall engine on the active vault root (the evergreen `main` checkout). Multi-turn history is
  // supplied by the Ask view (ephemeral session, F5). KB_ASK_E2E_STUB short-circuits to a
  // deterministic answer so the UI→IPC→render path is e2e-testable without a live SDK/CLI.
  ipcMain.handle('kb:ask', async (e, req: AskRequest): Promise<AskResult> => {
    if (process.env.KB_ASK_E2E_STUB) return stubbedAsk(req);
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) {
      return { question: req.question, answer: 'No active library — set one up first.', citations: [], grounded: false, toolCalls: 0, truncated: false };
    }
    // ASK-17: hand recall the Principal-configured work budget (from Instance Settings on `staging`)
    // so a real grounded multi-hop has room to finish past the SDK's tight 60s default. ASK-19: also
    // forward the optional retrieval tool-call override (`undefined` ⇒ recall's graph-size-scaled
    // default applies — see `recallBudget`; a set value wins as `opts.maxToolCalls`).
    const { recallBudgetMs, recallMaxToolCalls } = await getActiveInstanceSettings();
    // SPEC-0060 VUX-11 (ratified, PM-confirmed 2026-07-13 — stands, NOT superseded by #514's suggested
    // approach): effort is expressed ONLY through recall's depth levers (tool-call budget + time budget),
    // never a model swap — no recall-quick/-considered model exists in the catalog. `reasoningEffort` is
    // a depth/effort lever on the SAME model (Copilot SDK's gated param), so it doesn't conflict with
    // VUX-11 and is the honest part of #514's "Quick tier" fix.
    const { maxToolCalls, sessionBudgetMs } = recallEffortLevers(req.effort, { maxToolCalls: recallMaxToolCalls ?? undefined, sessionBudgetMs: recallBudgetMs ?? DEFAULT_RECALL_BUDGET_MS });
    const quick = req.effort === 'quick';
    // ORCH-16: pin the model recall's SDK session runs on, same as the enrich deciders — prod
    // otherwise passed no model and the SDK inherited `~/.copilot/settings.json` (model-pin gap).
    const model = resolveCopilotModel(undefined, 'recall');
    return recall(
      path.resolve(cfg.activeVaultPath),
      { question: req.question, history: req.history },
      {
        client: getRecallClient(), // #514: process-wide reuse — 2nd+ question skips the CLI server boot
        sessionBudgetMs,
        maxToolCalls,
        model,
        reasoningEffort: quick ? 'low' : undefined, // #514: honest Quick tier — gated per-model on the SDK side
        effort: req.effort,
        // #514: push live tool-call progress back to the SAME renderer that invoked this ask, so the
        // status line can name the in-flight tool + call count instead of a static "Searching…" line.
        onProgress: (evt: AskProgressEvent) => e.sender.send('kb:askProgress', evt),
      },
    );
  });

  // SPEC-0026 ASK-6: save a grounded recall answer as an inert KB Output (outputs/recall/<id>.md,
  // promoted to main, conforming `output` audit). The renderer passes the AskResult it rendered.
  ipcMain.handle('kb:saveRecallOutput', async (_e, result: AskResult): Promise<SaveRecallOutputResult> => {
    try {
      return await saveRecallOutput(result);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });

  // SPEC-0060 VUX-11 (slice-2b/2c): past-chats — persist / list / load Ask threads in app userData (NOT
  // the vault; distinct from saveRecallOutput, which git-commits an answer AS a KB Output). The id a save
  // returns can be passed back to UPDATE the same thread as it grows. Load is ULID-contained (the store
  // rejects a crafted id), so a renderer-supplied id can never escape the conversations dir.
  ipcMain.handle('kb:saveConversation', async (_e, req: { turns: ConversationTurn[]; id?: string; title?: string }): Promise<{ id: string }> => {
    return saveConversation(req?.turns ?? [], { id: req?.id, title: req?.title });
  });
  ipcMain.handle('kb:listConversations', async (): Promise<ConversationSummary[]> => {
    return listConversations();
  });
  ipcMain.handle('kb:loadConversation', async (_e, id: unknown): Promise<Conversation | null> => {
    return typeof id === 'string' ? loadConversation(id) : null;
  });
  ipcMain.handle('kb:deleteConversation', async (_e, id: unknown): Promise<{ ok: boolean }> => {
    return typeof id === 'string' ? deleteConversation(id) : { ok: false };
  });

  // SPEC-0026 ASK-14: open a citation's canonical target in Obsidian. The renderer hands us the
  // citation's vault-relative `ref`; we resolve it to an ABSOLUTE path under the active vault — with
  // containment (#30: `resolveContainedRel` rejects any `..`/symlink escape; null → no open) so a
  // crafted ref can't deep-link outside the vault — then hand the percent-encoded `obsidian://open`
  // URI to the OS. We never build the URI in the renderer, so the `obsidian:` scheme never touches
  // the DOM (DOMPurify's default allowlist stays intact, ASK-15/#93).
  ipcMain.handle('kb:openCitation', async (_e, ref: unknown): Promise<OpenCitationResult> => {
    if (typeof ref !== 'string' || ref.trim().length === 0) return { ok: false, reason: 'invalid-ref' };
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) return { ok: false, reason: 'no-vault' };
    const abs = await resolveContainedRel(path.resolve(cfg.activeVaultPath), ref);
    if (abs === null) return { ok: false, reason: 'invalid-ref' }; // escaped containment or missing
    try {
      await shell.openExternal(obsidianOpenUri(abs));
      return { ok: true };
    } catch {
      return { ok: false, reason: 'open-failed' };
    }
  });

  // SPEC-0018 REVIEW-17 / PRIN-24: working-zone-aware open of a review candidate's source. A review
  // can be raised MID-PIPELINE, so its source may be staging-only — not yet promoted to `main` (the
  // user's Obsidian vault, where `obsidian://open` resolves). Firing the deep link anyway is "file not
  // found". So resolve WHERE the `source.md` lives right now (`locateSourceRef`): open in Obsidian only
  // when it's on `main`; otherwise hand the view a `staging`/`missing` status so it shows the in-app /
  // "still processing" fallback — never a dead link. Like ASK-14 we never build the URI in the renderer.
  ipcMain.handle('kb:openSourceRef', async (_e, ref: unknown): Promise<OpenSourceRefResult> => {
    if (typeof ref !== 'string' || ref.trim().length === 0) return { status: 'invalid-ref' };
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) return { status: 'no-vault' };
    const located = await locateSourceRef(path.resolve(cfg.activeVaultPath), activeStagingRoot(), ref);
    switch (located.location) {
      case 'main':
        try {
          await shell.openExternal(obsidianOpenUri(located.mainAbs!));
          return { status: 'opened' };
        } catch {
          return { status: 'open-failed' };
        }
      case 'staging':
        return { status: 'staging' };
      case 'invalid':
        return { status: 'invalid-ref' };
      default:
        return { status: 'missing' };
    }
  });

  // SPEC-0039 EXPLORE: the read-only entity-neighborhood view. Reads the EVERGREEN graph at the active
  // vault root (like recall/ask, NOT the staging worktree — EXPLORE-3: canonical state only), via the
  // read-only recall tools — so it's read-only by construction (EXPLORE-1: no write path here).
  //
  // SPEC-0058 STATE-2: prefer the MAINTAINED graph projection — `makeProjectionTools` serves the exact
  // read-only surface from the in-memory snapshot (zero fs, O(degree) backlinks; byte-identical per
  // #457's equivalence), killing the per-mount O(N²) walk that failed to load. Until the projection's
  // first build, fall back to the live scan (a cold-start path #451's warming/timeout guard covers).
  const exploreReadTools = (root: string) => {
    const p = graphProjectionForActive();
    return p ? makeProjectionTools(p.data) : makeReadOnlyTools(root);
  };

  ipcMain.handle('kb:exploreEntities', async (): Promise<ExploreEntityRef[]> => {
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) return [];
    return listExploreEntities(exploreReadTools(path.resolve(cfg.activeVaultPath)));
  });

  // SPEC-0058 STATE-2: the single Explore read — `{status, data:{neighborhood, entities}, builtAt, stale}`
  // from the maintained graph projection (DL-1's render contract). `status` is FIRST-CLASS: `warming` while
  // the projection is still building (the view shows a calm "warming the graph…", never the alarming error
  // face — STATE-9/10), `ready` once built. ONE read serves everything Explore draws; zero render-path walk.
  ipcMain.handle('kb:exploreProjection', async (_e, focus?: unknown): Promise<ExploreProjection> => {
    const cfg = await readAppConfig();
    const projection = cfg.activeVaultPath ? graphProjectionForActive() : null;
    if (!projection) return { status: 'warming', data: null, builtAt: null, stale: false };
    const root = path.resolve(cfg.activeVaultPath!);
    const tools = makeProjectionTools(projection.data);
    const f = typeof focus === 'string' && focus.length > 0 ? focus : undefined;
    const contradictions = await readContradictionDirectives(root); // small + read-tolerant (CONTRA-6/7)
    const [neighborhood, entities] = await Promise.all([buildNeighborhood(tools, f, undefined, contradictions), listExploreEntities(tools)]);
    return { status: 'ready', data: { neighborhood, entities }, builtAt: projection.builtAt, stale: projection.stale };
  });

  ipcMain.handle('kb:exploreNeighborhood', async (_e, focus?: unknown): Promise<ExploreNeighborhood> => {
    const cfg = await readAppConfig();
    if (!cfg.activeVaultPath) return { found: false, claims: [], neighbors: [], shown: 0, total: 0, contradictions: [] };
    const root = path.resolve(cfg.activeVaultPath);
    const f = typeof focus === 'string' && focus.length > 0 ? focus : undefined;
    // SPEC-0036 CONTRA-6/7: pre-read the durable contradiction store (evergreen, read at the canonical
    // root like the rest of Explore) so the center's open-contradiction flag + per-claim "disputed" badge
    // surface in the read view. The store is small + read-tolerant (a missing file → no flags).
    const contradictions = await readContradictionDirectives(root);
    return buildNeighborhood(exploreReadTools(root), f, undefined, contradictions);
  });

  // SPEC-0035 HEALTH: deterministic, read-only structural-lint scan (orphans / dangling links / thin
  // stubs) over the EVERGREEN graph at the active vault root — no model calls, no fixes (v1 passive).
  ipcMain.handle('kb:healthReport', async (): Promise<HealthProjection> => {
    // SPEC-0058 STATE-3/13: return the Health PROJECTION (DL-2's render contract) — the view draws everything
    // from this one read, severity baked in. Surface-local for now: built off the read-only scan
    // (`makeReadOnlyTools`). The STATE-3 read-layer swap is a ONE-LINE change once the maintained graph
    // projection store (#457's `computeGraphProjection`/`makeProjectionTools` core) is instantiated at this
    // layer — replace `makeReadOnlyTools(...)` below with `makeProjectionTools(graphStore.current().data)`:
    // `buildHealthReport` already takes `RecallTools`, and `makeProjectionTools` returns exactly that, so the
    // projection-backed report is byte-identical minus the per-mount walk. Held until that store is wired (the
    // shared read-layer, DEV-5/DEV-3's lane) so this surface PR doesn't collide with it.
    const cfg = await readAppConfig();
    const now = new Date().toISOString();
    if (!cfg.activeVaultPath) return toHealthProjection({ scanned: 0, orphans: [], thin: [], dangling: [], counts: { orphans: 0, thin: 0, dangling: 0 } }, now);
    // VUX-16: filter findings the Principal has dismissed (evergreen on `main`, read at the same root the
    // scan reads) BEFORE the report caps + counts, so a dismissed finding is truly gone, not UI-hidden.
    const root = path.resolve(cfg.activeVaultPath);
    return toHealthProjection(await buildHealthReport(makeReadOnlyTools(root), await readHealthDismissals(root)), now);
  });

  // SPEC-0060 VUX-16 slice-1: apply a non-destructive Health remediation (relink / find-homes). Under the
  // canonical-writer lock + promoted, so the next `kb:healthReport` re-scan reflects the fix. Destructive
  // merge + the enrich action are HELD for a later slice (see healthRemediation.ts).
  ipcMain.handle('kb:healthRemediate', async (_e, req: HealthRemediateRequest): Promise<HealthRemediateResult> => {
    if (!req || (req.action !== 'relink' && req.action !== 'find-homes') || typeof req.nodeRel !== 'string') {
      return { ok: false, message: 'Invalid remediation request.' };
    }
    return remediateActiveHealthFinding(req);
  });
  // SPEC-0060 VUX-16 slice-1: dismiss / restore a Health finding (a durable evergreen directive).
  ipcMain.handle('kb:dismissHealthFinding', async (_e, req: HealthDismissRequest): Promise<HealthDismissResult> => {
    if (!req || typeof req.findingKey !== 'string' || typeof req.kind !== 'string') {
      return { ok: false, message: 'Invalid dismiss request.' };
    }
    return dismissActiveHealthFinding(req);
  });

  // SPEC-0058 Today: the single home read — `{status, data, builtAt, stale}` from the maintained Today
  // projection (mirrors `kb:exploreProjection`). `status` is FIRST-CLASS: `warming` while the composite is
  // still building its first snapshot (the view shows a calm "warming…", never the alarming error face —
  // STATE-9/10), `ready` once built. ONE instant read serves everything Today draws; zero render-path scan
  // (the composite's Health/activity walks run on the background cadence inside the store). The live clock
  // is view-rendered (it ticks), not in `data`.
  ipcMain.handle('kb:getTodayProjection', async (): Promise<TodayProjectionView> => {
    const projection = todayProjectionForActive();
    if (!projection) return { status: 'warming', data: null, builtAt: null, stale: false };
    return { status: 'ready', data: projection.data, builtAt: projection.builtAt, stale: projection.stale };
  });

  // SPEC-0027 PANEL-2/6/7: the Control Panel's Jobs view — list manageable jobs, persist config
  // changes (enable/schedule/posture), and trigger a manual "Run now". The renderer gates risky
  // changes behind a confirm; the main process owns the registry + scheduler.
  ipcMain.handle('kb:listJobs', async (): Promise<JobView[]> => listJobsForActive());

  ipcMain.handle('kb:setJobConfig', async (_e, patch: JobConfigPatch): Promise<JobView[]> => setActiveJobConfig(patch));

  ipcMain.handle('kb:runJobNow', async (_e, id: string): Promise<RunJobResult> => {
    try {
      return await runActiveJobNow(id);
    } catch {
      return { ran: false, reason: 'not-found' };
    }
  });

  // SPEC-0029 Audit & Activity (read-only). All three read the active `staging` worktree — the full
  // working-zone audit (AUDIT-10), a superset of the evergreen archive. Empty when no KB is active.

  // AUDIT-5 + SPEC-0058 STATE-4 (slice-0 "stop the bleed"): the curated feed reads the HEAD-keyed
  // CACHE (`loadActivityIndex`), never a full rebuild on the render path. A large/slow/mid-write vault
  // could make `buildActivityIndex`'s walk of every `audit.jsonl` exceed the 8s loadGuard → the chronic
  // "couldn't load" on Activity. `loadActivityIndex` serves the last-known-good cache when HEAD is
  // unchanged and rebuilds only on a canonical advance (then re-caches). Trade: an uncommitted audit
  // append (e.g. a just-issued recall in the gitignored ask cache) may lag one HEAD move — acceptable
  // for slice-0; the incremental Activity projection (slice-2) closes that with honest `stale`/`builtAt`.
  // The optional filter narrows within the recent window; `total`/`truncated` are surfaced so the UI
  // never silently truncates.
  ipcMain.handle('kb:activityFeed', async (_e, filter?: ActivityFilter): Promise<ActivityFeedResult> => {
    const root = activeStagingRoot();
    if (!root) return { entries: [], total: 0, truncated: false };
    const index = await loadActivityIndex(root);
    // SPEC-0060 VUX-14: the free-text search matches the VISIBLE SUMMARY, so it runs on the built FEED
    // (where the curated summary lives), not the raw event stream. Actor/type/time filters stay
    // event-level. (The `kb:activityEvents` raw-drill surface keeps its full-haystack text match.)
    const eventFilter: ActivityFilter | undefined = filter ? { ...filter, text: undefined } : filter;
    const events = eventFilter ? filterEvents(index.events, eventFilter) : index.events;
    const entries = filter?.text ? filterFeedByText(buildFeed(events), filter.text) : buildFeed(events);
    return { entries, total: index.total, truncated: index.truncated };
  });

  // AUDIT-5/7: raw events for drill-down + filter/search across the FULL audit (not the capped feed).
  ipcMain.handle('kb:activityEvents', async (_e, filter?: ActivityFilter): Promise<AuditEvent[]> => {
    const root = activeStagingRoot();
    return root ? readEvents(root, filter ?? {}) : [];
  });

  // AUDIT-6: trace a subject's provenance + transformation timeline + decisions, from the full audit.
  ipcMain.handle('kb:activityLineage', async (_e, id: string): Promise<Lineage> => {
    const root = activeStagingRoot();
    if (!root) return { subjectId: id, kind: 'unknown', sources: [], events: [], decisions: [] };
    return traceLineage(root, id);
  });

  // SPEC-0027 PANEL-3/5: the Control Panel's Settings (per-Instance autonomy default) + Agents
  // (observe-only). The renderer gates a → Autonomous default behind a confirm; the main process
  // owns the per-vault `.kb/instance.json` + emits the conforming audit.
  ipcMain.handle('kb:getInstanceSettings', async (): Promise<InstanceSettings> => getActiveInstanceSettings());
  // SCALE-7/8: live scale runtime for the Scale card's throttled indicator (effective vs reference ceiling).
  ipcMain.handle('kb:getScaleRuntime', async (): Promise<ScaleRuntime> => copilotScaleRuntime());

  ipcMain.handle('kb:setInstanceSettings', async (_e, s: InstanceSettings): Promise<InstanceSettings> => setActiveInstanceSettings(s));

  ipcMain.handle('kb:listAgents', async (): Promise<AgentView[]> => listAgentsForActive());

  // SPEC-0048: the model picker — the live accepted catalog + resolved model, and a validated set.
  ipcMain.handle('kb:getModelCatalog', async (): Promise<ModelCatalogView> => getModelCatalogForActive());
  ipcMain.handle('kb:setModel', async (_e, id: string | null): Promise<SetModelResult> => setActiveModel(id));
  ipcMain.handle('kb:setAgentModel', async (_e, agentKey: string, id: string | null): Promise<SetModelResult> => setActiveAgentModel(agentKey, id));

  // SPEC-0028 RESEARCH-15: the Control Panel's Researchers view — list/configure researchers,
  // on-demand "Run now" (test pass), and recent-run history. The renderer gates risky changes
  // (enable / → autonomous / widen egress) behind a confirm; the main process owns the registry +
  // emits the conforming `panel` audit. Run-now uses the deterministic stub in 1a (no egress).
  ipcMain.handle('kb:listResearchers', async (): Promise<ResearcherView[]> => listResearchersForActive());

  ipcMain.handle('kb:setResearcherConfig', async (_e, patch: ResearcherConfigPatch): Promise<ResearcherView[]> => setActiveResearcherConfig(patch));

  // PANEL-11 lifecycle delete: purge a (user-added) researcher's config; sources + audit retained.
  ipcMain.handle('kb:removeResearcher', async (_e, id: string): Promise<ResearcherView[]> => removeActiveResearcher(id));

  ipcMain.handle('kb:runResearcherNow', async (_e, id: string): Promise<RunResearcherResult> => {
    try {
      return await runActiveResearcherNow(id);
    } catch {
      return { ran: false, reason: 'not-found' };
    }
  });

  ipcMain.handle('kb:listResearcherRuns', async (_e, id: string): Promise<ResearcherLastRun[]> => listResearcherRunsForActive(id));

  // WORKIQ-FIX (SPEC-0028 Slice 3): the WorkIQ/M365 researcher CLI setup card. `kb:workIqStatus` reports
  // whether the `workiq` CLI is on PATH (the researcher fails loud until it is); `kb:installWorkIq` runs
  // the "simple workiq via CLI" install and re-detects. Pure status read needs no active vault.
  ipcMain.handle('kb:workIqStatus', async (): Promise<WorkIqStatus> => workIqStatus());
  ipcMain.handle('kb:installWorkIq', async (): Promise<InstallWorkIqResult> => installWorkIq());

  // SPEC-0037 WATCH-9: the unified Sources view's watched-folder rows. One list read folds config +
  // live `watching` + `lastEvent`; set/remove validate + loop-guard at this boundary (in the pipeline fn).
  ipcMain.handle('kb:listWatchFolders', async (): Promise<WatchFolderView[]> => listWatchFoldersForActive());
  ipcMain.handle('kb:setWatchFolder', async (_e, patch: WatchFolderPatch): Promise<WatchFolderView[]> => setActiveWatchFolder(patch));
  ipcMain.handle('kb:removeWatchFolder', async (_e, id: string): Promise<WatchFolderView[]> => removeActiveWatchFolder(id));

  // SPEC-0027 PANEL-4 · Sources (INTAKE-14): manage intake feed connectors + on-demand run.
  ipcMain.handle('kb:listIntakeConnectors', async (): Promise<IntakeConnectorView[]> => listIntakeConnectorsForActive());

  ipcMain.handle('kb:setIntakeConnectorConfig', async (_e, patch: IntakeConnectorConfigPatch): Promise<IntakeConnectorView[]> => setActiveIntakeConnectorConfig(patch));

  // PANEL-11 lifecycle delete: purge a (user-added) intake feed's config; sources + audit retained.
  ipcMain.handle('kb:removeIntakeConnector', async (_e, id: string): Promise<IntakeConnectorView[]> => removeActiveIntakeConnector(id));

  ipcMain.handle('kb:runIntakeConnectorNow', async (_e, id: string): Promise<RunIntakeConnectorResult> => {
    try {
      return await runActiveIntakeConnectorNow(id);
    } catch {
      return { ran: false, reason: 'not-found' };
    }
  });

  // SPEC-0043 SENSE-7: Principal override of a source's sensitivity (audited + Replay-sticky).
  ipcMain.handle('kb:setSourceSensitivity', async (_e, sourceId: string, label: string): Promise<{ ok: boolean; reason?: string; sensitivity?: string }> => {
    try {
      return await setActiveSourceSensitivity(sourceId, label);
    } catch {
      return { ok: false, reason: 'error' };
    }
  });

  // SPEC-0043 SENSE-10: read sources' current sensitivity (+ provenance) for the Control-Panel display.
  ipcMain.handle('kb:getSourceSensitivities', async (_e, sourceIds: string[]) => {
    try {
      return await getActiveSourceSensitivities(sourceIds);
    } catch {
      return {};
    }
  });

  // SPEC-0045 QUIESCE — graceful "Prepare for shutdown": pause new work + drain / resume / poll status.
  ipcMain.handle('kb:quiesce', async (): Promise<QuiesceStatus> => quiesceActive());
  ipcMain.handle('kb:resume', async (): Promise<QuiesceStatus> => resumeActive());
  ipcMain.handle('kb:quiesceStatus', async (): Promise<QuiesceStatus | null> => quiesceStatusForActive());
}

/** Deterministic recall result for the CI e2e happy-path (KB_ASK_E2E_STUB). Never used in prod. */
function stubbedAsk(req: AskRequest): AskResult {
  return {
    question: req.question,
    answer: '**Ada Lovelace** is regarded as the first computer programmer. [1]',
    citations: [{ kind: 'claim', ref: 'claims/person/ada-lovelace.md', label: 'first computer programmer' }],
    grounded: true,
    toolCalls: 2,
    truncated: false,
  };
}
