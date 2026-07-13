// Ask view (SPEC-0026 ASK-1/2/8 · SPEC-0060 VUX-11) — the grounded-recall CONVERSATION surface. The
// Principal types a question, the main process runs grounded recall (kb:ask → recall engine on the
// Copilot SDK), and the answer renders inline as a continued conversation. Pull-only (ASK-2): a recall
// runs ONLY on submit, never automatically. Multi-turn (ASK-8): prior Q/A are passed as history; state
// is view-local + ephemeral (F5), surviving shell view-switches but not relaunch.
//
// v3 (VUX-11): a full-pane chat — header (title · meta · actions) + scrolling conversation column
// (you-bubble + grounded answer w/ seal, prose, foot-stat, references) + a floating ask bar carrying a
// Quick/Considered effort toggle. v3 token system (no `--viz-*`). The "recall settings live on Ask"
// IA-lock (VUX-19) = the effort toggle here. The toggle is WIRED — onAsk sends `effort` (AskRequest,
// #487) so Quick/Considered modulates recall depth. Past-chats + Save-chat are WIRED too (slice-3, over
// DEV-1's #490 conversation store): Save chat persists/updates the thread, Past chats lists + reloads
// a saved thread (reloaded turns keep the full AskResult so citations re-render faithfully).
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { esc } from '../html';
import type { AskResult, Citation, RecallTurn, Conversation, ConversationSummary, ConversationTurn, AskProgressEvent } from '../../kb/types';

/**
 * Render the recall answer's markdown to **sanitized** HTML (#93). The answer is LLM/ingested content,
 * so this ALWAYS sanitizes: `marked` → HTML, then DOMPurify strips anything unsafe (scripts, handlers,
 * `javascript:` URLs) before it reaches the DOM. Never render model output un-sanitized (E1).
 */
function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
}

/**
 * Make inline `[n]` citation markers clickable (ASK-14). Runs BEFORE markdown parsing: each `[n]`
 * becomes a class-tagged superscript carrying the 1-based index in `data-cite` — the delegated handler
 * maps it to `citations[n-1]` (DEV-3's dense/gap-free contract). No `href`: the `obsidian://` deep-link
 * is built + opened in main, so the scheme never enters the DOM (ASK-15/#93). Pure + exported for test.
 */
export function linkifyCitationMarkers(answer: string, turnIndex: number, citations: Citation[] = []): string {
  return answer.replace(/\[(\d+)\]/g, (_m, n: string) => {
    const c = citations[Number(n) - 1];
    const label = c ? `Citation ${n}: ${refDisplayName(c)}` : `Citation ${n}`;
    return `<a class="ask-cite cite-link" role="link" tabindex="0" aria-label="${esc(label)}" data-turn="${turnIndex}" data-cite="${n}">${n}</a>`;
  });
}

type Effort = 'quick' | 'considered';

interface Turn {
  question: string;
  result: AskResult | null; // null while in flight
  askedAt: number; // epoch ms — for the "Nm ago" you-meta
  elapsedMs?: number; // client-measured round-trip, for the answer stat
  effort?: Effort; // the mode this turn was asked under; UNDEFINED for a reloaded saved turn (the
  // conversation store doesn't persist the mode) → the stat omits the mode chip then (honest).
  error?: string;
  savedRel?: string; // set once saved as an Output (ASK-6)
  saveError?: string;
  citeError?: string;
}

// View-local, ephemeral session state (F5). The shell mounts once + toggles visibility.
let turns: Turn[] = [];
let busy = false;
let effort: Effort = 'considered'; // VUX-11 default — the Considered (deeper) pass
// VUX-11 slice-3 (Past chats / Save chat): the persisted-thread id once this conversation is saved
// (null = unsaved). A saved thread auto-updates as it grows. `pastOpen` tracks the Past-chats panel.
let convId: string | null = null;
let pastOpen = false;
// The last-fetched Past-chats list (so a delete-intent re-renders the panel WITHOUT a re-fetch) + the
// row currently showing its inline delete-confirm (PANEL-7 idiom; null = none).
let pastList: ConversationSummary[] = [];
let pendingDeleteId: string | null = null;

