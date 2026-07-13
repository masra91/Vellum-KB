import { app, BrowserWindow, crashReporter } from 'electron';
import path from 'node:path';
import v8 from 'node:v8';
import started from 'electron-squirrel-startup';
import { registerIpc, initPipeline, stopRecallClient } from './main/ipc';
import {
  stopPipelineForQuit,
  getActiveInstanceSettings,
  activeSnapshotDir,
  pipelineStatusForActive,
  quiesceActive,
  resumeActive,
  isActiveQuiescing,
  setProjectionPushSink,
} from './main/pipeline';
import { createProjectionBroadcaster } from './main/projectionBroadcast';
import { quiesceTrayItems } from './main/quiesceTray';
import { startTelemetry, stopTelemetry } from './main/telemetry';
import { ensurePath } from './main/resolvePath';
import { createAppDevLog } from './kb/devlog';
import { QuickCaptureAgent } from './main/quickCaptureAgent';
import { electronQuickCaptureDeps } from './main/quickCaptureElectron';
import { setQuickCaptureAgent } from './main/quickCaptureService';
import { shouldQuitOnWindowAllClosed } from './main/lifecycle';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// The main process is the long-lived manager (SPEC-0010 STACK-2). For now it owns the
// IPC surface and a single window; the headless scheduler/agents grow from here.
// Tracked so QCAP-11 can restore the SAME window from the menubar instead of spawning a duplicate.
let mainWindow: BrowserWindow | null = null;
const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 660,
    // VUX-CLIP #522 §4: the floor below which the 13.25rem rail + a comfortable reading column can no
    // longer coexist. Rail auto-collapse below this is a scoped-out follow-up (issue's own C12 note).
    minWidth: 760,
    minHeight: 560,
    // #519 §4 — ONE chrome band: without this, macOS draws its own native title bar directly above the
    // themed `.bar` (index.css), reading as two stacked toolbars. `trafficLightPosition` centers the
    // lights in the 3.1rem (49.6px @ 16px root — no root font-size override in index.css) `.bar`: y =
    // (49.6 − 12px light diameter) / 2 ≈ 19; x = 14 matches `.bar`'s own `padding: 0 0.9rem` left inset.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 19 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  mainWindow.on('closed', () => {
    mainWindow = null; // so QCAP-11's restore re-creates rather than touching a destroyed window
  });
};

