import { describe, expect, it } from "bun:test";
import type { OpenIssue } from "../../daemon/issue-list";
import type { OpenPR } from "../../daemon/pr-list";
import type { WorktreeRow } from "../../daemon/worktree-list";
import {
  ISSUES_SECTION,
  PRS_SECTION,
  buildSourceRepos,
  emptyStateText,
  filterRepos,
  hasRows,
  isIssueRowKey,
  issueRowKey,
  matchesQuery,
  pickerRows,
  rowHaystack,
  sectionText,
  sourceDetailPhrases,
  sourceRowDim,
  sourceRowLabel,
  sourceRowMarker,
  worktreeForIssue,
  type SourceRepo,
} from "./source-picker-rows";
import { isPRRowKey } from "./pr-rows";

const pr = (overrides: Partial<OpenPR> = {}): OpenPR => ({
  number: 156,
  title: "fix(sidebar): park the renderer while hidden",
  url: "https://github.com/o/r/pull/156",
  author: "epilande",
  isDraft: false,
  reviewDecision: null,
  ciStatus: "none",
  headRefName: "feat/sidebar-parking",
  headRefOid: "sha-156",
  ...overrides,
});

const issue = (overrides: Partial<OpenIssue> = {}): OpenIssue => ({
  number: 144,
  title: "Notifications are swallowed inside nested tmux",
  url: "https://github.com/o/r/issues/144",
  author: "epilande",
  labels: ["bug"],
  ...overrides,
});

const worktree = (overrides: Partial<WorktreeRow> = {}): WorktreeRow => ({
  repoName: "repo",
  path: "/repo/wt/a",
  name: "a",
  repoRoot: "/repo",
  branch: "feat/a",
  tip: "sha-a",
  detached: false,
  isMain: false,
  locked: false,
  dirty: { dirty: false, modified: 0, untracked: 0 },
  upstream: null,
  sessions: [],
  ...overrides,
});

/** The three reads folded, with every source having answered. */
function build(
  input: {
    prs?: OpenPR[];
    issues?: OpenIssue[];
    worktrees?: WorktreeRow[];
  } = {},
): SourceRepo[] {
  return buildSourceRepos({
    prs: {
      repos: [{ repoRoot: "/repo", repoName: "repo", prs: input.prs ?? [] }],
      errors: [],
    },
    prError: null,
    issues: {
      repos: [
        { repoRoot: "/repo", repoName: "repo", issues: input.issues ?? [] },
      ],
      errors: [],
    },
    issueError: null,
    worktrees: {
      repos: [
        {
          repoRoot: "/repo",
          repoName: "repo",
          worktrees: input.worktrees ?? [],
        },
      ],
    },
    home: null,
  });
}

describe("row keys", () => {
  it("cannot collide with a worktree's or a PR's", () => {
    const key = issueRowKey("/repo", 144);
    expect(isIssueRowKey(key)).toBe(true);
    // A worktree key is an absolute path, and `pr:` is not a prefix of
    // `issue:` — so the PR classifier does not claim an issue row, which is
    // what keeps the panel's PR-key hold from ever holding one of these.
    expect(key.startsWith("/")).toBe(false);
    expect(isPRRowKey(key)).toBe(false);
  });

  it("separates repos with the same issue number", () => {
    expect(issueRowKey("/a", 144)).not.toBe(issueRowKey("/b", 144));
  });
});

