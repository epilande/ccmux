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

/** A session in the filtered list with optional search highlights */
export interface FilteredSession {
  session: EnrichedSession;
  highlights: {
    project?: string | null;
    cwd?: string | null;
    gitBranch?: string | null;
    lastPrompt?: string | null;
    /** Highlighted `\n`-joined prompt index; a matched older prompt renders
     * from here when `lastPrompt` (the newest) did not itself match. */
    prompts?: string | null;
  } | null;
  paneMatch?: boolean;
  /** The session matched a live transcript search (daemon `/search`). */
  transcriptMatch?: boolean;
  /** First transcript match snippet, shown to explain why the row matched. */
  transcriptSnippet?: string;
}

/** Discriminated union for items in the flat render list */
export type FlatItem =
  | {
      type: "header";
      groupKey: string;
      label: string;
      count: number;
      collapsed: boolean;
      statusSummary: StatusSummary;
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
    const status = session.status;
    if (status === "working") {
      summary.working++;
    } else if (status === "idle") {
      summary.idle++;
    } else if (status === "waiting") {
      const { attentionType } = getEffectiveStatus(session);
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
 */
export function sortGroups(
  groups: GroupEntry[],
  pinnedGroups: string[],
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

  return [...pinned, ...unpinned];
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

  const sorted = sortGroups(groupSessions(filtered, groupBy), pinnedGroups);

  const items: FlatItem[] = [];
  for (const { key, members } of sorted) {
    const isCollapsed = !isSearching && collapsed.has(key);
    items.push({
      type: "header",
      groupKey: key,
      label: getGroupLabel(key, groupBy),
      count: members.length,
      collapsed: isCollapsed,
      statusSummary: computeStatusSummary(members),
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

/** Predicate returning true if a session row has a subtitle (2 lines) vs collapsed (1 line). */
type SessionHasSubtitle = (session: EnrichedSession) => boolean;

/**
 * Compute the visual height of a flat item.
 * Non-first headers occupy 2 lines (divider + header).
 * Session items occupy 2 lines when a subtitle is rendered, 1 line otherwise.
 * First header occupies 1 line.
 */
export function itemVisualHeight(
  items: FlatItem[],
  index: number,
  hasSubtitle?: SessionHasSubtitle,
): number {
  const item = items[index];
  if (item.type === "header" && index > 0) return 2;
  if (item.type === "session") {
    if (!hasSubtitle) return 2;
    return hasSubtitle(item.filteredSession.session) ? 2 : 1;
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
  hasSubtitle?: SessionHasSubtitle,
): number {
  let line = 0;
  for (let i = 0; i < index; i++) {
    line += itemVisualHeight(items, i, hasSubtitle);
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
  hasSubtitle?: SessionHasSubtitle,
): number | null {
  const visualLine = toVisualLine(items, index, hasSubtitle);
  const lastLine = visualLine + itemVisualHeight(items, index, hasSubtitle) - 1;

  if (visualLine < scrollTop) {
    return visualLine;
  } else if (lastLine >= scrollTop + viewportHeight) {
    return lastLine - viewportHeight + 1;
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
