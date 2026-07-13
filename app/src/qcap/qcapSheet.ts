// Quick Capture sheet (SPEC-0038, visual = DESIGN-QCAP "the intake slot"). The frictionless global
// capture surface the menubar agent summons. Reuses the single renderer bundle via the `#qcap` route
// (shared preload `kbApi`), plain DOM, talks ONLY to `window.kbApi` → fully testable in happy-dom.
//
// It is NOT a generic capture box (the most-summoned surface — GATE-1 anti-generic): a flat-ink
// instrument slot built on the WS2 design-system language — a hero EditableField (`.viz-field__input
// --multiline`) on `--viz-field` ground, a top `--viz-ember` "live" hairline, keyboard-first. Flow:
// the focused-app SELECTION (Slice 2, QCAP-7) — or the clipboard, or a SCREENSHOT (QCAP-13) — loads the
// slot as a tagged "loaded" state → Enter saves onto the SPEC-0013 path (fire-and-forget, CAPTURE-2,
// surface=quick-capture) → the rule takes `--viz-ember` + a `--viz-patina` `preserved` tick (QCAP-10) →
// auto-dismiss + focus-restore (QCAP-2); Esc cancels; a failure holds in `--viz-oxide` with `⏎ retry`
// and does NOT auto-dismiss (no silent loss). A DENIED permission (Accessibility QCAP-9 / Screen
// Recording QCAP-13) shows a quiet --viz-brass steer-to-Settings + graceful degrade — never a dead end.
import { esc } from '../shell/html';
import type { ScreenshotMode } from '../kb/types';

/** Auto-dismiss dwell after a successful save — within DESIGN-QCAP §10's 350–500ms band (QCAP-2/10). */
export const QCAP_CONFIRM_MS = 450;

// QCAP-13 §3b: thin instrument-line template glyphs (NOT a 📷/camera emoji) — a full-frame rect (`-x`),
// a crop/region rect (`-i`), a window rect with a title bar (`-w`). Drawn in currentColor so they take
// the ghost button's muted-at-rest / ember-on-hover ink.
const GLYPH: Record<ScreenshotMode, string> = {
  full: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="3.5" width="11" height="9" rx="0.5"/></svg>',
  region:
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.2 1.6"><rect x="2.5" y="3.5" width="11" height="9" rx="0.5"/></svg>',
  window:
    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="3.5" width="11" height="9" rx="0.5"/><line x1="2.5" y1="6.2" x2="13.5" y2="6.2"/></svg>',
};
const SHOT_LABEL: Record<ScreenshotMode, string> = {
  full: 'Capture full screen',
  region: 'Capture a region',
  window: 'Capture a window',
};

