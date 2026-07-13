// The derived, rebuildable activity index (SPEC-0029 AUDIT-4).
//
// Per-item `audit.jsonl` stays the SINGLE SOURCE OF TRUTH (DATA-10). This module aggregates those
// files into one time-ordered stream of canonical `AuditEvent`s (via `audit.ts`'s normalizer) and
// caches it under `.kb/cache/` — the working zone: gitignored (vault `.gitignore` lists
// `.kb/cache/`), never promoted to `main` (not in EVERGREEN_PATHS), and replay-safe because it is
// rebuilt from the audit, never a second source of truth (STAGING-6; realizes the SPEC-0014
// deferred "audit global index" without a double-write).
//
// ROOT-AGNOSTIC, like every stage helper: in production the IPC layer passes the persistent
// `staging` worktree as `root` (where the full working-zone history lives — `.kb/jobs`, `connect/`,
// candidates, plus the evergreen `sources/`), satisfying AUDIT-10. Tests pass a temp vault.
//
// The feed shows the FULL append-only history, window-capped to the recent N events (AUDIT-5 +
// open-Q Q3: cap the index, never the per-item audit; surface truncation — no silent caps).
// `replay-reset` markers ride the stream inline as boundary events, so the timeline stays an honest
// immutable record (AUDIT-3) rather than hiding superseded generations.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeAuditLine, CONTROL_AUDIT_REL, type AuditEvent, type AuditActor, type NormalizeContext } from './audit';
import { fastHeadSha } from './gitHeadFast';

/** Bump when the cached shape changes so a stale cache from an older build is discarded. */
export const ACTIVITY_INDEX_VERSION = 1;

/** Default cap on how many (most-recent) events the index holds (open-Q Q3). */
export const DEFAULT_INDEX_WINDOW = 1000;

/** Vault-relative location of the cached index (working zone — gitignored, never promoted). */
export const ACTIVITY_INDEX_REL = path.join('.kb', 'cache', 'activity-index.json');

/** The cached, time-ordered activity index. `events` are newest-first. */
export interface ActivityIndex {
  /** Cache-shape version (see ACTIVITY_INDEX_VERSION). */
  version: number;
  /** When this index was built (ISO-8601; injectable clock in tests). */
  builtAt: string;
  /** The git HEAD of `root` the index was built from, for cheap freshness checks (null if none). */
  head: string | null;
  /** Total conforming events seen across all audit files (before the window cap). */
  total: number;
  /** True when `total` exceeded the window and older events were dropped from THIS index. */
  truncated: boolean;
  /** The events, newest-first, capped to the window. */
  events: AuditEvent[];
}

export interface BuildOptions {
  /** Cap on retained events (newest-first). Defaults to DEFAULT_INDEX_WINDOW. */
  window?: number;
  /** Injectable clock for `builtAt` (deterministic tests). */
  now?: () => string;
}

/** One audit file to read, with the path-derived hints its lines may need. */
interface AuditFile {
  /** Absolute path on disk. */
  abs: string;
  /** Vault-relative path (used as provenance). */
  rel: string;
  /** Source id when under `sources/<shard>/<id>/`. */
  sourceId?: string;
  /** Job id when it is a `.kb/jobs/<jobId>/journal.jsonl`. */
  jobId?: string;
}

/** Recursively collect file paths under `dir` whose basename equals `name`. Missing dir → []. */
async function findFiles(dir: string, name: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // absent tree — nothing to read
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findFiles(p, name)));
    else if (e.isFile() && e.name === name) out.push(p);
  }
  return out;
}

/** Collect every `*.jsonl` file directly under `dir` (the connect/blocks layout is flat). Missing
 *  dir → []. Sorted for a deterministic, reproducible read order (AUDIT-4). */
async function findJsonlFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // absent tree — nothing to read
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(dir, e.name))
    .sort();
}

