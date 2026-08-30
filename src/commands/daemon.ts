import { Command } from "commander";
import { resolve } from "path";
import {
  startDaemon,
  stopDaemon,
  stopDaemonByPort,
  isDaemonRunning,
  isDaemonRunningAsync,
  getDaemonPid,
  findDaemonPidByPort,
  waitForDaemon,
  spawnDaemonBackground,
} from "../daemon";
import {
  DAEMON_PORT,
  DAEMON_HOST,
  LOG_FILE,
  getDaemonUrl,
} from "../lib/config";
import { printDaemonHealth } from "./shared";
import { daemonBody } from "../lib/daemon-json";
import {
  BUILD_IDENTITY,
  classifyDaemonBuild,
  parseBuildIdentity,
  type BuildIdentity,
} from "../lib/build-identity";
import type { TmuxSocketError } from "../types";

/**
 * Apply `--socket`/`--label` by exporting `CCMUX_TMUX_SOCKET`, which is what
 * both a foreground daemon and a `-b` one read (the backgrounded child
 * inherits this environment; a flag on this process would not reach it).
 * `--socket` is resolved to an absolute path because the env encoding reads a
 * leading "/" as "this is a path, not a label". It resolves against
 * `CCMUX_CALLER_PWD` (the real invocation directory `bin/ccmux` preserves
 * before cd'ing into the package root), so a relative path means what the user
 * typed rather than something inside the ccmux install.
 */
function applySocketFlags(options: { socket?: string; label?: string }): void {
  if (options.socket && options.label) {
    console.error("Use either --socket or --label, not both");
    process.exit(1);
  }
  if (options.label) {
    if (options.label.startsWith("/")) {
      console.error("--label takes a socket name; use --socket for a path");
      process.exit(1);
    }
    process.env.CCMUX_TMUX_SOCKET = options.label;
    return;
  }
  if (options.socket) {
    process.env.CCMUX_TMUX_SOCKET = resolve(
      process.env.CCMUX_CALLER_PWD ?? process.cwd(),
      options.socket,
    );
  }
}

/**
 * The tmux server the RUNNING daemon tracks, read from it rather than
 * re-resolved here: `ccmux daemon status` is a client process and may not share
 * the daemon's environment or config at all.
 */
async function printTmuxServer(): Promise<void> {
  try {
    const response = await fetch(`${getDaemonUrl()}/server-info`);
    if (!response.ok) return;
    const info = await daemonBody<{
      socketPath: string | null;
      socketError?: TmuxSocketError | null;
      build?: unknown;
    }>(response, "server info");
    if (info.socketPath) {
      console.log(`tmux socket: ${info.socketPath}`);
    } else {
      const error = info.socketError ?? null;
      console.log(
        `tmux socket: unreachable${error?.attemptedSocket ? ` at ${error.attemptedSocket}` : ""}` +
          (error ? ` (${error.message})` : ""),
      );
    }
    printBuild(info.build);
  } catch {
    // The health line below already covers an unreachable daemon.
  }
}

/**
 * The daemon's build next to this CLI's, and the verdict the auto-start path
 * would reach (`classifyDaemonBuild`). A daemon predating the field prints
 * as `none`, which is outdated by definition.
 */
function printBuild(daemonBuild: unknown): void {
  const daemon = parseBuildIdentity(daemonBuild);
  const cli = BUILD_IDENTITY;
  const describe = (b: BuildIdentity) =>
    `${b.version} ${b.artifact}${b.stamp ? ` (${b.stamp})` : ""}`;
  console.log(
    `Daemon build: ${daemon ? describe(daemon) : "none (predates build identity)"}`,
  );
  console.log(`CLI build: ${describe(cli)}`);
  const verdict = classifyDaemonBuild(daemonBuild, cli);
  if (verdict === "current") {
    console.log("Build: current");
  } else if (verdict === "foreign") {
    const reason =
      daemon && daemon.version !== cli.version
        ? `daemon ${daemon.version} is newer than this CLI ${cli.version}`
        : `same version ${cli.version}, different install`;
    console.log(
      `Build: foreign (${reason}); left alone, run ccmux daemon restart to switch`,
    );
  } else {
    console.log(
      `Build: OUTDATED (daemon ${daemon?.version ?? "unknown"}, cli ${cli.version}); ` +
        "replaced automatically when idle, or run ccmux daemon restart",
    );
  }
}

