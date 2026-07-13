// Capture domain (SPEC-0013): preservation-first arrival. Each payload becomes its own
// immutable inbox unit and the batch is committed BEFORE any processing (CAPTURE-3).
// Shell-agnostic (no electron import) — the IPC layer reads dropped-file bytes and hands
// them here. The archivist (orchestrator.ts) later moves units into `sources/`.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ulid, isUlid } from './ulid';
import { boundedGit } from './canonicalAdvance';
import { ensureGitIdentity } from './vault';
import { mimeForName, rawNameFor } from './media';
import { appendAuditEvent } from './audit';
import type { ResearchProvenance } from './researchers';

export interface TextPayload {
  kind: 'text';
  text: string; // the captured payload (Markdown for a rich paste — RICHIN-1)
  /** Original clipboard HTML to preserve verbatim as an `original.html` sidecar (RICHIN-2);
   *  present only for a rich paste whose markup added structure over the plain text. */
  html?: string;
}
export interface FilePayload {
  kind: 'file';
  name: string; // original filename
  data: Uint8Array; // raw bytes (read by the IPC layer)
}
export type CapturePayload = TextPayload | FilePayload;

/** Capture-fidelity provenance for a derived text payload (RICHIN-10): how `raw.md` was
 *  produced and where the verbatim original lives. Recorded in the captured event + `source.md`. */
export interface ClipProvenance {
  format: 'html→md'; // (conversation parsing is a later RICHIN slice)
  original: string; // sidecar filename holding the verbatim source bytes (e.g. `original.html`)
}

/** Filename of the verbatim original-clipboard sidecar written next to a rich paste's `raw.md`. */
export const ORIGINAL_HTML_SIDECAR = 'original.html';

/** The `captured` event written to each unit's `audit.jsonl`; the archivist reads it to
 *  build `source.md`. `source.md` = identity; `audit.jsonl` = history (SPEC-0013 §3). */
export interface CapturedMeta {
  id: string;
  kind: 'text' | 'file';
  raw: string; // raw filename inside the unit
  contentHash: string; // `sha256:<hex>`
  capturedAt: string; // ISO 8601
  surface: string;
  captureBatch: string; // links payloads from one capture gesture (CAPTURE-14)
  origin?: 'principal' | 'external' | 'secondary'; // who produced it; defaults to principal (DATA-2/5). `secondary` = a researcher finding (SPEC-0028 RESEARCH-5)
  // Connector-supplied classification hint (SCOPE-14 / SPEC-0041 INTAKE-9): a high-confidence
  // scope/sensitivity signal the producing surface declares (e.g. an intake connector's defaults).
  // The archivist's decider prefers these over its conservative fallback so a connector's
  // `confidential` default lands on the source rather than being silently down-classified.
  scope?: string;
  sensitivity?: string;
  originalName?: string;
  mimeType?: string;
  bytes?: number;
  /** Capture-fidelity provenance for a derived text payload (RICHIN-10); present only when
   *  the payload was normalized from richer markup (rich paste), so the derivation is auditable. */
  clip?: ClipProvenance;
  /** Citation-rich research provenance, present on a `secondary` source (RESEARCH-6). */
  research?: ResearchProvenance;
}

/** Optional capture attributes — who produced it + (for secondary sources) research provenance. */
export interface CaptureOpts {
  origin?: CapturedMeta['origin'];
  research?: ResearchProvenance;
  /** Connector-supplied classification hint (SCOPE-14 / INTAKE-9) — the archivist decider prefers it. */
  scope?: string;
  sensitivity?: string;
  /** Override the git block-timeout (#163); defaults to boundedGit's standard bound. Tests drive it fast. */
  timeoutMs?: number;
}

export interface CaptureOutcome {
  ids: string[];
  captureBatch: string;
  committed: boolean;
}

