// SPEC-0030 OBS-20 (memory telemetry) + OBS-21 (leak watchdog). Pure + injected — no Electron, no
// real timer, no real v8 snapshot.
import { describe, it, expect } from 'vitest';
import { sampleMemory, detectLeak, createMemorySampler, type NodeMemUsage, type MemorySample } from './memorySampler';

const MB = 1024 * 1024;
const mem = (rssMb: number, heapMb = 10): NodeMemUsage => ({
  rss: rssMb * MB,
  heapTotal: (heapMb + 5) * MB,
  heapUsed: heapMb * MB,
  external: 1 * MB,
  arrayBuffers: 0,
});

function fakeLog() {
  const calls: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const push = (level: string) => (event: string, fields: Record<string, unknown> = {}) => calls.push({ level, event, fields });
  return { log: { debug: push('debug'), info: push('info'), warn: push('warn') }, calls };
}

const sampleAt = (rssMb: number, ts: string): MemorySample => ({ ts, rss: rssMb * MB, heapUsed: 10 * MB, heapTotal: 15 * MB, external: MB, arrayBuffers: 0 });
function climbing(n: number, startMb: number, stepMb: number): MemorySample[] {
  return Array.from({ length: n }, (_, i) => sampleAt(startMb + i * stepMb, `2026-06-08T00:${String(i).padStart(2, '0')}:00.000Z`));
}

describe('sampleMemory (OBS-20)', () => {
  it('captures memoryUsage numbers + maps getAppMetrics processes', () => {
    const s = sampleMemory(() => mem(200, 40), '2026-06-08T00:00:00.000Z', () => [
      { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 3.14159 }, memory: { workingSetSize: 123 } },
      { pid: 2, type: 'GPU' },
    ]);
    expect(s).toMatchObject({ rss: 200 * MB, heapUsed: 40 * MB, ts: '2026-06-08T00:00:00.000Z' });
    expect(s.processes).toEqual([
      { pid: 1, type: 'Browser', cpuPercent: 3.1, memoryKb: 123 },
      { pid: 2, type: 'GPU' },
    ]);
  });

  it('omits processes when getAppMetrics is absent', () => {
    const s = sampleMemory(() => mem(100), 'T');
    expect(s.processes).toBeUndefined();
  });
});

describe('detectLeak (OBS-21)', () => {
  it('returns null below minSamples', () => {
    expect(detectLeak(climbing(3, 100, 20), { minSamples: 6 })).toBeNull();
  });

  it('flags a sustained monotonic climb past the growth guard', () => {
    const t = detectLeak(climbing(6, 100, 20), { minSamples: 6, minGrowthMb: 50 });
    expect(t).toMatchObject({ leaking: true, samples: 6 });
    expect(t!.rssDeltaMb).toBeCloseTo(100, 1); // 5 steps * 20MB
    expect(t!.rssSlopeMbPerMin).toBeGreaterThan(0);
  });

  // #508 item 4: the OLD verdict required STRICTLY increasing RSS at every step — a single GC-timing
  // plateau/dip anywhere in the window flipped a real, sustained leak to "not leaking," making the
  // watchdog blind to it. The least-squares slope survives that noise: the overall window still climbs.
  it('a single flat step amid sustained growth still reads as leaking', () => {
    const s = climbing(6, 100, 20);
    s[3] = sampleAt(s[2].rss / MB, s[3].ts); // plateau at step 3 — the window still climbs overall
    const t = detectLeak(s, { minSamples: 6, minGrowthMb: 50 });
    expect(t?.leaking).toBe(true);
    expect(t!.rssSlopeMbPerMin).toBeGreaterThan(0);
  });

  it('does NOT flag growth below the magnitude guard (noise)', () => {
    const t = detectLeak(climbing(6, 100, 2), { minSamples: 6, minGrowthMb: 50 }); // 10MB total
    expect(t?.leaking).toBe(false);
  });

  it('a single dip amid sustained growth still reads as leaking', () => {
    const s = climbing(6, 100, 20);
    s[4] = sampleAt(80, s[4].ts); // one dip — the window still climbs overall
    const t = detectLeak(s, { minSamples: 6, minGrowthMb: 50 });
    expect(t?.leaking).toBe(true);
  });

  it('does NOT flag pure noise oscillating around a baseline (no sustained trend, tiny net delta)', () => {
    const s = [100, 110, 95, 105, 98, 102].map((mb, i) => sampleAt(mb, `2026-06-08T00:0${i}:00.000Z`));
    const t = detectLeak(s, { minSamples: 6, minGrowthMb: 50 });
    expect(t?.leaking).toBe(false);
  });
});

