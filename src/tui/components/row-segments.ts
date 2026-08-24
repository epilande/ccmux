/**
 * The half of row rendering that belongs to no single surface.
 *
 * Extracted from `WorktreesPanel.tsx` when the source picker arrived needing
 * the same primitives (issue #151, PR 2). Nothing in here knows what a row IS:
 * it fits coloured text to a width, names a phrase, flattens a foreign string
 * to one line, and scrolls a list measured in VISUAL lines rather than rows.
 * A surface supplies the rows; this supplies the arithmetic they are drawn
 * with.
 *
 * The extraction is also what stops a second component's module graph from
 * swallowing a 3,900-line one just to reach `fitSegments`.
 */

import { displayWidth, sliceToWidth, truncateText } from "../utils/format";

/** A run of same-colored text on a row. */
export interface RowSegment {
  text: string;
  fg: string;
}

/**
 * The longest prefix of `segments` that fits `width` columns, cutting the
 * segment that straddles the limit rather than dropping it.
 *
 * OpenTUI does not clip: a row wider than its box paints straight over the
 * border and the next row. Composing a row from colored `<text>` children and
 * hoping it fits is what that looks like in practice, so every row here is
 * fitted first and rendered second.
 */
export function fitSegments(
  segments: RowSegment[],
  width: number,
): RowSegment[] {
  const kept: RowSegment[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used >= width) break;
    const segmentWidth = displayWidth(segment.text);
    if (used + segmentWidth <= width) {
      kept.push(segment);
      used += segmentWidth;
      continue;
    }
    // Below two columns there is no room for text AND an ellipsis, and
    // `truncateText` would spend both on the marker alone and overrun.
    const room = width - used;
    kept.push({
      ...segment,
      text:
        room < 2
          ? sliceToWidth(segment.text, room)
          : truncateText(segment.text, room),
    });
    used = width;
  }
  return kept;
}

/** A phrase on the detail line, with the colour it carries. */
export interface Phrase {
  text: string;
  fg: string;
}

/**
 * `text` with every run of whitespace flattened to one space.
 *
 * For strings that arrive from OUTSIDE and land in a `height={1}` box — a
 * `gh` failure, above all. A newline is ZERO columns wide to
 * `Bun.stringWidth`, so a two-line stderr (an unauthenticated `gh` prints
 * exactly that) sails through every width guard and then loses everything
 * after the break, with no ellipsis to say a word was dropped, because
 * OpenTUI wraps and a wrapped line in a one-line box vanishes.
 *
 * Deliberately NOT inside `truncateText`, which has many callers with no such
 * problem, and deliberately not done daemon-side in `ghProblem`: the CLI
 * prints those same strings, where multi-line stderr is worth reading.
 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * What a `switch` over a wire-sourced union falls back to, without giving up
 * the compiler's help on the unions this repo owns.
 *
 * Every union these surfaces switch on arrives from the daemon, which is a
 * long-lived background process that can be NEWER than this build: a reason or
 * a PR state it has learned to send lands here as a value no case matches.
 * Without a default that renders as an empty string, and an empty string on a
 * removable row is a checkbox with no explanation beside it, the one thing
 * the Worktrees panel's design rules out.
 *
 * A bare `default:` would buy that at the cost of the error that catches a
 * member added to `PRUNE_REASONS` in this repo, which is the case worth
 * failing loudly. Routing the default through here keeps both: the `never`
 * parameter stops compiling the moment a case is missing, while the value
 * still decides what an unknown one renders as.
 */
export function unhandled<T>(_exhaustive: never, fallback: T): T {
  return fallback;
}

/** Where each row starts, and how tall it is, in the scrollbox's own units. */
export type VisualLayout = Map<string, { line: number; height: number }>;

/**
 * Scroll position that brings `path` fully into view, or null when it already
 * is. Same shape as `scrollTarget` in `utils/grouping.ts`, which is what the
 * session list uses; the difference is only how the lines are counted.
 */
export function scrollTargetFor(
  layout: VisualLayout,
  path: string | null,
  scrollTop: number,
  viewportHeight: number,
): number | null {
  if (!path || viewportHeight <= 0) return null;
  const slot = layout.get(path);
  if (!slot) return null;
  const lastLine = slot.line + slot.height - 1;
  if (slot.line < scrollTop) return slot.line;
  if (lastLine >= scrollTop + viewportHeight) {
    return lastLine - viewportHeight + 1;
  }
  return null;
}
