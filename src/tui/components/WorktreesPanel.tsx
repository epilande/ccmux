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
 * Ahead/behind as the CLI writes it. Omitted entirely when the branch is in
 * sync or has no upstream — a row of zeroes on every healthy worktree is
 * noise that pushes the facts that DO differ off a narrow panel.
 */
export function formatTracking(row: WorktreeRow): string {
  const upstream = row.upstream;
  if (!upstream) return "";
  if (upstream.gone) return "gone";
  const parts: string[] = [];
  if (upstream.ahead > 0) parts.push(`↑${upstream.ahead}`);
  if (upstream.behind > 0) parts.push(`↓${upstream.behind}`);
  return parts.join(" ");
}

/** Uncommitted work as `2m/1u`, or empty when the tree is clean. */
export function formatDirty(row: WorktreeRow): string {
  if (!row.dirty.dirty) return "";
  return `${row.dirty.modified}m/${row.dirty.untracked}u`;
}

/**
 * Everything on a row's first line except the cursor bar and the checkbox,
 * which are fixed-width and drawn by the component.
 */
export function primarySegments(
  entry: PanelRow,
  isCursor: boolean,
): RowSegment[] {
  const segments: RowSegment[] = [
    { text: entry.row.name, fg: rowColor(entry, isCursor) },
  ];
  if (entry.row.isMain) segments.push({ text: " main", fg: theme.mauve });
  if (entry.row.locked) segments.push({ text: " locked", fg: theme.overlay });
  segments.push({
    text: `  ${entry.row.branch ?? "detached"}`,
    fg: theme.overlay,
  });
  const tracking = formatTracking(entry.row);
  if (tracking) {
    segments.push({
      text: `  ${tracking}`,
      fg: entry.row.upstream?.gone ? theme.peach : theme.blue,
    });
  }
  const dirty = formatDirty(entry.row);
  if (dirty) segments.push({ text: `  ${dirty}`, fg: theme.yellow });
  return segments;
}

/**
 * The row's second line: what phase 2 (or the session list) had to say about
 * it. Empty for a healthy, unoccupied, un-PR'd worktree, and the component
 * draws no line at all in that case rather than an empty one.
 */
export function detailSegments(
  entry: PanelRow,
  opts: { compact: boolean; dirtyOk: boolean },
): RowSegment[] {
  const segments: RowSegment[] = [];
  const candidate = entry.candidate;
  if (candidate) {
    segments.push({
      text: candidate.detail,
      fg: reasonColor(candidate.reason),
    });
  } else if (entry.skip) {
    segments.push({ text: `held: ${entry.skip.reason}`, fg: theme.overlay });
  }
  const gap = () => (segments.length > 0 ? "  " : "");
  // Straight after the reason, and BEFORE the PR badge and the sessions,
  // because the line is fitted left to right and whatever sits last is what a
  // narrow panel drops. Behind the badge this was the first thing truncated,
  // which left a row still selectable with the one sentence explaining why it
  // is being held back missing. Compact mode gives it a line of its own
  // instead; a healthy row already states its counts on the first line.
  if (candidate?.dirty && !opts.compact) {
    segments.push({
      text: `${gap()}${opts.dirtyOk ? "will be deleted (D)" : "press D to include"}`,
      fg: opts.dirtyOk ? theme.red : theme.yellow,
    });
  }
  if (entry.pr) {
    segments.push({
      text: `${gap()}#${entry.pr.number} ${entry.pr.state}`,
      fg: prColor(entry.pr),
    });
  }
  // Sessions are what Enter acts on, so the sidebar keeps them too — just the
  // first one plus a count, since a ~40 column row cannot spell out three.
  const sessions = entry.row.sessions;
  const lead = sessions[0];
  if (lead) {
    const shown = opts.compact
      ? `${lead.agentType} ${lead.status}${sessions.length > 1 ? ` +${sessions.length - 1}` : ""}`
      : sessions.map((s) => `${s.agentType} ${s.status}`).join(", ");
    segments.push({ text: `${gap()}[${shown}]`, fg: statusColor(lead.status) });
  }
  if (candidate && candidate.ignoredFiles.length > 0) {
    segments.push({
      text: opts.compact
        ? `  +${candidate.ignoredFiles.length} ignored`
        : `  +${describeIgnoredFiles(candidate.ignoredFiles, 2)}`,
      fg: theme.peach,
    });
  }
  return segments;
}

/**
 * Visual LINES a row occupies: its name line, plus compact mode's own dirty
 * warning line, plus the detail line when there is anything to put on it.
 *
 * Rows are not one line each and never were, which is what made scrolling by
 * row INDEX wrong: a scrollbox measures `scrollTop` in lines, so a list of
 * two- and three-line rows scrolled the cursor off screen while the keys kept
 * acting on the row nobody could see. Derived from `detailSegments` rather
 * than from a copy of its conditions, so the height and the render cannot
 * disagree about whether a line exists.
 */
export function rowVisualHeight(entry: PanelRow, compact: boolean): number {
  const dirtyLine = entry.candidate?.dirty && compact ? 1 : 0;
  const detail = detailSegments(entry, { compact, dirtyOk: false });
  return 1 + dirtyLine + (detail.length > 0 ? 1 : 0);
}

/** Where each row starts, and how tall it is, in the scrollbox's own units. */
export type VisualLayout = Map<string, { line: number; height: number }>;

/**
 * Lay the whole list out in visual lines, headers included (one line each).
 *
 * Keyed by PATH for the same reason the cursor is: phase 2 re-sorts the list,
 * and a layout keyed by position would describe the arrangement the cursor
 * just left.
 */
