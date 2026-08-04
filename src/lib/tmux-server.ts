/**
 * Pure helpers for the single-server invariant.
 *
 * tmux pane ids (`%N`) are unique only within one server and collide across
 * servers (each numbers from `%0`). The daemon scans one server and exposes its
 * `#{socket_path}` via `GET /server-info`; consumers compare their own server
 * before targeting a pane, refusing a cross-server `%N` rather than switching or
 * sending keys to the wrong pane.
 *
 * I/O-free (its only import reads configuration) so both the TUI and the CLI
 * can import it.
 */

import { activeTmuxSocketOverride, tmuxSocketPath } from "./tmux-socket";

/**
 * The tmux socket this process's own tmux calls target: a configured override
 * when one applies here (see `activeTmuxSocketOverride`), else the first field
 * of `$TMUX` (`<socket_path>,<pid>,<session>`), else null.
 *
 * The override arm is what makes the guard below stronger rather than weaker:
 * a client outside tmux used to know nothing about its own server and had to
 * fail open, and now it knows exactly which one it was pointed at.
 */
export function currentTmuxSocket(): string | null {
  const override = activeTmuxSocketOverride();
  if (override) return tmuxSocketPath(override);
  return process.env.TMUX?.split(",")[0] ?? null;
}

/**
 * True unless we can prove the target pane is on a different server than the
 * daemon that produced its `%N`. Fail-open when either socket is unknown: the
 * guard is a safety net against a second-server collision, not a gate that
 * blocks use when the socket is simply unavailable.
 */
export function isSameTmuxServer(daemonSocket: string | null): boolean {
  const mine = currentTmuxSocket();
  if (!mine || !daemonSocket) return true;
  return mine === daemonSocket;
}
