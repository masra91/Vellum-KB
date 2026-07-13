// UI load-resilience helpers (#145, hardening PANEL-9). A Manage view that `await`s a main-process
// IPC read shows a "Loading…" placeholder until it resolves. If that IPC **hangs** (e.g. the backend
// is reading degraded staging and never returns), the view would spin forever — a `catch` alone
// doesn't help because the promise never rejects. `withTimeout` bounds the wait so a hung/slow load
// surfaces as a catchable failure, and `renderLoadError` gives the user a retryable fallback instead
// of an infinite spinner. DOM-light + view-agnostic so every Manage view shares one implementation.

/** Default load timeout for a Manage-view IPC read. Generous enough not to false-trip a merely-slow
 *  first load, short enough that a genuine hang doesn't strand the user staring at a spinner. */
export const LOAD_TIMEOUT_MS = 8000;

/** Timeout for a FULL-GRAPH read (Explore neighborhood, Health scan). These walk the whole
 *  `entities/` + `claims/` tree LIVE on every mount (SPEC-0058) — legitimately heavier than a light
 *  Manage read, so the 8s default false-trips on a cold/large vault and flips the view to an error face
 *  even though the scan would have finished (the packaged-app Explore/Health "Couldn't load" P0). A more
 *  generous bound lets a cold scan complete; it stays BOUNDED (never an infinite spinner, #145), and a
 *  trip past THIS is the honest signal the maintained graph projection is needed, not a live walk. */
export const GRAPH_LOAD_TIMEOUT_MS = 30000;

/** How long a graph read may run before the view swaps its spinner for the calm WARMING face — so a
 *  slow cold scan reads as "still preparing", not a frozen "Loading…", WHILE the scan keeps running. */
export const WARMING_AFTER_MS = 3000;

/** Thrown by {@link withTimeout} when the wrapped promise doesn't settle in time. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race `p` against a timeout: resolves/rejects with `p`'s outcome if it settles within `ms`, otherwise
 * rejects with a {@link TimeoutError}. The timer is cleared as soon as `p` settles (no dangling timer).
 * A hung IPC therefore becomes a normal rejection the caller's existing `catch` can handle.
 */
