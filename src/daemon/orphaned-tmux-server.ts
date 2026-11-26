/**
 * A tmux server that is still running after its socket FILE was deleted.
 *
 * The server keeps its listening socket open, so its attached clients go on
 * working, but nothing new can connect: every `tmux` command (and so every
 * ccmux scan) fails with "error connecting to <path> (No such file or
 * directory)", exactly as if no server were running. tmux has a documented way
 * back (SIGUSR1 makes the server recreate the socket), but only if you can tell
 * the two cases apart and know which pid to signal.
 *
 * This module tells them apart. It runs only on that ENOENT error, asks lsof
 * which tmux process still holds a unix socket bound to that path, and returns
 * its pid. It never signals anything: what to do with the pid is the user's
 * call, surfaced as a copyable command (`socketRecoveryHint`).
 */

/** tmux's connect failure for a socket path that does not exist. */
const MISSING_SOCKET_RE =
  /error connecting to (.+) \(No such file or directory\)/;

/** lsof is fast here (one filtered pass, ~20ms), but it must never stall a
 *  `/server-info` response on a wedged system. */
const LSOF_TIMEOUT_MS = 3000;

/** The socket path a tmux "missing socket" error names, or null when the error
 *  is anything else (a refused connection means the file exists and nobody is
 *  listening, which is a dead server, not an orphaned one). */
export function missingSocketPath(message: string): string | null {
  return MISSING_SOCKET_RE.exec(message)?.[1]?.trim() || null;
}

/**
 * macOS resolves `/tmp` and `/var` through the `/private` symlink, and the two
 * sides of the comparison disagree on spelling: tmux reports (and binds) the
 * resolved path, but a label whose directory was deleted can only be spelled
 * unresolved by `attemptedTmuxSocketPath()`. Compare without the prefix.
 */
function canonicalSocketPath(path: string): string {
  return path.replace(/^\/private(?=\/(?:tmp|var)\/)/, "");
}

/**
 * The distinct pids that hold a unix socket bound to `socketPath`, from
 * `lsof -F pn` output (`p<pid>` starts a process, `n<name>` names each of its
 * files). A server holds the path on more than one fd, and its clients'
 * sockets show as `->0x...` peers rather than a path, so they never match.
 */
export function parseSocketHolders(
  lsofOutput: string,
  socketPath: string,
): number[] {
  const target = canonicalSocketPath(socketPath);
  const pids = new Set<number>();
  let pid: number | null = null;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } else if (
      line.startsWith("n") &&
      pid !== null &&
      canonicalSocketPath(line.slice(1)) === target
    ) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/** Runs lsof and returns its stdout, or null when it is missing or fails. */
export type LsofRunner = (args: string[]) => Promise<string | null>;

const runLsof: LsofRunner = async (args) => {
  try {
    const proc = Bun.spawn(["lsof", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: LSOF_TIMEOUT_MS,
    });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    // lsof exits 1 when nothing matched, which is a real answer (no holder).
    return code === 0 || code === 1 ? out : null;
  } catch {
    // Not installed (common on minimal Linux images): no hint, never an error.
    // Silent, because this runs on every `/server-info` while tmux is down.
    return null;
  }
};

/**
 * The pid of the tmux server orphaned from its socket, when `message` is a
 * missing-socket error and exactly one tmux process still holds that path.
 * Null otherwise, including when lsof is unavailable or more than one process
 * matches: a hint naming the wrong pid is worse than no hint.
 */
export async function findOrphanedTmuxServer(
  message: string,
  run: LsofRunner = runLsof,
): Promise<number | null> {
  const socketPath = missingSocketPath(message);
  if (!socketPath) return null;
  const out = await run(["-U", "-a", "-c", "tmux", "-F", "pn"]);
  if (out === null) return null;
  const holders = parseSocketHolders(out, socketPath);
  return holders.length === 1 ? holders[0]! : null;
}
