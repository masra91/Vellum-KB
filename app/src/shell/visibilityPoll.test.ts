// @vitest-environment happy-dom
//
// #509 — the shared render-safe poll helper. Fails-before/passes-after on the CLASS: any view-local poll
// wired through this helper gets pause-while-hidden, detach-stops-it, and bounded error backoff for free.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createVisibilityPoll, isPollTargetVisible } from './visibilityPoll';

describe('isPollTargetVisible', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
  });

  it('is true for an attached, unhidden element with no `.view` ancestor', () => {
    expect(isPollTargetVisible(root)).toBe(true);
  });

  it('is false once the element is detached', () => {
    root.remove();
    expect(isPollTargetVisible(root)).toBe(false);
  });

  it('is false when an ANCESTOR `.view` carries `.hidden` — the shell mounts a poll target nested inside a `.view` (#509 Agents bug)', () => {
    const view = document.createElement('div');
    view.className = 'view hidden';
    const section = document.createElement('div');
    section.className = 'agents-section';
    view.appendChild(section);
    document.body.appendChild(view);
    expect(isPollTargetVisible(section)).toBe(false);
    view.classList.remove('hidden');
    expect(isPollTargetVisible(section)).toBe(true);
    view.remove();
  });

  it('is false when the element itself is the hidden `.view`', () => {
    root.className = 'view hidden';
    expect(isPollTargetVisible(root)).toBe(false);
  });

  it('is false when the element itself carries `.hidden` directly, even with no `.view` class (e.g. Reviews, whose container IS the toggled `.view` but a test fixture may omit that class name)', () => {
    root.className = 'hidden';
    expect(isPollTargetVisible(root)).toBe(false);
  });
});

describe('createVisibilityPoll', () => {
  let root: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    root.remove();
    vi.useRealTimers();
  });

  it('calls fn on the given cadence while visible', async () => {
    const fn = vi.fn(async () => {});
    createVisibilityPoll(root, 1000, fn);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('skips ticks (no fn call) while the window is backgrounded', async () => {
    const fn = vi.fn(async () => {});
    createVisibilityPoll(root, 1000, fn);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).not.toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skips ticks while an ancestor `.view` is hidden, resumes when shown (#509 — test the CLASS: mount under a `.view.hidden` parent)', async () => {
    const view = document.createElement('div');
    view.className = 'view hidden';
    document.body.appendChild(view);
    view.appendChild(root);
    const fn = vi.fn(async () => {});
    createVisibilityPoll(root, 1000, fn);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).not.toHaveBeenCalled();
    view.classList.remove('hidden');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    view.remove();
  });

  it('stops permanently once the container is detached — no further fn calls', async () => {
    const fn = vi.fn(async () => {});
    createVisibilityPoll(root, 1000, fn);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    root.remove();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stop() halts further ticks immediately', async () => {
    const fn = vi.fn(async () => {});
    const poll = createVisibilityPoll(root, 1000, fn);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    poll.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a rejecting fn never throws past the wrapper (no unhandledrejection) and backs off, capped, resetting on success', async () => {
    let fail = true;
    const fn = vi.fn(async () => {
      if (fail) throw new Error('boom');
    });
    createVisibilityPoll(root, 1000, fn);
    // Tick 1 (t=1000): fails → backoff x2 → next tick scheduled at t=1000+2000=3000
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); // t=2000 — still within backoff, no call yet
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); // t=3000 — backoff elapsed → tick 2, fails again → backoff x4
    expect(fn).toHaveBeenCalledTimes(2);
    fail = false;
    await vi.advanceTimersByTimeAsync(4000); // next backoff is 4x base=4000 → t=7000 → tick 3, succeeds
    expect(fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000); // backoff reset to 1x → next tick exactly 1000ms later
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('backoff never exceeds the 8x cap', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    createVisibilityPoll(root, 1000, fn);
    // Backoff sequence in multiplier: 1(fail→2), 2(fail→4), 4(fail→8), 8(fail→8 capped), 8(fail→8 capped)…
    await vi.advanceTimersByTimeAsync(1000); // t=1000, call #1
    await vi.advanceTimersByTimeAsync(2000); // t=3000, call #2
    await vi.advanceTimersByTimeAsync(4000); // t=7000, call #3
    await vi.advanceTimersByTimeAsync(8000); // t=15000, call #4 (backoff now capped at 8x)
    expect(fn).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(8000); // capped at 8000ms, not 16000ms
    expect(fn).toHaveBeenCalledTimes(5);
  });
});
