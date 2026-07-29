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
 * from the first words of the prompt. No model is consulted, deliberately —
 * a branch name that varies run to run is not something a user can predict,
 * script, or find again.
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
 *    a live Claude session is already protected by its own lock, while a
 *    ccmux-created worktree becomes prunable the moment its agent exits
 *    rather than needing an unlock first.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizePath, runGit, type GitRun } from "./worktree-git";

/** Where worktrees live, relative to the main checkout. */
export const WORKTREE_DIR = join(".claude", "worktrees");

/** How many words of a prompt a derived slug may use. */
const SLUG_WORDS = 3;
/** Hard cap on a derived slug, so a prompt of long words stays usable. */
const SLUG_MAX_CHARS = 40;

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

/**
 * The name a request resolves to, or an error explaining why it cannot.
 *
 * An explicit name always wins. A prompt-derived name is the convenience
 * path. Neither is an error rather than a generated placeholder: an
 * arbitrary name would be a directory and a branch the user did not choose
 * and cannot guess later.
 */
export function resolveWorktreeName(
  name: string | undefined,
  prompt: string | undefined,
): { ok: true; name: string } | { ok: false; error: string } {
  if (name !== undefined && name.trim() !== "") {
    const slug = slugify(name);
    if (!slug) {
      return {
        ok: false,
        error: `Worktree name '${name}' has no usable characters (letters and digits only)`,
      };
    }
    return { ok: true, name: slug };
  }
  if (prompt !== undefined && prompt.trim() !== "") {
    const slug = slugFromPrompt(prompt);
    if (slug) return { ok: true, name: slug };
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
 * The start point for the new branch: an explicit `base`, else the main
 * checkout's current branch.
 *
 * Defaulting to the main checkout's branch rather than to a fixed `main`
 * means a user working on a release branch gets worktrees off that branch,
 * which is what "another agent on what I am doing" means. A detached main
 * checkout reports `HEAD`, which git accepts as a start point.
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
 * Read `worktree.symlinkDirectories` from the repo's `.claude/settings.json`.
 *
 * Absent file, unreadable file, malformed JSON and a missing key are all the
 * same answer: nothing to symlink. This is optional convenience config, so
 * refusing to create a worktree because it could not be parsed would trade a
 * working feature for a cosmetic one.
 */
export function readSymlinkDirectories(mainRepoRoot: string): string[] {
  const settingsPath = join(mainRepoRoot, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      worktree?: { symlinkDirectories?: unknown };
    };
    const dirs = parsed.worktree?.symlinkDirectories;
    if (!Array.isArray(dirs)) return [];
    return dirs.filter((d): d is string => typeof d === "string" && d !== "");
  } catch {
    return [];
  }
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
      "--others",
      "--ignored",
      `--exclude-from=${includePath}`,
    ]),
    git(mainRepoRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
    ]),
  ]);
  if (matching.exitCode !== 0 || ignored.exitCode !== 0) return [];

  const lines = (out: string): string[] =>
    out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  const ignoredSet = new Set(lines(ignored.stdout));
  return lines(matching.stdout).filter((path) => ignoredSet.has(path));
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
 * One more observed difference, deliberate rather than accidental: Claude
 * Code LOCKS a worktree for the lifetime of its session (`git worktree list`
 * shows `locked` with a reason naming the session and pid) and ccmux does
 * not. The effect is benign and arguably useful — ccmux's prune skips locked
 * worktrees, so a checkout with a live Claude session is protected from
 * cleanup by that lock alone, while a ccmux-created worktree stays prunable
 * as soon as its agent exits.
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
    if (existsSync(target)) continue;
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

/**
 * Create the worktree for a spawn, or open the existing one.
 *
 * Create-or-open rather than create-or-fail: "spawn an agent on this task"
 * asked for an agent in that worktree, and if the worktree is already there
 * the request is satisfiable. Failing would make the second spawn of a name
 * an error the user has to resolve by hand for no benefit.
 */
export async function createWorktree(
  mainRepoRoot: string,
  request: { name?: string; base?: string; prompt?: string },
  options: CreateWorktreeOptions = {},
): Promise<
  { ok: true; result: WorktreeCreation } | { ok: false; error: string }
> {
  const git = options.git ?? runGit;
  const fileSetup = options.applyFileSetup ?? applyWorktreeFileSetup;

  const named = resolveWorktreeName(request.name, request.prompt);
  if (!named.ok) return named;
  const name = named.name;
  const path = worktreePathFor(mainRepoRoot, name);

  return withRepoLock(mainRepoRoot, async () => {
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
          symlinked: [],
          included: [],
        },
      };
    }

    // Not registered, but something is at the path. A directory with a `.git`
    // belongs to some other repository or is a worktree this repo has lost
    // track of; either way removing it could destroy work, so refuse and let
    // a human look. Anything else is debris from an interrupted create and is
    // cleared, since `git worktree add` refuses a non-empty target.
    if (existsSync(path)) {
      if (existsSync(join(path, ".git"))) {
        return {
          ok: false as const,
          error: `${path} already exists and contains a .git; remove or rename it first`,
        };
      }
      try {
        await rm(path, { recursive: true, force: true });
      } catch (err) {
        return {
          ok: false as const,
          error: `Could not clear ${path}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const based = await resolveBase(mainRepoRoot, request.base, git);
    if (!based.ok) return based;

    // An existing branch of this name is reused rather than recreated: the
    // user naming a worktree after a branch they already have means that
    // branch, and `-b` would fail on it.
    const branchExists = await git(mainRepoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${name}`,
    ]);
    const args =
      branchExists.exitCode === 0
        ? ["worktree", "add", path, name]
        : ["worktree", "add", "-b", name, path, based.base];

    const added = await git(mainRepoRoot, args);
    if (added.exitCode !== 0) {
      return {
        ok: false as const,
        error: `git ${args.join(" ")} failed: ${added.stderr.trim() || `exited ${added.exitCode}`}`,
      };
    }

    const setup = await fileSetup(mainRepoRoot, path);
    return {
      ok: true as const,
      result: {
        path,
        name,
        branch: name,
        created: true,
        symlinked: setup.symlinked,
        included: setup.included,
      },
    };
  });
}

/**
 * Whether git already tracks a worktree at `path`.
 *
 * Compared through `normalizePath`, not `resolve`: git records the REALPATH,
 * so a repo reached through any symlinked ancestor (every `/tmp` path on
 * macOS, and plenty of real home directories) records `/private/tmp/...`
 * against a computed `/tmp/...`. With a plain `resolve` the comparison always
 * failed, which turned create-or-open into a refusal complaining that the
 * directory "contains a .git" — the worktree it had just made.
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
