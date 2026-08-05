import type { Component } from "solid-js";
import { Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { truncateText } from "../utils/format";
import { turnsLabel } from "../turns-selection";
import { MAX_HANDOFF_NOTE_CHARS } from "../../daemon/handoff";
import { theme } from "../theme";

const MAX_WIDTH = 52;
const MIN_WIDTH = 24;

/** The focus marker's column plus the label's, in the new-session dialog's
 *  shape (marker, then the word) so a label reads the same wherever it is
 *  drawn. Sized to the longer of the two words and no wider: at a sidebar
 *  width every column here comes straight out of the turn count. */
const LABEL_WIDTH = 6;
/** Columns between a label and its control. */
const CONTROL_GAP = 1;

/** Border (2), the title, the turns row, the note row. Nothing below this is
 *  this dialog: both fields are the question it exists to ask. */
export const HANDOFF_DIALOG_FLOOR_ROWS = 5;

export type HandoffDialogField = "turns" | "note";

export interface HandoffDialogRows {
  /** The blank rows around the field stack. Pure air, given up first. */
  spacers: boolean;
  /** The muted line naming the SOURCE, under the title that names the
   *  target. Decoration next to the fields, so it goes before the hints. */
  source: boolean;
  /** The key-hint row. */
  hint: boolean;
  height: number;
}

/**
 * What the dialog can afford at this terminal height, in the fixed order it
 * gives rows up: the two blank rows first, then the source line, then the key
 * hints.
 *
 * A budget rather than a sum, the same way the Copy and new-session dialogs'
 * are, and for the same reason: a row rendered that the height did not account
 * for draws OVER its neighbour instead of clipping. Pure so it can be tested
 * without a renderer.
 *
 * The hints outlive the source line deliberately. Which session the response
 * came from is one keypress of context the user just supplied themselves; that
 * Tab reaches the note and Enter sends is not guessable from a box with two
 * rows in it.
 */
export function planHandoffDialogRows(
  terminalHeight: number,
): HandoffDialogRows {
  const withEverything = HANDOFF_DIALOG_FLOOR_ROWS + 4;
  if (terminalHeight >= withEverything) {
    return { spacers: true, source: true, hint: true, height: withEverything };
  }
  const withSource = HANDOFF_DIALOG_FLOOR_ROWS + 2;
  if (terminalHeight >= withSource) {
    return { spacers: false, source: true, hint: true, height: withSource };
  }
  const withHint = HANDOFF_DIALOG_FLOOR_ROWS + 1;
  if (terminalHeight >= withHint) {
    return { spacers: false, source: false, hint: true, height: withHint };
  }
  return {
    spacers: false,
    source: false,
    hint: false,
    // A terminal shorter than the floor gets what it has; the picker behind
    // it is unusable at that size anyway, and a box taller than the screen
    // would draw its bottom border off it.
    height: Math.min(Math.max(1, terminalHeight), HANDOFF_DIALOG_FLOOR_ROWS),
  };
}

interface HandoffDialogProps {
  /** The source and target rows, each named the way the pick banner names
   *  one (agent · project). */
  fromLabel: string;
  toLabel: string;
  turns: number;
  note: string;
  field: HandoffDialogField;
  onNoteInput: (value: string) => void;
}

/**
 * How much to hand off, and what to say about it.
 *
 * The pick has already happened when this opens (the banner and the aimed row
 * are gone), so the box has to name BOTH ends itself: the title carries the
 * target, because that is the irreversible half, and the muted line under it
 * carries the source.
 *
 * The turns row is the Copy dialog's question with the Copy dialog's keys —
 * one selector, one home (`turns-selection.ts`) — and the note row is the one
 * thing this dialog has that Copy does not. The note is folded to a single
 * line by the daemon's frozen header, so nothing is done about that here.
 */
export const HandoffDialog: Component<HandoffDialogProps> = (props) => {
  const dims = useTerminalDimensions();

  const width = () =>
    Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dims().width - 4));
  const contentWidth = () => Math.max(1, width() - 4);
  const plan = () => planHandoffDialogRows(dims().height);
  /** What a field's control has left once the label cell and the gap are
   *  spent. The input draws its placeholder in full PAST its own box, so this
   *  is what the placeholder is truncated against. */
  const controlWidth = () =>
    Math.max(1, contentWidth() - LABEL_WIDTH - CONTROL_GAP - 2);

  /** Truncated HERE rather than by the layout: an OpenTUI input draws its
   *  placeholder in full past its own box. (A long typed VALUE overruns the
   *  border at sidebar widths exactly as the new-session dialog's Prompt
   *  field has always done; that is the input's own scrolling, not this.) */
  const notePlaceholder = () =>
    truncateText("note (optional) · sent in the header", controlWidth());

  /** A field's label cell with its one-character focus marker. Colour alone
   *  is not enough: the digits act on the FOCUSED field, and a viewer who
   *  cannot tell which one that is types a count into a note. */
  const FieldLabel: Component<{ field: HandoffDialogField; text: string }> = (
    labelProps,
  ) => {
    const focused = () => props.field === labelProps.field;
    return (
      <box flexDirection="row" width={LABEL_WIDTH} height={1}>
        <box width={1}>
          <text fg={theme.blue}>{focused() ? ">" : ""}</text>
        </box>
        <box width={LABEL_WIDTH - 1}>
          <text fg={focused() ? theme.blue : theme.overlay}>
            {labelProps.text}
          </text>
        </box>
      </box>
    );
  };

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
        <text fg={theme.mauve}>
          <strong>
            {truncateText(`Hand off to ${props.toLabel}`, contentWidth())}
          </strong>
        </text>
      </box>
      <Show when={plan().source}>
        <box height={1}>
          <text fg={theme.overlay}>
            {truncateText(`from ${props.fromLabel}`, contentWidth())}
          </text>
        </box>
      </Show>
      <Show when={plan().spacers}>
        <box height={1} />
      </Show>

      <box flexDirection="row" height={1}>
        <FieldLabel field="turns" text="Turns" />
        <box width={CONTROL_GAP} />
        {/* Padded like the note's input shell below, so the two controls
          start in the same column: a one-column drift between two stacked
          values reads as a rendering fault. */}
        <box height={1} flexGrow={1} paddingLeft={1} paddingRight={1}>
          <text fg={props.field === "turns" ? theme.text : theme.subtext}>
            {truncateText(turnsLabel(props.turns), controlWidth())}
          </text>
        </box>
      </box>

      <box flexDirection="row" height={1}>
        <FieldLabel field="note" text="Note" />
        <box width={CONTROL_GAP} />
        {/* The same full-width run the new-session dialog's text fields
          paint, so a control reads as a control wherever it is; the input
          itself stays transparent over it (its own background prop does not
          paint). */}
        <box
          height={1}
          flexDirection="row"
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={
            props.field === "note" ? theme.border : theme.surface
          }
        >
          <input
            value={props.note}
            onInput={props.onNoteInput}
            focused={props.field === "note"}
            placeholder={notePlaceholder()}
            placeholderColor={theme.overlay}
            textColor={theme.text}
            cursorColor={theme.blue}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            // The endpoint refuses a longer note (a note is a one-liner), and
            // being refused AFTER the dialog closed would lose what was typed.
            maxLength={MAX_HANDOFF_NOTE_CHARS}
            flexGrow={1}
          />
        </box>
      </box>

      <Show when={plan().spacers}>
        <box height={1} />
      </Show>
      <Show when={plan().hint}>
        <box height={1}>
          <text fg={theme.overlay}>
            {truncateText(
              "j/k turns · tab note · enter send · esc cancel",
              contentWidth(),
            )}
          </text>
        </box>
      </Show>
    </box>
  );
};
