import type {
  Responsive,
  BreakpointConfig,
  ColumnsConfig,
  ColumnEntry,
  ColumnEntryObject,
  ColumnField,
  PromptDisplay,
  RowConfig,
  RowSide,
  StatusMode,
} from "../../lib/preferences";
import {
  BREAKPOINT_NAMES,
  COLUMN_FIELDS,
  DEFAULT_BREAKPOINTS,
} from "../../lib/preferences";
import type { EnrichedSession, BranchPR } from "../../types";
import { displayWidth, sliceToWidth, truncateText } from "../utils/format";

const RESPONSIVE_KEYS = new Set([
  "default",
  ...BREAKPOINT_NAMES,
] as readonly string[]);

/** Per-field default mode applied when an entry omits one. */
const DEFAULT_MODES: Partial<Record<ColumnField, string>> = {
  status: "icon",
  project: "dirname",
  agent: "full",
  pr: "full",
};

/** A resolved entry — field plus its concrete mode (when applicable). */
export interface ResolvedEntry {
  field: ColumnField;
  mode?: string;
}

/** A row's resolved layout: ordered left and right entry arrays. */
export interface ResolvedRow {
  left: ResolvedEntry[];
  right: ResolvedEntry[];
}

export interface ResolvedColumns {
  row1: ResolvedRow;
  row2: ResolvedRow;
}

/** Parse a shorthand string like "status:icon" or just "status". */
function parseShorthand(s: string): ColumnEntryObject | null {
  const colonIdx = s.indexOf(":");
  const fieldStr = colonIdx === -1 ? s : s.slice(0, colonIdx);
  const mode = colonIdx === -1 ? undefined : s.slice(colonIdx + 1);
  if (!COLUMN_FIELDS.includes(fieldStr as ColumnField)) return null;
  return { field: fieldStr as ColumnField, mode };
}

function isResponsiveObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return true; // empty {} is treated as responsive
  return keys.every((k) => RESPONSIVE_KEYS.has(k));
}

/**
 * Resolve a responsive value at the current terminal width.
 * Mobile-first cascade: a breakpoint value applies from that width upward
 * until a larger breakpoint overrides it.
 *
 * Object literals that contain non-responsive keys (e.g. ColumnEntryObject's
 * `{field, mode}`) are treated as leaf values, not responsive descriptors.
 */
export function resolveResponsive<T>(
  value: Responsive<T>,
  width: number,
  breakpoints: Required<BreakpointConfig>,
  implicitDefault: T,
): T {
  if (value === null || typeof value !== "object") return value as T;
  if (Array.isArray(value)) return value as T;
  if (!isResponsiveObject(value)) return value as T;

  const obj = value as {
    default?: T;
    xs?: T;
    sm?: T;
    md?: T;
    lg?: T;
  };
  let result: T = obj.default !== undefined ? obj.default : implicitDefault;
  for (const bp of BREAKPOINT_NAMES) {
    if (width >= breakpoints[bp] && obj[bp] !== undefined) {
      result = obj[bp] as T;
    }
  }
  return result;
}

/** Resolve a single column entry to its concrete `{field, mode}`. */
export function resolveEntry(
  entry: ColumnEntry,
  width: number,
  breakpoints: Required<BreakpointConfig>,
): ResolvedEntry | null {
  let obj: ColumnEntryObject | null;
  if (typeof entry === "string") {
    obj = parseShorthand(entry);
  } else {
    obj = entry;
  }
  if (!obj) return null;
  if (!COLUMN_FIELDS.includes(obj.field)) return null;

  let mode: string | undefined;
  if (obj.mode !== undefined) {
    mode = resolveResponsive<string>(
      obj.mode,
      width,
      breakpoints,
      DEFAULT_MODES[obj.field] ?? "",
    );
  } else {
    mode = DEFAULT_MODES[obj.field];
  }
  return { field: obj.field, mode };
}

/** Resolve a row side: pick the array at this width, then resolve each entry. */
export function resolveRowSide(
  side: RowSide | undefined,
  width: number,
  breakpoints: Required<BreakpointConfig>,
): ResolvedEntry[] {
  if (side === undefined) return [];
  const entries = resolveResponsive<ColumnEntry[]>(
    side as Responsive<ColumnEntry[]>,
    width,
    breakpoints,
    [],
  );
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => resolveEntry(e, width, breakpoints))
    .filter((e): e is ResolvedEntry => e !== null);
}

