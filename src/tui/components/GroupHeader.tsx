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
  /** Budget for the label and its segments; the rule is sized by layout. */
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
  /**
   * Run the rule to the box's last column instead of leaving the one-cell
   * right margin. For lists whose rows have no right padding of their own
   * (the Worktrees panel, the source picker), so the rule ends where the
   * rows do.
   */
  flushRight?: boolean;
  onActivate?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
}

/** Longer than any terminal is wide; the rule's box clips it to fit. */
const RULE_LENGTH = 1000;

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
  const paddingRight = () => (props.flushRight ? 0 : 1);

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
    let left = Math.max(0, (props.width ?? dims().width) - 1 - paddingRight());
    const activity =
      props.collapsed && !props.hideStatusSummary
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
    const segments: Array<{ text: string; color: string; label?: boolean }> = [
      { text: `${indicator()} `, color: theme.overlay },
      {
        text: truncateText(props.label, labelWidth),
        color: theme.text,
        label: true,
      },
      { text: count, color: theme.overlay },
      ...activity,
      ...(props.sharedBranch && props.sharedBranch !== "main"
        ? [{ text: `   ${props.sharedBranch}`, color: theme.blue }]
        : []),
      ...(props.prBadge
        ? [
            {
              text: `   ${props.prBadge}`,
              color: props.prBadgeColor ?? theme.mauve,
            },
          ]
        : []),
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
      return text.trim()
        ? [{ text, color: c(segment.color), label: segment.label }]
        : [];
    });
  });

  return (
    <box
      width="100%"
      height={1}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={paddingRight()}
      backgroundColor={bgColor()}
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT) {
          props.onActivate?.();
        } else if (event.button === MouseButton.RIGHT) {
          props.onContextMenu?.(event);
        }
      }}
    >
      <text wrapMode="none" flexShrink={0}>
        <For each={parts()}>
          {(part) => (
            <span style={{ fg: part.color }}>
              <Show when={props.selected && part.label} fallback={part.text}>
                <b>{part.text}</b>
              </Show>
            </span>
          )}
        </For>
      </text>
      {/* The header IS the divider: a rule fills what the label leaves, so a
          group boundary costs one line, not a rule line plus a label line.
          Layout sizes it, not `width`, so it ends where the rows do however
          the caller's budget drifts from the real box, and a label that
          measures wider than `displayWidth` thought eats the rule instead of
          wrapping the line. */}
      <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <text fg={c(theme.border)} wrapMode="none">
          {` ${"─".repeat(RULE_LENGTH)}`}
        </text>
      </box>
    </box>
  );
};
