import { afterEach, describe, expect, it } from "bun:test";
import {
  callerCwd,
  formatWorktreeList,
  parseSelection,
  resolveRepoOption,
} from "./worktree";
import type { WorktreeRepo, WorktreeRow } from "../daemon/worktree-list";

describe("parseSelection", () => {
  it("accepts single numbers and comma lists", () => {
    expect(parseSelection("1", 3)).toEqual([0]);
    expect(parseSelection("1,3", 3)).toEqual([0, 2]);
    expect(parseSelection("3 1", 3)).toEqual([0, 2]);
  });

  it("accepts ranges and de-duplicates overlaps", () => {
    expect(parseSelection("1-3", 3)).toEqual([0, 1, 2]);
    expect(parseSelection("1-2,2,3", 3)).toEqual([0, 1, 2]);
  });

  it("accepts 'a' and 'all' for everything", () => {
    expect(parseSelection("a", 2)).toEqual([0, 1]);
    expect(parseSelection("ALL", 2)).toEqual([0, 1]);
  });

  it("cancels on empty input", () => {
    expect(parseSelection("", 3)).toBeNull();
    expect(parseSelection("   ", 3)).toBeNull();
  });

  // A typo must cancel the whole run rather than resolve to some other
  // worktree: this selection drives directory deletion.
  it("rejects out-of-range, reversed and non-numeric input", () => {
    expect(parseSelection("4", 3)).toBeNull();
    expect(parseSelection("0", 3)).toBeNull();
    expect(parseSelection("1-9", 3)).toBeNull();
    expect(parseSelection("3-1", 3)).toBeNull();
    expect(parseSelection("y", 3)).toBeNull();
    expect(parseSelection("1,x", 3)).toBeNull();
  });
});

/**
 * `ccmux worktree list` rendering. The formatter is pure so the columns can
 * be asserted without a daemon: everything the command itself does is fetch
 * and print.
 */
function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    path: "/repo/wt/feat-a",
    repoRoot: "/repo",
    repoName: "repo",
    name: "feat-a",
    branch: "feat/a",
    detached: false,
    isMain: false,
    locked: false,
    dirty: { dirty: false, modified: 0, untracked: 0 },
    upstream: null,
    sessions: [],
    ...overrides,
  };
}

function repo(
  name: string,
  worktrees: WorktreeRow[],
  repoRoot = `/${name}`,
): WorktreeRepo {
  return { repoRoot, repoName: name, worktrees };
}

