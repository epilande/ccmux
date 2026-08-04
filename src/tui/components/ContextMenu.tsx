import type { Component } from "solid-js";
import { createEffect, createSignal, For } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton } from "@opentui/core";
import { truncateText } from "../utils/format";
import { theme } from "../theme";

export interface ContextMenuItem {
  /**
   * Stable identity, independent of where the item sits today.
   *
   * The keyboard highlight is stored as one of these rather than as a row
   * number because the list mutates while the menu is open — see
   * `contextMenu.highlight` in the store. Labels would nearly work and are
   * exactly the wrong thing to key on: they are copy, and renaming one would
   * quietly move the highlight.
   */
  id: string;
  label: string;
  hint: string;
  color: string;
  action: () => void;
}

interface ContextMenuProps {
  /**
   * Changes every time a row menu opens, even when it replaces one that is
   * already mounted. A truthy `<Show>` does not remount its child when the
   * row behind it changes, so local pointer state needs this explicit
   * lifetime boundary.
   */
  openGeneration?: number;
  x: number;
  y: number;
  items: ContextMenuItem[];
  /**
   * Rows to keep clear beneath the items for one that may still arrive.
   *
   * The row menu's "Move changes" arrives once a `git status` comes back,
   * which is after the menu is on screen. Against the bottom edge the clamp
   * pins the BOTTOM, so a menu that grew would slide every row up a line under
   * a pointer already travelling towards one.
   *
   * Reserved for the menu's whole life, not just until the answer lands: a
   * reservation released because the item is not coming drops the menu back
   * down by the row it was holding, which is the same shift a beat later.
   */
  reservedRows?: number;
  /**
   * The keyboard-highlighted item's `id`, or null for none.
   *
   * Drawn with the same raised background the pointer paints on hover rather
   * than a second affordance: it means the same thing (this is the row an
   * action would land on), and two different-looking "current" rows in one
   * 22-column box would be a puzzle. The pointer still wins while it is over
   * a row, so a menu being driven by both at once follows the hand.
   *
   * An id whose item is not in `items` lights nothing, which is what happens
   * when the highlighted item disappears from under an open menu.
   */
  highlight?: string | null;
  onClose: () => void;
}

const MENU_WIDTH = 22;
/** Columns an item row actually has: the width less its border and padding. */
const CONTENT_WIDTH = MENU_WIDTH - 4;

/**
 * The label as it fits beside its key hint, with the hint's own columns (and
 * one of air) spent first.
 *
 * A label wide enough to wrap used to render two rows while still counting as
 * one item, which made `menuHeight` — and with it the viewport clamp — wrong
 * for the whole menu, silently. The rows are pinned to one row each so the
 * height stays honest by construction; truncating here is what keeps an
 * over-long label legible instead of merely clipped.
 */
function fittedLabel(label: string, hint: string): string {
  const spent = hint ? hint.length + 1 : 0;
  return truncateText(label, Math.max(1, CONTENT_WIDTH - spent));
}

export const ContextMenu: Component<ContextMenuProps> = (props) => {
  const dims = useTerminalDimensions();
  const [hovered, setHovered] = createSignal<string | null>(null);
  /**
   * Freeze the rows once the pointer enters one of them.
   *
   * The list is allowed to mutate while a keyboard-opened menu is live: its
   * highlight is an item ID, so Enter still follows the item the user chose.
   * A pointer addresses screen coordinates instead. Once it has begun aiming
   * at a row, inserting or removing an item would put another action under
   * the same coordinate. Snapshot both the items and the reserved height at
   * the first hover so every pointer target stays where the user saw it. Item
   * actions still re-check current application state before acting.
   */
  const [pointerSnapshot, setPointerSnapshot] = createSignal<{
    items: ContextMenuItem[];
    reservedRows: number;
  } | null>(null);

  /** A menu opened over another row keeps this component mounted. Drop every
   * pointer-owned bit of state at that boundary so the new row cannot render
   * the old row's frozen actions. */
  createEffect(() => {
    void props.openGeneration;
    setPointerSnapshot(null);
    setHovered(null);
  });

  /**
   * A frozen list is only a pointer-safety device. Once the pointer has left
   * and the keyboard owns a real highlight, render the same live list that
   * App's key routing navigates. Otherwise an async item can be activated
   * while absent from the box (or a removed item can remain visible).
   */
  createEffect(() => {
    if (hovered() === null && props.highlight != null) {
      setPointerSnapshot(null);
    }
  });

  const renderedItems = () => pointerSnapshot()?.items ?? props.items;
  const renderedReservedRows = () =>
    pointerSnapshot()?.reservedRows ?? props.reservedRows ?? 0;

  /** Whether this row is the one an action would land on: the pointer's
   *  while it is over any row, otherwise the keyboard's. */
  const isActive = (item: ContextMenuItem): boolean =>
    hovered() === null ? props.highlight === item.id : hovered() === item.id;

  /** One row per item plus the border. True by construction: every item row
   *  is pinned to a single row below. */
  const menuHeight = () => renderedItems().length + 2;

  const clampedX = () => {
    const max = Math.max(0, dims().width - MENU_WIDTH);
    return Math.min(Math.max(0, props.x), max);
  };
  /** The height to keep on screen: what is drawn, plus what is being held
   *  for an item still to come. */
  const reservedHeight = () =>
    menuHeight() + Math.max(0, renderedReservedRows());

  const clampedY = () => {
    // Clamped against the RESERVED height, positioned at the drawn one: the
    // box grows into the space below rather than pushing itself up out of it.
    const max = Math.max(0, dims().height - reservedHeight());
    return Math.min(Math.max(0, props.y), max);
  };

  return (
    <box
      position="absolute"
      left={clampedX()}
      top={clampedY()}
      width={MENU_WIDTH}
      height={menuHeight()}
      backgroundColor={theme.surface}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
    >
      <For each={renderedItems()}>
        {(item) => (
          <box
            flexDirection="row"
            height={1}
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={isActive(item) ? theme.border : theme.surface}
            onMouseOver={() => {
              setPointerSnapshot(
                (snapshot) =>
                  snapshot ?? {
                    items: props.items,
                    reservedRows: props.reservedRows ?? 0,
                  },
              );
              setHovered(item.id);
            }}
            onMouseOut={() =>
              setHovered((current) => (current === item.id ? null : current))
            }
            onMouseDown={(event) => {
              if (event.button === MouseButton.LEFT) item.action();
              else if (event.button === MouseButton.RIGHT) props.onClose();
            }}
          >
            <box flexGrow={1}>
              <text fg={item.color}>{fittedLabel(item.label, item.hint)}</text>
            </box>
            <text fg={theme.overlay}>{item.hint}</text>
          </box>
        )}
      </For>
    </box>
  );
};
