/**
 * A repo's OPEN pull requests, as the Worktrees panel's PR section needs to
 * see them (issue #151).
 *
 * Repo-wide, which is what makes this a module rather than another call site.
 * The two existing listers are both branch-scoped and answer a different
 * question: `pr-resolver.ts` enriches ONE session's `(cwd, branch)` cell, and
 * `worktree-prune.ts` asks `--state all` about ONE branch to decide whether a
 * directory is finished. Neither can answer "what is open on this repo", which
 * is the whole content of a PR list.
 *
 * It sits beside `gh-spawn-source.ts` and reuses its `gh` plumbing wholesale —
 * the injectable runner, the explicit `env`, the 15s timeout and the failure
 * wording — because this call has the same shape and the same caller: a
 * request path someone is watching, where a hung `gh` must become a message
 * rather than a spinner that never stops.
 *
 * A failure is `{ ok: false, error }`, never an empty list. "This repo has no
 * open PRs" and "gh could not answer" are opposite facts — the first is a
 * section that correctly does not draw, the second is a section the user
 * should be told about — and `worktree-prune.ts` documents at length what
 * collapsing them costs.
 */

import { runMetadataGit, type GitRun } from "./worktree-git";
import type { BranchPR } from "../types/session";
import {
  foldChecks,
  normalizeReviewDecision,
  type RollupEntry,
} from "./pr-resolver";
import {
  parseRepoSlug,
  sameRepo,
  ghProblem,
  readString,
  runGh,
  stripControlChars,
  type GhRun,
  type SourceResult,
} from "./gh-spawn-source";

/**
 * How many PRs one repo contributes.
 *
 * Passed explicitly because `gh pr list` caps at 30 on its own, and a cap
 * nobody chose is worse than one that is written down: a busy repo would
 * silently lose its oldest open PRs with nothing on screen to say so. 50 is
 * more rows than the panel can usefully show and still one request.
 */
export const PR_LIST_LIMIT = 50;

/** The `--json` fields the section renders, in the order gh takes them. */
const PR_LIST_FIELDS = [
  "number",
  "title",
  "url",
  "author",
  "isDraft",
  "reviewDecision",
  "statusCheckRollup",
  "headRefName",
  "headRefOid",
  "headRepository",
  "headRepositoryOwner",
  "createdAt",
  "labels",
].join(",");

/** One open pull request, flattened to what a row shows. */
export interface OpenPR {
  number: number;
  createdAt?: string | null;
  labels?: string[];
  /** Control characters already stripped; see {@link stripControlChars}. */
  title: string;
  url: string;
  /** The author's login, or null when gh did not name one. */
  author: string | null;
  isDraft: boolean;
  reviewDecision: BranchPR["reviewDecision"];
  ciStatus: NonNullable<BranchPR["ciStatus"]>;
  headRefName: string;
  /** Source repository identity, distinct from the PR author and base repo. */
  headRepository?: { owner: string; name: string } | null;
  /**
   * SHA of the PR's head commit, or null when gh did not report one.
   *
   * For Start's checkout routing, only an exact SHA proves the destination.
   * Badges can also use configured upstream identity via associatedBranchPRs.
   * Never match a PR to a checkout by branch NAME: `gh pr list --head patch-1` on `cli/cli`
   * returns 25 PRs from 25 different forks, which is the namesake trap
   * `selectPRForBranch` exists to document.
   */
  headRefOid: string | null;
}

/**
 * Every open PR of the repo `cwd` sits in.
 *
 * Run in `cwd` so gh resolves the same repo every other surface does. Never
 * throws: `runGh` turns a missing binary into a result, and everything else
 * that can go wrong lands in `error`.
 */