describe("worktreeForIssue", () => {
  it("finds the worktree a spawn cut for the issue", () => {
    const found = worktreeForIssue(144, [
      worktree({ name: "other" }),
      worktree({ name: "issue-144-notifications" }),
    ]);
    expect(found?.row.name).toBe("issue-144-notifications");
    expect(found?.siblings).toBe(0);
  });

  it("matches the bare name as well as the family", () => {
    expect(
      worktreeForIssue(144, [worktree({ name: "issue-144" })])?.row.name,
    ).toBe("issue-144");
  });

  /**
   * The whole reason the prefix is family-exact. A bare `startsWith` makes
   * issue #14 claim `issue-144-foo`, and Enter would then jump into a
   * checkout for an entirely different issue.
   */
  it("refuses a longer number that merely starts with this one", () => {
    expect(
      worktreeForIssue(14, [worktree({ name: "issue-144-foo" })]),
    ).toBeNull();
    expect(worktreeForIssue(1, [worktree({ name: "issue-14" })])).toBeNull();
  });

  // A second spawn on the same issue derives `-2` rather than opening the
  // first, so several can exist. The first spawn wins and the rest are
  // counted, because there is no SHA here to break the tie and silently
  // choosing one of two live checkouts must be visible.
  it("takes the shortest name and counts the siblings", () => {
    const found = worktreeForIssue(144, [
      worktree({ name: "issue-144-notifications-2" }),
      worktree({ name: "issue-144-notifications" }),
      worktree({ name: "issue-144-notifications-3" }),
    ]);
    expect(found?.row.name).toBe("issue-144-notifications");
    expect(found?.siblings).toBe(2);
  });

  it("is stable when two names are the same length", () => {
    const found = worktreeForIssue(144, [
      worktree({ name: "issue-144-b" }),
      worktree({ name: "issue-144-a" }),
    ]);
    expect(found?.row.name).toBe("issue-144-a");
  });

  it("reports nothing when no worktree is for this issue", () => {
    expect(worktreeForIssue(144, [worktree({ name: "feat-x" })])).toBeNull();
  });
});

describe("buildSourceRepos", () => {
  it("marks a PR by SHA and an issue by name", () => {
    const [repo] = build({
      prs: [pr()],
      issues: [issue()],
      worktrees: [
        worktree({ name: "parking", tip: "sha-156", path: "/repo/wt/parking" }),
        worktree({ name: "issue-144-notifications", path: "/repo/wt/i144" }),
      ],
    });

    expect(repo!.prs[0]?.checkedOutName).toBe("parking");
    expect(repo!.prs[0]?.checkedOutPath).toBe("/repo/wt/parking");
    expect(repo!.issues[0]?.checkedOutName).toBe("issue-144-notifications");
    expect(repo!.issues[0]?.checkedOutPath).toBe("/repo/wt/i144");
  });

  // The PR's proof is the SHA and nothing else: a branch NAME matching is not
  // enough, because a fork can use any name it likes.
  it("leaves a PR unmarked when only its branch name matches", () => {
    const [repo] = build({
      prs: [pr()],
      worktrees: [worktree({ branch: "feat/sidebar-parking", tip: "other" })],
    });
    expect(repo!.prs[0]?.checkedOutName).toBeNull();
  });

  it("reports a source still in flight as pending, not as zero", () => {
    const repos = buildSourceRepos({
      prs: null,
      prError: null,
      issues: { repos: [], errors: [] },
      issueError: null,
      worktrees: {
        repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
      },
      home: null,
    });

    // Announcing `0` for something nobody has asked yet is the one answer
    // that is never true.
    expect(repos[0]?.prSection).toEqual({ kind: "pending" });
    expect(repos[0]?.issueSection).toEqual({ kind: "ready", count: 0 });
  });

  it("carries a per-repo failure's cause into that repo's section", () => {
    const repos = buildSourceRepos({
      prs: { repos: [], errors: [] },
      prError: null,
      issues: {
        repos: [],
        errors: [
          { repoRoot: "/repo", repoName: "repo", error: "gh: not logged in" },
        ],
      },
      issueError: null,
      worktrees: {
        repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
      },
      home: null,
    });

    expect(repos[0]?.issueSection).toEqual({
      kind: "unavailable",
      reason: "gh: not logged in",
    });
    // And it costs only its own section: the PR list still answers.
    expect(repos[0]?.prSection).toEqual({ kind: "ready", count: 0 });
  });

  /**
   * The first-run state for every existing user: their daemon predates
   * `/issues` until they restart it, so the whole request fails. It has to
   * read as unavailable-with-a-cause rather than as an empty list.
   */
  it("carries a whole-request failure into every repo's section", () => {
    const repos = buildSourceRepos({
      prs: { repos: [], errors: [] },
      prError: null,
      issues: null,
      issueError: "HTTP 404: run ccmux daemon restart",
      worktrees: {
        repos: [
          { repoRoot: "/a", repoName: "a", worktrees: [] },
          { repoRoot: "/b", repoName: "b", worktrees: [] },
        ],
      },
      home: null,
    });

    for (const repo of repos) {
      expect(repo.issueSection).toEqual({
        kind: "unavailable",
        reason: "HTTP 404: run ccmux daemon restart",
      });
    }
  });

  it("takes the union of every read's repos", () => {
    const repos = buildSourceRepos({
      prs: {
        repos: [{ repoRoot: "/b", repoName: "b", prs: [pr()] }],
        errors: [],
      },
      prError: null,
      issues: { repos: [], errors: [] },
      issueError: null,
      worktrees: {
        repos: [{ repoRoot: "/a", repoName: "a", worktrees: [] }],
      },
      home: null,
    });

    // A repo one read can see and another cannot would otherwise be a section
    // attached to nothing.
    expect(repos.map((repo) => repo.repoName)).toEqual(["a", "b"]);
  });

  it("leads with the repo it was opened over", () => {
    const repos = buildSourceRepos({
      prs: { repos: [], errors: [] },
      prError: null,
      issues: { repos: [], errors: [] },
      issueError: null,
      worktrees: {
        repos: [
          { repoRoot: "/a", repoName: "a", worktrees: [] },
          { repoRoot: "/z", repoName: "z", worktrees: [] },
        ],
      },
      home: "/z",
    });
    expect(repos.map((repo) => repo.repoName)).toEqual(["z", "a"]);
  });

  it("lists PRs before issues", () => {
    const rows = pickerRows(build({ prs: [pr()], issues: [issue()] }));
    // PRs lead because they are the closer-to-done thing: a PR has a head to
    // check out, an issue only a name to start from.
    expect(rows.map((row) => row.kind)).toEqual(["pr", "issue"]);
  });
});

