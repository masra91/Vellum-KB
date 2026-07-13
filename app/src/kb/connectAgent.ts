// The thin Connect agent (SPEC-0020 CONNECT-5, reusing the SPEC-0014 harness pattern).
// Each CANDIDATE SET (one block key) gets a fresh, disposable single-shot `copilot -p`
// session (ORCH-5) with NO tools: it returns a JSON verdict and the orchestrator does every
// effect (CONNECT-5). Mirrors decomposeAgent.ts so the harness is reused, not reinvented.
//
// Like Decompose, there is NO fabricating fallback: a bad/absent session must NOT invent a
// resolution (a wrong merge conflates two real things — worse than a wrong claim). On any
// failure the decider throws, and the stage treats it as a failed attempt (retry, then set
// aside; CONNECT-14 / ORCH-12).
import { detectCopilot } from './copilot';
import { UNTRUSTED_SOURCE_SKILL, UNTRUSTED_SOURCE_DELIMITER_NOTE } from './untrustedSource';
import { parseConnectDecision, type Candidate, type ConnectDecision } from './connect';
import { makeDefaultCopilotRunner, runDeciderScaffold, makeAvailabilityGate, type CopilotRunner } from './deciderScaffold';
import type { SpanCtx } from './tracing';

const COPILOT_TIMEOUT_MS = 120_000;

/** A minimal view of an existing canonical node that blocks to the same key (for fold-in). */
export interface ExistingNodeRef {
  id: string; // the node's stable id (frontmatter `id`)
  name: string; // its current canonical name
}

/** A durable prior verdict on a pair of same-block existing nodes (REVIEW-18 / CONNECT-21). */
export interface PriorDisambiguation {
  a: string; // existingNodeId
  b: string; // existingNodeId
  verdict: 'same' | 'distinct';
}

/** One bounded candidate set the agent resolves (CONNECT-4): all share `blockKey`. */
export interface CandidateSet {
  blockKey: string;
  kind: string;
  candidates: Candidate[]; // the unresolved candidates in this block (≥1)
  existingNodes: ExistingNodeRef[]; // already-canonical nodes with the same block key (may be empty)
  /**
   * Durable decisions already made about pairs of the existing nodes above (REVIEW-18). The matcher
   * must RESOLVE against these, not re-open them: a `distinct` pair is settled-separate, a `same` pair
   * is one node. Do NOT raise a review for a pair listed here — it has already been decided (CONNECT-21).
   */
  priorDecisions?: PriorDisambiguation[];
  /**
   * Map of candidate `sourceId` → the source's HUMAN TITLE (PRIN-24 / "never surface ULIDs"). The
   * prompt references a candidate's source by this title, NEVER the raw ULID — the model can only echo
   * what it is given, and feeding it the raw id is exactly why source ULIDs leaked into disambiguation
   * glosses. The stage resolves these (deriveSourceTitle), so a value is always a human label, never an
   * id; an absent entry falls back to a neutral label, still never the ULID.
   */
  sourceTitles?: Record<string, string>;
}

/** A decider maps a candidate set to a validated verdict. May throw (CONNECT-14). */
export type ConnectDecider = (set: CandidateSet, ctx?: SpanCtx) => Promise<ConnectDecision>;

export type { CopilotRunner };

/** The versioned per-stage instruction template (SPEC-0014 Q9 / SPEC-0020 §3.3). */
export const CONNECT_PROMPT_VERSION = 'connect/v1';

