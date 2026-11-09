import type { Component } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import type {
  CheckDetail,
  IssueDetail,
  PRDetail,
} from "../../daemon/source-detail";
import { theme } from "../theme";
import { truncateText, wrapToLines } from "../utils/format";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import {
  fetchIssueDetail,
  fetchPRDetail,
  type DetailResult,
} from "../utils/detail-fetch";
import { createDetailLoader } from "../utils/detail-loader";
import { PreviewFrame, previewContentWidth } from "./PreviewFrame";
import { fitSegments, oneLine, type RowSegment } from "./row-segments";
import { sourceRowMarker, type SourceRow } from "./source-picker-rows";
import { Text } from "./Text";

/**
 * Longer than the local previews' rest: each read is a `gh` call against
 * GitHub, and a cursor held on `j` should cross rows without spawning one.
 */
const SOURCE_DEBOUNCE_MS = 250;
/** The daemon's own list TTL, so a body and its row go stale together. */
const SOURCE_TTL_MS = 60_000;
/** Checks listed before `+N more`; failing ones sort first. */
const CHECKS_SHOWN = 8;

/**
 * A PR or issue body as the preview draws it: HTML comments gone (PR
 * templates and bots leave whole blocks of them that GitHub never shows),
 * tabs as spaces, trailing blanks trimmed, and runs of blank lines folded to
 * one. An unclosed comment hides the rest, as it does on GitHub.
 */
