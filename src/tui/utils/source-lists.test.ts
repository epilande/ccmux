import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { fetchOpenIssues, fetchOpenPRs } from "./source-lists";

let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  // `spyOn` + `mockRestore`, never `mock.module`, which leaks across files.
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

/** Records every URL asked for and answers each with `body`. */
function stubFetch(body: unknown, init: ResponseInit = {}) {
  const requested: string[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: unknown,
  ) => {
    requested.push(String(input));
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      ...init,
    });
  }) as unknown as typeof fetch);
  return requested;
}

/** The query part of the one URL that was asked for. */
function paramsOf(requested: string[]): URLSearchParams {
  expect(requested).toHaveLength(1);
  return new URL(requested[0]!).searchParams;
}

describe("fetchOpenPRs", () => {
  it("asks /prs and normalizes the answer", async () => {
    const requested = stubFetch({
      repos: [{ repoRoot: "/r", repoName: "r", prs: [] }],
      errors: [],
    });
    const answer = await fetchOpenPRs({ repo: "/r" });

    expect(new URL(requested[0]!).pathname).toBe("/prs");
    expect(answer.repos[0]?.repoName).toBe("r");
  });

  it("fills in fields an older daemon did not send", async () => {
    stubFetch({});
    // The daemon is a long-lived process that may predate this build, so a
    // partial body must read as empty rather than crash the surface.
    expect(await fetchOpenPRs({ repo: null })).toEqual({
      repos: [],
      errors: [],
    });
  });
});

describe("fetchOpenIssues", () => {
  it("asks /issues and normalizes the answer", async () => {
    const requested = stubFetch({
      repos: [{ repoRoot: "/r", repoName: "r", issues: [] }],
      errors: [],
    });
    const answer = await fetchOpenIssues({ repo: "/r" });

    expect(new URL(requested[0]!).pathname).toBe("/issues");
    expect(answer.repos[0]?.repoName).toBe("r");
  });

  it("fills in fields an older daemon did not send", async () => {
    stubFetch({});
    expect(await fetchOpenIssues({ repo: null })).toEqual({
      repos: [],
      errors: [],
    });
  });
});

describe("the scope both lists take", () => {
  // The same knobs `GET /worktrees` and the prune scan take, because a
  // surface merges all of them into one list and a repo one read can see and
  // another cannot is a section attached to nothing.
  it("sends repo and cwd, and cwd is additive rather than a replacement", async () => {
    const requested = stubFetch({ repos: [], errors: [] });
    await fetchOpenPRs({ repo: "/main", cwd: "/elsewhere" });

    const params = paramsOf(requested);
    expect(params.get("repo")).toBe("/main");
    expect(params.get("cwd")).toBe("/elsewhere");
  });

  it("omits an unscoped repo rather than sending an empty one", async () => {
    const requested = stubFetch({ repos: [], errors: [] });
    await fetchOpenIssues({ repo: null });

    // `repo=` would scope to a repo named "", which resolves to nothing at
    // all — the opposite of the "every known repo" this means.
    expect(paramsOf(requested).has("repo")).toBe(false);
  });

  it("sends refresh only when asked", async () => {
    const requested = stubFetch({ repos: [], errors: [] });
    await fetchOpenPRs({ repo: "/r" });
    expect(paramsOf(requested).has("refresh")).toBe(false);

    const refreshed = stubFetch({ repos: [], errors: [] });
    await fetchOpenPRs({ repo: "/r", refresh: true });
    expect(paramsOf(refreshed).get("refresh")).toBe("1");
  });
});

describe("failures", () => {
  /**
   * A 404 is the FIRST-RUN state for every existing user, whose daemon
   * predates the endpoint until they restart it, so its message has to name
   * the fix rather than the status code.
   */
  it("throws a message naming the fix when the daemon does not know the route", async () => {
    stubFetch({}, { status: 404 });
    await expect(fetchOpenIssues({ repo: "/r" })).rejects.toThrow(
      "ccmux daemon restart",
    );
  });

  it("throws on any other non-OK status", async () => {
    stubFetch({}, { status: 500 });
    await expect(fetchOpenPRs({ repo: "/r" })).rejects.toThrow("HTTP 500");
  });

  // A per-REPO failure is deliberately NOT one of these: it rides inside a
  // 200 so one broken checkout costs its own section and not the whole read.
  it("resolves when a repo failed but the request did not", async () => {
    stubFetch({
      repos: [],
      errors: [{ repoRoot: "/r", repoName: "r", error: "gh: not logged in" }],
    });
    const answer = await fetchOpenIssues({ repo: "/r" });

    expect(answer.errors[0]?.error).toContain("not logged in");
  });
});
