import type { Component } from "solid-js";
import {
  createSignal,
  createEffect,
  createMemo,
  For,
  on,
  Show,
  onCleanup,
} from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type {
  StyledText,
  TextRenderable,
  ScrollBoxRenderable,
} from "@opentui/core";
import type { EnrichedSession, SubagentState } from "../../types";
import type { IconStyle } from "../../lib/icons";
import { capturePane } from "../utils/tmux";
import { isSameServerCached } from "../utils/server-guard";
import { readLastAssistantTurn } from "../utils/transcript";
import {
  parseAnsiToStyledText,
  highlightSearchMatches,
} from "../utils/ansi-renderer";
import { getStatusColor } from "./StatusBadge";
import { getEffectiveStatus } from "../../daemon/status-machine";
import { useStatusIcon } from "../utils/useStatusIcon";
import { theme } from "../theme";
import {
  formatRelativeTime,
  formatSubagentName,
  formatVersion,
  shortenCwd,
} from "../utils/format";

/**
 * One row of the preview's Agents section: activity spinner, the agent's
 * human name (parsed from its transcript filename), and last-activity age.
 * Both `working` and `waiting` subagents render as activity — a subagent's
 * `waiting` is an unresolved tool_use (usually a tool mid-execution), not a
 * prompt for the user (see `getEffectiveStatus`).
 */
const SubagentRow: Component<{
  sub: SubagentState;
  iconStyle?: IconStyle;
}> = (props) => {
  const icon = useStatusIcon(
    () => "working",
    () => null,
    () => props.iconStyle,
    () => undefined,
  );
  const age = () =>
    props.sub.lastActivityAt
      ? formatRelativeTime(new Date(props.sub.lastActivityAt))
      : "";
  return (
    <box flexDirection="row">
      <text fg={theme.peach}>{"  " + icon()}</text>
      <box flexGrow={1} paddingLeft={1}>
        <text fg={theme.text}>{formatSubagentName(props.sub.agentId)}</text>
      </box>
      <text fg={theme.overlay}>{age()}</text>
    </box>
  );
};
/**
 * Peek body for a paneless background (background-agent) row. There is no
 * tmux pane to capture, so surface the agent's own record instead: the ask
 * (`intent`, arriving as `lastPrompt`), the Haiku `detail`, live `inFlight`
 * progress while working, the full `output.result`, the final assistant
 * turn read lazily from the JSONL transcript (`logPath`) once done, and the
 * linked PRs from `children[]`. Read-only on Claude's state; the one action
 * is Enter, which attaches to the agent (`claude attach`), the place a
 * blocked agent can be answered.
 */
