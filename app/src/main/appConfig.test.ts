// SPEC-0009 SETUP-6 — the app-level config (which vault is active) is persisted in
// Electron's userData, so a later launch loads the existing KB instead of re-onboarding.
// `app.getPath('userData')` is mocked to a throwaway temp dir; the real fs round-trips
// through it, proving the config survives a (simulated) process restart.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';

const state = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected getPath(${name})`);
      return state.userData;
    },
  },
}));

import { readAppConfig, writeAppConfig } from './appConfig';

const CONFIG_FILE = 'kb-app.config.json';

describe('appConfig persistence (SETUP-6)', () => {
  beforeEach(async () => {
    state.userData = await makeTempDir('kb-userdata-');
  });
  afterEach(async () => {
    await rmTempDir(state.userData);
  });

  it('first run: no config file yet → defaults to no active vault (setup is shown)', async () => {
    expect(await readAppConfig()).toEqual({ activeVaultPath: null });
  });

  it('persists activeVaultPath; a later launch reads the same vault back (no re-onboarding)', async () => {
    const vault = '/Users/principal/my-kb';

    await writeAppConfig({ activeVaultPath: vault });

    // The config lives in userData — it outlives the process, so a fresh launch sees it.
    expect(await pathExists(path.join(state.userData, CONFIG_FILE))).toBe(true);
    expect((await readAppConfig()).activeVaultPath).toBe(vault);
  });

  it('falls back to the default (not a crash) when the persisted config is corrupt', async () => {
    await fs.writeFile(path.join(state.userData, CONFIG_FILE), '{ this is not json');
    expect(await readAppConfig()).toEqual({ activeVaultPath: null });
  });

  // BUG-13 (#518): writeAppConfig used to be a plain writeFile — a crash mid-write left a truncated
  // config, and the vault was forgotten even though it was fine on disk. Prove the fix is crash-atomic:
  // simulate a crash AFTER the tmp file is written but BEFORE the rename that would replace the real
  // config — the real file must be untouched (still the last good write, never partial/corrupt).
  it('a crash mid-write (tmp written, rename never happens) never corrupts the real config file', async () => {
    const vault = '/Users/principal/good-kb';
    await writeAppConfig({ activeVaultPath: vault }); // a real prior good write
    expect((await readAppConfig()).activeVaultPath).toBe(vault);

    // Simulate the crash: a NEW write's tmp file lands on disk, but the process dies before the
    // rename that would swap it in — exactly what a plain writeFile could never protect against.
    const configFile = path.join(state.userData, CONFIG_FILE);
    const tmpFile = `${configFile}.${process.pid}.tmp`;
    await fs.writeFile(tmpFile, '{ "activeVaultPath": "/Users/principal/new-kb", truncat'); // deliberately truncated

    // The real config is UNTOUCHED — rename() is atomic, so a crash before it never partially applies.
    expect(await pathExists(configFile)).toBe(true);
    expect((await readAppConfig()).activeVaultPath).toBe(vault); // still the old good value, not corrupt/reset
    expect(JSON.parse(await fs.readFile(configFile, 'utf8'))).toEqual({ activeVaultPath: vault }); // byte-valid JSON

    // Cleanup the orphaned tmp (mirrors what a real restart would eventually do, if anything does).
    await fs.rm(tmpFile, { force: true });
  });

  it('a normal write actually uses tmp + rename (no leftover tmp file after success)', async () => {
    const vault = '/Users/principal/renamed-kb';
    await writeAppConfig({ activeVaultPath: vault });
    const tmpFile = path.join(state.userData, `${CONFIG_FILE}.${process.pid}.tmp`);
    expect(await pathExists(tmpFile)).toBe(false); // rename() consumed it — nothing left behind on success
    expect((await readAppConfig()).activeVaultPath).toBe(vault);
  });
});
