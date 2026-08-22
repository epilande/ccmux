import { describe, it, expect } from "bun:test";
import {
  branchCheckedOutAt,
  configurePRBranch,
  lookupIssue,
  lookupPR,
  parseRepoSlug,
  preparePRBranch,
  prRepoMismatch,
  sameRepo,
  seedPrompt,
  type GhRun,
  type GhRunResult,
  type PRSource,
} from "./gh-spawn-source";
import type { GitResult, GitRun } from "./worktree-git";

/** A runner that answers every call with one canned result. */
function ghAnswering(result: Partial<GhRunResult>): GhRun {
  return async () => ({ exitCode: 0, stdout: "", stderr: "", ...result });
}

const OPEN_PR = {
  number: 7,
  title: "Fix the flaky binder test",
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  headRefName: "fix/flaky-binder",
  baseRefName: "main",
  isCrossRepository: false,
};

describe("lookupPR", () => {
  it("reads the fields a spawn needs off a same-repo PR", async () => {
    const calls: string[][] = [];
    const run: GhRun = async (_cwd, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: JSON.stringify(OPEN_PR), stderr: "" };
    };
    const found = await lookupPR("/repo", 7, run);

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.headRefName).toBe("fix/flaky-binder");
    expect(found.value.baseRefName).toBe("main");
    expect(found.value.isCrossRepository).toBe(false);
    // No fork means no override remote: the branch tracks `origin`.
    expect(found.value.headRemoteUrl).toBeUndefined();
    expect(calls[0]?.slice(0, 3)).toEqual(["pr", "view", "7"]);
    expect(calls[0]?.join(" ")).toContain("isCrossRepository");
  });

  // A fork's branch has to push back to the FORK, not to origin, so the
  // clone URL is composed from the two repository fields.
  it("composes the fork clone URL for a cross-repository PR", async () => {
    const run = ghAnswering({
      stdout: JSON.stringify({
        ...OPEN_PR,
        isCrossRepository: true,
        headRepository: { name: "ccmux" },
        headRepositoryOwner: { login: "LiadOz" },
      }),
    });
    const found = await lookupPR("/repo", 7, run);

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.headRemoteUrl).toBe(
      "https://github.com/LiadOz/ccmux.git",
    );
  });

  it("refuses a fork PR whose repository gh did not name", async () => {
    const run = ghAnswering({
      stdout: JSON.stringify({ ...OPEN_PR, isCrossRepository: true }),
    });
    const found = await lookupPR("/repo", 7, run);

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("fork");
    expect(found.error).toContain("gh pr checkout 7");
  });

  // The state travels in the message: "not open" alone leaves the user
  // guessing whether they typed the wrong number or the PR landed.
  it("refuses a PR that is not open, naming its state", async () => {
    for (const state of ["MERGED", "CLOSED"]) {
      const run = ghAnswering({
        stdout: JSON.stringify({ ...OPEN_PR, state }),
      });
      const found = await lookupPR("/repo", 7, run);
      expect(found.ok).toBe(false);
      if (found.ok) return;
      expect(found.error).toContain(state);
      expect(found.error).toContain("#7");
    }
  });

  // Both names reach git as positional arguments, where a leading '-' is
  // parsed as an option. GitHub permits such a ref, so a fork author can
  // pick one.
  it("refuses a head or base ref that starts with a dash", async () => {
    const head = await lookupPR(
      "/repo",
      7,
      ghAnswering({
        stdout: JSON.stringify({ ...OPEN_PR, headRefName: "--upload-pack=x" }),
      }),
    );
    expect(head.ok).toBe(false);
    if (!head.ok) {
      expect(head.error).toContain("starts with '-'");
      expect(head.error).toContain("head ref");
    }

    const base = await lookupPR(
      "/repo",
      7,
      ghAnswering({
        stdout: JSON.stringify({ ...OPEN_PR, baseRefName: "-x" }),
      }),
    );
    expect(base.ok).toBe(false);
    if (!base.ok) expect(base.error).toContain("base ref");
  });

  it("reports a non-zero exit with gh's own stderr", async () => {
    const run = ghAnswering({
      exitCode: 1,
      stderr: "no pull requests found for #7",
    });
    const found = await lookupPR("/repo", 7, run);

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("exited 1");
    expect(found.error).toContain("no pull requests found");
  });

  it("reports unparseable output as a JSON problem", async () => {
    const found = await lookupPR("/repo", 7, ghAnswering({ stdout: "<html>" }));
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("did not return valid JSON");
  });

  it("reports a valid JSON body of the wrong shape", async () => {
    const found = await lookupPR("/repo", 7, ghAnswering({ stdout: "[]" }));
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("expected an object");
  });

  // ENOENT throws out of `Bun.spawn` rather than producing an exit code, so
  // the runner reports it separately and the message says how to fix it.
  it("reports a missing gh binary with install guidance", async () => {
    const run = ghAnswering({
      exitCode: 127,
      spawnError: "No such file or directory",
    });
    const found = await lookupPR("/repo", 7, run);

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("gh could not be run");
    expect(found.error).toContain("cli.github.com");
  });

  // A hung gh must not hang the spawn the user is watching, and its exit
  // code after a SIGKILL says nothing worth reporting.
  it("reports a timeout as a timeout, not as an exit code", async () => {
    const run = ghAnswering({ exitCode: 137, timedOut: true });
    const found = await lookupPR("/repo", 7, run);

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("timed out");
    expect(found.error).not.toContain("exited");
  });
});

