import {
  readFileSync,
  unlinkSync,
  existsSync,
  openSync,
  closeSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";
import { spawn } from "child_process";
import {
  LOG_FILE,
  getDaemonUrl,
  DAEMON_PORT,
  HEALTH_CHECK_TIMEOUT_MS,
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

/**
 * Liveness via HTTP /health, never the PID file alone: a dead daemon's PID can
 * be recycled by an unrelated process, a false positive that would suppress
 * auto-start (e.g. `ccmux picker`).
 */
export async function isDaemonRunningAsync(): Promise<boolean> {
  try {
    const response = await fetch(`${getDaemonUrl()}/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (response.ok) return true;
  } catch {
    // daemon unreachable (fetch rejects) -> treat as not running
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
 * Spawn daemon process in background (detached)
 */
export function spawnDaemonBackground(): void {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  const daemonArgs = isStandaloneBinary(process.argv[1])
    ? ["daemon", "start"]
    : [process.argv[1], "daemon", "start"];
  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
}

/**
 * Find daemon PID by checking what process is listening on the daemon port
 * Uses -sTCP:LISTEN to only find the server, not client connections
 */
export async function findDaemonPidByPort(): Promise<number | null> {
  try {
    const proc = Bun.spawn(
      ["lsof", "-ti", `tcp:${DAEMON_PORT}`, "-sTCP:LISTEN"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const output = await new Response(proc.stdout).text();
    const pid = parseInt(output.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
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
 * Stop the daemon holding the port, PID-reuse-safe: only ever signals the
 * confirmed port LISTENer (via findDaemonPidByPort), never the PID-file PID,
 * which may have been recycled by an unrelated live process. Safe to call
 * whenever /health is unreachable (the auto-start path does).
 */
export async function stopDaemonByPort(): Promise<boolean> {
  const pid = await findDaemonPidByPort();
  if (!pid) {
    removeStalePidFile(); // no listener -> no daemon; clear stale state only
    return false;
  }

  if (!(await isKillableDaemonPid(pid))) return false; // foreign squatter

  const killed = await killAndVerify(pid);
  removeStalePidFile();
  return killed;
}
