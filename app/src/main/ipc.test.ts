// SPEC-0009 SETUP-2 / SETUP-6 — main-process IPC tier.
//
// SETUP-2: the Principal picks a root folder (kb:pickFolder) and that folder becomes the
//          vault root (kb:create → persisted activeVaultPath → kb:getState).
// SETUP-6: a later launch loads the existing KB — kb:getState reports the vault + its
//          config (the renderer's onboarding gate), and initPipeline hands that vault to
//          the main process to manage. No re-onboarding.
//
// Electron is mocked: ipcMain.handle captures the handlers so we can invoke them directly,
// dialog.showOpenDialog returns a scripted pick, and app.getPath('userData') points at a
// temp dir. The pipeline is mocked so no real staging worktree/orchestrator spins up — we
// only assert the main process is asked to manage the right vault. createKb itself is real
// (a genuine git repo in a temp dir), so the pick → vault-root chain is exercised end-to-end.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir } from '../../test/tempVault';
import type { AppState, CreateKbResult, InstanceSettings } from '../kb/types';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const state = vi.hoisted(() => ({
  userData: '',
  dialogResult: { canceled: false, filePaths: [] as string[] },
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  stagingRoot: null as string | null, // SPEC-0029: the active staging worktree the activity handlers read
  clipboard: '', // SPEC-0038 QCAP-7: clipboard prefill source
  orch: null as null | { capture: (surface: string, payloads: unknown[]) => Promise<{ ids: string[]; captureBatch: string; committed: boolean }> },
  // SPEC-0038 QCAP-13: the mocked screenshot module's responses.
  screenshot: { status: 'unsupported', image: null } as { status: string; image: { handle: string; name: string } | null },
  screenshotBytes: null as Uint8Array | null, // what consumeScreenshotHandle returns for a valid handle
  clipboardImage: null as { handle: string; name: string } | null,
  graphProjection: null as null | { data: unknown; builtAt: string; stale: boolean }, // SPEC-0058 STATE-2 graph store
  todayProjection: null as null | { data: unknown; builtAt: string; stale: boolean }, // SPEC-0058 Today store
}));

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined), // ASK-14: shell.openExternal for the obsidian:// deep-link
  startPipeline: vi.fn(async () => undefined),
  pipelineControl: vi.fn(async () => ({ ok: true, message: 'Retrying Ada Lovelace.' })), // OBS-17
  recall: vi.fn(async () => ({ question: '', answer: 'mock recall', citations: [], grounded: true, toolCalls: 1, truncated: false })),
  // ASK-17/19: kb:ask reads the configured recall budget (time + tool-call override) from here. A vi.fn
  // so a test can vary the configured override and assert it crosses the read-boundary into recall opts.
  getActiveInstanceSettings: vi.fn(async (): Promise<InstanceSettings> => ({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: 240_000 })),
  // SPEC-0028 researcher pipeline helpers (the IPC handlers delegate to these).
  listResearchers: vi.fn(async () => [{ id: 'web-1', template: 'web', label: 'Web', egressTier: 'public-web', scope: 'global', enabled: false, schedule: 'off', posture: 'guarded', topics: [], lastRun: null }]),
  setResearcherConfig: vi.fn(async () => [{ id: 'web-1', template: 'web', label: 'Web', egressTier: 'public-web', scope: 'global', enabled: true, schedule: 'off', posture: 'guarded', topics: [], lastRun: null }]),
  removeResearcher: vi.fn(async () => []), // PANEL-11 lifecycle delete
  runResearcherNow: vi.fn(async () => ({ ran: true, sourceIds: ['SRC1'], note: 'secondary source SRC1' })),
  listResearcherRuns: vi.fn(async () => [{ ts: '2026-06-02T00:00:00.000Z', eventType: 'researched', what: 'Atlas', sourceId: 'SRC1', citations: 1 }]),
  // SPEC-0037 WATCH pipeline helpers (the IPC handlers delegate to these).
  listWatchFolders: vi.fn(async () => [{ id: 'drop', folderPath: '/abs/inbox', label: 'drop', enabled: false, scope: 'global', sensitivity: 'internal', ignoreGlobs: [], watching: false, lastEvent: null }]),
  setWatchFolder: vi.fn(async () => [{ id: 'drop', folderPath: '/abs/inbox', label: 'drop', enabled: true, scope: 'global', sensitivity: 'internal', ignoreGlobs: [], watching: true, lastEvent: null }]),
  removeWatchFolder: vi.fn(async () => []),
  removeIntakeConnector: vi.fn(async () => []), // PANEL-11 lifecycle delete
}));

vi.mock('electron', () => ({
  app: { getPath: (): string => state.userData, getVersion: (): string => '9.9.9-test' },
  ipcMain: { handle: (channel: string, fn: Handler) => state.handlers.set(channel, fn) },
  dialog: { showOpenDialog: vi.fn(async () => state.dialogResult) },
  shell: { openExternal: mocks.openExternal },
  clipboard: { readText: (): string => state.clipboard }, // SPEC-0038 QCAP-7
  BrowserWindow: { fromWebContents: (): null => null },
}));

// SPEC-0038 QCAP-13: mock the screenshot glue so the IPC handlers are tested without spawning
// `screencapture` / touching the real clipboard image. consumeScreenshotHandle returns bytes only
// for the registered handle (mirrors the issued-handle security boundary).
vi.mock('./quickCaptureScreenshot', () => ({
  captureScreenshot: vi.fn(async () => state.screenshot),
  consumeScreenshotHandle: vi.fn(async (handle: string) => (state.screenshot.image?.handle === handle ? state.screenshotBytes : null)),
  clipboardImageHandle: vi.fn(async () => state.clipboardImage),
}));

vi.mock('./pipeline', () => ({
  startPipeline: mocks.startPipeline,
  activePipeline: () => state.orch,
  activeStagingRoot: (): string | null => state.stagingRoot,
  reviewProjectionForActive: (): null => null, // SHELL-12: kb:listReviews now reads the maintained projection
  graphProjectionForActive: () => state.graphProjection, // SPEC-0058 STATE-2: the maintained graph projection (or null = warming)
  todayProjectionForActive: () => state.todayProjection, // SPEC-0058 Today: the maintained home projection (or null = warming)
  answerActiveReview: async () => ({ ok: false, message: 'no active kb' }),
  remediateActiveHealthFinding: async () => ({ ok: false, message: 'no active kb' }), // VUX-16
  dismissActiveHealthFinding: async () => ({ ok: false, message: 'no active kb' }),
  pipelineControlForActive: mocks.pipelineControl,
  fullReplay: async () => ({ ok: false, message: 'no active kb' }),
  composeBacklog: async () => ({ ok: false, message: 'no active kb' }),
  composeBacklogStatus: async () => ({ ok: false, message: 'no active kb' }),
  listResearchersForActive: mocks.listResearchers,
  setActiveResearcherConfig: mocks.setResearcherConfig,
  removeActiveResearcher: mocks.removeResearcher,
  runActiveResearcherNow: mocks.runResearcherNow,
  listResearcherRunsForActive: mocks.listResearcherRuns,
  listWatchFoldersForActive: mocks.listWatchFolders,
  setActiveWatchFolder: mocks.setWatchFolder,
  removeActiveWatchFolder: mocks.removeWatchFolder,
  removeActiveIntakeConnector: mocks.removeIntakeConnector,
  // ASK-17/19: kb:ask reads the configured recall budget from here before calling recall.
  getActiveInstanceSettings: mocks.getActiveInstanceSettings,
}));

