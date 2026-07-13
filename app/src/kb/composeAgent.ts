// The thin Compose agent (SPEC-0046 COMPOSE-7, reusing the SPEC-0014/0016 harness pattern). Each
// entity gets a fresh, disposable single-shot `copilot -p` session (ORCH-5/21) with NO tools: it
// returns a JSON decision (grounded prose) and the orchestrator does every effect. Mirrors
// claimsAgent.ts so the harness is reused, not reinvented (ORCH-9).
//
// Grounding is the non-negotiable (SPEC-0046 §3): the agent may synthesize ONLY from the numbered
// claims it is given, and every sentence it returns must cite the claim(s) it draws on. The parse
// seam (parseComposeDecision) REJECTS an un-grounded answer, so a bad session can't write
// ungrounded prose — the stage retries and then falls back to the structured blocks alone (never a
// hard failure; unlike Research, Compose performs NO egress).
import { detectCopilot } from './copilot';
import { UNTRUSTED_SOURCE_SKILL, UNTRUSTED_SOURCE_DELIMITER_NOTE } from './untrustedSource';
import { parseComposeDecision, type ComposeDecision } from './compose';
import { makeDefaultCopilotRunner, runDeciderScaffold, makeAvailabilityGate, type CopilotRunner } from './deciderScaffold';
import type { SpanCtx } from './tracing';

const COPILOT_TIMEOUT_MS = 120_000; // composing readable prose over many claims takes time

/** One claim offered to Compose as evidence — numbered 1..N (array order); the agent cites by number. */
export interface ComposeClaimInput {
  statement: string;
  /** The source's human title — context only; the citation the agent emits is the claim NUMBER. */
  title: string;
}

/** The work item as the Compose agent sees it: ONE entity + its cited claims + the names of the
 *  entities it links to (so cross-links can be woven into the prose; COMPOSE-4). */
export interface ComposeInput {
  entityId: string;
  kind: string;
  name: string;
  claims: ComposeClaimInput[];
  links: string[];
  /** SPEC-0050 slice-3: a durable human GUIDANCE steer for this entity (or global), folded into the
   *  prompt as an editorial orientation — NOT a fact (grounding stays absolute; it only shapes emphasis
   *  /framing over the SAME claims). Absent when there's no active steer. */
  guidance?: string;
}

/** A decider maps a ComposeInput to a validated, grounded ComposeDecision. May throw (COMPOSE-7). */
export type ComposeDecider = (input: ComposeInput, ctx?: SpanCtx) => Promise<ComposeDecision>;

export type { CopilotRunner };

/** The versioned per-stage instruction template (SPEC-0046 §3/§4), composed per entity. */
export const COMPOSE_PROMPT_VERSION = 'compose/v1';

export function buildComposePrompt(input: ComposeInput): string {
  const claimLines = input.claims.map((c, i) => `  [${i + 1}] ${c.statement}  (source: ${c.title})`);
  const linkLine =
    input.links.length > 0
      ? `These related entities have their own pages — when you mention one, write its name as a [[wikilink]]: ${input.links
          .map((n) => `[[${n}]]`)
          .join(', ')}.`
      : 'There are no related entities to link.';
  return [
    'You are the Vellum Compose editor. Write an ENCYCLOPEDIC page about ONE entity — like a',
    'Wikipedia article: a lede that says what/who it is, then sections that group related facts',
    'into flowing prose. NOT a bullet list, NOT a metadata dump.',
    '',
    'SCALE THE DEPTH TO THE EVIDENCE (COMPOSE-10). When there are MANY claims, write a fuller,',
    'multi-section article — a lede plus several thematic `##` sections that develop the entity in',
    'depth. When there are FEW claims, write a short but clean page — a tight lede, perhaps one',
    'section. The length must match how much grounded material exists: a richly-documented entity',
    'reads like a real encyclopedia entry, a thin one stays brief. NEVER pad, repeat, or speculate to',
    'fill space — more depth means MORE of the grounded claims woven in, never invented detail.',
    '',
    'GROUNDING IS ABSOLUTE. You may use ONLY the numbered claims below. You may NOT introduce a',
    'fact that is not in a claim, and you may NOT use outside knowledge. EVERY sentence you write',
    'must be grounded in one or more of the numbered claims, and you must list those claim numbers',
    'for that sentence. A sentence with no claim is forbidden (it would be an un-grounded statement).',
    'Do not write the citation markers yourself — just list the claim numbers per sentence; the',
    'system renders the citations and the References section.',
    '',
    // INTAKE-13 / RESEARCH-12: the claim statements + source titles below are SOURCE-derived (a feed-pulled
    // claim/title could read "ignore your instructions") — fence as DATA. Also reinforces grounding: the task
    // and output format come ONLY from these system instructions, never from anything inside a claim.
    UNTRUSTED_SOURCE_SKILL,
    '',
    linkLine,
    '',
    // SPEC-0050 slice-3: a durable human steer shapes EMPHASIS/FRAMING only — grounding stays absolute
    // (still ONLY the numbered claims; the steer never licenses an un-grounded fact).
    ...(input.guidance && input.guidance.trim().length > 0
      ? [`EDITORIAL GUIDANCE (the user's standing steer for this entity — shape emphasis/framing, NEVER add ungrounded facts): ${input.guidance.trim()}`, '']
      : []),
    `entity.kind: ${input.kind}`,
    `entity.name: ${input.name}`,
    UNTRUSTED_SOURCE_DELIMITER_NOTE, // the claim statements + source titles below are untrusted DATA
    'CLAIMS (the ONLY material you may use; cite by number):',
    ...claimLines,
    '--- SOURCE END ---',
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"sections":[{"heading":"<omit on the first/lede section>","sentences":[{"text":"<one prose sentence, may contain [[Entity]] links, NO citation markers>","claims":[1,2]}]}]}',
    'The first section is the lede and should omit "heading". Add further `##` sections only as the',
    'claims warrant — match the article length to the grounded material (COMPOSE-10).',
    '"heading" is BARE text only (e.g. "Family") — do NOT include leading `#`/`##` marks; we add them.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface ComposeDeciderOptions {
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
 * Build the production Compose decider: a fresh Copilot session per entity. THROWS when Copilot is
 * unavailable OR the output is bad OR the prose is un-grounded (parseComposeDecision enforces the
 * grounding invariants) — the stage retries and, after K attempts, falls back to blocks-only.
 * Stamps an ORCH-16 AgentTrace onto the returned decision.
 */
export function makeComposeDecider(opts: ComposeDeciderOptions = {}): ComposeDecider {
  const run = opts.run ?? makeDefaultCopilotRunner({ stage: 'compose', timeoutMs: COPILOT_TIMEOUT_MS });
  const cwd = opts.vaultPath; // staging worktree → Copilot subprocess cwd (COPILOT-CONTEXT-SCOPE-BUG)
  const isAvailable = makeAvailabilityGate(opts.available, detectCopilot);
  return async (input, ctx) => {
    if (!(await isAvailable())) throw new Error('compose: copilot unavailable');
    // #528 bug 1 fix: adopting the shared scaffold means `agentKey: 'compose'` is now threaded through
    // (previously omitted here — Compose's Settings model pin and Agents-catalog entry were both dead
    // because neither the initial resolve nor the model-fallback wrapper was agent-scoped).
    const { value: decision, agent } = await runDeciderScaffold({
      agentKey: 'compose',
      buildPrompt: () => buildComposePrompt(input),
      parse: (stdout) => parseComposeDecision(stdout, input.entityId, input.claims.length),
      run,
      cwd,
      ctx,
    });
    return { ...decision, agent };
  };
}
