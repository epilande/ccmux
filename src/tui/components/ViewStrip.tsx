import { For, Show, type Component } from "solid-js";
import type { RepoFacts } from "../../daemon/repo-facts";
import { VIEWS, type View } from "../actions";
import { theme } from "../theme";
import type { ConnectionState } from "../utils/sse";
import { displayWidth, truncateText } from "../utils/format";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { dotColor } from "./Header";

const VIEW_NAMES: Record<View, string> = {
  sessions: "Sessions",
  worktrees: "Worktrees",
  start: "Start",
};

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

/** Between two signals, and between the last signal and `scope:`. */
export const SEP = " · ";
/** The scope's label, never truncated: only the name after it is. */
const SCOPE_PREFIX = "scope: ";
/** Columns the right end spends around its content: the space that ends the
 *  rule's fill, and the ` ──` that closes the line. */
const RIGHT_DRESSING = 4;

/** Not `⚠` (what the sidebar's Header uses): it carries the Emoji property,
 *  so OpenTUI draws it two cells wide while tmux gives it one, and a strip
 *  whose right edge moves leaves the orphaned cell stale (`⚠d degraded`
 *  after a search narrowed the count). `▲` is one cell everywhere. */
const WARN = "▲";

/**
 * The strip's right end: status signals, then the scope's name, fitted into
 * `budget` columns (the scope's `scope: ` prefix is charged here too, but
 * never truncated). Priority when space runs out, cheapest first:
 * 1. the scope's name truncates, then drops with its prefix (a name budget
 *    under two columns would draw a lone `…`, which says nothing);
 * 2. `N invoking` drops, then `active`;
 * 3. the connection word shrinks to `●`, then the degraded word to `▲`.
 * The glyphs themselves are never dropped: a broken connection or a
 * degraded daemon outranks anything else the strip could say.
 */
export function rightSegments(
  status: StripStatus,
  scopeName: string,
  budget: number,
): { signals: RightSegment[]; scope: string } {
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
    signals.push({
      forms: [`${WARN} degraded`, WARN],
      fg: theme.yellow,
      shrink: 3,
    });
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
  // Signals shrink only when they overflow with no scope at all, so whatever
  // is left over is room no higher-ranked signal could use: the scope takes it.
  const room =
    budget - width(segs) - (segs.length ? SEP.length : 0) - SCOPE_PREFIX.length;
  return {
    signals: segs,
    scope: room < 2 ? "" : truncateText(scopeName, room),
  };
}

/**
 * The view strip is a titled RULE, not a row of chips: `━━ Sessions ·2 ──
 * Worktrees ── Start ───────── scope: all repos ──`. Drawn that way so the
 * line above the list reads as chrome at a glance. A row of names on a plain
 * background looked like one more data row, and the column-header line that
 * follows it (see `SessionList`) then had nothing to set it apart from.
 *
 * Three cues mark the active view, and the head line below claims none of
 * them: its rule stub is the accent bar (`━━` in `theme.blue` where the
 * others are `──` in `theme.border`), its name is bold, and its name is the
 * text color where the others are subtext. The count rides after the name in
 * the overlay color (`·2`, or `·2/8` while `f` or a search hides rows) so the
 * name reads alone. The scope carries a `scope:` prefix because bare at the
 * right edge it read as a column label over the last column.
 *
 * Board-wide signals (see `StripStatus`) sit inside the rule's right end,
 * ahead of `scope:` and joined to it by the same ` · `: `──── ● reconnecting
 * · 1 invoking · scope: all repos ──`. A healthy board draws none of them,
 * so its strip is exactly the plain titled rule.
 */
export const ViewStrip: Component<
  StripStatus & {
    view: View;
    scope: string | null;
    sessions: number;
    /** Sessions before `f` or a search filter hid any; shown as `·n/total`. */
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
  // The name and its count are separate runs so the count can go quieter.
  const countText = (view: View) =>
    count(view) === undefined
      ? ""
      : ` ·${count(view)}${stale(view) ? "~" : ""}`;
  const tabWidth = (view: View) =>
    displayWidth(VIEW_NAMES[view]) + displayWidth(countText(view));
  // Every tab is `stub(3) + name + count + space(1)`.
  const tabsWidth = () => VIEWS.reduce((n, v) => n + 4 + tabWidth(v), 0);
  const right = () =>
    rightSegments(
      props,
      props.scope?.split("/").pop() ?? "all repos",
      dims().width - 2 - tabsWidth() - RIGHT_DRESSING,
    );
  const rightWidth = () => {
    const { signals, scope } = right();
    const parts = [
      ...signals.map((s) => s.text),
      ...(scope ? [SCOPE_PREFIX + scope] : []),
    ];
    return parts.length
      ? parts.reduce((n, p) => n + displayWidth(p), 0) +
          (parts.length - 1) * SEP.length +
          RIGHT_DRESSING
      : 0;
  };
  /** The right end as text nodes, each a run of colored spans. */
  const rightNodes = (): RightSegment[][] => {
    const { signals, scope } = right();
    const nodes: RightSegment[][] = signals.map((seg) => [seg]);
    if (scope)
      nodes.push([
        { text: SCOPE_PREFIX, fg: theme.overlay },
        { text: scope, fg: props.scope ? theme.blue : theme.subtext },
      ]);
    nodes.forEach((node, i) =>
      node.push(
        i < nodes.length - 1
          ? { text: SEP, fg: theme.overlay }
          : { text: " ──", fg: theme.border },
      ),
    );
    return nodes;
  };
  const fill = () => Math.max(0, dims().width - 2 - tabsWidth() - rightWidth());
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
            <text fg={view === props.view ? theme.blue : theme.border}>
              {view === props.view ? "━━ " : "── "}
            </text>
            <text fg={view === props.view ? theme.text : theme.subtext}>
              <Show when={view === props.view} fallback={VIEW_NAMES[view]}>
                <b>{VIEW_NAMES[view]}</b>
              </Show>
            </text>
            {/* Guarded: an empty text node still paints one column. */}
            <Show when={countText(view)}>
              <text fg={theme.overlay}>{countText(view)}</text>
            </Show>
            <text> </text>
          </box>
        )}
      </For>
      {/* The gap before the right end rides on the rule's text: the renderer
          drops a text node's leading space and keeps a trailing one. */}
      <text fg={theme.border}>
        {"─".repeat(fill()) + (rightWidth() ? " " : "")}
      </text>
      {/* One text node per item, each carrying the separator or closing
          rule that FOLLOWS it: dynamic children inside a single text node
          are appended rather than inserted in place (a signal arriving after
          the scope drew behind it), and a node's leading space is dropped. */}
      <For each={rightNodes()}>
        {(node) => (
          <text>
            <For each={node}>
              {(span) => <span style={{ fg: span.fg }}>{span.text}</span>}
            </For>
          </text>
        )}
      </For>
    </box>
  );
};
