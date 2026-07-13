// Top-bar global search (#519 §2, VUX-3) — a real `<input>` + a minimal results overlay: entity-name
// prefix match over the Explore projection's entity list (`window.kbApi.exploreEntities()` — the same
// read already built for Explore's own "Focus an entity" picker). v1 scope per the issue: no full-text
// search over claims/sources yet; this closes the AC's "Enter does something observable" bar by
// navigating to Explore, re-centered on the picked entity (nav.ts's pendingFocus seam).
import { esc } from './html';
import { navigateTo } from './nav';
import { VIEW_EXPLORE } from './views';
import type { ExploreEntityRef } from '../kb/explorePanel';

const DEBOUNCE_MS = 150;
const MAX_RESULTS = 8;

// Session-cached entity list — a maintained-projection read (not a live scan), cheap to hold. A brand
// new entity created mid-session won't appear in search until the next mount; acceptable v1 tradeoff,
// not something #519 asks this pass to solve (Explore's own picker has the identical staleness today).
let entitiesCache: readonly ExploreEntityRef[] | null = null;
let entitiesPromise: Promise<readonly ExploreEntityRef[]> | null = null;

async function entities(): Promise<readonly ExploreEntityRef[]> {
  if (entitiesCache) return entitiesCache;
  entitiesPromise ??= window.kbApi.exploreEntities().catch(() => []);
  const list = await entitiesPromise;
  entitiesCache = list;
  return list;
}

/** Test-only: drop the session cache so a fresh `wireTopbarSearch` call re-fetches. */
export function resetEntitiesCacheForTest(): void {
  entitiesCache = null;
  entitiesPromise = null;
}

interface SearchState {
  results: ExploreEntityRef[];
  activeIndex: number; // -1 = no option active (typed but not yet arrowed to one)
}

/**
 * Wire the top bar's search `<input>` + its `role="listbox"` overlay. Call once per shell mount — the
 * elements themselves are recreated on each mount (shell.ts rebuilds `root.innerHTML`), so there's no
 * cross-mount handler leak to guard (unlike the shell's document-level ⌘K/nav listeners).
 */
export function wireTopbarSearch(root: HTMLElement): HTMLInputElement | null {
  const input = root.querySelector<HTMLInputElement>('#globalSearch');
  const overlay = root.querySelector<HTMLElement>('#searchResults');
  const kbdHint = root.querySelector<HTMLElement>('.topsearch-shell .kbd');
  if (!input || !overlay) return null;

  const state: SearchState = { results: [], activeIndex: -1 };
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const closeOverlay = (): void => {
    overlay.hidden = true;
    overlay.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    state.results = [];
    state.activeIndex = -1;
  };

  const paintOverlay = (): void => {
    if (state.results.length === 0) {
      // §2 no-match state — one quiet row, never a blank panel hanging open.
      overlay.innerHTML = `<div class="search-empty" role="presentation">No matches in your library</div>`;
    } else {
      overlay.innerHTML = state.results
        .map((r, i) => {
          const active = i === state.activeIndex;
          return (
            `<div class="search-result${active ? ' is-active' : ''}" id="search-opt-${i}" role="option" ` +
            `aria-selected="${active}" data-idx="${i}">` +
            `<span class="search-result-name">${esc(r.name)}</span>` +
            `<span class="search-result-kind">${esc(r.kind)}</span></div>`
          );
        })
        .join('');
    }
    overlay.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (state.activeIndex >= 0) input.setAttribute('aria-activedescendant', `search-opt-${state.activeIndex}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const runSearch = async (query: string): Promise<void> => {
    const q = query.trim().toLowerCase();
    if (!q) {
      closeOverlay(); // §2 — no overlay renders on an empty field
      return;
    }
    const all = await entities();
    // Stale-response guard: the field may have changed (or emptied) while this fetch/debounce was in flight.
    if (input.value.trim().toLowerCase() !== q) return;
    state.results = all.filter((e) => e.name.toLowerCase().startsWith(q)).slice(0, MAX_RESULTS);
    state.activeIndex = -1;
    paintOverlay();
  };

  input.addEventListener('input', () => {
    // §2 — the ⌘K hint hides (not removed) once the field has a value, so it never collides with typed text.
    kbdHint?.classList.toggle('is-hidden', input.value.length > 0);
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    const q = input.value;
    if (!q.trim()) {
      // Clearing needs no fetch, so it needs no debounce — close immediately, not 150ms later.
      closeOverlay();
      return;
    }
    debounceTimer = setTimeout(() => void runSearch(q), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (overlay.hidden && e.key !== 'Escape') return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.results.length === 0) return;
      state.activeIndex = (state.activeIndex + 1) % state.results.length;
      paintOverlay();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.results.length === 0) return;
      state.activeIndex = (state.activeIndex - 1 + state.results.length) % state.results.length;
      paintOverlay();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = state.activeIndex >= 0 ? state.results[state.activeIndex] : state.results[0];
      if (pick) {
        navigateTo(VIEW_EXPLORE, pick.rel);
        closeOverlay();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeOverlay(); // §2 — closes without clearing the field, returns focus to the input
      input.focus();
    }
  });

  // A short delay so a mousedown on a result (which would otherwise blur-then-lose the click) still
  // registers before the overlay tears down.
  input.addEventListener('blur', () => {
    window.setTimeout(closeOverlay, 150);
  });

  overlay.addEventListener('mousedown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.search-result');
    if (!row) return;
    e.preventDefault(); // keep focus on the input rather than losing it to the click first
    const pick = state.results[Number(row.dataset.idx)];
    if (pick) {
      navigateTo(VIEW_EXPLORE, pick.rel);
      closeOverlay();
    }
  });

  return input;
}
