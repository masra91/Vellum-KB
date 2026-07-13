// Ask & Recall — the "out" pillar core (SPEC-0026). A grounded, cited answer to an NL
// question, produced by a THICK, structure-aware agent that navigates the KB with a
// read-only tool surface — NOT a fixed retrieve-then-synthesize over plain text (ASK-4/5).
//
// Runtime substrate (ASK-12 / ORCH-21,22): the agent runs on the **GitHub Copilot SDK**
// (`@github/copilot-sdk`) — a real multi-turn Session that invokes our tools as native
// typed-tools and streams its answer. The SDK owns the turn loop; WE own the parts that make
// recall trustworthy:
//   - the read-only tool surface (so ASK-3 holds by construction — no write tool exists);
//   - grounding (ASK-7): the agent must finish by calling the `submitAnswer` tool with
//     citations, which we VERIFY resolve on disk before calling the answer grounded;
//   - the budget (F3): tool-call counting in the handler wrappers degrades retrieval past the
//     cap and steers the agent to answer.
// The SDK client is injected (a thin structural seam) so tests drive a fake session that
// scripts tool calls — no real CLI is spawned. Pull-only (ASK-2), ephemeral session (F5).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentTrace } from './archivist';
import { makeReadOnlyTools } from './recallTools';
import { RECALL_SKILL, makeSdkRecallClient } from './recallAgent';
import { acquireInteractiveCopilotSlot, CopilotCapacityTimeoutError } from './copilotConcurrency';
import { isModelUnavailableError, COPILOT_MODEL_AUTO } from './copilotModel';
import { DEFAULT_RECALL_BUDGET_MS } from './instanceConfig';
// SPEC-0026 ASK-19 — the retrieval-budget bounds + scaling live in the PURE `recallConstants` module
// (no node import) so the renderer's "Recall & Ask" Settings card can consume the bounds. Re-exported
// below so existing import sites (recall.test.ts) stay unchanged.
import { RECALL_BUDGET, recallBudget } from './recallConstants';

// ── Question / session ──────────────────────────────────────────────────────────────────────

/** One prior exchange in a conversational session (ASK-8). Passed in by the caller (F5). */
export interface RecallTurn {
  question: string;
  answer: string;
}

export interface RecallQuestion {
  question: string;
  history?: RecallTurn[];
}

// ── Evidence + answer ─────────────────────────────────────────────────────────────────────

/** A piece of evidence an assertion rests on (ASK-7). `ref` is repo-relative. */
export interface Citation {
  kind: 'entity' | 'claim' | 'source';
  ref: string; // entity node / claim file (file) or source dir
  label?: string; // human label: entity name, claim statement excerpt, …
}

/** #514: one retrieval tool-call's progress, emitted synchronously as the SDK invokes each tool — so the
 *  renderer can name the in-flight tool + call count within the same tick the model calls it (well under
 *  the 500ms AC), instead of staring at a static "Searching…" line for the whole 40-65s run. */
export interface AskProgressEvent {
  phase: 'tool-call' | 'budget-exhausted';
  tool?: string;
  used: number;
  max: number;
}

export interface AskResult {
  question: string;
  /** Markdown answer; substantive assertions carry inline citation markers (ASK-1/7). */
  answer: string;
  /** Evidence the answer cites — verified to resolve on disk (ASK-7). */
  citations: Citation[];
  /** True iff the answer rests on ≥1 verified KB citation. A bare/inferred answer is `false`. */
  grounded: boolean;
  /** How many read-only retrieval tool calls the run made (transparency / budget). */
  toolCalls: number;
  /** The run hit the budget cap (F3) before the agent answered. */
  truncated: boolean;
  /** ORCH-16 provenance of the agent run. */
  trace?: AgentTrace;
}

// ── Read-only tool surface (ASK-4) ──────────────────────────────────────────────────────────
//
// Every tool READS the KB; none mutates it. Tag/property filters (SPEC-0025 META) and the
// Obsidian CLI accelerator (ASK-9) are intentionally absent until those land — capability-gated,
// added to the registry later without changing the loop.

