import { describe, expect, it } from "bun:test";
import type { GitRun } from "./worktree-git";
import {
  MAX_CHANGES,
  parseLog,
  parseStatusZ,
  readWorktreeDetail,
} from "./worktree-detail";

describe("parseStatusZ", () => {
  it("reads codes and unquoted paths, renames with their source", () => {
    const out = [
      " M src/app.ts",
      "?? notes with space.md",
      "R  new name.ts",
      "old name.ts",
      "A  café.txt",
      "",
    ].join("\0");
    expect(parseStatusZ(out)).toEqual([
      { code: " M", path: "src/app.ts" },
      { code: "??", path: "notes with space.md" },
      { code: "R ", path: "new name.ts", from: "old name.ts" },
      { code: "A ", path: "café.txt" },
    ]);
  });

  it("replaces control characters in a path", () => {
    expect(parseStatusZ("?? a\x1b[2Jb\0")).toEqual([
      { code: "??", path: "a [2Jb" },
    ]);
  });

  it("is empty for a clean tree", () => {
    expect(parseStatusZ("")).toEqual([]);
  });
});

describe("parseLog", () => {
  it("reads sha, subject and date", () => {
    const out = "abc123\x1ffix: a thing\x1f2026-10-01T12:00:00-07:00\n";
    expect(parseLog(out)).toEqual([
      {
        sha: "abc123",
        subject: "fix: a thing",
        date: "2026-10-01T12:00:00-07:00",
      },
    ]);
  });
});

/** A git that answers status and log from a table. */
function fakeGit(answers: {
  status: { exitCode: number; stdout: string; stderr?: string };
  log: { exitCode: number; stdout: string };
}): GitRun {
  return async (_cwd, args) => {
    const answer = args[0] === "status" ? answers.status : answers.log;
    return { stderr: "", ...answer };
  };
}

describe("readWorktreeDetail", () => {
  it("caps the change list and still counts every change", async () => {
    const status = Array.from(
      { length: MAX_CHANGES + 5 },
      (_, i) => `?? f${i}`,
    ).join("\0");
    const result = await readWorktreeDetail(
      "/wt",
      fakeGit({
        status: { exitCode: 0, stdout: status },
        log: { exitCode: 0, stdout: "" },
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.detail.changes).toHaveLength(MAX_CHANGES);
    expect(result.detail.total).toBe(MAX_CHANGES + 5);
    expect(result.detail.truncated).toBe(true);
  });

  it("treats a branch with no commits as having none, not as a failure", async () => {
    const result = await readWorktreeDetail(
      "/wt",
      fakeGit({
        status: { exitCode: 0, stdout: "" },
        log: { exitCode: 128, stdout: "" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      detail: {
        path: "/wt",
        changes: [],
        total: 0,
        truncated: false,
        commits: [],
      },
    });
  });

  it("reports an unreadable worktree", async () => {
    const result = await readWorktreeDetail(
      "/wt",
      fakeGit({
        status: {
          exitCode: 128,
          stdout: "",
          stderr: "fatal: not a git repo\n",
        },
        log: { exitCode: 128, stdout: "" },
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: "git status failed: fatal: not a git repo",
    });
  });
});
