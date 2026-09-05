import {
  resolvePinnedTmuxClientTty,
  type ClientTtyRefusal,
} from "../../lib/tmux-client";
import { tmuxArgv } from "../../lib/tmux-exec";

/**
 * True, or why nobody moved. The refusals come straight from the resolver so
 * the toast can name the actual problem: a broken binding, an old binding, and
 * a plain "no client here" are three different things to tell a user.
 */
export type SwitchToPaneResult = true | "switch-failed" | ClientTtyRefusal;

export async function switchToPane(
  target: string,
): Promise<SwitchToPaneResult> {
  const resolved = await resolvePinnedTmuxClientTty();
  if (resolved.tty === null) return resolved.refusal;

  try {
    const proc = Bun.spawn(
      tmuxArgv("switch-client", "-c", resolved.tty, "-t", target),
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const exitCode = await proc.exited;
    return exitCode === 0 ? true : "switch-failed";
  } catch {
    return "switch-failed";
  }
}
