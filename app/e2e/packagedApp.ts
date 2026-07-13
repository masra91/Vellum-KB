// Paths to the build artifacts e2e needs:
//  - builtMainEntry(): the production-built main entry (`.vite/build/main.js`). Playwright
//    drives this real bundle (works because it isn't fuse-locked like the packaged binary).
//  - packagedExecutable(): the fully-packaged, fused binary from `electron-forge package`
//    (out/). Playwright can't attach to it (fuses disable Node inspect/RunAsNode), so it is
//    used only for a boot-survival smoke that catches asar/dep-bundling crashes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'Vellum';
const appRoot = path.resolve(__dirname, '..');

export function builtMainEntry(): string | null {
  const p = path.join(appRoot, '.vite', 'build', 'main.js');
  return fs.existsSync(p) ? p : null;
}

/** The built renderer's asset directory (`.vite/renderer/main_window/assets/`) — the per-route JS/CSS
 *  chunks Vite's code-splitting produced. #512: used to assert the qcap route's chunk carries none of
 *  the shell/marked/DOMPurify code (a real Vite async-chunk boundary, not just an eyeballed diff). */
export function rendererAssetsDir(): string | null {
  const p = path.join(appRoot, '.vite', 'renderer', 'main_window', 'assets');
  return fs.existsSync(p) ? p : null;
}

export function packagedExecutable(): string | null {
  const outDir = path.join(appRoot, 'out');
  if (!fs.existsSync(outDir)) return null;
  const arch = os.arch();

  if (process.platform === 'darwin') {
    const p = path.join(outDir, `${APP_NAME}-darwin-${arch}`, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME);
    return fs.existsSync(p) ? p : null;
  }
  if (process.platform === 'win32') {
    const p = path.join(outDir, `${APP_NAME}-win32-${arch}`, `${APP_NAME}.exe`);
    return fs.existsSync(p) ? p : null;
  }
  const p = path.join(outDir, `${APP_NAME}-linux-${arch}`, APP_NAME);
  return fs.existsSync(p) ? p : null;
}
