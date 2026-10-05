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

import type { BranchPR } from "../types/session";
import { normalizeReviewDecision } from "./pr-resolver";
import {
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
 * more rows than the panel can usefully show and still one request. It must
 * also stay within the 100 ids GraphQL's `nodes(ids:)` takes, since
 * {@link readCIStatuses} asks about every listed PR in one query.
 */
const PR_LIST_LIMIT = 50;

/**
 * The `--json` fields the section renders, in the order gh takes them.
 *
 * `statusCheckRollup` is deliberately NOT one of them. gh expands that field
 * into every check of every PR (`contexts(first:100)`, each with its workflow
 * joined in), and fifty PRs of that on a repo with heavy CI is more than
 * GitHub's GraphQL endpoint answers inside its own timeout: `vercel/next.js`
 * fails with a 504 after 11s, and the panel showed the same failure as a 502
 * with no list at all. `id` is here instead, so {@link readCIStatuses} can ask
 * for the one enum a row actually draws.
 */
const PR_LIST_FIELDS = [
  "id",
  "number",
  "title",
  "url",
  "author",
  "isDraft",
  "reviewDecision",
  "headRefName",
  "headRefOid",
].join(",");

/**
 * Each PR's CI as GitHub's own verdict on its head commit, one enum per PR.
 *
 * On `vercel/next.js` this and the slimmed list together take about 3.5s,
 * where the expanded rollup never answered.
 */
const CI_STATUS_QUERY =
  "query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { id commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }";

/** One open pull request, flattened to what a row shows. */
export interface OpenPR {
  number: number;
  /** Control characters already stripped; see {@link stripControlChars}. */
  title: string;
  url: string;
  /** The author's login, or null when gh did not name one. */
  author: string | null;
  isDraft: boolean;
  reviewDecision: BranchPR["reviewDecision"];
  ciStatus: NonNullable<BranchPR["ciStatus"]>;
  headRefName: string;
  /**
   * SHA of the PR's head commit, or null when gh did not report one.
   *
   * The ONLY thing that proves a local branch is this PR's. Never match a PR
   * to a checkout by branch NAME: `gh pr list --head patch-1` on `cli/cli`
   * returns 25 PRs from 25 different forks, which is the namesake trap
   * `selectPRForBranch` exists to document.
   */
  headRefOid: string | null;
}

/** A listed PR whose CI is not known yet, with the node id that asks for it. */
type ListedPR = Omit<OpenPR, "ciStatus"> & { id: string };

/**
 * Every open PR of the repo `cwd` sits in.
 *
 * Run in `cwd` so gh resolves the same repo every other surface does. Never
 * throws: `runGh` turns a missing binary into a result, and everything else
 * that can go wrong lands in `error`.
 *
 * Two calls: the list itself, then one {@link readCIStatuses} query for all
 * of its rows. A failure of EITHER fails the list, because the second one
 * failing leaves no honest `ciStatus` to draw: `"none"` means "no checks
 * configured", and a row cannot say "unknown".
 */
export async function listOpenPRs(
  cwd: string,
  run: GhRun = runGh,
): Promise<SourceResult<OpenPR[]>> {
  const result = await run(cwd, [
    "pr",
    "list",
    "--state",
    "open",
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

  const listed: ListedPR[] = [];
  for (const raw of rows) {
    const pr = readPR(raw);
    // A row gh could not describe well enough to identify is DROPPED rather
    // than failing the whole list: one malformed entry must not cost a repo
    // its section. Nothing here is destructive, so a missing row is a missing
    // row, where a refusal would be a blank panel.
    if (pr) listed.push(pr);
  }
  if (listed.length === 0) return { ok: true, value: [] };

  const ci = await readCIStatuses(cwd, listed, run);
  if (!ci.ok) return ci;
  const prs: OpenPR[] = listed.map(({ id, ...pr }) => ({
    ...pr,
    // A PR the answer did not cover reads as `"none"`, never `"passing"`:
    // the one wrong answer that would let an unverified PR wear a green tick.
    ciStatus: ci.value.get(id) ?? "none",
  }));
  // Newest first, which is gh's own order — restated as a sort so the section
  // does not inherit whatever ordering a future gh decides on.
  prs.sort((a, b) => b.number - a.number);
  return { ok: true, value: prs };
}

/** One `gh pr list` row, or null when it lacks the fields that identify it. */
function readPR(raw: unknown): ListedPR | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const id = readString(row, "id");
  const number = row.number;
  const url = readString(row, "url");
  // `id` is identity too: without it the row's CI cannot be asked for.
  if (!id || typeof number !== "number" || !Number.isInteger(number) || !url) {
    return null;
  }
  return {
    id,
    number,
    // Sanitized HERE, at the boundary GitHub's text enters through, rather
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
    headRefName: readString(row, "headRefName") ?? "",
    headRefOid: readString(row, "headRefOid"),
  };
}

/**
 * Each listed PR's CI status, keyed by node id, from one GraphQL query.
 *
 * `--hostname` comes from the PRs' own URL because `gh api`, unlike
 * `gh pr list`, does not take its host from the repo it runs in: on a GitHub
 * Enterprise checkout, with github.com also logged in, it would ask github.com
 * about ids it has never heard of.
 */
async function readCIStatuses(
  cwd: string,
  prs: ListedPR[],
  run: GhRun,
): Promise<SourceResult<Map<string, OpenPR["ciStatus"]>>> {
  const host = hostOf(prs[0]?.url ?? "");
  const result = await run(cwd, [
    "api",
    "graphql",
    ...(host ? ["--hostname", host] : []),
    "-f",
    `query=${CI_STATUS_QUERY}`,
    // `-f`, never `-F`: a raw field cannot be read as `@file` or a number.
    ...prs.flatMap((pr) => ["-f", `ids[]=${pr.id}`]),
  ]);
  const problem = ghProblem("api graphql", result);
  if (problem) return { ok: false, error: `reading CI status: ${problem}` };

  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch (err) {
    return {
      ok: false,
      error: `reading CI status: gh api graphql did not return valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  const nodes = (body as { data?: { nodes?: unknown } } | null)?.data?.nodes;
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      error:
        "reading CI status: gh api graphql did not return valid JSON: expected data.nodes",
    };
  }

  const statuses = new Map<string, OpenPR["ciStatus"]>();
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const id = readString(node as Record<string, unknown>, "id");
    if (id) statuses.set(id, ciStatusOf(rollupStateOf(node)));
  }
  return { ok: true, value: statuses };
}

/** `commits.nodes[0].commit.statusCheckRollup.state`, or null at any gap. */
function rollupStateOf(node: object): string | null {
  const commits = (node as { commits?: { nodes?: unknown } }).commits?.nodes;
  if (!Array.isArray(commits)) return null;
  const head = commits[0] as
    | { commit?: { statusCheckRollup?: { state?: unknown } | null } }
    | undefined;
  const state = head?.commit?.statusCheckRollup?.state;
  return typeof state === "string" ? state : null;
}

/**
 * GitHub's rollup state as the `ciStatus` a row draws.
 *
 * Not `foldChecks`, since there are no checks here to fold, but held to it:
 * on 200 open PRs across `microsoft/vscode`, `facebook/react`, `cli/cli` and
 * `denoland/deno` (2026-10-05) the two agreed on every one, including PRs
 * whose only failure was CANCELLED or ACTION_REQUIRED (failing here too, as
 * `pr-resolver.ts` insists), PRs that only SKIPPED (passing), and PRs with no
 * checks at all, which GitHub reports as a null rollup. STALE and
 * STARTUP_FAILURE never came up, so whether GitHub also reads those as pending
 * is unverified.
 *
 * Null and any state GitHub adds later read as `"none"`, never `"passing"`.
 */
function ciStatusOf(state: string | null): OpenPR["ciStatus"] {
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

/** The host part of a PR URL, or null when it does not parse. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
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
