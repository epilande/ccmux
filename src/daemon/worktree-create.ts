/**
 * Creating a worktree to spawn an agent into (issue #69).
 *
 * The counterpart to `worktree-prune.ts`: that module ends a worktree's life,
 * this one starts it. They share `worktree-git.ts` for plumbing and the same
 * placement convention, `<main>/.claude/worktrees/<name>`, which is where
 * Claude Code puts the worktrees it creates for itself. Matching it keeps the
 * whole population under one layout, so the prune scan, the picker's grouping
 * and any existing tooling see one kind of worktree rather than two.
 *
 * Naming is mechanical and always will be: a slug from an explicit name or
 * from the first words of the prompt. No model is consulted, deliberately,
 * because a branch name that varies run to run is not something a user can
 * predict, script, or find again.
 *
 * TWO DELIBERATE DIVERGENCES from what Claude Code does with its own
 * worktrees, both chosen rather than overlooked:
 *
 * 1. The branch is the BARE slug. Claude Code prefixes its own with
 *    `worktree-`. Matching it was considered and rejected: "behave
 *    identically" is worth paying for in FILE SETUP, where a difference
 *    produces a worktree that misbehaves, but a branch name is user-facing
 *    intent rather than a compatibility surface. Someone typing
 *    `--worktree fix-thing` expects a branch called `fix-thing`, and a forced
 *    prefix would clutter every branch listing to no benefit.
 * 2. No lock is taken. Claude Code holds a session lock for the life of its
 *    session, which is why `git worktree list` shows its worktrees as
 *    `locked` with a reason naming the session and pid. Not copying it is the
 *    behavior we want on both sides: ccmux's prune skips locked worktrees, so
 *    a live Claude session is protected by its own lock, and a ccmux-created
 *    worktree is protected by prune's own rules instead. Those rules are what
 *    make the absent lock safe. A worktree with a session bound to it is
 *    never offered for removal, whatever that session's status is, so a
 *    worktree spawned here is protected for as long as its agent is around.
 *    And a worktree still sitting on the tip it was cut from does not read as
 *    merged, because a branch whose tip equals a base tip is excluded from
 *    that classification, so a fresh one is not mistaken for finished work.
 *    The limit of that is worth knowing, since it is narrower than "has no
 *    commits of its own": a worktree cut from an OLDER ref (a `base` of
 *    `main~1`) sits on no base tip, so it can read as merged-locally from the
 *    moment it exists and the bound session is the only thing holding it.
 *    What a lock would add on top of all that is protection for a worktree
 *    with no session at all, which is exactly the debris the prune exists to
 *    clear.
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { cp, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  listWorktrees,
  normalizePath,
  readSymlinkDirectories,
  runGit,
  type GitRun,
} from "./worktree-git";

/** Where worktrees live, relative to the main checkout. */
export const WORKTREE_DIR = join(".claude", "worktrees");

/**
 * The line written into the hosting repo's `.git/info/exclude`, matching what
 * Claude Code writes for its own worktrees.
 *
 * Slash-separated regardless of platform: this is a gitignore pattern, not a
 * path, and git does not accept a backslash separator.
 */
export const WORKTREE_EXCLUDE_PATTERN = "**/.claude/worktrees/";

/** How many words of a prompt a derived slug may use. */
const SLUG_WORDS = 3;
/** Hard cap on a derived slug, so a prompt of long words stays usable. */
const SLUG_MAX_CHARS = 40;
/**
 * How far the `-2`, `-3` search for a free derived name goes before giving
 * up. Well past any plausible number of concurrent agents on one phrasing;
 * exists so a repo in a state that makes every candidate look taken produces
 * an error instead of an unbounded loop of git calls.
 */
const MAX_NAME_ATTEMPTS = 50;

/**
 * Reduce a string to a name usable as both a directory and a git branch.
 *
 * Lowercase, non-alphanumerics collapsed to single hyphens, trimmed. The
 * result is deliberately conservative rather than maximally faithful: it has
 * to survive being a path component, a ref name, and a shell word, and the
 * union of those constraints is narrow. Returns "" when nothing usable
 * survives, which callers treat as "no name".
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/g, "");
}

/**
 * Derive a worktree name from a prompt's opening words.
 *
 * `"fix sidebar flicker on resize"` becomes `fix-sidebar-flicker`. Three
 * words is enough to tell two concurrent tasks apart while staying short
 * enough to read in a picker row and type at a prompt.
 *
 * Stripping happens before the word split so that punctuation does not
 * consume a word slot: `"fix: sidebar flicker"` yields the same three words
 * as the unpunctuated form rather than losing one to `fix:`.
 *
 * Two prompts that open the same way collide here by design, and the slug is
 * not the place to fix that: dropping stopwords or reaching further into the
 * prompt only moves the collision, and it costs the property that makes this
 * function worth having, which is that a user can predict the name. The
 * collision is resolved at create time instead, by numbering; see
 * {@link createWorktree}.
 */
export function slugFromPrompt(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, SLUG_WORDS);
  return slugify(words.join("-"));
}

/** What a fork's derived worktree name ends in, and what it must never lose. */
const FORK_SUFFIX = "-fork";

/**
 * The `-fork` name a fork's worktree derives, or "" when the label yields
 * nothing usable.
 *
 * The suffix is BUDGETED inside the cap rather than appended past it: the
 * label's own tail is cut to make room, so the result is never longer than a
 * slug and always ends in `-fork`. That is a property callers depend on, not
 * a nicety. `resolveWorktreeName` slugifies whatever name it is handed, so a
 * result over the cap was trimmed there instead — a long branch losing part
 * of the suffix, and one exactly at the cap losing all of it and deriving its
 * own branch's name, which numbering then turned into `<branch>-2`. Budgeting
 * here makes that re-slugify a no-op, so what the dialog previews and what
 * the worktree is called are the same string.
 */
