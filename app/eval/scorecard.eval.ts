// Issue #525 (ENG-13) — the weekly eval SCORECARD gate. Runs every eval/scenarios/*.yaml through the
// SAME runner as library.eval.ts (no fork), but diffs against the COMMITTED baseline
// (`eval/baselines-committed/`, version-controlled) instead of the gitignored ad-hoc one, writes a
// JSON scorecard artifact for CI to upload, and — unlike library.eval.ts — FAILS the run when anything
// regressed. This is what makes "green" mean the harness can actually catch a quality regression: before
// this file, baselines were gitignored (no last-known-good existed anywhere a CI run could see) and
// nothing ever asserted zero-regressions.
//
// OPT-IN (BYOA-gated, non-required): needs a real copilot + scoped eval creds, so it self-skips unless
// KB_EVAL=1 — same convention as every other *.eval.ts. Two modes:
//   Diff (default):            KB_EVAL=1 npm run eval:scorecard
//   Promote (dispatch-only):   KB_EVAL=1 KB_EVAL_UPDATE_BASELINE=1 npm run eval:scorecard
// See `.github/workflows/nightly.yml` (the `eval-scorecard` job) + `eval/baselines-committed/README.md`.
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadScenario } from './runner/loader';
import { runMatrix } from './runner/runMatrix';
import { formatScorecard } from './runner/scorecard';
import { COMMITTED_BASELINE_DIR } from './runner/baseline';

const ENABLED = process.env.KB_EVAL === '1';
const UPDATE_BASELINE = process.env.KB_EVAL_UPDATE_BASELINE === '1';
const OUT_PATH = path.resolve(process.cwd(), process.env.KB_EVAL_SCORECARD_OUT || 'eval-scorecard.json');
const TIMEOUT_MS = 30 * 60_000; // mirrors library.eval.ts — real copilot over the full scenario library is slow
const SCENARIOS_DIR = path.resolve(process.cwd(), 'eval/scenarios');

/** One scenario×variant's row in the JSON scorecard artifact — everything a human/QA needs without
 *  re-running the eval: pass/fail counts, judge scores, the baseline diff, and the repro manifest. */
interface ScorecardRow {
  scenarioId: string;
  capability: string;
  variant: string;
  passed: number;
  failed: number;
  total: number;
  judge: { rubric: string; model: string; aggregateScore: number; threshold: number; pass: boolean }[];
  ok: boolean;
  diff: { regressions: number; improvements: number; ok: boolean };
  manifest: { sutModel: string; judgeModel: string; node: string; at: string };
}

describe.skipIf(!ENABLED)('issue #525 — eval scorecard vs committed baseline (weekly, BYOA-gated, non-required)', () => {
  it(
    UPDATE_BASELINE
      ? 'promotes every scenario × variant scorecard to the committed baseline (dispatch-only)'
      : 'diffs every scenario × variant against the committed baseline and fails on any regression',
    async () => {
      const files = (await fs.readdir(SCENARIOS_DIR)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
      const rows: ScorecardRow[] = [];
      const regressed: string[] = [];

      for (const file of files) {
        const scenario = await loadScenario(path.join(SCENARIOS_DIR, file));
        const results = await runMatrix(scenario, { baselineDir: COMMITTED_BASELINE_DIR, updateBaseline: UPDATE_BASELINE });
        for (const { scorecard, diff, manifest } of results) {
          console.log('\n' + formatScorecard(scorecard));
          console.log(`baseline (committed): ${diff.regressions} regression(s), ${diff.improvements} improvement(s)`);
          rows.push({
            scenarioId: scorecard.scenarioId,
            capability: scorecard.capability,
            variant: scorecard.variant,
            passed: scorecard.passed,
            failed: scorecard.failed,
            total: scorecard.total,
            judge: scorecard.judge.map((j) => ({ rubric: j.rubric, model: j.model, aggregateScore: j.aggregateScore, threshold: j.threshold, pass: j.pass })),
            ok: scorecard.ok,
            diff: { regressions: diff.regressions, improvements: diff.improvements, ok: diff.ok },
            manifest,
          });
          if (!diff.ok) regressed.push(`${scorecard.scenarioId}[${scorecard.variant}]: ${diff.deltas.filter((d) => d.kind === 'regression' || (d.kind === 'removed' && d.before === 'pass')).map((d) => d.check).join(', ')}`);
        }
      }

      await fs.writeFile(
        OUT_PATH,
        JSON.stringify({ generatedAt: new Date().toISOString(), mode: UPDATE_BASELINE ? 'promote' : 'diff', rows }, null, 2) + '\n',
        'utf8',
      );

      // The gate: a promotion run has nothing to fail on (it just wrote the new baseline); a diff run
      // MUST fail loud when anything regressed vs the committed last-known-good (no silent red, TEST-11).
      if (!UPDATE_BASELINE) {
        expect(regressed, `eval scorecard regression(s) vs committed baseline:\n${regressed.join('\n')}`).toEqual([]);
      }
    },
    TIMEOUT_MS,
  );
});
