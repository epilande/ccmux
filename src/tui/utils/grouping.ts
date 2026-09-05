import type { AttentionType, EnrichedSession } from "../../types";
import { getEffectiveStatus } from "../../daemon/status-machine";
import { shortenCwd } from "./format";
export type { GroupBy } from "../../lib/preferences";
export { VALID_GROUP_BY, DEFAULT_GROUP_BY } from "../../lib/preferences";
import type { GroupBy } from "../../lib/preferences";

/** Waiting subtype keys in StatusSummary */
type WaitingKey =
  | "waitingPermission"
  | "waitingPlanApproval"
  | "waitingGeneric";

/** Status counts for a group header */
export interface StatusSummary {
  working: number;
  waitingPermission: number;
  waitingPlanApproval: number;
  waitingGeneric: number;
  idle: number;
}

/** Maps waiting subtype summary keys to their AttentionType */
export const WAITING_SUBTYPES: ReadonlyArray<{
  key: WaitingKey;
  attention: AttentionType;
}> = [
  { key: "waitingPermission", attention: "permission" },
  { key: "waitingPlanApproval", attention: "plan_approval" },
  { key: "waitingGeneric", attention: null },
];

/** Which search source matched a session, in tier order: identity
 * (project/branch/group key) > cwd > content (prompt > pane > transcript). */
export type MatchSource = "identity" | "cwd" | "prompt" | "pane" | "transcript";

/** A session in the filtered list with optional search highlights */
export interface FilteredSession {
  session: EnrichedSession;
  highlights: {
    project?: string | null;
    cwd?: string | null;
    gitBranch?: string | null;
    lastPrompt?: string | null;
    /** A single normalized, highlighted prompt line: the newest older prompt
     * whose text matched, rendered here when `lastPrompt` (the newest) did not
     * itself match. Not the whole index, and never multi-line. */
    prompts?: string | null;
  } | null;
  paneMatch?: boolean;
  /** The session matched a live transcript search (daemon `/search`). */
  transcriptMatch?: boolean;
  /** First transcript match snippet, shown to explain why the row matched. */
  transcriptSnippet?: string;
  /** Composite relevance score while a query is active (issue #50): the best
   * source's tier score plus a small cross-source bonus. Absent on the
   * empty-query path, where no ranking applies. */
  score?: number;
  /** Every source that matched, strongest first. */
  matchSources?: MatchSource[];
  /** The source whose tier produced `score`; drives the row's match cue. */
  primarySource?: MatchSource;
}

/** Discriminated union for items in the flat render list */
export type FlatItem =
  | {
      type: "header";
      groupKey: string;
      label: string;
      count: number;
      collapsed: boolean;
      /** Raw member references, not a precomputed summary. The status summary
       * is derived downstream in the header's own reactive scope so this memo
       * never reads `session.subagents`: subagent churn (one write per fold
       * during a fan-out) would otherwise rebuild every FlatItem and force the
       * reference-keyed row list to recreate every row. */
      members: FilteredSession[];
    }
  | {
      type: "session";
      groupKey: string;
      filteredSession: FilteredSession;
    };

/** A group of sessions keyed for sorting */
export interface GroupEntry {
  key: string;
  members: FilteredSession[];
}

/** Deliberate group for paneless invoke worker rows under tmux-derived
 *  grouping, instead of lumping them into the misleading `(no tmux)`
 *  bucket alongside genuinely untracked sessions. */
export const INVOKE_GROUP_KEY = "(invoke)";

/** Deliberate group for paneless Claude background-agent rows
 *  under tmux-derived grouping, instead of the misleading `(no tmux)` bucket.
 *  Mirrors {@link INVOKE_GROUP_KEY}. */
export const BACKGROUND_GROUP_KEY = "(background)";

/**
 * Deliberate group key for a paneless row (synthetic invoke worker or
 * background agent), or null for a normal pane-tracked session.
 * Both kinds have no tmux target, so under session/window grouping they get a
 * deliberate group instead of the misleading `(no tmux)` bucket.
 */
function panelessGroupKey(session: EnrichedSession): string | null {
  if (session.originInvocationStatus !== undefined) return INVOKE_GROUP_KEY;
  if (session.trackingMode === "background") return BACKGROUND_GROUP_KEY;
  return null;
}

