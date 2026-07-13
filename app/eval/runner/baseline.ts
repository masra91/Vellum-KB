// SPEC-0042 EVAL Slice-2 — baseline diff (EVAL-8). Compares a fresh scorecard against a stored
// last-known-good baseline and surfaces regression/improvement deltas. PURE + fork-independent (operates
// on Scorecard objects regardless of how the deterministic/judge checks were produced) — so it's unit-
// testable now and stable across the Slice-2 forks. Storage (gitignored JSON) + --update-baseline land
// in the deep build; this is the diff core.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Scorecard } from './scorecard';
import type { CheckResult } from './validators';

/** Where ad-hoc/local last-known-good baselines live — GITIGNORED, never promoted (EVAL-8). The
 *  developer "tweak-and-compare" loop (`KB_EVAL=1 npm run eval -- --update-baseline`, per-machine). */
export const BASELINE_DIR = path.resolve(process.cwd(), 'eval/baselines');

/** Where the COMMITTED (version-controlled) last-known-good scorecard lives (ENG-3, issue #525) — the
 *  weekly CI eval-scorecard job diffs against THIS, not the gitignored `BASELINE_DIR`, so a regression
 *  is a real repo-visible signal rather than something only a local machine ever sees. Populated only via
 *  the nightly workflow's `update_eval_baseline` dispatch (mirrors the e2e visual-snapshot `update_snapshots`
 *  dispatch pattern) — never written silently by a routine run. */
export const COMMITTED_BASELINE_DIR = path.resolve(process.cwd(), 'eval/baselines-committed');

/** A filesystem-safe baseline filename for a scenario × variant. */
function baselinePath(dir: string, scenarioId: string, variant: string): string {
  const slug = (s: string): string => s.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'x';
  return path.join(dir, `${slug(scenarioId)}__${slug(variant)}.json`);
}

/** Load the stored baseline scorecard for a scenario × variant, or null if none exists yet.
 *  `dir` defaults to the ad-hoc `BASELINE_DIR`; pass `COMMITTED_BASELINE_DIR` for the CI scorecard job. */
export async function loadBaseline(scenarioId: string, variant: string, dir: string = BASELINE_DIR): Promise<Scorecard | null> {
  try {
    return JSON.parse(await fs.readFile(baselinePath(dir, scenarioId, variant), 'utf8')) as Scorecard;
  } catch {
    return null; // no baseline yet (first run) → the diff marks everything 'new'
  }
}

/** Persist a scorecard as the new baseline (EVAL-8) — only via an explicit `--update-baseline` caller,
 *  never silently (so a worse run can't overwrite the last-known-good). `dir` defaults to the ad-hoc
 *  `BASELINE_DIR`; pass `COMMITTED_BASELINE_DIR` for the CI baseline-promotion dispatch. */
export async function saveBaseline(scorecard: Scorecard, dir: string = BASELINE_DIR): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(baselinePath(dir, scorecard.scenarioId, scorecard.variant), JSON.stringify(scorecard, null, 2) + '\n', 'utf8');
}

export type CheckState = 'pass' | 'fail' | 'absent';
export type DeltaKind = 'regression' | 'improvement' | 'unchanged' | 'new' | 'removed';

/** One check's before→after across a baseline diff. */
export interface ScorecardDelta {
  check: string;
  before: CheckState;
  after: CheckState;
  kind: DeltaKind;
}

export interface BaselineDiff {
  scenarioId: string;
  variant: string;
  deltas: ScorecardDelta[];
  regressions: number;
  improvements: number;
  /** True iff no check regressed (pass→fail or present→absent of a previously-passing check). */
  ok: boolean;
}

const stateOf = (c: CheckResult | undefined): CheckState => (c === undefined ? 'absent' : c.pass ? 'pass' : 'fail');

function classify(before: CheckState, after: CheckState): DeltaKind {
  if (before === after) return 'unchanged';
  if (before === 'absent') return 'new';
  if (after === 'absent') return 'removed';
  return after === 'pass' ? 'improvement' : 'regression';
}

/**
 * Diff a current scorecard against its baseline (null baseline ⇒ every check is 'new'). Checks are keyed
 * by `index:check` (both scorecards come from the same ordered scenario), so a check that flips
 * pass→fail at its position is a REGRESSION. `ok` is false iff anything regressed (the merge/ship signal);
 * a `removed` previously-passing check also counts as a regression (lost coverage).
 */
export function diffScorecards(current: Scorecard, baseline: Scorecard | null): BaselineDiff {
  const key = (i: number, c: CheckResult): string => `${i}:${c.check}`;
  const baseByKey = new Map<string, CheckResult>();
  if (baseline) baseline.checks.forEach((c, i) => baseByKey.set(key(i, c), c));
  const seen = new Set<string>();
  const deltas: ScorecardDelta[] = [];

  current.checks.forEach((c, i) => {
    const k = key(i, c);
    seen.add(k);
    const before = stateOf(baseline ? baseByKey.get(k) : undefined);
    const after = stateOf(c);
    deltas.push({ check: c.check, before, after, kind: classify(before, after) });
  });
  // Checks present in the baseline but gone now (removed coverage).
  if (baseline) {
    baseline.checks.forEach((c, i) => {
      const k = key(i, c);
      if (seen.has(k)) return;
      deltas.push({ check: c.check, before: stateOf(c), after: 'absent', kind: classify(stateOf(c), 'absent') });
    });
  }

  const regressions = deltas.filter((d) => d.kind === 'regression' || (d.kind === 'removed' && d.before === 'pass')).length;
  const improvements = deltas.filter((d) => d.kind === 'improvement').length;
  return { scenarioId: current.scenarioId, variant: current.variant, deltas, regressions, improvements, ok: regressions === 0 };
}
