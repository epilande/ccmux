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
export function ghProblem(what: string, run: GhRunResult): string | null {
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

export function readString(
  row: Record<string, unknown>,
  key: string,
): string | null {
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
  // Both names reach git as POSITIONAL arguments (`worktree add <path>
  // <branch>`, `fetch origin <base>`), where a leading `-` is parsed as an
  // option instead. GitHub permits such a ref, so this is a real value an
  // attacker-authored fork branch can carry, not a hypothetical.
  for (const [label, ref] of [
    ["head", headRefName],
    ["base", baseRefName],
  ] as const) {
    if (ref.startsWith("-")) {
      return {
        ok: false,
        error: `PR #${number}'s ${label} ref '${ref}' starts with '-', which git would read as an option rather than a ref. Check it out by hand with 'gh pr checkout ${number}'.`,
      };
    }
  }

  // Refused rather than defaulted when it is not a boolean. A missing or
  // malformed field read as `false` sets the expected remote to `origin`,
  // which is precisely the fork hijack the reuse gate below exists to close:
  // failing OPEN on the field that says "this is a fork" would undo it.
  // Unreachable through today's gh (it errors on an unknown --json field),
  // and one line of defense on the property this module is built around.
  if (typeof row.isCrossRepository !== "boolean") {
    return {
      ok: false,
      error: `gh pr view ${number} did not say whether PR #${number} comes from a fork (isCrossRepository), so ccmux cannot tell which repository its branch should push to. Check it out with 'gh pr checkout ${number}' instead.`,
    };
  }
  const isCrossRepository = row.isCrossRepository;
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

/** A repository as `host/owner/repo`, however its URL was spelled. */
export interface RepoSlug {
  host: string;
  owner: string;
  repo: string;
}

/**
 * The repository a GitHub URL names, or null when it is not one.
 *
 * Handles every spelling a `remote get-url` can answer with: `https://` (with
 * or without userinfo and a `.git` suffix), `ssh://git@host/owner/repo`, and
 * the scp-like `git@host:owner/repo.git`. Only the first two path segments
 * matter, so a PR URL (`.../owner/repo/pull/7`) parses to the same slug as
 * the clone URL of that repo, which is the whole point.
 *
 * Lowercased because GitHub treats owner and repo case-insensitively, and a
 * remote spelled `github.com/JuneGunn/fzf` must not read as a different repo.
 * A local path, a non-GitHub-shaped URL, and an empty string all answer null:
 * this function proves a match, never a mismatch by absence.
 */
/**
 * Hosts that are one forge under two names.
 *
 * GitHub documents `ssh://git@ssh.github.com:443/owner/repo.git` as the way
 * through a firewall that blocks port 22, so a clone URL naming it is the
 * SAME repository as one naming github.com. Without this the host comparison
 * fails and {@link prRepoMismatch} refuses with a message that reads as
 * nonsense: "belongs to o/r, but this clone's 'origin' is o/r".
 */
const HOST_ALIASES: Record<string, string> = {
  "ssh.github.com": "github.com",
};

export function parseRepoSlug(url: string): RepoSlug | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scp-like syntax has no scheme and uses ':' where a URL has '/'.
  const scp = /^(?:([^@/]+)@)?([^:/]+):(.+)$/.exec(trimmed);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let host: string;
  let path: string;
  if (!withScheme && scp) {
    host = scp[2] ?? "";
    path = scp[3] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:") return null;
    host = parsed.hostname;
    path = parsed.pathname;
  }

  const segments = path
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s !== "");
  if (segments.length < 2 || !host) return null;
  const repo = (segments[1] ?? "").replace(/\.git$/i, "");
  if (!segments[0] || !repo) return null;
  const lowerHost = host.toLowerCase();
  return {
    host: HOST_ALIASES[lowerHost] ?? lowerHost,
    owner: segments[0].toLowerCase(),
    repo: repo.toLowerCase(),
  };
}

/** `owner/repo on host`, the form the mismatch message names a side with. */
function describeSlug(slug: RepoSlug): string {
  return `${slug.owner}/${slug.repo} on ${slug.host}`;
}

/** Whether two URLs name the same repository. Null on either side is false. */
export function sameRepo(a: RepoSlug | null, b: RepoSlug | null): boolean {
  if (!a || !b) return false;
  return a.host === b.host && a.owner === b.owner && a.repo === b.repo;
}

