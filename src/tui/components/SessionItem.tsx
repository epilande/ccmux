import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTick } from "../store";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton, type MouseEvent } from "@opentui/core";
import type { EnrichedSession } from "../../types";
import type { IconStyle } from "../../lib/icons";
import type {
  ColumnsConfig,
  BreakpointConfig,
  ColumnField,
  PromptDisplay,
} from "../../lib/preferences";
import { DEFAULT_PROMPT_DISPLAY } from "../../lib/preferences";
import { getAgentDisplayName, getAgentShortCode } from "../../lib/agents";
import { HighlightedText } from "./HighlightedText";
import { StatusBadge } from "./StatusBadge";
import { InvokeStatusBadge, type InvokeStatus } from "./InvokeStatusBadge";
import { BackgroundStatusBadge } from "./BackgroundStatusBadge";
import {
  type ResolvedColumns,
  type ResolvedEntry,
  type ResolvedRow,
  type StatusMode,
  resolveLayout,
  applyPromptDisplay,
  prLabel,
  prColorState,
  hasFieldData,
  normalizePrompt,
  rowHasContent,
  rowHasPrompt,
  entryRightWidth,
  getAttentionLabel,
  subagentCountLabel,
  trailingLabelsWidth,
  fitProjectCell,
  ATTENTION_LABEL_MAX,
} from "./session-columns";
import { theme } from "../theme";
import { formatRelativeTime, formatVersion, shortenCwd } from "../utils/format";

interface SessionItemProps {
  session: EnrichedSession;
  selected: boolean;
  index: number;
  highlights?: {
    project?: string | null;
    cwd?: string | null;
    gitBranch?: string | null;
    lastPrompt?: string | null;
  } | null;
  iconStyle?: IconStyle;
  showPreview?: boolean;
  previewWidth: number;
  isActivePane?: boolean;
  isActiveSession?: boolean;
  /** Pre-resolved layout shared by every row (computed in SessionList). */
  layout?: ResolvedColumns;
  columns?: ColumnsConfig;
  breakpoints?: BreakpointConfig;
  dimmed?: boolean;
  sidebar?: boolean;
  /** Prompt display mode for the fallback layout resolution (direct mounts /
   * tests). Ignored when `layout` is supplied pre-resolved by SessionList. */
  promptDisplay?: PromptDisplay;
  onActivate?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}

function abbreviateTarget(target: string, maxLen: number = 12): string {
  if (target.length <= maxLen) return target;
  const colonIdx = target.lastIndexOf(":");
  if (colonIdx === -1) return target.slice(0, maxLen - 1) + "~";
  const suffix = target.slice(colonIdx);
  const sessionName = target.slice(0, colonIdx);
  const availableLen = maxLen - suffix.length - 1;
  if (availableLen <= 0) return target.slice(0, maxLen - 1) + "~";
  return sessionName.slice(0, availableLen) + "~" + suffix;
}

interface ProjectPathParts {
  prefix: string;
  dirname: string;
}

function formatProjectPath(
  cwd: string,
  maxSegments: number = 2,
): ProjectPathParts {
  const displayPath = shortenCwd(cwd);
  const segments = displayPath.split("/").filter(Boolean);
  const dirname = segments.at(-1) || displayPath;
  if (segments.length <= 1) return { prefix: "", dirname };
  const visibleSegments =
    segments.length <= maxSegments ? segments : segments.slice(-maxSegments);
  const prefix = visibleSegments.slice(0, -1).join("/") + "/";
  return { prefix, dirname };
}

/**
 * The project cell's path parts fit to a width budget. The compact/dirname
 * mode drops the prefix, so pass "" for it. Computed off the same
 * `fitProjectCell` the FieldCell renders from, so the render and the width
 * budget can never diverge.
 */
function fittedProjectCell(
  session: EnrichedSession,
  mode: string | undefined,
  budget: number,
  maxBranchLen: number,
) {
  const { prefix, dirname } = formatProjectPath(
    session.paneCwd ?? session.cwd,
    2,
  );
  return fitProjectCell(
    {
      prefix: mode === "full" ? prefix : "",
      dirname,
      branch: session.gitBranch,
      isWorktree: session.isWorktree,
    },
    budget,
    maxBranchLen,
  );
}

