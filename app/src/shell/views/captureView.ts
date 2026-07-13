// Capture view (SPEC-0013) in the navigation shell (SPEC-0017 SHELL-3), Rich Ingestion (SPEC-0040 RICHIN),
// rendered at Vellum UX v2 (SPEC-0058 STATE content view — KB-Design-Lead-2's render contract). This slice
// is a VISUAL rewrite: a centered, airy composer on the textured cream ground (a raised `.viz-card`), with
// the data/IPC spine UNCHANGED (rich paste → Markdown, multi-file drag, pasted images, size-aware manifest,
// soft large-capture caution → `kb:capture`). STATE-1: input-only, no live vault scan on mount.
//
// Colour discipline (DL-2): NO ember anywhere (Capture is input, no decision) — `--viz-accent` is the only
// interactive hue (focus ring + the dropzone drag-over wash, DL-2's ruling), `--viz-sprout` = queued/
// processing/captured-✓, `--viz-oxide` only on a true capture error. #184: hue rides a glyph, never text.
import { esc } from '../html';
import { mountPermissionGate } from '../permissionGate';
import { interpretPaste } from '../../kb/richText';
import { createVisibilityPoll, type VisibilityPoll } from '../visibilityPoll';
import type { CaptureInput } from '../../kb/types';
import type { ViewHandle } from '../viewLifecycle';

// Soft thresholds (RICHIN-11): warn, never block. Preservation stays in-vault at any size.
const LARGE_TEXT_BYTES = 1 * 1024 * 1024; // ~1 MB pasted text
const LARGE_FILE_BYTES = 25 * 1024 * 1024; // ~25 MB file

// View-local state. The shell mounts each view once and toggles visibility, so this
// state (and the in-progress textarea) survives switching away and back (SHELL-8).
let stagedFiles: { name: string; data: Uint8Array }[] = [];
// The original clipboard HTML from the most recent rich paste, kept until capture so the
// verbatim sidecar can be preserved (RICHIN-2). Only attached when the textarea still holds
// exactly that pasted Markdown (a clean single rich paste).
let pendingPaste: { markdown: string; html: string } | null = null;
let statusPoll: VisibilityPoll | null = null;
let lastStatusSig = ''; // the last-painted pipeline readout — #509: write the DOM only when it changes
let vaultPath = ''; // the active vault path (for the MACOS-7 Blocked recovery on a denied capture)
let vaultName = '';
// The window-level drop guard must only be installed once across (re)mounts.
let dropGuardInstalled = false;

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type NoteKind = 'ok' | 'caution' | 'error';
const NOTE_GLYPH: Record<NoteKind, string> = { ok: '✓', caution: '◆', error: '✕' };

/** Set the capture note with a tokenized state (#184: hue on the glyph + a state class, never a multicolor
 *  emoji). `ok` → sprout check, `caution` → brass ◆, `error` → oxide ✕. Empty text clears it. */
function setNote(container: HTMLElement, text: string, kind: NoteKind = 'caution'): void {
  const note = container.querySelector('#captureNote');
  if (!note) return;
  note.className = `capture-note viz-body capture-note--${kind}`;
  note.innerHTML = text ? `<span class="capture-note-glyph" aria-hidden="true">${NOTE_GLYPH[kind]}</span> ${esc(text)}` : '';
}

function renderStagedFiles(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#staged');
  if (!el) return;
  // RICHIN-6: per-item manifest — name · size in Plex-Mono, a soft "large" flag (RICHIN-11), removable.
  el.innerHTML = stagedFiles
    .map((f, i) => {
      // RICHIN-11 caution: monochrome brass ◆ mark (aria-hidden) + ink label (#184) — never the multicolor emoji.
      const big = f.data.byteLength > LARGE_FILE_BYTES ? ' <span class="capture-flag"><span class="capture-flag-mark" aria-hidden="true">◆</span> large</span>' : '';
      return `<li class="capture-staged-row">
          <span class="capture-staged-name viz-numeric" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="capture-size viz-numeric">${humanSize(f.data.byteLength)}</span>${big}
          <button class="viz-btn viz-btn--ghost viz-btn--sm viz-focusable capture-staged-rm" data-rm="${i}" aria-label="Remove ${esc(f.name)}">remove</button>
        </li>`;
    })
    .join('');
  el.querySelectorAll<HTMLButtonElement>('button[data-rm]').forEach((b) =>
    b.addEventListener('click', () => {
      stagedFiles.splice(Number(b.dataset.rm), 1);
      renderStagedFiles(container);
    }),
  );
}