describe("lookupIssue", () => {
  const OPEN_ISSUE = {
    number: 45,
    title: "spawn: --pr and --issue flags",
    url: "https://github.com/o/r/issues/45",
    state: "OPEN",
  };

  it("reads number, title, url and state", async () => {
    const calls: string[][] = [];
    const run: GhRun = async (_cwd, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: JSON.stringify(OPEN_ISSUE), stderr: "" };
    };
    const found = await lookupIssue("/repo", 45, run);

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.title).toBe("spawn: --pr and --issue flags");
    expect(found.value.url).toBe("https://github.com/o/r/issues/45");
    expect(calls[0]?.slice(0, 3)).toEqual(["issue", "view", "45"]);
  });

  it("refuses a closed issue", async () => {
    const run = ghAnswering({
      stdout: JSON.stringify({ ...OPEN_ISSUE, state: "CLOSED" }),
    });
    const found = await lookupIssue("/repo", 45, run);

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("closed");
    expect(found.error).toContain("#45");
  });

  it("reports gh failures the same way the PR lookup does", async () => {
    const exited = await lookupIssue(
      "/repo",
      45,
      ghAnswering({ exitCode: 1, stderr: "not found" }),
    );
    expect(exited.ok).toBe(false);
    if (!exited.ok) expect(exited.error).toContain("exited 1");

    const garbage = await lookupIssue(
      "/repo",
      45,
      ghAnswering({ stdout: "nope" }),
    );
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.error).toContain("valid JSON");
  });
});

