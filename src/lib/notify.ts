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
 * Subset of the `notifications` preferences section that backend resolution
 * needs; kept local so this module stays free of preference imports.
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
  /** Session identity, agent-first: `Agent · project:branch` (passed whole; the
   * OS tail-truncates the title line at render). */
  title: string;
  /** The event line ("Needs permission: <tool>", "Finished", etc.), always set
   * for a real notification. Backends with a native subtitle slot (ccmux-notifier,
   * osascript) render it as its own line; notify-send and D-Bus fold it into
   * body line 1 (see `foldSubtitleIntoBody`). */
  subtitle?: string;
  /** Contextual content only (the pending command/question, or a finished
   * turn's closing words); may be empty when nothing could be extracted. */
  body: string;
  event: NotificationEventKind;
  sessionId: string;
  agent: string;
  project: string;
  branch?: string | null;
  pane?: string | null;
  /**
   * True for paneless background-agent sessions. `pane` alone is ambiguous
   * (a soft-evicted pane-tracked session also has `pane: null`), so the
   * daemon's click-action enrichment uses this to route background sessions
   * to the picker-popup click target instead of a pane jump.
   */
  background?: boolean;
  /** `true` maps to the platform default sound; a string names a sound. */
  sound?: boolean | string;
  /** backend "command" only: the user's configured shell command. */
  command?: string;
  /**
   * ccmux-notifier only: absolute path to the resolved helper binary, stamped
   * by the daemon's delivery wrapper via {@link resolveCcmuxNotifierBinary}.
   * `buildCcmuxNotifierArgv` refuses to build without it.
   */
  notifierPath?: string;
  /**
   * ccmux-notifier only: the `/notification-action` callback URL the helper
   * POSTs to. Stamped by the delivery wrapper (it owns the daemon port);
   * `buildCcmuxNotifierArgv` refuses to build without it.
   */
  callbackUrl?: string;
  /**
   * Staleness token (`session.statusChangedAt`) echoed back in the
   * notification-action callback so the daemon can reject a button press
   * whose session has moved on since the notification fired.
   */
  statusChangedAt?: string;
  /**
   * Per-wait generation (`session.attentionGeneration`) echoed back alongside
   * `statusChangedAt`. Catches a waiting->waiting swap that keeps `status`
   * unchanged (invisible to `statusChangedAt`) so an approve/deny/answer press
   * must match the exact wait it fired for.
   */
  attentionGeneration?: number;
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

/** "dbus" / "ccmux-notifier" / "command" have no static probe argv — see
 * {@link probeBackend}. */
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
  /**
   * Path of the running executable (`process.execPath`), for the brew-sibling
   * rung. In a compiled ccmux binary this IS ccmux, so its keg's `libexec` is
   * checked first — immune to another `ccmux` shadowing the brew one on PATH.
   * Under `bun run` it's the `bun` binary, whose sibling never exists, so it
   * falls through harmlessly.
   */
  execPath?: string | null;
  /** Absolute path to the `ccmux` binary on PATH, for the brew-sibling rung. */
  ccmuxPath?: string | null;
  which?: (cmd: string) => string | null;
  exists?: (path: string) => boolean;
  /** Symlink resolution for the brew-sibling rung; throws when path is missing. */
  realpath?: (path: string) => string;
}

