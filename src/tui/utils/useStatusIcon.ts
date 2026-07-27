import { createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import type { SessionStatus, AttentionType, AttentionState } from "../../types";
import {
  getStatusIcon,
  getAttentionIcon,
  DOT_SPINNER_FRAMES,
  NERDFONT_SPINNER_FRAMES,
  type IconStyle,
} from "../../lib/icons";
import { trackInterval, untrackInterval } from "./perf";

// A terminal renderer has no partial repaint: every spinner frame bump
// forces a full-buffer redraw, so one visible working spinner pins the
// renderer to (1000 / interval) redraws/sec. At 100ms that was ~10/sec
// and ~5.5% of a core (measured); 160ms keeps the 4/6-frame spin clearly
// animated (~640ms/rotation for dot) while cutting that steady-state cost
// ~37%.
export const SPINNER_INTERVAL_MS = 160;

// --- Shared spinner signal ---
// All "working" status icons share a single interval instead of each creating its own.
const [spinnerFrame, setSpinnerFrame] = createSignal(0);
/** Exported for tests: the shared frame counter every spinner icon reads. */
export { spinnerFrame };
let spinnerRefCount = 0;
let spinnerIntervalId: Timer | null = null;
let spinnerPaused = false;

function startSpinnerInterval(): void {
  if (spinnerIntervalId || spinnerPaused) return;
  spinnerIntervalId = trackInterval(() => {
    setSpinnerFrame((f) => f + 1);
  }, SPINNER_INTERVAL_MS);
}

function stopSpinnerInterval(): void {
  if (!spinnerIntervalId) return;
  untrackInterval(spinnerIntervalId);
  spinnerIntervalId = null;
}

/**
 * Stop/restart the shared spinner without touching refcounts.
 *
 * Every frame bump is a full-buffer redraw, so a sidebar in a background
 * window burns CPU animating something nobody can see. Pausing clears the
 * interval while leaving `spinnerRefCount` intact, so the icons stay
 * registered and resume in place; resuming bumps the frame once so the UI
 * repaints immediately instead of holding the pre-pause frame for up to one
 * interval.
 */
export function setSpinnerPaused(paused: boolean): void {
  if (paused === spinnerPaused) return;
  spinnerPaused = paused;

  if (paused) {
    stopSpinnerInterval();
    return;
  }

  if (spinnerRefCount > 0) {
    setSpinnerFrame((f) => f + 1);
    startSpinnerInterval();
  }
}

function acquireSpinner(): void {
  spinnerRefCount++;
  startSpinnerInterval();
}

function releaseSpinner(): void {
  if (--spinnerRefCount <= 0) {
    stopSpinnerInterval();
    spinnerRefCount = 0;
  }
}

function getAnimationFrames(
  style: IconStyle | undefined,
  status: string,
): readonly string[] | null {
  if (style === "dot" && status === "working") return DOT_SPINNER_FRAMES;
  if (style === "nerdfont" && status === "working")
    return NERDFONT_SPINNER_FRAMES;
  return null;
}

/**
 * Reactive hook that returns an animated status icon.
 *
 * Animated states use a shared spinner interval so N "working" sessions
 * only create 1 timer instead of N.
 */
export function useStatusIcon(
  status: Accessor<SessionStatus | string>,
  attentionType: Accessor<AttentionType | null | undefined>,
  iconStyle: Accessor<IconStyle | undefined>,
  attentionState?: Accessor<AttentionState | undefined>,
): Accessor<string> {
  const frames = createMemo(() => getAnimationFrames(iconStyle(), status()));
  const isAnimated = createMemo(() => frames() !== null);

  createEffect(() => {
    if (isAnimated()) {
      acquireSpinner();
      onCleanup(() => releaseSpinner());
    }
  });

  const icon = createMemo(() => {
    const attn = attentionState?.();
    if (attn && status() === "idle") return getAttentionIcon(attn, iconStyle());

    const f = frames();
    if (f) {
      const idx = spinnerFrame() % f.length;
      return f[idx];
    }

    return getStatusIcon(status(), attentionType(), iconStyle());
  });

  return icon;
}
