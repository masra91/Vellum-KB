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
    // under the separate eval config, not here. `scripts/**` (SPEC-0055 #529): the release workflow's
    // pure logic (tag/version matching, required-check evaluation) — CI-only tooling, not app source,
    // but held to the same "test everything" bar as the rest of the domain suite.
    include: ['src/**/*.test.ts', 'eval/runner/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.vite/**', 'dist/**', 'out/**'],
    // The domain suite is heavy on real FS + git + worktrees (TEST-18). Individual ops are fast,
    // but under full-suite parallelism they can spike past Vitest's 5s default → flaky timeouts.
    // Give the integration tests headroom (they still run in ~1–4s normally).
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // TEST-12 / ENG-10: gate coverage on the shell-agnostic domain/core only.
      // Main-process glue is Electron-bound (covered by e2e); the renderer/component
      // tier is reserved (TEST-5/13) — neither carries a unit-coverage gate yet.
      include: ['src/kb/**/*.ts'],
      exclude: ['src/kb/**/*.test.ts'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 80,
      },
    },
  },
});