const BackgroundPeek: Component<{ session: EnrichedSession }> = (props) => {
  const prs = () =>
    (props.session.backgroundChildren ?? []).filter((c) => c.kind === "pr");
  const result = () => {
    const r = props.session.backgroundResult;
    // Avoid echoing detail twice when result === detail.
    return r && r !== props.session.backgroundDetail ? r : null;
  };

  const progress = () => {
    if (props.session.status !== "working") return null;
    const f = props.session.backgroundInFlight;
    if (!f) return null;
    const parts: string[] = [];
    if (typeof f.tasks === "number" && f.tasks > 0) {
      parts.push(`${f.tasks} running`);
    }
    if (typeof f.queued === "number" && f.queued > 0) {
      parts.push(`${f.queued} queued`);
    }
    if (Array.isArray(f.kinds) && f.kinds.length > 0) {
      parts.push(f.kinds.join(", "));
    }
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  // Lazy client-side transcript read: done agents only, and only while this
  // row is the one previewed (the component exists only for the selected
  // session). The unconditional clear keeps a previous row's transcript from
  // rendering under this row while its read is in flight; the logPath guard
  // on resolve drops a stale read racing a row switch.
  const [lastTurn, setLastTurn] = createSignal<string | null>(null);
  createEffect(() => {
    const path = props.session.logPath;
    void props.session.updatedAt; // re-read when the session updates
    setLastTurn(null);
    if (props.session.status !== "idle" || !path) return;
    readLastAssistantTurn(path)
      .then((text) => {
        if (props.session.logPath === path) setLastTurn(text);
      })
      .catch(() => {});
  });
  const transcript = () => {
    const t = lastTurn();
    // The result is often the final turn verbatim; don't echo it twice.
    return t && t !== props.session.backgroundResult ? t : null;
  };

  const footer = () =>
    props.session.status === "waiting"
      ? "enter: attach agent to respond"
      : "enter: attach agent";

  return (
    <scrollbox flexGrow={1} stickyScroll={false}>
      <box flexDirection="column">
        <Show when={props.session.lastPrompt}>
          <text fg={theme.overlay}>Task</text>
          <text fg={theme.subtext}>{props.session.lastPrompt!}</text>
          <text fg={theme.border}>{""}</text>
        </Show>
        <Show
          when={props.session.backgroundDetail}
          fallback={<text fg={theme.overlay}>No summary yet</text>}
        >
          <text fg={theme.text}>{props.session.backgroundDetail!}</text>
        </Show>
        <Show when={progress()}>
          <text fg={theme.subtext}>{progress()!}</text>
        </Show>
        <Show when={result()}>
          <text fg={theme.border}>{""}</text>
          <text fg={theme.subtext}>{result()!}</text>
        </Show>
        {/* Stable wrapper: the transcript resolves async, and a bare <Show>
            appearing after first render would be appended to the END of the
            parent box (opentui insertion anchor), landing below the footer.
            The always-mounted box pins its slot in the column order. */}
        <box flexDirection="column">
          <Show when={transcript()}>
            <text fg={theme.border}>{""}</text>
            <text fg={theme.overlay}>Last reply</text>
            <text fg={theme.subtext}>{transcript()!}</text>
          </Show>
        </box>
        <Show when={prs().length > 0}>
          <text fg={theme.border}>{""}</text>
          <text fg={theme.subtext}>Pull requests:</text>
          <For each={prs()}>
            {(pr) => (
              <text fg={theme.mauve}>
                {"  "}
                {`#${pr.id}`} {pr.href}
              </text>
            )}
          </For>
        </Show>
        <text fg={theme.border}>{""}</text>
        <text fg={theme.overlay}>{footer()}</text>
      </box>
    </scrollbox>
  );
};

/**
 * Sentinel occupying the last-captured slot while the pane is in the
 * failed-capture state. A symbol can never equal a captured string, so a
 * recovery to any real content (even content identical to what rendered
 * before the failure) always repaints, while consecutive failures dedupe
 * the same way identical successful captures do: the focused poll loop
 * backs off to its max delay instead of re-spawning `tmux capture-pane`
 * against a dead pane every 500ms until the daemon's liveness sweep
 * unbinds the row (issue #114).
 */
const CAPTURE_FAILED = Symbol("ccmux.preview.capture-failed");

/**
 * Sentinel for the cross-server refusal state: the daemon's pane `%N` belongs
 * to a different tmux server, so capturing it here would render some OTHER
 * pane's content (issue #113). Dedupes through `applyCapture` like the failed
 * state, so the focused poll loop still backs off while refused.
 */
const CROSS_SERVER = Symbol("ccmux.preview.cross-server");

interface PreviewProps {
  session: EnrichedSession | null;
  onScrollboxRef?: (ref: ScrollBoxRenderable) => void;
  iconStyle?: IconStyle;
  width: number;
  focused?: boolean;
  refreshKey?: number;
  searchQuery?: string;
  /**
   * Focused-poll backoff bounds in ms (defaults 500/2000). Injectable so
   * tests can observe the backoff without multi-second waits.
   */
  pollDelays?: { min: number; max: number };
}

export const Preview: Component<PreviewProps> = (props) => {
  const dims = useTerminalDimensions();
  const separatorWidth = createMemo(() =>
    Math.max(1, Math.floor((dims().width * props.width) / 100) - 3),
  );
  const [content, setContent] = createSignal<StyledText | null>(null);
  let textRef: TextRenderable | undefined;
  // Raw capture from the last refresh (or a sentinel while the pane is
  // unreadable or refused); lets refreshPane skip the ANSI re-parse (and the
  // focused-poll loop back off) when the pane is silent or stays in one state.
  let lastCaptured:
    | string
    | typeof CAPTURE_FAILED
    | typeof CROSS_SERVER
    | null = null;

  // Fold one capture outcome into the dedupe state: repaint (and report
  // "changed" to the poll loop) only on a transition, whether between two
  // different contents or into/out of a sentinel state.
  const applyCapture = (
    next: string | typeof CAPTURE_FAILED | typeof CROSS_SERVER,
    rendered: string,
  ): boolean => {
    if (next === lastCaptured) return false;
    lastCaptured = next;
    setContent(parseAnsiToStyledText(rendered));
    return true;
  };

  const refreshPane = async (): Promise<boolean> => {
    const tmuxPane = props.session?.tmuxPane;
    if (!tmuxPane) {
      lastCaptured = null;
      setContent(null);
      return false;
    }
    // Cached verdict (utils/server-guard.ts): a cross-server `%N` would
    // capture the wrong pane, so refuse before spawning tmux at all. Defer a
    // microtask first so the refusal resolves asynchronously like every real
    // capture; a synchronous setContent during the mount effect would run
    // before the content <Show>'s text ref exists and paint nothing.
    if (!isSameServerCached()) {
      await Promise.resolve();
      if (props.session?.tmuxPane !== tmuxPane) return false;
      return applyCapture(CROSS_SERVER, "Pane is on a different tmux server");
    }
    // capturePane throws on a dead pane; fold to null so the stale-resolve guard
    // handles both. null is unambiguous: a live but empty pane resolves to "".
    const paneContent = await capturePane(tmuxPane, 30).catch(() => null);
    // Drop a stale resolve: the selection moved panes while we awaited. Applying
    // it would paint under the new row and corrupt `lastCaptured`. Mirrors the
    // BackgroundPeek logPath guard above.
    if (props.session?.tmuxPane !== tmuxPane) return false;
    if (paneContent === null) {
      return applyCapture(CAPTURE_FAILED, "Failed to capture pane");
    }
    return applyCapture(paneContent, paneContent);
  };

  createEffect(async () => {
    const tmuxPane = props.session?.tmuxPane;
    if (!tmuxPane) {
      lastCaptured = null;
      setContent(null);
      return;
    }

    lastCaptured = null;
    setContent(null);
    await refreshPane();
  });

  // Forced re-capture: the parent bumps refreshKey when it knows the pane
  // just changed underneath us (e.g. review notes delivered to the agent's
  // composer), so the user sees the outcome without focusing the preview.
  // `on(..., {defer})` tracks only the key: mount and selection changes are
  // already captured by the effects above, and an unfocused preview stays a
  // single snapshot otherwise.
  createEffect(
    on(
      () => props.refreshKey,
      () => {
        if (props.session?.tmuxPane) refreshPane();
      },
      { defer: true },
    ),
  );

  // Background refresh while focused (catches external output). Polls at
  // 500ms while the pane is changing, doubling up to 2s while it is quiet
  // so a silent pane costs 30 captures/min instead of 120.
  createEffect(() => {
    if (!props.focused || !props.session?.tmuxPane) return;

    const MIN_DELAY = props.pollDelays?.min ?? 500;
    const MAX_DELAY = props.pollDelays?.max ?? 2000;
    let delay = MIN_DELAY;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const changed = await refreshPane();
      if (disposed) return;
      delay = changed ? MIN_DELAY : Math.min(delay * 2, MAX_DELAY);
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    onCleanup(() => {
      disposed = true;
      clearTimeout(timer);
    });
  });

  // Bypass reconciler's string conversion by setting content directly on ref
  createEffect(() => {
    let styledContent = content();
    if (textRef && styledContent) {
      try {
        const query = props.searchQuery?.trim();
        if (query) {
          styledContent = highlightSearchMatches(
            styledContent,
            query,
            theme.border,
          );
        }
        textRef.content = styledContent;
      } catch {
        textRef = undefined;
      }
    }
  });

  const effective = () => {
    const s = props.session;
    if (!s) return null;
    return getEffectiveStatus(s);
  };

  const attentionState = () => props.session?.attentionState ?? null;

  const statusColor = () => {
    const s = props.session;
    if (!s) return theme.overlay;
    const attn = attentionState();
    if (s.status === "idle" && attn) return theme.green;
    const eff = effective();
    if (!eff) return theme.overlay;
    return getStatusColor(eff.status, eff.attentionType);
  };

  const statusIcon = useStatusIcon(
    () => effective()?.status ?? "idle",
    () => effective()?.attentionType ?? null,
    () => props.iconStyle,
    attentionState,
  );

  const statusText = () => {
    const s = props.session;
    if (!s) return "";
    const attn = attentionState();
    const eff = effective();
    // Lifted state (lead idle, subagents running) reads "agents",
    // matching the row's StatusBadge.
    if (eff?.status === "working" && eff.fromSubagent) return "agents";
    return s.status === "idle" && attn ? "done" : (eff?.status ?? "");
  };

  /** Live subagents for the Agents section; capped so a large fan-out
   * doesn't crowd out the pane content below. */
  const AGENTS_SHOWN_MAX = 4;
  const liveSubagents = () => props.session?.subagents ?? [];

  const metadataLine = () => {
    const s = props.session;
    if (!s) return "";
    const parts: string[] = [];
    if (s.gitBranch) {
      const branchDisplay = s.isWorktree
        ? `${s.project}:${s.gitBranch} (worktree)`
        : `${s.project}:${s.gitBranch}`;
      parts.push(branchDisplay);
    }
    if (s.version) parts.push(formatVersion(s.version));
    if (s.tmuxTarget) parts.push(s.tmuxTarget);
    if (s.lastUserInputAt) {
      parts.push(formatRelativeTime(new Date(s.lastUserInputAt)));
    }
    return parts.join(" · ");
  };

  return (
    <box
      flexDirection="column"
      width={`${props.width}%`}
      height="100%"
      border={["left"]}
      borderStyle="single"
      borderColor={props.focused ? theme.mauve : theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <Show
        when={props.session}
        fallback={<text fg={theme.overlay}>Select a session to preview</text>}
      >
        <box height={4} flexDirection="column">
          <box flexDirection="row">
            <box flexGrow={1}>
              <text>
                <b>{props.session!.project}</b>
              </text>
            </box>
            <text fg={statusColor()}>
              {statusIcon()} {statusText()}
            </text>
          </box>
          <text fg={theme.subtext}>
            {shortenCwd(props.session!.paneCwd ?? props.session!.cwd)}
          </text>
          <text fg={theme.overlay}>{metadataLine()}</text>
          <text fg={theme.border}>{"─".repeat(separatorWidth())}</text>
        </box>

        <Show when={liveSubagents().length > 0}>
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.subtext}>
              <b>Agents ({liveSubagents().length})</b>
            </text>
            <For each={liveSubagents().slice(0, AGENTS_SHOWN_MAX)}>
              {(sub) => <SubagentRow sub={sub} iconStyle={props.iconStyle} />}
            </For>
            <Show when={liveSubagents().length > AGENTS_SHOWN_MAX}>
              <text fg={theme.overlay}>
                {"  "}+{liveSubagents().length - AGENTS_SHOWN_MAX} more
              </text>
            </Show>
            <text fg={theme.border}>{"─".repeat(separatorWidth())}</text>
          </box>
        </Show>

        <Show when={props.session!.tmuxPane}>
          <Show
            when={content()}
            fallback={<text fg={theme.overlay}>Loading...</text>}
          >
            <scrollbox
              flexGrow={1}
              stickyScroll={true}
              stickyStart="bottom"
              ref={(r: ScrollBoxRenderable) => props.onScrollboxRef?.(r)}
            >
              <text
                wrapMode="none"
                ref={(r: TextRenderable) => (textRef = r)}
              />
            </scrollbox>
          </Show>
        </Show>

        <Show when={!props.session!.tmuxPane}>
          <Show
            when={props.session!.trackingMode === "background"}
            fallback={<text fg={theme.overlay}>No tmux pane associated</text>}
          >
            <BackgroundPeek session={props.session!} />
          </Show>
        </Show>
      </Show>
    </box>
  );
};
