import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { EnrichedSession } from "../../types";
import type { WorktreeRow } from "../../daemon/worktree-list";
import type {
  WorktreeChange,
  WorktreeDetail,
} from "../../daemon/worktree-detail";
import { getAgentDisplayName } from "../../lib/agents";
import { getStatusIcon, type IconStyle } from "../../lib/icons";
import { theme } from "../theme";
import {
  formatRelativeTime,
  shortenCwd,
  truncateMiddle,
  truncateText,
} from "../utils/format";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { fetchWorktreeDetail } from "../utils/detail-fetch";
import { createDetailLoader } from "../utils/detail-loader";
import { PreviewFrame, previewContentWidth } from "./PreviewFrame";
import { fitSegments, type RowSegment } from "./row-segments";
import { getStatusColor } from "./StatusBadge";
import { Text } from "./Text";

/** Local git, so a short rest is enough; matches the session preview's
 *  capture debounce order of magnitude. */
const WORKTREE_DEBOUNCE_MS = 120;
/** A worktree changes as someone works in it, so a revisit re-reads soon. */
const WORKTREE_TTL_MS = 5_000;
/** Changed paths listed before `+N more`. */
const CHANGES_SHOWN = 20;

/** What the Worktrees view hands its preview for the row under the cursor. */
export interface WorktreePreviewTarget {
  row: WorktreeRow;
  /** The facts the list shows beside the name (PR badge, removal reason,
   *  lock), in its colors. */
  facts: RowSegment[];
}

/** A repo header under the cursor. */
export interface WorktreePreviewHeader {
  repoName: string;
  repoRoot: string;
  /** `main + N worktrees`, the open PR and issue counts: whatever the
   *  repo's facts can say, already worded. */
  lines: string[];
}

interface WorktreePreviewProps {
  target: WorktreePreviewTarget | null;
  header?: WorktreePreviewHeader | null;
  width: number;
  focused?: boolean;
  onScrollboxRef?: (ref: ScrollBoxRenderable) => void;
  /** The full session for a worktree's session id, for its summary. */
  sessionById?: (id: string) => EnrichedSession | undefined;
  iconStyle?: IconStyle;
  /** Bumped by `R` to re-read past every cache. */
  refreshKey?: number;
}

/** A porcelain status code's color: staged additions green, deletions red,
 *  modifications yellow, untracked dim. */
export function changeColor(code: string): string {
  if (code === "??") return theme.overlay;
  if (code.includes("U")) return theme.red;
  if (code.includes("D")) return theme.red;
  if (code.includes("A")) return theme.green;
  if (code.includes("R") || code.includes("C")) return theme.blue;
  return theme.yellow;
}

/** `↑2 ↓1 origin/feat`, `branch gone`, or nothing without an upstream. */
export function trackingText(row: WorktreeRow): string {
  const upstream = row.upstream;
  if (!upstream?.upstream) return "";
  if (upstream.gone) return `${upstream.upstream} gone`;
  return [
    upstream.ahead ? `↑${upstream.ahead}` : "",
    upstream.behind ? `↓${upstream.behind}` : "",
    upstream.upstream,
  ]
    .filter(Boolean)
    .join(" ");
}

function changeLabel(change: WorktreeChange): string {
  return change.from ? `${change.from} → ${change.path}` : change.path;
}

/**
 * The Worktrees view's preview: the worktree's identity, then what is
 * uncommitted in it, its last commits, and the sessions running there.
 *
 * The header is the list's own data, so it paints at once; the body is a
 * local `git status` and `git log` read through the daemon once the cursor
 * rests (`GET /worktrees/detail`).
 */
