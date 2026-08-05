import { describe, it, expect } from "bun:test";
import { applyTurnsKey, turnsLabel } from "./turns-selection";
import { MAX_TURNS } from "../daemon/transcript-read";

describe("turnsLabel", () => {
  it("names one turn as the response it is", () => {
    expect(turnsLabel(1)).toBe("Last response");
  });

  it("says whose prompts come along once there is more than one", () => {
    expect(turnsLabel(3)).toBe("Last 3 turns (with your prompts)");
    expect(turnsLabel(20)).toBe("Last 20 turns (with your prompts)");
  });
});

describe("applyTurnsKey", () => {
  const at = (turns: number, pendingDigit = false) => ({ turns, pendingDigit });

  it("steps with j/k and the arrows", () => {
    expect(applyTurnsKey("j", at(1))).toEqual(at(2));
    expect(applyTurnsKey("down", at(1))).toEqual(at(2));
    expect(applyTurnsKey("k", at(3))).toEqual(at(2));
    expect(applyTurnsKey("up", at(3))).toEqual(at(2));
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(applyTurnsKey("k", at(1))).toEqual(at(1));
    expect(applyTurnsKey("j", at(MAX_TURNS))).toEqual(at(MAX_TURNS));
  });

  it("drops a half-typed count when a step lands", () => {
    // `1` then `j` is 2, not a 1 still waiting for a second digit.
    expect(applyTurnsKey("j", at(1, true))).toEqual(at(2));
  });

  it("jumps straight to an unambiguous digit", () => {
    expect(applyTurnsKey("5", at(1))).toEqual(at(5));
    expect(applyTurnsKey("9", at(3))).toEqual(at(9));
  });

  it("holds a leading 1 or 2 open for a second digit", () => {
    expect(applyTurnsKey("1", at(3))).toEqual(at(1, true));
    expect(applyTurnsKey("2", at(3))).toEqual(at(2, true));
  });

  it("takes a second digit that lands inside the range", () => {
    expect(applyTurnsKey("2", at(1, true))).toEqual(at(12));
    expect(applyTurnsKey("0", at(2, true))).toEqual(at(20));
  });

  it("starts a fresh count when the second digit would overshoot", () => {
    // `2` `5` is 5, not 25.
    expect(applyTurnsKey("5", at(2, true))).toEqual(at(5));
  });

  it("swallows a bare 0 without changing the count", () => {
    expect(applyTurnsKey("0", at(4))).toEqual(at(4));
  });

  it("returns null for a key that is not the selector's", () => {
    for (const key of ["escape", "return", "tab", "x", "space"]) {
      expect(applyTurnsKey(key, at(2))).toBeNull();
    }
  });
});
