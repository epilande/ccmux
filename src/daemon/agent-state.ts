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

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

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
  // A root of "" or "/" is under everything, so it would sweep the entire
  // projects map. No caller passes one today; refusing here means none ever
  // can by accident.
  if (root === "" || root === sep) return false;
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

/**
 * State entries whose directory no longer exists — the backlog `--state`
 * clears.
 *
 * An entry only counts as an orphan when its PARENT directory still exists.
 * Absence alone is not evidence of deletion: an unmounted external drive or a
 * disconnected network share makes every path on it vanish at once, and
 * without this rule a single `--state` run would drop the state for every
 * project on that volume in one write. A genuinely deleted worktree leaves
 * its parent (`…/worktrees/`) behind, so real orphans are still found, and
 * the ambiguous case is skipped rather than guessed.
 */
export function findOrphanEntries(state: AgentStateFile): string[] {
  const read = readStateObject(state.file);
  if (!read.ok) return [];
  const projects = projectsOf(read.data, state.projectsKey);
  if (!projects) return [];
  return Object.keys(projects).filter(
    (path) => !existsSync(path) && existsSync(dirname(path)),
  );
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
 * agent owns and rewrites constantly — a prune running from the daemon while
 * Claude Code is live is the NORMAL case, not a corner. The file is stat'd
 * before the read and again immediately before the rename, and the write is
 * abandoned if it changed in between, so a concurrent write becomes a
 * reported skip instead of silent wholesale loss. The remaining window is the
 * few milliseconds between the last stat and the rename, and the timestamped
 * copy is what makes even that recoverable.
 *
 * The rewrite is 2-space JSON with no trailing newline, byte-matching how
 * Claude Code formats the file, so a cleaned file stays diffable against its
 * backup.
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

  // A user who runs only Codex or only Cursor has no `~/.claude.json`, and
  // "nothing to clean" is the right answer for them, not an error printed on
  // every otherwise-successful prune.
  if (!existsSync(state.file)) return base;

  const before = fingerprint(state.file);
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
  // The pid disambiguates two cleanups landing in the same millisecond, which
  // would otherwise produce the same filename and have the second (already
  // cleaned) copy overwrite the first, losing the pre-state entirely.
  const backupPath = `${state.file}.ccmux-backup-${stamp}-${process.pid}`;
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
    // Last check before the swap. If the agent rewrote the file while we were
    // parsing it, our in-memory copy is already stale and renaming it over the
    // top would discard whatever it just wrote.
    const after = fingerprint(state.file);
    if (
      before &&
      after &&
      (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
    ) {
      return {
        ...base,
        backupPath,
        error:
          "the file changed while it was being cleaned (the agent wrote to it); " +
          "nothing was modified, re-run to try again",
      };
    }
    writeFileSync(tmp, JSON.stringify(read.data, null, 2));
    renameSync(tmp, state.file);
  } catch (err) {
    return {
      ...base,
      backupPath,
      error: `write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  pruneOldBackups(state.file);
  return { ...base, removed, backupPath };
}

/** mtime+size snapshot used to detect a concurrent write. */
function fingerprint(file: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** How many timestamped backups of one state file to keep. */
const MAX_BACKUPS = 3;

/**
 * Keep the newest {@link MAX_BACKUPS} backups and unlink the rest. The real
 * `~/.claude.json` is ~400KB, and one copy per prune run accumulates without
 * bound otherwise. Names sort lexicographically in timestamp order, so the
 * newest are simply the last ones.
 */
function pruneOldBackups(file: string): void {
  const dir = dirname(file);
  const prefix = `${basename(file)}.ccmux-backup-`;
  try {
    const backups = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of backups.slice(0, -MAX_BACKUPS)) {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // A backup we cannot remove is not worth failing the cleanup over.
      }
    }
  } catch {
    // Directory unreadable; leaving old backups is harmless.
  }
}
