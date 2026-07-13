// SPEC-0058 STATE-8 (#510) — the renderer-side half of the main→renderer projection PUSH. Thin wrapper
// over `window.kbApi.onProjectionChanged` that filters the raw event stream (every maintained store's
// updates land on the SAME IPC channel) down to the one store a view cares about, so each view's `show()`
// can subscribe with a one-line call instead of re-implementing the filter.

/** The maintained-projection stores a view can subscribe to (mirrors `pipeline.ts`'s `ProjectionPushEvent`). */
export type ProjectionStoreName = 'status' | 'review' | 'graph' | 'today';

/**
 * Subscribe `cb` to pushes for exactly `store`. Returns an unsubscribe function — call it from the
 * view's `hide()` so the subscription doesn't outlive the view's visibility (no leaked IPC listener).
 *
 * Best-effort, like the main-process `onUpdate` hook it mirrors (`projectionStore.ts`): a push is a
 * "go re-read the cache" nudge, never load-bearing, so a bridge that isn't there (a `Partial<KbApi>`
 * test double that doesn't exercise push) degrades to a no-op subscription rather than throwing.
 */
export function subscribeProjectionChanged(store: ProjectionStoreName, cb: () => void): () => void {
  if (typeof window.kbApi?.onProjectionChanged !== 'function') return () => {};
  return window.kbApi.onProjectionChanged((event) => {
    if (event.store === store) cb();
  });
}
