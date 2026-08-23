export { formatDuration, formatRelativeTime } from "../../lib/format";

export function shortenCwd(cwd: string): string {
  const home = process.env.HOME ?? "";
  return home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

export function formatVersion(version: string | null): string {
  if (!version) return "";
  // Strip prerelease/platform suffixes (e.g. "0.104.0-darwin-arm64" → "0.104.0")
  const semver = version.replace(/^v?/, "").replace(/[-+].*$/, "");
  return semver ? `v${semver}` : `v${version}`;
}

/**
 * Human name for a subagent from its transcript-derived agent ID.
 *
 * IDs come in two shapes (both observed on disk):
 * - Named agents/teammates: `a<name>-<hex>` (e.g.
 *   `areviewer-quality-4e04b65eee350afe` → `reviewer-quality`)
 * - Anonymous Task subagents: `a<hex>` (e.g. `a3a022751130cff19` → `3a0227`)
 *
 * Both start with a literal `a` prefix and end in a hex run; strip the
 * prefix, then strip a trailing `-<hex>` when a name remains.
 */
export function formatSubagentName(agentId: string): string {
  const body = agentId.startsWith("a") ? agentId.slice(1) : agentId;
  if (/^[0-9a-f]{8,}$/.test(body)) return body.slice(0, 6);
  return body.replace(/-[0-9a-f]{8,}$/, "");
}

/**
 * Terminal columns `text` occupies.
 *
 * `ambiguousIsNarrow` is pinned rather than left to Bun's default because the
 * two measurers in play could disagree there: OpenTUI's renderer measures with
 * its grapheme-aware "unicode" method, `Bun.stringWidth` is wcwidth-flavoured.
 * They agree on CJK (2), ZWJ sequences (2) and flags (2); ambiguous-width
 * characters are the only class where they can differ. Rendering probes of the
 * ones ccmux actually draws (`…`, `▎`, `α`, `→`, `①`) put ten of each in a
 * ten-column box, so OpenTUI treats them as narrow and so do we.
 */
const WIDTH_OPTIONS = { ambiguousIsNarrow: true } as const;

export function displayWidth(text: string): number {
  return Bun.stringWidth(text, WIDTH_OPTIONS);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Longest prefix of `text` that fits in `maxWidth` columns, cut on grapheme
 * boundaries: a cluster is taken whole or not at all, so no slice can end
 * mid-surrogate (a replacement glyph) or halfway through a ZWJ sequence. A
 * wide cluster that would straddle the limit is dropped, leaving the result a
 * column short of `maxWidth` rather than a column over.
 */
export function sliceToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  let out = "";
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    const segmentWidth = displayWidth(segment);
    if (width + segmentWidth > maxWidth) break;
    out += segment;
    width += segmentWidth;
  }
  return out;
}

/** `sliceToWidth` from the other end: the longest fitting SUFFIX. */
function sliceTailToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  const clusters = [...graphemes.segment(text)];
  let out = "";
  let width = 0;
  for (let i = clusters.length - 1; i >= 0; i--) {
    const segment = clusters[i]!.segment;
    const segmentWidth = displayWidth(segment);
    if (width + segmentWidth > maxWidth) break;
    out = segment + out;
    width += segmentWidth;
  }
  return out;
}

/**
 * Left-pad `text` with spaces until it occupies `width` columns; the
 * column-true counterpart of `String.padStart`, which counts code units and so
 * over-pads anything holding a wide glyph (an emoji pads as if it were its two
 * surrogates, pushing a right-aligned cell out of line with its ASCII
 * neighbours). Text already at or over `width` comes back untouched.
 */
export function padStartWidth(text: string, width: number): string {
  const pad = width - displayWidth(text);
  return pad > 0 ? " ".repeat(pad) + text : text;
}

/** Truncate plain text to `maxLen` columns, adding an ellipsis when clipped. */
export function truncateText(text: string, maxLen: number): string {
  if (displayWidth(text) <= maxLen) return text;
  return sliceToWidth(text, Math.max(1, maxLen - 1)) + "…";
}

/**
 * Truncate to `maxLen` columns from the MIDDLE, keeping both ends readable.
 *
 * For text whose tail carries as much meaning as its head, which is the case
 * for a derived worktree name: `fix-sidebar-flicker-on-resize` clipped from
 * the right leaves `fix-sidebar-…`, and every task that opens the same way
 * looks identical. Cutting the middle keeps the words that tell them apart.
 *
 * Columns, not code units, and cut on grapheme boundaries at both ends, so a
 * name holding wide glyphs fits its row like an ASCII one does.
 */
