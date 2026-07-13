// @vitest-environment happy-dom
//
// Capture view — the MACOS-7 / #56 blocked-capture recovery (component tier). When a capture write hits
// a macOS folder-permission denial, the capture panel must route to the Blocked recovery (brass,
// actionable) instead of surfacing the raw OS error — never a dead-end, never dev jargon.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountCapture } from './captureView';
import type { KbApi, CaptureResult, CaptureInput } from '../../kb/types';

function setApi(captureResult: CaptureResult): void {
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
    capture: vi.fn().mockResolvedValue(captureResult),
    pipelineStatus: vi.fn().mockResolvedValue({ queueDepth: 0, processing: null, lastArchived: null, updatedAt: null }),
    probeVaultAccess: vi.fn().mockResolvedValue({ ok: true, denied: false, message: 'ok' }),
    openSystemSettingsPrivacy: vi.fn().mockResolvedValue({ ok: true }),
  };
}

const OK: CaptureResult = { ok: true, blocked: false, ids: ['1'], captureBatch: 'b1', committed: true, message: 'Captured 1 item(s).' };
const flush = () => new Promise((r) => setTimeout(r, 0));
const captureMock = (): Mock => (window as unknown as { kbApi: KbApi }).kbApi.capture as unknown as Mock;
const lastInputs = (): CaptureInput[] => captureMock().mock.calls.at(-1)![0].inputs;

/** Dispatch a paste with stubbed clipboard flavors / image (happy-dom has no real clipboard). */
function paste(ta: HTMLTextAreaElement, data: { html?: string; plain?: string; image?: File }): void {
  const items = data.image ? [{ kind: 'file', type: data.image.type, getAsFile: () => data.image! }] : [];
  const files = data.image ? [data.image] : [];
  const cd = {
    getData: (t: string) => (t === 'text/html' ? (data.html ?? '') : t === 'text/plain' ? (data.plain ?? '') : ''),
    items,
    files,
  };
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: cd });
  ta.dispatchEvent(ev);
}

/** Dispatch a drop with a stubbed file list onto the dropzone. */
function drop(dz: HTMLElement, files: unknown[]): void {
  const ev = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { files } });
  dz.dispatchEvent(ev);
}

describe('captureView — blocked-capture recovery (MACOS-7 / #56)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  it('a permission-denied capture routes to the Blocked recovery (no raw OS error, no silent stall)', async () => {
    setApi({ ok: false, blocked: true, ids: [], captureBatch: null, committed: false, message: 'Vellum can’t write to your vault folder — access is turned off.' });
    mountCapture(root, '/Users/me/Documents/MyVault', 'KB');
    (root.querySelector('#captureText') as HTMLTextAreaElement).value = 'a thought';
    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await Promise.resolve(); await Promise.resolve();

    expect(root.querySelector('.perm-blocked')).not.toBeNull(); // Blocked recovery mounted in place
    expect(root.querySelector('#perm-open-settings')).not.toBeNull();
    expect(root.querySelector('#perm-retry')).not.toBeNull();
    expect(root.textContent).not.toContain('Operation not permitted'); // raw OS text never shown
  });

  it('a successful capture clears the input + confirms (no Blocked surface)', async () => {
    setApi({ ok: true, blocked: false, ids: ['1'], captureBatch: 'b1', committed: true, message: 'Captured 1 item(s).' });
    mountCapture(root, '/v', 'KB');
    const ta = root.querySelector('#captureText') as HTMLTextAreaElement;
    ta.value = 'x';
    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await Promise.resolve(); await Promise.resolve();

    expect(root.querySelector('.perm-blocked')).toBeNull();
    expect(ta.value).toBe('');
    expect(root.querySelector('#captureNote')!.textContent).toContain('Captured 1 item');
  });

  it('#160: an IPC-transport reject is honest, not silent — a note shows and the typed text is preserved', async () => {
    // The main handler always returns a structured result, but the channel itself can reject; the submit
    // must surface an honest note (not fail silently) AND never lose the user's capture.
    setApi(OK); // full kbApi shape (incl. pipelineStatus for the status timer)…
    captureMock().mockRejectedValue(new Error('channel down')); // …then make the capture channel reject
    mountCapture(root, '/v', 'KB');
    const ta = root.querySelector('#captureText') as HTMLTextAreaElement;
    ta.value = 'a precious thought';
    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await Promise.resolve(); await Promise.resolve();

    const note = root.querySelector('#captureNote')!.textContent ?? '';
    expect(note).toMatch(/couldn’t capture/i); // honest feedback, not silence
    expect(note).not.toContain('channel down'); // no raw error string leaked
    expect(ta.value).toBe('a precious thought'); // input preserved — capture never lost
  });
});

