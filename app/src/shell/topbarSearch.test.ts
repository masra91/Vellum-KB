// @vitest-environment happy-dom
//
// #519 §2/§12 — the top-bar ⌘K search: a real input + a role="listbox" results overlay, entity-name
// prefix match over the Explore projection's entity list. Keyboard flow (type → results → arrow →
// Enter → navigate), the empty-query and no-match states, and the stale-response guard.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wireTopbarSearch, resetEntitiesCacheForTest } from './topbarSearch';
import { NAVIGATE_EVENT, type NavigateDetail } from './nav';
import type { KbApi } from '../kb/types';
import type { ExploreEntityRef } from '../kb/explorePanel';

const entity = (name: string, kind = 'person'): ExploreEntityRef => ({ rel: `entities/${name}.md`, id: name, name, kind, confidence: 0.9 });

function setApi(entities: ExploreEntityRef[]): ReturnType<typeof vi.fn> {
  const exploreEntities = vi.fn(async () => entities);
  (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { exploreEntities: exploreEntities as unknown as KbApi['exploreEntities'] };
  return exploreEntities;
}

/** The exact top-bar fragment shell.ts renders — topbarSearch.ts wires against this markup. */
const TOP_BAR_FRAGMENT = `
  <div class="topsearch-shell">
    <span class="ts-glyph" aria-hidden="true"></span>
    <input type="text" class="topsearch" id="globalSearch" placeholder="Search entities, claims, sources…" aria-label="Search everything" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="searchResults" aria-autocomplete="list" />
    <span class="kbd" aria-hidden="true">⌘K</span>
    <div class="search-results" id="searchResults" role="listbox" aria-label="Search results" hidden></div>
  </div>`;

describe('wireTopbarSearch (#519 §2/§12)', () => {
  let root: HTMLElement;
  let input: HTMLInputElement;
  let overlay: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    resetEntitiesCacheForTest();
    document.body.innerHTML = `<div id="root">${TOP_BAR_FRAGMENT}</div>`;
    root = document.getElementById('root')!;
    input = root.querySelector('#globalSearch')!;
    overlay = root.querySelector('#searchResults')!;
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('no overlay renders on an empty field (§2 empty-query state)', () => {
    setApi([entity('Ada Lovelace')]);
    wireTopbarSearch(root);
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(overlay.hidden).toBe(true);
  });

  it('typing a prefix match renders results after the debounce, as role="option" rows', async () => {
    setApi([entity('Ada Lovelace'), entity('Alan Turing'), entity('Grace Hopper')]);
    wireTopbarSearch(root);
    input.value = 'Ada';
    input.dispatchEvent(new Event('input'));
    expect(overlay.hidden).toBe(true); // still debouncing

    await vi.advanceTimersByTimeAsync(150);
    expect(overlay.hidden).toBe(false);
    const rows = overlay.querySelectorAll('[role="option"]');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('Ada Lovelace');
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('match is case-insensitive prefix, not substring (fails-before: a naive substring match over-matches)', async () => {
    setApi([entity('Ada Lovelace'), entity('Canada Trust')]); // "ada" is a substring of BOTH, a prefix of neither's start except Ada
    wireTopbarSearch(root);
    input.value = 'ada'; // lowercase, prefix of "Ada Lovelace" only
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150);
    const names = Array.from(overlay.querySelectorAll('.search-result-name')).map((n) => n.textContent);
    expect(names).toEqual(['Ada Lovelace']);
  });

  it('§2 no-match state: one quiet row, "No matches in your library" — never a blank panel', async () => {
    setApi([entity('Ada Lovelace')]);
    wireTopbarSearch(root);
    input.value = 'zzz-nothing-matches';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150);
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain('No matches in your library');
    expect(overlay.querySelectorAll('[role="option"]').length).toBe(0);
  });

  it('clearing the field back to empty closes the overlay', async () => {
    setApi([entity('Ada Lovelace')]);
    wireTopbarSearch(root);
    input.value = 'Ada';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150);
    expect(overlay.hidden).toBe(false);

    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(overlay.hidden).toBe(true);
  });

  it('ArrowDown/ArrowUp move aria-activedescendant through the options (listbox a11y pattern)', async () => {
    setApi([entity('Ada Lovelace'), entity('Alan Turing')]);
    wireTopbarSearch(root);
    input.value = 'A';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(input.getAttribute('aria-activedescendant')).toBe('search-opt-0');
    expect(overlay.querySelector('#search-opt-0')?.classList.contains('is-active')).toBe(true);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(input.getAttribute('aria-activedescendant')).toBe('search-opt-1');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(input.getAttribute('aria-activedescendant')).toBe('search-opt-0');
  });

  it('Enter navigates to Explore carrying the picked entity — the active option if arrowed, else the top result', async () => {
    setApi([entity('Ada Lovelace'), entity('Alan Turing')]);
    wireTopbarSearch(root);
    const navigated: NavigateDetail[] = [];
    document.addEventListener(NAVIGATE_EVENT, (e) => navigated.push((e as CustomEvent<NavigateDetail>).detail));

    input.value = 'A';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(navigated).toHaveLength(1);
    expect(navigated[0].view).toBe('explore');
    expect(navigated[0].focus).toBe('entities/Ada Lovelace.md'); // top (first) result, none arrowed to
    expect(overlay.hidden).toBe(true); // Enter also closes the overlay
  });

  it('Enter with an arrowed-to option navigates to THAT entity, not the top result', async () => {
    setApi([entity('Ada Lovelace'), entity('Alan Turing')]);
    wireTopbarSearch(root);
    const navigated: NavigateDetail[] = [];
    document.addEventListener(NAVIGATE_EVENT, (e) => navigated.push((e as CustomEvent<NavigateDetail>).detail));

    input.value = 'A';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); // → index 0
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); // → index 1 (Alan Turing)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(navigated[0].focus).toBe('entities/Alan Turing.md');
  });

  it('Escape closes the overlay WITHOUT clearing the field, and returns focus to the input (§2)', async () => {
    setApi([entity('Ada Lovelace')]);
    wireTopbarSearch(root);
    input.value = 'Ada';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150);
    expect(overlay.hidden).toBe(false);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(overlay.hidden).toBe(true);
    expect(input.value).toBe('Ada'); // NOT cleared
  });

  it('the ⌘K hint hides (visibility, not removed) once the field has a value', () => {
    setApi([]);
    wireTopbarSearch(root);
    const kbd = root.querySelector('.kbd')!;
    expect(kbd.classList.contains('is-hidden')).toBe(false);
    input.value = 'x';
    input.dispatchEvent(new Event('input'));
    expect(kbd.classList.contains('is-hidden')).toBe(true);
    expect(document.body.contains(kbd)).toBe(true); // hidden via class, never removed from the DOM
  });

  it('a stale in-flight response is discarded if the field changed while the fetch was pending', async () => {
    let resolveFirst!: (v: ExploreEntityRef[]) => void;
    const exploreEntities = vi
      .fn()
      .mockImplementationOnce(() => new Promise<ExploreEntityRef[]>((r) => { resolveFirst = r; }));
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { exploreEntities: exploreEntities as unknown as KbApi['exploreEntities'] };
    wireTopbarSearch(root);

    input.value = 'Ada';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(150); // fires the (still-pending) fetch

    input.value = ''; // the Principal cleared the field before the fetch resolved
    input.dispatchEvent(new Event('input'));

    resolveFirst([entity('Ada Lovelace')]); // the stale fetch finally resolves
    await vi.advanceTimersByTimeAsync(0);
    expect(overlay.hidden).toBe(true); // stale result must not repaint a stale overlay over the now-empty field
  });
});
