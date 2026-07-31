/**
 * Relocating a checkout's UNCOMMITTED work into a fresh worktree.
 *
 * This is the one ccmux operation that handles work git cannot get back: a
 * commit is recoverable from the reflog, an uncommitted edit is not. So the
 * ordering below is the feature, not an implementation detail, and every
 * failure path is written to end with the user's changes still reachable.
 *
 * The sequence:
 *
 *   1. Refuse outright if the source has a merge/rebase/cherry-pick in
 *      progress, or if there is nothing to move.
 *   2. `git stash push` in the source. This is what removes the changes, and
 *      it is also the backup: from here until step 6 the work lives in a stash
 *      entry that nothing deletes.
 *   3. Create the worktree (injected; see {@link CreateWorktree}).
 *   4. `git stash apply` INTO the new worktree.
 *   5. Copy untracked files across when the mode asks for it.
 *   6. Only now drop the stash entry.
 *
 * Two deliberate choices make the failure paths safe:
 *
 * APPLY, THEN DROP — never `pop`. `pop` is apply-and-drop, so a partial apply
 * takes the backup with it. Applying leaves the entry untouched, which makes
 * step 6 the single commit point: before it, every failure can put the source
 * back exactly as it was; after it, the work is in the worktree.
 *
 * BY SHA, never by position. `stash@{0}` names whatever is on top RIGHT NOW,
 * and stashes are shared across every worktree of a repo, so a concurrent
 * `git stash push` (a person, or another agent in another pane) silently
 * renumbers them. The entry's SHA is captured immediately after the push and
 * every later reference re-resolves it, so this can only ever apply or drop
 * the entry it created.
 *
 * There is deliberately NO `git reset --hard` on the source. `stash push`
 * already left it clean, so a reset would be redundant on the happy path and
 * destructive on any other: an agent working in that pane can create files in
 * the seconds this takes, and a reset would delete work this function never
 * stashed and cannot restore.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit, type GitRun } from "./worktree-git";

/**
 * What happens to files git is not tracking yet.
 *
 * `move` is the default because agents create new files constantly, and a
 * mode that quietly left them behind would strand exactly the work the user
 * was trying to relocate.
 */
export type UntrackedMode = "move" | "copy" | "leave";

export const UNTRACKED_MODES: readonly UntrackedMode[] = [
  "move",
  "copy",
  "leave",
];

export function isUntrackedMode(value: unknown): value is UntrackedMode {
  return (
    typeof value === "string" &&
    (UNTRACKED_MODES as readonly string[]).includes(value)
  );
}

/**
 * The worktree-creation seam.
 *
 * Kept injected rather than imported so this module can be exercised against
 * fixture repos, and so it composes with whatever creation engine the caller
 * has.
 *
 * It is deliberately NARROWER than the real engine (`createWorktree` in
 * `worktree-create.ts`, which also takes the repo root and a prompt to derive
 * a name from, and reports a result union rather than throwing). The caller
 * curries the parts this module has no business knowing and converts a
 * refusal into a throw, which is what lands here as `create-failed`; see the
 * adapter in `server.ts`'s spawn handler.
 *
 * `created` is load-bearing rather than informational. The real engine is
 * create-or-OPEN for an explicit name, so a path coming back here can be a
 * worktree that was already on disk with somebody's uncommitted work in it,
 * and this module's rollback deletes what it made with
 * `worktree remove --force`. A seam that reported only the path would make
 * those two indistinguishable, which is how a failed move came to delete a
 * checkout it had merely opened. See {@link moveChangesToWorktree}.
 */
export type CreateWorktree = (opts: {
  name?: string;
  base?: string;
}) => Promise<{ path: string; created: boolean }>;

export interface MoveChangesInput {
  /** Checkout whose uncommitted work is being relocated. */
  source: string;
  /** Passed through to the creation engine. */
  name?: string;
  base?: string;
  /** Defaults to `move`. */
  untracked?: UntrackedMode;
  createWorktree: CreateWorktree;
  git?: GitRun;
}

