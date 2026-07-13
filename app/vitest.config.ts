/// <reference types="vitest" />
// Vitest config (SPEC-0012 TEST-3). Vite-native runner; node environment for the
// shell-agnostic domain. Component tier (jsdom/happy-dom) is reserved (TEST-5) and not
// configured yet. e2e lives under `e2e/` and is driven by Playwright, not Vitest.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // src domain suite + the EVAL harness's PURE/deterministic unit tests (SPEC-0042 Slice-1: schema,
    // validators, scorecard, loader). The opt-in scenario e2e (`eval/**/*.eval.ts`, real copilot) stays
    // under the separate eval config, not here.
    include: ['src/**/*.test.ts', 'eval/runner/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.vite/**', 'dist/**', 'out/**'],
    // The domain suite is heavy on real FS + git + worktrees (TEST-18). Individual ops are fast,
    // but under full-suite parallelism they can spike past Vitest's 5s default → flaky timeouts.
    // Give the integration tests headroom (they still run in ~1–4s normally).
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // TEST-12 / ENG-10 / #527 ENG-5: gate all three source directories, per-directory, not just
      // `src/kb`. `src/main` and `src/shell` had real suites but no floor — a coverage drop was
      // invisible until someone happened to notice. Per-directory (not one blended number) so a strong
      // dir (kb/shell) can't paper over a weak one (main) averaging out.
      include: ['src/kb/**/*.ts', 'src/main/**/*.ts', 'src/shell/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        // kb: unchanged from its original (pre-#527) floor.
        'src/kb/**': { lines: 90, functions: 90, statements: 90, branches: 80 },
        // main + shell (#527 ENG-5): measured-current-minus-2%, ratcheted — a REGRESSION gate, not a
        // coverage target. `main` in particular sits far below kb/shell (~63% lines) because it's a mix
        // of directly-testable orchestration glue (pipeline.ts, ipc.ts — genuinely undertested, a fast-
        // follow candidate) and truly Electron-only code with no vitest-reachable path (quickCaptureElectron.ts,
        // trayIcon.ts — covered by e2e instead, SPEC-0012 TEST-12). The floor is deliberately set from
        // TODAY'S real number (measured via a full `test:coverage` run), not aspirational, so it fails CI
        // on a genuine drop without demanding an unrelated coverage-raising effort in this batch.
        'src/main/**': { lines: 61, functions: 67, statements: 61, branches: 74 },
        'src/shell/**': { lines: 91, functions: 95, statements: 91, branches: 78 },
      },
    },
  },
});