export function slugForFork(label: string): string {
  const slug = slugify(label)
    .slice(0, SLUG_MAX_CHARS - FORK_SUFFIX.length)
    .replace(/-+$/g, "");
  return slug ? `${slug}${FORK_SUFFIX}` : "";
}

/**
 * The name a `--pr <n>` spawn's worktree derives.
 *
 * The `pr-<n>-` prefix is BUDGETED inside the cap the same way
 * {@link slugForFork} budgets its suffix, so `resolveWorktreeName`'s
 * re-slugify is a no-op and the number never gets trimmed off the front.
 *
 * The result must never be bare `pr-<n>`: Claude Code creates its own
 * fetch-only PR checkouts at `.claude/worktrees/pr-<n>`, and colliding with
 * one would put the agent in a detached checkout it does not own. The label
 * is normally the PR's head ref, but a ref made entirely of characters
 * `slugify` drops (a CJK branch name, say) leaves nothing behind, so a
 * literal `head` stands in rather than letting the name collapse.
 */
export function slugForPR(number: number, label: string): string {
  const prefix = `pr-${number}-`;
  const slug = slugify(label)
    .slice(0, SLUG_MAX_CHARS - prefix.length)
    .replace(/-+$/g, "");
  return `${prefix}${slug || "head"}`;
}

/**
 * The name an `--issue <n>` spawn's worktree derives, budgeted like
 * {@link slugForPR}.
 *
 * Bare `issue-<n>` is a fine fallback here — nothing else in the tree claims
 * that shape — so an unslugifiable title just yields the number.
 */
export function slugForIssue(number: number, title: string): string {
  const prefix = `issue-${number}`;
  const slug = slugify(title)
    .slice(0, SLUG_MAX_CHARS - prefix.length - 1)
    .replace(/-+$/g, "");
  return slug ? `${prefix}-${slug}` : prefix;
}

/**
 * Whether `name` is a worktree this tool cut for issue `number`.
 *
 * Family-exact, never a bare `startsWith`: `issue-14` must not claim
 * `issue-144-foo`. The separator is part of the prefix. Same rule the
 * source picker uses to mark a row as already checked out.
 */
export function isIssueWorktreeName(name: string, number: number): boolean {
  const exact = `issue-${number}`;
  return name === exact || name.startsWith(`${exact}-`);
}

/**
 * The worktree a previous `--issue <n>` spawn cut, if any.
 *
 * The SHORTEST name wins — that is the first spawn — matching
 * `worktreeForIssue` in the source picker so Enter and `POST /spawn` agree.
 */