// SPEC-0038 QCAP-11: restore + focus the main window from the menubar — CREATING it if none exists —
// so the `LSUIElement` accessory (QCAP-4/8) is never a one-way trap: a user who closed/hid the main
// window can always get back to it. On macOS the agent may have hidden the whole app (QCAP-2 focus-
// restore), so unhide first, then surface the window front-most.
function showMainWindow(): void {
  if (process.platform === 'darwin') {
    try {
      app.show(); // undo a prior app.hide() (QCAP-2) so the window can come forward
    } catch {
      /* best-effort */
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow(); // none open → bring one up
  }
}

// SPEC-0038 QCAP: the menubar agent owns the global hotkey + capture sheet, headlessly (QCAP-4) — it
// starts even before/without a main window. The hotkey applies the shipped default immediately; the
// per-Instance configured accelerator (QCAP-6) is applied once the pipeline resolves.
let qcapAgent: QuickCaptureAgent | null = null;
function startQuickCapture(): void {
  const deps = electronQuickCaptureDeps({
    onOpen: () => qcapAgent?.open(),
    onClose: () => qcapAgent?.close(),
    onShowMainWindow: () => showMainWindow(), // QCAP-11: tray "Show Vellum" restore
    getPipelineStatus: () => pipelineStatusForActive(), // QCAP-14: read-only tray live-status readout
    // QUIESCE-6: the optional "Prepare for shutdown / Resume" tray item — re-evaluated on each menu open,
    // so it reflects the current quiesce state. Runs in main, so it calls the controller directly.
    getExtraTrayItems: () => quiesceTrayItems(isActiveQuiescing(), { onPrepare: () => void quiesceActive(), onResume: () => void resumeActive() }),
  });
  qcapAgent = new QuickCaptureAgent(deps); // shipped default ⌥Space; conflict-aware + degrades (QCAP-9)
  setQuickCaptureAgent(qcapAgent);
  qcapAgent.start();
}

// SPEC-0058 STATE-8 (#510): broadcast a maintained-projection change to the renderer, so a visible view
// re-reads instantly instead of waiting on its poll interval. `() => mainWindow` reads the LIVE variable
// at call time (not a snapshot) — registered once, before any store can possibly push, so wiring order
// vs. `createWindow()`/`initPipeline()` doesn't matter, and it keeps working across a close/reopen
// (QCAP-11 reassigns `mainWindow`). The bridge itself (`createProjectionBroadcaster`) is factored out so
// it's unit-testable without a real Electron window — see `main/projectionBroadcast.test.ts`.
const broadcastProjectionChanged = createProjectionBroadcaster(() => mainWindow);

app.on('ready', async () => {
  // GUI launches (Finder/Dock/launchd) inherit a stripped PATH; recover the user's real
  // login-shell PATH first so spawned CLIs (Copilot, git) resolve like they do in a
  // terminal — otherwise detection + enrich silently fail in the packaged app (STACK-9).
  try {
    await ensurePath();
  } catch {
    // Best-effort: a PATH-resolution failure must never block startup.
  }
  setProjectionPushSink(broadcastProjectionChanged);
  registerIpc();
  // QCAP-3/4: bring up the menubar agent + global hotkey first, so quick capture is available even
  // headless (and even before a KB resumes — capture then reports "no active KB" honestly).
  startQuickCapture();
  // OBS-2/4: resume a previously-configured KB on launch. The app-level dev-log (userData) captures
  // a boot failure (e.g. worktree provision) that this fire-and-forget would otherwise swallow —
  // the silent-stall cause that motivated SPEC-0030.
  const appLog = createAppDevLog(app.getPath('userData'));
  // SPEC-0030 OBS-18/20/21: install crash capture (local minidumps, no upload; uncaught/rejection +
  // render/child/gpu-process-gone → breadcrumb) and start the memory sampler + leak watchdog. The
  // electron-free telemetry glue gets the Electron bits passed in (so pipeline.ts stays node-testable).
  startTelemetry({
    appLog,
    userDataDir: app.getPath('userData'),
    proc: process,
    appEvents: app,
    crashReporter,
    getAppMetrics: () => app.getAppMetrics(),
    writeHeapSnapshot: (file) => v8.writeHeapSnapshot(file),
    getSnapshotDir: activeSnapshotDir,
  });
  void initPipeline()
    .then(async () => {
      // QCAP-6: apply the per-Instance configured hotkey once the active KB has loaded (conflict-aware).
      try {
        const s = await getActiveInstanceSettings();
        if (qcapAgent && s.quickCaptureAccelerator) qcapAgent.setAccelerator(s.quickCaptureAccelerator);
      } catch (err) {
        appLog.error('boot.qcap-accel-failed', { err });
      }
    })
    .catch((err) => appLog.error('boot.init-pipeline-failed', { err }));
  createWindow();
});

// Release the global hotkey on quit (Electron best practice — a left-registered accelerator lingers).
// #514: also release the process-wide RecallClient's `copilot` CLI server (its own `client.stop()` had
// no production caller before this — every Ask leaked a server process for the app's lifetime).
app.on('will-quit', () => {
  qcapAgent?.stop();
  void stopRecallClient().catch(() => {}); // best-effort — quitting must never hang on this
});

// #515 BUG-2: `before-quit` is the ONE event that fires on every quit path — including Cmd-Q / Dock
// "Quit" on macOS, where `window-all-closed` never fires (the app stays alive with no window, QCAP-8
// below) — so it's the only place a quit can reliably be held open long enough to stop the pipeline and
// flush a pending promote before the process (and its git children) are killed. Previously only
// `window-all-closed` called `stopPipeline()`, which meant a macOS quit killed an in-flight
// advance/cherry-pick mid-write with no cleanup at all.
let quitInProgress = false;
app.on('before-quit', (event) => {
  if (quitInProgress) return; // this is our own re-quit below — let it proceed to actually exit
  quitInProgress = true;
  event.preventDefault();
  void (async () => {
    try {
      await stopPipelineForQuit(); // bounded best-effort flush (STAGING-12 — staging is durable either way)
    } finally {
      stopTelemetry(); // stop the memory sampler's interval on shutdown (OBS-20)
      app.quit();
    }
  })();
});

// QCAP-8 dual-model (also CAPTURE-12 / ORCH-1): on macOS the app stays alive with no window open — a
// persistent Dock + menubar/tray agent, the orchestrator draining the queue headlessly + the global
// hotkey live; the tray "Show Vellum" (QCAP-11) / hotkey / Dock-icon reopen the window. Other
// platforms quit as usual. Policy is the pure, unit-tested `shouldQuitOnWindowAllClosed`. The actual
// pipeline stop + flush happens in `before-quit` above, which `app.quit()` always triggers first.
app.on('window-all-closed', () => {
  if (shouldQuitOnWindowAllClosed(process.platform)) {
    app.quit();
  }
});

app.on('activate', () => {
  showMainWindow(); // restore/focus the tracked main window (or create one) — never a stray duplicate
});
