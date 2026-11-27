import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, spyOn } from "bun:test";
import { associatedBranchPRs, type OpenPR } from "../../daemon/pr-list";
import { runGit } from "../../daemon/worktree-git";
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
  it("keeps the daemon's association when branch facts are missing or empty", () => {
    const session = {
      mainRepoRoot: "/repo",
      worktreeRoot: "/repo/wt",
      gitBranch: "feature",
      branchPRs: [pr],
    };
    const facts = (value: BranchPR[], stale = false) => [
      {
        repoRoot: "/repo",
        repoName: "repo",
        branchPRs: { feature: { value, updatedAt: 1, stale } },
      },
    ];
    expect(branchPRs(session, [])).toEqual([pr]);
    expect(branchPRs(session, facts([]))).toEqual([pr]);
    expect(branchPRs(session, facts([], true))).toEqual([pr]);
    // A cached answer that names a PR is proven, so it wins.
    const proven = { ...pr, id: "9" };
    expect(branchPRs(session, facts([proven]))).toEqual([
      { ...proven, stale: false },
    ]);
    // With no daemon answer, an empty entry is still no badge.
    expect(branchPRs({ ...session, branchPRs: undefined }, facts([]))).toEqual(
      [],
    );
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

it("keeps the applied value when a poll answers with identical facts", async () => {
  const body = {
    repos: [{ repoRoot: "/repo", repoName: "repo" }],
    headerPR: true,
  };
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json(body)) as unknown as typeof fetch);
  let dispose = () => {};
  const cache = createRoot((d) => {
    dispose = d;
    return createRepoFacts({
      connected: () => false,
      sources: () => false,
      cwd: () => "/repo",
    });
  });
  try {
    await cache.refresh();
    const first = cache.data();
    await cache.refresh();
    expect(cache.data()).toBe(first);
  } finally {
    dispose();
    fetchSpy.mockRestore();
  }
});

it("stops polling while hidden and catches up when shown", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json({ repos: [], headerPR: true })) as unknown as typeof fetch);
  const [visible, setVisible] = createSignal(false);
  let dispose = () => {};
  createRoot((d) => {
    dispose = d;
    return createRepoFacts({
      connected: () => true,
      sources: () => false,
      cwd: () => "/repo",
      visible,
    });
  });
  try {
    await new Promise((done) => setTimeout(done, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    setVisible(true);
    await new Promise((done) => setTimeout(done, 0));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
    fetchSpy.mockRestore();
  }
});

it("keeps the badge on a branch pushed without -u that has one local commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccmux-pushed-no-upstream-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runGit(cwd, ["-c", "commit.gpgsign=false", ...args]);
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  };
  try {
    await git(root, "init", "--bare", "-b", "main", remote);
    await git(root, "init", "-b", "main", work);
    await git(work, "config", "user.name", "Test");
    await git(work, "config", "user.email", "test@example.com");
    await git(work, "commit", "--allow-empty", "-m", "init");
    await git(work, "remote", "add", "origin", remote);
    await git(work, "switch", "-c", "feature");
    await git(work, "commit", "--allow-empty", "-m", "PR head");
    const pushed = await git(work, "rev-parse", "HEAD");
    // No `-u`: the push leaves branch.feature.{remote,merge} unset.
    await git(work, "push", "origin", "feature");
    await git(work, "commit", "--allow-empty", "-m", "Local work");
    expect(
      (await runGit(work, ["config", "--get", "branch.feature.remote"]))
        .exitCode,
    ).toBe(1);

    const open: OpenPR = {
      number: 7,
      title: "feature",
      url: "https://github.com/owner/project/pull/7",
      author: "owner",
      isDraft: false,
      reviewDecision: null,
      ciStatus: "passing",
      headRefName: "feature",
      headRefOid: pushed,
      headRepository: { owner: "owner", name: "project" },
    };
    // The cause: neither the tip nor a tracking config proves the PR, so the
    // repo-facts cache stores an empty SUCCESS for the branch.
    const associated = await associatedBranchPRs(work, "feature", [open]);
    expect(associated).toEqual({ ok: true, value: [] });

    // The daemon's per-session lookup (`gh pr list --head feature`) still
    // found it by name, and that answer must survive the empty entry.
    const daemon: BranchPR = {
      id: "7",
      href: open.url,
      ciStatus: "passing",
      reviewDecision: null,
    };
    expect(
      branchPRs(
        {
          mainRepoRoot: work,
          worktreeRoot: work,
          gitBranch: "feature",
          branchPRs: [daemon],
        },
        [
          {
            repoRoot: work,
            repoName: "work",
            branchPRs: {
              feature: {
                // Converted the way RepoFactsCache stores it.
                value: (associated.ok ? associated.value : []).map((pr) => ({
                  id: String(pr.number),
                  href: pr.url,
                  ciStatus: pr.ciStatus,
                  reviewDecision: pr.reviewDecision,
                })),
                updatedAt: 1,
                stale: false,
              },
            },
          },
        ],
      ),
    ).toEqual([daemon]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
