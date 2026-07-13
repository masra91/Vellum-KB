// Diagnostic dev-log (SPEC-0030 OBS-1/2) — a minimal, in-house, leveled + size-rotated JSONL
// logger for OPERATIONAL diagnostics (exceptions/stack traces, subprocess stderr, git/worktree/
// lock detail, timings). Deliberately separate from the knowledge AUDIT (SPEC-0029): audit is
// curated knowledge lineage; this is the verbose cause behind a failure. No dependency (E1) —
// pino/winston would be overkill for an append-only JSONL sink.
//
// Cross-links to the audit by `runId`/`itemId` (OBS-3): bind them via `.child({runId, itemId})`
// so every diagnostic line carries the same ids as the structured audit event it explains.
//
// Logging must NEVER throw into the pipeline: methods return void and enqueue writes on a
// serialized, self-swallowing chain. Tests await `flush()`. A NO-OP logger (`noopDevLog`) is the
// safe default so stages can take an optional `DevLog` without callers/tests changing.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const DEFAULT_MAX_FILES = 5;
const REDACTED = '[redacted]';

export type Fields = Record<string, unknown> & {
  /** Values here are redacted unless the sink level is `debug` (OBS-10 minimal: captured text, egress payloads). */
  sensitive?: Record<string, unknown>;
  /** An Error (or anything) describing the cause — normalized to {message, stack}. */
  err?: unknown;
};

export interface DevLog {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** Bind scope + cross-link ids / fields onto every subsequent entry. */
  child(bind: { scope?: string; runId?: string; itemId?: string } & Record<string, unknown>): DevLog;
  /** Await all pending writes (tests; also for clean shutdown). */
  flush(): Promise<void>;
}

/** The minimal shape `onEmit` observers see for each line — enough to track "the last thing the
 *  pipeline was doing" (OBS-18 crash breadcrumb) without re-parsing the JSONL. */
export interface EmitRecord {
  ts: string;
  level: LogLevel;
  event: string;
  scope?: string;
  runId?: string;
  itemId?: string;
}

export interface DevLogOptions {
  /** Directory the log file lives in (created on first write, or eagerly when `eager` is set). */
  dir: string;
  /** Base filename. Default `pipeline.log`; rotated files get `.1`, `.2`, … suffixes. */
  file?: string;
  /** Minimum level written. Default `info`. At `debug`, sensitive fields are included verbatim. */
  level?: LogLevel;
  /** Rotate when the active file would exceed this many bytes. Default 5 MB. */
  maxBytes?: number;
  /** Keep this many rotated files (`.1`..`.N`); older are dropped. Default 5. */
  maxFiles?: number;
  /** Injectable clock for deterministic timestamps in tests. */
  now?: () => string;
  /** OBS-19: create the sink dir + (empty) file eagerly on construction, instead of lazily on the
   *  first write. The crash breadcrumb (OBS-18) and pre-vault boot errors vanish if the sink never
   *  came into existence; eager creation guarantees the file is there to write into. */
  eager?: boolean;
  /** OBS-18: a best-effort observer notified of every emitted line's id-bearing fields, so a crash
   *  handler can read the *last* runId/itemId/stage the pipeline touched. Never throws into logging. */
  onEmit?: (rec: EmitRecord) => void;
}

/** Shared, mutable sink state (one per file; children share it). */
interface Sink {
  dir: string;
  file: string;
  level: LogLevel;
  maxBytes: number;
  maxFiles: number;
  now: () => string;
  bytes: number | null; // current active-file size; null until first stat
  tail: Promise<void>; // serialized write chain
  onEmit?: (rec: EmitRecord) => void; // OBS-18 breadcrumb observer (best-effort)
}

function normalizeErr(err: unknown): { message: string; stack?: string } | undefined {
  if (err === undefined) return undefined;
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: typeof err === 'string' ? err : JSON.stringify(err) };
}

function redactSensitive(sensitive: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(sensitive)) out[k] = REDACTED;
  return out;
}

async function activePath(sink: Sink): Promise<string> {
  return path.join(sink.dir, sink.file);
}

/** Rotate `pipeline.log` → `.1` → `.2` … dropping the oldest beyond maxFiles. Best-effort. */
async function rotate(sink: Sink): Promise<void> {
  const base = path.join(sink.dir, sink.file);
  // Drop the oldest, then shift each down by one.
  await fs.rm(`${base}.${sink.maxFiles}`, { force: true });
  for (let i = sink.maxFiles - 1; i >= 1; i--) {
    await fs.rename(`${base}.${i}`, `${base}.${i + 1}`).catch(() => {});
  }
  await fs.rename(base, `${base}.1`).catch(() => {});
  sink.bytes = 0;
}

