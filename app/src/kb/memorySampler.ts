// Resource/memory telemetry (SPEC-0030 OBS-20) + leak watchdog (OBS-21). A long-run memory climb is
// the prime suspect for the 2026-06-07 V8-worker trap, and today it is invisible. This samples
// `process.memoryUsage()` + (Electron) `app.getAppMetrics()` on a COARSE interval and writes one
// compact `mem.sample` dev-log line per tick, so memory over hours reads as a trend, not a mystery.
//
// CARE (KB-Lead flagged): sampler overhead. The defaults are deliberately cheap — one ~60s tick, a
// single `memoryUsage()` + `getAppMetrics()` call (both O(processes), microseconds), one JSONL line,
// a bounded in-memory ring (no growth of our own). The expensive bit — `v8.writeHeapSnapshot` (OBS-21,
// hundreds of MB, multi-second) — is OFF by default and, when enabled, fires at most ONCE per leak
// episode above a high threshold. Local-only: numbers only, no egress (PRIN-19).
//
// Everything is injectable (samplers, clock, timer, snapshot writer) so it unit-tests with no Electron
// and no real timer.

export interface NodeMemUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

/** Compact per-process metric distilled from Electron's `app.getAppMetrics()`. */
export interface ProcMetric {
  pid?: number;
  type?: string;
  cpuPercent?: number;
  memoryKb?: number;
}

/** Electron's `ProcessMetric` shape (the bits we read) — kept loose so we don't depend on electron here. */
export interface ElectronProcessMetric {
  pid?: number;
  type?: string;
  cpu?: { percentCPUUsage?: number };
  memory?: { workingSetSize?: number };
}

export interface MemorySample {
  ts: string;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  /** Per-process CPU/mem (Electron only); omitted when `getAppMetrics` is unavailable. */
  processes?: ProcMetric[];
}

const MB = 1024 * 1024;

/** Build one sample (pure) from injected readers. */
export function sampleMemory(
  memoryUsage: () => NodeMemUsage,
  nowIso: string,
  getAppMetrics?: () => ElectronProcessMetric[] | undefined,
): MemorySample {
  const m = memoryUsage();
  const sample: MemorySample = {
    ts: nowIso,
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
  const metrics = getAppMetrics?.();
  if (metrics && metrics.length > 0) {
    sample.processes = metrics.map((p) => ({
      ...(typeof p.pid === 'number' ? { pid: p.pid } : {}),
      ...(typeof p.type === 'string' ? { type: p.type } : {}),
      ...(typeof p.cpu?.percentCPUUsage === 'number' ? { cpuPercent: Math.round(p.cpu.percentCPUUsage * 10) / 10 } : {}),
      ...(typeof p.memory?.workingSetSize === 'number' ? { memoryKb: p.memory.workingSetSize } : {}),
    }));
  }
  return sample;
}

export interface LeakOptions {
  /** Minimum samples in the window before a verdict (default 6 — ~6 min at 60s). */
  minSamples?: number;
  /** Minimum total RSS growth across the window to count as leaking, in MB (default 50). Guards noise. */
  minGrowthMb?: number;
  /** Minimum sustained least-squares slope to count as leaking, MB/min (default `minGrowthMb / 30` —
   *  the pace `minGrowthMb` over the sampler's nominal 30-sample default window works out to). A brief
   *  spike that then plateaus has a shallow regression slope even if its raw first↔last delta is large. */
  minSlopeMbPerMin?: number;
}

export interface MemTrend {
  /** Samples considered. */
  samples: number;
  /** Minutes spanned (first→last ts). */
  windowMin: number;
  /** RSS delta first→last, MB (can be negative). */
  rssDeltaMb: number;
  /** Heap-used delta first→last, MB. */
  heapDeltaMb: number;
  /** RSS growth rate, MB/min. */
  rssSlopeMbPerMin: number;
  /** OBS-21 verdict: sustained monotonic RSS growth (no plateau) past the magnitude guard. */
  leaking: boolean;
}

/** Least-squares slope of `ys` against `xs` (same length), robust to individual noisy points — a
 *  handful of GC-timing dips/spikes don't swing it the way a bare first↔last delta or a step-by-step
 *  check would. Returns 0 for a degenerate window (all `xs` identical). */
function leastSquaresSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const xBar = xs.reduce((a, b) => a + b, 0) / n;
  const yBar = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xBar) * (ys[i] - yBar);
    den += (xs[i] - xBar) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Compute the trend + leak verdict over a window of samples (pure). Null if too few samples. */
