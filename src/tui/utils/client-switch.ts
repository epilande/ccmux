import {
  CLIENT_TTY_PATTERN,
  resolveCurrentTmuxClientTty,
} from "../../lib/tmux-client";
import { tmuxArgv } from "../../lib/tmux-exec";

export type SwitchToPaneResult = true | "client-unavailable" | "switch-failed";

export async function switchToPane(
  target: string,
): Promise<SwitchToPaneResult> {
  const capturedClientTty = process.env.CCMUX_CLIENT_TTY;
  const clientTty =
    capturedClientTty === undefined
      ? await resolveCurrentTmuxClientTty()
      : capturedClientTty;
  if (!clientTty || !CLIENT_TTY_PATTERN.test(clientTty)) {
    return "client-unavailable";
  }

  try {
    const proc = Bun.spawn(
      tmuxArgv("switch-client", "-c", clientTty, "-t", target),
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
