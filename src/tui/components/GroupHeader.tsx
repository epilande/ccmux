import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { WAITING_SUBTYPES, computeStatusSummary } from "../utils/grouping";
import type { FilteredSession, StatusSummary } from "../utils/grouping";
import type { IconStyle } from "../../lib/icons";
import { getStatusIcon } from "../../lib/icons";
import { getStatusColor } from "./StatusBadge";
import { useStatusIcon } from "../utils/useStatusIcon";
import { MouseButton, type MouseEvent } from "@opentui/core";
import { displayWidth, truncateText } from "../utils/format";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { theme } from "../theme";

interface GroupHeaderProps {
  label: string;
  count: number;
  width?: number;
  facts?: string;
  sharedBranch?: string;
  prBadge?: string;
  prBadgeColor?: string;
  hideStatusSummary?: boolean;
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
  const dims = useSharedTerminalDimensions();
  const c = (color: string) => (props.dimmed ? theme.border : color);
  const bgColor = () =>
    props.selected && !props.dimmed ? theme.surface : undefined;
  const indicator = () => (props.collapsed ? "▸" : "▾");

  // Derived here (not in the flat-item memo) so a subagent-driven status
  // change re-renders only this header, not the whole row list.
  const summary = createMemo(() => computeStatusSummary(props.members));

  const workingIcon = useStatusIcon(
    () => (summary().working > 0 ? "working" : "idle"),
    () => null,
    () => props.iconStyle,
  );

  const dots = () => staticDots(summary(), props.iconStyle, props.dimmed);

  const parts = createMemo(() => {
    let left = Math.max(0, (props.width ?? dims().width) - 2);
    const activity = props.collapsed && !props.hideStatusSummary
      ? [
          ...(summary().working
            ? [
                {
                  text: ` ${workingIcon()} ${summary().working}`,
                  color: theme.peach,
                },
              ]
            : []),
          ...dots().map((dot) => ({
            text: ` ${dot.icon} ${dot.count}`,
            color: dot.color,
          })),
        ]
      : [];
    const count = ` (${props.count})`;
    // Keep the count and collapsed activity visible before spending space on
    // a long group name or optional repository facts.
    const labelWidth = Math.max(
      1,
      left -
        2 -
        displayWidth(count) -
        activity.reduce((width, part) => width + displayWidth(part.text), 0),
    );
    const segments = [
      { text: `${indicator()} `, color: theme.overlay },
      { text: truncateText(props.label, labelWidth), color: theme.text },
      { text: count, color: theme.overlay },
      ...activity,
      ...(props.sharedBranch && props.sharedBranch !== "main"
        ? [{ text: `   ${props.sharedBranch}`, color: theme.blue }] : []),
      ...(props.prBadge
        ? [{ text: `   ${props.prBadge}`, color: props.prBadgeColor ?? theme.mauve }] : []),
      ...(props.facts
        ? [{ text: `   ${props.facts}`, color: theme.subtext }]
        : []),
    ];
    return segments.flatMap((segment) => {
      // Facts are useful as complete phrases; do not leave a dangling
      // "main +…" in a narrow sidebar. The identity may still truncate.
      if (
        segment.text === `   ${props.facts}` &&
        displayWidth(segment.text) > left
      )
        return [];
      if (left <= 0) return [];
      const text = truncateText(segment.text, left);
      left -= displayWidth(text);
      return text.trim() ? [{ text, color: c(segment.color) }] : [];
    });
  });

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
      <text>
        <For each={parts()}>
          {(part) => (
            <span style={{ fg: part.color }}>
              <Show when={props.selected} fallback={part.text}>
                <b>{part.text}</b>
              </Show>
            </span>
          )}
        </For>
      </text>
    </box>
  );
};
