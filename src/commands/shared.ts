import {
  isDaemonRunningAsync,
  waitForDaemon,
  spawnDaemonBackground,
  stopDaemonByPort,
  findDaemonPidByPort,
  getProcessCommand,
} from "../daemon";
import {
  DAEMON_INFO_TIMEOUT_MS,
  DAEMON_PORT,
  getDaemonUrl,
} from "../lib/config";
import { daemonBody } from "../lib/daemon-json";
import {
  BUILD_IDENTITY,
  classifyDaemonBuild,
  parseBuildIdentity,
  type BuildIdentity,
  type BuildVerdict,
} from "../lib/build-identity";

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
 * What the auto-start path learned about the running daemon, with no side
 * effects yet. `settleDaemon` turns it into a launch, a restart, or nothing.
 */
export interface DaemonProbe {
  alive: boolean;
  /** Fail-open: an unreadable `/server-info` reads as `current`. */
  verdict: BuildVerdict;
  daemonBuild: BuildIdentity | null;
  /**
   * Only measured for an `outdated` daemon. `handoffs` is null when the daemon
   * predates the `busy` field and the count came from `/invocations`; the
   * whole thing is null when the daemon could not be asked (treated as busy,
   * fail safe: never kill a daemon that may be mid-invocation).
   */
  busy: { invocations: number; handoffs: number | null } | null;
}

export interface ReconcileDeps {
  isAlive: () => Promise<boolean>;
  /** GET `<daemon>/<path>` within `timeoutMs`; resolves status + JSON body or throws. */
  getJson: (
    path: string,
    timeoutMs: number,
  ) => Promise<{ status: number; body: unknown }>;
  launch: () => Promise<void>;
  cli: BuildIdentity;
  /** Progress line channel ("Starting daemon...", "restarting..."). */
  log: (line: string) => void;
  /** Warning channel (outdated-but-busy). */
  warn: (line: string) => void;
}

export type ReconcileOutcome =
  | "started"
  | "kept"
  | "restarted"
  | "busy"
  | "raced";

async function getDaemonJson(
  path: string,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${getDaemonUrl()}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

export function defaultReconcileDeps(
  overrides: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  return {
    isAlive: isDaemonRunningAsync,
    getJson: getDaemonJson,
    launch: launchDaemon,
    cli: BUILD_IDENTITY,
    log: (line) => console.error(line),
    warn: (line) => console.error(line),
    ...overrides,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One `/server-info` read, classified; `current` when the read fails. */
async function readBuild(deps: ReconcileDeps): Promise<{
  verdict: BuildVerdict;
  build: BuildIdentity | null;
  info: unknown;
}> {
  let info: unknown;
  try {
    ({ body: info } = await deps.getJson(
      "/server-info",
      DAEMON_INFO_TIMEOUT_MS,
    ));
  } catch {
    // Slow or unreadable: a live daemon is never evicted on a failed read.
    return { verdict: "current", build: null, info: null };
  }
  const build = isRecord(info) ? info.build : undefined;
  return {
    verdict: classifyDaemonBuild(build, deps.cli),
    build: parseBuildIdentity(build),
    info,
  };
}

/** Running-invocation count from `GET /invocations`, or null if unknowable. */
async function countRunningInvocations(
  deps: ReconcileDeps,
): Promise<number | null> {
  try {
    const { status, body } = await deps.getJson(
      "/invocations",
      DAEMON_INFO_TIMEOUT_MS,
    );
    // A daemon too old to have the endpoint cannot be running an invocation.
    if (status === 404) return 0;
    if (status !== 200 || !isRecord(body) || !Array.isArray(body.invocations)) {
      return null;
    }
    return body.invocations.filter(
      (record: unknown) => isRecord(record) && record.status === "running",
    ).length;
  } catch {
    return null;
  }
}

async function measureBusy(
  deps: ReconcileDeps,
  info: unknown,
): Promise<DaemonProbe["busy"]> {
  const busy = isRecord(info) ? info.busy : undefined;
  if (
    isRecord(busy) &&
    typeof busy.invocations === "number" &&
    typeof busy.handoffs === "number"
  ) {
    return { invocations: busy.invocations, handoffs: busy.handoffs };
  }
  const invocations = await countRunningInvocations(deps);
  return invocations === null ? null : { invocations, handoffs: null };
}

/**
 * Liveness plus a best-effort build comparison, no side effects. `/health`
 * on its short budget is the ONLY thing that decides an unreachable daemon;
 * the `/server-info` read gets its own longer budget and fails open.
 */
export async function probeDaemon(
  deps: ReconcileDeps = defaultReconcileDeps(),
): Promise<DaemonProbe> {
  if (!(await deps.isAlive())) {
    return { alive: false, verdict: "current", daemonBuild: null, busy: null };
  }
  const { verdict, build, info } = await readBuild(deps);
  const busy = verdict === "outdated" ? await measureBusy(deps, info) : null;
  return { alive: true, verdict, daemonBuild: build, busy };
}

function isIdle(busy: DaemonProbe["busy"]): boolean {
  return busy !== null && busy.invocations === 0 && (busy.handoffs ?? 0) === 0;
}

function describeBusy(busy: DaemonProbe["busy"]): string {
  if (busy === null) return "could not read its invocations";
  const parts = [`${busy.invocations} running invocations`];
  if (busy.handoffs !== null) parts.push(`${busy.handoffs} queued handoffs`);
  return parts.join(", ");
}

/**
 * Act on a probe: start a missing daemon, replace an outdated idle one, warn
 * about an outdated busy one, leave a current or foreign one alone (foreign is
 * another checkout on the same version; see `build-identity.ts`).
 */
export async function settleDaemon(
  probe: DaemonProbe,
  deps: ReconcileDeps = defaultReconcileDeps(),
): Promise<ReconcileOutcome> {
  if (!probe.alive) {
    deps.log("Starting daemon...");
    await deps.launch();
    return "started";
  }
  if (probe.verdict !== "outdated") return "kept";
  if (!isIdle(probe.busy)) {
    deps.warn(
      `Daemon is outdated but busy (${describeBusy(probe.busy)}); ` +
        "run `ccmux daemon restart` when it is free.",
    );
    return "busy";
  }
  deps.log("Daemon is outdated; restarting...");
  // Another CLI may have replaced it between the probe and now. Re-read once
  // right before the kill; a daemon that is no longer outdated stays.
  const { verdict } = await readBuild(deps);
  if (verdict !== "outdated") return "raced";
  await deps.launch();
  return "restarted";
}

/** `probeDaemon` then `settleDaemon`, for callers with nothing to overlap. */
export async function reconcileDaemon(
  deps: ReconcileDeps = defaultReconcileDeps(),
): Promise<ReconcileOutcome> {
  return settleDaemon(await probeDaemon(deps), deps);
}

/**
 * Ensure a daemon running THIS build is serving, starting or replacing one
 * as needed (an outdated daemon is only replaced when idle).
 * Exits the process if the daemon cannot be started.
 */
export async function ensureDaemon(): Promise<void> {
  await reconcileDaemon();
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
