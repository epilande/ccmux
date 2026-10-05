import { describe, it, expect } from "bun:test";
import { listOpenPRs, type OpenPR } from "./pr-list";
import type { GhRun, GhRunResult } from "./gh-spawn-source";

/** A runner that answers every call with one canned result. */
function ghAnswering(result: Partial<GhRunResult>): GhRun {
  return async () => ({ exitCode: 0, stdout: "", stderr: "", ...result });
}

/** A `data.nodes` body giving each PR id the rollup state it is mapped to. */
function rollupBody(states: Record<string, string | null>): string {
  return JSON.stringify({
    data: {
      nodes: Object.entries(states).map(([id, state]) => ({
        id,
        commits: {
          nodes: [
            {
              commit: { statusCheckRollup: state === null ? null : { state } },
            },
          ],
        },
      })),
    },
  });
}

/**
 * A runner that lists `rows` for `gh pr list` and answers the CI query with
 * `ci` (by default every listed id as SUCCESS), recording every call.
 */
function ghServing(
  rows: unknown[],
  ci: Partial<GhRunResult> | ((ids: string[]) => Partial<GhRunResult>) = (
    ids,
  ) => ({
    stdout: rollupBody(Object.fromEntries(ids.map((id) => [id, "SUCCESS"]))),
  }),
): GhRun & { calls: { cwd: string; args: string[] }[] } {
  const calls: { cwd: string; args: string[] }[] = [];
  const run: GhRun = async (cwd, args) => {
    calls.push({ cwd, args });
    const answer =
      args[0] === "pr"
        ? { stdout: JSON.stringify(rows) }
        : typeof ci === "function"
          ? ci(idsOf(args))
          : ci;
    return { exitCode: 0, stdout: "", stderr: "", ...answer };
  };
  return Object.assign(run, { calls });
}

/** The ids a CI query asked about, in order. */
function idsOf(args: string[]): string[] {
  return args
    .filter((arg) => arg.startsWith("ids[]="))
    .map((arg) => arg.slice("ids[]=".length));
}

