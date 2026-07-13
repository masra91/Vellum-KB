// Control Panel · source sensitivity override (SENSE-7/8/10) — Principal override of a source's
// sensitivity label. Extracted out of pipeline.ts (#528 ENG-7). NOT a registry-CRUD shape (there's no
// list to patch/upsert against — it re-stamps one source file + a sticky override store); kept as its
// own small module rather than folded into intakeControlPanel.ts, which it was previously sandwiched
// inside despite being an unrelated feature (SENSE, not INTAKE-14).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Mutex } from '../../kb/stageLock';
import { boundedGit } from '../../kb/canonicalAdvance';
import { dateShard, isUlid } from '../../kb/ulid';
import { setSensitivityOverride, sensitivityOverridesPath } from '../../kb/sensitivityOverride';
import { readSourceSensitivities, type SourceSensitivity } from '../../kb/sensitivityRead';
import { applySensitivityOverrideToSourceMd } from '../../kb/sourceDoc';
import { appendAuditEvent } from '../../kb/audit';

export interface SensitivityCtx {
  root: string;
  lock: Mutex;
}

/**
 * Principal override of a source's sensitivity label (SENSE-7/8). Validates the id is a real archived
 * source; under the canonical-writer lock it (1) persists the override to the Replay-sticky store so a
 * rebuild re-applies it (the classifier never overwrites a `by: principal` label), (2) re-stamps the
 * source's `source.md` frontmatter to the new label + `by: principal` (committing both atomically), then
 * (3) audits the change (`panel` event, from→to + why, SENSE-8). An empty label CLEARS the override (back
 * to the classifier/default). A custom label is accepted verbatim (SENSE-1); the comparator handles unknowns.
 */
export async function setSourceSensitivity(sourceId: string, label: string, ctx: SensitivityCtx): Promise<{ ok: boolean; reason?: string; sensitivity?: string }> {
  const { root, lock } = ctx;
  if (typeof sourceId !== 'string' || !isUlid(sourceId)) return { ok: false, reason: 'bad-id' }; // #29: only a real ULID → a real source path
  const clean = typeof label === 'string' ? label.trim() : '';
  const srcMdRel = path.join('sources', dateShard(sourceId), sourceId, 'source.md');
  const srcMdAbs = path.join(root, srcMdRel);
  try {
    await fs.access(srcMdAbs); // early not-found before taking the lock
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  const at = new Date().toISOString();
  let fromLabel = '';
  await lock.run(async () => {
    // Read the authoritative base INSIDE the lock so a concurrent archive of the same source can't make
    // the re-stamp clobber a stale base (KB-QD-2 #267).
    const before = await fs.readFile(srcMdAbs, 'utf8');
    fromLabel = (before.match(/^sensitivity: (.*)$/m)?.[1] ?? '').trim();
    await setSensitivityOverride(root, sourceId, clean, at); // clean === '' clears the override
    // Setting: re-stamp the live source.md now so the Panel reflects it without a rebuild. Clearing: leave
    // the frontmatter as-is (a later Replay re-derives the classifier/default label).
    if (clean.length > 0) await fs.writeFile(srcMdAbs, applySensitivityOverrideToSourceMd(before, clean, at), 'utf8');
    const git = boundedGit(root);
    await git.add([path.relative(root, sensitivityOverridesPath(root)), srcMdRel]);
    const staged = (await git.diff(['--cached', '--name-only'])).trim();
    if (staged.length > 0) await git.commit(`control-panel: sensitivity ${sourceId} → ${clean || '(cleared)'}`);
  }, 'sensitivity-override:write');
  await appendAuditEvent(root, {
    actor: 'panel',
    eventType: 'sensitivity-override',
    subjects: { sourceId },
    payload: { field: 'sensitivity', from: fromLabel, to: clean || '(cleared → classifier/default)', by: 'principal', why: 'Principal overrode a source sensitivity via Control Panel' },
  });
  return { ok: true, sensitivity: clean || fromLabel };
}

/** Read the current sensitivity label + provenance for a set of sources (SENSE-10) — for the Control
 *  Panel (the Activity-lineage drill-down) to show a chip + offer the Principal an edit. Read-only. */
export async function getSourceSensitivities(root: string, sourceIds: string[]): Promise<Record<string, SourceSensitivity>> {
  if (!Array.isArray(sourceIds)) return {};
  return readSourceSensitivities(root, sourceIds.filter((s): s is string => typeof s === 'string'));
}
