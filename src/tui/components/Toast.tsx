import type { Component } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { theme } from "../theme";

interface ToastProps {
  message: string;
}

// Cap the card width so a long message wraps inside the pill instead of
// stretching across the whole terminal.
const MAX_WIDTH = 40;

/**
 * Transient feedback pill floating in the top-right corner, macOS
 * notification style. Absolutely positioned so showing/hiding it never
 * reflows the layout underneath. Short messages shrink to fit; a long one
 * grows to MAX_WIDTH and then word-wraps, growing the card downward.
 *
 * The width is also clamped to the viewport so the right-anchored card never
 * overflows past the left edge. It renders in every mode, including the
 * narrow default sidebar (30 cols), where a fixed 40-wide card would clip its
 * border and the leading characters of the message off the terminal.
 */
export const Toast: Component<ToastProps> = (props) => {
  const dims = useTerminalDimensions();
  // Leave a 1-col gap on each side of the right-anchored card. The card is
  // border-box sized, so this is its full outer width including border+padding.
  const width = () => Math.min(MAX_WIDTH, Math.max(1, dims().width - 2));

  return (
    <box
      position="absolute"
      top={1}
      right={1}
      maxWidth={width()}
      backgroundColor={theme.surface}
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* width 100% lets a long message word-wrap within the capped box; the
          box itself still shrinks to fit a short message. */}
      <text fg={theme.subtext} width="100%">
        {props.message}
      </text>
    </box>
  );
};