describe('captureView — RICHIN rich ingestion (SPEC-0040)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    setApi(OK);
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    // The staged-files state is module-global (SHELL-8: survives remounts) — drain it via the
    // remove buttons so it never leaks into the next test.
    let b: HTMLButtonElement | null;
    while ((b = root.querySelector<HTMLButtonElement>('#staged button[data-rm]'))) b.click();
    root.remove();
    vi.restoreAllMocks();
  });

  it('RICHIN-1/2: a rich paste inserts Markdown and capture carries the original HTML sidecar', async () => {
    mountCapture(root, '/v', 'KB');
    const ta = root.querySelector('#captureText') as HTMLTextAreaElement;
    paste(ta, { html: '<h1>Hi</h1>', plain: 'Hi' });
    expect(ta.value).toContain('# Hi'); // converted, not the raw plain text

    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await flush();
    const text = lastInputs().find((i) => i.kind === 'text') as Extract<CaptureInput, { kind: 'text' }>;
    expect(text.text).toContain('# Hi');
    expect(text.html).toBe('<h1>Hi</h1>');
  });

  it('RICHIN-3: with "Keep formatting" off, a paste is captured as plain (no HTML sidecar)', () => {
    mountCapture(root, '/v', 'KB');
    (root.querySelector('#keepFormatting') as HTMLInputElement).checked = false;
    const ta = root.querySelector('#captureText') as HTMLTextAreaElement;
    paste(ta, { html: '<h1>Hi</h1>', plain: 'Hi' });
    // plain path: handler does not insert; the browser would insert the plain text. No sidecar pending.
    ta.value = 'Hi';
    root.querySelector<HTMLButtonElement>('#capture')!.click();
    const text = lastInputs().find((i) => i.kind === 'text') as Extract<CaptureInput, { kind: 'text' }>;
    expect(text.text).toBe('Hi');
    expect(text.html).toBeUndefined();
  });

  it('RICHIN-4: a multi-file drop stages one entry per file and captures one input each', async () => {
    mountCapture(root, '/v', 'KB');
    const dz = root.querySelector('#dropzone') as HTMLElement;
    drop(dz, [new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }), new File([new Uint8Array([2, 3])], 'b.pdf', { type: 'application/pdf' })]);
    await flush();
    expect(root.querySelectorAll('#staged li')).toHaveLength(2);

    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await flush();
    const files = lastInputs().filter((i) => i.kind === 'file');
    expect(files).toHaveLength(2);
  });

  it('RICHIN-4: a file that fails to read does not block the others (per-file isolation)', async () => {
    mountCapture(root, '/v', 'KB');
    const dz = root.querySelector('#dropzone') as HTMLElement;
    const bad = { name: 'bad.bin', arrayBuffer: () => Promise.reject(new Error('boom')) };
    drop(dz, [new File([new Uint8Array([1])], 'good.png', { type: 'image/png' }), bad]);
    await flush();
    expect(root.querySelectorAll('#staged li')).toHaveLength(1); // the good one survived
    expect(root.querySelector('#staged')!.textContent).toContain('good.png');
    expect(root.querySelector('#captureNote')!.textContent).toContain('bad.bin');
  });

  it('RICHIN-12: a pasted image (no text flavor) is staged as a file unit', async () => {
    mountCapture(root, '/v', 'KB');
    const ta = root.querySelector('#captureText') as HTMLTextAreaElement;
    paste(ta, { image: new File([new Uint8Array([9, 9])], 'shot.png', { type: 'image/png' }) });
    await flush();
    expect(root.querySelectorAll('#staged li')).toHaveLength(1);
    expect(root.querySelector('#staged')!.textContent).toContain('shot.png');
  });

  it('RICHIN-6: the manifest shows each file size', async () => {
    mountCapture(root, '/v', 'KB');
    drop(root.querySelector('#dropzone') as HTMLElement, [new File([new Uint8Array([1, 2, 3])], 'tiny.bin', { type: 'application/octet-stream' })]);
    await flush();
    expect(root.querySelector('#staged')!.textContent).toContain('3 B');
  });

  it('RICHIN-11: a large file is flagged in the manifest and warned (non-blocking) on capture', async () => {
    mountCapture(root, '/v', 'KB');
    const big = { name: 'big.bin', arrayBuffer: () => Promise.resolve(new ArrayBuffer(26 * 1024 * 1024)) };
    drop(root.querySelector('#dropzone') as HTMLElement, [big]);
    await flush();
    expect(root.querySelector('#staged')!.textContent).toContain('large');
    // a11y caution-glyph unify: the flag rides a monochrome brass ◆ mark (aria-hidden), label reads
    // AA in ink — fails-before this fix (was a multicolor ⚠️ emoji as the carrier).
    const mark = root.querySelector('.capture-flag .capture-flag-mark')!;
    expect(mark).toBeTruthy();
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.capture-flag')!.textContent).not.toContain('⚠️');

    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await flush();
    expect(captureMock()).toHaveBeenCalled(); // never blocked
    expect(root.querySelector('#captureNote')!.textContent).toContain('large file');
  });
});

