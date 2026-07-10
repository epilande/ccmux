import { realpath } from "fs/promises";

/**
 * Resolve `cwd`'s git repo root, realpath'd so macOS's `/tmp` -> `/private/tmp`
 * symlink doesn't produce a path that mismatches later string comparisons.
 * Returns null on any failure (not a git repo, git missing, spawn error).
 */
export async function resolveRepoRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const root = output.trim();
    if (!root) return null;
    return await realpath(root);
  } catch {
    return null;
  }
}
