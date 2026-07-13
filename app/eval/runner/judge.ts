// SPEC-0042 EVAL Slice-2 — the agent-judge validator (EVAL-4). A PINNED evaluator model (distinct from
// the system-under-test, so it never grades its own homework) scores a scenario output against a rubric →
// score + rationale; run N times, aggregate vs a threshold. The judge prompt + every rationale are logged
// for auditability. The live judge runs a separate Copilot SDK session (mirrors researchWebAgent); the
// session is an injectable seam so unit tests never load the SDK. Aggregation is pure + unit-tested.
import { acquireCopilotSlot } from '../../src/kb/copilotConcurrency';
import { resolveCopilotModel } from '../../src/kb/copilotModel';
import { DEFAULT_RESEARCH_SESSION_TIMEOUT_MS } from '../../src/kb/researchers';
import type { SessionConfig, SystemMessageConfig } from '@github/copilot-sdk';
import type { JudgeCheck } from './scenario';
import type { VaultSnapshot } from './snapshot';

// Fork #2 (ratified): the judge model is PINNED, distinct from the SUT, recorded in the EVAL-9 manifest,
// and env-overridable. The default is "a strong frontier model distinct from the SUT default" — the exact
// id is BYOA-Copilot-SDK-specific + not load-bearing (the Principal can name one), so it's overridable.
// NOTE: must be a copilot-CLI-valid id (validated pre-flight; validity is CLI-version-coupled — don't
// trust the CLI's own --help example). `claude-opus-4.8` = newest verified-accepted Opus on CLI 1.0.62
// (KB-Lead probe + end-to-end smoke). Deliberately NOT mirrored to copilotModel.ts's prod floor: the
// eval judge runs in a pinned container (no distribution concern), so it takes the newest id directly,
// whereas the prod floor stays 4.5 (broadly compatible) and reaches 4.8 via #342's runtime probe.
export const DEFAULT_JUDGE_MODEL = 'claude-opus-4.8';
/** The pinned judge model id (env override wins) — recorded in the reproducibility manifest (EVAL-9). */
export function resolveJudgeModel(): string {
  return process.env.KB_EVAL_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
}

/** The resolved system-under-test model: the SAME resolution every decider + recall uses
 *  (`resolveCopilotModel`, ORCH-28) — eval-harness `KB_COPILOT_MODEL` override, else the live-CLI-probed
 *  default (`copilotModelProbe.initLaunchModel`'s `resolvedLaunchModel`), else the `DEFAULT_COPILOT_MODEL`
 *  floor. Previously returned a literal `'copilot-default'` placeholder that could never equal the judge
 *  model even when the probed SDK default actually collided with it — a vacuous guard (ENG-3). */
export function resolveSutModel(): string {
  return resolveCopilotModel();
}

/**
 * HARD integrity guard (EVAL-4, KB-Lead-required): the judge model MUST differ from the system-under-test
 * model — a model cannot grade its own homework. Refuses to run on resolved-string equality (e.g. an
 * explicit `KB_COPILOT_MODEL=claude-opus-4.8` colliding with the judge default). A hard refuse beats
 * audit-after-the-fact; both ids are still recorded in the EVAL-9 manifest.
 */
export function assertJudgeDistinctFromSut(): void {
  const judge = resolveJudgeModel();
  const sut = resolveSutModel();
  if (judge === sut) {
    throw new Error(`EVAL judge model (${judge}) must differ from the system-under-test model (${sut}) — a model cannot grade its own homework. Set KB_EVAL_JUDGE_MODEL to a distinct model.`);
  }
}

/** One judge run's verdict — a [0,1] quality score + the model's rationale (logged for auditability). */
export interface JudgeRun {
  score: number;
  rationale: string;
}

/** A rubric's aggregated judgment over N runs (EVAL-4). */
export interface JudgeResult {
  rubric: string;
  model: string;
  runs: JudgeRun[];
  /** Mean of the run scores — the aggregate of the run distribution. */
  aggregateScore: number;
  threshold: number;
  pass: boolean;
}

