/**
 * Which tmux server ccmux talks to.
 *
 * Without an override every tmux call resolves ambiently (`$TMUX`, else the
 * default socket), which is fine until the daemon is auto-started from a shell
 * whose ambient server is not the one the user's agents run on: `list-panes -a`
 * then finds nothing and the board is empty with no explanation. An override
 * names the server explicitly, and {@link tmuxArgv} in `tmux-exec.ts` turns it
 * into the `-S`/`-L` flags every call site prepends.
 *
 * Precedence, first match wins:
 *   1. `ccmux daemon start --socket/--label`, which the flag handler exports as
 *      `CCMUX_TMUX_SOCKET` before spawning so a backgrounded daemon sees it
 *   2. `CCMUX_TMUX_SOCKET` (leading "/" means a socket path, anything else a
 *      socket label)
 *   3. the `tmuxSocket` preferences key
 *   4. none, which is today's behavior byte for byte
 *
 * Env and config are the primary interface: `ensureDaemon()`'s auto-spawn
 * inherits the environment, so both reach a daemon nobody started by hand.
 *
 * Applying it is per-process (see {@link activeTmuxSocketOverride}): the daemon
 * always honors the override, a client only when it is not itself inside tmux.
 */

import { realpathSync } from "fs";
import { join } from "path";
import { getPreferencesSync } from "./preferences";

/** A configured tmux server: `-S <value>` for a path, `-L <value>` for a label. */
export type TmuxSocketOverride =
  | { kind: "path"; value: string }
  | { kind: "label"; value: string };

/**
 * Read one configured value. A leading "/" makes it a socket path, anything
 * else a label, matching how the value is documented and how `--socket` is
 * normalized to an absolute path before it becomes `CCMUX_TMUX_SOCKET`.
 *
 * Takes `unknown` because the config source is hand-edited JSON: a `tmuxSocket`
 * that parses fine but is not a string (`42`, `[]`) must read as unconfigured.
 * Throwing here would escape through `tmuxArgv` into every ccmux surface at
 * once, since every tmux call builds its argv through it.
 */
export function parseTmuxSocketValue(raw: unknown): TmuxSocketOverride | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  return value.startsWith("/")
    ? { kind: "path", value }
    : { kind: "label", value };
}

let daemonProcess = false;

/**
 * Mark this process as the daemon, which honors the override unconditionally.
 * Called from `startDaemon()` before anything spawns tmux: the daemon inherits
 * `$TMUX` from whoever auto-started it, and deferring to that inherited server
 * is the exact failure the override exists to fix.
 */
export function markDaemonProcess(): void {
  daemonProcess = true;
}

/** Memoized preferences read; the env var is re-read on every call (it is free). */
let prefOverride: TmuxSocketOverride | null | undefined;

/** Drop the memoized preferences read. Test seam. */
export function resetTmuxSocketCache(): void {
  prefOverride = undefined;
  daemonProcess = false;
}

/** The configured override, ignoring whether this process should apply it. */
export function resolveTmuxSocketOverride(): TmuxSocketOverride | null {
  const fromEnv = parseTmuxSocketValue(process.env.CCMUX_TMUX_SOCKET);
  if (fromEnv) return fromEnv;
  if (prefOverride === undefined) {
    prefOverride = parseTmuxSocketValue(getPreferencesSync().tmuxSocket);
  }
  return prefOverride;
}

/**
 * The override this process's own tmux calls should carry, or null for
 * ambient resolution.
 *
 * A client inside tmux ignores it: it is physically attached to that server,
 * and pointing its pane actions at another one is nonsense (the daemon/client
 * mismatch is what `isSameTmuxServer` is for). A client outside tmux applies
 * it, which is what keeps a picker launched from a login shell capturing and
 * sending keys on the same server the daemon scans.
 */
export function activeTmuxSocketOverride(): TmuxSocketOverride | null {
  const override = resolveTmuxSocketOverride();
  if (!override) return null;
  if (daemonProcess) return override;
  return process.env.TMUX ? null : override;
}

/**
 * The directory tmux puts labeled sockets in: `$TMUX_TMPDIR` (else `/tmp`) plus
 * `tmux-<uid>`. Realpath'd because tmux reports `#{socket_path}` resolved
 * (`/tmp/tmux-501/x` comes back as `/private/tmp/tmux-501/x` on macOS) and the
 * cross-server guard compares that value literally.
 */
function socketDir(): string {
  const base = process.env.TMUX_TMPDIR?.trim() || "/tmp";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const dir = join(base, `tmux-${uid}`);
  try {
    return realpathSync(dir);
  } catch {
    // No server has ever run here, so the directory does not exist yet.
    return dir;
  }
}

/**
 * The socket path an override names. A `-S` path is returned verbatim, which is
 * what tmux itself reports back through `#{socket_path}` (verified on 3.6a).
 */
export function tmuxSocketPath(override: TmuxSocketOverride): string {
  return override.kind === "path"
    ? override.value
    : join(socketDir(), override.value);
}

/**
 * The socket this process's tmux calls target, whether or not one is reachable.
 * Used to say WHICH server was unreachable when a probe fails, so falls all the
 * way back to the default socket rather than reporting nothing.
 */
export function attemptedTmuxSocketPath(): string {
  const override = activeTmuxSocketOverride();
  if (override) return tmuxSocketPath(override);
  const ambient = process.env.TMUX?.split(",")[0];
  if (ambient) return ambient;
  return tmuxSocketPath({ kind: "label", value: "default" });
}

/**
 * The one-line "we could not reach it" message, shared by the picker/sidebar
 * empty state and `ccmux show`. The socket, not the underlying tmux error, is
 * the actionable part: it names the server ccmux was pointed at, which is what
 * a misconfigured override gets wrong.
 */
export function socketErrorMessage(attemptedSocket: string | null): string {
  return attemptedSocket
    ? `tmux server unreachable at ${attemptedSocket}`
    : "tmux server unreachable";
}
