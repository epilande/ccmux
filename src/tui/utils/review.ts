import type { CliRenderer } from "@opentui/core";
import { resolveRepoRoot } from "../../lib/git";

export const HUNK_DIFF_ARGS = ["diff", "--watch"] as const;
export const HUNK_INSTALL_HINT =
  "hunk not found: install it to review diffs (see github.com/modem-dev/hunk)";

export function isHunkAvailable(
  which: (cmd: string) => string | null = Bun.which,
): boolean {
  return which("hunk") !== null;
}

export type ReviewResult = { ok: true } | { ok: false; error: string };

type SpawnHunk = (
  cmd: string[],
  opts: {
    cwd: string;
    stdin: "inherit";
    stdout: "inherit";
    stderr: "inherit";
  },
) => { exited: Promise<number> };

export interface RunHunkReviewDeps {
  which?: (cmd: string) => string | null;
  spawn?: SpawnHunk;
  resolveRoot?: (cwd: string) => Promise<string | null>;
}

/**
 * Spawn `hunk diff --watch` in `root` with inherited stdio (`hunk` resolved via
 * PATH). Shared by the CLI `review` command and the in-picker review action;
 * both verify `hunk` is on PATH (`isHunkAvailable`) before calling.
 */
export function spawnHunkDiff(
  root: string,
  spawn: SpawnHunk = Bun.spawn as unknown as SpawnHunk,
): { exited: Promise<number> } {
  return spawn(["hunk", ...HUNK_DIFF_ARGS], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

/**
 * Suspend the picker's renderer, run `hunk diff --watch` in `cwd`'s repo root
 * with inherited stdio, then resume. Pre-flight checks (hunk on PATH, git
 * repo root) run before `suspend()` so error toasts render without a flicker.
 * `suspend()` has its own try/catch: if it throws, `resume()` is never
 * called (nothing to undo). Once suspended, `resume()` always runs via
 * try/finally, even if the spawn itself throws.
 */
export async function runHunkReview(
  renderer: Pick<CliRenderer, "suspend" | "resume">,
  cwd: string,
  deps: RunHunkReviewDeps = {},
): Promise<ReviewResult> {
  const which = deps.which ?? Bun.which;
  const spawn = deps.spawn ?? (Bun.spawn as unknown as SpawnHunk);
  const resolveRoot = deps.resolveRoot ?? resolveRepoRoot;

  const hunk = which("hunk");
  if (!hunk) return { ok: false, error: HUNK_INSTALL_HINT };

  const root = await resolveRoot(cwd);
  if (!root) return { ok: false, error: "not a git repository" };

  try {
    renderer.suspend();
  } catch (err) {
    return { ok: false, error: `suspend failed: ${err}` };
  }

  try {
    const proc = spawnHunkDiff(root, spawn);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return { ok: false, error: `hunk exited with code ${exitCode}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `${err}` };
  } finally {
    renderer.resume();
  }
}
