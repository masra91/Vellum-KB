// SPEC-0030 OBS-1/2/3 — the diagnostic dev-log subsystem (leveled, size-rotated JSONL,
// redaction-aware, runId/itemId cross-link). Standalone unit; the pipeline wiring (OBS-4) follows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';
import { createDevLog, noopDevLog, vaultLogDir, createVaultDevLog, createAppDevLog, readRecentDevLogEntries, type EmitRecord } from './devlog';

const NOW = (): string => '2026-06-02T00:00:00.000Z';

async function readLines(dir: string, file = 'pipeline.log'): Promise<Record<string, unknown>[]> {
  const txt = await fs.readFile(path.join(dir, file), 'utf8');
  return txt
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('devlog (SPEC-0030 OBS-1/2/3)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('kb-devlog-');
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('writes leveled JSONL entries and filters below the configured level (OBS-1)', async () => {
    const log = createDevLog({ dir, level: 'info', now: NOW });
    log.debug('skipped', { a: 1 });
    log.info('hi', { a: 1 });
    log.warn('warn', {});
    log.error('boom', {});
    await log.flush();
    const lines = await readLines(dir);
    expect(lines.map((l) => l.event)).toEqual(['hi', 'warn', 'boom']); // debug filtered out
    expect(lines[0]).toMatchObject({ ts: NOW(), level: 'info', event: 'hi', a: 1 });
  });

  it('binds scope + runId/itemId via child for the audit cross-link (OBS-3)', async () => {
    const log = createDevLog({ dir, now: NOW }).child({ scope: 'decompose', runId: 'R1' });
    log.error('decompose.failed', { itemId: 'S1', attempt: 3 });
    await log.flush();
    const [e] = await readLines(dir);
    expect(e).toMatchObject({ scope: 'decompose', runId: 'R1', event: 'decompose.failed', itemId: 'S1', attempt: 3 });
  });

  it('normalizes an Error into {message, stack} (OBS-4 cause capture)', async () => {
    const log = createDevLog({ dir, now: NOW });
    log.error('x', { err: new Error('kaboom') });
    await log.flush();
    const [e] = await readLines(dir);
    const err = e.err as { message: string; stack: string };
    expect(err.message).toBe('kaboom');
    expect(typeof err.stack).toBe('string');
  });

  it('redacts sensitive fields at info, includes them verbatim at debug (OBS-10 minimal)', async () => {
    const info = createDevLog({ dir, level: 'info', now: NOW });
    info.info('capture', { sensitive: { text: 'secret source text' } });
    await info.flush();
    expect((await readLines(dir))[0].sensitive).toEqual({ text: '[redacted]' });

    const dbgDir = await makeTempDir('kb-devlog-dbg-');
    const dbg = createDevLog({ dir: dbgDir, level: 'debug', now: NOW });
    dbg.debug('capture', { sensitive: { text: 'secret source text' } });
    await dbg.flush();
    expect((await readLines(dbgDir))[0].sensitive).toEqual({ text: 'secret source text' });
    await rmTempDir(dbgDir);
  });

  it('rotates by size, keeping maxFiles and dropping the oldest (OBS-2)', async () => {
    const log = createDevLog({ dir, level: 'info', maxBytes: 200, maxFiles: 2, now: NOW });
    for (let i = 0; i < 20; i++) log.info('e', { i, pad: 'x'.repeat(50) });
    await log.flush();
    expect(await pathExists(path.join(dir, 'pipeline.log'))).toBe(true);
    expect(await pathExists(path.join(dir, 'pipeline.log.1'))).toBe(true);
    expect(await pathExists(path.join(dir, 'pipeline.log.2'))).toBe(true);
    expect(await pathExists(path.join(dir, 'pipeline.log.3'))).toBe(false); // dropped beyond maxFiles
  });

  it('noopDevLog writes nothing and creates no file', async () => {
    noopDevLog.error('x', { err: new Error('y') });
    noopDevLog.child({ scope: 's' }).info('z');
    await noopDevLog.flush();
    expect(await pathExists(path.join(dir, 'pipeline.log'))).toBe(false);
  });

  it('never throws into the caller, even when the target dir is unwritable', async () => {
    const filePath = path.join(dir, 'not-a-dir');
    await fs.writeFile(filePath, 'x');
    const log = createDevLog({ dir: path.join(filePath, 'sub'), now: NOW }); // mkdir will fail (ENOTDIR)
    expect(() => log.error('boom', {})).not.toThrow();
    await expect(log.flush()).resolves.toBeUndefined();
  });
});