/** A `GitRun` answering from a table of `args.join(" ")` prefixes. */
function gitAnswering(
  table: Array<[string, Partial<GitResult>]>,
  calls: string[][] = [],
): GitRun {
  return async (_cwd, args) => {
    calls.push(args);
    const joined = args.join(" ");
    for (const [prefix, result] of table) {
      if (joined.startsWith(prefix)) {
        return { exitCode: 0, stdout: "", stderr: "", ...result };
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

describe("parseRepoSlug / sameRepo", () => {
  // Every spelling `git remote get-url` can answer with has to reduce to the
  // same slug as the PR's own URL, or the identity check below is noise.
  it("reduces every clone-URL spelling to one slug", () => {
    const canonical = { host: "github.com", owner: "junegunn", repo: "fzf" };
    for (const url of [
      "https://github.com/junegunn/fzf",
      "https://github.com/junegunn/fzf.git",
      "https://user@github.com/junegunn/fzf.git",
      "git@github.com:junegunn/fzf.git",
      "git@github.com:junegunn/fzf",
      "ssh://git@github.com/junegunn/fzf.git",
      // The PR URL itself: only the first two path segments count.
      "https://github.com/junegunn/fzf/pull/4733",
      // GitHub is case-insensitive about owner and repo.
      "https://github.com/JuneGunn/FZF.git",
    ]) {
      expect(parseRepoSlug(url)).toEqual(canonical);
    }
  });

  it("answers null for anything it cannot prove is a repo URL", () => {
    for (const url of ["", "   ", "/local/path/repo", "file:///tmp/repo.git"]) {
      expect(parseRepoSlug(url)).toBeNull();
    }
  });

  it("distinguishes owner, repo and host", () => {
    const base = parseRepoSlug("https://github.com/junegunn/fzf.git");
    expect(sameRepo(base, parseRepoSlug("git@github.com:junegunn/fzf"))).toBe(
      true,
    );
    expect(sameRepo(base, parseRepoSlug("https://github.com/maooc/fzf"))).toBe(
      false,
    );
    expect(sameRepo(base, parseRepoSlug("https://github.com/junegunn/x"))).toBe(
      false,
    );
    expect(sameRepo(base, parseRepoSlug("https://ghe.corp/junegunn/fzf"))).toBe(
      false,
    );
    // Null on either side is never a match: absence is not evidence.
    expect(sameRepo(base, null)).toBe(false);
  });
});

describe("prRepoMismatch", () => {
  // gh resolves a PR number through its OWN repo selection (set-default,
  // GH_REPO, a triangular clone's upstream) while the fetch is hardcoded to
  // `origin`. In a fork clone that also has a PR #7, the spawn would check
  // out the fork's PR under the base repo's title.
  it("refuses when origin is a different repo than the PR's", async () => {
    const git = gitAnswering([
      ["remote get-url origin", { stdout: "git@github.com:me/fzf.git\n" }],
    ]);
    const problem = await prRepoMismatch(
      "/repo",
      { ...OPEN_PR, url: "https://github.com/junegunn/fzf/pull/7" },
      git,
    );

    expect(problem).not.toBeNull();
    // Both sides named, so the user can see which one is wrong.
    expect(problem).toContain("junegunn/fzf");
    expect(problem).toContain("me/fzf");
  });

  it("passes when origin is the PR's own repo, however it is spelled", async () => {
    for (const url of [
      "https://github.com/junegunn/fzf.git",
      "git@github.com:junegunn/fzf",
      "ssh://git@github.com/JuneGunn/fzf.git",
    ]) {
      const git = gitAnswering([["remote get-url origin", { stdout: url }]]);
      expect(
        await prRepoMismatch(
          "/repo",
          { ...OPEN_PR, url: "https://github.com/junegunn/fzf/pull/7" },
          git,
        ),
      ).toBeNull();
    }
  });

  // Only a PROVEN mismatch refuses. Inventing one for an origin this cannot
  // parse would break clones that work today (and every local-path fixture).
  it("stays silent when either side cannot be parsed", async () => {
    const localOrigin = gitAnswering([
      ["remote get-url origin", { stdout: "/tmp/fixture/origin.git\n" }],
    ]);
    expect(
      await prRepoMismatch(
        "/repo",
        { ...OPEN_PR, url: "https://github.com/o/r/pull/7" },
        localOrigin,
      ),
    ).toBeNull();

    const noOrigin = gitAnswering([
      ["remote get-url origin", { exitCode: 2, stderr: "no such remote" }],
    ]);
    expect(
      await prRepoMismatch(
        "/repo",
        { ...OPEN_PR, url: "https://github.com/o/r/pull/7" },
        noOrigin,
      ),
    ).toBeNull();
  });
});

describe("branchCheckedOutAt", () => {
  const listing = [
    "worktree /repo",
    "HEAD aaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.claude/worktrees/other",
    "HEAD bbb",
    "branch refs/heads/fix/flaky-binder",
    "",
  ].join("\n");

  it("names the worktree already sitting on the branch", async () => {
    const git = gitAnswering([["worktree list", { stdout: listing }]]);
    expect(await branchCheckedOutAt("/repo", "fix/flaky-binder", git)).toBe(
      "/repo/.claude/worktrees/other",
    );
  });

  it("answers null when nothing holds it", async () => {
    const git = gitAnswering([["worktree list", { stdout: listing }]]);
    expect(await branchCheckedOutAt("/repo", "feat/other", git)).toBeNull();
  });
});

describe("preparePRBranch", () => {
  const pr: PRSource = { ...OPEN_PR };

  it("fetches the head, resolves it to a sha, and reports the remote base", async () => {
    const calls: string[][] = [];
    const git = gitAnswering(
      [
        ["rev-parse FETCH_HEAD", { stdout: "cafe1234\n" }],
        // No local branch of that name.
        ["rev-parse --verify --quiet refs/heads/", { exitCode: 1 }],
        ["rev-parse --verify --quiet origin/main", { stdout: "beef\n" }],
      ],
      calls,
    );
    const prepared = await preparePRBranch("/repo", pr, git);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.head).toBe("cafe1234");
    expect(prepared.value.branchExisted).toBe(false);
    expect(prepared.value.baseRemoteRef).toBe("origin/main");

    const joined = calls.map((c) => c.join(" "));
    // The head fetch comes first and FETCH_HEAD is read IMMEDIATELY: the
    // base fetch below it overwrites that ref.
    expect(joined[0]).toBe("fetch origin pull/7/head");
    expect(joined[1]).toBe("rev-parse FETCH_HEAD");
    expect(joined).toContain("fetch origin main");
  });

  it("refuses when the PR head cannot be fetched", async () => {
    const git = gitAnswering([
      ["fetch origin pull/7/head", { exitCode: 128, stderr: "couldn't find" }],
    ]);
    const prepared = await preparePRBranch("/repo", pr, git);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error).toContain("Could not fetch PR #7");
    expect(prepared.error).toContain("couldn't find");
  });

  // The upstream config is the only evidence a same-named branch is THIS PR.
  // THE FORK HIJACK. `git checkout -b foo origin/foo` writes exactly the
  // merge key the reuse gate used to accept, so a fork PR whose author names
  // their head after an ordinary origin-tracking branch would have been
  // fast-forwarded onto the fork's commits and then had its remote rewritten
  // to the fork. The remote half of the gate is what refuses it.
  it("refuses a fork PR whose head name collides with an origin-tracking branch", async () => {
    const calls: string[][] = [];
    const forkPR: PRSource = {
      ...OPEN_PR,
      isCrossRepository: true,
      headRemoteUrl: "https://github.com/attacker/ccmux.git",
    };
    const git = gitAnswering(
      [
        ["rev-parse FETCH_HEAD", { stdout: "cafe\n" }],
        ["rev-parse --verify --quiet refs/heads/", { stdout: "dead\n" }],
        // Exactly what an ordinary `checkout -b foo origin/foo` leaves.
        [
          "config --get branch.fix/flaky-binder.merge",
          { stdout: "refs/heads/fix/flaky-binder\n" },
        ],
        ["config --get branch.fix/flaky-binder.remote", { stdout: "origin\n" }],
      ],
      calls,
    );
    const prepared = await preparePRBranch("/repo", forkPR, git);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error).toContain("is not set up to track PR #7");
    expect(prepared.error).toContain("https://github.com/attacker/ccmux.git");
    // And nothing touched the ref: no branch-updating fetch was even issued.
    expect(calls.map((c) => c.join(" ")).join("\n")).not.toContain(
      "refs/pull/7/head:fix/flaky-binder",
    );
  });

  // The mirror image: a branch that really is this fork PR's is still reused.
  it("reuses a branch whose remote is the fork's own URL", async () => {
    const forkPR: PRSource = {
      ...OPEN_PR,
      isCrossRepository: true,
      headRemoteUrl: "https://github.com/LiadOz/ccmux.git",
    };
    const git = gitAnswering([
      ["rev-parse FETCH_HEAD", { stdout: "cafe\n" }],
      ["rev-parse --verify --quiet refs/heads/", { stdout: "dead\n" }],
      [
        "config --get branch.fix/flaky-binder.merge",
        { stdout: "refs/heads/fix/flaky-binder\n" },
      ],
      [
        "config --get branch.fix/flaky-binder.remote",
        // ssh spelling of the same repo: the same repository, so reuse.
        { stdout: "git@github.com:LiadOz/ccmux.git\n" },
      ],
    ]);
    const prepared = await preparePRBranch("/repo", forkPR, git);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.branchExisted).toBe(true);
  });

  it("refuses an unrelated local branch of the same name", async () => {
    const git = gitAnswering([
      ["rev-parse FETCH_HEAD", { stdout: "cafe\n" }],
      ["rev-parse --verify --quiet refs/heads/", { stdout: "dead\n" }],
      ["config --get branch.fix/flaky-binder.merge", { stdout: "" }],
    ]);
    const prepared = await preparePRBranch("/repo", pr, git);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error).toContain("already exists");
    expect(prepared.error).toContain("gh pr checkout 7");
  });

  it("fast-forwards a branch that already tracks the PR", async () => {
    const calls: string[][] = [];
    const git = gitAnswering(
      [
        ["rev-parse FETCH_HEAD", { stdout: "cafe\n" }],
        ["rev-parse --verify --quiet refs/heads/", { stdout: "dead\n" }],
        [
          "config --get branch.fix/flaky-binder.merge",
          { stdout: "refs/heads/fix/flaky-binder\n" },
        ],
        ["config --get branch.fix/flaky-binder.remote", { stdout: "origin\n" }],
      ],
      calls,
    );
    const prepared = await preparePRBranch("/repo", pr, git);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.branchExisted).toBe(true);
    // No leading '+': the non-forced refspec is what refuses divergence
    // instead of discarding the user's commits.
    expect(calls.map((c) => c.join(" "))).toContain(
      "fetch origin refs/pull/7/head:fix/flaky-binder",
    );
  });

  it("refuses a divergent tracked branch rather than forcing it", async () => {
    const git = gitAnswering([
      ["rev-parse FETCH_HEAD", { stdout: "cafe\n" }],
      ["rev-parse --verify --quiet refs/heads/", { stdout: "dead\n" }],
      [
        "config --get branch.fix/flaky-binder.merge",
        { stdout: "refs/heads/fix/flaky-binder\n" },
      ],
      ["config --get branch.fix/flaky-binder.remote", { stdout: "origin\n" }],
      [
        "fetch origin refs/pull/7/head:",
        { exitCode: 1, stderr: "non-fast-forward" },
      ],
    ]);
    const prepared = await preparePRBranch("/repo", pr, git);

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.error).toContain("diverged");
    expect(prepared.error).toContain("left untouched");
  });

  // Null costs only the `ccmux-base` key, so an unreachable base branch must
  // not fail a spawn that otherwise has everything it needs.
  it("reports a null base ref rather than failing when origin/<base> is missing", async () => {
    const git = gitAnswering([
      ["rev-parse FETCH_HEAD", { stdout: "cafe\n" }],
      ["rev-parse --verify --quiet refs/heads/", { exitCode: 1 }],
      ["rev-parse --verify --quiet origin/main", { exitCode: 1 }],
      ["fetch origin main", { exitCode: 1, stderr: "no such ref" }],
    ]);
    const prepared = await preparePRBranch("/repo", pr, git);

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.baseRemoteRef).toBeNull();
  });
});