/** OBS-19: bring the sink file into existence without writing a log line — `mkdir -p` the dir and
 *  touch the active file (a no-op append of '' creates it if absent, leaves an existing one intact).
 *  Best-effort: an eager-init failure must never crash boot; the first real write retries the mkdir. */
async function ensureSinkFile(sink: Sink): Promise<void> {
  try {
    await fs.mkdir(sink.dir, { recursive: true });
    await fs.appendFile(path.join(sink.dir, sink.file), '');
  } catch {
    /* eager creation is best-effort */
  }
}

async function writeLine(sink: Sink, line: string): Promise<void> {
  await fs.mkdir(sink.dir, { recursive: true });
  const p = await activePath(sink);
  if (sink.bytes === null) {
    sink.bytes = await fs
      .stat(p)
      .then((s) => s.size)
      .catch(() => 0);
  }
  const size = Buffer.byteLength(line);
  if (sink.maxFiles > 0 && sink.bytes > 0 && sink.bytes + size > sink.maxBytes) {
    await rotate(sink);
  }
  await fs.appendFile(p, line);
  sink.bytes = (sink.bytes ?? 0) + size;
}

class DevLogImpl implements DevLog {
  constructor(
    private readonly sink: Sink,
    private readonly bound: Record<string, unknown>,
  ) {}

  private emit(level: LogLevel, event: string, fields: Fields = {}): void {
    if (RANK[level] < RANK[this.sink.level]) return;
    const { sensitive, err, ...rest } = fields;
    const entry: Record<string, unknown> = {
      ts: this.sink.now(),
      level,
      ...this.bound,
      event,
      ...rest,
    };
    if (sensitive && Object.keys(sensitive).length > 0) {
      entry.sensitive = this.sink.level === 'debug' ? sensitive : redactSensitive(sensitive);
    }
    const normalized = normalizeErr(err);
    if (normalized) entry.err = normalized;

    // OBS-18: record the id-bearing fields for the crash breadcrumb BEFORE the (async) write — the
    // observer is synchronous + self-swallowing so a native trap a moment later still has the last
    // known {stage, runId, itemId}. Never let it throw into the caller's catch block.
    if (this.sink.onEmit) {
      try {
        // Read the merged entry (bound ⊕ per-call fields), so `error('…', { itemId })` is captured
        // as well as `.child({ runId, itemId })` bindings.
        const e = entry as { scope?: unknown; runId?: unknown; itemId?: unknown };
        this.sink.onEmit({
          ts: entry.ts as string,
          level,
          event,
          ...(typeof e.scope === 'string' ? { scope: e.scope } : {}),
          ...(typeof e.runId === 'string' ? { runId: e.runId } : {}),
          ...(typeof e.itemId === 'string' ? { itemId: e.itemId } : {}),
        });
      } catch {
        /* an observer fault must never break logging */
      }
    }

    const line = JSON.stringify(entry) + '\n';
    // Serialize + swallow: logging must never reject into the caller's catch block.
    this.sink.tail = this.sink.tail.then(() => writeLine(this.sink, line)).catch(() => {});
  }

  debug(event: string, fields?: Fields): void {
    this.emit('debug', event, fields);
  }
  info(event: string, fields?: Fields): void {
    this.emit('info', event, fields);
  }
  warn(event: string, fields?: Fields): void {
    this.emit('warn', event, fields);
  }
  error(event: string, fields?: Fields): void {
    this.emit('error', event, fields);
  }

  child(bind: { scope?: string; runId?: string; itemId?: string } & Record<string, unknown>): DevLog {
    const merged = { ...this.bound, ...bind };
    return new DevLogImpl(this.sink, merged);
  }

  flush(): Promise<void> {
    return this.sink.tail;
  }
}

/** Create a dev-log writing leveled JSONL to `<dir>/<file>` with size-based rotation (OBS-1/2). */
export function createDevLog(opts: DevLogOptions): DevLog {
  const sink: Sink = {
    dir: opts.dir,
    file: opts.file ?? 'pipeline.log',
    level: opts.level ?? 'info',
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
    now: opts.now ?? ((): string => new Date().toISOString()),
    bytes: null,
    tail: Promise.resolve(),
    ...(opts.onEmit ? { onEmit: opts.onEmit } : {}),
  };
  // OBS-19: eager creation is enqueued onto the same serialized tail as writes, so it can't race a
  // first log line and `flush()` awaits it (the regression test relies on this).
  if (opts.eager) {
    sink.tail = sink.tail.then(() => ensureSinkFile(sink));
  }
  return new DevLogImpl(sink, {});
}