/**
 * Rendered char width of the `project` cell, used to budget an inline prompt
 * that shares row 1 with it. Derived from {@link fittedProjectCell} so it
 * reflects the truncated (`…`) rendering, not the natural width.
 */
function projectCellWidth(
  session: EnrichedSession,
  mode: string | undefined,
  budget: number,
  maxBranchLen: number,
): number {
  const fitted = fittedProjectCell(session, mode, budget, maxBranchLen);
  return (
    fitted.prefix.length + fitted.dirname.length + fitted.branchLabel.length
  );
}

const Bold: Component<{ when: boolean; children: string }> = (p) => (
  <Show when={p.when} fallback={<>{p.children}</>}>
    <b>{p.children}</b>
  </Show>
);

function getAttentionColor(session: EnrichedSession): string {
  if (session.pendingTool) return theme.yellow;
  if (session.inPlanMode || session.attentionType === "plan_approval") {
    return theme.teal;
  }
  return theme.mauve;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, Math.max(1, maxLen - 1)) + "…";
}

/** Agent dot/label color by agent type. A function (not a module const) so it
 * reads the live `theme` after `applyTheme`, rather than freezing the default
 * palette at import time. */
export function agentColorFor(agentType: string): string {
  const colors: Record<string, string> = {
    claude: theme.peach,
    codex: theme.green,
    opencode: theme.blue,
    gemini: theme.mauve,
    pi: theme.teal,
  };
  return colors[agentType] ?? theme.overlay;
}

/** PR cell color by derived state; `none` (no state, e.g. background-agent
 * PRs) keeps the prior neutral mauve. A function for the same call-time reason
 * as {@link agentColorFor}. */
export function prStateColor(
  state: "red" | "green" | "yellow" | "none",
): string {
  const colors: Record<"red" | "green" | "yellow" | "none", string> = {
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    none: theme.mauve,
  };
  return colors[state];
}

interface FieldRenderContext {
  session: EnrichedSession;
  index: number;
  iconStyle?: IconStyle;
  highlights?: SessionItemProps["highlights"];
  isActivePane?: boolean;
  isActiveSession?: boolean;
  selected: boolean;
  dimmed?: boolean;
  sidebar?: boolean;
  agentColor: string;
  attentionColor: string;
  attentionLabel: string | null;
  paneInfo: string;
  versionLabel: string;
  agentLabel: string;
  agentShortLabel: string;
  timeLabel: string;
  maxBranchLen: number;
  /** Char budget for the prompt cell; keeps it from overflowing its row. */
  maxPromptLen: number;
  /** Char budget for the project cell; drives its `…` truncation. */
  maxProjectLen: number;
}

function dimColor(ctx: FieldRenderContext, color?: string): string | undefined {
  return ctx.dimmed ? theme.border : color;
}

/**
 * Right-align `text` within a fixed-width cell on the right side by padding
 * the left with spaces. Left-side cells keep their natural left-alignment.
 * Opentui's `<text>` fills its parent box, so flex `justifyContent` alone
 * can't right-align a single text child — padStart does the job instead.
 */
export function alignText(
  text: string,
  width: number,
  side: "left" | "right",
): string {
  if (side !== "right") return text;
  if (text.length >= width) return text;
  return text.padStart(width);
}

