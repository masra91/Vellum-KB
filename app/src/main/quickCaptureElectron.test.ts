// #512 PERF-R7: the qcap capture sheet used to DESTROY its BrowserWindow on every dismiss and
// re-create + reload the full bundle on every summon — the dominant cost standing between a hotkey
// press and the sheet actually being usable, independent of how small the bundle itself is. The fix
// keeps the window alive (hidden, not destroyed) and re-shows the already-warm instance on a repeat
// summon, telling its still-mounted renderer to reset itself via a push instead of a reload.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above the module body, so the fake class must be built inside
// vi.hoisted too (a plain `class FakeBrowserWindow {}` declared below the mock would be a TDZ error).
const state = vi.hoisted(() => {
  class FakeBrowserWindow {
    shown = false;
    destroyed = false;
    loadedCount = 0;
    sentChannels: string[] = [];
    listeners: Record<string, Array<() => void>> = {};
    webContents = { send: (channel: string) => this.sentChannels.push(channel) };

    constructor(_opts: unknown) {
      windows.push(this);
    }
    loadURL(): void {
      this.loadedCount += 1;
    }
    loadFile(): void {
      this.loadedCount += 1;
    }
    on(evt: string, cb: () => void): void {
      (this.listeners[evt] ??= []).push(cb);
    }
    once(evt: string, cb: () => void): void {
      (this.listeners[evt] ??= []).push(cb);
      if (evt === 'ready-to-show') cb(); // fire synchronously — the fake "page has painted" signal
    }
    show(): void {
      this.shown = true;
    }
    hide(): void {
      this.shown = false;
    }
    focus(): void {}
    isVisible(): boolean {
      return this.shown;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.shown = false;
    }
    setPosition(): void {}
    center(): void {}
  }
  const windows: InstanceType<typeof FakeBrowserWindow>[] = [];
  return { windows, FakeBrowserWindow };
});

vi.mock('electron', () => ({
  app: { hide: vi.fn() },
  BrowserWindow: state.FakeBrowserWindow,
  globalShortcut: { register: vi.fn(), unregister: vi.fn() },
  Tray: vi.fn(),
  Menu: { buildFromTemplate: vi.fn() },
  screen: {
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 1000 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  systemPreferences: { isTrustedAccessibilityClient: () => false },
  clipboard: { readText: () => '', writeText: () => {} },
  shell: { openExternal: vi.fn() },
}));

// electron-forge/plugin-vite injects these as build-time globals for the real main bundle; under
// vitest neither exists, so a bare reference throws ReferenceError rather than just being undefined.
vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', undefined);
vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');

import { electronQuickCaptureDeps } from './quickCaptureElectron';

describe('#512 qcap keep-alive window (PERF-R7)', () => {
  beforeEach(() => {
    state.windows.length = 0;
  });

  it('the FIRST summon creates and loads a real window', () => {
    const deps = electronQuickCaptureDeps({ onOpen: () => {}, onClose: () => {} });
    deps.showSheet();
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0].loadedCount).toBe(1);
    expect(state.windows[0].shown).toBe(true);
  });

  it('hideSheet HIDES the window rather than destroying it', () => {
    const deps = electronQuickCaptureDeps({ onOpen: () => {}, onClose: () => {} });
    deps.showSheet();
    const win = state.windows[0];
    deps.hideSheet();
    expect(win.isDestroyed()).toBe(false); // kept alive
    expect(win.isVisible()).toBe(false); // just hidden
  });

  it('a re-summon after hide REUSES the same window — no new BrowserWindow, no reload', () => {
    const deps = electronQuickCaptureDeps({ onOpen: () => {}, onClose: () => {} });
    deps.showSheet();
    deps.hideSheet();
    deps.showSheet(); // re-summon
    expect(state.windows).toHaveLength(1); // still the ONE window — never recreated
    expect(state.windows[0].loadedCount).toBe(1); // never reloaded
    expect(state.windows[0].shown).toBe(true);
  });

  it('a re-summon pushes the reset signal so the still-mounted sheet can reset its own state', () => {
    const deps = electronQuickCaptureDeps({ onOpen: () => {}, onClose: () => {} });
    deps.showSheet();
    deps.hideSheet();
    state.windows[0].sentChannels.length = 0; // clear the noise from the first summon (none expected, but be explicit)
    deps.showSheet();
    expect(state.windows[0].sentChannels).toContain('kb:qcap-resummoned');
  });

  it('the FIRST-ever summon does NOT get the resummon push (nothing mounted to reset yet)', () => {
    const deps = electronQuickCaptureDeps({ onOpen: () => {}, onClose: () => {} });
    deps.showSheet();
    expect(state.windows[0].sentChannels).not.toContain('kb:qcap-resummoned');
  });

  it('recreates a fresh window if the kept-alive one was destroyed out-of-band', () => {
    const deps = electronQuickCaptureDeps({ onOpen: () => {}, onClose: () => {} });
    deps.showSheet();
    state.windows[0].destroy(); // e.g. an external close, not our own hideSheet
    deps.showSheet();
    expect(state.windows).toHaveLength(2); // a genuinely new window, not reuse of a dead one
    expect(state.windows[1].loadedCount).toBe(1);
  });
});
