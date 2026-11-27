import {
  readFileSync,
  unlinkSync,
  existsSync,
  openSync,
  closeSync,
  mkdirSync,
} from "fs";
import { dirname, resolve } from "path";
import { spawn } from "child_process";
import {
  LOG_FILE,
  getDaemonUrl,
  DAEMON_PORT,
  HEALTH_CHECK_TIMEOUT_MS,
  HEALTH_RETRY_TIMEOUT_MS,
  getPidFilePath,
} from "../lib/config";

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll until process dies, with timeout.
 */
async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

/**
 * Send signal, wait, verify death. Escalate to SIGKILL if needed.
 */
async function killAndVerify(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false; // Process already dead
  }

  if (await waitForDeath(pid, 2000)) return true;

  // Escalate to SIGKILL
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true; // Died between check and kill
  }

  await waitForDeath(pid, 1000);
  return true;
}

/**
 * Stop a running daemon by reading PID file
 */
export async function stopDaemon(): Promise<boolean> {
  const pidFile = getPidFilePath();

  if (!existsSync(pidFile)) {
    return false;
  }

  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

  const killed = await killAndVerify(pid);

  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }

  return killed;
}

/**
 * Check if daemon is running via PID file
 */
export function isDaemonRunning(): boolean {
  const pidFile = getPidFilePath();

  if (!existsSync(pidFile)) {
    return false;
  }

  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process not running, clean up stale PID file
    unlinkSync(pidFile);
    return false;
  }
}

/** Remove the PID file only if its PID is dead -- never touch a recycled live PID. */
function cleanupStalePidFile(): void {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) return;
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  if (Number.isNaN(pid) || !isProcessAlive(pid)) {
    unlinkSync(pidFile);
  }
}

/**
 * Unconditionally remove the PID file so a fresh daemon can start (`Daemon.start`
 * aborts if it names a live PID). Removing the file never signals that PID; only
 * call once no healthy daemon remains.
 */
function removeStalePidFile(): void {
  const pidFile = getPidFilePath();
  if (existsSync(pidFile)) unlinkSync(pidFile);
}

/** One `/health` GET on its own budget. Injectable so tests need no network. */
export type HealthFetch = (url: string, timeoutMs: number) => Promise<Response>;

const defaultHealthFetch: HealthFetch = (url, timeoutMs) =>
  fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

/**
 * Whether a failed `/health` probe deserves one longer retry.
 *
 * Only a TIMEOUT does. A timeout means the connection was accepted and the
 * answer did not arrive in budget, which is exactly what a daemon a few
 * hundred milliseconds into boot looks like, and reading it as "no daemon"
 * gets that healthy listener killed. Everything else must NOT retry: a
 * refused connection (measured in Bun as a plain `Error` with
 * `code: "ConnectionRefused"`, the same shape a DNS failure produces) is the
 * ordinary no-daemon case on the picker's cold path, and doubling its cost
 * would be paid on every cold start. An unrecognized shape is treated as a
 * refusal for the same reason.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError` DOMException here;
 * `AbortError` is accepted alongside it because nothing on this path aborts
 * for any other reason, so a runtime that spells it that way still gets the
 * retry rather than a kill.
 */
