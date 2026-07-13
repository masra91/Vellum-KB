// About Vellum (#406 part-2 / SPEC-0057) — the one place we spend the FULL brand identity: a modal
// dialog over the shell with the signature gradient hero (a dark island in the cream app), the Spectral
// wordmark + crystalline lattice mark, one rationed-gold note, and the runtime version below on cream.
//
// Pattern: a modal-on-shell (NOT a root-replacement route like #qcap/showcase) — it overlays whatever
// you're on and returns you there. role=dialog + aria-modal + focus-trap + Esc/scrim dismiss + restored
// focus. Reachable from the Settings footer.
//
// Version: RELEASE-6 (SPEC-0055) — DEV-5 owns the `getAppVersion` IPC; here we just RENDER it, defensively
// (a missing/failed call shows "Version unavailable", never blank/crash — #160). So About closes RELEASE-6.
import { esc } from './html';
import { latticeMotif } from './latticeMotif';

const WORDMARK = 'Vellum';
// Brand §7 voice = outcome-first (avoid AI-forward hype + marketing tics). DL-1 (hero-identity owner)
// authorized this line; AI-Detector gate-1 endorsed the direction.
const TAGLINE = 'A calm second brain — it turns scattered fragments into grounded, connected, citation-backed recall.';
const CREDITS = 'Built on an Obsidian-compatible markdown vault · GitHub Copilot · Electron · OFL faces (Inter · Spectral · IBM Plex Mono).';

// The crystalline lattice mark (brand/assets/icon/vellum-glyph-mono.svg) — strokes use currentColor so it
// recolors to the hero's cream. Inlined (no asar-asset path gotcha); decorative → aria-hidden at the call site.
// #402 §2: generated via the shared latticeMotif() rather than a 4th hand-rolled inline SVG literal.
const MARK_SVG = latticeMotif({
  depth: 2,
  stroke: 'currentColor',
  strokeWidths: [1.5, 1.2],
  roundCaps: true,
  core: 'dot',
  crosshair: true,
  crosshairStrokeWidth: 0.9,
  crosshairOpacity: 0.85,
});

/** Read the runtime version via DEV-5's RELEASE-6 IPC (now typed on KbApi). Honest fallback (#160) if it rejects. */
async function loadVersion(): Promise<string> {
  try {
    const v = await window.kbApi.getAppVersion();
    return v ? `${WORDMARK} · v${v}` : 'Version unavailable';
  } catch {
    return 'Version unavailable';
  }
}

/** Mount the About modal over the shell. Dismissable (Esc / scrim / Close), focus-trapped, restores focus. */
export function mountAboutPanel(host: HTMLElement = document.body): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const scrim = document.createElement('div');
  scrim.className = 'about-scrim';
  scrim.innerHTML = `
    <div class="about-modal viz-surface" role="dialog" aria-modal="true" aria-label="About ${esc(WORDMARK)}">
      <div class="about-hero viz-drift">
        <span class="about-mark" aria-hidden="true">${MARK_SVG}</span>
        <span class="about-wordmark viz-voice">${esc(WORDMARK)}</span>
        <span class="about-rule" aria-hidden="true"></span>
        <p class="about-tagline viz-voice">${esc(TAGLINE)}</p>
      </div>
      <div class="about-body">
        <p class="about-version viz-numeric" aria-live="polite">…</p>
        <p class="about-credits viz-body">${esc(CREDITS)}</p>
        <div class="about-actions"><button type="button" class="about-close viz-btn viz-btn--ghost viz-focusable">Close</button></div>
      </div>
    </div>`;
  host.appendChild(scrim);

  const close = (): void => {
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
    prevFocus?.focus?.(); // restore focus to the trigger (a11y)
  };

  // Focus-trap + Esc. Capture phase so it wins regardless of inner focus.
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = Array.from(scrim.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('disabled'));
    if (f.length === 0) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
  document.addEventListener('keydown', onKey, true);

  // Scrim click OUTSIDE the modal dismisses; a click inside does not.
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  const closeBtn = scrim.querySelector<HTMLButtonElement>('.about-close')!;
  closeBtn.addEventListener('click', close);
  closeBtn.focus(); // initial focus into the dialog

  // Version (async, defensive) — fills once resolved; "Version unavailable" on absent/failed IPC (#160).
  void loadVersion().then((v) => {
    const el = scrim.querySelector<HTMLElement>('.about-version');
    if (el) el.textContent = v;
  });
}
