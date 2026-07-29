import { describe, expect, it } from "bun:test";
import { parseSelection } from "./worktree";

describe("parseSelection", () => {
  it("accepts single numbers and comma lists", () => {
    expect(parseSelection("1", 3)).toEqual([0]);
    expect(parseSelection("1,3", 3)).toEqual([0, 2]);
    expect(parseSelection("3 1", 3)).toEqual([0, 2]);
  });

  it("accepts ranges and de-duplicates overlaps", () => {
    expect(parseSelection("1-3", 3)).toEqual([0, 1, 2]);
    expect(parseSelection("1-2,2,3", 3)).toEqual([0, 1, 2]);
  });

  it("accepts 'a' and 'all' for everything", () => {
    expect(parseSelection("a", 2)).toEqual([0, 1]);
    expect(parseSelection("ALL", 2)).toEqual([0, 1]);
  });

  it("cancels on empty input", () => {
    expect(parseSelection("", 3)).toBeNull();
    expect(parseSelection("   ", 3)).toBeNull();
  });

  // A typo must cancel the whole run rather than resolve to some other
  // worktree: this selection drives directory deletion.
  it("rejects out-of-range, reversed and non-numeric input", () => {
    expect(parseSelection("4", 3)).toBeNull();
    expect(parseSelection("0", 3)).toBeNull();
    expect(parseSelection("1-9", 3)).toBeNull();
    expect(parseSelection("3-1", 3)).toBeNull();
    expect(parseSelection("y", 3)).toBeNull();
    expect(parseSelection("1,x", 3)).toBeNull();
  });
});
