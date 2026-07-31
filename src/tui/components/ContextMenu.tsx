import type { Component } from "solid-js";
import { createSignal, For } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton } from "@opentui/core";
import { truncateText } from "../utils/format";
import { theme } from "../theme";

export interface ContextMenuItem {
  label: string;
  hint: string;
  color: string;
  action: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  /**
   * Rows to keep clear beneath the items for one that may still arrive.
   *
   * The row menu's "Move changes" is appended once a `git status` comes back,
   * which is after the menu is on screen. Appending it last means nothing
   * above it moves — but only where the menu grows downward. Against the
   * bottom edge the clamp pins the BOTTOM instead, so a menu that grew would
   * slide every row up a line under a pointer already travelling towards one.
   *
   * Reserved for the menu's whole life, not just until the answer lands: a
   * reservation released because the item is not coming drops the menu back
   * down by the row it was holding, which is the same shift a beat later.
   */
  reservedRows?: number;
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
  const [hovered, setHovered] = createSignal<number | null>(null);

  /** One row per item plus the border. True by construction: every item row
   *  is pinned to a single row below. */
  const menuHeight = () => props.items.length + 2;

  const clampedX = () => {
    const max = Math.max(0, dims().width - MENU_WIDTH);
    return Math.min(Math.max(0, props.x), max);
  };
  /** The height to keep on screen: what is drawn, plus what is being held
   *  for an item still to come. */
  const reservedHeight = () =>
    menuHeight() + Math.max(0, props.reservedRows ?? 0);

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
      <For each={props.items}>
        {(item, i) => (
          <box
            flexDirection="row"
            height={1}
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={hovered() === i() ? theme.border : theme.surface}
            onMouseOver={() => setHovered(i())}
            onMouseOut={() => setHovered((h) => (h === i() ? null : h))}
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
