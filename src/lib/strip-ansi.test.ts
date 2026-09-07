import { describe, it, expect } from "bun:test";
import { stripAnsi, stripTerminalNoise } from "./strip-ansi";

describe("stripAnsi", () => {
  it("removes color codes", () => {
    expect(stripAnsi("\x1B[31mred\x1B[0m")).toBe("red");
  });

  it("removes multiple codes", () => {
    expect(stripAnsi("\x1B[1m\x1B[32mbold green\x1B[0m")).toBe("bold green");
  });

  it("passes through plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("removes SGR codes with multiple parameters", () => {
    expect(stripAnsi("\x1B[38;5;196mcolor\x1B[0m")).toBe("color");
  });

  it("removes private-mode CSI such as cursor hide and show", () => {
    expect(stripAnsi("\x1B[?25lhidden\x1B[?25h")).toBe("hidden");
  });

  it("removes an OSC 8 hyperlink terminated by BEL", () => {
    expect(stripAnsi("\x1B]8;;https://example.com\x07link\x1B]8;;\x07")).toBe(
      "link",
    );
  });

  it("removes an OSC terminated by ST", () => {
    expect(stripAnsi("\x1B]0;window title\x1B\\after")).toBe("after");
  });

  it("leaves an unterminated OSC and the text after it intact", () => {
    // The body excludes ESC and BEL and never runs to end-of-input, so
    // nothing matches and the rest of the line is not eaten.
    expect(stripAnsi("\x1B]8;;https://example.com and more")).toBe(
      "\x1B]8;;https://example.com and more",
    );
  });

  it("leaves the character after a lone ESC alone", () => {
    // Two-byte `ESC <char>` is not matched on purpose: consuming the byte
    // would weld `scroll` and `math` into one word. The caller's control
    // sweep turns the surviving ESC into a separator.
    expect(stripAnsi("scroll\x1Bmath")).toBe("scroll\x1Bmath");
  });
});

describe("stripTerminalNoise", () => {
  it("removes escape sequences and collapses what is left", () => {
    expect(
      stripTerminalNoise(
        "  \x1B[?25l\x1B]8;;https://example.com\x07LINKED\x1B]8;;\x07 " +
          "\x1B[32mgreen\x1B[0m   file\x1B[?25h  ",
      ),
    ).toBe("LINKED green file");
  });

  it("turns a stray control byte into a separator, not a weld", () => {
    // A BEL, a lone ESC and a C1 byte (U+0085 NEL, which JS `\s` does not
    // match) each become a space, so the words stay apart.
    expect(stripTerminalNoise("Fix\x07the\x85scroll\x1Bmath")).toBe(
      "Fix the scroll math",
    );
  });

  it("reduces text that is nothing but noise to the empty string", () => {
    expect(stripTerminalNoise("\x1B[2J\x1B[H \t\n\x07")).toBe("");
  });
});
