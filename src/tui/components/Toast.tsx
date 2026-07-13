import type { Component } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { theme } from "../theme";

interface ToastProps {
  message: string;
}

const MAX_WIDTH = 40;

/**
 * Transient feedback pill floating in the top-right corner, macOS notification
 * style. Absolutely positioned so showing/hiding it never reflows the layout.
 * A long message wraps and grows the card downward; a short one shrinks to fit.
 * The width is clamped to the viewport so the right-anchored card never clips
 * off the left edge in a narrow pane (e.g. the 30-col default sidebar).
 */
export const Toast: Component<ToastProps> = (props) => {
  const dims = useTerminalDimensions();
  // Border-box width, capped and clamped to leave a 1-col gap on each side.
  const width = () => Math.min(MAX_WIDTH, Math.max(1, dims().width - 2));

  return (
    <box
      position="absolute"
      top={1}
      right={1}
      zIndex={1} // paint above every other overlay, whatever the sibling order
      maxWidth={width()}
      backgroundColor={theme.surface}
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* width 100% wraps a long message; the box still shrinks to a short one. */}
      <text fg={theme.subtext} width="100%">
        {props.message}
      </text>
    </box>
  );
};
