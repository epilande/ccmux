import { expect, it } from "bun:test";
import type { OpenPR } from "../../daemon/pr-list";
import type { WorktreeRow } from "../../daemon/worktree-list";
import {
  checkoutHolding,
  describeChecks,
  describeReview,
  isPRRowKey,
  prRowKey,
} from "./pr-rows";
const pr: OpenPR = {
  number: 7,
  title: "fix",
  url: "https://github.com/o/r/pull/7",
  author: "owner",
  headRefName: "feature",
  headRefOid: "sha7",
  isDraft: false,
  ciStatus: "none",
  reviewDecision: null,
};
const row: WorktreeRow = {
  path: "/repo/feature",
  repoRoot: "/repo",
  repoName: "repo",
  name: "feature",
  branch: "feature",
  tip: "sha7",
  detached: false,
  isMain: false,
  locked: false,
  dirty: { dirty: false, modified: 0, untracked: 0 },
  upstream: null,
  sessions: [],
};
it("separates source keys by repo and from checkout paths", () => {
  expect(prRowKey("/a", 7)).not.toBe(prRowKey("/b", 7));
  expect(isPRRowKey(prRowKey("/a", 7))).toBe(true);
  expect(isPRRowKey("/repo/pr:7")).toBe(false);
});
it("requires a nonempty SHA match and uses branch name only to break proven ties", () => {
  expect(checkoutHolding(pr, [{ ...row, tip: "local-ahead" }])).toBeNull();
  expect(checkoutHolding(pr, [{ ...row, tip: undefined }])).toBeNull();
  expect(
    checkoutHolding({ ...pr, headRefOid: "" }, [{ ...row, tip: "" }]),
  ).toBeNull();
  expect(
    checkoutHolding(pr, [
      { ...row, path: "/repo/other", branch: "other" },
      row,
    ]),
  ).toBe(row);
});
it("keeps absent checks and routine review requirements silent", () => {
  expect(describeChecks(pr)).toBeNull();
  expect(describeReview(pr)).toBeNull();
  expect(
    describeReview({ ...pr, reviewDecision: "REVIEW_REQUIRED" }),
  ).toBeNull();
  expect(
    describeReview({ ...pr, reviewDecision: "CHANGES_REQUESTED" })?.text,
  ).toContain("changes");
  expect(describeChecks({ ...pr, ciStatus: "failing" })?.text).toContain(
    "fail",
  );
});
