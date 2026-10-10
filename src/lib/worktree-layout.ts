import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const DEFAULT_WORKTREE_PATH = ".claude/worktrees/{name}";

export interface WorktreeConfig {
  /** Main-checkout-relative, home-relative, or absolute directory template. */
  path?: string;
}

export type WorktreePathResolution =
  | { ok: true; path: string; parent: string; excludePattern: string | null }
  | { ok: false; error: string };

/** Pure interpolation; null preserves the name hole for reopened-name decoding. */
function renderWorktreeTemplate(
  mainRepoRoot: string,
  name: string | null,
  config: WorktreeConfig,
): string {
  const repo = basename(mainRepoRoot).replace(/[^A-Za-z0-9_-]+/g, "-");
  const template = config.path ?? DEFAULT_WORKTREE_PATH;
  if (name === null) return template.replace(/\{repo\}/g, repo);
  return template.replace(/\{(name|repo)\}/g, (_, key: string) =>
    key === "name" ? name : repo,
  );
}

/** A logical name occurs once in the final component; all other tokens are known. */
export function isWorktreePathTemplate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return false;
  const name = value.indexOf("{name}");
  return (
    name >= 0 &&
    name === value.lastIndexOf("{name}") &&
    basename(value).includes("{name}") &&
    !/[{}]/.test(value.replace(/\{(?:name|repo)\}/g, "")) &&
    (!value.startsWith("~") || value.startsWith("~/"))
  );
}

/** Hand-edited preferences are checked before any repository mutation. */
export function validateWorktreeConfig(config: unknown): string | null {
  if (config === undefined) return null;
  if (config === null || typeof config !== "object" || Array.isArray(config))
    return "worktree must be an object";
  const { path } = config as WorktreeConfig;
  if (path !== undefined && !isWorktreePathTemplate(path)) {
    return "worktree.path requires exactly one {name} in the final path segment, optional {repo}, and no unknown placeholders or control characters";
  }
  return null;
}

/** Resolve existing ancestors too: a symlink must not bypass the .git/root guards. */
function physicalPath(path: string): string {
  let ancestor = resolve(path);
  let suffix = "";
  for (;;) {
    try {
      return resolve(realpathSync.native(ancestor), suffix);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return resolve(path);
      suffix = join(basename(ancestor), suffix);
      ancestor = parent;
    }
  }
}

/** Pure policy over already-canonical root/parent values. */
function excludePatternForParent(root: string, parent: string): string | null {
  const inside = relative(root, parent);
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  )
    return null;
  const posix = inside.split(sep).join("/");
  if (posix === ".claude/worktrees") return "**/.claude/worktrees/";
  return `/${posix.replace(/[\\*?\[\]#! ]/g, "\\$&")}/`;
}

/** Effectful adapter: take a filesystem snapshot, then derive its ignore policy. */
export function worktreeExcludePattern(
  mainRepoRoot: string,
  path: string,
): string | null {
  const root = physicalPath(mainRepoRoot);
  const parent = physicalPath(dirname(path));
  return excludePatternForParent(root, parent);
}

/** Pure guards and metadata derivation; no ambient state or filesystem access. */
function validateResolvedPath(
  root: string,
  path: string,
): WorktreePathResolution {
  const parent = dirname(path);
  if (path === root)
    return {
      ok: false,
      error: `Worktree path '${path}' is the main checkout; choose another name or worktree.path`,
    };
  if (parent === root)
    return {
      ok: false,
      error:
        "worktree.path must not put its parent at the main checkout root, because the exclude would cover the repository",
    };
  if (path.split(sep).includes(".git") || /[\x00-\x1f\x7f]/.test(path))
    return {
      ok: false,
      error:
        "worktree.path must not resolve inside .git or contain control characters",
    };
  return {
    ok: true,
    path,
    parent,
    excludePattern: excludePatternForParent(root, parent),
  };
}

/** One shared resolution/validation contract for spawning and Move changes preflight. */
export function resolveWorktreePath(
  mainRepoRoot: string,
  name: string,
  config: WorktreeConfig = {},
): WorktreePathResolution {
  const invalid = validateWorktreeConfig(config);
  if (invalid) return { ok: false, error: invalid };
  const rendered = renderWorktreeTemplate(mainRepoRoot, name, config);
  const expanded = rendered.startsWith("~/")
    ? join(homedir(), rendered.slice(2))
    : rendered;
  const path = physicalPath(resolve(mainRepoRoot, expanded));
  const root = physicalPath(mainRepoRoot);
  return validateResolvedPath(root, path);
}

/** Reopened checkouts may use an older template; never guess when the current one differs. */
export function worktreeNameForPath(
  mainRepoRoot: string,
  path: string,
  config: WorktreeConfig = {},
): string {
  const template = basename(renderWorktreeTemplate(mainRepoRoot, null, config));
  const index = template.indexOf("{name}");
  const prefix = template.slice(0, index);
  const suffix = template.slice(index + "{name}".length);
  const directory = basename(path);
  if (
    index >= 0 &&
    directory.startsWith(prefix) &&
    directory.endsWith(suffix) &&
    directory.length > prefix.length + suffix.length
  ) {
    return directory.slice(prefix.length, directory.length - suffix.length);
  }
  return directory;
}
