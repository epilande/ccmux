/**
 * Per-directory agent state cleanup.
 *
 * Agents keep a map of "everything I know about this directory" keyed by
 * absolute path — Claude Code's `~/.claude.json` `projects` object is the one
 * ccmux handles today. Nothing prunes those entries when the directory is a
 * worktree that gets deleted, so they accumulate: on the machine this was
 * written against, 128 of 203 entries pointed at paths that no longer exist.
 *
 * Only Claude Code is wired up (issue #68 scopes it that way). Adding another
 * agent means appending one {@link AgentStateFile} descriptor below, not
 * touching any of the logic.
 */

import { copyFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/**
 * One agent's state file, described as "a JSON object at `file` whose
 * `projectsKey` property maps absolute directory paths to opaque state".
 */
export interface AgentStateFile {
  agent: string;
  file: string;
  projectsKey: string;
}

export function claudeStateFile(home: string = homedir()): AgentStateFile {
  return {
    agent: "claude",
    file: join(home, ".claude.json"),
    projectsKey: "projects",
  };
}

/** Every state file ccmux knows how to prune. */
export function builtinStateFiles(home: string = homedir()): AgentStateFile[] {
  return [claudeStateFile(home)];
}

export interface StateCleanupResult {
  agent: string;
  file: string;
  /** Path keys removed (or that would be removed, under `dryRun`). */
  removed: string[];
  /** Where the pre-edit copy went; null when nothing was written. */
  backupPath: string | null;
  /** Set when the file could not be read or written; nothing was changed. */
  error?: string;
}

/**
 * True when `entry` is `root` itself or a directory beneath it.
 *
 * Nested entries are the common case, not an edge case: an agent launched
 * from `<worktree>/src` records `<worktree>/src`, so removing only the exact
 * worktree path would leave its descendants behind forever. The separator
 * check keeps `/a/bc` from matching root `/a/b`.
 */
export function isUnderPath(entry: string, root: string): boolean {
  if (entry === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return entry.startsWith(prefix);
}

function readStateObject(
  file: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: false, error: "file does not exist" };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, error: "not a JSON object" };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function projectsOf(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const projects = data[key];
  if (
    typeof projects !== "object" ||
    projects === null ||
    Array.isArray(projects)
  ) {
    return null;
  }
  return projects as Record<string, unknown>;
}

/** Every state entry whose directory no longer exists — the backlog. */
export function findOrphanEntries(state: AgentStateFile): string[] {
  const read = readStateObject(state.file);
  if (!read.ok) return [];
  const projects = projectsOf(read.data, state.projectsKey);
  if (!projects) return [];
  return Object.keys(projects).filter((path) => !existsSync(path));
}

export interface CleanStateOptions {
  /** Report what would change without writing anything. */
  dryRun?: boolean;
  /** Timestamp source for the backup filename (injectable for tests). */
  now?: () => Date;
}

/**
 * Remove `paths` (and everything nested under them) from one agent's state
 * file, after copying the file aside.
 *
 * The backup is not decoration: this is a read-modify-write of a file the
 * agent owns and may rewrite at any moment, so a concurrent write can be lost
 * either way. The window is kept to the smallest possible (parse, delete,
 * atomic rename) and the copy is what makes the loss recoverable. The rewrite
 * is 2-space JSON, matching how Claude Code formats the file, so a cleaned
 * file stays diffable against its backup.
 */
export function cleanStateEntries(
  state: AgentStateFile,
  paths: string[],
  options: CleanStateOptions = {},
): StateCleanupResult {
  const base: StateCleanupResult = {
    agent: state.agent,
    file: state.file,
    removed: [],
    backupPath: null,
  };
  if (paths.length === 0) return base;

  const read = readStateObject(state.file);
  if (!read.ok) return { ...base, error: read.error };

  const projects = projectsOf(read.data, state.projectsKey);
  if (!projects) {
    return { ...base, error: `no "${state.projectsKey}" object` };
  }

  const removed = Object.keys(projects).filter((entry) =>
    paths.some((root) => isUnderPath(entry, root)),
  );
  if (removed.length === 0) return base;
  if (options.dryRun) return { ...base, removed };

  const stamp = (options.now?.() ?? new Date())
    .toISOString()
    .replace(/[:.]/g, "-");
  const backupPath = `${state.file}.ccmux-backup-${stamp}`;
  try {
    copyFileSync(state.file, backupPath);
  } catch (err) {
    return {
      ...base,
      error: `backup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  for (const entry of removed) delete projects[entry];

  const tmp = `${state.file}.ccmux-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(read.data, null, 2) + "\n");
    renameSync(tmp, state.file);
  } catch (err) {
    return {
      ...base,
      backupPath,
      error: `write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ...base, removed, backupPath };
}