/** Derive the group key for a session based on the groupBy mode */
export function getGroupKey(
  session: EnrichedSession,
  groupBy: GroupBy,
): string {
  // Paneless rows co-locate by cwd under project/cwd grouping (matching real
  // sessions in the same directory); under session/window grouping they have
  // no target, so `panelessGroupKey` gives them a deliberate group.
  switch (groupBy) {
    case "project":
      return session.project || session.cwd;
    case "cwd":
      return session.paneCwd || session.cwd;
    case "session": {
      const paneless = panelessGroupKey(session);
      if (paneless) return paneless;
      const target = session.tmuxTarget || "";
      const colonIdx = target.indexOf(":");
      return colonIdx > 0 ? target.slice(0, colonIdx) : target || "(no tmux)";
    }
    case "window": {
      const paneless = panelessGroupKey(session);
      if (paneless) return paneless;
      const target = session.tmuxTarget || "";
      const dotIdx = target.lastIndexOf(".");
      return dotIdx > 0 ? target.slice(0, dotIdx) : target || "(no tmux)";
    }
    case "none":
      return "";
  }
}

/** Format a group key into a display label */
export function getGroupLabel(groupKey: string, groupBy: GroupBy): string {
  if (groupBy === "cwd") {
    return shortenCwd(groupKey);
  }
  return groupKey;
}

/** Compute aggregate status counts for a group of sessions */
export function computeStatusSummary(
  sessions: FilteredSession[],
): StatusSummary {
  const summary: StatusSummary = {
    working: 0,
    waitingPermission: 0,
    waitingPlanApproval: 0,
    waitingGeneric: 0,
    idle: 0,
  };
  for (const { session } of sessions) {
    // Effective status, not raw: a lead idle at its prompt with subagents
    // running counts as working, matching what the row renders.
    const { status, attentionType } = getEffectiveStatus(session);
    if (status === "working") {
      summary.working++;
    } else if (status === "idle") {
      summary.idle++;
    } else if (status === "waiting") {
      if (attentionType === "permission") {
        summary.waitingPermission++;
      } else if (attentionType === "plan_approval") {
        summary.waitingPlanApproval++;
      } else {
        summary.waitingGeneric++;
      }
    }
  }
  return summary;
}

/** Collect filtered sessions into GroupEntry[] keyed by groupBy mode */
export function groupSessions(
  filtered: FilteredSession[],
  groupBy: GroupBy,
): GroupEntry[] {
  const groups = new Map<string, FilteredSession[]>();
  for (const fs of filtered) {
    const key = getGroupKey(fs.session, groupBy);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(fs);
  }
  return [...groups.entries()].map(([key, members]) => ({ key, members }));
}

/** Extract group keys from the header items in a flat item list */
export function headerGroupKeys(items: FlatItem[]): string[] {
  return items.flatMap((i) => (i.type === "header" ? [i.groupKey] : []));
}

/**
 * Sort groups: pinned groups first (in pinned order), then unpinned
 * groups sorted alphabetically.
 *
 * With `byScore` (search active), groups order by their best member's
 * relevance score instead, descending, and pinning yields: a strong match in
 * an unpinned group outranks a weakly-matching pinned one (same precedent as
 * search force-expanding collapsed groups). The stable sort keeps the
 * pinned-then-alphabetical order as the tiebreak between equal scores.
 */
export function sortGroups(
  groups: GroupEntry[],
  pinnedGroups: string[],
  byScore = false,
): GroupEntry[] {
  const pinnedSet = new Set(pinnedGroups);
  const pinned: GroupEntry[] = [];
  const unpinned: GroupEntry[] = [];

  for (const group of groups) {
    if (pinnedSet.has(group.key)) {
      pinned.push(group);
    } else {
      unpinned.push(group);
    }
  }

  // Pinned: maintain user-defined order from pinnedGroups array
  pinned.sort(
    (a, b) => pinnedGroups.indexOf(a.key) - pinnedGroups.indexOf(b.key),
  );

  // Unpinned: alphabetical (stable order unaffected by session status changes)
  unpinned.sort((a, b) => a.key.localeCompare(b.key));

  const ordered = [...pinned, ...unpinned];
  if (byScore) {
    const best = (g: GroupEntry) =>
      g.members.reduce((acc, m) => Math.max(acc, m.score ?? 0), 0);
    ordered.sort((a, b) => best(b) - best(a));
  }
  return ordered;
}

