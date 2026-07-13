// #528: extracted out of pipeline.ts so registry modules (main/registries/*.ts) can call it without a
// circular import back into pipeline.ts. No `active` state — a pure `(root, absPath, message) → commit`
// primitive, usable from anywhere already holding the canonical-writer lock.
import path from 'node:path';
import { boundedGit } from '../kb/canonicalAdvance';

/**
 * Commit one Control-Panel working file on the `staging` root — the **durability record**: these
 * files (`.kb/jobs/registry.json`, `.kb/instance.json`) are tracked on `staging`, never promoted, so
 * a commit is durable and protects them from a stray staging reset (the *conforming* audit is the
 * separate `panel` event the caller emits). MUST be called inside `lock.run` (it advances the
 * canonical branch directly; under the lock it is just another linear advance that stages cherry-pick
 * their disjoint work onto). A no-op write (identical bytes) commits nothing.
 */
// Exported for the #163 regression gate (boundedGit under the lock); `timeoutMs` defaults to the
// standard bound and is overridable so the test can drive the timeout fast.
export async function commitControlFile(root: string, absPath: string, message: string, timeoutMs?: number): Promise<void> {
  const git = boundedGit(root, timeoutMs); // #163: bounded — runs under the canonical-writer lock
  const rel = path.relative(root, absPath);
  await git.add(rel);
  // #517 BUG-10: scope BOTH the staged-check and the commit to `rel` — an unscoped `diff --cached` /
  // `commit` would (a) short-circuit `return` on someone ELSE's leftover staged file even when `rel`
  // itself has no change, or (b) silently sweep that leftover into this "control-panel: ..." commit.
  const staged = (await git.diff(['--cached', '--name-only', '--', rel])).trim();
  if (staged.length === 0) return; // nothing actually changed for THIS file
  await git.commit(`control-panel: ${message}`, rel);
}
