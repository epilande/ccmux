import type { Component } from "solid-js";
import { Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton } from "@opentui/core";
import { displayWidth, truncateMiddle, truncateText } from "../utils/format";
import { turnsLabel } from "../turns-selection";
import { MAX_HANDOFF_NOTE_CHARS } from "../../daemon/handoff";
import { handoffDialogHintSegments } from "./Footer";
import { theme } from "../theme";

const MAX_WIDTH = 52;
const MIN_WIDTH = 24;

/** The focus marker's column plus the label's, in the new-session dialog's
 *  shape (marker, then the word) so a label reads the same wherever it is
 *  drawn. Sized to the longer of the words and no wider: at a sidebar
 *  width every column here comes straight out of the turn count. */
const LABEL_WIDTH = 6;
/** Columns between a label and its control. */
const CONTROL_GAP = 1;

/** Content width below which the hint row gives up its middle segment,
 *  keeping only the two exits, the same trade the new-session dialog's
 *  hint row makes when compact. */
const COMPACT_HINT_WIDTH = 46;

/** Border (2), the title, the turns row, the note row, and the To row.
 *  The fields are the question this dialog exists to ask, and the To row is
 *  the one fact it can never drop: with a bare mode title, that row is the
 *  only place the irreversible half of the gesture is named. */
export const HANDOFF_DIALOG_FLOOR_ROWS = 6;

export type HandoffDialogField = "turns" | "note";

export interface HandoffDialogRows {
  /** The blank rows in the field stack (under the title, between the fields,
   *  before the endpoint rows). Pure air, given up first. */
  spacers: boolean;
  /** The Cancel/Send button row with its leading and trailing blanks — one
   *  droppable unit, the same as the new-session dialog's, and given up for
   *  the same reason: the buttons duplicate Enter and Escape exactly. */
  buttons: boolean;
  /** The From row naming the SOURCE, paired directly under the floor's To
   *  row. Decoration next to the target, so it goes before the hints. */
  source: boolean;
  /** The key-hint row. */
  hint: boolean;
  height: number;
}

/**
 * What the dialog can afford at this terminal height, in the fixed order it
 * gives rows up: the blank rows first, then the button row (a duplicate of
 * enter/esc), then the source line, then the key hints.
 *
 * A budget rather than a sum, the same way the Copy and new-session dialogs'
 * are, and for the same reason: a row rendered that the height did not account
 * for draws OVER its neighbour instead of clipping. Pure so it can be tested
 * without a renderer.
 *
 * `keyHints` follows the new-session dialog's split: the picker's Footer
 * carries this dialog's hints, so only the sidebar (which has no footer)
 * budgets a row for them. Where they ARE drawn, they outlive the From row
 * deliberately: which session the response came from is one keypress of
 * context the user just supplied themselves; that Tab reaches the note and
 * Enter sends is not guessable from a box with two rows in it. The To row is
 * part of the floor and never enters this order at all.
 */
export function planHandoffDialogRows(
  terminalHeight: number,
  keyHints: boolean,
): HandoffDialogRows {
  const hintRows = keyHints ? 1 : 0;
  // Floor + the three blanks + the From row + the button unit + the hint.
  const withEverything = HANDOFF_DIALOG_FLOOR_ROWS + 3 + 1 + 3 + hintRows;
  if (terminalHeight >= withEverything) {
    return {
      spacers: true,
      buttons: true,
      source: true,
      hint: keyHints,
      height: withEverything,
    };
  }
  const withButtons = HANDOFF_DIALOG_FLOOR_ROWS + 1 + 3 + hintRows;
  if (terminalHeight >= withButtons) {
    return {
      spacers: false,
      buttons: true,
      source: true,
      hint: keyHints,
      height: withButtons,
    };
  }
  const withSource = HANDOFF_DIALOG_FLOOR_ROWS + 1 + hintRows;
  if (terminalHeight >= withSource) {
    return {
      spacers: false,
      buttons: false,
      source: true,
      hint: keyHints,
      height: withSource,
    };
  }
  const withHint = HANDOFF_DIALOG_FLOOR_ROWS + 1;
  if (keyHints && terminalHeight >= withHint) {
    return {
      spacers: false,
      buttons: false,
      source: false,
      hint: true,
      height: withHint,
    };
  }
  return {
    spacers: false,
    buttons: false,
    source: false,
    hint: false,
    // A terminal shorter than the floor gets what it has; the picker behind
    // it is unusable at that size anyway, and a box taller than the screen
    // would draw its bottom border off it.
    height: Math.min(Math.max(1, terminalHeight), HANDOFF_DIALOG_FLOOR_ROWS),
  };
}

/**
 * One end of the handoff, tokenized the way the session list reads:
 * project:branch first, then the agent, then the tmux pane. Tokenized rather
 * than pre-joined because the row colours each part differently, and because
 * fitting a narrow width means choosing which token to give up.
 */
export interface HandoffEndpoint {
  /** project:branch, the list rows' leading identity; the raw session id
   *  when the row has left the board (the fallback the labels always had). */
  context: string;
  /** The agent's display name, "" when unknown. */
  agent: string;
  /** The agent token's brand colour (`agentColorFor`); unread when `agent`
   *  is empty. */
  agentColor: string;
  /** The tmux target (session:window.pane), "" when there is no live pane. */
  pane: string;
}

