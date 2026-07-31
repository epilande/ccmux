import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton } from "@opentui/core";
import type { SpawnableAgent } from "../../lib/spawnable-agents";
import {
  NEW_SESSION_FIELDS,
  type NewSessionDestination,
  type NewSessionDraft,
  type NewSessionField,
  type NewSessionPlacement,
} from "../store";
import { slugFromPrompt } from "../../daemon/worktree-create";
import { shortenCwd, truncateText } from "../utils/format";
import { agentColorFor } from "./SessionItem";
import { theme } from "../theme";

/** Width of the label gutter: focus marker (1) + "Placement" (9, the
 *  longest label) + one column of air before the content. */
const LABEL_WIDTH = 11;
/** Wide enough for the placement row's full labels; see COMPACT_CONTENT_WIDTH. */
const MAX_WIDTH = 65;
const MIN_WIDTH = 24;
/** Rows that belong to no field: border (2), title, blank, directory. Every
 *  other row is a field's, counted from NEW_SESSION_FIELDS below. */
const FIXED_CHROME_ROWS = 5;
/** The blank spacer plus the key-hint row, when the dialog draws its own. */
const KEY_HINT_ROWS = 2;
/** Content width the placement row's full labels need (number, brackets,
 *  and gaps included). Below it the row switches to the short labels and
 *  the key-hint line drops its middle segment. MAX_WIDTH is sized to leave
 *  exactly this much. */
const COMPACT_CONTENT_WIDTH = 49;
/** Content width the placement row needs even with the short labels. Below
 *  it the options stack vertically, which is the sidebar's 30-column rail:
 *  clipping the row would hide two of the three choices entirely. */
const STACKED_CONTENT_WIDTH = 33;

interface PlacementOption {
  value: NewSessionPlacement;
  label: string;
  compactLabel: string;
}

/** Placement choices, in the order their number keys select them. */
export const PLACEMENT_OPTIONS: readonly PlacementOption[] = [
  { value: "window", label: "New window", compactLabel: "Window" },
  { value: "split-h", label: "Split right", compactLabel: "Right" },
  { value: "split-v", label: "Split down", compactLabel: "Down" },
];

interface DestinationOption {
  value: NewSessionDestination;
  label: string;
  compactLabel: string;
}

/** Destination choices, in the order their number keys select them. */
export const DESTINATION_OPTIONS: readonly DestinationOption[] = [
  { value: "here", label: "This checkout", compactLabel: "Here" },
  { value: "worktree", label: "New worktree", compactLabel: "Worktree" },
];

/**
 * Greedy word-wrap into lines of at most `width` columns, breaking a word
 * that cannot fit on a line of its own.
 *
 * The dialog wraps its agent error itself rather than handing a long string
 * to the renderer, because the height budget below has to know the row count
 * BEFORE layout and the renderer's own wrapping cannot be predicted from
 * here (it breaks mid-word at the tail of a line, and a space landing on the
 * boundary moves to the next row). Lines produced here already fit, so
 * nothing can wrap a second time and the budget cannot be wrong.
 *
 * Widths are UTF-16 code units, not display columns, so a line of wide
 * glyphs (CJK) over-fills its column — the same limitation `truncateText`
 * has, tracked in issue #91, whose real fix is a shared display-width helper.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    // Longer than the whole column: it can only be broken mid-word.
    while (rest.length > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    if (!line) line = rest;
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`;
    else {
      lines.push(line);
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
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

interface NewSessionDialogProps {
  draft: NewSessionDraft;
  /** Spawnable agents, or null while `GET /agents` is still in flight. */
  agents: SpawnableAgent[] | null;
  agentsError?: string | null;
  onFocusField: (field: NewSessionField) => void;
  onSelectAgent: (name: string) => void;
  onSelectPlacement: (placement: NewSessionPlacement) => void;
  onSelectDestination: (destination: NewSessionDestination) => void;
  onPromptInput: (prompt: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  /**
   * Draw the dialog's own key-hint row. The picker's Footer switches to a
   * near-identical line whenever this dialog is open, and showing both puts
   * the same hints on screen twice; the footer wins there because that is
   * where the picker's hints always live. The sidebar has no footer at all,
   * so its dialog carries the row itself.
   */
  showKeyHints?: boolean;
}

