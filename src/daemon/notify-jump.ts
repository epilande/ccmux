/**
 * Shared "jump to the session" routing for notification default-click and
 * D-Bus `ActionInvoked`: a bound session switches its tmux client to the
 * pane; a background/unbound one opens the picker popup on the
 * most-recently-active client. Both `notify-delivery.ts`'s D-Bus callback and
 * the `/notification-action` handler's `default` action run this in-process
 * (no `sh -c` wrapper needed, we are already in the daemon).
 *
 * The popup gets the resolved tty handed to it as `--client-tty`, not just as
 * `-c`. `-c` decides which client the popup DRAWS on; the picker inside it
 * still has to know which client to switch, and asking tmux from inside a
 * popup returns whichever other attached client typed last. Passing it as the
 * picker's own option needs no `display-popup -e` and therefore no tmux 3.3
 * floor: every flag on this line exists in 3.2.
 */

import type { SpawnFn } from "../lib/notify";
import { tmuxArgvFor } from "../lib/tmux-exec";

export interface JumpTarget {
  /** True for paneless background-agent sessions (route to the popup). */
  background: boolean;
  /** The session's stable `%N` pane, or null when unbound. */
  pane: string | null;
}

export interface JumpDeps {
  resolveActiveClientTty: () => Promise<string | null>;
  tmuxPath: string;
  /** Absolute `ccmux` path for the popup path; null omits the popup jump (a
   *  bound-pane jump never needs it). */
  ccmuxPath: string | null;
  spawn: SpawnFn;
  log: (message: string, error?: unknown) => void;
  /**
   * Raises the terminal app hosting the tmux client to the foreground after a
   * jump (macOS `open -b <bundleId>`), so a click on a buried terminal actually
   * surfaces it. Optional and platform-scoped: only the darwin wiring provides
   * it; the Linux/D-Bus path leaves it undefined (a `tmux switch-client` there
   * needs no app activation). Fail-open: its own errors are swallowed by the
   * caller.
   */
  activateTerminal?: () => Promise<void>;
}

/**
 * Perform the jump for `target`. Background/unbound sessions open
 * `display-popup -c <tty> -E <ccmux> --client-tty <tty>`; bound sessions run
 * `switch-client -c <tty> -t <pane>`. Fail-open: any missing client tty or
 * spawn error is swallowed (logged), never thrown.
 *
 * The popup command is passed as separate argv, never as one shell string:
 * with more than one positional argument tmux execs it directly, so the tty
 * reaches the picker without a shell to quote it past.
 */
export async function performJump(
  target: JumpTarget,
  deps: JumpDeps,
): Promise<void> {
  try {
    const clientTty = await deps.resolveActiveClientTty();
    if (!clientTty) return;

    if (target.background || !target.pane) {
      if (!deps.ccmuxPath) return;
      deps.spawn(
        tmuxArgvFor(
          deps.tmuxPath,
          "display-popup",
          "-c",
          clientTty,
          "-E",
          deps.ccmuxPath,
          "--client-tty",
          clientTty,
        ),
        { stdout: "ignore", stderr: "ignore" },
      );
      await deps.activateTerminal?.();
      return;
    }

    deps.spawn(
      tmuxArgvFor(
        deps.tmuxPath,
        "switch-client",
        "-c",
        clientTty,
        "-t",
        target.pane,
      ),
      { stdout: "ignore", stderr: "ignore" },
    );
    await deps.activateTerminal?.();
  } catch (error) {
    deps.log("Notifier: jump action failed", error);
  }
}
