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
    // No `(worktree)` marker here: the Worktrees block above says which tree
    // each session is in, and repeating it on every line made the same fact
    // render twice on one screen.
    if (s.gitBranch) parts.push(s.gitBranch);
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

/**
 * The worktree directory's own name, which is what distinguishes one
 * worktree of a repo from another (the repo name is the group's label).
 * Taken from `worktreeRoot`, not the cwd: a pane that has `cd`'d into
 * `…/worktrees/parking/src/tui` is still in the worktree `parking`, and
 * naming it `tui` would invent a worktree nobody created.
 */
export function worktreeName(session: EnrichedSession): string {
  const cwd = session.paneCwd ?? session.cwd;
  const root = session.worktreeRoot ?? cwd;
  return root.split("/").filter(Boolean).at(-1) ?? root;
}

/** A worktree in this group, with the sessions running in it. */
interface WorktreeEntry {
  name: string;
  /** The session whose status the row shows — see {@link worktreeEntries}. */
  session: EnrichedSession;
  count: number;
}

/** Status precedence for the row a worktree shows: the one you'd want to
 *  know about first. */
const STATUS_RANK: Record<string, number> = { waiting: 0, working: 1 };
function statusRank(session: EnrichedSession): number {
  return STATUS_RANK[getEffectiveStatus(session).status] ?? 2;
}

/**
 * Group the worktree sessions by worktree, keeping one row each. Two agents
 * running in the same worktree are two sessions but ONE worktree, and a
 * heading that says "Worktrees" over two identical lines reads as two
 * worktrees; the count carries that instead. The row shows the most
 * attention-worthy session's status, so a waiting agent isn't hidden behind
 * an idle one sharing its tree.
 */
export function worktreeEntries(sessions: EnrichedSession[]): WorktreeEntry[] {
  const byRoot = new Map<string, WorktreeEntry>();
  for (const session of sessions) {
    if (!session.isWorktree) continue;
    const key = session.worktreeRoot ?? session.paneCwd ?? session.cwd;
    const existing = byRoot.get(key);
    if (!existing) {
      byRoot.set(key, { name: worktreeName(session), session, count: 1 });
      continue;
    }
    existing.count += 1;
    if (statusRank(session) < statusRank(existing.session)) {
      existing.session = session;
    }
  }
  return [...byRoot.values()];
}

/**
 * One line per worktree in the group: which worktree, what branch, what
 * state. A repo's sessions group together regardless of which checkout they
 * run in, so without this the preview says how many sessions the repo has
 * but not that they sit in different working trees. This is the only place
 * worktree context renders (the per-session lines below dropped their
 * `(worktree)` suffix when this arrived). Sessions only — the on-disk
 * worktree list, including trees with nothing running in them, belongs with
 * worktree management, which is what can act on them.
 */
const WorktreeRow: Component<{
  entry: WorktreeEntry;
  iconStyle?: IconStyle;
}> = (props) => {
  const effective = createMemo(() => getEffectiveStatus(props.entry.session));
  const icon = useStatusIcon(
    () => effective().status,
    () => effective().attentionType,
    () => props.iconStyle,
    () => props.entry.session.attentionState,
  );

  return (
    <box flexDirection="row" height={1} gap={1}>
      <text fg={getStatusColor(effective().status, effective().attentionType)}>
        {icon()}
      </text>
      <text fg={theme.text}>{props.entry.name}</text>
      <Show when={props.entry.session.gitBranch}>
        {(branch: () => string) => <text fg={theme.blue}>{branch()}</text>}
      </Show>
      <Show when={props.entry.count > 1}>
        <text fg={theme.overlay}>{`×${props.entry.count}`}</text>
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

  const worktrees = createMemo(() => worktreeEntries(props.sessions));

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
          <Show when={worktrees().length > 0}>
            <box flexDirection="column" paddingBottom={1}>
              <text fg={theme.subtext}>
                <b>Worktrees</b>
              </text>
              <For each={worktrees()}>
                {(entry) => (
                  <WorktreeRow entry={entry} iconStyle={props.iconStyle} />
                )}
              </For>
            </box>
          </Show>
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
