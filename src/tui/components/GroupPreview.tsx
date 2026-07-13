import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { EnrichedSession } from "../../types";
import { WAITING_SUBTYPES, computeStatusSummary } from "../utils/grouping";
import type { FilteredSession, StatusSummary } from "../utils/grouping";
import type { IconStyle } from "../../lib/icons";
import { getStatusIcon } from "../../lib/icons";
import { getStatusColor } from "./StatusBadge";
import { getEffectiveStatus } from "../../daemon/status-machine";
import { getMarkerKey } from "../../daemon/sessions";
import { useStatusIcon } from "../utils/useStatusIcon";
import { formatRelativeTime, formatVersion, shortenCwd } from "../utils/format";
import { theme } from "../theme";

interface GroupPreviewProps {
  header: { label: string; count: number; members: FilteredSession[] };
  sessions: EnrichedSession[];
  onScrollboxRef?: (ref: ScrollBoxRenderable) => void;
  iconStyle?: IconStyle;
  width: number;
}

/** Static summary parts (waiting + idle). Working is handled separately for animation. */
function staticSummaryParts(
  summary: StatusSummary,
  iconStyle: IconStyle | undefined,
): Array<{ text: string; color: string }> {
  const parts: Array<{ text: string; color: string }> = [];
  for (const { key, attention } of WAITING_SUBTYPES) {
    const count = summary[key];
    if (count > 0) {
      const icon = getStatusIcon("waiting", attention, iconStyle);
      parts.push({
        text: `${icon} ${count} waiting`,
        color: getStatusColor("waiting", attention),
      });
    }
  }
  if (summary.idle > 0) {
    const icon = getStatusIcon("idle", null, iconStyle);
    parts.push({ text: `${icon} ${summary.idle} idle`, color: theme.overlay });
  }
  return parts;
}

/** Individual session row with animated status icon */
const SessionRow: Component<{
  session: EnrichedSession;
  iconStyle?: IconStyle;
}> = (props) => {
  const effective = createMemo(() => getEffectiveStatus(props.session));
  const attentionState = () => props.session.attentionState;

  const icon = useStatusIcon(
    () => effective().status,
    () => effective().attentionType,
    () => props.iconStyle,
    attentionState,
  );

  const color = () => {
    const attn = attentionState();
    if (props.session.status === "idle" && attn) return theme.green;
    return getStatusColor(effective().status, effective().attentionType);
  };

  const label = () => props.session.tmuxTarget ?? getMarkerKey(props.session);

  const timeStr = () => {
    const time =
      props.session.lastActivityAt ??
      props.session.lastUserInputAt ??
      props.session.updatedAt;
    return time ? formatRelativeTime(new Date(time)) : "";
  };

  const meta = () => {
    const s = props.session;
    const parts: string[] = [];
    const cwd = s.paneCwd ?? s.cwd;
    if (cwd) parts.push(shortenCwd(cwd));
    if (s.gitBranch) {
      parts.push(s.isWorktree ? `${s.gitBranch} (worktree)` : s.gitBranch);
    }
    if (s.version) parts.push(formatVersion(s.version));
    return parts.join(" · ");
  };

  return (
    <box flexDirection="column" paddingBottom={1}>
      <box flexDirection="row" height={1} gap={1}>
        <text fg={color()}>{icon()}</text>
        <text fg={theme.text}>
          <b>{label()}</b>
        </text>
        <box flexGrow={1} />
        <text fg={theme.overlay}>{timeStr()}</text>
      </box>
      <Show when={meta()}>
        {(m: () => string) => (
          <box height={1} paddingLeft={3}>
            <text fg={theme.subtext}>{m()}</text>
          </box>
        )}
      </Show>
    </box>
  );
};

export const GroupPreview: Component<GroupPreviewProps> = (props) => {
  const dims = useTerminalDimensions();
  const separatorWidth = createMemo(() =>
    Math.max(1, Math.floor((dims().width * props.width) / 100) - 3),
  );

  // Derived in this component's reactive scope (not the flat-item memo) so a
  // subagent-driven status change re-renders only the preview header.
  const summary = createMemo(() => computeStatusSummary(props.header.members));

  const workingIcon = useStatusIcon(
    () => (summary().working > 0 ? "working" : "idle"),
    () => null,
    () => props.iconStyle,
  );

  const summaryParts = () => staticSummaryParts(summary(), props.iconStyle);

  return (
    <box
      flexDirection="column"
      width={`${props.width}%`}
      height="100%"
      border={["left"]}
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={3} flexDirection="column">
        <box flexDirection="row" gap={1}>
          <text>
            <b>{props.header.label}</b>
          </text>
          <text fg={theme.subtext}>({props.header.count} sessions)</text>
        </box>
        <box flexDirection="row" gap={2}>
          <Show when={summary().working > 0}>
            <text fg={theme.peach}>
              {workingIcon()} {summary().working} working
            </text>
          </Show>
          <For each={summaryParts()}>
            {(part) => <text fg={part.color}>{part.text}</text>}
          </For>
        </box>
        <text fg={theme.border}>{"─".repeat(separatorWidth())}</text>
      </box>

      <scrollbox
        flexGrow={1}
        ref={(r: ScrollBoxRenderable) => props.onScrollboxRef?.(r)}
      >
        <box flexDirection="column" paddingTop={1}>
          <For each={props.sessions}>
            {(session) => (
              <SessionRow session={session} iconStyle={props.iconStyle} />
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  );
};
