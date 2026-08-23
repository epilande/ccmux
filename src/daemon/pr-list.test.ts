import { describe, it, expect } from "bun:test";
import { listOpenPRs } from "./pr-list";
import type { GhRun, GhRunResult } from "./gh-spawn-source";

/** A runner that answers every call with one canned result. */
function ghAnswering(result: Partial<GhRunResult>): GhRun {
  return async () => ({ exitCode: 0, stdout: "", stderr: "", ...result });
}

const PR_ROW = {
  number: 151,
  title: "Worktrees panel: open-PR list",
  url: "https://github.com/o/r/pull/151",
  author: { login: "epilande", is_bot: false },
  isDraft: false,
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  headRefName: "feat/pr-list-panel",
  headRefOid: "abc123",
};

describe("listOpenPRs", () => {
  it("asks gh for open PRs with an explicit limit and the fields a row needs", async () => {
    const calls: string[][] = [];
    const cwds: string[] = [];
    const run: GhRun = async (cwd, args) => {
      cwds.push(cwd);
      calls.push(args);
      return { exitCode: 0, stdout: "[]", stderr: "" };
    };
    await listOpenPRs("/repo", run);

    const args = calls[0] ?? [];
    expect(args.slice(0, 2)).toEqual(["pr", "list"]);
    // Run in the caller's directory so gh resolves the same repo every other
    // worktree surface does.
    expect(cwds[0]).toBe("/repo");
    expect(args).toContain("--state");
    expect(args[args.indexOf("--state") + 1]).toBe("open");
    // gh caps at 30 silently without this; a cap nobody chose is worse.
    expect(args).toContain("--limit");
    expect(Number(args[args.indexOf("--limit") + 1])).toBeGreaterThan(30);
    const fields = args[args.indexOf("--json") + 1] ?? "";
    for (const field of [
      "number",
      "title",
      "url",
      "author",
      "isDraft",
      "reviewDecision",
      "statusCheckRollup",
      "headRefName",
      "headRefOid",
    ]) {
      expect(fields).toContain(field);
    }
  });

  it("flattens a row to what the section renders", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({ stdout: JSON.stringify([PR_ROW]) }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const [pr] = found.value;
    expect(pr).toBeDefined();
    expect(pr!.number).toBe(151);
    expect(pr!.title).toBe("Worktrees panel: open-PR list");
    expect(pr!.url).toBe("https://github.com/o/r/pull/151");
    // `author` is an OBJECT in gh's JSON; a string read would drop it.
    expect(pr!.author).toBe("epilande");
    expect(pr!.isDraft).toBe(false);
    expect(pr!.reviewDecision).toBe("APPROVED");
    expect(pr!.ciStatus).toBe("passing");
    expect(pr!.headRefName).toBe("feat/pr-list-panel");
    // The only reliable branch identity; never the head ref NAME.
    expect(pr!.headRefOid).toBe("abc123");
  });

  it("reports an empty repo as an empty list, not as a failure", async () => {
    const found = await listOpenPRs("/repo", ghAnswering({ stdout: "[]" }));
    expect(found).toEqual({ ok: true, value: [] });
  });

  it("orders newest first", async () => {
    const rows = [7, 200, 42].map((number) => ({ ...PR_ROW, number }));
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({ stdout: JSON.stringify(rows) }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.map((pr) => pr.number)).toEqual([200, 42, 7]);
  });

  it("normalizes an author gh did not name, and gh's empty review decision", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([
          { ...PR_ROW, author: null, reviewDecision: "" },
        ]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.author).toBeNull();
    expect(found.value[0]?.reviewDecision).toBeNull();
  });

  it("reads an empty check rollup as `none`, never as passing", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([{ ...PR_ROW, statusCheckRollup: [] }]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // An un-CI'd PR must never wear the colour of a verified one.
    expect(found.value[0]?.ciStatus).toBe("none");
  });

  it("folds a running check to pending and a cancelled one to failing", async () => {
    const rollups = [
      [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
      [
        {
          __typename: "CheckRun",
          status: "COMPLETED",
          conclusion: "CANCELLED",
        },
      ],
    ];
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify(
          rollups.map((statusCheckRollup, i) => ({
            ...PR_ROW,
            number: 10 - i,
            statusCheckRollup,
          })),
        ),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.map((pr) => pr.ciStatus)).toEqual([
      "pending",
      "failing",
    ]);
  });

  // A title travels into a TUI row and into the dialog's note, so it is
  // stripped where GitHub's text ENTERS rather than at each render. The C1
  // block matters as much as C0: a raw 0x9b is a one-byte CSI.
  it("strips control characters out of a title", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([
          { ...PR_ROW, title: "before\u001b[31m\u009bafter" },
        ]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.title).toBe("before [31m after");
  });

  it("drops a row it cannot identify rather than failing the whole list", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({
        stdout: JSON.stringify([
          { ...PR_ROW, number: "not a number" },
          { ...PR_ROW, url: "" },
          PR_ROW,
        ]),
      }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.map((pr) => pr.number)).toEqual([151]);
  });

  // The distinction the whole module exists for: a failure can never look
  // like "this repo has no open PRs".
  it("reports a non-zero exit as an error, not as an empty list", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({ exitCode: 1, stderr: "gh: not authenticated" }),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("gh pr list exited 1");
    expect(found.error).toContain("not authenticated");
  });

  it("names a missing gh binary with the fix", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({ spawnError: "No such file or directory" }),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("gh could not be run");
    expect(found.error).toContain("gh auth login");
  });

  it("names a timeout", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghAnswering({ timedOut: true, exitCode: 137 }),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("timed out");
  });

  it("refuses output that is not the requested JSON", async () => {
    for (const stdout of ["not json", '{"number":1}']) {
      const found = await listOpenPRs("/repo", ghAnswering({ stdout }));
      expect(found.ok).toBe(false);
      if (found.ok) continue;
      expect(found.error).toContain("did not return valid JSON");
    }
  });
});
