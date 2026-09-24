import { For, Show, type Component } from "solid-js";
import type { RepoFacts } from "../../daemon/repo-facts";
import { VIEWS, type View } from "../actions";
import { theme } from "../theme";
import type { ConnectionState } from "../utils/sse";
import { displayWidth, truncateText } from "../utils/format";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { dotColor } from "./Header";

/** Board-wide signals the strip carries at its right edge. Every field is
 *  optional and silent when healthy, so the default strip is just the views
 *  and the scope. */
export interface StripStatus {
  connectionState?: ConnectionState;
  /** Daemon scans have been failing long enough to serve stale state. */
  daemonDegraded?: boolean;
  /** `ccmux invoke` workers in flight. A Claude invoke has no row of its
   *  own, so this count is the only place it shows. */
  invokeInFlight?: number;
  /** `f` is hiding idle sessions. */
  hideIdle?: boolean;
}

export interface RightSegment {
  text: string;
  fg: string;
}

const SEP = " · ";

/** Not `⚠` (what the sidebar's Header uses): it carries the Emoji property,
 *  so OpenTUI draws it two cells wide while tmux gives it one, and a strip
 *  whose right edge moves leaves the orphaned cell stale (`⚠d degraded`
 *  after a search narrowed the count). `▲` is one cell everywhere. */
const WARN = "▲";

/**
 * The strip's right edge: status signals, then the scope, fitted into
 * `budget` columns. Priority when space runs out, cheapest first:
 * 1. the scope truncates, then drops;
 * 2. `N invoking` drops, then `active`;
 * 3. the connection word shrinks to `●`, then the degraded word to `▲`.
 * The glyphs themselves are never dropped: a broken connection or a
 * degraded daemon outranks anything else the strip could say.
 */
export function rightSegments(
  status: StripStatus,
  scopeLabel: string,
  scopeColor: string,
  budget: number,
): RightSegment[] {
  const connection =
    status.connectionState && status.connectionState !== "connected"
      ? status.connectionState
      : null;
  // Each signal lists its forms from fullest to smallest; "" means dropped.
  type Signal = { forms: string[]; fg: string; shrink: number };
  const signals: Signal[] = [];
  // `shrink` orders rule 2 before rule 3 (lower shrinks first).
  if (connection)
    signals.push({
      forms: [`● ${connection}`, "●"],
      fg: dotColor(connection),
      shrink: 2,
    });
  if (status.daemonDegraded)
    signals.push({ forms: [`${WARN} degraded`, WARN], fg: theme.yellow, shrink: 3 });
  if (status.invokeInFlight)
    signals.push({
      forms: [`${status.invokeInFlight} invoking`, ""],
      fg: theme.peach,
      shrink: 0,
    });
  if (status.hideIdle)
    signals.push({ forms: ["active", ""], fg: theme.overlay, shrink: 1 });
  const level = signals.map(() => 0);
  const steps = signals
    .map((s, i) => ({ i, shrink: s.shrink }))
    .sort((x, y) => x.shrink - y.shrink)
    .map((x) => x.i);
  const shown = () =>
    signals
      .map((s, i) => ({ text: s.forms[level[i]!]!, fg: s.fg }))
      .filter((s) => s.text);
  const width = (segs: RightSegment[]) =>
    segs.reduce((n, s) => n + displayWidth(s.text), 0) +
    Math.max(0, segs.length - 1) * SEP.length;
  for (const i of steps) {
    if (width(shown()) <= budget) break;
    level[i] = signals[i]!.forms.length - 1;
  }
  const segs = shown();
  const used = width(segs);
  // Signals shrink only when they overflow with no scope at all, so whatever
  // is left over is room no higher-ranked signal could use: the scope takes it.
  const room = budget - used - (segs.length ? SEP.length : 0);
  const scope =
    room <= 0 ? "" : room === 1 ? "…" : truncateText(scopeLabel, room);
  return scope ? [...segs, { text: scope, fg: scopeColor }] : segs;
}

export const ViewStrip: Component<
  StripStatus & {
    view: View;
    scope: string | null;
    sessions: number;
    /** Sessions before `f` or a search filter hid any; shown as `n/total`. */
    total?: number;
    facts: RepoFacts[];
    onView: (view: View) => void;
  }
> = (props) => {
  const dims = useSharedTerminalDimensions();
  const repos = () =>
    props.facts.filter((r) => !props.scope || r.repoRoot === props.scope);
  const count = (view: View): number | string | undefined => {
    if (view === "sessions")
      return props.total == null
        ? props.sessions
        : `${props.sessions}/${props.total}`;
    const values = repos();
    if (!values.length) return undefined;
    if (view === "worktrees")
      return values.every((r) => r.worktrees)
        ? values.reduce((n, r) => n + r.worktrees!.value.worktrees.length, 0)
        : undefined;
    return values.every((r) => r.counts)
      ? values.reduce(
          (n, r) => n + r.counts!.value.prs + r.counts!.value.issues,
          0,
        )
      : undefined;
  };
  const stale = (view: View) =>
    view === "sessions"
      ? false
      : repos().some((r) =>
          view === "worktrees" ? r.worktrees?.stale : r.counts?.stale,
        );
  const label = (view: View) =>
    `${view === "sessions" ? "Sessions" : view === "worktrees" ? "Worktrees" : "Start"}${count(view) === undefined ? "" : ` ${count(view)}${stale(view) ? " ~" : ""}`}`;
  const right = () => {
    const left = VIEWS.reduce((n, v) => n + displayWidth(label(v)) + 3, 0);
    return rightSegments(
      props,
      props.scope?.split("/").pop() ?? "all repos",
      props.scope ? theme.blue : theme.overlay,
      dims().width - left - 3,
    );
  };
  return (
    <box
      height={1}
      width="100%"
      paddingLeft={1}
      paddingRight={1}
      flexDirection="row"
    >
      <For each={VIEWS}>
        {(view) => (
          <box
            height={1}
            flexDirection="row"
            onMouseDown={() => props.onView(view)}
          >
            <text
              bg={view === props.view ? theme.surface : undefined}
              fg={view === props.view ? theme.text : theme.subtext}
            >
              <Show when={view === props.view} fallback={` ${label(view)} `}>
                <b>{` ${label(view)} `}</b>
              </Show>
            </text>
            <text> </text>
          </box>
        )}
      </For>
      <box flexGrow={1} />
      <box height={1} flexDirection="row">
        <For each={right()}>
          {(seg, i) => (
            <text>
              <Show when={i() > 0}>
                <span style={{ fg: theme.overlay }}>{SEP}</span>
              </Show>
              <span style={{ fg: seg.fg }}>{seg.text}</span>
            </text>
          )}
        </For>
      </box>
    </box>
  );
};
