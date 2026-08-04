import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/solid";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { MouseButton } from "@opentui/core";
import { basename, resolve, sep } from "node:path";
import { getDaemonUrl } from "../../lib/config";
import type {
  PRState,
  PruneCandidate,
  PruneRunResult,
  PruneScan,
  PruneSkip,
  WorktreeSession,
} from "../../daemon/worktree-prune";
import { describeIgnoredFiles } from "../../daemon/worktree-prune";
import type {
  WorktreeListResponse,
  WorktreeRow,
} from "../../daemon/worktree-list";
import type { SessionStatus } from "../../types/session";
import { displayWidth, sliceToWidth, truncateText } from "../utils/format";
import { fitHints } from "./Footer";
import { useStatusIcon } from "../utils/useStatusIcon";
import type { IconStyle } from "../../lib/icons";
import { theme } from "../theme";

/**
 * The picker's Worktrees surface (issue #102), which grew out of the
 * prune-only dialog of issue #68.
 *
 * It still owns its own state and keyboard handling rather than pushing
 * either into the store: everything here is scoped to one open/close cycle,
 * and App.tsx simply stops handling keys while it is up (the same shape the
 * help overlay uses).
 *
 * Two things about the shape are load-bearing:
 *
 * - The read is TWO requests, not one. `GET /worktrees` is local-only and
 *   answers instantly; `GET /worktrees/prune-candidates` fetches and asks
 *   GitHub, and can take seconds. They are fired together and merged by path
 *   as they land, so the panel paints the list first and gains its
 *   classification afterwards rather than showing a spinner for both.
 * - Removal is still three explicit steps — pick, then opt in to anything
 *   dirty, then confirm — because the action deletes directories and
 *   branches. Nothing is pre-selected, and a dirty row needs its own `D` on
 *   top of being selected. The daemon enforces the same dirty gate
 *   independently, so this is the ergonomic half of the rule, not the whole
 *   of it.
 */

type Phase = "loading" | "list" | "confirm" | "running" | "done" | "error";

/**
 * The `running` phase deliberately swallows every key — a delete midway
 * through is not something to cancel — but that makes an unbounded request a
 * trap: a wedged daemon would leave the overlay permanently unusable with no
 * exit but killing the pane. Every request therefore lands in an error state
 * rather than hanging. The list is local git work; the scan is a
 * network-bound `gh` fan-out; the run can legitimately spend minutes deleting
 * large trees.
 */
const LIST_TIMEOUT_MS = 20_000;
const SCAN_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 10 * 60_000;

/** How long a `y` copy confirmation stays on the hint line. */
const COPY_NOTE_MS = 2_000;

/**
 * `GET /worktrees/prune-candidates` as it may ARRIVE.
 *
 * Every array the daemon declares required is optional here, because the
 * daemon is a long-lived background process that can predate this build:
 * `open` (the healthy in-flight-PR rows the panel badges) is simply absent
 * from an older one, and `data.open.map` on undefined would throw in the
 * middle of a merge that had nothing else wrong with it.
 */
export type ScanResponse = Partial<PruneScan>;

/**
 * The single place that knows an older daemon exists. Everything downstream
 * reads a whole {@link PruneScan}, so the guard lives at the boundary instead
 * of at each of the three reads.
 */
export function normalizeScan(data: ScanResponse): PruneScan {
  return {
    candidates: data.candidates ?? [],
    skipped: data.skipped ?? [],
    open: data.open ?? [],
  };
}

/**
 * Turn an HTTP status into something that names a cause the user can act on.
 *
 * 404 gets its own wording because it is not an exotic failure here: the
 * daemon is a long-lived background process, `GET /worktrees` is new, and a
 * daemon started before this build answers 404 for it. "HTTP 404" describes
 * that as a mystery; the restart command is the whole fix.
 */
export function describeHttpFailure(status: number): string {
  if (status === 404) {
    return "daemon is out of date (restart it: ccmux daemon restart)";
  }
  return `HTTP ${status}`;
}

/**
 * One worktree as the panel knows it: what exists (phase 1) plus whatever
 * phase 2 had to say about it, which is nothing at all for a healthy row.
 */
export interface PanelRow {
  row: WorktreeRow;
  /** Set only when the scan proved a removal reason. Gates prune selection. */
  candidate: PruneCandidate | null;
  /** Set when the scan deliberately withheld this worktree. */
  skip: PruneSkip | null;
  /** PR to badge the row with, from either half of the scan. */
  pr: PRState | null;
}

/** One repo's rows, in display order. */
export interface PanelRepo {
  repoRoot: string;
  repoName: string;
  rows: PanelRow[];
}

interface WorktreesPanelProps {
  /** Main checkout to scope to; null lists every known repo. */
  repo: string | null;
  /**
   * The picker's own directory. Additive discovery, not a filter: it is what
   * makes a repo whose agents have all exited visible at all.
   */
  cwd: string;
  /**
   * Sidebar widths (~40 cols) truncate the full hint line, and what gets cut
   * is the end — including the live "prune N" count, which is exactly the
   * feedback that tells the user a dirty row is being held back.
   */
  compact?: boolean;
  /** The picker's icon style, so a row's status glyph is the SAME one the
   *  session list draws for that status. */
  iconStyle?: IconStyle;
  onClose: () => void;
  /** Jump to a session living in the row (Enter on an occupied row). */
  onJump: (session: WorktreeSession) => void;
  /**
   * Start an agent (Enter on a row with no session). `existingWorktree` is
   * set for a linked worktree, whose directory the dialog then locks; the
   * main checkout sends null and gets the ordinary destination choice.
   */
  onSpawn: (target: { cwd: string; existingWorktree: string | null }) => void;
  /**
   * Review a worktree's uncommitted diff. Absent where review cannot run
   * (the sidebar, which has no room to suspend into a full-screen tool), and
   * the `d` hint goes with it.
   */
  onReview?: (target: { path: string; sessionId: string | null }) => void;
}

/**
 * Split a selection into what will actually be removed and what the dirty
 * gate is holding back.
 *
 * Separated from the component (and exported) because it is the rule, not a
 * rendering detail: a selected worktree with uncommitted or untracked changes
 * is removed only if it ALSO carries its own opt-in. The daemon enforces the
 * same thing independently — this half exists so the panel can say so before
 * the user commits, instead of reporting a refusal afterwards.
 */
export function partitionSelection(
  candidates: PruneCandidate[],
  selected: ReadonlySet<string>,
  dirtyOk: ReadonlySet<string>,
): { removable: PruneCandidate[]; blockedDirty: PruneCandidate[] } {
  const removable: PruneCandidate[] = [];
  const blockedDirty: PruneCandidate[] = [];
  for (const candidate of candidates) {
    if (!selected.has(candidate.path)) continue;
    if (candidate.dirty && !dirtyOk.has(candidate.path)) {
      blockedDirty.push(candidate);
    } else {
      removable.push(candidate);
    }
  }
  return { removable, blockedDirty };
}

/**
 * Whether `candidate` is the worktree at `worktreePath` or a directory inside
 * it.
 *
 * The panel's rows carry the sessions the daemon reported when the list was
 * FETCHED, and Enter acts seconds later. Re-deciding "is this worktree
 * occupied" at Enter time means asking the live session list, and a session's
 * directory is only a path — an agent that has `cd`-ed into a subdirectory is
 * still in that worktree, so this is a prefix test and not equality.
 *
 * The separator is part of the prefix on purpose: a plain `startsWith` makes
 * `/wt/feature-two` look like it lives inside `/wt/feature`.
 *
 * Compares resolved paths, not real ones. Both sides come from the same
 * daemon (git's worktree list and the pane scan), so they agree in practice;
 * a symlinked checkout reached by two different absolute paths would not
 * match, and would fall through to the spawn dialog.
 */
