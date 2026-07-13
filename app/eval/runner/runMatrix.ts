// SPEC-0042 EVAL Slice-2 — the variant matrix runner (EVAL-7/8/9). Runs a scenario across its config
// variants (cross-product), scores each (deterministic + agent-judge), diffs each against its stored
// baseline, and emits a reproducibility manifest per variant. Variants run SEQUENTIALLY (the `model` axis
// is the process-global KB_COPILOT_MODEL env — applyVariant sets+restores it around each run, no bleed).
import { expandMatrix, applyVariant } from './variants';
import { runScenario, type RunScenarioOptions } from './runScenario';
import { loadBaseline, saveBaseline, diffScorecards, type BaselineDiff } from './baseline';
import { buildManifest, type ReproManifest } from './manifest';
import type { Scenario } from './scenario';
import type { Scorecard } from './scorecard';

export interface VariantRun {
  scorecard: Scorecard;
  /** Diff vs the stored baseline (regression/improvement deltas), or null baseline = all 'new'. */
  diff: BaselineDiff;
  manifest: ReproManifest;
}

export interface RunMatrixOptions extends RunScenarioOptions {
  /** Persist each variant's scorecard as the new baseline (the `--update-baseline` path). Default false —
   *  never silently overwrite a last-known-good. */
  updateBaseline?: boolean;
  /** Which baseline store to diff/save against — the ad-hoc gitignored `BASELINE_DIR` (default, local
   *  tweak-and-compare) or `COMMITTED_BASELINE_DIR` (the CI nightly scorecard job, issue #525). */
  baselineDir?: string;
  /** Injected clock for the manifest timestamp (tests); defaults to the wall clock. */
  now?: () => string;
}

/** Run the full scenario × variant matrix → per-variant scorecard + baseline diff + manifest. */
export async function runMatrix(scenario: Scenario, opts: RunMatrixOptions = {}): Promise<VariantRun[]> {
  const now = opts.now ?? (() => new Date().toISOString());
  const out: VariantRun[] = [];
  for (const variant of expandMatrix(scenario.variants)) {
    const resolved = applyVariant(variant); // sets KB_COPILOT_MODEL etc. for this variant
    try {
      const scorecard = await runScenario(scenario, {
        ...opts,
        variant: resolved.label,
        ...(resolved.recallMaxToolCalls ? { recallMaxToolCalls: resolved.recallMaxToolCalls } : {}),
      });
      const manifest = buildManifest(scenario.id, resolved.label, now());
      const baseline = await loadBaseline(scenario.id, resolved.label, opts.baselineDir);
      const diff = diffScorecards(scorecard, baseline);
      if (opts.updateBaseline) await saveBaseline(scorecard, opts.baselineDir);
      out.push({ scorecard, diff, manifest });
    } finally {
      resolved.restore(); // restore the env before the next variant (no model bleed)
    }
  }
  return out;
}
