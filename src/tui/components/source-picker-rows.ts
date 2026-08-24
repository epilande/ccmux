/**
 * What the source picker lists, and how each row is worded (issue #151).
 *
 * The picker answers one question — "what do I start work on?" — over two
 * sources that answer it differently: a pull request has a HEAD to check out,
 * an issue has only a number and a title. They share a list because the
 * question is one question and the FILTER is what makes that pay: typing
 * `notif` should reach both without the user first declaring which kind of
 * thing they are remembering.
 *
 * Pure, and separate from the component for the reason the panel's row
 * helpers are: this is where the rules live that a test can state directly,
 * and the component is left with rendering and keys.
 */

import type { IssueListResponse, OpenIssue } from "../../daemon/issue-list";
import type { OpenPR, PRListResponse } from "../../daemon/pr-list";
import type {
  WorktreeListResponse,
  WorktreeRow,
} from "../../daemon/worktree-list";
import { theme } from "../theme";
import {
  oneLine,
  orderRepos,
  unhandled,
  type Phrase,
} from "./row-segments";
import {
  PR_MARKER,
  checkoutHolding,
  prDetailPhrases,
  prRowKey,
  prRowLabel,
} from "./pr-rows";
import type { SourceSectionStatus } from "../utils/source-lists";

/**
 * The issue rows' marker, in the same one-column slot the PR rows use.
 *
 * A hollow ring against the PR's dotted one: they sit in one list, so the two
 * kinds have to be distinguishable at the left edge before the words are
 * read. Both are East Asian Ambiguous, so they stand or fall together under
 * `displayWidth` and a mis-measure is fixed once.
 */
export const ISSUE_MARKER = "○";

/** The section labels, which also name the sources in every message. */
export const PRS_SECTION = "Pull requests";
export const ISSUES_SECTION = "Issues";

/**
 * The cursor/layout key for an issue row.
 *
 * Cannot collide with a worktree's (an absolute path), nor with a PR row's:
 * `"issue:".startsWith("pr:")` is false, so `isPRRowKey` does not claim it.
 */
export function issueRowKey(repoRoot: string, number: number): string {
  return `issue:${repoRoot}#${number}`;
}

/** Whether `key` names an issue row. The inverse of the note above. */
export function isIssueRowKey(key: string): boolean {
  return key.startsWith("issue:");
}

/** One open pull request, with the checkout that already holds it resolved. */
export interface PRSourceRow {
  kind: "pr";
  key: string;
  repoRoot: string;
  repoName: string;
  pr: OpenPR;
  /** The worktree holding this PR's head, proved by SHA, or null. */
  checkedOutPath: string | null;
  checkedOutName: string | null;
}

/** One open issue, with the worktree a previous spawn cut for it, if any. */
export interface IssueSourceRow {
  kind: "issue";
  key: string;
  repoRoot: string;
  repoName: string;
  issue: OpenIssue;
  checkedOutPath: string | null;
  checkedOutName: string | null;
  /** Other worktrees for the same issue, beyond the one named above. */
  siblings: number;
}

export type SourceRow = PRSourceRow | IssueSourceRow;

/** One repo's contribution: its rows, and what each source has to say. */
export interface SourceRepo {
  repoRoot: string;
  repoName: string;
  prs: PRSourceRow[];
  issues: IssueSourceRow[];
  prSection: SourceSectionStatus;
  issueSection: SourceSectionStatus;
}

/**
 * The worktree a previous spawn cut for issue `number`, and how many others
 * exist for the same issue.
 *
 * By NAME, which is safe here and is not safe for a PR. The name is ccmux's
 * own: `slugForIssue` derives `issue-<n>` or `issue-<n>-<slug>`, so a match
 * proves this tool made that directory for that issue. A PR's branch name is
 * chosen by whoever opened it, which is why `checkoutHolding` insists on a
 * SHA instead.
 *
 * The prefix is family-EXACT and never a bare `startsWith`: `issue-14` would
 * otherwise claim `issue-144-foo`. The separator is part of the prefix, the
 * same rule `worktreeHoldsPath` follows for paths.
 *
 * Several can exist, because a second spawn on the same issue derives
 * `issue-144-foo-2` rather than opening the first. The SHORTEST name wins —
 * that is the first spawn — and the count of the rest is reported rather than
 * swallowed: unlike a PR there is no SHA to break the tie, so silently
 * choosing one of two live checkouts must at least be visible.
 */
