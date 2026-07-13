// @vitest-environment happy-dom
//
// SPEC-0026 ASK-1/2/8 · SPEC-0060 VUX-11 — the Ask view (v3), in the component tier (SPEC-0012 TEST-5:
// happy-dom via per-file env; the node tier stays the default). The IPC is mocked (`window.kbApi.ask`);
// we assert the rendered DOM + the request shape (incl. multi-turn history). v3 = a full-pane chat on
// the warm-vellum tokens (retires --viz-*): you-bubble + grounded answer (seal · prose · foot · refs),
// a calm skeleton in flight, and the Quick/Considered effort toggle on the ask bar (IA-lock VUX-19).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mountAsk, linkifyCitationMarkers } from './askView';
import type { AskResult, Citation, KbApi, Conversation, ConversationSummary, AskProgressEvent } from '../../kb/types';

const GROUNDED: AskResult = {
  question: 'Who was Ada Lovelace?',
  answer: 'Ada Lovelace is regarded as the first computer programmer.',
  citations: [{ kind: 'claim', ref: 'claims/person/ada-lovelace.md', label: 'first computer programmer' }],
  grounded: true,
  toolCalls: 2,
  truncated: false,
};

function setAsk(fn: KbApi['ask']): void {
  (window as unknown as { kbApi: Pick<KbApi, 'ask'> }).kbApi = { ask: fn };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
function type(root: HTMLElement, value: string): void {
  (root.querySelector('#askInput') as HTMLTextAreaElement).value = value;
}
function submit(root: HTMLElement): void {
  root.querySelector('#askForm')!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

describe('Ask view (SPEC-0026 ASK-1/2/8 · v3)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  it('renders the title, input, and Ask (send) button', () => {
    setAsk(vi.fn(async () => GROUNDED));
    mountAsk(root);
    expect(root.querySelector('h1')?.textContent).toContain('New conversation'); // v3: title is the conversation, not "Ask"
    expect(root.querySelector('#askInput')).toBeTruthy();
    expect(root.querySelector('#askBtn')?.textContent).toContain('Ask');
  });

  describe('UX v3 (SPEC-0060 VUX-11)', () => {
    it('is a full-pane v3 chat — Spectral (--voice) head, no emoji, no v2 .viz-card chrome', () => {
      setAsk(vi.fn(async () => GROUNDED));
      mountAsk(root);
      const view = root.querySelector('.ask-view');
      expect(view).toBeTruthy();
      expect(view?.classList.contains('viz-card')).toBe(false); // off the v2 instrument-panel chrome
      expect(view?.classList.contains('viz-grain')).toBe(false);
      expect(view?.classList.contains('card')).toBe(false);
      expect(root.querySelector('.ask-head')).toBeTruthy();
      expect(root.querySelector('h1')?.textContent).not.toMatch(/💬|🗨|📣/);
    });

    it('surfaces the Quick/Considered effort toggle ON Ask (IA-lock VUX-19), defaulting to Considered', () => {
      setAsk(vi.fn(async () => GROUNDED));
      mountAsk(root);
      const modes = root.querySelectorAll<HTMLElement>('#askModes .ask-mode');
      expect(modes).toHaveLength(2);
      expect(Array.from(modes).map((m) => m.dataset.effort)).toEqual(['quick', 'considered']);
      const on = root.querySelector<HTMLElement>('#askModes .ask-mode.is-on');
      expect(on?.dataset.effort).toBe('considered');
      expect(on?.getAttribute('aria-checked')).toBe('true');
    });

    it('clicking a mode switches the active effort (radio semantics)', () => {
      setAsk(vi.fn(async () => GROUNDED));
      mountAsk(root);
      root.querySelector<HTMLElement>('#askModes .ask-mode[data-effort="quick"]')!.click();
      const on = root.querySelector<HTMLElement>('#askModes .ask-mode.is-on');
      expect(on?.dataset.effort).toBe('quick');
      expect(on?.getAttribute('aria-checked')).toBe('true');
      expect(root.querySelector<HTMLElement>('.ask-mode[data-effort="considered"]')?.getAttribute('aria-checked')).toBe('false');
    });

    it('shows a calm empty invitation before any question (never a blank panel)', () => {
      setAsk(vi.fn(async () => GROUNDED));
      mountAsk(root);
      expect(root.querySelector('.ask-empty')).toBeTruthy();
    });

    it('renders the answer as Spectral prose (.ask-prose) with a v3 reference card (deep-link preserved)', async () => {
      setAsk(vi.fn(async () => GROUNDED));
      mountAsk(root);
      type(root, 'Who was Ada Lovelace?');
      submit(root);
      await tick();
      expect(root.querySelector('.ask-prose')).toBeTruthy();
      const ref = root.querySelector('.ask-ref');
      expect(ref).toBeTruthy();
      expect(ref?.querySelector('.rtitle')?.textContent).toContain('first computer programmer');
    });

    it('shows a calm skeleton + status while in flight (never a scary spinner), and NO ember anywhere', async () => {
      let resolve!: (r: AskResult) => void;
      setAsk(vi.fn(() => new Promise<AskResult>((r) => (resolve = r))));
      mountAsk(root);
      type(root, 'Who was Ada Lovelace?');
      submit(root);
      await tick();
      expect(root.querySelector('.ask-ans.is-thinking')).toBeTruthy();
      expect(root.querySelector('.ask-status')?.textContent).toContain('Searching your library');
      expect(root.querySelector('.ask-skel')).toBeTruthy();
      expect(root.querySelector('[class*="ember"]')).toBeNull(); // Ask is a read, never a decision
      resolve(GROUNDED);
      await tick();
      expect(root.querySelector('.ask-prose')).toBeTruthy(); // resolves to the answer
      expect(root.querySelector('.ask-ans.is-thinking')).toBeNull();
    });
  });

  it('submitting renders a grounded answer with its citations (ASK-1/7)', async () => {
    const ask = vi.fn(async () => GROUNDED);
    setAsk(ask);
    mountAsk(root);
    type(root, 'Who was Ada Lovelace?');
    submit(root);
    await tick();

    expect(ask).toHaveBeenCalledWith({ question: 'Who was Ada Lovelace?', history: [], effort: 'considered' });
    const col = root.querySelector('.ask-col')!;
    expect(col.textContent).toContain('Who was Ada Lovelace?');
    expect(col.textContent).toContain('first computer programmer');
    expect(col.querySelector('.ask-refs')).toBeTruthy();
    // #2: the reference shows the human label + capitalized kind; the raw vault path is in the tooltip, not inline.
    expect(col.querySelector('.ask-ref')!.textContent).toContain('Claim');
    expect(col.querySelector('.ask-refs')!.textContent).not.toContain('claims/person/ada-lovelace.md');
    expect(col.querySelector('.ask-ref')!.getAttribute('title')).toContain('claims/person/ada-lovelace.md');
    expect(ask).toHaveBeenCalledTimes(1); // pull-only: nothing asked before submit
  });

  it('passes prior turns as history (ASK-8 multi-turn)', async () => {
    const ask = vi.fn(async () => GROUNDED);
    setAsk(ask);
    mountAsk(root);
    type(root, 'q1');
    submit(root);
    await tick();
    type(root, 'q2');
    submit(root);
    await tick();
    expect(ask).toHaveBeenLastCalledWith({ question: 'q2', history: [{ question: 'q1', answer: GROUNDED.answer }], effort: 'considered' });
    expect(root.querySelectorAll('.ask-turn')).toHaveLength(2);
  });

  it('sends the selected effort — Quick after toggling, Considered by default (VUX-11, #487 wired)', async () => {
    const ask = vi.fn(async () => GROUNDED);
    setAsk(ask);
    mountAsk(root);
    // default is Considered
    type(root, 'q-default');
    submit(root);
    await tick();
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ question: 'q-default', effort: 'considered' }));
    // toggle to Quick → the next ask carries effort:'quick'
    root.querySelector<HTMLElement>('#askModes .ask-mode[data-effort="quick"]')!.click();
    type(root, 'q-quick');
    submit(root);
    await tick();
    expect(ask).toHaveBeenLastCalledWith(expect.objectContaining({ question: 'q-quick', effort: 'quick' }));
  });

  it('the header reflects the conversation — title = first question, meta counts turns + sources', async () => {
    setAsk(vi.fn(async () => GROUNDED));
    mountAsk(root);
    type(root, 'Who was Ada Lovelace?');
    submit(root);
    await tick();
    expect(root.querySelector('#askTitle')?.textContent).toBe('Who was Ada Lovelace?');
    expect(root.querySelector('#askSub')?.textContent).toContain('1 turn');
    expect(root.querySelector('#askSub')?.textContent).toContain('source');
  });

  it('"New" clears the conversation back to the empty invitation', async () => {
    setAsk(vi.fn(async () => GROUNDED));
    mountAsk(root);
    type(root, 'q1');
    submit(root);
    await tick();
    expect(root.querySelectorAll('.ask-turn')).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('#askNew')!.click();
    expect(root.querySelector('.ask-empty')).toBeTruthy();
    expect(root.querySelector('#askTitle')?.textContent).toBe('New conversation');
  });

  it('flags an ungrounded answer (caution, not error) and shows no references', async () => {
    setAsk(vi.fn(async () => ({ question: 'q', answer: "I don't know.", citations: [], grounded: false, toolCalls: 1, truncated: false })));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    expect(root.querySelector('.ask-ground.is-ungrounded')?.textContent).toContain('Not grounded');
    expect(root.querySelector('.ask-refs')).toBeNull();
  });

  it('flags a truncated (budget-reached) answer', async () => {
    setAsk(vi.fn(async () => ({ ...GROUNDED, truncated: true })));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    expect(root.querySelector('.ask-foot')?.textContent).toContain('budget');
  });

  it('reports the run stat honestly — mode + retrieval count, no faked confidence', async () => {
    setAsk(vi.fn(async () => GROUNDED));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    const stat = root.querySelector('.ask-stat')!;
    expect(stat.querySelector('.smode')?.textContent).toBe('Considered');
    expect(stat.textContent).toContain('2 retrievals');
    expect(root.querySelector('[class*="conf"]')).toBeNull(); // AskResult carries no confidence — none faked
  });

  it('renders an error (never throws to the user) if the recall IPC fails', async () => {
    setAsk(vi.fn(async () => {
      throw new Error('copilot CLI unavailable');
    }));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    expect(root.querySelector('.ask-prose.ask-error')?.textContent).toContain('copilot CLI unavailable');
  });

  it('ignores empty/whitespace questions (no IPC call)', async () => {
    const ask = vi.fn(async () => GROUNDED);
    setAsk(ask);
    mountAsk(root);
    type(root, '   ');
    submit(root);
    await tick();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('Ask view · save-to-library (SPEC-0026 ASK-6)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  function setApi(ask: KbApi['ask'], saveRecallOutput: KbApi['saveRecallOutput']): void {
    (window as unknown as { kbApi: Pick<KbApi, 'ask' | 'saveRecallOutput'> }).kbApi = { ask, saveRecallOutput };
  }
  async function askOnce(): Promise<void> {
    type(root, 'Who was Ada Lovelace?');
    submit(root);
    await tick();
  }
  const saveBtn = (): HTMLButtonElement | null => root.querySelector('.ask-save');

  it('offers "Save to Library" on an answered turn and persists it on click (ASK-6)', async () => {
    const save = vi.fn(async () => ({ ok: true, rel: 'outputs/recall/OUT1.md', message: 'Saved to outputs/recall/OUT1.md' }));
    setApi(vi.fn(async () => GROUNDED), save);
    mountAsk(root);
    await askOnce();

    expect(saveBtn()).toBeTruthy();
    saveBtn()!.click();
    await tick();

    expect(save).toHaveBeenCalledWith(GROUNDED); // the rendered AskResult is what gets saved
    expect(root.querySelector('.ask-save-row')?.textContent).toContain('Saved to your library');
    expect(root.querySelector('.ask-save-row code')?.textContent).toBe('outputs/recall/OUT1.md');
    expect(saveBtn()).toBeNull(); // button replaced by the saved confirmation
  });

  it('surfaces a save failure inline and keeps the button (retryable)', async () => {
    const save = vi.fn(async () => ({ ok: false, message: 'No active library.' }));
    setApi(vi.fn(async () => GROUNDED), save);
    mountAsk(root);
    await askOnce();
    saveBtn()!.click();
    await tick();
    expect(root.querySelector('.ask-save-status')?.textContent).toContain('No active library.');
    expect(saveBtn()).toBeTruthy(); // still offered
  });

  it('allows saving an UNGROUNDED answer too (F4 — honesty preserved by the banner)', async () => {
    const ungrounded: AskResult = { ...GROUNDED, grounded: false, citations: [] };
    setApi(vi.fn(async () => ungrounded), vi.fn(async () => ({ ok: true, rel: 'outputs/recall/U.md', message: 'ok' })));
    mountAsk(root);
    await askOnce();
    expect(saveBtn()).toBeTruthy(); // save offered even when not grounded
  });
});