/** Enumerate every audit/journal file in the vault, tagged with its path-derived hints. */
async function listAuditFiles(root: string): Promise<AuditFile[]> {
  const files: AuditFile[] = [];

  // sources/<shard>/<id>/audit.jsonl — the source id is the parent dir name.
  for (const abs of await findFiles(path.join(root, 'sources'), 'audit.jsonl')) {
    files.push({ abs, rel: path.relative(root, abs), sourceId: path.basename(path.dirname(abs)) });
  }
  // connect/audit.jsonl — the legacy stage-wide log (link reviews + pre-SCALE-5 resolves still
  // append here). No per-item subject from the path; the line's own `node`/subjects carry it.
  const connectAbs = path.join(root, 'connect', 'audit.jsonl');
  if (await fileExists(connectAbs)) files.push({ abs: connectAbs, rel: path.relative(root, connectAbs) });
  // connect/blocks/*.jsonl — SCALE-5 split the RESOLVE (entity-merge) audit per block so concurrent
  // resolve commits touch disjoint paths. Those per-block files hold connect's actual merge
  // transformations; without reading them, connect is invisible to the feed/lineage/source-trace
  // whenever cap>1 (the post-SCALE default). Enumerate every .jsonl under connect/blocks/.
  for (const abs of await findJsonlFiles(path.join(root, 'connect', 'blocks'))) {
    files.push({ abs, rel: path.relative(root, abs) });
  }

  // .kb/jobs/<jobId>/journal.jsonl — the job id is the parent dir name.
  for (const abs of await findFiles(path.join(root, '.kb', 'jobs'), 'journal.jsonl')) {
    files.push({ abs, rel: path.relative(root, abs), jobId: path.basename(path.dirname(abs)) });
  }
  // .kb/cache/ask/audit.jsonl — recall transparency log (working zone, gitignored; CANON-8/9).
  const askAbs = path.join(root, '.kb', 'cache', 'ask', 'audit.jsonl');
  if (await fileExists(askAbs)) files.push({ abs: askAbs, rel: path.relative(root, askAbs) });

  // .kb/audit.jsonl — cross-cutting control log (the Control Panel's Principal config changes).
  const controlAbs = path.join(root, CONTROL_AUDIT_REL);
  if (await fileExists(controlAbs)) files.push({ abs: controlAbs, rel: path.relative(root, controlAbs) });

  return files;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse + normalize a chunk of raw audit lines into canonical events (skipping malformed/foreign).
 *  `lineOffset` is the physical line number the chunk STARTS at (0 for a full-file read, or however
 *  many raw lines the file's cached prefix already consumed for an incremental delta read). */
function parseAuditLines(raw: string, f: AuditFile, lineOffset: number): AuditEvent[] {
  const out: AuditEvent[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue; // malformed line — never an event
    }
    const ctx: NormalizeContext = { file: f.rel, line: lineOffset + i, sourceId: f.sourceId, jobId: f.jobId };
    const ev = normalizeAuditLine(parsed, ctx);
    if (ev) out.push(ev);
  }
  return out;
}

/** #508 item 3: audit files are APPEND-ONLY by construction (every writer in this codebase only ever
 *  `fs.appendFile`s a new JSONL line) — so re-reading a file's full content on every activity-index
 *  rebuild is wasted work once we already have its earlier bytes parsed. This in-process cache tracks,
 *  per (root, file rel-path), how many bytes + raw lines were already consumed and the events already
 *  parsed from them; a later read of the same file re-reads ONLY the bytes appended since. Keyed by
 *  root so multiple vaults (tests) never collide; never evicted (bounded by "one entry per audit file
 *  this process has ever read" — one vault's worth in production). */
interface FileReadCacheEntry {
  size: number; // bytes of `abs` already consumed
  rawLines: number; // raw (pre-filter) lines already consumed — keeps provenance.line numbering accurate
  events: AuditEvent[]; // events parsed from those bytes
}
const fileReadCache = new Map<string, Map<string, FileReadCacheEntry>>();

/** Read the bytes of `abs` in `[fromByte, toByte)`. A write mid-line at the tail is common (a torn
 *  read of a line still being appended) — only bytes up to the LAST complete `\n` are consumed; the
 *  torn remainder is left for the next read (never silently dropped). */
async function readFileByteRange(abs: string, fromByte: number, toByte: number): Promise<{ text: string; newSize: number }> {
  if (toByte <= fromByte) return { text: '', newSize: fromByte };
  const fh = await fs.open(abs, 'r');
  try {
    const len = toByte - fromByte;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, fromByte);
    const chunk = buf.toString('utf8', 0, bytesRead);
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl === -1) return { text: '', newSize: fromByte }; // no complete line yet
    const complete = chunk.slice(0, lastNl + 1);
    return { text: complete, newSize: fromByte + Buffer.byteLength(complete, 'utf8') };
  } finally {
    await fh.close();
  }
}

