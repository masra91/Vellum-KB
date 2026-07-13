// The default route: Setup flow (SPEC-0009) → App Navigation Shell (SPEC-0017). Plain DOM — minimal
// UI, no framework. Split out of `renderer.ts` (#512 PERF-R6): this module (and its CSS/view-module
// import graph, incl. every rail view + `marked`/`DOMPurify` transitively via `shell.ts`) is reached
// ONLY via `renderer.ts`'s dynamic `import()` on the default route, so the qcap/showcase routes never
// pay for it — a Vite async-chunk boundary IS a code/CSS-splitting boundary, a static top-level import
// isn't. See `renderer.ts`'s `init()`.
import './design-system.css'; // shared visual foundation — tokens/type-roles/primitives/motion
import './permissionGate.css'; // SPEC-0034 MACOS-7 "Asking for the keys" — folder-permission UX
import './setupFlow.css'; // SPEC-0009 SETUP — guided first-run (model → sample seed → tour)
import './aboutPanel.css'; // SPEC-0057 #406 — the About Vellum identity modal
import '../index.css'; // shell chrome (top bar/rail/views) + base body reset
import type { PathInspection } from '../kb/types';
import { esc, baseName } from './html';
import { navIcon } from './icons';
import { mountShell } from './shell';
import { runGuidedSetup } from './setupFlow';
import { mountPermissionGate, icloudNoteHtml } from './permissionGate';
import { isLocalTccProtected, isICloudVault } from '../kb/permissions';

let root: HTMLElement;
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
      <h1 data-testid="setup-heading">Set up your Library</h1>
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

/** #512: renderer.ts's default-route entry point — either the Setup wizard (no KB yet, SHELL-9) or the
 *  navigation shell (KB loaded, SHELL-4), matching the pre-split `init()` behavior exactly. */
export async function mountApp(container: HTMLElement): Promise<void> {
  root = container;
  // #512 PERF-R6: Today's own first read (kb:getTodayProjection) doesn't need anything getState()
  // returns — it reads main's own already-resolved active-vault state — so kick it off CONCURRENTLY
  // with getState() instead of waiting for the whole shell to mount first (Today is the default view,
  // so this was a genuine extra round-trip in the critical path to first content). `.catch` suppresses
  // an unhandled-rejection warning for the (no-vault) branch below, where this fetch is simply
  // abandoned — `mountToday`'s own `load()` does its own error handling when it's actually consumed.
  const todayPrefetch = window.kbApi.getTodayProjection();
  todayPrefetch.catch(() => {});
  const state = await window.kbApi.getState();
  if (state.activeVaultPath && state.vaultConfig) {
    mountShell(root, state.activeVaultPath, state.vaultConfig.name, todayPrefetch);
  } else {
    renderSetup();
  }
}
