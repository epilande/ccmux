import { resolvePinnedTmuxClientTty } from "../../lib/tmux-client";
import { tmuxArgv } from "../../lib/tmux-exec";

export type SwitchToPaneResult = true | "client-unavailable" | "switch-failed";

export async function switchToPane(
  target: string,
): Promise<SwitchToPaneResult> {
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
