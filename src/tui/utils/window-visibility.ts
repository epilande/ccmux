import { createSignal, onCleanup, type Accessor } from "solid-js";
import { trackInterval, untrackInterval } from "./perf";
import { fetchWindowState, type WindowState } from "./tmux-window-state";

/**
 * Debounce applied to visibility re-checks. Refresh triggers arrive at human
 * pane-switch rate but can burst (switching sessions moves the active pane in
 * several windows at once), and each check costs one `tmux display-message`
 * spawn per sidebar process, so coalesce a burst into a single spawn.
 */
export const VISIBILITY_DEBOUNCE_MS = 250;

/**
 * Safety-net poll. Client attach/detach flips visibility for every window of a
 * session but fires no tmux select hook, so nothing pushes us an event for it.
 * Slow on purpose: it exists to heal a wrong answer, not to be the mechanism.
 */
export const VISIBILITY_POLL_MS = 30_000;

/**
 * A sidebar is visible only when its own pane's window is the active window of
 * a session that has an attached client.
 *
 * Unknown inputs fail OPEN (visible). A sidebar wrongly believed invisible
 * freezes its spinners and time labels in a window the user is looking at,
 * which is far worse than paying for redraws nobody sees.
 */
export function isVisibleWindowState(state: WindowState): boolean {
  return (state.windowActive ?? true) && (state.sessionAttached ?? true);
}

export interface WindowVisibility {
  /** Whether this process's window is currently on screen. */
  visible: Accessor<boolean>;
  /** Debounced re-check; safe to call on every incoming event. */
  refresh: () => void;
}

export interface WindowVisibilityOptions {
  /** Seam for tests; defaults to the real `tmux display-message` fetch. */
  fetch?: () => Promise<WindowState>;
  debounceMs?: number;
  pollMs?: number;
}

/**
 * Tracks whether this TUI process's tmux window is on screen, so background
 * instances can skip work whose only product is pixels nobody sees.
 *
 * Sidebar-only: the picker is always the thing the user is looking at.
 */
export function createWindowVisibility(
  options: WindowVisibilityOptions = {},
): WindowVisibility {
  const fetch = options.fetch ?? fetchWindowState;
  const debounceMs = options.debounceMs ?? VISIBILITY_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? VISIBILITY_POLL_MS;

  // Start visible: the first check is asynchronous, and a sidebar that boots
  // frozen in the window the user just toggled would look broken.
  const [visible, setVisible] = createSignal(true);
  let debounce: Timer | null = null;
  let disposed = false;

  const check = (): void => {
    void fetch().then(
      (state) => {
        if (!disposed) setVisible(isVisibleWindowState(state));
      },
      () => {
        // Fail open, same as an unparseable answer.
        if (!disposed) setVisible(true);
      },
    );
  };

  const refresh = (): void => {
    if (disposed) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      check();
    }, debounceMs);
  };

  check();
  const pollId = trackInterval(check, pollMs);

  onCleanup(() => {
    disposed = true;
    if (debounce) clearTimeout(debounce);
    untrackInterval(pollId);
  });

  return { visible, refresh };
}