vi.mock('../kb/recall', () => ({ recall: mocks.recall }));

import { registerIpc, initPipeline, stopRecallClient } from './ipc';
import { setResolvedLaunchModel } from '../kb/copilotModel';
import { createKb } from '../kb/vault';
import { computeGraphProjection } from '../kb/graphProjection';
import { obsidianOpenUri } from '../kb/citationLink';
import { setQuickCaptureAgent } from './quickCaptureService';
import type { QuickCaptureAgent, SelectionRead } from './quickCaptureAgent';
import type { ActivityFeedResult, AuditEvent, Lineage, OpenCitationResult, CaptureResult, QuickCaptureContext, TodayProjection, ConversationTurn } from '../kb/types';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const fn = state.handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return (await fn({ sender: {} }, ...args)) as T;
}

let vaultDir: string;

beforeEach(async () => {
  state.userData = await makeTempDir('kb-userdata-');
  vaultDir = await makeTempDir('kb-vault-');
  state.dialogResult = { canceled: false, filePaths: [] };
  state.handlers.clear();
  state.stagingRoot = null;
  state.clipboard = '';
  state.orch = null;
  state.screenshot = { status: 'unsupported', image: null };
  state.screenshotBytes = null;
  state.clipboardImage = null;
  state.graphProjection = null;
  state.todayProjection = null;
  setQuickCaptureAgent(null); // SPEC-0038: reset the QCAP agent singleton between tests (no cross-leak)
  mocks.startPipeline.mockClear();
  mocks.pipelineControl.mockClear();
  mocks.recall.mockClear();
  mocks.openExternal.mockClear();
  // ASK-19: reset to the default (no tool-call override) so a per-test mockResolvedValueOnce can't leak.
  mocks.getActiveInstanceSettings.mockReset();
  mocks.getActiveInstanceSettings.mockResolvedValue({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: 240_000 });
  delete process.env.KB_ASK_E2E_STUB;
  registerIpc();
});

afterEach(async () => {
  await rmTempDir(state.userData);
  await rmTempDir(vaultDir);
});

describe('SPEC-0055 RELEASE-6 — the app reports its version at runtime', () => {
  it('kb:getAppVersion returns app.getVersion() so a build is identifiable (the About panel renders it)', async () => {
    // FAILS-BEFORE: with no handler registered this throws "no handler registered for kb:getAppVersion".
    expect(await invoke<string>('kb:getAppVersion')).toBe('9.9.9-test');
  });
});

describe('SETUP-2 — the picked folder becomes the vault root', () => {
  it('kb:pickFolder returns the folder the Principal chose', async () => {
    state.dialogResult = { canceled: false, filePaths: [vaultDir] };
    expect(await invoke<string | null>('kb:pickFolder')).toBe(vaultDir);
  });

  it('kb:pickFolder returns null when the chooser is canceled', async () => {
    state.dialogResult = { canceled: true, filePaths: [] };
    expect(await invoke<string | null>('kb:pickFolder')).toBeNull();
  });

  it('the picked folder, once created, is the active vault root the app manages', async () => {
    // 1. Principal picks the folder…
    state.dialogResult = { canceled: false, filePaths: [vaultDir] };
    const picked = await invoke<string | null>('kb:pickFolder');
    expect(picked).toBe(vaultDir);

    // 2. …and creates the KB there.
    const res = await invoke<CreateKbResult>('kb:create', {
      path: picked,
      name: 'My KB',
      initGitIfNeeded: true,
    });
    expect(res.ok).toBe(true);

    // 3. The picked folder is now THE vault root: persisted + reported by getState…
    const app = await invoke<AppState>('kb:getState');
    expect(app.activeVaultPath).toBe(path.resolve(vaultDir));
    expect(app.vaultConfig?.name).toBe('My KB');

    // …and the main process is asked to manage exactly that vault.
    expect(mocks.startPipeline).toHaveBeenCalledWith(path.resolve(vaultDir));
  });
});

describe('MACOS-7 — folder-permission IPC ("Asking for the keys")', () => {
  it('kb:probeVaultAccess writes+removes a hidden probe marker; succeeds on an accessible vault (leaves no trace)', async () => {
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'KB', initGitIfNeeded: true });
    const res = await invoke<{ ok: boolean; denied: boolean }>('kb:probeVaultAccess', vaultDir);
    expect(res.ok).toBe(true);
    expect(res.denied).toBe(false);
    // the probe marker is cleaned up — nothing pollutes the user's vault (no synthetic artifact)
    await expect(fs.stat(path.join(vaultDir, '.kb', '.permission-probe'))).rejects.toThrow();
  });

  it('kb:probeVaultAccess refuses an off-config path (defense-in-depth) — never writes outside the active vault', async () => {
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'KB', initGitIfNeeded: true }); // active = vaultDir
    const offConfig = path.join(vaultDir, 'elsewhere'); // a different path than the active vault
    const res = await invoke<{ ok: boolean; denied: boolean }>('kb:probeVaultAccess', offConfig);
    expect(res.ok).toBe(false);
    expect(res.denied).toBe(false); // a config mismatch is NOT a permission denial (doesn't route to Blocked)
    // the probe never touched the off-config path — no marker written there (rejected before any fs write)
    await expect(fs.stat(path.join(offConfig, '.kb', '.permission-probe'))).rejects.toThrow();
  });

  it('kb:probeVaultAccess refuses when no KB is configured (null active vault)', async () => {
    const res = await invoke<{ ok: boolean; denied: boolean }>('kb:probeVaultAccess', vaultDir);
    expect(res.ok).toBe(false); // no active vault yet → nothing to probe
    expect(res.denied).toBe(false);
  });

  it('kb:openSystemSettingsPrivacy deep-links to the Files-and-Folders Privacy anchor', async () => {
    const res = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openSystemSettingsPrivacy');
    expect(res.ok).toBe(true);
    expect(res.usedFallback).toBeUndefined();
    expect(mocks.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
  });

  it('kb:openSystemSettingsPrivacy falls back to the general Privacy pane if the exact anchor rejects (never a no-op)', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('anchor not resolvable'));
    const res = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openSystemSettingsPrivacy');
    expect(res.ok).toBe(true);
    expect(res.usedFallback).toBe(true);
    expect(mocks.openExternal).toHaveBeenNthCalledWith(1, 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
    expect(mocks.openExternal).toHaveBeenNthCalledWith(2, 'x-apple.systempreferences:com.apple.preference.security?Privacy');
  });
});