function resolveRow(
  row: RowConfig | undefined,
  width: number,
  breakpoints: Required<BreakpointConfig>,
): ResolvedRow {
  return {
    left: resolveRowSide(row?.left, width, breakpoints),
    right: resolveRowSide(row?.right, width, breakpoints),
  };
}

/** Default picker layout — grows with terminal width. */
const DEFAULT_COLUMNS: ColumnsConfig = {
  row1: {
    left: [
      "index",
      { field: "status", mode: { default: "icon", sm: "short", md: "full" } },
      { field: "project", mode: { default: "dirname", md: "full" } },
    ],
    right: {
      default: ["pane"],
      xs: [{ field: "agent", mode: "short" }, "pane"],
      sm: [{ field: "agent", mode: "short" }, "pane", "time"],
      md: [{ field: "agent", mode: "full" }, "version", "pane", "time"],
    },
  },
  // Row 2 renders only when some field has data (see `rowHasContent`), so
  // sessions with no prompt stay single-line. `pr` is right-aligned branch
  // metadata; the prompt cell shrinks (see SessionItem) so long prompts
  // truncate instead of pushing the PR ids off-screen. The `PR ` prefix is
  // dropped (`short`) below the `lg` breakpoint to save room on smaller
  // screens; inline collapse drops it too (see `flattenToRow1`), so the bare
  // colored `#id` rides next to the branch instead of reading as "PR".
  row2: {
    left: ["prompt"],
    right: [{ field: "pr", mode: { default: "short", lg: "full" } }],
  },
};

/**
 * Default sidebar layout — narrow, identity-first. Row 1 carries the
 * session-level metadata that must survive the `p` toggle and the
 * no-prompt collapse: PR rides row 1 (in `short` mode — the `PR ` prefix
 * is too wide for a 30-col rail) next to the agent code. Row 2 is the
 * per-turn activity line (prompt + time); the pane target is dropped from
 * the defaults since selection, not the address, drives navigation —
 * restorable via `sidebar.columns`.
 */
export const SIDEBAR_DEFAULT_COLUMNS: ColumnsConfig = {
  row1: {
    left: ["status", "project"],
    right: ["pr:short", "agent:short"],
  },
  row2: {
    left: ["prompt"],
    right: ["time"],
  },
};

/** Merge user overrides onto a base layout, row-by-row. */
function mergeColumns(
  base: ColumnsConfig,
  user?: ColumnsConfig,
): ColumnsConfig {
  if (!user) return base;
  return {
    row1: { ...base.row1, ...user.row1 },
    row2: { ...base.row2, ...user.row2 },
  };
}

function resolveWithBase(
  base: ColumnsConfig,
  width: number,
  user?: ColumnsConfig,
  breakpoints?: BreakpointConfig,
): ResolvedColumns {
  const bp: Required<BreakpointConfig> = {
    ...DEFAULT_BREAKPOINTS,
    ...breakpoints,
  };
  const merged = mergeColumns(base, user);
  return {
    row1: resolveRow(merged.row1, width, bp),
    row2: resolveRow(merged.row2, width, bp),
  };
}

export function resolveColumns(
  width: number,
  user?: ColumnsConfig,
  breakpoints?: BreakpointConfig,
): ResolvedColumns {
  return resolveWithBase(DEFAULT_COLUMNS, width, user, breakpoints);
}

/** Sidebar uses its own narrower defaults; user overrides via `prefs.sidebar.columns`. */
export function resolveSidebarColumns(
  width: number,
  user?: ColumnsConfig,
  breakpoints?: BreakpointConfig,
): ResolvedColumns {
  return resolveWithBase(SIDEBAR_DEFAULT_COLUMNS, width, user, breakpoints);
}

/** Dispatch to picker or sidebar resolver based on mode. */
export function resolveLayout(
  sidebar: boolean,
  width: number,
  user?: ColumnsConfig,
  breakpoints?: BreakpointConfig,
): ResolvedColumns {
  return sidebar
    ? resolveSidebarColumns(width, user, breakpoints)
    : resolveColumns(width, user, breakpoints);
}