const FieldCell: Component<{
  entry: ResolvedEntry;
  ctx: FieldRenderContext;
  side: "left" | "right";
  /** True when a flexing prompt shares this row: the project cell yields its
   * flex-grow so the prompt fills the middle gap instead. */
  promptOnRow?: boolean;
}> = (props) => {
  const { entry, ctx, side } = props;
  const width = entryRightWidth(entry);
  switch (entry.field) {
    case "index":
      return (
        <box width={width}>
          <text fg={dimColor(ctx, theme.overlay)}>
            {ctx.index < 9 ? `${ctx.index + 1}` : " "}
          </text>
        </box>
      );
    case "status": {
      const mode = (entry.mode as StatusMode) ?? "icon";
      // Read `originInvocationStatus` inside the <Show when> getter (not a
      // captured const) so the cell re-renders when the store flips a
      // synthetic invoke row to its terminal outcome via a fine-grained
      // setState. `ctx.session` is a stable store proxy; pulling the read out
      // into a local would freeze the badge on the running spinner.
      return (
        <box width={width}>
          <Show
            when={ctx.session.originInvocationStatus}
            fallback={
              <Show
                when={ctx.session.trackingMode === "background"}
                fallback={
                  <StatusBadge
                    status={ctx.session.status}
                    attentionType={ctx.session.attentionType}
                    attentionState={ctx.session.attentionState}
                    session={ctx.session}
                    iconStyle={ctx.iconStyle}
                    mode={mode}
                    dimmed={ctx.dimmed}
                  />
                }
              >
                <BackgroundStatusBadge
                  status={ctx.session.status}
                  attentionType={ctx.session.attentionType}
                  iconStyle={ctx.iconStyle}
                  mode={mode}
                  dimmed={ctx.dimmed}
                />
              </Show>
            }
          >
            {(s: () => InvokeStatus) => (
              <InvokeStatusBadge
                status={s()}
                iconStyle={ctx.iconStyle}
                mode={mode}
                dimmed={ctx.dimmed}
              />
            )}
          </Show>
        </box>
      );
    }
    case "project": {
      const compact = entry.mode !== "full";
      // A createMemo, not a plain const: this component body runs once per
      // mount and rows stay mounted across SSE deltas, so a const would freeze
      // the cell on its mount-time value. The memo instead recomputes reactively
      // when the budget changes, while collapsing the cell's several JSX reads
      // (prefix/dirname/branchLabel) into one fit per pass. `fitted` applies the
      // `…` truncation for the non-highlighted path; the search-highlight path
      // stays untruncated (its markup can't be sliced by char count, same
      // documented tradeoff as the prompt cell).
      const fitted = createMemo(() =>
        fittedProjectCell(
          ctx.session,
          entry.mode,
          ctx.maxProjectLen,
          ctx.maxBranchLen,
        ),
      );
      const dirnameColor = () =>
        ctx.isActiveSession && !ctx.selected
          ? dimColor(ctx, theme.text)
          : dimColor(ctx, undefined);
      return (
        // When a prompt shares this row (inline mode), the prompt is the
        // flexible filler and the project must NOT shrink below its fitted
        // width, else flex squeezes the path into a mid-word clip (the `…`
        // and gap artifacts). The prompt (flexShrink=1) absorbs the squeeze
        // instead. When the project is the filler (no prompt), keep
        // flexShrink=1 as the backstop behind `fitProjectCell`.
        <box
          flexGrow={props.promptOnRow ? 0 : 1}
          flexShrink={props.promptOnRow ? 0 : 1}
          flexDirection="row"
        >
          <Show
            when={!ctx.highlights?.project}
            fallback={
              <HighlightedText
                text={ctx.highlights?.project ?? ""}
                highlightColor={dimColor(ctx, theme.yellow)}
                baseColor={dimColor(ctx, undefined)}
              />
            }
          >
            <Show when={!compact && fitted().prefix}>
              <text fg={dimColor(ctx, theme.subtext)}>{fitted().prefix}</text>
            </Show>
            <text fg={dirnameColor()}>
              <Bold when={ctx.selected || !!ctx.isActiveSession}>
                {fitted().dirname}
              </Bold>
            </text>
          </Show>
          <Show when={ctx.session.gitBranch}>
            {(branch: () => string) => (
              <Show
                when={
                  ctx.highlights?.gitBranch &&
                  branch().length <= ctx.maxBranchLen
                }
                fallback={
                  <text fg={dimColor(ctx, theme.blue)}>
                    {fitted().branchLabel}
                  </text>
                }
              >
                <text fg={dimColor(ctx, theme.blue)}>:</text>
                <HighlightedText
                  text={ctx.highlights!.gitBranch!}
                  highlightColor={dimColor(ctx, theme.yellow)}
                  baseColor={dimColor(ctx, theme.blue)}
                />
                <Show when={ctx.session.isWorktree}>
                  <text fg={dimColor(ctx, theme.blue)}>+</text>
                </Show>
              </Show>
            )}
          </Show>
        </box>
      );
    }
    case "agent": {
      const raw = entry.mode === "short" ? ctx.agentShortLabel : ctx.agentLabel;
      return (
        <box width={width}>
          <text fg={dimColor(ctx, ctx.agentColor)}>
            {alignText(raw, width, side)}
          </text>
        </box>
      );
    }
    case "version":
      return (
        <box width={width}>
          <text fg={dimColor(ctx, theme.overlay)}>
            {alignText(ctx.versionLabel, width, side)}
          </text>
        </box>
      );
    case "pane":
      return (
        <box width={width}>
          <text
            fg={dimColor(
              ctx,
              ctx.isActivePane ? theme.rosewater : theme.subtext,
            )}
          >
            {alignText(ctx.paneInfo, width, side)}
          </text>
        </box>
      );
    case "time":
      return (
        <box width={width}>
          <text fg={dimColor(ctx, theme.overlay)}>
            {alignText(ctx.timeLabel, width, side)}
          </text>
        </box>
      );
    case "prompt": {
      // Pre-truncate in JS (the idiom used by project/branch): rendered
      // text never overflows its row, so right-aligned siblings (the `pr`
      // field) keep their spot. Search highlights render untruncated; the
      // markup can't be sliced by char count.
      const text = () =>
        ctx.session.lastPrompt
          ? truncateText(
              normalizePrompt(ctx.session.lastPrompt),
              ctx.maxPromptLen,
            )
          : "";
      // The prompt is the row's flexible filler: its box grows into the
      // gap between the identity cells and the right-aligned metadata,
      // shrinking (and letting OpenTUI clip) before it can shove a sibling
      // off-row. Pre-truncation adds the `…`; the box is the hard backstop.
      return (
        <box flexGrow={1} flexShrink={1}>
          <Show
            when={ctx.highlights?.lastPrompt}
            fallback={<text fg={dimColor(ctx, theme.overlay)}>{text()}</text>}
          >
            <HighlightedText
              text={ctx.highlights!.lastPrompt!}
              highlightColor={dimColor(ctx, theme.yellow)}
              baseColor={dimColor(ctx, theme.overlay)}
            />
          </Show>
        </box>
      );
    }
    case "cwd":
      return (
        <text fg={dimColor(ctx, theme.overlay)}>
          {shortenCwd(ctx.session.paneCwd ?? ctx.session.cwd)}
        </text>
      );
    case "branch":
      return (
        <text fg={dimColor(ctx, theme.blue)}>
          {ctx.session.gitBranch ?? ""}
        </text>
      );
    case "pr": {
      const label = () => prLabel(ctx.session, entry.mode);
      // Color by PR state (red blocked / green approved / yellow open);
      // a state-less PR (background-agent PRs) keeps the neutral mauve.
      const color = () => prStateColor(prColorState(ctx.session) ?? "none");
      // Fixed-width cell so a flexible left side (the prompt) can never
      // crush it out of the row.
      return (
        <box width={label().length} flexShrink={0}>
          <text fg={dimColor(ctx, color())}>{label()}</text>
        </box>
      );
    }
  }
};

