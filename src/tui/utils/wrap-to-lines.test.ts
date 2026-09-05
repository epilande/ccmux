import { describe, expect, it } from "bun:test";
import { displayWidth, wrapText, wrapToLines } from "./format";

describe("wrapToLines", () => {
  it("returns every line when the text fits inside the cap", () => {
    expect(wrapToLines("one two three", 9, 3)).toEqual(["one two", "three"]);
  });

  it("caps the line count and marks the clip", () => {
    const lines = wrapToLines("alpha beta gamma delta epsilon", 11, 2);
    expect(lines).toHaveLength(2);
    expect(lines[lines.length - 1].endsWith("…")).toBe(true);
  });

  it("never exceeds the column width, ellipsis included", () => {
    const width = 12;
    for (const max of [1, 2, 3]) {
      for (const line of wrapToLines(
        "supercalifragilistic expialidocious and then some more words",
        width,
        max,
      )) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("does not mark a block that happens to end exactly at the cap", () => {
    const lines = wrapToLines("one two", 4, 2);
    expect(lines).toEqual(["one", "two"]);
  });

  it("keeps wide glyphs inside the column when clipping", () => {
    const lines = wrapToLines("日本語 のテキスト がここに あります よ", 8, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(8);
  });

  it("yields nothing to render for empty input or a zero cap", () => {
    expect(wrapToLines("", 20, 3)).toEqual([]);
    expect(wrapToLines("something", 20, 0)).toEqual([]);
    expect(wrapToLines("something", 0, 3)).toEqual([]);
  });

  it("caps a multi-KB prompt without wrapping the whole thing", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
    const lines = wrapToLines(huge, 40, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("\u2026");
  });
});

describe("wrapText maxLines", () => {
  // The early exit must be a pure optimization: capping at k has to give
  // exactly the first k lines of the uncapped wrap, or a block's height and
  // its content would depend on which path produced it.
  const cases: Array<[string, string, number]> = [
    ["ordinary words", "one two three four five six seven eight nine", 9],
    [
      "a word longer than the column",
      "short supercalifragilisticexpialidocious tail words here",
      8,
    ],
    ["wide glyphs", "\u65e5\u672c\u8a9e \u306e\u30c6\u30ad\u30b9\u30c8 \u304c\u3053\u3053\u306b \u3042\u308a\u307e\u3059 \u3088", 8],
    ["a single unbreakable cluster", "\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8", 1],
  ];

  for (const [name, text, width] of cases) {
    it(`matches the uncapped wrap's prefix for ${name}`, () => {
      const full = wrapText(text, width);
      for (let k = 1; k <= full.length + 1; k++) {
        expect(wrapText(text, width, k)).toEqual(full.slice(0, k));
      }
    });
  }

  it("wraps everything when no cap is given", () => {
    const text = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" ");
    expect(wrapText(text, 10, undefined)).toEqual(wrapText(text, 10));
  });
});
