// SPEC-0058 STATE-8 (#510) — the main→renderer push bridge. Pure/deterministic — a fake `BroadcastWindow`
// stands in for a real Electron `BrowserWindow`, so this runs in the normal node-tier CI gate.
import { describe, it, expect, vi } from 'vitest';
import { createProjectionBroadcaster, type BroadcastWindow } from './projectionBroadcast';

function fakeWindow(destroyed = false): BroadcastWindow & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return { isDestroyed: () => destroyed, webContents: { send }, send };
}

describe('createProjectionBroadcaster (store onUpdate → send bridge)', () => {
  it('sends kb:projection-changed with the event payload when a window exists', () => {
    const win = fakeWindow();
    const broadcast = createProjectionBroadcaster(() => win);
    broadcast({ store: 'today', builtAt: '2026-07-13T00:00:00.000Z' });
    expect(win.send).toHaveBeenCalledWith('kb:projection-changed', { store: 'today', builtAt: '2026-07-13T00:00:00.000Z' });
  });

  it('reads the window fresh on every call — a window created AFTER the broadcaster is built still receives the push', () => {
    let win: BroadcastWindow | null = null;
    const broadcast = createProjectionBroadcaster(() => win);
    broadcast({ store: 'review', builtAt: 't1' }); // no window yet → silently dropped, never throws
    const created = fakeWindow();
    win = created;
    broadcast({ store: 'review', builtAt: 't2' });
    expect(created.send).toHaveBeenCalledTimes(1);
    expect(created.send).toHaveBeenCalledWith('kb:projection-changed', { store: 'review', builtAt: 't2' });
  });

  it('drops the push silently when the window is destroyed (never load-bearing)', () => {
    const win = fakeWindow(true);
    const broadcast = createProjectionBroadcaster(() => win);
    expect(() => broadcast({ store: 'graph', builtAt: 't' })).not.toThrow();
    expect(win.send).not.toHaveBeenCalled();
  });

  it('drops the push silently when there is no window at all', () => {
    const broadcast = createProjectionBroadcaster(() => null);
    expect(() => broadcast({ store: 'status', builtAt: 't' })).not.toThrow();
  });
});