/** Read one audit file through the incremental cache: a byte-identical file (common on an idle poll)
 *  costs a single `fs.stat`, zero content reads; a grown file re-reads only its new bytes. New files
 *  and shrunk/replaced files (not the append-only steady state) fall through to a full re-read from
 *  byte 0 — but STILL via {@link readFileByteRange}'s torn-tail guard, so a full read that happens to
 *  land mid-write doesn't advance the cursor past bytes it never actually parsed (losing that line
 *  forever once the cursor moves past it — the risk a naive `size = fs.stat().size` would create). */
async function readAuditFileIncremental(root: string, f: AuditFile): Promise<AuditEvent[]> {
  let rootCache = fileReadCache.get(root);
  if (!rootCache) {
    rootCache = new Map();
    fileReadCache.set(root, rootCache);
  }
  const prior = rootCache.get(f.rel);
  let fileSize: number;
  try {
    fileSize = (await fs.stat(f.abs)).size;
  } catch {
    rootCache.delete(f.rel); // vanished — drop any stale entry
    return [];
  }
  if (prior && prior.size === fileSize) return prior.events; // unchanged — zero content read
  const growing = prior !== undefined && fileSize >= prior.size;
  const fromByte = growing ? prior.size : 0; // shrink/replace/new-file → re-read from scratch
  const basePrior = growing ? prior : undefined;
  const { text, newSize } = await readFileByteRange(f.abs, fromByte, fileSize);
  if (text.length === 0) {
    // No NEW complete line since last time (a torn tail, mid-write) — nothing to update yet.
    if (basePrior) return basePrior.events;
    rootCache.set(f.rel, { size: fromByte, rawLines: 0, events: [] });
    return [];
  }
  const deltaLines = text.split('\n').length;
  const deltaEvents = parseAuditLines(text, f, basePrior?.rawLines ?? 0);
  const events = basePrior ? [...basePrior.events, ...deltaEvents] : deltaEvents;
  rootCache.set(f.rel, { size: newSize, rawLines: (basePrior?.rawLines ?? 0) + deltaLines, events });
  return events;
}

/** Read + normalize EVERY conforming audit event in the vault, newest-first. Unbounded — callers
 *  that want the bounded feed use {@link buildActivityIndex}; lineage uses this directly. Each file is
 *  read through the incremental cache (#508 item 3) — an unchanged file costs one `fs.stat`. */
export async function readAllAuditEvents(root: string): Promise<AuditEvent[]> {
  root = path.resolve(root);
  const files = await listAuditFiles(root);
  const all: AuditEvent[] = [];
  for (const f of files) all.push(...(await readAuditFileIncremental(root, f)));
  all.sort(byTsDescending);
  return all;
}

/** Newest-first ordering. Ties broken by file+line so a rebuild is deterministic (AUDIT-4). */
function byTsDescending(a: AuditEvent, b: AuditEvent): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  if (a.provenance.file !== b.provenance.file) return a.provenance.file < b.provenance.file ? 1 : -1;
  return b.provenance.line - a.provenance.line;
}

/** Read the current git HEAD of `root` for the freshness key; null when not a git repo / no commits.
 *  Spawn-free (#506/#508's `fastHeadSha`) with a git-spawn fallback on any unrecognized on-disk shape —
 *  and that fallback (`canonicalHead`) is itself now bounded (#515), so an off-lock read against a
 *  wedged repo still can't silently hang the feed even on the fallback path. */
async function readHead(root: string): Promise<string | null> {
  try {
    return await fastHeadSha(root);
  } catch {
    return null;
  }
}

/**
 * Build the activity index from scratch (AUDIT-4) — the always-correct, replay-safe path. Reads
 * every audit file, normalizes, sorts newest-first, and caps to the recent window (surfacing
 * `truncated` + `total` so a capped feed is never silently truncated). Deterministic: same audit
 * on disk → identical index (modulo `builtAt`).
 */
export async function buildActivityIndex(root: string, opts: BuildOptions = {}): Promise<ActivityIndex> {
  root = path.resolve(root);
  const window = opts.window ?? DEFAULT_INDEX_WINDOW;
  const now = opts.now ?? (() => new Date().toISOString());
  const all = await readAllAuditEvents(root);
  const total = all.length;
  const truncated = total > window;
  return {
    version: ACTIVITY_INDEX_VERSION,
    builtAt: now(),
    head: await readHead(root),
    total,
    truncated,
    events: truncated ? all.slice(0, window) : all,
  };
}