/**
 * Drop the prompt entirely (the `off` prompt mode): row 2 is dropped
 * wholesale (density is the point of turning it off, so the PR cell goes
 * too), and a prompt placed on row 1 by a custom layout is stripped as well.
 */
export function stripPrompt(cols: ResolvedColumns): ResolvedColumns {
  return {
    row1: {
      left: cols.row1.left.filter((e) => e.field !== "prompt"),
      right: cols.row1.right.filter((e) => e.field !== "prompt"),
    },
    row2: { left: [], right: [] },
  };
}

/**
 * Collapse row 2 onto row 1 for single-line (`inline`) display: every row-2
 * entry joins the end of the matching row-1 side, and row 2 is emptied. The
 * prompt cell flexes to fill row 1's middle gap (see SessionItem's
 * `promptOnRow` handling), so the per-turn subtitle rides the identity line
 * instead of earning its own row.
 */
function flattenToRow1(cols: ResolvedColumns): ResolvedColumns {
  // `pr` (row 2's trailing metadata) tucks in right after `project` so it
  // reads as the branch metadata it is, rather than floating past the
  // timestamp at the far right; the prompt becomes the flexible filler at the
  // end of the left side. A field already on row 1 is dropped so nothing is
  // doubled (a custom `prompt` on row 1 plus the default `row2: [prompt]`
  // would otherwise render it twice, putting two flex fillers on one row).
  const present = new Set(
    [...cols.row1.left, ...cols.row1.right].map((e) => e.field),
  );
  const fresh = (entries: ResolvedEntry[]) =>
    entries.filter((e) => !present.has(e.field));
  const meta = fresh(cols.row2.right);
  const prompt = fresh(cols.row2.left);
  const projectIdx = cols.row1.left.findIndex((e) => e.field === "project");
  const left =
    projectIdx === -1
      ? [...cols.row1.left, ...meta, ...prompt]
      : [
          ...cols.row1.left.slice(0, projectIdx + 1),
          ...meta,
          ...cols.row1.left.slice(projectIdx + 1),
          ...prompt,
        ];
  // The single line has no room for the `PR ` prefix, and the bare colored
  // `#id` reads fine tucked next to the branch, so force `pr` to short.
  const shortenPr = (entries: ResolvedEntry[]): ResolvedEntry[] =>
    entries.map((e) => (e.field === "pr" ? { ...e, mode: "short" } : e));
  return {
    row1: { left: shortenPr(left), right: shortenPr(cols.row1.right) },
    row2: { left: [], right: [] },
  };
}

/**
 * Apply the runtime prompt mode (cycled by the `p` key) to a resolved layout:
 * - `off`: strip the prompt and drop row 2.
 * - `inline`: flatten row 2 onto row 1 for a single line. The narrow sidebar
 *   cannot fit an inline prompt, so it falls back to the two-row layout.
 * - `row2`: leave the prompt on its own row (the resolved default already
 *   places it there).
 */
export function applyPromptDisplay(
  cols: ResolvedColumns,
  mode: PromptDisplay,
  sidebar: boolean,
): ResolvedColumns {
  if (mode === "off") return stripPrompt(cols);
  if (mode === "inline" && !sidebar) return flattenToRow1(cols);
  return cols;
}

/**
 * Claude logs store slash-command turns as XML-ish markup
 * (`<command-name>/clear</command-name><command-args>…</command-args>`) and
 * local-command output wrapped in `<local-command-stdout>`. Reduce those to
 * the command line / inner text so the subtitle reads as the user's intent.
 */
function stripCommandMarkup(text: string): string {
  const command = text.match(/<command-name>(.*?)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>(.*?)<\/command-args>/);
    return [command[1], args?.[1]].filter(Boolean).join(" ");
  }
  const stdout = text.match(
    /<local-command-stdout>(.*?)<\/local-command-stdout>/,
  );
  if (stdout) return stdout[1];
  return text;
}

/**
 * The prompt as the subtitle renders it. Lives here (not SessionItem) so
 * `hasFieldData` can apply the same reduction: a prompt that normalizes
 * to "" (whitespace-only, or empty-inner markup like a quiet
 * `<local-command-stdout></local-command-stdout>`) must not earn row 2 a
 * line it would render blank.
 */