/**
 * Resolves the ccmux-notifier helper binary, in priority order:
 *   1. `CCMUX_NOTIFIER_PATH` — points at either the `.app` bundle or the inner
 *      binary; normalized to the inner binary. An explicit override that
 *      doesn't exist resolves to `null` (it never silently falls through to a
 *      different install).
 *   2. Sibling of the ccmux binary: `<dir>/../libexec/ccmux-notifier.app/...`
 *      — the Homebrew formula's `libexec` layout. Checked for the running
 *      executable first (see `execPath`), then for `ccmux` on PATH.
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
  const realpath = deps.realpath ?? realpathSync;

  const envPath = env.CCMUX_NOTIFIER_PATH;
  if (envPath) {
    const candidate = envPath.endsWith(".app")
      ? join(envPath, NOTIFIER_INNER_BINARY)
      : envPath;
    return exists(candidate) ? candidate : null;
  }

  for (const base of [deps.execPath, deps.ccmuxPath]) {
    if (!base) continue;
    // `ccmux` in a Homebrew prefix is a symlink into the versioned Cellar keg
    // (`Cellar/ccmux/<v>/bin/ccmux`), where the helper is staged in the keg's
    // `libexec` — not linked into the prefix. Resolve the real path first so
    // the lexical `../libexec` join lands in the keg, not the prefix's `bin`.
    // Fail-open: a broken/missing symlink keeps the un-resolved path.
    let realBase = base;
    try {
      realBase = realpath(base);
    } catch {
      // keep the un-resolved path
    }
    const sibling = join(
      dirname(realBase),
      "..",
      "libexec",
      NOTIFIER_APP_NAME,
      NOTIFIER_INNER_BINARY,
    );
    if (exists(sibling)) return sibling;
  }

  return which("ccmux-notifier");
}

/** The concrete backends `deliver` knows how to build (excludes the `"auto"`
 *  sentinel). Kept local rather than importing the preferences list so this
 *  module stays free of preference imports. */
const VALID_BACKENDS = new Set<Backend>([
  "ccmux-notifier",
  "osascript",
  "notify-send",
  "dbus",
  "command",
]);

/** True when `value` names a real backend (not `"auto"`, not an unknown
 *  string). ccmux.json is hand-edited, so runtime values aren't type-safe. */
export function isKnownBackend(value: unknown): value is Backend {
  return typeof value === "string" && VALID_BACKENDS.has(value as Backend);
}

/** True when a CONFIGURED backend value is neither `"auto"` nor a recognized
 *  backend, i.e. a typo/removed value `resolveBackend` will ignore (falling to
 *  the auto ladder). Unset and `"auto"` are recognized (they select the ladder
 *  on purpose). Lets callers surface a one-line warning. */
export function isUnrecognizedBackend(value: unknown): boolean {
  return value !== undefined && value !== "auto" && !isKnownBackend(value);
}

/**
 * Resolves the backend to use. A recognized explicit backend always wins,
 * regardless of platform. `"auto"` (the default), an unset value, OR an
 * unrecognized value (ccmux.json is hand-edited) all walk the platform ladder:
 * darwin -> ccmux-notifier (the delivery layer falls to osascript when the
 * helper isn't resolvable, mirroring dbus -> notify-send on linux); linux ->
 * dbus; anything else -> disabled. Routing a typo to the working default beats
 * silently hard-disabling notifications; callers surface it via
 * {@link isUnrecognizedBackend}.
 */
