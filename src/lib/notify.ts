/**
 * Notification backend resolution + delivery.
 *
 * Dependency-free (no daemon imports) so both the daemon notifier and the
 * `ccmux notify` command can share the exact same delivery path, and so the
 * TUI could reuse it later without pulling in daemon internals. Every I/O
 * entry point (`which`, `spawn`) is injectable for tests.
 */

export type Backend =
  | "terminal-notifier"
  | "osascript"
  | "notify-send"
  | "dbus"
  | "command";

export type NotificationEventKind = "waiting" | "finished";

/**
 * Subset of the (future) `notifications` preferences section that backend
 * resolution needs. Kept local rather than imported from
 * `src/lib/preferences.ts` since that section hasn't landed yet; a later
 * stage can fold this into `NotificationsConfig` without changing this
 * module's callers.
 */
export interface NotifyConfig {
  backend?: "auto" | Backend;
}

/**
 * Everything `deliver` needs to build argv for any backend. Click-action and
 * "command" backend fields are resolved by the caller (the daemon notifier
 * or `ccmux notify`), which has access to config/session data this module
 * doesn't know about.
 */
export interface NotificationPayload {
  title: string;
  subtitle?: string;
  body: string;
  event: NotificationEventKind;
  sessionId: string;
  agent: string;
  project: string;
  branch?: string | null;
  pane?: string | null;
  /**
   * True for paneless background-agent sessions. `pane` alone is ambiguous
   * for this (a soft-evicted pane-tracked session also has `pane: null`), so
   * the daemon's click-action enrichment (`src/daemon/notify-delivery.ts`)
   * uses this to route background sessions to the picker-popup click target
   * instead of a pane jump.
   */
  background?: boolean;
  /** `true` maps to the platform default sound; a string names a sound. */
  sound?: boolean | string;
  /** terminal-notifier only: bundle id to focus on click (`-activate`). */
  activateBundleId?: string;
  /** terminal-notifier only: shell command to run on click (`-execute`). */
  executeCommand?: string;
  /** terminal-notifier only: bundle id whose icon to borrow (`-sender`). */
  senderBundleId?: string;
  /** backend "command" only: the user's configured shell command. */
  command?: string;
}

export interface SpawnOptions {
  stdout?: "ignore" | "pipe" | "inherit";
  stderr?: "ignore" | "pipe" | "inherit";
  env?: Record<string, string>;
}

export type SpawnFn = (
  argv: string[],
  options?: SpawnOptions,
) => { exited: Promise<number>; kill?: () => void };

const PROBE_TIMEOUT_MS = 1000;
export const DELIVER_TIMEOUT_MS = 3000;

/** "dbus" has no spawn-based probe (it's a connection, not a binary) — its
 * own probe lives on `DbusNotifier.probe()` (`src/lib/notify-dbus.ts`),
 * consulted before this module's `probeBackend` ever would be. */
const PROBE_ARGV: Record<Exclude<Backend, "command" | "dbus">, string[]> = {
  osascript: ["osascript", "-e", "return 0"],
  "terminal-notifier": ["terminal-notifier", "-help"],
  "notify-send": ["notify-send", "--version"],
};

/**
 * Resolves the backend to use. `"auto"` (the default) walks the ladder:
 * darwin -> terminal-notifier if on PATH, else osascript; linux -> dbus
 * (click-to-jump capable; the daemon falls back to notify-send if the dbus
 * probe fails, see `src/daemon/notify-delivery.ts`); anything else ->
 * disabled. An explicit non-"auto" backend always wins, regardless of
 * platform.
 */
export function resolveBackend(
  config: NotifyConfig,
  platform: NodeJS.Platform = process.platform,
  which: (cmd: string) => string | null = Bun.which,
): Backend | null {
  const backend = config.backend ?? "auto";
  if (backend !== "auto") return backend;

  if (platform === "darwin") {
    return which("terminal-notifier") !== null
      ? "terminal-notifier"
      : "osascript";
  }
  if (platform === "linux") {
    return "dbus";
  }
  return null;
}

/**
 * Runs `argv`, resolving on exit or on `timeoutMs`, whichever comes first.
 * On timeout, best-effort `kill()` is fired but NOT awaited: a process that
 * ignores its kill signal (e.g. a user "command" backend) would otherwise
 * strand this promise forever. The late `exited` settlement (from a process
 * that eventually does exit, or that later rejects) is swallowed once the
 * timeout has already resolved, so it never surfaces as an unhandled
 * rejection.
 */
async function runWithTimeout(
  argv: string[],
  timeoutMs: number,
  spawn: SpawnFn,
  options?: SpawnOptions,
): Promise<number> {
  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawn(argv, options);
  } catch {
    return -1;
  }

  return new Promise<number>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill?.();
      } catch {
        // best-effort; we resolve 124 below regardless
      }
      resolve(124);
    }, timeoutMs);

    proc.exited
      .then((exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(exitCode);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(-1);
      });
  });
}

