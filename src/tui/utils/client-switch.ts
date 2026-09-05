import {
  hasCapturedTmuxClientTty,
  resolvePinnedTmuxClientTty,
} from "../../lib/tmux-client";
import { tmuxArgv } from "../../lib/tmux-exec";

export type SwitchToPaneResult = true | "client-unavailable" | "switch-failed";

export interface SwitchToPaneOptions {
  /**
   * The launcher already decided this is a popup on a legacy binding with
   * more than one client attached (`legacyPopupBinding`). `#{client_tty}`
   * then names the OTHER client that typed last, not us: refuse rather
   * than guess. A captured tty, or an uncaptured launch in a real pane /
   * with a single client, still uses the existing path.
   */
  refuseUncapturedGuess?: boolean;
}

export async function switchToPane(
  target: string,
  options?: SwitchToPaneOptions,
): Promise<SwitchToPaneResult> {
  // Check captured-ness BEFORE the #{client_tty} fallback: that query is
  // the guess we are refusing, and spawning it would move nothing but
  // still looks like we tried.
  if (options?.refuseUncapturedGuess && !hasCapturedTmuxClientTty()) {
    return "client-unavailable";
  }

  const { tty } = await resolvePinnedTmuxClientTty();
  if (!tty) return "client-unavailable";

  try {
    const proc = Bun.spawn(tmuxArgv("switch-client", "-c", tty, "-t", target), {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    return exitCode === 0 ? true : "switch-failed";
  } catch {
    return "switch-failed";
  }
}