/** Why a move refused or failed, for callers that branch on the reason. */
export type MoveChangesFailure =
  | "not-a-repo"
  | "operation-in-progress"
  | "nothing-to-move"
  | "stash-failed"
  | "create-failed"
  | "apply-failed"
  | "copy-failed";

export interface MoveChangesOk {
  ok: true;
  worktreePath: string;
  /** Tracked files whose changes moved. */
  moved: number;
  untracked: { mode: UntrackedMode; files: string[] };
  /**
   * Set when the move succeeded but the now-redundant stash entry could not
   * be dropped. Harmless leftover, surfaced so it can be cleaned up rather
   * than discovered later as a mystery entry.
   */
  leftoverStash?: string;
}

export interface MoveChangesError {
  ok: false;
  reason: MoveChangesFailure;
  error: string;
  /**
   * The stash entry holding the user's work, when one exists and was
   * deliberately left in place. Always reported, because it is the handle
   * they need to get their changes back by hand.
   */
  stashSha?: string;
  /** True when the source checkout was put back the way it was found. */
  sourceRestored?: boolean;
}

export type MoveChangesResult = MoveChangesOk | MoveChangesError;

/**
 * In-progress operations that make relocating changes unsafe. Each is a state
 * where the index carries git's own half-finished work, so stashing would
 * capture that rather than (or as well as) the user's, and unwinding it is not
 * something this function should be inventing.
 *
 * Resolved through `rev-parse --git-path` rather than by joining `.git/`,
 * because in a linked worktree these live in that worktree's admin directory,
 * not in the shared one.
 */
const OPERATION_MARKERS: readonly [string, string][] = [
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["BISECT_LOG", "a bisect"],
];

export async function readOperationInProgress(
  checkout: string,
  git: GitRun = runGit,
): Promise<string | null> {
  for (const [marker, label] of OPERATION_MARKERS) {
    const res = await git(checkout, ["rev-parse", "--git-path", marker]);
    if (res.exitCode !== 0) continue;
    const path = res.stdout.trim();
    if (!path) continue;
    const resolved = path.startsWith("/") ? path : join(checkout, path);
    if (existsSync(resolved)) return label;
  }
  return null;
}

export interface UncommittedState {
  /** Tracked files with staged or unstaged changes. */
  modified: number;
  /** Untracked paths, repo-relative. A trailing `/` is a collapsed directory. */
  untrackedPaths: string[];
}

/**
 * Uncommitted work in a checkout, as paths rather than counts.
 *
 * `-z` rather than plain `--porcelain`: with NUL separators git emits paths
 * verbatim, while the default format quotes and escapes anything unusual. A
 * filename with a quote, a backslash, or a newline in it is rare but entirely
 * legal, and this list drives file copies.
 */
export async function readUncommitted(
  checkout: string,
  git: GitRun = runGit,
): Promise<UncommittedState | null> {
  const res = await git(checkout, ["status", "--porcelain", "-z"]);
  if (res.exitCode !== 0) return null;

  let modified = 0;
  const untrackedPaths: string[] = [];
  for (const record of res.stdout.split("\0")) {
    if (record === "") continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // Ignored entries are not requested, so anything here is one or the other.
    if (status === "??") {
      if (path) untrackedPaths.push(path);
    } else {
      modified++;
    }
  }
  return { modified, untrackedPaths };
}

/** Marks the stash entry as ours, for identification and for recovery. */
function stashMessage(name?: string): string {
  return `ccmux move-changes${name ? `: ${name}` : ""}`;
}

/**
 * Locate our stash entry's CURRENT position by SHA.
 *
 * Everything that touches the entry after creation goes through this, because
 * the stack is shared repo-wide and shifts under concurrent pushes.
 */
