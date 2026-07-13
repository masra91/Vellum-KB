// Capture domain tests (SPEC-0013 CAPTURE-3/4/5/6/13/14). Real FS + real git against a
// throwaway temp vault (TEST-18), like vault.test.ts. Skips if git is absent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import simpleGit from 'simple-git';
import { createKb } from './vault';
import { captureToInbox, readCapturedMeta, normalizeInbox, type CapturePayload } from './ingest';
import { makeTempDir, rmTempDir, pathExists } from '../../test/tempVault';

function gitInstalledSync(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = gitInstalledSync();

async function inboxUnits(vault: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(vault, 'inbox'))).sort();
  } catch {
    return [];
  }
}

describe.skipIf(!gitAvailable)('captureToInbox (SPEC-0013)', () => {
  let dir: string;
  let vault: string;
  beforeEach(async () => {
    dir = await makeTempDir();
    vault = path.join(dir, 'vault');
    await createKb({ path: vault, initGitIfNeeded: true });
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('CAPTURE-3/4: writes an immutable text unit and commits before processing', async () => {
    const res = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'call Steve re: Q3 budget' }]);
    expect(res.committed).toBe(true);
    expect(res.ids).toHaveLength(1);

    const unit = path.join(vault, 'inbox', res.ids[0]);
    expect(await fs.readFile(path.join(unit, 'raw.md'), 'utf8')).toBe('call Steve re: Q3 budget');

    // Committed (CAPTURE-3) and working tree clean (add-only, nothing left dirty).
    const git = simpleGit(vault);
    const log = await git.log();
    expect(log.latest?.message).toContain('capture: 1 item(s) [in-app-panel]');
    expect((await git.status()).isClean()).toBe(true);
  });

  it('CAPTURE-6: records arrival provenance + content hash in the captured event', async () => {
    const res = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'hello' }]);
    const meta = await readCapturedMeta(path.join(vault, 'inbox', res.ids[0]));
    expect(meta.kind).toBe('text');
    expect(meta.raw).toBe('raw.md');
    expect(meta.surface).toBe('in-app-panel');
    expect(meta.mimeType).toBe('text/markdown');
    expect(meta.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta.captureBatch).toBe(res.captureBatch);
    expect(() => new Date(meta.capturedAt).toISOString()).not.toThrow();
  });

  it('CAPTURE-4/6: stores file bytes verbatim with original name, mime, size, hash', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const payload: CapturePayload = { kind: 'file', name: 'screenshot.png', data: bytes };
    const res = await captureToInbox(vault, 'in-app-panel', [payload]);

    const unit = path.join(vault, 'inbox', res.ids[0]);
    const stored = await fs.readFile(path.join(unit, 'raw.png'));
    expect(new Uint8Array(stored)).toEqual(bytes); // byte-for-byte immutable

    const meta = await readCapturedMeta(unit);
    expect(meta.kind).toBe('file');
    expect(meta.raw).toBe('raw.png');
    expect(meta.originalName).toBe('screenshot.png');
    expect(meta.mimeType).toBe('image/png');
    expect(meta.bytes).toBe(8);
  });

  it('CAPTURE-5/14: one capture with N payloads → N units, distinct ULIDs, shared captureBatch', async () => {
    const payloads: CapturePayload[] = [
      { kind: 'text', text: 'caption for the shots' },
      { kind: 'file', name: 'a.png', data: new Uint8Array([1, 2, 3]) },
      { kind: 'file', name: 'b.png', data: new Uint8Array([4, 5, 6]) },
    ];
    const res = await captureToInbox(vault, 'in-app-panel', payloads);
    expect(res.ids).toHaveLength(3);
    expect(new Set(res.ids).size).toBe(3); // distinct identities

    for (const id of res.ids) {
      const meta = await readCapturedMeta(path.join(vault, 'inbox', id));
      expect(meta.captureBatch).toBe(res.captureBatch); // all linked by one batch
    }
    // a single commit for the gesture
    const log = await simpleGit(vault).log();
    expect(log.latest?.message).toContain('capture: 3 item(s)');
  });

  it('CAPTURE-5: capture is add-only — a second capture leaves the first untouched', async () => {
    const a = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'first' }]);
    const b = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'second' }]);
    const units = await inboxUnits(vault);
    expect(units).toEqual([a.ids[0], b.ids[0]].sort());
    expect(await fs.readFile(path.join(vault, 'inbox', a.ids[0], 'raw.md'), 'utf8')).toBe('first');
  });

  it('files with no extension fall back to raw.bin', async () => {
    const res = await captureToInbox(vault, 'in-app-panel', [{ kind: 'file', name: 'README', data: new Uint8Array([7]) }]);
    expect(await pathExists(path.join(vault, 'inbox', res.ids[0], 'raw.bin'))).toBe(true);
  });

  it('rejects an empty capture', async () => {
    await expect(captureToInbox(vault, 'in-app-panel', [])).rejects.toThrow(/nothing to capture/);
  });

  it('ORCH-14: normalizeInbox adopts a loose dropped file into a canonical external unit', async () => {
    // Simulate another app / disk drop: a loose file directly in inbox/, no ULID, no audit.
    await fs.mkdir(path.join(vault, 'inbox'), { recursive: true });
    await fs.writeFile(path.join(vault, 'inbox', 'report.pdf'), Buffer.from([1, 2, 3, 4]));

    const minted = await normalizeInbox(vault);
    expect(minted).toHaveLength(1);

    const unit = path.join(vault, 'inbox', minted[0]);
    expect(await pathExists(path.join(vault, 'inbox', 'report.pdf'))).toBe(false); // moved in
    expect(new Uint8Array(await fs.readFile(path.join(unit, 'raw.pdf')))).toEqual(new Uint8Array([1, 2, 3, 4]));

    const meta = await readCapturedMeta(unit);
    expect(meta.origin).toBe('external');
    expect(meta.surface).toBe('folder-drop');
    expect(meta.originalName).toBe('report.pdf');
    expect(meta.mimeType).toBe('application/pdf');

    // committed (preservation-first) and nothing left dirty
    const git = simpleGit(vault);
    expect((await git.log()).latest?.message).toContain('normalize: 1 foreign drop(s)');
    expect((await git.status()).isClean()).toBe(true);
  });

  it('ORCH-14: normalizeInbox ignores hidden/system files (e.g. .DS_Store)', async () => {
    await fs.mkdir(path.join(vault, 'inbox'), { recursive: true });
    await fs.writeFile(path.join(vault, 'inbox', '.DS_Store'), 'junk');
    expect(await normalizeInbox(vault)).toEqual([]);
    expect(await pathExists(path.join(vault, 'inbox', '.DS_Store'))).toBe(true); // left alone
  });

  it('ORCH-14: normalizeInbox leaves canonical units untouched (idempotent, no commit)', async () => {
    await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'canonical' }]);
    const headBefore = (await simpleGit(vault).log()).latest?.hash;
    const minted = await normalizeInbox(vault);
    expect(minted).toEqual([]);
    expect((await simpleGit(vault).log()).latest?.hash).toBe(headBefore); // no new commit
  });
});