export function createDaemonCommand(): Command {
  const daemon = new Command("daemon").description("Manage the daemon process");

  daemon
    .command("start")
    .description("Start the daemon")
    .option("-b, --background", "Run in background")
    .option("--foreground", "Keep stdio on the TTY (skip log-file redirect)")
    .option("--socket <path>", "tmux socket path to track (tmux -S)")
    .option("--label <name>", "tmux socket label to track (tmux -L)")
    .action(async (options) => {
      applySocketFlags(options);

      if (isDaemonRunning()) {
        const pid = getDaemonPid();
        console.log(`Daemon is already running (PID: ${pid})`);
        process.exit(1);
      }

      // Detect orphaned daemon holding the port
      if (await isDaemonRunningAsync()) {
        console.log(
          "Detected orphaned daemon via health check, stopping it...",
        );
        await stopDaemonByPort();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      if (options.background) {
        spawnDaemonBackground();

        if (await waitForDaemon()) {
          const pid = getDaemonPid();
          console.log(`Daemon started in background (PID: ${pid})`);
        } else {
          console.error("Failed to start daemon");
          process.exit(1);
        }
      } else {
        if (options.foreground) process.env.CCMUX_DAEMON_FOREGROUND = "1";
        console.log(`Starting daemon on ${DAEMON_HOST}:${DAEMON_PORT}...`);
        if (!options.foreground) console.log(`Logs → ${LOG_FILE}`);
        await startDaemon();
      }
    });

  daemon
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      if (!isDaemonRunning()) {
        // Fallback: check health endpoint for orphaned daemon
        if (await isDaemonRunningAsync()) {
          console.log(
            "Detected orphaned daemon via health check, stopping it...",
          );
          const stopped = await stopDaemonByPort();
          if (stopped) {
            console.log("Daemon stopped");
          } else {
            console.error("Failed to stop orphaned daemon");
            process.exit(1);
          }
          return;
        }

        console.log("Daemon is not running");
        process.exit(1);
      }

      const stopped = await stopDaemon();
      if (stopped) {
        console.log("Daemon stopped");
      } else {
        console.error("Failed to stop daemon");
        process.exit(1);
      }
    });

  daemon
    .command("restart")
    .description("Restart the daemon")
    .action(async () => {
      const isRunningPid = isDaemonRunning();
      const isRunningHealth = await isDaemonRunningAsync();

      if (isRunningPid || isRunningHealth) {
        console.log("Stopping daemon...");
        if (!isRunningPid && isRunningHealth) {
          console.log("(Detected orphaned daemon via health check)");
        }
        await stopDaemonByPort();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      spawnDaemonBackground();

      if (await waitForDaemon()) {
        const pid = getDaemonPid();
        console.log(`Daemon restarted in background (PID: ${pid})`);
      } else {
        console.error("Failed to restart daemon");
        process.exit(1);
      }
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      // Use the async check so a live daemon with a missing or corrupt PID
      // file (detected via the `/health` endpoint) is still reported as
      // running, matching `daemon start` / `daemon stop` detection.
      if (!(await isDaemonRunningAsync())) {
        console.log("Daemon: stopped");
        return;
      }

      // Prefer the PID file; fall back to the port listener when the PID
      // file is missing (orphaned daemon).
      const pid = getDaemonPid() ?? (await findDaemonPidByPort());
      console.log(`Daemon: running (PID: ${pid ?? "unknown"})`);
      await printTmuxServer();
      await printDaemonHealth();
    });

  return daemon;
}
