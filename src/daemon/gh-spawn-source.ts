/**
 * Resolving `ccmux spawn --pr <n>` / `--issue <n>` into a worktree spawn.
 *
 * Two halves that deliberately live together: the `gh` lookups that turn a
 * number into a title, a URL and (for a PR) a head ref, and the git
 * preparation that makes a checkout of that head possible. They share one
 * subject — "the PR/issue this spawn is for" — and splitting them would put
 * the fetch that only exists to serve `headRefName` in a module that has
 * never heard of it.
 *
 * Everything here is a REFUSAL or a fetch. Nothing creates a worktree: that
 * stays with `worktree-create.ts`, which owns the lock, the naming and the
 * file setup. See `handleSpawn` in `server.ts` for the ordering.
 */

import { withRepoLock } from "./worktree-create";
import { listWorktrees, runGit, type GitRun } from "./worktree-git";

/**
 * How long a `gh` call may take before it is killed.
 *
 * The existing `gh` call sites (`pr-resolver.ts`, `worktree-prune.ts`) have
 * no timeout because they run in the background and a hung one merely leaves
 * a column unfilled. This one is in the request path of a spawn, so a `gh`
 * blocked on a dead network would hang the command the user is watching.
 */
const GH_TIMEOUT_MS = 15_000;

/** Longest title text a seeded prompt carries; see {@link seedPrompt}. */
const MAX_TITLE_CHARS = 200;

/** What a `gh` invocation did, with the two non-exit failures called out. */
export interface GhRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Killed by {@link GH_TIMEOUT_MS}; the exit code means nothing then. */
  timedOut?: boolean;
  /** `gh` could not be started at all (not installed, not executable). */
  spawnError?: string;
}

/** Runs `gh <args...>` in `cwd`. Never throws. Injectable for tests. */
export type GhRun = (cwd: string, args: string[]) => Promise<GhRunResult>;

export const runGh: GhRun = async (cwd, args) => {
  let timedOut = false;
  // One try around the whole spawn-through-read sequence, like
  // `worktree-prune.ts`: a missing `gh` throws from `Bun.spawn` itself rather
  // than producing a process with an exit code to branch on.
  try {
    const proc = Bun.spawn(["gh", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      // Passed explicitly rather than inherited, the way `worktree-prune.ts`
      // does it: Bun resolves the binary against the env it is GIVEN, so
      // without this a test cannot put a stub `gh` on PATH.
      env: { ...process.env },
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, GH_TIMEOUT_MS);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr, ...(timedOut ? { timedOut } : {}) };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { exitCode: 127, stdout: "", stderr: "", spawnError: message(err) };
  }
};

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The failure a `gh` run reports, or null when it produced output to parse. */
function ghProblem(what: string, run: GhRunResult): string | null {
  if (run.spawnError) {
    return `gh could not be run: ${run.spawnError}. Install the GitHub CLI (https://cli.github.com) and run 'gh auth login'.`;
  }
  if (run.timedOut) {
    return `gh ${what} timed out after ${GH_TIMEOUT_MS / 1000}s`;
  }
  if (run.exitCode !== 0) {
    const detail = run.stderr.trim();
    return `gh ${what} exited ${run.exitCode}${detail ? `: ${detail}` : ""}`;
  }
  return null;
}

/** The PR fields a spawn needs, as `gh pr view --json` reports them. */
export interface PRSource {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  /** The fork's clone URL, absent for a same-repo PR. */
  headRemoteUrl?: string;
}

/** The issue fields a spawn needs. */
export interface IssueSource {
  number: number;
  title: string;
  url: string;
  state: string;
}

export type SourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Resolve `--pr <n>` through `gh pr view`, run in the request's cwd so gh
 * picks the same repo the spawn is for.
 *
 * A non-OPEN PR is refused with its state in the message: a merged or closed
 * PR still has a head ref that could be fetched, and quietly checking one out
 * would put an agent on history nobody is reviewing any more.
 */
