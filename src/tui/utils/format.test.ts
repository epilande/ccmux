import { describe, it, expect } from "bun:test";
import {
  displayWidth,
  formatSubagentName,
  formatVersion,
  padStartWidth,
  sliceToWidth,
  truncateMiddle,
  truncateText,
  truncateHighlighted,
} from "./format";

/** Visible length: markup tags and ellipsis affixes excluded. */
const visibleLen = (s: string) =>
  s.replace(/<\/?b>/g, "").replace(/…/g, "").length;

/** Visible display columns: markup tags and ellipsis affixes excluded. */
const visibleWidth = (s: string) =>
  displayWidth(s.replace(/<\/?b>/g, "").replace(/…/g, ""));

/** A half of a surrogate pair with no partner: what a code-unit slice
 *  through an astral character leaves behind, rendered as `�`. */
const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    s,
  );

const CJK = "日本語テキスト"; // 7 chars, 14 columns
const FAMILY = "👨‍👩‍👧‍👦"; // 11 code units, 2 columns
const FLAG = "🇯🇵"; // 4 code units, 2 columns

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

describe("displayWidth", () => {
  it("counts ASCII one column per character", () => {
    expect(displayWidth("hello")).toBe(5);
    expect(displayWidth("")).toBe(0);
  });

  it("counts wide glyphs as two columns, not as code units", () => {
    expect(CJK.length).toBe(7);
    expect(displayWidth(CJK)).toBe(14);
  });

  it("counts a ZWJ sequence as the single glyph it renders as", () => {
    expect(FAMILY.length).toBe(11);
    expect(displayWidth(FAMILY)).toBe(2);
  });

  it("counts a regional-indicator flag as one glyph", () => {
    expect(FLAG.length).toBe(4);
    expect(displayWidth(FLAG)).toBe(2);
  });

  it("adds up a mixed string", () => {
    expect(displayWidth(`ok ${CJK} ${FLAG}`)).toBe(3 + 14 + 1 + 2);
  });

  it("treats ambiguous-width characters as narrow, like the renderer does", () => {
    // OpenTUI draws ten of each in a ten-column box; a wcwidth table that
    // called them wide would make every ellipsis-terminated string overflow.
    for (const char of ["…", "▎", "α", "→", "①"]) {
      expect(displayWidth(char)).toBe(1);
    }
  });
});

describe("sliceToWidth", () => {
  it("returns the whole string when it already fits", () => {
    expect(sliceToWidth("hello", 10)).toBe("hello");
    expect(sliceToWidth(CJK, 14)).toBe(CJK);
  });

  it("cuts ASCII at the exact column", () => {
    expect(sliceToWidth("hello world", 5)).toBe("hello");
  });

  it("cuts CJK by columns, not by characters", () => {
    expect(sliceToWidth(CJK, 6)).toBe("日本語");
    expect(displayWidth(sliceToWidth(CJK, 6))).toBe(6);
  });

  it("drops a wide glyph that would straddle the limit", () => {
    // Odd budget: the fourth character needs two columns and only one is
    // left, so the result lands a column short rather than a column over.
    expect(sliceToWidth(CJK, 7)).toBe("日本語");
  });

  it("never splits a ZWJ sequence or a flag", () => {
    expect(sliceToWidth(`${FAMILY}abc`, 3)).toBe(`${FAMILY}a`);
    expect(sliceToWidth(FAMILY, 1)).toBe("");
    expect(sliceToWidth(`${FLAG}x`, 2)).toBe(FLAG);
    expect(sliceToWidth(FLAG, 1)).toBe("");
  });

  it("leaves no lone surrogate at any budget", () => {
    const mixed = `a${FAMILY}${CJK}${FLAG}z`;
    for (let budget = 0; budget <= displayWidth(mixed) + 2; budget++) {
      const out = sliceToWidth(mixed, budget);
      expect(hasLoneSurrogate(out)).toBe(false);
      expect(displayWidth(out)).toBeLessThanOrEqual(budget);
    }
  });

  it("returns nothing when there is no room", () => {
    expect(sliceToWidth("hello", 0)).toBe("");
    expect(sliceToWidth("hello", -3)).toBe("");
  });
});

