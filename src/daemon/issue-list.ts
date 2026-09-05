/**
 * A repo's OPEN issues, as the source picker needs to see them (issue #151).
 *
 * The sibling of `pr-list.ts`, deliberately built the same way and out of the
 * same `gh` plumbing from `gh-spawn-source.ts`: the injectable runner, the
 * explicit env, the 15s timeout, the written-down `--limit`, the read-a-row-
 * field-by-field reader that DROPS a malformed entry rather than failing the
 * list, and the rule that a failure is `{ ok: false, error }` and never an
 * empty list. Read that module's header for the reasoning; it applies here
 * unchanged.
 *
 * Two facts specific to issues:
 *
 * - `gh issue list` never returns pull requests, so nothing downstream has to
 *   dedupe the two lists against each other.
 * - A list that has gone stale is fail-SAFE by construction. An issue closed
 *   between the listing and the pick is refused by `lookupIssue` on the spawn
 *   path, which re-reads its state and says so. So there is deliberately no
 *   second state check here, and adding one would only narrow the window it
 *   cannot close anyway.
 */

import {
  ghProblem,
  readString,
  runGh,
  stripControlChars,
  type GhRun,
  type SourceResult,
} from "./gh-spawn-source";

/**
 * How many issues one repo contributes.
 *
 * The same explicit cap as `PR_LIST_LIMIT`, for the same reason: `gh issue
 * list` caps at 30 on its own, and a cap nobody chose is worse than one that
 * is written down.
 */
const ISSUE_LIST_LIMIT = 50;

/** The `--json` fields a row renders, in the order gh takes them. */
const ISSUE_LIST_FIELDS = ["number", "title", "url", "author", "labels"].join(
  ",",
);

/** One open issue, flattened to what a row shows. */
export interface OpenIssue {
  number: number;
  /** Control characters already stripped; see {@link stripControlChars}. */
  title: string;
  url: string;
  /** The author's login, or null when gh did not name one. */
  author: string | null;
  /** Label names only. Empty when the issue has none, or gh named none. */
  labels: string[];
}

/**
 * Every open issue of the repo `cwd` sits in.
 *
 * Run in `cwd` so gh resolves the same repo every other surface does. Never
 * throws: `runGh` turns a missing binary into a result, and everything else
 * that can go wrong lands in `error`.
 */
export async function listOpenIssues(
  cwd: string,
  run: GhRun = runGh,
): Promise<SourceResult<OpenIssue[]>> {
  const result = await run(cwd, [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIST_LIMIT),
    "--json",
    ISSUE_LIST_FIELDS,
  ]);
  const problem = ghProblem("issue list", result);
  if (problem) return { ok: false, error: problem };

  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout);
  } catch (err) {
    return {
      ok: false,
      error: `gh issue list did not return valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      error: "gh issue list did not return valid JSON: expected an array",
    };
  }

  const issues: OpenIssue[] = [];
  for (const raw of rows) {
    const issue = readIssue(raw);
    // One row gh could not describe well enough to identify must not cost a
    // repo its whole section. Nothing here is destructive, so a missing row
    // is a missing row where a refusal would be a blank list.
    if (issue) issues.push(issue);
  }
  // Newest first, which is gh's own order — restated as a sort so the list
  // does not inherit whatever ordering a future gh decides on.
  issues.sort((a, b) => b.number - a.number);
  return { ok: true, value: issues };
}

/** One `gh issue list` row, or null when it lacks the fields that identify it. */
function readIssue(raw: unknown): OpenIssue | null {
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
    // Sanitized HERE, at the boundary GitHub's text enters through, for the
    // reason `pr-list.ts` gives: a title reaches a TUI row, the new-session
    // dialog's note and (through `seedPrompt`) an agent's opening message,
    // and only one of those would have thought to strip it.
    title: stripControlChars(readString(row, "title") ?? `Issue #${number}`),
    url,
    // `author` is an OBJECT (`{ login, ... }`), not a string.
    author: nestedString(row.author, "login"),
    labels: readLabels(row.labels),
  };
}

/**
 * Label names, read defensively.
 *
 * A label gh describes without a name is dropped rather than rendered as an
 * empty chip. Labels are decoration on a row nobody acts on by label, so
 * losing one costs nothing; an unreadable list costs the row.
 */
function readLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const name = readString(item as Record<string, unknown>, "name");
    if (name) names.push(stripControlChars(name));
  }
  return names;
}

function nestedString(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null) return null;
  return readString(value as Record<string, unknown>, key);
}

/** One repo's open issues, as `GET /issues` reports them. */
export interface IssueRepo {
  repoRoot: string;
  repoName: string;
  issues: OpenIssue[];
}

/**
 * A repo whose issues could not be read.
 *
 * Per repo rather than per response, exactly as `PRListError` is: one broken
 * checkout (no GitHub remote, issues disabled on the repo, a repo `gh` is not
 * authenticated for) costs its own section and nothing else. Spelled out here
 * rather than shared with `pr-list.ts` because the two lists are deliberately
 * independent on the wire — a repo with issues turned off must be able to
 * fail this list while its PR list still answers.
 */
export interface IssueListError {
  repoRoot: string;
  repoName: string;
  error: string;
}

/** Body of `GET /issues`. */
export interface IssueListResponse {
  repos: IssueRepo[];
  errors: IssueListError[];
}

/**
 * What a client actually receives, which is not the same type: the daemon is
 * a long-lived process that may PREDATE this build, so every field is
 * optional on the wire. Same guard `normalizePRList` puts on the PR list, and
 * it lives beside the response for the same reason — so the two cannot drift.
 */
export type IssueListBody = Partial<IssueListResponse>;

export function normalizeIssueList(data: IssueListBody): IssueListResponse {
  return { repos: data.repos ?? [], errors: data.errors ?? [] };
}
