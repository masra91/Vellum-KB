// macOS folder-permission UX — "Asking for the keys" (SPEC-0034 MACOS-7; specs/design/macos-permission.md).
// macOS's TCC grant dialog is system-owned + non-restylable; this module owns the two moments we DO
// control, in the app's own instrument language (the shared `_design-system` / "The Line"):
//   (1) PRE-PROMPT — explain *why* + *which exact folder* before the OS asks; Continue performs a
//       deliberate probe write so the system dialog fires coupled to the explanation (MACOS-5), not
//       later, decoupled, mid-pipeline.
//   (2) BLOCKED — a **brass** (waiting-on-YOU, not oxide/broken), actionable denied-state recovery: the
//       exact Settings path + Open System Settings (deep-link with graceful fallback) + Retry. Never a
//       dead end; Retry-while-denied returns to Blocked (loop closed, no relaunch). It is the GENERAL
//       recovery for ANY write-time denial — first-run deny, revoked-later, or a never-granted run (#56).
//   plus a quiet, NON-blocking iCloud detect-warn note (v1 detect+warn only).
// Pure render helpers (data → esc-safe HTML string) test without a DOM; the controller wires the IPC
// (probeVaultAccess — a benign write that triggers TCC; openSystemSettingsPrivacy — the deep-link).
import { esc } from './html';

/** PRE-PROMPT (MACOS-7 flow 1) — why + the exact folder (mono); Continue triggers the OS TCC dialog. */
export function prePromptHtml(folder: string): string {
  return `<div class="perm-panel perm-preprompt">
    <div class="perm-head"><span class="perm-glyph" aria-hidden="true">⌖</span><h1 class="perm-title">Vellum needs access to your library folder</h1></div>
    <p class="perm-body">To read and write your notes in <span class="perm-path">${esc(folder)}</span>, macOS will ask next — choose <strong>Allow</strong>.</p>
    <div class="perm-actions"><button type="button" id="perm-continue" class="v3-btn v3-btn--primary">Continue</button></div>
  </div>`;
}

/** BLOCKED (MACOS-7 flows 3/4/5) — the brass, actionable denied recovery. Names the folder, states the
 *  consequence plainly (ink), gives the exact Settings path + Open System Settings + Retry. `acting`
 *  disables the buttons single-flight; `note` shows a transient outcome line (ink, never raw OS text). */
export function blockedHtml(folder: string, opts: { acting?: boolean; note?: string } = {}): string {
  const dis = opts.acting ? ' disabled' : '';
  const note = opts.note ? `<p class="perm-note">${esc(opts.note)}</p>` : '';
  return `<div class="perm-panel perm-blocked" role="alert">
    <div class="perm-head"><span class="perm-glyph perm-glyph-blocked" aria-hidden="true">⚠</span><h1 class="perm-title">Vellum can’t reach your library folder</h1></div>
    <p class="perm-body">Access to <span class="perm-path">${esc(folder)}</span> is turned off, so your notes can’t be read or written until you allow it.</p>
    <p class="perm-steps">To fix: <strong>System Settings → Privacy &amp; Security → Files and Folders</strong> → enable <strong>Vellum</strong>.</p>
    ${note}
    <div class="perm-actions">
      <button type="button" id="perm-open-settings" class="v3-btn v3-btn--ghost"${dis}>Open System Settings</button>
      <button type="button" id="perm-retry" class="v3-btn v3-btn--primary"${dis}>Retry</button>
    </div>
  </div>`;
}

/** iCloud detect-warn (MACOS-7 flow 6) — a quiet, NON-blocking inline note (v1: detect + warn only). */
export function icloudNoteHtml(): string {
  return `<p class="perm-icloud"><span class="perm-glyph-icloud" aria-hidden="true">☁</span> Your library is in iCloud Drive — files may sync or be offloaded; Vellum reads them on demand.</p>`;
}

export interface PermissionGateOptions {
  /** The vault path to probe (the real fs path). */
  vaultPath: string;
  /** The folder shown to the user (the resolved path). */
  folder: string;
  /** Show the non-blocking iCloud note (vault is under iCloud Drive). */
  isICloud?: boolean;
  /** Where to start: `pre-prompt` (first-run) or `blocked` (runtime re-entry — revoked/never-granted). */
  start?: 'pre-prompt' | 'blocked';
  /** Called when a probe/retry succeeds (access granted) — proceed (e.g. mount the shell / reload). */
  onGranted: () => void;
}

/**
 * Mount the permission gate (MACOS-7). Drives the pre-prompt → probe → granted/blocked state machine:
 * Continue/Retry call {@link window.kbApi.probeVaultAccess} (the benign write that triggers TCC); a
 * grant fires `onGranted`, a denial drops to Blocked; Open System Settings deep-links via
 * {@link window.kbApi.openSystemSettingsPrivacy} (with fallback). Single-flight; the loop stays closed
 * (Retry-while-denied returns to Blocked) so the user grants-then-Retry without relaunching.
 */
export function mountPermissionGate(container: HTMLElement, opts: PermissionGateOptions): void {
  let phase: 'pre' | 'blocked' = opts.start === 'blocked' ? 'blocked' : 'pre';
  let acting = false;
  let note = '';

  function render(): void {
    const inner = phase === 'pre' ? prePromptHtml(opts.folder) : blockedHtml(opts.folder, { acting, note });
    container.innerHTML = `<div class="perm-surface">${inner}${opts.isICloud ? icloudNoteHtml() : ''}</div>`;
    container.querySelector<HTMLButtonElement>('#perm-continue')?.addEventListener('click', () => void probe());
    container.querySelector<HTMLButtonElement>('#perm-retry')?.addEventListener('click', () => void probe());
    container.querySelector<HTMLButtonElement>('#perm-open-settings')?.addEventListener('click', () => void openSettings());
  }

  async function probe(): Promise<void> {
    if (acting) return;
    acting = true;
    note = '';
    if (phase === 'blocked') render(); // reflect the disabled state immediately
    try {
      const res = await window.kbApi.probeVaultAccess(opts.vaultPath);
      if (res.ok) {
        acting = false;
        opts.onGranted();
        return;
      }
      // Denied (or otherwise unreachable) → the Blocked recovery. Keep the note friendly (never raw OS
      // text — no dev jargon); a denial needs no note (the panel already explains it).
      phase = 'blocked';
      note = res.denied ? '' : 'Couldn’t reach the folder — check it still exists, then Retry.';
    } catch {
      phase = 'blocked';
      note = 'Couldn’t reach the folder — check it still exists, then Retry.';
    }
    acting = false;
    render();
  }

  async function openSettings(): Promise<void> {
    if (acting) return;
    acting = true;
    render();
    try {
      const res = await window.kbApi.openSystemSettingsPrivacy();
      note = res.ok
        ? res.usedFallback
          ? 'Opened Privacy & Security — find Files and Folders, enable Vellum, then Retry.'
          : 'Opened System Settings — enable Vellum under Files and Folders, then Retry.'
        : 'Couldn’t open System Settings — open it manually: Privacy & Security → Files and Folders.';
    } catch {
      note = 'Couldn’t open System Settings — open it manually: Privacy & Security → Files and Folders.';
    }
    acting = false;
    render();
  }

  render();
}