export interface EntityHit {
  rel: string; // repo-relative path to the entity node
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  confidence: number;
  tags: string[]; // Obsidian Properties/tags (SPEC-0025 META) — surfaced so the agent is metadata-aware
  derivedFrom: string[]; // contributing source dirs (provenance)
}

export interface ClaimHit {
  rel: string; // repo-relative path to the claim file
  id: string;
  subject: string; // repo-relative path to the subject entity node
  status: string; // fact | interpretation | hypothesis | …
  confidence: number;
  statement: string;
  derivedFrom: string[]; // source dir(s) the claim was derived from
  mentions: string[]; // verbatim evidence spans
  relatesTo: string[]; // soft hints to other entities (unresolved names)
}

/** One `[[wikilink]]` edge between nodes (or a claim→entity reference). */
export interface LinkHit {
  from: string; // repo-relative path of the file holding the link
  to: string; // link target (repo-relative path or bare name as written)
}

export interface GrepHit {
  rel: string; // repo-relative path of the matching file
  line: number; // 1-based line number
  text: string; // the matching line (trimmed)
}

/** One entity hit from `search` — the entity itself, enriched with its top claims + backlinks so a
 *  broad first pass doesn't need follow-up `claimsForEntity`/`linkTraversal` calls (SPEC-0061 T1
 *  follow-up, #538). */
export interface SearchEntityHit {
  entity: EntityHit;
  snippet: string;
  claims: ClaimHit[];
  incoming: LinkHit[];
}

/** A standalone claim or source hit from `search` — the match wasn't (or wasn't only) attributable to
 *  an entity already returned in `entities`. */
export interface SearchHit {
  kind: 'claim' | 'source';
  rel: string;
  label: string; // claim statement, or the source rel-path
  snippet: string;
}

/** Composite ranked search result: entities (with claims + backlinks folded in), plus standalone claim
 *  and source hits, all ordered by relevance within their group (#538). */
export interface SearchResult {
  entities: SearchEntityHit[];
  claims: SearchHit[];
  sources: SearchHit[];
}

export interface RecallTools {
  /** Find entity nodes by name/alias (case-insensitive substring), optionally filtered by kind. */
  entityLookup(args: { query: string; kind?: string; limit?: number }): Promise<EntityHit[]>;
  /** Claims whose subject is the given entity (by node rel-path or by name). */
  claimsForEntity(args: { entity: string; limit?: number }): Promise<ClaimHit[]>;
  /** Outgoing `[[links]]` from an entity's node + incoming backlinks to it across the graph. */
  linkTraversal(args: { entity: string }): Promise<{ outgoing: LinkHit[]; incoming: LinkHit[] }>;
  /** Raw text of an entity node or claim file (for quoting). Null if absent / out of bounds. */
  readNode(args: { rel: string }): Promise<string | null>;
  /** The `source.md` text of a source dir (immutable ground truth, for quotes). */
  readSource(args: { dir: string }): Promise<string | null>;
  /** Lexical fallback: case-insensitive line search over sources/entities/claims. */
  grep(args: { pattern: string; limit?: number }): Promise<GrepHit[]>;
  /**
   * Composite ranked full-text search: entities (with claims + backlinks attached) + standalone
   * claim/source hits, in ONE call (SPEC-0061 T1 follow-up, #538) — turns a 10-24-call granular
   * exploration into 2-4. OPTIONAL: only an index-backed tool surface can implement this (it needs
   * FTS5 ranking, not a per-call walker scan) — mirrors the tag/property-filter deferral precedent at
   * the top of `recallTools.ts` (a capability gated in, not a breaking interface change). Callers
   * (`buildRecallToolDefs`) check for its presence before registering the tool with the agent.
   */
  search?(args: { query: string; limit?: number }): Promise<SearchResult>;
}

/** The ALWAYS-present read-only retrieval tool names (kept in sync with `RecallTools`'s required
 *  methods). `search` is NOT here — it's conditionally added to a session's tool defs only when the
 *  injected `tools.search` exists (see `buildRecallToolDefs`), since not every `RecallTools`
 *  implementation has it. */
