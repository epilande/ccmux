import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { MouseButton } from "@opentui/core";
import type { SpawnableAgent } from "../../lib/spawnable-agents";
import {
  NEW_SESSION_FIELDS,
  type NewSessionDraft,
  type NewSessionField,
  type NewSessionPlacement,
} from "../store";
import { shortenCwd, truncateText } from "../utils/format";
import { agentColorFor } from "./SessionItem";
import { theme } from "../theme";

/** Width of the label gutter ("Placement" is the longest label). */
const LABEL_WIDTH = 10;
/** Wide enough for the placement row's full labels; see COMPACT_CONTENT_WIDTH. */
const MAX_WIDTH = 64;
const MIN_WIDTH = 24;
/** Rows that belong to no field: border (2), title, blank, directory. Every
 *  other row is a field's, counted from NEW_SESSION_FIELDS below. */
const FIXED_CHROME_ROWS = 5;
/** The blank spacer plus the key-hint row, when the dialog draws its own. */
const KEY_HINT_ROWS = 2;
/** Content width the placement row's full labels need (number, brackets,
 *  and gaps included). Below it the row switches to the short labels and
 *  the key-hint line drops its middle segment. */
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
   * type, which is the point: a field added to `NEW_SESSION_FIELDS` (issue
   * #69's worktree destination is next) fails to compile until its height
   * is declared here. The previous hand-summed constant type-checked fine
   * and silently clipped the bottom row instead.
   */
  const fieldRows: Record<NewSessionField, () => number> = {
    // Declared before `visibleAgents` but never CALLED before it exists:
    // `otherFieldRows("agent")` is the only caller during that window and
    // it filters this entry out. createMemo runs eagerly, so the ordering
    // is load-bearing, not stylistic.
    agent: () => Math.max(1, visibleAgents().length),
    placement: () => (stacked() ? PLACEMENT_OPTIONS.length : 1),
    prompt: () => 1,
  };

  /** Rows claimed by every field but `except`. Lets the scrollable agent
   *  list size itself without consulting its own (circular) row count. */
  const otherFieldRows = (except: NewSessionField): number =>
    NEW_SESSION_FIELDS.filter((field) => field !== except).reduce(
      (total, field) => total + fieldRows[field](),
      0,
    );

  /** The agent list is the only field that can grow past a screen; cap it at
   *  what every other row has left over, and scroll the rest. */
  const visibleAgents = createMemo(() => {
    const list = agents();
    const room = Math.max(
      1,
      dims().height - FIXED_CHROME_ROWS - hintRows() - otherFieldRows("agent"),
    );
    const { start, end } = optionWindow(
      list.length,
      selectedAgentIndex(),
      Math.min(room, list.length),
    );
    return list.slice(start, end).map((agent, offset) => ({
      agent,
      /** Absolute position, so the number key shown is the one that picks it. */
      index: start + offset,
    }));
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

  const labelColor = (field: NewSessionField) =>
    props.draft.field === field ? theme.blue : theme.overlay;

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
        <box width={LABEL_WIDTH}>
          <text fg={labelColor("agent")}>Agent</text>
        </box>
        <box flexDirection="column" flexGrow={1}>
          <Show
            when={props.agents !== null}
            fallback={<text fg={theme.overlay}>Loading agents...</text>}
          >
            <Show
              when={agents().length > 0}
              fallback={
                <text fg={theme.red}>
                  {props.agentsError ?? "No agents found on PATH"}
                </text>
              }
            >
              <For each={visibleAgents()}>
                {(entry) => (
                  <box
                    height={1}
                    flexDirection="row"
                    onMouseDown={(event) => {
                      if (event.button !== MouseButton.LEFT) return;
                      props.onFocusField("agent");
                      props.onSelectAgent(entry.agent.name);
                    }}
                  >
                    <box width={2}>
                      <text fg={theme.green}>
                        {entry.agent.name === props.draft.agent ? ">" : ""}
                      </text>
                    </box>
                    {/* Only the first nine get a number key. */}
                    <box width={2}>
                      <text fg={theme.overlay}>
                        {entry.index < 9 ? `${entry.index + 1}` : ""}
                      </text>
                    </box>
                    <text fg={agentColorFor(entry.agent.name)}>
                      {entry.agent.displayName}
                    </text>
                  </box>
                )}
              </For>
            </Show>
          </Show>
        </box>
      </box>

      <box flexDirection="row">
        <box width={LABEL_WIDTH} height={1}>
          <text fg={labelColor("placement")}>Placement</text>
        </box>
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
                    {/* Stacked has a row to itself, so it can afford the full
                        label even though it is the narrowest surface. */}
                    {compact() && !stacked()
                      ? option.compactLabel
                      : option.label}
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
        <box width={LABEL_WIDTH}>
          <text fg={labelColor("prompt")}>Prompt</text>
        </box>
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

      <box flexDirection="row" height={1}>
        <box width={LABEL_WIDTH}>
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
            <box width={1} />
            <text fg={theme.overlay}>cancel</text>
          </box>
        </box>
      </Show>
    </box>
  );
};