export async function listOpenPRs(
  cwd: string,
  run: GhRun = runGh,
  head?: string,
): Promise<SourceResult<OpenPR[]>> {
  const result = await run(cwd, [
    "pr",
    "list",
    "--state",
    "open",
    ...(head ? ["--head", head] : []),
    "--limit",
    String(PR_LIST_LIMIT),
    "--json",
    PR_LIST_FIELDS,
  ]);
  const problem = ghProblem("pr list", result);
  if (problem) return { ok: false, error: problem };

  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout);
  } catch (err) {
    return {
      ok: false,
      error: `gh pr list did not return valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      error: "gh pr list did not return valid JSON: expected an array",
    };
  }

  const prs: OpenPR[] = [];
  for (const raw of rows) {
    const pr = readPR(raw);
    // A row gh could not describe well enough to identify is DROPPED rather
    // than failing the whole list: one malformed entry must not cost a repo
    // its section. Nothing here is destructive, so a missing row is a missing
    // row, where a refusal would be a blank panel.
    if (pr) prs.push(pr);
  }
  // Newest first, which is gh's own order — restated as a sort so the section
  // does not inherit whatever ordering a future gh decides on.
  prs.sort((a, b) => b.number - a.number);
  return { ok: true, value: prs };
}

/** One `gh pr list` row, or null when it lacks the fields that identify it. */
function readPR(raw: unknown): OpenPR | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const number = row.number;
  const url = readString(row, "url");
  if (typeof number !== "number" || !Number.isInteger(number) || !url) {
    return null;
  }
  return {
    number,
    createdAt: readString(row, "createdAt"),
    labels: Array.isArray(row.labels)
      ? row.labels.flatMap((label) => {
          const name = nestedString(label, "name");
          return name ? [stripControlChars(name)] : [];
        })
      : [], // Sanitized HERE, at the boundary GitHub's text enters through, rather
    // than at each of the places it renders: a title reaches a TUI row, the
    // new-session dialog's note and (through `seedPrompt`) an agent's opening
    // message, and only one of those would have thought to strip it.
    title: stripControlChars(readString(row, "title") ?? `PR #${number}`),
    url,
    // `author` is an OBJECT (`{ login, ... }`), not a string, so it takes the
    // nested read that `gh pr view`'s headRepositoryOwner takes.
    author: nestedString(row.author, "login"),
    // Anything that is not literally `true` is not a draft. gh sends a
    // boolean; a field it stops sending must not make every PR a draft.
    isDraft: row.isDraft === true,
    reviewDecision: normalizeReviewDecision(
      typeof row.reviewDecision === "string" ? row.reviewDecision : null,
    ),
    // The shared fold, not a second opinion on it: it mirrors gh's own PR
    // rollup, an empty rollup is `"none"` rather than `"passing"`, and
    // CANCELLED counts as failing by design. See `pr-resolver.ts`.
    ciStatus: foldChecks(readRollup(row.statusCheckRollup)),
    headRepository: (() => {
      const owner = nestedString(row.headRepositoryOwner, "login");
      const name = nestedString(row.headRepository, "name");
      return owner && name ? { owner, name } : null;
    })(),
    headRefName: readString(row, "headRefName") ?? "",
    headRefOid: readString(row, "headRefOid"),
  };
}

/**
 * The check rollup, read field by field rather than trusted as a shape.
 *
 * An entry too malformed to read is DROPPED, which biases the fold towards
 * `"none"` — never towards `"passing"`, the one answer that would let an
 * un-verified PR wear a green tick.
 */
function readRollup(value: unknown): RollupEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: RollupEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const str = (key: string): string | null =>
      typeof row[key] === "string" ? (row[key] as string) : null;
    entries.push({
      __typename: str("__typename") ?? undefined,
      status: str("status"),
      conclusion: str("conclusion"),
      state: str("state"),
    });
  }
  return entries;
}

function nestedString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  return readString(value as Record<string, unknown>, key);
}

/** One repo's open PRs, as `GET /prs` reports them. */
export interface PRRepo {
  repoRoot: string;
  repoName: string;
  prs: OpenPR[];
}

/**
 * A repo whose PRs could not be read.
 *
 * Per repo rather than per response, so one broken checkout (no GitHub
 * remote, a repo `gh` is not authenticated for) costs its own section and
 * nothing else. A single top-level error would take every other repo's list
 * down with it, which on the multi-repo view is most of the panel.
 */
export interface PRListError {
  repoRoot: string;
  repoName: string;
  error: string;
}

/** Body of `GET /prs`. */
export interface PRListResponse {
  repos: PRRepo[];
  errors: PRListError[];
}

/**
 * What a client actually receives, which is not the same type: the daemon is
 * a long-lived process that may PREDATE this build, so every field is
 * optional on the wire. Same guard `ScanResponse`/`normalizeScan` puts on the
 * prune scan, and it lives beside the response for the same reason — so the
 * two cannot drift apart as the response gains fields.
 */
export type PRListBody = Partial<PRListResponse>;

export function normalizePRList(data: PRListBody): PRListResponse {
  return { repos: data.repos ?? [], errors: data.errors ?? [] };
}

/** The head name a capped `gh` query should use. A local alias such as
 *  `review-7` tracking `refs/heads/feature` must ask for `feature`. */
