import { describe, it, expect } from "bun:test";
import { listOpenIssues, normalizeIssueList } from "./issue-list";
import type { GhRun, GhRunResult } from "./gh-spawn-source";

/** A runner that answers every call with one canned result. */
function ghAnswering(result: Partial<GhRunResult>): GhRun {
  return async () => ({ exitCode: 0, stdout: "", stderr: "", ...result });
}

const ISSUE_ROW = {
  number: 151,
  title: "Open-PR list in the Worktrees panel",
  url: "https://github.com/o/r/issues/151",
  author: { login: "epilande", is_bot: false },
  labels: [
    { id: "L1", name: "enhancement", color: "a2eeef" },
    { id: "L2", name: "tui", color: "000000" },
  ],
};

describe("listOpenIssues", () => {
  it("asks gh for open issues with an explicit limit and the fields a row needs", async () => {
    const calls: string[][] = [];
    const cwds: string[] = [];
    const run: GhRun = async (cwd, args) => {
      cwds.push(cwd);
      calls.push(args);
      return { exitCode: 0, stdout: "[]", stderr: "" };
    };
    await listOpenIssues("/repo", run);

    const args = calls[0] ?? [];
    expect(args.slice(0, 2)).toEqual(["issue", "list"]);
    // Run in the caller's directory so gh resolves the same repo every other
    // worktree surface does.
    expect(cwds[0]).toBe("/repo");
    expect(args).toContain("--state");
    expect(args[args.indexOf("--state") + 1]).toBe("open");
    // gh caps at 30 silently without this; a cap nobody chose is worse.
    expect(args).toContain("--limit");
    expect(Number(args[args.indexOf("--limit") + 1])).toBeGreaterThan(30);
    const fields = args[args.indexOf("--json") + 1] ?? "";
    for (const field of ["number", "title", "url", "author", "labels"]) {
      expect(fields).toContain(field);
    }
  });

  it("flattens a row to what a picker row renders", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({ stdout: JSON.stringify([ISSUE_ROW]) }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const [issue] = found.value;
    expect(issue).toBeDefined();
    expect(issue!.number).toBe(151);
    expect(issue!.title).toBe("Open-PR list in the Worktrees panel");
    expect(issue!.url).toBe("https://github.com/o/r/issues/151");
    // `author` is an OBJECT in gh's JSON; a string read would drop it.
    expect(issue!.author).toBe("epilande");
    // Labels are objects too, and only their names reach a row.
    expect(issue!.labels).toEqual(["enhancement", "tui"]);
  });

  it("reports a repo with no open issues as an empty list, not as a failure", async () => {
    const found = await listOpenIssues("/repo", ghAnswering({ stdout: "[]" }));
    expect(found).toEqual({ ok: true, value: [] });
  });

  it("orders newest first", async () => {
    const rows = [7, 200, 42].map((number) => ({ ...ISSUE_ROW, number }));
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({ stdout: JSON.stringify(rows) }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.map((issue) => issue.number)).toEqual([200, 42, 7]);
  });

  it("normalizes an author gh did not name, and an issue with no labels", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([{ ...ISSUE_ROW, author: null, labels: [] }]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.author).toBeNull();
    expect(found.value[0]?.labels).toEqual([]);
  });

  it("drops a label it cannot name rather than rendering an empty chip", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([
          {
            ...ISSUE_ROW,
            labels: [{ name: "bug" }, { color: "fff" }, null, "plain string"],
          },
        ]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.labels).toEqual(["bug"]);
  });

  it("survives a labels field that is not an array at all", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([{ ...ISSUE_ROW, labels: "enhancement" }]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // The row is still identified; only its decoration is missing.
    expect(found.value[0]?.number).toBe(151);
    expect(found.value[0]?.labels).toEqual([]);
  });

  /**
   * A title travels into a TUI row, the dialog's note and (through
   * `seedPrompt`) an agent's opening message, so it is stripped where
   * GitHub's text ENTERS. The exhaustive bidi and C1 cases live on
   * `stripControlChars` and in `pr-list.test.ts`; this proves the boundary is
   * applied on this path too, and that a label gets the same treatment.
   */
  it("strips control characters out of a title and a label", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([
          {
            ...ISSUE_ROW,
            title: "before\u001b[31m\u009bafter",
            labels: [{ name: "bu\u202eg" }],
          },
        ]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.title).toBe("before [31m after");
    expect(found.value[0]?.labels[0]).not.toContain("\u202e");
  });

  it("falls back to a title when gh reports none", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({ stdout: JSON.stringify([{ ...ISSUE_ROW, title: "" }]) }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.title).toBe("Issue #151");
  });

  it("drops a row it cannot identify rather than failing the whole list", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([
          { ...ISSUE_ROW, number: "not a number" },
          { ...ISSUE_ROW, number: 3.5 },
          { ...ISSUE_ROW, url: "" },
          ISSUE_ROW,
        ]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.map((issue) => issue.number)).toEqual([151]);
  });

  // The distinction the module exists for: a failure can never look like
  // "this repo has no open issues". A repo with issues DISABLED fails here,
  // and drawing that as an empty list would be a lie about the repo.
  it("reports a non-zero exit as an error, not as an empty list", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({ exitCode: 1, stderr: "gh: not authenticated" }),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("gh issue list exited 1");
    expect(found.error).toContain("not authenticated");
  });

  it("names a missing gh binary with the fix", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({ spawnError: "No such file or directory" }),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("gh could not be run");
    expect(found.error).toContain("gh auth login");
  });

  it("names a timeout", async () => {
    const found = await listOpenIssues(
      "/repo",
      ghAnswering({ timedOut: true, exitCode: 137 }),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("timed out");
  });

  it("refuses output that is not the requested JSON", async () => {
    for (const stdout of ["not json", '{"number":1}']) {
      const found = await listOpenIssues("/repo", ghAnswering({ stdout }));
      expect(found.ok).toBe(false);
      if (found.ok) continue;
      expect(found.error).toContain("did not return valid JSON");
    }
  });
});

describe("normalizeIssueList", () => {
  // The daemon may PREDATE this build, so a body missing either field must
  // read as empty rather than crashing the surface that renders it.
  it("fills in fields an older daemon did not send", () => {
    expect(normalizeIssueList({})).toEqual({ repos: [], errors: [] });
    expect(normalizeIssueList({ repos: [] }).errors).toEqual([]);
  });

  it("passes through what a current daemon sends", () => {
    const body = {
      repos: [{ repoRoot: "/r", repoName: "r", issues: [] }],
      errors: [{ repoRoot: "/e", repoName: "e", error: "boom" }],
    };
    expect(normalizeIssueList(body)).toEqual(body);
  });
});