export function normalizePrompt(text: string): string {
  return stripCommandMarkup(text.replace(/\s+/g, " ").trim()).trim();
}

/**
 * PRs to render for a session's `pr` field. Background rows' authoritative
 * children (PRs the agent created) win; pane rows fall back to the
 * branch-derived `branchPRs` from the daemon's gh lookup.
 */
export function sessionPRs(session: EnrichedSession): BranchPR[] {
  const bg = (session.backgroundChildren ?? []).filter((c) => c.kind === "pr");
  if (bg.length > 0) return bg;
  return session.branchPRs ?? [];
}

/** PR-state color bucket for the `pr` cell. `null` means the PR carries no
 * review/CI state (background-agent PRs), so the caller keeps the neutral
 * color rather than picking a traffic-light hue. */
export type PRColorState = "red" | "green" | "yellow";

function prColorOf(pr: BranchPR): PRColorState | null {
  // Background-agent PRs have neither field → neutral. (gh-resolved PRs
  // always carry both, even if null, so `undefined` distinguishes them.)
  if (pr.reviewDecision === undefined && pr.ciStatus === undefined) return null;
  if (pr.ciStatus === "failing" || pr.reviewDecision === "CHANGES_REQUESTED")
    return "red";
  if (pr.reviewDecision === "APPROVED") return "green";
  // Open: review-required, no decision, pending, passing-but-unapproved, or
  // no CI configured. Strict green means only an explicit APPROVAL is green.
  return "yellow";
}

/**
 * One color for a session's PR cell. Folds multiple PRs on a branch by
 * worst-color (red > yellow > green) so a branch with any blocked PR is
 * never painted green. Returns `null` when no PR carries state, leaving the
 * cell its neutral (mauve) color.
 */
export function prColorState(session: EnrichedSession): PRColorState | null {
  let sawState = false;
  let sawYellow = false;
  for (const pr of sessionPRs(session)) {
    const c = prColorOf(pr);
    if (c === null) continue;
    sawState = true;
    if (c === "red") return "red";
    if (c === "yellow") sawYellow = true;
  }
  if (!sawState) return null;
  return sawYellow ? "yellow" : "green";
}

/**
 * Rendered label for the `pr` cell. Full mode (default): "PR #25" /
 * "PR #49 #51". Short mode drops the prefix ("#25") for narrow layouts
 * like the sidebar, where the state color alone marks it as a PR.
 */
export function prLabel(session: EnrichedSession, mode?: string): string {
  const prs = sessionPRs(session);
  if (prs.length === 0) return "";
  const ids = prs.map((p) => `#${p.id}`).join(" ");
  return mode === "short" ? ids : `PR ${ids}`;
}

/** Whether a single field has displayable data on this session. */
export function hasFieldData(
  session: EnrichedSession,
  field: ColumnField,
): boolean {
  switch (field) {
    case "index":
      return true;
    case "status":
      return true;
    case "project":
      return !!(session.paneCwd ?? session.cwd);
    case "agent":
      return !!session.agentType;
    case "version":
      return !!session.version;
    case "pane":
      return !!session.tmuxTarget;
    case "time":
      return !!(session.lastUserInputAt ?? session.lastActivityAt);
    case "prompt":
      return !!session.lastPrompt && normalizePrompt(session.lastPrompt) !== "";
    case "cwd":
      return !!(session.paneCwd ?? session.cwd);
    case "branch":
      return !!session.gitBranch;
    case "pr":
      return sessionPRs(session).length > 0;
  }
}

/**
 * Whether row 2 earns its line for a session. `time` is excluded from the
 * check: it annotates content rather than being content, so a session
 * whose row 2 would hold nothing but a timestamp collapses to one line.
 * When another field has data, time still renders alongside it.
 */
export function rowHasContent(
  session: EnrichedSession,
  row: ResolvedRow,
): boolean {
  const counts = (e: ResolvedEntry) =>
    e.field !== "time" && hasFieldData(session, e.field);
  return row.left.some(counts) || row.right.some(counts);
}

