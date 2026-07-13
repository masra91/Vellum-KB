// Control Panel · Watched folders (SPEC-0037 WATCH-9; over the watch registry). Extracted out of
// pipeline.ts (#528 ENG-7); pipeline.ts's thin `*ForActive` wrappers pass in exactly what this needs
// (root/lock/vaultPath/log/refresh) rather than this module importing the `active` singleton directly.
import type { Mutex } from '../../kb/stageLock';
import type { DevLog } from '../../kb/devlog';
import { readWatchRegistry, writeWatchRegistry, upsertWatchFolder, patchWatchFolder, watchRegistryPath } from '../../kb/watchRegistry';
import { checkWatchLoopSafe, isSafeWatchId, DEFAULT_WATCH_SCOPE, DEFAULT_WATCH_SENSITIVITY, WATCH_MAX_DEPTH_CAP } from '../../kb/watchConnectors';
import { buildWatchFolderViews } from '../../kb/watchPanel';
import { readEvents } from '../../kb/activityIndex';
import { appendAuditEvent } from '../../kb/audit';
import type { WatchFolderView, WatchFolderPatch } from '../../kb/types';
import { runRegistryWrite, runRegistryRemove } from './registryCrud';

export interface WatchCtx {
  root: string;
  lock: Mutex;
  vaultPath: string;
  log: DevLog;
  watchingIds: () => Set<string>;
  refresh: () => Promise<void>;
}

/** List the active KB's watched folders for the unified Sources view (WATCH-9): config + the live
 *  `watching` flag (from the scheduler) + each folder's newest `watch` audit folded as `lastEvent`.
 *  Reads `staging` (registry + audit live there). */
export async function listWatchFolders(ctx: Pick<WatchCtx, 'root' | 'log' | 'watchingIds'>): Promise<WatchFolderView[]> {
  const { root } = ctx;
  const registry = await readWatchRegistry(root, ctx.log);
  const events = await readEvents(root, { actors: ['watch'] }); // newest-first
  const lastByWatch: Record<string, (typeof events)[number] | undefined> = {};
  for (const f of registry) lastByWatch[f.id] = events.find((e) => e.subjects.watchId === f.id);
  return buildWatchFolderViews(registry, ctx.watchingIds(), lastByWatch);
}

/**
 * Apply a Sources-view edit to a watched folder (WATCH-9) + return the refreshed list. Untrusted IPC
 * input is validated at this boundary; a `folderPath` being set/changed is **loop-guarded** against the
 * REAL vault (WATCH-10) — a loop-unsafe folder (the vault/.kb/.git or an ancestor) is REFUSED and never
 * persisted (the change is dropped, fail-safe). The write + git commit run under the shared lock
 * (durability); a conforming `panel` audit records the change (AUDIT-2); then the scheduler re-syncs so a
 * newly-enabled folder starts watching (and a disabled one stops).
 */