describe("row presentation", () => {
  it("labels a row with its number and title", () => {
    const [prRow, issueRow] = pickerRows(
      build({ prs: [pr()], issues: [issue()] }),
    );
    expect(sourceRowLabel(prRow!)).toBe(
      "#156 fix(sidebar): park the renderer while hidden",
    );
    expect(sourceRowLabel(issueRow!)).toBe(
      "#144 Notifications are swallowed inside nested tmux",
    );
  });

  it("gives the two kinds different markers", () => {
    const [prRow, issueRow] = pickerRows(
      build({ prs: [pr()], issues: [issue()] }),
    );
    // They share one list, so the left edge is what says which is which
    // before any word is read.
    expect(sourceRowMarker(prRow!)).not.toBe(sourceRowMarker(issueRow!));
  });

  it("dims a draft PR and nothing else", () => {
    const [draft] = pickerRows(build({ prs: [pr({ isDraft: true })] }));
    const [ready] = pickerRows(build({ prs: [pr()] }));
    const [open] = pickerRows(build({ issues: [issue()] }));
    expect(sourceRowDim(draft!)).toBe(true);
    expect(sourceRowDim(ready!)).toBe(false);
    // An open issue is open; there is no equivalent of a draft to dim.
    expect(sourceRowDim(open!)).toBe(false);
  });

  it("says who opened an issue and what it is labelled", () => {
    const [row] = pickerRows(
      build({ issues: [issue({ labels: ["bug", "help wanted"] })] }),
    );
    expect(sourceDetailPhrases(row!).map((phrase) => phrase.text)).toEqual([
      "@epilande",
      "bug, help wanted",
    ]);
  });

  it("keeps an issue's labels on a narrow surface, where the author goes", () => {
    const [row] = pickerRows(build({ issues: [issue()] }));
    const phrases = sourceDetailPhrases(row!, { compact: true });
    const texts = phrases.map((phrase) => phrase.text);
    // Labels say what KIND of work it is, which is the half worth the columns.
    expect(texts).toContain("bug");
    expect(texts).not.toContain("@epilande");
  });

  it("says where an issue is already checked out, and how many others exist", () => {
    const [row] = pickerRows(
      build({
        issues: [issue()],
        worktrees: [
          worktree({ name: "issue-144-notifications" }),
          worktree({ name: "issue-144-notifications-2" }),
        ],
      }),
    );
    const phrases = sourceDetailPhrases(row!).map((phrase) => phrase.text);
    expect(phrases).toContain(
      "checked out in issue-144-notifications (+1 more)",
    );
  });

  it("drops the count when there is only the one", () => {
    const [row] = pickerRows(
      build({
        issues: [issue()],
        worktrees: [worktree({ name: "issue-144-notifications" })],
      }),
    );
    expect(sourceDetailPhrases(row!).map((phrase) => phrase.text)).toContain(
      "checked out in issue-144-notifications",
    );
  });

  it("draws a PR's detail line with the panel's own rules", () => {
    const [row] = pickerRows(
      build({ prs: [pr({ reviewDecision: "APPROVED", ciStatus: "passing" })] }),
    );
    expect(sourceDetailPhrases(row!).map((phrase) => phrase.text)).toEqual([
      "feat/sidebar-parking",
      "@epilande",
      "approved",
      "checks pass",
    ]);
  });
});

