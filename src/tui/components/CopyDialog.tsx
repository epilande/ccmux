import type { Component } from "solid-js";
import { Show } from "solid-js";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { MouseButton } from "@opentui/core";
import { truncateText } from "../utils/format";
import { turnsLabel } from "../turns-selection";
import { theme } from "../theme";

const MAX_WIDTH = 46;
const MIN_WIDTH = 20;

/** Border (2), the title, the turns row. Nothing below this is a dialog. */
export const COPY_DIALOG_FLOOR_ROWS = 4;

export interface CopyDialogRows {
  /** The blank row under the title. Pure air, given up first; the air around
   *  the button row is the button unit's own. */
  spacers: boolean;
  /** The Cancel/Copy button row with its leading and trailing blanks — one
   *  droppable unit, the same as the new-session and handoff dialogs', and
   *  given up for the same reason: the buttons duplicate Enter and Escape. */
  buttons: boolean;
  height: number;
}

/**
 * What the dialog can afford at this terminal height, in the fixed order it
 * gives rows up: the blank row first, then the button row (a duplicate of
 * enter/esc).
 *
 * A budget rather than a sum, the same way the new-session dialog's is, and
 * for the same reason: a row rendered that the height did not account for
 * draws OVER its neighbour instead of clipping. Pure so it can be tested
 * without a renderer.
 */
export function planCopyDialogRows(terminalHeight: number): CopyDialogRows {
  const withEverything = COPY_DIALOG_FLOOR_ROWS + 1 + 3;
  if (terminalHeight >= withEverything) {
    return { spacers: true, buttons: true, height: withEverything };
  }
  const withButtons = COPY_DIALOG_FLOOR_ROWS + 3;
  if (terminalHeight >= withButtons) {
    return { spacers: false, buttons: true, height: withButtons };
  }
  return {
    spacers: false,
    buttons: false,
    // A terminal shorter than the floor gets what it has; the picker behind
    // it is unusable at that size anyway, and a box taller than the screen
    // would draw its bottom border off it.
    height: Math.min(Math.max(1, terminalHeight), COPY_DIALOG_FLOOR_ROWS),
  };
}

interface CopyDialogProps {
  /** The row being copied FROM, named the way the handoff banner names one. */
  label: string;
  turns: number;
  /** Click twins of Enter and Escape: the same paths, all the same guards. */
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * How much of a session's conversation to put on the clipboard.
 *
 * One question with one answer, rather than a mode of the new-session dialog:
 * that machinery is a field list with a row budget and a spawn behind it. It
 * opens on the answer most people want (the last response), so Enter alone is
 * the whole interaction. The dressing is still the shared dialog language —
 * the control shell and the Cancel/Copy buttons — so the one selector here
 * reads the same as the handoff dialog's Turns row.
 */
export const CopyDialog: Component<CopyDialogProps> = (props) => {
  const dims = useSharedTerminalDimensions();

  const width = () =>
    Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dims().width - 4));
  const contentWidth = () => Math.max(1, width() - 4);
  const plan = () => planCopyDialogRows(dims().height);

  return (
    <box
      position="absolute"
      /* Centered by arithmetic rather than a 50% offset and a negative
         margin, which disagree by a row when dialog and terminal are both
         odd-height (see `NoticeDialog`). */
      top={Math.max(0, Math.floor((dims().height - plan().height) / 2))}
      left={Math.max(0, Math.floor((dims().width - width()) / 2))}
      width={width()}
      height={plan().height}
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1}>
        <text fg={theme.text}>
          <strong>
            {truncateText(`Copy from ${props.label}`, contentWidth())}
          </strong>
        </text>
      </box>
      <Show when={plan().spacers}>
        <box height={1} />
      </Show>
      {/* The one control, in the shared control shell the new-session and
        handoff dialogs paint, wearing its focused colour: it is the only
        field, so it is always the one the keys act on. */}
      <box
        height={1}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.border}
      >
        <text fg={theme.text}>
          {truncateText(
            turnsLabel(props.turns),
            Math.max(1, contentWidth() - 2),
          )}
        </text>
      </box>

      <Show when={plan().buttons}>
        <box height={1} />
        {/* Confirm and Cancel in the shared right-aligned order; pure click
          duplicates of Enter and Escape, never Tab stops. */}
        <box flexDirection="row" height={1}>
          <box flexGrow={1} />
          <box
            height={1}
            flexDirection="row"
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.surface}
            onMouseDown={(event) => {
              if (event.button === MouseButton.LEFT) props.onCancel();
            }}
          >
            <text fg={theme.text}>Cancel</text>
          </box>
          <box width={2} />
          <box
            height={1}
            flexDirection="row"
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.mauve}
            onMouseDown={(event) => {
              if (event.button === MouseButton.LEFT) props.onSubmit();
            }}
          >
            <text fg={theme.base}>
              <strong>Copy</strong>
            </text>
          </box>
        </box>
        <box height={1} />
      </Show>
    </box>
  );
};