describe("formatWorktreeList", () => {
  it("says so when there is nothing to list", () => {
    expect(formatWorktreeList([])).toEqual(["No worktrees found."]);
  });

  it("marks the main checkout and names the branch", () => {
    const lines = formatWorktreeList([
      repo("proj", [
        row({ name: "proj", branch: "main", isMain: true }),
        row(),
      ]),
    ]);

    expect(lines[0]).toContain("proj (main)");
    expect(lines[0]).toContain("main");
    expect(lines[1]).toContain("feat-a");
    expect(lines[1]).toContain("feat/a");
  });

  it("labels a detached worktree instead of leaving the branch blank", () => {
    const lines = formatWorktreeList([
      repo("proj", [row({ branch: null, detached: true })]),
    ]);

    expect(lines[0]).toContain("(detached)");
  });

  it("shows ahead and behind, and nothing when in sync", () => {
    const lines = formatWorktreeList([
      repo("proj", [
        row({
          name: "ahead",
          upstream: {
            upstream: "origin/feat/a",
            gone: false,
            ahead: 2,
            behind: 1,
          },
        }),
        row({
          name: "synced",
          upstream: {
            upstream: "origin/feat/b",
            gone: false,
            ahead: 0,
            behind: 0,
          },
        }),
      ]),
    ]);

    expect(lines[0]).toContain("↑2 ↓1");
    expect(lines[1]).not.toContain("↑");
    expect(lines[1]).not.toContain("↓");
  });

  // A gone upstream has no counts, so "in sync" would be the wrong reading of
  // the two zeros it leaves behind.
  it("says gone rather than showing an in-sync worktree", () => {
    const lines = formatWorktreeList([
      repo("proj", [
        row({
          upstream: {
            upstream: "origin/feat/a",
            gone: true,
            ahead: 0,
            behind: 0,
          },
        }),
      ]),
    ]);

    expect(lines[0]).toContain("gone");
  });

  it("summarizes dirt as modified and untracked counts", () => {
    const lines = formatWorktreeList([
      repo("proj", [
        row({ dirty: { dirty: true, modified: 2, untracked: 1 } }),
        row({ name: "clean" }),
      ]),
    ]);

    expect(lines[0]).toContain("2m 1u");
    expect(lines[1]).not.toContain("m");
  });

  it("names each attached session with its status", () => {
    const lines = formatWorktreeList([
      repo("proj", [
        row({
          sessions: [
            {
              id: "s1",
              agentType: "claude",
              status: "working",
              tmuxPane: "%1",
              tmuxTarget: "w:0.1",
              pid: null,
            },
            {
              id: "s2",
              agentType: "codex",
              status: "idle",
              tmuxPane: "%2",
              tmuxTarget: "w:0.2",
              pid: null,
            },
          ],
        }),
      ]),
    ]);

    expect(lines[0]).toContain("claude working, codex idle");
  });

  // One repo is the common case and needs no header; several would be
  // unreadable without one.
  it("groups by repo only when there is more than one", () => {
    const single = formatWorktreeList([repo("proj", [row()])]);
    expect(single).toHaveLength(1);
    expect(single[0]).not.toContain("proj");

    const many = formatWorktreeList([
      repo("alpha", [row({ name: "a-1" })]),
      repo("beta", [row({ name: "b-1" })]),
    ]);
    expect(many[0]).toBe("alpha  (/alpha)");
    expect(many[1]).toContain("a-1");
    expect(many[2]).toBe("");
    expect(many[3]).toBe("beta  (/beta)");
    expect(many[4]).toContain("b-1");
  });

  // Columns are computed across every repo, so the groups line up with each
  // other rather than each being its own table.
  it("aligns the columns across repos and leaves no trailing padding", () => {
    const lines = formatWorktreeList([
      repo("alpha", [row({ name: "short", branch: "x" })]),
      repo("beta", [row({ name: "a-much-longer-name", branch: "y" })]),
    ]);

    const branchColumn = (line: string) => line.indexOf("x");
    expect(branchColumn(lines[1])).toBe(lines[4].indexOf("y"));
    for (const line of lines) expect(line).toBe(line.trimEnd());
  });
});

/**
 * The caller's directory. `bin/ccmux` cds into the package root before
 * handing off, so a bare `process.cwd()` here is the ccmux INSTALL — which
 * for cwd-based repo discovery means every invocation answers for the ccmux
 * checkout instead of wherever the user is standing.
 */
describe("callerCwd and resolveRepoOption", () => {
  const saved = process.env.CCMUX_CALLER_PWD;

  afterEach(() => {
    if (saved === undefined) delete process.env.CCMUX_CALLER_PWD;
    else process.env.CCMUX_CALLER_PWD = saved;
  });

  it("prefers the caller's directory over the install's", () => {
    process.env.CCMUX_CALLER_PWD = "/home/dev/project";
    expect(callerCwd()).toBe("/home/dev/project");
  });

  it("falls back to process.cwd() when the wrapper did not set it", () => {
    delete process.env.CCMUX_CALLER_PWD;
    expect(callerCwd()).toBe(process.cwd());
  });

  // The daemon runs chdir'd to `/`, so a relative repo can only be resolved
  // here — and only against the caller's directory, never the install's.
  it("resolves a relative --repo against the caller's directory", () => {
    process.env.CCMUX_CALLER_PWD = "/home/dev/project";
    expect(resolveRepoOption("../other")).toBe("/home/dev/other");
    expect(resolveRepoOption(".")).toBe("/home/dev/project");
  });

  it("leaves an absolute --repo alone and passes undefined through", () => {
    process.env.CCMUX_CALLER_PWD = "/home/dev/project";
    expect(resolveRepoOption("/srv/repo")).toBe("/srv/repo");
    expect(resolveRepoOption(undefined)).toBeUndefined();
  });
});
