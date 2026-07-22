import type { Component } from "solid-js";
import type { ConnectionState } from "../utils/sse";
import { theme } from "../theme";

interface HeaderProps {
  sessionCount: number;
  totalCount?: number;
  hideIdle?: boolean;
  connectionState: ConnectionState;
  /** Daemon scans have been failing long enough to serve stale state
   *  (issue #46); surfaces a warning segment when true. */
  daemonDegraded?: boolean;
  dimmed?: boolean;
  /** Count of `ccmux invoke` workers currently in flight (Claude +
   *  subprocess). Shown only when nonzero. */
  invokeInFlight?: number;
}

/** Connection-dot color by state. A function (not a module const) so it reads
 * the live `theme` after `applyTheme` instead of freezing the default palette
 * at import time. */
export function dotColor(state: ConnectionState): string {
  const colors: Record<ConnectionState, string> = {
    connected: theme.green,
    reconnecting: theme.yellow,
    disconnected: theme.red,
  };
  return colors[state];
}

export const Header: Component<HeaderProps> = (props) => {
  const c = (color?: string) => (props.dimmed ? theme.border : color);
  return (
    <box width="100%" height={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" width="100%">
        <text fg={c(dotColor(props.connectionState))}>● </text>
        <text fg={c(undefined)}>
          <b>Sessions</b>
        </text>
        <text fg={c(theme.overlay)}>
          {" "}
          ({props.sessionCount}
          {props.totalCount != null ? `/${props.totalCount}` : ""})
        </text>
        {props.hideIdle && <text fg={c(theme.yellow)}> [active]</text>}
        {props.invokeInFlight ? (
          <text fg={c(theme.peach)}> · {props.invokeInFlight} invoking</text>
        ) : null}
        {props.daemonDegraded ? (
          <text fg={c(theme.yellow)}> ⚠ daemon degraded: scans failing</text>
        ) : null}
      </box>
    </box>
  );
};
