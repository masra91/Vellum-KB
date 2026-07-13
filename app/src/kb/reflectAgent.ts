// The thin Reflect agent (SPEC-0024 REFLECT-3) — the rumination cognition over ONE bounded working
// set. Like decompose/connect deciders it is a fresh, disposable single-shot `copilot -p` session
// with NO tools (a single pass, not KB-traversing/multi-hop — so CLI, not the SDK, per #43): it
// returns a JSON verdict of findings and the orchestrator (JobStage) does every effect. There is
// NO fabricating fallback — a bad/absent session throws and the job run is treated as a failed pass.
import { extractBalancedJson } from './jsonExtract';
import { detectCopilot } from './copilot';
import { normalizeStatement as normalizeStatementForCompare } from './directives';
import { makeDefaultCopilotRunner, runDeciderScaffold, makeAvailabilityGate, type CopilotRunner } from './deciderScaffold';
import type { AgentTrace } from './archivist';

const COPILOT_TIMEOUT_MS = 120_000;

/** A node in the working set the agent ruminates over (a bounded slice — never the whole KB). */
export interface ReflectNode {
  rel: string; // repo-relative entity node path
  name: string;
  kind: string;
  tags: string[];
  excerpt: string; // a short body excerpt (claims/links block snippet) for context
}

/** What the agent sees: the bounded working set + brief continuity from the journal (JOBS-7). */
export interface ReflectContext {
  workingSet: ReflectNode[];
  journalNotes: string[]; // recent "inspected"/cursor breadcrumbs, oldest→newest
}

/**
 * One thing rumination found. Additive findings carry `writes` (applied on `staging`); destructive
 * ones (retire/merge/consolidate) carry a `review` proposal and NO writes — JobStage routes them by
 * posture (REFLECT-4/5). Mirrors the engine's `JobFinding` minus the runner-owned `proposed` field.
 */
export interface ReflectFinding {
  summary: string; // the what + why (audit; AUTO-8)
  kind: 'additive' | 'destructive';
  confidence: number; // 0..1 — agent-judged (no fixed numeric window in v1, REFLECT-3)
  writes?: { rel: string; content: string }[]; // additive effects (missed claim, emergent-topic node, tag refresh)
  // destructive/low-confidence → Review proposal. A `consolidation` target names the merge an
  // approved Review will execute (REFLECT-7): the survivor node + the loser(s) to fold into it.
  // A `contradiction` target (SPEC-0036 CONTRA-2) names a detected DISAGREEMENT: the entity node and
  // the two conflicting claim statements. The orchestrator records a durable contradiction flag on the
  // entity (keyed on its block identity) AND routes the yes/no question to Review (CONTRA-1/5); the flag
  // persists until the human resolves it.
  review?: {
    question: string;
    detail?: string;
    consolidation?: { canonicalRel: string; loserRels: string[] };
    contradiction?: { entityRel: string; statementA: string; statementB: string };
  };
}

export interface ReflectResult {
  inspected: string; // what this pass looked at (for audit + journal)
  findings: ReflectFinding[];
  /** #528 bug 2 fix: ORCH-16 provenance — previously never built (Reflect passes had zero record of
   *  which model ran, timing, or self-repair rounds, unlike every other decider's decision). */
  agent?: AgentTrace;
}

/** A reflect decider maps a working set to findings. May throw (no fabrication). Injectable for tests. */
export type ReflectDecider = (ctx: ReflectContext) => Promise<ReflectResult>;

export type { CopilotRunner };

export const REFLECT_PROMPT_VERSION = 'reflect/v1';

