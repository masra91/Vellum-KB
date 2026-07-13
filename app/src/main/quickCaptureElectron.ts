// Electron-backed QuickCaptureDeps (SPEC-0038) — the thin platform glue the QuickCaptureAgent drives
// (the behavior + invariants live in quickCaptureAgent.ts, unit-tested). Owns: global hotkey
// registration (conflict = register returns false → agent degrades, QCAP-9), the always-present
// menubar/tray entry (QCAP-3), the frameless capture sheet window (loads the shared renderer at the
// `#qcap` route, QCAP-4 headless), and focus-restore to the prior app on dismiss (QCAP-2, macOS app.hide).
import { app, globalShortcut, Tray, Menu, BrowserWindow, screen, systemPreferences, clipboard, shell } from 'electron';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { QuickCaptureDeps, SelectionRead } from './quickCaptureAgent';
import { trayStatusModel } from './trayStatusModel';
import { buildTrayTemplate } from './trayMenu';
import { buildTrayImage } from './trayIcon';
import type { PipelineStatusView } from '../kb/pipelineStatusView';

const execFileP = promisify(execFile);

/** macOS Privacy panes (SPEC-0034 / QCAP-9 steer-to-Settings) — exact anchor with a general fallback. */
const ACCESSIBILITY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy';

/** Is this process a trusted macOS Accessibility client right now? (false off-darwin / when not granted.) */
function accessibilityGranted(): boolean {
  return process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false);
}

/**
 * Read the focused app's current text selection on macOS (SPEC-0038 QCAP-7/9, Slice 2). The honest
 * mechanism with NO native module (per E1 — a native addon also broke the mac package build before):
 * gate on the Accessibility grant, then post a synthetic ⌘C through System Events (which the grant
 * unlocks) and read the pasteboard — saving + restoring the user's clipboard so the read is
 * non-destructive. Bounded by a short timeout so a stuck `osascript` can't stall the summon
 * (preserves the QCAP-2 fast-out feel). Any failure → degrade to `denied`/`unsupported` (clipboard-only).
 */
async function readFocusedSelection(): Promise<SelectionRead> {
  if (process.platform !== 'darwin') return { status: 'unsupported', text: null };
  // Probe WITHOUT prompting — a system prompt on every summon would be hostile. The explicit request
  // lives on the tray's "Enable selection capture…" item + the sheet's steer-to-Settings affordance.
  if (!systemPreferences.isTrustedAccessibilityClient(false)) return { status: 'denied', text: null };

  const saved = clipboard.readText(); // restore this afterward — selection-read must not eat the clipboard
  try {
    await execFileP('osascript', ['-e', 'tell application "System Events" to keystroke "c" using {command down}'], {
      timeout: 1200,
    });
    await delay(120); // give the frontmost app a beat to place the copy on the pasteboard
    const text = clipboard.readText();
    clipboard.writeText(saved); // restore the user's clipboard (best-effort, non-destructive)
    // Unchanged pasteboard = no live selection (or the app ignored ⌘C) → null, sheet falls to clipboard.
    if (!text || text === saved) return { status: 'granted', text: null };
    return { status: 'granted', text };
  } catch {
    clipboard.writeText(saved); // restore even if the keystroke post / read failed
    return { status: 'denied', text: null }; // couldn't post the copy → treat as not-granted, degrade
  }
}

/** DESIGN-QCAP §2: command-bar proportions — a narrow sheet that reads as a summoned tool. */
const SHEET_WIDTH = 520;
const SHEET_HEIGHT = 200;

/** DESIGN-QCAP §2/§10: anchor the sheet in the upper third of the focused display (command-bar
 *  convention) — never centered like a blocking modal. Chosen for hotkey-summon consistency. */
function anchorUpperThird(win: BrowserWindow): void {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    const x = Math.round(wa.x + (wa.width - SHEET_WIDTH) / 2);
    const y = Math.round(wa.y + wa.height / 3 - SHEET_HEIGHT / 2);
    win.setPosition(x, y);
  } catch {
    win.center(); // fall back to centered if display geometry is unavailable
  }
}