export function shouldRetryHealthProbe(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Liveness via HTTP /health, never the PID file alone: a dead daemon's PID can
 * be recycled by an unrelated process, a false positive that would suppress
 * auto-start (e.g. `ccmux picker`).
 *
 * A probe that TIMES OUT is retried once on a longer budget (see
 * `shouldRetryHealthProbe`); a refused one is not, so the no-daemon path keeps
 * its single short probe.
 */
export async function isDaemonRunningAsync(
  healthFetch: HealthFetch = defaultHealthFetch,
): Promise<boolean> {
  const url = `${getDaemonUrl()}/health`;
  try {
    const response = await healthFetch(url, HEALTH_CHECK_TIMEOUT_MS);
    if (response.ok) return true;
  } catch (error) {
    if (shouldRetryHealthProbe(error)) {
      try {
        const retried = await healthFetch(url, HEALTH_RETRY_TIMEOUT_MS);
        if (retried.ok) return true;
      } catch {
        // still unreachable after the longer budget -> not running
      }
    }
    // any other failure: daemon unreachable (fetch rejects) -> not running
  }
  cleanupStalePidFile();
  return false;
}

/**
 * Get daemon PID if running
 */
export function getDaemonPid(): number | null {
  const pidFile = getPidFilePath();

  if (!existsSync(pidFile)) {
    return null;
  }

  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * Wait for daemon to be fully operational
 * Polls for PID file and verifies health endpoint is responding
 */
export async function waitForDaemon(
  maxAttempts = 40,
  intervalMs = 50,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    if (isDaemonRunning()) {
      // Verify server is responding
      try {
        const response = await fetch(`${getDaemonUrl()}/health`, {
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
        });
        if (response.ok) return true;
      } catch {
        // Server not ready yet, continue polling
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * True when running as a `bun build --compile` standalone binary (execPath is
 * the ccmux binary, argv[1] an embedded `/$bunfs` path) rather than
 * `bun <script>` (execPath `bun`, argv[1] the real script). The daemon re-spawn
 * must forward the script path for `bun <script>` but not for a compiled binary
 * (whose embedded argv[1] would corrupt the re-spawn and the daemon would never start).
 */
export function isStandaloneBinary(
  argv1: string | undefined,
  execPath: string = process.execPath,
): boolean {
  const execName = execPath.split(/[\\/]/).pop() ?? "";
  if (execName !== "bun" && execName !== "bun.exe") return true;
  return (
    !argv1 || argv1.includes("$bunfs") || /^[A-Za-z]:[\\/]~BUN/i.test(argv1)
  );
}

/**
 * cwd at import, before the sidebar (or the daemon itself) chdirs away.
 * `bin/ccmux` execs `bun dist/index.js` so argv[1] is relative; resolve it
 * against this directory, not the cwd at spawn time.
 */
const SPAWN_CWD = process.cwd();

/**
 * argv for re-spawning this process as `daemon start`.
 *
 * `bin/ccmux` execs `bun dist/index.js` (or `bun src/index.ts`) so argv[1] is
 * relative. After an idle replace, `launchDaemon` has already killed the
 * listener; `spawnDaemonBackground` then re-spawns. The sidebar chdirs to
 * `CCMUX_CALLER_PWD` before `ensureDaemon()`, so a relative script would be
 * resolved from the caller's directory and bun would fail to start — leaving
 * no daemon and dropping SSE for every TUI. Resolve against `cwd` (the
 * directory at import, before any chdir). A compiled binary has no script
 * path to forward.
 */
export function daemonSpawnArgv(
  argv1: string | undefined,
  execPath: string,
  cwd: string,
): string[] {
  if (isStandaloneBinary(argv1, execPath)) return ["daemon", "start"];
  return [resolve(cwd, argv1!), "daemon", "start"];
}

/**
 * Spawn daemon process in background (detached)
 */
export function spawnDaemonBackground(): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  const daemonArgs = daemonSpawnArgv(
    process.argv[1],
    process.execPath,
    SPAWN_CWD,
  );
  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
}

/**
 * Who, if anyone, listens on the daemon port. `none` means a lookup tool RAN
 * and found no listener. `unknown` means nothing could say: no tool ran, or
 * one saw a listener it could not name (`ss` lists another user's socket
 * without its owner). A daemon may well be serving then, and
 * `stopDaemonByPort` must keep its pid file.
 */
type PortLookup =
  | { kind: "listener"; pid: number }
  | { kind: "none" }
  | { kind: "unknown" };

/** What one tool's output says: a pid, nothing, or a socket with no owner. */
type ToolAnswer = number | "none" | "unowned";

/** `lsof -ti` prints one pid per line. */
function parseLsof(output: string): ToolAnswer {
  const pid = parseInt(output.trim(), 10);
  return isNaN(pid) ? "none" : pid;
}

/**
 * `ss -p` names the owner as `users:(("bun",pid=1234,fd=11))`. The field is
 * only there for the caller's own sockets (or under root); the daemon runs as
 * the user, so a line without one is a listener that is not ours to name.
 */
function parseSs(output: string): ToolAnswer {
  const match = output.match(/\bpid=(\d+)/);
  if (match) return parseInt(match[1]!, 10);
  return output.trim() ? "unowned" : "none";
}

/**
 * Ask the OS who listens on the daemon port, from the live socket table and
 * never the pid file (which may name a recycled pid). Only LISTEN sockets
 * count, so a client connection is never mistaken for the server.
 *
 * `lsof` first (present by default on macOS), then `ss` (iproute2, on every
 * mainstream Linux, where `lsof` is an optional package). Without the
 * fallback such a machine never replaced an outdated daemon, and `ccmux
 * daemon restart` removed the live daemon's pid file. A tool that runs and
 * finds nothing still falls through, so a no-op `lsof` stub cannot hide `ss`;
 * that costs one extra spawn only when nothing is listening.
 *
 * Only a tool that exits 0 can confirm that nothing is listening. A pid it
 * names counts whatever its exit code, but an empty answer from a failed run
 * proves nothing: `lsof` exits 1 both for "no match" and for an error, so
 * without `ss` to confirm, a quiet `lsof` is `unknown`, not `none`. (`ss`
 * exits 0 when nothing matches.)
 */
async function lookupDaemonPort(): Promise<PortLookup> {
  const lookups: Array<[string[], (output: string) => ToolAnswer]> = [
    [["lsof", "-ti", `tcp:${DAEMON_PORT}`, "-sTCP:LISTEN"], parseLsof],
    [["ss", "-ltnpH", `sport = :${DAEMON_PORT}`], parseSs],
  ];
  let ranClean = false;
  let unowned = false;
  for (const [argv, parse] of lookups) {
    try {
      const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
      const answer = parse(await new Response(proc.stdout).text());
      if (typeof answer === "number") return { kind: "listener", pid: answer };
      if (((await proc.exited) ?? 0) !== 0) continue;
      if (answer === "unowned") unowned = true;
      else ranClean = true;
    } catch {
      // Not on PATH, or not spawnable: try the next tool.
    }
  }
  return { kind: ranClean && !unowned ? "none" : "unknown" };
}

/**
 * The LISTEN pid on the daemon port, or null when there is none or it cannot
 * be determined.
 */
export async function findDaemonPidByPort(): Promise<number | null> {
  const lookup = await lookupDaemonPort();
  return lookup.kind === "listener" ? lookup.pid : null;
}

/**
 * Return the full command line for a PID via `ps`, or null if it can't be read.
 */
export async function getProcessCommand(pid: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(["ps", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Whether a process holding the port may be killed. The daemon is always spawned
 * as `<runtime> <script> daemon start`, so the `daemon start` argv tail identifies
 * it across install paths. Fail-open on an unreadable cmd (preserve zombie
 * recovery); only spare a readable cmd that clearly isn't ours (foreign squatter).
 */
async function isKillableDaemonPid(pid: number): Promise<boolean> {
  const cmd = await getProcessCommand(pid);
  if (!cmd) return true; // unreadable -> fail open
  return /(^|\s)daemon\s+start(\s|$)/.test(cmd);
}

/**
 * Remove the PID file unless it names a live process that may be a ccmux
 * daemon (`isKillableDaemonPid`, fail-open on an unreadable command line).
 * Never signals anything. For when nothing could name the listener: a dead pid
 * is stale for certain, and so is a live one that is plainly something else
 * (a recycled pid, which would make the next `Daemon.start` refuse).
 */
async function removePidFileUnlessDaemon(): Promise<void> {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) return;
  const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  if (
    Number.isNaN(pid) ||
    !isProcessAlive(pid) ||
    !(await isKillableDaemonPid(pid))
  ) {
    unlinkSync(pidFile);
  }
}

/**
 * Stop the daemon holding the port, PID-reuse-safe: only ever signals the
 * confirmed port LISTENer (via `lookupDaemonPort`), never the PID-file PID,
 * which may have been recycled by an unrelated live process. Safe to call
 * whenever /health is unreachable (the auto-start path does).
 */
export async function stopDaemonByPort(expectedPid?: number): Promise<boolean> {
  const lookup = await lookupDaemonPort();
  if (lookup.kind === "unknown") {
    // Nothing could say who listens, so a daemon may still be serving: its
    // pid file stays unless it is provably stale.
    await removePidFileUnlessDaemon();
    return false;
  }
  if (lookup.kind === "none") {
    removeStalePidFile(); // no listener -> no daemon; clear stale state only
    return false;
  }
  const pid = lookup.pid;
  // A confirm-time snapshot: another CLI may have already replaced the
  // outdated listener with a current daemon. Never signal a different pid.
  if (expectedPid !== undefined && pid !== expectedPid) return false;

  if (!(await isKillableDaemonPid(pid))) return false; // foreign squatter

  const killed = await killAndVerify(pid);
  removeStalePidFile();
  return killed;
}

/**
 * The stop half of `ccmux daemon restart`. `still-running` means a daemon
 * still answers after the stop (its listener could not be found, or is not a
 * ccmux daemon), so the restart must not spawn: a second daemon would only
 * die on bind while the first keeps serving. Its pid file is left as it was,
 * so `ccmux daemon stop` still works.
 */
export async function stopForRestart(): Promise<"stopped" | "still-running"> {
  if (await stopDaemonByPort()) return "stopped";
  return (await isDaemonRunningAsync()) ? "still-running" : "stopped";
}
