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

/** Truncate plain text to `maxLen` chars, adding an ellipsis when clipped. */
export function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(1, maxLen - 1)) + "…";
}

/**
 * Window single-span highlight markup (one `<b>…</b>`, as `wrapFirstMatch`
 * emits) to `maxLen` VISIBLE chars (tags excluded from the count) so a match
 * deep in a long prompt still renders within a height-1 row instead of
 * wrapping/overlapping. The bold span is always kept whole; `…` is affixed
 * on whichever side is clipped. Leading pre-match context is capped hard (see
 * LEAD_CONTEXT_CAP) so the span starts within ~25 chars of the window even
 * when the real box is narrower than `maxLen` (maxLen is a layout budget, not
 * the actual box width: a row with long project/branch cells gets a narrower
 * box and OpenTUI clips the tail, so a span pushed far right by ~1/3-of-budget
 * leading context could be clipped off). Any leftover budget goes to the
 * trailing side. Markup with no span is treated as plain text. Mirrors the
 * daemon's radius-windowed transcript snippets, but works from a char budget.
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

  if (pre.length + span.length + post.length <= maxLen) return markup;

  // Chars left for context once the (always-kept) span is reserved.
  const contextBudget = Math.max(0, maxLen - span.length);
  // Leading context is ~1/3 of the budget but hard-capped so the span always
  // starts near the window start (surviving a real box narrower than maxLen).
  // Any budget the (possibly short) leading side leaves goes to the trailing
  // side.
  const leadTarget = Math.min(Math.floor(contextBudget / 3), LEAD_CONTEXT_CAP);
  const preShown = Math.min(pre.length, leadTarget);
  const postShown = Math.min(post.length, contextBudget - preShown);

  const lead = preShown < pre.length ? "…" : "";
  const trail = postShown < post.length ? "…" : "";
  const preSlice = pre.slice(pre.length - preShown);
  const postSlice = post.slice(0, postShown);
  return `${lead}${preSlice}<b>${span}</b>${postSlice}${trail}`;
}
