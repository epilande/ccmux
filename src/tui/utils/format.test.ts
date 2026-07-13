import { describe, it, expect } from "bun:test";
import { formatSubagentName, formatVersion, truncateText, truncateHighlighted } from "./format";

/** Visible length: markup tags and ellipsis affixes excluded. */
const visibleLen = (s: string) =>
  s.replace(/<\/?b>/g, "").replace(/…/g, "").length;

describe("formatVersion", () => {
  it("should return empty string for null", () => {
    expect(formatVersion(null)).toBe("");
  });

  it("should return empty string for empty string", () => {
    expect(formatVersion("")).toBe("");
  });

  it("should add v prefix to plain version", () => {
    expect(formatVersion("2.1.50")).toBe("v2.1.50");
  });

  it("should keep existing v prefix", () => {
    expect(formatVersion("v0.29.5")).toBe("v0.29.5");
  });

  it("should strip platform suffix", () => {
    expect(formatVersion("0.104.0-darwin-arm64")).toBe("v0.104.0");
  });

  it("should strip prerelease suffix", () => {
    expect(formatVersion("1.0.0-beta.1")).toBe("v1.0.0");
  });

  it("should strip build metadata", () => {
    expect(formatVersion("1.2.3+build.456")).toBe("v1.2.3");
  });

  it("should handle v prefix with suffix", () => {
    expect(formatVersion("v0.104.0-darwin-arm64")).toBe("v0.104.0");
  });
});

describe("truncateHighlighted", () => {
  it("returns short markup unchanged", () => {
    const markup = "<b>hi</b> there";
    expect(truncateHighlighted(markup, 20)).toBe(markup);
  });

  it("windows a span near the start, clipping only the tail", () => {
    const markup =
      "<b>find</b> the thing in a very long trailing context that overflows";
    const out = truncateHighlighted(markup, 20);
    expect(out.startsWith("<b>find</b>")).toBe(true);
    expect(out.startsWith("…")).toBe(false);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("<b>find</b>"); // span intact
    expect(visibleLen(out)).toBeLessThanOrEqual(20);
  });

  it("windows a span deep in the middle, clipping both sides with pre-context", () => {
    const markup =
      "alpha bravo charlie delta echo <b>MATCH</b> foxtrot golf hotel india";
    const out = truncateHighlighted(markup, 20);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("<b>MATCH</b>"); // span intact, not split
    // Some leading context shows before the span (bias ~1/3 of budget)...
    expect(out.indexOf("<b>MATCH</b>")).toBeGreaterThan(1);
    // ...but the span starts within ~25 chars of the window start.
    expect(out.indexOf("<b>")).toBeLessThanOrEqual(25);
    expect(visibleLen(out)).toBeLessThanOrEqual(20);
  });

  it("caps leading context so the span starts near the window even with a large budget", () => {
    // Big budget: ~1/3 of it (well over 24) would push the span far right and
    // OpenTUI would clip it off a real (narrower) box. The lead cap prevents that.
    const pre = "z".repeat(300);
    const post = "y".repeat(300);
    const out = truncateHighlighted(`${pre}<b>NEEDLE</b>${post}`, 200);
    expect(out).toContain("<b>NEEDLE</b>"); // span intact
    // <b> begins within 25 chars (leading ellipsis + <=24 context), not ~65.
    expect(out.indexOf("<b>")).toBeLessThanOrEqual(25);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(visibleLen(out)).toBeLessThanOrEqual(200);
  });

  it("windows a span near the end, clipping only the head", () => {
    const markup =
      "a very long leading context that runs well past the budget then <b>END</b>";
    const out = truncateHighlighted(markup, 20);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("<b>END</b>")).toBe(true);
    expect(visibleLen(out)).toBeLessThanOrEqual(20);
  });

  it("keeps a span longer than the budget fully intact", () => {
    const markup = "xx<b>this-whole-span-exceeds-the-budget</b>yy";
    const out = truncateHighlighted(markup, 5);
    // The bold span is never sliced, even when it alone exceeds maxLen.
    expect(out).toContain("<b>this-whole-span-exceeds-the-budget</b>");
  });

  it("never splits the markup tags", () => {
    const markup =
      "leading words galore <b>needle</b> and trailing words galore too";
    const out = truncateHighlighted(markup, 12);
    // Exactly one intact <b>…</b> pair, tags balanced.
    expect((out.match(/<b>/g) ?? []).length).toBe(1);
    expect((out.match(/<\/b>/g) ?? []).length).toBe(1);
    expect(out.indexOf("<b>")).toBeLessThan(out.indexOf("</b>"));
    expect(out).toContain("<b>needle</b>");
  });

  it("falls back to plain truncation when there is no span", () => {
    const plain = "plain long text well over the budget";
    expect(truncateHighlighted(plain, 10)).toBe(truncateText(plain, 10));
  });
});

describe("formatSubagentName", () => {
  it("parses named agent IDs", () => {
    expect(formatSubagentName("areviewer-quality-4e04b65eee350afe")).toBe(
      "reviewer-quality",
    );
    expect(formatSubagentName("asleeper-one-8c2e4613a97d4ec9")).toBe(
      "sleeper-one",
    );
  });

  it("shortens anonymous hex IDs", () => {
    expect(formatSubagentName("a3a022751130cff19")).toBe("3a0227");
  });

  it("passes through IDs without the a-prefix convention", () => {
    expect(formatSubagentName("custom-name")).toBe("custom-name");
  });
});
