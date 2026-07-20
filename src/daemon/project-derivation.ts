import { existsSync, readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join, resolve, sep } from "path";
import { homedir } from "os";

/** Process-wide default cache for {@link deriveProject}. */
export const projectCache: Map<string, string> = new Map();

export interface DeriveProjectOptions {
  /**
   * Memoization cache, keyed by the raw `cwd` string. Defaults to the
   * process-wide {@link projectCache} so every call site shares one cache.
   * Callers pass their own `Map` in tests to observe cache population
   * without touching daemon-wide state.
   */
  cache?: Map<string, string>;
  /**
   * Home directory to stop the upward walk at (never scan above it).
   * Defaults to `os.homedir()`. Overridable for tests, since Bun's
   * `os.homedir()` does not track a test-time `process.env.HOME` override.
   */
  homeDir?: string;
}

/**
 * Derive the display "project" name for a `cwd`, git-aware so worktrees of
 * the same repo group together instead of fragmenting by worktree
 * directory name.
 *
 * Resolution:
 * 1. Walk parent directories from `cwd` looking for a `.git` entry,
 *    stopping at `$HOME` or the filesystem root (never scanning above the
 *    user's home directory).
 * 2. A `.git` DIRECTORY means the main checkout: project is that
 *    directory's own basename.
 * 3. A `.git` FILE (a worktree) contains `gitdir: <path>` pointing into
 *    `<main>/.git/worktrees/<name>`; the main root is derived by stripping
 *    that suffix. A relative `gitdir` path is resolved against the
 *    directory containing the `.git` file first. If the resolved path
 *    doesn't match the `/.git/worktrees/<name>` shape (e.g. a submodule's
 *    `.git/modules/<name>` gitdir), this falls back to the plain cwd
 *    basename rather than guessing a wrong repo root.
 * 4. If no `.git` is found (not a git repo), falls back to the cwd
 *    basename, matching prior behavior byte-for-byte for a repo root or a
 *    non-git directory.
 *
 * Results are memoized (see {@link DeriveProjectOptions.cache}) so the
 * filesystem walk runs at most once per unique cwd (this is called on
 * every session create/update and reconcile tick). The cache has no
 * invalidation; a cwd's git-repo identity is not expected to change for
 * the life of the daemon process.
 */
export function deriveProject(
  cwd: string,
  fallback: string,
  options: DeriveProjectOptions = {},
): string {
  const cache = options.cache ?? projectCache;

  const cached = cache.get(cwd);
  if (cached !== undefined) return cached;

  const homeDir = options.homeDir ?? homedir();
  const project =
    resolveGitAwareProject(cwd, homeDir) ?? cwdBasename(cwd) ?? fallback;
  cache.set(cwd, project);
  return project;
}

/**
 * Mirrors the pre-existing `cwd.split("/").pop()` derivation exactly
 * (rather than `path.basename`, which strips trailing slashes
 * differently) so a repo-root cwd produces a byte-identical result to
 * before this helper existed.
 */
function cwdBasename(cwd: string): string | null {
  const name = cwd.split("/").pop();
  return name ? name : null;
}

/**
 * Walk up from `cwd` looking for `.git`, stopping at `homeDir` or the
 * filesystem root. Returns the git-aware project name, or null if `cwd`
 * isn't inside a git repo (caller falls back to the cwd basename).
 */
function resolveGitAwareProject(cwd: string, homeDir: string): string | null {
  if (!isAbsolute(cwd)) return null;

  let dir = cwd;

  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      // statSync can still throw if the entry vanishes between the
      // existsSync check and here (e.g. a worktree being removed while
      // the daemon walks); the daemon loop must not see that throw.
      let stat;
      try {
        stat = statSync(gitPath);
      } catch {
        return null;
      }
      if (stat.isDirectory()) {
        // Main checkout: project = this dir's own basename.
        return cwdBasename(dir);
      }
      if (stat.isFile()) {
        return resolveWorktreeProject(gitPath, dir);
      }
      // Neither file nor directory (unexpected); treat as not a repo.
      return null;
    }

    if (dir === homeDir) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * A `.git` FILE holds `gitdir: <path>`. For a worktree, `<path>` points
 * into `<main>/.git/worktrees/<name>`; derive the main root's basename by
 * stripping that suffix. Returns null (caller falls back to cwd basename)
 * when the gitdir doesn't have that shape, e.g. a submodule's
 * `.git/modules/<name>` gitdir.
 */
function resolveWorktreeProject(
  gitFilePath: string,
  gitFileDir: string,
): string | null {
  let content: string;
  try {
    content = readFileSync(gitFilePath, "utf-8");
  } catch {
    return null;
  }

  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;

  const rawGitdir = match[1];
  const gitdir = isAbsolute(rawGitdir)
    ? rawGitdir
    : resolve(gitFileDir, rawGitdir);

  const marker = `${sep}.git${sep}worktrees${sep}`;
  const markerIdx = gitdir.lastIndexOf(marker);
  if (markerIdx === -1) return null;

  const mainRoot = gitdir.slice(0, markerIdx);
  return cwdBasename(mainRoot);
}