export const TOOL_NAMES = ['entityLookup', 'claimsForEntity', 'linkTraversal', 'readNode', 'readSource', 'grep'] as const;
export type ToolName = (typeof TOOL_NAMES)[number] | 'search';

/** The tool the agent MUST call to finish: its answer + the evidence it rests on (ASK-7). */
export const SUBMIT_ANSWER_TOOL = 'submitAnswer';

// ── SDK seam (minimal structural view of @github/copilot-sdk, so tests need no real CLI) ─────

/** A tool definition handed to the SDK (mapped to `defineTool` by the production client). */
export interface RecallToolDef {
  name: string;
  description: string;
  parameters?: Record<string, unknown>; // raw JSON schema (avoids a direct zod dep)
  /**
   * Set when this custom tool's name collides with a Copilot CLI built-in (e.g. `grep`, added in CLI
   * 1.0.62): the SDK/CLI rejects the session otherwise ("conflicts with a built-in tool of the same
   * name"). Signals "our KB-scoped tool IS the agent's <name>" — mirrors the web researcher's `fetch`.
   * See [[builtinTools]] for the version-coupled built-in registry + the build-time guard.
   */
  overridesBuiltInTool?: boolean;
  handler: (args: unknown, invocation?: unknown) => Promise<unknown> | unknown;
}

export interface RecallSessionConfig {
  model?: string;
  systemMessage?: { mode?: 'append' | 'replace'; content: string };
  tools?: RecallToolDef[];
  allowedTools?: string[];
  /** #514: SDK-side reasoning-effort lever (gated per-model — the SDK ignores it for a model that
   *  doesn't support it). Set by recall() when the caller passes `opts.reasoningEffort`. */
  reasoningEffort?: string;
}

export interface RecallSession {
  /**
   * Send the question and resolve when the agent is idle (it answers via the submitAnswer tool).
   * `timeoutMs` is the work budget (ASK-17): how long to wait for `session.idle` before giving up —
   * the SDK throws if it's reached. Defaults to the SDK's 60s when omitted; recall passes the
   * configured budget so a real grounded multi-hop has room to finish.
   */
  sendAndWait(prompt: string, timeoutMs?: number): Promise<unknown>;
  disconnect?(): Promise<void> | void;
}

