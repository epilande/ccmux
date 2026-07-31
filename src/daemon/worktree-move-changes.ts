/**
 * Relocating a checkout's UNCOMMITTED work into a fresh worktree.
 *
 * This is the one ccmux operation that handles work git cannot get back: a
 * commit is recoverable from the reflog, an uncommitted edit is not. So the
 * ordering below is the feature, not an implementation detail, and every
 * failure path is written to end with the user's changes still REACHABLE —
 * which is a weaker and more honest claim than "put back". A restore can
 * itself fail (the checkout changed underneath the move), and the confirmation
 * failures around the push return before there is an entry this function can
 * name. Every one of those still leaves the work in the stash, and every one
 * of them says which situation the caller is in rather than implying the
 * cheerful one: `sourceRestored` and `stashSha` exist for exactly that.
 *
 * The whole sequence runs under a per-repository lock, because the stash stack
 * is shared by every worktree of a repo and reading a status another move has
 * already stashed away answers the wrong question. See {@link withMoveLock}.
 *
 * The sequence:
 *
 *   1. Refuse outright if the source has a merge/rebase/cherry-pick/revert or
 *      bisect in progress, or if there is nothing to move.
 *   2. `git stash push` in the source. This is what removes the changes, and
 *      it is also the backup: from here until step 6 the work lives in a stash
 *      entry that nothing deletes.
 *   3. Create the worktree (injected; see {@link CreateWorktree}). It must be
 *      a FRESH one — a worktree the engine merely opened is refused, because
 *      the rollback below removes what it made.
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
 * OURS ONLY, PROVEN BY THE REF MOVING. `git stash push` exits 0 having
 * created NOTHING when the tree went clean between the status read and the
 * push ("No local changes to save"), and its message is not a unique
 * identifier — an entry from an earlier run of this very function carries the
 * same one. Recognising our entry by what is on top and what it is called
 * therefore adopts somebody else's work and then, at step 6, drops it. So
 * `refs/stash` is read before AND after the push, and only a ref that MOVED
 * proves an entry is ours. See {@link readStashRef}.
 *
 * There is deliberately NO `git reset --hard` on the source. `stash push`
 * already left it clean, so a reset would be redundant on the happy path and
 * destructive on any other: an agent working in that pane can create files in
 * the seconds this takes, and a reset would delete work this function never
 * stashed and cannot restore.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { normalizePath, runGit, type GitRun } from "./worktree-git";

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
  /**
   * Set when the changes landed as one worktree state instead of the staged
   * and unstaged halves they left as. Nothing is lost — every edit is in the
   * new checkout — but a `git add` the user had already done is not, so this
   * is worth a line rather than a silent difference they find at commit time.
   * Only ever set when there was a split to lose; see
   * {@link carriedStagedContent}.
   */
  flattenedIndex?: boolean;
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
  /** Untracked FILES, repo-relative. Never a directory; see below. */
  untrackedPaths: string[];
}

/**
 * Uncommitted work in a checkout, as paths rather than counts.
 *
 * `-z` rather than plain `--porcelain`: with NUL separators git emits paths
 * verbatim, while the default format quotes and escapes anything unusual. A
 * filename with a quote, a backslash, or a newline in it is rare but entirely
 * legal, and this list drives file copies.
 *
 * `--untracked-files=all` because git's default collapses a wholly untracked
 * directory into one `?? deep/` record. That is two problems in one: the
 * count it feeds ("3 untracked files") is wrong by however many files are
 * under there, and the copy it feeds gets a directory to recurse into rather
 * than a list to enumerate — which sweeps up the .env and node_modules inside
 * it, since a recursive copy has no idea git was excluding them. Expanded,
 * every path here is a file git would actually move, ignored content in
 * neither list.
 *
 * With ONE exception git will not expand for us: a nested checkout (a linked
 * worktree, a submodule) is reported as a directory even under `-uall`,
 * because git refuses to descend into another repository. `.claude/worktrees/`
 * is the case that matters, since ccmux puts its own worktrees there, and it
 * is handled where it belongs — the hosting repo excludes the directory, so
 * this read never sees it (`ensureWorktreesExcluded` in `worktree-create.ts`).
 *
 * The two-record shape of a rename is handled explicitly. `R  new\0old\0` is
 * ONE changed file described by two records, so counting records reports a
 * single `git mv` as two.
 */
