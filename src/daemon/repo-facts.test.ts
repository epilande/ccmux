import { describe, expect, it } from "bun:test";
import { RepoFactsCache } from "./repo-facts";
import type { WorktreeRepo } from "./worktree-list";
import type { OpenPR } from "./pr-list";
import type { SourceResult } from "./gh-spawn-source";

const repo: WorktreeRepo = {
  repoRoot: "/repo",
  repoName: "repo",
  worktrees: [],
};
const pr: OpenPR = {
  number: 2,
  title: "change",
  url: "https://github.com/o/r/pull/2",
  author: "dev",
  isDraft: false,
  reviewDecision: null,
  ciStatus: "passing",
  headRefName: "feature",
  headRefOid: "abc",
};
const failed = { ok: false as const, error: "gh unavailable" };
function harness() {
  let now = 0;
  let enabled = true;
  let answer: SourceResult<OpenPR[]> = { ok: true, value: [pr] };
  const calls = { local: 0, prs: 0, issues: 0 };
  const cache = new RepoFactsCache({
    now: () => now,
    roots: async () => ["/repo"],
    headerPR: async () => enabled,
    local: async () => {
      calls.local++;
      return repo;
    },
    prs: async () => {
      calls.prs++;
      return answer;
    },
    issues: async () => {
      calls.issues++;
      return { ok: true, value: [] };
    },
  });
  return {
    cache,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    fail: () => {
      answer = failed;
    },
    succeed: () => {
      answer = { ok: true, value: [] };
    },
    disable: () => {
      enabled = false;
    },
  };
}
describe("repo facts", () => {
  it("has no value or stale marker before any lookup succeeds", async () => {
    const h = harness();
    h.fail();
    await h.cache.refresh(["/repo"]);
    expect(h.cache.snapshot(["/repo"])[0]?.prs).toBeUndefined();
    expect(h.cache.snapshot(["/repo"])[0]?.worktrees?.value).toEqual(repo);
  });
  it("retains a successful value as stale after a failure, and recovers to zero", async () => {
    const h = harness();
    await h.cache.refresh(["/repo"]);
    h.fail();
    h.advance(60_001);
    await h.cache.refresh(["/repo"]);
    expect(h.cache.snapshot(["/repo"])[0]?.prs).toEqual({
      value: [pr],
      updatedAt: 0,
      stale: true,
    });
    h.succeed();
    h.advance(60_001);
    await h.cache.refresh(["/repo"]);
    expect(h.cache.snapshot(["/repo"])[0]?.prs?.value).toEqual([]);
    expect(h.cache.snapshot(["/repo"])[0]?.prs?.stale).toBe(false);
  });
  it("joins concurrent refreshes and throttles key repeat", async () => {
    const h = harness();
    await Promise.all([
      h.cache.refresh(["/repo"], true),
      h.cache.refresh(["/repo"], true),
    ]);
    expect(h.calls.prs).toBe(1);
    await h.cache.refresh(["/repo"], true);
    expect(h.calls.prs).toBe(1);
    h.advance(2_001);
    await h.cache.refresh(["/repo"], true);
    expect(h.calls.prs).toBe(2);
  });
  it("keeps ordinary reads fresh until the timer interval", async () => {
    const h = harness();
    await h.cache.refresh(["/repo"]);
    h.advance(20_000);
    await h.cache.refresh(["/repo"]);
    expect(h.calls.local).toBe(1);
    h.advance(40_001);
    await h.cache.refresh(["/repo"]);
    expect(h.calls.local).toBe(2);
  });
  it("disables background GitHub lookups while allowing Start to request sources", async () => {
    const h = harness();
    h.disable();
    await h.cache.refresh(["/repo"]);
    expect(h.calls).toEqual({ local: 1, prs: 0, issues: 0 });
    await h.cache.refresh(["/repo"], false, true);
    expect(h.calls).toEqual({ local: 1, prs: 1, issues: 1 });
  });
  it("publishes the local answer while GitHub is still pending", async () => {
    let resolve!: (answer: SourceResult<OpenPR[]>) => void;
    const pending = new Promise<SourceResult<OpenPR[]>>((done) => {
      resolve = done;
    });
    const cache = new RepoFactsCache({
      roots: async () => ["/repo"],
      headerPR: async () => true,
      local: async () => repo,
      prs: () => pending,
      issues: async () => failed,
    });
    const load = cache.refresh(["/repo"]);
    await new Promise((done) => setTimeout(done, 0));
    expect(cache.snapshot(["/repo"])[0]?.worktrees?.value).toEqual(repo);
    expect(cache.snapshot(["/repo"])[0]?.prs).toBeUndefined();
    resolve({ ok: true, value: [pr] });
    await load;
    expect(cache.snapshot(["/repo"])[0]?.prs?.value).toEqual([pr]);
  });
  it("refreshes on the timer and stops on shutdown", async () => {
    let calls = 0;
    const cache = new RepoFactsCache(
      {
        roots: async () => ["/repo"],
        headerPR: async () => false,
        local: async () => {
          calls++;
          return repo;
        },
        prs: async () => failed,
        issues: async () => failed,
      },
      10,
    );
    cache.start();
    try {
      await new Promise((done) => setTimeout(done, 45));
      expect(calls).toBeGreaterThan(1);
    } finally {
      cache.stop();
    }
    const stopped = calls;
    await new Promise((done) => setTimeout(done, 30));
    expect(calls).toBe(stopped);
  });
});
