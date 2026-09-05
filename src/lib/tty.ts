/**
 * Our own controlling terminal, shared by the two callers that need to know
 * which terminal this ccmux process is actually sitting on rather than which
 * client tmux thinks is current.
 */

/**
 * The pathname of the terminal on stdin (fd 0), or null when stdin is not a
 * tty. Resolve it while fd 0 is still the interactive terminal (before a TUI
 * renderer suspends), since that is what makes the answer meaningful.
 *
 * Deliberately our OWN device, not `#{client_tty}`: inside a `display-popup`
 * this is the popup job's pty, which belongs to no `window_pane`, and that
 * absence is the only reliable way to tell a popup from a real pane
 * (`TMUX_PANE` is not set by tmux for a popup and can be inherited from
 * whatever environment the tmux server was started in, pointing at a pane on
 * a different server entirely).
 */
export async function readOwnTty(
  log?: (message: string) => void,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tty"], {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const tty = stdout.trim();
    return tty.startsWith("/dev/") ? tty : null;
  } catch (err) {
    log?.(`tty resolution failed: ${err}`);
    return null;
  }
}