export async function readUncommitted(
  checkout: string,
  git: GitRun = runGit,
): Promise<UncommittedState | null> {
  const res = await git(checkout, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);
  if (res.exitCode !== 0) return null;

  let modified = 0;
  const untrackedPaths: string[] = [];
  const records = res.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    // Ignored entries are not requested, so anything here is one or the other.
    if (status === "??") {
      if (path) untrackedPaths.push(path);
      continue;
    }
    modified++;
    // A rename or a copy spends a second record on the ORIGINAL path. It is
    // never a change of its own, so it is consumed here rather than counted.
    // Either half of the code can carry the letter (`RM` is a rename that was
    // edited afterwards), and no other status uses R or C.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return { modified, untrackedPaths };
}

/**
 * A shell command that drops the stash entry with this SHA.
 *
 * Not `git stash drop <sha>`: drop only accepts a `stash@{N}` reflog
 * reference and answers "'<sha>' is not a stash reference". And not a bare
 * `git stash drop` either, which takes whatever is on top — precisely the
 * entry this is trying not to name, since the reason a sha is being reported
 * at all is that the stack has moved. Looking the position up first is what
 * makes the advice work.
 *
 * `git stash apply <sha>` DOES work, which is why the recovery lines that
 * name a sha directly are fine as they are.
 *
 * Lives here rather than with the CLI text so the module's own real-git tests
 * can run the string and prove it.
 */
export function dropStashCommand(sha: string): string {
  return `git stash drop $(git stash list --format="%gd %H" | grep ${sha} | cut -d" " -f1)`;
}

/** Marks the stash entry as ours, for identification and for recovery. */
function stashMessage(name?: string): string {
  return `ccmux move-changes${name ? `: ${name}` : ""}`;
}

/**
 * The SHA at the top of the stash stack, or null when the stack is empty.
 *
 * Read either side of the push, because a ref that MOVED is the only proof
 * that the entry on top is the one this run made; see the module header.
 */
async function readStashRef(
  checkout: string,
  git: GitRun,
): Promise<string | null> {
  const res = await git(checkout, [
    "rev-parse",
    "--verify",
    "--quiet",
    "refs/stash",
  ]);
  if (res.exitCode !== 0) return null;
  return res.stdout.trim() || null;
}

/** The message of a stash entry, for confirming it is ours. */
async function stashSubject(
  checkout: string,
  sha: string,
  git: GitRun,
): Promise<string> {
  const res = await git(checkout, ["log", "-1", "--format=%s", sha]);
  return res.exitCode === 0 ? res.stdout : "";
}

/**
 * The repository whose stash stack a checkout shares, as a lock key.
 *
 * The shared admin directory rather than the working tree: every linked
 * worktree of a repo pushes onto ONE stack, so two moves running from two
 * worktrees of the same repo are exactly the collision that has to be
 * serialized, and their `--show-toplevel` paths differ. Resolved through
 * `normalizePath` so two routes to one repo (a symlinked `/tmp` on macOS,
 * a symlinked home) do not take two different locks over one stack.
 */
async function stashScopeKey(
  source: string,
  git: GitRun,
): Promise<string | null> {
  const res = await git(source, ["rev-parse", "--git-common-dir"]);
  if (res.exitCode !== 0) return null;
  const dir = res.stdout.trim();
  if (!dir) return null;
  return normalizePath(isAbsolute(dir) ? dir : join(source, dir));
}

