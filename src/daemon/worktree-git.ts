/**
 * Git plumbing for worktree pruning: enumerating a repo's worktrees and
 * answering the four questions that make one removable (is it dirty, is its
 * branch merged, is its upstream gone, what does its admin dir look like).
 *
 * Every GIT call goes through an injectable {@link GitRun} so the
 * classification above it can be exercised against fixture repos without
 * mocking `Bun.spawn`, and so a caller that already knows a repo is
 * unreachable can stub it out. The file also reads a little repo-adjacent
 * CONFIG straight off disk ({@link readSymlinkDirectories}), which does not
 * go through that seam because there is no subprocess to inject; those
 * readers take their root paths as arguments instead, which is what makes
 * them testable.
 *
 * Nothing here mutates a repo; the removal side lives in `worktree-prune.ts`.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `git -C <cwd> <args...>`. Never throws; a failed spawn is exit 127. */
export type GitRun = (cwd: string, args: string[]) => Promise<GitResult>;

/**
 * Default runner. A spawn failure (git missing, cwd deleted between listing
 * and running) is reported as a non-zero exit rather than a throw, so one
 * unreachable repo can't abort a scan over every other repo.
 */
export const runGit: GitRun = async (cwd, args) => {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
};

/** One row of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path as git records it. */
  path: string;
  /** Short branch name (`refs/heads/x` -> `x`), null when detached. */
  branch: string | null;
  head: string | null;
  detached: boolean;
  bare: boolean;
  /** `locked` marker present (an interrupted `worktree add` leaves these). */
  locked: boolean;
  /** git already considers the admin entry stale (working tree gone). */
  prunable: boolean;
  /**
   * The main checkout is always the FIRST entry git prints, for every repo
   * layout — that is the documented ordering, not an accident of sorting.
   */
  isMain: boolean;
}

/**
 * Parse `git worktree list --porcelain`. Records are separated by blank
 * lines; each starts with `worktree <path>`. Attribute lines are either
 * `key value` or a bare `key` flag.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const raw of stdout.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;
    const spaceIdx = line.indexOf(" ");
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const value = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);

    if (key === "worktree") {
      current = {
        path: value,
        branch: null,
        head: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
        isMain: entries.length === 0,
      };
      entries.push(current);
      continue;
    }
    if (!current) continue;

    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.startsWith("refs/heads/")
          ? value.slice("refs/heads/".length)
          : value;
        break;
      case "detached":
        current.detached = true;
        break;
      case "bare":
        current.bare = true;
        break;
      case "locked":
        current.locked = true;
        break;
      case "prunable":
        current.prunable = true;
        break;
    }
  }

  return entries;
}

export async function listWorktrees(
  repoRoot: string,
  git: GitRun = runGit,
): Promise<WorktreeEntry[]> {
  const res = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (res.exitCode !== 0) return [];
  return parseWorktreeList(res.stdout);
}

/**
 * Read `worktree.symlinkDirectories` from Claude Code's MERGED settings.
 *
 * Claude Code uses this to share a directory (typically `node_modules`) into
 * the worktrees it creates, by symlink. ccmux reads it for the opposite
 * reason: to recognize such a link and not mistake it for the user's own
 * uncommitted work.
 *
 * All three scopes are consulted, because Claude Code resolves this key from
 * merged settings and the schema puts no scope restriction on it. USER scope
 * matters most in practice: a machine-wide "share node_modules" preference is
 * the natural place to set this once rather than per repo, and reading only
 * the project file would leave exactly those users with the bug this exists
 * to fix and no way to see why.
 *
 * Precedence is Claude Code's own, highest first, with a defined list
 * REPLACING rather than extending the one below it: `.claude/settings.local
 * .json`, then `.claude/settings.json`, then `~/.claude/settings.json`. That
 * mirrors what the tool would actually have symlinked, which is the thing
 * being recognized.
 *
 * Absent file, unreadable file, malformed JSON and a missing key are all the
 * same answer, "this scope says nothing", so the next one down is consulted.
 * This is optional convenience config: a parse failure must not change how a
 * destructive feature behaves.
 */
export function readSymlinkDirectories(
  mainRepoRoot: string,
  homeDir: string = homedir(),
): string[] {
  const scopes = [
    join(mainRepoRoot, ".claude", "settings.local.json"),
    join(mainRepoRoot, ".claude", "settings.json"),
    join(homeDir, ".claude", "settings.json"),
  ];
  for (const path of scopes) {
    const dirs = readSymlinkDirectoriesFrom(path);
    if (dirs) return dirs;
  }
  return [];
}

/** One settings file's list, or null when it does not define the key. */
function readSymlinkDirectoriesFrom(settingsPath: string): string[] | null {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      worktree?: { symlinkDirectories?: unknown };
    };
    const dirs = parsed.worktree?.symlinkDirectories;
    if (!Array.isArray(dirs)) return null;
    return dirs.filter((d): d is string => typeof d === "string" && d !== "");
  } catch {
    // Missing, unreadable or malformed: this scope simply says nothing.
    return null;
  }
}

