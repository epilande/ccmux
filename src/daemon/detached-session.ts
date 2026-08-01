import { tmuxArgv } from "../lib/tmux-exec";

/**
 * Create a detached tmux session for ccmux invocations.
 * Returns the pane id of the new session's only pane, or null on failure.
 */
export async function createDetachedTmuxSession(
  sessionName: string,
  cwd: string,
): Promise<{ paneId: string } | null> {
  try {
    const proc = Bun.spawn(
      tmuxArgv(
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        cwd,
        "-P",
        "-F",
        "#{pane_id}",
      ),
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const paneId = output.trim();
    if (!paneId) return null;
    return { paneId };
  } catch {
    return null;
  }
}

/**
 * Sweep orphan `ccmux-invoke-*` tmux sessions left behind by a daemon
 * that exited mid-invocation (SIGKILL, crash, OOM). The detached agent
 * inside would otherwise keep running and burn the user's subscription
 * quota until they noticed it in `tmux ls`. Returns the number of
 * sessions killed; errors are swallowed (best-effort cleanup).
 */
export async function sweepOrphanInvokeSessions(): Promise<number> {
  try {
    const list = Bun.spawn(tmuxArgv("list-sessions", "-F", "#{session_name}"), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(list.stdout).text();
    await list.exited;
    const orphans = out
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.startsWith("ccmux-invoke-"));
    await Promise.all(orphans.map((name) => killTmuxSession(name)));
    return orphans.length;
  } catch {
    return 0;
  }
}

/**
 * Kill a tmux session by name. Errors are swallowed (session may already
 * be gone). No-op if the session does not exist.
 */
export async function killTmuxSession(sessionName: string): Promise<void> {
  try {
    const proc = Bun.spawn(tmuxArgv("kill-session", "-t", sessionName), {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } catch {
    /* swallow */
  }
}