export function mountAsk(container: HTMLElement): void {
  turns = [];
  busy = false;
  effort = 'considered';
  convId = null;
  pastOpen = false;
  pastList = [];
  pendingDeleteId = null;
  container.innerHTML = `
    <section class="ask-view" id="ask">
      <header class="ask-head">
        <div class="ask-head-id">
          <h1 id="askTitle">New conversation</h1>
          <div class="ask-sub" id="askSub"><span>Grounded recall over your library</span></div>
        </div>
        <div class="ask-actions">
          <button type="button" class="ask-act is-quiet" id="askPast" aria-haspopup="true" aria-expanded="false"><span class="ask-act-i" aria-hidden="true">◷</span> Past chats</button>
          <button type="button" class="ask-act is-quiet" id="askSaveChat"><span class="ask-act-i" aria-hidden="true">◫</span> Save chat</button>
          <button type="button" class="ask-act" id="askNew"><span class="ask-act-i" aria-hidden="true">✎</span> New</button>
          <div class="ask-pastpanel" id="askPastPanel" role="menu" aria-label="Past chats" hidden></div>
        </div>
      </header>
      <div class="ask-scroll">
        <div class="ask-col" id="askTranscript"></div>
      </div>
      <div class="ask-dock">
        <form class="ask-bar" id="askForm">
          <textarea id="askInput" class="ask-input" rows="1" autocomplete="off" placeholder="Ask your library a question…" aria-label="Ask a question"></textarea>
          <div class="ask-bar-row">
            <div class="ask-modes" role="radiogroup" aria-label="Recall effort" id="askModes">
              <button type="button" class="ask-mode" role="radio" data-effort="quick" aria-checked="false" tabindex="-1">Quick <small>fast pass</small></button>
              <button type="button" class="ask-mode is-on" role="radio" data-effort="considered" aria-checked="true" tabindex="0">Considered <small>deeper</small></button>
            </div>
            <button id="askBtn" class="ask-send" type="submit"><span class="ask-send-i" aria-hidden="true">↑</span> Ask</button>
          </div>
          <div class="ask-hint">Enter to send · Shift+Enter for a new line</div>
        </form>
      </div>
    </section>`;

  const form = container.querySelector<HTMLFormElement>('#askForm');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    void onAsk(container);
  });
  // Enter submits, Shift+Enter newlines (chat convention); textarea auto-grows.
  const input = container.querySelector<HTMLTextAreaElement>('#askInput');
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void onAsk(container);
    }
  });
  input?.addEventListener('input', () => autoGrow(input));

  // Effort toggle (VUX-11) — the selected mode is sent on each ask (onAsk → AskRequest.effort).
  container.querySelector<HTMLElement>('#askModes')?.addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>('.ask-mode');
    if (!opt || busy) return;
    setEffort(container, (opt.dataset.effort as Effort) ?? 'considered');
  });

  container.querySelector<HTMLElement>('#askNew')?.addEventListener('click', () => {
    if (busy) return;
    turns = [];
    convId = null; // a fresh thread — the next Save chat starts a new conversation
    closePastPanel(container);
    renderTranscript(container);
    updateHead(container);
    updateActions(container);
    container.querySelector<HTMLTextAreaElement>('#askInput')?.focus();
  });

  // Save chat (VUX-11 slice-2c) — persist the thread; once saved, it auto-updates as it grows.
  container.querySelector<HTMLElement>('#askSaveChat')?.addEventListener('click', () => void saveChat(container));
  // Past chats (VUX-11 slice-2b) — toggle the panel; load the list on open.
  container.querySelector<HTMLElement>('#askPast')?.addEventListener('click', () => void togglePastPanel(container));
  // Delegated (the panel re-renders, so bind on the container). Order: confirm-yes / confirm-no / reveal-
  // confirm / open — so a click never falls through to the wrong action. The ✕ REVEALS an inline confirm
  // (PANEL-7 idiom, cancel-default); only the ✓ actually deletes.
  const panelEl = container.querySelector<HTMLElement>('#askPastPanel');
  panelEl?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const yes = t.closest<HTMLElement>('.ask-pastdel-yes');
    if (yes?.dataset.del) {
      void deleteConv(container, yes.dataset.del);
      return;
    }
    if (t.closest('.ask-pastdel-no')) {
      pendingDeleteId = null;
      renderPastPanel(container);
      return;
    }
    const del = t.closest<HTMLElement>('.ask-pastdel');
    if (del?.dataset.del) {
      pendingDeleteId = del.dataset.del; // reveal the inline confirm on this row (don't delete yet)
      renderPastPanel(container);
      return;
    }
    const open = t.closest<HTMLElement>('.ask-pastopen');
    if (open?.dataset.id) void loadConv(container, open.dataset.id);
  });

  // ASK-6/14: delegated handlers on the persistent transcript — save-to-KB + citation deep-links.
  const transcript = container.querySelector<HTMLElement>('#askTranscript');
  transcript?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLElement>('.ask-save');
    if (btn) {
      void saveTurn(container, Number(btn.dataset.turn));
      return;
    }
    const cite = target.closest<HTMLElement>('.cite-link, .ask-ref');
    if (cite) {
      e.preventDefault();
      void openCitation(container, Number(cite.dataset.turn), Number(cite.dataset.cite));
    }
  });
  transcript?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cite = (e.target as HTMLElement).closest<HTMLElement>('.cite-link, .ask-ref');
    if (!cite) return;
    e.preventDefault();
    void openCitation(container, Number(cite.dataset.turn), Number(cite.dataset.cite));
  });

  renderTranscript(container);
  updateHead(container);
  updateActions(container);
}