/** Whether the prompt cell lands on this resolved row (either side). */
export function rowHasPrompt(row: ResolvedRow): boolean {
  return (
    row.left.some((e) => e.field === "prompt") ||
    row.right.some((e) => e.field === "prompt")
  );
}

/** Max rendered width of an attention label before it is ellipsized. */
export const ATTENTION_LABEL_MAX = 12;

/**
 * The row-1 attention label for a session (pending tool name, "Plan",
 * "Permission", "Question"), or null when the row needs no attention marker.
 * Pure and layout-owned so the shared column budget can reserve its width;
 * the theme-dependent color stays in SessionItem (`getAttentionColor`).
 */
export function getAttentionLabel(session: EnrichedSession): string | null {
  if (session.pendingTool) return session.pendingTool;
  if (session.inPlanMode || session.attentionType === "plan_approval") {
    return "Plan";
  }
  if (session.status !== "waiting") return null;
  if (session.attentionType === "permission") return "Permission";
  if (session.attentionType === "question") return "Question";
  return null;
}

/**
 * The row-1 "N Agent" subagent-count label, or null when it should not show.
 * Hidden while a tool/plan attention marker is up (that takes the slot), and
 * only present when the session has live subagents.
 */
export function subagentCountLabel(session: EnrichedSession): string | null {
  if (
    !session.pendingTool &&
    !session.inPlanMode &&
    session.subagents &&
    session.subagents.length > 0
  ) {
    return `${session.subagents.length} Agent`;
  }
  return null;
}

/**
 * The glyph a row wears while a handoff is queued for it. One column, and the
 * same mark the pick-target banner leads with, so the thing being aimed and
 * the row waiting for it read as one feature.
 */
export const HANDOFF_BADGE = "⇄";

/**
 * The handoff badge for a session, or null when nothing is queued for it.
 *
 * Driven straight off `pendingHandoff`, which the daemon puts on the row while
 * a handoff waits for it to go idle and takes off again when it is delivered
 * or expires. There is no client-side timer: the badge appears and clears with
 * the SSE update that changed the fact.
 */
export function handoffBadge(session: EnrichedSession): string | null {
  return session.pendingHandoff ? HANDOFF_BADGE : null;
}

/**
 * Rendered width of row 1's trailing labels (attention + subagent count +
 * handoff badge) for a session. Consumed per-row (see `attentionWidth` in
 * SessionItem): each row reserves a cell sized to exactly its own labels, so an
 * unlabeled row reserves nothing and its prompt runs to the right-side
 * metadata, while a labeled row's prompt/project budgets subtract this width so
 * the `…` truncation lands just before the label. Right-side column alignment
 * is preserved by those columns' fixed widths, not by a uniform trailing cell.
 * Sidebar collapses the attention label to a single "!" and hides the subagent
 * count; the badge is one column either way and survives both.
 */
export function trailingLabelsWidth(
  session: EnrichedSession,
  sidebar: boolean,
): number {
  const attn = getAttentionLabel(session);
  const badge = handoffBadge(session);
  const badgeW = badge ? displayWidth(badge) : 0;
  const attnW = attn
    ? sidebar
      ? 1
      : Math.min(displayWidth(attn), ATTENTION_LABEL_MAX)
    : 0;
  const sub = sidebar ? null : subagentCountLabel(session);
  const subW = sub ? displayWidth(sub) : 0;
  // Summed over the labels this row actually draws, plus the box's one-column
  // gap between each adjacent pair. Kept as a fold rather than a pair of
  // hand-written gap terms, which is where a third label would have gone wrong.
  const widths = [attnW, subW, badgeW].filter((w) => w > 0);
  return widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1);
}

/** Split cwd parts plus branch state, fed to {@link fitProjectCell}. */
export interface ProjectCellInput {
  /** Path prefix (e.g. "epilande/"); pass "" in compact/dirname mode. */
  prefix: string;
  dirname: string;
  branch: string | null;
  isWorktree: boolean;
  /**
   * The prefix carries repo identity rather than path context (a worktree
   * row's `<repo>/<worktree>`), so it outranks the dirname when the cell has
   * to shrink. Path prefixes keep the default order (prefix first).
   */
  repoPrefix?: boolean;
}