describe("filtering", () => {
  it("matches the number, the title, the author, a branch and a label", () => {
    const [prRow, issueRow] = pickerRows(
      build({ prs: [pr()], issues: [issue()] }),
    );
    for (const needle of ["156", "park", "epilande", "sidebar-parking"]) {
      expect(matchesQuery(prRow!, needle), needle).toBe(true);
    }
    for (const needle of ["144", "swallowed", "epilande", "bug"]) {
      expect(matchesQuery(issueRow!, needle), needle).toBe(true);
    }
  });

  it("ignores case and surrounding space", () => {
    const [row] = pickerRows(build({ prs: [pr()] }));
    expect(matchesQuery(row!, "  PARK  ")).toBe(true);
  });

  it("matches everything on an empty query", () => {
    const [row] = pickerRows(build({ prs: [pr()] }));
    expect(matchesQuery(row!, "")).toBe(true);
    expect(matchesQuery(row!, "   ")).toBe(true);
  });

  it("does not match a word that is in neither field", () => {
    const [row] = pickerRows(build({ prs: [pr()] }));
    expect(matchesQuery(row!, "kubernetes")).toBe(false);
  });

  it("lower-cases the whole haystack once", () => {
    const [row] = pickerRows(build({ prs: [pr({ title: "MiXeD Case" })] }));
    expect(rowHaystack(row!)).toBe(rowHaystack(row!).toLowerCase());
  });

  /**
   * One typed word reaching both kinds is the whole argument for a single
   * list over two tabs: a user remembers the words, not whether the thing
   * they remember was filed as a PR or as an issue.
   */
  it("reaches both kinds with one query", () => {
    const repos = filterRepos(
      build({
        prs: [pr({ title: "feat(notify): auto-detect nested tmux" })],
        issues: [issue()],
      }),
      "notif",
    );
    expect(pickerRows(repos)).toHaveLength(2);
  });

  it("keeps a repo whose rows all failed to match, and says zero", () => {
    const repos = filterRepos(build({ prs: [pr()], issues: [issue()] }), "zzz");
    // Dropping the repo would make the list jump between groups as characters
    // are typed; a `0` under its name is the answer to "is it in this one".
    expect(repos).toHaveLength(1);
    expect(repos[0]?.prSection).toEqual({ kind: "ready", count: 0 });
    expect(repos[0]?.issueSection).toEqual({ kind: "ready", count: 0 });
  });

  it("restates a ready count for what the filter left", () => {
    const repos = filterRepos(
      build({
        prs: [
          pr({ number: 1 }),
          pr({ number: 2, title: "other", headRefName: "feat/other" }),
        ],
      }),
      "park",
    );
    expect(repos[0]?.prSection).toEqual({ kind: "ready", count: 1 });
  });

  it("leaves a pending or failed section alone", () => {
    const base = buildSourceRepos({
      prs: null,
      prError: null,
      issues: { repos: [], errors: [] },
      issueError: "boom",
      worktrees: {
        repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
      },
      home: null,
    });
    const repos = filterRepos(base, "anything");

    // Neither reports a count, so a local query has nothing to restate: what
    // GitHub said does not change because the user typed.
    expect(repos[0]?.prSection).toEqual({ kind: "pending" });
    expect(repos[0]?.issueSection).toEqual({
      kind: "unavailable",
      reason: "boom",
    });
  });
});