export interface DirtyState {
  dirty: boolean;
  /** Tracked files with staged or unstaged modifications. */
  modified: number;
  /** Untracked files (directories collapse to one entry, as git prints them). */
  untracked: number;
  /**
   * Individual ignored FILES, by path — `.env`, `.env.local`, a local config.
   * Ignored DIRECTORIES (`node_modules/`, `dist/`) are deliberately excluded:
   * git collapses them to a single entry, and they are regenerable build
   * output, so counting them would flag every worktree alike.
   *
   * Not part of `dirty` — see {@link readDirtyState}.
   */
  ignoredFiles: string[];
}

/**
 * Uncommitted, untracked and ignored content, from one `git status`.
 *
 * Untracked counts as dirty deliberately: the whole point of the flag is
 * "you would lose work", and an untracked scratch file, a stashed-by-hand
 * patch, or an unstaged fix is exactly the work that a worktree whose branch
 * is already merged still holds.
 *
 * Ignored files are collected but NOT counted as dirty, which is a deliberate
 * split rather than an oversight. Plain `--porcelain` hides them entirely, so
 * a worktree whose only uncommitted content is a gitignored `.env` reported
 * perfectly clean and could be swept up by "select all" — and since the trash
 * directory is deleted at the end of the same run, an unbackupable file would
 * be gone with no recovery window. They are surfaced so the user sees them
 * before the directory goes away. Folding them into `dirty` instead would
 * fire the opt-in gate on essentially every worktree (a stray `.DS_Store` is
 * an ignored file), and a gate that always fires trains people to clear it
 * reflexively, which is worse than no gate for the case it exists to catch.
 */
export async function readDirtyState(
  worktreePath: string,
  git: GitRun = runGit,
  options: { setupSymlinks?: string[] } = {},
): Promise<DirtyState> {
  const res = await git(worktreePath, [
    "status",
    "--porcelain",
    "--ignored=matching",
  ]);
  // An unreadable worktree is reported dirty: refusing to remove something we
  // could not inspect is the safe direction for a destructive action.
  if (res.exitCode !== 0) {
    return { dirty: true, modified: 0, untracked: 0, ignoredFiles: [] };
  }

  const setupSymlinks = new Set(
    (options.setupSymlinks ?? []).map((entry) => entry.replace(/\/+$/, "")),
  );

  let modified = 0;
  let untracked = 0;
  const ignoredFiles: string[] = [];
  for (const line of res.stdout.split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("!!")) {
      const path = line.slice(3).trim();
      // A trailing slash is git's marker for a collapsed ignored directory.
      if (path && !path.endsWith("/")) ignoredFiles.push(path);
    } else if (line.startsWith("??")) {
      if (isSetupSymlink(worktreePath, line.slice(3).trim(), setupSymlinks)) {
        continue;
      }
      untracked++;
    } else modified++;
  }
  return {
    dirty: modified + untracked > 0,
    modified,
    untracked,
    ignoredFiles,
  };
}

/**
 * Whether an untracked entry is just a `worktree.symlinkDirectories` link.
 *
 * A `node_modules/` gitignore pattern is DIRECTORY-only, so it does not match
 * a symlink of that name, and git reports the link as untracked. Every
 * worktree set up by this convention therefore read as dirty — which for the
 * prune feature meant demanding the uncommitted-work opt-in for a worktree
 * whose only "work" is a symlink the tooling created itself. Confirmed
 * against the real repo, where every agent-created worktree reports
 * `?? node_modules`.
 *
 * Narrow on purpose: only names the repo actually configured, and only when
 * the entry really is a symlink on disk. A real directory of that name, or a
 * symlink the user made for their own reasons, still counts as dirt.
 *
 * Matching is on the WHOLE path git reported, so a configured `node_modules`
 * does not exempt `packages/foo/node_modules`. That is deliberate and fails
 * closed: a monorepo symlinking per-package directories keeps reading dirty
 * until it lists those paths explicitly, which is the right default for a
 * gate in front of a deletion.
 *
 * WHY EXEMPTING IS SAFE, which matters more than the narrowness. The obvious
 * worry is "this symlink could point at anything, including real work". It
 * could, and that is still safe, because the blast radius is not what the
 * link points AT: deleting a symlink never touches its target. The worst an
 * exemption can cost is the link itself, which the tooling can recreate.
 * Verified end to end: a worktree whose only untracked entry was
 * `node_modules -> <a directory of real files>` was exempted, pruned with no
 * dirty opt-in, and the target came through with its contents intact. Real
 * work sitting INSIDE the worktree is unaffected either way, since it is a
 * separate untracked entry that this exemption does not name.
 *
 * `lstatSync`, not `statSync`: `stat` follows the link and reports the
 * TARGET's type, so `isSymbolicLink()` comes back false for EVERYTHING,
 * including a genuine symlink. The exemption would then silently never fire
 * and every setup symlink would read as dirt again, which is the bug this
 * exists to fix. Measured: `stat(link).isSymbolicLink()` is false while
 * `lstat(link).isSymbolicLink()` is true. The failure is closed rather than
 * open, so it costs correctness rather than safety, but it is invisible.
 */