function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

function setEffort(container: HTMLElement, next: Effort): void {
  effort = next;
  container.querySelectorAll<HTMLElement>('#askModes .ask-mode').forEach((m) => {
    const on = m.dataset.effort === next;
    m.classList.toggle('is-on', on);
    m.setAttribute('aria-checked', on ? 'true' : 'false');
    m.tabIndex = on ? 0 : -1;
  });
}

const CITE_ERRORS: Record<string, string> = {
  'no-vault': 'No active library.',
  'invalid-ref': 'That citation could not be opened.',
  'open-failed': 'Could not open Obsidian — is it installed?',
};

/** Open a citation's canonical target in Obsidian (ASK-14). Failures surface inline (never throw). */
async function openCitation(container: HTMLElement, turnIndex: number, citeIndex: number): Promise<void> {
  const t = turns[turnIndex];
  const c = t?.result?.citations[citeIndex - 1];
  if (!t || !c) return;
  t.citeError = undefined;
  try {
    const res = await window.kbApi.openCitation(c.ref);
    if (!res.ok) t.citeError = CITE_ERRORS[res.reason ?? ''] ?? 'That citation could not be opened.';
  } catch (err) {
    t.citeError = err instanceof Error ? err.message : String(err);
  }
  if (t.citeError) renderTranscript(container);
}