const PR_ROW = {
  id: "PR_151",
  number: 151,
  title: "Worktrees panel: open-PR list",
  url: "https://github.com/o/r/pull/151",
  author: { login: "epilande", is_bot: false },
  isDraft: false,
  reviewDecision: "APPROVED",
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
      "id",
      "number",
      "title",
      "url",
      "author",
      "isDraft",
      "reviewDecision",
      "headRefName",
      "headRefOid",
    ]) {
      expect(fields).toContain(field);
    }
    // gh expands this into every check of every PR, which on a busy repo
    // times GitHub's GraphQL endpoint out (502/504) and costs the whole list.
    expect(fields).not.toContain("statusCheckRollup");
  });

  it("asks for every listed PR's CI in one query, on the PRs' own host", async () => {
    const run = ghServing([PR_ROW, { ...PR_ROW, id: "PR_7", number: 7 }]);
    await listOpenPRs("/repo", run);

    expect(run.calls).toHaveLength(2);
    const { cwd, args } = run.calls[1]!;
    expect(cwd).toBe("/repo");
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
    // Raw fields only: `-F` would read a value starting with `@` as a file.
    expect(args).not.toContain("-F");
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    expect(query).toContain("statusCheckRollup { state }");
    expect(query).not.toContain("contexts");
    expect(idsOf(args)).toEqual(["PR_151", "PR_7"]);
  });

  // `gh api` does not take its host from the repo it runs in the way
  // `gh pr list` does, so an Enterprise checkout must name its host.
  it("sends the CI query to an Enterprise host the PR URLs name", async () => {
    const run = ghServing([
      { ...PR_ROW, url: "https://ghe.example.com/o/r/pull/151" },
    ]);
    await listOpenPRs("/repo", run);

    const args = run.calls[1]?.args ?? [];
    expect(args[args.indexOf("--hostname") + 1]).toBe("ghe.example.com");
  });

  it("makes no CI query for a repo with no open PRs", async () => {
    const run = ghServing([]);
    const found = await listOpenPRs("/repo", run);

    expect(found).toEqual({ ok: true, value: [] });
    expect(run.calls).toHaveLength(1);
  });

  it("flattens a row to what the section renders", async () => {
    const found = await listOpenPRs("/repo", ghServing([PR_ROW]));

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
    const found = await listOpenPRs("/repo", ghServing(rows));

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.map((pr) => pr.number)).toEqual([200, 42, 7]);
  });

  it("normalizes an author gh did not name, and gh's empty review decision", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghServing([{ ...PR_ROW, author: null, reviewDecision: "" }]),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.author).toBeNull();
    expect(found.value[0]?.reviewDecision).toBeNull();
  });

  it("reads a PR with no checks as `none`, never as passing", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghServing([PR_ROW], { stdout: rollupBody({ PR_151: null }) }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // An un-CI'd PR must never wear the colour of a verified one.
    expect(found.value[0]?.ciStatus).toBe("none");
  });

  it("maps every rollup state GitHub reports", async () => {
    const states: Record<string, OpenPR["ciStatus"]> = {
      SUCCESS: "passing",
      FAILURE: "failing",
      ERROR: "failing",
      PENDING: "pending",
      EXPECTED: "pending",
      // A state GitHub adds later is not evidence the checks passed.
      SOMETHING_NEW: "none",
    };
    const names = Object.keys(states);
    const found = await listOpenPRs(
      "/repo",
      ghServing(
        names.map((state, i) => ({ ...PR_ROW, id: state, number: 100 - i })),
        { stdout: rollupBody(Object.fromEntries(names.map((s) => [s, s]))) },
      ),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.map((pr) => pr.ciStatus)).toEqual(
      names.map((state) => states[state]),
    );
  });

  it("reads a PR the CI answer left out as `none`", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghServing([PR_ROW], { stdout: rollupBody({}) }),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.ciStatus).toBe("none");
  });

  // `"none"` means "no checks configured", so a failed CI query has no
  // honest status to put on a row. It fails the list, and says which step.
  it("reports a failed CI query as an error, not as unchecked PRs", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghServing([PR_ROW], {
        exitCode: 1,
        stderr: "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)",
      }),
    );

    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain("reading CI status");
    expect(found.error).toContain("gh api graphql exited 1");
    expect(found.error).toContain("502");
  });

  it("refuses a CI answer that is not the requested JSON", async () => {
    for (const stdout of ["not json", '{"data":{}}', "null"]) {
      const found = await listOpenPRs("/repo", ghServing([PR_ROW], { stdout }));
      expect(found.ok).toBe(false);
      if (found.ok) continue;
      expect(found.error).toContain("reading CI status");
      expect(found.error).toContain("did not return valid JSON");
    }
  });

  // A title travels into a TUI row and into the dialog's note, so it is
  // stripped where GitHub's text ENTERS rather than at each render. The C1
  // block matters as much as C0: a raw 0x9b is a one-byte CSI.
  it("strips control characters out of a title", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghServing([{ ...PR_ROW, title: "before\u001b[31m\u009bafter" }]),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.title).toBe("before [31m after");
  });

  /**
   * A title is written by whoever opened the PR, on a fork by anyone, and it
   * lands in a TUI row. Bidi controls make a string display as something
   * other than what it says; the invisible ones break width arithmetic.
   */
  it("strips bidi controls and invisible padding out of a title", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghServing([
        {
          ...PR_ROW,
          // RLO, PDF, an isolate pair, ZWSP, BOM and a line separator.
          title: "fix\u202egnp.txt\u202c a\u2066b\u2069c\u200bd\ufeffe\u2028f",
        },
      ]),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const title = found.value[0]?.title ?? "";
    for (const bad of [
      "\u202e",
      "\u202c",
      "\u2066",
      "\u2069",
      "\u200b",
      "\ufeff",
      "\u2028",
    ]) {
      expect(title).not.toContain(bad);
    }
    expect(title).toContain("fix");
    expect(title).toContain("gnp.txt");
  });

  /**
   * The CLASS, not a list. A hand-written set of bidi controls missed U+061C,
   * which sits alone in the Arabic block nowhere near the rest, so this asks
   * Unicode which codepoints carry `Bidi_Control` and asserts none survive.
   * A future Unicode revision adding one fails here rather than in the wild.
   */
  it("strips every codepoint Unicode calls a bidi control", async () => {
    const controls: string[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (/\p{Bidi_Control}/u.test(ch)) controls.push(ch);
    }
    expect(controls.length).toBeGreaterThan(0);

    const found = await listOpenPRs(
      "/repo",
      ghServing([{ ...PR_ROW, title: `a${controls.join("")}b` }]),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const title = found.value[0]?.title ?? "";
    expect(controls.filter((ch) => title.includes(ch))).toEqual([]);
  });

  /**
   * Deliberately KEPT. ZWNJ and ZWJ carry meaning in Persian, Arabic and
   * Indic scripts, and ZWJ is what joins an emoji sequence, so stripping them
   * corrupts titles that are merely written in another language. Neither can
   * reorder text or introduce an escape sequence.
   */
  it("keeps the zero-width joiners that are ordinary text", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghServing([
        {
          ...PR_ROW,
          title: "family \ud83d\udc68\u200d\ud83d\udc69 and \u200cnb",
        },
      ]),
    );

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value[0]?.title).toContain("\u200d");
    expect(found.value[0]?.title).toContain("\u200c");
  });

  it("drops a row it cannot identify rather than failing the whole list", async () => {
    const found = await listOpenPRs(
      "/repo",
      ghServing([
        { ...PR_ROW, number: "not a number" },
        { ...PR_ROW, url: "" },
        // Without an id the row's CI cannot be asked for.
        { ...PR_ROW, id: "" },
        PR_ROW,
      ]),
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