export function worktreeHoldsPath(
  worktreePath: string,
  candidate: string,
): boolean {
  if (!candidate) return false;
  const root = resolve(worktreePath);
  const path = resolve(candidate);
  return path === root || path.startsWith(root + sep);
}

/**
 * Where a row sits within its repo group.
 *
 * The order encodes what the panel is FOR: the main checkout anchors the
 * group, then the worktrees someone is working in, then the ones that are
 * merely alive, and last the ones the scan proved are finished. A candidate
 * sinking to the bottom is why the list re-sorts exactly once, when phase 2
 * lands, instead of settling twice.
 */
function rowBucket(entry: PanelRow): number {
  if (entry.row.isMain) return 0;
  if (entry.candidate) return 3;
  return entry.row.sessions.length > 0 ? 1 : 2;
}

/** Rows an agent is actively in sort above rows whose agent is parked. */
function sessionRank(entry: PanelRow): number {
  const sessions = entry.row.sessions;
  if (sessions.some((s) => s.status === "working" || s.status === "waiting")) {
    return 0;
  }
  return sessions.length > 0 ? 1 : 2;
}

/**
 * Sort one repo's rows. Pure and exported: it is the panel's whole layout
 * contract, and the single re-sort is the thing worth testing.
 */
export function sortWorktreeRows(rows: PanelRow[]): PanelRow[] {
  return [...rows].sort(
    (a, b) =>
      rowBucket(a) - rowBucket(b) ||
      sessionRank(a) - sessionRank(b) ||
      a.row.name.localeCompare(b.row.name),
  );
}

/**
 * Repos alphabetically, except that the one the panel was OPENED over leads.
 *
 * Widening with Tab should not make the repo the user was looking at jump to
 * wherever the alphabet puts it; the group they came from stays where their
 * eyes already are, and everything else falls in behind it.
 */
export function orderRepos<T extends { repoRoot: string; repoName: string }>(
  repos: T[],
  home: string | null,
): T[] {
  const sorted = [...repos].sort((a, b) =>
    a.repoName.localeCompare(b.repoName),
  );
  if (!home) return sorted;
  const index = sorted.findIndex((repo) => repo.repoRoot === home);
  if (index <= 0) return sorted;
  const [first] = sorted.splice(index, 1);
  return first ? [first, ...sorted] : sorted;
}

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

/**
 * The title line: the panel's name, plus the scanning suffix when phase 2 is
 * still in flight.
 *
 * The suffix rides the title so the indicator costs no rows at all, and it is
 * ALL OR NOTHING rather than fitted alongside the title. `fitSegments` would
 * happily hand back `Worktrees · rep… · ◐ scan…`, which spends the columns
 * that name the repo on a word it then truncates into nonsense; at sidebar
 * widths the title is the thing worth keeping, so the suffix is dropped whole
 * the moment both do not fit. The title itself is still fitted, because
 * OpenTUI wraps rather than clips and a wrapped line in a `height={1}` box
 * disappears entirely.
 */
export function titleSegments(
  title: string,
  suffix: string | null,
  width: number,
): RowSegment[] {
  if (suffix !== null && displayWidth(title) + displayWidth(suffix) <= width) {
    return [
      { text: title, fg: theme.text },
      { text: suffix, fg: theme.overlay },
    ];
  }
  return fitSegments([{ text: title, fg: theme.text }], width);
}

/** Dirty rows stay flagged yellow unless the cursor is on them. */
function rowColor(entry: PanelRow, isCursor: boolean): string {
  if (isCursor) return theme.text;
  return entry.row.dirty.dirty ? theme.yellow : theme.subtext;
}

/** Green for a proven merge, blue for the inferred one, peach for closed. */
function reasonColor(reason: PruneCandidate["reason"]): string {
  switch (reason) {
    case "pr-merged":
    case "merged-locally":
      return theme.green;
    case "upstream-gone":
      return theme.blue;
    case "pr-closed":
      return theme.peach;
  }
}

/** Same mapping the session rows use, so a status reads the same everywhere. */
function statusColor(status: SessionStatus): string {
  switch (status) {
    case "working":
      return theme.peach;
    case "waiting":
      return theme.red;
    case "idle":
      return theme.overlay;
  }
}

function prColor(pr: PRState): string {
  switch (pr.state) {
    case "OPEN":
      return theme.green;
    case "MERGED":
      return theme.mauve;
    case "CLOSED":
      return theme.peach;
  }
}

/**
 * Ahead/behind, in the arrows everyone already reads. Omitted when the branch
 * is in sync or has no upstream: a row of zeroes on every healthy worktree is
 * noise that pushes the facts that DO differ off a narrow panel.
 *
 * A gone upstream reads as words rather than as a bare "gone", which said
 * nothing about WHAT was gone.
 */
export function formatTracking(row: WorktreeRow): string {
  const upstream = row.upstream;
  if (!upstream) return "";
  if (upstream.gone) return "branch gone";
  const parts: string[] = [];
  if (upstream.ahead > 0) parts.push(`↑${upstream.ahead}`);
  if (upstream.behind > 0) parts.push(`↓${upstream.behind}`);
  return parts.join(" ");
}

/**
 * Uncommitted work in words, one phrase per half, and only the halves that
 * are non-zero. `0m/4u` made the reader decode a format to learn one fact.
 */
export function dirtyPhrases(row: WorktreeRow): string[] {
  if (!row.dirty.dirty) return [];
  const parts: string[] = [];
  if (row.dirty.modified > 0) parts.push(`${row.dirty.modified} modified`);
  if (row.dirty.untracked > 0) parts.push(`${row.dirty.untracked} untracked`);
  return parts;
}

/**
 * The removal reason as a phrase, derived from the REASON rather than passed
 * through from the daemon's `detail`.
 *
 * Two of the four reasons already name the PR, which is what made the old row
 * say `PR #100 merged  #100 MERGED`: the reason and the badge were rendered
 * as independent facts. Deriving here lets {@link detailPhrases} drop the
 * badge when the reason has already spoken. The daemon's own `detail` is the
 * fallback, so a reason it words differently still shows something true.
 */