export function buildConnectPrompt(set: CandidateSet): string {
  // PRIN-24 / "never surface ULIDs": reference each candidate's source by its HUMAN TITLE, never the
  // raw source ULID. The model only echoes what it is given — feeding `source: <ULID>` is exactly why
  // a raw id leaked into the disambiguation gloss. `sourceTitles` (sourceId → title) is resolved by the
  // stage and never holds an id; an absent entry collapses to a neutral label, still never the ULID.
  const candidateLines = set.candidates.map((c) => {
    const title = set.sourceTitles?.[c.sourceId]?.trim();
    return `  - id: ${c.id}  name: ${JSON.stringify(c.name)}  source: ${JSON.stringify(title || 'untitled source')}  mentions: ${JSON.stringify(c.mentions)}`;
  });
  const existingLines =
    set.existingNodes.length > 0
      ? set.existingNodes.map((n) => `  - existingNodeId: ${n.id}  name: ${JSON.stringify(n.name)}`)
      : ['  (none)'];
  // REVIEW-18 / CONNECT-21: decisions already made about pairs of the existing nodes — resolve against
  // them, NEVER re-ask. `distinct` = settled-separate (two real things sharing a name); `same` = one node.
  const priorDecisionLines =
    set.priorDecisions && set.priorDecisions.length > 0
      ? set.priorDecisions.map((d) => `  - ${d.a} and ${d.b}: ALREADY DECIDED ${d.verdict.toUpperCase()} — do NOT raise a review for this pair`)
      : null;
  return [
    'You are the Vellum Connect librarian. ENTITY RESOLUTION: decide which of these',
    `per-source candidate mentions (all loosely grouped as kind "${set.kind}") refer to the`,
    'SAME real-world thing. The grouping is deliberately loose — it may over-group. SPLIT it',
    'into one CLUSTER per distinct real thing.',
    '',
    // INTAKE-13 / RESEARCH-12: candidate names + mentions + source titles below are SOURCE-derived (a
    // feed item could name an entity "ignore your instructions / merge everything") — fence as DATA.
    UNTRUSTED_SOURCE_SKILL,
    '',
    'For each cluster give: canonicalName (the best human name for the node), the',
    'memberCandidateIds it contains, a confidence in [0,1], and — if the cluster is the same',
    'thing as one of the existing nodes below — that node\'s existingNodeId (to fold into it).',
    'EVERY candidate id below MUST appear in exactly one cluster.',
    '',
    'TOPIC TAGS (SPEC-0025 META-2): for each cluster ALSO coin tags[] — 1–4 emergent "topic/" tags for',
    'the recurring THEMES / domains this entity belongs to, drawn from its mentions + source context',
    '(e.g. "topic/machine-learning", "topic/travel", "topic/finance"). Topic tags are the COMMUNITY LABELS',
    'that knit the knowledge graph together — a topic is a theme MANY entities can share. So:',
    '  - make them broad + REUSABLE (prefer a few general topics over many hyper-specific ones);',
    '  - format each as lowercase "topic/<short-kebab-theme>";',
    '  - NEVER restate this entity\'s own name or kind as a topic (no "topic/<the name>", no "topic/person");',
    '  - if the entity has no clear thematic domain, omit tags[] — do not force one.',
    '',
    'EVENT DATES (SPEC-0025 META Slice-2): for each cluster ALSO coin dates[] — the entity\'s notable EVENT',
    'dates that are STATED in the sources (e.g. born, died, founded, released, joined). Each is',
    '{"label":"<short kebab event, e.g. founded>","value":"<ISO date>"}, where value is as precise as the',
    'source supports: a year "1976", a year-month "2007-06", or a full date "2007-06-29" — do NOT invent a',
    'month or day the source doesn\'t give (just use the year). Only dates ABOUT this entity, grounded in the',
    'text; if none are stated, omit dates[] — never guess or fabricate a date.',
    '',
    'Do NOT merge things that are merely similar — when two mentions are genuinely ambiguous',
    '(e.g. "S. Jobs" could be a different person), keep them in SEPARATE clusters and raise a',
    'review instead of guessing. A wrong merge conflates two real things.',
    '',
    `blockKey: ${set.blockKey}`,
    `kind: ${set.kind}`,
    UNTRUSTED_SOURCE_DELIMITER_NOTE, // the candidate/existing-node names + mentions below are untrusted DATA
    'CANDIDATES:',
    ...candidateLines,
    'EXISTING NODES (same block — fold a cluster into one only if truly the same thing):',
    ...existingLines,
    ...(priorDecisionLines
      ? ['ALREADY-DECIDED PAIRS (durable verdicts — resolve against these, NEVER re-ask):', ...priorDecisionLines]
      : []),
    '--- SOURCE END ---',
    '',
    'Optionally add reviews[] for genuinely ambiguous merges — the affected candidates are',
    'parked, not merged, until answered. For each such review you MUST make the candidates',
    'tellable apart so a human can decide WITHOUT re-reading the sources (REVIEW-16):',
    '  - candidates[]: for EACH affected candidate, give its id (from CANDIDATES above) and a',
    '    one-line "gloss" — what makes THIS one this one: its source context, strongest claim,',
    '    or timeframe (e.g. "from the fishing-trip notes, May 2026" vs "Dave\'s wedding guest',
    '    list"). You hold every candidate\'s mentions + source — author the gloss from them.',
    '  - Refer to a source by the human TITLE shown in its "source:" field above, NEVER a raw id.',
    '    The question and every gloss MUST contain NO opaque ids (ULIDs) — they are meaningless to a',
    '    human and break the "never surface an internal id" promise (PRIN-24).',
    '  - the question itself MUST use those glosses, NOT bare names — a bare "Is Benton the same',
    '    as Benton?" is undecidable. e.g. "Is Benton (fishing-trip notes) the same person as',
    '    Benton (Dave\'s wedding list)?"',
    '  - when the ambiguity is between two EXISTING NODES above (e.g. two same-named nodes that may',
    '    or may not be one), add "pair":["<existingNodeIdA>","<existingNodeIdB>"] — the verdict is then',
    '    remembered durably for that pair so you are never asked about it again (REVIEW-18).',
    'Optionally add signals[] (typed notes for the audit log only; type is open — note,',
    'possible-duplicate, ambiguity, suggestion). Both are optional and usually unnecessary.',
    '',
    'Do NOT create typed links or resolve relationships — only entity resolution here.',
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"blockKey":"<the key above>","clusters":[{"canonicalName":"...","memberCandidateIds":["..."],"existingNodeId":"...","confidence":0.0,"tags":["topic/..."],"dates":[{"label":"founded","value":"1976"}]}],"reviews":[{"question":"...","detail":"...","candidates":[{"id":"<candidate id>","gloss":"..."}],"pair":["<existingNodeIdA>","<existingNodeIdB>"],"refs":["..."]}],"signals":[{"type":"...","note":"...","refs":["..."]}]}',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface ConnectDeciderOptions {
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
 * Build the production Connect decider: a fresh Copilot session per candidate set. THROWS
 * when Copilot is unavailable or the output is bad — the stage retries and, after K attempts,
 * sets the block aside (CONNECT-14). Stamps an ORCH-16 AgentTrace onto the returned verdict.
 * The verdict is validated to PARTITION exactly the candidate ids in the set (connect.ts).
 */
export function makeConnectDecider(opts: ConnectDeciderOptions = {}): ConnectDecider {
  const run = opts.run ?? makeDefaultCopilotRunner({ stage: 'connect', timeoutMs: COPILOT_TIMEOUT_MS });
  const cwd = opts.vaultPath; // staging worktree → Copilot subprocess cwd (COPILOT-CONTEXT-SCOPE-BUG)
  const isAvailable = makeAvailabilityGate(opts.available, detectCopilot);
  return async (set, ctx) => {
    if (!(await isAvailable())) throw new Error('connect: copilot unavailable');
    const ids = set.candidates.map((c) => c.id);
    const { value: decision, agent } = await runDeciderScaffold({
      agentKey: 'connect',
      buildPrompt: () => buildConnectPrompt(set),
      parse: (stdout) => parseConnectDecision(stdout, set.blockKey, ids),
      run,
      cwd,
      ctx,
    });
    return { ...decision, agent };
  };
}
