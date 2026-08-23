import { describe, expect, it } from "bun:test";
import { paneTitleText } from "./session-columns";

describe("paneTitleText", () => {
  it("strips the idle glyph Claude Code prefixes its summary with", () => {
    expect(paneTitleText("✳ Add dark mode toggle to settings")).toBe(
      "Add dark mode toggle to settings",
    );
  });

  it("strips the braille spinner shown while working", () => {
    expect(paneTitleText("⠂ cache-invalidation-fix")).toBe(
      "cache-invalidation-fix",
    );
    expect(paneTitleText("⣾ Fix pagination off-by-one")).toBe(
      "Fix pagination off-by-one",
    );
  });

  it("keeps a title that has no glyph", () => {
    expect(paneTitleText("Mac")).toBe("Mac");
  });

  it("yields empty for nothing displayable", () => {
    expect(paneTitleText(null)).toBe("");
    expect(paneTitleText("")).toBe("");
    expect(paneTitleText("✳ ")).toBe("");
  });

  it("does not eat a leading digit or punctuation inside the summary", () => {
    expect(paneTitleText("✳ 3 failing tests in parser/")).toBe(
      "3 failing tests in parser/",
    );
  });
});