async function findStashRef(
  checkout: string,
  sha: string,
  git: GitRun,
): Promise<string | null> {
  const res = await git(checkout, ["stash", "list", "--format=%H%x09%gd"]);
  if (res.exitCode !== 0) return null;
  for (const line of res.stdout.split("\n")) {
    const [entrySha, ref] = line.split("\t");
    if (entrySha === sha && ref) return ref;
  }
  return null;
}

/**
 * Copy untracked paths from the source into the new worktree.
 *
 * Copying (rather than letting the stash carry them) is what makes `copy`
 * safe: the source never stops having the files, so there is no window where
 * they exist only inside a stash entry.
 */
function copyUntracked(
  source: string,
  destination: string,
  paths: string[],
): void {
  for (const rel of paths) {
    const from = join(source, rel);
    if (!existsSync(from)) continue;
    const to = join(destination, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}

/**
 * Move `source`'s uncommitted work into a new worktree, leaving the source
 * without it (and, on any failure, exactly as it was found).
 */
export async function moveChangesToWorktree(
  input: MoveChangesInput,
): Promise<MoveChangesResult> {
  const {
    source,
    name,
    base,
    untracked: mode = "move",
    createWorktree,
    git = runGit,
  } = input;

  const topLevel = await git(source, ["rev-parse", "--show-toplevel"]);
  if (topLevel.exitCode !== 0) {
    return {
      ok: false,
      reason: "not-a-repo",
      error: `Not a git checkout: ${source}`,
    };
  }

  const operation = await readOperationInProgress(source, git);
  if (operation) {
    return {
      ok: false,
      reason: "operation-in-progress",
      error:
        `Cannot move changes while ${operation} is in progress. ` +
        `Finish or abort it first.`,
    };
  }

  const state = await readUncommitted(source, git);
  if (!state) {
    return {
      ok: false,
      reason: "not-a-repo",
      error: `Could not read the status of ${source}`,
    };
  }

  // `leave` moves tracked changes only, so untracked files don't count toward
  // "is there anything to move" for it.
  const untrackedMoves = mode !== "leave";
  const filesToCopy = mode === "copy" ? state.untrackedPaths : [];
  const stashNeeded =
    state.modified > 0 || (mode === "move" && state.untrackedPaths.length > 0);

  if (!stashNeeded && filesToCopy.length === 0) {
    return {
      ok: false,
      reason: "nothing-to-move",
      error: untrackedMoves
        ? `Nothing to move: ${source} has no uncommitted changes.`
        : `Nothing to move: ${source} has no tracked changes, and untracked files are set to stay.`,
    };
  }

  // --- Step 2: stash. Past here the source has been modified, so every
  // failure below has to put it back. ---
  const marker = stashMessage(name);
  let stashSha: string | undefined;
  if (stashNeeded) {
    const args = ["stash", "push", "--message", marker];
    // Only `move` hands untracked files to the stash; `copy` duplicates them
    // by hand afterwards and `leave` never touches them.
    if (mode === "move") args.push("--include-untracked");
    const pushed = await git(source, args);
    if (pushed.exitCode !== 0) {
      return {
        ok: false,
        reason: "stash-failed",
        error: `Could not stash changes in ${source}: ${pushed.stderr.trim()}`,
      };
    }

    const head = await git(source, [
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/stash",
    ]);
    const sha = head.stdout.trim();
    const subject = await git(source, [
      "log",
      "-1",
      "--format=%s",
      "refs/stash",
    ]);
    // The entry we just made must be the one on top. If it is not, something
    // else pushed a stash in the microseconds since, and acting on the wrong
    // entry is exactly the mistake this module refuses to make.
    if (!sha || !subject.stdout.includes(marker)) {
      return {
        ok: false,
        reason: "stash-failed",
        error:
          `Stashed the changes in ${source}, but could not confirm which stash entry ` +
          `holds them, so nothing further was done. The work is safe in the stash; ` +
          `recover it with 'git stash list' and 'git stash pop'.`,
        stashSha: sha || undefined,
      };
    }
    stashSha = sha;
  }

  /** Put the source back the way it was found. Used by every failure below. */
  const restoreSource = async (): Promise<boolean> => {
    if (!stashSha) return true;
    const ref = await findStashRef(source, stashSha, git);
    const applied = await git(source, ["stash", "apply", ref ?? stashSha]);
    return applied.exitCode === 0;
  };

  // --- Step 3: create the worktree. ---
  let worktreePath: string;
  try {
    const created = await createWorktree({ name, base });
    worktreePath = created.path;
    if (!created.created) {
      // A worktree that was already there. The engine opens one happily for
      // an explicit name, and for an ordinary spawn that is the right answer,
      // but a move cannot use it: the rollback below force-removes the
      // worktree, which would take a checkout this run did not make and
      // whatever uncommitted work was sitting in it. Refusing costs a retry
      // under another name; the alternative costs somebody their files.
      const restored = await restoreSource();
      return {
        ok: false,
        reason: "create-failed",
        error:
          `A worktree already exists at ${created.path}, and moving changes needs a fresh one ` +
          `(pick another name, or leave the name empty). Nothing was moved.`,
        stashSha,
        sourceRestored: restored,
      };
    }
  } catch (err) {
    const restored = await restoreSource();
    return {
      ok: false,
      reason: "create-failed",
      error: `Could not create the worktree: ${
        err instanceof Error ? err.message : String(err)
      }`,
      stashSha,
      sourceRestored: restored,
    };
  }

  /**
   * Undo the creation. Best effort by design: the changes are what matter,
   * and a leftover directory is a far smaller problem than a failed rollback
   * masking the real error.
   *
   * Only ever reaches a worktree THIS run created: the branch above turns a
   * merely-opened one into a `create-failed` before any of the callers below
   * exist. That refusal is what makes an unconditional `--force` safe here.
   */
  const removeWorktree = async (): Promise<void> => {
    await git(source, ["worktree", "remove", "--force", worktreePath]);
  };

  // --- Step 4: apply into the new worktree. ---
  if (stashSha) {
    const ref = await findStashRef(source, stashSha, git);
    const applied = await git(worktreePath, [
      "stash",
      "apply",
      ref ?? stashSha,
    ]);
    if (applied.exitCode !== 0) {
      await removeWorktree();
      const restored = await restoreSource();
      return {
        ok: false,
        reason: "apply-failed",
        error:
          `Could not apply the changes in the new worktree: ${applied.stderr.trim()}. ` +
          `The worktree was removed and your changes were kept in the stash.`,
        stashSha,
        sourceRestored: restored,
      };
    }
  }

  // --- Step 5: untracked copies. ---
  if (filesToCopy.length > 0) {
    try {
      copyUntracked(source, worktreePath, filesToCopy);
    } catch (err) {
      await removeWorktree();
      const restored = await restoreSource();
      return {
        ok: false,
        reason: "copy-failed",
        error: `Could not copy untracked files into the worktree: ${
          err instanceof Error ? err.message : String(err)
        }`,
        stashSha,
        sourceRestored: restored,
      };
    }
  }

  // --- Step 6: the commit point. The work is in the worktree, so the backup
  // can go. A failure here is cosmetic and must not fail the move. ---
  let leftoverStash: string | undefined;
  if (stashSha) {
    const ref = await findStashRef(source, stashSha, git);
    const dropped = ref
      ? await git(source, ["stash", "drop", ref])
      : { exitCode: 1, stdout: "", stderr: "entry not found" };
    if (dropped.exitCode !== 0) leftoverStash = stashSha;
  }

  return {
    ok: true,
    worktreePath,
    moved: state.modified,
    untracked: {
      mode,
      files: mode === "leave" ? [] : state.untrackedPaths,
    },
    ...(leftoverStash ? { leftoverStash } : {}),
  };
}
