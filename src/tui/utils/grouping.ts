import type { AttentionType, EnrichedSession } from "../../types";
import { getEffectiveStatus } from "../../daemon/status-machine";
import { shortenCwd, sliceToWidth } from "./format";
export type { GroupBy } from "../../lib/preferences";
export { VALID_GROUP_BY, DEFAULT_GROUP_BY } from "../../lib/preferences";
import { VALID_GROUP_BY } from "../../lib/preferences";
import type { GroupBy } from "../../lib/preferences";
import type { UIState } from "../../lib/state";

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
    /** The agent's pane-title summary with the matched span wrapped, when the
     * query hit the summary text itself. Substring highlights like
     * `lastPrompt`, not fuzzysort markup: the `summary` cell shows this
     * instead of deferring to the prompt, since the hit IS the evidence. */
    summary?: string | null;
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
      /** Present only when a project header unambiguously names one repository. */
      repoRoot?: string;
      /**
       * On the `needs attention` band only: waiting sessions the repo scope
       * hides from it. The band says so rather than looking complete.
       */
      hiddenWaiting?: number;
      collapsed: boolean;
      /**
       * The raw keys (see {@link groupKeyOf}) whose sessions this header
       * holds, sorted. Absent on a synthetic header. More than one, or one
       * that differs from `groupKey`, means the group is renamed or merged.
       */
      rawKeys?: string[];
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
      sharedTmuxSession?: string;
    };

/** A group of sessions keyed for sorting */
export interface GroupEntry {
  key: string;
  members: FilteredSession[];
}

/** A group as {@link groupSessions} builds it: also the raw keys folded into
 *  it, sorted. */
export interface AliasedGroupEntry extends GroupEntry {
  rawKeys: string[];
}

/**
 * The user's group names, per groupBy mode: raw group key to displayed name.
 * Per mode because one string means different things in different modes (a
 * project named `dev` is not a tmux session named `dev`). Persisted whole in
 * `state.json`; never pruned for liveness, so a directory closed for a week
 * still lands in its renamed group when a session reopens there.
 */
export type GroupAliases = NonNullable<UIState["groupAliases"]>;

/** Merged-away groups' own layouts, per mode (UIState `groupLayouts`). */
export type GroupLayouts = NonNullable<UIState["groupLayouts"]>;

/**
 * `groupLayouts` as read from disk: known modes, each a merge record with a
 * list of raw keys for `pins` and a boolean collapse per `merged` key. A
 * mode in any other shape is dropped whole, the per-key maps earlier builds
 * of this branch wrote included: a merge without a record resets as one
 * saved before records existed did. Copied with `Object.fromEntries`, so a
 * `__proto__` key stays data.
 */