/** Display strings for the project cell after fitting to a width budget. */
export interface ProjectCellDisplay {
  prefix: string;
  dirname: string;
  /** ":"-prefixed branch (with the `~`/`+` conventions), or "" when no branch. */
  branchLabel: string;
}

/**
 * The `:branch` label with the existing conventions: capped at `maxBranchLen`
 * COLUMNS with a trailing `~`, worktree `+` appended. Every budget in this
 * pipeline is a column count, so a branch of wide glyphs is capped by what it
 * draws rather than by how many code units it happens to spend.
 */
function branchLabelFor(
  branch: string,
  isWorktree: boolean,
  maxBranchLen: number,
): string {
  const shown =
    displayWidth(branch) > maxBranchLen
      ? sliceToWidth(branch, maxBranchLen - 1) + "~"
      : branch;
  return ":" + shown + (isWorktree ? "+" : "");
}

/** Narrowest budget that could still render a label: ":" + one column of
 *  branch + "~" + the worktree "+". Anything less and `shortenBranchLabel`
 *  returns "" outright; at or above it the label still drops when the branch
 *  has no grapheme narrow enough to fill that one column. */
function minBranchLabelWidth(isWorktree: boolean): number {
  return 3 + (isWorktree ? 1 : 0);
}

/**
 * Shorten a branch label to `avail` columns using the `~` marker; "" if too
 * tight. "Too tight" counts the worktree `+` as well as the ":" and one
 * usable column, because a label that keeps a one-column body plus both
 * markers would come back WIDER than the room it was given, and on a worktree
 * row that single overspent column is enough to push the repo out of the cell.
 *
 * A body that comes back empty drops the whole label. The one usable column
 * can hold no part of a wide-glyph branch (a CJK or emoji grapheme needs two),
 * and `:~` names no branch while still charging two columns the row would
 * rather spend on identity.
 */
function shortenBranchLabel(
  branch: string,
  isWorktree: boolean,
  avail: number,
): string {
  const wt = isWorktree ? "+" : "";
  if (avail < minBranchLabelWidth(isWorktree)) return "";
  const bodyWidth = Math.max(1, avail - 1 /* colon */ - 1 /* ~ */ - wt.length);
  if (displayWidth(branch) <= bodyWidth) return ":" + branch + wt;
  const body = sliceToWidth(branch, bodyWidth);
  if (!body) return "";
  return ":" + body + "~" + wt;
}

/** Fit the prefix into `avail` columns; dropped entirely under 2 usable ones. */
function fitPrefix(prefix: string, avail: number): string {
  if (avail < 2) return "";
  return displayWidth(prefix) > avail ? truncateText(prefix, avail) : prefix;
}

/** The dirname is the cell's last identifiable part, so it holds this many
 *  columns even when the budget says otherwise. */
const DIRNAME_FLOOR = 5;
/** Floor for a dirname that shares the cell with a repo prefix: the repo is
 *  the identity there, so the worktree name gives up more before the repo
 *  gives up anything. */
const WORKTREE_NAME_FLOOR = 3;

/** Fit the dirname into `avail` columns, never below `floor` (the caller
 *  absorbs the overflow elsewhere). */
function fitDirname(
  dirname: string,
  avail: number,
  floor = DIRNAME_FLOOR,
): string {
  if (displayWidth(dirname) <= avail) return dirname;
  return truncateText(dirname, Math.max(floor, avail));
}

/**
 * Fit the project (path:branch) cell into `budget` COLUMNS, never silently
 * clipping: any shortening shows `…` (or the existing `~` for the branch).
 * Shrink order matches the design: prefix first (drop it under 2 usable
 * columns), then the dirname (kept to a small floor), then the branch as a
 * last resort.
 *
 * Every budget here is measured with `displayWidth`, not `.length`: the parts
 * are cut by `truncateText`/`sliceToWidth`, which are column-true, so counting
 * the leftovers in code units would let a wide-glyph dirname (or an emoji in a
 * branch name) buy room the terminal never gives it back.
 *
 * A `repoPrefix` cell (a worktree's `<repo>/<worktree>`) reverses the first
 * two, since the repo a worktree belongs to is worth more than the tail of
 * its own directory name, and it renders the repo all-or-nothing. A
 * *truncated* repo is the worst of both: `claude-t…work…` names no repo and
 * swallows the `/` that made the pair read as a path, while still charging
 * for the characters. So the repo is either shown whole or dropped, and the
 * worktree name takes the freed space back at its normal floor. That also
 * keeps the cell inside `budget`: sizing a truncated prefix against a
 * floored dirname and then re-floating the dirname made the two steps
 * disagree and overflow into the neighbouring column.
 *
 * The branch yields before identity does on those cells: `maxBranchLen` alone
 * let a long branch spell itself out while the repo dropped and the worktree
 * name fell to a stub, which is backwards for a row whose whole purpose is
 * saying which tree it is.
 */