function isSetupSymlink(
  worktreePath: string,
  entry: string,
  setupSymlinks: Set<string>,
): boolean {
  const name = entry.replace(/\/+$/, "");
  if (!setupSymlinks.has(name)) return false;
  try {
    return lstatSync(resolve(worktreePath, name)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Base refs a branch counts as "merged into" — the repo's default branch,
 * preferring the remote-tracking copy (which is what a merge on GitHub
 * actually advances) and falling back to the local one.
 *
 * Resolution order: `origin/HEAD`'s symbolic target (set by `clone`, and by
 * `git remote set-head`), then the conventional names. Every returned ref is
 * verified to exist, so ancestry checks below never spend a spawn on a ref
 * that isn't there.
 */
export async function resolveBaseRefs(
  repoRoot: string,
  git: GitRun = runGit,
): Promise<string[]> {
  const candidates: string[] = [];

  const head = await git(repoRoot, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (head.exitCode === 0) {
    const ref = head.stdout.trim();
    if (ref) candidates.push(ref);
  }
  candidates.push("origin/main", "origin/master", "main", "master");

  const verified: string[] = [];
  for (const ref of candidates) {
    if (verified.includes(ref)) continue;
    const res = await git(repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (res.exitCode === 0) verified.push(ref);
  }
  return verified;
}

/**
 * True when `branch`'s tip is an ancestor of any base ref — the local,
 * provable form of "already merged", and the only reason that justifies a
 * non-forced `git branch -d`.
 *
 * A squash or rebase merge does NOT satisfy this (the tip commit never
 * appears on the base), which is why the PR-derived reasons exist alongside
 * it rather than on top of it.
 */
export async function isMergedInto(
  repoRoot: string,
  branch: string,
  baseRefs: string[],
  git: GitRun = runGit,
): Promise<boolean> {
  for (const base of baseRefs) {
    // Never call a branch "merged into itself": the default branch's own
    // worktree would otherwise classify as removable.
    if (base === branch || base.endsWith(`/${branch}`)) continue;
    const res = await git(repoRoot, [
      "merge-base",
      "--is-ancestor",
      // Fully qualified, NOT the short name: git's disambiguation ranks
      // `refs/tags/<name>` ABOVE `refs/heads/<name>`, so a tag sharing the
      // branch's name silently answered this question about the tag. An
      // unmerged branch then classified `merged-locally` and lost its
      // directory on a false reason.
      `refs/heads/${branch}`,
      base,
    ]);
    if (res.exitCode === 0) return true;
  }
  return false;
}

export interface UpstreamState {
  /** Configured upstream ref, e.g. `origin/feat/x`. Null when none is set. */
  upstream: string | null;
  /** Upstream was configured but no longer exists on the remote. */
  gone: boolean;
}

/**
 * Upstream state for every local branch, in one `for-each-ref`.
 *
 * `%(upstream:track)` reports `[gone]` exactly when a branch has an upstream
 * configured that no longer resolves — which, after a `fetch --prune`, is the
 * signature of a remote branch deleted on merge. Branches with no upstream at
 * all report an empty track and are NOT gone: a purely local branch has
 * nothing to have lost.
 */
export async function readUpstreamStates(
  repoRoot: string,
  git: GitRun = runGit,
): Promise<Map<string, UpstreamState>> {
  const states = new Map<string, UpstreamState>();
  const res = await git(repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)",
    "refs/heads",
  ]);
  if (res.exitCode !== 0) return states;

  for (const line of res.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [name, upstream = "", track = ""] = line.split("\t");
    if (!name) continue;
    states.set(name, {
      upstream: upstream || null,
      gone: upstream !== "" && track.includes("[gone]"),
    });
  }
  return states;
}

/**
 * `git fetch --prune`, the call that turns a branch deleted on GitHub into a
 * locally visible `[gone]`. Slow (network) and therefore run once per repo
 * per prune surface, never per worktree. Failure is not fatal: without it the
 * scan simply reports fewer `upstream gone` rows.
 */
export async function fetchPrune(
  repoRoot: string,
  git: GitRun = runGit,
): Promise<boolean> {
  const res = await git(repoRoot, ["fetch", "--prune", "--quiet"]);
  return res.exitCode === 0;
}

/**
 * The `.git/worktrees/<name>` admin directory backing a linked worktree,
 * read from its `.git` FILE while the worktree still exists.
 *
 * Captured before removal because it is the only reliable handle on the admin
 * entry: the directory name under `.git/worktrees/` is not derivable from the
 * worktree path (git de-duplicates colliding basenames with a suffix), and
 * once the working tree is gone there is nothing left to read it from.
 */
export function readAdminDir(worktreePath: string): string | null {
  const gitFile = resolve(worktreePath, ".git");
  if (!existsSync(gitFile)) return null;
  let content: string;
  try {
    content = readFileSync(gitFile, "utf-8");
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;
  const raw = match[1];
  return isAbsolute(raw) ? raw : resolve(dirname(gitFile), raw);
}