export interface RecallClient {
  createSession(config: RecallSessionConfig): Promise<RecallSession>;
  disconnect?(): Promise<void> | void;
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────

export interface RecallOptions {
  /** The Copilot-SDK-backed client. Defaults to the real SDK; tests inject a fake. */
  client?: RecallClient;
  /** Defaults to a read-only tool surface over `root`. */
  tools?: RecallTools;
  /** Model hint passed to the SDK session. */
  model?: string;
  /** Absolute path to the BYOA `copilot` CLI for the default SDK client (BUG #65); resolved by the
   *  main tier (STACK-9). Ignored when a `client` is injected. */
  cliPath?: string;
  /** F3 budget: max read-only retrieval tool calls per question. */
  maxToolCalls?: number;
  /** Injectable clock for deterministic audit timestamps in tests. */
  now?: () => string;
  /** Set false to skip the ASK-11 audit write (tests). Defaults true. */
  audit?: boolean;
  /**
   * Acquire a copilot capacity slot before opening the SDK session (ASK-16). Defaults to the
   * interactive/priority lane ({@link acquireInteractiveCopilotSlot}) so recall NO LONGER bypasses the
   * global ceiling and a foreground query reserves capacity ahead of background ingestion + fails fast
   * if it can't. Returns the single-use release (called on session teardown). Tests inject a fake pool.
   */
  acquireSlot?: () => Promise<() => void>;
  /**
   * Recall's interactive work budget in ms (ASK-17): how long the SDK `session.idle` wait is given
   * before recall stops and returns its best grounded partial. The shipped 60s SDK default was too
   * tight for a real multi-hop over a large KB; the main process passes the Principal-configured value
   * ({@link DEFAULT_RECALL_BUDGET_MS}). On exhaustion recall returns a grounded PARTIAL + honest
   * "incomplete" (ORCH-7), never a bare timeout.
   */
  sessionBudgetMs?: number;
  /** #514: SDK-side reasoning-effort lever, forwarded to the session verbatim (gated per-model on the
   *  SDK side — a model that doesn't support it just ignores it). Set alongside a quick-tier model. */
  reasoningEffort?: string;
  /** #514: the tier label this run was asked at (e.g. 'quick' | 'considered') — recorded honestly on the
   *  trace so it reflects the tier that ACTUALLY ran, not just what was requested. Purely descriptive;
   *  recall() does not branch on this value (ipc.ts already resolved the model/levers from it). */
  effort?: string;
  /** #514: fired synchronously on every retrieval tool call (+ once on budget exhaustion) so a live caller
   *  can render "looking up X — retrieval N of M" instead of a static status line. Never awaited/blocking. */
  onProgress?: (evt: AskProgressEvent) => void;
}

export const DEFAULT_MAX_TOOL_CALLS = 12;

// Re-exported from the pure `recallConstants` module (imported at the top) so existing import sites
// (recall.test.ts) keep importing the retrieval-budget bounds + scaling from `./recall` unchanged.
export { RECALL_BUDGET, recallBudget };

/** Count canonical entity nodes — the `.md` files anywhere under `entities/` — as the budget's
 *  graph-size input. Cheap recursive readdir; missing/empty `entities/` → 0. Ignores dotdirs
 *  (working state never lives under entities/). */
export async function countEntityNodes(root: string): Promise<number> {
  let count = 0;
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(path.join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.md')) count++;
    }
  }
  await walk(path.join(path.resolve(root), 'entities'));
  return count;
}

const nowIso = (): string => new Date().toISOString();
const erasedClock = (): string => nowIso();

/** Mutable capture of the agent's final answer (set by the submitAnswer tool). */
interface Captured {
  answered: boolean;
  answer: string;
  citations: Citation[];
  declaredGrounded: boolean;
}

/**
 * Run one grounded recall (SPEC-0026 ASK-1) on the Copilot SDK. Registers the read-only tools +
 * a `submitAnswer` tool, opens a Session with the recall skill as its system message, and sends
 * the question; the SDK drives the multi-turn tool loop. We then VERIFY the submitted citations
 * resolve on disk before calling the answer grounded (ASK-7), enforce the tool-call budget in the
 * handler wrappers (F3), and emit a transparency audit event (ASK-11). Read-only w.r.t. the
 * ontology (ASK-3): only read tools are registered. Never throws at the caller — agent/runtime
 * failure yields an honest, ungrounded result.
 */