describe("configurePRBranch", () => {
  it("tracks origin for a same-repo PR", async () => {
    const calls: string[][] = [];
    await configurePRBranch(
      "/repo",
      "fix/flaky-binder",
      { ...OPEN_PR },
      "origin/main",
      gitAnswering([], calls),
    );
    const joined = calls.map((c) => c.join(" "));

    expect(joined).toContain("config branch.fix/flaky-binder.remote origin");
    expect(joined).toContain(
      "config branch.fix/flaky-binder.merge refs/heads/fix/flaky-binder",
    );
    expect(joined).toContain(
      "config branch.fix/flaky-binder.ccmux-base origin/main",
    );
    // Only a fork needs an explicit push target.
    expect(joined.join("\n")).not.toContain("pushRemote");
  });

  it("points a fork PR's branch at the fork for both fetch and push", async () => {
    const calls: string[][] = [];
    await configurePRBranch(
      "/repo",
      "fix/flaky-binder",
      { ...OPEN_PR, isCrossRepository: true, headRemoteUrl: "https://x/y.git" },
      "origin/main",
      gitAnswering([], calls),
    );
    const joined = calls.map((c) => c.join(" "));

    expect(joined).toContain(
      "config branch.fix/flaky-binder.remote https://x/y.git",
    );
    expect(joined).toContain(
      "config branch.fix/flaky-binder.pushRemote https://x/y.git",
    );
  });

  // These keys are not independent: `remote` landing while `pushRemote`
  // fails leaves a fork's branch fetching from the fork and PUSHING TO
  // ORIGIN, which opens a second PR without ever showing an error.
  it("reports a partial write instead of swallowing it", async () => {
    const calls: string[][] = [];
    const git = gitAnswering(
      [
        [
          "config branch.b.pushRemote",
          { exitCode: 4, stderr: "could not lock config file" },
        ],
      ],
      calls,
    );
    const result = await configurePRBranch(
      "/repo",
      "b",
      { ...OPEN_PR, isCrossRepository: true, headRemoteUrl: "https://x/y.git" },
      "origin/main",
      git,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("branch.b.pushRemote");
    expect(result.error).toContain("could not lock config file");
    // Every remaining key is still attempted: a partial write is what has to
    // be described, and stopping early would leave more of it unset.
    expect(calls.map((c) => c.join(" "))).toContain(
      "config branch.b.merge refs/heads/fix/flaky-binder",
    );
  });

  it("succeeds when every write lands", async () => {
    const result = await configurePRBranch(
      "/repo",
      "b",
      { ...OPEN_PR },
      "origin/main",
      gitAnswering([]),
    );
    expect(result.ok).toBe(true);
  });

  it("writes no ccmux-base when the remote base never resolved", async () => {
    const calls: string[][] = [];
    await configurePRBranch(
      "/repo",
      "b",
      { ...OPEN_PR },
      null,
      gitAnswering([], calls),
    );
    expect(calls.map((c) => c.join(" ")).join("\n")).not.toContain(
      "ccmux-base",
    );
  });
});

describe("seedPrompt", () => {
  it("puts provenance first and the user's own prompt after a blank line", () => {
    expect(seedPrompt("PR #7", "Fix it", "https://x/7", "review this")).toBe(
      "PR #7: Fix it\nhttps://x/7\n\nreview this",
    );
    expect(seedPrompt("Issue #7", "Fix it", "https://x/7", undefined)).toBe(
      "Issue #7: Fix it\nhttps://x/7",
    );
  });

  // The title comes from GitHub, where it can be any length and contain
  // anything, and it travels into a single-quoted shell argument.
  it("strips control characters and caps a long title", () => {
    expect(seedPrompt("PR #1", "a b\tc", "u", undefined)).toBe(
      "PR #1: a b c\nu",
    );
    // C1 as well as C0: U+009B is a one-byte CSI, so a title carrying one
    // would put a live escape sequence into a prompt typed into a terminal.
    expect(seedPrompt("PR #1", "a\u009b31mb\u0085c", "u", undefined)).toBe(
      "PR #1: a 31mb c\nu",
    );
    // U+00A0 is the first codepoint PAST the C1 block, and must survive.
    expect(seedPrompt("PR #1", "a\u00a0b", "u", undefined)).toBe(
      "PR #1: a\u00a0b\nu",
    );
    const long = seedPrompt("PR #1", "x".repeat(500), "u", undefined);
    expect(long.split("\n")[0]?.length).toBeLessThan(220);
    expect(long).toContain("…");
  });

  it("drops the separator when nothing usable is left of the title", () => {
    expect(seedPrompt("PR #1", "   ", "https://x/1", undefined)).toBe(
      "PR #1\nhttps://x/1",
    );
  });
});
