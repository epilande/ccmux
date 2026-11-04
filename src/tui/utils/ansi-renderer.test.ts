import { describe, it, expect } from "bun:test";
import { StyledText, RGBA, TextAttributes } from "@opentui/core";
import type { TextChunk } from "@opentui/core";
import { highlightSearchMatches, parseAnsiToStyledText } from "./ansi-renderer";

/** Read a chunk color back as [r, g, b] ints (0-255) for readable assertions. */
function rgb(color: RGBA | undefined): [number, number, number] | undefined {
  if (!color) return undefined;
  const [r, g, b] = color.toInts();
  return [r, g, b];
}

function makeChunk(text: string, fg?: string): TextChunk {
  return {
    __isChunk: true as const,
    text,
    fg: fg ? RGBA.fromHex(fg) : undefined,
  };
}

function texts(styled: StyledText): string[] {
  return styled.chunks.map((c) => c.text);
}

function hasBg(chunk: TextChunk): boolean {
  return chunk.bg !== undefined;
}

describe("highlightSearchMatches", () => {
  it("returns original when query is empty", () => {
    const styled = new StyledText([makeChunk("hello world")]);
    const result = highlightSearchMatches(styled, "", "#313244");
    expect(texts(result)).toEqual(["hello world"]);
  });

  it("highlights a single match", () => {
    const styled = new StyledText([makeChunk("hello error world")]);
    const result = highlightSearchMatches(styled, "error", "#313244");

    expect(texts(result)).toEqual(["hello ", "error", " world"]);
    expect(hasBg(result.chunks[0])).toBe(false);
    expect(hasBg(result.chunks[1])).toBe(true);
    expect(hasBg(result.chunks[2])).toBe(false);
  });

  it("is case-insensitive", () => {
    const styled = new StyledText([makeChunk("Hello ERROR World")]);
    const result = highlightSearchMatches(styled, "error", "#313244");

    expect(texts(result)).toEqual(["Hello ", "ERROR", " World"]);
    expect(hasBg(result.chunks[1])).toBe(true);
  });

  it("highlights multiple matches in same chunk", () => {
    const styled = new StyledText([makeChunk("error one error two")]);
    const result = highlightSearchMatches(styled, "error", "#313244");

    expect(texts(result)).toEqual(["error", " one ", "error", " two"]);
    expect(hasBg(result.chunks[0])).toBe(true);
    expect(hasBg(result.chunks[1])).toBe(false);
    expect(hasBg(result.chunks[2])).toBe(true);
    expect(hasBg(result.chunks[3])).toBe(false);
  });

  it("highlights across multiple chunks", () => {
    const styled = new StyledText([
      makeChunk("no match here", "#ff0000"),
      makeChunk("found error here", "#00ff00"),
    ]);
    const result = highlightSearchMatches(styled, "error", "#313244");

    expect(texts(result)).toEqual([
      "no match here",
      "found ",
      "error",
      " here",
    ]);
    // First chunk unchanged
    expect(hasBg(result.chunks[0])).toBe(false);
    // Match chunk has bg
    expect(hasBg(result.chunks[2])).toBe(true);
  });

  it("preserves original fg color on highlighted chunks", () => {
    const styled = new StyledText([makeChunk("has error", "#ff0000")]);
    const result = highlightSearchMatches(styled, "error", "#313244");

    // The highlighted chunk should keep its original fg
    const matchChunk = result.chunks[1];
    expect(matchChunk.fg).toBeDefined();
  });

  it("handles match at start of text", () => {
    const styled = new StyledText([makeChunk("error at start")]);
    const result = highlightSearchMatches(styled, "error", "#313244");

    expect(texts(result)).toEqual(["error", " at start"]);
    expect(hasBg(result.chunks[0])).toBe(true);
  });

  it("handles match at end of text", () => {
    const styled = new StyledText([makeChunk("ends with error")]);
    const result = highlightSearchMatches(styled, "error", "#313244");

    expect(texts(result)).toEqual(["ends with ", "error"]);
    expect(hasBg(result.chunks[1])).toBe(true);
  });

  it("handles no matches", () => {
    const styled = new StyledText([makeChunk("nothing here")]);
    const result = highlightSearchMatches(styled, "missing", "#313244");

    expect(texts(result)).toEqual(["nothing here"]);
    expect(hasBg(result.chunks[0])).toBe(false);
  });
});