/** Columns the gap between endpoint tokens costs: two columns of air, so the
 *  colour-separated tokens read as three facts rather than one run, without
 *  a dotted join spending columns on punctuation. */
const TOKEN_SEP_WIDTH = 2;
/** The narrowest a truncated context token is still recognizable at; below
 *  this the row starts giving up whole tokens instead. */
const MIN_CONTEXT_WIDTH = 8;

/**
 * The endpoint's tokens, fitted to `width` columns.
 *
 * The context yields first (middle-truncated, the way long paths are cut
 * everywhere else), then the agent is dropped whole, and the pane goes last:
 * two sessions on the same agent in the same project differ by nothing BUT
 * the pane, and naming the physical destination is the row's whole job.
 * Pure and exported for tests.
 */
export function fitHandoffEndpoint(
  endpoint: HandoffEndpoint,
  width: number,
): { context: string; agent: string; pane: string } {
  const cost = (token: string) =>
    token ? TOKEN_SEP_WIDTH + displayWidth(token) : 0;
  const paneCost = cost(endpoint.pane);
  const agentCost = cost(endpoint.agent);
  if (displayWidth(endpoint.context) + agentCost + paneCost <= width) {
    return endpoint;
  }
  const withAgent = width - agentCost - paneCost;
  if (withAgent >= MIN_CONTEXT_WIDTH) {
    return {
      ...endpoint,
      context: truncateMiddle(endpoint.context, withAgent),
    };
  }
  const withoutAgent = width - paneCost;
  if (withoutAgent >= 1) {
    return {
      context: truncateMiddle(endpoint.context, withoutAgent),
      agent: "",
      pane: endpoint.pane,
    };
  }
  return {
    context: "",
    agent: "",
    pane: truncateText(endpoint.pane, Math.max(1, width)),
  };
}

interface HandoffDialogProps {
  /** The two ends, tokenized; see `HandoffEndpoint`. */
  from: HandoffEndpoint;
  to: HandoffEndpoint;
  turns: number;
  note: string;
  field: HandoffDialogField;
  onNoteInput: (value: string) => void;
  onFocusField: (field: HandoffDialogField) => void;
  /** Click twins of Enter and Escape: the same paths, all the same guards. */
  onSubmit: () => void;
  onCancel: () => void;
  /**
   * Draw the dialog's own key-hint row. The picker's Footer switches to the
   * same line whenever this dialog is open, and showing both puts the same
   * hints on screen twice; the footer wins there because that is where the
   * picker's hints always live. The sidebar has no footer at all, so its
   * dialog carries the row itself. (The new-session dialog's rule.)
   */
  showKeyHints?: boolean;
}

/**
 * How much to hand off, and what to say about it.
 *
 * The pick has already happened when this opens (the banner and the aimed row
 * are gone), so the box has to name BOTH ends itself: the To and From rows
 * under the fields, each tokenized the way the session list reads
 * (project:branch, agent, pane). The pane is deliberately part of that:
 * handoffs mostly stay inside one project, where two rows on the same agent
 * differ by nothing else, and the pane is where the text will physically be
 * typed. The title is a bare mode indicator like New session's, which is why
 * the To row is part of the floor: without it the target is named nowhere.
 *
 * Drawn in the new-session dialog's visual language rather than its own — the
 * `▎` focus marker, the shared control shells, the Cancel/Send buttons, the
 * confirm-first hint row — because this IS that dialog's shape: a short field
 * list with one action behind it. The turns row is the Copy dialog's question
 * with the Copy dialog's keys (one selector, one home: `turns-selection.ts`),
 * and the note row is the one thing this dialog has that Copy does not. The
 * note is folded to a single line by the daemon's frozen header, so nothing
 * is done about that here.
 */
