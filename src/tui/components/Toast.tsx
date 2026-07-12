import type { Component } from "solid-js";
import { theme } from "../theme";

interface ToastProps {
  message: string;
}

// Cap the card width so a long message wraps inside the pill instead of
// stretching across the whole terminal. Sized to sit inside even a narrow
// (50-col) viewport once the right anchor, border, and padding are counted.
const MAX_WIDTH = 40;

/**
 * Transient feedback pill floating in the top-right corner, macOS
 * notification style. Absolutely positioned so showing/hiding it never
 * reflows the layout underneath. Short messages shrink to fit; a long one
 * grows to MAX_WIDTH and then word-wraps, growing the card downward.
 */
export const Toast: Component<ToastProps> = (props) => (
  <box
    position="absolute"
    top={1}
    right={1}
    maxWidth={MAX_WIDTH}
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
