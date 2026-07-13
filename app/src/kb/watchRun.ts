// One folder-watch reconcile pass (SPEC-0037 WATCH-3/4/8/10) — the testable CORE, deliberately
// chokidar-free (the live watcher in watchScheduler just calls this). A pass scans the watched folder's
// current files, and for each non-ignored, non-symlink, regular file whose content is NEW or CHANGED
// (contentHash dedup vs the per-folder ledger) COPIES it into the KB as an immutable PRIMARY source via
// the ingest spine (`surface=watch:<id>`, origin:'external') — non-destructively (the original is never
// touched, WATCH-4). An unchanged file is a no-op; a changed file ingests a new source carrying the
// prior-source link (ratified Fork#1). The loop-guard (WATCH-10) refuses watching the vault/.kb/.git or
// an ancestor before any read. Mirrors intakeRun: failed ≠ empty (a read error is a distinct audited
// `watch-failed`, never a silent no-op; OBS-4); the ledger only advances for files actually ingested.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendAuditEvent } from './audit';
import { captureToInbox } from './ingest';
import type { Mutex } from './stageLock';
import {
  checkWatchLoopSafe,
  collectWatchedFiles,
  hashContent,
  moveOriginalToArchive,
  renderWatchSourceBody,
  isSafeWatchId,
  watchArchiveBase,
  watchDrains,
  type WatchFolderConfig,
} from './watchConnectors';

/** Per-folder dedup ledger (WATCH-8): basename → the last-ingested content hash + the source it produced.
 *  Lets an unchanged re-save be a no-op and a changed file link its new source to the prior. */
export type WatchLedger = Record<string, { hash: string; sourceId: string }>;

/** Absolute path to a watched folder's dedup ledger (`.kb/watch/<id>/seen.json`). Id is slug-guarded. */
export function watchLedgerPath(root: string, id: string): string {
  return path.join(path.resolve(root), '.kb', 'watch', id, 'seen.json');
}

export async function readWatchLedger(root: string, id: string): Promise<WatchLedger> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(watchLedgerPath(root, id), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as WatchLedger;
  } catch {
    /* missing/malformed → empty ledger */
  }
  return {};
}

