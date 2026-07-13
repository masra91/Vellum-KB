// e2e smoke (SPEC-0012 TEST-4; SPEC-0009 SETUP-1). Two complementary checks:
//
//  1. UI smoke — Playwright drives the production-built app bundle (`.vite/build/main.js`,
//     real main + preload + renderer) with a clean userData dir, and asserts the first-run
//     Setup wizard renders (SETUP-1). Playwright attaches here because the built bundle is
//     not fuse-locked.
//  2. Packaged boot-survival — the fully-packaged, fused binary can't be driven by Playwright
//     (fuses disable Node inspect / RunAsNode), so we instead spawn it with a clean userData
//     dir and assert it boots and stays up without crashing. This is the check that would
//     have caught the `simple-git` asar-bundling bug (a missing bundled dep crashes on boot).
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtMainEntry, packagedExecutable, rendererAssetsDir } from './packagedApp';

function freshUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'));
}

// Best-effort: a temp userData dir the (now-exited) app may still briefly lock on Windows
// (EBUSY) must never fail the test — the assertion already happened, and the OS reaps temp.
function rmDirBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}

test.describe('SETUP-1 — first-run boot', () => {
  let app: ElectronApplication | null = null;
  let userDataDir: string | null = null;

  test.afterEach(async () => {
    await app?.close();
    app = null;
    if (userDataDir) {
      rmDirBestEffort(userDataDir);
      userDataDir = null;
    }
  });

  test('SETUP-1: built app boots and shows the first-run Setup UI', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    userDataDir = freshUserDataDir();
    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });

    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    // #527 ENG-15: was `toHaveText('Set up your Library')` — an exact-copy assertion that breaks this
    // e2e on any wording change with zero functional signal (a copy edit isn't a regression). Assert on
    // a stable `data-testid` instead — the thing this test actually cares about (clean userData ⇒ no
    // configured vault ⇒ the Setup wizard rendered, SETUP-1 / SETUP-6), not its wording.
    await expect(window.locator('[data-testid="setup-heading"]')).toBeVisible({ timeout: 15_000 });
  });

  // #512 PERF-R5: `show:false` + `ready-to-show` means the window is never visible before the renderer
  // has painted, and its `backgroundColor` is the shell's own fixed-light cream rather than the OS
  // default white — together these are what eliminate the white first-frame flash. Asserting the actual
  // pixel-level absence of a white flash is inherently racy in a headless CI runner; asserting the two
  // window options that CAUSE it is the deterministic proxy.
  test('PERF-R5: main window ships themed + hidden-until-ready (no white first-frame flash)', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    userDataDir = freshUserDataDir();
    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });

    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    const bg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor());
    expect(bg?.toLowerCase()).toBe('#f4efe3'); // the fixed-light Vellum cream (index.css --bg), not OS-default white

    // By the time content has loaded, ready-to-show has already fired and shown the window — confirms
    // the show happens off that event (not eagerly at BrowserWindow construction).
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible());
    expect(visible).toBe(true);
  });
});

test('TEST-4: packaged app boots without crashing (asar/dep-bundling smoke)', async () => {
  const exe = packagedExecutable();
  expect(exe, 'packaged app not found — run `npm run package` first').toBeTruthy();

  const userDataDir = freshUserDataDir();
  const child = spawn(exe as string, [`--user-data-dir=${userDataDir}`], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  // If a bundled dep is missing, the main process throws and the app exits early.
  const earlyExit = await new Promise<{ code: number | null } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000); // survived 6s ⇒ booted OK
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });

  // Shut it down and WAIT for full exit before touching the userData dir — Windows holds
  // file locks (e.g. Chromium's DIPS db) until the process is actually gone.
  if (earlyExit === null) {
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 3000);
    });
  }
  rmDirBestEffort(userDataDir);

  expect(earlyExit, `packaged app exited during boot (code ${earlyExit?.code}). stderr:\n${stderr}`).toBeNull();
});

// #512 PERF-R6: renderer.ts used to statically import the ENTIRE app (every rail view + `marked` +
// `DOMPurify` transitively via shell.ts) at its top level, so the qcap capture-sheet window — which
// only ever needs qcapSheet.ts's own tiny UI — paid to parse/execute all of it too. Each route now
// loads via a dynamic `import()`, a real Vite async-chunk boundary; this asserts the qcap chunk's
// ACTUAL built output carries none of the shell's code, not just that the source imports look right.
test('PERF-R6: the qcap route\'s built chunk carries no marked/DOMPurify/shell-view code', () => {
  const assetsDir = fs.existsSync(path.join(__dirname, '..', '.vite')) ? rendererAssetsDir() : null;
  expect(assetsDir, 'built renderer assets not found — run `npm run package` first').toBeTruthy();

  const files = fs.readdirSync(assetsDir as string);
  const qcapChunk = files.find((f) => f.startsWith('qcapSheet-') && f.endsWith('.js'));
  expect(qcapChunk, 'expected a separate qcapSheet-*.js chunk (code-splitting regressed?)').toBeTruthy();
  const appRouteChunk = files.find((f) => f.startsWith('appRoute-') && f.endsWith('.js'));
  expect(appRouteChunk, 'expected a separate appRoute-*.js chunk (code-splitting regressed?)').toBeTruthy();

  const qcapSrc = fs.readFileSync(path.join(assetsDir as string, qcapChunk as string), 'utf8');
  // Telltale strings from the shell's view code / markdown pipeline — none of this belongs in a chunk
  // whose only job is the capture textarea.
  expect(qcapSrc).not.toContain('DOMPurify');
  expect(qcapSrc).not.toContain('activity-entry'); // Activity view markup
  expect(qcapSrc).not.toContain('ask-turn'); // Ask view markup

  // Sanity check the OTHER direction too: the shell/setup chunk DOES carry the markdown pipeline (this
  // is genuinely a route-scoping assertion, not "nothing anywhere imports DOMPurify").
  const appRouteSrc = fs.readFileSync(path.join(assetsDir as string, appRouteChunk as string), 'utf8');
  expect(appRouteSrc).toContain('DOMPurify');
});
