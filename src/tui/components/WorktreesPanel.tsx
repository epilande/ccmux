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
import { useKeyboard, useRenderer } from "@opentui/solid";
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
  ScanResponse,
  WorktreeSession,
} from "../../daemon/worktree-prune";
import {
  describeHttpFailure,
  describeIgnoredFiles,
  normalizeScan,
} from "../../daemon/worktree-prune";
import type {
  WorktreeListResponse,
  WorktreeRow,
} from "../../daemon/worktree-list";
import type {
  OpenPR,
  PRListBody,
  PRListResponse,
} from "../../daemon/pr-list";
import { normalizePRList } from "../../daemon/pr-list";
import type { SessionStatus } from "../../types/session";
import { displayWidth, sliceToWidth, truncateText } from "../utils/format";
import { fitHints } from "./Footer";
import { useStatusIcon } from "../utils/useStatusIcon";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
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
/** Phase 3, one `gh pr list` per repo behind a daemon-side TTL. */
const PR_TIMEOUT_MS = 30_000;

/** How long a `y` copy confirmation stays on the hint line. */
const COPY_NOTE_MS = 2_000;

/**
 * One worktree as the panel knows it: what exists (phase 1) plus whatever
 * phase 2 had to say about it, which is nothing at all for a healthy row.
 */
export interface WorktreePanelRow {
  kind: "worktree";
  /**
   * What the cursor, the scroll layout and the selection sets key by.
   *
   * The worktree's own absolute path.
   */
  key: string;
  row: WorktreeRow;
  /** Set only when the scan proved a removal reason. Gates prune selection. */
  candidate: PruneCandidate | null;
  /** Set when the scan deliberately withheld this worktree. */
  skip: PruneSkip | null;
  /** PR to badge the row with, from either half of the scan. */
  pr: PRState | null;
}

/** One open pull request of the repo, from phase 3 (issue #151). */
export interface PRPanelRow {
  kind: "pr";
  /** {@link prRowKey}. */
  key: string;
  repoRoot: string;
  pr: OpenPR;
  /**
   * The local worktree holding this PR's head commit, or null.
   *
   * Proven by SHA (`headRefOid` equal to the branch tip), never by branch
   * NAME: `gh pr list --head patch-1` on `cli/cli` answers with 25 PRs from
   * 25 different forks, which is the namesake trap `selectPRForBranch`
   * documents. Where either side does not resolve the row stays unmarked
   * rather than guessing.
   */
  checkedOutPath: string | null;
  /** That worktree's display name, for the phrase that names it. */
  checkedOutName: string | null;
}

/**
 * What a repo with no open-PR rows shows in the PR view.
 *
 * A ROW, and that is the whole point of it. It used to be a LINE — the render
 * drew it and `visualLayout` counted it, but `flatRows()` did not contain it,
 * so the cursor could not stand on it. A PR view whose repos all answered
 * `no open PRs` therefore had an empty `flatRows()`: `moveCursor` returned on
 * the spot, scrolling is an effect of where the cursor IS and had nothing to
 * chase, and every repo past the first screenful was unreachable from the
 * keyboard while a scrollbar drew itself alongside. Making it a row deletes
 * that whole class of bug rather than patching it — there is no longer a
 * second arm in the layout, or a second branch in the render, that the row
 * list can disagree with.
 *
 * There is deliberately no worktrees-view counterpart: `GET /worktrees` only
 * reports a repo it found worktrees for, main checkout included, so a repo
 * group with zero worktree rows cannot exist.
 */
export interface PRStatusRow {
  kind: "pr-status";
  /** {@link prStatusRowKey}. */
  key: string;
  repoRoot: string;
  /** The section state this line reports, which is also what it says. */
  status: PRSectionStatus;
}

/**
 * A row of the list, which is no longer only worktrees.
 *
 * A discriminated union rather than a worktree row with optional PR fields,
 * because the difference is not decoration: `space`, `x` and `D` act on a
 * removal a PR row has no notion of, and `y` and `d` act on a directory it
 * does not have. Narrowing on `kind` is what makes the compiler ask every one
 * of those what it means here — including a key added later, which is the
 * case a runtime guard would miss, and which is exactly how `PRStatusRow`
 * was added.
 */
export type PanelRow = WorktreePanelRow | PRPanelRow | PRStatusRow;

/**
 * The cursor/layout key for a PR row.
 *
 * Synthetic, and it cannot collide with a worktree's: every worktree key is
 * an absolute path, so it starts with `/`.
 */
export function prRowKey(repoRoot: string, number: number): string {
  return `pr:${repoRoot}#${number}`;
}

/**
 * Whether `key` names a PR row rather than a worktree.
 *
 * Cheap and total: a worktree's key is an absolute path, so the prefix can
 * never be ambiguous. Used where a key has to be classified WITHOUT the row
 * in hand, which is precisely the case that matters — a cursor pointing at a
 * row phase 3 has not delivered yet.
 */
export function isPRRowKey(key: string): boolean {
  return key.startsWith("pr:");
}

/**
 * The cursor/layout key for a repo's PR-status row.
 *
 * Cannot collide with a worktree's, which is an absolute path, nor with a PR
 * row's: `"pr-status:".startsWith("pr:")` is false, so {@link isPRRowKey}
 * does not claim it and the re-seed effect's PR-key hold does not either.
 * That is correct — no return path ever asks to land on one of these.
 */
export function prStatusRowKey(repoRoot: string): string {
  return `pr-status:${repoRoot}`;
}

/**
 * The repo a {@link prStatusRowKey} names, or null for any other key.
 *
 * The inverse exists because a `pr-status` row is the one row kind that is
 * REPLACED rather than removed: the moment its repo gains a PR the key is
 * gone, and the cursor sitting on it is about to be re-seeded. Knowing which
 * repo it named is what lets the re-seed land on that repo's new rows instead
 * of at the top of the list.
 */