export async function lookupPR(
  cwd: string,
  number: number,
  run: GhRun = runGh,
): Promise<SourceResult<PRSource>> {
  const result = await run(cwd, [
    "pr",
    "view",
    String(number),
    "--json",
    "number,title,url,state,headRefName,baseRefName,isCrossRepository,headRepository,headRepositoryOwner",
  ]);
  const problem = ghProblem(`pr view ${number}`, result);
  if (problem) return { ok: false, error: problem };

  let row: Record<string, unknown>;
  try {
    row = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: `gh pr view ${number} did not return valid JSON: ${message(err)}`,
    };
  }
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return {
      ok: false,
      error: `gh pr view ${number} did not return valid JSON: expected an object`,
    };
  }

  const state = readString(row, "state");
  const headRefName = readString(row, "headRefName");
  const baseRefName = readString(row, "baseRefName");
  const url = readString(row, "url");
  if (!state || !headRefName || !baseRefName || !url) {
    return {
      ok: false,
      error: `gh pr view ${number} did not report the fields this needs (state, headRefName, baseRefName, url)`,
    };
  }
  if (state !== "OPEN") {
    return {
      ok: false,
      error: `PR #${number} is ${state}, not open; spawning against it would check out history nobody is reviewing. Check it out by hand if that is what you want.`,
    };
  }

  const isCrossRepository = row.isCrossRepository === true;
  let headRemoteUrl: string | undefined;
  if (isCrossRepository) {
    // Only a fork needs these, and only a fork can be refused for missing
    // them: without an owner and a repo name there is no URL to push the
    // branch back to, and a branch that tracks the WRONG remote is worse
    // than a refused spawn.
    const owner = nestedString(row.headRepositoryOwner, "login");
    const repo = nestedString(row.headRepository, "name");
    if (!owner || !repo) {
      return {
        ok: false,
        error: `PR #${number} comes from a fork whose repository gh did not name, so its branch cannot be set up to push back. Check it out with 'gh pr checkout ${number}' instead.`,
      };
    }
    headRemoteUrl = `https://github.com/${owner}/${repo}.git`;
  }

  return {
    ok: true,
    value: {
      number,
      title: readString(row, "title") ?? `PR #${number}`,
      url,
      state,
      headRefName,
      baseRefName,
      isCrossRepository,
      ...(headRemoteUrl ? { headRemoteUrl } : {}),
    },
  };
}

function nestedString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  return readString(value as Record<string, unknown>, key);
}

/**
 * Resolve `--issue <n>` through `gh issue view`.
 *
 * Only CLOSED is refused. gh reports `OPEN` or `CLOSED` for an issue, and
 * anything else it grows later is not something to guess at.
 */
export async function lookupIssue(
  cwd: string,
  number: number,
  run: GhRun = runGh,
): Promise<SourceResult<IssueSource>> {
  const result = await run(cwd, [
    "issue",
    "view",
    String(number),
    "--json",
    "number,title,url,state",
  ]);
  const problem = ghProblem(`issue view ${number}`, result);
  if (problem) return { ok: false, error: problem };

  let row: Record<string, unknown>;
  try {
    row = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: `gh issue view ${number} did not return valid JSON: ${message(err)}`,
    };
  }
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return {
      ok: false,
      error: `gh issue view ${number} did not return valid JSON: expected an object`,
    };
  }

  const state = readString(row, "state");
  const url = readString(row, "url");
  if (!state || !url) {
    return {
      ok: false,
      error: `gh issue view ${number} did not report the fields this needs (state, url)`,
    };
  }
  if (state === "CLOSED") {
    return {
      ok: false,
      error: `Issue #${number} is closed; spawn against it by hand if that is what you want.`,
    };
  }

  return {
    ok: true,
    value: {
      number,
      title: readString(row, "title") ?? `Issue #${number}`,
      url,
      state,
    },
  };
}

/**
 * The worktree already sitting on `branch`, or null.
 *
 * Asked before anything is fetched or created, so `--pr` on a branch the user
 * already has checked out is OUR message naming the directory rather than
 * git's "already used by worktree at" at the end of a create.
 */
export async function branchCheckedOutAt(
  mainRepoRoot: string,
  branch: string,
  git: GitRun = runGit,
): Promise<string | null> {
  for (const entry of await listWorktrees(mainRepoRoot, git)) {
    if (entry.branch === branch) return entry.path;
  }
  return null;
}

/** What {@link preparePRBranch} settled, for the create that follows it. */
export interface PRBranchPrep {
  /** The PR head's sha, to cut a new branch from. */
  head: string;
  /** True when the local branch was already there and was fast-forwarded. */
  branchExisted: boolean;
  /**
   * `origin/<baseRefName>`, or null when it could not be made to resolve.
   * Null only costs the `ccmux-base` key (the picker's `d` review falls back
   * to its own default), so it is not worth failing a spawn over.
   */
  baseRemoteRef: string | null;
}

/**
 * Fetch the PR's head and settle which branch the worktree will check out.
 *
 * Runs under the repo lock so two concurrent `--pr` spawns cannot interleave
 * their `FETCH_HEAD` reads, and RELEASES it before the caller creates the
 * worktree: `createWorktree` takes the same lock, and `withRepoLock` is not
 * reentrant — nesting them deadlocks. The window that opens between the two
 * is the same one the create path already documents for its process-local
 * lock, and `git worktree add -b` fails loudly on anything that lands in it.
 *
 * Nothing here force-updates a ref. A same-named local branch is reused only
 * when its upstream config already says it is this PR, and only by a
 * NON-forced `git fetch` refspec, which refuses divergence rather than
 * discarding commits the user may still want.
 */
