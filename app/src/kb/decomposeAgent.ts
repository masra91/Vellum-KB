// The thin Decompose agent (SPEC-0015 DECOMP-3, reusing the SPEC-0014 harness pattern).
// Each source gets a fresh, disposable single-shot `copilot -p` session (ORCH-5) with NO
// tools: it returns a JSON decision and the orchestrator does every effect (DECOMP-3).
// Mirrors copilotAgent.ts (the archivist) so the harness is reused, not reinvented (ORCH-9).
//
// Unlike the archivist, Decompose has NO deterministic fallback that fabricates output: a
// bad/absent session must NOT invent entities (that would pollute the graph). On any failure
// the decider throws, and the stage treats it as a failed attempt (retry, then set aside;
// DECOMP-6 / ORCH-12).
import { detectCopilot } from './copilot';
import { UNTRUSTED_SOURCE_SKILL, UNTRUSTED_SOURCE_DELIMITER_NOTE } from './untrustedSource';
import { parseDecomposeDecision, type DecomposeDecision } from './decompose';
import { makeDefaultCopilotRunner, runDeciderScaffold, makeAvailabilityGate, type CopilotRunner } from './deciderScaffold';
import type { SpanCtx } from './tracing';

const COPILOT_TIMEOUT_MS = 120_000; // decomposition reads more than a classification

/** The source as the agent sees it: identity + the raw text to decompose. */
export interface SourceInput {
  sourceId: string;
  kind: 'text' | 'file';
  originalName?: string;
  mimeType?: string;
  /** The source's text content (text sources; or extracted text). Null for opaque files. */
  text: string | null;
}

/** A decider maps a source to a validated decompose decision. May throw (DECOMP-6). */
export type DecomposeDecider = (input: SourceInput, ctx?: SpanCtx) => Promise<DecomposeDecision>;

export type { CopilotRunner };

/**
 * The versioned per-stage instruction template (SPEC-0014 Q9 / SPEC-0015 §3.1), composed
 * per source. The base entity `kind` set and signal `type` set are NUDGES in prose — the
 * agent MAY coin new ones (DECOMP-7,10). They are never enforced in code.
 */
export const DECOMPOSE_PROMPT_VERSION = 'decompose/v2';

