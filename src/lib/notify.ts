/**
 * Notification backend resolution + delivery.
 *
 * Dependency-free (no daemon imports) so both the daemon notifier and the
 * `ccmux notify` command can share the exact same delivery path, and so the
 * TUI could reuse it later without pulling in daemon internals. Every I/O
 * entry point (`which`, `spawn`) is injectable for tests.
 */

import { existsSync, realpathSync } from "fs";
import { dirname, join } from "path";

export type Backend =
  | "ccmux-notifier"
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
  /** backend "command" only: the user's configured shell command. */
  command?: string;
  /**
   * ccmux-notifier only: absolute path to the resolved helper binary, stamped
   * by the daemon's delivery wrapper (`src/daemon/notify-delivery.ts`), which
   * resolves it via {@link resolveCcmuxNotifierBinary}. Absent for every other
   * backend; `buildCcmuxNotifierArgv` refuses to build without it.
   */
  notifierPath?: string;
  /**
   * ccmux-notifier only: the `/notification-action` callback URL the helper
   * POSTs to on a button/click. Stamped by the delivery wrapper (it owns the
   * daemon port); `buildCcmuxNotifierArgv` refuses to build without it.
   */
  callbackUrl?: string;
  /**
   * Staleness token echoed back in the notification-action callback so the
   * daemon can reject a button press whose session has moved on since the
   * notification fired (same `session.statusChangedAt` the debounce keys on).
   * Additive for the ccmux-notifier backend; other backends ignore it.
   */
  statusChangedAt?: string;
  /**
   * Approve/Deny action buttons for a `permission` wait (ccmux-notifier /
   * D-Bus only). Present only when the session's agent has a
   * `notificationActions` map; the ids round-trip to `/notification-action`.
   */
  actions?: Array<{ id: "approve" | "deny"; label: string }>;
  /**
   * Inline text-reply action for a `question` wait (ccmux-notifier / D-Bus
   * only). The typed text round-trips as `userText` to `/notification-action`.
   */
  reply?: { id: "answer"; label: string };
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
/**
 * ccmux-notifier gets its own, much longer cap: on a fresh install the helper
 * blocks in `requestAuthorization` for up to its own `kAuthTimeout` (180s)
 * before it can post — killing it mid-request drops the notification and can
 * even record a denial (see `notifier/Sources/main.swift`). Sit just above the
 * helper's 180s so the timeout only ever bites a genuinely wedged process;
 * once authorized the helper posts and exits in well under a second.
 */
export const NOTIFIER_DELIVER_TIMEOUT_MS = 190_000;

/** "dbus" has no spawn-based probe (it's a connection, not a binary) — its
 * own probe lives on `DbusNotifier.probe()` (`src/lib/notify-dbus.ts`),
 * consulted before this module's `probeBackend` ever would be. */
const PROBE_ARGV: Record<
  Exclude<Backend, "command" | "dbus" | "ccmux-notifier">,
  string[]
> = {
  osascript: ["osascript", "-e", "return 0"],
  "notify-send": ["notify-send", "--version"],
};

/** Bundle layout of the notarized helper: `<app>.app/Contents/MacOS/<bin>`. */
const NOTIFIER_APP_NAME = "ccmux-notifier.app";
const NOTIFIER_INNER_BINARY = join("Contents", "MacOS", "ccmux-notifier");

export interface CcmuxNotifierResolveDeps {
  env?: NodeJS.ProcessEnv;
  /** Absolute path to the `ccmux` binary, for the brew-sibling rung. */
  ccmuxPath?: string | null;
  which?: (cmd: string) => string | null;
  exists?: (path: string) => boolean;
}