/** Save a completed turn's answer as a KB Output (ASK-6) — once; updates the turn + re-renders. */
async function saveTurn(container: HTMLElement, index: number): Promise<void> {
  const t = turns[index];
  if (!t || !t.result || t.savedRel) return;
  t.saveError = undefined;
  const btn = container.querySelector<HTMLButtonElement>(`.ask-save[data-turn="${index}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
  }
  try {
    const res = await window.kbApi.saveRecallOutput(t.result);
    if (res.ok && res.rel) t.savedRel = res.rel;
    else t.saveError = res.message;
  } catch (err) {
    t.saveError = err instanceof Error ? err.message : String(err);
  }
  renderTranscript(container);
}

async function onAsk(container: HTMLElement): Promise<void> {
  if (busy) return;
  const input = container.querySelector<HTMLTextAreaElement>('#askInput');
  const question = (input?.value ?? '').trim();
  if (!question) return;

  // History = prior completed turns (ASK-8), gathered before this turn is added.
  const history: RecallTurn[] = turns
    .filter((t) => t.result !== null)
    .map((t) => ({ question: t.question, answer: t.result!.answer }));

  const askedWith = effort; // capture the mode at submit time (the toggle can change mid-flight)
  const turn: Turn = { question, result: null, askedAt: Date.now(), effort: askedWith };
  turns.push(turn);
  if (input) {
    input.value = '';
    autoGrow(input);
  }
  busy = true;
  setBusy(container, true);
  renderTranscript(container);
  updateHead(container);
  scrollToEnd(container);

  const started = Date.now();
  // #514: subscribe to live tool-call progress for the DURATION of this ask only — so the status line
  // names the in-flight tool + call count instead of a static "Searching…" for the whole 40-65s run.
  // Updates the in-flight turn's status span directly (no full re-render — see updateThinkingStatus).
  // ENG-15/16: optional — a harness/older preload without it just keeps the static status line.
  const unsubscribeProgress = window.kbApi.onAskProgress?.((evt) => updateThinkingStatus(container, evt)) ?? ((): void => {});
  try {
    // VUX-11: send the Quick/Considered effort (AskRequest.effort, #487) so the toggle modulates recall
    // depth — Quick = shallow/fast floor, Considered = full configured depth. Omitted ⇒ considered.
    turn.result = await window.kbApi.ask({ question, history, effort: askedWith });
  } catch (err) {
    turn.error = err instanceof Error ? err.message : String(err);
  } finally {
    unsubscribeProgress();
    turn.elapsedMs = Date.now() - started;
    busy = false;
    setBusy(container, false);
    renderTranscript(container);
    updateHead(container);
    updateActions(container);
    scrollToEnd(container);
    container.querySelector<HTMLTextAreaElement>('#askInput')?.focus();
    // A saved thread stays current: re-persist in the background once this turn lands (best-effort).
    if (convId && turn.result) void persistConversation();
  }
}

function setBusy(container: HTMLElement, on: boolean): void {
  const btn = container.querySelector<HTMLButtonElement>('#askBtn');
  const input = container.querySelector<HTMLTextAreaElement>('#askInput');
  if (btn) btn.disabled = on;
  if (input) input.disabled = on;
}

function scrollToEnd(container: HTMLElement): void {
  const sc = container.querySelector<HTMLElement>('.ask-scroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

/** Header title + meta reflect the conversation (VUX-11): first question as the title, turn/source counts. */
function updateHead(container: HTMLElement): void {
  const title = container.querySelector<HTMLElement>('#askTitle');
  const sub = container.querySelector<HTMLElement>('#askSub');
  if (title) title.textContent = turns.length ? turns[0].question : 'New conversation';
  if (sub) {
    if (!turns.length) {
      sub.innerHTML = `<span>Grounded recall over your library</span>`;
    } else {
      const answered = turns.filter((t) => t.result);
      const sources = new Set(answered.flatMap((t) => t.result!.citations.map((c) => c.ref))).size;
      const parts = [`${turns.length} turn${turns.length === 1 ? '' : 's'}`];
      if (sources) parts.push(`grounded in ${sources} source${sources === 1 ? '' : 's'}`);
      sub.innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('<span class="dot"></span>');
    }
  }
}

// ── Past chats / Save chat (VUX-11 slice-3) ──────────────────────────────────────────────────────

/** Completed turns → the persistable shape (only answered turns; the FULL AskResult so a reload
 *  re-renders citations/grounded/toolCalls faithfully, not a lossy Q+A transcript). */
function toConversationTurns(): ConversationTurn[] {
  return turns
    .filter((t) => t.result !== null)
    .map((t) => ({ result: t.result!, askedAt: new Date(t.askedAt).toISOString(), latencyMs: t.elapsedMs }));
}

/** At least one answered turn exists to save. */
function hasSavable(): boolean {
  return turns.some((t) => t.result !== null);
}

/** Reflect the Save-chat button state (disabled when nothing to save / busy; "Saved" once persisted). */
function updateActions(container: HTMLElement): void {
  const save = container.querySelector<HTMLButtonElement>('#askSaveChat');
  if (!save) return;
  save.disabled = busy || !hasSavable();
  const saved = convId !== null;
  save.classList.toggle('is-saved', saved);
  save.innerHTML = saved
    ? `<span class="ask-act-i" aria-hidden="true">✓</span> Saved`
    : `<span class="ask-act-i" aria-hidden="true">◫</span> Save chat`;
}

/** Persist the current thread — create (no id) or update (id). Best-effort; sets convId on success. */
async function persistConversation(): Promise<boolean> {
  const convTurns = toConversationTurns();
  if (convTurns.length === 0) return false;
  try {
    const res = await window.kbApi.saveConversation(convId ? { id: convId, turns: convTurns } : { turns: convTurns });
    convId = res.id;
    return true;
  } catch {
    return false;
  }
}

/** Save chat (manual, slice-2c): persist + reflect saved state; a transient failure flashes on the button. */
async function saveChat(container: HTMLElement): Promise<void> {
  if (busy || !hasSavable()) return;
  const ok = await persistConversation();
  updateActions(container);
  if (!ok) {
    const save = container.querySelector<HTMLButtonElement>('#askSaveChat');
    if (save) {
      save.innerHTML = `<span class="ask-act-i" aria-hidden="true">⚠</span> Couldn’t save`;
      save.classList.add('is-error');
      setTimeout(() => {
        save.classList.remove('is-error');
        updateActions(container);
      }, 2500);
    }
  }
}

async function togglePastPanel(container: HTMLElement): Promise<void> {
  if (pastOpen) {
    closePastPanel(container);
    return;
  }
  await openPastPanel(container);
}

function closePastPanel(container: HTMLElement): void {
  pastOpen = false;
  pendingDeleteId = null; // drop any half-shown confirm so it doesn't reappear on reopen
  const panel = container.querySelector<HTMLElement>('#askPastPanel');
  if (panel) panel.hidden = true;
  container.querySelector<HTMLElement>('#askPast')?.setAttribute('aria-expanded', 'false');
}

/** Open the Past-chats panel + load the saved-thread list (slice-2b). */
async function openPastPanel(container: HTMLElement): Promise<void> {
  const panel = container.querySelector<HTMLElement>('#askPastPanel');
  if (!panel) return;
  pastOpen = true;
  container.querySelector<HTMLElement>('#askPast')?.setAttribute('aria-expanded', 'true');
  panel.hidden = false;
  panel.innerHTML = `<div class="ask-past-status">Loading…</div>`;
  let list: ConversationSummary[];
  try {
    list = await window.kbApi.listConversations();
  } catch {
    panel.innerHTML = `<div class="ask-past-status error">Couldn’t load past chats.</div>`;
    return;
  }
  if (!pastOpen) return; // closed while loading
  pastList = list;
  pendingDeleteId = null;
  renderPastPanel(container);
}

/** Render the Past-chats panel from the cached list — so a delete-intent (inline confirm) re-renders
 *  without a re-fetch. */
function renderPastPanel(container: HTMLElement): void {
  const panel = container.querySelector<HTMLElement>('#askPastPanel');
  if (!panel) return;
  panel.innerHTML = pastList.length === 0 ? `<div class="ask-past-status">No saved chats yet.</div>` : pastList.map(pastRow).join('');
}

function pastRow(c: ConversationSummary): string {
  const meta = `${c.turnCount} turn${c.turnCount === 1 ? '' : 's'} · ${relTime(Date.parse(c.updatedAt) || Date.now())}`;
  const title = c.title || 'Untitled chat';
  // PANEL-7 inline confirm: the ✕ doesn't delete — it reveals an in-row "Delete? ✓ / ✕" (cancel-default,
  // slate/oxide, no ember). Only ✓ deletes. Reuses the reveal-confirm idiom from Agents·Schedules.
  const tail =
    pendingDeleteId === c.id
      ? `<span class="ask-pastconfirm" role="group" aria-label="Confirm delete">
          <span class="ask-pastconfirm-q">Delete?</span>
          <button type="button" class="ask-pastdel-yes" data-del="${esc(c.id)}" aria-label="Confirm delete “${esc(title)}”" title="Delete">✓</button>
          <button type="button" class="ask-pastdel-no" aria-label="Keep “${esc(title)}”" title="Keep">✕</button>
        </span>`
      : `<button type="button" class="ask-pastdel" data-del="${esc(c.id)}" aria-label="Delete “${esc(title)}”" title="Delete chat">✕</button>`;
  // A row = an open-button (loads the thread) + the delete affordance. Two buttons, not nested (a11y).
  return `<div class="ask-pastrow${pendingDeleteId === c.id ? ' is-confirming' : ''}">
    <button type="button" class="ask-pastopen" role="menuitem" data-id="${esc(c.id)}">
      <span class="ask-pasttitle">${esc(title)}</span>
      <span class="ask-pastmeta">${esc(meta)}</span>
      ${c.preview ? `<span class="ask-pastprev">${esc(c.preview)}</span>` : ''}
    </button>
    ${tail}
  </div>`;
}

/** Load a saved chat into the view (replaces the current thread). Reloaded turns carry the full
 *  AskResult (citations/grounding re-render faithfully); mode wasn't persisted, so the stat omits it. */
async function loadConv(container: HTMLElement, id: string): Promise<void> {
  let conv: Conversation | null;
  try {
    conv = await window.kbApi.loadConversation(id);
  } catch {
    conv = null;
  }
  closePastPanel(container);
  if (!conv) return;
  convId = conv.id;
  turns = conv.turns.map((ct) => ({
    question: ct.result.question,
    result: ct.result,
    askedAt: Date.parse(ct.askedAt) || Date.now(),
    elapsedMs: ct.latencyMs,
  }));
  renderTranscript(container);
  updateHead(container);
  updateActions(container);
  scrollToEnd(container);
}

/** Delete a saved chat (slice-2d, over #492). The IPC is idempotent + ULID-contained; we refresh the
 *  open panel afterward. If the deleted thread is the one currently loaded, drop the saved id — the view
 *  keeps the turns, but a future Save starts a fresh conversation. */
async function deleteConv(container: HTMLElement, id: string): Promise<void> {
  try {
    await window.kbApi.deleteConversation(id);
  } catch {
    /* best-effort: a failed delete leaves the row; the next open re-lists the truth */
  }
  if (convId === id) {
    convId = null;
    updateActions(container);
  }
  if (pastOpen) await openPastPanel(container); // re-render the list without the removed row
}

const CITATION_KIND_LABEL: Record<string, string> = { entity: 'Entity', claim: 'Claim', source: 'Source' };
const CITATION_KIND_CLASS: Record<string, string> = { entity: 'k-entity', claim: 'k-claim', source: 'k-source' };

/** Display name for a reference (dogfood #2): human label/title, else note basename — never the raw path. */
function refDisplayName(c: Citation): string {
  if (c.label && c.label.trim().length > 0) return c.label.trim();
  const base = c.ref.replace(/\/+$/, '').split('/').pop() ?? c.ref;
  return base.replace(/\.md$/i, '');
}

/** References (ASK-13/14) as v3 cards — numbered to match the inline markers, each a deep-link to Obsidian. */
function renderReferences(citations: Citation[], turnIndex: number): string {
  if (citations.length === 0) return '';
  const items = citations
    .map((c, i) => {
      const n = i + 1;
      const kind = CITATION_KIND_LABEL[c.kind] ?? c.kind;
      const kclass = CITATION_KIND_CLASS[c.kind] ?? '';
      return `<button type="button" class="ask-ref" role="link" tabindex="0" aria-label="Citation ${n}: ${esc(refDisplayName(c))}" data-turn="${turnIndex}" data-cite="${n}" title="${esc(c.ref)} — open in Obsidian"><span class="num">${n}</span><span class="rbody"><span class="rtitle">${esc(refDisplayName(c))}</span><span class="rkind ${kclass}">${esc(kind)}</span></span><span class="rgo" aria-hidden="true">→</span></button>`;
    })
    .join('');
  return `<div class="ask-refs"><div class="ask-refs-h"><span>References</span><span class="line"></span></div>${items}</div>`;
}

/** The answer side of a turn: seal + scholarly prose + foot stat + references. */
function renderAnswer(t: Turn, turnIndex: number): string {
  const r = t.result!;
  const answerHtml = renderMarkdown(linkifyCitationMarkers(r.answer, turnIndex, r.citations));
  const citeErr = t.citeError ? `<div class="ask-cite-status error">${esc(t.citeError)}</div>` : '';

  // Honest stat (no confidence — AskResult has none; not faked). Mode (the user's selection, omitted
  // for a reloaded turn whose mode wasn't persisted) · retrievals (toolCalls) · client-measured latency.
  const stat: string[] = [];
  if (t.effort) stat.push(`<span class="smode">${t.effort === 'quick' ? 'Quick' : 'Considered'}</span>`);
  if (typeof r.toolCalls === 'number') stat.push(`<span>${r.toolCalls} retrieval${r.toolCalls === 1 ? '' : 's'}</span>`);
  if (t.elapsedMs) stat.push(`<span>${(t.elapsedMs / 1000).toFixed(1)}s</span>`);
  const statHtml = `<div class="ask-stat">${stat.join('<span class="sdot"></span>')}</div>`;

  const flags: string[] = [];
  if (!r.grounded) flags.push('Not grounded in the library');
  if (r.truncated) flags.push('Partial — retrieval budget reached');
  const groundHtml = `<div class="ask-ground ${r.grounded ? 'is-grounded' : 'is-ungrounded'}">${r.grounded ? '✓ grounded' : '⚠ ' + esc(flags[0] ?? 'not grounded')}</div>`;
  const extraFlag = r.truncated && r.grounded ? `<div class="ask-ground is-warn">⚠ ${esc('Partial — retrieval budget reached')}</div>` : '';

  return `<div class="ask-ans">
    <span class="seal" aria-hidden="true">✦</span>
    <div class="ask-prose">${answerHtml}</div>
    <div class="ask-foot">${groundHtml}${extraFlag}${statHtml}</div>
    ${renderReferences(r.citations, turnIndex)}
    ${citeErr}
    ${renderSaveRow(t, turnIndex)}
  </div>`;
}

/** Save-to-KB affordance for a completed turn (ASK-6): a button, or the saved confirmation. */
function renderSaveRow(t: Turn, index: number): string {
  if (t.savedRel) {
    return `<div class="ask-save-row is-saved">✓ Saved to your library — <code>${esc(t.savedRel)}</code></div>`;
  }
  const err = t.saveError ? `<span class="ask-save-status error"> ${esc(t.saveError)}</span>` : '';
  return `<div class="ask-save-row"><button type="button" class="ask-save" data-turn="${index}"><span aria-hidden="true">⤓</span> Save to Library</button>${err}</div>`;
}

/** The calm in-flight state (VUX: never a blank async gap) — a status line + a shimmer skeleton. The
 *  status line starts generic and is updated in place by {@link updateThinkingStatus} as progress events
 *  arrive (#514) — never re-rendered from here mid-flight (that would flicker + lose the skeleton). */
function renderThinking(): string {
  return `<div class="ask-ans is-thinking">
    <span class="seal" aria-hidden="true">✦</span>
    <div class="ask-status"><span class="what">Searching your library…</span></div>
    <div class="ask-skel" aria-hidden="true"><span class="ln w1"></span><span class="ln w2"></span><span class="ln w3"></span></div>
  </div>`;
}

/** Human phrase for a retrieval tool name — the status line names WHAT it's looking up, not the raw
 *  tool identifier (a Principal doesn't know what "entityLookup" means). */
const PROGRESS_TOOL_LABEL: Record<string, string> = {
  entityLookup: 'entities',
  claimsForEntity: 'claims',
  linkTraversal: 'connections',
  readNode: 'a note',
  readSource: 'a source',
  grep: 'your library',
};

function progressLabel(evt: AskProgressEvent): string {
  if (evt.phase === 'budget-exhausted') return 'Wrapping up your answer…';
  const what = (evt.tool && PROGRESS_TOOL_LABEL[evt.tool]) || 'your library';
  return `Looking up ${what} — retrieval ${evt.used} of ${evt.max}`;
}

/** #514: repaint ONLY the in-flight turn's status span in place (no full renderTranscript — that would
 *  flicker and can't outrun a fast tool-call cadence). Only one ask can be in flight at a time (the
 *  `busy` guard), so the LAST turn's status span is unambiguously the right target; a no-op if the DOM
 *  moved on (turn already resolved, view swapped away) — progress arriving late is simply dropped. */
function updateThinkingStatus(container: HTMLElement, evt: AskProgressEvent): void {
  const el = container.querySelector<HTMLElement>('.ask-turn:last-child .ask-status .what');
  if (el) el.textContent = progressLabel(evt);
}

function relTime(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function renderTurn(t: Turn, index: number): string {
  let ans: string;
  if (t.error) {
    ans = `<div class="ask-ans"><span class="seal is-error" aria-hidden="true">!</span><div class="ask-prose ask-error error">Couldn’t answer — ${esc(t.error)}. Try again from the box below.</div></div>`;
  } else if (t.result === null) {
    ans = renderThinking();
  } else {
    ans = renderAnswer(t, index);
  }
  return `<div class="ask-turn">
    <div class="ask-you"><div class="ask-you-col"><div class="bubble">${esc(t.question)}</div><div class="ask-meta-you">${esc(relTime(t.askedAt))}</div></div></div>
    ${ans}
  </div>`;
}

function renderTranscript(container: HTMLElement): void {
  const el = container.querySelector<HTMLElement>('#askTranscript');
  if (!el) return;
  // Empty state (VUX: calm, never blank) — an invitation, not a void.
  if (turns.length === 0) {
    el.innerHTML = `<div class="ask-empty"><span class="ask-empty-seal" aria-hidden="true">✦</span><p class="ask-empty-h">Ask your library a question</p><p class="ask-empty-sub">Answers are grounded in your sources, entities, and claims — every one cites where it came from, and you can open it.</p></div>`;
    return;
  }
  el.innerHTML = turns.map((t, i) => renderTurn(t, i)).join('');
}
