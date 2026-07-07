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
} from "./session-columns";
import { theme } from "../theme";
import {
  formatRelativeTime,
  formatVersion,
  shortenCwd,
  truncateText,
  truncateHighlighted,
} from "../utils/format";

export interface SessionItemHighlights {
  project?: string | null;
  cwd?: string | null;
  gitBranch?: string | null;
  lastPrompt?: string | null;
  prompts?: string | null;
}

interface SessionItemProps {
  session: EnrichedSession;
  selected: boolean;
  index: number;
  highlights?: SessionItemHighlights | null;
  /** Live transcript-search snippet, shown dim in the prompt cell to explain
   * why the row matched when no prompt highlight applies. */
  transcriptSnippet?: string;
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
 * Rendered char width of the `project` cell, used to budget an inline prompt
 * that shares row 1 with it. Mirrors the project FieldCell: dirname (plus the
 * path prefix in `full` mode) and the `:branch` suffix (branch truncated to
 * `maxBranchLen`, `+` appended for worktrees).
 */
function projectCellWidth(
  session: EnrichedSession,
  mode: string | undefined,
  maxBranchLen: number,
): number {
  const { prefix, dirname } = formatProjectPath(
    session.paneCwd ?? session.cwd,
    2,
  );
  let width = dirname.length;
  if (mode === "full") width += prefix.length;
  if (session.gitBranch) {
    const shown = Math.min(session.gitBranch.length, maxBranchLen);
    width += 1 + shown + (session.isWorktree ? 1 : 0);
  }
  return width;
}

const Bold: Component<{ when: boolean; children: string }> = (p) => (
  <Show when={p.when} fallback={<>{p.children}</>}>
    <b>{p.children}</b>
  </Show>
);

function getAttentionLabel(session: EnrichedSession): string | null {
  if (session.pendingTool) return session.pendingTool;
  if (session.inPlanMode || session.attentionType === "plan_approval") {
    return "Plan";
  }
  if (session.status !== "waiting") return null;
  if (session.attentionType === "permission") return "Permission";
  if (session.attentionType === "question") return "Question";
  return null;
}

function getAttentionColor(session: EnrichedSession): string {
  if (session.pendingTool) return theme.yellow;
  if (session.inPlanMode || session.attentionType === "plan_approval") {
    return theme.teal;
  }
  return theme.mauve;
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
  transcriptSnippet?: string;
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
      // Functions, not consts: this component body runs once per mount,
      // and rows stay mounted across SSE deltas — a const here would
      // freeze the cell on its mount-time value.
      const path = () =>
        formatProjectPath(ctx.session.paneCwd ?? ctx.session.cwd, 2);
      const dirnameColor = () =>
        ctx.isActiveSession && !ctx.selected
          ? dimColor(ctx, theme.text)
          : dimColor(ctx, undefined);
      return (
        <box
          flexGrow={props.promptOnRow ? 0 : 1}
          flexShrink={1}
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
            <Show when={!compact}>
              <text fg={dimColor(ctx, theme.subtext)}>{path().prefix}</text>
            </Show>
            <text fg={dirnameColor()}>
              <Bold when={ctx.selected || !!ctx.isActiveSession}>
                {path().dirname}
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
                    :
                    {branch().length > ctx.maxBranchLen
                      ? branch().slice(0, ctx.maxBranchLen - 1) + "~"
                      : branch()}
                    {ctx.session.isWorktree ? "+" : ""}
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
      // A matched OLDER prompt: when the newest prompt (`lastPrompt`) didn't
      // itself match, surface the older one that did so the row shows why it
      // matched. `highlights.prompts` is a single highlighted prompt line.
      const promptMatchLine = (): string | null => {
        if (ctx.highlights?.lastPrompt || !ctx.highlights?.prompts) return null;
        return ctx.highlights.prompts;
      };
      // A transcript-only match (no prompt highlight to show): surface the
      // matched snippet so the user sees why the row matched. Truncated to the
      // same budget as a normal prompt.
      const transcriptLine = (): string | null => {
        if (ctx.highlights?.lastPrompt || promptMatchLine()) return null;
        if (!ctx.transcriptSnippet) return null;
        return truncateText(
          normalizePrompt(ctx.transcriptSnippet),
          ctx.maxPromptLen,
        );
      };
      // The prompt is the row's flexible filler: its box grows into the
      // gap between the identity cells and the right-aligned metadata,
      // shrinking (and letting OpenTUI clip) before it can shove a sibling
      // off-row. Pre-truncation adds the `…`; the box is the hard backstop.
      // `flexDirection="row"` so HighlightedText's sibling <text> segments lay
      // out left-to-right instead of stacking/overlapping (matches the project
      // cell); without it a multi-span highlight renders as garbled overlap.
      return (
        <box flexGrow={1} flexShrink={1} flexDirection="row">
          <Show
            when={ctx.highlights?.lastPrompt}
            fallback={
              <Show
                when={promptMatchLine()}
                fallback={
                  <Show
                    when={transcriptLine()}
                    fallback={
                      <text fg={dimColor(ctx, theme.overlay)}>{text()}</text>
                    }
                  >
                    <text fg={dimColor(ctx, theme.overlay)}>
                      {transcriptLine()}
                    </text>
                  </Show>
                }
              >
                <HighlightedText
                  text={truncateHighlighted(
                    promptMatchLine()!,
                    ctx.maxPromptLen,
                  )}
                  highlightColor={dimColor(ctx, theme.yellow)}
                  baseColor={dimColor(ctx, theme.overlay)}
                />
              </Show>
            }
          >
            <HighlightedText
              text={truncateHighlighted(
                ctx.highlights!.lastPrompt!,
                ctx.maxPromptLen,
              )}
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
  /** Render attention indicator + subagent count after row.left (row 1 only). */
  showAttention?: boolean;
  /** Optional fixed-width spacer prepended after the active indicator. */
  leadingIndent?: number;
}> = (props) => {
  // A prompt on this row is the flexible filler (its cell grows into the gap),
  // so the standalone spacer would double up and split the space. Drop it, and
  // tell the project cell to give up its own flex-grow.
  const hasPrompt = createMemo(() => rowHasPrompt(props.row));
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
      <Show when={!hasPrompt()}>
        <box flexGrow={1} flexShrink={1} />
      </Show>
      <Show when={props.showAttention && props.ctx.attentionLabel}>
        <text fg={props.ctx.attentionColor}>
          {props.ctx.sidebar ? "!" : props.ctx.attentionLabel}
        </text>
      </Show>
      <Show
        when={
          props.showAttention &&
          !props.ctx.sidebar &&
          !props.ctx.session.pendingTool &&
          !props.ctx.session.inPlanMode &&
          props.ctx.session.subagents &&
          props.ctx.session.subagents.length > 0
        }
      >
        <text fg={props.ctx.dimmed ? theme.border : theme.teal}>
          {props.ctx.session.subagents.length} Agent
        </text>
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

  // Budget for the prompt cell: full width minus the item's horizontal
  // padding, the leading indent, every sibling cell on the prompt's row, and
  // the inter-cell gaps. The prompt rides row 1 when inline (sharing it with
  // project) and row 2 otherwise; budget against whichever row it landed on
  // so the `…` truncation lands just before the right-aligned metadata.
  // Conservative floor so tiny viewports still show something identifiable.
  const maxPromptLen = () => {
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
            ? projectCellWidth(props.session, e.mode, maxBranchLen())
            : entryRightWidth(e);
      return acc + (w > 0 ? w + 1 : 0); // +1 for the inter-cell gap
    }, 0);
    const reserved =
      2 + // item paddingLeft/paddingRight
      (onRow1 ? 0 : row2LeadingIndent(cols.row1.left)) +
      cells +
      2; // small margin so the `…` lands inside the flexed box, not clipped
    return Math.max(16, effectiveWidth() - reserved);
  };

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
    get transcriptSnippet() {
      return props.transcriptSnippet;
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
        <RowRender row={row1()} ctx={ctx} showAttention />
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