describe("parseAnsiToStyledText", () => {
  function only(input: string): TextChunk {
    const chunks = parseAnsiToStyledText(input).chunks;
    expect(chunks.length).toBe(1);
    return chunks[0]!;
  }

  it("maps the basic 16 colors to the Catppuccin palette, not Anser's VGA defaults", () => {
    // Anser's default would be 187,0,0 / 0,187,0; the themed palette is vivid.
    expect(rgb(only("\x1b[31mred\x1b[0m").fg)).toEqual([243, 139, 168]);
    expect(rgb(only("\x1b[32mgreen\x1b[0m").fg)).toEqual([166, 227, 161]);
    expect(rgb(only("\x1b[34mblue\x1b[0m").fg)).toEqual([137, 180, 250]);
  });

  it("maps bright colors (90-97) through the bright half of the palette", () => {
    expect(rgb(only("\x1b[90mbright black\x1b[0m").fg)).toEqual([88, 91, 112]);
    expect(rgb(only("\x1b[97mbright white\x1b[0m").fg)).toEqual([
      166, 173, 200,
    ]);
  });

  it("maps background colors too", () => {
    const chunk = only("\x1b[41mon red\x1b[0m");
    expect(rgb(chunk.bg)).toEqual([243, 139, 168]);
    expect(chunk.fg).toBeUndefined();
  });

  it("computes the 256-color cube via the standard xterm formula", () => {
    // 196 = pure red, 208 = orange, 16 = black corner of the cube.
    expect(rgb(only("\x1b[38;5;196mx\x1b[0m").fg)).toEqual([255, 0, 0]);
    expect(rgb(only("\x1b[38;5;208mx\x1b[0m").fg)).toEqual([255, 135, 0]);
    expect(rgb(only("\x1b[38;5;16mx\x1b[0m").fg)).toEqual([0, 0, 0]);
  });

  it("computes the 256-color grayscale ramp", () => {
    expect(rgb(only("\x1b[38;5;232mx\x1b[0m").fg)).toEqual([8, 8, 8]);
    expect(rgb(only("\x1b[38;5;255mx\x1b[0m").fg)).toEqual([238, 238, 238]);
  });

  it("passes truecolor through exactly", () => {
    expect(rgb(only("\x1b[38;2;255;128;0mx\x1b[0m").fg)).toEqual([255, 128, 0]);
  });

  it("leaves default (uncolored) text without an fg", () => {
    expect(only("plain").fg).toBeUndefined();
  });

  it("applies reverse video by swapping fg/bg (Anser pre-swaps)", () => {
    // \x1b[31m\x1b[7m -> red moves to bg, default(black) to fg.
    const chunk = only("\x1b[31m\x1b[7mx\x1b[0m");
    expect(rgb(chunk.bg)).toEqual([243, 139, 168]);
    expect(rgb(chunk.fg)).toEqual([69, 71, 90]);
  });

  it("maps text decorations to attributes", () => {
    // Anser keeps only the last decoration per chunk, so assert each alone.
    expect(only("\x1b[1mbold\x1b[0m").attributes! & TextAttributes.BOLD).toBe(
      TextAttributes.BOLD,
    );
    expect(only("\x1b[2mdim\x1b[0m").attributes! & TextAttributes.DIM).toBe(
      TextAttributes.DIM,
    );
    expect(
      only("\x1b[3mitalic\x1b[0m").attributes! & TextAttributes.ITALIC,
    ).toBe(TextAttributes.ITALIC);
    expect(
      only("\x1b[4munderline\x1b[0m").attributes! & TextAttributes.UNDERLINE,
    ).toBe(TextAttributes.UNDERLINE);
  });

  it("maps multiple chunks with per-chunk colors", () => {
    const styled = parseAnsiToStyledText(
      "\x1b[31mred\x1b[0m plain \x1b[32mgreen\x1b[0m",
    );
    expect(styled.chunks.map((c) => c.text)).toEqual([
      "red",
      " plain ",
      "green",
    ]);
    expect(rgb(styled.chunks[0]!.fg)).toEqual([243, 139, 168]);
    expect(styled.chunks[1]!.fg).toBeUndefined();
    expect(rgb(styled.chunks[2]!.fg)).toEqual([166, 227, 161]);
  });
});
