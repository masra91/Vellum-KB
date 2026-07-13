// The scheduled-researcher tick (SPEC-0028 RESEARCH-2; KB-PM seam ruling Option (a)). Researchers
// reuse the JOBS scheduler's *machinery shape* — coarse named-preset cadence (PRESET_INTERVAL_MS),
// restart-safe "due" derived from the last run, single-flight per id — but the EXECUTION BODY is
// `runResearcher` (a standing research pass → cited secondary source via the ingest path), NOT the
// JobBehavior→JobFinding→write-sink flow. This keeps JOBS-10's "behaviors take no direct writes"
// invariant intact (a JobBehavior and a Researcher are distinct behavior shapes that share only
// scheduling). The scheduler owns no canonical writes; runResearcher's ingest does.
//
// "Due" comes from the researcher's last `researcher` audit event (its last pass) — survives
// restarts with no separate timer state, mirroring isJobDue. A standing researcher does NOT go
// through the dispatcher's dedup ledger (that coalesces *inline requests*); its cadence is what
// bounds how often it researches its standing topic ("poll this daily").
import path from 'node:path';
import { PRESET_INTERVAL_MS } from './jobs';
import { readResearcherRegistry } from './researcherRegistry';
import { readEvents } from './activityIndex';
import { runResearcher } from './researchRun';
import { runInlineResearchSweep, selectResearchFn, type ResearchDepsOptions } from './researchInline';
import { dedupKeyFor, researchWhatFor, type ResearcherConfig, type ResearchRequest } from './researchers';
import { ulid } from './ulid';
import { Mutex } from './stageLock';
import { noopDevLog, type DevLog } from './devlog';

/** The pure due-check given an already-known last-run ms (`null` = never run) — no I/O. Shared by the
 *  audit-derived slow path below and the scheduler's in-process fast path (#506). */
function isDueGivenLast(r: ResearcherConfig, lastMs: number | null, now: number): boolean {
  if (!r.enabled || r.schedule === 'off') return false;
  if (lastMs === null) return true; // never run → due
  const interval = PRESET_INTERVAL_MS[r.schedule];
  return !Number.isFinite(lastMs) || now - lastMs >= interval;
}

/** Is a researcher due for a standing pass? enabled + scheduled + (never-run OR last + interval ≤ now).
 *  #506: walks the WHOLE `audit.jsonl` per researcher per tick (`readEvents` → `readAllAuditEvents`) —
 *  correct but expensive as audit history grows. `ResearcherScheduler.tick` prefers its in-process
 *  `lastRunAt` memo once this process has run a researcher at least once; this audit-derived read is
 *  the restart-safe fallback (first check after boot, or a memo miss). */
export async function isResearcherDue(root: string, r: ResearcherConfig, now: number): Promise<boolean> {
  if (!r.enabled || r.schedule === 'off') return false;
  const events = await readEvents(root, { actors: ['researcher'], subjectId: r.id }); // newest-first
  const last = events[0];
  return isDueGivenLast(r, last ? Date.parse(last.ts) : null, now);
}

/** The synthetic standing request a scheduled researcher runs against (its topic/label/prompt). */
export function standingRequest(r: ResearcherConfig, id: string, ts: string): ResearchRequest {
  const what = researchWhatFor(r); // WS1 #6 class: real name, never the generic template word
  // A standing pass is a chain ROOT (depth 1) — its cadence, not a depth limit, is what bounds it.
  return { id, ts, by: { stage: 'scheduler' }, what, why: 'scheduled standing research', context: '', dedupKey: dedupKeyFor({ what, by: {} }), depth: 1 };
}

export class ResearcherScheduler {
  private readonly root: string;
  private readonly opts: ResearchDepsOptions;
  private readonly log: DevLog;
  private readonly inFlight = new Set<string>(); // single-flight per researcher id (across ticks)
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private sweeping = false; // single-flight for the inline sweep (across ticks)
  // #506: in-process due-check memo — once THIS process has run a researcher, its due-check is a pure
  // in-memory comparison instead of a fresh `readEvents` walk of the whole audit log every 60s tick.
  // Not persisted (restart-safe by design: a cold process falls back to the audit-derived `isResearcherDue`).
  private readonly lastRunAt = new Map<string, number>();