describe('Ask view · sanitized markdown rendering (#93)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });
  const answerWith = (answer: string): AskResult => ({ ...GROUNDED, answer });
  async function ask(answer: string): Promise<void> {
    setAsk(vi.fn(async () => answerWith(answer)));
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
  }

  it('renders markdown (no literal `**`/`#` left in the prose)', async () => {
    await ask('**Ada** was a _pioneer_.');
    const prose = root.querySelector('.ask-prose')!;
    expect(prose.querySelector('strong')?.textContent).toBe('Ada');
    expect(prose.querySelector('em')?.textContent).toBe('pioneer');
    expect(prose.innerHTML).not.toContain('**'); // raw markers gone
  });

  it('SANITIZES model output — strips an event-handler attribute (E1), keeps benign content', async () => {
    await ask('Hello <img src=x onerror="window.__pwned=1"> world');
    const prose = root.querySelector('.ask-prose')!;
    expect(prose.querySelector('img')?.getAttribute('onerror') ?? null).toBeNull(); // onerror stripped
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(prose.textContent).toContain('Hello'); // benign text + the safe <img src> survive
  });

  it('SANITIZES model output — strips <script> entirely (E1)', async () => {
    await ask('before <script>window.__pwned=1</script> after');
    const prose = root.querySelector('.ask-prose')!;
    expect(prose.querySelector('script')).toBeNull();
    expect(prose.innerHTML).not.toContain('<script');
    expect(prose.textContent).toContain('before');
    expect(prose.textContent).toContain('after');
  });

  it('keeps a safe markdown link but drops a javascript: URL', async () => {
    await ask('[ok](https://example.com) and [bad](javascript:alert(1))');
    const hrefs = Array.from(root.querySelectorAll('.ask-prose a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://example.com');
    expect(hrefs.some((h) => h?.startsWith('javascript:'))).toBe(false);
  });
});

