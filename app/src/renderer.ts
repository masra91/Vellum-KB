// Renderer: Setup flow (SPEC-0009) → App Navigation Shell (SPEC-0017). Plain DOM —
// minimal UI, no framework. On launch it asks main for state and shows either the
// Setup wizard (no KB yet — a full-screen pre-shell gate, SHELL-9) or the navigation
// shell (KB loaded; Capture is the default view, SHELL-4).
// Bundled design-system fonts (SPEC-0057 Vellum / SPEC-0033 DESIGN-7) — self-hosted @fontsource faces
// (pinned, OFL, no CDN) backing the `--viz-font-*` roles. Brand §4: Inter (interface — body/labels/nav),
// Spectral (voice — names, titles, section heads, quotes), IBM Plex Mono (data — counts/confidence/hex/
// timestamps). Imported before the design system so @font-face is live. (Replaces Saira Condensed + Plex
// Sans from the pre-brand instrument identity.)
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/spectral/400.css';
import '@fontsource/spectral/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './shell/design-system.css'; // shared visual foundation — tokens/type-roles/primitives/motion
import './shell/permissionGate.css'; // SPEC-0034 MACOS-7 "Asking for the keys" — folder-permission UX
import './shell/setupFlow.css'; // SPEC-0009 SETUP — guided first-run (model → sample seed → tour)
import './shell/views/showcase.css'; // DESIGN-SHOWCASE — dev-only primitive gallery layout (?showcase)
import './qcap/qcap.css'; // SPEC-0038 QCAP — the frictionless quick-capture sheet (#qcap route)
import './shell/aboutPanel.css'; // SPEC-0057 #406 — the About Vellum identity modal
import './index.css';
import type { PathInspection, RendererErrorReport } from './kb/types';
import { esc, baseName } from './shell/html';
import { navIcon } from './shell/icons';
import { mountShell } from './shell/shell';
import { runGuidedSetup } from './shell/setupFlow';
import { mountShowcase } from './shell/views/showcaseView';
import { mountQuickCaptureSheet } from './qcap/qcapSheet';
import { mountPermissionGate, icloudNoteHtml } from './shell/permissionGate';
import { isLocalTccProtected, isICloudVault } from './kb/permissions';
import { initTheme } from './shell/theme';

// SPEC-0058 theme-toggle: apply the persisted (or default-light) theme BEFORE any UI paints, so a
// dark-mode user never sees a light→dark flash on launch. Setup, the permission gate, and the shell all
// inherit it. Pure attribute set — honors the themeCohesion invariant (no prefers-color-scheme touch).
initTheme();

const root = document.getElementById('app')!;

let chosenPath: string | null = null;
let inspection: PathInspection | null = null;

// VUX-RETIRE #523 §3: the terminology glossary bans colored status emoji ("Status markers are
// monochrome glyphs, never coloured emoji") — a monochrome glyph carries the state hue instead
// (contrast contract: small text stays --ink, only the glyph rides the hue), plus an sr-only label
// since the glyph is the only visual signal a screen reader would otherwise miss.
function mark(ok: boolean, warnIfFalse = false): string {
  if (ok) return `<span class="setup-mark ok">${navIcon('circle-check')}<span class="sr-only">OK</span></span>`;
  const cls = warnIfFalse ? 'warn' : 'bad';
  const label = warnIfFalse ? 'Warning' : 'Error';
  return `<span class="setup-mark ${cls}">${navIcon('alert-triangle')}<span class="sr-only">${label}</span></span>`;
}

function renderSetup(): void {
  root.innerHTML = `
    <div class="setup-view">
    <div class="card">
      <h1>Set up your Library</h1>
      <p class="muted">
        Choose a folder to hold your library. It becomes a git-versioned folder you can also
        open directly in Obsidian.
      </p>
      <button id="choose" class="primary">Choose folder…</button>
      <div id="details"></div>
    </div>
    </div>`;
  document.getElementById('choose')!.addEventListener('click', onChoose);
}

async function onChoose(): Promise<void> {
  const p = await window.kbApi.pickFolder();
  if (!p) return;
  chosenPath = p;
  inspection = await window.kbApi.inspect(p);
  renderDetails();
}