/**
 * Why this clone cannot be the one the PR lives in, or null when it can.
 *
 * `gh` resolves a PR number through its OWN repo selection (`gh repo
 * set-default`, `GH_REPO`, the upstream of a triangular clone), while the
 * fetch below is hardcoded to `origin`. When those disagree the failure is
 * silent and wrong in the worst way: in a fork clone with its own PR #7, the
 * spawn would check out the fork's PR under the base repo's title.
 *
 * v1 REFUSES rather than picking a remote. Choosing one means reproducing
 * gh's precedence rules, and a wrong guess checks out the wrong code; naming
 * both sides costs the user one command and no ambiguity.
 *
 * Only a proven mismatch refuses. An origin that is not a GitHub URL at all
 * (a local path fixture, a mirror, a host this cannot parse) leaves the
 * question unanswered, and inventing a refusal there would break clones that
 * work today.
 */
export async function prRepoMismatch(
  mainRepoRoot: string,
  pr: PRSource,
  git: GitRun = runGit,
): Promise<string | null> {
  const prSlug = parseRepoSlug(pr.url);
  if (!prSlug) return null;
  const remote = await git(mainRepoRoot, ["remote", "get-url", "origin"]);
  if (remote.exitCode !== 0) return null;
  const originSlug = parseRepoSlug(remote.stdout.trim());
  if (!originSlug) return null;
  if (sameRepo(prSlug, originSlug)) return null;
  // The HOST is named as well as owner/repo, because a host-only mismatch
  // (a GitHub Enterprise clone of a repo that also exists on github.com)
  // would otherwise print the same slug on both sides and read as nonsense.
  return (
    `PR #${pr.number} belongs to ${describeSlug(prSlug)}, but this clone's 'origin' is ` +
    `${describeSlug(originSlug)}. ccmux fetches the PR from 'origin', so it would ` +
    `check out the wrong code. Point 'origin' at the base repository, or fetch the PR by hand.`
  );
}

/**
 * The repository a `branch.<b>.remote` value points at, or null.
 *
 * That value is either a URL or the NAME of a remote, and both spellings are
 * ordinary: ccmux writes a URL for a fork and the name `origin` for a
 * same-repo PR, while plain git writes whatever name the user configured
 * (`git remote add fork <url>; git checkout -b foo fork/foo` leaves `fork`).
 * Comparing the raw strings therefore refuses branches that genuinely ARE
 * the PR's, so a name is resolved through `remote.<name>.url` and both sides
 * are compared as repositories.
 *
 * This does NOT reopen the hijack: for a fork PR the expected side is the
 * fork's URL, while a hijacking branch's `origin` resolves to the BASE
 * repository, so the two still differ.
 */