export interface ElectronQcapHooks {
  /** Open the sheet (wired to the agent; used by the tray menu item). */
  onOpen: () => void;
  /** Dismiss + restore focus (wired to the agent; used by sheet blur — click-away dismiss). */
  onClose: () => void;
  /** QCAP-11: restore/focus (create-if-none) the main window — the menubar "Show Vellum" item. */
  onShowMainWindow?: () => void;
  /** QCAP-14: read the OBS pipeline-status view-model for the read-only tray live-status readout.
   *  Optional — omitted in tests/headless → the readout section is simply absent. Best-effort: a
   *  rejection/null degrades to no readout, never a dead tray. */
  getPipelineStatus?: () => Promise<PipelineStatusView | null>;
  /** Optional appended tray items (DEV-2's QUIESCE-6 "Prepare for shutdown / Resume" fast-follow) —
   *  the agreed insertion hook; they slot between the capture actions and Quit. */
  getExtraTrayItems?: () => Electron.MenuItemConstructorOptions[];
  log?: (event: string, data?: Record<string, unknown>) => void;
}

function createSheetWindow(onBlur: () => void): BrowserWindow {
  const win = new BrowserWindow({
    width: SHEET_WIDTH,
    height: SHEET_HEIGHT,
    frame: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  // Load the shared renderer at the #qcap route (no separate Vite entry — same preload/kbApi).
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void win.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#qcap`);
  } else {
    void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), { hash: 'qcap' });
  }
  // Frictionless: clicking away dismisses (Spotlight-like). Guarded so app.hide()'s blur can't loop.
  win.on('blur', () => {
    if (!win.isDestroyed()) onBlur();
  });
  return win;
}

