import { describe, expect, it } from "bun:test";
import type { GhRun, GhRunResult } from "./gh-spawn-source";
import {
  BODY_MAX_CHARS,
  Limiter,
  readChecks,
  readIssueDetail,
  readPRDetail,
  sanitizeBody,
} from "./source-detail";

/** A runner that records its argv and answers with `result`. */
function gh(result: Partial<GhRunResult>) {
  const calls: { cwd: string; args: string[] }[] = [];
  const run: GhRun = async (cwd, args) => {
    calls.push({ cwd, args });
    return { exitCode: 0, stdout: "", stderr: "", ...result };
  };
  return { run, calls };
}

describe("sanitizeBody", () => {
  it("keeps newlines and tabs, and drops CR and other controls", () => {
    expect(sanitizeBody("a\r\n\tb\x1b[31mc\x9bd").body).toBe("a\n\tb[31mcd");
  });

  it("drops the invisible and reordering characters titles lose too", () => {
    expect(sanitizeBody("safe‮reversed​⁦x").body).toBe("safereversedx");
  });

  it("caps the body without splitting a surrogate pair", () => {
    const raw = "a".repeat(BODY_MAX_CHARS - 1) + "😀tail";
    const { body, truncated } = sanitizeBody(raw);
    expect(truncated).toBe(true);
    expect(body).toBe("a".repeat(BODY_MAX_CHARS - 1));
  });
});

describe("readChecks", () => {
  it("names each check, failing first, then pending, in gh's order", () => {
    const checks = readChecks([
      {
        __typename: "CheckRun",
        name: "lint",
        status: "COMPLETED",
        conclusion: "SUCCESS",
      },
      {
        __typename: "CheckRun",
        name: "test",
        status: "IN_PROGRESS",
        conclusion: null,
      },
      { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
      {
        __typename: "CheckRun",
        name: "docs",
        status: "COMPLETED",
        conclusion: "SKIPPED",
      },
      {
        __typename: "CheckRun",
        name: "e2e",
        status: "COMPLETED",
        conclusion: "CANCELLED",
      },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    expect(checks).toEqual([
      { name: "ci/legacy", state: "fail" },
      { name: "e2e", state: "fail" },
      { name: "test", state: "pending" },
      { name: "lint", state: "pass" },
      { name: "docs", state: "skip" },
    ]);
  });

  it("strips control characters from names", () => {
    expect(
      readChecks([
        {
          __typename: "CheckRun",
          name: "a\x1b[2Jb",
          status: "COMPLETED",
          conclusion: "NEUTRAL",
        },
      ]),
    ).toEqual([{ name: "a[2Jb", state: "neutral" }]);
  });

  it("is empty for a missing or malformed rollup", () => {
    expect(readChecks(null)).toEqual([]);
    expect(readChecks("nope")).toEqual([]);
  });
});

describe("readPRDetail", () => {
  it("asks gh for one PR and reads its body, size and checks", async () => {
    const { run, calls } = gh({
      stdout: JSON.stringify({
        body: "## Summary\r\nDoes a thing",
        baseRefName: "main",
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            name: "test",
            status: "COMPLETED",
            conclusion: "FAILURE",
          },
        ],
      }),
    });
    const result = await readPRDetail("/repo", 42, run);
    expect(calls[0]).toEqual({
      cwd: "/repo",
      args: [
        "pr",
        "view",
        "42",
        "--json",
        "body,baseRefName,additions,deletions,changedFiles,statusCheckRollup",
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        number: 42,
        body: "## Summary\nDoes a thing",
        truncated: false,
        baseRefName: "main",
        additions: 12,
        deletions: 3,
        changedFiles: 2,
        checks: [{ name: "test", state: "fail" }],
      },
    });
  });

  it("reports gh's failure rather than an empty body", async () => {
    const { run } = gh({ exitCode: 1, stderr: "no pull requests found" });
    const result = await readPRDetail("/repo", 9, run);
    expect(result).toEqual({
      ok: false,
      error: "gh pr view exited 1: no pull requests found",
    });
  });

  it("reports output that is not a JSON object", async () => {
    const { run } = gh({ stdout: "[]" });
    const result = await readPRDetail("/repo", 9, run);
    expect(result.ok).toBe(false);
  });
});

describe("readIssueDetail", () => {
  it("reads the body only, never the comments", async () => {
    const { run, calls } = gh({ stdout: JSON.stringify({ body: "Steps" }) });
    const result = await readIssueDetail("/repo", 7, run);
    expect(calls[0]!.args).toEqual(["issue", "view", "7", "--json", "body"]);
    expect(result).toEqual({
      ok: true,
      value: { number: 7, body: "Steps", truncated: false },
    });
  });

  it("treats a missing body as an empty one", async () => {
    const { run } = gh({ stdout: JSON.stringify({ body: null }) });
    expect(await readIssueDetail("/repo", 7, run)).toEqual({
      ok: true,
      value: { number: 7, body: "", truncated: false },
    });
  });
});

describe("Limiter", () => {
  it("never runs more than its limit at once", async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limiter.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return "done";
      });
    const results = await Promise.all([task(), task(), task(), task(), task()]);
    expect(results).toEqual(["done", "done", "done", "done", "done"]);
    expect(peak).toBe(2);
  });

  it("releases its slot when a task throws", async () => {
    const limiter = new Limiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await limiter.run(async () => "next")).toBe("next");
  });
});