// #516 BUG-3 (the normalizeInbox half): an oversized/unreadable foreign drop is refused (audited),
// never a whole-pass throw that would wedge the archive drain (normalizeInbox runs under
// `lock.run('normalize')` in drainOnce with no surrounding try/catch — a throw here used to kill the
// ENTIRE drain, before the real queue was even read).
describe.skipIf(!gitAvailable)('normalizeInbox — per-file isolation + size cap (#516 BUG-3)', () => {
  let dir: string;
  let vault: string;
  beforeEach(async () => {
    dir = await makeTempDir();
    vault = path.join(dir, 'vault');
    await createKb({ path: vault, initGitIfNeeded: true });
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  async function auditEvents(): Promise<Array<{ eventType: string; payload: Record<string, unknown> }>> {
    const raw = await fs.readFile(path.join(vault, '.kb', 'audit.jsonl'), 'utf8').catch(() => '');
    return raw
      .trim()
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { eventType: string; payload: Record<string, unknown> });
  }

  it('a file over the size cap is REFUSED (audited capture-refused), never read, and stays on disk untouched', async () => {
    await fs.mkdir(path.join(vault, 'inbox'), { recursive: true });
    await fs.writeFile(path.join(vault, 'inbox', 'huge.bin'), Buffer.alloc(100, 1));
    const minted = await normalizeInbox(vault, Date.now(), 50); // tiny cap — the 100-byte file exceeds it
    expect(minted).toEqual([]);
    expect(await pathExists(path.join(vault, 'inbox', 'huge.bin'))).toBe(true); // untouched, not adopted
    expect(await inboxUnits(vault)).toEqual(['huge.bin']); // no ULID unit dir minted for it — the raw file is all that's there

    const events = await auditEvents();
    const refused = events.find((e) => e.eventType === 'capture-refused');
    expect(refused).toBeDefined();
    expect(refused!.payload.name).toBe('huge.bin');
    expect(refused!.payload.bytes).toBe(100);
    expect(refused!.payload.reason).toContain('size cap');
  });

  it('one refused file does NOT block a sibling good file from normalizing in the same pass', async () => {
    await fs.mkdir(path.join(vault, 'inbox'), { recursive: true });
    await fs.writeFile(path.join(vault, 'inbox', 'huge.bin'), Buffer.alloc(100, 1));
    await fs.writeFile(path.join(vault, 'inbox', 'fine.txt'), 'a perfectly normal file');
    const minted = await normalizeInbox(vault, Date.now(), 50);
    expect(minted).toHaveLength(1); // the good one adopted
    expect(await pathExists(path.join(vault, 'inbox', 'huge.bin'))).toBe(true); // refused one left alone
    expect(await pathExists(path.join(vault, 'inbox', 'fine.txt'))).toBe(false); // adopted (moved into its unit)
  });

  it('a per-file read failure is isolated (audited, skipped) — never a whole-pass throw', async () => {
    await fs.mkdir(path.join(vault, 'inbox'), { recursive: true });
    // A directory entry that LOOKS like a plain file to fs.stat's isFile() gate would be unusual to
    // fabricate portably; instead simulate an unreadable file via a broken symlink target read failure
    // is already excluded by isFile() — so exercise the catch-all via a file that vanishes between the
    // readdir listing and the stat/read (a realistic race): create it, then race a deletion mid-pass by
    // making the SECOND file's presence the assertion target (isolation, not the exact error path).
    await fs.writeFile(path.join(vault, 'inbox', 'a-first.txt'), 'first');
    await fs.writeFile(path.join(vault, 'inbox', 'b-second.txt'), 'second');
    await fs.rm(path.join(vault, 'inbox', 'a-first.txt')); // vanished before normalizeInbox's own stat
    const minted = await normalizeInbox(vault);
    expect(minted).toHaveLength(1); // b-second still adopted despite a-first's mid-scan disappearance
    expect(await pathExists(path.join(vault, 'inbox', 'b-second.txt'))).toBe(false);
  });
});

describe.skipIf(!gitAvailable)('captureToInbox — RICHIN rich paste (SPEC-0040)', () => {
  let dir: string;
  let vault: string;
  beforeEach(async () => {
    dir = await makeTempDir();
    vault = path.join(dir, 'vault');
    await createKb({ path: vault, initGitIfNeeded: true });
  });
  afterEach(async () => {
    await rmTempDir(dir);
  });

  it('RICHIN-2/10: a rich-paste text unit writes raw.md + original.html sidecar + clip provenance', async () => {
    const md = '# Title\n\n- a\n- b';
    const html = '<h1>Title</h1><ul><li>a</li><li>b</li></ul>';
    const res = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: md, html }]);

    const unit = path.join(vault, 'inbox', res.ids[0]);
    // raw.md is the derived Markdown payload; the verbatim original is preserved alongside it.
    expect(await fs.readFile(path.join(unit, 'raw.md'), 'utf8')).toBe(md);
    expect(await fs.readFile(path.join(unit, 'original.html'), 'utf8')).toBe(html);

    const meta = await readCapturedMeta(unit);
    expect(meta.kind).toBe('text');
    expect(meta.clip).toEqual({ format: 'html→md', original: 'original.html' });

    // RICHIN-9: the preservation spine is untouched — committed before processing, tree clean.
    const git = simpleGit(vault);
    expect((await git.log()).latest?.message).toContain('capture: 1 item(s) [in-app-panel]');
    expect((await git.status()).isClean()).toBe(true);
  });

  it('RICHIN-2: a plain text capture writes NO sidecar and NO clip (sidecar only when it differs)', async () => {
    const res = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'plain note' }]);
    const unit = path.join(vault, 'inbox', res.ids[0]);
    expect(await pathExists(path.join(unit, 'original.html'))).toBe(false);
    expect((await readCapturedMeta(unit)).clip).toBeUndefined();
  });
});