/**
 * Build the flat item list from filtered sessions, applying grouping,
 * sorting, and collapse state.
 * During search, all groups are forced expanded.
 */
export function buildFlatItems(
  filtered: FilteredSession[],
  groupBy: GroupBy,
  collapsed: Set<string>,
  isSearching: boolean,
  pinnedGroups: string[] = [],
): FlatItem[] {
  if (groupBy === "none") {
    return filtered.map((fs) => ({
      type: "session" as const,
      groupKey: "",
      filteredSession: fs,
    }));
  }

  const sorted = sortGroups(
    groupSessions(filtered, groupBy),
    pinnedGroups,
    isSearching,
  );

  const items: FlatItem[] = [];
  for (const { key, members } of sorted) {
    const isCollapsed = !isSearching && collapsed.has(key);
    items.push({
      type: "header",
      groupKey: key,
      label: getGroupLabel(key, groupBy),
      count: members.length,
      collapsed: isCollapsed,
      members,
    });
    if (!isCollapsed) {
      for (const fs of members) {
        items.push({
          type: "session",
          groupKey: key,
          filteredSession: fs,
        });
      }
    }
  }

  return items;
}

/**
 * How many terminal lines a session row occupies.
 *
 * A count rather than the has-a-subtitle boolean it replaced: a row is no
 * longer either one or two lines, because the wrapped prompt block adds a
 * variable number more. Every consumer here derives scroll and menu geometry
 * from this one answer, and the SAME function feeds the renderer, so a row
 * cannot be measured as one height and drawn at another.
 */
type SessionLineCount = (session: EnrichedSession) => number;

/**
 * Compute the visual height of a flat item.
 * Non-first headers occupy 2 lines (divider + header).
 * Session items ask `lineCount`; without one they are assumed to be 2 lines.
 * First header occupies 1 line.
 */
export function itemVisualHeight(
  items: FlatItem[],
  index: number,
  lineCount?: SessionLineCount,
): number {
  const item = items[index];
  if (item.type === "header" && index > 0) return 2;
  if (item.type === "session") {
    if (!lineCount) return 2;
    // A row always draws its identity line, whatever the caller computes.
    return Math.max(1, lineCount(item.filteredSession.session));
  }
  return 1;
}

/**
 * Convert a flat item index to a visual line position.
 * Headers (except the first) render a divider line above them,
 * so they occupy 2 visual lines instead of 1.
 */
export function toVisualLine(
  items: FlatItem[],
  index: number,
  lineCount?: SessionLineCount,
): number {
  let line = 0;
  for (let i = 0; i < index; i++) {
    line += itemVisualHeight(items, i, lineCount);
  }
  return line;
}

/**
 * Compute the scroll target to keep the item at `index` visible.
 * Returns the new scrollTop, or null if no scrolling is needed.
 */
export function scrollTarget(
  items: FlatItem[],
  index: number,
  scrollTop: number,
  viewportHeight: number,
  lineCount?: SessionLineCount,
): number | null {
  const visualLine = toVisualLine(items, index, lineCount);
  const lastLine = visualLine + itemVisualHeight(items, index, lineCount) - 1;

  if (visualLine < scrollTop) {
    return visualLine;
  } else if (lastLine >= scrollTop + viewportHeight) {
    // Never past the row's own first line: a row taller than the viewport
    // keeps its identity line (index, status, active marker) on screen.
    return Math.min(visualLine, lastLine - viewportHeight + 1);
  }
  return null;
}

/**
 * Get the session-only index for a given flat index.
 * Used for 1-9 quick jump numbering (counts only session items).
 */
export function getSessionIndex(items: FlatItem[], flatIndex: number): number {
  let sessionIdx = 0;
  for (let i = 0; i < flatIndex; i++) {
    if (items[i].type === "session") sessionIdx++;
  }
  return sessionIdx;
}