export async function setWatchFolder(patch: WatchFolderPatch, ctx: WatchCtx): Promise<WatchFolderView[]> {
  const { root, lock } = ctx;
  if (typeof patch.id !== 'string' || patch.id.length === 0) return listWatchFolders(ctx);

  const clean: WatchFolderPatch = { id: patch.id };
  if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
  if (typeof patch.scope === 'string' && patch.scope.trim()) clean.scope = patch.scope.trim();
  if (typeof patch.sensitivity === 'string' && patch.sensitivity.trim()) clean.sensitivity = patch.sensitivity.trim();
  if (typeof patch.label === 'string') clean.label = patch.label;
  if (Array.isArray(patch.ignoreGlobs)) clean.ignoreGlobs = patch.ignoreGlobs.filter((g): g is string => typeof g === 'string');
  if (typeof patch.folderPath === 'string' && patch.folderPath.trim()) clean.folderPath = patch.folderPath.trim();
  // Slice-2 opt-ins (WATCH-12/14): coerce to safe values at the boundary — maxDepth clamped to [0, cap].
  if (typeof patch.recursive === 'boolean') clean.recursive = patch.recursive;
  if (typeof patch.maxDepth === 'number' && Number.isFinite(patch.maxDepth)) clean.maxDepth = Math.min(Math.max(0, Math.floor(patch.maxDepth)), WATCH_MAX_DEPTH_CAP);
  if (typeof patch.consume === 'boolean') clean.consume = patch.consume;

  // WATCH-10 loop-guard at the IPC boundary: a folderPath set/change must be loop-safe vs the REAL vault,
  // else REFUSE the whole change (never persist a folder that would re-ingest the vault into itself).
  if (clean.folderPath !== undefined) {
    const guard = await checkWatchLoopSafe(ctx.vaultPath, clean.folderPath);
    if (!guard.ok) {
      ctx.log.child({ scope: 'watch' }).warn('watch.config-refused', { watchId: clean.id, folderPath: clean.folderPath, reason: guard.reason });
      await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: clean.id }, payload: { refused: true, folderPath: clean.folderPath, reason: guard.reason, why: 'folder-watch loop-guard refused the folder (WATCH-10)' } });
      return listWatchFolders(ctx); // fail-safe: nothing persisted
    }
  }

  const { applied } = await runRegistryWrite(root, {
    lock,
    lockLabel: 'watch-config:write',
    registryPath: watchRegistryPath,
    commitMessage: `watch ${clean.id} config change`,
    read: (r) => readWatchRegistry(r),
    findId: clean.id,
    patchExisting: (r) =>
      patchWatchFolder(r, clean.id, {
        ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}),
        ...(clean.folderPath !== undefined ? { folderPath: clean.folderPath } : {}),
        ...(clean.scope !== undefined ? { scope: clean.scope } : {}),
        ...(clean.sensitivity !== undefined ? { sensitivity: clean.sensitivity } : {}),
        ...(clean.label !== undefined ? { label: clean.label } : {}),
        ...(clean.ignoreGlobs !== undefined ? { ignoreGlobs: clean.ignoreGlobs } : {}),
        ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}),
        ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
        ...(clean.consume !== undefined ? { consume: clean.consume } : {}),
      }),
    insertNew: async (r) => {
      // New watched folder requires a folderPath (already loop-guarded above).
      if (clean.folderPath === undefined) return false;
      await upsertWatchFolder(r, {
        id: clean.id,
        folderPath: clean.folderPath,
        enabled: clean.enabled ?? false,
        scope: clean.scope ?? DEFAULT_WATCH_SCOPE,
        sensitivity: clean.sensitivity ?? DEFAULT_WATCH_SENSITIVITY,
        ...(clean.label !== undefined ? { label: clean.label } : {}),
        ...(clean.ignoreGlobs !== undefined ? { ignoreGlobs: clean.ignoreGlobs } : {}),
        ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}),
        ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}),
        ...(clean.consume !== undefined ? { consume: clean.consume } : {}),
      });
      return true;
    },
  });

  if (applied) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: clean.id }, payload: { ...(clean.enabled !== undefined ? { enabled: clean.enabled } : {}), ...(clean.folderPath !== undefined ? { folderPath: clean.folderPath } : {}), ...(clean.recursive !== undefined ? { recursive: clean.recursive } : {}), ...(clean.maxDepth !== undefined ? { maxDepth: clean.maxDepth } : {}), ...(clean.consume !== undefined ? { consume: clean.consume } : {}), why: 'Principal edited a watched folder via Control Panel' } });
    await ctx.refresh(); // start/stop live watchers to match the new config
  }
  return listWatchFolders(ctx);
}

/** Remove a watched folder (WATCH-9): drop it from the registry, audit the removal, and stop its live
 *  watcher. An unsafe id is a no-op (the registry guard would reject it anyway). */
export async function removeWatchFolder(id: string, ctx: WatchCtx): Promise<WatchFolderView[]> {
  const { root, lock } = ctx;
  if (!isSafeWatchId(id)) return listWatchFolders(ctx);
  const removed = await runRegistryRemove(root, {
    lock,
    lockLabel: 'watch-config:remove',
    registryPath: watchRegistryPath,
    commitMessage: `watch ${id} removed`,
    read: (r) => readWatchRegistry(r),
    findId: id,
    remove: async (r, removeId, folders) => {
      await writeWatchRegistry(r, folders.filter((f) => f.id !== removeId));
    },
  });
  if (removed) {
    await appendAuditEvent(root, { actor: 'panel', eventType: 'watch-config-change', subjects: { watchId: id }, payload: { removed: true, why: 'Principal removed a watched folder via Control Panel' } });
    await ctx.refresh(); // tear down the removed folder's live watcher
  }
  return listWatchFolders(ctx);
}
