// @vitest-environment happy-dom
//
// macOS folder-permission UX — "Asking for the keys" (SPEC-0034 MACOS-7; specs/design/macos-permission.md).
// Component tier (TEST-5): the IPC is mocked (`window.kbApi.probeVaultAccess`/`openSystemSettingsPrivacy`);
// we assert the pre-prompt + brass blocked recovery render + the probe → granted/blocked/retry state
// machine, plus the no-dev-jargon + XSS-safe + brass-not-oxide guarantees.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prePromptHtml, blockedHtml, icloudNoteHtml, mountPermissionGate } from './permissionGate';
import type { KbApi } from '../kb/types';

const FOLDER = '/Users/me/Documents/MyVault';

function setApi(over: Partial<Pick<KbApi, 'probeVaultAccess' | 'openSystemSettingsPrivacy'>> = {}): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    probeVaultAccess: vi.fn().mockResolvedValue({ ok: true, denied: false, message: 'ok' }),
    openSystemSettingsPrivacy: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
}

describe('permissionGate render helpers (MACOS-7)', () => {
  it('prePromptHtml names the exact folder (mono) + steers to Allow, with the ⌖ glyph', () => {
    const h = prePromptHtml(FOLDER);
    expect(h).toContain('⌖');
    expect(h).toContain('needs access to your library folder'); // VUX-RETIRE #523 §4: vault → library
    expect(h).toContain(FOLDER);
    expect(h).toContain('perm-path'); // the path is tabular-mono
    expect(h).toContain('choose <strong>Allow</strong>');
    expect(h).toContain('id="perm-continue"');
  });

  it('blockedHtml is brass + actionable (Settings path + Open System Settings + Retry) — never oxide', () => {
    const h = blockedHtml(FOLDER);
    expect(h).toContain('⚠');
    expect(h).toContain('perm-glyph-blocked'); // gold-deep glyph (CSS), not the oxide alarm
    expect(h).not.toContain('viz-state-error'); // never the oxide/broken hue — it's gold-deep (waiting on you)
    expect(h).toContain('can’t reach your library folder'); // VUX-RETIRE #523 §4: vault → library
    expect(h).toContain(FOLDER);
    expect(h).toContain('Privacy &amp; Security → Files and Folders');
    expect(h).toContain('id="perm-open-settings"');
    expect(h).toContain('id="perm-retry"');
  });

  it('blockedHtml disables the buttons single-flight + shows a transient note', () => {
    const h = blockedHtml(FOLDER, { acting: true, note: 'Opened System Settings — enable Vellum, then Retry.' });
    expect(h).toContain('disabled');
    expect(h).toContain('Opened System Settings');
  });

  it('icloudNoteHtml is a quiet, non-blocking ☁ note (detect-warn only)', () => {
    const h = icloudNoteHtml();
    expect(h).toContain('☁');
    expect(h).toContain('iCloud Drive');
    expect(h).toContain('perm-icloud'); // muted, not an alarm
  });

  it('escapes interpolated folder paths (XSS-safe)', () => {
    const evil = '/x/<img src=x onerror=alert(1)>';
    expect(prePromptHtml(evil)).not.toContain('<img src=x');
    expect(prePromptHtml(evil)).toContain('&lt;img');
    expect(blockedHtml(evil)).not.toContain('<img src=x');
  });
});

describe('mountPermissionGate state machine (MACOS-7 flows 1/3/5)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  it('flow 1: pre-prompt → Continue probes → grant calls onGranted (proceeds silently)', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, denied: false, message: 'ok' });
    setApi({ probeVaultAccess: probe });
    const onGranted = vi.fn();
    mountPermissionGate(root, { vaultPath: FOLDER, folder: FOLDER, onGranted });

    expect(root.querySelector('#perm-continue')).not.toBeNull(); // starts at pre-prompt
    root.querySelector<HTMLButtonElement>('#perm-continue')!.click();
    await Promise.resolve(); await Promise.resolve();

    expect(probe).toHaveBeenCalledWith(FOLDER);
    expect(onGranted).toHaveBeenCalledOnce();
  });

  it('flow 3: a denied probe drops to the Blocked recovery (no onGranted, no raw OS text)', async () => {
    const probe = vi.fn().mockResolvedValue({ ok: false, denied: true, message: 'Operation not permitted' });
    setApi({ probeVaultAccess: probe });
    const onGranted = vi.fn();
    mountPermissionGate(root, { vaultPath: FOLDER, folder: FOLDER, onGranted });

    root.querySelector<HTMLButtonElement>('#perm-continue')!.click();
    await Promise.resolve(); await Promise.resolve();

    expect(onGranted).not.toHaveBeenCalled();
    expect(root.querySelector('#perm-retry')).not.toBeNull(); // now on Blocked
    expect(root.querySelector('.perm-blocked')).not.toBeNull();
    expect(root.textContent).not.toContain('Operation not permitted'); // raw OS text never shown
  });

  it('flow 5: Retry while still denied returns to Blocked; grant-then-Retry proceeds (loop closed)', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, denied: true, message: 'denied' }) // Continue → blocked
      .mockResolvedValueOnce({ ok: false, denied: true, message: 'denied' }) // Retry while denied → blocked
      .mockResolvedValueOnce({ ok: true, denied: false, message: 'ok' }); // Retry after granting → proceed
    setApi({ probeVaultAccess: probe });
    const onGranted = vi.fn();
    mountPermissionGate(root, { vaultPath: FOLDER, folder: FOLDER, onGranted });

    root.querySelector<HTMLButtonElement>('#perm-continue')!.click();
    await Promise.resolve(); await Promise.resolve();
    root.querySelector<HTMLButtonElement>('#perm-retry')!.click(); // still denied
    await Promise.resolve(); await Promise.resolve();
    expect(onGranted).not.toHaveBeenCalled();
    expect(root.querySelector('#perm-retry')).not.toBeNull(); // loop stays closed — no relaunch

    root.querySelector<HTMLButtonElement>('#perm-retry')!.click(); // granted now
    await Promise.resolve(); await Promise.resolve();
    expect(onGranted).toHaveBeenCalledOnce();
  });

  it('Open System Settings calls the deep-link IPC; start:blocked enters directly (runtime re-entry)', async () => {
    const openSettings = vi.fn().mockResolvedValue({ ok: true });
    setApi({ openSystemSettingsPrivacy: openSettings });
    mountPermissionGate(root, { vaultPath: FOLDER, folder: FOLDER, start: 'blocked', onGranted: vi.fn() });

    expect(root.querySelector('.perm-blocked')).not.toBeNull(); // entered at Blocked
    expect(root.querySelector('#perm-continue')).toBeNull();
    root.querySelector<HTMLButtonElement>('#perm-open-settings')!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(root.textContent).toContain('Files and Folders'); // guidance note after opening
  });

  it('shows the non-blocking iCloud note when the vault is under iCloud Drive', () => {
    setApi();
    mountPermissionGate(root, { vaultPath: FOLDER, folder: FOLDER, isICloud: true, onGranted: vi.fn() });
    expect(root.querySelector('.perm-icloud')).not.toBeNull();
  });
});