export function describeReason(candidate: PruneCandidate): string {
  switch (candidate.reason) {
    // The daemon's own detail already words these well and carries the
    // number even in the cases where the candidate's `pr` did not survive the
    // trip, so it is the fallback rather than a bare "PR merged".
    case "pr-merged":
      return candidate.pr
        ? `PR #${candidate.pr.number} merged`
        : candidate.detail;
    case "pr-closed":
      return candidate.pr
        ? `PR #${candidate.pr.number} closed`
        : candidate.detail;
    case "upstream-gone":
      return "branch gone";
    case "merged-locally":
      // `merged into origin/main` names a remote the reader did not ask
      // about. Cosmetic only: an unrecognized wording passes through intact.
      return candidate.detail.replace(/\borigin\//g, "");
  }
}

/**
 * Whether a skip reason is the daemon's agent-LIVENESS gate.
 *
 * Matched on the daemon's raw wording rather than on the trimmed phrase, and
 * deliberately narrow: anything it does not recognize is treated as carrying
 * an independent fact and kept. Failing that way round shows a redundant
 * phrase, where the other way round would lose one.
 */
export function isLivenessSkip(reason: string): boolean {
  return /^an agent is /.test(reason);
}

/**
 * A withheld worktree's reason, in the panel's voice. The daemon writes full
 * sentences (`an agent is working here`); this trims the article so the
 * phrase sits in a `·`-separated line without dominating it. Anything it does
 * not recognize passes through unchanged.
 */
export function describeSkip(reason: string): string {
  return reason.replace(/^an agent is /, "agent ");
}

/** An open PR, for a healthy row. Merged and closed ones arrive as reasons. */
function describePR(pr: PRState): string {
  return `PR #${pr.number} ${pr.state.toLowerCase()}`;
}

/** The status that decides how a group of sessions is coloured and counted. */
function leadStatus(sessions: WorktreeSession[]): SessionStatus {
  if (sessions.some((s) => s.status === "waiting")) return "waiting";
  if (sessions.some((s) => s.status === "working")) return "working";
  return "idle";
}

/**
 * The agents living in a worktree, as a phrase.
 *
 * One agent is named (`claude working`); several collapse to a count, because
 * six agent names is not something a row can hold and is not what the reader
 * is asking. A mixed group leads with the count that matters: an idle six with
 * one waiting is a row you want to visit.
 */
export function describeSessions(sessions: WorktreeSession[]): string {
  const lead = sessions[0];
  if (!lead) return "";
  if (sessions.length === 1) return `${lead.agentType} ${lead.status}`;
  const status = leadStatus(sessions);
  const sharing = sessions.filter((s) => s.status === status).length;
  if (sharing === sessions.length) {
    return `${sessions.length} agents ${status}`;
  }
  return `${sessions.length} agents, ${sharing} ${status}`;
}

/** A phrase on the detail line, with the colour it carries. */
export interface Phrase {
  text: string;
  fg: string;
}

/**
 * Everything the detail line says about a row, in reading order and already
 * de-duplicated: a fact is stated once, by whichever phrase says it best.
 *
 * Empty when a worktree genuinely has nothing to report, and the component
 * then draws no second line at all rather than an indented blank.
 */
export function detailPhrases(
  entry: PanelRow,
  opts: { dirtyOk: boolean; compact?: boolean },
): Phrase[] {
  const phrases: Phrase[] = [];
  const candidate = entry.candidate;
  const row = entry.row;

  // At sidebar widths the line cannot hold both, and the phrase that must
  // survive is the one about work that would be DELETED, not the one about
  // why the row is removable (the rule above it already says that
  // categorically). At full width the reason leads, which reads better.
  const dirtyLeads = opts.compact === true && candidate?.dirty === true;
  const reasonPhrase: Phrase[] = candidate
    ? [{ text: describeReason(candidate), fg: reasonColor(candidate.reason) }]
    : [];
  if (!dirtyLeads) phrases.push(...reasonPhrase);
  // Locked comes off the worktree itself, not off the scan, so it is already
  // true on the first paint. The scan's own `locked` skip would say it twice.
  if (row.locked) phrases.push({ text: "locked", fg: theme.overlay });
  // Two ways a skip repeats something already on the row, and neither may be
  // dropped unconditionally.
  //
  // `locked` is dropped only when the row itself already said it, because a
  // lock the phase-1 read missed would otherwise vanish entirely.
  //
  // The agent-liveness gate ("an agent is working here") was a PROXY for the
  // session summary, which now states the same thing with more precision and
  // a count. It is dropped only when that summary will actually be drawn, so
  // a session-less row the daemon saw an agent in still says so rather than
  // saying nothing.
  const skipReason = entry.skip?.reason ?? "";
  const skipText = skipReason ? describeSkip(skipReason) : "";
  const sessionsText = describeSessions(row.sessions);
  const alreadySaid =
    (row.locked && skipText === "locked") ||
    (sessionsText !== "" && isLivenessSkip(skipReason));
  if (skipText && !alreadySaid) {
    phrases.push({ text: skipText, fg: theme.overlay });
  }
  // A removable row leads with its REASON, and its tracking state is either
  // that same fact (`upstream-gone`) or the thing that produced it (a merged
  // PR whose branch GitHub then deleted). Either way `PR #100 merged · branch
  // gone` states one event twice. Tracking is news only on a row that is
  // staying.
  const tracking = candidate ? "" : formatTracking(row);
  if (tracking) {
    phrases.push({
      text: tracking,
      fg: row.upstream?.gone ? theme.peach : theme.blue,
    });
  }
  // A merged or closed PR arrives as the reason; only an OPEN one is news the
  // reason has not already carried.
  const reasonNamesPR =
    candidate?.reason === "pr-merged" || candidate?.reason === "pr-closed";
  if (entry.pr && !reasonNamesPR) {
    phrases.push({ text: describePR(entry.pr), fg: prColor(entry.pr) });
  }
  const dirty = dirtyPhrases(row);
  const dirtySegments: Phrase[] = [];
  dirty.forEach((text, index) => {
    // The opt-in note rides the LAST dirty phrase, where it reads as a
    // sentence about the work rather than as a separate instruction.
    const last = index === dirty.length - 1;
    const note = candidate?.dirty && last;
    dirtySegments.push({
      text: note
        ? `${text} ${opts.dirtyOk ? "(D armed, will be deleted)" : "(D removes it too)"}`
        : text,
      fg: note && opts.dirtyOk ? theme.red : theme.yellow,
    });
  });
  if (dirtyLeads) {
    phrases.unshift(...dirtySegments);
    phrases.push(...reasonPhrase);
  } else {
    phrases.push(...dirtySegments);
  }
  if (sessionsText) {
    phrases.push({
      text: sessionsText,
      fg: statusColor(leadStatus(row.sessions)),
    });
  }
  if (candidate && candidate.ignoredFiles.length > 0) {
    phrases.push({
      text: `+${describeIgnoredFiles(candidate.ignoredFiles, 2)}`,
      fg: theme.peach,
    });
  }
  return phrases;
}

/** The separator between detail phrases, muted so the facts carry the line. */
const PHRASE_SEPARATOR = " · ";

/**
 * The rail: a single muted `│` in its own column, carried by every line of a
 * repo group below the group's first line.
 *
 * A per-row connector was the obvious first shape and the wrong one. Rows that
 * had nothing to say drew no second line, so the connector appeared and
 * vanished down the list and read as a broken rail rather than as one group.
 * Continuous means CONTINUOUS: one-line rows carry it too, and the only line
 * without it is the one the rail hangs from.
 */
export const RAIL = "│";

/** Columns before line 1's content: the cursor bar, the rail, and a space.
 *  The marker slot is inside `primarySegments`, not here. */
export const ROW_GUTTER = 3;

/**
 * The marker slot's width, which is not one number: a status icon is one
 * column and a bracket checkbox is three, each plus a trailing space.
 *
 * The detail line spends the same slot on indentation, so it has to follow
 * the wider marker inside the removable section or the section's two lines
 * would not line up with each other.
 */
export function markerWidth(hasCheckbox: boolean): number {
  return hasCheckbox ? 4 : 2;
}

/** Columns before a detail line's content, for a row with or without a box. */
export function detailGutter(hasCheckbox: boolean): number {
  return ROW_GUTTER + markerWidth(hasCheckbox);
}

/** Columns the scrollbox keeps to itself for its scrollbar. */
const SCROLLBAR_GUTTER = 1;

/** Phrases as renderable segments, with the separator as its own segment so
 *  it stays muted while the phrases keep their own colours. */
export function detailSegments(
  entry: PanelRow,
  opts: { compact: boolean; dirtyOk: boolean },
): RowSegment[] {
  const segments: RowSegment[] = [];
  for (const phrase of detailPhrases(entry, opts)) {
    if (segments.length > 0) {
      segments.push({ text: PHRASE_SEPARATOR, fg: theme.overlay });
    }
    segments.push(phrase);
  }
  return segments;
}

/**
 * The name a row shows.
 *
 * The main checkout says what it IS rather than repeating the directory name,
 * which the repo header directly above has already said.
 */
export function rowLabel(row: WorktreeRow): string {
  return row.isMain ? "main checkout" : row.name;
}

/**
 * The branch, or empty when naming it would only stutter.
 *
 * A worktree derived from its branch carries the same word twice
 * (`fix-codex  fix-codex`), which is the single loudest thing on a screen full
 * of rows and says nothing. Shown only where the two genuinely differ.
 */
export function rowBranch(row: WorktreeRow): string {
  if (row.detached || !row.branch) return "detached";
  return row.branch === rowLabel(row) ? "" : row.branch;
}

/** Longest label in a group, so one group's branches line up in a column. */
export function labelColumnWidth(rows: PanelRow[], max = 28): number {
  let width = 0;
  for (const entry of rows) {
    width = Math.max(width, displayWidth(rowLabel(entry.row)));
  }
  return Math.min(width, max);
}

/**
 * Line 1: the icon slot, the name, and the branch when it differs.
 *
 * Everything else a row knows moved to the detail line. That is what buys the
 * alignment: the name always starts in the same column and the branch always
 * starts in the same column, so a group reads as a table instead of as a
 * paragraph that happens to be wrapped.
 */
export function primarySegments(
  entry: PanelRow,
  opts: {
    isCursor: boolean;
    labelWidth: number;
    selected?: boolean;
    /** The live status glyph for an occupied row, already resolved by the
     *  caller (it animates, so it cannot come from a pure function). */
    statusIcon?: string;
  },
): RowSegment[] {
  const row = entry.row;
  const segments: RowSegment[] = [];
  if (entry.candidate) {
    // The only rows with checkboxes are the ones under the removable
    // divider, which is what makes an unexplained checkbox impossible.
    // Brackets rather than ☐/☑: they are unambiguously three columns in
    // every font, where the ballot glyphs are East Asian Ambiguous and would
    // take two columns wherever a terminal decides they are wide, breaking
    // the column the whole group aligns on.
    segments.push({
      text: opts.selected ? "[x] " : "[ ] ",
      fg: opts.selected ? theme.green : theme.overlay,
    });
  } else if (row.isMain) {
    segments.push({ text: "⌂ ", fg: theme.mauve });
  } else if (row.sessions.length > 0) {
    // The SAME glyph the session list uses for that status, spinner included:
    // a static dot on a working row asked the reader to learn a second
    // vocabulary for a fact ccmux already has one for.
    segments.push({
      text: `${opts.statusIcon ?? "●"} `,
      fg: statusColor(leadStatus(row.sessions)),
    });
  } else {
    segments.push({ text: "  ", fg: theme.overlay });
  }

  const label = rowLabel(row);
  const branch = rowBranch(entry.row);
  segments.push({ text: label, fg: rowColor(entry, opts.isCursor) });
  if (branch) {
    const pad = Math.max(1, opts.labelWidth - displayWidth(label) + 2);
    segments.push({ text: " ".repeat(pad), fg: theme.overlay });
    segments.push({ text: branch, fg: theme.overlay });
  }
  return segments;
}

/**
 * A repo group's rows split at the removable line.
 *
 * `sortWorktreeRows` already sinks classified candidates to the bottom, so
 * this is a partition and not a re-sort; it exists because the divider, the
 * checkbox rule and the line arithmetic all need to agree on where the
 * section starts.
 */
export function splitRemovable(rows: PanelRow[]): {
  kept: PanelRow[];
  removable: PanelRow[];
} {
  return {
    kept: rows.filter((entry) => !entry.candidate),
    removable: rows.filter((entry) => entry.candidate),
  };
}

/**
 * Whether the list draws a header line per repo.
 *
 * A single repo has its name in the panel's own title, and repeating it
 * directly underneath is a line spent saying nothing. Derived rather than
 * passed so the render and the line arithmetic cannot disagree about how many
 * lines exist.
 */
export function showsGroupHeaders(repos: PanelRepo[]): boolean {
  return repos.length > 1;
}

/**
 * The full-width rule that opens a group's removable section.
 *
 * Starts with a tee so the rail runs INTO it rather than being interrupted by
 * it: the section is a labelled break in one group, not a new group.
 */
export function dividerText(count: number, width: number): string {
  const label = `├─ removable · ${count} `;
  const fill = Math.max(0, width - displayWidth(label));
  return `${label}${"─".repeat(fill)}`;
}

/** `1 worktree` / `3 worktrees`, so no sentence has to say `worktree(s)`. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The removal's headline, as a sentence rather than a schema.
 *
 * `Delete 1 worktree(s), 1 branch(es)?` made the reader parse a form to learn
 * what was about to be deleted, at the one moment where the reading has to be
 * effortless.
 */
export function describeRemoval(worktrees: number, branches: number): string {
  if (branches === 0) {
    return `Delete ${plural(worktrees, "worktree", "worktrees")}?`;
  }
  if (worktrees === 1 && branches === 1) {
    return "Delete 1 worktree and its branch?";
  }
  return `Delete ${plural(worktrees, "worktree", "worktrees")} and ${plural(
    branches,
    "branch",
    "branches",
  )}?`;
}

/**
 * The lines under the headline: everything that is true of THIS removal and
 * nothing that is not. Each one is a consequence the headline does not carry,
 * so an empty list means the headline told the whole story.
 */
export function removalDetails(opts: {
  includedDirty: number;
  blockedDirty: number;
  ignoredFiles: number;
}): string[] {
  const lines: string[] = [];
  if (opts.includedDirty > 0) {
    lines.push(
      `including ${plural(opts.includedDirty, "worktree", "worktrees")} with uncommitted work`,
    );
  }
  if (opts.blockedDirty > 0) {
    lines.push(
      `skipping ${plural(opts.blockedDirty, "dirty worktree", "dirty worktrees")} (needs D)`,
    );
  }
  if (opts.ignoredFiles > 0) {
    lines.push(
      `${plural(opts.ignoredFiles, "ignored file", "ignored files")} go too`,
    );
  }
  return lines;
}

/**
 * The removal confirmation, as a centered box over the list.
 *
 * Mirrors `ConfirmationDialog`'s visual language (the same centered box,
 * border, and `Y confirm / N cancel` row) rather than reusing it: that
 * component is typed against `ConfirmAction` and a `Session`, and renders a
 * single subtitle line where this needs a headline plus up to three
 * consequences. It renders as a CHILD of the panel, never through
 * `store.showConfirmDialog`, because a sibling overlay is exactly how the
 * send-review confirm ended up buried under this panel.
 */
const RemovalConfirm: Component<{
  headline: string;
  details: string[];
  destructive: boolean;
  width: number;
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => {
  const boxWidth = () => Math.max(24, Math.min(56, props.width));
  const boxHeight = () => 7 + props.details.length;
  return (
    <box
      position="absolute"
      top="50%"
      left="50%"
      width={boxWidth()}
      height={boxHeight()}
      marginTop={-Math.floor(boxHeight() / 2)}
      marginLeft={-Math.floor(boxWidth() / 2)}
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={props.destructive ? theme.red : theme.border}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
    >
      <text fg={theme.text}>
        <strong>Remove worktrees?</strong>
      </text>
      <box height={1} />
      {/* Red only when uncommitted work is actually going, so the one
          irreversible case does not read like the routine one. */}
      <text fg={props.destructive ? theme.red : theme.subtext}>
        {truncateText(props.headline, boxWidth() - 2)}
      </text>
      <For each={props.details}>
        {(line) => (
          <text fg={theme.overlay}>{truncateText(line, boxWidth() - 2)}</text>
        )}
      </For>
      <box height={1} />
      <box flexDirection="row">
        <box
          flexDirection="row"
          onMouseDown={(event) => {
            if (event.button === MouseButton.LEFT) props.onConfirm();
          }}
        >
          <text fg={theme.green}>
            <strong>Y</strong>
          </text>
          <text fg={theme.overlay}> confirm </text>
        </box>
        <box
          flexDirection="row"
          onMouseDown={(event) => {
            if (event.button === MouseButton.LEFT) props.onCancel();
          }}
        >
          <text fg={theme.red}>
            <strong>N</strong>
          </text>
          <text fg={theme.overlay}> cancel</text>
        </box>
      </box>
    </box>
  );
};

/**
 * Visual LINES a row occupies: its name line, plus the detail line when there
 * is anything to put on it.
 *
 * Rows are not one line each, which is what made scrolling by row INDEX
 * wrong: a scrollbox measures `scrollTop` in lines, so a list of one- and
 * two-line rows scrolled the cursor off screen while the keys kept acting on
 * the row nobody could see. Derived from `detailPhrases` rather than from a
 * copy of its conditions, so the height and the render cannot disagree about
 * whether a line exists.
 */
export function rowVisualHeight(entry: PanelRow, compact = false): number {
  return (
    1 + (detailPhrases(entry, { dirtyOk: false, compact }).length > 0 ? 1 : 0)
  );
}

/** Where each row starts, and how tall it is, in the scrollbox's own units. */
export type VisualLayout = Map<string, { line: number; height: number }>;

/**
 * Lay the whole list out in visual lines: repo headers and the removable
 * divider each take one, and a row takes whatever {@link rowVisualHeight}
 * says.
 *
 * The divider is not a row and the cursor never lands on it, but it is a LINE,
 * and a scroll target computed without it puts every row below the divider one
 * line off. Keyed by PATH for the same reason the cursor is: phase 2 re-sorts
 * the list, and a layout keyed by position would describe the arrangement the
 * cursor just left.
 */
export function visualLayout(
  repos: PanelRepo[],
  heightOf: (entry: PanelRow) => number,
): VisualLayout {
  const layout: VisualLayout = new Map();
  let line = 0;
  const place = (entry: PanelRow) => {
    const height = heightOf(entry);
    layout.set(entry.row.path, { line, height });
    line += height;
  };
  const headers = showsGroupHeaders(repos);
  for (const repo of repos) {
    if (headers) line += 1; // the repo header
    const { kept, removable } = splitRemovable(repo.rows);
    kept.forEach(place);
    if (removable.length > 0) line += 1; // the removable divider
    removable.forEach(place);
  }
  return layout;
}

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

/**
 * argv that puts stdin on the system clipboard, or null where there is none
 * to put it on.
 *
 * The LOCAL fallback, used only when the terminal won't take OSC 52.
 * Deliberately macOS-only: `pbcopy` is always present there, while every
 * Linux answer (`wl-copy`, `xclip`, `xsel`) depends on which display server
 * is running and on a package that may not be installed, and a copy key that
 * silently fails is worse than one that says it cannot.
 */
export function clipboardArgv(
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  return platform === "darwin" ? ["pbcopy"] : null;
}

/** What {@link copyToClipboard} needs from the renderer, named so tests can
 *  supply it without one. */
export interface Osc52Writer {
  isOsc52Supported(): boolean;
  copyToClipboardOSC52(text: string): boolean;
}

/**
 * Put `text` on the clipboard through BOTH channels available, and report
 * which ones were tried.
 *
 * Both, rather than one with the other as fallback, because neither can be
 * confirmed and they cover different machines:
 *
 * - OSC 52 goes out through the TERMINAL, so it is the only thing that
 *   reaches the clipboard the user is looking at when ccmux runs over ssh
 *   (the documented remote setup), where the remote's `pbcopy` is either
 *   absent or copies to the wrong machine. But `copyToClipboardOSC52`
 *   returning true only means the sequence was WRITTEN: a terminal that
 *   drops it, or a tmux without `set-clipboard on`, reports success and
 *   copies nothing.
 * - The local helper is verifiable but only exists on the machine ccmux runs
 *   on.
 *
 * Preferring either one alone therefore means a `y` that silently does
 * nothing in the other's case. Writing the same text to both costs one
 * escape sequence and one short-lived process, and the failure mode becomes
 * a redundant copy instead of a missing one.
 */
export function copyToClipboard(
  text: string,
  writer: Osc52Writer | null,
  spawn: (argv: string[], text: string) => boolean = spawnClipboardHelper,
): { osc52: boolean; local: boolean } {
  const osc52 = Boolean(
    writer?.isOsc52Supported() && writer.copyToClipboardOSC52(text),
  );
  const argv = clipboardArgv();
  const local = argv !== null && spawn(argv, text);
  return { osc52, local };
}

function spawnClipboardHelper(argv: string[], text: string): boolean {
  try {
    const child = Bun.spawn(argv, {
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    void child.exited;
    return true;
  } catch {
    return false;
  }
}

export const WorktreesPanel: Component<WorktreesPanelProps> = (props) => {
  const dims = useTerminalDimensions();
  // Only for `y`: OSC 52 goes out through the terminal the renderer owns.
  const renderer = useRenderer();
  const [phase, setPhase] = createSignal<Phase>("loading");
  const [repos, setRepos] = createSignal<WorktreeListResponse["repos"]>([]);
  const [scan, setScan] = createSignal<PruneScan | null>(null);
  /** Phase 2's failure, which leaves the panel usable read-only. */
  const [scanError, setScanError] = createSignal<string | null>(null);
  const [cursorPath, setCursorPath] = createSignal<string | null>(null);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [dirtyOk, setDirtyOk] = createSignal<Set<string>>(new Set());
  const [result, setResult] = createSignal<PruneRunResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** True while the panel is narrowed to `props.repo`; Tab flips it. */
  const [scoped, setScoped] = createSignal(props.repo !== null);
  const [note, setNote] = createSignal<string | null>(null);
  let listBox: ScrollBoxRenderable | undefined;
  /** Bumped when the scrollbox is measured or resized, so the scroll effect
   *  re-runs once there is a real viewport height to fit the cursor into. */
  const [scrollboxLayout, setScrollboxLayout] = createSignal(0);
  let resultBox: ScrollBoxRenderable | undefined;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Which load the in-flight requests belong to. Tab refetches both phases,
   * and the slow one from the previous scope would otherwise land on top of
   * the new one.
   */
  let loadGeneration = 0;

  onCleanup(() => {
    if (noteTimer) clearTimeout(noteTimer);
  });

  /** Repo filter currently in force, which is what both requests carry. */
  const repoFilter = (): string | null => (scoped() ? props.repo : null);

  const merged = createMemo<PanelRepo[]>(() => {
    const data = scan();
    const candidates = new Map(data?.candidates.map((c) => [c.path, c]) ?? []);
    const skips = new Map(data?.skipped.map((s) => [s.path, s]) ?? []);
    const openPRs = new Map((data?.open ?? []).map((o) => [o.path, o.pr]));
    return orderRepos(repos(), props.repo).map((repo) => ({
      repoRoot: repo.repoRoot,
      repoName: repo.repoName,
      rows: sortWorktreeRows(
        repo.worktrees.map((row) => {
          const candidate = candidates.get(row.path) ?? null;
          return {
            row,
            candidate,
            skip: skips.get(row.path) ?? null,
            pr: openPRs.get(row.path) ?? candidate?.pr ?? null,
          };
        }),
      ),
    }));
  });

  /** Every row in display order, which is what the cursor walks. */
  const flatRows = createMemo(() => merged().flatMap((repo) => repo.rows));

  const candidates = (): PruneCandidate[] => scan()?.candidates ?? [];

  // Tracked by PATH, not index: phase 2 re-sorts the list under the cursor,
  // and an index would silently point at whichever row moved into that slot.
  const cursorIndex = (): number => {
    const path = cursorPath();
    const rows = flatRows();
    const found = path ? rows.findIndex((r) => r.row.path === path) : -1;
    return found >= 0 ? found : 0;
  };
  const cursorRow = (): PanelRow | null => flatRows()[cursorIndex()] ?? null;

  // Seed the cursor the moment there is a row to sit on. Leaving it null and
  // falling back to index 0 looks identical until phase 2 re-sorts, at which
  // point "index 0" is a different worktree and the cursor has silently
  // jumped to whatever took the top slot.
  createEffect(() => {
    const rows = flatRows();
    const first = rows[0];
    if (cursorPath() === null && first) setCursorPath(first.row.path);
  });

  /**
   * Keep the cursor's row on screen.
   *
   * An effect rather than something `moveCursor` does, because the two ways
   * the cursor's row leaves the viewport are not both keypresses: phase 2
   * re-sorts the list, and a row can move out from under a cursor nobody
   * touched. Every key that acts (space, x, Enter, y, D) acts on the cursor,
   * so a cursor off screen is a key acting on a row the user cannot see.
   */
  createEffect(() => {
    // The scrollbox mounts in the same update that delivers the first rows,
    // so this effect's initial run can land before yoga has measured it:
    // scrollTo clamps against a zero-size viewport and the scroll is lost.
    void scrollboxLayout();
    const path = cursorPath();
    if (!listBox || !path) return;
    const target = scrollTargetFor(
      visualLayout(merged(), (entry) =>
        rowVisualHeight(entry, props.compact === true),
      ),
      path,
      listBox.scrollTop,
      listBox.viewport?.height ?? 0,
    );
    if (target !== null) listBox.scrollTo(target);
  });

  const partition = createMemo(() =>
    partitionSelection(candidates(), selected(), dirtyOk()),
  );
  /** Selected rows that will actually be removed (dirty ones need `D`). */
  const effective = () => partition().removable;
  const blockedDirty = () => partition().blockedDirty;
  /** Ignored files riding along with the current selection — nothing in git
   *  or in the trash window brings these back, so they are named at the
   *  confirmation step and not only on the rows. */
  const ignoredCount = () =>
    effective().reduce((n, c) => n + c.ignoredFiles.length, 0);
  /** Selected dirty rows that WILL be deleted (their opt-in is live). */
  const includedDirty = () => effective().filter((c) => c.dirty);

  /** Columns a row may occupy: the box minus its border and padding. */
  const contentWidth = () => Math.max(8, dims().width - 4);
  /** What a line inside the SCROLLBOX may occupy: the content less the column
   *  the scrollbox keeps for its bar. Text that overruns it does not clip, it
   *  WRAPS, and a wrapped line inside a `height={1}` box disappears instead:
   *  that is how the removable divider lost its rule (its run of dashes is one
   *  unbreakable word, so the whole word moved to a line nobody renders). */
  const listWidth = () => Math.max(8, contentWidth() - SCROLLBAR_GUTTER);
  /** Line 1's budget, past the cursor bar, the rail and their space. The icon
   *  slot lives inside `primarySegments`, so it is not subtracted here. */
  const rowWidth = () => Math.max(4, listWidth() - ROW_GUTTER);
  /** The detail line's budget, which also spends the marker slot on indent. */
  const detailWidth = (hasCheckbox: boolean) =>
    Math.max(4, listWidth() - detailGutter(hasCheckbox));

  /**
   * The panel's title. A single repo puts its name here, which is what lets
   * the list drop the group header line that would otherwise repeat it.
   */
  const panelTitle = (): string => {
    const repos = merged();
    const only = repos.length === 1 ? repos[0] : undefined;
    return only ? `Worktrees · ${only.repoName}` : "Worktrees";
  };

  /**
   * Whether phase 2 is still in flight.
   *
   * Derived from the merge's own inputs rather than kept as a second flag, so
   * the indicator cannot disagree with the data it describes. That also makes
   * it right across the generation counter for free: `load()` clears both
   * before firing, so a re-fired scan (Tab, `r`) shows the indicator again,
   * and every completion returns early on a stale generation, so a slow scan
   * from the previous scope can never clear a newer one's indicator.
   */
  const scanning = (): boolean => scan() === null && scanError() === null;

  // Purely decorative, and gated on `scanning()` so the shared spinner
  // interval is released the moment the scan lands. Nothing keys off it: the
  // list is fully navigable, selectable and actionable throughout phase 1.
  const scanIcon = useStatusIcon(
    () => (scanning() ? "working" : "idle"),
    () => null,
    // Spelled out, never left to default: `getAnimationFrames` only animates
    // a style it was given, so an undefined one renders a STATIC dot here.
    () => props.iconStyle ?? "dot",
  );

  /** The muted tail on the title line, or null when there is nothing to say. */
  const scanSuffix = (): string | null =>
    scanning() ? ` · ${scanIcon()} scanning` : null;

  const titleLine = createMemo(() =>
    titleSegments(panelTitle(), scanSuffix(), contentWidth()),
  );

  function flash(message: string): void {
    setNote(message);
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => setNote(null), COPY_NOTE_MS);
  }

  /**
   * Fire both reads. They are independent requests rather than a sequence:
   * phase 1 is local git work that answers in milliseconds and phase 2 talks
   * to GitHub, so waiting for one to start the other would cost the whole
   * point of splitting them.
   */
  function load(): void {
    const generation = ++loadGeneration;
    const filter = repoFilter();
    setPhase("loading");
    setScan(null);
    setScanError(null);

    const listUrl = new URL(`${getDaemonUrl()}/worktrees`);
    if (filter) listUrl.searchParams.set("repo", filter);
    if (props.cwd) listUrl.searchParams.set("cwd", props.cwd);
    fetch(listUrl, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(describeHttpFailure(response.status));
        const data = (await response.json()) as WorktreeListResponse;
        if (generation !== loadGeneration) return;
        setRepos(data.repos);
        setPhase("list");
      })
      .catch((err: unknown) => {
        if (generation !== loadGeneration) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });

    const scanUrl = new URL(`${getDaemonUrl()}/worktrees/prune-candidates`);
    if (filter) scanUrl.searchParams.set("repo", filter);
    if (props.cwd) scanUrl.searchParams.set("cwd", props.cwd);
    fetch(scanUrl, { signal: AbortSignal.timeout(SCAN_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(describeHttpFailure(response.status));
        const data = normalizeScan((await response.json()) as ScanResponse);
        if (generation !== loadGeneration) return;
        setScan(data);
        // A selection made before the classification landed, or carried
        // across a Tab, may name paths this scope never classified. Dropping
        // them here keeps a stale opt-in from re-arming invisibly the next
        // time the same row is picked.
        const live = new Set(data.candidates.map((c) => c.path));
        setSelected((prev) => new Set([...prev].filter((p) => live.has(p))));
        setDirtyOk((prev) => new Set([...prev].filter((p) => live.has(p))));
      })
      .catch((err: unknown) => {
        if (generation !== loadGeneration) return;
        // Read-only degradation on purpose: the list is already on screen and
        // still worth navigating, jumping from and spawning into. Only the
        // prune half is unavailable, and the line says so.
        setScanError(err instanceof Error ? err.message : String(err));
      });
  }

  onMount(load);

  function toggleSelected(path: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
        // Deselecting revokes the dirty opt-in with it. Otherwise the opt-in
        // outlives the selection and re-arms invisibly when the row is picked
        // again, with no second `D` and nothing on screen to say so.
        setDirtyOk((ok) => {
          if (!ok.has(path)) return ok;
          const copy = new Set(ok);
          copy.delete(path);
          return copy;
        });
      } else next.add(path);
      return next;
    });
  }

  function toggleDirtyOk(candidate: PruneCandidate): void {
    if (!candidate.dirty) return;
    setDirtyOk((prev) => {
      const next = new Set(prev);
      if (next.has(candidate.path)) next.delete(candidate.path);
      else next.add(candidate.path);
      return next;
    });
    // Opting in to losing the work is a strictly stronger statement than
    // selecting the row, so it implies the selection rather than requiring a
    // second keypress to express the same intent.
    setSelected((prev) => new Set(prev).add(candidate.path));
  }

  function moveCursor(delta: number): void {
    const rows = flatRows();
    if (rows.length === 0) return;
    const next = Math.min(Math.max(cursorIndex() + delta, 0), rows.length - 1);
    setCursorPath(rows[next]!.row.path);
    // Scrolling is an EFFECT of where the cursor is, not of the keypress that
    // moved it: the phase-2 re-sort moves rows under a cursor nobody touched,
    // and only an effect keeps that row on screen too.
  }

  /**
   * Enter, which means whatever the row is: go to the agent already there,
   * or start one where there is none. The main checkout gets the ordinary
   * dialog (its destination is a real choice); a linked worktree locks the
   * directory to itself, because a second session in the same worktree is
   * deliberately not a thing this panel offers.
   */
  function activateRow(entry: PanelRow): void {
    const session = entry.row.sessions[0];
    if (session) {
      props.onJump(session);
      return;
    }
    props.onSpawn(
      entry.row.isMain
        ? { cwd: entry.row.repoRoot, existingWorktree: null }
        : { cwd: entry.row.path, existingWorktree: entry.row.path },
    );
  }

  function copyPath(path: string): void {
    const how = copyToClipboard(path, renderer);
    flash(
      how.osc52 || how.local
        ? `copied ${basename(path)}`
        : "copy needs OSC 52 or pbcopy",
    );
  }

  function runPrune(): void {
    const chosen = effective();
    setPhase("running");
    fetch(`${getDaemonUrl()}/worktrees/prune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: chosen.map((c) => c.path),
        allowDirty: chosen.filter((c) => c.dirty).map((c) => c.path),
        source: "picker",
        repo: repoFilter(),
        cwd: props.cwd,
        // Exempt THIS surface's own pane from the daemon's live-pane
        // occupancy guard. The picker's popup is invisible to it (a
        // `display-popup` is not a real pane and never appears in
        // `list-panes -a`), but the SIDEBAR runs in a real one, so pruning
        // the worktree its pane sits in would otherwise refuse on itself.
        // `JSON.stringify` drops the key when the variable is unset, which is
        // exactly the optional-field contract the endpoint expects.
        callerPane: process.env.TMUX_PANE,
      }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    })
      .then(async (response) => {
        const data = (await response.json()) as PruneRunResult & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(data.error ?? `HTTP ${response.status}`);
        setResult(data);
        setPhase("done");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });
  }

  useKeyboard((event: KeyEvent) => {
    const key = event.name;
    event.preventDefault();

    if (phase() === "running") return;

    if (phase() === "done" || phase() === "error") {
      // The commonest error here is a daemon that was started before this
      // build, which the user fixes in another pane and then wants to retry.
      // Without this the only way back is to close and reopen, and on the
      // `done` phase a stale list is exactly what a retry refreshes.
      if (key === "r" || key === "R") {
        load();
        return;
      }
      if (
        key === "q" ||
        key === "escape" ||
        key === "return" ||
        key === "enter"
      ) {
        props.onClose();
      }
      if (resultBox && (key === "j" || key === "k")) {
        resultBox.scrollTo(resultBox.scrollTop + (key === "j" ? 1 : -1));
      }
      return;
    }

    if (phase() === "confirm") {
      if (key === "y" || key === "Y") runPrune();
      else if (key === "n" || key === "N" || key === "escape") setPhase("list");
      return;
    }

    const entry = cursorRow();
    switch (key) {
      case "j":
      case "down":
        moveCursor(1);
        break;
      case "k":
      case "up":
        moveCursor(-1);
        break;
      case "space":
      case " ":
        // Only a classified candidate is selectable: the main checkout, a
        // held row and a healthy one have no removal to opt into, and a
        // checkbox on them would promise one.
        if (entry?.candidate) toggleSelected(entry.candidate.path);
        break;
      // `A` too, matching x/X, y/Y and D/d below: a shift held a beat too long
      // should not silently do nothing.
      case "a":
      case "A":
        // "All" means all CLEAN rows: a bulk key must never be the thing that
        // opts a dirty worktree in. Clearing the opt-ins matters as much as
        // the selection — a stale `dirtyOk` left behind would silently re-arm
        // the moment the row was selected again by hand.
        setSelected(
          new Set(
            candidates()
              .filter((c) => !c.dirty)
              .map((c) => c.path),
          ),
        );
        setDirtyOk(new Set<string>());
        break;
      // Shift+D opts a dirty row in; a bare `d` reviews the row's diff. Both
      // spellings of the capital are matched because terminals disagree: the
      // key arrives as name `"d"` with `shift` set, not as `"D"`. Testing
      // only `case "D"` made the opt-in unreachable, which the keyboard tests
      // caught.
      case "D":
      case "d": {
        if (key === "D" || event.shift) {
          if (entry?.candidate) toggleDirtyOk(entry.candidate);
          break;
        }
        if (entry && props.onReview) {
          props.onReview({
            path: entry.row.path,
            sessionId: entry.row.sessions[0]?.id ?? null,
          });
        }
        break;
      }
      // Removal moved off Enter, which now means "open this worktree". `x`
      // is the picker's kill key on a session row, so it is the same verb in
      // the same place rather than a new one to learn.
      case "x":
      case "X": {
        if (effective().length > 0) {
          setPhase("confirm");
          break;
        }
        // With nothing selected, `x` used to do nothing at all, which reads as
        // a broken key. It now either acts on the row under the cursor or says
        // what is missing.
        if (entry?.candidate && !entry.candidate.dirty) {
          // Single-target: the cursor IS the selection anyone would have made,
          // and the confirm still stands between it and the deletion.
          toggleSelected(entry.candidate.path);
          setPhase("confirm");
          break;
        }
        if (entry?.candidate) {
          // A dirty row selected on its own still removes nothing, so sending
          // it to a "delete 0 worktrees" confirm would be the same dead end
          // wearing a dialog. Name the key that unblocks it instead.
          flash("uncommitted work here: D includes it, then x");
          break;
        }
        flash("nothing selected: space selects a worktree under `removable`");
        break;
      }
      case "return":
      case "enter":
        if (entry) activateRow(entry);
        break;
      case "y":
      case "Y":
        if (entry) copyPath(entry.row.path);
        break;
      case "tab":
        // Inert with nothing to scope to: the panel is already showing every
        // repo it knows about.
        if (props.repo === null) break;
        setScoped((on) => !on);
        load();
        break;
      case "q":
      case "escape":
        props.onClose();
        break;
    }
  });

  /**
   * The hint line, ranked so a narrow panel drops the optional keys rather
   * than clipping the line mid-word. Same machinery the footer uses.
   */
  const hintLine = () => {
    // The removal keys are taught where they apply: on a row under the
    // removable divider, or once something is already selected (so the count
    // and the way to act on it never disappear mid-selection). Everywhere
    // else they are noise about an action the cursor cannot take.
    const inRemovable = cursorRow()?.candidate != null;
    const removing = inRemovable || selected().size > 0;
    return fitHints(
      [
        { text: "j/k move", rank: 3 },
        { text: "enter open", rank: 4 },
        ...(removing
          ? [
              { text: "space select", rank: 3 },
              // A bare `x remove` until something is selected: `x remove 0`
              // reads as a broken count rather than as an empty selection.
              {
                text:
                  effective().length > 0
                    ? `x remove ${effective().length}`
                    : "x remove",
                rank: 4,
              },
              { text: "D dirty too", rank: 1 },
              { text: "a all clean", rank: 1 },
            ]
          : []),
        { text: "y copy", rank: 1 },
        ...(props.onReview ? [{ text: "d review", rank: 1 }] : []),
        ...(props.repo !== null
          ? [{ text: scoped() ? "tab all repos" : "tab this repo", rank: 2 }]
          : []),
        { text: "q close", rank: 5 },
      ],
      contentWidth(),
    );
  };

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      {/* No justifyContent here: with flexDirection="row" it would center the
          title horizontally, where the pre-scanning-suffix box only centered
          vertically (a height-1 no-op) and the header has always read as
          left-aligned like every other dialog's. */}
      <box width="100%" height={1} flexDirection="row">
        <text fg={titleLine()[0]?.fg ?? theme.text}>
          <strong>{titleLine()[0]?.text ?? ""}</strong>
        </text>
        <Show when={titleLine()[1]}>
          {(segment: () => RowSegment) => (
            <text fg={segment().fg}>{segment().text}</text>
          )}
        </Show>
      </box>

      {/* One always-present growing body. A `flexGrow` scrollbox that only
          exists inside a <Show> never resolves a height, which drops the
          footer to the top of the panel and paints the list under it. */}
      <box flexGrow={1} flexDirection="column">
        <Show when={phase() === "loading"}>
          <box paddingTop={1}>
            <text fg={theme.subtext}>Reading worktrees...</text>
          </box>
        </Show>

        <Show when={phase() === "error"}>
          <box paddingTop={1} flexDirection="column">
            <text fg={theme.red}>
              {truncateText(error() ?? "", contentWidth())}
            </text>
            <text fg={theme.overlay}>r retry · q close</text>
          </box>
        </Show>

        <Show when={phase() === "list" || phase() === "confirm"}>
          <Show
            when={flatRows().length > 0}
            fallback={
              <box paddingTop={1}>
                <text fg={theme.subtext}>No worktrees found.</text>
              </box>
            }
          >
            <scrollbox
              flexGrow={1}
              ref={(r: ScrollBoxRenderable) => {
                listBox = r;
                // The root's resize fires before its children are measured,
                // so listen on the node the scroll effect actually reads.
                const bump = () => setScrollboxLayout((v) => v + 1);
                r.viewport.on("resize", bump);
                r.content.on("resize", bump);
              }}
            >
              <For each={merged()}>
                {(repo) => {
                  const split = () => splitRemovable(repo.rows);
                  const labelWidth = () => labelColumnWidth(repo.rows);
                  /* One row, in both sections: the section only decides
                     whether it carries a checkbox. */
                  /**
                   * One row. `railed` is false only for the group's very
                   * first LINE, which is what the rail hangs from.
                   */
                  const renderRow = (entry: PanelRow, railed: boolean) => {
                    const isCursor = () =>
                      cursorRow()?.row.path === entry.row.path;
                    const isSelected = () => selected().has(entry.row.path);
                    const detail = () =>
                      detailSegments(entry, {
                        compact: props.compact === true,
                        dirtyOk: dirtyOk().has(entry.row.path),
                      });
                    // The session list's own icon, spinner and all. Called
                    // per row, which `<For>` gives its own reactive owner, so
                    // the shared spinner interval is acquired and released
                    // with the row.
                    const statusIcon = useStatusIcon(
                      () => leadStatus(entry.row.sessions),
                      () => null,
                      // Defaulted here because the two halves of the icon API
                      // disagree: `getStatusIcon` treats an unset style as
                      // "dot" while `getAnimationFrames` needs it spelled out,
                      // so leaving it undefined yields a STATIC dot on a
                      // working row, which is the exact bug being fixed.
                      () => props.iconStyle ?? "dot",
                    );
                    return (
                      <box flexDirection="column">
                        <box height={1} flexDirection="row">
                          <text fg={isCursor() ? theme.mauve : theme.overlay}>
                            {isCursor() ? "▎" : " "}
                          </text>
                          <text fg={theme.overlay}>
                            {railed ? `${RAIL} ` : "  "}
                          </text>
                          <For
                            each={fitSegments(
                              primarySegments(entry, {
                                isCursor: isCursor(),
                                labelWidth: labelWidth(),
                                selected: isSelected(),
                                statusIcon: statusIcon(),
                              }),
                              rowWidth(),
                            )}
                          >
                            {(segment) => (
                              <text fg={segment.fg}>{segment.text}</text>
                            )}
                          </For>
                        </box>
                        <Show when={detail().length > 0}>
                          <box height={1} flexDirection="row">
                            {/* A detail line always hangs off its own line 1,
                                so it always carries the rail, and it indents
                                to whatever marker that line 1 used. */}
                            <text fg={theme.overlay}>
                              {` ${RAIL} ${" ".repeat(
                                markerWidth(entry.candidate !== null),
                              )}`}
                            </text>
                            <For
                              each={fitSegments(
                                detail(),
                                detailWidth(entry.candidate !== null),
                              )}
                            >
                              {(segment) => (
                                <text fg={segment.fg}>{segment.text}</text>
                              )}
                            </For>
                          </box>
                        </Show>
                      </box>
                    );
                  };
                  return (
                    <box flexDirection="column">
                      <Show when={showsGroupHeaders(merged())}>
                        <box height={1} flexDirection="row">
                          <text fg={theme.mauve}>
                            <strong>
                              {truncateText(repo.repoName, contentWidth())}
                            </strong>
                          </text>
                        </box>
                      </Show>
                      <For each={split().kept}>
                        {(entry, index) => renderRow(entry, index() > 0)}
                      </For>
                      {/* Everything below this line can be deleted, and only
                          things below it carry checkboxes. The rule starts
                          with a tee, so the rail runs into it. */}
                      <Show when={split().removable.length > 0}>
                        <box height={1} flexDirection="row">
                          <text fg={theme.overlay}> </text>
                          <text fg={theme.overlay}>
                            {dividerText(
                              split().removable.length,
                              listWidth() - 1,
                            )}
                          </text>
                        </box>
                      </Show>
                      <For each={split().removable}>
                        {(entry, index) =>
                          // With no kept rows the divider is the group's first
                          // line, so every removable row still hangs off it.
                          renderRow(
                            entry,
                            index() > 0 || split().kept.length > 0,
                          )
                        }
                      </For>
                    </box>
                  );
                }}
              </For>
            </scrollbox>
          </Show>

          {/* The in-flight scan is announced on the TITLE line and nowhere
              else. It used to have its own row here, which stated the fact a
              second time and, worse, took its row back when the scan landed:
              the whole list stepped down one line in the same frame the
              re-sort moved rows around, which is the "glitch" the title
              suffix exists to replace. */}
          <Show when={scanError()}>
            <box height={1}>
              <text fg={theme.yellow}>
                {truncateText(
                  `Prune scan failed: ${scanError()}`,
                  contentWidth(),
                )}
              </text>
            </box>
          </Show>
        </Show>

        <Show when={phase() === "running"}>
          <box paddingTop={1}>
            <text fg={theme.peach}>Pruning...</text>
          </box>
        </Show>

        <Show when={phase() === "done"}>
          <scrollbox
            flexGrow={1}
            ref={(r: ScrollBoxRenderable) => (resultBox = r)}
          >
            <For each={result()?.outcomes ?? []}>
              {(outcome) => (
                <box flexDirection="column">
                  <box height={1}>
                    <text fg={outcome.removed ? theme.green : theme.red}>
                      {`${outcome.removed ? "✓" : "✗"} ${outcome.path}`}
                    </text>
                  </box>
                  <For each={outcome.steps}>
                    {(step) => (
                      <box height={1} paddingLeft={4}>
                        <text fg={step.ok ? theme.subtext : theme.red}>
                          {`${step.step}: ${step.detail}`}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              )}
            </For>
          </scrollbox>
        </Show>
      </box>

      <box justifyContent="center" width="100%" height={1}>
        <Show when={phase() === "list" || phase() === "confirm"}>
          <Show
            when={note()}
            fallback={
              // Dimmed but present while the confirm owns the keyboard: the
              // keys are still the panel's, they are just not answerable yet.
              <text fg={phase() === "confirm" ? theme.surface : theme.overlay}>
                {hintLine()}
              </text>
            }
          >
            {(message: () => string) => (
              <text fg={theme.green}>
                {truncateText(message(), contentWidth())}
              </text>
            )}
          </Show>
        </Show>
        <Show when={phase() === "done"}>
          <text fg={theme.overlay}>j/k scroll · r reload · q close</text>
        </Show>
      </box>
      <Show when={phase() === "confirm"}>
        <RemovalConfirm
          headline={describeRemoval(
            effective().length,
            effective().filter((c) => c.branch && c.branchDeletion !== "none")
              .length,
          )}
          details={removalDetails({
            includedDirty: includedDirty().length,
            blockedDirty: blockedDirty().length,
            ignoredFiles: ignoredCount(),
          })}
          destructive={includedDirty().length > 0}
          width={contentWidth()}
          onConfirm={runPrune}
          onCancel={() => setPhase("list")}
        />
      </Show>
    </box>
  );
};