export function prStatusRowRepo(key: string): string | null {
  const prefix = "pr-status:";
  return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

/**
 * The panel's two views (issue #151).
 *
 * A second AXIS, orthogonal to the Tab scope: all four combinations are
 * meaningful, and the tab line names the views while the title names the
 * scope. The PR list started life as a third section appended to every repo
 * group and that shape lost on its own terms — one always-drawn header per
 * repo cost a line each across a thirteen-repo view, and the one repo the
 * user actually works in had its PRs below the fold before a key was
 * pressed. Reordering could not fix it either: phase 3 lands after phase 1
 * has painted, so PRs at the TOP would shove already-visible worktree rows
 * down mid-interaction, which is the exact shift the pending-rides-the-header
 * idiom exists to prevent. A view costs one line for the whole panel and can
 * arrive whenever it likes.
 */
export type PanelView = "worktrees" | "prs";

/**
 * Which view an open starts on, derived from the row it was asked to land on.
 *
 * A derivation and not a prop, because every return path into the panel (the
 * review round trip, a cancelled spawn dialog, a spawn-from-PR) already
 * carries the cursor it wants, and a PR key can only be shown by the PR view.
 * One rule covers all three call sites and none of them learns a new
 * argument.
 */
export function initialView(cursor: string | null | undefined): PanelView {
  return cursor != null && isPRRowKey(cursor) ? "prs" : "worktrees";
}

/** One repo's rows, in display order. */
export interface PanelRepo {
  repoRoot: string;
  repoName: string;
  rows: PanelRow[];
  /**
   * What phase 3 has to say about this repo.
   *
   * Derived onto the group rather than passed to the render, for the reason
   * `showsGroupHeaders` is derived: `visualLayout` has to count the same
   * lines the render draws, and two independent conditions eventually
   * disagree.
   *
   * Note the reversal against the Worktrees view, which is deliberate. There
   * a repo with no open PRs says NOTHING — the view's subject is directories
   * and a `0` per repo is thirteen lines of noise. Here `0` is the answer the
   * view exists to give, so it takes a line under the repo header, and so
   * does `unavailable`, and so does the wait for GitHub.
   */
  prSection: PRSectionStatus;
}

/**
 * What phase 3 has to say about one repo.
 *
 * A union rather than a count plus flags, so "still waiting" and "answered
 * zero" cannot be confused. A nullable count invited exactly that. The
 * failure carries its own CAUSE, because the PR view says it under the repo
 * it applies to rather than in one line below a list of many.
 */
export type PRSectionStatus =
  | { kind: "pending" }
  | { kind: "ready"; count: number }
  | { kind: "unavailable"; reason: string | null };

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
  /**
   * Seed the cursor on this row's KEY, for a reopen that should land where
   * the user left (the review round-trip, a cancelled spawn dialog).
   *
   * A key, not a path: since the list gained PR rows it can be a worktree's
   * absolute path or a synthetic `pr:<repoRoot>#<n>`, and a cancelled PR
   * spawn dialog sends the latter.
   *
   * A key no phase ever delivers falls back to the first row through the
   * re-seed effect, like a row that vanished under the cursor. "Not delivered
   * yet" is deliberately not that case: the effect holds a PR key while phase
   * 3 is in flight, because phase 1 lands first with worktrees only and would
   * otherwise clobber the seed before its row could exist.
   */
  initialCursor?: string | null;
  /**
   * This open is a RETURN from an action the panel launched, so the first
   * load may seed phase 2 from the last completed scan instead of firing
   * it again. One-shot: `r` and Tab inside the same mount still rescan.
   */
  isReturn?: boolean;
  /**
   * Open with the scope already Tab-widened. Set on a return whose action
   * left from the widened view: Tab's rescope is panel-local state the store
   * never sees, so it has to be re-established here, or the return would
   * land back on the opening repo's narrow view. `repo` still names the
   * opening repo, which is what keeps Tab able to narrow back to it.
   */
  startWidened?: boolean;
  onClose: () => void;
  /** Jump to a session living in the row (Enter on an occupied row). */
  onJump: (session: WorktreeSession) => void;
  /**
   * Start an agent (Enter on a row with no session). `existingWorktree` is
   * set for a linked worktree, whose directory the dialog then locks; the
   * main checkout sends null and gets the ordinary destination choice.
   */
  onSpawn: (target: {
    cwd: string;
    existingWorktree: string | null;
    panelRepo: string | null;
    panelScope: string | null;
    /**
     * The row's KEY, when it is not the worktree path App would infer.
     *
     * Only a checked-out PR row sends it: that row's destination is the
     * worktree holding the PR, so it takes this verb, but the row itself is
     * the PR, and the return cursor is what `initialView` reads to decide
     * which view to reopen in.
     */
    cursor?: string;
  }) => void;
  /**
   * Review a worktree's uncommitted diff. Absent where review cannot run
   * (the sidebar, which has no room to suspend into a full-screen tool), and
   * the `d` hint goes with it.
   */
  onReview?: (target: {
    path: string;
    sessionId: string | null;
    panelRepo: string | null;
    panelScope: string | null;
  }) => void;
  /**
   * Enter on an open PR that is NOT checked out here: cut a worktree from its
   * head (issue #151).
   *
   * A verb of its own rather than a flag on `onSpawn`, because the daemon
   * derives the worktree's NAME and its base from the PR — `POST /spawn`
   * refuses `pr` alongside `worktree.name` and `worktree.base` — so the
   * dialog it opens has different rows. A PR that IS checked out goes through
   * `onSpawn` instead, which is the existing revalidated jump.
   */
  onSpawnFromPR: (target: {
    number: number;
    title: string;
    repoRoot: string;
    cursor: string;
    panelRepo: string | null;
    panelScope: string | null;
  }) => void;
  /**
   * What the keys that leave this process are allowed to do. Required on
   * purpose; see {@link PanelEffects}. Production passes {@link liveEffects},
   * tests pass a recorder.
   */
  effects: PanelEffects;
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
 * The local worktree holding `pr`'s head commit, or null.
 *
 * Identity is the SHA and nothing else. `headRefOid` equal to a branch tip is
 * what defeats name reuse and the fork noise `gh pr list --head` returns; a
 * match on the branch NAME would mark a PR as checked out because someone
 * else's fork happens to use the same word. Where either side does not
 * resolve — an old daemon that sends no `tip`, a detached worktree, a gh that
 * withheld `headRefOid` — the row stays UNMARKED, which costs a convenience
 * where a wrong mark would send Enter into the wrong directory.
 *
 * Among several worktrees at the same commit (a checkout just cut from this
 * branch shares its tip) the one whose branch is also the PR's head wins.
 * That is a tie-break between rows the SHA has already proven, never a way in
 * for a name to prove anything by itself.
 */
export function checkoutHolding(
  pr: OpenPR,
  worktrees: WorktreeRow[],
): WorktreeRow | null {
  if (!pr.headRefOid) return null;
  const matches = worktrees.filter((row) => row.tip === pr.headRefOid);
  return (
    matches.find((row) => row.branch === pr.headRefName) ?? matches[0] ?? null
  );
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
  // PRs are the group's last section, below even the removable one: they
  // describe work on GitHub rather than a directory on disk, and the panel's
  // subject is the directories.
  if (entry.kind === "pr") return 4;
  // Below the PRs. It can never tie with one — it exists only where there are
  // none — but the bucket says so rather than leaving it to be inferred.
  if (entry.kind === "pr-status") return 5;
  if (entry.row.isMain) return 0;
  if (entry.candidate) return 3;
  return entry.row.sessions.length > 0 ? 1 : 2;
}

/** Rows an agent is actively in sort above rows whose agent is parked. */
function sessionRank(entry: PanelRow): number {
  if (entry.kind !== "worktree") return 0;
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
  return [...rows].sort((a, b) => {
    const byBucket = rowBucket(a) - rowBucket(b) || sessionRank(a) - sessionRank(b);
    if (byBucket !== 0) return byBucket;
    // Both PRs, since the buckets above already separated the two kinds.
    // Newest first — gh's own order, restated so a future gh cannot change it.
    if (a.kind === "pr" && b.kind === "pr") return b.pr.number - a.pr.number;
    // Narrowed on WORKTREE rather than on `pr`, so a third kind cannot reach
    // `a.row` below. The buckets have already separated every pairing that
    // gets here anyway; this is the compiler's guarantee of that, not a case.
    if (a.kind !== "worktree" || b.kind !== "worktree") return 0;
    return a.row.name.localeCompare(b.row.name);
  });
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

/** The tab line's labels. */
export const WORKTREES_TAB = "Worktrees";
export const PRS_TAB = "Pull Requests";
/** What the PR tab degrades to at sidebar widths, where the long label plus
 *  a count does not fit beside `Worktrees`. */
export const PRS_TAB_SHORT = "PRs";
/**
 * One column inside each tab and one between them.
 *
 * Both are baked into the SEGMENTS rather than set as box padding, so the
 * width a tab occupies is exactly the width of its own text. The ladder
 * below measures rungs by summing segment widths; padding the box instead
 * would put two columns per tab outside that sum, and the line that has to
 * fit `contentWidth()` would quietly run four columns over.
 */
const TAB_PAD = " ";
const TAB_GAP = " ";
/**
 * What separates the header's three zones: the scope label, the chip strip,
 * and the muted status tail.
 *
 * Two columns rather than one, because a chip already carries `TAB_PAD`
 * inside its own background: one column of gap would put the scope label a
 * single column from a chip's EDGE while the two chips sit three columns
 * apart from each other, and the strip would read as three tabs with the
 * first one unstyled.
 */
const ZONE_GAP = "  ";

/**
 * One tab on the view line: which view it selects, whether it is the one
 * showing, and the text of its own filled chip.
 *
 * A structure and not a flat segment list, which is what this used to
 * return, because a chip has to be a single BOX to carry a background and a
 * click, and a flat list cannot say where one chip ends and the next begins.
 */
export interface ViewTab {
  view: PanelView;
  active: boolean;
  segments: RowSegment[];
}

/** Columns a rung occupies: every chip's own text, plus the gaps between. */
function tabsWidth(tabs: ViewTab[]): number {
  const chips = tabs.reduce(
    (n, tab) =>
      n + tab.segments.reduce((m, s) => m + displayWidth(s.text), 0),
    0,
  );
  return chips + displayWidth(TAB_GAP) * Math.max(0, tabs.length - 1);
}

/**
 * Fit a rung that is already too wide, chip by chip from the left.
 *
 * Each chip is fitted against what the ones before it left over, and a chip
 * with nothing left ends the line rather than rendering an empty filled
 * block. That last part is why this replaced a flat `fitSegments` call: the
 * old one could leave the separator dangling with nothing after it, and a
 * background makes that failure visible instead of merely odd — an empty
 * two-column chip of colour, sitting where a label should be.
 */
function fitTabs(tabs: ViewTab[], width: number): ViewTab[] {
  const fitted: ViewTab[] = [];
  let remaining = width;
  for (const tab of tabs) {
    if (fitted.length > 0) {
      const gap = displayWidth(TAB_GAP);
      if (remaining <= gap) break;
      remaining -= gap;
    }
    const segments = fitSegments(tab.segments, remaining);
    const used = segments.reduce((n, s) => n + displayWidth(s.text), 0);
    // Not merely "wider than nothing": a chip fitted down to its padding and
    // an ellipsis carries no label at all, and on the active chip's fill that
    // is a block of colour saying only that something was here. A chip earns
    // its columns by keeping at least one character of what it is called.
    const label = segments
      .map((segment) => segment.text)
      .join("")
      .replace(/[\s…]/gu, "");
    if (used === 0 || label === "") break;
    fitted.push({ ...tab, segments });
    remaining -= used;
  }
  return fitted;
}

/**
 * How the header line resolves at the width it has: the scope label, the two
 * chips, and the muted status tail.
 *
 * ONE line for all three. The panel used to spend two — a bold `Worktrees`
 * title over a tab line whose first chip also said `Worktrees`, with the
 * title's own suffix saying `42 worktrees` a third time. The tabs NAME the
 * views, so a title above them can only repeat whichever one is showing; what
 * a title was actually carrying that the tabs were not is the SCOPE, and that
 * is the one thing kept.
 *
 * The zones, left to right:
 *
 * - The scope lead. `all repos`, or the repo's own name when Tab has narrowed
 *   the panel to one. Derived from the scope FLAG and `props.repo`, never
 *   from the loaded rows, so it is right in the first frame and changes only
 *   when the user changes it. A lead that arrived with the data would shift
 *   both chips rightwards mid-open, and a chip is a click target.
 * - The chips. Each carries its OWN count, which is what let the counts stop
 *   naming their subject: `Worktrees 42` says once what `Worktrees` and
 *   `· 42 worktrees` said twice. No `·` between a label and its number —
 *   in this TUI that dot divides peers (`9 untracked · 1 waiting`), and
 *   gluing a count to its own label with it made the pair read as two things.
 * - The tail: the removal notice and the scanning announcement, dividing
 *   dots and all, because those ARE peers.
 *
 * The colour does the work a browser tab's shape does: exactly one chip is
 * filled, on `border`, the ground `ContextMenu` already uses for its
 * highlighted item. The other takes the panel's own `base`. A second, dimmer
 * fill was the first cut and is not portable — `border` is DARKER than
 * `surface` in dracula and rose-pine, which draws the active chip recessed
 * and the inactive one raised. With one fill there is nothing to invert.
 *
 * It stays ONE line. A rule under the strip would read more like a browser's
 * tabs and costs a row of list, which is the tax this panel exists to refuse.
 *
 * The chips carry NO key. One revision put a `[l]` badge on the inactive tab
 * and live use rejected it: keyboard notation inside a label reads as
 * documentation leaking into the interface, whatever it buys in
 * discoverability. The keys are taught on the hint line like every other key.
 *
 * Budgeted against `contentWidth()` and not `listWidth()`, because it renders
 * OUTSIDE the scrollbox and so does not pay for the scrollbar's column. It
 * still has to be fitted: OpenTUI wraps rather than clips, and a wrapped line
 * inside a `height={1}` box vanishes instead of overflowing.
 *
 * The degradation is a ladder of WHOLE swaps, each rung both NARROWER and
 * poorer than the one above it:
 *
 * 1. `all repos   Worktrees 42   Pull Requests 7   · ◐ scanning`
 * 2. the tail, which is transient and restates a spinner the chip may show
 * 3. `Pull Requests` swapped whole for `PRs`
 * 4. the counts, which the body restates anyway
 * 5. the scope lead
 *
 * The counts go before the lead deliberately. A count whose scope is unknown
 * is not a smaller truth, it is a misleading one: `42` means something very
 * different across thirteen repos than inside one.
 *
 * Below the last rung both chips no longer fit at all, and what survives is
 * the ACTIVE one. That reverses the flat-label version, which kept the
 * leftmost chip and so could leave `Worktrees` alone on the line while the
 * PR view was showing. Harmless when a tab was just a word; not harmless now
 * that it carries a FILL, because the strip would then show nothing filled
 * at all — the single state the fill exists to rule out.
 */
export interface HeaderLayout {
  /** Null once the ladder has dropped it. */
  lead: string | null;
  tabs: ViewTab[];
  /** Null once the ladder has dropped it. */
  tail: string | null;
}

/** Columns a whole rung occupies, gaps between zones included. */
function headerWidth(layout: HeaderLayout): number {
  const gap = displayWidth(ZONE_GAP);
  return (
    (layout.lead === null ? 0 : displayWidth(layout.lead) + gap) +
    tabsWidth(layout.tabs) +
    (layout.tail === null ? 0 : gap + displayWidth(layout.tail))
  );
}

/**
 * One drawn piece of the header line: a run of text, or a clickable chip.
 *
 * The line is rendered from ONE `<For>` over these rather than from a
 * `<Show>` per zone beside a `<For>` of chips, and both halves of that
 * sentence are load-bearing. A `<Show>` sibling that unmounts does not
 * reliably return to its own slot: the scope lead, dropped at a narrow width
 * and restored on the way back out, came back at the END of the row
 * (`Worktrees 16   Pull Requests 2   ccmux`). Rendering every zone
 * unconditionally and EMPTYING it is not the fix either, however obvious it
 * looks — an empty `<text>` still occupies one column in OpenTUI, so three
 * emptied zones would put the line three columns over the width
 * `headerWidth` measured, and a line that overruns its box does not clip, it
 * wraps, and a wrapped line inside `height={1}` vanishes. A single list
 * reconciler owns the order, and a zone with nothing to say is simply not in
 * the list.
 */
export type HeaderPart =
  | { kind: "lead"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "chip"; key: string; tab: ViewTab };

/** The header line as the drawn pieces it is made of, in order. */
export function headerParts(layout: HeaderLayout): HeaderPart[] {
  const parts: HeaderPart[] = [];
  // An EMPTY part is the same one-column leak as an emptied zone, arriving
  // by a different road: `basename("/")` is `""`, so a repo rooted at `/`
  // hands this a lead that is non-null and yet spells nothing, which
  // `headerWidth` measures as zero and OpenTUI draws as one. Nothing here
  // ever emits an empty string.
  if (layout.lead !== null && layout.lead !== "") {
    parts.push({ kind: "lead", key: "lead", text: layout.lead });
    parts.push({ kind: "text", key: "lead-gap", text: ZONE_GAP });
  }
  layout.tabs.forEach((tab, index) => {
    // The gap is its OWN piece and not padding on the chip: padding inside a
    // background paints the gap in the chip's colour, which fuses two
    // adjacent chips into one block.
    if (index > 0) {
      parts.push({ kind: "text", key: `gap-${tab.view}`, text: TAB_GAP });
    }
    parts.push({ kind: "chip", key: `chip-${tab.view}`, tab });
  });
  if (layout.tail !== null && layout.tail !== "") {
    parts.push({ kind: "text", key: "tail-gap", text: ZONE_GAP });
    parts.push({ kind: "text", key: "tail", text: layout.tail });
  }
  return parts;
}

export function headerLayout(opts: {
  view: PanelView;
  lead: string;
  /** The panel's worktree count, or "" while it is not known yet. */
  worktrees: string;
  /** The PR count, the pending spinner, or `unavailable`. */
  prs: string;
  tail: string | null;
  width: number;
}): HeaderLayout {
  const chip = (
    tabView: PanelView,
    label: string,
    count: string,
  ): ViewTab => {
    const active = tabView === opts.view;
    const fg = active ? theme.text : theme.overlay;
    const segments: RowSegment[] = [{ text: TAB_PAD + label, fg }];
    // The count is the dim layer INSIDE the chip, one step down from its
    // label rather than the flat `overlay` it wore on the bare line: on the
    // active chip's lighter ground `overlay` reads as noise.
    if (count) {
      segments.push({
        text: ` ${count}`,
        fg: active ? theme.subtext : theme.overlay,
      });
    }
    segments.push({ text: TAB_PAD, fg });
    return { view: tabView, active, segments };
  };
  const build = (prLabel: string, counts: boolean): ViewTab[] => [
    chip("worktrees", WORKTREES_TAB, counts ? opts.worktrees : ""),
    chip("prs", prLabel, counts ? opts.prs : ""),
  ];
  // The last chip standing is the ACTIVE one, not the leftmost. Under the
  // old flat labels either would do, but a chip carries a FILL now, and a
  // strip holding only the inactive chip is a header with nothing filled on
  // it while the body shows the other view — the one state the fill exists
  // to make impossible. Both chips keep their positions everywhere they both
  // fit; this rung is reached only when one of them cannot.
  const activeOnly = build(PRS_TAB_SHORT, false).filter((tab) => tab.active);

  // Every rung must be strictly NARROWER than the one above it, or it is
  // unreachable: the search takes the first rung that fits, so a rung no
  // narrower than its predecessor can never be the first. That is easy to
  // break by accident rather than by design — with no tail to drop, or no
  // counts to drop, two rungs collapse into the same layout — so the ladder
  // enforces it on the way in rather than asserting it in a comment.
  const ladder: HeaderLayout[] = [];
  const rung = (layout: HeaderLayout): void => {
    const last = ladder[ladder.length - 1];
    if (last !== undefined && headerWidth(layout) >= headerWidth(last)) return;
    ladder.push(layout);
  };
  rung({ lead: opts.lead, tabs: build(PRS_TAB, true), tail: opts.tail });
  rung({ lead: opts.lead, tabs: build(PRS_TAB, true), tail: null });
  rung({ lead: opts.lead, tabs: build(PRS_TAB_SHORT, true), tail: null });
  rung({ lead: opts.lead, tabs: build(PRS_TAB_SHORT, false), tail: null });
  rung({ lead: null, tabs: build(PRS_TAB_SHORT, false), tail: null });
  rung({ lead: null, tabs: activeOnly, tail: null });
  for (const layout of ladder) {
    if (headerWidth(layout) <= opts.width) return layout;
  }
  return { lead: null, tabs: fitTabs(activeOnly, opts.width), tail: null };
}

/**
 * The name is the BRIGHT layer of a row: line 1's label renders in the text
 * colour while the branch beside it and the whole detail line stay dim, so a
 * full screen reads as "bright = a worktree, dim = facts about it". With
 * every row in the same subdued grey, names and detail phrases merged into
 * one undifferentiated column.
 *
 * Yellow is reserved for the rows where dirt means DANGER: a dirty row under
 * the removable divider, whose uncommitted work a removal would delete.
 *
 * A merely-dirty kept row stays in the ordinary colour. Dirty is the normal
 * state of a main checkout, and a panel where half the names glow yellow has
 * no colour left for the one row where the dirt actually threatens work.
 */
function rowColor(entry: PanelRow, isCursor: boolean): string {
  if (isCursor) return theme.text;
  // A draft is dimmer than the rest of its section: it is on GitHub but not
  // asking for anything yet, and the section exists to point at what is.
  if (entry.kind === "pr") {
    return entry.pr.isDraft ? theme.subtext : theme.text;
  }
  // Dim: it is a fact ABOUT a repo, not a thing you can act on, and it reads
  // as the detail line it used to be.
  if (entry.kind === "pr-status") return theme.overlay;
  return entry.candidate && entry.row.dirty.dirty ? theme.yellow : theme.text;
}

/**
 * What a `switch` over a wire-sourced union falls back to, without giving up
 * the compiler's help on the unions this repo owns.
 *
 * Every union the panel switches on arrives from the daemon, which is a
 * long-lived background process that can be NEWER than this build: a reason or
 * a PR state it has learned to send lands here as a value no case matches.
 * Without a default that renders as an empty string, and an empty string on a
 * removable row is a checkbox with no explanation beside it, the one thing
 * the section's whole design rules out.
 *
 * A bare `default:` would buy that at the cost of the error that catches a
 * member added to `PRUNE_REASONS` in this repo, which is the case worth
 * failing loudly. Routing the default through here keeps both: the `never`
 * parameter stops compiling the moment a case is missing, while the value
 * still decides what an unknown one renders as.
 */
function unhandled<T>(_exhaustive: never, fallback: T): T {
  return fallback;
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
    default:
      return unhandled(reason, theme.subtext);
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
    default:
      return unhandled(pr.state, theme.subtext);
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
 * What a dirty worktree says when it cannot say how dirty.
 *
 * `readDirtyState` reports a worktree whose `git status` FAILED as dirty with
 * both counts at zero. That is the safe direction for a destructive action, but a
 * shape that leaves the row with nothing to print. The CLI already words it
 * this way (`describeDirtyCounts` falls back to `dirty`); the panel spends the
 * room it has on plain words.
 */
export const DIRTY_UNCOUNTED = "uncommitted work";

/**
 * Uncommitted work in words, one phrase per half, and only the halves that
 * are non-zero. `0m/4u` made the reader decode a format to learn one fact.
 *
 * Never empty for a dirty row, which matters beyond the row reading blind:
 * the `D` opt-in note rides the LAST of these phrases, so no phrase means a
 * destructive opt-in with nothing on screen to show it was taken.
 */
export function dirtyPhrases(row: WorktreeRow): string[] {
  if (!row.dirty.dirty) return [];
  const parts: string[] = [];
  if (row.dirty.modified > 0) parts.push(`${row.dirty.modified} modified`);
  if (row.dirty.untracked > 0) parts.push(`${row.dirty.untracked} untracked`);
  return parts.length > 0 ? parts : [DIRTY_UNCOUNTED];
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
    default:
      // A reason only a newer daemon knows about. Its own sentence is the one
      // thing about it that is guaranteed to be true, and the alternative is
      // a checkbox with nothing next to it.
      return unhandled(candidate.reason, candidate.detail);
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

/**
 * What a PR's review state says, in the words GitHub uses for it.
 *
 * `REVIEW_REQUIRED` is deliberately silent: it is the DEFAULT state of every
 * PR on a protected branch, so a phrase for it would appear on nearly every
 * row and say nothing about that row in particular.
 */
export function describeReview(pr: OpenPR): Phrase | null {
  switch (pr.reviewDecision) {
    case "APPROVED":
      return { text: "approved", fg: theme.green };
    case "CHANGES_REQUESTED":
      return { text: "changes requested", fg: theme.peach };
    case "REVIEW_REQUIRED":
      return null;
    // `BranchPR` types this nullable AND optional, so both spellings of
    // "GitHub said nothing" are cases here rather than a default.
    case null:
    case undefined:
      return null;
    default:
      return unhandled(pr.reviewDecision, null);
  }
}

/**
 * What a PR's checks say.
 *
 * `none` is silent rather than green: an un-CI'd PR has nothing to report,
 * and `foldChecks` keeps it out of `passing` for exactly that reason.
 */
export function describeChecks(pr: OpenPR): Phrase | null {
  switch (pr.ciStatus) {
    case "passing":
      return { text: "checks pass", fg: theme.green };
    case "failing":
      return { text: "checks fail", fg: theme.red };
    case "pending":
      return { text: "checks running", fg: theme.yellow };
    case "none":
      return null;
    default:
      return unhandled(pr.ciStatus, null);
  }
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
  if (entry.kind === "pr") return prDetailPhrases(entry, opts);
  // Nothing on a second line, which is also how `rowVisualHeight` learns this
  // row is one line tall — the same derivation every other row uses, rather
  // than a height special-cased for it.
  if (entry.kind === "pr-status") return [];
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
  // The two halves of the dirty story come from different phases: the phrases
  // read the LIST's dirty state and the opt-in note gates on the SCAN's. When
  // the scan saw uncommitted work the list did not (they are read seconds
  // apart, and the merge joins them by path without reconciling them), there
  // is no phrase for the note to ride and pressing `D` changes nothing on
  // screen. The scan's own word for it stands in, so the note always has
  // something to say it about, and only then, so a row never says it twice.
  const rowDirty = dirtyPhrases(row);
  const dirty =
    rowDirty.length > 0 ? rowDirty : candidate?.dirty ? [DIRTY_UNCOUNTED] : [];
  const dirtySegments: Phrase[] = [];
  // `it` for a single file, `them` for several; the uncounted fallback has
  // both counts at zero and reads as singular work ("uncommitted work
  // (D deletes it)").
  const dirtyFiles = row.dirty.modified + row.dirty.untracked;
  const deleteNote = dirtyFiles > 1 ? "(D deletes them)" : "(D deletes it)";
  dirty.forEach((text, index) => {
    // The opt-in note rides the LAST dirty phrase, where it reads as a
    // sentence about the work rather than as a separate instruction.
    const last = index === dirty.length - 1;
    const note = candidate?.dirty && last;
    // Same rule as `rowColor`: the warning colours belong to the rows where
    // a removal would delete the work being counted. On a kept row the same
    // counts are information, and colouring them yellow made every dirty
    // main checkout shout as loudly as the row that was actually at risk.
    const warn = candidate ? theme.yellow : theme.subtext;
    dirtySegments.push({
      text: note
        ? `${text} ${opts.dirtyOk ? "(D armed, will be deleted)" : deleteNote}`
        : text,
      fg: note && opts.dirtyOk ? theme.red : warn,
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

/**
 * A PR row's detail line: its head branch, who opened it, and only the states
 * that are news.
 *
 * The branch leads because it is what a checkout would be named after, and it
 * is the fact that connects the row to the worktrees above it. Draft, review
 * and checks each stay silent in their unremarkable state, by the same rule
 * the worktree rows follow: a phrase that appears on every row is noise that
 * pushes the ones that differ off a narrow panel.
 *
 * `checked out` comes LAST and is the loudest thing on the line, because it
 * changes what Enter does.
 */
function prDetailPhrases(
  entry: PRPanelRow,
  opts: { compact?: boolean },
): Phrase[] {
  const pr = entry.pr;
  const phrases: Phrase[] = [];
  if (pr.headRefName) {
    phrases.push({ text: pr.headRefName, fg: theme.overlay });
  }
  // The author is the first thing to go on a narrow surface: on a repo you
  // work in, most PRs are yours, and the branch is the useful half.
  if (pr.author && opts.compact !== true) {
    phrases.push({ text: `@${pr.author}`, fg: theme.overlay });
  }
  if (pr.isDraft) phrases.push({ text: "draft", fg: theme.subtext });
  const review = describeReview(pr);
  if (review) phrases.push(review);
  const checks = describeChecks(pr);
  if (checks) phrases.push(checks);
  if (entry.checkedOutName) {
    phrases.push({
      text: `checked out in ${entry.checkedOutName}`,
      fg: theme.green,
    });
  }
  return phrases;
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

/** The separator between detail phrases, muted so the facts carry the line. */
const PHRASE_SEPARATOR = " · ";

/**
 * The rail: a single muted `│` in its own column, carried by EVERY row line
 * of a repo group.
 *
 * A per-row connector was the obvious first shape and the wrong one. Rows that
 * had nothing to say drew no second line, so the connector appeared and
 * vanished down the list and read as a broken rail rather than as one group.
 * Continuous means CONTINUOUS: one-line rows carry it too. The only bare line
 * is the one above the group that the rail hangs from: the panel title in
 * the scoped view, the repo header in the multi-repo view.
 */
export const RAIL = "│";

/**
 * The cursor bar, drawn IN the rail's column on the cursor row's lines.
 *
 * Heavy vertical, not the session list's `▎`: box-drawing verticals are
 * centered in their cell while `▎` hugs the cell's left edge, so `▎` in the
 * rail column sticks out left of the line it is supposed to sit on. `┃`
 * shares `│`'s centerline and reads as a thicker, highlighted rail segment.
 *
 * The alternatives were both tried live and rejected: `▎` in this column
 * sits visibly off the rail line, and `▎` in its OWN column left of the
 * rail reads as a mark detached from the row's structure. The cursor
 * belongs ON the rail, even at `┃`'s lighter weight.
 */
export const CURSOR_BAR = "┃";

/**
 * The PR rows' marker, in the same one-column slot the other markers use.
 *
 * A glyph of its own rather than a reused one: the slot is read as a legend
 * down the left edge, and a PR row is not any of the four things already
 * spelled there.
 */
export const PR_MARKER = "⊙";

/** Columns before line 1's content: a space, the rail (which the cursor bar
 *  overlays on the cursor row), and a space. The marker slot is inside
 *  `primarySegments`, not here. */
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
export function rowLabel(entry: PanelRow): string {
  // `#151 Worktrees panel: open-PR list` — the number and the title are one
  // label, on line 1 where the bright layer is. Splitting them across the two
  // columns would put the only thing that identifies the PR to a human on the
  // dim line.
  if (entry.kind === "pr") return `#${entry.pr.number} ${entry.pr.title}`;
  // No spinner here: `rowLabel` is pure and the render passes the live glyph
  // to `primarySegments` instead. Nothing reads this arm today (the label
  // column skips the row and `primarySegments` returns before it), so it
  // exists to be honest rather than to be called.
  if (entry.kind === "pr-status") return prStatusText(entry.status, "");
  return entry.row.isMain ? "main checkout" : entry.row.name;
}

/**
 * The branch, or empty when naming it would only stutter.
 *
 * A worktree derived from its branch carries the same word twice
 * (`fix-codex  fix-codex`), which is the single loudest thing on a screen full
 * of rows and says nothing. Shown only where the two genuinely differ.
 *
 * The main checkout has its own stutter: `main checkout  main` in every repo
 * group. Its branch is news only when it is somewhere UNEXPECTED, so the
 * default branch is hidden there too. A display heuristic, not truth — the
 * rows do not carry the repo's real default branch, so a repo whose default
 * is `develop` but whose main checkout sits on `main` wrongly hides it. That
 * failure only hides a true name; it can never show a wrong one.
 */
export function rowBranch(entry: PanelRow): string {
  // A PR's head ref goes on the detail line instead. Its label is already the
  // full width of a title, so a second column beside it has nowhere to start.
  if (entry.kind !== "worktree") return "";
  const row = entry.row;
  if (row.detached || !row.branch) return "detached";
  if (row.branch === rowLabel(entry)) return "";
  if (row.isMain && (row.branch === "main" || row.branch === "master")) {
    return "";
  }
  return row.branch;
}

/**
 * Longest label among `rows`, so their branches line up in a column.
 *
 * The component measures the WHOLE panel, not one repo group: a per-group
 * column put the branches at a different x in every group, and the eye
 * tracked a zigzag down a multi-repo list instead of one straight line.
 */
export function labelColumnWidth(rows: PanelRow[], max = 28): number {
  let width = 0;
  for (const entry of rows) {
    // Only WORKTREE rows are measured. A PR row's label is a title and a
    // status row's is a sentence; either would push the branch column of
    // every worktree in the panel to the cap, over rows that have no branch
    // column of their own to align to.
    if (entry.kind !== "worktree") continue;
    width = Math.max(width, displayWidth(rowLabel(entry)));
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
    /** The PANEL's widest marker slot ({@link markerWidth} of whether any
     *  checkbox exists anywhere), which the branch column pads against. */
    markerBase: number;
    selected?: boolean;
    /** The live status glyph for an occupied row, already resolved by the
     *  caller (it animates, so it cannot come from a pure function). */
    statusIcon?: string;
  },
): RowSegment[] {
  const segments: RowSegment[] = [];
  if (entry.kind === "pr") {
    // Its own marker, so the left edge stays a legend: `⌂` main checkout, a
    // status glyph where an agent is, `·` a plain worktree, `[ ]` removable,
    // `⊙` a pull request.
    segments.push({ text: `${PR_MARKER} `, fg: theme.mauve });
    segments.push({
      text: rowLabel(entry),
      fg: rowColor(entry, opts.isCursor),
    });
    return segments;
  }
  if (entry.kind === "pr-status") {
    // NO marker glyph — the left-edge legend names things you can act on,
    // and this is a sentence about the repo. The slot is still SPENT, so the
    // text starts in exactly the column it did when this was drawn as a
    // detail-shaped line rather than a row: `markerWidth(false)` here plus
    // `ROW_GUTTER` outside is `detailGutter(false)`, unchanged.
    segments.push({
      text: " ".repeat(markerWidth(false)),
      fg: theme.overlay,
    });
    segments.push({
      text: prStatusText(entry.status, opts.statusIcon ?? ""),
      fg: rowColor(entry, opts.isCursor),
    });
    return segments;
  }
  const row = entry.row;
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
    // Never an empty slot: every row's line 1 carries a marker, so the left
    // edge reads as a legend down the screen (`⌂` main checkout, a status
    // glyph where someone is working, `·` plain worktree, `[ ]` removable),
    // and a detail line, which never has one, is structurally
    // distinguishable from a one-line row instead of only tonally.
    segments.push({ text: "· ", fg: theme.overlay });
  }

  const label = rowLabel(entry);
  const branch = rowBranch(entry);
  segments.push({ text: label, fg: rowColor(entry, opts.isCursor) });
  if (branch) {
    // Padded against the PANEL's widest marker, not the row's own: kept rows
    // wear a 2-column marker and removable rows a 4-column checkbox, and a
    // pad computed from the label alone made the branch column jog two
    // columns to the right at the removable divider.
    const pad = Math.max(
      1,
      opts.markerBase +
        opts.labelWidth +
        2 -
        markerWidth(entry.candidate !== null) -
        displayWidth(label),
    );
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
  kept: WorktreePanelRow[];
  removable: WorktreePanelRow[];
  prs: (PRPanelRow | PRStatusRow)[];
} {
  const worktrees = rows.filter(
    (entry): entry is WorktreePanelRow => entry.kind === "worktree",
  );
  return {
    kept: worktrees.filter((entry) => !entry.candidate),
    removable: worktrees.filter((entry) => entry.candidate),
    // Both PR kinds, since the PR view renders them the same way: they are
    // rows in one list, and a repo has either the open ones or the single
    // line standing in for them. A third output would only give the render
    // somewhere new to disagree with the layout.
    prs: rows.filter(
      (entry): entry is PRPanelRow | PRStatusRow => entry.kind !== "worktree",
    ),
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
 * The label that opens a group's removable section.
 *
 * Starts with a tee so the rail runs INTO it rather than being interrupted by
 * it: the section is a labelled break in one group, not a new group. No dash
 * run after the label: the repo header owns the horizontal-rule language, and
 * even a capped run here read as a competing boundary. The tee and the words
 * are the whole divider. Truncated rather than trusted to fit, because OpenTUI
 * wraps instead of clipping and a wrapped line in a `height={1}` box vanishes.
 */
export function dividerText(count: number, width: number): string {
  return truncateText(`├─ removable · ${count}`, Math.max(1, width));
}

/**
 * What a {@link PRStatusRow} says.
 *
 * `ready` needs no count because the row exists only where the repo produced
 * no PR rows, so it is zero by construction — and that condition now lives in
 * ONE place, `merged()`, rather than being re-derived by the render and the
 * line arithmetic separately.
 *
 * The wait is said here rather than leaving the section blank, for the reason
 * the title's `scanning` suffix rides the title: an empty run of repo headers
 * reads as broken, and an answer that REPLACES text in place moves nothing.
 * The cause is said under the repo it applies to, which is what a single
 * shared line cannot do; reached only for a per-REPO failure, since a
 * whole-request one has the same cause for every repo and takes the whole
 * view instead (`prWholeFailure`) rather than printing itself once per repo.
 *
 * No width and no truncation: this is a row's label now, and every row in the
 * panel is fitted by `fitSegments` at render. Two places truncating one
 * string is how they come to disagree. The reason is flattened to one line
 * first — see {@link oneLine} for the newline that is zero columns wide.
 */
export function prStatusText(status: PRSectionStatus, spinner: string): string {
  if (status.kind === "pending") {
    return spinner ? `${spinner} checking GitHub` : "checking GitHub";
  }
  if (status.kind === "ready") return "no open PRs";
  const reason = status.reason ? oneLine(status.reason) : "";
  return reason ? `unavailable: ${reason}` : "unavailable";
}

/**
 * The dim rule that trails a repo header, giving a group boundary real
 * weight without spending a blank line on it (which the layout deliberately
 * does not have). It runs the FULL list width, and it is the ONLY horizontal
 * rule in the panel: the header marks the panel's PRIMARY boundary, a repo,
 * while the removable divider is a labelled break inside one group and stays
 * visually subordinate by carrying no rule at all, just its tee and label.
 *
 * Only the fill: the name itself stays a separate render concern because it
 * is bold mauve while the rule is muted. Empty when the name leaves no room
 * for at least the leading space and one dash.
 */
export function headerRule(name: string, width: number): string {
  const fill = width - displayWidth(name) - 1;
  return fill > 0 ? ` ${"─".repeat(fill)}` : "";
}

/** `1 worktree` / `3 worktrees`, so no sentence has to say `worktree(s)`. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Whether a prune run went entirely to plan: something was removed, nothing
 * was refused, and no step failed along the way (a failed step on a removed
 * worktree, like a surviving branch or a skipped liveness check, is still
 * something the user should see). This is the gate for skipping the outcome
 * screen: its per-row detail is the point when anything went sideways, and
 * pure ceremony when every line would be a green check.
 */
export function pruneFullySucceeded(result: PruneRunResult): boolean {
  return (
    result.outcomes.length > 0 &&
    result.outcomes.every(
      (outcome) =>
        outcome.removed &&
        outcome.error == null &&
        outcome.steps.every((step) => step.ok),
    )
  );
}

/** The title-line notice a fully successful removal leaves behind. */
export function removalNotice(count: number): string {
  return `removed ${plural(count, "worktree", "worktrees")}`;
}

/**
 * The last COMPLETED phase-2 scan, kept across panel mounts so a reopen that
 * is a RETURN (the review round-trip, a cancelled spawn dialog) can seed
 * itself from it instead of re-firing the fetch+gh scan the user just
 * watched finish. Keyed by the repo scope it answered for: a cache from
 * another scope is a miss, never a fallback. Only successful scans are
 * stored (a failure has nothing worth reusing), and any completed prune run
 * clears it, because its outcomes may have removed the very worktrees the
 * scan classified. Plain opens (`W`, the group menu) never read it, so PR
 * badges cannot go stale through ordinary use.
 */
export interface CachedScan {
  scope: string | null;
  scan: PruneScan;
}

let lastCompletedScan: CachedScan | null = null;

/** The cached scan iff it answered for exactly this scope, else null. */
export function cachedScanFor(
  cache: CachedScan | null,
  scope: string | null,
): PruneScan | null {
  return cache !== null && cache.scope === scope ? cache.scan : null;
}

/** Test hygiene: the cache is module state and must not leak across tests. */
export function resetScanCache(): void {
  lastCompletedScan = null;
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
 * Lay the ACTIVE view out in visual lines: repo headers and the removable
 * divider each take one, and a row takes whatever {@link rowVisualHeight}
 * says.
 *
 * The divider is not a row and the cursor never lands on it, but it is a LINE,
 * and a scroll target computed without it puts every row below the divider one
 * line off. Keyed by PATH for the same reason the cursor is: phase 2 re-sorts
 * the list, and a layout keyed by position would describe the arrangement the
 * cursor just left.
 *
 * Per VIEW, because the two draw different lines from the same groups. Only
 * the rows the active view renders are placed at all — a layout that measured
 * both would put every row after the first group out of true by exactly the
 * lines the other view owns.
 */
export function visualLayout(
  repos: PanelRepo[],
  heightOf: (entry: PanelRow) => number,
  view: PanelView = "worktrees",
): VisualLayout {
  const layout: VisualLayout = new Map();
  let line = 0;
  const place = (entry: PanelRow) => {
    const height = heightOf(entry);
    layout.set(entry.key, { line, height });
    line += height;
  };
  const headers = showsGroupHeaders(repos);
  for (const repo of repos) {
    if (headers) line += 1; // the repo header
    const { kept, removable, prs } = splitRemovable(repo.rows);
    if (view === "prs") {
      // No arm for "this repo has nothing": a repo with no open PRs carries a
      // `pr-status` ROW instead, so there is no line here that is not also a
      // row, and therefore nothing for the row list to disagree with.
      prs.forEach(place);
      continue;
    }
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

/**
 * argv that hands `url` to the desktop's browser, or null where there is no
 * standard way to.
 *
 * The two answers every desktop agrees on. `open` is always present on macOS;
 * `xdg-open` is the freedesktop entry point every Linux desktop installs,
 * which is a weaker guarantee than `pbcopy`'s but the only one there is, so a
 * missing one is reported rather than guessed around.
 *
 * Known limit, and it has no fix of `y`'s kind: over ssh this opens a browser
 * on the REMOTE machine. `y` covers that case by ALSO writing OSC 52, which
 * reaches the terminal the user is looking at; there is no escape sequence
 * for "open this URL", so the honest thing is to say so rather than pretend.
 */
export function browserArgv(
  url: string,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return null;
  return ["xdg-open", url];
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
  platform: NodeJS.Platform = process.platform,
): { osc52: boolean; local: boolean } {
  const osc52 = Boolean(
    writer?.isOsc52Supported() && writer.copyToClipboardOSC52(text),
  );
  const argv = clipboardArgv(platform);
  const local = argv !== null && spawn(argv, text);
  return { osc52, local };
}

/**
 * The pull request a row points at, whichever kind of row it is.
 *
 * ONE meaning for `o` on every row, which is the rule the panel's keys follow
 * (`d` reviews, `y` copies, `x` removes — none of them read the row to decide
 * what they are). A PR row IS a pull request; a worktree row has one when the
 * scan found it, open or merged. A row with neither says so rather than
 * silently doing nothing.
 */
export function rowPRUrl(entry: PanelRow): string | null {
  if (entry.kind === "pr") return entry.pr.url;
  // A sentence about a repo has no PR of its own, so `o` says "no PR on this
  // row" here, which is the same thing it says on a plain worktree.
  if (entry.kind === "pr-status") return null;
  // One arm, not two: the merge in `merged()` already folds a candidate's PR
  // into `entry.pr` (`openPRs.get(path) ?? candidate?.pr ?? null`), so a
  // second `?? entry.candidate?.pr?.url` here was unreachable and read as if
  // the two could differ.
  return entry.pr?.url ?? null;
}

/** Hand `url` to the desktop browser. False when there is no way to, or the
 *  helper could not be started. */
export function openInBrowser(
  url: string,
  spawn: (argv: string[]) => boolean = spawnDetached,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const argv = browserArgv(url, platform);
  return argv !== null && spawn(argv);
}

function spawnDetached(argv: string[]): boolean {
  try {
    const child = Bun.spawn(argv, {
      stdout: "ignore",
      stderr: "ignore",
    });
    void child.exited;
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything the panel does OUTSIDE its own process: the two keys that hand a
 * URL or some text to another program.
 *
 * A REQUIRED prop, and that is the entire point of it. `o` shipped calling
 * `openInBrowser(url)` with no injected spawner, so a component mounted by
 * `testRender` plus one simulated keypress ran the real `open` and put real
 * browser windows on the developer's screen — twice, in a suite that reported
 * green. The seam already existed one level down ({@link openInBrowser} and
 * {@link copyToClipboard} both take an injectable spawner); nothing MADE the
 * component thread it, so it did not.
 *
 * Required is what turns that omission into a compile error: a mount cannot
 * exist without saying what its side effects are, so a test that forgets does
 * not build rather than reaching the machine. The next key that shells out
 * has nowhere to put a real default.
 *
 * The methods are VERBS, not argv. Which argv each verb runs, and on which
 * platform, is settled by {@link browserArgv} / {@link clipboardArgv} and
 * their own tests, which inject a spawner and assert the exact argument list.
 * A spawn-level seam would have to force two different shapes (the clipboard
 * helper writes stdin, the browser one does not) through one signature.
 */
export interface PanelEffects {
  /** Hand `url` to the desktop browser. False when there is no way to. */
  openUrl(url: string): boolean;
  /**
   * Put `text` on the clipboard by every channel available. The OSC 52
   * writer is the renderer, which the component owns, so it is passed in
   * rather than captured here.
   */
  copyText(
    text: string,
    writer: Osc52Writer | null,
  ): { osc52: boolean; local: boolean };
}

/** The panel's real side effects, for the one place that wants them. */
export const liveEffects: PanelEffects = {
  openUrl: (url) => openInBrowser(url),
  copyText: (text, writer) => copyToClipboard(text, writer),
};

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
  const dims = useSharedTerminalDimensions();
  // Only for `y`: OSC 52 goes out through the terminal the renderer owns.
  const renderer = useRenderer();
  const [phase, setPhase] = createSignal<Phase>("loading");
  const [repos, setRepos] = createSignal<WorktreeListResponse["repos"]>([]);
  const [scan, setScan] = createSignal<PruneScan | null>(null);
  /** Phase 2's failure, which leaves the panel usable read-only. */
  const [scanError, setScanError] = createSignal<string | null>(null);
  /** Phase 3 (issue #151): the repos' open PRs, null until GitHub answers. */
  const [prs, setPrs] = createSignal<PRListResponse | null>(null);
  /** Phase 3's whole-request failure. Per-REPO failures ride inside a
   *  successful response, so one broken repo costs only its own section. */
  const [prError, setPrError] = createSignal<string | null>(null);
  const [cursorPath, setCursorPath] = createSignal<string | null>(
    props.initialCursor ?? null,
  );
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [dirtyOk, setDirtyOk] = createSignal<Set<string>>(new Set());
  const [result, setResult] = createSignal<PruneRunResult | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  /** True while the panel is narrowed to `props.repo`; Tab flips it. */
  const [scoped, setScoped] = createSignal(
    props.repo !== null && props.startWidened !== true,
  );
  /**
   * Which view is up; `h`/`l` flip it, and it is ORTHOGONAL to `scoped`.
   *
   * Seeded from the cursor the open was asked to land on ({@link
   * initialView}), which is what lets every return path — the review round
   * trip, a cancelled spawn dialog, a cancelled spawn-from-PR — reopen in the
   * view that can actually show its row without any of them learning a new
   * prop.
   */
  const [view, setView] = createSignal<PanelView>(
    initialView(props.initialCursor),
  );
  /**
   * The row each view was last left on, so `h` restores what `l` left rather
   * than dropping the cursor on row 1 both ways.
   *
   * A plain object and not a signal: nothing RENDERS from it. It is read once
   * inside `switchView` and written once on the way out, so making it
   * reactive would only add a dependency for effects to chase.
   *
   * Remembered keys go STALE by design, and that is the whole reason the
   * restore is a preference rather than an assignment. The PR view's keys
   * change under it: a repo with no open PRs carries a synthetic
   * `pr-status:<repoRoot>` row that VANISHES the moment that repo gains a PR,
   * and a PR that merges between two visits takes its row with it. So a
   * remembered key that is not in the view's CURRENT rows is discarded and
   * the ordinary re-seed takes over.
   */
  const lastCursorByView: Record<PanelView, string | null> = {
    worktrees: null,
    prs: null,
  };

  /**
   * Move to `next`, remembering where this view was and restoring where that
   * one was.
   *
   * Both halves go through here rather than through `setView` at the two key
   * sites: remembering on the way out and restoring on the way in are one
   * transaction, and splitting them is how one of them comes to be forgotten.
   */
  function switchView(next: PanelView): void {
    if (next === view()) return;
    lastCursorByView[view()] = cursorPath();
    const remembered = lastCursorByView[next];
    setView(next);
    // Only if it is still there. `flatRows()` is read AFTER `setView`, so it
    // is already the new view's list; a key that has gone falls through to
    // the re-seed effect, which puts the cursor on the first row.
    if (remembered !== null && flatRows().some((r) => r.key === remembered)) {
      setCursorPath(remembered);
    }
  }
  const [note, setNote] = createSignal<string | null>(null);
  /** A fully successful removal's title-line notice; the next load wipes it. */
  const [titleNotice, setTitleNotice] = createSignal<string | null>(null);
  let listBox: ScrollBoxRenderable | undefined;
  /** One-shot: only a return-open's FIRST load may seed from the cache, so
   *  `r` and Tab inside the same mount still rescan for real. */
  let seedFromCache = props.isReturn === true;
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

  /**
   * Whether phase 3 is still in flight. Derived from its own inputs for the
   * same reason `scanning` is: the generation counter then covers it for free.
   */
  const prPending = (): boolean => prs() === null && prError() === null;

  /**
   * Why phase 3 has nothing for this repo, or null when it has an answer.
   *
   * Both shapes of failure reach `prSection`, so the tab line and the union
   * stay truthful either way, but only ONE of them is ever drawn per repo. A
   * per-REPO error is, under the repo it names, because "which repo" is the
   * question a single shared line cannot answer. A whole-request failure is
   * not: it is one cause for every repo, so `prWholeFailure` takes the whole
   * view and these per-repo lines are never reached.
   *
   * Declared ABOVE `merged`, which is a `createMemo` and therefore runs on
   * creation. It survived below only because the first evaluation is always
   * pending and short-circuits past this call; a later change that seeded
   * phase 3 the way a return-open seeds phase 2 would have turned that into a
   * temporal-dead-zone crash at mount.
   */
  const prReasonFor = (repoRoot: string): string | null => {
    const failed = prError();
    if (failed !== null) return failed;
    return (
      (prs()?.errors ?? []).find((e) => e.repoRoot === repoRoot)?.error ?? null
    );
  };

  /** Repo filter currently in force, which is what both requests carry. */
  const repoFilter = (): string | null => (scoped() ? props.repo : null);

  /**
   * The filter the rows on screen were loaded UNDER, or `undefined` before
   * anything has loaded. What it exists for is telling a RESCOPE apart from a
   * plain reload, which the phase alone cannot: `r`, a post-prune reload and
   * a Tab all set the phase back to `loading` over a list that stays on
   * screen, and only one of the three has made that list belong to another
   * question.
   */
  const [loadedFilter, setLoadedFilter] = createSignal<string | null | undefined>(
    undefined,
  );

  const merged = createMemo<PanelRepo[]>(() => {
    const data = scan();
    const candidates = new Map(data?.candidates.map((c) => [c.path, c]) ?? []);
    const skips = new Map(data?.skipped.map((s) => [s.path, s]) ?? []);
    const openPRs = new Map((data?.open ?? []).map((o) => [o.path, o.pr]));
    const prsByRepo = new Map(
      (prs()?.repos ?? []).map((repo) => [repo.repoRoot, repo.prs]),
    );
    const pending = prPending();
    return orderRepos(repos(), props.repo).map((repo) => {
      const worktrees: PanelRow[] = repo.worktrees.map((row) => {
        const candidate = candidates.get(row.path) ?? null;
        return {
          kind: "worktree" as const,
          key: row.path,
          row,
          candidate,
          skip: skips.get(row.path) ?? null,
          pr: openPRs.get(row.path) ?? candidate?.pr ?? null,
        };
      });
      const openPRRows: PanelRow[] = (prsByRepo.get(repo.repoRoot) ?? []).map(
        (pr) => {
          const held = checkoutHolding(pr, repo.worktrees);
          return {
            kind: "pr" as const,
            key: prRowKey(repo.repoRoot, pr.number),
            repoRoot: repo.repoRoot,
            pr,
            checkedOutPath: held?.path ?? null,
            // The worktree's own display name, the one the row above it
            // shows — not a basename recomputed here, which is the same
            // string only until the two disagree.
            checkedOutName: held?.name ?? null,
          };
        },
      );
      // `unavailable` covers both shapes of phase-3 failure: the whole
      // request falling over, and THIS repo's own error riding back inside an
      // otherwise fine response. Either way the PR view says so under this
      // repo, with the cause.
      const prReason = pending ? null : prReasonFor(repo.repoRoot);
      const prSection: PRSectionStatus = pending
        ? { kind: "pending" }
        : prReason !== null
          ? { kind: "unavailable", reason: prReason }
          : { kind: "ready", count: openPRRows.length };
      // The ONE place that decides whether a repo has PR rows or the line
      // that stands in for them. Not view-conditional: the view is a filter
      // over one list, and the worktrees filter drops this row on its kind
      // without knowing it exists. Everything downstream — the layout, the
      // render, the cursor — then treats it as the ordinary row it is.
      const prRows: PanelRow[] =
        openPRRows.length > 0
          ? openPRRows
          : [
              {
                kind: "pr-status" as const,
                key: prStatusRowKey(repo.repoRoot),
                repoRoot: repo.repoRoot,
                status: prSection,
              },
            ];
      return {
        repoRoot: repo.repoRoot,
        repoName: repo.repoName,
        rows: sortWorktreeRows([...worktrees, ...prRows]),
        prSection,
      };
    });
  });

  /**
   * What the PR view says INSTEAD of a list when phase 3 failed wholesale.
   *
   * One line, and no repo groups at all. The per-repo line is right for a
   * per-repo failure — with thirteen repos, "which one" is the only question
   * a shared line cannot answer — but a whole-request failure has ONE cause
   * for every repo, and saying it under each of them filled the entire
   * viewport with thirteen copies of the same sentence. That is not an edge
   * case either: it is the FIRST-RUN state for every existing user, whose
   * daemon predates `/prs` until they restart it.
   *
   * The groups go with it rather than standing over the line as bare
   * headers. In this view a repo name whose PRs are entirely unknown carries
   * no information, and thirteen empty headers is the same noise wearing a
   * different shape.
   *
   * Declared ABOVE `flatRows`, which is a `createMemo` and therefore runs on
   * creation and reads this. Below it, that is a temporal-dead-zone crash at
   * mount, which is the same trap `prReasonFor` is placed above `merged` to
   * avoid — and which the tests caught the moment `flatRows` started gating
   * on it.
   */
  const prWholeFailure = (): string | null =>
    view() === "prs" ? prError() : null;

  /**
   * Every row of every repo, both kinds, in display order.
   *
   * The panel-WIDE measurements read this rather than the active view's list,
   * so the label column and the title counts describe the same panel whichever
   * view is up and nothing jogs when `h`/`l` is pressed.
   */
  const allRows = createMemo(() => merged().flatMap((repo) => repo.rows));

  /**
   * The rows the CURSOR walks: the active view's, and only those.
   *
   * Everything that MOVES or ACTS reads this — `cursorIndex`, `cursorRow`, the
   * re-seed effect, `moveCursor`, the empty-state gate — because a consumer
   * left on the unfiltered list is a key acting on a row that is not on
   * screen. The rows themselves are unchanged and unsorted here: the view is a
   * filter over one list, not two lists.
   */
  const flatRows = createMemo(() => {
    if (view() !== "prs") {
      return allRows().filter((entry) => entry.kind === "worktree");
    }
    // A whole-request failure replaces the whole list with one banner line
    // (`hasContent` / `emptyState`), so there is nothing on screen for a
    // cursor to be on. Without this the row list still held a `pr-status`
    // row per repo: the cursor seeded onto one and `j` walked it invisibly,
    // which is the "a key acting on a row the user cannot see" shape this
    // panel is built to avoid, even where every one of those keys only
    // flashes. The gate is the same accessor the render uses, so the two
    // cannot disagree about whether the list exists.
    if (prWholeFailure() !== null) return [];
    // Everything that is NOT a worktree: PR rows, and the `pr-status` row
    // standing in for a repo that has none. Spelled as the complement on
    // purpose — the worktrees filter stays an exact kind, so a row kind added
    // later lands in the PR view rather than in neither, which is how these
    // rows became unreachable in the first place.
    return allRows().filter((entry) => entry.kind !== "worktree");
  });

  /** One label column for the whole panel, so the branches form a single
   *  straight line across repo groups instead of re-aligning per group. */
  const labelWidth = createMemo(() => labelColumnWidth(allRows()));

  /** The panel's widest marker slot: 4 the moment any checkbox exists, else
   *  2. The branch column pads against this rather than each row's own
   *  marker, so it cannot jog by two at the removable divider. */
  const markerBase = createMemo(() =>
    markerWidth(
      allRows().some(
        (entry) => entry.kind === "worktree" && entry.candidate !== null,
      ),
    ),
  );

  const candidates = (): PruneCandidate[] => scan()?.candidates ?? [];

  // Tracked by PATH, not index: phase 2 re-sorts the list under the cursor,
  // and an index would silently point at whichever row moved into that slot.
  //
  // Memoized rather than plain accessors because EVERY row reads the cursor,
  // several times over: a plain accessor makes each read a fresh O(rows)
  // findIndex, so one j/k costs O(rows²) scans on top of re-running the row
  // builders. Which row is the cursor's is one fact; it is computed once.
  const cursorIndex = createMemo((): number => {
    const path = cursorPath();
    const rows = flatRows();
    const found = path ? rows.findIndex((r) => r.key === path) : -1;
    return found >= 0 ? found : 0;
  });
  const cursorRow = createMemo((): PanelRow | null => {
    return flatRows()[cursorIndex()] ?? null;
  });
  /**
   * The cursor row's path, as the thing a row compares ITSELF against.
   *
   * A row that read `cursorRow()` would subscribe to the whole row object and
   * re-render on any change to it; comparing paths lets each row's own
   * `isCursor` memo hold its value, so a keypress re-renders the two rows
   * whose boolean actually flipped instead of all of them.
   */
  const cursorKey = createMemo(() => cursorRow()?.key ?? null);

  // Seed the cursor the moment there is a row to sit on. Leaving it null and
  // falling back to index 0 looks identical until phase 2 re-sorts, at which
  // point "index 0" is a different worktree and the cursor has silently
  // jumped to whatever took the top slot.
  //
  // Re-seeded when the key is GONE for the same reason. A Tab re-scope, an `r`
  // reload or a reopen can drop the row the cursor was on, and the two halves
  // of the cursor then disagree: `cursorIndex` falls back to 0, so the
  // highlight and every key that acts move to the top row, while `cursorPath`
  // still names a row that is not in the list, which the scroll effect looks
  // up, does not find, and gives up on.
  //
  // That disagreement is NOT invisible, and used not to be understood. Phase 1
  // and phase 3 are two independent promise chains, and Solid flushes effects
  // BETWEEN their setters, so on every reopen seeded with a PR key this ran
  // once against a list holding worktrees only. It is not a race that a fast
  // daemon wins: with `/prs` answering instantly the seed was still thrown
  // away before phase 3 could deliver its row. Hence the hold below, and hence
  // repairing the disagreement at all rather than treating it as cosmetic.
  //
  // The phase-2 re-sort does not trip this: it reorders the same keys.
  createEffect(() => {
    const rows = flatRows();
    const first = rows[0];
    const path = cursorPath();
    const live = path !== null && rows.some((r) => r.key === path);
    // A PR key that is not in the list yet is NOT a row that vanished. Phase
    // 1 is local git and phase 3 is a `gh` round trip, so on a reopen phase 1
    // essentially always lands first, with worktrees only; re-seeding here
    // would drop the cursor before the row it names could arrive, defeating
    // the restoration `initialCursor` exists for. Held only while phase 3 is
    // still in flight, so a PR that has genuinely gone (merged between the
    // two opens) still falls back to the first row the moment we know.
    // Gated on the VIEW as well, and not only on the key. Held in the PR
    // view, where the row can still arrive; NOT held in the Worktrees view,
    // which will never show a PR row however long phase 3 takes, so a hold
    // there would leave `cursorPath` naming a row the list does not have
    // while `cursorIndex` fell back to 0 — the exact disagreement this
    // re-seed exists to repair. That is the `l`-then-`h`-while-pending path.
    if (
      !live &&
      path !== null &&
      view() === "prs" &&
      isPRRowKey(path) &&
      prPending()
    ) {
      return;
    }
    if (live || !first) return;
    // A `pr-status` key does not go missing because its row was removed — it
    // goes missing because that repo ANSWERED and its stand-in was replaced
    // by real PR rows. Falling back to `rows[0]` there yanks the cursor to
    // the top of the list and drags the viewport with it, away from the rows
    // the user was parked on waiting for. So re-seed within the same repo
    // when it still has rows, and only then fall back.
    //
    // Bounded on purpose: this fires only when the CURSOR's repo answers. A
    // reload that returns the same answer keeps the key and never reaches
    // here, and another repo gaining PRs does not touch this key either.
    const repoRoot = prStatusRowRepo(path ?? "");
    if (repoRoot !== null) {
      const sameRepo = rows.find(
        (r) => r.kind !== "worktree" && r.repoRoot === repoRoot,
      );
      if (sameRepo) {
        setCursorPath(sameRepo.key);
        return;
      }
    }
    setCursorPath(first.key);
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
      visualLayout(
        merged(),
        (entry) => rowVisualHeight(entry, props.compact === true),
        view(),
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
   * The header's leading label: WHICH repos the panel is showing. A single
   * repo puts its name here, which is what lets the list drop the group
   * header line that would otherwise repeat it.
   *
   * Read from the scope flag and `props.repo`, never from the loaded rows.
   * Two things follow, and both are the point. It is right in the FIRST
   * frame, so the chips beside it do not slide rightwards when phase 1 lands
   * — they are click targets, and a target that moves after the panel opens
   * is a target the user can miss. And on a Tab rescope it flips
   * IMMEDIATELY, in the same frame as the keypress, where the rows behind it
   * are deliberately the previous scope's until the reload answers: the
   * label states what the panel is now fetching, which is the question Tab
   * just asked. `basename` is exactly what the daemon derives `repoName`
   * from, so the scoped label matches the group header it replaces.
   */
  const headerLead = (): string => {
    // Scoped: from the FLAG and the prop, so Tab flips the label in the same
    // frame as the keypress and no reload can be caught saying the old
    // scope's name. `basename` is exactly what the daemon derives `repoName`
    // from, so this matches the group header it stands in for.
    if (scoped() && props.repo !== null) return basename(props.repo);
    // Unscoped, but only one repo answered: it still has to be named here,
    // because `showsGroupHeaders` draws no header for a lone group and the
    // name would otherwise appear nowhere in the panel. Gated on the SCOPE
    // the rows were loaded under, exactly as the count is and for both of
    // the same reasons — `repos()` holds the PREVIOUS scope's list while a
    // rescope is in flight, so a Tab that widens the panel would go on
    // naming the repo it just left; and a plain `r`, which is not a rescope,
    // must not drop the name and put it back, since this label's width is
    // what positions both chips.
    const repos = loadedFilter() === repoFilter() ? merged() : [];
    return repos.length === 1 ? repos[0]!.repoName : "all repos";
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


  // The PR header's own spinner, released the moment phase 3 lands.
  const prIcon = useStatusIcon(
    () => (prPending() ? "working" : "idle"),
    () => null,
    () => props.iconStyle ?? "dot",
  );

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

  /**
   * The panel's worktree count, worn by the `Worktrees` chip, or "" while it
   * is not known.
   *
   * A bare number, because the chip it sits in already names its subject.
   * The old title said `Worktrees` and then `· 42 worktrees` beside it, which
   * is where two of the word's three appearances came from.
   *
   * WORKTREE rows of the WHOLE panel, not of the active view: the inactive
   * chip has to state the other view's count, which is the whole reason
   * `merged()` stays unfiltered. Counting the view's own list said `0` under
   * the PR view, and counting the unfiltered list unfiltered said `4` for two
   * worktrees and two PRs, with the number JUMPING when phase 3 arrived.
   * `markerBase` filters the same way.
   *
   * Blanked while ANY load is in flight, and that is deliberately not what
   * the scope LEAD does, because the two can go wrong in different ways.
   * A repo's identity cannot be stale — it is the same repo before and after
   * the reload — so the lead holds and keeps both chips still. A COUNT can:
   * `load()` is what a finished prune calls, so holding the old number
   * across it states `Worktrees 2` for a panel that has just removed one of
   * the two. `repos()` is retained across a reload, but the loading branch
   * does not DRAW it — the body reads `Reading worktrees...` — so a held
   * count is not even agreeing with rows on screen; there are none.
   *
   * The cost is that this chip narrows by the width of its own number while
   * the panel reloads, and the PR chip beside it moves with it. That is a
   * click target moving, which is a real cost and the reason the lead is
   * handled the other way. It is accepted HERE because the alternative is
   * stating a number we have reason to believe is wrong, and because the
   * body is visibly reloading while it happens.
   */
  const worktreeCount = (): string => {
    if (phase() === "loading") return "";
    if (merged().length === 0) return "";
    return String(
      allRows().filter((entry) => entry.kind === "worktree").length,
    );
  };

  /**
   * The muted tail: the removal notice, then the scanning announcement, or
   * null when there is nothing to say. They can coexist — a fully successful
   * prune reloads in place, so its notice rides the very rescan it triggered
   * — which is what the dividing `·` is for. It divides PEERS here, the one
   * job that dot has in this panel now that no count is glued to its label.
   */
  const headerTail = (): string | null => {
    const parts: string[] = [];
    const notice = titleNotice();
    if (notice) parts.push(notice);
    if (scanning()) parts.push(`${scanIcon()} scanning`);
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  /**
   * What the `Pull Requests` chip wears: the live count, the spinner while
   * GitHub is being asked, or `unavailable` when the whole request fell over.
   *
   * A bare token with no `·` in front of it. `Pull Requests unavailable`
   * reads as the sentence it is, where `Pull Requests · unavailable` read as
   * two separate facts.
   *
   * Counted from `allRows()` so it is the PANEL's number and not the active
   * view's — the inactive tab has to state the other view's count, which is
   * the whole reason `merged()` stays unfiltered. A whole-request failure
   * says so rather than reporting the `0` rows that failure produced; a
   * per-REPO failure does not appear here at all, because the PR view names
   * it under the repo it belongs to.
   */
  const prTabSuffix = (): string => {
    if (prPending()) return prIcon();
    const count = allRows().filter((entry) => entry.kind === "pr").length;
    // Read off the SECTIONS the body is drawn from, not a second look at
    // `errors`, so the tab and the lines under it can never tell different
    // stories. Per-repo failures arrive as HTTP 200 with `repos: []`, so
    // `prError()` is null and a fresh count is 0 — the tab asserted `0`
    // while every line beneath it said the answer was unknown, and in the
    // Worktrees view, which has no lines, the fabricated `0` was all you saw.
    //
    // The gate is ZERO-ONLY, and the comment has to say so rather than claim
    // a principle the code does not apply. A count of zero that ANY repo
    // could not answer for is not a count at all, so it reads `unavailable`
    // — which deliberately overstates the mixed case (one repo errored,
    // twelve truthfully zero). A NON-zero count is shown as-is even when a
    // repo failed: `1` alongside an unavailable repo is a lower bound
    // presented as a total, and that is a known overstatement in the other
    // direction, accepted because the alternative is hiding every count the
    // moment any repo is unreachable. Do not read "never assert a number we
    // cannot stand behind" as the rule in force here; it is the direction
    // the zero case leans, not a property of the whole derivation.
    //
    // Known gap, left open on purpose: a repo that `GET /worktrees` reported
    // but `GET /prs` mentions in NEITHER `repos` nor `errors` reads as
    // ready-0 — "no open PRs" where the truth is "never asked". It is
    // reachable, since the two are separate requests and the daemon derives
    // its repo set per request, but closing it means changing what an absent
    // repo means, which many tests currently bake in as the lenient reading.
    if (count === 0 && merged().some((r) => r.prSection.kind === "unavailable")) {
      return "unavailable";
    }
    return String(count);
  };

  const header = createMemo(() =>
    headerLayout({
      view: view(),
      lead: headerLead(),
      worktrees: worktreeCount(),
      prs: prTabSuffix(),
      tail: headerTail(),
      width: contentWidth(),
    }),
  );
  /**
   * The tab the pointer is over, so an inactive chip answers a hover before
   * it is clicked. Without it a filled block that reacts to nothing until
   * the click lands reads as decoration rather than a control.
   */
  const [hoveredTab, setHoveredTab] = createSignal<PanelView | null>(null);

  /**
   * Whether the active view has anything to draw.
   *
   * One question for both views now. It used to need the REPO list in the PR
   * view, because a repo with no open PRs drew a line that was not a row;
   * that line is a `pr-status` row, so every repo contributes at least one
   * row to either view and `flatRows()` answers for both.
   */
  const hasContent = () =>
    view() === "prs"
      ? prWholeFailure() === null && flatRows().length > 0
      : flatRows().length > 0;

  /** The line that stands in for the list, and the colour that says whether
   *  it is a fact or a failure. */
  const emptyState = (): RowSegment => {
    const failure = prWholeFailure();
    if (failure !== null) {
      // Flattened: a `gh` failure can be two lines, and a newline is zero
      // columns wide, so it would pass the width guard and then take
      // everything after it off the screen. See {@link oneLine}.
      return {
        text: `Open PRs unavailable: ${oneLine(failure)}`,
        fg: theme.yellow,
      };
    }
    return {
      text: view() === "prs" ? "No repos found." : "No worktrees found.",
      fg: theme.subtext,
    };
  };

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
  function load(opts: { refresh?: boolean } = {}): void {
    const generation = ++loadGeneration;
    const filter = repoFilter();
    setPhase("loading");
    setScan(null);
    setScanError(null);
    setPrs(null);
    setPrError(null);
    // A removal notice describes the run that led HERE; any further load
    // (Tab, `r`, a reopen) is news that supersedes it. The success path sets
    // its notice AFTER calling load(), so the one reload it rides survives.
    setTitleNotice(null);

    const listUrl = new URL(`${getDaemonUrl()}/worktrees`);
    if (filter) listUrl.searchParams.set("repo", filter);
    if (props.cwd) listUrl.searchParams.set("cwd", props.cwd);
    fetch(listUrl, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(describeHttpFailure(response.status));
        const data = (await response.json()) as WorktreeListResponse;
        if (generation !== loadGeneration) return;
        setRepos(data.repos);
        setLoadedFilter(filter);
        setPhase("list");
      })
      .catch((err: unknown) => {
        if (generation !== loadGeneration) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });

    // Phase 3 is INDEPENDENT of both: a third request on the same generation,
    // with its own timeout, so a slow GitHub cannot hold up the list and a
    // failure costs one line rather than the panel. Deliberately not seeded
    // from the prune scan's cached PRs — that scan answers about worktrees,
    // so it knows nothing about a PR no checkout here has ever held, which is
    // most of what this section is for. A return-open simply refetches; the
    // daemon's per-repo TTL is what makes that cheap.
    const prUrl = new URL(`${getDaemonUrl()}/prs`);
    if (filter) prUrl.searchParams.set("repo", filter);
    if (props.cwd) prUrl.searchParams.set("cwd", props.cwd);
    // Only an explicit `r`. Every other load (open, Tab, a finished prune)
    // is happy with the daemon's TTL, which is what keeps a rescope free.
    if (opts.refresh) prUrl.searchParams.set("refresh", "1");
    fetch(prUrl, { signal: AbortSignal.timeout(PR_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(describeHttpFailure(response.status));
        const data = normalizePRList((await response.json()) as PRListBody);
        if (generation !== loadGeneration) return;
        setPrs(data);
      })
      .catch((err: unknown) => {
        if (generation !== loadGeneration) return;
        setPrError(err instanceof Error ? err.message : String(err));
      });

    // A return-open reuses the scan the user just watched complete instead
    // of re-firing it. The seed goes through `setScan` exactly like a live
    // completion, so the merge, the single re-sort and the title suffix all
    // behave identically, and nothing is in flight for this generation, so
    // nothing can clobber it. Phase 1 above still re-ran: it is local and
    // instant, and a review may have changed the dirty counts it reports.
    const seeded = seedFromCache
      ? cachedScanFor(lastCompletedScan, filter)
      : null;
    seedFromCache = false;
    if (seeded) {
      setScan(seeded);
      return;
    }

    const scanUrl = new URL(`${getDaemonUrl()}/worktrees/prune-candidates`);
    if (filter) scanUrl.searchParams.set("repo", filter);
    if (props.cwd) scanUrl.searchParams.set("cwd", props.cwd);
    fetch(scanUrl, { signal: AbortSignal.timeout(SCAN_TIMEOUT_MS) })
      .then(async (response) => {
        if (!response.ok) throw new Error(describeHttpFailure(response.status));
        const data = normalizeScan((await response.json()) as ScanResponse);
        if (generation !== loadGeneration) return;
        lastCompletedScan = { scope: filter, scan: data };
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
    setCursorPath(rows[next]!.key);
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
    const origin = { panelRepo: props.repo, panelScope: repoFilter() };
    if (entry.kind === "pr") {
      // A PR already checked out here is not a spawn question at all: it is
      // the worktree that holds it, so Enter routes through the SAME verb a
      // worktree row's Enter takes, which revalidates against the live
      // session list and jumps if an agent moved in since the list was read.
      if (entry.checkedOutPath) {
        props.onSpawn({
          cwd: entry.checkedOutPath,
          existingWorktree: entry.checkedOutPath,
          // The PR row's own key, not the worktree's path. The destination
          // is the worktree; the ROW is this PR, and a cancelled dialog has
          // to come back to it — in the PR view, which `initialView` derives
          // from exactly this cursor.
          cursor: entry.key,
          ...origin,
        });
        return;
      }
      props.onSpawnFromPR({
        number: entry.pr.number,
        title: entry.pr.title,
        repoRoot: entry.repoRoot,
        cursor: entry.key,
        ...origin,
      });
      return;
    }
    if (entry.kind === "pr-status") {
      // Enter has nothing to open. Say what the row is reporting rather than
      // doing nothing, and where it is a failure name the key that retries.
      flash(
        entry.status.kind === "pending"
          ? "still checking GitHub"
          : entry.status.kind === "unavailable"
            ? "open PRs unavailable here: r retries"
            : "no open PRs here",
      );
      return;
    }
    const session = entry.row.sessions[0];
    if (session) {
      props.onJump(session);
      return;
    }
    // The opening repo AND the live filter travel with the action: Tab's
    // rescope is panel-local, so a return that read the store instead would
    // land on the narrow view the user had already widened away from.
    props.onSpawn(
      entry.row.isMain
        ? { cwd: entry.row.repoRoot, existingWorktree: null, ...origin }
        : { cwd: entry.row.path, existingWorktree: entry.row.path, ...origin },
    );
  }

  function copyPath(path: string): void {
    const how = props.effects.copyText(path, renderer);
    flash(
      how.osc52 || how.local
        ? `copied ${basename(path)}`
        : "copy needs OSC 52 or pbcopy",
    );
  }

  /**
   * `o`: open this row's pull request on GitHub.
   *
   * The same verb on every row (see {@link rowPRUrl}), and it always says
   * what happened — the browser opens in another application, so a key that
   * silently did nothing would be indistinguishable from one that worked.
   */
  function openRowPR(entry: PanelRow | null): void {
    const url = entry ? rowPRUrl(entry) : null;
    if (!url) {
      flash("no PR on this row");
      return;
    }
    flash(props.effects.openUrl(url) ? `opened ${url}` : "no browser opener here");
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
        // Either way the run may have removed worktrees the cached scan
        // still classifies, so a later return-open must scan fresh.
        lastCompletedScan = null;
        if (pruneFullySucceeded(data)) {
          // Straight back to the list: the outcome screen earns its keep with
          // per-row detail, which an all-green run has none of. The removed
          // paths are gone, so the selection and its opt-ins go with them
          // rather than waiting for the rescan to filter them.
          setSelected(new Set<string>());
          setDirtyOk(new Set<string>());
          load();
          setTitleNotice(removalNotice(data.outcomes.length));
          return;
        }
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
      //
      // Same `refresh` as the list phase, and that is the whole point of the
      // key: `r` was justified on "one key, one meaning, on every phase", and
      // a done-phase retry that answered the PR section from a 60s cache
      // would have been the context-sensitive version of it. It is also the
      // phase whose own comment promises a stale list gets refreshed.
      if (key === "r" || key === "R") {
        load({ refresh: true });
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
    /**
     * Whether the removal keys are live.
     *
     * The VIEW, not the cursor row, because `x` acts on the SELECTION and
     * `a` on every candidate in scope — neither reads the cursor at all. With
     * rows selected in the Worktrees view, an `x` pressed after `l` would
     * open the confirm over worktrees that are not on screen, which is the
     * one way this panel could delete something the user cannot see. The
     * selection itself is deliberately left alone across a view switch, so
     * `h` gets it back untouched.
     */
    const canRemove = view() === "worktrees";
    switch (key) {
      // The two views, on the two keys the panel had left. `Tab` is NOT one
      // of them: scope and view are orthogonal axes and each keeps its own.
      // In the session list `h`/`l` collapse and expand a group, but the
      // panel owns every key while it is up, and panel-local divergence has
      // precedent (`d` reviews a branch here and a working tree there).
      case "h":
      case "left":
        switchView("worktrees");
        break;
      case "l":
      case "right":
        switchView("prs");
        break;
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
        if (!canRemove) break;
        // Only a classified candidate is selectable: the main checkout, a
        // held row and a healthy one have no removal to opt into, and a
        // checkbox on them would promise one.
        if (entry?.kind === "worktree" && entry.candidate) {
          toggleSelected(entry.candidate.path);
        }
        break;
      // `A` too, matching x/X, y/Y and D/d below: a shift held a beat too long
      // should not silently do nothing.
      case "a":
      case "A":
        if (!canRemove) break;
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
          if (!canRemove) break;
          if (entry?.kind === "worktree" && entry.candidate) {
            toggleDirtyOk(entry.candidate);
          }
          break;
        }
        // Explicitly guarded rather than left to fall through: `d` reviews a
        // DIFF of a checkout, and a PR row is not one. Saying so beats a key
        // that reads as broken.
        if (entry?.kind === "pr") {
          flash("d reviews a worktree; enter opens this PR");
          break;
        }
        if (entry?.kind === "pr-status") {
          flash("d reviews a worktree");
          break;
        }
        if (entry && props.onReview) {
          props.onReview({
            path: entry.row.path,
            sessionId: entry.row.sessions[0]?.id ?? null,
            panelRepo: props.repo,
            panelScope: repoFilter(),
          });
        }
        break;
      }
      // Removal moved off Enter, which now means "open this worktree". `x`
      // is the picker's kill key on a session row, so it is the same verb in
      // the same place rather than a new one to learn.
      case "x":
      case "X": {
        if (!canRemove) {
          // Never silent, by the same rule the empty-selection cases below
          // follow — and here the silence would be worse than a dead key,
          // since a selection made in the other view is still counted and
          // still real.
          flash("removal lives in the worktrees view: h");
          break;
        }
        if (effective().length > 0) {
          setPhase("confirm");
          break;
        }
        // With nothing selected, `x` used to do nothing at all, which reads as
        // a broken key. It now either acts on the row under the cursor or says
        // what is missing.
        if (entry?.kind === "worktree" && entry.candidate && !entry.candidate.dirty) {
          // Single-target: the cursor IS the selection anyone would have made,
          // and the confirm still stands between it and the deletion.
          toggleSelected(entry.candidate.path);
          setPhase("confirm");
          break;
        }
        if (entry?.kind === "worktree" && entry.candidate) {
          // A dirty row selected on its own still removes nothing, so sending
          // it to a "delete 0 worktrees" confirm would be the same dead end
          // wearing a dialog. Name the key that unblocks it instead.
          flash("uncommitted work here: D includes it, then x");
          break;
        }
        if (blockedDirty().length > 0) {
          // Same dead end, reached from a row that is not the dirty one: the
          // selection is entirely held back by the dirty gate. Saying
          // "nothing selected" here contradicts the footer, which is counting
          // that selection two lines below.
          flash("uncommitted work: D includes it, then x");
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
        // Guarded for the same reason `d` is: `y` copies a PATH, and a PR row
        // has no directory until one is cut from it.
        if (entry?.kind === "pr") {
          flash("no directory yet: enter cuts a worktree from this PR");
          break;
        }
        if (entry?.kind === "pr-status") {
          flash("nothing to copy on this line");
          break;
        }
        if (entry) copyPath(entry.row.path);
        break;
      // Both spellings of the capital, like x/X, a/A and D/d above: terminals
      // disagree about whether a shifted letter arrives as `"O"` or as `"o"`
      // with `shift` set, and testing only one made a binding unreachable on
      // half of them once already.
      case "o":
      case "O":
        openRowPR(entry);
        break;
      // `r` already means reload on the done and error phases; it simply
      // never reached the list, where the panel spends all its time. One key,
      // one meaning, on every phase. It matters more since the PR section
      // arrived: the worktree scan is local and only changes when the user
      // does something, while a PR merges on GitHub with nothing local to
      // show for it, and close-and-reopen was the only way to find out.
      case "r":
      case "R":
        load({ refresh: true });
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
    if (view() === "prs") {
      // A shorter line, because the keys really are fewer: the removal keys
      // are gated off with the rows they act on, and `y` and `d` have nothing
      // to answer — a PR has no directory to copy and no working tree to
      // review until one is cut from it. That leaves room for `h` at a rank
      // that survives the narrow widths, which is not true of `l` on the
      // fuller line the other view has to fit.
      return fitHints(
        [
          { text: "j/k move", rank: 3 },
          { text: "enter checkout", rank: 4 },
          { text: "o github", rank: 2 },
          { text: "r refresh", rank: 1 },
          { text: "h worktrees", rank: 3 },
          ...(props.repo !== null
            ? [{ text: scoped() ? "tab all repos" : "tab this repo", rank: 2 }]
            : []),
          { text: "q close", rank: 5 },
        ],
        contentWidth(),
      );
    }
    // The removal keys are taught where they apply: on a row under the
    // removable divider, or once something is already selected (so the count
    // and the way to act on it never disappear mid-selection). Everywhere
    // else they are noise about an action the cursor cannot take.
    const cursor = cursorRow();
    const inRemovable =
      cursor?.kind === "worktree" && cursor.candidate !== null;
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
              { text: "D include dirty", rank: 1 },
              { text: "a all clean", rank: 1 },
            ]
          : []),
        { text: "y copy", rank: 1 },
        ...(props.onReview ? [{ text: "d review", rank: 1 }] : []),
        // Lowest rank, and last among their peers: `o` opens something in
        // another application and `r` only re-reads what is already correct,
        // so they are the first hints a narrow panel can afford to lose. They
        // must never displace a key that ACTS on the list, which is exactly
        // what `r` at a higher rank did to `D include dirty`.
        { text: "o github", rank: 1 },
        { text: "r refresh", rank: 1 },
        ...(props.repo !== null
          ? [{ text: scoped() ? "tab all repos" : "tab this repo", rank: 2 }]
          : []),
        // The SHORT form, ranked with `tab` — the pair it belongs to, since
        // they are the panel's two axes — and LAST among that rank, so it is
        // the first of the pair to go and displaces nothing that already fit.
        // A known and accepted cost: this line is fuller than the PR view's,
        // so the hint survives to 90 columns and is gone by 80. The tab line
        // above still names both views at every width; only the key goes.
        // Buying it back was tried, on the tab line as a `[l]` badge, and
        // rejected — keyboard notation inside a label reads as documentation
        // leaking into the interface.
        { text: `l ${PRS_TAB_SHORT}`, rank: 2 },
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
      {/* The whole header, one line: which repos, which of their two
          subjects, and whatever is in flight. No justifyContent — with
          flexDirection="row" it would center the line, and this header has
          always read as left-aligned like every other dialog's.

          It renders OUTSIDE the scrollbox, so it is budgeted against
          `contentWidth()` and pays nothing for the scrollbar column. Drawn
          from the loading phase onwards rather than appearing with the list,
          which would step the whole body down one line at exactly the moment
          the rows land. */}
      <Show
        when={
          phase() === "loading" || phase() === "list" || phase() === "confirm"
        }
      >
        <box width="100%" height={1} flexDirection="row">
          <For each={headerParts(header())}>
            {(part: HeaderPart) => {
              if (part.kind === "lead") {
                // The scope leads, in the panel's brightest ink: it is the
                // subject the chips beside it are two views OF.
                return (
                  <text fg={theme.text}>
                    <strong>{part.text}</strong>
                  </text>
                );
              }
              if (part.kind === "text") {
                return <text fg={theme.overlay}>{part.text}</text>;
              }
              const tab = part.tab;
              return (
                <box
                  flexDirection="row"
                  /* ONE chip is filled, and the other takes the panel's own
                     ground rather than a second, dimmer fill. Two fills was
                     the first cut and it is not portable: `border` is DARKER
                     than `surface` in dracula and rose-pine, which would draw
                     the active chip recessed and the inactive one raised —
                     backwards, in a palette a user can also override
                     arbitrarily. With one fill there is nothing to invert:
                     the filled chip is the one showing, whatever the theme
                     does with its greys. */
                  backgroundColor={tab.active ? theme.border : theme.base}
                  onMouseOver={() => setHoveredTab(tab.view)}
                  onMouseOut={() =>
                    setHoveredTab((current) =>
                      current === tab.view ? null : current,
                    )
                  }
                  onMouseDown={(event) => {
                    if (event.button === MouseButton.LEFT) {
                      switchView(tab.view);
                    }
                  }}
                >
                  <For each={tab.segments}>
                    {(segment: RowSegment) => (
                      <text
                        fg={
                          !tab.active && hoveredTab() === tab.view
                            ? theme.subtext
                            : segment.fg
                        }
                      >
                        {segment.text}
                      </text>
                    )}
                  </For>
                </box>
              );
            }}
          </For>
        </box>
      </Show>

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
            when={hasContent()}
            fallback={
              <box paddingTop={1}>
                <text fg={emptyState().fg}>
                  {truncateText(emptyState().text, contentWidth())}
                </text>
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
                  // A pure function of a group that does not change while it
                  // is mounted (a new `merged()` builds new groups), but read
                  // once PER ROW: as a plain accessor the split is recomputed
                  // at each of its four call sites, on every keypress. The
                  // label column is NOT per-group — `labelWidth` above
                  // measures the whole panel, so branches align across
                  // groups.
                  const split = createMemo(() => splitRemovable(repo.rows));
                  /* One row, in both sections: the section only decides
                     whether it carries a checkbox. */
                  /**
                   * One row. The rail is continuous over EVERY row line; the
                   * bare line above it (the panel title in the scoped view,
                   * the repo header in the multi-repo view) is what it hangs
                   * from. Leaving the first row's line 1 bare as an "anchor"
                   * just read as a hole in the rail.
                   */
                  const renderRow = (entry: PanelRow) => {
                    // A memo, not an accessor: every j/k changes `cursorKey`,
                    // and an accessor propagates that to each row's segment
                    // builders, which then rebuild and recreate every `<text>`
                    // child in the list. Held here, the value only changes for
                    // the row being left and the row being entered.
                    const isCursor = createMemo(
                      () => cursorKey() === entry.key,
                    );
                    const isSelected = () => selected().has(entry.key);
                    // The marker slot's width, which is what the detail line
                    // indents to. A PR row never carries a checkbox.
                    const hasCheckbox =
                      entry.kind === "worktree" && entry.candidate !== null;
                    // Read twice per render (once to decide the line exists,
                    // once to fit it), so it is computed once.
                    const detail = createMemo(() =>
                      detailSegments(entry, {
                        compact: props.compact === true,
                        dirtyOk: dirtyOk().has(entry.key),
                      }),
                    );
                    // The session list's own icon, spinner and all. Called
                    // per row, which `<For>` gives its own reactive owner, so
                    // the shared spinner interval is acquired and released
                    // with the row.
                    const statusIcon = useStatusIcon(
                      () =>
                        entry.kind === "worktree"
                          ? leadStatus(entry.row.sessions)
                          : // A waiting status row spins, which is what makes
                            // the pending PR view look alive per repo rather
                            // than thirteen static copies of one sentence.
                            entry.kind === "pr-status" &&
                              entry.status.kind === "pending"
                            ? "working"
                            : "idle",
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
                        {/* The cursor row carries the session list's
                            selected-row surface highlight, spanning both lines
                            of a two-line row; the cursor bar alone was easy to
                            miss. The bar takes the RAIL's own column, but the
                            highlight starts on the column AFTER it: `┃` is
                            centered in its cell, so a highlight that includes
                            the bar's own cell shows half a cell of surface
                            poking out LEFT of the stroke. */}
                        <box height={1} width="100%" flexDirection="row">
                          <text> </text>
                          <text fg={isCursor() ? theme.mauve : theme.overlay}>
                            {isCursor() ? CURSOR_BAR : RAIL}
                          </text>
                          <box
                            flexGrow={1}
                            height={1}
                            flexDirection="row"
                            backgroundColor={
                              isCursor() ? theme.surface : undefined
                            }
                          >
                            <text> </text>
                            <For
                              each={fitSegments(
                                primarySegments(entry, {
                                  isCursor: isCursor(),
                                  labelWidth: labelWidth(),
                                  markerBase: markerBase(),
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
                        </box>
                        <Show when={detail().length > 0}>
                          <box height={1} width="100%" flexDirection="row">
                            <text> </text>
                            {/* A detail line always hangs off its own line
                                1, so it always carries the rail, and it
                                indents to whatever marker that line 1 used.
                                The rail column matches line 1's, so a
                                two-line cursor row wears the bar on both
                                lines — and, as on line 1, the highlight
                                starts on the column after it. */}
                            <text fg={isCursor() ? theme.mauve : theme.overlay}>
                              {isCursor() ? CURSOR_BAR : RAIL}
                            </text>
                            <box
                              flexGrow={1}
                              height={1}
                              flexDirection="row"
                              backgroundColor={
                                isCursor() ? theme.surface : undefined
                              }
                            >
                              <text fg={theme.overlay}>
                                {` ${" ".repeat(markerWidth(hasCheckbox))}`}
                              </text>
                              <For
                                each={fitSegments(
                                  detail(),
                                  detailWidth(hasCheckbox),
                                )}
                              >
                                {(segment) => (
                                  <text fg={segment.fg}>{segment.text}</text>
                                )}
                              </For>
                            </box>
                          </box>
                        </Show>
                      </box>
                    );
                  };
                  // `listWidth`, not `contentWidth`: the header renders
                  // INSIDE the scrollbox, which keeps a column for its bar,
                  // so a name fitted to the content width overruns it by
                  // one. The scrollbox takes that column back silently,
                  // leaving a name that reads as complete with its last
                  // character gone and no ellipsis to say so (the divider,
                  // whose fill is one unbreakable word, wrapped away
                  // entirely instead).
                  const headerName = () =>
                    truncateText(repo.repoName, listWidth());
                  return (
                    <box flexDirection="column">
                      <Show when={showsGroupHeaders(merged())}>
                        <box height={1} flexDirection="row">
                          <text fg={theme.mauve}>
                            <strong>{headerName()}</strong>
                          </text>
                          {/* The rule is what makes the boundary scannable
                              on a tall multi-repo list without spending a
                              blank line on it; muted so the bold name stays
                              the loudest thing on the line. */}
                          <text fg={theme.overlay}>
                            {headerRule(headerName(), listWidth())}
                          </text>
                        </box>
                      </Show>
                      {/* One group, two views. The repo header above is
                          shared — it names the repo either way — and only
                          what hangs under it changes. */}
                      <Show
                        when={view() === "prs"}
                        fallback={
                          <box flexDirection="column">
                            <For each={split().kept}>
                              {(entry) => renderRow(entry)}
                            </For>
                            {/* Everything below this line can be deleted, and
                                only things below it carry checkboxes. The
                                label starts with a tee, so the rail runs into
                                it. */}
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
                              {(entry) => renderRow(entry)}
                            </For>
                          </box>
                        }
                      >
                        {/* The repo's open pull requests — or, where it has
                            none, the single `pr-status` row standing in for
                            them, which `merged()` put in the same list. One
                            branch, because there is only one kind of thing
                            here now. */}
                        <For each={split().prs}>
                          {(entry) => renderRow(entry)}
                        </For>
                      </Show>
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