export function bodyText(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/\t/g, "  ")
    .replace(/[  ]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A check's glyph and color, the list's `CI ✓/✗/◐` vocabulary. */
export function checkGlyph(state: CheckDetail["state"]): RowSegment {
  switch (state) {
    case "fail":
      return { text: "✗", fg: theme.red };
    case "pending":
      return { text: "◐", fg: theme.yellow };
    case "pass":
      return { text: "✓", fg: theme.green };
    default:
      return { text: "−", fg: theme.overlay };
  }
}

interface SourcePreviewProps {
  row: SourceRow | null;
  /** The row's age as the list words it (`3d`). */
  age?: string;
  width: number;
  focused?: boolean;
  onScrollboxRef?: (ref: ScrollBoxRenderable) => void;
  /** Bumped by `R` to re-read past every cache. */
  refreshKey?: number;
}

type Detail = PRDetail | IssueDetail;

/**
 * The Start view's preview: the PR or issue under the cursor, its facts
 * from the list at once, then its checks and body once the cursor rests
 * (`GET /prs/detail`, `GET /issues/detail`).
 */
export const SourcePreview: Component<SourcePreviewProps> = (props) => {
  const dims = useSharedTerminalDimensions();
  const lineWidth = createMemo(() =>
    previewContentWidth(dims().width, props.width),
  );
  const bodyWidth = () => Math.max(1, lineWidth() - 1);

  const detail = createDetailLoader<SourceRow, Detail>({
    target: () => props.row,
    id: (row) => row.key,
    fetch: (row, refresh): Promise<DetailResult<Detail>> =>
      row.kind === "pr"
        ? fetchPRDetail(row.repoRoot, row.pr.number, refresh)
        : fetchIssueDetail(row.repoRoot, row.issue.number, refresh),
    debounceMs: SOURCE_DEBOUNCE_MS,
    ttlMs: SOURCE_TTL_MS,
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
  const prDetail = (): PRDetail | null => {
    const d = ready();
    return props.row?.kind === "pr" && d ? (d as PRDetail) : null;
  };

  /** `⊙ #206 title…` wrapped to at most two lines. */
  const titleLines = createMemo(() => {
    const row = props.row;
    if (!row) return [];
    const number = row.kind === "pr" ? row.pr.number : row.issue.number;
    const title = row.kind === "pr" ? row.pr.title : row.issue.title;
    return wrapToLines(
      `${sourceRowMarker(row)} #${number} ${oneLine(title)}`,
      lineWidth(),
      2,
    );
  });

  /** `@author · 3d · draft · approved · labels` */
  const metaLine = createMemo((): RowSegment[] => {
    const row = props.row;
    if (!row) return [];
    const author = row.kind === "pr" ? row.pr.author : row.issue.author;
    const labels = row.kind === "pr" ? row.pr.labels : row.issue.labels;
    const parts: RowSegment[] = [];
    if (author) parts.push({ text: `@${oneLine(author)}`, fg: theme.subtext });
    if (props.age) parts.push({ text: props.age, fg: theme.overlay });
    if (row.kind === "pr" && row.pr.isDraft)
      parts.push({ text: "draft", fg: theme.subtext });
    if (row.kind === "pr" && row.pr.reviewDecision === "APPROVED")
      parts.push({ text: "approved", fg: theme.green });
    if (row.kind === "pr" && row.pr.reviewDecision === "CHANGES_REQUESTED")
      parts.push({ text: "changes requested", fg: theme.peach });
    if (labels?.length)
      parts.push({ text: oneLine(labels.join(", ")), fg: theme.subtext });
    return fitSegments(
      parts.map((p, i) => ({ ...p, text: `${i ? " · " : ""}${p.text}` })),
      lineWidth(),
    );
  });

  /** `head → base +12 −3`, the base and size arriving with the detail. */
  const branchLine = createMemo((): RowSegment[] => {
    const row = props.row;
    if (row?.kind !== "pr") return [];
    const d = prDetail();
    const parts: RowSegment[] = [
      { text: oneLine(row.pr.headRefName || "?"), fg: theme.blue },
    ];
    if (d?.baseRefName)
      parts.push({ text: ` → ${oneLine(d.baseRefName)}`, fg: theme.subtext });
    if (d?.additions != null)
      parts.push({ text: ` +${d.additions}`, fg: theme.green });
    if (d?.deletions != null)
      parts.push({ text: ` −${d.deletions}`, fg: theme.red });
    return fitSegments(parts, lineWidth());
  });

  const checkout = () => {
    const row = props.row;
    if (!row?.checkedOutName) return "";
    const more =
      row.kind === "issue" && row.siblings ? ` (+${row.siblings} more)` : "";
    return truncateText(`→ ${row.checkedOutName}${more}`, lineWidth());
  };

  const body = () => {
    const d = ready();
    return d ? bodyText(d.body) : "";
  };

  return (
    <PreviewFrame width={props.width} focused={props.focused}>
      <Show
        when={props.row}
        fallback={
          <Text fg={theme.overlay}>Select a PR or issue to preview</Text>
        }
      >
        <box flexDirection="column" flexShrink={0}>
          <For each={titleLines()}>
            {(line) => (
              <box height={1} flexShrink={0}>
                <Text fg={theme.text} wrapMode="none">
                  <b>{line}</b>
                </Text>
              </box>
            )}
          </For>
          <box height={1} flexDirection="row" flexShrink={0}>
            <For each={metaLine()}>
              {(segment) => (
                <Text fg={segment.fg} wrapMode="none">
                  {segment.text}
                </Text>
              )}
            </For>
          </box>
          <box
            height={branchLine().length ? 1 : 0}
            flexDirection="row"
            flexShrink={0}
          >
            <For each={branchLine()}>
              {(segment) => (
                <Text fg={segment.fg} wrapMode="none">
                  {segment.text}
                </Text>
              )}
            </For>
          </box>
          <box height={checkout() ? 1 : 0} flexShrink={0}>
            <Show when={checkout()}>
              <Text fg={theme.mauve} wrapMode="none">
                {checkout()}
              </Text>
            </Show>
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
          {/* Stable section boxes: a late-mounting <Show> appends to the END
              of its parent, which would put the checks under the body. */}
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
              <Show when={prDetail()?.checks.length ? prDetail() : null}>
                {(d: () => PRDetail) => (
                  <box flexDirection="column" paddingBottom={1}>
                    <Text fg={theme.subtext}>
                      <b>{`Checks (${d().checks.length})`}</b>
                    </Text>
                    <For each={d().checks.slice(0, CHECKS_SHOWN)}>
                      {(check) => (
                        <box height={1} flexDirection="row">
                          <Text fg={checkGlyph(check.state).fg} wrapMode="none">
                            {`${checkGlyph(check.state).text} `}
                          </Text>
                          <Text fg={theme.text} wrapMode="none">
                            {truncateText(
                              check.name,
                              Math.max(1, bodyWidth() - 2),
                            )}
                          </Text>
                        </box>
                      )}
                    </For>
                    <Show when={d().checks.length > CHECKS_SHOWN}>
                      <Text fg={theme.overlay}>
                        {`+${d().checks.length - CHECKS_SHOWN} more`}
                      </Text>
                    </Show>
                  </box>
                )}
              </Show>
            </box>
            <box flexDirection="column">
              <Show when={ready()}>
                {(d: () => Detail) => (
                  <box flexDirection="column">
                    <Show
                      when={body()}
                      fallback={<Text fg={theme.overlay}>No description.</Text>}
                    >
                      <Text fg={theme.text}>{body()}</Text>
                    </Show>
                    <Show when={d().truncated}>
                      <Text fg={theme.overlay}>
                        {truncateText(
                          "… cut here; the rest is on GitHub (o)",
                          bodyWidth(),
                        )}
                      </Text>
                    </Show>
                  </box>
                )}
              </Show>
            </box>
          </box>
        </scrollbox>
      </Show>
    </PreviewFrame>
  );
};
