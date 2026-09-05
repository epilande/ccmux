import type { Component } from "solid-js";
import { createMemo, For } from "solid-js";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { MouseButton } from "@opentui/core";
import { truncateText, wrapText } from "../utils/format";
import { theme } from "../theme";

const MAX_WIDTH = 72;
const MIN_WIDTH = 24;
/** Border (2), title, blank under it, blank above the hint, hint. */
const CHROME_ROWS = 6;

interface NoticeDialogProps {
  title: string;
  /** Already-composed message lines; wrapped here to whatever width there is. */
  lines: string[];
  onDismiss: () => void;
}

/**
 * A message the user has to acknowledge.
 *
 * The same centered, bordered shape as the confirmation dialog, and modal for
 * the same reason — but with one exit rather than two, because there is no
 * choice to make: something has already happened and this is the record of it.
 * Every key dismisses it (see `App.tsx`), so nothing about recovering from a
 * half-done move depends on finding a particular one.
 *
 * Its own lines are pre-wrapped rather than left to the renderer for the same
 * reason the new-session dialog wraps its error: the height has to be known
 * before layout, and content that wraps past its budgeted rows draws OUTSIDE
 * the border instead of clipping.
 */
export const NoticeDialog: Component<NoticeDialogProps> = (props) => {
  const dims = useSharedTerminalDimensions();

  const width = () =>
    Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dims().width - 4));
  const contentWidth = () => Math.max(1, width() - 4);

  /**
   * The message, wrapped, and capped at the rows the screen has.
   *
   * The cap matters as much as the wrap: a message longer than the terminal
   * would push the height past `dims().height`, where the clamp below draws
   * the overflow over the rows above it.
   */
  const lines = createMemo(() => {
    const wrapped = props.lines.flatMap((line) =>
      wrapText(line, contentWidth()),
    );
    const room = Math.max(1, dims().height - CHROME_ROWS);
    if (wrapped.length <= room) return wrapped;
    // Say that it was cut rather than ending mid-sentence.
    const kept = wrapped.slice(0, room);
    kept[room - 1] = truncateText(
      wrapped.slice(room - 1).join(" "),
      contentWidth(),
    );
    return kept;
  });

  const height = () =>
    Math.min(dims().height, CHROME_ROWS + Math.max(1, lines().length));

  return (
    <box
      position="absolute"
      /* Centered by arithmetic rather than by a 50% offset and a negative
         margin: those disagree by a row when the dialog and the terminal are
         both odd-height, and the row they disagree by is the bottom border,
         which lands off screen exactly when the dialog is already as tall as
         the terminal. */
      top={Math.max(0, Math.floor((dims().height - height()) / 2))}
      left={Math.max(0, Math.floor((dims().width - width()) / 2))}
      width={width()}
      height={height()}
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT) props.onDismiss();
      }}
    >
      <box height={1}>
        {/* The shared title colour: dialog titles say WHAT this box is, and
          severity lives in the message lines, not the headline. */}
        <text fg={theme.text}>
          <strong>{truncateText(props.title, contentWidth())}</strong>
        </text>
      </box>
      <box height={1} />
      <For each={lines()}>
        {(line) => (
          <box height={1}>
            <text fg={theme.text}>{line}</text>
          </box>
        )}
      </For>
      <box height={1} />
      <box height={1}>
        <text fg={theme.overlay}>
          {truncateText("any key to dismiss", contentWidth())}
        </text>
      </box>
    </box>
  );
};
