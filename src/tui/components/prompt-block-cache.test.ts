import { describe, it, expect } from "bun:test";
import { createPromptBlockCache } from "./prompt-block-cache";

const TEXT =
  "Please refactor the upload queue so retried jobs go back to the end " +
  "of the pending pool before the next scheduler tick runs.";

describe("prompt block cache", () => {
  it("hands back the same array for an unchanged session", () => {
    const cache = createPromptBlockCache();
    const first = cache.lines("a", TEXT, 30, 3);
    const second = cache.lines("a", TEXT, 30, 3);
    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(1);
  });

  it("keeps sessions apart", () => {
    const cache = createPromptBlockCache();
    const a = cache.lines("a", TEXT, 30, 3);
    const b = cache.lines("b", "something else entirely", 30, 3);
    expect(b).not.toBe(a);
    expect(cache.lines("a", TEXT, 30, 3)).toBe(a);
    expect(cache.size).toBe(2);
  });

  it("re-wraps when the prompt changes", () => {
    const cache = createPromptBlockCache();
    const first = cache.lines("a", TEXT, 30, 3);
    const second = cache.lines(
      "a",
      "A wholly different prompt about logs",
      30,
      3,
    );
    expect(second).not.toBe(first);
    expect(second).not.toEqual(first);
    expect(cache.lines("a", TEXT, 30, 3)).not.toBe(first);
  });

  it("re-wraps when the width changes", () => {
    const cache = createPromptBlockCache();
    const narrow = cache.lines("a", TEXT, 20, 4);
    const wide = cache.lines("a", TEXT, 50, 4);
    expect(wide).not.toBe(narrow);
    expect(wide).not.toEqual(narrow);
  });

  it("re-wraps when the line cap changes", () => {
    const cache = createPromptBlockCache();
    const two = cache.lines("a", TEXT, 30, 2);
    const four = cache.lines("a", TEXT, 30, 4);
    expect(four).not.toBe(two);
    expect(two.length).toBe(2);
    expect(four.length).toBe(4);
  });

  it("evicts sessions that left the list", () => {
    const cache = createPromptBlockCache();
    const a = cache.lines("a", TEXT, 30, 3);
    cache.lines("b", TEXT, 30, 3);
    cache.lines("c", TEXT, 30, 3);
    expect(cache.size).toBe(3);

    cache.retain(["a"]);
    expect(cache.size).toBe(1);
    // The survivor keeps its identity; the evicted one is wrapped afresh.
    expect(cache.lines("a", TEXT, 30, 3)).toBe(a);
    expect(cache.lines("b", TEXT, 30, 3)).not.toBe(a);
  });

  it("empties completely when the list does", () => {
    const cache = createPromptBlockCache();
    cache.lines("a", TEXT, 30, 3);
    cache.retain([]);
    expect(cache.size).toBe(0);
  });
});