// WS3 migration (DESIGN-LEGACY-VIEWS §6): the Capture view moved off the legacy off-system primitives
// (.muted, button.primary, button.link, an unlabeled textarea, an un-announced dropzone) onto The
// Line's blessed .viz-* primitives + the a11y baseline. The headline fixes are the textarea's real
// accessible name (placeholder ≠ label) and the announced dropzone. Fails-before/passes-after on the CLASS.
describe('captureView — WS3 design-system migration (DESIGN-LEGACY-VIEWS §6 — onto The Line)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    setApi(OK);
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    // Drain the module-global staged state via the remove buttons so it never leaks into the next test.
    let b: HTMLButtonElement | null;
    while ((b = root.querySelector<HTMLButtonElement>('#staged button[data-rm]'))) b.click();
    root.remove();
    vi.restoreAllMocks();
  });

  it('renders the Capture button as a blessed .viz-btn--primary (was button.primary)', () => {
    mountCapture(root, '/v', 'KB');
    const btn = root.querySelector<HTMLButtonElement>('#capture')!;
    expect(btn.classList.contains('viz-btn')).toBe(true);
    expect(btn.classList.contains('viz-btn--primary')).toBe(true);
    expect(btn.classList.contains('primary')).toBe(false); // legacy indigo class gone
  });

  it('gives the textarea a real accessible name via aria-label; the Spectral head is the visible label (§6 a11y, SPEC-0058 v2)', () => {
    mountCapture(root, '/v', 'KB');
    const ta = root.querySelector<HTMLTextAreaElement>('#captureText')!;
    expect(ta.getAttribute('aria-label')).toBe('Capture'); // accessible name (placeholder is NOT one)
    expect(root.querySelector('.capture-eyebrow')?.textContent).toBe('Capture'); // the eyebrow names the surface
    expect(root.querySelector('.capture-title')?.textContent).toContain('mind'); // v3 de-slopped human title
    expect(ta.classList.contains('viz-field__input--multiline')).toBe(true);
  });

  it('announces + makes the dropzone reachable — role=region + aria-label + tabindex (§6 a11y)', () => {
    mountCapture(root, '/v', 'KB');
    const dz = root.querySelector<HTMLElement>('#dropzone')!;
    // role="region" (not "button"): the dropzone has no click/keyboard activation — it's a labelled
    // drop target, so an announced region is the correct semantic; a role=button with no handler would
    // be a no-op-button anti-pattern (KB-Lead classify fast-follow on #285).
    expect(dz.getAttribute('role')).toBe('region');
    expect(dz.getAttribute('aria-label')).toBe('Drop files or images here to capture them');
    expect(dz.getAttribute('tabindex')).toBe('0'); // keyboard-reachable / announced
  });

  it('restyles the keep-formatting toggle to the WS2 muted-signage label (off legacy .muted)', () => {
    mountCapture(root, '/v', 'KB');
    const toggle = root.querySelector('#keepFormatting')!.closest('label')!;
    expect(toggle.classList.contains('capture-toggle')).toBe(true);
    expect(toggle.classList.contains('muted')).toBe(false);
    expect(root.querySelector('#keepFormatting')).not.toBeNull(); // checkbox + native label wrap preserved
  });

  it('renders the staged-file remove action as a .viz-btn--ghost naming its file (was button.link)', async () => {
    mountCapture(root, '/v', 'KB');
    drop(root.querySelector('#dropzone') as HTMLElement, [new File([new Uint8Array([1])], 'note.pdf', { type: 'application/pdf' })]);
    await flush();
    const rm = root.querySelector<HTMLButtonElement>('#staged button[data-rm]')!;
    expect(rm.classList.contains('viz-btn')).toBe(true);
    expect(rm.classList.contains('viz-btn--ghost')).toBe(true);
    expect(rm.classList.contains('link')).toBe(false); // legacy button.link gone
    expect(rm.getAttribute('aria-label')).toBe('Remove note.pdf'); // "remove" alone is ambiguous to AT
    expect(rm.dataset.rm).toBe('0'); // the remove handler hook is preserved
  });

  it('carries NO legacy off-system primitives (.muted / button.link / button.primary) on any render path', async () => {
    mountCapture(root, '/v', 'KB');
    drop(root.querySelector('#dropzone') as HTMLElement, [new File([new Uint8Array([1])], 'f.bin', { type: 'application/octet-stream' })]);
    await flush(); // exercise the staged-files render path too
    expect(root.querySelector('.muted')).toBeNull(); // path / toggle / note / pipeline / size all migrated
    expect(root.querySelector('button.link')).toBeNull(); // remove → .viz-btn--ghost
    expect(root.querySelector('button.primary')).toBeNull(); // Capture → .viz-btn--primary
  });
});

