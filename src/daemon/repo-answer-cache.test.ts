import { describe, it, expect } from "bun:test";
import { RepoAnswerCache } from "./repo-answer-cache";
import type { SourceResult } from "./gh-spawn-source";

const TTL = 60_000;
const FAILURE_TTL = 15_000;

function cache(): RepoAnswerCache<string> {
  return new RepoAnswerCache<string>({
    ttlMs: TTL,
    failureTtlMs: FAILURE_TTL,
  });
}

/** A fetch that counts its calls and answers with whatever it is handed. */
function counting(...results: SourceResult<string>[]) {
  let calls = 0;
  const fetch = (): Promise<SourceResult<string>> => {
    const result = results[Math.min(calls, results.length - 1)]!;
    calls += 1;
    return Promise.resolve(result);
  };
  return { fetch, calls: () => calls };
}

const ok = (value: string): SourceResult<string> => ({ ok: true, value });
const bad = (error: string): SourceResult<string> => ({ ok: false, error });

/**
 * Age the settled entry by rewriting the timestamp the TTL is measured from,
 * which is exactly what the seam exists for: a boundary is reached without
 * waiting for it.
 */
function age(
  subject: RepoAnswerCache<string>,
  repo: string,
  byMs: number,
): void {
  const entry = subject.entries.get(repo);
  if (!entry?.done) throw new Error("entry has not settled");
  entry.done.at -= byMs;
}

describe("RepoAnswerCache", () => {
  it("serves a fresh success without calling fetch again", async () => {
    const subject = cache();
    const source = counting(ok("first"), ok("second"));

    await subject.answer("/repo", false, source.fetch);
    const again = await subject.answer("/repo", false, source.fetch);

    expect(again).toEqual(ok("first"));
    expect(source.calls()).toBe(1);
  });

  it("calls again once the success TTL has passed", async () => {
    const subject = cache();
    const source = counting(ok("first"), ok("second"));

    await subject.answer("/repo", false, source.fetch);
    age(subject, "/repo", TTL);
    const again = await subject.answer("/repo", false, source.fetch);

    expect(again).toEqual(ok("second"));
    expect(source.calls()).toBe(2);
  });

  it("caches per repo, so one repo's answer never serves another", async () => {
    const subject = cache();
    const source = counting(ok("a"), ok("b"));

    const first = await subject.answer("/a", false, source.fetch);
    const second = await subject.answer("/b", false, source.fetch);

    expect(first).toEqual(ok("a"));
    expect(second).toEqual(ok("b"));
    expect(source.calls()).toBe(2);
  });

  it("registers the entry before the first await, so a same-tick caller joins", async () => {
    const subject = cache();
    let calls = 0;
    let release: (result: SourceResult<string>) => void = () => {};
    const fetch = (): Promise<SourceResult<string>> => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };

    // Both callers start in the SAME tick, which is the case the registration
    // ordering exists for: nothing has settled and nothing has been awaited.
    const first = subject.answer("/repo", false, fetch);
    const second = subject.answer("/repo", false, fetch);
    expect(calls).toBe(1);
    expect(second).toBe(first);

    release(ok("shared"));
    expect(await first).toEqual(ok("shared"));
    expect(await second).toEqual(ok("shared"));
  });

  it("joins an in-flight call rather than racing a refresh against it", async () => {
    const subject = cache();
    let calls = 0;
    let release: (result: SourceResult<string>) => void = () => {};
    const fetch = (): Promise<SourceResult<string>> => {
      calls += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };

    const first = subject.answer("/repo", false, fetch);
    // The refresh arrives while the first call is still running. It must JOIN:
    // a second `gh` here would be two calls for one repo, and the slow one
    // could land after the fast one and stamp its stale answer fresh.
    const refreshed = subject.answer("/repo", true, fetch);
    expect(calls).toBe(1);
    expect(refreshed).toBe(first);

    release(ok("shared"));
    await first;
  });

  it("lets a refresh bypass a fresh success", async () => {
    const subject = cache();
    const source = counting(ok("stale"), ok("fresh"));

    await subject.answer("/repo", false, source.fetch);
    const again = await subject.answer("/repo", true, source.fetch);

    expect(again).toEqual(ok("fresh"));
    expect(source.calls()).toBe(2);
  });

  it("refuses to let a refresh bypass a fresh FAILURE", async () => {
    const subject = cache();
    const source = counting(bad("gh: not logged in"), ok("recovered"));

    await subject.answer("/repo", false, source.fetch);
    const again = await subject.answer("/repo", true, source.fetch);

    // Key-repeat on a refresh key must not serial-spawn one doomed call per
    // press. The held failure is what makes that free.
    expect(again).toEqual(bad("gh: not logged in"));
    expect(source.calls()).toBe(1);
  });

  it("holds a failure for the failure TTL, not the success TTL", async () => {
    const subject = cache();
    const source = counting(bad("gh: not logged in"), ok("recovered"));

    await subject.answer("/repo", false, source.fetch);
    // Past the failure window but well inside the success one: a failure that
    // inherited the success TTL would still be served here.
    age(subject, "/repo", FAILURE_TTL);
    const again = await subject.answer("/repo", false, source.fetch);

    expect(again).toEqual(ok("recovered"));
    expect(source.calls()).toBe(2);
  });

  it("still holds a failure inside its own window", async () => {
    const subject = cache();
    const source = counting(bad("gh: not logged in"), ok("recovered"));

    await subject.answer("/repo", false, source.fetch);
    age(subject, "/repo", FAILURE_TTL - 1);
    const again = await subject.answer("/repo", false, source.fetch);

    expect(again).toEqual(bad("gh: not logged in"));
    expect(source.calls()).toBe(1);
  });

  it("drops the entry when a fetch throws, so the repo cannot wedge in flight", async () => {
    const subject = cache();
    let calls = 0;
    const fetch = (): Promise<SourceResult<string>> => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("unforeseen"))
        : Promise.resolve(ok("recovered"));
    };

    await expect(subject.answer("/repo", false, fetch)).rejects.toThrow(
      "unforeseen",
    );
    expect(subject.entries.has("/repo")).toBe(false);

    // The next caller gets a real call rather than the rejected promise for
    // the daemon's whole life.
    expect(await subject.answer("/repo", false, fetch)).toEqual(
      ok("recovered"),
    );
    expect(calls).toBe(2);
  });

  it("leaves a newer entry alone when an older call throws late", async () => {
    const subject = cache();
    let reject: (err: Error) => void = () => {};
    const slow = (): Promise<SourceResult<string>> =>
      new Promise((_resolve, rejectIt) => {
        reject = rejectIt;
      });

    const first = subject.answer("/repo", false, slow);
    first.catch(() => {});
    // Force the entry to look settled-and-stale so the next call replaces it
    // rather than joining, then let the ORIGINAL call fail.
    const entry = subject.entries.get("/repo")!;
    entry.done = { at: Date.now() - TTL, result: ok("placeholder") };
    const second = await subject.answer("/repo", false, () =>
      Promise.resolve(ok("second")),
    );
    reject(new Error("late failure"));
    await Promise.resolve();

    expect(second).toEqual(ok("second"));
    expect(subject.entries.get("/repo")?.done?.result).toEqual(ok("second"));
  });
});
