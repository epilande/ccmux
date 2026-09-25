import type { RepoFactsResponse } from "../../daemon/repo-facts";
import { branchPRs, factsText } from "../utils/repo-facts";
import type { Component } from "solid-js";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import type { EnrichedSession, TmuxSocketError } from "../../types";
import type { IconStyle } from "../../lib/icons";
import type {
  ColumnsConfig,
  BreakpointConfig,
  PromptDisplay,
} from "../../lib/preferences";
import {
  DEFAULT_BREAKPOINTS,
  DEFAULT_PROMPT_DISPLAY,
} from "../../lib/preferences";
import {
  type FlatItem,
  NEEDS_YOU_GROUP_KEY,
  getSessionIndex,
  scrollTarget,
  toVisualLine,
} from "../utils/grouping";
import { SessionItem } from "./SessionItem";
import { GroupHeader } from "./GroupHeader";
import type { HeaderCells, ResolvedColumns } from "./session-columns";
import {
  resolveLayout,
  applyPromptDisplay,
  columnHeaderCells,
  hasHeaderLabels,
  rowHasContent,
  normalizePrompt,
  promptBlockWidth,
  withoutPrompt,
  withoutFlexText,
  EMPTY_PROMPT_BLOCK,
  PROMPT_BLOCK_MIN_WIDTH,
} from "./session-columns";
import { createPromptBlockCache } from "./prompt-block-cache";
import { theme } from "../theme";
import { socketErrorMessage } from "../../lib/tmux-socket";
import { padStartWidth } from "../utils/format";

interface SessionListProps {
  items: FlatItem[];
  repoFacts?: RepoFactsResponse;
  marks?: Set<string>;
  selectedIndex: number;
  iconStyle?: IconStyle;
  showPreview?: boolean;
  previewWidth: number;
  activePaneId?: string | null;
  activeSessionId?: string | null;
  columns?: ColumnsConfig;
  breakpoints?: BreakpointConfig;
  dimmed?: boolean;
  ageFadeAfter?: number;
  sidebar?: boolean;
  /**
   * Draw the column-header line above the rows. The list still withholds it
   * below the `md` breakpoint, where the cells it would label are gone, and
   * when the resolved layout leaves nothing to label.
   */
  columnHeader?: boolean;
  /** Prompt display mode (cycled by the `p` key): inline, own row, or off. */
  promptDisplay?: PromptDisplay;
  /** Height of the wrapped prompt block, in lines. 0 (the default) is off. */
  promptLines?: number;
  /**
   * Whether a search query is currently narrowing the list.
   *
   * The block yields to the one-line `prompt` cell while it is: that cell is
   * the only place a row draws its match highlights, the older-prompt match
   * line, the transcript snippet and the `[pane]`/`[transcript]`/`[cwd]`
   * source tag, and a result with no visible reason for matching is worse
   * than a prompt with less room.
   */
  searchActive?: boolean;
  loading?: boolean;
  /** Set when the daemon cannot reach its tmux server; replaces the empty
   *  state, which would otherwise read as "no agents are running". */
  socketError?: TmuxSocketError | null;
  onActivate?: (item: FlatItem, index: number) => void;
  onContextMenu?: (item: FlatItem, index: number, event: MouseEvent) => void;
  /**
   * Hands the parent a way to ASK where a row currently sits on screen, for
   * the keyboard path that opens a row menu without a pointer to anchor on.
   *
   * A pull rather than a push: the answer changes with every scroll, resize
   * and row that grows a subtitle, and a pushed one would either be stale by
   * the time a key was pressed or cost a callback per frame to keep fresh.
   * This is the only place the geometry is known — the row heights, the
   * scroll offset and the viewport's own position all live here.
   */
  onRowAnchor?: (resolve: RowAnchor) => void;
}

/** Where a flat-item row is on screen right now, or null when it is not
 *  drawn (no list, or an index outside it). */
export type RowAnchor = (index: number) => { x: number; y: number } | null;

/**
 * Whether a row represents the active tmux pane. Guards `tmuxPane !== null`
 * so a paneless synthetic invoke row (tmuxPane null) never equals a null
 * `activePaneId` and gets falsely highlighted as the active pane.
 */
export function isActivePaneRow(
  session: { tmuxPane: string | null },
  activePaneId: string | null | undefined,
): boolean {
  return session.tmuxPane !== null && session.tmuxPane === activePaneId;
}