// #516 BUG-9: unit files written before a failing commit are cleaned up, not left as orphaned
// uncommitted litter that a LATER successful capture's `git add inbox` (which stages the whole inbox
// tree) silently sweeps up and rescue-commits under an unrelated message — while the UI already told
// the Principal THIS capture failed, so a re-capture would mint a duplicate.
describe.skipIf(!gitAvailable)('captureToInbox — failed-commit cleanup (#516 BUG-9)', () => {
  let dir: string;
  let vault: string;
  beforeEach(async () => {
    dir = await makeTempDir();
    vault = path.join(dir, 'vault');
    await createKb({ path: vault, initGitIfNeeded: true });
  });
  afterEach(async () => {
    await fs.rm(path.join(vault, '.git', 'index.lock'), { force: true }).catch(() => {});
    await rmTempDir(dir);
  });

  /** Force the NEXT git commit in this repo to fail deterministically: a real, held `index.lock` makes
   *  git refuse with "Unable to create '.git/index.lock': File exists." — no fake-git injection seam
   *  needed, and it exercises the REAL git failure path end-to-end. */
  async function jamGitIndex(): Promise<void> {
    await fs.writeFile(path.join(vault, '.git', 'index.lock'), '');
  }

  it('a failing commit removes the just-written unit dirs — no unit remains queued after a failed capture', async () => {
    await jamGitIndex();
    await expect(captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'will fail to commit' }])).rejects.toThrow();
    expect(await inboxUnits(vault)).toEqual([]); // nothing left behind — not even a partial unit
  });

  it('cleans up ALL units in a multi-payload batch on a failed commit, not just the first', async () => {
    await jamGitIndex();
    await expect(
      captureToInbox(vault, 'in-app-panel', [
        { kind: 'text', text: 'one' },
        { kind: 'text', text: 'two' },
        { kind: 'text', text: 'three' },
      ]),
    ).rejects.toThrow();
    expect(await inboxUnits(vault)).toEqual([]);
  });

  it('a LATER successful capture is unaffected — no orphaned litter to rescue-commit under its message', async () => {
    await jamGitIndex();
    await expect(captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'fails' }])).rejects.toThrow();
    await fs.rm(path.join(vault, '.git', 'index.lock'), { force: true });

    const res = await captureToInbox(vault, 'in-app-panel', [{ kind: 'text', text: 'succeeds' }]);
    expect(res.committed).toBe(true);
    expect(await inboxUnits(vault)).toEqual([res.ids[0]]); // exactly the new unit — no leftover from the failed attempt
    const git = simpleGit(vault);
    expect((await git.log()).latest?.message).toContain('capture: 1 item(s)'); // its OWN message, nothing rescued in
    expect((await git.status()).isClean()).toBe(true);
  });
});

describe('readCapturedMeta error handling', () => {
  it('throws when the audit file is empty', async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(path.join(dir, 'audit.jsonl'), '\n');
      await expect(readCapturedMeta(dir)).rejects.toThrow(/no captured event/);
    } finally {
      await rmTempDir(dir);
    }
  });

  it('throws when the captured event is malformed', async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(path.join(dir, 'audit.jsonl'), JSON.stringify({ action: 'captured' }) + '\n');
      await expect(readCapturedMeta(dir)).rejects.toThrow(/malformed/);
    } finally {
      await rmTempDir(dir);
    }
  });
});