describe('SETUP-6 — later launches load the existing KB (no re-onboarding)', () => {
  it('first run (no configured KB): getState reports no vault → setup is shown', async () => {
    const app = await invoke<AppState>('kb:getState');
    expect(app.activeVaultPath).toBeNull();
    expect(app.vaultConfig).toBeNull();
  });

  it('first run: initPipeline starts nothing when no KB is configured', async () => {
    await initPipeline();
    expect(mocks.startPipeline).not.toHaveBeenCalled();
  });

  it('a 2nd launch with a configured KB loads it and skips onboarding', async () => {
    // --- Launch #1: configure a KB at the picked folder. ---
    state.dialogResult = { canceled: false, filePaths: [vaultDir] };
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'Relaunch KB', initGitIfNeeded: true });

    // --- Launch #2: a fresh process re-registers handlers; only the persisted config
    //     (in userData) carries over. ---
    mocks.startPipeline.mockClear();
    state.handlers.clear();
    registerIpc();

    // The renderer's onboarding gate is `activeVaultPath && vaultConfig`. Both present →
    // it mounts the shell instead of the Setup wizard. No re-onboarding.
    const app = await invoke<AppState>('kb:getState');
    expect(app.activeVaultPath).toBe(path.resolve(vaultDir));
    expect(app.vaultConfig).not.toBeNull();
    expect(app.vaultConfig?.name).toBe('Relaunch KB');

    // And on launch the main process resumes managing the configured vault.
    await initPipeline();
    expect(mocks.startPipeline).toHaveBeenCalledWith(path.resolve(vaultDir));
  });

  it('a 2nd launch whose configured vault has vanished does not falsely report a loaded KB', async () => {
    // Configure, then delete the vault from disk (moved/deleted between launches).
    state.dialogResult = { canceled: false, filePaths: [vaultDir] };
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'Gone KB', initGitIfNeeded: true });
    await rmTempDir(vaultDir);

    const app = await invoke<AppState>('kb:getState');
    // Path is still remembered, but the config can't load → renderer's gate (needs both)
    // falls back to setup rather than mounting a broken shell.
    expect(app.activeVaultPath).toBe(path.resolve(vaultDir));
    expect(app.vaultConfig).toBeNull();

    // initPipeline likewise refuses to manage a vault whose config is gone
    // (clear the call kb:create made on launch #1 so we observe only this launch).
    mocks.startPipeline.mockClear();
    await initPipeline();
    expect(mocks.startPipeline).not.toHaveBeenCalled();
  });
});

describe('SPEC-0026 ASK — kb:ask grounded recall', () => {
  async function configureVault(p: string): Promise<void> {
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: p }) + '\n');
  }

  it('runs recall on the active vault root and returns its result', async () => {
    await configureVault(vaultDir);
    const res = await invoke<{ answer: string }>('kb:ask', { question: 'Who?', history: [] });
    // 3rd arg carries the resolved BYOA cliPath (BUG #65); its value is env-dependent, so match loosely.
    expect(mocks.recall).toHaveBeenCalledWith(path.resolve(vaultDir), { question: 'Who?', history: [] }, expect.any(Object));
    expect(res.answer).toBe('mock recall');
  });

  it('ASK-17/19: forwards the configured time budget + tool-call override across the read-boundary into recall opts', async () => {
    await configureVault(vaultDir);
    // A Principal-configured manual search-depth override (recallMaxToolCalls) must reach recall as opts.maxToolCalls.
    mocks.getActiveInstanceSettings.mockResolvedValueOnce({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: 300_000, recallMaxToolCalls: 18 });
    await invoke('kb:ask', { question: 'Who?', history: [] });
    const opts = (mocks.recall.mock.calls[0] as unknown[])[2] as { sessionBudgetMs?: number; maxToolCalls?: number };
    expect(opts.sessionBudgetMs).toBe(300_000); // ASK-17 time budget
    expect(opts.maxToolCalls).toBe(18); // ASK-19 retrieval tool-call override
  });

  it('ASK-19: no configured override ⇒ recall opts.maxToolCalls is undefined (recall applies its scaled default)', async () => {
    await configureVault(vaultDir);
    // Default mock has no recallMaxToolCalls → the override is absent, so recall falls back to recallBudget(nodeCount).
    await invoke('kb:ask', { question: 'Who?', history: [] });
    const opts = (mocks.recall.mock.calls[0] as unknown[])[2] as { maxToolCalls?: number };
    expect(opts.maxToolCalls).toBeUndefined();
  });

  it('VUX-11: effort "quick" shallows recall depth — floor hops + 60s — even over a deep Principal config', async () => {
    await configureVault(vaultDir);
    // Principal configured a DEEP baseline (5min, 18 hops); Quick must still force the fast/shallow floor.
    mocks.getActiveInstanceSettings.mockResolvedValueOnce({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: 300_000, recallMaxToolCalls: 18 });
    await invoke('kb:ask', { question: 'Who?', history: [], effort: 'quick' });
    const opts = (mocks.recall.mock.calls[0] as unknown[])[2] as { sessionBudgetMs?: number; maxToolCalls?: number };
    expect(opts.maxToolCalls).toBe(4); // RECALL_BUDGET.BASE floor
    expect(opts.sessionBudgetMs).toBe(60_000); // RECALL_BUDGET_MS_MIN floor
  });

  it('VUX-11: effort "considered" passes the configured depth through unchanged (the full-depth default)', async () => {
    await configureVault(vaultDir);
    mocks.getActiveInstanceSettings.mockResolvedValueOnce({ autonomyDefault: 'guarded', devLogLevel: 'info', quickCaptureAccelerator: 'Alt+Space', recallBudgetMs: 300_000, recallMaxToolCalls: 18 });
    await invoke('kb:ask', { question: 'Who?', history: [], effort: 'considered' });
    const opts = (mocks.recall.mock.calls[0] as unknown[])[2] as { sessionBudgetMs?: number; maxToolCalls?: number };
    expect(opts.sessionBudgetMs).toBe(300_000); // unchanged from config
    expect(opts.maxToolCalls).toBe(18);
  });

  it('returns an honest ungrounded result when no KB is configured (recall not run)', async () => {
    const res = await invoke<{ grounded: boolean; answer: string }>('kb:ask', { question: 'Who?' });
    expect(res.grounded).toBe(false);
    expect(res.answer).toContain('No active library');
    expect(mocks.recall).not.toHaveBeenCalled();
  });

  it('KB_ASK_E2E_STUB short-circuits to a deterministic grounded answer (no recall, no vault)', async () => {
    process.env.KB_ASK_E2E_STUB = '1';
    const res = await invoke<{ grounded: boolean; citations: { ref: string }[] }>('kb:ask', { question: 'Who?' });
    expect(res.grounded).toBe(true);
    expect(res.citations[0].ref).toBe('claims/person/ada-lovelace.md');
    expect(mocks.recall).not.toHaveBeenCalled();
  });
});