export function fitProjectCell(
  input: ProjectCellInput,
  budget: number,
  maxBranchLen: number,
): ProjectCellDisplay {
  const { prefix, dirname, branch, isWorktree, repoPrefix } = input;
  const prefixWidth = displayWidth(prefix);
  const dirnameWidth = displayWidth(dirname);
  let branchLabel = branch
    ? branchLabelFor(branch, isWorktree, maxBranchLen)
    : "";

  if (branch && repoPrefix) {
    // Reserve what `<repo>/<worktree>` needs to stay a label (the repo whole,
    // the worktree name at its floor) before the branch claims the rest.
    //
    // Only when the cell can pay for BOTH, though. Below that the repo is
    // dropping whatever the branch does, so squeezing the branch buys
    // nothing; and buying the repo by dropping the branch outright makes the
    // branch blink out of existence as the terminal *widens* into the band
    // where the repo starts fitting.
    const identityReserve =
      prefixWidth + Math.min(dirnameWidth, WORKTREE_NAME_FLOOR);
    const minBranch = minBranchLabelWidth(isWorktree);
    if (
      identityReserve + minBranch <= budget &&
      displayWidth(branchLabel) > budget - identityReserve
    ) {
      branchLabel = shortenBranchLabel(
        branch,
        isWorktree,
        budget - identityReserve,
      );
    }
  }

  // What the path parts get to share once the branch label has its width.
  const pathBudget = budget - displayWidth(branchLabel);

  if (prefixWidth + dirnameWidth <= pathBudget) {
    return { prefix, dirname, branchLabel };
  }

  let outPrefix = prefix;
  let outDirname = dirname;

  if (repoPrefix) {
    // 1. Shrink the worktree name first, keeping the repo whole.
    outDirname = fitDirname(
      dirname,
      pathBudget - prefixWidth,
      WORKTREE_NAME_FLOOR,
    );
    if (prefixWidth + displayWidth(outDirname) > pathBudget) {
      // 2. Even at its floor the pair doesn't fit: drop the repo whole (never
      //    a stub) and give the worktree name the entire path budget back.
      outPrefix = "";
      outDirname = fitDirname(dirname, pathBudget);
    }
  } else {
    // 1. Shrink the prefix first: give it what's left after dirname+branch.
    outPrefix = fitPrefix(prefix, pathBudget - dirnameWidth);
    // 2. Then the dirname, kept to a small floor so it stays identifiable.
    outDirname = fitDirname(dirname, pathBudget - displayWidth(outPrefix));
  }
  if (displayWidth(outPrefix) + displayWidth(outDirname) <= pathBudget) {
    return { prefix: outPrefix, dirname: outDirname, branchLabel };
  }

  // 3. Last resort: shorten the branch further with the `~` marker.
  if (branch) {
    const availForBranch =
      budget - displayWidth(outPrefix) - displayWidth(outDirname);
    branchLabel = shortenBranchLabel(branch, isWorktree, availForBranch);
  }
  return { prefix: outPrefix, dirname: outDirname, branchLabel };
}

/** Width allocated to a resolved entry on a "right side" (right-aligned column). */
export function entryRightWidth(entry: ResolvedEntry): number {
  switch (entry.field) {
    case "status":
      return entry.mode === "full" ? 9 : entry.mode === "short" ? 6 : 1;
    case "agent":
      return entry.mode === "short" ? 2 : 8;
    case "version":
      return 10;
    case "pane":
      return 12;
    case "time":
      return 4;
    case "index":
      return 1;
    default:
      return 0; // text fields right-align with intrinsic width
  }
}

export type { StatusMode };
