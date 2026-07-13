// SPEC-0042 EVAL Slice-2 — agent-judge (EVAL-4). Pure/deterministic — aggregation + model resolution +
// runJudgeCheck driven by an INJECTED session (the live pinned-model SDK path is opt-in/e2e). Runs in CI.
import { describe, it, expect, afterEach } from 'vitest';
import { aggregateJudge, resolveJudgeModel, resolveSutModel, assertJudgeDistinctFromSut, runJudgeCheck, renderJudgeOutput, DEFAULT_JUDGE_MODEL, type JudgeSession } from './judge';
import { setResolvedLaunchModel } from '../../src/kb/copilotModel';
import type { VaultSnapshot } from './snapshot';
import type { AskResult } from '../../src/kb/recall';

const snap = (over: Partial<VaultSnapshot> = {}): VaultSnapshot => ({ root: '/v', entities: [], claims: [], sources: [], outputs: [], recall: null, audit: [], spans: [], devLog: [], ...over });
const ask = (over: Partial<AskResult> = {}): AskResult => ({ question: 'q', answer: 'a', citations: [], grounded: false, toolCalls: 0, truncated: false, ...over });

describe('aggregateJudge (mean of run distribution vs threshold)', () => {
  it('passes when the mean ≥ threshold, fails below', () => {
    expect(aggregateJudge([1, 1, 1], 0.8)).toEqual({ aggregateScore: 1, pass: true });
    expect(aggregateJudge([0.9, 0.8, 0.7], 0.8)).toMatchObject({ pass: true }); // mean 0.8 ≥ 0.8
    expect(aggregateJudge([0.5, 0.5], 0.8)).toMatchObject({ pass: false });
  });
  it('empty runs → score 0, fail (a judge that never scored is not a pass)', () => {
    expect(aggregateJudge([], 0.8)).toEqual({ aggregateScore: 0, pass: false });
  });
  it('clamps out-of-range scores into [0,1]', () => {
    expect(aggregateJudge([2, -1], 0.8)).toEqual({ aggregateScore: 0.5, pass: false }); // → [1,0] mean 0.5
  });
});

describe('resolveJudgeModel', () => {
  afterEach(() => {
    delete process.env.KB_EVAL_JUDGE_MODEL;
  });
  it('defaults to DEFAULT_JUDGE_MODEL; env overrides', () => {
    delete process.env.KB_EVAL_JUDGE_MODEL;
    expect(resolveJudgeModel()).toBe(DEFAULT_JUDGE_MODEL);
    process.env.KB_EVAL_JUDGE_MODEL = 'some-other-model';
    expect(resolveJudgeModel()).toBe('some-other-model');
  });
});

describe('assertJudgeDistinctFromSut — judge ≠ SUT hard guard (EVAL-4, KB-Lead-required)', () => {
  afterEach(() => {
    delete process.env.KB_COPILOT_MODEL;
    delete process.env.KB_EVAL_JUDGE_MODEL;
  });
  it('REFUSES when the resolved judge model equals the resolved SUT model (the opus-4 collision)', () => {
    process.env.KB_COPILOT_MODEL = DEFAULT_JUDGE_MODEL; // SUT collides with the judge default
    expect(resolveSutModel()).toBe(DEFAULT_JUDGE_MODEL);
    expect(() => assertJudgeDistinctFromSut()).toThrow(/cannot grade its own homework/);
  });
  it('allows distinct models (default judge vs SDK-default SUT)', () => {
    delete process.env.KB_COPILOT_MODEL;
    expect(() => assertJudgeDistinctFromSut()).not.toThrow();
  });
  it('runJudgeCheck refuses to run on a judge==SUT collision (hard fail, not a 0-score run)', async () => {
    process.env.KB_COPILOT_MODEL = DEFAULT_JUDGE_MODEL;
    await expect(runJudgeCheck({ rubric: 'r' }, snap(), { session: async () => ({ score: 1, rationale: 'x' }) })).rejects.toThrow(/grade its own homework/);
  });
  it('trips when the PROBED SDK default (no explicit KB_COPILOT_MODEL override) collides with the judge model — the vacuous-guard regression (ENG-3)', () => {
    delete process.env.KB_COPILOT_MODEL; // no eval override — force resolution through the probed default
    setResolvedLaunchModel(DEFAULT_JUDGE_MODEL); // simulate copilotModelProbe.initLaunchModel() resolving the same model as the judge
    try {
      expect(resolveSutModel()).toBe(DEFAULT_JUDGE_MODEL);
      expect(() => assertJudgeDistinctFromSut()).toThrow(/cannot grade its own homework/);
    } finally {
      setResolvedLaunchModel(null);
    }
  });
});

describe('renderJudgeOutput', () => {
  it('includes the recall answer + entity/claim digest for the judge to assess', () => {
    const out = renderJudgeOutput(snap({ recall: ask({ answer: 'Hopper worked on COBOL.' }), entities: [{ path: 'entities/person/grace-hopper.md', body: '' }] }));
    expect(out).toMatch(/Hopper worked on COBOL/);
    expect(out).toMatch(/grace-hopper\.md/);
  });
});

describe('runJudgeCheck (N runs via injected session, aggregate vs threshold)', () => {
  it('runs the default N=3, aggregates, passes, and logs each rationale', async () => {
    const session: JudgeSession = async () => ({ score: 0.9, rationale: 'good' });
    const r = await runJudgeCheck({ rubric: 'is it correct?' }, snap(), { session });
    expect(r.runs).toHaveLength(3);
    expect(r.threshold).toBe(0.8);
    expect(r.pass).toBe(true);
    expect(r.runs.every((x) => x.rationale === 'good')).toBe(true);
  });
  it('honors scenario-supplied runs + threshold; fails below threshold', async () => {
    const session: JudgeSession = async () => ({ score: 0.6, rationale: 'meh' });
    const r = await runJudgeCheck({ rubric: 'r', runs: 2, threshold: 0.8 }, snap(), { session });
    expect(r.runs).toHaveLength(2);
    expect(r.pass).toBe(false);
  });
  it('a thrown judge run scores 0 (failed≠silent), not a crash', async () => {
    const session: JudgeSession = async () => {
      throw new Error('judge boom');
    };
    const r = await runJudgeCheck({ rubric: 'r', runs: 1 }, snap(), { session });
    expect(r.runs[0].score).toBe(0);
    expect(r.runs[0].rationale).toMatch(/judge run failed/);
    expect(r.pass).toBe(false);
  });
});