export function worktreeForIssue(
  number: number,
  worktrees: WorktreeRow[],
): { row: WorktreeRow; siblings: number } | null {
  const exact = `issue-${number}`;
  const family = `${exact}-`;
  const matches = worktrees.filter(
    (row) => row.name === exact || row.name.startsWith(family),
  );
  if (matches.length === 0) return null;
  const [first] = [...matches].sort(
    (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
  );
  return first ? { row: first, siblings: matches.length - 1 } : null;
}

/**
 * Fold the three reads into the groups the picker draws.
 *
 * Three independent requests land here: the open PRs, the open issues, and
 * the local worktree list that both kinds are matched against. The worktrees
 * are LOCAL and answer instantly, so a row can be marked checked-out before
 * either GitHub answer arrives; a source still in flight contributes a
 * pending section rather than an absence, which is what keeps the header from
 * announcing `0` for something nobody has asked yet.
 *
 * The repo set is the UNION of everything that answered, because a repo one
 * read can see and another cannot is a section attached to nothing — the
 * three endpoints scope through the same resolver precisely so this union is
 * normally just one of them.
 */
export function buildSourceRepos(input: {
  prs: PRListResponse | null;
  prError: string | null;
  issues: IssueListResponse | null;
  issueError: string | null;
  worktrees: WorktreeListResponse | null;
  home: string | null;
}): SourceRepo[] {
  const names = new Map<string, string>();
  const note = (repoRoot: string, repoName: string) => {
    if (!names.has(repoRoot)) names.set(repoRoot, repoName);
  };
  for (const repo of input.worktrees?.repos ?? []) note(repo.repoRoot, repo.repoName);
  for (const repo of input.prs?.repos ?? []) note(repo.repoRoot, repo.repoName);
  for (const repo of input.prs?.errors ?? []) note(repo.repoRoot, repo.repoName);
  for (const repo of input.issues?.repos ?? []) note(repo.repoRoot, repo.repoName);
  for (const repo of input.issues?.errors ?? []) note(repo.repoRoot, repo.repoName);

  const worktreesByRoot = new Map<string, WorktreeRow[]>();
  for (const repo of input.worktrees?.repos ?? []) {
    worktreesByRoot.set(repo.repoRoot, repo.worktrees);
  }

  const built: SourceRepo[] = [];
  for (const [repoRoot, repoName] of names) {
    const worktrees = worktreesByRoot.get(repoRoot) ?? [];
    const prs = (input.prs?.repos.find((r) => r.repoRoot === repoRoot)?.prs ?? []).map(
      (pr): PRSourceRow => {
        const holder = checkoutHolding(pr, worktrees);
        return {
          kind: "pr",
          key: prRowKey(repoRoot, pr.number),
          repoRoot,
          repoName,
          pr,
          checkedOutPath: holder?.path ?? null,
          checkedOutName: holder?.name ?? null,
        };
      },
    );
    const issues = (
      input.issues?.repos.find((r) => r.repoRoot === repoRoot)?.issues ?? []
    ).map((issue): IssueSourceRow => {
      const holder = worktreeForIssue(issue.number, worktrees);
      return {
        kind: "issue",
        key: issueRowKey(repoRoot, issue.number),
        repoRoot,
        repoName,
        issue,
        checkedOutPath: holder?.row.path ?? null,
        checkedOutName: holder?.row.name ?? null,
        siblings: holder?.siblings ?? 0,
      };
    });
    built.push({
      repoRoot,
      repoName,
      prs,
      issues,
      prSection: sectionStatus(repoRoot, input.prs, input.prError, (repo) => repo.prs.length),
      issueSection: sectionStatus(
        repoRoot,
        input.issues,
        input.issueError,
        (repo) => repo.issues.length,
      ),
    });
  }
  return orderRepos(built, input.home);
}

/**
 * One source's state for one repo.
 *
 * A WHOLE-request failure and a PER-REPO one are different facts and both are
 * reported here as `unavailable` with their own cause: the request-wide one
 * is the first-run state for every existing user, whose daemon predates the
 * endpoint until they restart it. A repo the response mentions in NEITHER its
 * repos nor its errors is reported ready-0, which is knowingly generous —
 * "never asked" reads as "nothing open" — and is the same gap the panel
 * leaves open, kept identical rather than answered differently in two places.
 */
function sectionStatus<T extends { repoRoot: string }>(
  repoRoot: string,
  response: { repos: T[]; errors: { repoRoot: string; error: string }[] } | null,
  error: string | null,
  count: (repo: T) => number,
): SourceSectionStatus {
  if (error) return { kind: "unavailable", reason: error };
  if (!response) return { kind: "pending" };
  const failed = response.errors.find((row) => row.repoRoot === repoRoot);
  if (failed) return { kind: "unavailable", reason: failed.error };
  const repo = response.repos.find((row) => row.repoRoot === repoRoot);
  return { kind: "ready", count: repo ? count(repo) : 0 };
}

/**
 * A row's label: the number and the title, as one string.
 *
 * The number is what the request carries and the title is the only thing that
 * says what it is, so they are one label on the bright line. Splitting them
 * across two columns would put the human-readable half on the dim one.
 */
export function sourceRowLabel(row: SourceRow): string {
  if (row.kind === "pr") return prRowLabel(row.pr);
  return `#${row.issue.number} ${row.issue.title}`;
}

/** The marker in a row's gutter, which is what distinguishes the two kinds. */
export function sourceRowMarker(row: SourceRow): string {
  return row.kind === "pr" ? PR_MARKER : ISSUE_MARKER;
}

/**
 * Whether a row's label is drawn dimmer than the rest of the list.
 *
 * Only a draft PR is: it is on GitHub but is not asking for anything yet, and
 * the list exists to point at what is. An issue has no equivalent state — an
 * open issue is open — so nothing dims it.
 */
export function sourceRowDim(row: SourceRow): boolean {
  return row.kind === "pr" && row.pr.isDraft;
}

/**
 * A row's detail line, in reading order.
 *
 * A PR's is the panel's, unchanged and shared. An issue's is deliberately
 * shorter, because there is less that is true about it: who opened it, its
 * labels, and — loudest, because it changes what Enter does — the checkout a
 * previous spawn already cut for it.
 */
export function sourceDetailPhrases(
  row: SourceRow,
  opts: { compact?: boolean } = {},
): Phrase[] {
  if (row.kind === "pr") {
    return prDetailPhrases(row.pr, {
      checkedOutName: row.checkedOutName,
      compact: opts.compact,
    });
  }
  const phrases: Phrase[] = [];
  if (row.issue.author) {
    phrases.push({ text: `@${row.issue.author}`, fg: theme.overlay });
  }
  // Labels are the only thing on an issue row that says what KIND of work it
  // is, so they survive a narrow surface where the author does not.
  if (row.issue.labels.length > 0) {
    phrases.push({ text: row.issue.labels.join(", "), fg: theme.subtext });
  }
  if (row.checkedOutName) {
    phrases.push({
      text:
        row.siblings > 0
          ? `checked out in ${row.checkedOutName} (+${row.siblings} more)`
          : `checked out in ${row.checkedOutName}`,
      fg: theme.green,
    });
  }
  return phrases;
}

/**
 * Everything a row can be matched on, lower-cased.
 *
 * Deliberately wide: the number, the title, the author, a PR's branch and an
 * issue's labels. `151`, `epilande`, `spawn-pr` and `bug` should each narrow
 * the list, because a user opening this surface remembers one of those and
 * has no reason to know which field it lives in.
 */
export function rowHaystack(row: SourceRow): string {
  const parts =
    row.kind === "pr"
      ? [
          `#${row.pr.number}`,
          row.pr.title,
          row.pr.author ?? "",
          row.pr.headRefName,
        ]
      : [
          `#${row.issue.number}`,
          row.issue.title,
          row.issue.author ?? "",
          ...row.issue.labels,
        ];
  return parts.join(" ").toLowerCase();
}

/**
 * Case-insensitive substring, over the whole haystack.
 *
 * The same simple matcher the session search uses. No fuzzy scoring: a picker
 * whose ranking a user cannot predict is a picker they read all of anyway.
 */
export function matchesQuery(row: SourceRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return rowHaystack(row).includes(needle);
}

/**
 * The repos with only the matching rows kept.
 *
 * A repo is kept even when NOTHING in it matches, and its sections say `0`.
 * Dropping it instead would make the list jump between repos as characters
 * are typed, and a `0` under a name is the answer to "is it in this one".
 * The two failure states are untouched by a filter: they report what GitHub
 * said, which no local query changes.
 */
export function filterRepos(repos: SourceRepo[], query: string): SourceRepo[] {
  if (!query.trim()) return repos;
  return repos.map((repo) => {
    const prs = repo.prs.filter((row) => matchesQuery(row, query));
    const issues = repo.issues.filter((row) => matchesQuery(row, query));
    return {
      ...repo,
      prs,
      issues,
      prSection: recount(repo.prSection, prs.length),
      issueSection: recount(repo.issueSection, issues.length),
    };
  });
}

/** A ready count restated for the filtered list; anything else is unchanged. */
function recount(
  status: SourceSectionStatus,
  count: number,
): SourceSectionStatus {
  return status.kind === "ready" ? { kind: "ready", count } : status;
}

/**
 * A section header: the source's name, then what it has to say.
 *
 * The count sits against the label with no `·` between them. In this TUI that
 * dot divides PEERS (`9 untracked · 1 waiting`); gluing a count to its own
 * label makes one fact read as two.
 *
 * A failure states its CAUSE here rather than in one line below the list,
 * because "which repo, and which source" is the question a single shared line
 * cannot answer. `oneLine` because that cause is `gh` stderr, which arrives
 * with newlines that are zero columns wide and would take the rest of the row
 * with them.
 */
export function sectionText(
  label: string,
  status: SourceSectionStatus,
  spinner: string,
): string {
  switch (status.kind) {
    case "pending":
      return `${label} ${spinner} checking GitHub`.replace(/\s+/g, " ");
    case "ready":
      return `${label} ${status.count}`;
    case "unavailable":
      return status.reason
        ? `${label} unavailable: ${oneLine(status.reason)}`
        : `${label} unavailable`;
    default:
      return unhandled(status, label);
  }
}

/** Every row the picker can put a cursor on, in the order it draws them. */
export function pickerRows(repos: SourceRepo[]): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const repo of repos) {
    rows.push(...repo.prs, ...repo.issues);
  }
  return rows;
}

