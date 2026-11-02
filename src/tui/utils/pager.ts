import type { CliRenderer } from "@opentui/core";

/** Runs `argv` with `text` on its stdin and the terminal on its stdout and
 *  stderr; resolves with its exit code. */
export type PagerSpawn = (argv: string[], text: string) => Promise<number>;

export interface PagerDeps {
  env?: Record<string, string | undefined>;
  spawn?: PagerSpawn;
}

/**
 * The pager to run: the user's `$PAGER` through the shell (it is a command
 * line, `less -R` or `bat -p`, the way git runs it), else `less +G`, which
 * opens at the end, where a transcript's newest turn is. No `-R`: the text
 * is an agent's words, and passing escape sequences through raw would let
 * one paint the terminal.
 */
export function pagerCommand(
  env: Record<string, string | undefined>,
): string[] {
  const pager = env.PAGER?.trim();
  return pager ? ["sh", "-c", pager] : ["less", "+G"];
}

const defaultSpawn: PagerSpawn = async (argv, text) => {
  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    proc.stdin.write(text);
    await proc.stdin.end();
  } catch {
    // A pager quit before it read everything closes the pipe under us; what
    // it showed is what the user wanted.
  }
  return proc.exited;
};

/**
 * Show `text` in a pager over the picker: suspend the renderer, pipe the text
 * to the pager's stdin, and resume when it exits.
 *
 * Piped, never written to a file. A transcript can carry whatever the user
 * pasted into an agent (tokens, keys), and a temp file outlives a crash. As
 * with review's suspend, a `suspend()` that throws leaves nothing to undo,
 * and once suspended `resume()` is guaranteed even if the spawn throws.
 */
export async function openInPager(
  renderer: Pick<CliRenderer, "suspend" | "resume">,
  text: string,
  deps: PagerDeps = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const argv = pagerCommand(deps.env ?? process.env);
  const spawn = deps.spawn ?? defaultSpawn;
  try {
    renderer.suspend();
  } catch (err) {
    return { ok: false, error: `suspend failed: ${err}` };
  }
  try {
    await spawn(argv, text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${argv[0]} failed: ${err}` };
  } finally {
    renderer.resume();
  }
}