export function truncateMiddle(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (displayWidth(text) <= maxLen) return text;
  // Nothing but the ellipsis fits; a one-column head would say less than it.
  if (maxLen === 1) return "…";
  const room = maxLen - 1;
  // The head gets the odd column: reading starts there.
  const head = sliceToWidth(text, Math.ceil(room / 2));
  const tail = sliceTailToWidth(text, room - displayWidth(head));
  return `${head}…${tail}`;
}

/**
 * Window single-span highlight markup (one `<b>…</b>`, as `wrapFirstMatch`
 * emits) to `maxLen` VISIBLE columns (tags excluded from the count) so a match
 * deep in a long prompt still renders within a height-1 row instead of
 * wrapping/overlapping. The bold span is always kept whole; `…` is affixed
 * on whichever side is clipped. Leading pre-match context is capped hard (see
 * LEAD_CONTEXT_CAP) so the span starts within ~25 columns of the window even
 * when the real box is narrower than `maxLen` (maxLen is a layout budget, not
 * the actual box width: a row with long project/branch cells gets a narrower
 * box and OpenTUI clips the tail, so a span pushed far right by ~1/3-of-budget
 * leading context could be clipped off). Any leftover budget goes to the
 * trailing side. Markup with no span is treated as plain text. Mirrors the
 * daemon's radius-windowed transcript snippets, but works from a column budget.
 */
const LEAD_CONTEXT_CAP = 24;

export function truncateHighlighted(markup: string, maxLen: number): string {
  const open = markup.indexOf("<b>");
  const close = markup.indexOf("</b>");
  if (open === -1 || close === -1 || close < open) {
    return truncateText(markup, maxLen);
  }
  const pre = markup.slice(0, open);
  const span = markup.slice(open + 3, close);
  const post = markup.slice(close + 4);

  const spanWidth = displayWidth(span);
  if (displayWidth(pre) + spanWidth + displayWidth(post) <= maxLen) {
    return markup;
  }

  // Columns left for context once the (always-kept) span is reserved.
  const contextBudget = Math.max(0, maxLen - spanWidth);
  // Leading context is ~1/3 of the budget but hard-capped so the span always
  // starts near the window start (surviving a real box narrower than maxLen).
  // Any budget the (possibly short) leading side leaves goes to the trailing
  // side.
  const leadTarget = Math.min(Math.floor(contextBudget / 3), LEAD_CONTEXT_CAP);
  const preSlice = sliceTailToWidth(pre, leadTarget);
  const postSlice = sliceToWidth(post, contextBudget - displayWidth(preSlice));

  const lead = preSlice.length < pre.length ? "…" : "";
  const trail = postSlice.length < post.length ? "…" : "";
  return `${lead}${preSlice}<b>${span}</b>${postSlice}${trail}`;
}

/**
 * Greedy word-wrap into lines of at most `width` columns, breaking a word
 * that cannot fit on a line of its own.
 *
 * Callers wrap text themselves rather than handing a long string to the
 * renderer, because their height budget has to know the row count
 * BEFORE layout and the renderer's own wrapping cannot be predicted from
 * here (it breaks mid-word at the tail of a line, and a space landing on the
 * boundary moves to the next row). Lines produced here already fit, so
 * nothing can wrap a second time and the budget cannot be wrong.
 *
 * Widths are display columns (`displayWidth`), so a line of wide glyphs (CJK,
 * emoji) fits its column like an ASCII one does, and mid-word breaks land on
 * grapheme boundaries (issue #91).
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    // Longer than the whole column: it can only be broken mid-word.
    while (displayWidth(rest) > width) {
      if (line) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }
      const head = sliceToWidth(rest, width);
      if (!head) {
        // A single cluster wider than the whole column (a wide glyph at
        // width 1): nothing can be split off it, so let the word overflow
        // rather than slice a cluster or spin on an empty head.
        lines.push(rest);
        rest = "";
        break;
      }
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (!rest) continue;
    const restWidth = displayWidth(rest);
    if (!line) {
      line = rest;
      lineWidth = restWidth;
    } else if (lineWidth + 1 + restWidth <= width) {
      line += ` ${rest}`;
      lineWidth += 1 + restWidth;
    } else {
      lines.push(line);
      line = rest;
      lineWidth = restWidth;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * {@link wrapText}, capped at `maxLines`. The last kept line is ellipsized
 * when text was dropped, so a clipped block never passes for a complete one.
 *
 * Returns the lines rather than a string: the caller's row height IS the
 * array length, which is the whole reason wrapping happens here instead of
 * in the renderer.
 */
export function wrapToLines(
  text: string,
  width: number,
  maxLines: number,
): string[] {
  if (maxLines <= 0 || width <= 0 || !text) return [];
  const lines = wrapText(text, width);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  // `truncateText` only ellipsizes when it has to clip, and `last` already
  // fits the column by construction — so make room for the marker first.
  kept[maxLines - 1] = truncateText(last + " …", width);
  return kept;
}