export function resolveBackend(
  config: NotifyConfig,
  platform: NodeJS.Platform = process.platform,
): Backend | null {
  if (isKnownBackend(config.backend)) return config.backend;

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
 * the first delivery. Three backends have no spawn-based probe here and
 * default to a harmless `true` that's never relied on: `"command"` runs an
 * arbitrary user command (nothing safe to probe), `"dbus"` is routed through
 * `DbusNotifier.probe()` by its callers first, and `"ccmux-notifier"` is
 * probed with its *resolved absolute path* in `notify-delivery.ts`
 * (`probeCcmuxNotifier`), which this module can't know.
 */
export async function probeBackend(
  backend: Backend,
  spawn: SpawnFn = Bun.spawn as unknown as SpawnFn,
): Promise<boolean> {
  if (
    backend === "command" ||
    backend === "dbus" ||
    backend === "ccmux-notifier"
  ) {
    return true;
  }
  // No static probe argv (an unrecognized backend slipped past resolution):
  // report disabled explicitly rather than relying on `spawn(undefined)` to
  // throw its way to a false.
  const argv = PROBE_ARGV[backend];
  if (!argv) return false;
  const exitCode = await runWithTimeout(argv, PROBE_TIMEOUT_MS, spawn);
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

/**
 * Backends with no native subtitle slot (notify-send, D-Bus) render the event
 * line by folding the subtitle in as body line 1. Empty parts are skipped so
 * neither an empty subtitle nor an empty body leaves a stray blank line.
 */
export function foldSubtitleIntoBody(payload: {
  subtitle?: string;
  body: string;
}): string {
  return [payload.subtitle, payload.body].filter((part) => !!part).join("\n");
}

function buildOsascriptArgv(payload: NotificationPayload): string[] {
  const sound = resolveSoundName(payload.sound);

  // Positional args map to `item N of argv`, built in lockstep with the clause
  // so subtitle and sound land at the right index whether or not either is set.
  const positional = [payload.title, payload.body];
  let clause =
    "display notification (item 2 of argv) with title (item 1 of argv)";
  if (payload.subtitle) {
    positional.push(payload.subtitle);
    clause += ` subtitle (item ${positional.length} of argv)`;
  }
  if (sound) {
    positional.push(sound);
    clause += ` sound name (item ${positional.length} of argv)`;
  }

  return [
    "osascript",
    "-e",
    "on run argv",
    "-e",
    clause,
    "-e",
    "end run",
    // `--` ends osascript's own flag parsing: title/subtitle/body/sound are
    // attacker-influenceable (title starts with the session's project name,
    // a directory basename) and a value like "-e ..." would otherwise be
    // consumed as another osascript flag instead of a script argument.
    "--",
    ...positional,
  ];
}

/**
 * Builds the ccmux-notifier `post` argv from the payload; `argv[0]` is the
 * resolved absolute helper path. Returns `null` when the delivery layer
 * hasn't stamped the helper path and callback URL — nothing to run.
 * `--subtitle`/`--actions`/`--reply-action` appear only when the payload
 * carries them; `--body` passes through verbatim (multi-line context and all)
 * and is omitted when empty; `--payload` is the opaque staleness token the
 * helper echoes to `/notification-action`.
 */
export function buildCcmuxNotifierArgv(
  payload: NotificationPayload,
): string[] | null {
  if (!payload.notifierPath || !payload.callbackUrl) return null;

  const argv = [payload.notifierPath, "post", "--title", payload.title];
  if (payload.subtitle) argv.push("--subtitle", payload.subtitle);
  // The body is context-only now and may be empty (e.g. a finished notification
  // whose closing words couldn't be extracted); the subtitle carries the event
  // line, so omit an empty --body rather than posting a blank banner line.
  if (payload.body) argv.push("--body", payload.body);
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
      attentionGeneration: payload.attentionGeneration,
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
    // CCMUX_SUBTITLE is the bare event line for structured consumers; CCMUX_BODY
    // is the complete text (subtitle folded in), matching the notify-send/dbus
    // rendering, so a script reading only $CCMUX_BODY still gets the event line.
    CCMUX_SUBTITLE: payload.subtitle ?? "",
    CCMUX_BODY: foldSubtitleIntoBody(payload),
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
      // notify-send has no subtitle slot, so the event line is folded into
      // the body (see `foldSubtitleIntoBody`). `--` guards the same class of
      // bug as osascript above: a title starting with `-` would otherwise
      // parse as an option.
      return [
        "notify-send",
        "--app-name=ccmux",
        "--",
        payload.title,
        foldSubtitleIntoBody(payload),
      ];
    case "command":
      return payload.command ? ["sh", "-c", payload.command] : null;
    case "dbus":
      // Connection-oriented, not spawn-oriented: real dispatch lives in
      // `DbusNotifier`. Deliberate no-op so a stray direct call to
      // `deliver("dbus", ...)` fails safe instead of throwing.
      return null;
  }
}

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
  timeoutMs?: number,
): Promise<void> {
  const argv = buildArgv(backend, payload);
  if (!argv) return;

  // An explicit `timeoutMs` (tests, or a caller that knows better) beats the
  // per-backend default.
  const effectiveTimeout = timeoutMs ?? deliverTimeoutFor(backend);

  const options: SpawnOptions =
    backend === "command"
      ? { stdout: "ignore", stderr: "ignore", env: buildCommandEnv(payload) }
      : { stdout: "ignore", stderr: "ignore" };

  await runWithTimeout(argv, effectiveTimeout, spawn, options);
}