describe('captureView — Vellum UX v2 glance (SPEC-0058 STATE content view, DL-2 contract)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    setApi(OK);
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('is a centered v3 composer: a Spectral head + a focus-within surface (not v2 .viz-card / legacy .card)', () => {
    mountCapture(root, '/v', 'KB');
    expect(root.querySelector('.capture-v2')).not.toBeNull();
    const composer = root.querySelector('.capture-composer');
    expect(composer).not.toBeNull();
    expect(composer?.classList.contains('viz-card')).toBe(false); // v3: its own surface, off the v2 card chrome
    expect(root.querySelector('.capture-v2')?.classList.contains('viz-surface')).toBe(false);
    expect(root.querySelector('.capture-title')?.classList.contains('viz-voice')).toBe(true); // Spectral head
    expect(root.querySelector('.card')).toBeNull(); // legacy card chrome gone
    expect(root.querySelector('.path')).toBeNull(); // vault path is no longer chrome (kept in state)
    expect(root.querySelector('[class*="ember"]')).toBeNull(); // capture is input, never a decision
  });

  it('the dropzone drag-over adds the .over hook (CSS maps it to the --viz-accent wash, DL-2 ruling — not ember)', () => {
    mountCapture(root, '/v', 'KB');
    const dz = root.querySelector<HTMLElement>('#dropzone')!;
    dz.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    expect(dz.classList.contains('over')).toBe(true);
    dz.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true }));
    expect(dz.classList.contains('over')).toBe(false);
  });

  it('the queue reads as a mono count, never an emoji (#184: tokenized glyph + Plex-Mono number)', async () => {
    mountCapture(root, '/v', 'KB');
    await flush(); // refreshStatus awaits pipelineStatus()
    const q = root.querySelector('#pipeline')!;
    expect(q.querySelector('.viz-numeric')).not.toBeNull(); // mono count
    expect(q.textContent).not.toContain('📥'); // no emoji
    expect(q.textContent).toContain('in queue');
  });

  it('a successful capture confirms with the OK (sprout) note state; clears the field', async () => {
    mountCapture(root, '/v', 'KB');
    (root.querySelector('#captureText') as HTMLTextAreaElement).value = 'a thought';
    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await flush();
    const note = root.querySelector('#captureNote')!;
    expect(note.classList.contains('capture-note--ok')).toBe(true); // sprout state
    expect((root.querySelector('#captureText') as HTMLTextAreaElement).value).toBe(''); // cleared
  });

  it('a true capture error uses the oxide (error) note state — not caution, not ember', async () => {
    setApi({ ok: false, blocked: false, ids: [], captureBatch: '', committed: false, message: 'Disk is full.' });
    mountCapture(root, '/v', 'KB');
    (root.querySelector('#captureText') as HTMLTextAreaElement).value = 'x';
    root.querySelector<HTMLButtonElement>('#capture')!.click();
    await flush();
    expect(root.querySelector('#captureNote')!.classList.contains('capture-note--error')).toBe(true); // oxide
  });

  it('NO ember anywhere — Capture is input, not a decision (colour discipline)', async () => {
    mountCapture(root, '/v', 'KB');
    drop(root.querySelector('#dropzone') as HTMLElement, [new File([new Uint8Array([1])], 'f.bin', { type: 'application/octet-stream' })]);
    await flush();
    expect(root.innerHTML.toLowerCase()).not.toContain('ember');
  });
});

