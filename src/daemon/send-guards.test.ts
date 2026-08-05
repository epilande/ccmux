import { describe, it, expect } from "bun:test";
import {
  AMBIGUOUS_WAIT_ERROR,
  checkForegroundLiveness,
  defuseLeadingTrigger,
  isAmbiguousWait,
  matchesUnsafeReplyPattern,
  stripControlChars,
} from "./send-guards";

describe("checkForegroundLiveness", () => {
  it("is live for a running agent process", async () => {
    const result = await checkForegroundLiveness("%1", async () => "claude");
    expect(result).toEqual({ live: true, foreground: "claude" });
  });

  it("is not live for a bare shell", async () => {
    const result = await checkForegroundLiveness("%1", async () => "zsh");
    expect(result).toEqual({ live: false, foreground: "zsh" });
  });

  it("strips a login-shell leading dash before the shell check", async () => {
    const result = await checkForegroundLiveness("%1", async () => "-zsh");
    expect(result.live).toBe(false);
  });

  it("is not live for a terminal editor", async () => {
    const result = await checkForegroundLiveness("%1", async () => "vim");
    expect(result.live).toBe(false);
  });

  it("fails CLOSED (not live) on a null query", async () => {
    const result = await checkForegroundLiveness("%1", async () => null);
    expect(result).toEqual({ live: false, foreground: null });
  });
});

describe("matchesUnsafeReplyPattern", () => {
  it("is false when the agent defines no unsafeReplyPattern", () => {
    expect(matchesUnsafeReplyPattern("/new", undefined)).toBe(false);
  });

  it("is true when the text matches", () => {
    expect(matchesUnsafeReplyPattern("/new session", /^\/new\b/)).toBe(true);
  });

  it("is false when the text doesn't match", () => {
    expect(matchesUnsafeReplyPattern("hello", /^\/new\b/)).toBe(false);
  });

  it("resets lastIndex so a /g-flagged regex doesn't skip matches across calls", () => {
    const pattern = /^\/new\b/g;
    expect(matchesUnsafeReplyPattern("/new session", pattern)).toBe(true);
    // Without the lastIndex reset, a stateful /g regex would start this
    // second call mid-string and miss the match.
    expect(matchesUnsafeReplyPattern("/new session", pattern)).toBe(true);
  });
});

describe("defuseLeadingTrigger", () => {
  it("prefixes a leading slash with a space", () => {
    expect(defuseLeadingTrigger("/new")).toBe(" /new");
  });

  it("prefixes a leading bang with a space", () => {
    expect(defuseLeadingTrigger("!rm -rf /")).toBe(" !rm -rf /");
  });

  it("leaves ordinary text unchanged", () => {
    expect(defuseLeadingTrigger("hello world")).toBe("hello world");
  });

  it("leaves a mid-string slash/bang unchanged", () => {
    expect(defuseLeadingTrigger("hello /new")).toBe("hello /new");
  });
});

describe("isAmbiguousWait", () => {
  it("is true when ambiguousWait is set", () => {
    expect(isAmbiguousWait({ ambiguousWait: true })).toBe(true);
  });

  it("is false when ambiguousWait is false", () => {
    expect(isAmbiguousWait({ ambiguousWait: false })).toBe(false);
  });

  it("is false when ambiguousWait is undefined", () => {
    expect(isAmbiguousWait({})).toBe(false);
  });

  it("exports the refusal error message alongside the predicate", () => {
    expect(AMBIGUOUS_WAIT_ERROR).toBe(
      "Multiple sessions are waiting; press is ambiguous",
    );
  });
});

describe("stripControlChars re-export", () => {
  it("is the same implementation notify-text.ts exports", () => {
    // Sanity check on the re-export, not a re-test of the sanitizer itself
    // (that's covered by notify-context.test.ts and notification-action.test.ts).
    expect(stripControlChars("a\x1bb", {})).toBe("ab");
    expect(
      stripControlChars("a\tb\nc", { keepNewlines: true, keepTabs: true }),
    ).toBe("a\tb\nc");
  });
});