/** Add dropped files as staged units — one per file (RICHIN-4). Per-file isolation: a file that
 *  fails to read NEVER blocks or discards the others (RICHIN-4 / ORCH-12 spirit). */
async function addDroppedFiles(container: HTMLElement, files: FileList): Promise<void> {
  const failed: string[] = [];
  for (const file of Array.from(files)) {
    try {
      stagedFiles.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    } catch {
      failed.push(file.name || 'a file');
    }
  }
  renderStagedFiles(container);
  if (failed.length) setNote(container, `Couldn't read ${failed.join(', ')} — other items still staged.`, 'caution');
}

/** Stage a single File (e.g. a pasted image, RICHIN-12), synthesizing a name when the clipboard
 *  gives none. One unit per file; shares the gesture's captureBatch with any text at capture. */
async function addStagedFile(container: HTMLElement, file: File): Promise<void> {
  let name = file.name;
  if (!name) {
    const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
    name = `pasted-image.${ext || 'png'}`;
  }
  try {
    stagedFiles.push({ name, data: new Uint8Array(await file.arrayBuffer()) });
    renderStagedFiles(container);
  } catch {
    setNote(container, `Couldn't read the pasted image.`, 'caution');
  }
}

/** The first image on the clipboard, if any (screenshot paste), else null (RICHIN-12). */
function imageFromClipboard(cd: DataTransfer): File | null {
  for (const it of cd.items ? Array.from(cd.items) : []) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) return f;
    }
  }
  for (const f of cd.files ? Array.from(cd.files) : []) {
    if (f.type.startsWith('image/')) return f;
  }
  return null;
}

function setOrInsert(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
}

/** Paste handler (RICHIN-1/2/3/12): rich HTML → Markdown (original kept verbatim), a pasted
 *  image → file unit, and the "Keep formatting" toggle off → plain-text escape hatch. */
function onPaste(container: HTMLElement, ta: HTMLTextAreaElement, e: ClipboardEvent): void {
  const cd = e.clipboardData;
  if (!cd) return; // no clipboard payload — let the default happen
  const html = cd.getData('text/html');
  const plain = cd.getData('text/plain');

  // RICHIN-12: an image with no usable text → capture as a file (shares the batch with text).
  if (!html.trim() && !plain.trim()) {
    const img = imageFromClipboard(cd);
    if (img) {
      e.preventDefault();
      void addStagedFile(container, img);
      return;
    }
  }

  const keep = (container.querySelector('#keepFormatting') as HTMLInputElement | null)?.checked ?? true;
  const res = interpretPaste({ html, plain }, { plainOnly: !keep });
  if (!res.rich) {
    pendingPaste = null; // plain paste → let the browser insert the text; no sidecar
    return;
  }
  // Rich paste: insert the derived Markdown and remember the verbatim original for the sidecar.
  e.preventDefault();
  setOrInsert(ta, res.markdown);
  pendingPaste = { markdown: res.markdown, html: res.html! };
}

/** Soft, non-blocking caution when a capture exceeds a size threshold (RICHIN-11). Plain text — the
 *  caller folds it into the captured-confirmation note (preserved in full, never an error). */
function sizeWarning(text: string, files: { data: Uint8Array }[]): string {
  const big: string[] = [];
  if (new TextEncoder().encode(text).byteLength > LARGE_TEXT_BYTES) big.push('large text');
  if (files.some((f) => f.data.byteLength > LARGE_FILE_BYTES)) big.push('a large file');
  return big.length ? `${big.join(' + ')} preserved in full` : '';
}