export async function upstreamHeadName(
  cwd: string,
  branch: string,
  git: GitRun = runMetadataGit,
): Promise<string> {
  const merge = await git(cwd, ["config", "--get", `branch.${branch}.merge`]);
  // A timeout must not fall through to the local name: a tracking alias
  // would then be queried as if it were the upstream head. Exit 1 (unset)
  // and other config failures still use the local name.
  if (merge.exitCode === 124) {
    throw new Error(`git config failed (${merge.exitCode})`);
  }
  if (merge.exitCode !== 0) return branch;
  const ref = merge.stdout.trim();
  return ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : branch;
}

function looksLikeRemoteUrl(value: string): boolean {
  return value.includes("://") || value.startsWith("git@");
}

/** `git config --get` exits 1 when the key is unset. Any other failure is
 *  unreadable identity, which must not be reported as "no association". */
async function configGet(
  git: GitRun,
  cwd: string,
  key: string,
): Promise<{ ok: true; value: string } | { ok: false }> {
  const result = await git(cwd, ["config", "--get", key]);
  if (result.exitCode === 1) return { ok: true, value: "" };
  if (result.exitCode !== 0) return { ok: false };
  return { ok: true, value: result.stdout.trim() };
}

/** An exact local tip always associates. Upstream identity additionally
 * allows local-ahead commits, except a trunk tracked under another name: a
 * branch cut from origin/main tracks main without being main's PR.
 * These are local ref/config reads; never fetch or inspect dirty files.
 * Fork checkouts store a URL in `branch.<name>.remote` with no named remote,
 * so the upstream atoms on `for-each-ref` are empty even when that config is set. */
export async function associatedBranchPRs(
  cwd: string,
  branch: string,
  prs: OpenPR[],
  git: GitRun = runMetadataGit,
): Promise<SourceResult<OpenPR[]>> {
  if (!prs.length) return { ok: true, value: [] };
  const ref = `refs/heads/${branch}`;
  const tipResult = await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
  if (tipResult.exitCode !== 0 && tipResult.exitCode !== 1)
    return { ok: false, error: "Cannot read branch identity" };
  const tip = tipResult.exitCode === 0 ? tipResult.stdout.trim() : "";
  if (!tip) return { ok: true, value: [] };
  const remoteConfig = await configGet(git, cwd, `branch.${branch}.remote`);
  const mergeConfig = await configGet(git, cwd, `branch.${branch}.merge`);
  if (!remoteConfig.ok || !mergeConfig.ok)
    return { ok: false, error: "Cannot read branch identity" };
  const remote = remoteConfig.value;
  const merge = mergeConfig.value;
  let remoteRepo = null;
  if (remote && remote !== "." && merge) {
    if (looksLikeRemoteUrl(remote)) {
      remoteRepo = parseRepoSlug(remote);
    } else {
      const url = await git(cwd, ["remote", "get-url", "--", remote]);
      if (url.exitCode !== 0)
        return { ok: false, error: "Cannot read branch remote" };
      remoteRepo = parseRepoSlug(url.stdout);
    }
  }
  const upstream = merge.startsWith("refs/heads/")
    ? merge.slice("refs/heads/".length)
    : "";
  const tracksTrunk =
    !!remoteRepo &&
    !!upstream &&
    upstream !== branch &&
    prs.some((pr) => pr.headRefName === upstream) &&
    (await isTrunk(git, cwd, remote, upstream));
  return {
    ok: true,
    value: prs.filter((pr) => {
      // An upstream can name an unrelated branch (one cut from origin/main
      // tracks main), so it widens the SHA proof and never vetoes it.
      if (pr.headRefOid === tip) return true;
      if (!remoteRepo) return false;
      const base = parseRepoSlug(pr.url);
      if (merge === `refs/pull/${pr.number}/head`)
        return sameRepo(remoteRepo, base);
      const head =
        base && pr.headRepository
          ? {
              host: base.host,
              owner: pr.headRepository.owner.toLowerCase(),
              repo: pr.headRepository.name.toLowerCase(),
            }
          : null;
      return (
        merge === `refs/heads/${pr.headRefName}` &&
        !tracksTrunk &&
        sameRepo(remoteRepo, head)
      );
    }),
  };
}

/** `main`/`master`, or the remote's `HEAD` target when it is recorded. An
 *  unreadable `HEAD` is not a trunk: the conventional names already cover
 *  the common case, and a URL remote has no `HEAD` ref to read. */
async function isTrunk(
  git: GitRun,
  cwd: string,
  remote: string,
  name: string,
): Promise<boolean> {
  if (name === "main" || name === "master") return true;
  if (looksLikeRemoteUrl(remote)) return false;
  const head = await git(cwd, [
    "symbolic-ref",
    "--quiet",
    "--short",
    `refs/remotes/${remote}/HEAD`,
  ]);
  return head.exitCode === 0 && head.stdout.trim() === `${remote}/${name}`;
}