describe("sectionText", () => {
  it("puts the count against its own label with no divider", () => {
    // In this TUI `·` divides PEERS; gluing a count to its label makes one
    // fact read as two.
    expect(sectionText(PRS_SECTION, { kind: "ready", count: 2 }, "")).toBe(
      "Pull requests 2",
    );
    expect(sectionText(ISSUES_SECTION, { kind: "ready", count: 0 }, "")).toBe(
      "Issues 0",
    );
  });

  it("rides the spinner on the label while GitHub is being asked", () => {
    expect(sectionText(ISSUES_SECTION, { kind: "pending" }, "◐")).toBe(
      "Issues ◐ checking GitHub",
    );
  });

  it("states a failure's cause under the source it belongs to", () => {
    expect(
      sectionText(
        ISSUES_SECTION,
        { kind: "unavailable", reason: "gh: not logged in" },
        "",
      ),
    ).toBe("Issues unavailable: gh: not logged in");
  });

  /**
   * `gh` stderr arrives with newlines, which are ZERO columns wide: they pass
   * every width guard and then take the rest of the row with them, because
   * OpenTUI wraps and a wrapped line in a one-line box vanishes.
   */
  it("flattens a multi-line cause", () => {
    const text = sectionText(
      ISSUES_SECTION,
      { kind: "unavailable", reason: "gh: not logged in\nrun gh auth login" },
      "",
    );
    expect(text).not.toContain("\n");
    expect(text).toContain("run gh auth login");
  });

  it("still names the source when a failure has no cause", () => {
    expect(
      sectionText(PRS_SECTION, { kind: "unavailable", reason: null }, ""),
    ).toBe("Pull requests unavailable");
  });
});

describe("the empty state", () => {
  it("is not drawn while anything has a row", () => {
    expect(hasRows(build({ prs: [pr()] }))).toBe(true);
    expect(hasRows(build())).toBe(false);
  });

  // The query is what the user would change, so it is answered before any
  // report about GitHub.
  it("blames the filter first", () => {
    expect(emptyStateText(build({ prs: [pr()] }), "zzz").text).toBe(
      'Nothing matches "zzz"',
    );
  });

  it("says it is still asking while a source is in flight", () => {
    const repos = buildSourceRepos({
      prs: null,
      prError: null,
      issues: null,
      issueError: null,
      worktrees: {
        repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
      },
      home: null,
    });
    expect(emptyStateText(repos, "").text).toBe("Checking GitHub...");
  });

  it("names the cause when a source failed", () => {
    const repos = buildSourceRepos({
      prs: { repos: [], errors: [] },
      prError: null,
      issues: null,
      issueError: "HTTP 404: run ccmux daemon restart",
      worktrees: {
        repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
      },
      home: null,
    });
    expect(emptyStateText(repos, "").text).toContain("ccmux daemon restart");
  });

  it("says nothing is open when both sources answered zero", () => {
    expect(emptyStateText(build(), "").text).toBe("Nothing open here");
  });

  it("says there is no repository when nothing answered at all", () => {
    const repos = buildSourceRepos({
      prs: { repos: [], errors: [] },
      prError: null,
      issues: { repos: [], errors: [] },
      issueError: null,
      worktrees: { repos: [] },
      home: null,
    });
    expect(emptyStateText(repos, "").text).toBe("No repository here");
  });
});
