// OBS-24: the maintained status PROJECTION. Holds the last-known-good `PipelineStatusView` so the
// render path (Status IPC + the QCAP-14 tray readout) reads it INSTANTLY — it never triggers the
// expensive compute that made the status poll block behind the pipeline's own git ops and trip the
// 8s load-guard (#256).
//
// SHELL-12: this is now a thin ADAPTER over the generic cached-projection spine (`projectionStore.ts`)
// — the same backbone every other surface (reviews · settings · activity) reads from. It keeps the
// status-specific contract (`current(): PipelineStatusView | null`, builtAt carried INSIDE the view)
// so OBS-24's callers are unchanged; all the store mechanics live in the shared spine (no parallel
// impl). The status view embeds its own `builtAt`, so this adapter unwraps the envelope's `.data`.
import type { PipelineStatusView } from '../kb/pipelineStatusView';
import { createProjectionStore } from './projectionStore';

export interface StatusSnapshotDeps {
  /** The expensive status compute — run ONLY on the background cadence, never the render path. */
  compute: () => Promise<PipelineStatusView | null>;
  /** Background refresh cadence in ms. */
  intervalMs: number;
  /** Load the persisted last-known-good snapshot for the active KB (shown instantly on launch). */
  load?: () => PipelineStatusView | null;
  /** Persist a freshly-computed snapshot as the new last-known-good. Best-effort. */
  save?: (view: PipelineStatusView) => void;
  /** Report a background compute failure (the last-known-good snapshot is retained). */
  onError?: (err: unknown) => void;
  /** PUSH hook (SHELL-12 (c), issue #510) — fired after each refresh that changes the snapshot, mirroring
   *  `ProjectionStoreDeps.onUpdate`. Unwrapped to the view (not the `Projection<T>` envelope) to match this
   *  adapter's existing unwrapped-envelope convention; callers that only need the freshness stamp read
   *  `view.builtAt` (every `PipelineStatusView` carries its own `builtAt`, per the adapter's doc comment). */
  onUpdate?: (view: PipelineStatusView) => void;
  /** Injectable timer (tests). */
  scheduler?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void };
}

export interface StatusSnapshotStore {
  /** The last-known-good status view, or null if none computed/persisted yet. Instant — no compute. */
  current(): PipelineStatusView | null;
  start(): void;
  stop(): void;
  refreshNow(): Promise<void>;
}

export function createStatusSnapshotStore(deps: StatusSnapshotDeps): StatusSnapshotStore {
  const store = createProjectionStore<PipelineStatusView>({
    compute: deps.compute,
    intervalMs: deps.intervalMs,
    ...(deps.load ? { load: deps.load } : {}),
    ...(deps.save ? { save: deps.save } : {}),
    ...(deps.onError ? { onError: deps.onError } : {}),
    ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
  });
  return {
    current: () => store.current()?.data ?? null, // status carries builtAt inside the view → unwrap the envelope
    start: () => store.start(),
    stop: () => store.stop(),
    refreshNow: () => store.refreshNow(),
  };
}
