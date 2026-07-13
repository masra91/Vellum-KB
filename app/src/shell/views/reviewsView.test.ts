// @vitest-environment happy-dom
//
// SPEC-0018 Reviews view + #110 (badge/list reconciliation). Component tier (happy-dom). The IPC is
// mocked (`window.kbApi.listReviews` / `answerReview`); we assert the rendered DOM and that the list
// stays in sync with the live rail badge (both read `listReviews()`), including the CONNECT-15
// ambiguous-link review type (empty subject → empty `refs`).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountReviews } from './reviewsView';
import { LOAD_TIMEOUT_MS } from '../loadGuard';
import type { KbApi, ReviewSummary } from '../../kb/types';

const POLL_MS = 5000; // keep in sync with REVIEW_POLL_MS in reviewsView.ts

const CLAIM_REVIEW: ReviewSummary = {
  id: 'R1',
  question: 'Is "Ada" the mathematician Ada Lovelace?',
  detail: 'Two sources mention "Ada" with different roles.',
  stage: 'claims',
  refs: ['Ada'],
  createdAt: '2026-06-02T10:00:00.000Z',
};
// A CONNECT-15 ambiguous-link review: NO entity subject → empty refs, raised by `connect`.
const LINK_REVIEW: ReviewSummary = {
  id: 'L1',
  question: 'Should "Ada Lovelace" link to "Analytical Engine"?',
  detail: '"Ada Lovelace" relates to "engine", which matches multiple entities: Analytical Engine, Difference Engine.',
  stage: 'connect',
  refs: [],
  createdAt: '2026-06-02T11:00:00.000Z',
};

function setApi(
  list: KbApi['listReviews'],
  answerReview?: KbApi['answerReview'],
  openCitation?: KbApi['openCitation'],
  reviewProjection?: KbApi['reviewProjection'],
): void {
  // The view reads the warming-aware ENVELOPE (`reviewProjection`), not the flattened `listReviews`
  // (SPEC-0060 VUX-13). By default derive the envelope from the same `list` mock so existing tests
  // (which return a ReviewSummary[]) keep working; the warming/error tests pass an explicit override.
  const derived: KbApi['reviewProjection'] = async () => ({ data: await list(), builtAt: '2026-06-02T12:00:00.000Z', stale: false });
  (window as unknown as { kbApi: Pick<KbApi, 'listReviews' | 'answerReview' | 'openCitation' | 'reviewProjection'> }).kbApi = {
    listReviews: list,
    reviewProjection: reviewProjection ?? derived,
    answerReview: answerReview ?? vi.fn(async () => ({ ok: true, message: 'answered' })),
    openCitation: openCitation ?? vi.fn(async () => ({ ok: true as const })),
  };
}

// REVIEW-16: a disambiguation review — two candidates that share the name "Ada", told apart by their
// agent-authored glosses, each with a working source link. The view renders these as rows.
const DISAMBIG_REVIEW: ReviewSummary = {
  id: 'D1',
  question: 'Is "Ada" from the fishing trip the same person as "Ada" from Dave\'s wedding?',
  detail: 'Two sources mention "Ada" in unrelated contexts.',
  stage: 'connect',
  refs: ['Ada'],
  candidates: [
    { name: 'Ada', gloss: 'from the fishing trip', title: 'Fishing trip notes', sourceRel: 'sources/2026/06/01/01ABC/source.md' },
    { name: 'Ada', gloss: "from Dave's wedding", title: "Dave's wedding guest list", sourceRel: 'sources/2026/06/02/01XYZ/source.md' },
  ],
  createdAt: '2026-06-02T12:00:00.000Z',
};

