import type { Component } from "solid-js";
import { Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { truncateText } from "../utils/format";
import { theme } from "../theme";

const MAX_WIDTH = 46;
const MIN_WIDTH = 20;

/** Border (2), the title, the turns row. Nothing below this is a dialog. */
export const COPY_DIALOG_FLOOR_ROWS = 4;

export interface CopyDialogRows {
  /** The blank rows above and below the turns row. Pure air, given up first. */
  spacers: boolean;
  /** The key-hint row. */
  hint: boolean;
  height: number;
}

/**
 * What the dialog can afford at this terminal height, in the fixed order it
 * gives rows up: the two blank rows first, then the key hints.
 *
 * A budget rather than a sum, the same way the new-session dialog's is, and
 * for the same reason: a row rendered that the height did not account for
 * draws OVER its neighbour instead of clipping. Pure so it can be tested
 * without a renderer.
 */
export function planCopyDialogRows(terminalHeight: number): CopyDialogRows {
  const withEverything = COPY_DIALOG_FLOOR_ROWS + 3;
  if (terminalHeight >= withEverything) {
    return { spacers: true, hint: true, height: withEverything };
  }
  const withHint = COPY_DIALOG_FLOOR_ROWS + 1;
  if (terminalHeight >= withHint) {
    return { spacers: false, hint: true, height: withHint };
  }
  return {
    spacers: false,
    hint: false,
    // A terminal shorter than the floor gets what it has; the picker behind
    // it is unusable at that size anyway, and a box taller than the screen
    // would draw its bottom border off it.
    height: Math.min(Math.max(1, terminalHeight), COPY_DIALOG_FLOOR_ROWS),
  };
}

/**
 * How much of the conversation the current count would take, in words.
 *
 * One turn is the last response on its own, which is what the item promised
 * before it grew a dialog. Past one the payload stops being a response and
 * becomes an exchange, so the parenthetical says the thing a user would
 * otherwise discover only after pasting: their own prompts come too.
 */
export function copyTurnsLabel(turns: number): string {
  if (turns <= 1) return "Last response";
  return `Last ${turns} turns (with your prompts)`;
}

interface CopyDialogProps {
  /** The row being copied FROM, named the way the handoff banner names one. */
  label: string;
  turns: number;
}

/**
 * How much of a session's conversation to put on the clipboard.
 *
 * The same centered, bordered, modal shape as the notice and confirmation
 * dialogs rather than a mode of the new-session dialog: that machinery is a
 * field list with a row budget and a spawn behind it, and this asks one
 * question with one answer. It opens on the answer most people want (the last
 * response), so Enter alone is the whole interaction.
 */
export const CopyDialog: Component<CopyDialogProps> = (props) => {
  const dims = useTerminalDimensions();

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
        <text fg={theme.peach}>
          <strong>
            {truncateText(`Copy from ${props.label}`, contentWidth())}
          </strong>
        </text>
      </box>
      <Show when={plan().spacers}>
        <box height={1} />
      </Show>
      <box height={1}>
        <text fg={theme.text}>
          <strong>
            {truncateText(copyTurnsLabel(props.turns), contentWidth())}
          </strong>
        </text>
      </box>
      <Show when={plan().spacers}>
        <box height={1} />
      </Show>
      <Show when={plan().hint}>
        <box height={1}>
          <text fg={theme.overlay}>
            {truncateText(
              "j/k turns · enter copy · esc cancel",
              contentWidth(),
            )}
          </text>
        </box>
      </Show>
    </box>
  );
};
