import { PANE_FIELD_SEP } from "../../lib/tmux-format";
import { tmuxArgv } from "../../lib/tmux-exec";

/**
 * Live tmux state of the window hosting this process's own pane.
 *
 * A `null` field means "could not be determined" (no `TMUX_PANE`, tmux errored,
 * output unparseable). There is no single right fail-safe direction for that —
 * the width persister refuses to persist on unknown, the visibility gate stays
 * visible on unknown — so each consumer decides for itself.
 */
export interface WindowState {
  windowWidth: number | null;
  windowActive: boolean | null;
  sessionAttached: boolean | null;
}

export const UNKNOWN_WINDOW_STATE: WindowState = {
  windowWidth: null,
  windowActive: null,
  sessionAttached: null,
};

/**
 * Parse the three fields out of a `display-message` line. Split from the spawn
 * so the field decoding (notably `session_attached` being a client *count*,
 * not a flag) is unit-testable without tmux.
 */
export function parseWindowState(output: string): WindowState {
  const parts = output.trim().split(PANE_FIELD_SEP);
  if (parts.length < 3) return UNKNOWN_WINDOW_STATE;
  const width = Number.parseInt(parts[0], 10);
  const active = Number.parseInt(parts[1], 10);
  // session_attached is a count of attached clients (>0 means attached).
  const attached = Number.parseInt(parts[2], 10);
  return {
    windowWidth: Number.isInteger(width) ? width : null,
    windowActive: Number.isInteger(active) ? active === 1 : null,
    sessionAttached: Number.isInteger(attached) ? attached > 0 : null,
  };
}

/**
 * One `tmux display-message` for everything a sidebar needs to know about its
 * own window. The width persister (drag vs. window-resize gating) and the
 * visibility gate (background-work suppression) share this one implementation,
 * so each query is a single spawn returning all three fields. They do not
 * share results: each caller pays for its own spawn when it asks.
 */
export async function fetchWindowState(): Promise<WindowState> {
  const pane = process.env.TMUX_PANE;
  if (!pane) return UNKNOWN_WINDOW_STATE;
  try {
    const format = [
      "#{window_width}",
      "#{window_active}",
      "#{session_attached}",
    ].join(PANE_FIELD_SEP);
    const proc = Bun.spawn(
      tmuxArgv("display-message", "-p", "-t", pane, format),
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return parseWindowState(out);
  } catch {
    return UNKNOWN_WINDOW_STATE;
  }
}
