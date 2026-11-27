import type { Component, JSX } from "solid-js";
import { theme } from "../theme";

/**
 * Columns a preview may draw a line in: its share of the terminal, less the
 * left border and the padding either side. Every preview fits its header
 * strings to this before drawing them, since OpenTUI wraps rather than
 * clips.
 */
export function previewContentWidth(
  terminalWidth: number,
  percent: number,
): number {
  return Math.max(1, Math.floor((terminalWidth * percent) / 100) - 3);
}

/**
 * The frame every view's preview sits in: a left rule, mauve while the
 * preview has focus, one column of padding each side, and `width` percent
 * of the row it shares with its list.
 */
export const PreviewFrame: Component<{
  width: number;
  focused?: boolean;
  children: JSX.Element;
}> = (props) => (
  <box
    flexDirection="column"
    width={`${props.width}%`}
    height="100%"
    flexShrink={0}
    border={["left"]}
    borderStyle="single"
    borderColor={props.focused ? theme.mauve : theme.border}
    paddingLeft={1}
    paddingRight={1}
  >
    {props.children}
  </box>
);