/** Columns a keyboard-opened row menu is inset from the list's left edge, so
 *  the row it belongs to is still identifiable underneath it. */
const ROW_MENU_INDENT = 2;

export const SessionList: Component<SessionListProps> = (props) => {
  let scrollboxRef: ScrollBoxRenderable | undefined;
  const promptBlockCache = createPromptBlockCache(normalizePrompt);
  const [scrollboxLayout, setScrollboxLayout] = createSignal(0);
  // Columns the scrollbox's viewport is narrower than the list: the
  // scrollbar and content inset the rows are laid out inside. The header
  // line renders OUTSIDE the scrollbox and pads by this much on the right so
  // its cells end on the same column the rows' do.
  const [viewportInset, setViewportInset] = createSignal(0);
  const dims = useSharedTerminalDimensions();
  const effectiveWidth = () =>
    props.showPreview
      ? Math.floor((dims().width * (100 - props.previewWidth)) / 100)
      : dims().width;

  /**
   * Whether rows draw the wrapped block at all, decided ONCE for the list.
   *
   * The same answer has to reach two places (the block itself, and the
   * `prompt` cell the block replaces) and they must never disagree, or a
   * width where the block yields would show no prompt at all. So the three
   * ways it yields (turned off, a search is running, a rail too narrow for a
   * readable wrap) live here rather than at either use site.
   */
  const blockActive = () =>
    (props.promptLines ?? 0) > 0 &&
    // `promptDisplay: "off"` means no prompt anywhere, and the `p` key cycles
    // it live — so it hides the block too rather than leaving one prompt
    // surface the toggle cannot reach.
    props.promptDisplay !== "off" &&
    !props.searchActive &&
    promptBlockWidth(effectiveWidth()) >= PROMPT_BLOCK_MIN_WIDTH;

  // Resolved once here for every row (the layout is identical across
  // rows at a given width/config) and passed down to each SessionItem.
  // The scroll-target math below reads the same object, so row heights
  // and scroll positions can't disagree.
  const layout = createMemo(() => {
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

  function enriched(item: Extract<FlatItem, { type: "session" }>) {
    const session = item.filteredSession.session;
    if (!props.repoFacts) return session;
    return {
      ...session,
      branchPRs: props.repoFacts.headerPR
        ? branchPRs(session, props.repoFacts.repos)
        : [],
    };
  }

  /**
   * The layout for a row whose block is drawn and whose agent DID write a
   * summary: the block renders the same text a `prompt` cell would, so that
   * cell goes, while `summary` keeps its place on the identity line.
   */
  const withBlock = createMemo(() => withoutPrompt(layout()));

  /**
   * The layout for a row whose block is drawn and whose agent wrote NO
   * summary: its `summary` cell could only fall back to the prompt, which is
   * exactly what the block below is already printing, so the row lays out
   * with no flexible text cell at all.
   */
  const withBlockNoSummary = createMemo(() => withoutFlexText(layout()));

  /**
   * The layout THIS row is measured and drawn by.
   *
   * Per row rather than per list because the block's yield rule is a property
   * of the session: two rows in one list can disagree about whether their
   * flexible cell would merely repeat the block. Both the height math below
   * and the `layout` prop read this same call, so a row can never be measured
   * by one shape and drawn by another.
   */
  const rowLayout = (session: EnrichedSession): ResolvedColumns => {
    if (!blockActive()) return layout();
    // `== null`, not `=== null`: a picker on this build can be talking to a
    // daemon that predates the field (the machine-wide daemon runs whatever
    // was linked until it auto-restarts), and `undefined` there means "no
    // summary", not "a summary I must make room for". Every other read of
    // the field is loose or truthy for the same reason.
    return session.summary == null ? withBlockNoSummary() : withBlock();
  };

  /**
   * The wrapped prompt block, resolved HERE rather than in the row, for the
   * same reason `layout` is: the scroll math below and the renderer must
   * agree on the row's height, and the only way they cannot disagree is to
   * derive both from one array. The row draws exactly these lines; the row
   * is exactly this many lines tall.
   *
   * Memoized per session (see `prompt-block-cache.ts`): the measurement pass
   * asks for every preceding row's block on every call, and an unchanged
   * session must hand back the same array so the row's `<For>` stays still.
   */
  const promptBlock = (session: EnrichedSession): string[] => {
    if (!blockActive()) return EMPTY_PROMPT_BLOCK;
    // Raw, not normalized: the cache normalizes on a miss, so the two regex
    // passes do not run on every one of the measurement pass's reads.
    return promptBlockCache.lines(
      session.id,
      session.lastPrompt ?? "",
      promptBlockWidth(effectiveWidth()),
      props.promptLines ?? 0,
    );
  };

  // The cache only ever grows by session id, so retire the ids that left.
  createEffect(() => {
    promptBlockCache.retain(
      props.items.flatMap((item) =>
        item.type === "session" ? [item.filteredSession.session.id] : [],
      ),
    );
  });

  const sessionLines = (
    session: EnrichedSession,
    item: Extract<FlatItem, { type: "session" }>,
  ) =>
    1 +
    (rowHasContent(session, rowLayout(session).row2) ? 1 : 0) +
    promptBlock(session).length +
    (props.sidebar &&
    item.groupKey === NEEDS_YOU_GROUP_KEY &&
    session.tmuxTarget
      ? 1
      : 0);

  createEffect(() => {
    // Re-run once the scrollbox gets real dimensions (and on later resizes).
    // The scrollbox mounts in the same update that delivers the first
    // sessions, so this effect's initial run can land before yoga has
    // measured it: scrollTo clamps against a zero-size viewport/content and
    // the initial scroll-into-view is silently lost.
    void scrollboxLayout();
    const index = props.selectedIndex;
    if (!scrollboxRef || index < 0) return;

    const viewportHeight = scrollboxRef.viewport?.height ?? 0;
    const target = scrollTarget(
      props.items,
      index,
      scrollboxRef.scrollTop,
      viewportHeight,
      sessionLines,
    );
    if (target !== null) {
      scrollboxRef.scrollTo(target);
    }
  });

  /**
   * The screen position of row `index`, for a menu opened from the keyboard.
   *
   * The same visual-line arithmetic the scroll effect above runs, less the
   * scroll offset and plus the viewport's own origin — so the answer is in
   * the absolute screen coordinates a mouse event would have carried, which
   * is what `ContextMenu` clamps against.
   */
  const rowAnchor: RowAnchor = (index) => {
    const scrollbox = scrollboxRef;
    if (!scrollbox || index < 0 || index >= props.items.length) return null;
    const line =
      toVisualLine(props.items, index, sessionLines) - scrollbox.scrollTop;
    return {
      // Indented off the list's left edge: the menu covers the row it belongs
      // to either way, and leaving the selection marker and status glyph
      // visible is what says WHICH row it came from.
      x: scrollbox.viewport.x + ROW_MENU_INDENT,
      y: scrollbox.viewport.y + line,
    };
  };

  const headerFacts = (item: Extract<FlatItem, { type: "header" }>) => {
    const root = item.repoRoot;
    if (
      !root ||
      !item.members.every(
        (m) => (m.session.mainRepoRoot ?? m.session.worktreeRoot) === root,
      )
    )
      return undefined;
    return props.repoFacts?.repos.find((r) => r.repoRoot === root);
  };
  const renderItem = (item: FlatItem, index: number) => {
    const onActivate = props.onActivate
      ? () => props.onActivate!(item, index)
      : undefined;
    const onContextMenu = props.onContextMenu
      ? (event: MouseEvent) => props.onContextMenu!(item, index, event)
      : undefined;

    if (item.type === "header") {
      return (
        <>
          <GroupHeader
            label={item.label}
            count={item.count}
            // The viewport's real width, so the header's rule ends on the
            // column the rows' last cell does, scrollbar or not.
            width={effectiveWidth() - viewportInset()}
            facts={factsText(headerFacts(item))}
            collapsed={item.collapsed}
            selected={index === props.selectedIndex}
            members={item.members}
            iconStyle={props.iconStyle}
            dimmed={props.dimmed}
            onActivate={onActivate}
            onContextMenu={onContextMenu}
          />
        </>
      );
    }
    return (
      <SessionItem
        session={enriched(item)}
        marked={props.marks?.has(item.filteredSession.session.id)}
        selected={index === props.selectedIndex}
        index={getSessionIndex(props.items, index)}
        highlights={item.filteredSession.highlights}
        transcriptSnippet={
          item.filteredSession.transcriptMatch
            ? item.filteredSession.transcriptSnippet
            : undefined
        }
        matchSource={item.filteredSession.primarySource}
        iconStyle={props.iconStyle}
        showPreview={props.showPreview}
        previewWidth={props.previewWidth}
        isActivePane={isActivePaneRow(
          item.filteredSession.session,
          props.activePaneId,
        )}
        isActiveSession={
          item.filteredSession.session.id === props.activeSessionId
        }
        layout={rowLayout(item.filteredSession.session)}
        promptBlock={promptBlock(item.filteredSession.session)}
        dimmed={props.dimmed}
        sidebar={props.sidebar}
        needsYou={item.groupKey === NEEDS_YOU_GROUP_KEY}
        sharedTmuxSession={item.sharedTmuxSession}
        ageFadeAfter={props.ageFadeAfter}
        onActivate={onActivate}
        onContextMenu={onContextMenu}
      />
    );
  };

  // The head is the quietest line on screen on purpose: the strip above it
  // owns weight and accent, rows own semantic color, and the head is told
  // apart by being dimmer than both (the overlay color, lowercase). Caps,
  // bold, underline and a rule beneath were all tried; each either fought
  // the strip for its cue or cost a row.
  const headerFg = () => (props.dimmed ? theme.border : theme.overlay);

  /**
   * Header cells for THIS layout, or null when no line should draw. Read off
   * the same `layout()` the rows use (post prompt-mode), so an inline
   * collapse that moves `pr` next to the project moves the labels with it.
   * While the wrapped prompt block is on, rows drop the `prompt` cell
   * (`withBlock`). The header follows that summary-row layout. A row with
   * no summary also drops the flex cell, so its right edge can sit left of
   * the labels; that case is the exception, not a second header.
   */
  const headerCells = createMemo(() => {
    if (!props.columnHeader || props.sidebar) return null;
    const md = props.breakpoints?.md ?? DEFAULT_BREAKPOINTS.md;
    if (effectiveWidth() < md) return null;
    const row1 = blockActive() ? withBlock().row1 : layout().row1;
    const cells = columnHeaderCells(row1);
    return hasHeaderLabels(cells) ? cells : null;
  });

  return (
    <box
      flexDirection="column"
      width={props.showPreview ? `${100 - props.previewWidth}%` : "100%"}
      flexShrink={1}
    >
      <Show when={props.items.length > 0 && headerCells()}>
        {(cells: () => HeaderCells) => (
          // Same geometry as a row: the item's 1-column padding either side
          // (the left one is where the active `▎` draws), cells one gap
          // apart, right-side labels right-aligned in their fixed boxes.
          <box
            flexDirection="row"
            gap={1}
            width="100%"
            height={1}
            paddingLeft={1}
            paddingRight={1 + viewportInset()}
          >
            <For each={cells().left}>
              {(cell) =>
                cell.width > 0 ? (
                  <box width={cell.width} flexShrink={0}>
                    <text fg={headerFg()}>{cell.text}</text>
                  </box>
                ) : (
                  <box flexGrow={1} flexShrink={1}>
                    <text fg={headerFg()}>{cell.text}</text>
                  </box>
                )
              }
            </For>
            <Show when={!cells().left.some((c) => c.width === 0)}>
              <box flexGrow={1} flexShrink={1} />
            </Show>
            <For each={cells().right}>
              {(cell) => (
                <box width={cell.width} flexShrink={0}>
                  <text fg={headerFg()}>
                    {padStartWidth(cell.text, cell.width)}
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={
          <Show when={!props.loading}>
            <box paddingLeft={1} paddingTop={1}>
              <Show
                when={props.socketError}
                fallback={<text fg={theme.overlay}>No sessions found</text>}
              >
                {(error: () => TmuxSocketError) => (
                  <text fg={theme.red}>
                    {socketErrorMessage(error().attemptedSocket)}
                  </text>
                )}
              </Show>
            </box>
          </Show>
        }
      >
        <scrollbox
          ref={(r: ScrollBoxRenderable) => {
            scrollboxRef = r;
            // Handed up here rather than on mount: with no rows there is no
            // scrollbox at all (see the fallback above), and a resolver
            // published before it existed would answer null for the list's
            // whole life.
            props.onRowAnchor?.(rowAnchor);
            // The root's resize fires before its children are measured, so
            // listen on the two nodes whose sizes the scroll effect reads.
            const bump = () => {
              setScrollboxLayout((v) => v + 1);
              setViewportInset(Math.max(0, r.width - r.viewport.width));
            };
            r.viewport.on("resize", bump);
            r.content.on("resize", bump);
          }}
          flexGrow={1}
        >
          <For each={props.items}>
            {(item, index) => renderItem(item, index())}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
};