  private readonly lock: Mutex;

  /** `root` is the staging worktree (where the registry + audit live + researchers write). `opts`
   *  carries the injected cognition (self-nomination runner, Web SDK options, or a `researchFn`
   *  override for tests) — shared by BOTH the inline sweep (via the dispatcher) and the standing
   *  passes (via `runResearcher`), so the same fake drives both in tests. #517: `lock` is the shared
   *  canonical-writer lock — threaded into every dispatched pass's ingest commit (never the
   *  research()/egress call itself) so it's serialized against stage advances/other writers instead of
   *  racing them on the same git index. */
  constructor(root: string, opts: ResearchDepsOptions = {}, lock: Mutex = new Mutex(), log: DevLog = noopDevLog) {
    this.root = path.resolve(root);
    this.opts = opts;
    this.lock = lock;
    this.log = log;
  }

  start(tickMs = 60_000): void {
    void this.tick();
    if (this.tickTimer == null) {
      this.tickTimer = setInterval(() => void this.tick(), tickMs);
      this.tickTimer.unref?.();
    }
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Is a researcher pass (or a tick) in flight? (SPEC-0045 QUIESCE-3 — "safe to shut down".) */
  busy(): boolean {
    return this.ticking || this.inFlight.size > 0;
  }

  /** One tick: first an inline sweep (route pending `research-request` signals through the
   *  dispatcher, RESEARCH-3), then a standing pass for every enabled+scheduled+due researcher,
   *  serially, each single-flight. Returns the ids of the standing passes it fired. Ticks never
   *  overlap (`ticking` guard). */
  async tick(now: number = Date.now()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: string[] = [];
    try {
      await this.inlineSweep();
      const researchers = await readResearcherRegistry(this.root);
      for (const r of researchers) {
        if (this.inFlight.has(r.id)) continue; // single-flight (JOBS-6 analogue)
        // #506: prefer the in-process memo (no I/O) once this process has run `r` before; else fall
        // back to the restart-safe audit-derived check.
        const memoLast = this.lastRunAt.get(r.id);
        const due = memoLast !== undefined ? isDueGivenLast(r, memoLast, now) : await isResearcherDue(this.root, r, now);
        if (!due) continue;
        fired.push(r.id);
        await this.runStanding(r, now);
      }
    } finally {
      this.ticking = false;
    }
    return fired;
  }

  /** Route any pending `research-request` signals through the dispatcher (RESEARCH-3), reusing the
   *  scheduler's injected cognition. Single-flight (`sweeping`) so a slow sweep can't overlap itself
   *  across ticks. Cheap + idempotent — the dispatcher's persistent dedup ledger coalesces a request
   *  already fanned out on an earlier sweep. Never throws into the tick: a failed sweep is logged so
   *  the standing passes still run. Public so the pipeline can poke it right after a stage drain. */
  async inlineSweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await runInlineResearchSweep(this.root, { ...this.opts, lock: this.lock });
    } catch (err) {
      this.log.child({ scope: 'researcher-scheduler' }).error('inline-sweep-failed', { err });
    } finally {
      this.sweeping = false;
    }
  }

  /** Run one standing pass (single-flight-guarded). Never throws into the tick loop — a failed pass
   *  is logged + skipped so one bad researcher can't stall the others. */
  private async runStanding(r: ResearcherConfig, now: number): Promise<void> {
    if (this.inFlight.has(r.id)) return;
    this.inFlight.add(r.id);
    try {
      const ts = new Date(now).toISOString();
      // Stamp the pass (provenance + the audit event the due-check reads) with the tick's logical
      // time, so cadence is computed against the scheduler clock, not wall-clock.
      // Template-aware cognition (Web/Code), same selection the inline dispatcher uses.
      await runResearcher(this.root, r, standingRequest(r, ulid(now), ts), { research: selectResearchFn(this.root, r, this.opts), now: () => ts, lock: this.lock });
      this.lastRunAt.set(r.id, now); // #506: record completion for the next tick's in-process due-check
    } catch (err) {
      this.log.child({ scope: 'researcher-scheduler' }).error('standing-pass-failed', { itemId: r.id, err });
    } finally {
      this.inFlight.delete(r.id);
    }
  }
}
