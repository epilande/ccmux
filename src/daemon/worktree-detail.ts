/**
 * One worktree's local detail, for the Worktrees view's preview: what is
 * uncommitted in it and its last few commits.
 *
 * Local only, like `worktree-list.ts`: it never fetches and never runs `gh`,
 * so the preview can ask on every settled cursor move. The caller (the
 * `GET /worktrees/detail` handler) is what proves the path is a registered
 * worktree before this runs; this module only reads.
 */

import { runMetadataGit, type GitRun } from "./worktree-git";
import { stripControlChars } from "./notify-text";

/** The most changed paths one answer lists; `total` still counts them all. */
export const MAX_CHANGES = 200;

/** How many commits the preview shows. */
const LOG_COUNT = 5;

/** One `git status` entry: its two-letter code and its path. */
export interface WorktreeChange {
  /** The porcelain XY code, `??` for untracked, ` M`, `A `, `R ` and so on. */
  code: string;
  path: string;
  /** A rename's or copy's source. */
  from?: string;
}

export interface WorktreeCommit {
  sha: string;
  subject: string;
  /** Committer date, ISO 8601. */
  date: string;
}

export interface WorktreeDetail {
  path: string;
  changes: WorktreeChange[];
  /** Every changed path, including any past {@link MAX_CHANGES}. */
  total: number;
  truncated: boolean;
  commits: WorktreeCommit[];
}

/** A path or subject made safe to draw on one row. */
function clean(text: string): string {
  return stripControlChars(text, { replacement: " " });
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * `-z` rather than `--short`: it turns off C-quoting, so a path with a space
 * or a non-ASCII name arrives as itself rather than `"caf\303\251"`, and it
 * makes a rename's source its own NUL-separated field instead of an `a -> b`
 * that a path containing ` -> ` would break.
 */
export function parseStatusZ(stdout: string): WorktreeChange[] {
  const fields = stdout.split("\0");
  const changes: WorktreeChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const change: WorktreeChange = { code, path: clean(field.slice(3)) };
    if (code[0] === "R" || code[0] === "C") {
      const from = fields[++i];
      if (from) change.from = clean(from);
    }
    changes.push(change);
  }
  return changes;
}

/** Parse `git log --format=%h%x1f%s%x1f%cI`, one commit per line. */
export function parseLog(stdout: string): WorktreeCommit[] {
  const commits: WorktreeCommit[] = [];
  for (const line of stdout.split("\n")) {
    const [sha, subject, date] = line.split("\x1f");
    if (!sha || subject === undefined || !date) continue;
    commits.push({ sha, subject: clean(subject), date: date.trim() });
  }
  return commits;
}

/**
 * `path`'s changes and recent commits.
 *
 * A failed `git status` is the failure (the worktree is unreadable); a failed
 * `git log` is not, because a branch with no commits yet (`git worktree add
 * --orphan`, a fresh `git init`) exits non-zero there and simply has none.
 */
export async function readWorktreeDetail(
  path: string,
  git: GitRun = runMetadataGit,
): Promise<
  { ok: true; detail: WorktreeDetail } | { ok: false; error: string }
> {
  const [status, log] = await Promise.all([
    git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    git(path, ["log", "-n", String(LOG_COUNT), "--format=%h%x1f%s%x1f%cI"]),
  ]);
  if (status.exitCode !== 0)
    return {
      ok: false,
      error: `git status failed: ${clean(status.stderr).trim() || `exit ${status.exitCode}`}`,
    };
  const changes = parseStatusZ(status.stdout);
  return {
    ok: true,
    detail: {
      path,
      changes: changes.slice(0, MAX_CHANGES),
      total: changes.length,
      truncated: changes.length > MAX_CHANGES,
      commits: log.exitCode === 0 ? parseLog(log.stdout) : [],
    },
  };
}