/** Clamp a raw model score into [0,1] (a misbehaving judge can't push the aggregate out of range). */
function clampScore(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Aggregate N run scores against a threshold (EVAL-4, ratified S2-C): the aggregate is the MEAN of the
 * run distribution; `pass` iff mean ≥ threshold. Pure — unit-tested. Empty runs ⇒ score 0, fail (a judge
 * that never produced a verdict is not a pass).
 */
export function aggregateJudge(scores: number[], threshold: number): { aggregateScore: number; pass: boolean } {
  if (scores.length === 0) return { aggregateScore: 0, pass: false };
  const clamped = scores.map(clampScore);
  const aggregateScore = clamped.reduce((a, b) => a + b, 0) / clamped.length;
  return { aggregateScore, pass: aggregateScore >= threshold };
}

/** The injectable judge session: one rubric judgment over the rendered output. Production = the live
 *  pinned-model SDK session; tests inject a deterministic fake. */
export type JudgeSession = (input: { model: string; rubric: string; output: string }) => Promise<JudgeRun>;

/** Render the scenario output the judge scores (the recall answer + a compact entities/claims digest). */
export function renderJudgeOutput(snap: VaultSnapshot): string {
  const lines: string[] = [];
  if (snap.recall) lines.push(`RECALL ANSWER:\n${snap.recall.answer}\n(grounded=${snap.recall.grounded}, citations=${snap.recall.citations.length})`);
  lines.push(`\nENTITIES (${snap.entities.length}):`, ...snap.entities.map((e) => `- ${e.path}`));
  lines.push(`\nCLAIMS (${snap.claims.length}):`, ...snap.claims.map((c) => `- ${c.path}`));
  return lines.join('\n');
}

/**
 * Run one judge check over the snapshot: N runs (check.runs ?? 3) of the pinned-model session, aggregate
 * vs the threshold (check.threshold ?? 0.8). The session is injected (tests) or the live one (prod). Each
 * rationale is returned in `runs` for the scorecard log (EVAL-4 auditability).
 */
export async function runJudgeCheck(check: JudgeCheck, snap: VaultSnapshot, opts: { session?: JudgeSession; cliPath?: string } = {}): Promise<JudgeResult> {
  assertJudgeDistinctFromSut(); // refuse before running — the judge can't be the SUT (KB-Lead-required)
  const model = resolveJudgeModel();
  const threshold = check.threshold ?? 0.8;
  const n = Math.max(1, check.runs ?? 3);
  const session = opts.session ?? liveJudgeSession({ cliPath: opts.cliPath });
  const output = renderJudgeOutput(snap);
  const runs: JudgeRun[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const r = await session({ model, rubric: check.rubric, output });
      runs.push({ score: clampScore(r.score), rationale: r.rationale });
    } catch (e) {
      runs.push({ score: 0, rationale: `judge run failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const { aggregateScore, pass } = aggregateJudge(runs.map((r) => r.score), threshold);
  return { rubric: check.rubric, model, runs, aggregateScore, threshold, pass };
}

/** The judge system message — frames the model as an impartial evaluator returning a [0,1] score + why. */
const JUDGE_SKILL = [
  'You are an impartial EVALUATOR for a knowledge-base eval harness. You are NOT the system being tested.',
  'Score how well the OUTPUT satisfies the RUBRIC, as a single number from 0.0 (fails) to 1.0 (fully meets),',
  'with a one-paragraph rationale citing specifics from the output. Be calibrated + strict; do not reward',
  'vagueness. FINISH by calling submitJudgment EXACTLY ONCE with { score, rationale }.',
].join('\n');

/** The live pinned-model judge session (mirrors researchWebAgent.liveSdkSession). SDK dynamically imported
 *  so unit tests (which inject `session`) never load it; the live path is exercised opt-in / in CI/e2e. */
function liveJudgeSession(opts: { cliPath?: string }): JudgeSession {
  return async ({ model, rubric, output }) => {
    const { CopilotClient, defineTool, approveAll, RuntimeConnection } = await import('@github/copilot-sdk');
    let verdict: JudgeRun | null = null;
    const release = await acquireCopilotSlot();
    const client = new CopilotClient(opts.cliPath ? { connection: RuntimeConnection.forStdio({ path: opts.cliPath }) } : {});
    try {
      const systemMessage: SystemMessageConfig = { mode: 'replace', content: JUDGE_SKILL };
      const tools = [
        defineTool('submitJudgment', {
          description: 'Submit the rubric score (0..1) and a one-paragraph rationale. Call exactly once.',
          parameters: { type: 'object', properties: { score: { type: 'number' }, rationale: { type: 'string' } }, required: ['score', 'rationale'], additionalProperties: false },
          handler: async (args: unknown) => {
            const a = args as { score?: unknown; rationale?: unknown };
            verdict = { score: clampScore(a.score), rationale: typeof a.rationale === 'string' ? a.rationale : '' };
            return { ok: true };
          },
        }),
      ];
      const sessionConfig: SessionConfig = { clientName: 'kb-app-eval-judge', model, systemMessage, tools, availableTools: ['submitJudgment'], onPermissionRequest: approveAll };
      const session = await client.createSession(sessionConfig);
      try {
        await session.sendAndWait(`RUBRIC:\n${rubric}\n\nOUTPUT TO EVALUATE:\n${output}\n\nScore it, then call submitJudgment exactly once.`, DEFAULT_RESEARCH_SESSION_TIMEOUT_MS);
      } finally {
        await session.disconnect();
      }
      return verdict ?? { score: 0, rationale: 'judge produced no verdict' };
    } finally {
      await client.stop();
      release();
    }
  };
}