describe('Reviews view (SPEC-0018) + #110 list/badge reconciliation', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="host"></div>';
    root = document.createElement('div');
    document.getElementById('host')!.appendChild(root);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders open reviews with Confirm/Reject (REVIEW-10)', async () => {
    setApi(vi.fn(async () => [CLAIM_REVIEW]));
    await mountReviews(root);
    expect(root.querySelector('.review-q')?.textContent).toContain('Ada Lovelace');
    expect(root.querySelector('.review-confirm')).toBeTruthy();
    expect(root.querySelector('.review-reject')).toBeTruthy();
    expect(root.textContent).toContain('About: Ada');
  });

  it('UX v2 (SPEC-0058): v2 material surface, Spectral head, no emoji — items present (ember spine is CSS)', async () => {
    setApi(vi.fn(async () => [CLAIM_REVIEW]));
    await mountReviews(root);
    // lifted off the legacy `.card` onto the scoped v2 surface; head is the Spectral voice, no 🔍
    expect(root.querySelector('.reviews-v2.viz-surface')).toBeTruthy();
    expect(root.querySelector('.reviews-title.viz-voice')?.textContent).toBe('Reviews');
    expect(root.querySelector('.card')).toBeNull(); // legacy card chrome gone
    expect(root.querySelector('.review')).toBeTruthy(); // the item (its ember decision-spine is in CSS)
    // no raw emoji anywhere (🔍 head / 🎉 empty removed, #184)
    expect(/[\u{1F300}-\u{1FAFF}]|🔍|🎉/u.test(root.textContent ?? '')).toBe(false);
  });

  it('UX v2: the empty state is the calm v2 .viz-empty (no 🎉, no ember)', async () => {
    setApi(vi.fn(async () => []));
    await mountReviews(root);
    expect(root.querySelector('.viz-empty')).toBeTruthy();
    expect(root.textContent).toContain('Nothing needs you');
    expect(root.textContent).not.toContain('🎉');
  });

  it('PRIN-24 backstop: scrubs a raw source ULID parroted into the question / detail / gloss', async () => {
    const ULID = '01KTJHC7MYV1MZ8XEBA4AAJH3M';
    const leaky: ReviewSummary = {
      id: 'U1',
      question: `Is Ciaran (sole mention, from source ${ULID}) the same person?`,
      detail: `Both candidates trace to ${ULID}.`,
      stage: 'connect',
      refs: [],
      candidates: [{ name: 'Ciaran', gloss: `sole mention, from source ${ULID}`, title: 'A note' }],
      createdAt: '2026-06-02T12:00:00.000Z',
    };
    setApi(vi.fn(async () => [leaky]));
    await mountReviews(root);
    // The raw id must NEVER reach the Principal — anywhere in the rendered surface.
    expect(root.textContent).not.toContain(ULID);
    // …replaced with a neutral word (not deleted), so the sentence still reads.
    expect(root.querySelector('.review-q')?.textContent).toContain('a source');
    expect(root.querySelector('.review-candidate-gloss')?.textContent).toContain('a source');
  });

  it('WS2 PR3: composes the shared Button + EditableField primitives (DESIGN-SYS §8/§9)', async () => {
    setApi(vi.fn(async () => [CLAIM_REVIEW]));
    await mountReviews(root);
    // Button — Confirm is the emphasized action (.viz-btn--primary); Reject is the neutral .viz-btn.
    const confirm = root.querySelector('.review-confirm');
    expect(confirm?.classList.contains('viz-btn')).toBe(true);
    expect(confirm?.classList.contains('viz-btn--primary')).toBe(true);
    expect(confirm?.classList.contains('primary')).toBe(false); // bespoke chrome dropped → the primitive
    const reject = root.querySelector('.review-reject');
    expect(reject?.classList.contains('viz-btn')).toBe(true);
    // EditableField — the note is a labelled multiline input (a11y: the .viz-field label wraps the control).
    const field = root.querySelector('.review-note-field.viz-field');
    expect(field).not.toBeNull();
    expect(field?.querySelector('.viz-field__label')).not.toBeNull();
    const note = root.querySelector('.review-note');
    expect(note?.classList.contains('viz-field__input')).toBe(true);
    expect(note?.classList.contains('viz-field__input--multiline')).toBe(true);
  });

  it('#145: a hung listReviews times out → retryable error (no infinite spinner), and Retry re-loads', async () => {
    const list = vi.fn<KbApi['listReviews']>().mockReturnValue(new Promise<ReviewSummary[]>(() => {})); // hangs
    setApi(list);
    const mounted = mountReviews(root);
    expect(root.querySelector('.rev-skeleton')).toBeTruthy(); // calm warming skeleton initially (VUX-13)

    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS); // trip the timeout
    await mounted;
    expect(root.querySelector('.rev-skeleton')).toBeFalsy(); // no infinite skeleton
    expect(root.querySelector('.load-error')).toBeTruthy();
    expect(root.querySelector('.load-retry')).toBeTruthy();

    // Retry succeeds → the list renders.
    list.mockResolvedValue([CLAIM_REVIEW]);
    root.querySelector<HTMLButtonElement>('.load-retry')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.review-q')?.textContent).toContain('Ada Lovelace');
  });

  it('renders a CONNECT-15 ambiguous-LINK review (empty subject) — confirm/reject, no "About" line (#110)', async () => {
    setApi(vi.fn(async () => [LINK_REVIEW]));
    await mountReviews(root);
    expect(root.querySelector('.review-q')?.textContent).toContain('Analytical Engine');
    expect(root.textContent).toContain('matches multiple entities'); // detail rendered verbatim
    expect(root.querySelector('.review-confirm')).toBeTruthy();
    expect(root.querySelector('.review-reject')).toBeTruthy();
    expect(root.textContent).toContain('Raised by: connect');
    expect(root.textContent).not.toContain('About:'); // empty refs → no subject line, not a crash
  });

  it('list catches up to the badge: a review raised after mount appears on the next poll (#110)', async () => {
    const list = vi
      .fn<KbApi['listReviews']>()
      .mockResolvedValueOnce([]) // mounted while the queue was empty
      .mockResolvedValue([LINK_REVIEW]); // then a link review is raised
    setApi(list);
    await mountReviews(root);
    expect(root.textContent).toContain('Nothing needs you'); // initial empty state (the frozen bug)

    await vi.advanceTimersByTimeAsync(POLL_MS); // the visibility-aware poll fires
    expect(root.textContent).not.toContain('Nothing needs you');
    expect(root.querySelector('.review-q')?.textContent).toContain('Analytical Engine');
  });

  it('does not repoll-repaint when the open set is unchanged (no flicker)', async () => {
    setApi(vi.fn(async () => [CLAIM_REVIEW]));
    await mountReviews(root);
    const firstList = root.querySelector('.review-list');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(root.querySelector('.review-list')).toBe(firstList); // same node — not re-innerHTML'd
  });

  it('skips the poll while the view is hidden (another view is shown)', async () => {
    const list = vi.fn<KbApi['listReviews']>().mockResolvedValueOnce([]).mockResolvedValue([LINK_REVIEW]);
    setApi(list);
    await mountReviews(root);
    root.classList.add('hidden'); // shell un-shows this view
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(list).toHaveBeenCalledTimes(1); // no fetch while hidden
    expect(root.textContent).toContain('Nothing needs you');
  });

  it('never clobbers a note being written: defers the repaint while a note is dirty', async () => {
    const list = vi.fn<KbApi['listReviews']>().mockResolvedValueOnce([CLAIM_REVIEW]).mockResolvedValue([CLAIM_REVIEW, LINK_REVIEW]);
    setApi(list);
    await mountReviews(root);
    const note = root.querySelector<HTMLTextAreaElement>('.review-note')!;
    note.value = 'half-written correction'; // dirty
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(note.value).toBe('half-written correction'); // preserved
    expect(root.querySelectorAll('.review')).toHaveLength(1); // repaint deferred — note intact

    note.value = ''; // note cleared → next poll is free to refresh
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(root.querySelectorAll('.review')).toHaveLength(2);
  });

  it('answering removes the item from the queue', async () => {
    const list = vi.fn<KbApi['listReviews']>().mockResolvedValueOnce([CLAIM_REVIEW]).mockResolvedValue([]);
    const answerReview = vi.fn(async () => ({ ok: true, message: 'answered' }));
    setApi(list, answerReview);
    await mountReviews(root);
    root.querySelector<HTMLButtonElement>('.review-confirm')!.click();
    await vi.advanceTimersByTimeAsync(340); // flush the answer + forced refresh + the exit-motion settle (#520 §10)
    expect(answerReview).toHaveBeenCalledWith({ id: 'R1', verdict: 'confirm', note: undefined });
    expect(root.textContent).toContain('Nothing needs you');
  });

  it('stops polling once the view is detached from the document', async () => {
    const list = vi.fn(async () => [CLAIM_REVIEW]);
    setApi(list);
    await mountReviews(root);
    const callsAfterMount = list.mock.calls.length;
    root.remove(); // shell tears the view out
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(list.mock.calls.length).toBe(callsAfterMount); // no further polling
  });

  // --- REVIEW-16: disambiguation candidate rows -------------------------------------------------
  describe('REVIEW-16 candidate rows', () => {
    it('renders one row per candidate, gloss-first, so the Principal can tell them apart', async () => {
      setApi(vi.fn(async () => [DISAMBIG_REVIEW]));
      await mountReviews(root);
      const rows = root.querySelectorAll('.review-candidate');
      expect(rows).toHaveLength(2);
      const glosses = Array.from(root.querySelectorAll('.review-candidate-gloss')).map((g) => g.textContent);
      expect(glosses).toEqual(['from the fishing trip', "from Dave's wedding"]);
      // The shared name is shown as the row label (both are "Ada"); the gloss is what distinguishes.
      expect(Array.from(root.querySelectorAll('.review-candidate-name')).map((n) => n.textContent)).toEqual(['Ada', 'Ada']);
    });

    it('"Open in Obsidian" opens that candidate\'s source via openCitation (reuses the EXPLORE-4 IPC)', async () => {
      const openCitation = vi.fn(async () => ({ ok: true as const }));
      setApi(vi.fn(async () => [DISAMBIG_REVIEW]), undefined, openCitation);
      await mountReviews(root);
      const links = root.querySelectorAll<HTMLButtonElement>('.review-candidate-open');
      expect(links).toHaveLength(2);
      links[1].click(); // open the second candidate's source
      expect(openCitation).toHaveBeenCalledWith('sources/2026/06/02/01XYZ/source.md'); // the FILE, not the dir
    });

    it('renders the source TITLE as the link text (PRIN-24) — not a generic label or a raw ULID', async () => {
      // The live bug: the link showed a generic "Open in Obsidian" and the Principal saw a raw ULID / dead
      // dir. Fix: the link TEXT is the human source title, opening source.md.
      setApi(vi.fn(async () => [DISAMBIG_REVIEW]));
      await mountReviews(root);
      const links = Array.from(root.querySelectorAll<HTMLButtonElement>('.review-candidate-open'));
      expect(links.map((l) => l.textContent?.trim())).toEqual(['Fishing trip notes ↗', "Dave's wedding guest list ↗"]);
      expect(root.textContent).not.toContain('Open in Obsidian'); // generic placeholder gone from visible text
      expect(links[0].title).toBe('Open in Obsidian'); // survives only as the accessible action label (tooltip)
    });

    it('omits the link for a candidate with no known sourceRel (renders gloss only)', async () => {
      const review: ReviewSummary = {
        ...DISAMBIG_REVIEW,
        candidates: [
          { name: 'Ada', gloss: 'from the fishing trip', title: 'Fishing trip notes', sourceRel: 'sources/2026/06/01/01ABC/source.md' },
          { name: 'Ada', gloss: 'mentioned only in passing', title: 'Ada' }, // no sourceRel (title falls back to name)
        ],
      };
      setApi(vi.fn(async () => [review]));
      await mountReviews(root);
      expect(root.querySelectorAll('.review-candidate')).toHaveLength(2);
      expect(root.querySelectorAll('.review-candidate-open')).toHaveLength(1); // only the one with a source
    });

    it('esc()s the source-/agent-derived name/gloss/title — untrusted text never reaches an HTML sink (XSS)', async () => {
      const xss = '<img src=x onerror="window.__pwned=1">';
      const review: ReviewSummary = {
        ...DISAMBIG_REVIEW,
        candidates: [{ name: xss, gloss: xss, title: xss, sourceRel: '"><script>window.__pwned=1</script>' }],
      };
      setApi(vi.fn(async () => [review]));
      await mountReviews(root);
      // The payload renders as inert text, not DOM: no injected <img>/<script>, and the row is intact.
      expect(root.querySelector('.review-candidate-gloss')?.textContent).toBe(xss);
      expect(root.querySelector('.review-candidate-gloss img')).toBeNull();
      expect(root.querySelector('.review-candidate script')).toBeNull();
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
      // The malicious TITLE renders as inert link text (PRIN-24 fix surface), not DOM.
      const openBtn = root.querySelector<HTMLButtonElement>('.review-candidate-open');
      expect(openBtn?.textContent?.trim()).toBe(`${xss} ↗`);
      expect(openBtn?.querySelector('img')).toBeNull();
      // The malicious sourceRel survives only as an inert data attribute, round-tripped verbatim.
      expect(openBtn?.dataset.rel).toBe('"><script>window.__pwned=1</script>');
    });

    it('an ordinary review (no candidates) renders no candidate block — unchanged behaviour', async () => {
      setApi(vi.fn(async () => [CLAIM_REVIEW]));
      await mountReviews(root);
      expect(root.querySelector('.review-candidates')).toBeNull();
    });
  });

  // REVIEW-19 / ENG-15/16: the LIVE queue carries partial/legacy/malformed records — e.g. candidates
  // raised BEFORE title-persistence (#295/#305) carry `title: null` on disk (55 such / 9 open reviews
  // observed live, incl. "Jordan"). The old render did `esc(c.title)` (→ `.replace` on null) inside a
  // `.map`, throwing AFTER the fetch resolved → the WHOLE list never painted ("Loading… forever")
  // while the rail badge still showed a count. These lock the null-safe + per-item-isolation fix.
  describe('REVIEW-19 / ENG-15/16 — partial / legacy / malformed data never blanks the list', () => {
    const legacyTitleNull: ReviewSummary = {
      id: 'D-legacy',
      question: 'Is this "Jordan" the same as that "Jordan"?',
      detail: 'Raised before title-persistence landed.',
      stage: 'connect',
      refs: ['Jordan'],
      // `title: null` is the real legacy shape (violates the compile-time type → cast, the whole point).
      candidates: [
        { name: 'Jordan', gloss: 'from the climbing log', title: null, sourceRel: 'sources/2026/06/01/01J/source.md' },
        { name: 'Jordan', gloss: 'from the invoice', title: null, sourceRel: 'sources/2026/06/02/01K/source.md' },
      ] as unknown as ReviewSummary['candidates'],
      createdAt: '2026-06-03T09:00:00.000Z',
    };

    it('renders a legacy candidate with title:null — the list PAINTS (fails-before: esc(c.title) threw in .map)', async () => {
      setApi(vi.fn(async () => [legacyTitleNull]));
      await mountReviews(root);
      // The regression was "Loading… forever" — assert the list actually painted.
      expect(root.querySelector('.review-list')).not.toBeNull();
      expect(root.querySelector('.review-q')?.textContent).toContain('Jordan');
      // Both rows render; the link text falls back to the candidate NAME (never esc(undefined), never a ULID).
      const links = root.querySelectorAll<HTMLButtonElement>('.review-candidate-open');
      expect(links).toHaveLength(2);
      expect(links[0].textContent?.trim()).toBe('Jordan ↗');
      expect(root.textContent).not.toContain('undefined');
    });

    it('renders a candidate missing BOTH title and name — generic link text, never esc(undefined)', async () => {
      const review = {
        ...legacyTitleNull,
        id: 'D-noname',
        candidates: [{ gloss: 'only a gloss', sourceRel: 'sources/2026/06/02/01M/source.md' }] as unknown as ReviewSummary['candidates'],
      } as ReviewSummary;
      setApi(vi.fn(async () => [review]));
      await mountReviews(root);
      const link = root.querySelector<HTMLButtonElement>('.review-candidate-open');
      expect(link?.textContent?.trim()).toBe('Open in Obsidian ↗');
      expect(root.textContent).not.toContain('undefined');
    });

    it('ENG-16: one malformed candidate degrades its OWN row — sibling candidates still render', async () => {
      const review = {
        ...legacyTitleNull,
        id: 'D-mixed',
        candidates: [
          { name: 'Jordan', gloss: 'good row', title: 'A real title', sourceRel: 'sources/2026/06/01/01J/source.md' },
          null, // a malformed entry in the array
        ] as unknown as ReviewSummary['candidates'],
      } as ReviewSummary;
      setApi(vi.fn(async () => [review]));
      await mountReviews(root);
      expect(root.querySelectorAll('.review-candidate')).toHaveLength(2); // good row + a safe fallback row
      expect(root.textContent).toContain('A real title'); // the good candidate survived
      expect(root.querySelector('.review-list')).not.toBeNull();
    });

    it('ENG-16: one malformed REVIEW degrades its own row — sibling reviews still render + stay actionable', async () => {
      setApi(vi.fn(async () => [CLAIM_REVIEW, null as unknown as ReviewSummary, DISAMBIG_REVIEW]));
      await mountReviews(root);
      expect(root.querySelectorAll('.review')).toHaveLength(3); // two good + one fallback
      expect(root.textContent).toContain('Ada Lovelace'); // CLAIM_REVIEW survived
      expect(root.textContent).toContain("Dave's wedding"); // DISAMBIG_REVIEW survived
      expect(root.querySelectorAll('.review-confirm').length).toBeGreaterThanOrEqual(2); // good items still answerable
    });
  });

  // REVIEW-20 (#322 UI-never-blocks): answering is OPTIMISTIC — the item leaves the queue the INSTANT
  // the Principal clicks; the verdict IPC + backend resume/merge run async (the UI never waits). The
  // P1 was "confirm/deny takes forever to disappear, waiting on the backend." On async failure we
  // reconcile honestly: re-surface the item with a retryable error affordance.
  describe('REVIEW-20 — optimistic confirm/deny (UI never waits on the backend)', () => {
    /** An answerReview whose promise we resolve by hand — to assert UI state WHILE the IPC is pending.
     *  `resolve` is a STABLE wrapper (the inner resolver is bound lazily when `fn` is first called). */
    function deferredAnswer(): { fn: KbApi['answerReview']; resolve: (ok: boolean) => void } {
      let inner: ((v: { ok: boolean; message: string }) => void) | undefined;
      const fn = vi.fn(
        () => new Promise<{ ok: boolean; message: string }>((res) => { inner = res; }),
      ) as unknown as KbApi['answerReview'];
      return { fn, resolve: (ok) => inner?.({ ok, message: ok ? 'answered' : 'failed' }) };
    }

    it('marks the row leaving IMMEDIATELY on click — before the answer IPC resolves (fails-before: old code awaited it)', async () => {
      const { fn: answerReview, resolve } = deferredAnswer();
      setApi(vi.fn(async () => [CLAIM_REVIEW]), answerReview);
      await mountReviews(root);
      expect(root.querySelector('.review[data-id="R1"]')).not.toBeNull();

      root.querySelector<HTMLButtonElement>('.review-confirm')!.click();
      // Synchronously after the click — the row starts its exit (#520 §10) though the IPC promise is
      // still PENDING; it isn't gone from the queue waiting on the backend (REVIEW-20's core guarantee).
      expect(root.querySelector('.review[data-id="R1"]')?.classList.contains('is-leaving')).toBe(true);
      expect(answerReview).toHaveBeenCalledWith({ id: 'R1', verdict: 'confirm', note: undefined });
      expect(root.textContent).not.toContain('Nothing needs you'); // not yet — still settling out

      // The exit-motion timer (not the backend) drives the actual removal — advance past --dur-settle
      // WITHOUT resolving the IPC, proving removal doesn't wait on the backend either.
      await vi.advanceTimersByTimeAsync(340);
      expect(root.querySelector('.review[data-id="R1"]')).toBeNull();
      expect(root.textContent).toContain('Nothing needs you'); // last item → empty state once settled

      resolve(true); // the backend finally acks — nothing more to paint, the item was already gone
      await vi.advanceTimersByTimeAsync(0);
      expect(root.querySelector('.review[data-id="R1"]')).toBeNull();
    });

    it('the optimistic removal SURVIVES a reconcile poll that still lists the item (no flicker-back)', async () => {
      // The async answer is slow and the 2.5s SHELL-12 projection hasn't dropped the item yet, so a 5s
      // poll still returns it. The suppression must keep it removed until the backend catches up.
      const { fn: answerReview, resolve } = deferredAnswer();
      setApi(vi.fn(async () => [CLAIM_REVIEW]), answerReview); // projection still has it
      await mountReviews(root);
      root.querySelector<HTMLButtonElement>('.review-confirm')!.click();
      expect(root.querySelector('.review[data-id="R1"]')?.classList.contains('is-leaving')).toBe(true);

      await vi.advanceTimersByTimeAsync(POLL_MS); // a reconcile poll fires while the answer is in flight (>> the exit-settle duration)
      expect(root.querySelector('.review[data-id="R1"]')).toBeNull(); // STILL gone — no flicker-back
      expect(root.textContent).toContain('Nothing needs you');
      resolve(true);
      await vi.advanceTimersByTimeAsync(0);
    });

    it('a rejected (ok:false) answer restores the item with a retryable error affordance', async () => {
      const answerReview = vi.fn(async () => ({ ok: false, message: 'canonical lock busy' }));
      setApi(vi.fn(async () => [CLAIM_REVIEW]), answerReview); // still open on the backend (write failed)
      await mountReviews(root);
      root.querySelector<HTMLButtonElement>('.review-confirm')!.click();
      expect(root.querySelector('.review[data-id="R1"]')?.classList.contains('is-leaving')).toBe(true); // optimistically leaving

      await vi.advanceTimersByTimeAsync(0); // flush the failed IPC + the reconcile refresh
      // Restored — the item is back, carries an honest alert, and stays actionable (retry).
      expect(root.querySelector('.review[data-id="R1"]')).not.toBeNull();
      const err = root.querySelector('.review-error');
      expect(err?.getAttribute('role')).toBe('alert');
      expect(err?.textContent).toContain('try again');
      expect(root.querySelector('.review-confirm')).not.toBeNull();
    });

    it('a THROWN answer IPC also restores the item (honest rollback, not a silent drop)', async () => {
      const answerReview = vi.fn(async () => { throw new Error('ipc channel died'); });
      setApi(vi.fn(async () => [CLAIM_REVIEW]), answerReview);
      await mountReviews(root);
      root.querySelector<HTMLButtonElement>('.review-confirm')!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(root.querySelector('.review[data-id="R1"]')).not.toBeNull();
      expect(root.querySelector('.review-error')).not.toBeNull();
    });

    it('retrying after a failure clears the error banner and re-optimistically removes the row', async () => {
      const answerReview = vi
        .fn<KbApi['answerReview']>()
        .mockResolvedValueOnce({ ok: false, message: 'busy' })
        .mockResolvedValueOnce({ ok: true, message: 'answered' });
      setApi(vi.fn(async () => [CLAIM_REVIEW]), answerReview);
      await mountReviews(root);
      root.querySelector<HTMLButtonElement>('.review-confirm')!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(root.querySelector('.review-error')).not.toBeNull(); // failed → banner

      root.querySelector<HTMLButtonElement>('.review-confirm')!.click(); // retry
      expect(root.querySelector('.review[data-id="R1"]')?.classList.contains('is-leaving')).toBe(true); // optimistically leaving again
      await vi.advanceTimersByTimeAsync(340); // exit-motion settle (#520 §10) — row + its stale banner both clear
      expect(root.querySelector('.review[data-id="R1"]')).toBeNull();
      expect(root.querySelector('.review-error')).toBeNull(); // banner gone with the row on the fresh attempt
    });

    it('answering one of several items removes only that row — the others (and their notes) are untouched', async () => {
      setApi(vi.fn(async () => [CLAIM_REVIEW, LINK_REVIEW]), vi.fn(async () => ({ ok: true, message: 'answered' })));
      await mountReviews(root);
      // Type a note on the OTHER item — answering R1 must not clobber it.
      const linkNote = root.querySelector<HTMLTextAreaElement>('.review[data-id="L1"] .review-note')!;
      linkNote.value = 'half-written note on the link review';

      root.querySelector<HTMLButtonElement>('.review[data-id="R1"] .review-confirm')!.click();
      expect(root.querySelector('.review[data-id="R1"]')?.classList.contains('is-leaving')).toBe(true); // answered row leaving
      expect(root.querySelector('.review[data-id="L1"]')).not.toBeNull(); // sibling stays
      expect(root.querySelector<HTMLTextAreaElement>('.review[data-id="L1"] .review-note')!.value).toBe(
        'half-written note on the link review',
      ); // sibling's in-progress note preserved (no full repaint)
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});

// SPEC-0060 VUX-13 — the warming skeleton. On a cold launch the review projection is still building
// for a beat (`reviewProjection()` → null). The OLD view read `listReviews()`, which collapses that
// warming-null to `[]`, so it flashed the "Nothing needs you right now" empty state — wrong-empty, the
// ~2s blank these tests pin down. The fix reads the envelope and paints a skeleton while warming.
describe('Reviews warming skeleton (SPEC-0060 VUX-13 — no 2s blank / wrong-empty)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="host"></div>';
    root = document.createElement('div');
    document.getElementById('host')!.appendChild(root);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('shows the skeleton — NOT the "Nothing needs you" empty state — while the projection is warming', async () => {
    // Warming: the envelope is null (projection not yet built). The list mock is irrelevant here.
    setApi(vi.fn(async () => []), undefined, undefined, vi.fn(async () => null));
    await mountReviews(root);
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.rev-skeleton')).toBeTruthy(); // calm warming affordance
    // Fails-before: the old view collapsed warming→[] and painted the empty state. It must NOT now.
    expect(root.textContent).not.toContain('Nothing needs you right now');
    expect(root.querySelector('.load-error')).toBeFalsy(); // warming is not an error
  });

  it('swaps the skeleton for the real list once the projection finishes building (poll catches up)', async () => {
    // First read warming (null); the poll re-reads and gets a ready envelope with one open review.
    const proj = vi
      .fn<KbApi['reviewProjection']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ data: [CLAIM_REVIEW], builtAt: '2026-06-02T12:00:00.000Z', stale: false });
    setApi(vi.fn(async () => [CLAIM_REVIEW]), undefined, undefined, proj);
    await mountReviews(root);
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.rev-skeleton')).toBeTruthy(); // warming first

    await vi.advanceTimersByTimeAsync(POLL_MS); // the next poll lands the built projection
    expect(root.querySelector('.rev-skeleton')).toBeFalsy();
    expect(root.querySelector('.review-q')?.textContent).toContain('Ada Lovelace');
  });

  it('shows the calm empty state (not a skeleton) once the projection is BUILT and genuinely empty', async () => {
    // Ready + zero open reviews → the queue is honestly quiet; the skeleton must give way to the
    // "Nothing needs you" empty state. This is the distinction the old flattened read could not make.
    setApi(vi.fn(async () => []), undefined, undefined, vi.fn(async () => ({ data: [], builtAt: '2026-06-02T12:00:00.000Z', stale: false })));
    await mountReviews(root);
    await vi.advanceTimersByTimeAsync(0);
    expect(root.querySelector('.rev-skeleton')).toBeFalsy();
    expect(root.textContent).toContain('Nothing needs you right now');
  });
});

// SPEC-0060 VUX-1: the Reviews CSS block migrates off the instrument-panel --viz-* names onto the
// warm-vellum v3 tokens. Ember stays — Reviews is the one sanctioned ember surface (needs-you = decision).
// Guard on the CSS source (happy-dom applies no stylesheet).
describe('VUX-1 v3 token migration (SPEC-0060 — off --viz-*)', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  const block = indexCss.slice(
    indexCss.indexOf('Reviews view — VELLUM v3'),
    indexCss.indexOf('Ask view — VELLUM v3'),
  );

  it('isolated the Reviews v3 block', () => {
    expect(block.length).toBeGreaterThan(500);
  });

  it('the v3 Reviews block carries NO --viz-* tokens (retired, VUX-1)', () => {
    expect(block).not.toMatch(/var\(--viz-/);
  });

  it('keeps ember on the review card + uses v3 ground/ink tokens', () => {
    expect(block).toMatch(/rgba\(200,\s*116,\s*60/); // the sanctioned ember wash/border (needs-you decision)
    expect(block).toMatch(/var\(--ink\b/);
    expect(block).toMatch(/var\(--linen\b/);
  });
});