export function visualLayout(
  repos: PanelRepo[],
  heightOf: (entry: PanelRow) => number,
): VisualLayout {
  const layout: VisualLayout = new Map();
  let line = 0;
  for (const repo of repos) {
    line += 1; // the repo header
    for (const entry of repo.rows) {
      const height = heightOf(entry);
      layout.set(entry.row.path, { line, height });
      line += height;
    }
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
  /** The same, minus the fixed cursor bar and checkbox gutter. */
  const rowWidth = () => Math.max(4, contentWidth() - 5);

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
      case "X":
        if (effective().length > 0) setPhase("confirm");
        break;
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
  const hintLine = () =>
    fitHints(
      [
        { text: "j/k move", rank: 3 },
        { text: "enter open", rank: 4 },
        { text: "space select", rank: 3 },
        { text: `x prune ${effective().length}`, rank: 4 },
        { text: "a all clean", rank: 1 },
        { text: "D dirty", rank: 1 },
        { text: "y copy", rank: 1 },
        ...(props.onReview ? [{ text: "d review", rank: 1 }] : []),
        ...(props.repo !== null
          ? [{ text: scoped() ? "tab all repos" : "tab this repo", rank: 2 }]
          : []),
        { text: "q close", rank: 5 },
      ],
      contentWidth(),
    );

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
      <box justifyContent="center" width="100%" height={1}>
        <text fg={theme.text}>
          <strong>Worktrees</strong>
        </text>
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
                {(repo) => (
                  <box flexDirection="column">
                    <box height={1} flexDirection="row">
                      <text fg={theme.mauve}>
                        <strong>
                          {truncateText(repo.repoName, contentWidth())}
                        </strong>
                      </text>
                    </box>
                    <For each={repo.rows}>
                      {(entry) => {
                        const isCursor = () =>
                          cursorRow()?.row.path === entry.row.path;
                        const isSelected = () => selected().has(entry.row.path);
                        const opted = () => dirtyOk().has(entry.row.path);
                        const detail = () =>
                          detailSegments(entry, {
                            compact: props.compact === true,
                            dirtyOk: opted(),
                          });
                        return (
                          <box flexDirection="column">
                            <box height={1} flexDirection="row">
                              <text
                                fg={isCursor() ? theme.mauve : theme.overlay}
                              >
                                {isCursor() ? "▎" : " "}
                              </text>
                              {/* Only a candidate gets a box. The gutter is
                                  still spent on every row so the names stay
                                  in one column. */}
                              <text
                                fg={isSelected() ? theme.green : theme.overlay}
                              >
                                {entry.candidate
                                  ? isSelected()
                                    ? "[x] "
                                    : "[ ] "
                                  : "    "}
                              </text>
                              <For
                                each={fitSegments(
                                  primarySegments(entry, isCursor()),
                                  rowWidth(),
                                )}
                              >
                                {(segment) => (
                                  <text fg={segment.fg}>{segment.text}</text>
                                )}
                              </For>
                            </box>
                            {/* Compact mode gives the dirty warning its own
                                line. Sharing one with the reason meant a ~40
                                column sidebar cut the warning in half, losing
                                the only text that explains why the row is
                                held back. */}
                            <Show
                              when={entry.candidate?.dirty && props.compact}
                            >
                              <box
                                height={1}
                                flexDirection="row"
                                paddingLeft={5}
                              >
                                <text fg={opted() ? theme.red : theme.yellow}>
                                  {truncateText(
                                    opted()
                                      ? "DIRTY, will be deleted"
                                      : "DIRTY, press D to include",
                                    rowWidth(),
                                  )}
                                </text>
                              </box>
                            </Show>
                            <Show when={detail().length > 0}>
                              <box
                                height={1}
                                flexDirection="row"
                                paddingLeft={5}
                              >
                                <For each={fitSegments(detail(), rowWidth())}>
                                  {(segment) => (
                                    <text fg={segment.fg}>{segment.text}</text>
                                  )}
                                </For>
                              </box>
                            </Show>
                          </box>
                        );
                      }}
                    </For>
                  </box>
                )}
              </For>
            </scrollbox>
          </Show>

          <Show when={scan() === null && scanError() === null}>
            <box height={1}>
              <text fg={theme.overlay}>Checking for finished worktrees...</text>
            </box>
          </Show>
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
        <Show when={phase() === "list"}>
          <Show
            when={note()}
            fallback={<text fg={theme.overlay}>{hintLine()}</text>}
          >
            {(message: () => string) => (
              <text fg={theme.green}>
                {truncateText(message(), contentWidth())}
              </text>
            )}
          </Show>
        </Show>
        <Show when={phase() === "confirm"}>
          {/* Red whenever uncommitted work is actually going, so the one
              irreversible case does not read like the routine one. */}
          <text fg={includedDirty().length > 0 ? theme.red : theme.text}>
            {`Delete ${effective().length} worktree(s)` +
              `, ${effective().filter((c) => c.branch && c.branchDeletion !== "none").length} branch(es)` +
              (ignoredCount() > 0
                ? `, ${ignoredCount()} ignored file(s)`
                : "") +
              (includedDirty().length > 0
                ? `, INCLUDING ${includedDirty().length} with uncommitted work`
                : "") +
              (blockedDirty().length > 0
                ? `, skipping ${blockedDirty().length} dirty`
                : "") +
              "?  y / n"}
          </text>
        </Show>
        <Show when={phase() === "done"}>
          <text fg={theme.overlay}>j/k scroll · r reload · q close</text>
        </Show>
      </box>
    </box>
  );
};