/**
 * Width to indent row 2 left so its content aligns under row 1's project column.
 * Sums fixed widths of row 1 left entries that come before "project", plus
 * inter-entry gaps. If row 1 has no project entry, return 0 (no auto-indent).
 */
function row2LeadingIndent(row1Left: ResolvedEntry[]): number {
  const projectIdx = row1Left.findIndex((e) => e.field === "project");
  if (projectIdx <= 0) return 0;
  const preProject = row1Left.slice(0, projectIdx);
  const sumWidths = preProject.reduce((acc, e) => acc + entryRightWidth(e), 0);
  return sumWidths + (preProject.length - 1);
}

/** A row's left/right entries with the active indicator + flex spacer. */
const RowRender: Component<{
  row: ResolvedRow;
  ctx: FieldRenderContext;
  /** Render the trailing attention/subagent cell after row.left (row 1 only). */
  showAttention?: boolean;
  /** This row's own trailing-labels width (attention + subagent count). The
   * cell is sized to exactly its content, so an unlabeled row reserves 0 and
   * its prompt runs all the way to the right-side metadata. */
  attentionWidth?: number;
  /** Optional fixed-width spacer prepended after the active indicator. */
  leadingIndent?: number;
}> = (props) => {
  // A prompt on this row is the flexible filler (its cell grows into the gap),
  // so the standalone spacer would double up and split the space. Drop it, and
  // tell the project cell to give up its own flex-grow.
  const hasPrompt = createMemo(() => rowHasPrompt(props.row));
  // The project cell also flex-grows (when no prompt shares its row), so it is
  // the filler and the standalone spacer is redundant. Rendering both splits
  // the slack and squeezes the project cell by ~1 column, which drops its `…`.
  // Only add the spacer when the row has no flexible filler of its own.
  const hasFlexFiller = createMemo(
    () =>
      hasPrompt() ||
      props.row.left.some((e) => e.field === "project") ||
      props.row.right.some((e) => e.field === "project"),
  );
  return (
    <box flexDirection="row" gap={1} width="100%" height={1}>
      <Show when={(props.leadingIndent ?? 0) > 0}>
        <box width={props.leadingIndent} />
      </Show>
      <For each={props.row.left}>
        {(entry) => (
          <FieldCell
            entry={entry}
            ctx={props.ctx}
            side="left"
            promptOnRow={hasPrompt()}
          />
        )}
      </For>
      <Show when={!hasFlexFiller()}>
        <box flexGrow={1} flexShrink={1} />
      </Show>
      {/* Per-row trailing-labels cell, sized to exactly its own content
          (`attentionWidth`), so an unlabeled row reserves nothing and its
          prompt extends into this space. `width` + `flexShrink={0}` keep the
          rendered width identical to the value the prompt/project budgets
          subtract, so the truncation `…` lands right before the label. */}
      <Show when={props.showAttention && (props.attentionWidth ?? 0) > 0}>
        <box
          width={props.attentionWidth}
          flexShrink={0}
          flexDirection="row"
          gap={1}
        >
          <Show when={props.ctx.attentionLabel}>
            {(label: () => string) => (
              <text fg={props.ctx.attentionColor}>
                {props.ctx.sidebar
                  ? "!"
                  : truncateText(label(), ATTENTION_LABEL_MAX)}
              </text>
            )}
          </Show>
          <Show
            when={!props.ctx.sidebar && subagentCountLabel(props.ctx.session)}
          >
            {(label: () => string) => (
              <text fg={props.ctx.dimmed ? theme.border : theme.teal}>
                {label()}
              </text>
            )}
          </Show>
        </box>
      </Show>
      <For each={props.row.right}>
        {(entry) => (
          <FieldCell
            entry={entry}
            ctx={props.ctx}
            side="right"
            promptOnRow={hasPrompt()}
          />
        )}
      </For>
    </box>
  );
};

