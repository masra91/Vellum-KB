// Live-run walkthrough harness — the CORRECTIVE SWARM gate-of-record (06-28).
//
// WHY THIS EXISTS: the packaged build shipped broken (Explore/Health fail-to-load, screens
// recolored-not-redesigned) because the visual gates were STATIC CSS audits — nobody drove the
// real .app. The new rule: "view done" = a LIVE packaged-app walkthrough that DL **and** QD each
// sign. This harness makes that a repeatable command.
//
// WHAT IT DOES: launches the REAL built bundle on a SEEDED, populated, git-backed vault (so the
// data-views render genuine content, not empty states), navigates EVERY rail view, and writes a
// full-window PNG of each in BOTH themes to `e2e/walkthrough-shots/`. DL-2 (and I, and PM) then Read
// the PNGs and judge each surface against the prototype. It does NOT assert pixel baselines — it
// captures the TRUTH of each view (including a stuck "busy"/"couldn't load" state, which is exactly
// what the static gate missed). The only hard assertion is that the app booted to the shell.
//
// Dark is the v2 `[data-theme="dark"]` opt-in token layer (#445) — NOT prefers-color-scheme — so we
// inject the attribute via page.evaluate (emulateMedia would do nothing). Run it with:
//   ALLOW_LOCAL_E2E=1 npm run walkthrough          (from app/, packages first if needed)
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { builtMainEntry } from './packagedApp';
import { seedWalkthroughVault } from './seededVault';
import { NAV_VIEWS } from '../src/shell/views';

const APP_ROOT = path.join(__dirname, '..');
const SHOTS_DIR = path.join(__dirname, 'walkthrough-shots');

function resetShotsDir(): void {
  fs.rmSync(SHOTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

function rmBestEffort(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* leave it for the OS to reap */
  }
}

// Stale-bundle guard (DL-2's catch): globalSetup's fresh-guard (#455) stamps the built HEAD to
// `app/.e2e-built-sha`. If a gater runs against a PRE-#455 globalSetup (or any future regression where the
// build silently isn't refreshed), the shots would reflect a STALE bundle and a sign would be wrong. So
// before capturing, assert the build is stamped to the checked-out HEAD — turning a silent stale-gate into
// a LOUD failure with the fix. Skipped on CI (it packages immediately before e2e — freshness guaranteed)
// and outside a git repo (can't verify). This is belt-and-suspenders ON TOP of the globalSetup guard.
test('the packaged build is fresh for the checked-out HEAD (no stale-gate)', () => {
  if (process.env.CI) return;
  let head: string;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return; // not a git repo / git unavailable — nothing to verify against
  }
  if (!head) return;
  let marker: string | null = null;
  try {
    marker = fs.readFileSync(path.join(APP_ROOT, '.e2e-built-sha'), 'utf8').trim();
  } catch {
    /* absent → almost certainly a pre-#455 globalSetup that never stamps */
  }
  expect(
    marker,
    `STALE BUILD — the e2e bundle is not stamped to HEAD ${head.slice(0, 8)} (marker: ${marker ? marker.slice(0, 8) : 'absent'}). ` +
      `globalSetup's fresh-guard should have rebuilt; you may be on a pre-#455 globalSetup or E2E_FRESH didn't reach it. ` +
      `Fix: (cd app && rm -rf .vite out .e2e-built-sha && E2E_FRESH=1 npm run walkthrough)`,
  ).toBe(head);
});

