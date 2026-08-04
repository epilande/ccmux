/**
 * Every worktree a repo has, as the Worktrees panel and `ccmux worktree list`
 * need to see it — the read path that answers "what exists", where
 * `worktree-prune.ts` answers "what is finished".
 *
 * The two are deliberately separate scans rather than one with a flag. The
 * prune scan is classification: it filters to `!isMain && !bare`, and a
 * worktree it cannot prove is removable produces nothing at all, so a healthy
 * worktree with an open PR, a detached HEAD, or simply nothing to say is
 * invisible in it by design. Here the absence of a reason is not a filter, the
 * main checkout is a row (the panel anchors its repo group on it), and no
 * classification is attempted.
 *
 * LOCAL ONLY, and that is a contract rather than an omission: no `git fetch`,
 * no `gh`, nothing that can block on a network round trip. It is what the
 * panel renders instantly on open, with the prune scan's slower answers merged
 * in by path afterwards. Adding a network call here would cost that.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { mapWithConcurrency } from "../lib/concurrency";
import {
  listWorktrees,
  normalizePath,
  readDirtyState,
  readSymlinkDirectories,
  readUpstreamStates,
  runGit,
  type GitRun,
  type UpstreamState,
} from "./worktree-git";
import type { WorktreeSession } from "./worktree-prune";

/**
 * Uncommitted work in a worktree, narrowed to what a row shows. The ignored
 * files and directories {@link readDirtyState} also collects stay out: they
 * exist to be named in front of a DELETION, and nothing here deletes.
 */
export interface WorktreeDirty {
  dirty: boolean;
  modified: number;
  untracked: number;
}

/** One worktree of one repo, including the repo's main checkout. */
export interface WorktreeRow {
  /** Absolute worktree root, as git records it. */
  path: string;
  /** Main checkout this worktree hangs off (equal to `path` on the main row). */
  repoRoot: string;
  repoName: string;
  /** Display name: the worktree directory's own basename. */
  name: string;
  /** Short branch name, null when detached. */
  branch: string | null;
  detached: boolean;
  isMain: boolean;
  /** `git worktree lock`ed — the user asked for it to be left alone. */
  locked: boolean;
  dirty: WorktreeDirty;
  /**
   * Upstream tracking for `branch`, including ahead/behind. Null only when
   * there is no branch to track (detached HEAD); a branch that simply has no
   * upstream configured still has a state, with a null `upstream`.
   */
  upstream: UpstreamState | null;
  /** Sessions living in this worktree, as the caller reported them. */
  sessions: WorktreeSession[];
}

/** One repo's worktrees, main checkout first. */
export interface WorktreeRepo {
  repoRoot: string;
  repoName: string;
  worktrees: WorktreeRow[];
}

/** Body of `GET /worktrees`. */
export interface WorktreeListResponse {
  repos: WorktreeRepo[];
}

export interface ListDeps {
  git?: GitRun;
  /**
   * Sessions living in a worktree, keyed by its (realpath-normalized) root.
   * Supplied by the daemon, which is the only thing that knows — the same
   * seam `worktree-prune.ts` takes.
   */
  sessionsFor?: (worktreePath: string) => WorktreeSession[];
}

/**
 * `git status` runs per worktree, so a repo with dozens of them would
 * otherwise open dozens of processes at once from the daemon's own thread.
 */
const DIRTY_CONCURRENCY = 8;

/**
 * List one repo's worktrees. Null when `repoRoot` is not a git repo, or is one
 * with nothing to show — the caller drops those rather than rendering an empty
 * group.
 */
export async function listRepoWorktrees(
  repoRoot: string,
  deps: ListDeps = {},
): Promise<WorktreeRepo | null> {
  const git = deps.git ?? runGit;
  const entries = await listWorktrees(repoRoot, git);
  // `bare` has no working tree to inspect; a path that is no longer on disk is
  // a stale admin entry that `git worktree prune` reclaims, and there is
  // nothing the panel could do with it — no directory to jump to, spawn into,
  // copy or diff. Both are dropped rather than shown as rows that answer no
  // question.
  const present = entries.filter(
    (entry) => !entry.bare && existsSync(entry.path),
  );
  if (present.length === 0) return null;

  const upstreams = await readUpstreamStates(repoRoot, git);
  // Read once per repo, not per worktree: it is the same file for all of them,
  // and without it every tooling-created worktree reads as dirty on the
  // `node_modules` symlink the tooling itself made.
  const setupSymlinks = readSymlinkDirectories(repoRoot);
  const repoName = basename(repoRoot);

  const rows = await mapWithConcurrency(
    present,
    DIRTY_CONCURRENCY,
    async (entry): Promise<WorktreeRow> => {
      const state = await readDirtyState(entry.path, git, { setupSymlinks });
      return {
        path: entry.path,
        repoRoot,
        repoName,
        name: basename(entry.path),
        branch: entry.branch,
        detached: entry.detached,
        isMain: entry.isMain,
        locked: entry.locked,
        dirty: {
          dirty: state.dirty,
          modified: state.modified,
          untracked: state.untracked,
        },
        upstream: entry.branch ? (upstreams.get(entry.branch) ?? null) : null,
        sessions: deps.sessionsFor?.(normalizePath(entry.path)) ?? [],
      };
    },
  );

  // Main checkout first — it is the repo group's anchor, and git's own
  // ordering already puts it there, but the sort makes that independent of
  // whether the caller reordered anything.
  rows.sort(
    (a, b) =>
      Number(b.isMain) - Number(a.isMain) || a.name.localeCompare(b.name),
  );

  return { repoRoot, repoName, worktrees: rows };
}

/**
 * List several repos' worktrees, de-duplicating repeated roots the way
 * `scanRepos` does — the same repo can be reached through a session's
 * `mainRepoRoot` and through a caller's cwd.
 */
export async function listAllWorktrees(
  repoRoots: string[],
  deps: ListDeps = {},
): Promise<WorktreeListResponse> {
  const seen = new Set<string>();
  const repos: WorktreeRepo[] = [];
  for (const root of repoRoots) {
    const key = normalizePath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    const repo = await listRepoWorktrees(root, deps);
    if (repo) repos.push(repo);
  }
  repos.sort((a, b) => a.repoName.localeCompare(b.repoName));
  return { repos };
}