/** The pipeline queue readout (DL-2 contract): a mono count + a tokenized sprout glyph (queued/processing
 *  = sprout), no emoji. STATE-1-safe: reads the cheap pipeline status, never a vault walk.
 *
 *  #509: previously had NO try/catch — a rejecting `pipelineStatus()` became an unhandledrejection + a
 *  `reportRendererError` IPC + a log line every 1.5s until relaunch. The visibility poll wrapper
 *  (createVisibilityPoll) now catches + backs off, but this still guards a direct/manual call. Also
 *  writes the DOM only when the readout actually changed (was: every tick, even unchanged). */
async function refreshStatus(container: HTMLElement): Promise<void> {
  const el = container.querySelector<HTMLElement>('#pipeline');
  if (!el) return;
  let s: Awaited<ReturnType<typeof window.kbApi.pipelineStatus>>;
  try {
    s = await window.kbApi.pipelineStatus();
  } catch {
    return; // transient IPC failure — leave the last-known readout, the poll wrapper backs off the retry
  }
  const sig = `${s.queueDepth}|${s.processing ?? ''}`;
  if (sig === lastStatusSig) return; // unchanged — no DOM write
  lastStatusSig = sig;
  const active = s.queueDepth > 0 || !!s.processing;
  el.className = `capture-queue viz-body${active ? ' capture-queue--active' : ''}`;
  const glyph = `<span class="capture-queue-glyph" aria-hidden="true">◷</span>`;
  const count = `<span class="viz-numeric">${s.queueDepth}</span> in queue`;
  el.innerHTML = s.processing ? `${glyph} ${count} · filing…` : `${glyph} ${count}`;
}

async function onCapture(container: HTMLElement): Promise<void> {
  const textArea = container.querySelector('#captureText') as HTMLTextAreaElement;
  const text = textArea.value;
  const inputs: CaptureInput[] = [];
  if (text.trim().length > 0) {
    // RICHIN-2: attach the original clipboard HTML only when the textarea still holds exactly the
    // pasted Markdown (a clean single rich paste) — so `original.html` is always a faithful source.
    const html = pendingPaste && pendingPaste.markdown.trim() === text.trim() ? pendingPaste.html : undefined;
    inputs.push({ kind: 'text', text, ...(html ? { html } : {}) });
  }
  for (const f of stagedFiles) inputs.push({ kind: 'file', name: f.name, data: f.data });

  if (inputs.length === 0) {
    setNote(container, 'Type something, paste, or drop a file first.', 'caution');
    return;
  }

  const warn = sizeWarning(text, stagedFiles);

  // The main `kb:capture` handler always resolves a structured CaptureResult, but the IPC channel itself
  // can still reject (handler unregistered, serialization error). Guard so a transport reject becomes an
  // honest, retryable note instead of a SILENT failure (#160) — and the typed text + staged files are
  // left intact (never lose a capture on a failed submit).
  //
  // #520 §10: "Keep it" is the headline double-capture-risk fix — the button showed nothing in flight,
  // so a second click during the await could fire a duplicate capture. `.is-busy` (sprout breathe) +
  // `disabled` close that window; both clear in `finally` so every exit path (resolve or reject) restores
  // the button, matching the setNote(...) calls' own all-paths-covered contract.
  const submitBtn = container.querySelector<HTMLButtonElement>('#capture');
  submitBtn?.classList.add('is-busy');
  if (submitBtn) submitBtn.disabled = true;
  let res: Awaited<ReturnType<typeof window.kbApi.capture>>;
  try {
    res = await window.kbApi.capture({ inputs });
  } catch {
    setNote(container, 'Couldn’t capture just now — your text is safe; try again.', 'error');
    return;
  } finally {
    submitBtn?.classList.remove('is-busy');
    if (submitBtn) submitBtn.disabled = false;
  }
  if (res.ok) {
    textArea.value = '';
    stagedFiles = [];
    pendingPaste = null;
    renderStagedFiles(container);
    setNote(container, warn ? `${res.message} · ${warn}` : res.message, 'ok');
  } else if (res.blocked && vaultPath) {
    // SPEC-0034 MACOS-7 / #56: the capture write hit a folder-permission denial — route to the Blocked
    // recovery (actionable: Open System Settings + Retry) instead of a raw OS error. On grant + Retry the
    // gate re-mounts the capture view (the loop stays closed; no relaunch).
    mountPermissionGate(container, {
      vaultPath,
      folder: vaultPath,
      start: 'blocked',
      onGranted: () => mountCapture(container, vaultPath, vaultName),
    });
    return;
  } else {
    setNote(container, res.message, 'error');
  }
  void refreshStatus(container);
}