/**
 * Resolves the ccmux-notifier helper binary, in priority order:
 *   1. `CCMUX_NOTIFIER_PATH` — points at either the `.app` bundle or the inner
 *      binary; normalized to the inner binary. An explicit override that
 *      doesn't exist resolves to `null` (it never silently falls through to a
 *      different install).
 *   2. Sibling of the `ccmux` binary: `<dir>/../libexec/ccmux-notifier.app/...`
 *      — the Homebrew formula's `libexec` layout.
 *   3. `ccmux-notifier` on PATH — dev builds / manual installs.
 * `null` when none resolve; the caller falls down the backend ladder (to
 * osascript on darwin) rather than erroring.
 */
export function resolveCcmuxNotifierBinary(
  deps: CcmuxNotifierResolveDeps = {},
): string | null {
  const env = deps.env ?? process.env;
  const which = deps.which ?? Bun.which;
  const exists = deps.exists ?? existsSync;

  const envPath = env.CCMUX_NOTIFIER_PATH;
  if (envPath) {
    const candidate = envPath.endsWith(".app")
      ? join(envPath, NOTIFIER_INNER_BINARY)
      : envPath;
    return exists(candidate) ? candidate : null;
  }

  if (deps.ccmuxPath) {
    // `ccmux` in a Homebrew prefix is a symlink into the versioned Cellar keg
    // (`Cellar/ccmux/<v>/bin/ccmux`), where the helper is staged in the keg's
    // `libexec` — not linked into the prefix. Resolve the real path first so
    // the lexical `../libexec` join lands in the keg, not the prefix's `bin`.
    // Fail-open: a broken/missing symlink keeps the un-resolved path.
    let realCcmuxPath = deps.ccmuxPath;
    try {
      realCcmuxPath = realpathSync(deps.ccmuxPath);
    } catch {
      // keep the un-resolved path
    }
    const sibling = join(
      dirname(realCcmuxPath),
      "..",
      "libexec",
      NOTIFIER_APP_NAME,
      NOTIFIER_INNER_BINARY,
    );
    if (exists(sibling)) return sibling;
  }

  return which("ccmux-notifier");
}

/**
 * Resolves the backend to use. `"auto"` (the default) walks the ladder:
 * darwin -> ccmux-notifier (the delivery layer falls to osascript when the
 * helper isn't resolvable, mirroring dbus -> notify-send on linux); linux ->
 * dbus (click-to-jump capable; the daemon falls back to notify-send if the
 * dbus probe fails, see `src/daemon/notify-delivery.ts`); anything else ->
 * disabled. An explicit non-"auto" backend always wins, regardless of
 * platform.
 *
 * The legacy `"terminal-notifier"` value (removed in v2) is not in
 * {@link Backend}; a config still carrying it is normalized to `"auto"` by
 * the callers before it reaches here (fail-open, see `notifications.backend`).
 */
/** Backends removed in v2 (v1 config values that must not hard-error). */
const REMOVED_BACKENDS = new Set(["terminal-notifier"]);

/**
 * Normalizes a raw configured backend value read from `ccmux.json` (untyped at
 * runtime). A removed v1 backend (`terminal-notifier`) maps to `undefined` (→
 * the auto ladder) and is reported via `removed` so the caller can log it once
 * — the plan's fail-open requirement. Any other value passes through.
 */
export function normalizeBackendConfig(raw: unknown): {
  backend: NotifyConfig["backend"];
  removed: string | null;
} {
  if (typeof raw === "string" && REMOVED_BACKENDS.has(raw)) {
    return { backend: undefined, removed: raw };
  }
  return { backend: raw as NotifyConfig["backend"], removed: null };
}