function renderDetails(): void {
  if (!inspection) return;
  const ins = inspection;
  document.getElementById('details')!.innerHTML = `
    <p class="path">${esc(ins.path)}</p>
    <ul class="checks">
      <li>${mark(ins.gitInstalled)} git installed</li>
      <li>${mark(ins.isGitRepo)} git repository ${ins.isGitRepo ? '' : '<span class="muted">(will initialize)</span>'}</li>
      <li>${mark(ins.copilot.available, true)} Copilot &mdash; <span class="muted">${esc(ins.copilot.detail)}</span></li>
      ${ins.alreadyKb ? `<li>${mark(false, true)} This folder already contains a Vellum config (will be reused).</li>` : ''}
    </ul>
    ${
      isICloudVault(ins.tccProtectedDir)
        ? // iCloud is detect-warn-only (v1, MACOS-2): a calm, non-blocking note — not a steer-away.
          icloudNoteHtml()
        : ins.tccProtectedDir
          ? `<p class="warning">⚠️ This folder is inside your <strong>${esc(ins.tccProtectedDir)}</strong>, a macOS-protected location. Vellum's background tasks (git, Copilot) can be silently blocked there — captures may never finish processing. <strong>Pick a folder outside ${esc(ins.tccProtectedDir)}</strong> (e.g. one directly in your home directory) to be safe.</p>`
          : ''
    }
    <label class="field">Name<input id="name" value="${esc(baseName(ins.path))}" /></label>
    <label class="checkbox"><input type="checkbox" id="initGit" checked /> Initialize git repo if needed</label>
    ${ins.gitInstalled ? '' : '<p class="error">git is required. Install git, then choose the folder again.</p>'}
    <button id="create" class="primary" ${ins.gitInstalled ? '' : 'disabled'}>Create Library</button>
    <div id="result"></div>`;
  document.getElementById('create')?.addEventListener('click', onCreate);
}

async function onCreate(): Promise<void> {
  if (!chosenPath) return;
  const name = (document.getElementById('name') as HTMLInputElement | null)?.value;
  const initGit = (document.getElementById('initGit') as HTMLInputElement | null)?.checked ?? true;
  const btn = document.getElementById('create') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const res = await window.kbApi.create({ path: chosenPath, name, initGitIfNeeded: initGit });

  if (res.ok && res.vaultConfig) {
    const path = chosenPath;
    const vaultName = res.vaultConfig.name;
    // SPEC-0009 SETUP: the KB now exists → walk the remaining one-time guided steps (model → optional
    // sample seed → short tour) on the WS2 flow, THEN hand off to the shell. This runs only in the create
    // path, so a returning launch (vault already configured) never re-onboards (SETUP-6).
    const enterShell = (): void => mountShell(root, path, vaultName);
    const guided = (): void => runGuidedSetup(root, { vaultName, onDone: enterShell });
    // SPEC-0034 MACOS-7: for a vault in a LOCAL TCC-gated folder (Documents/Desktop/Downloads), gate the
    // first run behind the pre-prompt — Continue performs a probe write so the macOS grant dialog fires
    // coupled to our explanation (MACOS-5), and a denial drops to the Blocked recovery. The guided setup
    // runs only after the grant (model-pick/seed need a writable vault). Other locations (incl. iCloud,
    // which is detect-warn-only) proceed straight into the guided flow.
    if (isLocalTccProtected(inspection?.tccProtectedDir ?? null)) {
      mountPermissionGate(root, { vaultPath: path, folder: path, onGranted: guided });
      return;
    }
    guided();
    return;
  }
  document.getElementById('result')!.innerHTML = `<p class="error">${esc(res.message)}</p>`;
  btn.disabled = false;
  btn.textContent = 'Create Library';
}

/** Dev-only design-system showcase gate (design-system-showcase.md): reachable ONLY via `?showcase`
 *  or `#showcase` — never in the user nav. Static, no IPC/pipeline/`active` dependency, so it renders
 *  on any (or no) vault — that's what lets the HYBRID visual snapshot pin the primitives directly
 *  (the parked #233 needed a git+pipeline harness). The e2e drives it by setting the hash post-boot. */
function showcaseRequested(): boolean {
  return new URLSearchParams(location.search).has('showcase') || location.hash.toLowerCase().includes('showcase');
}

/** SPEC-0038 QCAP: the menubar agent loads this same renderer with `#qcap` for the capture sheet. */
function qcapRequested(): boolean {
  return location.hash.toLowerCase() === '#qcap';
}

// SPEC-0030 OBS-18 (renderer): forward uncaught renderer errors / unhandled rejections to the main
// app-log (the isolated renderer can't write it itself). Fire-and-forget; its own failures swallowed.
function installRendererErrorForwarding(): void {
  const report = (r: RendererErrorReport): void => {
    void window.kbApi?.reportRendererError?.(r).catch(() => {});
  };
  window.addEventListener('error', (e: ErrorEvent) => {
    report({
      kind: 'error',
      message: e.message || String((e.error as Error | undefined)?.message ?? 'renderer error'),
      ...(e.filename ? { source: e.filename } : {}),
      ...(typeof e.lineno === 'number' ? { line: e.lineno } : {}),
      ...(typeof e.colno === 'number' ? { col: e.colno } : {}),
      ...((e.error as Error | undefined)?.stack ? { stack: String((e.error as Error).stack) } : {}),
    });
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason: unknown = e.reason;
    report({
      kind: 'unhandledrejection',
      message: reason instanceof Error ? reason.message : String(reason),
      ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
    });
  });
}

async function init(): Promise<void> {
  installRendererErrorForwarding(); // OBS-18: always on, before any route (showcase/qcap/shell)
  if (qcapRequested()) {
    mountQuickCaptureSheet(root);
    return;
  }
  if (showcaseRequested()) {
    mountShowcase(root);
    return;
  }
  const state = await window.kbApi.getState();
  if (state.activeVaultPath && state.vaultConfig) {
    mountShell(root, state.activeVaultPath, state.vaultConfig.name);
  } else {
    renderSetup();
  }
}

// Let the showcase be reached after boot (the e2e sets `location.hash = 'showcase'` — no reload, no IPC).
window.addEventListener('hashchange', () => {
  if (showcaseRequested()) mountShowcase(root);
});

void init();