/** Whether any repo has a row; the gate on drawing a list at all. */
export function hasRows(repos: SourceRepo[]): boolean {
  return repos.some((repo) => repo.prs.length > 0 || repo.issues.length > 0);
}

/**
 * What to say instead of a list, when there is no row anywhere.
 *
 * A real empty STATE rather than a scrollbox holding nothing but headers, and
 * that is a correctness rule as much as a presentation one: a list of lines
 * with no rows has nothing for the cursor to move to, so everything below the
 * first screenful would be unreachable from the keyboard. The panel already
 * paid for that bug once.
 *
 * The order is deliberate. A filter that matched nothing is the user's own
 * doing and is the most likely reason, so it is answered first, before any
 * report about GitHub — the query is what they would change.
 */
export function emptyStateText(
  repos: SourceRepo[],
  query: string,
): { text: string; fg: string } {
  if (query.trim()) {
    return { text: `Nothing matches "${query.trim()}"`, fg: theme.subtext };
  }
  const sections = repos.flatMap((repo) => [repo.prSection, repo.issueSection]);
  if (sections.length === 0) {
    return { text: "No repository here", fg: theme.subtext };
  }
  if (sections.some((status) => status.kind === "pending")) {
    return { text: "Checking GitHub...", fg: theme.subtext };
  }
  const failed = sections.find((status) => status.kind === "unavailable");
  if (failed && failed.kind === "unavailable") {
    return {
      text: failed.reason
        ? `Unavailable: ${oneLine(failed.reason)}`
        : "Unavailable",
      fg: theme.red,
    };
  }
  return { text: "Nothing open here", fg: theme.subtext };
}
