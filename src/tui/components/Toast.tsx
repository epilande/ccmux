import type { Component } from "solid-js";
import { theme } from "../theme";

interface ToastProps {
  message: string;
}

/**
 * Transient feedback pill floating in the top-right corner, macOS
 * notification style. Absolutely positioned so showing/hiding it never
 * reflows the layout underneath.
 */
export const Toast: Component<ToastProps> = (props) => (
  <box
    position="absolute"
    top={1}
    left={0}
    width="100%"
    height={3}
    flexDirection="row"
    justifyContent="flex-end"
    paddingRight={1}
  >
    <box
      maxWidth="100%"
      backgroundColor={theme.surface}
      borderStyle="single"
      borderColor={theme.overlay}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.text}>{props.message}</text>
    </box>
  </box>
);