export const SessionItem: Component<SessionItemProps> = (props) => {
  const { tick } = useTick();
  const dims = useTerminalDimensions();
  const effectiveWidth = () =>
    props.showPreview
      ? Math.floor((dims().width * (100 - props.previewWidth)) / 100)
      : dims().width;

  // The layout normally arrives pre-resolved from SessionList; the
  // fallback covers direct mounts (tests) and matches what SessionList
  // would have computed.
  const columns = createMemo(() => {
    if (props.layout) return props.layout;
    const resolved = resolveLayout(
      !!props.sidebar,
      effectiveWidth(),
      props.columns,
      props.breakpoints,
    );
    return applyPromptDisplay(
      resolved,
      props.promptDisplay ?? DEFAULT_PROMPT_DISPLAY,
      !!props.sidebar,
    );
  });

  const maxBranchLen = () => {
    const w = effectiveWidth();
    if (w < 60) return 8;
    if (w < 70) return 12;
    if (w < 90) return 24;
    if (w < 120) return 36;
    if (w < 150) return 48;
    return 60;
  };

  // This row's own trailing-labels cell width. Per-row (not a list-wide max),
  // so an unlabeled row reserves nothing and its prompt runs to the right-side
  // metadata; a labeled row's prompt/project budgets subtract exactly this so
  // the truncation `…` lands right before the label.
  const attentionWidth = createMemo(() =>
    trailingLabelsWidth(props.session, !!props.sidebar),
  );

  // The project cell renders inside SessionList's scrollbox, whose scrollbar
  // (and content inset) consume a couple of columns the terminal width does
  // not reflect. Without reserving them, `fitProjectCell` fills right up to a
  // box that is a hair narrower than budgeted and OpenTUI hard-clips the
  // trailing char, dropping the very `…` we added. A direct mount (tests, no
  // scrollbox) still needs a 1-char cushion so content never exactly equals
  // its box (OpenTUI clips on an exact fit too). `props.layout` is supplied
  // only by SessionList, so it distinguishes the two contexts.
  const scrollbarReserve = () => (props.layout ? 3 : 1);

  // Prompt-floor budgeting shorthand: how many chars an inline prompt is
  // guaranteed on row 1 before the project cell starts yielding width. The
  // prompt truncates down to this floor first; only then does the path give
  // up space. Bounded by data length so a short prompt reserves less.
  const PROMPT_MIN = 16;

  // Budget for the project cell's `…` truncation. Full width minus the item
  // padding, every row-1 sibling except project (and the prompt, budgeted via
  // its floor below), the reserved attention cell, and a small margin. Reads
  // only the raw prompt length (capped at PROMPT_MIN), never maxPromptLen, so
  // maxPromptLen can depend on the fitted project width without a cycle.
  const maxProjectLen = createMemo(() => {
    const cols = columns();
    const promptOnRow1 = rowHasPrompt(cols.row1);
    const siblings = [...cols.row1.left, ...cols.row1.right].filter(
      (e) => e.field !== "project" && e.field !== "prompt",
    );
    const cells = siblings.reduce((acc, e) => {
      const w =
        e.field === "pr"
          ? prLabel(props.session, e.mode).length
          : entryRightWidth(e);
      return acc + (w > 0 ? w + 1 : 0); // +1 for the inter-cell gap
    }, 0);
    const attn = attentionWidth();
    const promptFloor =
      promptOnRow1 && hasFieldData(props.session, "prompt")
        ? Math.min(
            normalizePrompt(props.session.lastPrompt ?? "").length,
            PROMPT_MIN,
          ) + 1
        : 0;
    const reserved =
      2 + // item paddingLeft/paddingRight
      cells +
      (attn > 0 ? attn + 1 : 0) +
      promptFloor +
      2 + // small margin so the truncated content sits inside its flex box
      scrollbarReserve(); // scrollbox eats width the terminal size hides
    return Math.max(12, effectiveWidth() - reserved);
  });

  // Budget for the prompt cell: full width minus the item's horizontal
  // padding, the leading indent, every sibling cell on the prompt's row, and
  // the inter-cell gaps. The prompt rides row 1 when inline (sharing it with
  // project, and with the reserved attention cell) and row 2 otherwise; budget
  // against whichever row it landed on so the `…` truncation lands just before
  // the right-aligned metadata. Conservative floor so tiny viewports still
  // show something identifiable.
  const maxPromptLen = createMemo(() => {
    const cols = columns();
    const onRow1 = rowHasPrompt(cols.row1);
    const row = onRow1 ? cols.row1 : cols.row2;
    const siblings = [...row.left, ...row.right].filter(
      (e) => e.field !== "prompt",
    );
    const cells = siblings.reduce((acc, e) => {
      const w =
        e.field === "pr"
          ? prLabel(props.session, e.mode).length
          : e.field === "project"
            ? projectCellWidth(
                props.session,
                e.mode,
                maxProjectLen(),
                maxBranchLen(),
              )
            : entryRightWidth(e);
      return acc + (w > 0 ? w + 1 : 0); // +1 for the inter-cell gap
    }, 0);
    // The reserved attention cell only exists on row 1, so it eats into the
    // prompt budget only when the prompt shares that row (inline mode).
    const attn = onRow1 ? attentionWidth() : 0;
    const reserved =
      2 + // item paddingLeft/paddingRight
      (onRow1 ? 0 : row2LeadingIndent(cols.row1.left)) +
      cells +
      (attn > 0 ? attn + 1 : 0) +
      2; // small margin so the `…` lands inside the flexed box, not clipped
    return Math.max(16, effectiveWidth() - reserved);
  });

  const agentColor = () => agentColorFor(props.session.agentType);

  const bgColor = () =>
    props.selected && !props.dimmed ? theme.surface : undefined;

  // Isolated so the 1s tick re-runs ONE memo per row; with the default
  // string equality, cells re-render only when the label text flips
  // (e.g. "3m" -> "4m"), not on every tick.
  const timeLabel = createMemo((): string => {
    void tick();
    return props.session.lastUserInputAt
      ? formatRelativeTime(new Date(props.session.lastUserInputAt))
      : props.session.lastActivityAt
        ? formatRelativeTime(new Date(props.session.lastActivityAt))
        : "-";
  });

  // One stable object whose getters read live sources. FieldCell captures
  // `ctx` once at mount (it destructures props), so every field must stay
  // readable-live through this object: a JSX expression reading a getter
  // subscribes to exactly the underlying signals, and rows mounted across
  // SSE deltas keep rendering fresh data without a remount.
  const ctx: FieldRenderContext = {
    get session() {
      return props.session;
    },
    get index() {
      return props.index;
    },
    get iconStyle() {
      return props.iconStyle;
    },
    get highlights() {
      return props.highlights;
    },
    get isActivePane() {
      return props.isActivePane;
    },
    get isActiveSession() {
      return props.isActiveSession;
    },
    get selected() {
      return (
        props.selected ||
        (props.session.status === "idle" &&
          props.session.attentionState !== null)
      );
    },
    get dimmed() {
      return props.dimmed;
    },
    get sidebar() {
      return props.sidebar;
    },
    get agentColor() {
      return agentColor();
    },
    get attentionColor() {
      return props.dimmed ? theme.border : getAttentionColor(props.session);
    },
    get attentionLabel() {
      return getAttentionLabel(props.session);
    },
    get paneInfo() {
      return props.session.tmuxTarget
        ? abbreviateTarget(props.session.tmuxTarget, 12)
        : "";
    },
    get versionLabel() {
      return props.session.version ? formatVersion(props.session.version) : "-";
    },
    get agentLabel() {
      return getAgentDisplayName(props.session.agentType);
    },
    get agentShortLabel() {
      return getAgentShortCode(props.session.agentType);
    },
    get timeLabel() {
      return timeLabel();
    },
    get maxBranchLen() {
      return maxBranchLen();
    },
    get maxPromptLen() {
      return maxPromptLen();
    },
    get maxProjectLen() {
      return maxProjectLen();
    },
  };

  const row2HasContent = createMemo(() =>
    rowHasContent(props.session, columns().row2),
  );

  /** Filter out entries whose field has no data — keeps row 2 from rendering blanks. */
  const filterRow = (row: ResolvedRow): ResolvedRow => ({
    left: row.left.filter((e) => visibleField(props.session, e.field)),
    right: row.right.filter((e) => visibleField(props.session, e.field)),
  });

  const row1 = createMemo(() => columns().row1);
  const row2 = createMemo(() => filterRow(columns().row2));

  return (
    <box width="100%" height={row2HasContent() ? 2 : 1} flexDirection="column">
      <Show when={props.isActiveSession}>
        <box
          position="absolute"
          left={0}
          top={0}
          width={1}
          height={row2HasContent() ? 2 : 1}
        >
          <text fg={agentColor()}>▎</text>
          <Show when={row2HasContent()}>
            <text fg={agentColor()}>▎</text>
          </Show>
        </box>
      </Show>
      <box
        width="100%"
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={bgColor()}
        onMouseDown={(event) => {
          if (event.button === MouseButton.LEFT) {
            props.onActivate?.();
          } else if (event.button === MouseButton.RIGHT) {
            props.onContextMenu?.(event);
          }
        }}
      >
        <RowRender
          row={row1()}
          ctx={ctx}
          showAttention
          attentionWidth={attentionWidth()}
        />
        <Show when={row2HasContent()}>
          <RowRender
            row={row2()}
            ctx={ctx}
            leadingIndent={row2LeadingIndent(row1().left)}
          />
        </Show>
      </box>
    </box>
  );
};

/**
 * Whether a field should be rendered when it has no data.
 * Row-1 fields like `status` always render (they have a state to display);
 * pure-text fields like `prompt` would render an empty cell, so we hide them.
 */
function visibleField(session: EnrichedSession, field: ColumnField): boolean {
  switch (field) {
    case "prompt":
    case "cwd":
    case "branch":
    case "pr":
      return hasFieldData(session, field);
    default:
      return true;
  }
}
