// Renderer entry — a thin router only. #512 PERF-R6: this file used to statically import the WHOLE
// app (every rail view + `marked` + `DOMPurify` transitively via `shell.ts`, plus setup/permission-gate/
// showcase CSS) at the top level, so the qcap window — which only ever needs `qcapSheet.ts` + its own
// CSS — paid to parse/execute all of it too (they share one Vite renderer target, `main_window`, loading
// the SAME `index.html`/bundle with a `#qcap` hash). A dynamic `import()` per route is a real Vite
// async-chunk boundary (code AND the CSS each chunk statically imports) — the qcap route now loads only
// `qcap/qcapSheet.ts`'s own chunk, never `shell/appRoute.ts`'s. See `shell/appRoute.ts` for the
// Setup-flow → Shell default route (moved there verbatim) and `qcap/qcapSheet.ts` for the capture sheet.
//
// Fonts stay here (needed everywhere text renders, incl. qcap) — self-hosted @fontsource faces (pinned,
// OFL, no CDN) backing the `--viz-font-*` roles. Brand §4: Inter (interface), Spectral (voice), IBM Plex
// Mono (data). Imported before anything else so @font-face is live on first paint of any route.
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/spectral/400.css';
import '@fontsource/spectral/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import type { RendererErrorReport } from './kb/types';
import { initTheme } from './shell/theme';

// SPEC-0058 theme-toggle: apply the persisted (or default-light) theme BEFORE any UI paints, so a
// dark-mode user never sees a light→dark flash on launch. Setup, the permission gate, and the shell all
// inherit it. Pure attribute set — honors the themeCohesion invariant (no prefers-color-scheme touch).
initTheme();

const root = document.getElementById('app')!;

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
    const { mountQuickCaptureSheet } = await import('./qcap/qcapSheet');
    mountQuickCaptureSheet(root);
    // #512 PERF-R7: the qcap window is kept alive across summons (main.showSheet keeps it hidden, not
    // destroyed) — this page never reloads again, so main pushes a reset signal on every re-summon
    // instead. Subscribed exactly once here (this branch runs once per page load); re-mounting is safe
    // + correct since `mountQuickCaptureSheet` rebuilds the DOM (and so its own listeners) from scratch.
    window.kbApi.onQuickCaptureResummoned(() => mountQuickCaptureSheet(root));
    return;
  }
  if (showcaseRequested()) {
    const { mountShowcase } = await import('./shell/views/showcaseView');
    mountShowcase(root);
    return;
  }
  const { mountApp } = await import('./shell/appRoute');
  await mountApp(root);
}

// Let the showcase be reached after boot (the e2e sets `location.hash = 'showcase'` — no reload, no IPC).
window.addEventListener('hashchange', () => {
  if (showcaseRequested()) void import('./shell/views/showcaseView').then(({ mountShowcase }) => mountShowcase(root));
});

void init();