// #514: kb:ask previously built a fresh RecallClient (→ a fresh CLI server) on every call. ipc.ts now
// passes ONE process-wide client via opts.client — proven here at the wiring level by identity (the
// underlying "one CopilotClient" guarantee is recallAgent.test.ts's job).
describe('#514 — kb:ask reuses ONE process-wide RecallClient across questions', () => {
  async function configureVault(p: string): Promise<void> {
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: p }) + '\n');
  }

  it('passes the SAME client instance (opts.client) on every kb:ask call — 2nd+ question skips the server boot', async () => {
    await configureVault(vaultDir);
    await invoke('kb:ask', { question: 'Q1', history: [] });
    await invoke('kb:ask', { question: 'Q2', history: [] });
    const client1 = (mocks.recall.mock.calls[0] as unknown[])[2] as { client?: unknown };
    const client2 = (mocks.recall.mock.calls[1] as unknown[])[2] as { client?: unknown };
    expect(client1.client).toBeDefined();
    expect(client1.client).toBe(client2.client); // identical reference — reused, not rebuilt
  });

  it('stopRecallClient() is safe to call before any ask ever ran (idempotent no-op)', async () => {
    await expect(stopRecallClient()).resolves.toBeUndefined();
    await expect(stopRecallClient()).resolves.toBeUndefined();
  });

  it('a subsequent ask after stopRecallClient() builds a FRESH client (a clean client for the next question, not a stale disconnected one)', async () => {
    await configureVault(vaultDir);
    await invoke('kb:ask', { question: 'Q1', history: [] });
    const before = (mocks.recall.mock.calls[0] as unknown[])[2] as { client?: unknown };
    await stopRecallClient();
    await invoke('kb:ask', { question: 'Q2', history: [] });
    const after = (mocks.recall.mock.calls[1] as unknown[])[2] as { client?: unknown };
    expect(after.client).not.toBe(before.client);
  });
});

// #514: the honest Quick tier is reasoningEffort ONLY — VUX-11 (ratified, PM-confirmed 2026-07-13) rules
// out a model swap for effort: recall depth (tool-call/time budget, tested elsewhere) + reasoningEffort
// are the only levers. Quick and Considered resolve the SAME (untiered, global) model.
describe('#514 — honest Quick tier: reasoningEffort only, model is UNCHANGED by effort (VUX-11)', () => {
  async function configureVault(p: string): Promise<void> {
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: p }) + '\n');
  }

  afterEach(() => {
    setResolvedLaunchModel(null);
  });

  it('effort:"quick" forwards reasoningEffort:"low" but resolves the SAME global model as considered', async () => {
    await configureVault(vaultDir);
    setResolvedLaunchModel('claude-opus-4.8');
    await invoke('kb:ask', { question: 'Who?', history: [], effort: 'quick' });
    const opts = (mocks.recall.mock.calls[0] as unknown[])[2] as { model?: string; reasoningEffort?: string; effort?: string };
    expect(opts.model).toBe('claude-opus-4.8'); // NOT a lighter model — VUX-11: no model swap for effort
    expect(opts.reasoningEffort).toBe('low');
    expect(opts.effort).toBe('quick');
  });

  it('effort:"considered" (or omitted) resolves the same model, no reasoningEffort override', async () => {
    await configureVault(vaultDir);
    setResolvedLaunchModel('claude-opus-4.8');
    await invoke('kb:ask', { question: 'Who?', history: [], effort: 'considered' });
    const opts = (mocks.recall.mock.calls[0] as unknown[])[2] as { model?: string; reasoningEffort?: string; effort?: string };
    expect(opts.model).toBe('claude-opus-4.8');
    expect(opts.reasoningEffort).toBeUndefined();
    expect(opts.effort).toBe('considered');
  });

  it('quick and considered resolve to the IDENTICAL model — effort never changes which model runs', async () => {
    await configureVault(vaultDir);
    setResolvedLaunchModel('claude-sonnet-4.6');
    await invoke('kb:ask', { question: 'Q1', history: [], effort: 'quick' });
    await invoke('kb:ask', { question: 'Q2', history: [], effort: 'considered' });
    const quickOpts = (mocks.recall.mock.calls[0] as unknown[])[2] as { model?: string };
    const consideredOpts = (mocks.recall.mock.calls[1] as unknown[])[2] as { model?: string };
    expect(quickOpts.model).toBe(consideredOpts.model);
  });
});

// #514: a live Ask pushes tool-call progress back to the SAME renderer that invoked it, so the status
// line can name the in-flight tool + call count instead of a static "Searching…" line for the whole run.
describe('#514 — kb:ask pushes live progress to the invoking renderer', () => {
  async function configureVault(p: string): Promise<void> {
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: p }) + '\n');
  }

  it('passes an onProgress callback that sends kb:askProgress on the invoking sender', async () => {
    await configureVault(vaultDir);
    const send = vi.fn();
    const fn = state.handlers.get('kb:ask')!;
    await fn({ sender: { send } }, { question: 'Who?', history: [] });
    const opts = (mocks.recall.mock.calls[0] as unknown[])[2] as { onProgress?: (evt: unknown) => void };
    expect(typeof opts.onProgress).toBe('function');
    opts.onProgress!({ phase: 'tool-call', tool: 'entityLookup', used: 1, max: 4 });
    expect(send).toHaveBeenCalledWith('kb:askProgress', { phase: 'tool-call', tool: 'entityLookup', used: 1, max: 4 });
  });
});

describe('SPEC-0060 VUX-11 — kb:saveConversation / listConversations / loadConversation (past-chats)', () => {
  const turn = (q: string, a: string): ConversationTurn => ({ result: { question: q, answer: a, citations: [], grounded: true, toolCalls: 1, truncated: false }, askedAt: '2026-06-28T00:00:00.000Z' });

  it('round-trips a thread through the IPC layer: save → list (newest-first) → load (faithful)', async () => {
    const { id } = await invoke<{ id: string }>('kb:saveConversation', { turns: [turn('Who is Ada?', 'Ada Lovelace.')] });
    expect(typeof id).toBe('string');
    const list = await invoke<{ id: string; title: string; turnCount: number }[]>('kb:listConversations');
    expect(list.find((s) => s.id === id)).toMatchObject({ title: 'Who is Ada?', turnCount: 1 });
    const loaded = await invoke<{ id: string; turns: { result: { answer: string } }[] } | null>('kb:loadConversation', id);
    expect(loaded?.turns[0].result.answer).toBe('Ada Lovelace.'); // full AskResult restored
  });

  it('an id can UPDATE the same thread (no duplicate row)', async () => {
    const { id } = await invoke<{ id: string }>('kb:saveConversation', { turns: [turn('q1', 'a1')] });
    await invoke('kb:saveConversation', { id, turns: [turn('q1', 'a1'), turn('q2', 'a2')] });
    const list = await invoke<unknown[]>('kb:listConversations');
    expect(list).toHaveLength(1);
    const loaded = await invoke<{ turns: unknown[] }>('kb:loadConversation', id);
    expect(loaded.turns).toHaveLength(2);
  });

  it('load is ULID-contained — a crafted traversal id returns null (no escape)', async () => {
    expect(await invoke('kb:loadConversation', '../kb-app.config')).toBeNull();
    expect(await invoke('kb:loadConversation', 'not-a-ulid')).toBeNull();
  });

  it('delete removes a thread through the IPC layer; a crafted id is rejected (ok:false)', async () => {
    const { id } = await invoke<{ id: string }>('kb:saveConversation', { turns: [turn('q', 'a')] });
    expect(await invoke<unknown[]>('kb:listConversations')).toHaveLength(1);
    expect(await invoke('kb:deleteConversation', id)).toEqual({ ok: true });
    expect(await invoke<unknown[]>('kb:listConversations')).toHaveLength(0);
    expect(await invoke('kb:deleteConversation', '../kb-app.config')).toEqual({ ok: false }); // contained
  });
});