export function resolveBackend(
  config: NotifyConfig,
  platform: NodeJS.Platform = process.platform,
): Backend | null {
  const backend = config.backend ?? "auto";
  if (backend !== "auto") return backend;

  if (platform === "darwin") {
    return "ccmux-notifier";
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
  // "command"/"dbus" have no spawn-based probe here (see the doc above).
  // "ccmux-notifier" is probed with its *resolved absolute path* in
  // `notify-delivery.ts` (`probeCcmuxNotifier`), which this module can't know,
  // so it's a harmless `true` default that path never relies on.
  if (
    backend === "command" ||
    backend === "dbus" ||
    backend === "ccmux-notifier"
  ) {
    return true;
  }
  const exitCode = await runWithTimeout(
    PROBE_ARGV[backend],
    PROBE_TIMEOUT_MS,
    spawn,
  );
  return exitCode === 0;
}

/** Probes a resolved ccmux-notifier binary via `<path> --version` (exit 0).
 * Split out from {@link probeBackend} because the path is dynamic (resolved
 * per install), so it can't live in the static `PROBE_ARGV` map. */
export async function probeCcmuxNotifier(
  binaryPath: string,
  spawn: SpawnFn = Bun.spawn as unknown as SpawnFn,
): Promise<boolean> {
  const exitCode = await runWithTimeout(
    [binaryPath, "--version"],
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

/**
 * Builds the ccmux-notifier `post` argv from the payload. `argv[0]` is the
 * resolved absolute helper path (`payload.notifierPath`), so `Bun.spawn`
 * executes it directly. Returns `null` when the delivery layer hasn't stamped
 * the helper path and callback URL — nothing to run.
 *
 * `--actions`/`--reply-action` appear only when the payload carries them (a
 * `permission` wait with a mapped agent gets Approve/Deny; a `question` wait
 * gets Reply); `--body` passes through verbatim, multi-line context and all.
 * `--payload` is the opaque staleness token the helper echoes back to
 * `/notification-action`.
 */
export function buildCcmuxNotifierArgv(
  payload: NotificationPayload,
): string[] | null {
  if (!payload.notifierPath || !payload.callbackUrl) return null;

  const argv = [payload.notifierPath, "post", "--title", payload.title];
  if (payload.subtitle) argv.push("--subtitle", payload.subtitle);
  argv.push("--body", payload.body);
  argv.push("--group", `ccmux-${payload.sessionId}`);

  const sound = resolveSoundName(payload.sound);
  if (sound) argv.push("--sound", sound);

  if (payload.actions && payload.actions.length > 0) {
    argv.push(
      "--actions",
      payload.actions.map((a) => `${a.id}:${a.label}`).join(","),
    );
  }
  if (payload.reply) {
    argv.push("--reply-action", `${payload.reply.id}:${payload.reply.label}`);
  }

  argv.push("--callback-url", payload.callbackUrl);
  argv.push(
    "--payload",
    JSON.stringify({
      sessionId: payload.sessionId,
      statusChangedAt: payload.statusChangedAt,
    }),
  );
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
    case "ccmux-notifier":
      return buildCcmuxNotifierArgv(payload);
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
/**
 * Per-backend default delivery timeout. ccmux-notifier may block on first-run
 * auth (see {@link NOTIFIER_DELIVER_TIMEOUT_MS}); every other spawn backend
 * exits promptly, so the short 3s cap ({@link DELIVER_TIMEOUT_MS}) catches a
 * genuinely hung process without killing the notifier mid-`requestAuthorization`.
 */
export function deliverTimeoutFor(backend: Backend): number {
  return backend === "ccmux-notifier"
    ? NOTIFIER_DELIVER_TIMEOUT_MS
    : DELIVER_TIMEOUT_MS;
}

export async function deliver(
  backend: Backend,
  payload: NotificationPayload,
  spawn: SpawnFn = Bun.spawn as unknown as SpawnFn,
  timeoutMs?: number,
): Promise<void> {
  const argv = buildArgv(backend, payload);
  if (!argv) return;

  // An explicit `timeoutMs` always wins (tests, or a caller that knows better);
  // otherwise fall to the per-backend default.
  const effectiveTimeout = timeoutMs ?? deliverTimeoutFor(backend);

  const options: SpawnOptions =
    backend === "command"
      ? { stdout: "ignore", stderr: "ignore", env: buildCommandEnv(payload) }
      : { stdout: "ignore", stderr: "ignore" };

  await runWithTimeout(argv, effectiveTimeout, spawn, options);
}
