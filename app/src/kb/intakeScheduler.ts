// The intake connector tick (SPEC-0041 INTAKE-1/11) — proactive feeds reuse the JOBS scheduler's
// *machinery shape* (coarse named-preset cadence via PRESET_INTERVAL_MS, restart-safe "due" derived
// from the last run, single-flight per id) but the EXECUTION BODY is `runIntakeConnector` (a pass →
// PRIMARY source via the ingest path), NOT the JobBehavior→write-sink flow. This is the exact seam
// researcherScheduler uses (a JobBehavior, a Researcher, and an intake Connector are distinct behavior
// shapes that share only scheduling) — it keeps JOBS-10 intact while letting INTAKE write `sources/`.
//
// "Due" comes from the connector's last `intake` audit event (its last pass) — survives restarts with
// no separate timer state, mirroring isJobDue / isResearcherDue.
import path from 'node:path';
import { PRESET_INTERVAL_MS } from './jobs';
import { readEvents } from './activityIndex';
import { readIntakeRegistry } from './intakeRegistry';
import { runIntakeConnector } from './intakeRun';
import { makeRssIntakeFn, type RssIntakeOptions } from './rssConnector';
import { makeM365MailIntakeFn, type M365MailIntakeOptions } from './m365MailConnector';
import type { IntakeConnectorConfig, IntakeFetchFn } from './intakeConnectors';
import { Mutex } from './stageLock';
import { noopDevLog, type DevLog } from './devlog';

/** Is a connector due for a pull? enabled + scheduled + (never-run OR last + interval ≤ now). */
export async function isIntakeDue(root: string, c: IntakeConnectorConfig, now: number): Promise<boolean> {
  if (!c.enabled || c.schedule === 'off') return false;
  const interval = PRESET_INTERVAL_MS[c.schedule];
  const events = await readEvents(root, { actors: ['intake'], subjectId: c.id }); // newest-first
  const last = events[0];
  if (!last) return true; // never run → due
  const lastMs = Date.parse(last.ts);
  return !Number.isFinite(lastMs) || now - lastMs >= interval;
}

/** Injected cognition/IO for the scheduler — RSS options (production) and/or a fetch override (tests). */
export interface IntakeDepsOptions {
  rss?: RssIntakeOptions;
  /** M365-mail connector options (Slice 2) — cliPath + the env-gated Graph MCP factory; tests inject `session`. */
  m365Mail?: M365MailIntakeOptions;
  /** Force one fetch fn for every connector (tests) — bypasses the per-type selection. */
  fetchOverride?: IntakeFetchFn;
}

/** Select the fetch behavior for a connector by `type`. Slice 1 = RSS; Slice 2 = M365-mail (its live
 *  Graph-MCP wiring is env-gated — `makeM365MailIntakeFn` THROWS when the tenant/MCP isn't configured,
 *  surfacing a distinct `intake-failed`, never a silent no-op). An unknown type also throws. */
export function selectIntakeFn(c: IntakeConnectorConfig, opts: IntakeDepsOptions = {}): IntakeFetchFn {
  if (opts.fetchOverride) return opts.fetchOverride;
  switch (c.type) {
    case 'rss':
      return makeRssIntakeFn(opts.rss);
    case 'm365-mail':
      return makeM365MailIntakeFn(opts.m365Mail);
    default:
      return async () => {
        throw new Error(`unknown intake connector type: ${(c as IntakeConnectorConfig).type}`);
      };
  }
}

export class IntakeScheduler {
  private readonly root: string;
  private readonly opts: IntakeDepsOptions;
  private readonly log: DevLog;
  private readonly inFlight = new Set<string>(); // single-flight per connector id (across ticks)
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private readonly lock: Mutex;

  /** `root` is the staging worktree (where the registry + audit live + intake writes sources). #517:
   *  `lock` is the shared canonical-writer lock — threaded into every pull's ingest commit so it's
   *  serialized against stage advances/other writers instead of racing them on the same git index. */
  constructor(root: string, opts: IntakeDepsOptions = {}, lock: Mutex = new Mutex(), log: DevLog = noopDevLog) {
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

  /** Is a connector pull (or a tick) in flight? (SPEC-0045 QUIESCE-3 — "safe to shut down".) */
  busy(): boolean {
    return this.ticking || this.inFlight.size > 0;
  }

  /** One tick: a pull for every enabled+scheduled+due connector, serially, each single-flight.
   *  Returns the ids it fired. Ticks never overlap (`ticking` guard). */
  async tick(now: number = Date.now()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const fired: string[] = [];
    try {
      const connectors = await readIntakeRegistry(this.root);
      for (const c of connectors) {
        if (this.inFlight.has(c.id)) continue; // single-flight (JOBS-6 analogue)
        if (!(await isIntakeDue(this.root, c, now))) continue;
        fired.push(c.id);
        await this.runStanding(c, now);
      }
    } finally {
      this.ticking = false;
    }
    return fired;
  }

  /** Run one pull (single-flight-guarded). Never throws into the tick loop — a failed connector is
   *  logged + skipped (its own pass already audits `intake-failed`) so one bad feed can't stall others. */
  private async runStanding(c: IntakeConnectorConfig, now: number): Promise<void> {
    if (this.inFlight.has(c.id)) return;
    this.inFlight.add(c.id);
    try {
      const ts = new Date(now).toISOString(); // stamp the pass with the tick's logical time
      await runIntakeConnector(this.root, c, { fetch: selectIntakeFn(c, this.opts), now: () => ts, lock: this.lock });
    } catch (err) {
      this.log.child({ scope: 'intake-scheduler' }).error('intake-pass-failed', { itemId: c.id, err });
    } finally {
      this.inFlight.delete(c.id);
    }
  }
}
