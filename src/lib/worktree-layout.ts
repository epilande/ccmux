import { basename } from "node:path";

export const VALID_WORKTREE_LOCATIONS = ["nested", "sibling"] as const;

export interface WorktreeConfig {
  location?: (typeof VALID_WORKTREE_LOCATIONS)[number];
  /** Directory template; branch names are unaffected. */
  nameTemplate?: string;
}

/** Exactly one name placeholder, optional repo placeholders, safe literal text. */
export function isWorktreeNameTemplate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.split("{name}").length === 2 &&
    /^[A-Za-z0-9_-]*$/.test(value.replace(/\{(?:name|repo)\}/g, ""))
  );
}

/** Reject hand-edited invalid JSON before a spawn can change git or the filesystem. */
export function validateWorktreeConfig(config: unknown): string | null {
  if (config === undefined) return null;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return "worktree must be an object";
  }
  const { location, nameTemplate } = config as WorktreeConfig;
  if (location !== undefined && !VALID_WORKTREE_LOCATIONS.includes(location)) {
    return "worktree.location must be nested or sibling";
  }
  if (nameTemplate !== undefined && !isWorktreeNameTemplate(nameTemplate)) {
    return "worktree.nameTemplate must contain exactly one {name}, optional {repo}, and only letters, digits, underscores or hyphens";
  }
  return null;
}

/** Repo names may contain spaces or punctuation; keep the result a single safe component. */
export function worktreeDirectoryName(
  mainRepoRoot: string,
  name: string,
  config: WorktreeConfig = {},
): string {
  const repo = basename(mainRepoRoot).replace(/[^A-Za-z0-9_-]+/g, "-");
  return (config.nameTemplate ?? "{name}").replace(
    /\{(name|repo)\}/g,
    (_, key: string) => (key === "name" ? name : repo),
  );
}