describe('createMemorySampler (OBS-20/21)', () => {
  it('tick records a mem.sample line + exposes latest()', () => {
    const f = fakeLog();
    let rss = 150;
    const s = createMemorySampler({ log: f.log, memoryUsage: () => mem(rss), now: () => 'T', level: 'info' });
    s.tick();
    expect(f.calls).toEqual([{ level: 'info', event: 'mem.sample', fields: expect.objectContaining({ rssMb: 150 }) }]);
    expect(s.latest()).toMatchObject({ rss: 150 * MB });
  });

  it('start/stop drive the injected timer exactly once', () => {
    const f = fakeLog();
    let started: (() => void) | null = null;
    let cleared = 0;
    const s = createMemorySampler({
      log: f.log,
      memoryUsage: () => mem(100),
      setIntervalFn: (cb) => { started = cb; return 'H'; },
      clearIntervalFn: () => { cleared++; },
    });
    s.start();
    s.start(); // idempotent
    expect(started).toBeTypeOf('function');
    started!();
    expect(f.calls.some((c) => c.event === 'mem.sample')).toBe(true);
    s.stop();
    expect(cleared).toBe(1);
  });

  it('emits a loud mem.leak-suspected warn on a sustained climb (OBS-21)', () => {
    const f = fakeLog();
    let i = 0;
    const rssSeq = [100, 120, 140, 160, 180, 200, 220];
    const tsSeq = rssSeq.map((_, k) => `2026-06-08T00:${String(k).padStart(2, '0')}:00.000Z`);
    const s = createMemorySampler({
      log: f.log,
      memoryUsage: () => mem(rssSeq[i]),
      now: () => tsSeq[i],
      leak: { minSamples: 6, minGrowthMb: 50 },
    });
    for (i = 0; i < rssSeq.length; i++) s.tick();
    const warn = f.calls.find((c) => c.event === 'mem.leak-suspected');
    expect(warn?.level).toBe('warn');
    expect(String(warn?.fields.msg)).toMatch(/memory climbing: rss \+\d/);
    expect(s.trend()?.leaking).toBe(true);
  });

  it('writes at most ONE heap snapshot per leak episode, then re-arms after a plateau (OBS-21)', () => {
    const f = fakeLog();
    const written: string[] = [];
    let i = 0;
    // climb hard (×6) → snapshot once; then plateau; then climb again → snapshot again.
    const rssSeq = [100, 200, 300, 400, 500, 600, 600, 100, 200, 300, 400, 500, 600];
    const tsSeq = rssSeq.map((_, k) => `2026-06-08T${String(k).padStart(2, '0')}:00:00.000Z`);
    const s = createMemorySampler({
      log: f.log,
      memoryUsage: () => mem(rssSeq[i]),
      now: () => tsSeq[i],
      windowSize: 6,
      leak: { minSamples: 6, minGrowthMb: 50 },
      heapSnapshotMb: 200,
      getSnapshotDir: () => '/tmp/vault/.kb/cache',
      writeHeapSnapshot: (file) => { written.push(file); return file; },
    });
    for (i = 0; i < rssSeq.length; i++) s.tick();
    expect(written.length).toBe(2); // once per episode, not on every leaking tick
    expect(written[0]).toMatch(/\/tmp\/vault\/\.kb\/cache\/heap-.*\.heapsnapshot$/);
  });

  it('skips the snapshot when no writer is injected (no node:v8 dependency)', () => {
    const f = fakeLog();
    let i = 0;
    const rssSeq = climbing(6, 100, 100).map((s) => s.rss / MB);
    const s = createMemorySampler({
      log: f.log,
      memoryUsage: () => mem(rssSeq[i]),
      now: () => `2026-06-08T0${i}:00:00.000Z`,
      leak: { minSamples: 6, minGrowthMb: 50 },
      heapSnapshotMb: 100,
      getSnapshotDir: () => '/tmp/x',
      // no writeHeapSnapshot
    });
    for (i = 0; i < rssSeq.length; i++) s.tick();
    expect(f.calls.some((c) => c.event === 'mem.heap-snapshot-written')).toBe(false);
  });
});