function sha256(data: Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

/**
 * Write each payload as an immutable `inbox/<ULID>/` unit and commit the batch.
 * Add-only + globally-unique ULIDs ⇒ never conflicts with archiving or other captures
 * (CAPTURE-5). One unit per payload, all sharing a `captureBatch` (CAPTURE-14).
 */
export async function captureToInbox(
  root: string,
  surface: string,
  payloads: CapturePayload[],
  now: number = Date.now(),
  opts: CaptureOpts = {},
): Promise<CaptureOutcome> {
  if (payloads.length === 0) throw new Error('captureToInbox: nothing to capture');
  root = path.resolve(root);
  const captureBatch = ulid(now);
  const capturedAt = new Date(now).toISOString();
  const ids: string[] = [];
  const dirsWritten: string[] = []; // #516 BUG-9: cleaned up if the commit below fails

  for (const p of payloads) {
    const id = ulid(now);
    const dir = path.join(root, 'inbox', id);
    dirsWritten.push(dir);
    await fs.mkdir(dir, { recursive: true });

    let meta: CapturedMeta;
    if (p.kind === 'text') {
      const data = new TextEncoder().encode(p.text);
      // Save typed notes as Markdown so Obsidian renders them (text is valid Markdown).
      await fs.writeFile(path.join(dir, 'raw.md'), p.text, 'utf8');
      // RICHIN-2: a rich paste preserves the original clipboard bytes verbatim as a sidecar —
      // conversion is therefore non-destructive and re-derivable (the source of truth is kept).
      let clip: ClipProvenance | undefined;
      if (p.html && p.html.length > 0) {
        await fs.writeFile(path.join(dir, ORIGINAL_HTML_SIDECAR), p.html, 'utf8');
        clip = { format: 'html→md', original: ORIGINAL_HTML_SIDECAR };
      }
      meta = {
        id,
        kind: 'text',
        raw: 'raw.md',
        contentHash: sha256(data),
        capturedAt,
        surface,
        captureBatch,
        mimeType: 'text/markdown',
        ...(clip ? { clip } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.scope ? { scope: opts.scope } : {}),
        ...(opts.sensitivity ? { sensitivity: opts.sensitivity } : {}),
        ...(opts.research ? { research: opts.research } : {}),
      };
    } else {
      const raw = rawNameFor(p.name);
      await fs.writeFile(path.join(dir, raw), Buffer.from(p.data));
      meta = {
        id,
        kind: 'file',
        raw,
        contentHash: sha256(p.data),
        capturedAt,
        surface,
        captureBatch,
        originalName: p.name,
        mimeType: mimeForName(p.name),
        bytes: p.data.byteLength,
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.scope ? { scope: opts.scope } : {}),
        ...(opts.sensitivity ? { sensitivity: opts.sensitivity } : {}),
        ...(opts.research ? { research: opts.research } : {}),
      };
    }
    await fs.writeFile(path.join(dir, 'audit.jsonl'), JSON.stringify({ action: 'captured', ...meta }) + '\n', 'utf8');
    ids.push(id);
  }

  // CAPTURE-3: commit the raw units before anything processes them. Add-only — staging
  // just `inbox` keeps capture from sweeping up unrelated working state.
  const git = boundedGit(root, opts.timeoutMs); // #163: bounded — runs under the canonical-writer lock
  await ensureGitIdentity(git);
  try {
    await git.raw('add', 'inbox');
    await git.commit(`capture: ${payloads.length} item(s) [${surface}]`);
  } catch (err) {
    // #516 BUG-9: the commit failed AFTER the unit files were already written to disk. Left in place,
    // they'd sit as orphaned UNCOMMITTED litter — invisible to `readQueue` (git-blind) but silently
    // swept up and rescue-committed by the NEXT successful capture's `git add inbox` (which stages the
    // whole inbox tree, not just its own new files) under an unrelated commit message, while the UI
    // already told the Principal THIS capture failed — a re-capture then mints a duplicate. The bytes
    // are still in the user's hands at this surface (clipboard/dropped file), so removing the
    // half-committed unit is safe: nothing is lost that the commit failure hadn't already lost.
    for (const dir of dirsWritten) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return { ids, captureBatch, committed: true };
}

/** Read the `captured` event back from a unit's `audit.jsonl` (first line). */
export async function readCapturedMeta(unitDir: string): Promise<CapturedMeta> {
  const raw = await fs.readFile(path.join(unitDir, 'audit.jsonl'), 'utf8');
  const first = raw.split('\n').find((l) => l.trim().length > 0);
  if (!first) throw new Error(`no captured event in ${unitDir}/audit.jsonl`);
  const obj = JSON.parse(first) as Partial<CapturedMeta> & { action?: string };
  if (!obj.id || !obj.kind || !obj.raw) throw new Error(`malformed captured event in ${unitDir}`);
  return obj as CapturedMeta;
}

// #516 BUG-3: a foreign drop bigger than this is REFUSED (audited `capture-refused`), never attempted —
// `fs.readFile`ing a multi-GiB file risks Node's own Buffer-size ceiling throwing mid-read, and that
// throw used to propagate straight out of normalizeInbox (called under `lock.run('normalize')` in
// drainOnce with no try/catch at all): ONE oversized drop wedged the entire archive drain permanently,
// not just that file — every subsequent poke/sweep re-hit the same throw before the queue was ever even
// read. 2GiB comfortably clears any real capture while staying well under Node's Buffer ceiling.
export const MAX_FOREIGN_DROP_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Adopt foreign drops (SPEC-0014 ORCH-14): the inbox is a contract that also accepts loose
 * files dropped by another app / directly on disk (no ULID, no audit). Wrap each into a
 * canonical `inbox/<ULID>/` unit (`origin: external`, `surface: folder-drop`) and commit,
 * so the archivist can process them like any capture. Idempotent: canonical `<ULID>/`
 * units are left untouched. Returns the ids minted this pass.
 *
 * #516 BUG-3: each file is isolated (its own try/catch) — an oversized or otherwise-unreadable drop is
 * audited + skipped, never a whole-pass throw that would wedge archiving entirely (the "ingestion halts
 * entirely at cap=1" failure mode this bug produced). `maxBytes` defaults to {@link
 * MAX_FOREIGN_DROP_BYTES}; injectable so tests can exercise the refusal path without a real multi-GiB file.
 */
export async function normalizeInbox(root: string, now: number = Date.now(), maxBytes: number = MAX_FOREIGN_DROP_BYTES): Promise<string[]> {
  root = path.resolve(root);
  const inbox = path.join(root, 'inbox');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(inbox, { withFileTypes: true });
  } catch {
    return [];
  }

  const minted: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // skip hidden/system files (e.g. .DS_Store)
    if (e.isDirectory() && isUlid(e.name)) continue; // already a canonical unit
    if (!e.isFile()) continue; // non-canonical dirs: left for the archivist's failure path

    const srcPath = path.join(inbox, e.name);
    let dir: string | undefined;
    try {
      const stat = await fs.stat(srcPath);
      if (stat.size > maxBytes) {
        await appendAuditEvent(root, {
          actor: 'archivist',
          subjects: {},
          eventType: 'capture-refused',
          payload: { name: e.name, bytes: stat.size, capBytes: maxBytes, reason: 'exceeds the per-file ingest size cap', why: 'folder-drop normalize (ORCH-14)' },
        });
        continue; // never attempted — the original is left untouched (still on disk, never lost)
      }

      const id = ulid(now);
      dir = path.join(inbox, id);
      await fs.mkdir(dir, { recursive: true });
      const raw = rawNameFor(e.name);
      const data = await fs.readFile(srcPath);

      const meta: CapturedMeta = {
        id,
        kind: 'file',
        raw,
        contentHash: sha256(data),
        capturedAt: new Date(now).toISOString(),
        surface: 'folder-drop',
        captureBatch: id,
        origin: 'external',
        originalName: e.name,
        mimeType: mimeForName(e.name),
        bytes: data.byteLength,
      };
      // Write the canonical unit fully BEFORE removing the original — the raw bytes are
      // never at risk (the original survives until its copy + audit are on disk).
      await fs.writeFile(path.join(dir, raw), data);
      await fs.writeFile(path.join(dir, 'audit.jsonl'), JSON.stringify({ action: 'captured', ...meta }) + '\n', 'utf8');
      await fs.rm(srcPath);
      minted.push(id);
    } catch (err) {
      // A per-file failure (unreadable, vanished mid-scan, a write hiccup, …) is isolated — the
      // original stays exactly where it was (never partially adopted), and every OTHER file in this
      // pass still normalizes. Clean up any half-written unit dir so it never sits as orphaned litter.
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await appendAuditEvent(root, {
        actor: 'archivist',
        subjects: {},
        eventType: 'capture-refused',
        payload: { name: e.name, reason: err instanceof Error ? err.message : String(err), why: 'folder-drop normalize (ORCH-14)' },
      }).catch(() => {}); // audit is best-effort transparency; never let it mask the original skip
    }
  }

  if (minted.length > 0) {
    const git = boundedGit(root); // #163: bounded — runs under the canonical-writer lock
    await ensureGitIdentity(git);
    await git.raw('add', 'inbox');
    await git.commit(`normalize: ${minted.length} foreign drop(s)`);
  }
  return minted;
}
