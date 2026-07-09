import { describe, expect, it } from "bun:test";
import { isRecentlyProcessedByAny } from "./index";

describe("isRecentlyProcessedByAny", () => {
  it("returns false for an empty watcher array", () => {
    expect(isRecentlyProcessedByAny([], "s1")).toBe(false);
  });

  it("returns true when the single watcher reports true", () => {
    const watchers = [{ isRecentlyProcessed: (id: string) => id === "s1" }];
    expect(isRecentlyProcessedByAny(watchers, "s1")).toBe(true);
  });

  it("returns false when the single watcher reports false", () => {
    const watchers = [{ isRecentlyProcessed: (id: string) => id === "s1" }];
    expect(isRecentlyProcessedByAny(watchers, "s2")).toBe(false);
  });

  it("returns true when only the non-primary watcher reports true (the regression case)", () => {
    const watchers = [
      { isRecentlyProcessed: (id: string) => id === "primary-only" },
      { isRecentlyProcessed: (id: string) => id === "s1" },
    ];
    expect(isRecentlyProcessedByAny(watchers, "s1")).toBe(true);
  });

  it("returns false when neither watcher reports true for a different id", () => {
    const watchers = [
      { isRecentlyProcessed: (id: string) => id === "primary-only" },
      { isRecentlyProcessed: (id: string) => id === "s1" },
    ];
    expect(isRecentlyProcessedByAny(watchers, "s2")).toBe(false);
  });
});