export async function recall(root: string, q: RecallQuestion | string, opts: RecallOptions = {}): Promise<AskResult> {
  root = path.resolve(root);
  const question = typeof q === 'string' ? q : q.question;
  const history = (typeof q === 'string' ? undefined : q.history) ?? [];
  const tools = opts.tools ?? makeReadOnlyTools(root);
  const client = opts.client ?? makeSdkRecallClient({ model: opts.model, cliPath: opts.cliPath });
  // F3 budget scaled to graph size (dogfood #5): a small KB gets a small cap so the agent can't
  // loop/over-explore. Explicit `opts.maxToolCalls` (callers/tests) still wins.
  const maxToolCalls = opts.maxToolCalls ?? recallBudget(await countEntityNodes(root));
  const clock = opts.now ?? erasedClock;
  const acquireSlot = opts.acquireSlot ?? acquireInteractiveCopilotSlot;
  // ASK-17: the recall work budget — well above the SDK's tight 60s default so a real grounded
  // multi-hop has room to converge; the main process passes the Principal-configured value.
  const sessionBudgetMs = opts.sessionBudgetMs ?? DEFAULT_RECALL_BUDGET_MS;

  const budget = { used: 0, truncated: false };
  const captured: Captured = { answered: false, answer: '', citations: [], declaredGrounded: true };
  const toolDefs = buildRecallToolDefs(tools, captured, budget, maxToolCalls, opts.onProgress);

  let trace: AgentTrace;
  let result: AskResult | null = null;
  let sessionIncomplete = false; // ASK-17(c): the session ran out of budget mid-flight after a partial
  let modelUsed = opts.model; // #514: the trace records what ACTUALLY ran, not just what was requested —
  // updated below if the auto-fallback retry fires (a stale pin never silently mislabels the trace).
  try {
    // ASK-16: recall is INTERACTIVE-PRIORITY — acquire a slot from the global pool (it no longer
    // bypasses the safety ceiling) through the priority lane, so the human query reserves capacity
    // ahead of background ingestion and a wedged/saturated pool fails fast (below) instead of the
    // agent thrashing outside the bound to a 60s `session.idle` hang. Held across the SDK session.
    // One SDK session attempt with a given model id. Acquires/releases its own interactive slot so a
    // model-fallback retry (below) gets a fresh slot rather than holding one across both attempts.
    const runSession = async (model: string | undefined): Promise<void> => {
      modelUsed = model;
      const releaseSlot = await acquireSlot();
      try {
        const session = await client.createSession({
          model,
          systemMessage: { mode: 'append', content: RECALL_SKILL },
          tools: toolDefs,
          allowedTools: [...TOOL_NAMES, ...(tools.search ? (['search'] as const) : []), SUBMIT_ANSWER_TOOL],
          reasoningEffort: opts.reasoningEffort,
        });
        try {
          // ASK-17: wait up to the configured budget for `session.idle` (vs the SDK's tight 60s default).
          await session.sendAndWait(buildUserPrompt(question, history), sessionBudgetMs);
        } finally {
          await session.disconnect?.();
        }
      } finally {
        releaseSlot(); // free the slot the instant the session ends — even on error
      }
    };
    // Model-pin resilience (ORCH-16 fast-follow): attempt with the resolved pin; if copilot rejects it
    // pre-flight as unavailable, retry ONCE with `--model auto` so a stale pin can't hard-break recall.
    // The rejection happens at session-creation (before any tool call), so the retry starts clean.
    try {
      await runSession(opts.model);
    } catch (err) {
      if (!isModelUnavailableError(err)) throw err;
      await runSession(COPILOT_MODEL_AUTO);
    }
    trace = { via: 'copilot', runtime: 'copilot', ok: captured.answered, at: clock(), model: modelUsed, effort: opts.effort };
  } catch (err) {
    const busy = err instanceof CopilotCapacityTimeoutError;
    if (!busy && captured.answered) {
      // ASK-17(c): the session hit its budget (or errored) AFTER the agent had already submitted an
      // answer — keep that best grounded PARTIAL + flag it incomplete; fall through to finalize. Never
      // discard real grounded work for a bare timeout throw (ORCH-7).
      sessionIncomplete = true;
      trace = { via: 'copilot', runtime: 'copilot', ok: true, at: clock(), model: modelUsed, effort: opts.effort };
    } else {
      // ASK-16 honest fast-fail (capacity) OR a hard failure with nothing captured (SDK/CLI unavailable,
      // a budget exhausted before any answer) → honest, ungrounded result; never fabricate (ORCH-7).
      result = {
        question,
        answer: busy
          ? 'Your library is busy ingesting right now, so I couldn’t reach a grounded answer in time — please try again in a moment.'
          : `I couldn't reach a grounded answer in time (${err instanceof Error ? err.message : String(err)}). Your library may be large — try a more specific question or raise the recall budget in Settings.`,
        citations: [],
        grounded: false,
        toolCalls: budget.used,
        truncated: true,
        trace: { via: 'copilot', ok: false, error: err instanceof Error ? err.message : String(err), at: clock(), effort: opts.effort },
      };
    }
  }

  if (!result) {
    // ASK-7 + ASK-13: verify citations resolve, dedup by ref, and renumber the answer's inline
    // [n] markers so they are dense + 1:1 with the final citations[] ([n] → citations[n-1]).
    const finalized = captured.answered
      ? await finalizeCitations(tools, captured.answer, captured.citations)
      : { answer: 'I could not reach a grounded answer within the retrieval budget.', citations: [] as Citation[] };
    // ASK-17(c): a budget-exhausted run that DID capture a partial answer is returned grounded-as-far-as-
    // it-got with an honest "incomplete" note appended — never silently presented as complete.
    const answer = sessionIncomplete
      ? `${finalized.answer}\n\n_(Recall ran out of time before fully exploring your library — this answer may be incomplete. Ask a more specific question or raise the recall budget in Settings.)_`
      : finalized.answer;
    result = {
      question,
      answer,
      citations: finalized.citations,
      grounded: finalized.citations.length > 0 && captured.declaredGrounded,
      toolCalls: budget.used,
      truncated: budget.truncated || !captured.answered || sessionIncomplete,
      trace: trace!,
    };
  }

  if (opts.audit !== false) await writeRecallAudit(root, result, toolDefs, clock());
  return result;
}

