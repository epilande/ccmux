import type { Component } from "solid-js";
import { createMemo, Show } from "solid-js";
import { WAITING_SUBTYPES, computeStatusSummary } from "../utils/grouping";
import type { FilteredSession, StatusSummary } from "../utils/grouping";
import type { IconStyle } from "../../lib/icons";
import { getStatusIcon } from "../../lib/icons";
import { getStatusColor } from "./StatusBadge";
import { useStatusIcon } from "../utils/useStatusIcon";
import { MouseButton, type MouseEvent } from "@opentui/core";
import { theme } from "../theme";

interface GroupHeaderProps {
  label: string;
  count: number;
  collapsed: boolean;
  selected: boolean;
  members: FilteredSession[];
  iconStyle?: IconStyle;
  dimmed?: boolean;
  onActivate?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}

function staticDots(
  summary: StatusSummary,
  iconStyle: IconStyle | undefined,
  dimmed: boolean | undefined,
): Array<{ icon: string; count: number; color: string }> {
  const dots: Array<{ icon: string; count: number; color: string }> = [];
  const c = (color: string) => (dimmed ? theme.border : color);

  for (const { key, attention } of WAITING_SUBTYPES) {
    const count = summary[key];
    if (count > 0) {
      dots.push({
        icon: getStatusIcon("waiting", attention, iconStyle),
        count,
        color: c(getStatusColor("waiting", attention)),
      });
    }
  }
  if (summary.idle > 0) {
    dots.push({
      icon: getStatusIcon("idle", null, iconStyle),
      count: summary.idle,
      color: c(theme.overlay),
    });
  }

  return dots;
}

export const GroupHeader: Component<GroupHeaderProps> = (props) => {
  const c = (color: string) => (props.dimmed ? theme.border : color);
  const bgColor = () =>
    props.selected && !props.dimmed ? theme.surface : undefined;
  const indicator = () => (props.collapsed ? "▶" : "▼");

  // Derived here (not in the flat-item memo) so a subagent-driven status
  // change re-renders only this header, not the whole row list.
  const summary = createMemo(() => computeStatusSummary(props.members));

  const workingIcon = useStatusIcon(
    () => (summary().working > 0 ? "working" : "idle"),
    () => null,
    () => props.iconStyle,
  );

  const dots = () => staticDots(summary(), props.iconStyle, props.dimmed);

  return (
    <box
      width="100%"
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bgColor()}
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT) {
          props.onActivate?.();
        } else if (event.button === MouseButton.RIGHT) {
          props.onContextMenu?.(event);
        }
      }}
    >
      <box flexDirection="row" gap={1} width="100%">
        <text fg={c(theme.overlay)}>{indicator()}</text>
        <text fg={c(theme.text)}>
          <Show when={props.selected} fallback={<>{props.label}</>}>
            <b>{props.label}</b>
          </Show>
        </text>
        <text fg={c(theme.subtext)}>({props.count})</text>
        <Show when={props.collapsed}>
          <box flexDirection="row" gap={1}>
            <Show when={summary().working > 0}>
              <text fg={c(theme.peach)}>
                {workingIcon()} {summary().working}
              </text>
            </Show>
            {dots().map((dot) => (
              <text fg={dot.color}>
                {dot.icon} {dot.count}
              </text>
            ))}
          </box>
        </Show>
      </box>
    </box>
  );
};