describe('linkifyCitationMarkers (ASK-14, pure)', () => {
  const CITES: Citation[] = [
    { kind: 'entity', ref: 'entities/ada.md', label: 'Ada Lovelace' },
    { kind: 'claim', ref: 'claims/bug.md', label: 'coined bug' },
  ];
  it('wraps each [n] in an href-less role=link anchor with the 1-based index + a source-naming aria-label', () => {
    const out = linkifyCitationMarkers('Ada [1] and Grace [2].', 3, CITES);
    expect(out).toContain('class="ask-cite cite-link"'); // v3 superscript chip; .cite-link kept for the delegated handler
    expect(out).toContain('role="link"'); // a11y: it IS a deep-link, not a generic button
    expect(out).not.toContain('role="button"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('data-turn="3"');
    expect(out).toContain('data-cite="1"');
    expect(out).toContain('aria-label="Citation 1: Ada Lovelace"'); // names the source
    expect(out).toContain('aria-label="Citation 2: coined bug"');
    expect(out).not.toContain('href'); // the obsidian:// scheme never enters the DOM (built in main)
  });
  it('falls back to a bare "Citation n" label when a marker outruns citations[] (malformed output)', () => {
    expect(linkifyCitationMarkers('See [5].', 0, [])).toContain('aria-label="Citation 5"');
  });
  it('leaves non-citation text untouched', () => {
    expect(linkifyCitationMarkers('no markers here', 0)).toBe('no markers here');
  });
});

describe('Ask view · citation deep-links (SPEC-0026 ASK-14)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  const CITED: AskResult = {
    question: 'q',
    answer: 'Ada [1] pioneered computing; Grace [2] coined "bug".',
    citations: [
      { kind: 'entity', ref: 'entities/person/ada-lovelace.md', label: 'Ada Lovelace' },
      { kind: 'claim', ref: 'claims/person/grace/bug.md', label: 'coined bug' },
    ],
    grounded: true,
    toolCalls: 2,
    truncated: false,
  };

  function setApi(open: KbApi['openCitation']): void {
    (window as unknown as { kbApi: Pick<KbApi, 'ask' | 'openCitation'> }).kbApi = {
      ask: vi.fn(async () => CITED),
      openCitation: open,
    };
  }
  async function askOnce(): Promise<void> {
    type(root, 'q');
    submit(root);
    await tick();
  }

  it('renders each inline [n] as a clickable, href-less .cite-link (ASK-14)', async () => {
    setApi(vi.fn(async () => ({ ok: true })));
    mountAsk(root);
    await askOnce();
    const links = root.querySelectorAll('.ask-prose .cite-link');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBeNull(); // protocol stays out of the DOM
    expect((links[0] as HTMLElement).dataset.cite).toBe('1');
    expect(links[0].textContent).toBe('1'); // v3: a clean superscript, no brackets
  });

  it('renders a numbered References list from citations[] (ASK-13/14)', async () => {
    setApi(vi.fn(async () => ({ ok: true })));
    mountAsk(root);
    await askOnce();
    const refs = root.querySelectorAll('.ask-refs .ask-ref');
    expect(refs).toHaveLength(2);
    expect(root.querySelector('.ask-refs')?.textContent).toContain('References');
    expect(refs[0].querySelector('.num')?.textContent).toBe('1');
    // #2: label-first + capitalized kind; the raw path lives in the tooltip, not the visible text.
    expect(refs[0].textContent).toContain('Ada Lovelace'); // the human label
    expect(refs[0].textContent).toContain('Entity'); // capitalized kind
    expect(refs[0].textContent).not.toContain('entities/person/ada-lovelace.md');
    expect(refs[0].getAttribute('title')).toContain('entities/person/ada-lovelace.md');
    expect(refs[1].textContent).toContain('coined bug');
  });

  it('clicking an inline [n] opens its citation via the canonical ref (index-mapped, ASK-14)', async () => {
    const open = vi.fn(async () => ({ ok: true }));
    setApi(open);
    mountAsk(root);
    await askOnce();
    (root.querySelectorAll('.cite-link')[1] as HTMLElement).click(); // [2]
    await tick();
    expect(open).toHaveBeenCalledWith('claims/person/grace/bug.md'); // citations[1].ref
  });

  it('clicking a References entry opens the same canonical target', async () => {
    const open = vi.fn(async () => ({ ok: true }));
    setApi(open);
    mountAsk(root);
    await askOnce();
    (root.querySelectorAll('.ask-ref')[0] as HTMLElement).click(); // [1]
    await tick();
    expect(open).toHaveBeenCalledWith('entities/person/ada-lovelace.md'); // citations[0].ref
  });

  it('opens on keyboard (Enter) for a11y — anchors are role=link/tabindex=0', async () => {
    const open = vi.fn(async () => ({ ok: true }));
    setApi(open);
    mountAsk(root);
    await askOnce();
    root
      .querySelectorAll('.cite-link')[0]
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(open).toHaveBeenCalledWith('entities/person/ada-lovelace.md');
  });

  it('surfaces a failed open inline (never throws to the user)', async () => {
    setApi(vi.fn(async () => ({ ok: false, reason: 'open-failed' as const })));
    mountAsk(root);
    await askOnce();
    (root.querySelector('.cite-link') as HTMLElement).click();
    await tick();
    expect(root.querySelector('.ask-cite-status.error')?.textContent).toContain('Obsidian');
  });
});