/**
 * Per-repository serialization of the WHOLE move transaction, from the status
 * read to the drop.
 *
 * Every step in between reads or writes state the next move would read
 * differently: a status that another move has already stashed away reports a
 * clean tree, and a push that lands mid-transaction renumbers a stack the
 * other run is still holding a handle into. Serializing is what lets each run
 * reason about the stack as if it were alone with it.
 *
 * A SEPARATE map from `worktree-create.ts`'s `withRepoLock`, deliberately.
 * This lock is held ACROSS the creation engine's call, so the two would
 * deadlock the moment they shared a key, and keying them differently by
 * coincidence (an admin dir is not a repo root) is not a property worth
 * relying on. Nothing under the creation lock ever takes this one, so the
 * nesting has no cycle to close.
 */
const moveLocks = new Map<string, Promise<unknown>>();

async function withMoveLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = moveLocks.get(key) ?? Promise.resolve();
  // Chained off the previous holder's settlement, not its value, so one
  // failed move does not poison the queue behind it.
  const run = previous.then(fn, fn);
  moveLocks.set(
    key,
    run.catch(() => undefined),
  );
  try {
    return await run;
  } finally {
    if (moveLocks.get(key) === run) moveLocks.delete(key);
  }
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
 * Apply a stash entry into `checkout`, keeping the staged/unstaged split when
 * git will let us.
 *
 * `--index` is what preserves it. A plain apply merges both halves into one
 * worktree state, so once the entry drops the staged snapshot is gone — for
 * content the user deliberately `git add`ed that is lost work, not a
 * cosmetic difference in what `git status` prints.
 *
 * `--index` is ATTEMPTED only when the target's index already matches HEAD,
 * rather than tried and retried on failure. It refuses outright when the
 * target has staged changes of its own, and a failed attempt is not free: for
 * an entry made with `--include-untracked` it has already written the
 * untracked files back by then, so the plain retry fails with "already
 * exists" on a case that would have applied cleanly on the first try. Asking
 * first costs one `git diff --cached`. The retry stays for every other way
 * `--index` can fail, where the plain apply is no worse off than it would
 * have been alone.
 */
async function applyStash(
  checkout: string,
  ref: string,
  git: GitRun,
): Promise<{ ok: boolean; flattened: boolean; stderr: string }> {
  const staged = await git(checkout, ["diff", "--cached", "--quiet"]);
  if (staged.exitCode === 0) {
    const withIndex = await git(checkout, ["stash", "apply", "--index", ref]);
    if (withIndex.exitCode === 0) {
      return { ok: true, flattened: false, stderr: "" };
    }
  }
  const plain = await git(checkout, ["stash", "apply", ref]);
  return {
    ok: plain.exitCode === 0,
    flattened: plain.exitCode === 0,
    stderr: plain.stderr,
  };
}

/**
 * Whether a stash entry carries staged content, i.e. whether flattening it
 * actually loses anything.
 *
 * A stash's second parent is the index at push time, its first is HEAD. When
 * those trees agree there was nothing staged, and a plain apply reproduces
 * exactly what `--index` would have.
 */
async function carriedStagedContent(
  checkout: string,
  sha: string,
  git: GitRun,
): Promise<boolean> {
  const res = await git(checkout, ["diff", "--quiet", `${sha}^`, `${sha}^2`]);
  // 1 is "they differ"; anything else (128) is a question we could not ask,
  // and guessing "yes" would put a warning on a move that lost nothing.
  return res.exitCode === 1;
}