/** The per-vault dev-log directory: `<vault>/.kb/cache/logs/` — gitignored (under `.kb/cache/`),
 *  never promoted (OBS-2), co-located with the worktrees/state it describes. */
export function vaultLogDir(vaultPath: string): string {
  return path.join(vaultPath, '.kb', 'cache', 'logs');
}

/** A dev-log for one vault's pipeline diagnostics, at `<vault>/.kb/cache/logs/pipeline.log` (OBS-2). */
export function createVaultDevLog(vaultPath: string, opts: Omit<DevLogOptions, 'dir'> = {}): DevLog {
  return createDevLog({ ...opts, dir: vaultLogDir(vaultPath) });
}

/** A parsed dev-log line (the shape `emit` writes), for the Status view's recent-errors panel (OBS-6). */
export interface DevLogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  scope?: string;
  runId?: string;
  itemId?: string;
  err?: { message: string; stack?: string };
  [k: string]: unknown;
}

/** Byte budget for the tail read (#506). At `devLogLevel: debug` a 5MB active file read whole on
 *  EVERY 2.5s status tick was ≈7GB/hour of read amplification for `limit` (default 20) entries — the
 *  tail comfortably covers many multiples of that even on a chatty log. Mirrors `perfIndex.readSpans`. */
export const DEFAULT_DEVLOG_TAIL_BYTES = 64 * 1024;

/**
 * Read recent dev-log entries from a vault's active `pipeline.log` (OBS-6), newest-first, filtered
 * to `minLevel` and up (default `warn` — the errors/warnings the Status view surfaces). Best-effort:
 * a missing/torn log yields what parses, never throws. Reads only the TAIL of the active file (the
 * last `tailBytes`, #506 — was the WHOLE file every tick) since `limit` recent matches live near the
 * end; rotated `.N` files are older history, never read here. Cross-links carry `runId`/`itemId` back
 * to the audit (OBS-3).
 */
export async function readRecentDevLogEntries(
  vaultPath: string,
  opts: { minLevel?: LogLevel; limit?: number; tailBytes?: number } = {},
): Promise<DevLogEntry[]> {
  const minRank = RANK[opts.minLevel ?? 'warn'];
  const limit = opts.limit ?? 20;
  const tailBytes = opts.tailBytes ?? DEFAULT_DEVLOG_TAIL_BYTES;
  const file = path.join(vaultLogDir(vaultPath), 'pipeline.log');
  let raw: string;
  try {
    const { size } = await fs.stat(file);
    if (size <= tailBytes) {
      raw = await fs.readFile(file, 'utf8');
    } else {
      // Read ONLY the last `tailBytes` — O(budget), not O(file). The first line is cut mid-record,
      // so drop everything up to the first newline before parsing.
      const fh = await fs.open(file, 'r');
      try {
        const buf = Buffer.alloc(tailBytes);
        await fh.read(buf, 0, tailBytes, size - tailBytes);
        const tail = buf.toString('utf8');
        const nl = tail.indexOf('\n');
        raw = nl >= 0 ? tail.slice(nl + 1) : '';
      } finally {
        await fh.close();
      }
    }
  } catch {
    return [];
  }
  const out: DevLogEntry[] = [];
  // Walk newest-first (bottom-up) so we can stop once we have `limit` matches.
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    let obj: DevLogEntry;
    try {
      obj = JSON.parse(line) as DevLogEntry;
    } catch {
      continue; // a torn/partial line — skip
    }
    if (typeof obj.level !== 'string' || RANK[obj.level] === undefined) continue;
    if (RANK[obj.level] < minRank) continue;
    out.push(obj);
  }
  return out;
}

/** An app-level dev-log in Electron userData, for errors BEFORE a vault is open — setup /
 *  worktree-provision failures on boot that would otherwise vanish (OBS-2). The sink is created
 *  **eagerly** (OBS-19): forensics 2026-06-07 found `<userData>/logs/` absent in a live install, so a
 *  boot/crash breadcrumb had nowhere to land. `eager` guarantees `app.log` exists from boot. */
export function createAppDevLog(userDataDir: string, opts: Omit<DevLogOptions, 'dir' | 'file'> = {}): DevLog {
  return createDevLog({ ...opts, eager: true, dir: path.join(userDataDir, 'logs'), file: 'app.log' });
}

/** A logger that discards everything — the safe default when no dev-log is wired (tests / standalone stages). */
export const noopDevLog: DevLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopDevLog,
  flush: () => Promise.resolve(),
};
