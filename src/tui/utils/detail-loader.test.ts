import { describe, expect, it } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import type { DetailResult } from "./detail-fetch";
import { createDetailLoader } from "./detail-loader";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fetch whose answers the test releases by hand. */
function controlledFetch() {
  const asked: { key: string; refresh: boolean }[] = [];
  const pending: ((result: DetailResult<string>) => void)[] = [];
  const fetch = (key: string, refresh: boolean) => {
    asked.push({ key, refresh });
    return new Promise<DetailResult<string>>((resolve) =>
      pending.push(resolve),
    );
  };
  const answer = (detail: string) => pending.shift()!({ ok: true, detail });
  return { fetch, asked, pending, answer };
}

function mount(
  fetch: (key: string, refresh: boolean) => Promise<DetailResult<string>>,
  ttlMs = 60_000,
) {
  return createRoot((dispose) => {
    const [target, setTarget] = createSignal<string | null>("a");
    const [refreshKey, setRefreshKey] = createSignal(0);
    const state = createDetailLoader({
      target,
      id: (key) => key,
      fetch,
      debounceMs: 10,
      ttlMs,
      refreshKey,
    });
    return {
      state,
      setTarget,
      refresh: () => setRefreshKey((k) => k + 1),
      dispose,
    };
  });
}

describe("createDetailLoader", () => {
  it("reads the item once the cursor rests on it", async () => {
    const gh = controlledFetch();
    const loader = mount(gh.fetch);
    expect(loader.state()).toEqual({ status: "loading" });
    expect(gh.asked).toEqual([]);
    await sleep(20);
    expect(gh.asked).toEqual([{ key: "a", refresh: false }]);
    gh.answer("A");
    await sleep(0);
    expect(loader.state()).toEqual({ status: "ready", detail: "A" });
    loader.dispose();
  });

  it("does not read rows the cursor only passes over", async () => {
    const gh = controlledFetch();
    const loader = mount(gh.fetch);
    for (const key of ["b", "c", "d"]) loader.setTarget(key);
    await sleep(20);
    expect(gh.asked.map((a) => a.key)).toEqual(["d"]);
    loader.dispose();
  });

  it("keeps one read out at a time, then reads where the cursor is now", async () => {
    const gh = controlledFetch();
    const loader = mount(gh.fetch);
    await sleep(20);
    // `a` is out. The cursor moves on twice and rests.
    loader.setTarget("b");
    await sleep(20);
    loader.setTarget("c");
    await sleep(20);
    expect(gh.asked.map((a) => a.key)).toEqual(["a"]);
    gh.answer("A");
    await sleep(0);
    // `b` was never read; `a`'s answer was not painted under `c`.
    expect(gh.asked.map((a) => a.key)).toEqual(["a", "c"]);
    expect(loader.state()).toEqual({ status: "loading" });
    gh.answer("C");
    await sleep(0);
    expect(loader.state()).toEqual({ status: "ready", detail: "C" });
    loader.dispose();
  });

  it("serves a revisited item from cache, and re-reads it on refresh", async () => {
    const gh = controlledFetch();
    const loader = mount(gh.fetch);
    await sleep(20);
    gh.answer("A");
    await sleep(0);
    loader.setTarget("b");
    await sleep(20);
    gh.answer("B");
    await sleep(0);
    loader.setTarget("a");
    expect(loader.state()).toEqual({ status: "ready", detail: "A" });
    expect(gh.asked).toHaveLength(2);

    loader.refresh();
    expect(loader.state()).toEqual({ status: "loading" });
    expect(gh.asked.at(-1)).toEqual({ key: "a", refresh: true });
    gh.answer("A2");
    await sleep(0);
    expect(loader.state()).toEqual({ status: "ready", detail: "A2" });
    loader.dispose();
  });

  it("shows a failure, and asks again when the cursor comes back", async () => {
    let calls = 0;
    const loader = mount(async () => {
      calls += 1;
      return { ok: false, error: "gh pr view exited 1" };
    });
    await sleep(20);
    expect(loader.state()).toEqual({
      status: "error",
      error: "gh pr view exited 1",
    });
    loader.setTarget("b");
    await sleep(20);
    loader.setTarget("a");
    await sleep(20);
    expect(calls).toBe(3);
    loader.dispose();
  });

  it("is idle with nothing under the cursor", async () => {
    const gh = controlledFetch();
    const loader = mount(gh.fetch);
    loader.setTarget(null);
    await sleep(20);
    expect(loader.state()).toEqual({ status: "idle" });
    expect(gh.asked).toEqual([]);
    loader.dispose();
  });
});
