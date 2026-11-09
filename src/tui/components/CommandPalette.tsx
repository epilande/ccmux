import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { MouseButton } from "@opentui/core";
import type { PaletteMatch } from "../actions";
import { theme } from "../theme";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { displayWidth, padStartWidth, truncateText } from "../utils/format";
import { HighlightedText } from "./HighlightedText";
import { Text } from "./Text";

/** The widest the box gets: room for a long label, its section and a key,
 *  without stretching a 200-column terminal into a banner. */
const MAX_WIDTH = 72;
/** Rows above the box, so it sits near the top the way a command line does
 *  and the list it covers stays partly visible below. */
const TOP_GAP = 2;
/** Rows the frame spends on itself: two borders, the input row and the rule
 *  under it. */
const FRAME_ROWS = 4;
/** The most commands shown at once; the list windows past that. */
const MAX_ROWS = 14;
const GAP = 2;

interface CommandPaletteProps {
  query: string;
  matches: PaletteMatch[];
  /** The highlighted command's id; null lights the first row. */
  highlight: string | null;
  onQuery: (query: string) => void;
  /** Enter in the input. */
  onSubmit: () => void;
  /** A click on a row. */
  onRun: (id: string) => void;
}

/**
 * The index of the row Enter would run: the highlighted command's, or the
 * first row when nothing is highlighted (a fresh query) or the highlighted
 * command has been filtered out.
 */
export function paletteActiveIndex(
  matches: PaletteMatch[],
  highlight: string | null,
): number {
  const index = highlight
    ? matches.findIndex((m) => m.command.id === highlight)
    : -1;
  return index >= 0 ? index : 0;
}

/**
 * The first visible row of a `rows`-tall window over `count` rows that keeps
 * `active` in view, centred where it can be.
 */
export function paletteWindowStart(
  count: number,
  rows: number,
  active: number,
): number {
  if (count <= rows) return 0;
  const centred = active - Math.floor(rows / 2);
  return Math.max(0, Math.min(centred, count - rows));
}

/**
 * The `:` palette: a filter input over every action the current view offers,
 * each row its label (match highlighted), its section, and the key it stands
 * for, the way the row menu pairs `Fork  F`.
 *
 * Every string is fitted before it is drawn, since OpenTUI wraps rather than
 * clips. Keys are owned by App: it moves the highlight and runs on Enter,
 * and the `<input>` here sees only the text keys App leaves it.
 */
export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const dims = useSharedTerminalDimensions();
  const boxWidth = createMemo(() =>
    Math.max(20, Math.min(MAX_WIDTH, dims().width - 4)),
  );
  /** Inside the border and the one-column padding either side. */
  const inner = createMemo(() => boxWidth() - 4);
  const rows = createMemo(() =>
    Math.max(
      1,
      Math.min(
        MAX_ROWS,
        props.matches.length || 1,
        dims().height - TOP_GAP - FRAME_ROWS - 1,
      ),
    ),
  );
  const active = createMemo(() =>
    paletteActiveIndex(props.matches, props.highlight),
  );
  const visible = createMemo(() => {
    const start = paletteWindowStart(props.matches.length, rows(), active());
    return props.matches
      .slice(start, start + rows())
      .map((match, i) => ({ match, index: start + i }));
  });
  /** One width for the key column and one for the section column, sized
   *  once for the whole list so they line up as columns. */
  const keyWidth = createMemo(() =>
    Math.max(
      0,
      ...props.matches.map((m) => displayWidth(m.command.keys ?? "")),
    ),
  );
  const sectionWidth = createMemo(() =>
    Math.max(0, ...props.matches.map((m) => displayWidth(m.command.section))),
  );
  /** What the label may spend; the section yields before the label does. */
  const showSection = createMemo(
    () => inner() - keyWidth() - sectionWidth() - 2 * GAP >= 16,
  );
  const labelWidth = createMemo(() =>
    Math.max(
      1,
      inner() -
        keyWidth() -
        (keyWidth() ? GAP : 0) -
        (showSection() ? sectionWidth() + GAP : 0),
    ),
  );
  /** Match markup only survives a label that fits whole; a truncated one
   *  is drawn plain, since cutting through `<b>` tags would print them. */
  const label = (match: PaletteMatch) =>
    displayWidth(match.command.label) <= labelWidth()
      ? match.labelMarkup
      : truncateText(match.command.label, labelWidth());

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      alignItems="center"
      paddingTop={TOP_GAP}
    >
      <box
        width={boxWidth()}
        height={rows() + FRAME_ROWS}
        backgroundColor={theme.surface}
        borderStyle="single"
        borderColor={theme.border}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <box height={1} flexDirection="row" flexShrink={0}>
          <Text fg={theme.mauve} width={2}>
            :{" "}
          </Text>
          <input
            value={props.query}
            onInput={props.onQuery}
            onSubmit={props.onSubmit}
            focused
            placeholder="Type a command…"
            placeholderColor={theme.overlay}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.blue}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            width="100%"
          />
        </box>
        <box height={1} flexShrink={0}>
          <Text fg={theme.border}>{"─".repeat(inner())}</Text>
        </box>
        <Show
          when={props.matches.length > 0}
          fallback={
            <box height={1}>
              <Text fg={theme.subtext}>No matching commands</Text>
            </box>
          }
        >
          <For each={visible()}>
            {(row) => (
              <box
                height={1}
                flexShrink={0}
                flexDirection="row"
                backgroundColor={
                  row.index === active() ? theme.border : theme.surface
                }
                onMouseDown={(event) => {
                  if (event.button === MouseButton.LEFT)
                    props.onRun(row.match.command.id);
                }}
              >
                <box flexGrow={1}>
                  <HighlightedText
                    text={label(row.match)}
                    baseColor={theme.text}
                    highlightColor={theme.mauve}
                  />
                </box>
                <Show when={showSection()}>
                  <box paddingLeft={GAP} flexShrink={0}>
                    <Text fg={theme.subtext} wrapMode="none">
                      {padStartWidth(row.match.command.section, sectionWidth())}
                    </Text>
                  </box>
                </Show>
                <Show when={keyWidth() > 0}>
                  <box paddingLeft={GAP} flexShrink={0}>
                    <Text fg={theme.blue} wrapMode="none">
                      {padStartWidth(row.match.command.keys ?? "", keyWidth())}
                    </Text>
                  </box>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </box>
    </box>
  );
};
