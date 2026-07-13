// App-level config (which vault is active), persisted in Electron's userData.
// Tiny JSON file — no electron-store dependency (PRIN-5 simplicity).
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './conversationStore';

export interface AppConfigData {
  activeVaultPath: string | null;
}

const DEFAULT: AppConfigData = { activeVaultPath: null };

function configFilePath(): string {
  return path.join(app.getPath('userData'), 'kb-app.config.json');
}

export async function readAppConfig(): Promise<AppConfigData> {
  try {
    return { ...DEFAULT, ...(JSON.parse(await fs.readFile(configFilePath(), 'utf8')) as AppConfigData) };
  } catch {
    return { ...DEFAULT };
  }
}

/** BUG-13 (#518): was a plain `writeFile` — a crash mid-write (process killed, disk full, power loss)
 *  left a truncated/half-written `kb-app.config.json`; `readAppConfig`'s parse then fails and the
 *  Principal's active vault is forgotten, dropping them into first-run setup despite the vault being
 *  intact on disk. Tmp + rename (the same idiom `conversationStore.ts` already uses) makes the write
 *  crash-atomic on one filesystem: a reader only ever sees the fully-old or fully-new file, never a
 *  partial one, because `rename` is atomic at the OS level. */
export async function writeAppConfig(data: AppConfigData): Promise<void> {
  await writeJsonAtomic(configFilePath(), data);
}