describe('sink locations (SPEC-0030 OBS-2)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir('kb-obs2-');
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('vaultLogDir is <vault>/.kb/cache/logs (gitignored under .kb/cache, never promoted)', () => {
    expect(vaultLogDir('/some/vault')).toBe(path.join('/some/vault', '.kb', 'cache', 'logs'));
  });

  it('createVaultDevLog writes to <vault>/.kb/cache/logs/pipeline.log', async () => {
    const log = createVaultDevLog(dir, { now: NOW });
    log.error('x', { itemId: 'S1' });
    await log.flush();
    const p = path.join(dir, '.kb', 'cache', 'logs', 'pipeline.log');
    expect(await pathExists(p)).toBe(true);
    expect((await readLines(path.join(dir, '.kb', 'cache', 'logs')))[0]).toMatchObject({ event: 'x', itemId: 'S1' });
  });

  it('createAppDevLog writes to <userData>/logs/app.log (pre-vault/boot errors)', async () => {
    const log = createAppDevLog(dir, { now: NOW });
    log.error('boot.init-pipeline-failed', {});
    await log.flush();
    expect(await pathExists(path.join(dir, 'logs', 'app.log'))).toBe(true);
    expect((await readLines(path.join(dir, 'logs'), 'app.log'))[0]).toMatchObject({ event: 'boot.init-pipeline-failed', level: 'error' });
  });

  // OBS-19 (regression): the app-level sink MUST exist after init even with zero log lines written.
  // Forensics 2026-06-07 found `<userData>/logs/` absent in a live install, so the crash breadcrumb
  // had nowhere to land. Before the eager fix this assertion fails (file created lazily on 1st write).
  it('createAppDevLog creates the app.log sink EAGERLY on boot, before any write (OBS-19)', async () => {
    const log = createAppDevLog(dir, { now: NOW });
    await log.flush(); // no log call at all — eager creation is enqueued on the tail flush awaits
    expect(await pathExists(path.join(dir, 'logs', 'app.log'))).toBe(true);
  });

  it('eager:true creates the sink file with no write; default (lazy) does not (OBS-19)', async () => {
    const lazy = createDevLog({ dir: path.join(dir, 'lazy'), now: NOW });
    await lazy.flush();
    expect(await pathExists(path.join(dir, 'lazy', 'pipeline.log'))).toBe(false);

    const eager = createDevLog({ dir: path.join(dir, 'eager'), eager: true, now: NOW });
    await eager.flush();
    expect(await pathExists(path.join(dir, 'eager', 'pipeline.log'))).toBe(true);
  });

  // OBS-18 support: the onEmit breadcrumb observer sees each line's last {scope,runId,itemId} — from
  // both `.child()` bindings and per-call fields — so a crash handler can name the last item touched.
  it('onEmit observes the last scope/runId/itemId from bindings AND per-call fields (OBS-18)', async () => {
    const seen: EmitRecord[] = [];
    const log = createDevLog({ dir, now: NOW, onEmit: (r) => seen.push(r) }).child({ scope: 'claims', runId: 'R7' });
    log.info('claims.start', { itemId: 'E42' });
    log.error('decompose.failed', { itemId: 'E99' });
    await log.flush();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ event: 'claims.start', scope: 'claims', runId: 'R7', itemId: 'E42', level: 'info' });
    expect(seen[1]).toMatchObject({ event: 'decompose.failed', scope: 'claims', runId: 'R7', itemId: 'E99', level: 'error' });
  });

  it('a throwing onEmit never breaks logging (OBS-18 best-effort)', async () => {
    const log = createDevLog({ dir, now: NOW, onEmit: () => { throw new Error('observer fault'); } });
    expect(() => log.info('still.logs', { a: 1 })).not.toThrow();
    await log.flush();
    expect((await readLines(dir))[0]).toMatchObject({ event: 'still.logs' });
  });
});