export const NewSessionDialog: Component<NewSessionDialogProps> = (props) => {
  const dims = useTerminalDimensions();

  const width = () =>
    Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dims().width - 4));
  const contentWidth = () => Math.max(1, width() - LABEL_WIDTH - 4);
  const compact = () => contentWidth() < COMPACT_CONTENT_WIDTH;
  const stacked = () => contentWidth() < STACKED_CONTENT_WIDTH;

  /**
   * The label to draw for a numbered option, shared by Placement and Where.
   *
   * Stacking gives each option its own row, but a row is not unlimited: at
   * the sidebar's real 30-column rail the dialog is 26 wide and the label
   * column is 8, which renders `New window` / `Split right` / `Split down`
   * as `New` / `Split` / `Split` — two of the three indistinguishable, and
   * `This checkout` / `New worktree` the same way. The full label is
   * therefore used only when it actually fits, and the short label (which
   * exists for exactly this) is the fallback in both layouts.
   */
  const optionLabel = (option: {
    label: string;
    compactLabel: string;
  }): string => {
    // The row also spends a 2-wide number cell and two 1-wide bracket cells.
    const room = contentWidth() - 4;
    if (!stacked()) return compact() ? option.compactLabel : option.label;
    return option.label.length <= room ? option.label : option.compactLabel;
  };

  const showKeyHints = () => props.showKeyHints !== false;
  const hintRows = () => (showKeyHints() ? KEY_HINT_ROWS : 0);

  const agents = createMemo(() => props.agents ?? []);
  const selectedAgentIndex = createMemo(() => {
    const index = agents().findIndex((a) => a.name === props.draft.agent);
    return index >= 0 ? index : 0;
  });
  const selectedAgent = createMemo(
    () => agents()[selectedAgentIndex()] ?? null,
  );

  /**
   * How many rows each field occupies. Exhaustive over `NewSessionField` by
   * type, which is the point: a field added to `NEW_SESSION_FIELDS` fails to
   * compile until its height is declared here. The previous hand-summed
   * constant type-checked fine and silently clipped the bottom row instead.
   */
  const fieldRows: Record<NewSessionField, () => number> = {
    // Declared before `visibleAgents` and `agentErrorLines` but never CALLED
    // before they exist: `otherFieldRows("agent")` is the only caller during
    // that window and it filters this entry out. createMemo runs eagerly, so
    // the ordering is load-bearing, not stylistic.
    agent: () =>
      showAgentError()
        ? agentErrorLines().length
        : Math.max(1, visibleAgents().length),
    placement: () => (stacked() ? PLACEMENT_OPTIONS.length : 1),
    destination: () => (stacked() ? DESTINATION_OPTIONS.length : 1),
    prompt: () => 1,
  };

  /** Rows claimed by every field but `except`. Lets the scrollable agent
   *  list size itself without consulting its own (circular) row count. */
  const otherFieldRows = (except: NewSessionField): number =>
    NEW_SESSION_FIELDS.filter((field) => field !== except).reduce(
      (total, field) => total + fieldRows[field](),
      0,
    );

  /** Rows the agent field may claim before the dialog outgrows the screen:
   *  everything the other fields and the chrome have not already spent. */
  const agentRoom = createMemo(() =>
    Math.max(
      1,
      dims().height - FIXED_CHROME_ROWS - hintRows() - otherFieldRows("agent"),
    ),
  );

  /** Where the visible slice of the agent list starts. Split from the slice
   *  itself so the rows can derive their absolute number from it without the
   *  slice having to carry a wrapper object per entry (see below). */
  const agentWindowStart = createMemo(() => {
    const list = agents();
    return optionWindow(
      list.length,
      selectedAgentIndex(),
      Math.min(agentRoom(), list.length),
    ).start;
  });

  /**
   * The agent list is the only field that can grow past a screen; cap it at
   * what every other row has left over, and scroll the rest.
   *
   * Returns the raw slice, NOT `{agent, index}` wrappers. `<For>` is keyed by
   * reference, so freshly minted wrappers made every visible row tear down
   * and rebuild on each j/k; the underlying agent objects are stable, so
   * slicing them directly lets it reuse the rows and move only the marker.
   */
  const visibleAgents = createMemo(() => {
    const list = agents();
    const start = agentWindowStart();
    return list.slice(start, start + Math.min(agentRoom(), list.length));
  });

  /** The agent field carries an error instead of a list: the daemon answered
   *  with one, or answered with nothing to spawn. */
  const showAgentError = () => props.agents !== null && agents().length === 0;

  /**
   * The agent error, pre-wrapped to the content column and capped at the rows
   * the field actually has. Budgeting this field as one row was what clipped
   * the dialog's bottom rows outside its border whenever the message wrapped
   * (issue #85) — the stale-daemon message is three rows at a sidebar width.
   * Capping matters too: an error longer than the screen would otherwise push
   * the height past `dims().height`, where the clamp below re-creates exactly
   * the same clipping.
   */
  const agentErrorLines = createMemo(() => {
    // `||`, not `??`: the daemon's own error text is passed straight through
    // (App.tsx takes `body?.error` at its word), and a `{"error": ""}` body
    // would otherwise render an empty red row that says nothing at all.
    const text = props.agentsError || "No agents found on PATH";
    const lines = wrapText(text, contentWidth());
    const room = agentRoom();
    if (lines.length <= room) return lines;
    // Say that it was cut, rather than ending mid-sentence: the last visible
    // row carries as much of the remainder as fits, with an ellipsis.
    const kept = lines.slice(0, room);
    kept[room - 1] = truncateText(
      lines.slice(room - 1).join(" "),
      contentWidth(),
    );
    return kept;
  });

  const height = () =>
    Math.min(
      dims().height,
      FIXED_CHROME_ROWS +
        hintRows() +
        NEW_SESSION_FIELDS.reduce(
          (total, field) => total + fieldRows[field](),
          0,
        ),
    );

  /**
   * A field's label cell, carrying a one-character focus marker.
   *
   * Colour alone is not enough here: the number keys are scoped to the
   * FOCUSED field, so a viewer who can't tell which label is highlighted
   * can press `2` believing they are on Agent, get "Split right", and spawn
   * with no confirmation step. The selections themselves already use
   * colour-safe markers (`>` and `[brackets]`); this closes the last one.
   *
   * Marker (1) plus label cell (the rest of the gutter) is exactly the
   * width the content column is measured against, so nothing reflows.
   */
  const FieldLabel: Component<{ field: NewSessionField; text: string }> = (
    labelProps,
  ) => {
    const focused = () => props.draft.field === labelProps.field;
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

  const cwdLabel = () =>
    truncateText(shortenCwd(props.draft.cwd), contentWidth());

  /** Says whether this agent can take a prompt at all, which is per-agent
   *  and not otherwise discoverable. Shortened on a narrow surface, where
   *  the full sentence would run past the border. */
  const promptPlaceholder = () => {
    const agent = selectedAgent();
    let text: string;
    if (agent && !agent.supportsPrompt) {
      text = stacked()
        ? "no prompt support"
        : `${agent.displayName} can't start with a prompt`;
    } else {
      text = stacked() ? "Optional prompt..." : "Optional first message...";
    }
    // The input draws its placeholder in full, past its own box, so the
    // fit has to be enforced here rather than left to the layout.
    return truncateText(text, contentWidth());
  };

  return (
    <box
      position="absolute"
      top="50%"
      left="50%"
      width={width()}
      height={height()}
      marginTop={-Math.floor(height() / 2)}
      marginLeft={-Math.floor(width() / 2)}
      backgroundColor={theme.base}
      borderStyle="single"
      borderColor={theme.border}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1}>
        <text fg={theme.text}>
          <strong>New session</strong>
        </text>
      </box>
      <box height={1} />

      <box flexDirection="row">
        <FieldLabel field="agent" text="Agent" />
        <box flexDirection="column" flexGrow={1}>
          <Show
            when={props.agents !== null}
            fallback={
              <box height={1}>
                <text fg={theme.overlay}>
                  {truncateText("Loading agents...", contentWidth())}
                </text>
              </box>
            }
          >
            <Show
              when={agents().length > 0}
              fallback={
                /* One row per pre-wrapped line, which is the same count the
                   height was budgeted from. Left to the renderer instead,
                   a long message wrapped past its single budgeted row and
                   pushed the dialog's last rows outside the border. */
                <For each={agentErrorLines()}>
                  {(line) => (
                    <box height={1}>
                      <text fg={theme.red}>{line}</text>
                    </box>
                  )}
                </For>
              }
            >
              <For each={visibleAgents()}>
                {(agent, i) => {
                  /** Absolute position, so the number key shown is the one
                   *  that picks it even when the list has scrolled. */
                  const number = () => agentWindowStart() + i() + 1;
                  return (
                    <box
                      height={1}
                      flexDirection="row"
                      onMouseDown={(event) => {
                        if (event.button !== MouseButton.LEFT) return;
                        props.onFocusField("agent");
                        props.onSelectAgent(agent.name);
                      }}
                    >
                      <box width={2}>
                        <text fg={theme.green}>
                          {agent.name === props.draft.agent ? ">" : ""}
                        </text>
                      </box>
                      {/* Only the first nine get a number key. */}
                      <box width={2}>
                        <text fg={theme.overlay}>
                          {number() <= 9 ? `${number()}` : ""}
                        </text>
                      </box>
                      <text fg={agentColorFor(agent.name)}>
                        {agent.displayName}
                      </text>
                    </box>
                  );
                }}
              </For>
            </Show>
          </Show>
        </box>
      </box>

      <box flexDirection="row">
        <FieldLabel field="placement" text="Placement" />
        <box
          flexDirection={stacked() ? "column" : "row"}
          flexGrow={1}
          onMouseDown={() => props.onFocusField("placement")}
        >
          <For each={PLACEMENT_OPTIONS}>
            {(option, index) => {
              const selected = () => option.value === props.draft.placement;
              return (
                <box
                  height={1}
                  flexDirection="row"
                  flexShrink={0}
                  marginRight={stacked() ? 0 : 2}
                  onMouseDown={(event) => {
                    if (event.button !== MouseButton.LEFT) return;
                    props.onFocusField("placement");
                    props.onSelectPlacement(option.value);
                  }}
                >
                  {/* Spacing comes from box widths and margins, never from
                      padded strings: a `<text>` is measured on its trimmed
                      content, so trailing spaces collapse under flex. */}
                  <box width={2}>
                    <text fg={theme.overlay}>{`${index() + 1}`}</text>
                  </box>
                  {/* Brackets, not colour alone: the placements have no
                      selection gutter of their own. Each bracket gets a
                      fixed-width box so choosing an option never reflows the
                      row, and so the marker survives a colourless terminal. */}
                  <box width={1}>
                    <text fg={theme.green}>{selected() ? "[" : ""}</text>
                  </box>
                  <text fg={selected() ? theme.green : theme.subtext}>
                    {optionLabel(option)}
                  </text>
                  <box width={1}>
                    <text fg={theme.green}>{selected() ? "]" : ""}</text>
                  </box>
                </box>
              );
            }}
          </For>
        </box>
      </box>

      <box flexDirection="row" height={1}>
        <FieldLabel field="prompt" text="Prompt" />
        <input
          value={props.draft.prompt}
          onInput={props.onPromptInput}
          focused={props.draft.field === "prompt"}
          placeholder={promptPlaceholder()}
          placeholderColor={theme.overlay}
          textColor={theme.text}
          cursorColor={theme.blue}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          flexGrow={1}
        />
      </box>

      <box flexDirection="row">
        <FieldLabel field="destination" text="Where" />
        <box
          flexDirection={stacked() ? "column" : "row"}
          flexGrow={1}
          onMouseDown={() => props.onFocusField("destination")}
        >
          <For each={DESTINATION_OPTIONS}>
            {(option, index) => {
              const selected = () => option.value === props.draft.destination;
              /* The worktree option carries the name it would create, so the
                 choice is concrete rather than a promise. It tracks the
                 prompt as it is typed, which is also the answer to "where
                 did that branch name come from". */
              const label = () => {
                const base = optionLabel(option);
                if (option.value !== "worktree") return base;
                // Budgeted, not appended blindly: a long prompt yields a long
                // slug, and on one row that pushed the dialog's own right
                // border off screen. Each option spends a 2-wide number cell
                // and two 1-wide brackets, and when side by side the first
                // option also spends its label and a 2-wide margin.
                const spent = stacked()
                  ? 4
                  : 8 + optionLabel(DESTINATION_OPTIONS[0]!).length + 2;
                const room = contentWidth() - spent;
                const slug = slugFromPrompt(props.draft.prompt);
                if (!slug) {
                  // A worktree is named by the prompt and nothing else, so
                  // with no derivable name this option cannot spawn. Say so
                  // while the choice is being made rather than on Enter, and
                  // only while it is the choice: on the unselected row the
                  // hint is noise. Appended only when it fits whole, since a
                  // truncated `Worktree (a...` explains nothing.
                  if (!selected()) return base;
                  const hinted = `${base} (add a prompt)`;
                  return hinted.length <= room ? hinted : base;
                }
                return truncateText(
                  `${base}: ${slug}`,
                  Math.max(base.length, room),
                );
              };
              return (
                <box
                  height={1}
                  flexDirection="row"
                  flexShrink={0}
                  marginRight={stacked() ? 0 : 2}
                  onMouseDown={(event) => {
                    if (event.button !== MouseButton.LEFT) return;
                    props.onFocusField("destination");
                    props.onSelectDestination(option.value);
                  }}
                >
                  <box width={2}>
                    <text fg={theme.overlay}>{`${index() + 1}`}</text>
                  </box>
                  <box width={1}>
                    <text fg={theme.green}>{selected() ? "[" : ""}</text>
                  </box>
                  <text fg={selected() ? theme.green : theme.subtext}>
                    {label()}
                  </text>
                  <box width={1}>
                    <text fg={theme.green}>{selected() ? "]" : ""}</text>
                  </box>
                </box>
              );
            }}
          </For>
        </box>
      </box>

      <box flexDirection="row" height={1}>
        {/* Not a field: derived, never focused, so it only pads past the
            marker column to stay aligned with the labels above. */}
        <box width={LABEL_WIDTH} paddingLeft={1}>
          <text fg={theme.overlay}>Directory</text>
        </box>
        <text fg={theme.subtext}>{cwdLabel()}</text>
      </box>

      <Show when={showKeyHints()}>
        <box height={1} />
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
              <strong>enter</strong>
            </text>
            <box width={1} />
            <text fg={theme.overlay}>spawn</text>
          </box>
          {/* The middle hint is the one that goes when there is no room for
              it: the two it sits between are the dialog's only exits. */}
          <Show when={!compact()}>
            <box flexDirection="row" marginRight={1}>
              <text fg={theme.overlay}>· tab field · j/k or 1-9 pick</text>
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
            {/* At the real 30-column rail even this two-hint line overruns
                the border; Esc needs no gloss, so its word is what goes. */}
            <Show when={!stacked()}>
              <box width={1} />
              <text fg={theme.overlay}>cancel</text>
            </Show>
          </box>
        </box>
      </Show>
    </box>
  );
};