// #514: bound the conversation history that goes into every prompt — before this, the FULL history was
// resent verbatim on every turn (`recall.ts:362-365`), so prompt bytes grew unbounded with conversation
// length. Cap to the last K turns (older turns dropped, honestly noted) and cap EACH turn's text — so the
// history section has a real constant byte ceiling (K × 2 × per-turn cap), independent of how long the
// conversation has run.
const MAX_HISTORY_TURNS = 10;
const MAX_HISTORY_TURN_CHARS = 2000;

function truncateForHistory(s: string): string {
  return s.length > MAX_HISTORY_TURN_CHARS ? `${s.slice(0, MAX_HISTORY_TURN_CHARS)}…[truncated]` : s;
}

/** The user-turn prompt: the question plus any prior conversation (ASK-8), bounded (#514). The skill is
 *  the system message. */
function buildUserPrompt(question: string, history: RecallTurn[]): string {
  const capped = history.slice(-MAX_HISTORY_TURNS);
  const omitted = history.length - capped.length;
  const note = omitted > 0 ? `_(${omitted} earlier turn(s) omitted for length)_\n\n` : '';
  const convo =
    capped.length > 0
      ? note + capped.map((h) => `Q: ${truncateForHistory(h.question)}\nA: ${truncateForHistory(h.answer)}`).join('\n') + '\n\n'
      : '';
  return `${convo}Question: ${question}\n\nRetrieve from the KB, then finish by calling ${SUBMIT_ANSWER_TOOL} with your grounded answer and citations.`;
}

// #514: no single tool result reaches the session over this bound — `readSource`/`readNode` could return
// a whole (possibly multi-MB) file verbatim into context. Windowed (head/tail) rather than a hard cut, so
// the model still sees the START (usually the most relevant framing) and END (often a conclusion/summary)
// of a long document, with an honest note in between naming what was dropped.
const MAX_TOOL_RESULT_BYTES = 32 * 1024;
const TOOL_RESULT_WINDOW_CHARS = 12 * 1024; // head + tail, leaving headroom under the 32KB bound for the note

function windowToolResult(json: string): string {
  if (Buffer.byteLength(json, 'utf8') <= MAX_TOOL_RESULT_BYTES) return json;
  const head = json.slice(0, TOOL_RESULT_WINDOW_CHARS);
  const tail = json.slice(-TOOL_RESULT_WINDOW_CHARS);
  const droppedChars = json.length - head.length - tail.length;
  return `${head}\n…[truncated ~${droppedChars} chars — this result exceeded the ${MAX_TOOL_RESULT_BYTES / 1024}KB per-call bound]…\n${tail}`;
}

/**
 * Build the SDK tool definitions: each read-only retrieval tool wrapped with budget accounting
 * (F3), plus the `submitAnswer` tool that captures the agent's final answer + citations (ASK-7).
 * Exported for unit testing the wrappers directly.
 */