// #509 — the pipeline poll must survive a rejecting `pipelineStatus()`: before this fix there was NO
// try/catch, so a rejection became an unhandledrejection every tick (never surfaced, never recovered).
describe('captureView — pipeline poll resilience (#509)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  it('a rejecting pipelineStatus() never throws past mount / crashes the view', async () => {
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = {
      capture: vi.fn().mockResolvedValue(OK),
      pipelineStatus: vi.fn().mockRejectedValue(new Error('IPC channel down')),
      probeVaultAccess: vi.fn().mockResolvedValue({ ok: true, denied: false, message: 'ok' }),
      openSystemSettingsPrivacy: vi.fn().mockResolvedValue({ ok: true }),
    };
    expect(() => mountCapture(root, '/v', 'KB')).not.toThrow();
    await flush();
    // Never crashed the surface — the composer is still fully there and usable.
    expect(root.querySelector('#captureText')).not.toBeNull();
    expect(root.querySelector('#capture')).not.toBeNull();
  });
});

// SPEC-0060 VUX-1: the Capture CSS block migrates off the instrument-panel --viz-* names onto the
// warm-vellum v3 tokens. NO ember (capture is input, not a decision). Guard on the CSS source.
describe('VUX-1 v3 token migration (SPEC-0060 — off --viz-*)', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  const block = indexCss.slice(
    indexCss.indexOf('Capture view — VELLUM v3'),
    indexCss.indexOf('App navigation shell'),
  );

  it('isolated the Capture v3 block', () => {
    expect(block.length).toBeGreaterThan(500);
  });

  it('the v3 Capture block carries NO --viz-* tokens and NO ember', () => {
    expect(block).not.toMatch(/var\(--viz-/);
    expect(block).not.toMatch(/--ember|var\(--ember/);
  });

  it('uses v3 ground/ink + interactive/state tokens (linen/ink/slate/sprout)', () => {
    expect(block).toMatch(/var\(--ink\b/);
    expect(block).toMatch(/var\(--linen\b/);
    expect(block).toMatch(/var\(--slate\b/); // interactive (focus ring / dropzone wash)
    expect(block).toMatch(/var\(--sprout\b/); // captured-✓ / queued
  });
});
