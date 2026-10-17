import type { Component } from "solid-js";
import type { AttentionType, SessionStatus } from "../../types";
import type { IconStyle } from "../../lib/icons";
import type { StatusMode } from "../../lib/preferences";
import { getBackgroundIcon } from "../../lib/icons";
import { getStatusColor } from "./StatusBadge";
import { theme } from "../theme";
import { Text } from "./Text";

interface BackgroundStatusBadgeProps {
  status: SessionStatus;
  attentionType?: AttentionType;
  iconStyle?: IconStyle;
  mode?: StatusMode;
  dimmed?: boolean;
}

/**
 * Status badge for a Claude background (background-agent) row, distinct from
 * the normal `StatusBadge`: a static diamond-family glyph (no spinner, since
 * background state updates at turn boundaries) marks it as a background row,
 * while color stays subtype-aware via the shared `getStatusColor` (red
 * waiting / teal plan approval, peach working, dim idle). Mirrors the
 * `InvokeStatusBadge` precedent for paneless rows.
 */
export const BackgroundStatusBadge: Component<BackgroundStatusBadgeProps> = (
  props,
) => {
  const icon = () => getBackgroundIcon(props.status, props.iconStyle ?? "dot");
  const color = () => getStatusColor(props.status, props.attentionType ?? null);
  const label = () => {
    const mode = props.mode ?? "full";
    if (mode === "icon") return icon();
    const text = props.status;
    return `${icon()} ${mode === "short" ? text.slice(0, 4) : text.padEnd(7)}`;
  };
  return <Text fg={props.dimmed ? theme.border : color()}>{label()}</Text>;
};
