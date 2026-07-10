/**
 * tmux *client* (not pane) queries, shared by consumers that need to act on
 * behalf of "whatever terminal the user is attached with" rather than a
 * specific pane:
 *
 * - `ccmux switch` (`src/commands/switch.ts`) falls back to these when
 *   invoked outside tmux (no `$TMUX`, so no implicit current client) - e.g.
 *   a notification click from Notification Center.
 * - The daemon's notification delivery wrapper (`src/daemon/notify-delivery.ts`)
 *   reuses the same client for background-session click targets
 *   (`display-popup -c`) and for resolving the frontmost-terminal bundle id.
 *
 * Dependency-free (bare `Bun.spawn`, no injection) to match the rest of this
 * file's sibling `tmux-server.ts` and the daemon's `pane-io.ts`; tests stub
 * `Bun.spawn` globally instead.
 */

/**
 * The pid of the tmux client attached to the current session context (i.e.
 * `$TMUX`'s session, or - when invoked from inside a pane - the one
 * `display-message` resolves by default). Returns null on any query failure
 * or when no client is present.
 */
export async function getActiveTmuxClientPid(): Promise<number | null> {
  try {
    const proc = Bun.spawn(["tmux", "display-message", "-p", "#{client_pid}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const pid = parseInt(output.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * The tty of the most-recently-active attached tmux client (highest
 * `#{client_activity}` wins), for callers with no implicit current client
 * (invoked outside tmux entirely, e.g. a notification click). Returns null
 * when no client is attached or the query fails.
 */
export async function resolveActiveTmuxClientTty(): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["tmux", "list-clients", "-F", "#{client_activity} #{client_tty}"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    let bestActivity = -Infinity;
    let bestTty: string | null = null;
    for (const rawLine of output.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) continue;
      const activity = Number(line.slice(0, spaceIdx));
      const tty = line.slice(spaceIdx + 1).trim();
      if (!tty || Number.isNaN(activity)) continue;
      if (activity > bestActivity) {
        bestActivity = activity;
        bestTty = tty;
      }
    }
    return bestTty;
  } catch {
    return null;
  }
}