export function detectLeak(samples: MemorySample[], opts: LeakOptions = {}): MemTrend | null {
  const minSamples = opts.minSamples ?? 6;
  const minGrowthMb = opts.minGrowthMb ?? 50;
  if (samples.length < minSamples) return null;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const rssDeltaMb = (last.rss - first.rss) / MB;
  const heapDeltaMb = (last.heapUsed - first.heapUsed) / MB;
  const spanMs = Math.max(0, Date.parse(last.ts) - Date.parse(first.ts));
  const windowMin = spanMs / 60_000;

  // #508 item 4: OBS-21's original verdict required STRICTLY increasing RSS at every single step — one
  // GC-timing dip/plateau anywhere in the window flipped a real, sustained leak to "not leaking" and
  // made the sampler blind to it. A least-squares slope over the WHOLE window survives that noise: a
  // genuine leak keeps a positive slope even with a dip or two; a one-off spike that then plateaus
  // regresses toward a shallow/flat slope instead of reading as sustained growth.
  const t0 = Date.parse(first.ts);
  const xsMin = samples.map((s) => (Date.parse(s.ts) - t0) / 60_000);
  const rssValuesMb = samples.map((s) => s.rss / MB);
  const rssSlopeMbPerMin = leastSquaresSlope(xsMin, rssValuesMb);
  const minSlopeMbPerMin = opts.minSlopeMbPerMin ?? minGrowthMb / 30;
  const leaking = rssDeltaMb >= minGrowthMb && rssSlopeMbPerMin >= minSlopeMbPerMin;

  return {
    samples: samples.length,
    windowMin: Math.round(windowMin * 10) / 10,
    rssDeltaMb: Math.round(rssDeltaMb * 10) / 10,
    heapDeltaMb: Math.round(heapDeltaMb * 10) / 10,
    rssSlopeMbPerMin: Math.round(rssSlopeMbPerMin * 100) / 100,
    leaking,
  };
}

/** A minimal dev-log sink the sampler writes through (matches `DevLog`'s leveled methods). */
export interface SamplerLog {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
}

