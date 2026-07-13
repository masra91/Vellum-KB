// #528 ENG-7 — the shared shape behind every Control Panel registry write (jobs/watch/researchers/
// intake): find-by-id in the registry, patch the existing row OR insert a new one, commit the control
// file under the canonical-writer lock (durability), and report whether anything was actually applied
// (so the caller knows whether to emit conforming audit events). Each registry's OWN validation,
// defaults, and nested-patch-merge logic stays in its own file — this only factors out the identical
// lock/read/patch-or-insert/commit ceremony that wrapped all four.
import type { Mutex } from '../../kb/stageLock';
import { commitControlFile } from '../commitControlFile';

export interface RunRegistryWriteOptions<TItem> {
  lock: Mutex;
  lockLabel: string;
  registryPath: (root: string) => string;
  commitMessage: string;
  read: (root: string) => Promise<TItem[]>;
  findId: string;
  /** Patch the existing row. Called only when a row with `findId` is found. Return value ignored
   *  (some registry `patch*` helpers return the updated list — this accepts that as-is). */
  patchExisting: (root: string, prior: TItem) => Promise<unknown>;
  /** Insert a new row for `findId` (validated/defaulted by the caller). Return `false` to REFUSE
   *  creation (e.g. a required field is still missing) — nothing is applied or committed. */
  insertNew: (root: string) => Promise<boolean>;
}

/** Run one registry write under the shared lock: find → patch-or-insert → commit (only if applied). */
export async function runRegistryWrite<TItem>(root: string, opts: RunRegistryWriteOptions<TItem>): Promise<{ prior: TItem | undefined; applied: boolean }> {
  let prior: TItem | undefined;
  let applied = false;
  await opts.lock.run(async () => {
    const registry = await opts.read(root);
    prior = (registry as Array<TItem & { id?: string }>).find((r) => r.id === opts.findId);
    if (prior) {
      await opts.patchExisting(root, prior);
      applied = true;
    } else {
      applied = await opts.insertNew(root);
    }
    if (applied) await commitControlFile(root, opts.registryPath(root), opts.commitMessage);
  }, opts.lockLabel);
  return { prior, applied };
}

export interface RunRegistryRemoveOptions<TItem> {
  lock: Mutex;
  lockLabel: string;
  registryPath: (root: string) => string;
  commitMessage: string;
  read: (root: string) => Promise<TItem[]>;
  findId: string;
  /** Delete the row for `findId`. Passed the registry array already read this pass (avoids a
   *  redundant re-read — the caller typically filters it and writes the result back). Return
   *  value ignored (some registry `delete*` helpers return the updated list). */
  remove: (root: string, id: string, registry: TItem[]) => Promise<unknown>;
}

/** Run one registry removal under the shared lock: no-op if the id isn't present, else delete + commit. */
export async function runRegistryRemove<TItem>(root: string, opts: RunRegistryRemoveOptions<TItem>): Promise<boolean> {
  let removed = false;
  await opts.lock.run(async () => {
    const registry = await opts.read(root);
    if (!(registry as Array<TItem & { id?: string }>).some((r) => r.id === opts.findId)) return;
    await opts.remove(root, opts.findId, registry);
    removed = true;
    await commitControlFile(root, opts.registryPath(root), opts.commitMessage);
  }, opts.lockLabel);
  return removed;
}
