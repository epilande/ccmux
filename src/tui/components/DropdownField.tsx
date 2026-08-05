import type { Component } from "solid-js";
import { createMemo, For } from "solid-js";
import { MouseButton } from "@opentui/core";
import { displayWidth, truncateText } from "../utils/format";
import { theme } from "../theme";

/**
 * The dropdown the new-session dialog's option fields share: a one-row pill
 * showing the held value, and an absolute overlay holding the list.
 *
 * Two components rather than one, and the seam is deliberate. An absolute
 * child only z-sorts against its own siblings in OpenTUI, so an overlay
 * nested inside a field's row paints UNDER the rows that follow it — the
 * list has to be a late child of the dialog box itself. The trigger renders
 * in the field's row, the overlay renders at the dialog root anchored under
 * that row, and the dialog composes the two.
 */

/** One option in a dropdown's list. */
export interface DropdownOption {
  /** What the row (and the collapsed pill, when held) shows. */
  label: string;
  /** Label colour; the theme's text colour when absent. Agents pass their
   *  brand colour, the plain fields pass nothing. */
  color?: string;
}

/**
 * Slice of a longer option list to show, keeping the selection visible and
 * centered where it can be. Exported for its own tests: an off-by-one here
 * hides the row the user is on.
 */
export function optionWindow(
  total: number,
  selected: number,
  size: number,
): { start: number; end: number } {
  if (size >= total || size <= 0) return { start: 0, end: total };
  const half = Math.floor(size / 2);
  const start = Math.min(Math.max(selected - half, 0), total - size);
  return { start, end: start + size };
}

interface DropdownTriggerProps {
  /** The held value's label. */
  value: string;
  /** The held value's colour; the theme's text colour when absent. */
  color?: string;
  /** Whether this pill's field has focus, which picks the hotter of the two
   *  raised tokens — the same pairing the context menu uses for hover. */
  focused: boolean;
  /** Columns the label may spend before it is truncated: the control's run
   *  less its padding, the caret, and one column of air — so a long value
   *  can never push the caret. */
  maxWidth: number;
  onOpen: () => void;
}

/** The collapsed control: the held value on a raised background that fills
 *  the whole value column, with the arrow pinned at its right edge as the
 *  affordance that a list is behind it. Full-width rather than
 *  content-hugging, so the form keeps one uniform right edge. */
export const DropdownTrigger: Component<DropdownTriggerProps> = (props) => (
  <box
    height={1}
    flexDirection="row"
    flexGrow={1}
    paddingLeft={1}
    paddingRight={1}
    backgroundColor={props.focused ? theme.border : theme.surface}
    onMouseDown={(event) => {
      if (event.button === MouseButton.LEFT) props.onOpen();
    }}
  >
    <text fg={props.color ?? theme.text}>
      {truncateText(props.value, Math.max(1, props.maxWidth))}
    </text>
    <box flexGrow={1} />
    <box width={1}>
      <text fg={theme.overlay}>▾</text>
    </box>
  </box>
);

interface DropdownOverlayProps {
  options: DropdownOption[];
  /** The row j/k is on, drawn with the raised background. */
  highlight: number;
  /** The draft's current value, drawn with the `▎` marker. */
  selected: number;
  /** Anchor within the parent the overlay is a child of, in that parent's
   *  content-box coordinates: the row under the field it belongs to. */
  top: number;
  left: number;
  /** Option rows the screen has room for below the anchor; the overlay
   *  windows itself into them and scrolls to keep the highlight visible. */
  maxRows: number;
  maxWidth: number;
  onSelect: (index: number) => void;
}

/**
 * The open list. Absolute and z-raised, so it floats OVER the rows beneath
 * its field instead of pushing them down — the whole point of collapsing the
 * fields. Shows absolute numbers, so a scrolled window never renumbers the
 * keys.
 */
/** Columns an option row spends before its label: border and left padding
 *  (3), then the marker and number cells (2 each). Shared by the box width
 *  and the label budget so the two cannot drift. */
const OPTION_CHROME = 7;

export const DropdownOverlay: Component<DropdownOverlayProps> = (props) => {
  /** The chrome, the widest label, and a column of right air; clamped so
   *  the overlay stays inside its parent's right edge. */
  const width = createMemo(() => {
    const widest = Math.max(
      1,
      ...props.options.map((option) => displayWidth(option.label)),
    );
    return Math.min(props.maxWidth, widest + OPTION_CHROME + 1);
  });

  /** The visible slice, with where it starts so each row can carry its
   *  absolute index. */
  const window = createMemo(() => {
    const { start, end } = optionWindow(
      props.options.length,
      props.highlight,
      Math.max(1, props.maxRows),
    );
    return { start, slice: props.options.slice(start, end) };
  });

  return (
    <box
      position="absolute"
      left={props.left}
      top={props.top}
      width={width()}
      height={window().slice.length + 2}
      zIndex={1}
      backgroundColor={theme.surface}
      borderStyle="single"
      /* The muted chrome token the dialog frame and the context menu use:
        the raised fill is what says "floating layer", and an accent border
        here would out-shout the accent's real jobs (focus, selection). */
      borderColor={theme.border}
      flexDirection="column"
    >
      {/* `<For>` keys rows by option IDENTITY: the slice above is fresh per
        highlight move, but its elements must not be, or every keypress
        tears down and rebuilds all visible rows (the caller memoizes the
        option objects for exactly this). */}
      <For each={window().slice}>
        {(option, i) => {
          const index = () => window().start + i();
          return (
            <box
              height={1}
              flexDirection="row"
              flexShrink={0}
              paddingLeft={1}
              backgroundColor={
                index() === props.highlight ? theme.border : theme.surface
              }
              onMouseDown={(event) => {
                if (event.button !== MouseButton.LEFT) return;
                props.onSelect(index());
              }}
            >
              <box width={2}>
                <text fg={theme.green}>
                  {index() === props.selected ? "▎" : ""}
                </text>
              </box>
              {/* Only the first nine get a number key. */}
              <box width={2}>
                <text fg={theme.overlay}>
                  {index() < 9 ? `${index() + 1}` : ""}
                </text>
              </box>
              <text fg={option.color ?? theme.text}>
                {truncateText(
                  option.label,
                  Math.max(1, width() - OPTION_CHROME),
                )}
              </text>
            </box>
          );
        }}
      </For>
    </box>
  );
};