/** Persist the index to the gitignored cache. Best-effort callers should catch; we surface errors. */
export async function writeActivityIndexCache(root: string, index: ActivityIndex): Promise<void> {
  const file = path.join(path.resolve(root), ACTIVITY_INDEX_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(index), 'utf8');
}

/** Read the cached index, or null when absent/unreadable/stale-shape. */
export async function readActivityIndexCache(root: string): Promise<ActivityIndex | null> {
  const file = path.join(path.resolve(root), ACTIVITY_INDEX_REL);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as ActivityIndex;
    if (parsed.version !== ACTIVITY_INDEX_VERSION) return null; // shape changed — discard
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load the index, rebuilding only when stale (AUDIT-4 freshness; open-Q Q2 "HEAD-poke + full
 * rebuild"). The cache is fresh iff its `head` equals `root`'s current git HEAD AND its window is
 * at least the requested one — a HEAD-poke is cheap and mirrors ORCH-15. A full rebuild is always
 * available via {@link buildActivityIndex} and is the fallback whenever HEAD is unavailable.
 */
export async function loadActivityIndex(root: string, opts: BuildOptions = {}): Promise<ActivityIndex> {
  root = path.resolve(root);
  const window = opts.window ?? DEFAULT_INDEX_WINDOW;
  const cached = await readActivityIndexCache(root);
  if (cached) {
    const head = await readHead(root);
    // Fresh only when we have a real HEAD that matches, and the cache isn't narrower than asked.
    const windowOk = cached.events.length >= window || !cached.truncated;
    if (head !== null && cached.head === head && windowOk) return cached;
  }
  const fresh = await buildActivityIndex(root, opts);
  await writeActivityIndexCache(root, fresh).catch(() => {
    /* cache is an optimization; a read-only / racing FS must not fail the read */
  });
  return fresh;
}

// ── Filter / search (AUDIT-7) ──────────────────────────────────────────────────────────────────

export interface ActivityFilter {
  /** Restrict to these actors (any-of). */
  actors?: readonly AuditActor[];
  /** Restrict to these event-types (any-of). */
  eventTypes?: readonly string[];
  /** Match events touching this subject id (any subject field). */
  subjectId?: string;
  /** Inclusive lower bound on `ts` (ISO-8601). */
  since?: string;
  /** Inclusive upper bound on `ts` (ISO-8601). */
  until?: string;
  /** Case-insensitive free-text over actor, event-type, subjects, model, and payload. */
  text?: string;
}

/** True if `event` has `id` in any of its subject fields. */
function touchesSubject(event: AuditEvent, id: string): boolean {
  return Object.values(event.subjects).some((v) => v === id);
}

/** Lowercased haystack of an event's searchable text. */
function haystack(event: AuditEvent): string {
  return [event.actor, event.eventType, event.model ?? '', event.runId ?? '', Object.values(event.subjects).join(' '), JSON.stringify(event.payload)]
    .join(' ')
    .toLowerCase();
}

/** Read + filter all audit events in one call (AUDIT-7) — the convenience the Control Panel and the
 *  Activity view read through. Newest-first. For large vaults the cached {@link loadActivityIndex}
 *  feed is cheaper; this reads the full audit, so prefer it for targeted filters (e.g. one job). */
export async function readEvents(root: string, filter: ActivityFilter = {}): Promise<AuditEvent[]> {
  return filterEvents(await readAllAuditEvents(root), filter);
}

/** Apply a filter to an event stream (AUDIT-7). Pure; preserves input order. */
export function filterEvents(events: readonly AuditEvent[], filter: ActivityFilter = {}): AuditEvent[] {
  const text = filter.text?.trim().toLowerCase();
  return events.filter((e) => {
    if (filter.actors && filter.actors.length > 0 && !filter.actors.includes(e.actor)) return false;
    if (filter.eventTypes && filter.eventTypes.length > 0 && !filter.eventTypes.includes(e.eventType)) return false;
    if (filter.subjectId && !touchesSubject(e, filter.subjectId)) return false;
    if (filter.since && e.ts < filter.since) return false;
    if (filter.until && e.ts > filter.until) return false;
    if (text && !haystack(e).includes(text)) return false;
    return true;
  });
}