export async function writeWatchLedger(root: string, id: string, ledger: WatchLedger): Promise<void> {
  const p = watchLedgerPath(root, id);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

export interface RunWatchDeps {
  /** The REAL vault root (Obsidian/promotion target) — the loop-guard checks the folder against this. */
  vaultRoot: string;
  /** Injectable ISO clock (deterministic tests). */
  now?: () => string;
  /** #517: the shared canonical-writer lock — serializes each ingested file's `captureToInbox` commit
   *  against stage advances/other writers on the same git index. Production (`WatchScheduler`) always
   *  supplies it; tests that don't exercise concurrent writers may omit it. */
  lock?: Mutex;
}

export interface RunWatchResult {
  /** PRIMARY source ids produced this pass. */
  sourceIds: string[];
  /** Files copied in as sources (new or changed). */
  ingested: number;
  /** Files seen but skipped (unchanged, ignored, symlink, directory, or a loop-refused subdir). */
  skipped: number;
  /** Originals moved out after a successful ingest (consume mode, WATCH-14). */
  movedOut?: number;
  /** Relative paths of subdirectories the per-descended-path loop-guard refused (WATCH-13). */
  refusedSubdirs?: string[];
  /** The loop-guard refused the folder (WATCH-10) — distinct from an empty pass. */
  refused?: boolean;
  /** The pass failed to read the folder (WATCH read error) — distinct from "nothing new" (OBS-4). */
  failed?: boolean;
  error?: string;
  note: string;
}

/** Decode bytes as UTF-8 text iff they carry no NUL in the first 8 KiB (a cheap binary sniff). A text
 *  file ingests as a markdown source (flows into Decompose); a binary copies as a file artifact. */
function asText(data: Uint8Array): string | null {
  const n = Math.min(data.length, 8192);
  for (let i = 0; i < n; i++) if (data[i] === 0) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/**
 * Copy ONE watched file into the KB as a primary source (non-destructive — reads, never moves/deletes).
 * Text files ingest as a rendered markdown source (provenance header + the prior-source link when
 * superseding); binary files ingest as the raw file artifact. `name` is the file's path RELATIVE to the
 * watched root (== basename when non-recursive) — it rides provenance/originalName; the on-disk raw
 * filename is reduced to an extension-only `raw.<ext>` by the ingest spine, so a nested relpath is
 * path-safe (never creates inbox subdirs). Returns the new source id.
 */
export async function ingestWatchedFile(
  root: string,
  c: WatchFolderConfig,
  name: string,
  data: Uint8Array,
  stampMs: number,
  fetchedAt: string,
  priorSourceId?: string,
  lock?: Mutex,
): Promise<string> {
  const text = asText(data);
  const surface = `watch:${c.id}`;
  const opts = { origin: 'external' as const, scope: c.scope, sensitivity: c.sensitivity };
  const doCapture = () =>
    text !== null
      ? captureToInbox(root, surface, [{ kind: 'text', text: renderWatchSourceBody(c, name, fetchedAt, { textContent: text, ...(priorSourceId ? { priorSourceId } : {}) }) }], stampMs, opts)
      : captureToInbox(root, surface, [{ kind: 'file', name, data }], stampMs, opts);
  // #517: serialize ONLY this commit against other writers on the same git index.
  const out = lock ? await lock.run(doCapture, surface) : await doCapture();
  return out.ids[0];
}

/**
 * Run one reconcile pass over `c.folderPath` (the restart-safe core — a startup reconcile and every live
 * chokidar event both route here). Loop-guarded (root AND every descended subdir, WATCH-13); recursive
 * within the configured depth cap or flat (WATCH-12); never follows symlinks. Dedup is two-layer:
 * contentHash is the dedup-of-record (identical content = ONE source regardless of path, WATCH-3/12), and
 * the relpath ledger tracks each path's last-seen content for independent change-detection. In consume
 * mode (WATCH-14) the original is MOVED out only AFTER a successful, non-destructive ingest. Always audits
 * (ingested / no-new / subdir-refused / refused / failed) so a pass is never silent (AUDIT-2/OBS-4).
 */
export async function reconcileWatchFolder(root: string, c: WatchFolderConfig, deps: RunWatchDeps): Promise<RunWatchResult> {
  if (!isSafeWatchId(c.id)) throw new Error(`reconcileWatchFolder: refusing unsafe watch id ${JSON.stringify(c.id)}`);
  const now = deps.now ?? (() => new Date().toISOString());

  // WATCH-10 loop-guard: refuse before any read (the vault/.kb/.git or an ancestor → ingest loop).
  const guard = await checkWatchLoopSafe(deps.vaultRoot, c.folderPath);
  if (!guard.ok) {
    await appendAuditEvent(root, { actor: 'watch', eventType: 'watch-refused', ts: now(), subjects: { watchId: c.id }, payload: { folderPath: c.folderPath, reason: guard.reason, why: 'folder-watch loop-guard (WATCH-10)' } });
    return { sourceIds: [], ingested: 0, skipped: 0, refused: true, note: `refused: ${guard.reason}` };
  }

  // Scan the folder (WATCH-12 — recursive within the depth cap, or Slice-1 flat). A ROOT read failure is a
  // distinct watch-failed (failed ≠ empty, OBS-4); subdir read errors / loop-refused subdirs are skips.
  let scan: import('./watchConnectors').WatchScanResult;
  try {
    scan = await collectWatchedFiles(deps.vaultRoot, c);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await appendAuditEvent(root, { actor: 'watch', eventType: 'watch-failed', ts: now(), subjects: { watchId: c.id }, payload: { folderPath: c.folderPath, error, why: 'folder-watch read failed' } });
    return { sourceIds: [], ingested: 0, skipped: 0, failed: true, error, note: `watch failed: ${error}` };
  }

  // Drain/consume (WATCH-16: drain is the DEFAULT — the folder empties like an inbox; `consume: false`
  // opts out into copy mode). Resolve the archive base once and confirm it is OUTSIDE the vault (a
  // misconfigured custom archiveDir inside the vault would pollute the KB) — else fall back to plain copy.
  const consume = watchDrains(c);
  let archiveBase: string | undefined;
  if (consume) {
    archiveBase = watchArchiveBase(c);
    try {
      const vaultReal = await fs.realpath(deps.vaultRoot);
      const a = path.resolve(archiveBase);
      if (a === vaultReal || a.startsWith(vaultReal + path.sep)) archiveBase = undefined; // refuse in-vault archive
    } catch {
      /* vault doesn't resolve — archive lives under the (already loop-safe) watched folder; keep it */
    }
  }

  const ledger = await readWatchLedger(root, c.id);
  // contentHash is the dedup-of-record (WATCH-3, KB-Lead's WATCH-12 refinement): identical CONTENT is ONE
  // source regardless of path — same bytes at two paths = one artifact, not two. The relpath ledger only
  // tracks each path's last-seen content (so distinct files at distinct paths change-track independently);
  // this reverse index maps a known contentHash → the source it already produced.
  const hashIndex = new Map<string, string>();
  for (const e of Object.values(ledger)) hashIndex.set(e.hash, e.sourceId);

  const sourceIds: string[] = [];
  const ingestedItems: Array<{ name: string; sourceId: string; priorSourceId?: string; movedTo?: string }> = [];
  let skipped = scan.skipped;
  let deduped = 0;
  let movedOut = 0;
  let ledgerDirty = false;
  let ingestFailure: string | undefined;
  let moveFailure: string | undefined;

  try {
    for (const f of scan.files) {
      const data = new Uint8Array(await fs.readFile(f.absPath));
      const hash = hashContent(data);
      const prior = ledger[f.relPath];
      if (prior && prior.hash === hash) { skipped++; continue; } // unchanged re-save at this path → no-op (WATCH-3/8)

      // contentHash dedup (WATCH-12): this exact content already produced a source (at this or another
      // path) → do NOT mint a second source. Record this path against the SAME source so it change-tracks,
      // but ingest nothing new. (A duplicate original is left in place even in consume mode — its content
      // is already preserved, and leaving it is the non-destructive choice for the ambiguous case.)
      const existing = hashIndex.get(hash);
      if (existing) {
        ledger[f.relPath] = { hash, sourceId: existing };
        ledgerDirty = true;
        deduped++;
        continue;
      }

      const fetchedAt = now();
      const stampMs = Date.parse(fetchedAt) || Date.now();
      // WATCH-14: copy into the KB FIRST — the source is committed/preserved before we ever touch the original.
      const sourceId = await ingestWatchedFile(root, c, f.relPath, data, stampMs, fetchedAt, prior?.sourceId, deps.lock);
      ledger[f.relPath] = { hash, sourceId };
      ledgerDirty = true;
      hashIndex.set(hash, sourceId);
      sourceIds.push(sourceId);
      const item: { name: string; sourceId: string; priorSourceId?: string; movedTo?: string } = { name: f.relPath, sourceId, ...(prior ? { priorSourceId: prior.sourceId } : {}) };

      // …THEN move the original out (consume). Reached ONLY after a successful ingest; a never-clobbering
      // MOVE, never a delete. A move failure leaves the original in place (safe — it's already in the KB)
      // and is audited; it never undoes the ingest nor fails the whole pass.
      if (consume && archiveBase) {
        try {
          item.movedTo = await moveOriginalToArchive(f.absPath, archiveBase, f.relPath);
          movedOut++;
        } catch (mErr) {
          if (!moveFailure) moveFailure = `archive move failed for ${f.relPath}: ${mErr instanceof Error ? mErr.message : String(mErr)}`;
        }
      }
      ingestedItems.push(item);
    }
  } catch (err) {
    // A copy/capture failed mid-pass (WATCH/INTAKE-12 parity): already-committed sources stay; record
    // the partial outcome + error, and only successfully-ingested files advance the ledger.
    ingestFailure = err instanceof Error ? err.message : String(err);
  }

  if (ledgerDirty) await writeWatchLedger(root, c.id, ledger);
  skipped += deduped; // a content-duplicate produced no new source — counted as skipped for the pass tally

  // Audit refused subdirs distinctly (WATCH-13) even on an otherwise-empty pass — never silent (OBS-4).
  if (scan.refusedSubdirs.length > 0) {
    await appendAuditEvent(root, { actor: 'watch', eventType: 'watch-subdir-refused', ts: now(), subjects: { watchId: c.id }, payload: { folderPath: c.folderPath, refusedSubdirs: scan.refusedSubdirs, why: 'per-descended-path loop-guard (WATCH-13)' } });
  }

  const partial = ingestFailure ?? moveFailure;

  if (ingestedItems.length === 0 && !ingestFailure) {
    await appendAuditEvent(root, { actor: 'watch', eventType: 'watch-no-new', ts: now(), subjects: { watchId: c.id }, payload: { folderPath: c.folderPath, skipped, ...(deduped > 0 ? { deduped } : {}), ...(scan.refusedSubdirs.length ? { refusedSubdirs: scan.refusedSubdirs } : {}), why: 'folder-watch pass — no new/changed files' } });
    return { sourceIds, ingested: 0, skipped, ...(scan.refusedSubdirs.length ? { refusedSubdirs: scan.refusedSubdirs } : {}), note: 'no new files' };
  }

  await appendAuditEvent(root, {
    actor: 'watch',
    eventType: 'watch-ingested',
    ts: now(),
    subjects: { watchId: c.id, ...(sourceIds[0] ? { sourceId: sourceIds[0] } : {}) },
    payload: {
      folderPath: c.folderPath,
      files: ingestedItems.map((f) => f.name),
      sourceIds,
      // carry the prior-source link for each changed (superseding) file (ratified Fork#1)
      supersedes: ingestedItems.filter((f) => f.priorSourceId).map((f) => ({ name: f.name, priorSourceId: f.priorSourceId, sourceId: f.sourceId })),
      // consume/move-out provenance (WATCH-14): where each original was archived to
      ...(movedOut > 0 ? { movedOut, archivedTo: ingestedItems.filter((f) => f.movedTo).map((f) => ({ name: f.name, movedTo: f.movedTo })) } : {}),
      ...(deduped > 0 ? { deduped } : {}), // content-identical files that mapped to an existing source (WATCH-12)
      ...(scan.refusedSubdirs.length ? { refusedSubdirs: scan.refusedSubdirs } : {}),
      ...(partial ? { partialFailure: partial } : {}),
      why: 'folder-watch arrival (non-destructive copy → primary source)',
    },
  });

  return {
    sourceIds,
    ingested: ingestedItems.length,
    skipped,
    ...(movedOut > 0 ? { movedOut } : {}),
    ...(scan.refusedSubdirs.length ? { refusedSubdirs: scan.refusedSubdirs } : {}),
    // Only an INGEST failure flags the pass failed; a best-effort consume-move miss is surfaced in the note.
    ...(ingestFailure ? { failed: true, error: ingestFailure } : {}),
    note: `${ingestedItems.length} ingested, ${skipped} skipped${movedOut > 0 ? `, ${movedOut} moved out` : ''}${partial ? ` (partial: ${partial})` : ''}`,
  };
}
