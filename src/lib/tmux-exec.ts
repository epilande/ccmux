/**
 * The one place a `tmux` command line is built.
 *
 * Every call site goes through {@link tmuxArgv} so a configured socket override
 * (see `tmux-socket.ts`) reaches all of them at once, and so a future
 * multi-server wrapper has a single seam to widen. With no override configured
 * the argv is byte-identical to the bare `["tmux", ...args]` it replaced, which
 * `tmux-exec.test.ts` asserts directly.
 *
 * The override is resolved per call rather than once at module load: the daemon
 * marks itself (`markDaemonProcess`) after this module is first imported, and
 * an env lookup is nothing next to the subprocess that follows it.
 */

import { activeTmuxSocketOverride } from "./tmux-socket";

/** `["-S", path]`, `["-L", label]`, or `[]` when no override applies. */
export function tmuxSocketArgs(): string[] {
  const override = activeTmuxSocketOverride();
  if (!override) return [];
  return override.kind === "path"
    ? ["-S", override.value]
    : ["-L", override.value];
}

/** argv for a tmux command, using a caller-resolved binary path. */
export function tmuxArgvFor(binary: string, ...args: string[]): string[] {
  return [binary, ...tmuxSocketArgs(), ...args];
}

/** argv for a tmux command, resolving `tmux` through PATH. */
export function tmuxArgv(...args: string[]): string[] {
  return tmuxArgvFor("tmux", ...args);
}

/**
 * Run a tmux command synchronously and return its stdout, or null on failure.
 *
 * Synchronous (unlike ccmux's other tmux queries) because the "osc"
 * notification backend's probe and termname sniff run inside synchronous
 * delivery code; both are cheap, infrequent reads. `binary` lets the daemon
 * pass its once-resolved absolute `tmux` path.
 */
export function tmuxCaptureSync(
  args: string[],
  binary = "tmux",
): string | null {
  try {
    const result = Bun.spawnSync(tmuxArgvFor(binary, ...args), {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success) return null;
    return result.stdout.toString();
  } catch {
    return null;
  }
}

/** POSIX single-quoting, for a tmux invocation embedded in a shell string. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `tmux ...` prefix for a nested invocation inside a shell string (a
 * `run-shell` body, a hook). `"tmux"` with no override, so the surrounding
 * string is unchanged in the default case.
 */
export function tmuxShellPrefix(): string {
  const args = tmuxSocketArgs();
  if (args.length === 0) return "tmux";
  return `tmux ${args[0]} ${shellQuote(args[1])}`;
}
