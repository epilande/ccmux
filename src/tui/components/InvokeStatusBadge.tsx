import type { Component } from "solid-js";
import type { IconStyle } from "../../lib/icons";
import type { StatusMode } from "../../lib/preferences";
import type { InvocationStatus } from "../../types";
import { getInvokeTerminalIcon } from "../../lib/icons";
import { useStatusIcon } from "../utils/useStatusIcon";
import { theme } from "../theme";
import { Text } from "./Text";

/** Lifecycle state of a client-synthesized subprocess invoke row. Alias of
 *  the shared {@link InvocationStatus}. */
export type InvokeStatus = InvocationStatus;

interface InvokeStatusBadgeProps {
  status: InvokeStatus;
  iconStyle?: IconStyle;
  mode?: StatusMode;
  dimmed?: boolean;
}

/** Badge color by invoke status. A function (not a module const) so it reads
 * the live `theme` after `applyTheme` instead of freezing the default palette
 * at import time. */
export function invokeColor(status: InvokeStatus): string {
  const colors: Record<InvokeStatus, string> = {
    running: theme.peach,
    succeeded: theme.green,
    failed: theme.red,
    cancelled: theme.overlay,
  };
  return colors[status];
}

const INVOKE_LABELS: Record<InvokeStatus, string> = {
  // "working" matches a normal active session's label (the underlying status
  // enum stays "running" for daemon/SSE/CLI parity; only the badge text is
  // unified). Terminal states keep their invoke-specific labels.
  running: "working",
  succeeded: "done",
  failed: "failed",
  cancelled: "cancel",
};

/**
 * Status badge for an invoke-driven worker row, distinct from the normal
 * `StatusBadge`: running reuses the shared animated "working" spinner (so a
 * live worker pulses), and terminal states show a static success/failure
 * glyph in green/red/dim. The board fabricates these rows for paneless
 * subprocess invokes (codex/cursor/opencode/gemini).
 */
export const InvokeStatusBadge: Component<InvokeStatusBadgeProps> = (props) => {
  // Drive useStatusIcon with the live status (not a hardcoded "working") so a
  // terminal row releases the shared spinner the moment it flips: "working"
  // is the only animated status, so a non-running status leaves isAnimated()
  // false and the spinner ref/interval is dropped through its ~6s linger.
  const runningIcon = useStatusIcon(
    () => (props.status === "running" ? "working" : "idle"),
    () => null,
    () => props.iconStyle,
  );
  const icon = () =>
    props.status === "running"
      ? runningIcon()
      : getInvokeTerminalIcon(props.status, props.iconStyle ?? "dot");
  const color = () => invokeColor(props.status);
  const label = () => {
    const mode = props.mode ?? "full";
    if (mode === "icon") return icon();
    const text = INVOKE_LABELS[props.status];
    return `${icon()} ${mode === "short" ? text.slice(0, 4) : text.padEnd(7)}`;
  };
  return <Text fg={props.dimmed ? theme.border : color()}>{label()}</Text>;
};