describe('SPEC-0026 ASK-14 — kb:openCitation opens an Obsidian deep-link', () => {
  async function configureVault(p: string): Promise<void> {
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: p }) + '\n');
  }

  it('resolves a contained ref to an absolute path and opens the percent-encoded obsidian:// URI', async () => {
    await configureVault(vaultDir);
    const res = await invoke<OpenCitationResult>('kb:openCitation', 'entities/person/ada lovelace.md');
    expect(res).toEqual({ ok: true });
    // the URI is built from the ABSOLUTE vault path + encoded (the space → %20)
    const expectedAbs = path.join(path.resolve(vaultDir), 'entities/person/ada lovelace.md');
    const expectedUri = obsidianOpenUri(expectedAbs);
    expect(expectedUri).toContain('%20'); // the space is percent-encoded, not a raw URI break
    expect(mocks.openExternal).toHaveBeenCalledWith(expectedUri);
  });

  it('refuses a ref that escapes the vault (containment, #30) — no open', async () => {
    await configureVault(vaultDir);
    const res = await invoke<OpenCitationResult>('kb:openCitation', '../../etc/passwd');
    expect(res).toEqual({ ok: false, reason: 'invalid-ref' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('refuses an empty/non-string ref', async () => {
    await configureVault(vaultDir);
    expect(await invoke<OpenCitationResult>('kb:openCitation', '')).toEqual({ ok: false, reason: 'invalid-ref' });
    expect(await invoke<OpenCitationResult>('kb:openCitation', 42)).toEqual({ ok: false, reason: 'invalid-ref' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('returns no-vault when no KB is configured (nothing opened)', async () => {
    const res = await invoke<OpenCitationResult>('kb:openCitation', 'entities/x.md');
    expect(res).toEqual({ ok: false, reason: 'no-vault' });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('maps a failed open to open-failed (never rejects the renderer)', async () => {
    await configureVault(vaultDir);
    mocks.openExternal.mockRejectedValueOnce(new Error('no handler for obsidian://'));
    const res = await invoke<OpenCitationResult>('kb:openCitation', 'entities/x.md');
    expect(res).toEqual({ ok: false, reason: 'open-failed' });
  });
});

describe('SPEC-0029 Audit & Activity — read-only IPC over the active staging worktree', () => {
  /** Seed a KB with a small spread of real audit lines and point the (mocked) staging root at it. */
  async function seedActivityVault(): Promise<void> {
    await createKb({ path: vaultDir, name: 'Activity KB', initGitIfNeeded: true });
    const write = async (rel: string, lines: Record<string, unknown>[]): Promise<void> => {
      const abs = path.join(vaultDir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.appendFile(abs, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    };
    await write(path.join('sources', '2026', '01', 'S1', 'audit.jsonl'), [
      { action: 'archived', id: 'S1', archivedAt: '2026-01-01T00:00:00.000Z', decision: {}, agent: { via: 'deterministic' } },
      { ts: '2026-01-01T00:01:00.000Z', stage: 'claims', runId: 'C1', entityId: 'E1', sourceId: 'S1', event: 'claimed', claims: 2 },
    ]);
    await write(path.join('connect', 'audit.jsonl'), [
      { ts: '2026-01-01T00:02:00.000Z', stage: 'connect', runId: 'N1', blockKey: 'k', event: 'resolved', node: 'entities/2026/01/E1.md', candidates: 1, merged: 0 },
    ]);
    state.stagingRoot = vaultDir;
  }

  it('returns empty results when no KB is active (no staging root)', async () => {
    state.stagingRoot = null;
    expect(await invoke<ActivityFeedResult>('kb:activityFeed')).toEqual({ entries: [], total: 0, truncated: false });
    expect(await invoke<AuditEvent[]>('kb:activityEvents')).toEqual([]);
    const lin = await invoke<Lineage>('kb:activityLineage', 'E1');
    expect(lin).toMatchObject({ subjectId: 'E1', kind: 'unknown', events: [] });
  });

  it('kb:activityFeed returns curated entries + the window-cap signal', async () => {
    await seedActivityVault();
    const res = await invoke<ActivityFeedResult>('kb:activityFeed');
    expect(res.total).toBe(3);
    expect(res.truncated).toBe(false);
    expect(res.entries.length).toBeGreaterThan(0);
    expect(res.entries[0]).toHaveProperty('summary');
    expect(res.entries[0]).toHaveProperty('events'); // raw events ride along for drill-down
  });

  it('kb:activityFeed honors an actor filter', async () => {
    await seedActivityVault();
    const res = await invoke<ActivityFeedResult>('kb:activityFeed', { actors: ['connect'] });
    expect(res.entries.every((e) => e.actor === 'connect')).toBe(true);
    expect(res.entries.length).toBe(1);
  });

  it('kb:activityEvents returns raw events filtered across the full audit', async () => {
    await seedActivityVault();
    const all = await invoke<AuditEvent[]>('kb:activityEvents');
    expect(all.map((e) => e.actor)).toEqual(['connect', 'claims', 'archivist']); // newest-first
    const byEntity = await invoke<AuditEvent[]>('kb:activityEvents', { subjectId: 'E1' });
    expect(byEntity.map((e) => e.actor).sort()).toEqual(['claims', 'connect']);
  });

  it('kb:activityLineage traces a subject from the audit', async () => {
    await seedActivityVault();
    const lin = await invoke<Lineage>('kb:activityLineage', 'E1');
    expect(lin.kind).toBe('entity');
    expect(lin.sources).toContain('S1');
    expect(lin.events.length).toBeGreaterThanOrEqual(2);
  });
});

describe('SPEC-0028 Researchers — Control Panel IPC delegates to the pipeline helpers', () => {
  it('kb:listResearchers returns the researcher views', async () => {
    const views = await invoke<{ id: string }[]>('kb:listResearchers');
    expect(mocks.listResearchers).toHaveBeenCalled();
    expect(views[0].id).toBe('web-1');
  });

  it('kb:setResearcherConfig forwards the patch + returns the refreshed list', async () => {
    const views = await invoke<{ enabled: boolean }[]>('kb:setResearcherConfig', { id: 'web-1', enabled: true });
    expect(mocks.setResearcherConfig).toHaveBeenCalledWith({ id: 'web-1', enabled: true });
    expect(views[0].enabled).toBe(true);
  });

  it('kb:listWatchFolders returns the watched-folder views (SPEC-0037)', async () => {
    const views = await invoke<{ id: string; watching: boolean }[]>('kb:listWatchFolders');
    expect(mocks.listWatchFolders).toHaveBeenCalled();
    expect(views[0].id).toBe('drop');
  });

  it('kb:setWatchFolder forwards the patch + returns the refreshed list', async () => {
    const views = await invoke<{ enabled: boolean }[]>('kb:setWatchFolder', { id: 'drop', enabled: true });
    expect(mocks.setWatchFolder).toHaveBeenCalledWith({ id: 'drop', enabled: true });
    expect(views[0].enabled).toBe(true);
  });

  it('kb:removeWatchFolder forwards the id + returns the refreshed list', async () => {
    const views = await invoke<unknown[]>('kb:removeWatchFolder', 'drop');
    expect(mocks.removeWatchFolder).toHaveBeenCalledWith('drop');
    expect(views).toEqual([]);
  });

  it('kb:removeResearcher (PANEL-11) forwards the id + returns the refreshed roster', async () => {
    const views = await invoke<unknown[]>('kb:removeResearcher', 'web-1');
    expect(mocks.removeResearcher).toHaveBeenCalledWith('web-1');
    expect(views).toEqual([]);
  });

  it('kb:removeIntakeConnector (PANEL-11) forwards the id + returns the refreshed list', async () => {
    const views = await invoke<unknown[]>('kb:removeIntakeConnector', 'hn');
    expect(mocks.removeIntakeConnector).toHaveBeenCalledWith('hn');
    expect(views).toEqual([]);
  });

  it('kb:runResearcherNow forwards the id + returns the run result', async () => {
    const res = await invoke<{ ran: boolean; sourceIds: string[] }>('kb:runResearcherNow', 'web-1');
    expect(mocks.runResearcherNow).toHaveBeenCalledWith('web-1');
    expect(res).toMatchObject({ ran: true, sourceIds: ['SRC1'] });
  });

  it('kb:runResearcherNow maps a thrown error to a not-found result (never rejects the renderer)', async () => {
    mocks.runResearcherNow.mockRejectedValueOnce(new Error('boom'));
    const res = await invoke<{ ran: boolean; reason?: string }>('kb:runResearcherNow', 'web-1');
    expect(res).toEqual({ ran: false, reason: 'not-found' });
  });

  it('kb:listResearcherRuns forwards the id + returns recent runs', async () => {
    const runs = await invoke<{ eventType: string }[]>('kb:listResearcherRuns', 'web-1');
    expect(mocks.listResearcherRuns).toHaveBeenCalledWith('web-1');
    expect(runs[0].eventType).toBe('researched');
  });
});

describe('SPEC-0030 OBS-17 — kb:pipelineControl delegates set-aside recovery', () => {
  it('forwards the {action, stage, itemId} request + returns the result', async () => {
    const res = await invoke<{ ok: boolean; message?: string }>('kb:pipelineControl', { action: 'retry', stage: 'claims', itemId: '01ADAID' });
    expect(mocks.pipelineControl).toHaveBeenCalledWith({ action: 'retry', stage: 'claims', itemId: '01ADAID' });
    expect(res).toEqual({ ok: true, message: 'Retrying Ada Lovelace.' });
  });
});

describe('SPEC-0046 COMPOSE-9 — kb:composeBacklog / kb:composeBacklogStatus are wired', () => {
  it('registers the backfill trigger + read-only status handlers and returns the pipeline result', async () => {
    expect(await invoke<{ ok: boolean; message: string }>('kb:composeBacklog')).toEqual({ ok: false, message: 'no active kb' });
    expect(await invoke<{ ok: boolean; message: string }>('kb:composeBacklogStatus')).toEqual({ ok: false, message: 'no active kb' });
  });
});

describe('SPEC-0038 QCAP — quick capture IPC', () => {
  it('QCAP-1: with no active KB, kb:quickCapture reports it (never silently drops)', async () => {
    state.orch = null;
    const res = await invoke<CaptureResult>('kb:quickCapture', { inputs: [{ kind: 'text', text: 'hi' }] });
    expect(res.ok).toBe(false);
  });

  it('QCAP-5/2: delivers onto the SPEC-0013 path with surface=quick-capture (fast-out — delegates to capture())', async () => {
    const capture = vi.fn(async () => ({ ids: ['Q1'], captureBatch: 'qb', committed: true }));
    state.orch = { capture };
    const res = await invoke<CaptureResult>('kb:quickCapture', { inputs: [{ kind: 'text', text: 'mid-read thought' }] });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('quick-capture', [{ kind: 'text', text: 'mid-read thought' }]);
    expect(res).toEqual({ ok: true, ids: ['Q1'], captureBatch: 'qb', committed: true, message: 'Captured 1 item(s).' });
  });

  it('fork #3: the frictionless sheet is text-only — file inputs are ignored', async () => {
    const capture = vi.fn(async () => ({ ids: ['Q1'], captureBatch: 'qb', committed: true }));
    state.orch = { capture };
    await invoke<CaptureResult>('kb:quickCapture', {
      inputs: [
        { kind: 'text', text: 'note' },
        { kind: 'file', name: 'x.png', data: new Uint8Array([1]) },
      ],
    });
    expect(capture).toHaveBeenCalledWith('quick-capture', [{ kind: 'text', text: 'note' }]);
  });

  it('empty text → nothing captured', async () => {
    const capture = vi.fn(async () => ({ ids: [], captureBatch: 'qb', committed: true }));
    state.orch = { capture };
    const res = await invoke<CaptureResult>('kb:quickCapture', { inputs: [{ kind: 'text', text: '   ' }] });
    expect(capture).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it('QCAP-7: kb:quickCaptureContext returns the clipboard + degrades selection when no agent is wired', async () => {
    state.clipboard = 'something I was reading';
    // No QCAP agent → no summon-time selection → selection null + accessibility unsupported (clipboard-only).
    const ctx = await invoke<QuickCaptureContext>('kb:quickCaptureContext');
    expect(ctx).toEqual({ clipboard: 'something I was reading', selection: null, accessibility: 'unsupported', clipboardImage: null, screenshotSupported: process.platform === 'darwin' });
  });

  it('QCAP-7/9 (Slice 2): kb:quickCaptureContext folds in the agent selection read at summon time', async () => {
    state.clipboard = 'on the clipboard';
    // A contract-faithful stub agent: takeSelectionContext returns what the real agent stashed on open().
    const stub = { takeSelectionContext: (): SelectionRead => ({ status: 'granted', text: 'the highlighted line' }) };
    setQuickCaptureAgent(stub as unknown as QuickCaptureAgent);
    const ctx = await invoke<QuickCaptureContext>('kb:quickCaptureContext');
    expect(ctx).toEqual({ clipboard: 'on the clipboard', selection: 'the highlighted line', accessibility: 'granted', clipboardImage: null, screenshotSupported: process.platform === 'darwin' });
  });

  it('QCAP-9 (Slice 2): a denied grant degrades — selection null, accessibility denied, clipboard still flows', async () => {
    state.clipboard = 'fallback text';
    const stub = { takeSelectionContext: (): SelectionRead => ({ status: 'denied', text: null }) };
    setQuickCaptureAgent(stub as unknown as QuickCaptureAgent);
    const ctx = await invoke<QuickCaptureContext>('kb:quickCaptureContext');
    expect(ctx).toEqual({ clipboard: 'fallback text', selection: null, accessibility: 'denied', clipboardImage: null, screenshotSupported: process.platform === 'darwin' });
  });

  it('QCAP-13: kb:quickCaptureContext folds in a clipboard image (the "paste an image" prefill)', async () => {
    state.clipboardImage = { handle: '/tmp/kb-qcap-shots/clip.png', name: 'pasted-image-1.png' };
    const ctx = await invoke<QuickCaptureContext>('kb:quickCaptureContext');
    expect(ctx.clipboardImage).toEqual({ handle: '/tmp/kb-qcap-shots/clip.png', name: 'pasted-image-1.png' });
  });

  it('QCAP-13: kb:quickCaptureScreenshot returns the capture result', async () => {
    state.screenshot = { status: 'granted', image: { handle: '/tmp/kb-qcap-shots/shot.png', name: 'screenshot-1.png' } };
    const res = await invoke<{ status: string; image: { handle: string } | null }>('kb:quickCaptureScreenshot', 'region');
    expect(res).toEqual({ status: 'granted', image: { handle: '/tmp/kb-qcap-shots/shot.png', name: 'screenshot-1.png' } });
  });

  it('QCAP-13: kb:quickCapture resolves a screenshot input → a file payload on the SPEC-0013 path (surface=quick-capture)', async () => {
    const capture = vi.fn(async () => ({ ids: ['SHOT1'], captureBatch: 'b1', committed: true }));
    state.orch = { capture };
    state.screenshot = { status: 'granted', image: { handle: '/tmp/kb-qcap-shots/shot.png', name: 'screenshot-1.png' } };
    state.screenshotBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const res = await invoke<CaptureResult>('kb:quickCapture', {
      inputs: [{ kind: 'screenshot', handle: '/tmp/kb-qcap-shots/shot.png', name: 'screenshot-1.png' }],
    });
    expect(res.ok).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const [surface, payloads] = capture.mock.calls[0] as unknown as [string, Array<{ kind: string; name?: string }>];
    expect(surface).toBe('quick-capture');
    expect(payloads).toEqual([{ kind: 'file', name: 'screenshot-1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }]);
  });

  it('QCAP-13: a screenshot handle we did NOT issue is ignored (nothing captured) — security boundary', async () => {
    const capture = vi.fn(async () => ({ ids: ['x'], captureBatch: 'b', committed: true }));
    state.orch = { capture };
    state.screenshot = { status: 'granted', image: { handle: '/tmp/kb-qcap-shots/legit.png', name: 'legit.png' } };
    state.screenshotBytes = new Uint8Array([1, 2, 3]);
    // A forged handle (not the one the mock "issued") → consume returns null → no payload → nothing captured.
    const res = await invoke<CaptureResult>('kb:quickCapture', {
      inputs: [{ kind: 'screenshot', handle: '/etc/passwd', name: 'evil.png' }],
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe('Nothing to capture.');
    expect(capture).not.toHaveBeenCalled();
  });

  it('QCAP-13: kb:openScreenRecordingSettings deep-links to the Screen-Recording anchor, falls back to Privacy', async () => {
    const ok = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openScreenRecordingSettings');
    expect(ok).toEqual({ ok: true });
    expect(mocks.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    mocks.openExternal.mockClear();
    mocks.openExternal.mockRejectedValueOnce(new Error('anchor not resolvable'));
    const fb = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openScreenRecordingSettings');
    expect(fb).toEqual({ ok: true, usedFallback: true });
    expect(mocks.openExternal).toHaveBeenNthCalledWith(2, 'x-apple.systempreferences:com.apple.preference.security?Privacy');
  });

  it('QCAP-9 (Slice 2): kb:openAccessibilitySettings deep-links to the Accessibility Privacy anchor', async () => {
    const res = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openAccessibilitySettings');
    expect(res.ok).toBe(true);
    expect(res.usedFallback).toBeUndefined();
    expect(mocks.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });

  it('QCAP-9 (Slice 2): kb:openAccessibilitySettings falls back to the general Privacy pane (never a no-op)', async () => {
    mocks.openExternal.mockRejectedValueOnce(new Error('anchor not resolvable'));
    const res = await invoke<{ ok: boolean; usedFallback?: boolean }>('kb:openAccessibilitySettings');
    expect(res).toEqual({ ok: true, usedFallback: true });
    expect(mocks.openExternal).toHaveBeenNthCalledWith(1, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    expect(mocks.openExternal).toHaveBeenNthCalledWith(2, 'x-apple.systempreferences:com.apple.preference.security?Privacy');
  });

  it('QCAP-2: kb:quickCaptureClose resolves (no-op when no agent is wired)', async () => {
    await expect(invoke<void>('kb:quickCaptureClose')).resolves.toBeUndefined();
  });
});

// SPEC-0058 slice-0 — Explore + Health read the EVERGREEN graph via makeReadOnlyTools. The packaged P0
// was these views failing to load on that path. These regress through the REAL IPC handlers (registerIpc
// + a real git vault with real entity files), NOT a mocked stub of the read — so a genuine break in the
// evergreen-graph read path (the thing that shipped broken) is caught here, not hidden behind a fake.
describe('SPEC-0058 slice-0 — Explore + Health evergreen-graph read path (REAL IPC handlers)', () => {
  /** Seed the active vault with two real, parser-valid entity files linked Ada → Steve. */
  async function seedGraphVault(): Promise<void> {
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'Graph KB', initGitIfNeeded: true }); // active = vaultDir
    const ada = '---\nid: 01ADA\nkind: person\nname: Ada Lovelace\ntags: ["type/person"]\n---\n# Ada Lovelace\nWorked with [[entities/person/steve.md]].\n';
    const steve = '---\nid: 01STEVE\nkind: person\nname: Steve\ntags: ["type/person"]\n---\n# Steve\n';
    await fs.mkdir(path.join(vaultDir, 'entities', 'person'), { recursive: true });
    await fs.writeFile(path.join(vaultDir, 'entities', 'person', 'ada.md'), ada, 'utf8');
    await fs.writeFile(path.join(vaultDir, 'entities', 'person', 'steve.md'), steve, 'utf8');
  }

  it('kb:exploreEntities returns the real entity list from the live vault scan', async () => {
    await seedGraphVault();
    const entities = await invoke<{ name: string }[]>('kb:exploreEntities');
    expect(entities.map((e) => e.name).sort()).toEqual(['Ada Lovelace', 'Steve']);
  });

  it('kb:exploreNeighborhood builds a real 1-hop neighborhood (center + linked neighbor) from the vault', async () => {
    await seedGraphVault();
    const nb = await invoke<{ found: boolean; center?: { name: string }; neighbors: { name: string }[] }>('kb:exploreNeighborhood', 'Ada Lovelace');
    expect(nb.found).toBe(true);
    expect(nb.center?.name).toBe('Ada Lovelace');
    expect(nb.neighbors.map((n) => n.name)).toContain('Steve'); // the [[steve]] wikilink resolved to a real edge
  });

  it('kb:healthReport scans the real vault and returns the Health PROJECTION (SPEC-0058 STATE-3; no throw on the read path)', async () => {
    await seedGraphVault();
    const proj = await invoke<{ status: string; scanned: number; dimensions: { key: string }[]; overall: string }>('kb:healthReport');
    expect(proj.status).toBe('ready');
    expect(proj.scanned).toBe(2); // both entities were really walked + parsed
    expect(proj.dimensions.map((d) => d.key)).toEqual(['dangling', 'orphans', 'thin']); // the contract shape
    expect(['ok', 'attention']).toContain(proj.overall);
  });

  it('all three handlers degrade to safe empty results when no vault is active (never throw)', async () => {
    // no kb:create → readAppConfig has no activeVaultPath
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: null }) + '\n');
    expect(await invoke<unknown[]>('kb:exploreEntities')).toEqual([]);
    expect(await invoke<{ found: boolean }>('kb:exploreNeighborhood')).toMatchObject({ found: false });
    expect(await invoke<{ scanned: number }>('kb:healthReport')).toMatchObject({ scanned: 0 });
  });

  // SPEC-0060 VUX-16 slice-1: the remediation IPCs reject malformed input at the boundary, and with no
  // active KB they fail honestly (never throw). The end-to-end apply/dismiss loop is covered in
  // healthRemediation.test.ts (real staging + promote); here we guard the IPC contract.
  it('kb:healthRemediate / kb:dismissHealthFinding validate input + fail honestly with no active KB', async () => {
    await fs.writeFile(path.join(state.userData, 'kb-app.config.json'), JSON.stringify({ activeVaultPath: null }) + '\n');
    // malformed → rejected at the boundary
    expect(await invoke<{ ok: boolean }>('kb:healthRemediate', { action: 'merge', nodeRel: 'x' })).toMatchObject({ ok: false }); // merge is HELD/destructive — not a slice-1 action
    expect(await invoke<{ ok: boolean }>('kb:healthRemediate', {})).toMatchObject({ ok: false });
    expect(await invoke<{ ok: boolean }>('kb:dismissHealthFinding', { kind: 'orphan' })).toMatchObject({ ok: false }); // missing findingKey
    // well-formed but no active KB → honest failure, not a throw
    expect(await invoke<{ ok: boolean; message: string }>('kb:healthRemediate', { action: 'find-homes', nodeRel: 'entities/x.md' })).toMatchObject({ ok: false });
    expect(await invoke<{ ok: boolean; message: string }>('kb:dismissHealthFinding', { findingKey: 'orphan:concept|x', kind: 'orphan' })).toMatchObject({ ok: false });
  });
});

// SPEC-0058 STATE-2 — the MAINTAINED graph projection at the IPC: kb:exploreProjection serves
// {status, data:{neighborhood, entities}, builtAt, stale} from the in-memory snapshot (no live walk),
// and the migrated handlers read the projection when it's built. Through the REAL registerIpc handlers,
// with a REAL computed projection (computeGraphProjection over a real vault) as the store's current() —
// not a faked stub of the data: the handler's assembly (makeProjectionTools + buildNeighborhood) runs on
// real graph data. The store's maintenance/persistence is proven separately (projectionStore + #457 tests).
describe('SPEC-0058 STATE-2 — kb:exploreProjection over the maintained graph store (REAL handler)', () => {
  async function seedAndProject(): Promise<void> {
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'Graph KB', initGitIfNeeded: true });
    const ada = '---\nid: 01ADA\nkind: person\nname: Ada Lovelace\ntags: ["type/person"]\n---\n# Ada Lovelace\nWorked with [[entities/person/steve.md]].\n';
    const steve = '---\nid: 01STEVE\nkind: person\nname: Steve\ntags: ["type/person"]\n---\n# Steve\n';
    await fs.mkdir(path.join(vaultDir, 'entities', 'person'), { recursive: true });
    await fs.writeFile(path.join(vaultDir, 'entities', 'person', 'ada.md'), ada, 'utf8');
    await fs.writeFile(path.join(vaultDir, 'entities', 'person', 'steve.md'), steve, 'utf8');
    // Compute a REAL graph projection (the same one the background store would maintain) and seed it as current().
    const graph = await computeGraphProjection(vaultDir);
    state.graphProjection = { data: graph, builtAt: '2026-06-28T00:00:00.000Z', stale: false };
  }

  it('returns a calm WARMING status (not an error face) when the projection has not built yet', async () => {
    await invoke<CreateKbResult>('kb:create', { path: vaultDir, name: 'Graph KB', initGitIfNeeded: true });
    state.graphProjection = null; // store.current() === null → still warming
    const res = await invoke<{ status: string; data: unknown }>('kb:exploreProjection', 'Ada Lovelace');
    expect(res.status).toBe('warming');
    expect(res.data).toBeNull();
  });

  it('serves the full Explore read (neighborhood + entities) from the maintained projection, no live walk', async () => {
    await seedAndProject();
    const res = await invoke<{
      status: string;
      builtAt: string;
      stale: boolean;
      data: { neighborhood: { found: boolean; center?: { name: string }; neighbors: { name: string }[] }; entities: { name: string }[] };
    }>('kb:exploreProjection', 'Ada Lovelace');
    expect(res.status).toBe('ready');
    expect(res.builtAt).toBe('2026-06-28T00:00:00.000Z');
    expect(res.stale).toBe(false);
    expect(res.data.neighborhood.found).toBe(true);
    expect(res.data.neighborhood.center?.name).toBe('Ada Lovelace');
    expect(res.data.neighborhood.neighbors.map((n) => n.name)).toContain('Steve'); // precomputed backlink resolved
    expect(res.data.entities.map((e) => e.name).sort()).toEqual(['Ada Lovelace', 'Steve']);
  });

  it('the migrated kb:exploreNeighborhood reads the projection when built (same result as the live walk)', async () => {
    await seedAndProject();
    const nb = await invoke<{ found: boolean; center?: { name: string }; neighbors: { name: string }[] }>('kb:exploreNeighborhood', 'Ada Lovelace');
    expect(nb.found).toBe(true);
    expect(nb.center?.name).toBe('Ada Lovelace');
    expect(nb.neighbors.map((n) => n.name)).toContain('Steve');
  });
});

// SPEC-0058 Today — the MAINTAINED home projection at the IPC: kb:getTodayProjection serves
// {status, data, builtAt, stale} from the in-memory snapshot (no live scan), mirroring exploreProjection.
// The composite's COMPOSITION (assembleTodayProjection over the maintained reads) is proven in
// todayProjection.test.ts; here we prove the IPC envelope + the warming/ready status discipline.
describe('SPEC-0058 Today — kb:getTodayProjection over the maintained store (REAL handler)', () => {
  it('returns a calm WARMING status (not an error face) when the projection has not built yet', async () => {
    state.todayProjection = null; // store.current() === null → still warming
    const res = await invoke<{ status: string; data: unknown; builtAt: string | null; stale: boolean }>('kb:getTodayProjection');
    expect(res.status).toBe('warming');
    expect(res.data).toBeNull();
    expect(res.builtAt).toBeNull();
  });

  it('serves the full Today projection from the maintained snapshot when built, carrying the freshness envelope', async () => {
    const data: TodayProjection = {
      greeting: { salutation: 'Good evening' },
      subtitle: 'Your library is quiet and current — nothing moved while you were away.',
      line: { meta: 'nothing in flight · nothing composed yet', stations: [] },
      stats: [],
      activity: [],
      decisions: [],
      health: [],
    };
    state.todayProjection = { data, builtAt: '2026-06-28T00:00:00.000Z', stale: true };
    const res = await invoke<{ status: string; data: typeof data; builtAt: string; stale: boolean }>('kb:getTodayProjection');
    expect(res.status).toBe('ready');
    expect(res.builtAt).toBe('2026-06-28T00:00:00.000Z');
    expect(res.stale).toBe(true); // the envelope is preserved → the view can show "updating…"
    expect(res.data.greeting.salutation).toBe('Good evening');
    expect(res.data.subtitle).toContain('quiet and current');
  });
});