export const WorktreePreview: Component<WorktreePreviewProps> = (props) => {
  const dims = useSharedTerminalDimensions();
  const lineWidth = createMemo(() =>
    previewContentWidth(dims().width, props.width),
  );
  // Inside the frame, less the scrollbar the body may grow.
  const bodyWidth = () => Math.max(1, lineWidth() - 1);

  const detail = createDetailLoader({
    target: () => props.target?.row ?? null,
    // The dirty counts are part of the identity: when the list's next read
    // says the tree changed, the preview re-reads it too.
    id: (row) => `${row.path}#${row.dirty.modified}/${row.dirty.untracked}`,
    fetch: (row) => fetchWorktreeDetail(row.path),
    debounceMs: WORKTREE_DEBOUNCE_MS,
    ttlMs: WORKTREE_TTL_MS,
    refreshKey: () => props.refreshKey ?? 0,
  });

  const ready = () => {
    const state = detail();
    return state.status === "ready" ? state.detail : null;
  };
  const errorText = () => {
    const state = detail();
    return state.status === "error" ? state.error : null;
  };

  const title = () => {
    const row = props.target?.row;
    if (!row) return "";
    return row.isMain ? "⌂ main checkout" : row.name;
  };

  const branchLine = createMemo((): RowSegment[] => {
    const row = props.target?.row;
    if (!row) return [];
    const segments: RowSegment[] = [
      {
        text: row.branch ?? (row.detached ? "detached HEAD" : "no branch"),
        fg: theme.blue,
      },
    ];
    const tracking = trackingText(row);
    if (tracking)
      segments.push({
        text: `  ${tracking}`,
        fg: row.upstream?.gone ? theme.yellow : theme.subtext,
      });
    return fitSegments(segments, lineWidth());
  });

  const factsLine = createMemo(() =>
    fitSegments(
      (props.target?.facts ?? []).map((segment, i) => ({
        ...segment,
        text: `${i ? " · " : ""}${segment.text}`,
      })),
      lineWidth(),
    ),
  );

  const sessions = () =>
    (props.target?.row.sessions ?? []).map((s) => ({
      session: s,
      full: props.sessionById?.(s.id),
    }));

  return (
    <PreviewFrame width={props.width} focused={props.focused}>
      <Show
        when={props.target}
        fallback={
          <Show
            when={props.header}
            fallback={
              <Text fg={theme.overlay}>Select a worktree to preview</Text>
            }
          >
            {(header: () => WorktreePreviewHeader) => (
              <box flexDirection="column" flexShrink={0}>
                <Text fg={theme.text} wrapMode="none">
                  <b>{truncateText(header().repoName, lineWidth())}</b>
                </Text>
                <For each={header().lines}>
                  {(line) => (
                    <Text fg={theme.subtext} wrapMode="none">
                      {truncateText(line, lineWidth())}
                    </Text>
                  )}
                </For>
                <Text fg={theme.overlay} wrapMode="none">
                  {truncateMiddle(shortenCwd(header().repoRoot), lineWidth())}
                </Text>
              </box>
            )}
          </Show>
        }
      >
        {(target: () => WorktreePreviewTarget) => (
          <>
            <box flexDirection="column" flexShrink={0}>
              <box height={1} flexShrink={0}>
                <Text fg={theme.text} wrapMode="none">
                  <b>{truncateText(title(), lineWidth())}</b>
                </Text>
              </box>
              <box height={1} flexDirection="row" flexShrink={0}>
                <For each={branchLine()}>
                  {(segment) => (
                    <Text fg={segment.fg} wrapMode="none">
                      {segment.text}
                    </Text>
                  )}
                </For>
              </box>
              <box
                height={factsLine().length ? 1 : 0}
                flexDirection="row"
                flexShrink={0}
              >
                <For each={factsLine()}>
                  {(segment) => (
                    <Text fg={segment.fg} wrapMode="none">
                      {segment.text}
                    </Text>
                  )}
                </For>
              </box>
              <box height={1} flexShrink={0}>
                <Text fg={theme.subtext} wrapMode="none">
                  {truncateMiddle(shortenCwd(target().row.path), lineWidth())}
                </Text>
              </box>
              <box height={1} flexShrink={0}>
                <Text fg={theme.border}>{"─".repeat(lineWidth())}</Text>
              </box>
            </box>
            <scrollbox
              flexGrow={1}
              ref={(r: ScrollBoxRenderable) => {
                props.onScrollboxRef?.(r);
              }}
            >
              {/* Each section sits in an always-mounted box: a <Show> that
                  mounts late appends to the END of its parent (OpenTUI's
                  insertion anchor), which would put the changes under the
                  sessions once they load. */}
              <box flexDirection="column">
                <box flexDirection="column">
                  <Show when={detail().status === "loading"}>
                    <Text fg={theme.overlay}>Loading…</Text>
                  </Show>
                  <Show when={errorText()}>
                    {(error: () => string) => (
                      <Text fg={theme.yellow}>{error()}</Text>
                    )}
                  </Show>
                </box>
                <box flexDirection="column">
                  <Show when={ready()}>
                    {(d: () => WorktreeDetail) => (
                      <box flexDirection="column">
                        <Text fg={theme.subtext}>
                          <b>
                            {d().total
                              ? `Changes (${d().total})`
                              : "No uncommitted changes"}
                          </b>
                        </Text>
                        <For each={d().changes.slice(0, CHANGES_SHOWN)}>
                          {(change) => (
                            <box height={1} flexDirection="row">
                              <Text
                                fg={changeColor(change.code)}
                                wrapMode="none"
                              >
                                {`${change.code.replace(/ /g, "·")} `}
                              </Text>
                              <Text fg={theme.text} wrapMode="none">
                                {truncateMiddle(
                                  changeLabel(change),
                                  Math.max(1, bodyWidth() - 3),
                                )}
                              </Text>
                            </box>
                          )}
                        </For>
                        <Show when={d().total > CHANGES_SHOWN}>
                          <Text fg={theme.overlay}>
                            {`+${d().total - CHANGES_SHOWN} more`}
                          </Text>
                        </Show>
                        <Show when={d().commits.length > 0}>
                          <Text fg={theme.border}>{""}</Text>
                          <Text fg={theme.subtext}>
                            <b>Recent commits</b>
                          </Text>
                          <For each={d().commits}>
                            {(commit) => {
                              const age = formatRelativeTime(
                                new Date(commit.date),
                              );
                              return (
                                <box height={1} flexDirection="row">
                                  <Text fg={theme.mauve} wrapMode="none">
                                    {`${commit.sha} `}
                                  </Text>
                                  <box flexGrow={1}>
                                    <Text fg={theme.text} wrapMode="none">
                                      {truncateText(
                                        commit.subject,
                                        Math.max(
                                          1,
                                          bodyWidth() -
                                            commit.sha.length -
                                            age.length -
                                            2,
                                        ),
                                      )}
                                    </Text>
                                  </box>
                                  <Text fg={theme.overlay} wrapMode="none">
                                    {` ${age}`}
                                  </Text>
                                </box>
                              );
                            }}
                          </For>
                        </Show>
                      </box>
                    )}
                  </Show>
                </box>
                <box flexDirection="column">
                  <Show when={sessions().length > 0}>
                    <Text fg={theme.border}>{""}</Text>
                    <Text fg={theme.subtext}>
                      <b>{`Sessions (${sessions().length})`}</b>
                    </Text>
                    <For each={sessions()}>
                      {({ session, full }) => {
                        const label = [
                          session.tmuxTarget ??
                            (session.background ? "background" : ""),
                          getAgentDisplayName(session.agentType),
                          full?.summary ?? full?.lastPrompt ?? "",
                        ]
                          .filter(Boolean)
                          .join(" · ");
                        return (
                          <box height={1} flexDirection="row">
                            <Text
                              fg={getStatusColor(session.status, null)}
                              wrapMode="none"
                            >
                              {`${getStatusIcon(session.status, null, props.iconStyle)} `}
                            </Text>
                            <Text fg={theme.text} wrapMode="none">
                              {truncateText(
                                label.replace(/\s+/g, " "),
                                Math.max(1, bodyWidth() - 2),
                              )}
                            </Text>
                          </box>
                        );
                      }}
                    </For>
                  </Show>
                </box>
              </box>
            </scrollbox>
          </>
        )}
      </Show>
    </PreviewFrame>
  );
};
