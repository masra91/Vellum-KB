import { describe, it, expect } from 'vitest';
import { evaluateRequiredChecks, REQUIRED_CHECK_NAMES } from './verifyRequiredChecks.mjs';

const successRun = (name: string, completedAt = '2026-07-13T00:00:00Z') => ({ name, conclusion: 'success', completed_at: completedAt });

describe('evaluateRequiredChecks (#529 RELEASE-3 — never release from a red/unverified SHA)', () => {
  it('passes when every required check has a successful run', () => {
    const response = { check_runs: REQUIRED_CHECK_NAMES.map((n) => successRun(n)) };
    const result = evaluateRequiredChecks(response, REQUIRED_CHECK_NAMES);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('fails when a required check never ran at all (missing, not silently passing)', () => {
    const response = { check_runs: [successRun('secret scan')] }; // the other two never ran on this SHA
    const result = evaluateRequiredChecks(response, REQUIRED_CHECK_NAMES);
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toContain('missing');
    expect(result.missing).toHaveLength(2);
  });

  it('fails when a required check ran but failed', () => {
    const response = {
      check_runs: [
        successRun('typecheck · lint · unit (ubuntu-latest)'),
        { name: 'secret scan', conclusion: 'failure', completed_at: '2026-07-13T00:00:00Z' },
        successRun('package build-check (ubuntu-latest)'),
      ],
    };
    const result = evaluateRequiredChecks(response, REQUIRED_CHECK_NAMES);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['secret scan (failure)']);
  });

  it('fails when a required check is still pending/in-progress (not yet success)', () => {
    const response = {
      check_runs: [
        { name: 'typecheck · lint · unit (ubuntu-latest)', conclusion: null, completed_at: null },
        successRun('secret scan'),
        successRun('package build-check (ubuntu-latest)'),
      ],
    };
    const result = evaluateRequiredChecks(response, REQUIRED_CHECK_NAMES);
    expect(result.ok).toBe(false);
    expect(result.missing[0]).toContain('pending');
  });

  it('uses the LATEST run by completed_at when a check has been re-run (a stale failure must not block a since-fixed re-run)', () => {
    const response = {
      check_runs: [
        { name: 'secret scan', conclusion: 'failure', completed_at: '2026-07-13T00:00:00Z' }, // the original, failed
        { name: 'secret scan', conclusion: 'success', completed_at: '2026-07-13T00:05:00Z' }, // the re-run, passed
        successRun('typecheck · lint · unit (ubuntu-latest)'),
        successRun('package build-check (ubuntu-latest)'),
      ],
    };
    const result = evaluateRequiredChecks(response, REQUIRED_CHECK_NAMES);
    expect(result.ok).toBe(true);
  });

  it('handles an empty/absent check_runs array as everything missing', () => {
    const result = evaluateRequiredChecks({ check_runs: [] }, REQUIRED_CHECK_NAMES);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(REQUIRED_CHECK_NAMES.length);
  });

  it('tolerates a response with no check_runs key at all (defensive — a malformed API response must not throw)', () => {
    expect(() => evaluateRequiredChecks({}, REQUIRED_CHECK_NAMES)).not.toThrow();
    expect(evaluateRequiredChecks({}, REQUIRED_CHECK_NAMES).ok).toBe(false);
  });
});