// SPEC-0060 VUX-1: the Ask view migrates off the instrument-panel --viz-* names onto the warm-vellum v3
// token set, with the reading-measure + long-token wrap on the prose. Fails-before/passes-after on the
// CSS source (happy-dom applies no stylesheet, same guard pattern as confirmDismissCss.test.ts).
describe('VUX-1 v3 token migration (SPEC-0060 — off --viz-*)', () => {
  const indexCss = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
  // Isolate the Ask block: from the v3 Ask banner to the next view's section banner.
  const askBlock = indexCss.slice(
    indexCss.indexOf('Ask view — VELLUM v3'),
    indexCss.indexOf('Explore view (SPEC-0039'),
  );

  it('isolated the Ask CSS block', () => {
    expect(askBlock.length).toBeGreaterThan(500);
  });

  it('the v3 Ask block carries NO --viz-* tokens (retired, VUX-1)', () => {
    expect(askBlock).not.toMatch(/var\(--viz-/);
  });

  it('the prose wraps long unbroken tokens (reading safety)', () => {
    const m = askBlock.match(/\.ask-prose\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });

  it('uses v3 ground/ink/identity tokens (linen/ink/viridian)', () => {
    expect(askBlock).toMatch(/var\(--viridian\b/); // the recall identity colour
    expect(askBlock).toMatch(/var\(--ink\b/);
    expect(askBlock).toMatch(/var\(--linen\b|var\(--parchment\b/);
  });
});

describe('Ask view · Past chats + Save chat (VUX-11 slice-3)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  function setApi(extra: Partial<KbApi> = {}): void {
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { ask: vi.fn(async () => GROUNDED), ...extra };
  }
  async function ask(q: string): Promise<void> {
    type(root, q);
    submit(root);
    await tick();
  }
  const iso = '2026-06-28T12:00:00.000Z';

  it('Save chat is disabled until there is an answered turn, then enabled', async () => {
    setApi();
    mountAsk(root);
    const save = root.querySelector<HTMLButtonElement>('#askSaveChat')!;
    expect(save.disabled).toBe(true); // nothing to save yet
    await ask('q');
    expect(save.disabled).toBe(false);
  });

  it('Save chat persists the thread (full AskResult), shows saved state, and auto-updates the same id', async () => {
    const saveConversation = vi.fn<KbApi['saveConversation']>(async () => ({ id: 'C1' }));
    setApi({ saveConversation });
    mountAsk(root);
    await ask('q1');
    root.querySelector<HTMLButtonElement>('#askSaveChat')!.click();
    await tick();
    expect(saveConversation).toHaveBeenCalledTimes(1);
    const arg = saveConversation.mock.calls[0][0] as { turns: Array<{ result: AskResult; askedAt: string }>; id?: string };
    expect(arg.id).toBeUndefined(); // first save creates (no id)
    expect(arg.turns[0].result).toBe(GROUNDED); // the FULL AskResult is persisted, not a lossy transcript
    expect(typeof arg.turns[0].askedAt).toBe('string');
    const save = root.querySelector<HTMLButtonElement>('#askSaveChat')!;
    expect(save.classList.contains('is-saved')).toBe(true);
    expect(save.textContent).toContain('Saved');
    // a saved thread stays current — the next ask auto-updates the SAME id
    await ask('q2');
    await tick();
    expect(saveConversation).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'C1' }));
  });

  it('Past chats lists saved threads and reloads one faithfully (citations re-render; no faked mode)', async () => {
    const summaries: ConversationSummary[] = [{ id: 'C1', title: 'Ada chat', updatedAt: iso, turnCount: 1, preview: 'who was…' }];
    const conv: Conversation = { id: 'C1', title: 'Ada chat', createdAt: iso, updatedAt: iso, turns: [{ result: GROUNDED, askedAt: iso, latencyMs: 1200 }] };
    setApi({ listConversations: vi.fn(async () => summaries), loadConversation: vi.fn(async () => conv) });
    mountAsk(root);
    root.querySelector<HTMLButtonElement>('#askPast')!.click();
    await tick();
    const rows = root.querySelectorAll<HTMLElement>('.ask-pastrow');
    expect(rows).toHaveLength(1);
    expect(root.querySelector('.ask-pasttitle')?.textContent).toBe('Ada chat');
    root.querySelector<HTMLButtonElement>('.ask-pastopen')!.click();
    await tick();
    // the reloaded thread re-renders the answer + its reference card (full AskResult, faithful)
    expect(root.querySelector('.ask-prose')?.textContent).toContain('first computer programmer');
    expect(root.querySelector('.ask-ref')).toBeTruthy();
    expect(root.querySelector('#askTitle')?.textContent).toBe(GROUNDED.question);
    // mode wasn't persisted → the stat omits the Quick/Considered chip (honest, not faked)
    expect(root.querySelector('.ask-stat .smode')).toBeNull();
    expect(root.querySelector('#askPastPanel')?.hasAttribute('hidden')).toBe(true); // panel closed after load
  });

  it('Past chats shows a calm empty state when there are no saved chats', async () => {
    setApi({ listConversations: vi.fn(async () => []) });
    mountAsk(root);
    root.querySelector<HTMLButtonElement>('#askPast')!.click();
    await tick();
    expect(root.querySelector('.ask-past-status')?.textContent).toContain('No saved chats');
  });

  it('Past chats delete is a TWO-STEP inline confirm (PANEL-7): ✕ reveals "Delete?", ✓ deletes + re-lists', async () => {
    const summaries: ConversationSummary[] = [{ id: 'C1', title: 'Ada chat', updatedAt: iso, turnCount: 1, preview: 'p' }];
    const listConversations = vi
      .fn<KbApi['listConversations']>()
      .mockResolvedValueOnce(summaries) // first open → one row
      .mockResolvedValue([]); // after delete → empty
    const deleteConversation = vi.fn<KbApi['deleteConversation']>(async () => ({ ok: true }));
    setApi({ listConversations, deleteConversation });
    mountAsk(root);
    root.querySelector<HTMLButtonElement>('#askPast')!.click();
    await tick();
    expect(root.querySelectorAll('.ask-pastrow')).toHaveLength(1);
    // step 1: ✕ reveals the inline confirm — it does NOT delete yet (cancel-default, no immediate loss)
    root.querySelector<HTMLButtonElement>('.ask-pastdel')!.click();
    expect(root.querySelector('.ask-pastconfirm')).toBeTruthy();
    expect(deleteConversation).not.toHaveBeenCalled();
    // step 2: ✓ confirms → deletes + re-lists to empty
    root.querySelector<HTMLButtonElement>('.ask-pastdel-yes')!.click();
    await tick();
    expect(deleteConversation).toHaveBeenCalledWith('C1');
    expect(root.querySelector('.ask-past-status')?.textContent).toContain('No saved chats');
    expect(root.querySelector('.ask-prose')).toBeNull(); // distinct from open (didn't load)
  });

  it('Past chats delete confirm can be cancelled (✕ keep) — nothing is deleted', async () => {
    const summaries: ConversationSummary[] = [{ id: 'C1', title: 'Ada chat', updatedAt: iso, turnCount: 1, preview: 'p' }];
    const deleteConversation = vi.fn<KbApi['deleteConversation']>(async () => ({ ok: true }));
    setApi({ listConversations: vi.fn(async () => summaries), deleteConversation });
    mountAsk(root);
    root.querySelector<HTMLButtonElement>('#askPast')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>('.ask-pastdel')!.click(); // reveal confirm
    root.querySelector<HTMLButtonElement>('.ask-pastdel-no')!.click(); // cancel
    expect(deleteConversation).not.toHaveBeenCalled();
    expect(root.querySelector('.ask-pastconfirm')).toBeNull(); // back to the row, no confirm
    expect(root.querySelectorAll('.ask-pastrow')).toHaveLength(1); // row still there
  });

  it('New starts a fresh thread — the next Save creates a NEW conversation (no stale id)', async () => {
    const saveConversation = vi.fn(async () => ({ id: 'C1' }));
    setApi({ saveConversation });
    mountAsk(root);
    await ask('q1');
    root.querySelector<HTMLButtonElement>('#askSaveChat')!.click();
    await tick();
    root.querySelector<HTMLButtonElement>('#askNew')!.click();
    expect(root.querySelector<HTMLButtonElement>('#askSaveChat')!.classList.contains('is-saved')).toBe(false); // reset
    await ask('q2');
    root.querySelector<HTMLButtonElement>('#askSaveChat')!.click();
    await tick();
    expect(saveConversation).toHaveBeenLastCalledWith(expect.not.objectContaining({ id: 'C1' })); // new thread
  });
});

// #514 — live progress: the status line names the in-flight tool + call count within the same tick the
// model calls it, instead of a static "Searching…" line for the whole 40-65s run.
describe('Ask view — live progress during an in-flight ask (#514)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '<div id="r"></div>';
    root = document.getElementById('r')!;
  });

  /** A controllable ask(): resolves only when the test calls `resolve`, so progress events can be fired
   *  mid-flight and the DOM inspected before the turn settles. */
  function setControllableAsk(): { resolve: (r: AskResult) => void; onAskProgress: KbApi['onAskProgress']; unsubscribe: ReturnType<typeof vi.fn>; progressCb: () => (evt: AskProgressEvent) => void } {
    let resolve!: (r: AskResult) => void;
    const promise = new Promise<AskResult>((res) => {
      resolve = res;
    });
    const ask = vi.fn(async () => promise);
    let cb: ((evt: AskProgressEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    const onAskProgress = vi.fn((c: (evt: AskProgressEvent) => void) => {
      cb = c;
      return unsubscribe;
    });
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { ask, onAskProgress };
    return { resolve, onAskProgress, unsubscribe, progressCb: () => cb! };
  }

  it('subscribes for the ask, updates the status line in place per event, and unsubscribes once it settles', async () => {
    const { resolve, onAskProgress, unsubscribe, progressCb } = setControllableAsk();
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();

    expect(onAskProgress).toHaveBeenCalledTimes(1); // subscribed exactly once for this ask
    expect(root.querySelector('.ask-status .what')?.textContent).toBe('Searching your library…'); // initial, generic

    progressCb()({ phase: 'tool-call', tool: 'entityLookup', used: 1, max: 4 });
    expect(root.querySelector('.ask-status .what')?.textContent).toBe('Looking up entities — retrieval 1 of 4');

    progressCb()({ phase: 'tool-call', tool: 'claimsForEntity', used: 2, max: 4 });
    expect(root.querySelector('.ask-status .what')?.textContent).toBe('Looking up claims — retrieval 2 of 4');
    expect(unsubscribe).not.toHaveBeenCalled(); // still in flight

    resolve(GROUNDED);
    await tick();
    expect(unsubscribe).toHaveBeenCalledTimes(1); // unsubscribed the instant the ask settles
  });

  it('a budget-exhausted event shows an honest wrapping-up label, not a raw tool name', async () => {
    const { progressCb } = setControllableAsk();
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    progressCb()({ phase: 'budget-exhausted', tool: 'grep', used: 4, max: 4 });
    expect(root.querySelector('.ask-status .what')?.textContent).toBe('Wrapping up your answer…');
  });

  it('unsubscribes even when the ask REJECTS (error path never leaks the subscription)', async () => {
    let reject!: (err: Error) => void;
    const promise = new Promise<AskResult>((_res, rej) => {
      reject = rej;
    });
    const ask = vi.fn(async () => promise);
    const unsubscribe = vi.fn();
    const onAskProgress = vi.fn(() => unsubscribe);
    (window as unknown as { kbApi: Partial<KbApi> }).kbApi = { ask, onAskProgress };
    mountAsk(root);
    type(root, 'q');
    submit(root);
    await tick();
    reject(new Error('boom'));
    await tick();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('gracefully degrades when onAskProgress is unavailable — no throw, the static status line stays (ENG-15/16)', async () => {
    setAsk(vi.fn(async () => GROUNDED)); // no onAskProgress on window.kbApi at all
    mountAsk(root);
    type(root, 'q');
    expect(() => submit(root)).not.toThrow();
    await tick();
    expect(root.querySelector('.ask-ans')).not.toBeNull(); // the ask still completed normally
  });
});