describe('readRecentDevLogEntries (SPEC-0030 OBS-6 — recent errors for the Status view)', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await makeTempDir('kb-devlog-read-');
  });
  afterEach(async () => {
    await rmTempDir(vault);
  });

  it('returns warn+error entries newest-first, filtering out info/debug, capped to limit', async () => {
    const log = createVaultDevLog(vault, { level: 'debug', now: NOW }).child({ scope: 'decompose' });
    log.debug('noise');
    log.info('start', { itemId: 'SRC1' });
    log.warn('decompose.setaside', { itemId: 'SRC2', reason: 'collision-exhausted' });
    log.error('decompose.failed', { runId: 'R1', itemId: 'SRC3', err: new Error('copilot exploded') });
    await log.flush();

    const recent = await readRecentDevLogEntries(vault);
    expect(recent).toHaveLength(2); // only warn + error (info/debug filtered)
    expect(recent[0]).toMatchObject({ event: 'decompose.failed', level: 'error', itemId: 'SRC3', runId: 'R1' }); // newest-first
    expect(recent[0].err?.message).toBe('copilot exploded'); // cause carried (OBS-3 cross-link)
    expect(recent[0].scope).toBe('decompose');
    expect(recent[1]).toMatchObject({ event: 'decompose.setaside', level: 'warn', itemId: 'SRC2' });
  });

  it('honors minLevel and limit', async () => {
    const log = createVaultDevLog(vault, { level: 'debug', now: NOW });
    log.warn('w1');
    log.error('e1');
    log.error('e2');
    await log.flush();

    expect(await readRecentDevLogEntries(vault, { minLevel: 'error' })).toHaveLength(2); // warns excluded
    expect(await readRecentDevLogEntries(vault, { limit: 1 })).toHaveLength(1); // newest only
    expect((await readRecentDevLogEntries(vault, { limit: 1 }))[0].event).toBe('e2');
  });

  it('a missing log yields an empty list (never throws)', async () => {
    await expect(readRecentDevLogEntries(vault)).resolves.toEqual([]);
  });

  // #506: a 5MB active log read WHOLE on every 2.5s status tick was ~7GB/hour of read amplification
  // at debug level. Prove the tail-budget read: a file bigger than the budget is NOT whole-file-read,
  // yet the newest entries (the ones a status tick actually wants) still come back correctly.
  it('reads only the TAIL of a file larger than the byte budget, not the whole file (#506)', async () => {
    const logDir = vaultLogDir(vault);
    await fs.mkdir(logDir, { recursive: true });
    const file = path.join(logDir, 'pipeline.log');
    // Old padding entries (well before the tail window) — must NOT surface, and must not be READ at all.
    const oldLines = Array.from({ length: 500 }, (_, i) => JSON.stringify({ ts: NOW(), level: 'error', event: `old-${i}`, pad: 'x'.repeat(200) }));
    const recentLines = [
      JSON.stringify({ ts: NOW(), level: 'warn', event: 'recent-warn' }),
      JSON.stringify({ ts: NOW(), level: 'error', event: 'recent-error' }),
    ];
    await fs.writeFile(file, [...oldLines, ...recentLines].join('\n') + '\n', 'utf8');
    const { size } = await fs.stat(file);
    const tailBytes = 2048;
    expect(size).toBeGreaterThan(tailBytes); // sanity: the file really exceeds the budget

    const spy = vi.spyOn(fs, 'readFile');
    try {
      const recent = await readRecentDevLogEntries(vault, { limit: 10, tailBytes });
      expect(spy).not.toHaveBeenCalled(); // the large-file branch uses fs.open+read, never a whole-file readFile
      const events = recent.map((e) => e.event);
      expect(events).toContain('recent-warn');
      expect(events).toContain('recent-error');
      expect(events).not.toContain('old-0'); // the very first line — nowhere near the tail window
    } finally {
      spy.mockRestore();
    }
  });

  it('a file smaller than the byte budget is still read in full (small-file branch)', async () => {
    const log = createVaultDevLog(vault, { level: 'debug', now: NOW });
    log.warn('small-file-warn');
    await log.flush();
    const recent = await readRecentDevLogEntries(vault, { tailBytes: 10 * 1024 * 1024 });
    expect(recent.map((e) => e.event)).toContain('small-file-warn');
  });
});
