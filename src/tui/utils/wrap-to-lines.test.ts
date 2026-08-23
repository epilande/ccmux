import { describe, expect, it } from "bun:test";
import { displayWidth, wrapToLines } from "./format";

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
});
