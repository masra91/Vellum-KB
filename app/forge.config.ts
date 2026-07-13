import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// SPEC-0034 MACOS-3 (#56): code-sign the packaged macOS build with a STABLE identity under the
// hardened runtime, so the TCC folder grant persists across same-identity rebuilds (an ad-hoc `-`
// signature's designated requirement is a per-build cdhash → re-prompts every rebuild). Signing is
// OPT-IN (`KB_OSX_SIGN=1`) so the default `npm run package` stays UNSIGNED — CI's package build-check
// (#28/TEST-20) and non-cert contributors are unaffected; a signed build is produced only when a
// developer/release runner sets the flag (+ optionally pins the identity via `KB_OSX_SIGN_IDENTITY`,
// else @electron/osx-sign auto-detects from the keychain: `Apple Development` for dev/test,
// `Developer ID Application` for release). Notarization (MACOS-8) is a separate, creds-gated step.
const SIGN_MACOS = process.env.KB_OSX_SIGN === '1';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // #401: the production app icon (Dock / Finder / Cmd-Tab). `icon` is given WITHOUT an extension —
    // electron-packager appends the per-platform form (`build/icon.icns` on macOS, `build/icon.ico` on
    // Windows, `build/icon.png` for the Linux makers). Built from the brand mark in `brand/`.
    icon: 'build/icon',
    // #400: an explicit, stable bundle identifier for the rebrand (was the electron-packager default
    // `com.electron.kb-app`). Drives the macOS CFBundleIdentifier — the app's durable identity for
    // Launch Services, the TCC grant, and (when signed) the designated requirement.
    appBundleId: 'com.vellum.app',
    // MACOS-6: folder usage-description strings so the macOS TCC prompt explains WHY the app wants
    // the user's Documents/Desktop/Downloads (the consent rationale). Harmless in an unsigned build.
    extendInfo: {
      NSDocumentsFolderUsageDescription: 'Vellum reads and writes your knowledge-base vault when it lives in your Documents folder.',
      NSDesktopFolderUsageDescription: 'Vellum reads and writes your knowledge-base vault when it lives on your Desktop.',
      NSDownloadsFolderUsageDescription: 'Vellum reads and writes your knowledge-base vault when it lives in your Downloads folder.',
      // SPEC-0038 QCAP-8 (Principal revision 2026-06-08): the macOS DUAL-MODEL — present BOTH a Dock
      // app AND a persistent tray agent ("do both"). `LSUIElement: false` so the **Dock icon shows**
      // (Dock + Cmd-Tab + app menu) — the original accessory mode (`true`) hid the app from the Dock,
      // which the Principal reported as "the app stopped showing up in the Dock". Tray/hotkey
      // persistence is preserved by the don't-quit-on-window-all-closed lifecycle (main.ts, QCAP-8).
      LSUIElement: false,
      // SPEC-0038 QCAP-7/9 (Slice 2): selection-capture posts a synthetic ⌘C through System Events,
      // which triggers the macOS Automation TCC prompt — this usage string is its honest rationale.
      // A denied/absent grant degrades to clipboard-only (never silently dead). Harmless when unsigned.
      NSAppleEventsUsageDescription:
        'Vellum captures the text you have selected in the frontmost app when you summon Quick Capture. If you decline, capture still works from your clipboard.',
    },
    // MACOS-3: sign with the hardened runtime + the non-sandboxed entitlements (opt-in; see above).
    ...(SIGN_MACOS
      ? {
          osxSign: {
            ...(process.env.KB_OSX_SIGN_IDENTITY ? { identity: process.env.KB_OSX_SIGN_IDENTITY } : {}),
            optionsForFile: () => ({ hardenedRuntime: true, entitlements: 'build/entitlements.mac.plist' }),
          },
        }
      : {}),
    // SPEC-0061 T1 (#530): `@electron-forge/plugin-vite` auto-sets `packagerConfig.ignore` to exclude
    // EVERYTHING except the `/.vite` bundle output (verified empirically: packaging without this
    // override copies no `node_modules` at all, so an externalized native `require()` — e.g. fsevents,
    // canvas/path2d, and now better-sqlite3 — resolves to nothing at runtime; `AutoUnpackNativesPlugin`
    // below has nothing to unpack if the native was never copied into the package in the first place).
    // Providing our OWN `ignore` here (which plugin-vite detects and leaves alone, per its own guard)
    // reproduces its default AND carves out the one runtime dependency closure the library index
    // needs: `better-sqlite3` itself, `bindings` (resolves the platform `.node` path), and `bindings`'
    // own dependency `file-uri-to-path`. Extend this list if a future externalized native needs the
    // same treatment (fsevents/canvas/path2d are optionalDependencies that degrade gracefully when
    // absent, so they were never actually exercised by this gap — better-sqlite3 is NOT optional, so
    // packaging it without a copy path would silently ship a library index that can never open).
    ignore: (file: string) => {
      if (!file) return false;
      if (file.startsWith('/.vite')) return false;
      // The copy walker never descends past a path this function marks "ignore" — `/node_modules`
      // itself (and every ancestor of a kept dep below) must return `false` (don't prune here) even
      // though its OTHER children are excluded individually.
      if (file === '/node_modules') return false;
      const RUNTIME_NATIVE_DEPS = ['better-sqlite3', 'bindings', 'file-uri-to-path'];
      if (RUNTIME_NATIVE_DEPS.some((dep) => file === `/node_modules/${dep}` || file.startsWith(`/node_modules/${dep}/`))) return false;
      return true;
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    // Unpack native `.node` modules (e.g. chokidar's macOS `fsevents`) out of app.asar into
    // app.asar.unpacked so they're dlopen-able at runtime — Node can't load a native binary from
    // inside an asar. Pairs with externalizing `fsevents` in vite.main.config.ts (SPEC-0037 WATCH).
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