export function withTimeout<T>(p: Promise<T>, ms: number = LOAD_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** True when a load failure is the backend still WARMING — a {@link TimeoutError} on a cold/large first
 *  scan — rather than a genuine fault. A warming state must NOT wear the alarming error face (SPEC-0058
 *  STATE-* / KB-Lead reframe: a cold-start scan in flight is "warming", not "broken"). Any non-timeout
 *  throw is a real error and routes to {@link renderLoadError}. */
export function isWarming(err: unknown): boolean {
  return err instanceof TimeoutError;
}

/**
 * Un-swallow a view's load failure to the main app-log via the OBS-18 renderer-error channel, so a
 * packaged-app walkthrough sees the REAL cause — a `TimeoutError` (the scan budget tripped on a cold/large
 * vault) vs a thrown read error — instead of a silent `catch {}` (SPEC-0058 slice-0: nobody knew which it
 * was). Fire-and-forget and self-guarded: telemetry must never throw over the original failure it reports.
 * `view` tags the log line (e.g. "explore", "health").
 */
export function reportLoadFailure(view: string, err: unknown): void {
  try {
    const e = err instanceof Error ? err : new Error(String(err));
    void window.kbApi?.reportRendererError?.({
      kind: 'error',
      message: `[${view}] load failed: ${e.name}: ${e.message}`,
      ...(e.stack ? { stack: e.stack } : {}),
    })?.catch?.(() => {});
  } catch {
    /* best-effort telemetry — swallow its own failure, never mask the load failure */
  }
}

/**
 * Run a full-graph `fetch()` with honest WARMING feedback (SPEC-0058 slice-0). Bounds it by
 * {@link GRAPH_LOAD_TIMEOUT_MS}; if it hasn't settled after `warmingAfterMs`, `onWarming()` fires once so
 * the view can swap its spinner for the calm "still preparing" face WHILE the scan keeps running. Resolves
 * with the value on success; on failure rejects with the original error (a `TimeoutError` if the bound
 * tripped — the caller routes that to {@link renderWarming}, any other error to {@link renderLoadError}).
 */
export async function loadGraphWithWarming<T>(
  fetch: () => Promise<T>,
  onWarming: () => void,
  opts: { warmingAfterMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  const warmTimer = setTimeout(onWarming, opts.warmingAfterMs ?? WARMING_AFTER_MS);
  try {
    return await withTimeout(fetch(), opts.timeoutMs ?? GRAPH_LOAD_TIMEOUT_MS);
  } finally {
    clearTimeout(warmTimer);
  }
}

/**
 * Render a calm "still preparing" WARMING state — NOT the error face — for when a graph read is slow or
 * timed out because the backend is still warming on a cold/large vault (SPEC-0058 slice-0, KB-Lead's
 * warming-vs-error reframe). A distinct `.load-warming` class (no error hue) + patient copy so the user
 * reads "be patient", not "it broke"; the Retry re-runs the load. `headerHtml` is the view's own trusted
 * static header (not user data), so it is intentionally not escaped — same contract as {@link renderLoadError}.
 */
export function renderWarming(container: HTMLElement, headerHtml: string, onRetry: () => void): void {
  container.innerHTML = `<div class="load-face viz-surface">${headerHtml}<p class="load-warming viz-body"><span class="vmark churn load-face-mark" aria-hidden="true"></span> Still preparing your library — this can take a moment the first time on a large one. <button type="button" class="load-face-btn load-retry">Retry</button></p></div>`;
  container.querySelector<HTMLButtonElement>('.load-retry')?.addEventListener('click', () => onRetry());
}

/**
 * Render a **retryable** "couldn't load" fallback into a Manage view's container (#145). `headerHtml`
 * is the view's own trusted header block (its `<h1>` + any intro), kept so the view still looks like
 * itself in the error state; `onRetry` re-runs the view's load. The Retry button is wired here so
 * every view gets the same affordance. `headerHtml` is a static, code-supplied literal (not user
 * data), so it is intentionally not escaped.
 */
export function renderLoadError(container: HTMLElement, headerHtml: string, onRetry: () => void): void {
  container.innerHTML = `<div class="load-face load-face-error viz-surface">${headerHtml}<p class="error load-error">Couldn’t load — the app may be busy or still starting up. <button type="button" class="load-face-btn load-retry">Retry</button></p></div>`;
  container.querySelector<HTMLButtonElement>('.load-retry')?.addEventListener('click', () => onRetry());
}

/** Skeleton shapes the shared primitive can paint (#520 §8) — pick the one matching the view's real
 *  loaded layout: `cards` for a card list (Sources/Connectors, Agents-hub sub-sections, Settings),
 *  `rows` for a flat table/list (Activity, Jobs/Schedules), `prose` for flowing text (Today, Ask). */
export type SkeletonShape = 'cards' | 'rows' | 'prose';

function skeletonShapeHtml(shape: SkeletonShape): string {
  if (shape === 'cards') {
    const card =
      '<div class="skel-card" aria-hidden="true"><span class="skel skel-ln"></span>' +
      '<span class="skel skel-ln skel-ln--short"></span><span class="skel skel-ln skel-ln--sub"></span></div>';
    return `<div class="skel-cards">${card}${card}</div>`;
  }
  if (shape === 'rows') {
    const row =
      '<div class="skel-row" aria-hidden="true"><span class="skel skel-ln skel-ln--short"></span>' +
      '<span class="skel skel-ln"></span></div>';
    return `<div class="skel-rows">${row}${row}${row}</div>`;
  }
  return (
    '<div class="skel-prose" aria-hidden="true"><span class="skel skel-ln skel-ln--w1"></span>' +
    '<span class="skel skel-ln skel-ln--w2"></span><span class="skel skel-ln skel-ln--w3"></span></div>'
  );
}

/**
 * A bare status-line + shaped skeleton fragment, with no wrapping surface/header — for a view that
 * already owns its own container chrome and just needs its inner slot filled (e.g. Activity's
 * `#activityBody`, Health's `.line` body). Caller's slot element should carry `aria-busy="true"` itself
 * (it isn't set here, since there's no single wrapper this function controls).
 */
export function skeletonFragmentHtml(shape: SkeletonShape = 'cards'): string {
  return (
    '<div class="skel-status" aria-hidden="true"><span class="vmark loom"></span> Reading your library…</div>' +
    skeletonShapeHtml(shape)
  );
}

/**
 * Paint the shared VUX-6 skeleton — a shaped placeholder (never bare "Loading…" text), synchronously on
 * the first frame at mount, before the async read starts. `headerHtml` is the view's own trusted static
 * header (kept so the surface still looks like itself while warming — same contract as
 * {@link renderWarming}/{@link renderLoadError}); `shape` matches the view's real loaded layout (§8).
 * `aria-busy="true"` sits on the swapped wrapper, so it clears automatically the moment the view replaces
 * `container.innerHTML` with real content — no manual cleanup needed at the call site.
 */
export function skeletonHtml(headerHtml: string, shape: SkeletonShape = 'cards'): string {
  return `<div class="viz-surface" aria-busy="true">${headerHtml}${skeletonFragmentHtml(shape)}</div>`;
}

export function paintSkeleton(container: HTMLElement, headerHtml: string, shape: SkeletonShape = 'cards'): void {
  container.innerHTML = skeletonHtml(headerHtml, shape);
}
