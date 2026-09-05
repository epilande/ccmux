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
import { DEFAULT_PROMPT_DISPLAY } from "../../lib/preferences";
import {
  type FlatItem,
  getSessionIndex,
  scrollTarget,
  toVisualLine,
} from "../utils/grouping";
import { SessionItem } from "./SessionItem";
import { GroupHeader } from "./GroupHeader";
import {
  resolveLayout,
  applyPromptDisplay,
  rowHasContent,
  normalizePrompt,
  promptBlockWidth,
  withoutPrompt,
} from "./session-columns";
import { createPromptBlockCache } from "./prompt-block-cache";
import { theme } from "../theme";
import { socketErrorMessage } from "../../lib/tmux-socket";

interface SessionListProps {
  items: FlatItem[];
  selectedIndex: number;
  iconStyle?: IconStyle;
  showPreview?: boolean;
  previewWidth: number;
  activePaneId?: string | null;
  activeSessionId?: string | null;
  columns?: ColumnsConfig;
  breakpoints?: BreakpointConfig;
  dimmed?: boolean;
  sidebar?: boolean;
  /** Prompt display mode (cycled by the `p` key): inline, own row, or off. */
  promptDisplay?: PromptDisplay;
  /** Height of the wrapped prompt block, in lines. 0 (the default) is off. */
  promptLines?: number;
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

/** One shared array for every session that has no block, so a row whose
 *  block is off never re-keys on an identity-only change. */
const EMPTY_PROMPT_BLOCK: string[] = [];

export const SessionList: Component<SessionListProps> = (props) => {
  let scrollboxRef: ScrollBoxRenderable | undefined;
  const promptBlockCache = createPromptBlockCache();
  const [scrollboxLayout, setScrollboxLayout] = createSignal(0);
  const dims = useSharedTerminalDimensions();
  const effectiveWidth = () =>
    props.showPreview
      ? Math.floor((dims().width * (100 - props.previewWidth)) / 100)
      : dims().width;

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
    const cols = applyPromptDisplay(
      resolved,
      props.promptDisplay ?? DEFAULT_PROMPT_DISPLAY,
      !!props.sidebar,
    );
    // The block renders the same text a `prompt` cell would, so the cell goes.
    return (props.promptLines ?? 0) > 0 ? withoutPrompt(cols) : cols;
  });

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
    const max = props.promptLines ?? 0;
    // `promptDisplay: "off"` means no prompt anywhere, and the `p` key cycles
    // it live — so it hides the block too rather than leaving one prompt
    // surface the toggle cannot reach.
    if (max <= 0 || props.promptDisplay === "off") return EMPTY_PROMPT_BLOCK;
    const text = normalizePrompt(session.lastPrompt ?? "");
    return promptBlockCache.lines(
      session.id,
      text,
      promptBlockWidth(effectiveWidth()),
      max,
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

  const sessionLines = (session: EnrichedSession) =>
    1 +
    (rowHasContent(session, layout().row2) ? 1 : 0) +
    promptBlock(session).length;

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
   *
   * A non-first header draws a divider line above itself and `toVisualLine`
   * counts it, so the header's own row is one line further down; anchoring on
   * the divider would open the menu a row above the thing it belongs to.
   */
  const rowAnchor: RowAnchor = (index) => {
    const scrollbox = scrollboxRef;
    if (!scrollbox || index < 0 || index >= props.items.length) return null;
    const item = props.items[index];
    if (!item) return null;
    const divider = item.type === "header" && index > 0 ? 1 : 0;
    const line =
      toVisualLine(props.items, index, sessionLines) -
      scrollbox.scrollTop +
      divider;
    return {
      // Indented off the list's left edge: the menu covers the row it belongs
      // to either way, and leaving the selection marker and status glyph
      // visible is what says WHICH row it came from.
      x: scrollbox.viewport.x + ROW_MENU_INDENT,
      y: scrollbox.viewport.y + line,
    };
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
          {index > 0 && (
            <box height={1} paddingLeft={1} paddingRight={1}>
              <text fg={theme.border}>{"─".repeat(200)}</text>
            </box>
          )}
          <GroupHeader
            label={item.label}
            count={item.count}
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
        session={item.filteredSession.session}
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
        layout={layout()}
        promptBlock={promptBlock(item.filteredSession.session)}
        dimmed={props.dimmed}
        sidebar={props.sidebar}
        onActivate={onActivate}
        onContextMenu={onContextMenu}
      />
    );
  };

  return (
    <box
      flexDirection="column"
      width={props.showPreview ? `${100 - props.previewWidth}%` : "100%"}
      flexShrink={1}
    >
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
            const bump = () => setScrollboxLayout((v) => v + 1);
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
