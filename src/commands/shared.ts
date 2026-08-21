import {
  isDaemonRunningAsync,
  waitForDaemon,
  spawnDaemonBackground,
  stopDaemonByPort,
  findDaemonPidByPort,
  getProcessCommand,
} from "../daemon";
import { DAEMON_PORT, getDaemonUrl } from "../lib/config";
import { daemonBody } from "../lib/daemon-json";

/**
 * Evict any zombie on the daemon port, spawn a fresh daemon, wait for health.
 * Shared by every auto-start path so they behave identically. Exits on failure,
 * surfacing the port holder's PID/command line instead of a silent error.
 */
export async function launchDaemon(): Promise<void> {
  const evicted = await stopDaemonByPort();
  if (evicted) {
    // let the killed listener's socket release before we bind
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  spawnDaemonBackground();

  if (await waitForDaemon()) return;

  const blockerPid = await findDaemonPidByPort();
  if (blockerPid) {
    const cmd = await getProcessCommand(blockerPid);
    console.error(
      `Daemon port ${DAEMON_PORT} is held by PID ${blockerPid}` +
        (cmd ? `: ${cmd}` : ""),
    );
  }
  console.error("Failed to start daemon");
  process.exit(1);
}

/**
 * Ensure the daemon is running, starting it if necessary.
 * Exits the process if the daemon cannot be started.
 */
export async function ensureDaemon(): Promise<void> {
  if (await isDaemonRunningAsync()) return;

  console.error("Starting daemon...");
  await launchDaemon();
}

/**
 * Fetch the daemon `/health` summary and print sessions / clients / uptime,
 * each line prefixed with `indent`. Shared by `ccmux status` and `ccmux
 * daemon status`, which differ only in indentation.
 */
export async function printDaemonHealth(indent = ""): Promise<void> {
  try {
    const response = await fetch(`${getDaemonUrl()}/health`);
    if (response.ok) {
      const health = await daemonBody<{
        sessions: number;
        clients: number;
        uptime: number;
      }>(response, "health");
      console.log(`${indent}Sessions: ${health.sessions}`);
      console.log(`${indent}Connected clients: ${health.clients}`);
      console.log(`${indent}Uptime: ${Math.round(health.uptime)}s`);
    }
  } catch {
    console.log(`${indent}Could not fetch health info`);
  }
}
