import type { Component } from "solid-js";
import { createMemo } from "solid-js";
import { theme } from "../theme";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { displayWidth, truncateText } from "../utils/format";
import { GROUP_NAME_MAX_WIDTH } from "../utils/grouping";
import { Text } from "./Text";

/** The widest the box gets, matching the command palette it stands in for. */
const MAX_WIDTH = 72;
/** Rows above the box: the palette's, so the prompt opens where it does. */
const TOP_GAP = 2;
/** Title, input, rule and hint rows, plus the two borders. */
const HEIGHT = 6;

/** The hint line, longest first; the first that fits is drawn. */
const HINTS = [
  "enter rename · esc cancel · an existing name merges",
  "enter rename · esc cancel",
  "enter · esc",
];

interface RenamePromptProps {
  /** The group's current label, for the title. */
  label: string;
  /** The name being typed (prefilled with the label). */
  value: string;
  onInput: (value: string) => void;
  /** Enter in the input. */
  onSubmit: () => void;
}

/**
 * The rename prompt for a group header: one input, prefilled with the
 * group's name. It is the `:` palette's rename mode (same modal slot, same
 * place on screen), drawn on its own because it has no command list.
 *
 * Keys are owned by App: it commits on Enter and cancels on Esc, and the
 * `<input>` sees every other key, `j`/`k` included, as text. Every string is
 * fitted before it is drawn, since OpenTUI wraps rather than clips, and the
 * box narrows to a sidebar's width.
 */
export const RenamePrompt: Component<RenamePromptProps> = (props) => {
  const dims = useSharedTerminalDimensions();
  const boxWidth = createMemo(() =>
    Math.max(20, Math.min(MAX_WIDTH, dims().width - 4)),
  );
  /** Inside the border and the one-column padding either side. */
  const inner = createMemo(() => boxWidth() - 4);
  const label = createMemo(() =>
    truncateText(
      props.label,
      Math.max(1, inner() - displayWidth("Rename ") - displayWidth(" to:")),
    ),
  );
  const hint = createMemo(
    () =>
      HINTS.find((text) => displayWidth(text) <= inner()) ??
      truncateText(HINTS.at(-1)!, inner()),
  );

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
        height={HEIGHT}
        backgroundColor={theme.surface}
        borderStyle="single"
        borderColor={theme.border}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <box height={1} flexDirection="row" flexShrink={0}>
          <Text fg={theme.subtext} wrapMode="none">
            Rename{" "}
          </Text>
          <Text fg={theme.text} wrapMode="none">
            <b>{label()}</b>
          </Text>
          <Text fg={theme.subtext} wrapMode="none">
            {" "}
            to:
          </Text>
        </box>
        <box height={1} flexDirection="row" flexShrink={0}>
          <Text fg={theme.mauve} width={2}>
            ›{" "}
          </Text>
          <input
            value={props.value}
            onInput={props.onInput}
            onSubmit={props.onSubmit}
            focused
            maxLength={GROUP_NAME_MAX_WIDTH}
            placeholder="New name"
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
        <box height={1} flexShrink={0}>
          <Text fg={theme.overlay} wrapMode="none">
            {hint()}
          </Text>
        </box>
      </box>
    </box>
  );
};