export async function preparePRBranch(
  mainRepoRoot: string,
  pr: PRSource,
  git: GitRun = runGit,
): Promise<SourceResult<PRBranchPrep>> {
  return withRepoLock(mainRepoRoot, async () => {
    const branch = pr.headRefName;
    const fetched = await git(mainRepoRoot, [
      "fetch",
      "origin",
      `pull/${pr.number}/head`,
    ]);
    if (fetched.exitCode !== 0) {
      return {
        ok: false as const,
        error: `Could not fetch PR #${pr.number}: git fetch origin pull/${pr.number}/head failed: ${fetched.stderr.trim() || `exited ${fetched.exitCode}`}`,
      };
    }
    // Immediately, and kept as a sha: the base fetch below overwrites
    // FETCH_HEAD, so anything that reads it later reads the wrong commit.
    const resolved = await git(mainRepoRoot, ["rev-parse", "FETCH_HEAD"]);
    const head = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || !head) {
      return {
        ok: false as const,
        error: `Could not resolve the fetched head of PR #${pr.number}`,
      };
    }

    // So `origin/<base>` exists locally for the `ccmux-base` key below.
    // Best-effort: the key is a convenience for the picker's diff review, and
    // a repo whose base branch cannot be fetched still has a PR head to check
    // out. Verified rather than assumed, so the key is never written pointing
    // at a ref that does not resolve.
    await git(mainRepoRoot, ["fetch", "origin", pr.baseRefName]);
    const baseRemoteRef = `origin/${pr.baseRefName}`;
    const baseVerified = await git(mainRepoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${baseRemoteRef}^{commit}`,
    ]);

    const existing = await git(mainRepoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    const branchExisted = existing.exitCode === 0;
    if (branchExisted) {
      // The upstream config is the only evidence that a same-named branch is
      // THIS PR rather than someone's unrelated `fix-typo`. Reusing on the
      // name alone would check the agent out onto history that has nothing to
      // do with the PR, under a name that says it does.
      const merge = await git(mainRepoRoot, [
        "config",
        "--get",
        `branch.${branch}.merge`,
      ]);
      if (merge.stdout.trim() !== `refs/heads/${branch}`) {
        return {
          ok: false as const,
          error: `A local branch '${branch}' already exists and is not set up to track PR #${pr.number}. Rename or delete it, or check the PR out by hand with 'gh pr checkout ${pr.number}'.`,
        };
      }
      // No leading '+': git refuses a non-fast-forward, which is exactly the
      // answer wanted. A branch carrying local commits the PR does not have
      // is the user's work, and this feature never discards it.
      const updated = await git(mainRepoRoot, [
        "fetch",
        "origin",
        `refs/pull/${pr.number}/head:${branch}`,
      ]);
      if (updated.exitCode !== 0) {
        return {
          ok: false as const,
          error: `Local branch '${branch}' has diverged from PR #${pr.number} and was left untouched (updating it would not be a fast-forward). Reconcile it yourself, then spawn again.`,
        };
      }
    }

    return {
      ok: true as const,
      value: {
        head,
        branchExisted,
        baseRemoteRef: baseVerified.exitCode === 0 ? baseRemoteRef : null,
      },
    };
  });
}

/**
 * Point the checked-out branch at the PR, the way `gh pr checkout` does.
 *
 * Same-repo PRs track `origin`; a fork's branch tracks the fork's clone URL
 * (as both `remote` and `pushRemote`, since gh does not add a named remote
 * for it), so `git push` from the new worktree updates the PR instead of
 * failing or, worse, opening a second one.
 *
 * `ccmux-base` is ccmux's own key: it is what the picker's `d` review diffs
 * against, and for a PR the useful base is the branch the PR targets rather
 * than whatever the repo's HEAD happened to be. Written as the REMOTE ref,
 * which is what a fresh clone actually has.
 *
 * Re-asserted on a reused branch too — every write here is idempotent, and a
 * branch created by an older ccmux (or by hand) heals on the next spawn.
 */
export async function configurePRBranch(
  mainRepoRoot: string,
  branch: string,
  pr: PRSource,
  baseRemoteRef: string | null,
  git: GitRun = runGit,
): Promise<void> {
  const remote = pr.headRemoteUrl ?? "origin";
  await git(mainRepoRoot, ["config", `branch.${branch}.remote`, remote]);
  if (pr.headRemoteUrl) {
    await git(mainRepoRoot, [
      "config",
      `branch.${branch}.pushRemote`,
      pr.headRemoteUrl,
    ]);
  }
  await git(mainRepoRoot, [
    "config",
    `branch.${branch}.merge`,
    `refs/heads/${pr.headRefName}`,
  ]);
  if (baseRemoteRef) {
    await git(mainRepoRoot, [
      "config",
      `branch.${branch}.ccmux-base`,
      baseRemoteRef,
    ]);
  }
}

/**
 * The prompt a `--pr`/`--issue` spawn opens the agent with.
 *
 * Two lines of provenance (what and where), then the user's own `--prompt`
 * after a blank line so the instruction stays visually theirs. The title is
 * stripped of control characters and capped: it comes from GitHub, where it
 * can be any length and contain anything, and it travels into a
 * single-quoted shell argument.
 */
export function seedPrompt(
  label: string,
  title: string,
  url: string,
  userPrompt: string | undefined,
): string {
  const clean = title.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const capped =
    clean.length > MAX_TITLE_CHARS
      ? `${clean.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
      : clean;
  const head = `${label}${capped ? `: ${capped}` : ""}\n${url}`;
  return userPrompt ? `${head}\n\n${userPrompt}` : head;
}
