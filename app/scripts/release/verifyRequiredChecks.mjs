// SPEC-0055 slice 1 (#529) — RELEASE-3: "the build is produced from the exact tagged SHA and only
// when that SHA's required CI checks are green." The workflow fetches the tagged commit's check-runs
// via `gh api` (already-authenticated, no token plumbing needed here) and pipes the JSON to this pure
// evaluator — a release can never build+publish from a commit whose required checks are missing,
// pending, or red. Kept as a pure filter over parsed JSON (not a live network caller) so the matching
// rule itself is unit-tested, not just exercised end-to-end in CI.
import { readFileSync } from 'node:fs';

// The three checks pinned as REQUIRED in the `main` branch ruleset (issue #525, ENG-1) — see
// .github/workflows/ci.yml's header comment. Matrix-suffixed names mirror what GitHub actually
// records for a single-entry `strategy.matrix` job (ci.yml deliberately keeps these single-entry so
// the check-run name stays stable — see the `quick`/`package` job comments).
export const REQUIRED_CHECK_NAMES = ['typecheck · lint · unit (ubuntu-latest)', 'secret scan', 'package build-check (ubuntu-latest)'];

/**
 * Evaluate a GitHub `GET /commits/{sha}/check-runs` response against `requiredNames`. Multiple runs
 * can exist for one name (a re-run) — the LATEST by `completed_at` decides. A name with zero runs is
 * "missing", never silently treated as passing.
 */
export function evaluateRequiredChecks(checkRunsResponse, requiredNames) {
  const runs = checkRunsResponse?.check_runs ?? [];
  const details = requiredNames.map((name) => {
    const matches = runs.filter((r) => r.name === name);
    if (matches.length === 0) return { name, conclusion: 'missing' };
    const latest = matches.reduce((a, b) => ((b.completed_at ?? '') > (a.completed_at ?? '') ? b : a));
    return { name, conclusion: latest.conclusion ?? 'pending' };
  });
  const missing = details.filter((d) => d.conclusion !== 'success').map((d) => `${d.name} (${d.conclusion})`);
  return { ok: missing.length === 0, missing, details };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node verifyRequiredChecks.mjs <check-runs.json>');
    process.exit(2);
  }
  const response = JSON.parse(readFileSync(file, 'utf8'));
  const { ok, missing, details } = evaluateRequiredChecks(response, REQUIRED_CHECK_NAMES);
  for (const d of details) console.log(`${d.conclusion === 'success' ? 'OK' : 'FAIL'}: ${d.name} — ${d.conclusion}`);
  if (!ok) {
    console.error(`::error::Required check(s) not green on this SHA — refusing to release from unverified code: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('OK: all required checks are green.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