export const HandoffDialog: Component<HandoffDialogProps> = (props) => {
  const dims = useTerminalDimensions();

  const width = () =>
    Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dims().width - 4));
  const contentWidth = () => Math.max(1, width() - 4);
  const plan = () =>
    planHandoffDialogRows(dims().height, props.showKeyHints !== false);
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

  /**
   * A derived endpoint row: label cell padded past the marker column (never
   * focused, like the new-session dialog's Directory row), then the fitted
   * tokens in the list's own order, told apart by colour alone — context in
   * subtext, the agent in its brand colour, the pane in the text colour,
   * because WHERE the text lands is the fact this row exists to name.
   */
  const EndpointRow: Component<{ label: string; endpoint: HandoffEndpoint }> = (
    rowProps,
  ) => {
    const fitted = () => fitHandoffEndpoint(rowProps.endpoint, controlWidth());
    return (
      <box flexDirection="row" height={1}>
        <box width={LABEL_WIDTH} paddingLeft={1}>
          <text fg={theme.overlay}>{rowProps.label}</text>
        </box>
        <box width={1 + CONTROL_GAP} />
        <Show when={fitted().context}>
          <text fg={theme.subtext}>{fitted().context}</text>
        </Show>
        <Show when={fitted().context && fitted().agent}>
          <box width={TOKEN_SEP_WIDTH} />
        </Show>
        <Show when={fitted().agent}>
          <text fg={rowProps.endpoint.agentColor}>{fitted().agent}</text>
        </Show>
        <Show when={fitted().pane && (fitted().context || fitted().agent)}>
          <box width={TOKEN_SEP_WIDTH} />
        </Show>
        <Show when={fitted().pane}>
          <text fg={theme.text}>{fitted().pane}</text>
        </Show>
      </box>
    );
  };

  /** Whether the hint row keeps its middle segment; the two it sits between
   *  are the dialog's only exits, so they are what a narrow surface keeps. */
  const compactHints = () => contentWidth() < COMPACT_HINT_WIDTH;

  /**
   * A field's label cell, carrying the new-session dialog's one-character
   * focus marker. Colour alone is not enough: the digits act on the FOCUSED
   * field, and a viewer who cannot tell which one that is types a count into
   * a note.
   */
  const FieldLabel: Component<{ field: HandoffDialogField; text: string }> = (
    labelProps,
  ) => {
    const focused = () => props.field === labelProps.field;
    return (
      <box flexDirection="row" width={LABEL_WIDTH} height={1}>
        <box width={1}>
          <text fg={theme.blue}>{focused() ? "▎" : ""}</text>
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
        {/* A bare mode indicator, the New session title's rule: the endpoints
          are compound labels, and folding one into a title sentence is what
          made it read as two unrelated tokens. The To row names the target. */}
        <text fg={theme.text}>
          <strong>Hand off</strong>
        </text>
      </box>
      <Show when={plan().spacers}>
        <box height={1} />
      </Show>

      <box
        flexDirection="row"
        height={1}
        onMouseDown={(event) => {
          if (event.button === MouseButton.LEFT) props.onFocusField("turns");
        }}
      >
        <FieldLabel field="turns" text="Turns" />
        <box width={CONTROL_GAP} />
        {/* The same full-width run the new-session dialog's controls paint,
          so a control reads as a control wherever it is; focus is the same
          surface-to-border lift its text fields make. */}
        <box
          height={1}
          flexGrow={1}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={
            props.field === "turns" ? theme.border : theme.surface
          }
        >
          <text fg={theme.text}>
            {truncateText(turnsLabel(props.turns), controlWidth())}
          </text>
        </box>
      </box>

      <Show when={plan().spacers}>
        <box height={1} />
      </Show>
      <box
        flexDirection="row"
        height={1}
        onMouseDown={(event) => {
          if (event.button === MouseButton.LEFT) props.onFocusField("note");
        }}
      >
        <FieldLabel field="note" text="Note" />
        <box width={CONTROL_GAP} />
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
      {/* The endpoint pair: To in the floor (the irreversible half), From
        directly under it with no air between — they answer one question. */}
      <EndpointRow label="To" endpoint={props.to} />
      <Show when={plan().source}>
        <EndpointRow label="From" endpoint={props.from} />
      </Show>

      <Show when={plan().buttons}>
        <box height={1} />
        {/* Confirm and Cancel, right-aligned in the macOS order the
          new-session dialog set: quiet Cancel left, the primary rightmost.
          Pure duplicates of Enter and Escape, so they are click affordances
          only and deliberately NOT Tab stops (Tab keeps toggling the
          fields). */}
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
              <strong>Send</strong>
            </text>
          </box>
        </box>
        <box height={1} />
      </Show>

      <Show when={plan().hint}>
        {/* The Footer's segments (`handoffDialogHintSegments`), confirm first
          and Escape last in the new-session hint row's order and colours; the
          middle is what a narrow surface gives up. */}
        <box flexDirection="row" height={1}>
          <box
            flexDirection="row"
            flexShrink={0}
            marginRight={1}
            onMouseDown={(event) => {
              if (event.button === MouseButton.LEFT) props.onSubmit();
            }}
          >
            <text fg={theme.green}>
              <strong>{handoffDialogHintSegments()[0]!.key}</strong>
            </text>
            <box width={1} />
            <text fg={theme.overlay}>
              {handoffDialogHintSegments()[0]!.gloss}
            </text>
          </box>
          <Show when={!compactHints()}>
            <box flexDirection="row" marginRight={1}>
              <text fg={theme.overlay}>
                {handoffDialogHintSegments()
                  .slice(1, -1)
                  .map((segment) => `· ${segment.key} ${segment.gloss}`)
                  .join(" ")}
              </text>
            </box>
          </Show>
          <box
            flexDirection="row"
            flexShrink={0}
            onMouseDown={(event) => {
              if (event.button === MouseButton.LEFT) props.onCancel();
            }}
          >
            <text fg={theme.overlay}>·</text>
            <box width={1} />
            <text fg={theme.red}>
              <strong>esc</strong>
            </text>
            <Show when={!compactHints()}>
              <box width={1} />
              <text fg={theme.overlay}>cancel</text>
            </Show>
          </box>
        </box>
      </Show>
    </box>
  );
};