export function normalizeGroupLayouts(input: unknown): GroupLayouts {
  if (!isPlainObject(input)) return {};
  const out: GroupLayouts = {};
  for (const mode of VALID_GROUP_BY) {
    if (mode === "none" || !Object.hasOwn(input, mode)) continue;
    const record = input[mode];
    if (!isPlainObject(record)) continue;
    const { pins, merged } = record;
    if (
      !Array.isArray(pins) ||
      !pins.every((key) => typeof key === "string") ||
      !isPlainObject(merged)
    )
      continue;
    const entries = Object.entries(merged).flatMap(([raw, layout]) =>
      isPlainObject(layout) && typeof layout.collapsed === "boolean"
        ? [[raw, { collapsed: layout.collapsed }] as const]
        : [],
    );
    if (entries.length)
      out[mode] = { pins: [...pins], merged: Object.fromEntries(entries) };
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The widest a group name may be, in terminal columns. */
export const GROUP_NAME_MAX_WIDTH = 64;

/** C0 controls, DEL and C1 controls: none belongs in a one-line label, and
 *  `\0` is how ccmux spells its synthetic header keys. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * A typed group name made safe to key and draw: control characters stripped,
 * trimmed, and capped at {@link GROUP_NAME_MAX_WIDTH} columns. Empty means
 * there is no name (the prompt treats that as a cancel). Stripping `\0`
 * means a name can never collide with a synthetic header key.
 */
export function sanitizeGroupName(name: string): string {
  return sliceToWidth(cleanGroupName(name), GROUP_NAME_MAX_WIDTH).trimEnd();
}

/** {@link sanitizeGroupName} without the width cap: what a name says before
 *  it is cut to fit, for matching it against keys that are longer. */
function cleanGroupName(name: string): string {
  return name.replace(CONTROL_CHARS, "").trim();
}

/** What a group's header says: a name the user typed is its own label, and
 *  only a derived key gets the mode's formatting (a cwd key's
 *  home-shortening). */
function groupLabelOf(
  key: string,
  rawKeys: readonly string[],
  groupBy: GroupBy,
): string {
  return rawKeys.includes(key) ? getGroupLabel(key, groupBy) : key;
}

/**
 * The group key a typed name means. A name that is an existing group's key,
 * or (when only one group shows it) an existing group's displayed label,
 * means that group, so typing what a header says merges into it even where
 * the label is not the key (cwd's `~/Code/beta` for `/home/me/Code/beta`).
 * Both matches run before the width cap, so a full path past it still finds
 * its group. Anything else is a new name, under {@link sanitizeGroupName}.
 * Empty means no name.
 */
export function resolveGroupName(
  typed: string,
  groups: readonly AliasedGroupEntry[],
  groupBy: GroupBy,
): string {
  const clean = cleanGroupName(typed);
  if (!clean) return "";
  if (groups.some((group) => group.key === clean)) return clean;
  const shown = groups.filter(
    (group) => groupLabelOf(group.key, group.rawKeys, groupBy) === clean,
  );
  return shown.length === 1 ? shown[0]!.key : sanitizeGroupName(clean);
}

/**
 * `groupAliases` as read from disk, reduced to what the fold can trust: known
 * modes, string-to-string entries, names stripped of control characters and
 * trimmed, and no no-ops (a name equal to its raw key is no alias). Not
 * width-capped: a merge into a group whose raw key is a long path writes
 * that path as the name, and a cap here would cut it off its group. Entries are copied
 * with `Object.fromEntries`, so a raw key spelled `__proto__` stays data.
 */
export function normalizeGroupAliases(input: unknown): GroupAliases {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: GroupAliases = {};
  for (const mode of VALID_GROUP_BY) {
    if (mode === "none" || !Object.hasOwn(input, mode)) continue;
    const map = (input as Record<string, unknown>)[mode];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const entries = Object.entries(map).flatMap(([raw, value]) => {
      if (typeof value !== "string") return [];
      const name = cleanGroupName(value);
      return name && name !== raw ? [[raw, name] as const] : [];
    });
    if (entries.length) out[mode] = Object.fromEntries(entries);
  }
  return out;
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

/**
 * The key a session derives for `groupBy` before any rename: its project,
 * directory, tmux session or window. Deliberately not exported: every
 * consumer goes through {@link groupKeyOf}, so a call site that forgets the
 * alias fold is a compile error rather than a group that silently splits or
 * un-collapses after a rename.
 */
function rawGroupKey(session: EnrichedSession, groupBy: GroupBy): string {
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

/**
 * The group a session belongs to: its raw key, renamed by `aliases` for this
 * mode. One hop and never chained, so an alias's value is a name, never
 * looked up again. Bucketing, sorting, pinning and collapsing all run on
 * this final name, which is what makes a rename to an existing name a merge.
 */
export function groupKeyOf(
  session: EnrichedSession,
  groupBy: GroupBy,
  aliases: GroupAliases,
): string {
  const raw = rawGroupKey(session, groupBy);
  if (groupBy === "none") return raw;
  return resolveAlias(raw, aliases[groupBy]);
}

/**
 * The key a rename replaced for `session`, or null when its group carries
 * the derived key unchanged. For search, which still finds a renamed group
 * by its old name; never a group key itself (that is {@link groupKeyOf}).
 */
export function aliasedRawKey(
  session: EnrichedSession,
  groupBy: GroupBy,
  aliases: GroupAliases,
): string | null {
  if (groupBy === "none") return null;
  const raw = rawGroupKey(session, groupBy);
  return resolveAlias(raw, aliases[groupBy]) === raw ? null : raw;
}

/** `raw` through one mode's alias map. Own properties only: a raw key that
 *  happens to be `constructor` must not read `Object.prototype`. */
function resolveAlias(
  raw: string,
  map: Readonly<Record<string, string>> | undefined,
): string {
  return map && Object.hasOwn(map, raw) ? map[raw]! : raw;
}

/**
 * The keys behind a renamed or merged group, as a header names them (a cwd
 * key home-shortened), sorted; null for a group under its own derived name.
 * What the header's marker and the group preview's sources line say.
 */
export function groupSources(
  groupKey: string,
  rawKeys: readonly string[] | undefined,
): string[] | null {
  if (!rawKeys?.length) return null;
  if (rawKeys.length === 1 && rawKeys[0] === groupKey) return null;
  return rawKeys.map(shortenCwd);
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

/** Collect filtered sessions into groups keyed by their final (aliased)
 *  names, each carrying the raw keys folded into it. */
export function groupSessions(
  filtered: FilteredSession[],
  groupBy: GroupBy,
  aliases: GroupAliases,
): AliasedGroupEntry[] {
  const map = groupBy === "none" ? undefined : aliases[groupBy];
  const groups = new Map<
    string,
    { members: FilteredSession[]; raw: Set<string> }
  >();
  for (const fs of filtered) {
    const raw = rawGroupKey(fs.session, groupBy);
    const key = resolveAlias(raw, map);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { members: [], raw: new Set() }));
    group.members.push(fs);
    group.raw.add(raw);
  }
  return [...groups.entries()].map(([key, { members, raw }]) => ({
    key,
    members,
    rawKeys: [...raw].sort((a, b) => a.localeCompare(b)),
  }));
}

export const NEEDS_YOU_GROUP_KEY = "\0needs-you";
export const NEEDS_YOU_GROUP_LABEL = "needs attention";

/**
 * The header that ENDS the `needs attention` band in the flat (`none`) grouping.
 * Grouped modes need no such thing because the next real group header already
 * closes the band; a flat list has no next header, so without this every
 * ordinary row reads as a member of the band. Like the band it is synthetic:
 * selectable, but guarded out of every group action (kill, move, collapse).
 */
export const SESSIONS_GROUP_KEY = "\0sessions";
export const SESSIONS_GROUP_LABEL = "sessions";

/** A header ccmux synthesizes rather than one a real group owns. Group actions
 *  (bulk kill, move, pin, collapse and its persistence) must never reach one. */
export function isSyntheticGroupKey(key: string): boolean {
  return key === NEEDS_YOU_GROUP_KEY || key === SESSIONS_GROUP_KEY;
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
export function sortGroups<T extends GroupEntry>(
  groups: T[],
  pinnedGroups: string[],
  byScore = false,
): T[] {
  const pinnedSet = new Set(pinnedGroups);
  const pinned: T[] = [];
  const unpinned: T[] = [];

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
 * With `attentionBand` off, waiting sessions stay in their own groups.
 * `hiddenWaiting` counts waiting sessions the repo scope keeps out of
 * `filtered`; the band carries it, and draws for it alone when none of its
 * own are left, so a scope never hides a waiting session without a word.
 */
export function buildFlatItems(
  filtered: FilteredSession[],
  groupBy: GroupBy,
  collapsed: Set<string>,
  isSearching: boolean,
  pinnedGroups: string[] = [],
  attentionBand = true,
  hiddenWaiting = 0,
  aliases: GroupAliases = {},
): FlatItem[] {
  const waitingStartedAt = (fs: FilteredSession): number => {
    const parsed = Date.parse(
      fs.session.statusChangedAt ?? fs.session.lastActivityAt ?? "",
    );
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const inBand = (fs: FilteredSession) =>
    attentionBand && fs.session.status === "waiting";
  const waiting = filtered
    .filter(inBand)
    .sort((a, b) => waitingStartedAt(a) - waitingStartedAt(b));
  const rest = filtered.filter((fs) => !inBand(fs));
  const items: FlatItem[] = [];
  const hidden = attentionBand ? hiddenWaiting : 0;
  if (waiting.length || hidden) {
    items.push({
      type: "header",
      groupKey: NEEDS_YOU_GROUP_KEY,
      label: NEEDS_YOU_GROUP_LABEL,
      count: waiting.length,
      ...(hidden ? { hiddenWaiting: hidden } : {}),
      collapsed: false,
      members: waiting,
    });
    for (const fs of waiting)
      items.push({
        type: "session",
        groupKey: NEEDS_YOU_GROUP_KEY,
        filteredSession: fs,
      });
  }
  if (groupBy === "none") {
    if ((waiting.length || hidden) && rest.length) {
      items.push({
        type: "header",
        groupKey: SESSIONS_GROUP_KEY,
        label: SESSIONS_GROUP_LABEL,
        count: rest.length,
        collapsed: false,
        members: rest,
      });
    }
    return [
      ...items,
      ...rest.map(
        (fs): FlatItem => ({
          type: "session",
          groupKey: "",
          filteredSession: fs,
        }),
      ),
    ];
  }
  const sorted = sortGroups(
    groupSessions(rest, groupBy, aliases),
    pinnedGroups,
    isSearching,
  );
  for (const { key, members, rawKeys } of sorted) {
    const isCollapsed = !isSearching && collapsed.has(key);
    const root =
      members[0]?.session.mainRepoRoot ?? members[0]?.session.worktreeRoot;
    const repoRoot =
      groupBy === "project" &&
      root &&
      members.every(
        ({ session }) =>
          (session.mainRepoRoot ?? session.worktreeRoot) === root,
      )
        ? root
        : undefined;
    const tmuxName = (fs: FilteredSession) =>
      fs.session.tmuxTarget?.split(":")[0];
    const firstTmux = tmuxName(members[0]!);
    const sharedTmuxSession =
      (groupBy === "session" || groupBy === "window") &&
      firstTmux &&
      members.every((fs) => tmuxName(fs) === firstTmux)
        ? firstTmux
        : undefined;
    items.push({
      type: "header",
      groupKey: key,
      label: groupLabelOf(key, rawKeys, groupBy),
      count: members.length,
      collapsed: isCollapsed,
      members,
      rawKeys,
      repoRoot,
    });
    if (!isCollapsed) {
      for (const fs of members)
        items.push({
          type: "session",
          groupKey: key,
          filteredSession: fs,
          sharedTmuxSession,
        });
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
type SessionLineCount = (
  session: EnrichedSession,
  item: Extract<FlatItem, { type: "session" }>,
) => number;

/**
 * Compute the visual height of a flat item.
 * Headers occupy 1 line: the header draws its own rule, so there is no
 * separate divider line to count.
 * Session items ask `lineCount`; without one they are assumed to be 2 lines.
 */
export function itemVisualHeight(
  items: FlatItem[],
  index: number,
  lineCount?: SessionLineCount,
): number {
  const item = items[index];
  if (item.type === "session") {
    if (!lineCount) return 2;
    // A row always draws its identity line, whatever the caller computes.
    return Math.max(1, lineCount(item.filteredSession.session, item));
  }
  return 1;
}

/**
 * Convert a flat item index to a visual line position: the sum of every
 * earlier item's `itemVisualHeight`.
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