export function electronQuickCaptureDeps(hooks: ElectronQcapHooks): QuickCaptureDeps {
  let sheet: BrowserWindow | null = null;
  let tray: Tray | null = null;
  // QCAP-14: cache the last tray state so a status-only refresh (mouse-enter) can rebuild the full
  // menu, and the last computed status lines for resilience.
  let lastTrayState: { hotkeyAccelerator: string | null } = { hotkeyAccelerator: null };
  let lastStatusLines: string[] = [];

  /** The capture ACTION items (DEV-1, QCAP-3/9/11) — Quick Capture · Hotkey-unavailable · Enable-
   *  selection · Show Vellum — verbatim + in order, composed into the menu's actions section. */
  function buildActionItems(state: { hotkeyAccelerator: string | null }): Electron.MenuItemConstructorOptions[] {
    const accel = state.hotkeyAccelerator;
    // QCAP-9 (Slice 2): when selection-capture isn't yet granted, offer an explicit enable path from
    // the always-present menubar (never a silent dead feature) — the native prompt + a steer to the
    // Settings·Privacy·Accessibility pane. Hidden once granted. Off-darwin the item never appears.
    const needsAccessibility = process.platform === 'darwin' && !accessibilityGranted();
    return [
      {
        label: accel ? `Quick Capture  (${accel})` : 'Quick Capture',
        ...(accel ? { accelerator: accel } : {}),
        click: () => hooks.onOpen(),
      },
      ...(accel
        ? []
        : [{ label: 'Hotkey unavailable — use this menu', enabled: false } as Electron.MenuItemConstructorOptions]),
      ...(needsAccessibility
        ? [
            { type: 'separator' as const },
            {
              label: 'Enable selection capture…',
              click: () => {
                // Trigger the native Accessibility prompt, then steer to the pane (flaky anchor → fallback).
                systemPreferences.isTrustedAccessibilityClient(true);
                void shell.openExternal(ACCESSIBILITY_PANE).catch(() => {
                  void shell.openExternal(PRIVACY_PANE);
                });
              },
            } as Electron.MenuItemConstructorOptions,
          ]
        : []),
      // QCAP-11: restore the main window from the menubar so the LSUIElement accessory is never a
      // one-way trap. Plain instrument-voice label (design §4) — no icon/badge. onShowMainWindow
      // creates the window if none exists; omitted in tests/headless → the item is simply absent.
      ...(hooks.onShowMainWindow
        ? [{ label: 'Show Vellum', click: () => hooks.onShowMainWindow?.() } as Electron.MenuItemConstructorOptions]
        : []),
    ];
  }

  /** QCAP-14: rebuild + set the tray context menu — read-only status readout (live OBS view-model) on
   *  top, then the capture actions, the optional QUIESCE-6 hook items, then Quit. Best-effort: a status
   *  fetch failure degrades to no readout, never a dead tray. */
  async function rebuildTrayMenu(): Promise<void> {
    if (!tray) return;
    try {
      const view = hooks.getPipelineStatus ? await hooks.getPipelineStatus() : null;
      lastStatusLines = trayStatusModel(view);
    } catch {
      lastStatusLines = []; // a status read must never break the always-present tray
    }
    if (!tray) return; // teardown could race the await
    tray.setContextMenu(
      Menu.buildFromTemplate(
        buildTrayTemplate({
          statusLines: lastStatusLines,
          actionItems: buildActionItems(lastTrayState),
          extraItems: hooks.getExtraTrayItems?.(),
        }),
      ),
    );
  }

  return {
    registerHotkey(accelerator, onTrigger) {
      try {
        // globalShortcut.register returns false when the OS/another app already owns the accelerator.
        return globalShortcut.register(accelerator, onTrigger);
      } catch {
        return false; // an invalid/unsupported accelerator → treated as unavailable (QCAP-9 degrade)
      }
    },
    unregisterHotkey(accelerator) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {
        /* best-effort */
      }
    },
    showSheet() {
      // #512 PERF-R7: keep the window ALIVE across summons (hideSheet hides, never destroys) — a
      // fresh BrowserWindow + full page load on every hotkey press was the dominant cost standing
      // between a summon and the <~150ms warm-focus target, independent of how small the bundle is.
      // Only the FIRST-ever summon needs a real load; every summon after that just re-shows the
      // already-warm window and tells its still-mounted sheet to reset itself (clipboard re-read,
      // empty field) — see `kb:qcap-resummoned` (kb/types.ts) for the reset signal.
      if (!sheet || sheet.isDestroyed()) {
        sheet = createSheetWindow(hooks.onClose);
        const w = sheet;
        w.once('ready-to-show', () => {
          if (!w.isDestroyed()) {
            anchorUpperThird(w);
            w.show();
            w.focus();
          }
        });
        return;
      }
      sheet.webContents.send('kb:qcap-resummoned');
      anchorUpperThird(sheet);
      sheet.show();
      sheet.focus();
    },
    hideSheet() {
      if (sheet && !sheet.isDestroyed()) sheet.hide(); // keep-alive: hidden, not torn down
    },
    restoreFocus() {
      // macOS: hiding the app returns key focus to the previously-active app (QCAP-2). Elsewhere the
      // window destroy already yields focus.
      if (process.platform === 'darwin') {
        try {
          app.hide();
        } catch {
          /* best-effort */
        }
      }
    },
    // Slice 2 (QCAP-7/9): the agent calls this on summon, before the sheet steals focus. Never throws
    // the summon dead — readFocusedSelection degrades to denied/unsupported on any failure.
    readSelection() {
      return readFocusedSelection();
    },
    setTray(state) {
      if (!tray) {
        // #401: the Vellum mono glyph as a macOS template image (recolors with the menu bar). Replaces
        // the prior empty-image + "⤓" title placeholder. The tray is the always-present entry (QCAP-3).
        tray = new Tray(buildTrayImage());
        tray.setToolTip('Vellum — Quick Capture');
        // QCAP-14: refresh the live status just before the menu opens — macOS fires mouse-enter ahead
        // of the click that shows the context menu, so the readout is fresh without a background poll.
        tray.on('mouse-enter', () => void rebuildTrayMenu());
      }
      lastTrayState = state;
      void rebuildTrayMenu();
    },
    log: hooks.log,
  };
}