export function mountQuickCaptureSheet(root: HTMLElement): void {
  root.innerHTML = `
    <div class="qcap-sheet">
      <div class="qcap-head">
        <span class="qcap-mark">Capture</span>
        <span class="qcap-head__meta">
          <span id="qcapShots" class="qcap-shots" hidden>
            <button id="qcapShotFull" type="button" class="qcap-shot" aria-label="${SHOT_LABEL.full}" title="${SHOT_LABEL.full}">${GLYPH.full}</button>
            <button id="qcapShotRegion" type="button" class="qcap-shot" aria-label="${SHOT_LABEL.region}" title="${SHOT_LABEL.region}">${GLYPH.region}</button>
            <button id="qcapShotWindow" type="button" class="qcap-shot" aria-label="${SHOT_LABEL.window}" title="${SHOT_LABEL.window}">${GLYPH.window}</button>
          </span>
          <span id="qcapClipTag" class="qcap-cliptag" hidden>clipboard</span>
          <button id="qcapAxEnable" type="button" class="qcap-ax" hidden
            title="Turn on Accessibility to capture the selected text from any app">selection capture off — enable</button>
          <button id="qcapShotEnable" type="button" class="qcap-ax" hidden
            title="Turn on Screen Recording to capture a screenshot">screen recording off — enable</button>
        </span>
      </div>
      <div class="qcap-field">
        <textarea id="qcapText" class="qcap-input"
          rows="3" aria-label="Quick capture"></textarea>
      </div>
      <div class="qcap-row">
        <span class="qcap-hint viz-numeric">⏎ save · ⇧⏎ newline · esc dismiss</span>
        <span id="qcapNote" class="qcap-note viz-numeric" role="status" aria-live="assertive"></span>
        <button id="qcapSave" type="button" class="v3-btn v3-btn--ghost v3-btn--sm qcap-save">⏎ save</button>
      </div>
    </div>`;

  const field = root.querySelector('.qcap-field') as HTMLElement;
  const ta = root.querySelector('#qcapText') as HTMLTextAreaElement;
  const note = root.querySelector('#qcapNote') as HTMLElement;
  const clipTag = root.querySelector('#qcapClipTag') as HTMLElement;
  const axEnable = root.querySelector('#qcapAxEnable') as HTMLButtonElement;
  const shots = root.querySelector('#qcapShots') as HTMLElement;
  const shotEnable = root.querySelector('#qcapShotEnable') as HTMLButtonElement;

  // QCAP-13: an image (screenshot or pasted clipboard image) loaded into the slot. Its bytes live in
  // main behind an opaque handle; on submit we send the handle (a `screenshot` input) — never DOM bytes.
  let pendingImage: { handle: string; name: string } | null = null;
  // Whether the textarea currently holds an auto-PREFILL (clipboard/selection text) vs user-typed text —
  // a prefill is dropped when capturing an image / on first edit; typed text is kept as a caption.
  let textIsPrefill = false;

  const setNote = (text: string, cls = ''): void => {
    note.textContent = text;
    note.className = `qcap-note viz-numeric${cls ? ` ${cls}` : ''}`;
  };

  /** Load an image into the slot as a tagged "loaded" state (QCAP-13/7) — same language as text prefill. */
  const loadImage = (img: { handle: string; name: string }, source: 'screenshot' | 'clipboard'): void => {
    pendingImage = img;
    if (textIsPrefill) {
      ta.value = ''; // an auto-prefill is superseded by the captured image; user-typed text stays (caption)
      textIsPrefill = false;
    }
    clipTag.textContent = source;
    clipTag.hidden = false;
    field.classList.add('is-loaded');
    ta.placeholder = 'add a note (optional) — ⏎ saves the image';
  };

  // QCAP-7/13: pre-fill the slot. A clipboard IMAGE (the "paste an image" path / Screen-Recording-denied
  // degrade) loads as an image; else the focused-app SELECTION takes precedence over clipboard TEXT
  // ("save what I'm looking at" in one gesture). QCAP-9: a denied Accessibility grant shows its brass
  // steer. The screenshot cluster shows only where capture is supported (macOS).
  void window.kbApi
    .quickCaptureContext()
    .then((ctx) => {
      if (ctx.screenshotSupported) shots.hidden = false;
      if (ctx.clipboardImage) {
        loadImage(ctx.clipboardImage, 'clipboard');
      } else {
        const prefill =
          ctx.selection && ctx.selection.length > 0
            ? { text: ctx.selection, source: 'selection' }
            : ctx.clipboard && ctx.clipboard.length > 0
              ? { text: ctx.clipboard, source: 'clipboard' }
              : null;
        if (prefill && ta.value.length === 0) {
          ta.value = prefill.text;
          ta.select();
          textIsPrefill = true;
          clipTag.textContent = prefill.source;
          clipTag.hidden = false;
          field.classList.add('is-loaded');
        }
      }
      if (ctx.accessibility === 'denied') axEnable.hidden = false;
    })
    .catch(() => {});

  // QCAP-9/13: steer to the relevant Privacy pane (Accessibility / Screen Recording) — main opens it
  // with a fallback, never a dead-end. The sheet keeps working (degrades) meanwhile.
  axEnable.addEventListener('click', () => void window.kbApi.openAccessibilitySettings());
  shotEnable.addEventListener('click', () => void window.kbApi.openScreenRecordingSettings());

  // QCAP-13: a screenshot button → capture (full/region/window). Granted → load as an image; denied →
  // brass steer + degrade-to-paste hint; cancelled (the user dismissed an interactive pick) → benign.
  const shoot = async (mode: ScreenshotMode): Promise<void> => {
    const res = await window.kbApi.quickCaptureScreenshot(mode);
    if (res.status === 'granted' && res.image) {
      loadImage(res.image, 'screenshot');
      shotEnable.hidden = true;
      setNote('screenshot ready — ⏎ to save', 'viz-state-settled');
    } else if (res.status === 'denied') {
      shotEnable.hidden = false; // the quiet brass steer (needs-you, not error)
      setNote('screen recording off — paste an image instead');
    }
    // 'cancelled' / 'unsupported' → no-op (never a stuck error state)
  };
  (root.querySelector('#qcapShotFull') as HTMLButtonElement).addEventListener('click', () => void shoot('full'));
  (root.querySelector('#qcapShotRegion') as HTMLButtonElement).addEventListener('click', () => void shoot('region'));
  (root.querySelector('#qcapShotWindow') as HTMLButtonElement).addEventListener('click', () => void shoot('window'));

  ta.addEventListener('input', () => {
    textIsPrefill = false;
    // A TEXT prefill being edited drops its tag (now typed material). A pending IMAGE keeps its tag —
    // the typed text is just an optional caption riding alongside the image.
    if (!pendingImage && !clipTag.hidden) {
      clipTag.hidden = true;
      field.classList.remove('is-loaded');
    }
    setNote(''); // a fresh edit clears a prior failure notice
  });

  ta.focus();

  const cancel = (): void => {
    void window.kbApi.quickCaptureClose(); // QCAP-2: dismiss + restore prior-app focus
  };

  const submit = async (): Promise<void> => {
    const text = ta.value;
    const inputs: Array<{ kind: 'text'; text: string } | { kind: 'screenshot'; handle: string; name: string }> = [];
    if (pendingImage) inputs.push({ kind: 'screenshot', handle: pendingImage.handle, name: pendingImage.name });
    if (text.trim().length > 0) inputs.push({ kind: 'text', text });
    if (inputs.length === 0) {
      cancel(); // nothing to save → frictionless cancel, never a stuck empty sheet
      return;
    }
    // QCAP-2 fast-out: capture returns on preserve+commit, never blocking on Enrich (CAPTURE-2).
    const res = await window.kbApi.quickCapture({ inputs });
    if (res.ok) {
      // QCAP-10: the rule takes ember + a patina `preserved` tick, then auto-dismiss (the line took it).
      field.classList.add('is-saving');
      setNote('preserved', 'viz-state-settled');
      setTimeout(() => void window.kbApi.quickCaptureClose(), QCAP_CONFIRM_MS); // QCAP-2 auto-dismiss
    } else {
      // Failure HOLDS in oxide with ⏎ retry — never auto-dismisses, so a lost capture can't be missed.
      field.classList.add('is-error');
      setNote(`couldn't save — ⏎ retry${res.message ? ` (${esc(res.message)})` : ''}`, 'viz-state-error');
    }
  };

  root.querySelector('#qcapSave')!.addEventListener('click', () => void submit());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  });
}