test.describe('LIVE WALKTHROUGH — every view, both themes, on a seeded vault (gate-of-record)', () => {
  let app: ElectronApplication | null = null;
  let userDataDir: string | null = null;
  let vault: string | null = null;

  test.afterEach(async () => {
    await app?.close();
    app = null;
    if (userDataDir) rmBestEffort(userDataDir);
    if (vault) rmBestEffort(vault);
    userDataDir = vault = null;
  });

  test('captures all views in light + dark for DL/QD sign-off', async () => {
    const main = builtMainEntry();
    expect(main, 'built bundle not found — run `npm run package` first').toBeTruthy();

    const seeded = seedWalkthroughVault();
    userDataDir = seeded.userDataDir;
    vault = seeded.vault;
    resetShotsDir();

    app = await electron.launch({ args: [main as string, `--user-data-dir=${userDataDir}`] });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Configured + populated vault ⇒ the shell (not Setup). This is the one hard gate: the app booted.
    await expect(page.locator('.sidebar, #app .shell, .nav-item').first()).toBeVisible({ timeout: 20_000 });

    const setTheme = async (theme: 'light' | 'dark'): Promise<void> => {
      // Dark = the v2 [data-theme="dark"] opt-in token layer (#445), NOT prefers-color-scheme — set
      // it on <html> where it persists across nav clicks (no reload). Light = default vellum (absent).
      await page.evaluate((t) => {
        if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
      }, theme);
    };

    // #527 ENG-15: was a fixed arbitrary-delay sleep after the view container appeared — a flat guess at how
    // long async (IPC) content takes to paint. Too short = a mid-load capture race (the documented
    // Agents "Loading… ~16s" flake on a degraded machine); too long = wasted time on every fast view.
    // Every SPEC-0058 status face marks its OWN in-progress state, so wait for those to CLEAR instead:
    // `aria-busy="true"` (loadGuard's shared VUX-6 skeleton — most views), `.load-warming` (loadGuard's
    // calm cold-start face, which self-retries), and Health's own literal "Scanning…" state (predates the
    // shared skeleton). Bounded + tolerant (`.catch`) — a GENUINELY stuck view still gets captured AS-IS
    // once the bound trips, which is the whole point of this gate (never force a false "it settled").
    const waitForViewSettled = (root: import('@playwright/test').Locator): Promise<void> =>
      root
        .locator('[aria-busy="true"], .health-scanning, .load-warming')
        .first()
        .waitFor({ state: 'detached', timeout: 12_000 })
        .catch(() => {});

    // Capture every rail view in one theme: click its nav item, let it settle (so a stuck busy/error
    // state is captured as-is — that's the whole point), then a full-window PNG.
    const captureRailViews = async (theme: 'light' | 'dark'): Promise<string[]> => {
      const written: string[] = [];
      for (const v of NAV_VIEWS) {
        const nav = page.locator(`.nav-item[data-view="${v.id}"]`);
        if ((await nav.count()) === 0) continue; // not a rail entry in this build — skip, don't fail
        await nav.click();
        const viewEl = page.locator(`.view[data-view="${v.id}"]`).first();
        await viewEl.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
        await waitForViewSettled(viewEl);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${v.id}-${theme}.png`) });
        written.push(`${v.id}-${theme}.png`);
      }
      return written;
    };

    // Rail views first, both themes — toggling data-theme keeps the same shell DOM (no nav-item teardown).
    await setTheme('light');
    const light = await captureRailViews('light');
    await setTheme('dark');
    const dark = await captureRailViews('dark');

    // Showcase LAST: the #showcase hash route replaces the shell DOM (nav-items vanish), so it can't be
    // followed by a rail pass without a reload. Capture it terminally in both themes.
    const showcase: string[] = [];
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(theme);
      await page.evaluate(() => {
        window.location.hash = 'showcase';
      });
      const showcaseEl = page.locator('.showcase').first();
      await showcaseEl.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      await waitForViewSettled(showcaseEl); // showcase is static (no IPC read) — resolves immediately
      await page.screenshot({ path: path.join(SHOTS_DIR, `showcase-${theme}.png`) });
      showcase.push(`showcase-${theme}.png`);
    }

    const all = [...light, ...dark, ...showcase];
    fs.writeFileSync(
      path.join(SHOTS_DIR, 'INDEX.md'),
      `# Live walkthrough screenshots\n\n${all.length} shots (${light.length} light + ${dark.length} dark), seeded vault, packaged bundle.\n\n` +
        all.map((f) => `- ${f}`).join('\n') +
        '\n',
    );
    console.log(`[walkthrough] wrote ${all.length} screenshots to ${SHOTS_DIR}`);
    expect(all.length).toBeGreaterThan(0);
  });
});