async function remoteSlug(
  mainRepoRoot: string,
  value: string,
  git: GitRun,
): Promise<RepoSlug | null> {
  if (!value) return null;
  const direct = parseRepoSlug(value);
  if (direct) return direct;
  const url = await git(mainRepoRoot, [
    "config",
    "--get",
    `remote.${value}.url`,
  ]);
  if (url.exitCode !== 0) return null;
  return parseRepoSlug(url.stdout.trim());
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

/** What {@link configurePRBranch} could not finish, though the spawn is fine. */
export interface PRBranchConfig {
  /** Set when the OPTIONAL `ccmux-base` key could not be written. */
  baseNote?: string;
}

/** What {@link preparePRBranch} settled, for the create that follows it. */
export interface PRBranchPrep {
  /** The PR head's sha, to cut a new branch from. */
  head: string;
  /** True when the local branch was already there and was fast-forwarded. */
  branchExisted: boolean;
  /**
   * `origin/<baseRefName>`, or null when it could not be made to resolve.
   * Null only costs the `ccmux-base` key (the picker's `D` branch review falls back
   * to its own default), so it is not worth failing a spawn over. The WRITE
   * of that key is non-fatal for the same reason; see {@link configurePRBranch}.
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
      //
      // BOTH halves are required, and the `remote` half is what closes a
      // fork hijack: `git checkout -b foo origin/foo` writes exactly
      // `branch.foo.merge = refs/heads/foo` for every ordinary
      // origin-tracking branch, so `merge` alone says nothing about WHICH
      // repository the branch follows. A fork PR whose author names their
      // head `foo` would pass on the merge key, get fast-forwarded onto the
      // fork's commits (the non-forced fetch permits it whenever the local
      // branch is an ancestor), and then have its remote rewritten to the
      // fork by `configurePRBranch`. Requiring the remote to be the one this
      // PR would be configured with makes the branch prove it is already
      // this PR's before anything touches it.
      const expectedRemote = pr.headRemoteUrl ?? "origin";
      const [merge, remote] = await Promise.all([
        git(mainRepoRoot, ["config", "--get", `branch.${branch}.merge`]),
        git(mainRepoRoot, ["config", "--get", `branch.${branch}.remote`]),
      ]);
      const configured = remote.stdout.trim();
      // Compared as REPOSITORIES, not as strings: either side may be a URL
      // or a remote name, and `remoteSlug` resolves a name through
      // `remote.<name>.url` so the two spellings of one repository match.
      // A repository neither side can be resolved to stays a refusal.
      const remoteMatches =
        configured === expectedRemote ||
        sameRepo(
          await remoteSlug(mainRepoRoot, configured, git),
          await remoteSlug(mainRepoRoot, expectedRemote, git),
        );
      if (merge.stdout.trim() !== `refs/heads/${branch}` || !remoteMatches) {
        return {
          ok: false as const,
          error: `A local branch '${branch}' already exists and is not set up to track PR #${pr.number} (it would need branch.${branch}.merge = refs/heads/${branch} and branch.${branch}.remote = ${expectedRemote}). Rename or delete it, or check the PR out by hand with 'gh pr checkout ${pr.number}'.`,
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
 * Same-repo PRs track `origin` and carry NO `pushRemote`; a fork's branch
 * tracks the fork's clone URL as both `remote` and `pushRemote` (gh does not
 * add a named remote for it). Either way `git push` from the new worktree
 * updates the PR instead of failing or, worse, opening a second one.
 *
 * `ccmux-base` is ccmux's own key: it is what the picker's `D` branch review diffs
 * against, and for a PR the useful base is the branch the PR targets rather
 * than whatever the repo's HEAD happened to be. Written as the REMOTE ref,
 * which is what a fresh clone actually has.
 *
 * Re-asserted on a reused branch too, since every write here is idempotent,
 * so a branch created by an older ccmux (or by hand) heals on the next spawn.
 *
 * The three TRACKING keys are checked, and a failure is reported rather
 * than swallowed. They are not independent: `remote` landing while
 * `pushRemote` fails leaves a fork's branch fetching from the fork and
 * PUSHING TO ORIGIN, which is how someone opens a second PR (or pushes to a
 * repo they did not mean to) without ever seeing an error.
 *
 * That is also why the same-repo path UNSETS `pushRemote` rather than
 * leaving it alone: git documents `branch.<name>.pushRemote` as overriding
 * `branch.<name>.remote` for pushing, so a stale one left on a reused branch
 * would send the push elsewhere while every key checked here reported
 * success. `--unset` exits 5 when the key is absent, which is the state
 * being asked for, not a failure.
 *
 * `ccmux-base` is deliberately NOT fatal. It is a hint for the picker's diff
 * base, and {@link preparePRBranch} already declines to fail a spawn when the
 * ref it would name cannot be resolved; failing on the WRITE of the same
 * optional key would contradict that and 500 an otherwise-correct spawn
 * (worktree and all) over a diff-base hint. It is reported as a note instead.
 *
 * ccmux OWNS that key on a `--pr` branch, which is why a looked-up base
 * that could not be resolved UNSETS it rather than leaving it (issue #157).
 * Treating a pre-existing value as the user's breaks on a REUSED branch:
 * the key would still name whatever an earlier spawn recorded, so a base
 * this spawn declined to write silently becomes what `D` diffs against,
 * where absence is what lets `D` fall back to its heuristic.
 *
 * That unset is only for a decline. Occupied reopen never looks the base
 * up (it skips {@link preparePRBranch}), so a missing argument here means
 * "leave the key" rather than "clear it" — the first spawn's still-correct
 * `ccmux-base` must survive a second `--pr` / source-picker Enter.
 *
 * Every op is still attempted, because a partial write is what has to be
 * described accurately, and stopping early would leave more of it unset.
 */
export async function configurePRBranch(
  mainRepoRoot: string,
  branch: string,
  pr: PRSource,
  /**
   * `origin/<base>` to record, `null` when this spawn looked the base up
   * and declined to write it (unset so `D` falls back), or omitted when
   * this spawn never looked it up (leave whatever is already there).
   */
  baseRemoteRef?: string | null,
  git: GitRun = runGit,
): Promise<SourceResult<PRBranchConfig>> {
  /** One `git config` write, or the removal of a key that must not persist. */
  type ConfigOp = { key: string; value: string } | { key: string; unset: true };

  const run = async (op: ConfigOp): Promise<string | null> => {
    const res =
      "unset" in op
        ? await git(mainRepoRoot, ["config", "--unset", op.key])
        : await git(mainRepoRoot, ["config", op.key, op.value]);
    // Exit 5 from `--unset` means the key was not there, which is the state
    // being asked for. Treating it as a failure would report every ordinary
    // same-repo spawn as broken.
    if (res.exitCode === 0 || ("unset" in op && res.exitCode === 5)) {
      return null;
    }
    return `${op.key} (${res.stderr.trim() || `exited ${res.exitCode}`})`;
  };

  const tracking: ConfigOp[] = [
    { key: `branch.${branch}.remote`, value: pr.headRemoteUrl ?? "origin" },
    pr.headRemoteUrl
      ? { key: `branch.${branch}.pushRemote`, value: pr.headRemoteUrl }
      : { key: `branch.${branch}.pushRemote`, unset: true },
    { key: `branch.${branch}.merge`, value: `refs/heads/${pr.headRefName}` },
  ];

  const failed: string[] = [];
  for (const op of tracking) {
    const problem = await run(op);
    if (problem) failed.push(problem);
  }

  // Optional, never fatal, and attempted even when a tracking op failed; see
  // this function's doc comment. Omitted (`undefined`) is "never looked up":
  // do not treat that as a decline, which would unset a still-correct key.
  const baseKey = `branch.${branch}.ccmux-base`;
  const baseProblem =
    baseRemoteRef === undefined
      ? null
      : await run(
          baseRemoteRef
            ? { key: baseKey, value: baseRemoteRef }
            : { key: baseKey, unset: true },
        );

  if (failed.length > 0) {
    return {
      ok: false,
      error: `Could not finish setting up branch '${branch}' to track PR #${pr.number}: ${failed.join("; ")}. Until that is fixed, 'git push' from this worktree may not go where you expect; 'gh pr checkout ${pr.number}' inside it will reset the tracking config.`,
    };
  }

  if (baseProblem) {
    return {
      ok: true,
      value: {
        baseNote: baseRemoteRef
          ? `could not record ${baseRemoteRef} as the review base for '${branch}' (${baseProblem}); the picker's 'D' branch review will fall back to its default base`
          : `could not clear the recorded review base for '${branch}' (${baseProblem}); the picker's 'D' branch review may diff against a base an earlier spawn recorded`,
      },
    };
  }
  return { ok: true, value: {} };
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
/**
 * Text from GitHub with every control character replaced by a space.
 *
 * C0, DEL and C1. The C1 block (U+0080-U+009F) matters as much as C0: a raw
 * 0x9B is a one-byte CSI, so a title carrying one puts an escape sequence
 * into whatever renders it — a prompt typed into a terminal, or a TUI row.
 * Applied at the boundary where GitHub's text ENTERS ccmux, so no consumer
 * has to remember.
 */
export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS, " ").trim();
}

/**
 * Characters that must not survive into anything ccmux renders or types.
 *
 * Three classes, and the reason each is here:
 *
 * - C0, DEL and C1 (`\x00-\x1f\x7f-\x9f`). The C1 block matters as much as
 *   C0: a raw 0x9b is a one-byte CSI, so a title carrying one puts an escape
 *   sequence into whatever renders it.
 * - Bidi controls: ALM (U+061C), LRM/RLM, the embedding and override block,
 *   and the isolates. That is every codepoint carrying `Bidi_Control`, swept
 *   rather than listed from memory. U+061C is the easy one to miss: it sits
 *   alone in the Arabic block, nowhere near the others.
 *   These make a string DISPLAY as something other than what it says, which
 *   is the Trojan Source class, and a PR title is written by whoever opened
 *   the PR — on a fork, that is anyone.
 * - Invisible padding and separators (ZWSP, BOM, word joiner, LS, PS). They
 *   contribute no glyph, so a display-width calculation and a terminal can
 *   disagree about how wide the string is; LS and PS can break a row that is
 *   rendered as one line.
 *
 * Deliberately NOT stripped: ZWNJ (U+200C) and ZWJ (U+200D). Both are
 * ordinary letters' worth of meaning in Persian, Arabic and Indic scripts,
 * and ZWJ is what joins an emoji sequence, so removing them corrupts titles
 * that are simply written in another language or contain a family emoji. They
 * cannot reorder text and cannot introduce an escape sequence, which is what
 * the other two classes are here for.
 */
const CONTROL_CHARS =
  /[\x00-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g;

/**
 * Drop a trailing HIGH surrogate left behind by slicing at a UTF-16 boundary.
 *
 * `String.prototype.slice` counts code UNITS, so a cap landing inside an
 * astral character (an emoji, most CJK extension characters) keeps its first
 * half. That half is not a character: it encodes to U+FFFD in anything that
 * writes it out, so the title ends in a replacement glyph rather than the
 * ellipsis that says it was cut (issue #157). Only the high half can be
 * stranded this way — a slice never begins mid-pair, since it starts at 0.
 */
function dropTrailingLoneSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

export function seedPrompt(
  label: string,
  title: string,
  url: string,
  userPrompt: string | undefined,
): string {
  const clean = stripControlChars(title);
  const capped =
    clean.length > MAX_TITLE_CHARS
      ? `${dropTrailingLoneSurrogate(clean.slice(0, MAX_TITLE_CHARS - 1)).trimEnd()}…`
      : clean;
  const head = `${label}${capped ? `: ${capped}` : ""}\n${url}`;
  return userPrompt ? `${head}\n\n${userPrompt}` : head;
}