export function mountCapture(container: HTMLElement, vaultPathArg: string, name: string): ViewHandle {
  vaultPath = vaultPathArg;
  vaultName = name;
  lastStatusSig = ''; // a fresh mount replaces the DOM below — the next refreshStatus must always paint it
  // v3 (SPEC-0060 VUX-1): a calm centered composer on the warm-vellum tokens. De-slopped copy — a plain
  // eyebrow + a human title (no "Vellum reads it, files it, and connects it" marketing line, no slop
  // placeholder). NO ember (capture is input, not a decision); accent=interactive, sprout=captured-✓.
  // `vaultName`/`vaultPath` are retained in state (for the Blocked-recovery re-mount) but no longer chrome.
  container.innerHTML = `
    <div class="capture-v2">
      <header class="capture-head">
        <div class="capture-eyebrow viz-signage">Capture</div>
        <h1 class="capture-title viz-voice">What’s on your mind?</h1>
      </header>
      <div class="capture-composer">
        <textarea id="captureText" class="capture viz-field__input viz-field__input--multiline viz-body viz-focusable" rows="5"
          placeholder="Paste a thought, a link, or drop a file…" aria-label="Capture"></textarea>
        <div id="dropzone" class="capture-dropzone viz-focusable" role="region" tabindex="0" aria-label="Drop files or images here to capture them">
          <span class="capture-dropzone-glyph" aria-hidden="true">⊕</span> Drop files or images here
        </div>
        <ul id="staged" class="capture-staged"></ul>
        <div class="capture-controls">
          <label class="capture-toggle viz-body"><input type="checkbox" id="keepFormatting" checked /> Keep formatting on paste</label>
          <button id="capture" class="viz-btn viz-btn--primary viz-focusable capture-submit">Keep it</button>
        </div>
        <p id="captureNote" class="capture-note viz-body" role="status"></p>
      </div>
      <p id="pipeline" class="capture-queue viz-body" role="status"></p>
    </div>`;

  container.querySelector('#capture')!.addEventListener('click', () => void onCapture(container));

  const ta = container.querySelector('#captureText') as HTMLTextAreaElement;
  ta.addEventListener('paste', (e) => onPaste(container, ta, e as ClipboardEvent));

  const dz = container.querySelector('#dropzone') as HTMLElement;
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  dz.addEventListener('dragover', (e) => {
    stop(e);
    dz.classList.add('over'); // CSS: --viz-accent wash (interactive affordance, DL-2's ruling — not ember/sprout)
  });
  dz.addEventListener('dragleave', (e) => {
    stop(e);
    dz.classList.remove('over');
  });
  dz.addEventListener('drop', (e) => {
    stop(e);
    dz.classList.remove('over');
    const dt = (e as DragEvent).dataTransfer;
    if (dt?.files?.length) void addDroppedFiles(container, dt.files);
  });

  // Prevent the window from navigating when a file is dropped outside the zone.
  if (!dropGuardInstalled) {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    dropGuardInstalled = true;
  }

  renderStagedFiles(container);

  // #509 gave the queue readout a self-gating visibility poll (`createVisibilityPoll` — pauses the IPC
  // while hidden/backgrounded, backs off on error). #510 layers the explicit shell-driven lifecycle on
  // top: `hide()` fully `stop()`s it (not just self-gating) so it matches every other view's contract
  // (zero live timers once hidden — the fake-timer sweep in shell.test.ts), and `show()` re-creates it
  // + does one immediate refresh so the queue reads fresh the instant Capture becomes visible again.
  return {
    show: () => {
      void refreshStatus(container);
      if (statusPoll == null) statusPoll = createVisibilityPoll(container, 1500, () => refreshStatus(container));
    },
    hide: () => {
      statusPoll?.stop();
      statusPoll = null;
    },
  };
}
