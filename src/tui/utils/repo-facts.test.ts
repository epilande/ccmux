import { createRoot } from "solid-js";
import { describe, expect, it, spyOn } from "bun:test";
import {
  badgeColor,
  badgeText,
  branchPRs,
  createRepoFacts,
} from "./repo-facts";
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

it("does not manufacture associations from a namesake PR in the repository list", () => {
  const source = {
    number: 2,
    title: "namesake",
    url: "https://github.com/o/r/pull/2",
    author: null,
    isDraft: false,
    reviewDecision: null,
    ciStatus: "none" as const,
    headRefName: "feature",
    headRefOid: "different",
  };
  expect(
    branchPRs(
      {
        mainRepoRoot: "/repo",
        worktreeRoot: "/repo",
        gitBranch: "feature",
        branchPRs: [pr],
      },
      [
        {
          repoRoot: "/repo",
          repoName: "repo",
          prs: { value: [source], updatedAt: 1, stale: false },
        },
      ],
    ),
  ).toEqual([pr]);
});

it("never lets an older poll overwrite a newer applied refresh and ignores disposed requests", async () => {
  const pending: ((response: Response) => void)[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (() =>
      new Promise<Response>((resolve) =>
        pending.push(resolve),
      )) as unknown as typeof fetch,
  );
  let dispose = () => {};
  const cache = createRoot((d) => {
    dispose = d;
    return createRepoFacts({
      connected: () => false,
      sources: () => false,
      cwd: () => "/repo",
    });
  });
  const answer = (name: string) =>
    Response.json({
      repos: [{ repoRoot: `/${name}`, repoName: name }],
      headerPR: true,
    });
  try {
    const older = cache.refresh();
    const newer = cache.refresh(true);
    pending[1]!(answer("new"));
    await newer;
    pending[0]!(answer("old"));
    await older;
    expect(cache.data().repos[0]?.repoName).toBe("new");
    const late = cache.refresh();
    dispose();
    pending[2]!(answer("disposed"));
    await late;
    expect(cache.data().repos[0]?.repoName).toBe("new");
  } finally {
    dispose();
    fetchSpy.mockRestore();
  }
});
