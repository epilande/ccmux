/**
 * Settle delay before collecting a hidden sidebar's heap. Long enough that
 * flipping between windows never GCs on the way past, and that whatever work
 * was in flight when the window went away has finished allocating.
 */
export const IDLE_GC_DELAY_MS = 5_000;

export interface IdleGcOptions {
  /** Seam for tests; defaults to a synchronous full collection. */
  gc?: (force: boolean) => void;
  delayMs?: number;
}

export interface IdleGcScheduler {
  /** Feed every visibility change; only the true -> false edge schedules. */
  setVisible: (visible: boolean) => void;
  cancel: () => void;
}

/**
 * Collects a sidebar's heap once its window has been off screen for a while.
 *
 * JSC's GC is allocation-driven, so it only runs as a consequence of a process
 * allocating. A gated background sidebar allocates almost nothing (measured:
 * ~0.95s of CPU over its life, down from ~6.1s), which means nothing ever
 * triggers a collection and the process can sit indefinitely on the heap
 * high-water mark it reached while booting. Observed on a 25-sidebar fleet:
 * 9 processes stranded at 126-155MB against the ~95MB the others settle to.
 *
 * So do explicitly what allocation pressure no longer does. Forcing a full
 * synchronous collection pauses the renderer, which is free here: by
 * definition nobody is looking at this pane. Never collect on the visible
 * path — a visible sidebar both allocates enough to be collected normally and
 * cannot afford the pause.
 */
export function createIdleGcScheduler(
  options: IdleGcOptions = {},
): IdleGcScheduler {
  const gc = options.gc ?? ((force: boolean) => Bun.gc(force));
  const delayMs = options.delayMs ?? IDLE_GC_DELAY_MS;

  let timer: Timer | null = null;

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    setVisible(visible: boolean) {
      if (visible) {
        // Back on screen before the settle elapsed: this was a pass-through.
        cancel();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        gc(true);
      }, delayMs);
    },
    cancel,
  };
}