export function buildDecomposePrompt(input: SourceInput): string {
  const body = input.text ?? '(no extractable text — this is an opaque file; infer only from its name/type)';
  return [
    'You are the Vellum Decompose librarian. Read ONE source and DECOMPOSE it into the',
    'distinct ENTITIES it mentions — the nodes of the knowledge graph. Extract only entities',
    'grounded in the text; do NOT invent anything not supported by it.',
    '',
    // INTAKE-13 / RESEARCH-12: open-feed source content is untrusted — fence it as DATA, not instructions.
    UNTRUSTED_SOURCE_SKILL,
    '',
    'A NODE has INDEPENDENT IDENTITY — a nameable real-world referent you could collect facts',
    'about across many sources: a person, organization, place, project, event, work/artifact,',
    'or a durable named concept/term that exists independently of this source. Extract a node',
    'ONLY for such things.',
    '',
    'Do NOT make a node out of what is really an ATTRIBUTE, ROLE, or CLAIM about another',
    'entity — those are recorded later by the Claims stage, never as their own nodes:',
    '  - roles / titles / descriptors predicated of an entity ("first computer programmer",',
    '    "the CEO", "a British mathematician")',
    '  - properties / values (dates, quantities, statuses, a location used as an attribute)',
    '  - relationships or predicates ("worked with", "founded")',
    '  - generic common nouns used descriptively, not as a specific named referent ("an',
    '    algorithm", "a meeting") — unless the source treats it as a specific named thing',
    'Tie-breaker: ask "could a DIFFERENT source add independent facts about this as its own',
    'thing, and would it deserve its own page?" If it is only meaningful as a description of',
    'another entity here, it is an attribute/claim, NOT a node.',
    '',
    'PREFER FEWER, higher-confidence nodes. When unsure whether something is a node or an',
    'attribute, treat it as an attribute and do NOT extract it — Claims will capture it.',
    '',
    'For each entity give: kind, name, a confidence in [0,1] that it is a real distinct',
    'entity, and mentions[] (verbatim spans from the source that evidence it).',
    '',
    'kind is an OPEN, emergent vocabulary. PREFER these common kinds when they fit:',
    '  person, organization, concept, event, place, project',
    'but COIN a new kind when none fits — do not force-fit.',
    '',
    'Optionally add signals[]: typed notes FOR THE RECORD that are not entities (they go to',
    'the audit log, never the graph). type is also an OPEN vocabulary — prefer these:',
    '  note, ambiguity, possible-duplicate, taxonomy, suggestion, low-quality-source',
    'Each signal has: type, note (free text), and optional refs[] (entity names it concerns).',
    'Signals are optional and usually unnecessary — only add one when it genuinely helps.',
    '',
    'One special signal: type "research-request" asks a background researcher to learn more about a',
    'term the source leans on but does NOT itself explain (an unfamiliar acronym, tool, person, or',
    'concept worth corroborating). For it, ALSO set:',
    '  what: the exact term/topic to research (short),',
    '  note: WHY it is worth researching (what is unclear or worth confirming),',
    '  context: the verbatim surrounding sentence/phrase from the source it appears in.',
    'Only emit one when the source genuinely depends on a term it leaves unexplained — never for',
    'common knowledge, and never more than a couple per source.',
    '',
    `Do NOT resolve identity across sources or deduplicate — just decompose THIS source.`,
    '',
    `sourceId: ${input.sourceId}`,
    `kind: ${input.kind}`,
    input.originalName ? `originalName: ${input.originalName}` : '',
    input.mimeType ? `mimeType: ${input.mimeType}` : '',
    UNTRUSTED_SOURCE_DELIMITER_NOTE,
    body,
    '--- SOURCE END ---',
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"sourceId":"<the id above>","entities":[{"kind":"...","name":"...","confidence":0.0,"mentions":["..."]}],"signals":[{"type":"...","note":"...","refs":["..."]},{"type":"research-request","what":"...","note":"why it matters","context":"verbatim surrounding text"}]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface DecomposeDeciderOptions {
  /** Force availability (skips detection). Tests set this; production detects lazily. */
  available?: boolean;
  /** Injected runner (tests). Defaults to shelling out to `copilot -p`. */
  run?: CopilotRunner;
  /** Working directory for the Copilot subprocess (the staging worktree, threaded from the
   *  pipeline). Set as the execFile `cwd` so Copilot's workspace scan stays scoped here, not the
   *  filesystem root — `--add-dir` only widens permissions, it does NOT move the cwd. */
  vaultPath?: string;
}

/**
 * Build the production Decompose decider: a fresh Copilot session per source. THROWS when
 * Copilot is unavailable or the output is bad — the stage retries and, after K attempts,
 * sets the source aside (DECOMP-6). Stamps an ORCH-16 AgentTrace onto the returned decision.
 */
export function makeDecomposeDecider(opts: DecomposeDeciderOptions = {}): DecomposeDecider {
  const run = opts.run ?? makeDefaultCopilotRunner({ stage: 'decompose', timeoutMs: COPILOT_TIMEOUT_MS });
  const cwd = opts.vaultPath; // staging worktree → Copilot subprocess cwd (COPILOT-CONTEXT-SCOPE-BUG)
  const isAvailable = makeAvailabilityGate(opts.available, detectCopilot);
  return async (input, ctx) => {
    if (!(await isAvailable())) throw new Error('decompose: copilot unavailable');
    // HEAL-1/ORCH-16: self-repair + per-agent model-fallback + timed AgentTrace (#528 shared scaffold).
    // A launch/timeout/systemic error from `run` is NOT a parse error and propagates so the stage's
    // set-aside + #256 breaker still see it (HEAL-6 boundary) — `runDeciderScaffold` only catches
    // nothing; it re-throws whatever `runWithSelfRepair` exhausts on.
    const { value: decision, agent } = await runDeciderScaffold({
      agentKey: 'decompose',
      buildPrompt: () => buildDecomposePrompt(input),
      parse: (stdout) => parseDecomposeDecision(stdout, input.sourceId),
      run,
      cwd,
      ctx,
    });
    return { ...decision, agent };
  };
}