describe("padStartWidth", () => {
  it("matches padStart for ASCII", () => {
    expect(padStartWidth("hi", 5)).toBe("   hi");
    expect(padStartWidth("", 3)).toBe("   ");
  });

  it("leaves text that already fills (or overflows) the width alone", () => {
    expect(padStartWidth("hello", 5)).toBe("hello");
    expect(padStartWidth("too long", 5)).toBe("too long");
  });

  it("pads a wide glyph by the columns it draws, not its code units", () => {
    // padStart would count FAMILY as 11 and pad nothing at all; the cell needs
    // 8 spaces to end on the same column as an ASCII neighbour.
    expect(padStartWidth(FAMILY, 10)).toBe(" ".repeat(8) + FAMILY);
    expect(displayWidth(padStartWidth(FAMILY, 10))).toBe(10);
    expect(displayWidth(padStartWidth(CJK, 20))).toBe(20);
  });

  it("lands an emoji cell on the same column as an ASCII one", () => {
    const width = 12;
    for (const text of ["1:2.3", FLAG, `${FAMILY}:1.0`, `${CJK}`]) {
      const padded = padStartWidth(text, width);
      expect(displayWidth(padded)).toBe(Math.max(width, displayWidth(text)));
    }
  });
});

describe("truncateText", () => {
  it("leaves text that fits alone", () => {
    expect(truncateText("hello", 10)).toBe("hello");
    expect(truncateText("hello", 5)).toBe("hello");
  });

  it("clips ASCII to the budget, ellipsis included", () => {
    expect(truncateText("hello world", 8)).toBe("hello w…");
    expect(displayWidth(truncateText("hello world", 8))).toBe(8);
  });

  it("measures CJK in columns rather than characters", () => {
    // Seven characters, fourteen columns: it does NOT fit an 8-column cell.
    const out = truncateText(CJK, 8);
    expect(out).toBe("日本語…");
    expect(displayWidth(out)).toBeLessThanOrEqual(8);
  });

  it("keeps emoji clusters whole and leaves no lone surrogate", () => {
    const out = truncateText(FAMILY.repeat(3), 4);
    expect(out).toBe(`${FAMILY}…`);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(displayWidth(out)).toBeLessThanOrEqual(4);
  });

  it("fits a mixed string to its column budget", () => {
    const out = truncateText(`ok ${FLAG} ${CJK}`, 10);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(displayWidth(out)).toBeLessThanOrEqual(10);
    expect(out.startsWith(`ok ${FLAG}`)).toBe(true);
  });
});

describe("truncateMiddle", () => {
  it("leaves text that fits alone", () => {
    expect(truncateMiddle("fix-the-bug", 20)).toBe("fix-the-bug");
    expect(truncateMiddle("fix-the-bug", 11)).toBe("fix-the-bug");
  });

  it("keeps both ends of a name that does not fit", () => {
    // The tail is what tells two "fix sidebar" tasks apart, which is the
    // whole reason this is not a right-hand truncation.
    const out = truncateMiddle("fix-sidebar-flicker", 15);
    expect(out).toBe("fix-sid…flicker");
    expect(displayWidth(out)).toBe(15);
  });

  it("gives the odd column to the head", () => {
    const out = truncateMiddle("abcdefghij", 6);
    expect(out).toBe("abc…ij");
    expect(displayWidth(out)).toBe(6);
  });

  it("degrades to the ellipsis alone rather than a one-column head", () => {
    expect(truncateMiddle("abcdef", 1)).toBe("…");
    expect(truncateMiddle("abcdef", 0)).toBe("");
  });

  it("measures CJK in columns rather than characters", () => {
    // Two columns per character, so an 8-column budget buys three of them
    // and the ellipsis rather than seven.
    expect(truncateMiddle(CJK, 8)).toBe("日本…ト");
    expect(displayWidth(truncateMiddle(CJK, 8))).toBeLessThanOrEqual(8);
  });

  it("cuts both ends on grapheme boundaries", () => {
    const out = truncateMiddle(`${FAMILY}${FLAG}${FAMILY}${FLAG}`, 5);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
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

  it("budgets a wide-glyph window in columns, not code units", () => {
    const markup = `${CJK.repeat(3)}<b>探す</b>${CJK.repeat(3)}`;
    const out = truncateHighlighted(markup, 20);
    expect(out).toContain("<b>探す</b>"); // span intact
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(visibleWidth(out)).toBeLessThanOrEqual(20);
    expect(hasLoneSurrogate(out)).toBe(false);
  });

  it("keeps emoji clusters whole on both sides of the span", () => {
    const markup = `${FAMILY.repeat(6)}<b>hit</b>${FLAG.repeat(6)}`;
    const out = truncateHighlighted(markup, 16);
    expect(out).toContain("<b>hit</b>");
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(visibleWidth(out)).toBeLessThanOrEqual(16);
    // Whole families and whole flags survived, never a half of either.
    const visible = out.replace(/<\/?b>|…|hit/g, "");
    expect(visible.replace(new RegExp(`${FAMILY}|${FLAG}`, "gu"), "")).toBe("");
  });

  it("returns a wide-glyph markup untouched when it already fits", () => {
    const markup = `<b>探す</b>${CJK}`;
    expect(truncateHighlighted(markup, 18)).toBe(markup);
    // ...and not when only its code-unit count fits.
    expect(truncateHighlighted(markup, 12)).not.toBe(markup);
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