export function buildRecallToolDefs(
  tools: RecallTools,
  captured: Captured,
  budget: { used: number; truncated: boolean },
  maxToolCalls: number,
  onProgress?: (evt: AskProgressEvent) => void,
): RecallToolDef[] {
  const retrieval = (
    name: ToolName,
    description: string,
    parameters: Record<string, unknown>,
    opts: { overridesBuiltInTool?: boolean } = {},
  ): RecallToolDef => ({
    name,
    description,
    parameters,
    ...(opts.overridesBuiltInTool ? { overridesBuiltInTool: true } : {}),
    handler: async (rawArgs) => {
      if (budget.used >= maxToolCalls) {
        budget.truncated = true;
        onProgress?.({ phase: 'budget-exhausted', tool: name, used: budget.used, max: maxToolCalls });
        return `Retrieval budget exhausted (${maxToolCalls} calls). Do not call more retrieval tools — call ${SUBMIT_ANSWER_TOOL} now with your best grounded answer.`;
      }
      budget.used++;
      // #514: fire BEFORE the (possibly slow) file IO below, synchronously with the SDK's tool-call —
      // so a live status line updates within the same tick the model calls the tool, not after it resolves.
      onProgress?.({ phase: 'tool-call', tool: name, used: budget.used, max: maxToolCalls });
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await (tools[name] as (a: any) => Promise<unknown>)(args);
      return windowToolResult(JSON.stringify(out ?? null));
    },
  });

  const defs: RecallToolDef[] = [
    retrieval('entityLookup', 'Find entity nodes by name/alias; optional kind filter.', {
      type: 'object',
      properties: { query: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number' } },
      required: ['query'],
    }),
    retrieval('claimsForEntity', 'Claims about an entity (by node rel-path or name).', {
      type: 'object',
      properties: { entity: { type: 'string' }, limit: { type: 'number' } },
      required: ['entity'],
    }),
    retrieval('linkTraversal', 'Outgoing [[links]] + incoming backlinks for an entity.', {
      type: 'object',
      properties: { entity: { type: 'string' } },
      required: ['entity'],
    }),
    retrieval('readNode', 'Raw text of an entity or claim file (for exact quotes).', {
      type: 'object',
      properties: { rel: { type: 'string' } },
      required: ['rel'],
    }),
    retrieval('readSource', 'The source.md text of a source dir (ground-truth quotes).', {
      type: 'object',
      properties: { dir: { type: 'string' } },
      required: ['dir'],
    }),
    // `grep` collides with the CLI built-in (added in CLI 1.0.62) → must override or the session is
    // rejected and Ask/Recall goes down. Our grep IS the agent's grep (KB-scoped retrieval). [[builtinTools]]
    retrieval(
      'grep',
      'Case-insensitive line search across sources/entities/claims.',
      {
        type: 'object',
        properties: { pattern: { type: 'string' }, limit: { type: 'number' } },
        required: ['pattern'],
      },
      { overridesBuiltInTool: true },
    ),
    // #538: only registered when the injected `tools` implements it (the index-backed surface) — the
    // live vault-walker surface has no FTS5 to rank against, so this is capability-gated, not always-on.
    ...(tools.search
      ? [
          retrieval('search', 'Composite ranked search: entities (with their top claims + backlinks attached) + standalone claim/source hits, in ONE call. Prefer this for a broad first pass before the single-entity tools.', {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'number' } },
            required: ['query'],
          }),
        ]
      : []),
    {
      name: SUBMIT_ANSWER_TOOL,
      description: 'Finish: submit the grounded markdown answer and the evidence it cites.',
      parameters: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          grounded: { type: 'boolean' },
          citations: {
            type: 'array',
            items: {
              type: 'object',
              properties: { kind: { type: 'string', enum: ['entity', 'claim', 'source'] }, ref: { type: 'string' }, label: { type: 'string' } },
              required: ['kind', 'ref'],
            },
          },
        },
        required: ['answer'],
      },
      handler: (rawArgs) => {
        const a = (rawArgs ?? {}) as { answer?: unknown; grounded?: unknown; citations?: unknown };
        captured.answered = true;
        captured.answer = typeof a.answer === 'string' ? a.answer : '';
        captured.declaredGrounded = a.grounded !== false;
        captured.citations = Array.isArray(a.citations)
          ? a.citations.map(asCitation).filter((c): c is Citation => c !== null)
          : [];
        return 'Answer recorded.';
      },
    },
  ];
  return defs;
}

