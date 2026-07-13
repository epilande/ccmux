import type { Component } from "solid-js";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { EnrichedSession } from "../../types";
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
} from "../utils/grouping";
import { SessionItem } from "./SessionItem";
import { GroupHeader } from "./GroupHeader";
import {
  resolveLayout,
  applyPromptDisplay,
  rowHasContent,
} from "./session-columns";
import { theme } from "../theme";

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
  loading?: boolean;
  onActivate?: (item: FlatItem, index: number) => void;
  onContextMenu?: (item: FlatItem, index: number, event: MouseEvent) => void;
}

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

export const SessionList: Component<SessionListProps> = (props) => {
  let scrollboxRef: ScrollBoxRenderable | undefined;
  const [scrollboxLayout, setScrollboxLayout] = createSignal(0);
  const dims = useTerminalDimensions();
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
    return applyPromptDisplay(
      resolved,
      props.promptDisplay ?? DEFAULT_PROMPT_DISPLAY,
      !!props.sidebar,
    );
  });

  const hasSubtitle = (session: EnrichedSession) =>
    rowHasContent(session, layout().row2);

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
      hasSubtitle,
    );
    if (target !== null) {
      scrollboxRef.scrollTo(target);
    }
  });

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
              <text fg={theme.overlay}>No sessions found</text>
            </box>
          </Show>
        }
      >
        <scrollbox
          ref={(r: ScrollBoxRenderable) => {
            scrollboxRef = r;
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