export interface MemorySamplerOptions {
  log: SamplerLog;
  memoryUsage?: () => NodeMemUsage;
  getAppMetrics?: () => ElectronProcessMetric[] | undefined;
  now?: () => string;
  /** Tick interval (default 60_000 — coarse, low overhead). */
  intervalMs?: number;
  /** Rolling window kept in memory for the trend/leak verdict (default 30 samples). */
  windowSize?: number;
  /** Dev-log level for the routine `mem.sample` line (default 'info'). */
  level?: 'debug' | 'info';
  leak?: LeakOptions;
  /** OBS-21 heap snapshot: write a `.heapsnapshot` when RSS growth exceeds this, MB. Off if undefined. */
  heapSnapshotMb?: number;
  /** Returns the dir to write a heap snapshot into (`<vault>/.kb/cache/`), or null to skip. */
  getSnapshotDir?: () => string | null;
  /** Snapshot writer, injected by the main glue as `v8.writeHeapSnapshot` (returns the path written).
   *  Kept injected — not imported here — so this module never pulls `node:v8` into a renderer bundle
   *  (the `__vite-browser-external` boundary, #248). If absent, snapshots are skipped. */
  writeHeapSnapshot?: (file: string) => string;
  /** Injectable timer (tests). */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface MemorySampler {
  start(): void;
  stop(): void;
  /** The most recent sample (null before the first tick). */
  latest(): MemorySample | null;
  /** The current trend/leak verdict (null until enough samples). */
  trend(): MemTrend | null;
  /** Take one sample now (drives the interval; exposed for deterministic tests). */
  tick(): MemorySample;
}

/** Create the periodic memory sampler + leak watchdog (OBS-20/21). Call `start()` after app ready. */
export function createMemorySampler(opts: MemorySamplerOptions): MemorySampler {
  const memoryUsage = opts.memoryUsage ?? ((): NodeMemUsage => process.memoryUsage());
  const now = opts.now ?? ((): string => new Date().toISOString());
  const intervalMs = opts.intervalMs ?? 60_000;
  const windowSize = Math.max(2, opts.windowSize ?? 30);
  const level = opts.level ?? 'info';
  const setIntervalFn = opts.setIntervalFn ?? ((cb, ms): unknown => setInterval(cb, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h): void => clearInterval(h as ReturnType<typeof setInterval>));

  const ring: MemorySample[] = [];
  let lastSample: MemorySample | null = null;
  let lastTrend: MemTrend | null = null;
  let snapshotTakenThisEpisode = false;
  let handle: unknown = null;

  const maybeHeapSnapshot = (trend: MemTrend): void => {
    if (opts.heapSnapshotMb === undefined || trend.rssDeltaMb < opts.heapSnapshotMb) return;
    if (snapshotTakenThisEpisode) return; // at most once per leak episode (snapshots are expensive)
    const dir = opts.getSnapshotDir?.();
    if (!dir || !opts.writeHeapSnapshot) return; // no target / no writer injected → skip
    try {
      const file = `${dir.replace(/\/$/, '')}/heap-${now().replace(/[:.]/g, '-')}.heapsnapshot`;
      const written = opts.writeHeapSnapshot(file);
      snapshotTakenThisEpisode = true;
      opts.log.warn('mem.heap-snapshot-written', { file: written });
    } catch (err) {
      opts.log.warn('mem.heap-snapshot-failed', { err });
    }
  };

  const tick = (): MemorySample => {
    const sample = sampleMemory(memoryUsage, now(), opts.getAppMetrics);
    lastSample = sample;
    ring.push(sample);
    if (ring.length > windowSize) ring.shift();

    // OBS-20: one compact telemetry line per tick (numbers only).
    opts.log[level]('mem.sample', {
      rssMb: Math.round(sample.rss / MB),
      heapUsedMb: Math.round(sample.heapUsed / MB),
      heapTotalMb: Math.round(sample.heapTotal / MB),
      externalMb: Math.round(sample.external / MB),
      ...(sample.processes ? { procCount: sample.processes.length } : {}),
    });

    // OBS-21: leak verdict over the rolling window.
    lastTrend = detectLeak(ring, opts.leak);
    if (lastTrend?.leaking) {
      opts.log.warn('mem.leak-suspected', {
        rssDeltaMb: lastTrend.rssDeltaMb,
        windowMin: lastTrend.windowMin,
        rssSlopeMbPerMin: lastTrend.rssSlopeMbPerMin,
        msg: `memory climbing: rss +${lastTrend.rssDeltaMb} MB over ${lastTrend.windowMin}m`,
      });
      maybeHeapSnapshot(lastTrend);
    } else {
      snapshotTakenThisEpisode = false; // plateaued/dropped → a future episode may snapshot again
    }
    return sample;
  };

  return {
    start(): void {
      if (handle !== null) return;
      handle = setIntervalFn(() => tick(), intervalMs);
    },
    stop(): void {
      if (handle !== null) {
        clearIntervalFn(handle);
        handle = null;
      }
    },
    latest: (): MemorySample | null => lastSample,
    trend: (): MemTrend | null => lastTrend,
    tick,
  };
}