/**
 * Probes that the resolved backend's binary actually works, run once before
 * the first delivery. `"command"` runs an arbitrary user command, so there's
 * nothing safe to probe; it always reports available. `"dbus"` similarly has
 * no spawn-based probe here — callers route it through `DbusNotifier.probe()`
 * instead (`ccmux notify`'s command handler, `notify-delivery.ts`'s
 * dispatcher) before ever reaching this function, so `true` is a harmless
 * default that's never actually relied on for dbus.
 */
export async function probeBackend(
  backend: Backend,
  spawn: SpawnFn = Bun.spawn as unknown as SpawnFn,
): Promise<boolean> {
  if (backend === "command" || backend === "dbus") return true;
  const exitCode = await runWithTimeout(
    PROBE_ARGV[backend],
    PROBE_TIMEOUT_MS,
    spawn,
  );
  return exitCode === 0;
}

/** `true` -> platform default sound name; falsy -> no sound; else passthrough. */
function resolveSoundName(sound: boolean | string | undefined): string | null {
  if (!sound) return null;
  return sound === true ? "default" : sound;
}

function buildOsascriptArgv(payload: NotificationPayload): string[] {
  const sound = resolveSoundName(payload.sound);
  const displayClause = sound
    ? "display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)"
    : "display notification (item 2 of argv) with title (item 1 of argv)";

  const argv = [
    "osascript",
    "-e",
    "on run argv",
    "-e",
    displayClause,
    "-e",
    "end run",
    // `--` ends osascript's own flag parsing: title/body/sound are
    // attacker-influenceable (title starts with the session's project name,
    // a directory basename) and a value like "-e ..." would otherwise be
    // consumed as another osascript flag instead of a script argument.
    "--",
    payload.title,
    payload.body,
  ];
  if (sound) argv.push(sound);
  return argv;
}

function buildTerminalNotifierArgv(payload: NotificationPayload): string[] {
  const argv = ["terminal-notifier", "-title", payload.title];
  if (payload.subtitle) argv.push("-subtitle", payload.subtitle);
  argv.push("-message", payload.body);
  argv.push("-group", `ccmux-${payload.sessionId}`);

  if (payload.senderBundleId) argv.push("-sender", payload.senderBundleId);
  const sound = resolveSoundName(payload.sound);
  if (sound) argv.push("-sound", sound);
  if (payload.activateBundleId)
    argv.push("-activate", payload.activateBundleId);
  if (payload.executeCommand) argv.push("-execute", payload.executeCommand);
  return argv;
}

function buildCommandEnv(payload: NotificationPayload): Record<string, string> {
  return {
    ...process.env,
    CCMUX_EVENT: payload.event,
    CCMUX_SESSION_ID: payload.sessionId,
    CCMUX_AGENT: payload.agent,
    CCMUX_PROJECT: payload.project,
    CCMUX_BRANCH: payload.branch ?? "",
    CCMUX_TITLE: payload.title,
    CCMUX_BODY: payload.body,
    CCMUX_PANE: payload.pane ?? "",
  };
}

/** Builds argv for `backend`, or `null` when there's nothing to run (e.g.
 * "command" backend with no configured command). */
function buildArgv(
  backend: Backend,
  payload: NotificationPayload,
): string[] | null {
  switch (backend) {
    case "osascript":
      return buildOsascriptArgv(payload);
    case "terminal-notifier":
      return buildTerminalNotifierArgv(payload);
    case "notify-send":
      // `--` guards the same class of bug as osascript above: a title
      // starting with `-` would otherwise parse as an option.
      return [
        "notify-send",
        "--app-name=ccmux",
        "--",
        payload.title,
        payload.body,
      ];
    case "command":
      return payload.command ? ["sh", "-c", payload.command] : null;
    case "dbus":
      // Connection-oriented, not spawn-oriented: real dispatch lives in
      // `src/daemon/notify-delivery.ts`'s `DbusNotifier`. A documented
      // no-op so a stray direct call to `deliver("dbus", ...)` fails safe
      // instead of throwing.
      return null;
  }
}

/**
 * Delivers one notification via `backend`. Fire-and-forget by design: stdout
 * and stderr are ignored, exit is awaited with a cap, and failures (spawn
 * throws, non-zero exit, timeout) are swallowed here. Callers that need to
 * disable the notifier on repeated failure should rely on {@link probeBackend}
 * up front rather than inspecting delivery outcomes.
 */
export async function deliver(
  backend: Backend,
  payload: NotificationPayload,
  spawn: SpawnFn = Bun.spawn as unknown as SpawnFn,
  timeoutMs: number = DELIVER_TIMEOUT_MS,
): Promise<void> {
  const argv = buildArgv(backend, payload);
  if (!argv) return;

  const options: SpawnOptions =
    backend === "command"
      ? { stdout: "ignore", stderr: "ignore", env: buildCommandEnv(payload) }
      : { stdout: "ignore", stderr: "ignore" };

  await runWithTimeout(argv, timeoutMs, spawn, options);
}
