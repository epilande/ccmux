import { describe, expect, it } from "bun:test";
import { badgeColor, badgeText, branchPRs } from "./repo-facts";
import { theme } from "../theme";
import type { BranchPR } from "../../types/session";

const pr: BranchPR = {
  id: "1",
  href: "https://github.com/o/r/pull/1",
  ciStatus: "passing",
};
describe("repo fact presentation", () => {
  it("preserves existing associations until an authoritative branch result arrives", () => {
    const session = {
      mainRepoRoot: "/repo",
      worktreeRoot: "/repo/wt",
      gitBranch: "feature",
      branchPRs: [pr],
    };
    expect(branchPRs(session, [])).toEqual([pr]);
    expect(
      branchPRs(session, [
        {
          repoRoot: "/repo",
          repoName: "repo",
          branchPRs: { feature: { value: [], updatedAt: 1, stale: false } },
        },
      ]),
    ).toEqual([]);
  });
  it("retains multiple PRs and marks only previously successful facts stale", () => {
    const session = {
      mainRepoRoot: "/repo",
      worktreeRoot: "/repo/wt",
      gitBranch: "feature",
    };
    const prs = branchPRs(session, [
      {
        repoRoot: "/repo",
        repoName: "repo",
        branchPRs: {
          feature: {
            value: [pr, { ...pr, id: "2" }],
            updatedAt: 1,
            stale: true,
          },
        },
      },
    ]);
    expect(prs.map((p) => p.id)).toEqual(["1", "2"]);
    expect(prs.every((p) => p.stale)).toBe(true);
    expect(badgeText(prs[0]!)).toBe("PR #1 ✓ ~");
    expect(badgeText(null, true)).toBe("");
  });
  it("lets failing checks and requested changes dominate passing checks", () => {
    expect(badgeColor([pr, { ...pr, ciStatus: "failing" }])).toBe(theme.red);
    expect(badgeColor([{ ...pr, reviewDecision: "CHANGES_REQUESTED" }])).toBe(
      theme.red,
    );
    expect(badgeText({ ...pr, reviewDecision: "CHANGES_REQUESTED" })).toContain(
      "changes",
    );
  });
});

for (const name of ["constructor", "toString", "__proto__"]) {
  it(`ignores inherited branch properties for ${name}, but accepts a real cached answer`, () => {
    const session = {
      mainRepoRoot: "/repo",
      worktreeRoot: "/repo",
      gitBranch: name,
    };
    const repo = { repoRoot: "/repo", repoName: "repo", branchPRs: {} };
    expect(branchPRs(session, [repo])).toEqual([]);
    repo.branchPRs = JSON.parse(
      JSON.stringify({
        [name]: {
          value: [{ id: "7", href: "https://github.com/o/r/pull/7" }],
          stale: false,
          updatedAt: 1,
        },
      }),
    );
    expect(branchPRs(session, [repo]).map((pr) => pr.id)).toEqual(["7"]);
  });
}
