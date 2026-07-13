// SPEC-0058 STATE-8 (#510) — the main→renderer projection PUSH bridge, factored out of `main.ts` so it's
// unit-testable without a real Electron `BrowserWindow` (`main.ts` itself calls Electron APIs at module
// load and isn't safely importable in a test). `pipeline.ts`'s `ProjectionPushEvent` is the payload shape;
// this module only knows how to deliver one to a window, not what triggered it.

/** The minimal `BrowserWindow` surface this bridge needs — a structural subset so a test double doesn't
 *  need a real Electron window. */
export interface BroadcastWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

/**
 * Build the push sink `main.ts` registers via `setProjectionPushSink`. `getWindow` is called fresh on
 * EVERY event (not captured once) so it always sees the live `mainWindow` — created after this bridge is
 * built, or replaced across a close/reopen (QCAP-11) — without the caller needing to re-register.
 * Guards a null/destroyed window the same way `showMainWindow()` does; a dropped push is never load-
 * bearing (STATE-8 push is a nudge, not the render path's data source — see `pipeline.ts`'s doc comment).
 */
export function createProjectionBroadcaster(getWindow: () => BroadcastWindow | null): (event: { store: string; builtAt: string }) => void {
  return (event) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('kb:projection-changed', event);
    }
  };
}