function asCitation(x: unknown): Citation | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if ((o.kind !== 'entity' && o.kind !== 'claim' && o.kind !== 'source') || typeof o.ref !== 'string') return null;
  return { kind: o.kind, ref: o.ref, label: typeof o.label === 'string' ? o.label : undefined };
}

/** Does a citation's target resolve on disk? — the grounding guarantee (ASK-7). */
async function citationResolves(tools: RecallTools, c: Citation): Promise<boolean> {
  if (!c || typeof c.ref !== 'string') return false;
  return c.kind === 'source' ? (await tools.readSource({ dir: c.ref })) !== null : (await tools.readNode({ rel: c.ref })) !== null;
}

/**
 * Verify + dedup + renumber (ASK-7 + ASK-13). Keep only citations that resolve on disk, dedup by
 * `ref` (a target cited twice ⇒ one number, reused), and rewrite the answer's inline `[n]` markers
 * so they are **dense + 1:1** with the returned `citations[]` (`[n]` → `citations[n-1]`). A marker
 * whose citation didn't resolve is dropped, and the survivors are renumbered with no gaps — so a
 * dual-render (ASK-14) can map by index without holes or dangling markers.
 */
export async function finalizeCitations(
  tools: RecallTools,
  answer: string,
  raw: Citation[],
): Promise<{ answer: string; citations: Citation[] }> {
  const refToNum = new Map<string, number>(); // dedup key → assigned dense number (1-based)
  const citations: Citation[] = [];
  const origToNum: Array<number | null> = []; // per RAW citation index → its final number (null = dropped)
  for (const c of raw) {
    if (!(await citationResolves(tools, c))) {
      origToNum.push(null);
      continue;
    }
    const key = `${c.kind}:${c.ref}`;
    let num = refToNum.get(key);
    if (num === undefined) {
      num = citations.length + 1;
      refToNum.set(key, num);
      citations.push({ kind: c.kind, ref: c.ref, label: c.label });
    }
    origToNum.push(num);
  }
  // Rewrite each `[k]` (1-based into the agent's raw citations) → its dense number, or drop it.
  const renumbered = answer.replace(/\[(\d+)\]/g, (_m, d: string) => {
    const k = Number(d);
    const num = k >= 1 && k <= origToNum.length ? origToNum[k - 1] : null;
    return num === null ? '' : `[${num}]`;
  });
  return { answer: renumbered, citations };
}

/** ASK-11: append a transparency event recording the question, retrieval, and answer summary.
 *  Lives under the gitignored, never-promoted working zone `.kb/cache/ask/` (CANON-8/9): recall
 *  runs against the vault ROOT (the `main` checkout Obsidian browses), so writing it anywhere
 *  tracked would leave that checkout perpetually git-dirty with non-evergreen machinery state. */
async function writeRecallAudit(root: string, result: AskResult, toolDefs: RecallToolDef[], ts: string): Promise<void> {
  const dir = path.join(root, '.kb', 'cache', 'ask');
  const line =
    JSON.stringify({
      ts,
      event: 'recall',
      runtime: 'copilot-sdk',
      question: result.question,
      toolCalls: result.toolCalls,
      tools: toolDefs.filter((t) => t.name !== SUBMIT_ANSWER_TOOL).map((t) => t.name),
      citations: result.citations.map((c) => `${c.kind}:${c.ref}`),
      grounded: result.grounded,
      truncated: result.truncated,
      agent: result.trace,
    }) + '\n';
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'audit.jsonl'), line);
  } catch {
    /* audit is best-effort transparency; never fail a recall on it */
  }
}

// Re-export so callers get the loop + the default tool surface from one module.
export { makeReadOnlyTools };