/**
 * Copy untracked FILES from the source into the new worktree.
 *
 * Copying (rather than letting the stash carry them) is what makes `copy`
 * safe: the source never stops having the files, so there is no window where
 * they exist only inside a stash entry.
 *
 * One path per file, never a directory, which is the whole reason
 * {@link readUncommitted} reads with `--untracked-files=all`. Handed git's
 * collapsed `?? deep/` instead, this would recurse into it and copy the .env
 * and the node_modules that git was deliberately excluding — content the move
 * has no business relocating in either mode. Ignored files travel through the
 * creation engine's file setup (`worktree.symlinkDirectories`,
 * `.worktreeinclude`) or not at all.
 *
 * `recursive` stays on for `cpSync`'s benefit rather than for directories:
 * it is what lets a single call handle whatever a path turns out to be.
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
  const { source, git = runGit } = input;

  // Resolved before the lock is taken, because it IS the lock's key. Doubles
  // as the "is this a checkout at all" probe, which is why the refusal below
  // is the not-a-repo one.
  const scope = await stashScopeKey(source, git);
  if (!scope) {
    return {
      ok: false,
      reason: "not-a-repo",
      error: `Not a git checkout: ${source}`,
    };
  }

  return withMoveLock(scope, () => runMove(input));
}

/** The transaction itself. Only ever called under {@link withMoveLock}. */
async function runMove(input: MoveChangesInput): Promise<MoveChangesResult> {
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
    // Read either side of the push: only a ref that MOVED proves the entry on
    // top belongs to this run.
    const before = await readStashRef(source, git);
    const pushed = await git(source, args);
    const after = await readStashRef(source, git);
    const fresh = after && after !== before ? after : null;

    if (pushed.exitCode !== 0) {
      // A failed push can still have created the entry: git writes
      // `refs/stash` before it cleans the working tree, so a failure while
      // removing untracked files leaves a complete entry behind a non-zero
      // exit. Reporting no sha there would hide the only handle on work that
      // is now half out of the tree.
      const ours =
        fresh && (await stashSubject(source, fresh, git)).includes(marker)
          ? fresh
          : undefined;
      return {
        ok: false,
        reason: "stash-failed",
        error:
          `Could not stash changes in ${source}: ${pushed.stderr.trim()}` +
          (ours
            ? ` A stash entry was created before it failed; your changes are in ${ours}.`
            : ""),
        ...(ours ? { stashSha: ours } : {}),
      };
    }

    if (!fresh) {
      // Exit 0 and nothing created: "No local changes to save", because the
      // tree went clean between the status read above and this push. The
      // entry on top (if any) is somebody else's — a previous run of this
      // function included, since they share this message — and adopting it
      // would apply and then DROP their work.
      return {
        ok: false,
        reason: "nothing-to-move",
        error:
          `Nothing to move: ${source} had no uncommitted changes left by the time they ` +
          `were stashed.`,
      };
    }

    // Ours was created, but something else pushed on top of it in between.
    // Our entry is still in the stack, but nothing here can tell it apart
    // from an identically-named one left by an earlier run, so this refuses
    // rather than guessing — and above all does not report the entry that
    // landed on top as if it were ours.
    if (!(await stashSubject(source, fresh, git)).includes(marker)) {
      return {
        ok: false,
        reason: "stash-failed",
        error:
          `Stashed the changes in ${source}, but another stash was pushed on top before ` +
          `they could be confirmed, so nothing further was done. The work is safe in the ` +
          `stash; find the 'ccmux move-changes' entry with 'git stash list' and recover it ` +
          `with 'git stash pop stash@{N}'.`,
      };
    }
    const sha = fresh;
    stashSha = sha;
  }

  /**
   * Put the source back the way it was found. Used by every failure below.
   *
   * Goes through {@link applyStash} for the same reason the worktree apply
   * does: a source whose staged and unstaged halves were merged back into one
   * is not the state it was found in. The flattening is not reported here —
   * the caller is already being told the move failed, and which half a
   * restored edit sits in is not the headline.
   */
  const restoreSource = async (): Promise<boolean> => {
    if (!stashSha) return true;
    const ref = await findStashRef(source, stashSha, git);
    return (await applyStash(source, ref ?? stashSha, git)).ok;
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
  let flattenedIndex = false;
  if (stashSha) {
    const ref = await findStashRef(source, stashSha, git);
    const applied = await applyStash(worktreePath, ref ?? stashSha, git);
    if (!applied.ok) {
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
    // Worth mentioning only when there WAS a split to lose.
    flattenedIndex =
      applied.flattened && (await carriedStagedContent(source, stashSha, git));
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
    ...(flattenedIndex ? { flattenedIndex: true } : {}),
  };
}
