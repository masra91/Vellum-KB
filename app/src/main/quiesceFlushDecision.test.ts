// BUG-11 (#518): `quiesceStatusForActive` used to force an IMMEDIATE `promoter.flushNow()` on every
// poll (settingsView polls every ~1s while quiescing) whenever quiescing + idle + a promotion still
// pending — with no bound. `flushNow()` never throws (coalescingPromoter swallows `promote()` errors
// internally), so a persistently-failing promote() got hammered forever, bypassing the promoter's own
// debounce/cap backoff, and the UI was stuck reading "Publishing the last changes…" with the real
// cause never surfaced. `quiesceFlushDecision` is the pure decision this dispatches to — proving it
// bounds retries and reports an honest cause covers the fix without spinning up a whole pipeline.
import { describe, it, expect } from 'vitest';
import { quiesceFlushDecision, MAX_QUIESCE_FLUSH_ATTEMPTS } from './pipeline';

describe('quiesceFlushDecision (BUG-11 #518)', () => {
  it('not quiescing: always "Running normally.", never flushes', () => {
    const d = quiesceFlushDecision(false, 3, true, { attempts: 0, error: null });
    expect(d).toMatchObject({ shouldFlush: false, safe: false, detail: 'Running normally.' });
  });

  it('quiescing, idle, no pending promotion: safe, no flush needed', () => {
    const d = quiesceFlushDecision(true, 0, false, { attempts: 0, error: null });
    expect(d).toMatchObject({ shouldFlush: false, safe: true, detail: 'Safe to shut down — all work finished.' });
  });

  it('quiescing, work still remaining: not safe, no flush (nothing to publish yet)', () => {
    const d = quiesceFlushDecision(true, 2, false, { attempts: 0, error: null });
    expect(d).toMatchObject({ shouldFlush: false, safe: false, detail: 'Finishing up — 2 items remaining…' });
  });

  it('quiescing, idle, promotion pending, under the attempt budget: forces a flush', () => {
    const d = quiesceFlushDecision(true, 0, true, { attempts: 0, error: null });
    expect(d).toMatchObject({ shouldFlush: true, safe: false, detail: 'Publishing the last changes to your library…' });
  });

  // The core of the bug: this is what a naive "every poll while pending" check would keep doing
  // forever. Proves the budget actually caps it — the SAME inputs (attempts at the ceiling) must stop
  // requesting a flush, not just "eventually".
  it(`stops forcing a flush once attempts reach MAX_QUIESCE_FLUSH_ATTEMPTS (${MAX_QUIESCE_FLUSH_ATTEMPTS})`, () => {
    for (let attempts = 0; attempts < MAX_QUIESCE_FLUSH_ATTEMPTS; attempts++) {
      const d = quiesceFlushDecision(true, 0, true, { attempts, error: 'boom' });
      expect(d.shouldFlush).toBe(true); // still within budget
    }
    const exhausted = quiesceFlushDecision(true, 0, true, { attempts: MAX_QUIESCE_FLUSH_ATTEMPTS, error: 'boom' });
    expect(exhausted.shouldFlush).toBe(false); // budget spent — stop hammering promote()
    // further attempts (well past the ceiling) stay bounded too — never resumes hammering on its own.
    const wayPast = quiesceFlushDecision(true, 0, true, { attempts: MAX_QUIESCE_FLUSH_ATTEMPTS + 50, error: 'boom' });
    expect(wayPast.shouldFlush).toBe(false);
  });

  it('once exhausted, reports the real cause instead of an eternal "Publishing…"', () => {
    const d = quiesceFlushDecision(true, 0, true, { attempts: MAX_QUIESCE_FLUSH_ATTEMPTS, error: 'git push rejected: non-fast-forward' });
    expect(d.safe).toBe(false); // never falsely "safe" while `main` still owes changes
    expect(d.detail).toBe("Couldn't publish — git push rejected: non-fast-forward");
  });

  it('exhausted with no captured error message still gives an honest (non-"Publishing…") fallback', () => {
    const d = quiesceFlushDecision(true, 0, true, { attempts: MAX_QUIESCE_FLUSH_ATTEMPTS, error: null });
    expect(d.detail).not.toMatch(/Publishing the last changes/);
    expect(d.detail).toMatch(/^Couldn't publish/);
  });

  it('a fresh (reset) attempt budget recovers forcing behavior — a later quiesce is not poisoned by a past failure', () => {
    const exhausted = quiesceFlushDecision(true, 0, true, { attempts: MAX_QUIESCE_FLUSH_ATTEMPTS, error: 'boom' });
    expect(exhausted.shouldFlush).toBe(false);
    // pipeline.ts resets { attempts: 0, error: null } on promote() success and on entering a fresh
    // quiesceActive() — simulate that reset here and confirm flushing resumes.
    const resumed = quiesceFlushDecision(true, 0, true, { attempts: 0, error: null });
    expect(resumed.shouldFlush).toBe(true);
  });

  it('never reports "safe" while a promotion is genuinely still pending, exhausted or not', () => {
    expect(quiesceFlushDecision(true, 0, true, { attempts: 0, error: null }).safe).toBe(false);
    expect(quiesceFlushDecision(true, 0, true, { attempts: MAX_QUIESCE_FLUSH_ATTEMPTS, error: 'boom' }).safe).toBe(false);
  });
});
