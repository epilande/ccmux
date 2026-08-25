/**
 * How an open pull request is drawn, and how it is proved to be checked out
 * already.
 *
 * Extracted from `WorktreesPanel.tsx` (issue #151, PR 2) so the source picker
 * renders a PR the way the panel's PR view renders one, rather than the way a
 * second author would have guessed. Nothing here is new: the panel is still
 * the only caller until the picker lands, and every rule below was settled by
 * live testing on the panel.
 *
 * The split from the panel is by SUBJECT, not by convenience: a function here
 * takes an {@link OpenPR} and knows nothing about panel rows, selection,
 * scopes or views. That is what lets a surface with entirely different rows
 * reuse it, and what keeps this module from growing back into the panel.
 */

import type { OpenPR } from "../../daemon/pr-list";
import type { WorktreeRow } from "../../daemon/worktree-list";
import { theme } from "../theme";
import { unhandled, type Phrase } from "./row-segments";

/**
 * The PR rows' marker, in the same one-column slot the other markers use.
 *
 * A glyph of its own rather than a reused one: the slot is read as a legend
 * down the left edge, and a PR row is not any of the four things already
 * spelled there.
 */
export const PR_MARKER = "⊙";

/**
 * The cursor/layout key for a PR row.
 *
 * Synthetic, and it cannot collide with a worktree's: every worktree key is
 * an absolute path, so it starts with `/`.
 */
export function prRowKey(repoRoot: string, number: number): string {
  return `pr:${repoRoot}#${number}`;
}

/**
 * Whether `key` names a PR row rather than a worktree.
 *
 * Cheap and total: a worktree's key is an absolute path, so the prefix can
 * never be ambiguous. Used where a key has to be classified WITHOUT the row
 * in hand, which is precisely the case that matters — a cursor pointing at a
 * row the PR fetch has not delivered yet.
 */
export function isPRRowKey(key: string): boolean {
  return key.startsWith("pr:");
}

/**
 * The local worktree holding `pr`'s head commit, or null.
 *
 * Identity is the SHA and nothing else. `headRefOid` equal to a branch tip is
 * what defeats name reuse and the fork noise `gh pr list --head` returns; a
 * match on the branch NAME would mark a PR as checked out because someone
 * else's fork happens to use the same word. Where either side does not
 * resolve — an old daemon that sends no `tip`, a detached worktree, a gh that
 * withheld `headRefOid` — the row stays UNMARKED, which costs a convenience
 * where a wrong mark would send Enter into the wrong directory.
 *
 * Among several worktrees at the same commit (a checkout just cut from this
 * branch shares its tip) the one whose branch is also the PR's head wins.
 * That is a tie-break between rows the SHA has already proven, never a way in
 * for a name to prove anything by itself.
 */
export function checkoutHolding(
  pr: OpenPR,
  worktrees: WorktreeRow[],
): WorktreeRow | null {
  if (!pr.headRefOid) return null;
  const matches = worktrees.filter((row) => row.tip === pr.headRefOid);
  return (
    matches.find((row) => row.branch === pr.headRefName) ?? matches[0] ?? null
  );
}

/**
 * What a PR's review state says, in the words GitHub uses for it.
 *
 * `REVIEW_REQUIRED` is deliberately silent: it is the DEFAULT state of every
 * PR on a protected branch, so a phrase for it would appear on nearly every
 * row and say nothing about that row in particular.
 */
export function describeReview(pr: OpenPR): Phrase | null {
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { text: "approved", fg: theme.green };
    case "CHANGES_REQUESTED":
      return { text: "changes requested", fg: theme.peach };
    case "REVIEW_REQUIRED":
      return null;
    // `BranchPR` types this nullable AND optional, so both spellings of
    // "GitHub said nothing" are cases here rather than a default.
    case null:
    case undefined:
      return null;
    default:
      return unhandled(pr.reviewDecision, null);
  }
}

/**
 * What a PR's checks say.
 *
 * `none` is silent rather than green: an un-CI'd PR has nothing to report,
 * and `foldChecks` keeps it out of `passing` for exactly that reason.
 */
export function describeChecks(pr: OpenPR): Phrase | null {
  switch (pr.ciStatus) {
    case "passing":
      return { text: "checks pass", fg: theme.green };
    case "failing":
      return { text: "checks fail", fg: theme.red };
    case "pending":
      return { text: "checks running", fg: theme.yellow };
    case "none":
      return null;
    default:
      return unhandled(pr.ciStatus, null);
  }
}

/**
 * A PR row's detail line: its head branch, who opened it, and only the states
 * that are news.
 *
 * The branch leads because it is what a checkout would be named after, and it
 * is the fact that connects the row to the worktrees above it. Draft, review
 * and checks each stay silent in their unremarkable state, by the same rule
 * the worktree rows follow: a phrase that appears on every row is noise that
 * pushes the ones that differ off a narrow panel.
 *
 * `checked out` comes LAST and is the loudest thing on the line, because it
 * changes what Enter does.
 */
/**
 * It takes the PR and the NAME of the checkout holding it rather than a row,
 * because the two surfaces that draw this line disagree about everything else
 * on one: the panel resolved the checkout while building its rows, and a
 * picker resolves it against its own worktree read.
 */
export function prDetailPhrases(
  pr: OpenPR,
  opts: { checkedOutName: string | null; compact?: boolean },
): Phrase[] {
  const phrases: Phrase[] = [];
  if (pr.headRefName) {
    phrases.push({ text: pr.headRefName, fg: theme.overlay });
  }
  // The author is the first thing to go on a narrow surface: on a repo you
  // work in, most PRs are yours, and the branch is the useful half.
  if (pr.author && opts.compact !== true) {
    phrases.push({ text: `@${pr.author}`, fg: theme.overlay });
  }
  if (pr.isDraft) phrases.push({ text: "draft", fg: theme.subtext });
  const review = describeReview(pr);
  if (review) phrases.push(review);
  const checks = describeChecks(pr);
  if (checks) phrases.push(checks);
  if (opts.checkedOutName) {
    phrases.push({
      text: `checked out in ${opts.checkedOutName}`,
      fg: theme.green,
    });
  }
  return phrases;
}

/**
 * A PR's label: `#151 Worktrees panel: open-PR list`.
 *
 * The number and the title are ONE label, on the bright line. Splitting them
 * across two columns would put the only thing that identifies the PR to a
 * human on the dim one.
 */
export function prRowLabel(pr: OpenPR): string {
  return `#${pr.number} ${pr.title}`;
}

/**
 * Whether a PR's label is drawn dimmer than the rest of its list.
 *
 * A draft is on GitHub but is not asking for anything yet, and a list of open
 * PRs exists to point at what is. Callers apply their own cursor colour on
 * top of this, so it answers about the PR alone.
 */
export function prRowDim(pr: OpenPR): boolean {
  return pr.isDraft;
}