export function buildReflectPrompt(ctx: ReflectContext): string {
  const nodeLines = ctx.workingSet.map(
    (n) => `  - rel: ${n.rel}  name: ${JSON.stringify(n.name)}  kind: ${n.kind}  tags: ${JSON.stringify(n.tags)}  excerpt: ${JSON.stringify(n.excerpt)}`,
  );
  const journalLines = ctx.journalNotes.length > 0 ? ctx.journalNotes.map((j) => `  - ${j}`) : ['  (first run / none)'];
  return [
    'You are the Vellum Reflect librarian doing one RUMINATION pass over a BOUNDED slice of the KB',
    '(NOT the whole KB). Look ONLY at the working set below and find what the forward pipeline missed',
    'or what has gone stale: missed claims, missing/lost connections, emergent topics (recurring',
    'themes with no node yet), stale derived metadata (tags), and low-traction topics.',
    '',
    'Bias toward GROWTH, not shrink. ADDITIVE, high-confidence repairs (add a missed claim, restore a',
    'link, coin or refresh an emergent "topic/" tag for a node missing its thematic labels, group an',
    'emergent topic) → kind "additive" with `writes` (each a',
    'repo-relative path + full file content). Anything DESTRUCTIVE (retire/merge/consolidate/delete a',
    'node) or low-confidence → kind "destructive" with a yes/no `review` {question, detail} and NO',
    'writes — never delete or merge directly. Finding NOTHING is a normal, good outcome (return []).',
    '',
    'CONTRADICTIONS: if TWO claims about the SAME ONE entity assert INCOMPATIBLE facts (e.g. "born',
    '1815" vs "born 1816"; a spec line vs its reversed revision), report it as kind "destructive" with a',
    'yes/no `review` AND a `contradiction` {entityRel, statementA, statementB} — entityRel is that',
    'entity\'s `rel`, and the two statements are the conflicting claims VERBATIM. Phrase the question so',
    'CONFIRM = supersede with the newer/stronger source and REJECT = keep BOTH (a genuine disagreement,',
    'both stay attributed). Only for a real incompatibility about one entity, NOT merely related claims.',
    '',
    'Prior runs (for continuity — avoid re-chewing the same ground):',
    ...journalLines,
    '',
    'Working set:',
    ...nodeLines,
    '',
    'Respond with ONLY a JSON object and nothing else, of the form:',
    '{"inspected":"<short note on what you looked at>","findings":[{"summary":"...","kind":"additive|destructive","confidence":0.0,"writes":[{"rel":"...","content":"..."}],"review":{"question":"...","detail":"...","contradiction":{"entityRel":"...","statementA":"...","statementB":"..."}}}]}',
  ].join('\n');
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Parse + validate one session's stdout into a ReflectResult. Tolerates surrounding prose by
 * extracting the first JSON object. Throws on a bad shape — the run is treated as a failed pass and
 * NEVER fabricates a finding (a wrong destructive proposal or bogus write is worse than no-op).
 */
export function parseReflectResult(stdout: string): ReflectResult {
  const json = extractBalancedJson(stdout); // HEAL-2: tolerate fences/leading/trailing prose
  if (json === null) throw new Error('reflect: no JSON object in output');
  // REFLECT-18 + HEAL-2: lenient extraction (extractBalancedJson) finds the brace-balanced object even
  // amid prose/fences; a still-malformed object surfaces as a clear, controlled reflect error — the job
  // runner catches it (sets the slice aside, never fabricates a finding) and HEAL-1 self-repair feeds the
  // error back to the model for a corrected round.
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`reflect: agent output was not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isNonEmptyString(obj.inspected)) throw new Error('reflect: missing inspected');
  if (!Array.isArray(obj.findings)) throw new Error('reflect: findings must be an array');
  const findings = obj.findings.map((f, i): ReflectFinding => {
    if (typeof f !== 'object' || f === null) throw new Error(`reflect: findings[${i}] must be an object`);
    const o = f as Record<string, unknown>;
    if (!isNonEmptyString(o.summary)) throw new Error(`reflect: findings[${i}].summary required`);
    if (o.kind !== 'additive' && o.kind !== 'destructive') throw new Error(`reflect: findings[${i}].kind must be additive|destructive`);
    if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
      throw new Error(`reflect: findings[${i}].confidence must be a number in [0,1]`);
    }
    const finding: ReflectFinding = { summary: o.summary, kind: o.kind, confidence: o.confidence };
    if (o.writes !== undefined) {
      if (!Array.isArray(o.writes)) throw new Error(`reflect: findings[${i}].writes must be an array`);
      finding.writes = o.writes.map((w, j) => {
        const wo = w as Record<string, unknown>;
        if (!isNonEmptyString(wo?.rel) || typeof wo?.content !== 'string') {
          throw new Error(`reflect: findings[${i}].writes[${j}] must be { rel, content }`);
        }
        return { rel: wo.rel, content: wo.content };
      });
    }
    if (o.review !== undefined) {
      const ro = o.review as Record<string, unknown>;
      if (!isNonEmptyString(ro?.question)) throw new Error(`reflect: findings[${i}].review.question required`);
      finding.review = { question: ro.question, ...(isNonEmptyString(ro.detail) ? { detail: ro.detail } : {}) };
      if (ro.consolidation !== undefined) {
        const co = ro.consolidation as Record<string, unknown>;
        if (!isNonEmptyString(co?.canonicalRel) || !Array.isArray(co?.loserRels) || !co.loserRels.every(isNonEmptyString)) {
          throw new Error(`reflect: findings[${i}].review.consolidation must be { canonicalRel, loserRels[] }`);
        }
        finding.review.consolidation = { canonicalRel: co.canonicalRel, loserRels: co.loserRels as string[] };
      }
      if (ro.contradiction !== undefined) {
        // SPEC-0036 CONTRA-2: a detected disagreement — the entity node + the two conflicting statements.
        const xo = ro.contradiction as Record<string, unknown>;
        if (!isNonEmptyString(xo?.entityRel) || !isNonEmptyString(xo?.statementA) || !isNonEmptyString(xo?.statementB)) {
          throw new Error(`reflect: findings[${i}].review.contradiction must be { entityRel, statementA, statementB }`);
        }
        if (normalizeStatementForCompare(xo.statementA) === normalizeStatementForCompare(xo.statementB)) {
          throw new Error(`reflect: findings[${i}].review.contradiction statements must differ`);
        }
        finding.review.contradiction = { entityRel: xo.entityRel, statementA: xo.statementA, statementB: xo.statementB };
      }
    }
    return finding;
  });
  return { inspected: obj.inspected, findings };
}

export interface ReflectDeciderOptions {
  available?: boolean;
  run?: CopilotRunner;
  /** Working directory for the Copilot subprocess (the staging worktree, threaded from the
   *  pipeline). Set as the execFile `cwd` so Copilot's workspace scan stays scoped here, not the
   *  filesystem root — `--add-dir` only widens permissions, it does NOT move the cwd. */
  vaultPath?: string;
}

/** Build the production Reflect decider: a fresh Copilot session per pass. Throws when Copilot is
 *  unavailable or the output is bad (the run is a failed pass; no fabrication). */
export function makeReflectDecider(opts: ReflectDeciderOptions = {}): ReflectDecider {
  // No `stage` tag, unlike every other decider — reflect stays deliberately untagged/background,
  // sharing the remaining copilotConcurrency pool rather than reserving a named slice.
  const run = opts.run ?? makeDefaultCopilotRunner({ timeoutMs: COPILOT_TIMEOUT_MS });
  const cwd = opts.vaultPath; // staging worktree → Copilot subprocess cwd (COPILOT-CONTEXT-SCOPE-BUG)
  const isAvailable = makeAvailabilityGate(opts.available, detectCopilot);
  return async (ctx) => {
    if (!(await isAvailable())) throw new Error('reflect: copilot unavailable');
    // #528 bug 2 fix: adopting the shared scaffold means an AgentTrace is now built and attached —
    // Reflect previously returned zero provenance (no model/timing/repair count) on every pass.
    const { value, agent } = await runDeciderScaffold({
      agentKey: 'reflect',
      buildPrompt: () => buildReflectPrompt(ctx),
      parse: parseReflectResult,
      run,
      cwd,
    });
    return { ...value, agent };
  };
}