export function pickIssueWorktree<T extends { name: string }>(
  number: number,
  worktrees: T[],
): T | null {
  const matches = worktrees.filter((row) =>
    isIssueWorktreeName(row.name, number),
  );
  if (matches.length === 0) return null;
  const [first] = [...matches].sort(
    (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
  );
  return first ?? null;
}

/**
 * What a checkout's HEAD is, for a caller that needs both to cut from it and
 * to name something after it.
 *
 * `ref` is what git is asked to branch from and `label` what a human reads,
 * and they differ only when HEAD is detached: `--abbrev-ref` answers the
 * literal string "HEAD" there, which ANOTHER checkout of the repo would
 * resolve to its own head, so the ref has to be the sha. The label is that
 * sha abbreviated, since a 40-character directory name is nobody's idea of a
 * worktree.
 *
 * A branch name is used as-is, not resolved to a sha: refs are shared by
 * every worktree of a repository, so it means the same commit from the main
 * checkout, and it reports far better than a sha does.
 */
export interface CheckoutHead {
  ref: string;
  label: string;
}

/** Null for an unborn HEAD or anything that is not a checkout at all. */
export async function readCheckoutHead(
  checkout: string,
  git: GitRun = runGit,
): Promise<CheckoutHead | null> {
  const branch = await git(checkout, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = branch.stdout.trim();
  if (branch.exitCode !== 0 || !name) return null;
  if (name !== "HEAD") return { ref: name, label: name };

  const head = await git(checkout, ["rev-parse", "HEAD"]);
  const sha = head.stdout.trim();
  if (head.exitCode !== 0 || !sha) return null;
  return { ref: sha, label: sha.slice(0, 12) };
}

/**
 * The name a request resolves to, or an error explaining why it cannot.
 *
 * An explicit name always wins. A prompt-derived name is the convenience
 * path, and `derivedName` is the same convenience for a caller that has to do
 * the deriving itself: a fork carries no prompt (`POST /spawn` refuses the
 * combination), so its destination is named after the source's branch by the
 * route that knows what it forked. None of the three is an error rather than
 * a generated placeholder: an arbitrary name would be a directory and a
 * branch the user did not choose and cannot guess later.
 *
 * `derived` travels with the name because the two are not interchangeable
 * downstream: an explicit name is a request for THAT worktree, while a
 * derived one is a guess at a title and has to give way to an existing
 * worktree of the same name rather than joining it. See
 * {@link createWorktree}.
 */
export function resolveWorktreeName(
  name: string | undefined,
  prompt: string | undefined,
  derivedName?: string,
): { ok: true; name: string; derived: boolean } | { ok: false; error: string } {
  if (name !== undefined && name.trim() !== "") {
    const slug = slugify(name);
    if (!slug) {
      return {
        ok: false,
        error: `Worktree name '${name}' has no usable characters (letters and digits only)`,
      };
    }
    return { ok: true, name: slug, derived: false };
  }
  if (prompt !== undefined && prompt.trim() !== "") {
    const slug = slugFromPrompt(prompt);
    if (slug) return { ok: true, name: slug, derived: true };
  }
  if (derivedName !== undefined && derivedName.trim() !== "") {
    const slug = slugify(derivedName);
    if (slug) return { ok: true, name: slug, derived: true };
  }
  return {
    ok: false,
    error:
      "A worktree needs a name: pass one explicitly, or give a prompt to derive it from",
  };
}

/** Absolute path of the worktree a name resolves to. */
export function worktreePathFor(mainRepoRoot: string, name: string): string {
  return join(mainRepoRoot, WORKTREE_DIR, name);
}

/**
 * The start point for the new branch: an explicit `base`, else the MAIN
 * checkout's current branch.
 *
 * The default is read from the main checkout, never from wherever the caller
 * happens to be. A user working on a release branch in their main checkout
 * gets worktrees off that branch, which is what "another agent on what I am
 * doing" means, but a caller inside a LINKED worktree gets the main
 * checkout's branch rather than their own, and has to pass `base` to branch
 * off what they are looking at. Which ref won is reported back in
 * {@link WorktreeCreation.base}, so the answer is visible rather than
 * assumed. A detached main checkout reports `HEAD`, which git accepts as a
 * start point.
 *
 * A MOVE never reaches this default: `runMove` resolves the source checkout's
 * own HEAD sha and passes it as `base`, because relocating uncommitted work
 * onto the main checkout's branch drops the commits it was written against.
 */
export async function resolveBase(
  mainRepoRoot: string,
  base: string | undefined,
  git: GitRun = runGit,
): Promise<{ ok: true; base: string } | { ok: false; error: string }> {
  if (base !== undefined && base.trim() !== "") {
    const verified = await git(mainRepoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${base}^{commit}`,
    ]);
    if (verified.exitCode !== 0) {
      return { ok: false, error: `Base ref not found: ${base}` };
    }
    return { ok: true, base };
  }

  const current = await git(mainRepoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (current.exitCode !== 0) {
    return { ok: false, error: "Could not resolve the repository's HEAD" };
  }
  return { ok: true, base: current.stdout.trim() || "HEAD" };
}

/** What a create request did, so callers can report it honestly. */
export interface WorktreeCreation {
  path: string;
  name: string;
  branch: string;
  /** False when an existing worktree was opened rather than created. */
  created: boolean;
  /**
   * False when the branch was already there and got checked out as it stood.
   * A reused branch can carry any amount of history, so a caller reporting
   * this creation must not describe it as a new branch.
   */
  branchCreated: boolean;
  /**
   * The ref the branch was cut from, as {@link resolveBase} resolved it.
   * Absent when nothing was cut: opening an existing worktree and checking
   * out an existing branch both start from history this request did not
   * choose, and naming a base for them would be a guess.
   */
  base?: string;
  /** Paths symlinked in from the main checkout. */
  symlinked: string[];
  /** Paths copied in from the main checkout. */
  included: string[];
}

export interface CreateWorktreeOptions {
  git?: GitRun;
  /** Injectable for tests; defaults to the real filesystem work. */
  applyFileSetup?: (
    mainRepoRoot: string,
    worktreePath: string,
  ) => Promise<{ symlinked: string[]; included: string[] }>;
}

/**
 * Resolve `.worktreeinclude` to the concrete files to copy.
 *
 * The file is GITIGNORE SYNTAX, not a list of literal paths, and the contract
 * is a dual filter: a path is included only if it matches a pattern AND is
 * gitignored. The second half is what stops a tracked file from being
 * duplicated into the worktree, where it would shadow the checkout's own copy
 * and silently diverge from it.
 *
 * Both halves are delegated to git rather than reimplemented, because
 * gitignore semantics (negation, anchoring, directory-only patterns,
 * precedence) are far too subtle to reproduce by hand:
 *
 * - `--others --ignored --exclude-from=<file>` lists untracked paths matching
 *   the include patterns. `--others` is what excludes tracked files.
 * - `--others --ignored --exclude-standard` lists everything the repo's own
 *   ignore rules cover.
 *
 * The intersection is the contract. Verified on a fixture: a file that is
 * untracked and matches an include pattern but is NOT gitignored appears in
 * the first list alone and is correctly absent from the intersection.
 */
export async function resolveWorktreeIncludes(
  mainRepoRoot: string,
  git: GitRun = runGit,
): Promise<string[]> {
  const includePath = join(mainRepoRoot, ".worktreeinclude");
  if (!existsSync(includePath)) return [];

  const [matching, ignored] = await Promise.all([
    git(mainRepoRoot, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      `--exclude-from=${includePath}`,
    ]),
    git(mainRepoRoot, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
    ]),
  ]);
  if (matching.exitCode !== 0 || ignored.exitCode !== 0) return [];

  // `-z` is not just a separator choice: without it git C-QUOTES any path with
  // a non-ASCII or special byte, so `café.local` comes back as the literal
  // `"caf\303\251.local"` and every filesystem call on it misses. NUL
  // termination disables the quoting, so an entry is kept byte for byte.
  const entries = (out: string): string[] =>
    out.split("\0").filter((l) => l !== "");
  const ignoredSet = new Set(entries(ignored.stdout));
  return entries(matching.stdout).filter((path) => ignoredSet.has(path));
}

/**
 * Guard against a configured path escaping the worktree.
 *
 * `.claude/settings.json` and `.worktreeinclude` are repo content, so on a
 * repo someone else wrote they are untrusted input that this module turns
 * into filesystem writes. A `../` entry would otherwise write outside the
 * worktree it is supposed to be setting up.
 */
function isInside(parent: string, candidate: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  return (
    resolvedCandidate === resolvedParent ||
    resolvedCandidate.startsWith(resolvedParent + "/")
  );
}

/**
 * Apply the two file-setup conventions Claude Code uses for its own
 * worktrees, so a ccmux-created worktree is indistinguishable from one the
 * agent made and needs no ccmux-specific configuration.
 *
 * WHAT IS CONTRACT AND WHAT IS NOT. This reimplements another tool's
 * behavior, so it is worth being explicit about how much each part is
 * guaranteed, because the answers differ and the undocumented ones can drift
 * with a Claude Code release:
 *
 * - DOCUMENTED: `.worktreeinclude` is gitignore syntax, it COPIES rather than
 *   symlinks, and it applies a dual filter (matches a pattern AND is
 *   gitignored). Both halves are delegated to git in
 *   {@link resolveWorktreeIncludes} rather than reimplemented.
 * - OBSERVED against the real implementation (`claude --worktree` run on a
 *   throwaway fixture, so these are its actual outputs rather than
 *   inferences) and NOT documented, so any of it can drift with a release:
 *   the placement is the same `<main>/.claude/worktrees/<name>`;
 *   `symlinkDirectories` produces an ABSOLUTE symlink into the main checkout;
 *   an entry whose source does not exist is skipped rather than failing; and
 *   a NESTED entry (`nested/cache`) was not linked at all, where this
 *   implementation does create it, having already made the parent directory.
 *   Doing slightly more there is harmless: the link points at real content
 *   the repo asked to share.
 * - CONFIRMED by experiment rather than taken on trust: `.worktreeinclude`
 *   really does leave tracked files alone. A tracked file matching an include
 *   pattern, modified in the main working copy, arrived in the new worktree
 *   with the COMMITTED content, proving git's checkout supplied it and the
 *   include pass did not copy over the top.
 * - CONSERVATIVE CHOICES where behavior could not be pinned down, each
 *   picked so the failure mode is a worktree that needs one manual step
 *   rather than one that lost something: a missing source is skipped instead
 *   of failing the spawn; an existing target is never overwritten, so a
 *   checked-out path of the same name is never replaced by a link; and every
 *   step is reported in the result so a user can see what was applied and
 *   why their worktree looks the way it does.
 *
 * Known upstream interactions worth remembering: writing to a symlinked file
 * replaces the symlink with a regular file (atomic rename), and
 * `git worktree remove` refuses to remove symlinks as untracked entries.
 * Neither breaks ccmux's own prune, which renames the directory aside and
 * calls `git worktree prune` rather than `git worktree remove`, and whose
 * recursive delete unlinks symlinks instead of following them.
 *
 * Locking is the one observed behavior deliberately not copied; see
 * divergence 2 in this file's header for why.
 *
 * Symlinks for `worktree.symlinkDirectories` (a shared `node_modules` is the
 * point: copying it would be slow and would double the disk cost of every
 * worktree), copies for `.worktreeinclude` (local settings and secrets, where
 * a symlink would silently propagate an edit in one worktree back to the main
 * checkout and every sibling).
 *
 * Every step is best-effort and reported rather than fatal. A worktree with
 * an unlinked `node_modules` still works after an install; a worktree that
 * failed to be created because a symlink could not be made is just gone.
 */
export async function applyWorktreeFileSetup(
  mainRepoRoot: string,
  worktreePath: string,
  git: GitRun = runGit,
): Promise<{ symlinked: string[]; included: string[] }> {
  const symlinked: string[] = [];
  const included: string[] = [];

  for (const entry of readSymlinkDirectories(mainRepoRoot)) {
    const source = join(mainRepoRoot, entry);
    const target = join(worktreePath, entry);
    if (!isInside(worktreePath, target)) continue;
    if (!existsSync(source)) continue;
    // An existing target is left alone: `git worktree add` may have checked
    // out a tracked path of the same name, and replacing it would delete
    // repository content.
    if (existsSync(target) || isSymlink(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target);
      symlinked.push(entry);
    } catch {
      // Reported by omission; see the doc comment.
    }
  }

  for (const entry of await resolveWorktreeIncludes(mainRepoRoot, git)) {
    const source = join(mainRepoRoot, entry);
    const target = join(worktreePath, entry);
    if (!isInside(worktreePath, target)) continue;
    if (!existsSync(source)) continue;
    // Same guard as the symlink loop, and the symlink half matters as much
    // here: a DANGLING symlink checked out at the target reads as absent to
    // `existsSync`, and a copy would then write THROUGH it to wherever it
    // points, which the escape guard above cannot see because the escape is
    // in the link's text rather than in the entry's.
    if (existsSync(target) || isSymlink(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      await cp(source, target, { recursive: true });
      included.push(entry);
    } catch {
      // Same as above.
    }
  }

  return { symlinked, included };
}

/** `existsSync` follows symlinks, so a broken one reads as absent. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Per-repo serialization of worktree creation.
 *
 * `git worktree add` mutates shared repository state (the admin directory,
 * and `config.worktree` when the repo uses per-worktree config), and two
 * spawns racing on one repo is the normal case for this feature rather than
 * an edge case: "start three agents on this" is the point. Keyed by main
 * checkout so unrelated repos still proceed in parallel.
 */
const repoLocks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(
  mainRepoRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = repoLocks.get(mainRepoRoot) ?? Promise.resolve();
  // Chained off the previous holder's settlement, not its value, so one
  // failed creation does not poison the queue behind it.
  const run = previous.then(fn, fn);
  repoLocks.set(
    mainRepoRoot,
    run.catch(() => undefined),
  );
  try {
    return await run;
  } finally {
    // Only the last waiter clears the slot, so a queue that has drained does
    // not leak an entry per repo for the daemon's lifetime.
    if (repoLocks.get(mainRepoRoot) === run) repoLocks.delete(mainRepoRoot);
  }
}

/** Whether the repo already has a local branch of this name. */
async function localBranchExists(
  mainRepoRoot: string,
  name: string,
  git: GitRun,
): Promise<boolean> {
  const res = await git(mainRepoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${name}`,
  ]);
  return res.exitCode === 0;
}

/**
 * The first free name in the `<slug>`, `<slug>-2`, `<slug>-3` series.
 *
 * Only ever asked for a DERIVED name. A derived slug is three words of a
 * prompt, so two unrelated tasks that open the same way land on it constantly:
 * "fix the flaky test in the sidebar" and "fix the flaky test in the binder"
 * both derive `fix-the-flaky`. Opening the existing worktree there would put
 * the second agent in the first agent's checkout, on the first agent's
 * branch, with neither of them told: the exact opposite of what "start three
 * agents on this" asked for.
 *
 * Free means all three of no worktree registered at the path, nothing on disk
 * at the path, and no branch of that name. The branch has to count too,
 * because the create path below reuses a branch it finds, and for a name
 * nobody typed that would silently start the agent on unrelated history.
 *
 * `branchOverridden` drops that third test, and only that one: when the
 * caller names the branch itself the name is a directory label and nothing
 * else, so a same-named branch says nothing about this worktree and skipping
 * to `-2` over it would rename the checkout for no reason.
 *
 * Runs under the repo lock, so concurrent spawns of one prompt each see the
 * previous one's worktree and take the next number.
 */
async function firstFreeDerivedName(
  mainRepoRoot: string,
  slug: string,
  git: GitRun,
  branchOverridden: boolean,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? slug : `${slug}-${attempt}`;
    const path = worktreePathFor(mainRepoRoot, candidate);
    if (existsSync(path) || isSymlink(path)) continue;
    if (await isRegisteredWorktree(mainRepoRoot, path, git)) continue;
    if (
      !branchOverridden &&
      (await localBranchExists(mainRepoRoot, candidate, git))
    ) {
      continue;
    }
    return { ok: true, name: candidate };
  }
  return {
    ok: false,
    error: `Could not find a free worktree name near '${slug}' after ${MAX_NAME_ATTEMPTS} tries; pass a name explicitly`,
  };
}

/**
 * Record the ref a new branch was cut from as `branch.<name>.ccmux-base`, so
 * a later review can ask what the branch changed instead of guessing the
 * repo's default branch (`resolveMergeBase`, `tui/utils/review.ts`).
 *
 * Branch config is the right home because git maintains it: the section is
 * deleted with the branch and renamed with a rename, so the record lives
 * exactly as long as the thing it describes and there is no cleanup of ours.
 *
 * A NAME is stored as one, deliberately — the merge-base still lands on the
 * fork point after the user merges the base back in, where a pinned sha would
 * drift. What must not survive is anything whose meaning depends on WHERE it
 * is evaluated, because this is read back from the worktree, where HEAD is
 * the branch's own tip: `HEAD` and `@` on a detached main checkout, `HEAD~1`
 * and `HEAD^`, `@{-1}`. Stored verbatim, the first two make the merge-base
 * the branch tip itself (a review of a fully committed worktree that reports
 * nothing to review), and the rest silently review the wrong range.
 *
 * So the value is what `--symbolic-full-name` NAMES the base, when that is a
 * real ref: `refs/heads/main` for `main`, and equally for `@{-1}` or
 * `main@{u}`, which name a ref here and something else, or nothing, in the
 * worktree. Everything git cannot name that way — a rev expression, a raw
 * sha, `HEAD` while detached (which names the literal `HEAD`) — is pinned to
 * its commit instead, and skipped when even that cannot be answered.
 *
 * Best-effort, like the exclude-file append: a config write that will not
 * take costs a later review its accuracy, not this caller their worktree.
 */
async function recordBranchBase(
  mainRepoRoot: string,
  branch: string,
  base: string,
  git: GitRun,
): Promise<void> {
  const key = `branch.${branch}.ccmux-base`;
  // The exit code decides nothing here: a rev expression git cannot name
  // (`HEAD~1`, a raw sha) still exits 0, with empty output.
  const symbolic = await git(mainRepoRoot, [
    "rev-parse",
    "--symbolic-full-name",
    "--verify",
    "--quiet",
    base,
  ]);
  const ref = symbolic.stdout.trim();
  if (ref.startsWith("refs/")) {
    await git(mainRepoRoot, ["config", key, ref]);
    return;
  }
  const commit = await git(mainRepoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${base}^{commit}`,
  ]);
  const sha = commit.stdout.trim();
  if (commit.exitCode !== 0 || !sha) return;
  await git(mainRepoRoot, ["config", key, sha]);
}

/**
 * Create the worktree for a spawn, or open the existing one.
 *
 * For an EXPLICIT name, create-or-open rather than create-or-fail: "spawn an
 * agent on this task" asked for an agent in that worktree, and if the
 * worktree is already there the request is satisfiable. Failing would make
 * the second spawn of a name an error the user has to resolve by hand for no
 * benefit.
 *
 * For a DERIVED name, a collision takes the next free number instead. Nobody
 * asked for that name, so there is no intent to honor by opening it, and the
 * headline case for this feature is several agents started on one prompt:
 * create-or-open would quietly stack them in one checkout on one branch.
 * Numbering is the whole fix; see {@link firstFreeDerivedName}.
 *
 * `branch` decouples the branch from the directory name for the one caller
 * that has to: a `--pr` spawn must land on the PR's OWN head ref so that
 * `git push` works out of the box, while its directory is named after the PR
 * number. Overriding here rather than duplicating the creation logic is what
 * keeps the lock, the numbering, the occupied-path refusals and the file
 * setup shared. With an override the caller also SETTLES whether that branch
 * already exists, through `branchExists`: the checks that make reuse safe are
 * its own (see `gh-spawn-source.ts`), and they ran under a different
 * acquisition of the same lock, so re-deriving the answer here would let a
 * branch that appeared in between be checked out as if it had passed them
 * (issue #157).
 */
export async function createWorktree(
  mainRepoRoot: string,
  request: {
    name?: string;
    base?: string;
    prompt?: string;
    /** A name the CALLER derived, carrying the same collision semantics. */
    derivedName?: string;
    /** The branch to check out, when it must differ from the name. */
    branch?: string;
    /**
     * Whether `branch` already exists, as the CALLER settled it. Only read
     * alongside `branch`; omitted, the answer is derived here.
     *
     * The point is that it is a DECISION carried forward, not a fact
     * re-measured. `preparePRBranch` validates the branch and releases the
     * repo lock before this function takes it (`withRepoLock` is not
     * reentrant), so a branch created inside that window would otherwise be
     * checked out unconditionally and then reconfigured to track the PR —
     * without ever passing the upstream checks that exist to prove it IS the
     * PR (issue #157). Carrying the decision makes either race direction a
     * refusal instead. `-b` refuses a branch that appeared, but git alone
     * does NOT cover the other direction: `git worktree add <path> <branch>`
     * with the local branch gone DWIMs it back into existence from
     * `<remote>/<branch>` (git-worktree(1), default behaviour), silently
     * checking out history that never passed those checks. So the create
     * re-measures under its own lock and refuses on disagreement. Only
     * re-measuring to REUSE would be the bug; re-measuring to REFUSE is what
     * covers both directions.
     */
    branchExists?: boolean;
    /**
     * Whether to write `branch.<branch>.ccmux-base` for a branch this cut.
     * Defaults to true; only a caller whose base is NOT a review base opts
     * out.
     *
     * A `--pr` spawn is that caller: its cut point is the PR head itself, so
     * the record would name the branch as its own base and the picker's `D`
     * review would diff it against itself — a merge-base equal to HEAD,
     * which settles the lookup and never reaches the heuristic fallback.
     * `configurePRBranch` owns that key on this path and writes the branch
     * the PR actually targets; when it cannot, no key is better than a
     * poison one, because absence is what makes the fallback run.
     *
     * Explicit rather than inferred from `branch`: a branch override happens
     * to be the only opt-out caller today, but a future one with no second
     * writer wants the record, and inference would silently deny it.
     */
    recordBase?: boolean;
    /**
     * Open a registered worktree this pick returns, instead of numbering a
     * sibling of the derived name.
     *
     * `--issue` is the caller: a second spawn of the same issue must land
     * in the first checkout, not `issue-<n>-<slug>-2`. Runs under the repo
     * lock, so a checkout that appeared since the picker was opened is
     * still found.
     */
    reuseExisting?: (
      worktrees: { name: string; path: string }[],
    ) => { name: string; path: string } | null;
  },
  options: CreateWorktreeOptions = {},
): Promise<
  { ok: true; result: WorktreeCreation } | { ok: false; error: string }
> {
  const git = options.git ?? runGit;
  const fileSetup = options.applyFileSetup ?? applyWorktreeFileSetup;

  const named = resolveWorktreeName(
    request.name,
    request.prompt,
    request.derivedName,
  );
  if (!named.ok) return named;

  return withRepoLock(mainRepoRoot, async () => {
    // Before anything looks at the directory, so the very first worktree in a
    // repo is already invisible to git by the time it exists. Idempotent, so
    // running it on the open path too costs one `check-ignore` and heals a
    // repo whose worktrees predate this.
    await ensureWorktreesExcluded(mainRepoRoot, git);

    const openIfPresent = async (
      path: string,
      name: string,
    ): Promise<{ ok: true; result: WorktreeCreation } | null> => {
      if (!existsSync(path)) return null;
      if (!(await isRegisteredWorktree(mainRepoRoot, path, git))) return null;
      const branch = await currentBranch(path, git);
      return {
        ok: true as const,
        result: {
          path,
          name,
          branch: branch ?? name,
          created: false,
          branchCreated: false,
          symlinked: [],
          included: [],
        },
      };
    };

    // A `--pr` spawn names the branch itself. git will not check the same
    // branch out in two worktrees, so if it is already here, OPEN that
    // checkout rather than numbering a sibling that git would refuse.
    if (request.branch !== undefined) {
      for (const entry of await listWorktrees(mainRepoRoot, git)) {
        if (entry.bare || entry.branch !== request.branch) continue;
        const opened = await openIfPresent(entry.path, basename(entry.path));
        if (opened) return opened;
      }
    }

    if (request.reuseExisting) {
      const listed = (await listWorktrees(mainRepoRoot, git))
        .filter((entry) => !entry.bare)
        .map((entry) => ({ name: basename(entry.path), path: entry.path }));
      const hit = request.reuseExisting(listed);
      if (hit) {
        const opened = await openIfPresent(hit.path, hit.name);
        if (opened) return opened;
      }
    }

    // Inside the lock, so two spawns of one prompt cannot both settle on the
    // same free number.
    const resolved = named.derived
      ? await firstFreeDerivedName(
          mainRepoRoot,
          named.name,
          git,
          request.branch !== undefined,
        )
      : { ok: true as const, name: named.name };
    if (!resolved.ok) return resolved;
    const name = resolved.name;
    const branchName = request.branch ?? name;
    const path = worktreePathFor(mainRepoRoot, name);

    // Registered with git already: open it, whatever is on disk.
    const registered = await isRegisteredWorktree(mainRepoRoot, path, git);
    if (registered) {
      if (!existsSync(path)) {
        return {
          ok: false as const,
          error: `Worktree '${name}' is registered but its directory is missing; run 'git worktree prune' or 'ccmux worktree prune' first`,
        };
      }
      const branch = await currentBranch(path, git);
      return {
        ok: true as const,
        result: {
          path,
          name,
          branch: branch ?? name,
          created: false,
          branchCreated: false,
          symlinked: [],
          included: [],
        },
      };
    }

    // Not registered, but something is at the path. Whatever it is, it is not
    // this repo's worktree, and the only shape that can be cleared safely is
    // an EMPTY directory. A `.git` says the path was a checkout, so it
    // belongs to another repository or to a worktree this repo lost track of.
    // Any other content is someone's files, and the top level does not tell
    // us whose: `<path>/sub/.git` is a nested repo with work in it, and a
    // recursive delete would take it. Clearing a non-empty directory buys
    // nothing anyway, since `git worktree add` refuses a non-empty target.
    // Refusing costs the user one message; clearing costs them their files.
    // This deliberately departs from issue #69's "no .git inside, so remove
    // it" design.
    if (existsSync(path) || isSymlink(path)) {
      // `existsSync` follows symlinks, so a `.git` symlink pointing nowhere
      // reads as absent. A broken one still says "this was a checkout".
      const dotGit = join(path, ".git");
      if (existsSync(dotGit) || isSymlink(dotGit)) {
        return {
          ok: false as const,
          error: `${path} already exists and contains a .git; remove or rename it first`,
        };
      }
      const occupied = `${path} already exists and is not empty; remove or rename it first, or pass a different worktree name`;
      if (!isEmptyDirectory(path)) {
        return { ok: false as const, error: occupied };
      }
      // Removed NON-recursively, which is what closes the window between the
      // check above and this line: `rmdir` fails on a directory that gained
      // content in between, where a recursive delete would have taken it. The
      // check stays for the message, since it can say more than an errno can.
      try {
        await rmdir(path);
      } catch {
        // Content that appeared, a permission problem, a path that stopped
        // being a directory: every one of them leaves the target occupied,
        // which is the same answer for the caller.
        return { ok: false as const, error: occupied };
      }
    }

    const based = await resolveBase(mainRepoRoot, request.base, git);
    if (!based.ok) return based;

    // An EXPLICIT name reuses an existing branch rather than recreating it:
    // the user naming a worktree after a branch they already have means that
    // branch, and `-b` would fail on it.
    //
    // A DERIVED name never reuses, and does not even look. The candidate
    // search already rejected every name a branch was holding, so a branch
    // here means one appeared since, and the lock that search ran under is
    // process-local: another checkout of this repo, another tool or a person
    // can all do it. Whatever that branch is, it is not this spawn's, and
    // reusing it would start the agent on unrelated history under a name
    // nobody chose. `-b` makes git refuse instead, which is a loud failure
    // the user can act on rather than a silent one they discover later.
    //
    // An OVERRIDDEN branch takes the caller's own settled answer when it has
    // one, for the reason in `branchExists`: measuring it again here would be
    // a second, later observation of something already decided under checks
    // this function cannot repeat. It is still measured, but only to REFUSE
    // on disagreement, never to reuse the newer answer. Without that check
    // the vanished direction is silent rather than loud: git's remote-branch
    // DWIM recreates `<branch>` from `<remote>/<branch>` and checks out
    // history the caller's checks never saw.
    if (request.branch !== undefined && request.branchExists !== undefined) {
      const measured = await localBranchExists(mainRepoRoot, branchName, git);
      if (measured !== request.branchExists) {
        return {
          ok: false as const,
          error:
            `Branch '${branchName}' ${measured ? "appeared" : "vanished"} after the ` +
            `caller settled it, so it was not checked out: whatever is there now ` +
            `has not been proved to be what was asked for. Try again.`,
        };
      }
    }
    const reusingBranch =
      request.branch !== undefined
        ? (request.branchExists ??
          (await localBranchExists(mainRepoRoot, branchName, git)))
        : named.derived
          ? false
          : await localBranchExists(mainRepoRoot, name, git);
    const args = reusingBranch
      ? ["worktree", "add", path, branchName]
      : ["worktree", "add", "-b", branchName, path, based.base];

    const added = await git(mainRepoRoot, args);
    if (added.exitCode !== 0) {
      return {
        ok: false as const,
        error: `git ${args.join(" ")} failed: ${added.stderr.trim() || `exited ${added.exitCode}`}`,
      };
    }

    // Only for a branch this request CUT: a reused branch was not cut from
    // the base, so recording one would misdescribe its history (the same
    // reason `result.base` is undefined below). And only when the caller
    // wants it recorded at all; see `recordBase`.
    if (!reusingBranch && (request.recordBase ?? true))
      await recordBranchBase(mainRepoRoot, branchName, based.base, git);

    const setup = await fileSetup(mainRepoRoot, path);
    return {
      ok: true as const,
      result: {
        path,
        name,
        branch: branchName,
        created: true,
        branchCreated: !reusingBranch,
        // A reused branch was not cut from the base, so naming one would
        // misreport where its history comes from.
        base: reusingBranch ? undefined : based.base,
        symlinked: setup.symlinked,
        included: setup.included,
      },
    };
  });
}

/**
 * Make `.claude/worktrees/` invisible to git in the repo that HOSTS the
 * worktrees, the way Claude Code does for its own.
 *
 * Without it the first worktree turns the repo into one that permanently has
 * "untracked work" in it, and everything downstream believes it: the picker's
 * dirty gate offers a move for a checkout whose only change is other agents'
 * checkouts, the move's counts include them, and `--untracked copy`
 * physically duplicates every sibling worktree into the new one — a full
 * recursive copy, `.git` link file and all. (`move` is spared only because
 * git will not stash a nested worktree, so it silently relocates nothing
 * while reporting that it did.)
 *
 * Written to `info/exclude` rather than `.gitignore`: the ignore file is the
 * repo's, shared with everyone who clones it, and this is a fact about one
 * machine's tooling. Located through `rev-parse --git-path` rather than by
 * joining `.git/`, which gets a `.git` FILE (a linked worktree, a submodule)
 * right for free — and `info/exclude` lives in the COMMON directory, so every
 * worktree of the repo shares the one file.
 *
 * git's own `check-ignore` is the idempotency test, not a scan for our line.
 * It answers the question that actually matters — "would git already ignore
 * this?" — so a repo whose `.gitignore` covers `.claude/` gets nothing added,
 * and neither does one that already has the entry. The trailing slash on the
 * query is load-bearing: the pattern matches a DIRECTORY, and with the path
 * absent from disk git cannot tell that it is one.
 *
 * Best effort throughout. A read-only `.git` is a reason to skip an
 * optimization, never to fail a spawn.
 *
 * @returns whether a line was appended.
 */
export async function ensureWorktreesExcluded(
  mainRepoRoot: string,
  git: GitRun = runGit,
): Promise<boolean> {
  const ignored = await git(mainRepoRoot, [
    "check-ignore",
    "-q",
    `${WORKTREE_DIR}/`,
  ]);
  // 0 = already ignored, nothing to do. 1 = not ignored. Anything else (128,
  // 127) means we could not ask, and writing on a guess is how a tool ends up
  // appending a duplicate line every run.
  if (ignored.exitCode !== 1) return false;

  const located = await git(mainRepoRoot, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  if (located.exitCode !== 0) return false;
  const relative = located.stdout.trim();
  if (!relative) return false;
  // `--git-path` answers relative to the cwd it ran in unless the git is new
  // enough for `--path-format=absolute`, and that cwd is `mainRepoRoot`.
  const path = isAbsolute(relative) ? relative : join(mainRepoRoot, relative);

  try {
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
    // Only ever appends, and never without a newline of its own: the file is
    // the user's, and a repo that has hand-written rules in here must get
    // them back untouched.
    const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${separator}${WORKTREE_EXCLUDE_PATTERN}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The path an EXPLICIT worktree name already occupies, or null.
 *
 * Exists for the one caller that must not get create-or-open:
 * `--with-changes` moves uncommitted work into the worktree and rolls the
 * worktree back if anything goes wrong, so it needs a checkout nothing else
 * owns. Asking here, before a single file has been touched, turns "that name
 * is taken" into an argument error rather than something discovered halfway
 * through a move.
 *
 * A name the engine would reject outright answers null: reporting it as
 * occupied would be wrong, and {@link createWorktree} says why it is bad far
 * better than this can.
 */
export async function existingWorktreeFor(
  mainRepoRoot: string,
  name: string,
  git: GitRun = runGit,
): Promise<string | null> {
  const named = resolveWorktreeName(name, undefined);
  if (!named.ok) return null;
  const path = worktreePathFor(mainRepoRoot, named.name);
  return (await isRegisteredWorktree(mainRepoRoot, path, git)) ? path : null;
}

/**
 * True only for a directory with nothing in it.
 *
 * A file, a symlink, and an unreadable path all answer false: this gates a
 * recursive delete, so anything it cannot positively identify as empty has to
 * count as content.
 */
function isEmptyDirectory(path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

/**
 * Whether git already tracks a worktree at `path`.
 *
 * Compared through `normalizePath`, not `resolve`: git records the REALPATH,
 * so a repo reached through any symlinked ancestor (every `/tmp` path on
 * macOS, and plenty of real home directories) records `/private/tmp/...`
 * against a computed `/tmp/...`. With a plain `resolve` the comparison always
 * failed, which turned create-or-open into a refusal complaining that the
 * directory "contains a .git", meaning the worktree it had just made.
 */
async function isRegisteredWorktree(
  mainRepoRoot: string,
  path: string,
  git: GitRun,
): Promise<boolean> {
  const res = await git(mainRepoRoot, ["worktree", "list", "--porcelain"]);
  if (res.exitCode !== 0) return false;
  const wanted = normalizePath(path);
  return res.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some(
      (line) => normalizePath(line.slice("worktree ".length).trim()) === wanted,
    );
}

async function currentBranch(
  path: string,
  git: GitRun,
): Promise<string | null> {
  const res = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (res.exitCode !== 0) return null;
  return res.stdout.trim() || null;
}
