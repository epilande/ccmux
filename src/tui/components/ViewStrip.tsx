import { createMemo, For, Show, type Component } from "solid-js";
import type { RepoFacts } from "../../daemon/repo-facts";
import { VIEWS, type View } from "../actions";
import { theme } from "../theme";
import { Text } from "./Text";
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

/** Between two signals, and between the last signal and the scope. */
const SEP = " · ";
/** The scope's label, longest first: a tight strip shortens it, and only
 *  then drops it, before the name after it is ever cut. */
const SCOPE_PREFIXES = ["scope: ", "in ", ""] as const;
/** Columns the right end spends around its content: the space that ends the
 *  rule's fill. Nothing follows the scope's name: the strip ends on it, at
 *  the last column, the way it starts on "Sessions" at the first. */
const RIGHT_DRESSING = 1;
/** Columns every tab spends besides its name and count: the `── ` stub and
 *  the space after it. The first tab has no stub (see `tabDressing`). */
const TAB_DRESSING = 4;
/** The rule stub drawn before every tab but the first. */
const TAB_STUB = 3;

/** What `view`'s tab spends besides its name and count. The first tab starts
 *  flush at column 0, so it pays only for the space after it. */
function tabDressing(view: View): number {
  return view === VIEWS[0] ? TAB_DRESSING - TAB_STUB : TAB_DRESSING;
}
/** Rule cells kept between the tabs and the right end, so the two never
 *  run together as `Start  in api-server`. */
const MIN_FILL = 1;

/** What every tab's name shrinks to on a strip too narrow for the scope's
 *  name. Two letters so Sessions and Start stay apart. */
const SHORT_VIEW_NAMES: Record<View, string> = {
  sessions: "Se",
  worktrees: "Wt",
  start: "St",
};

/** Not `⚠` (what the sidebar's Header uses): it carries the Emoji property,
 *  so OpenTUI draws it two cells wide while tmux gives it one, and a strip
 *  whose right edge moves leaves the orphaned cell stale (`⚠d degraded`
 *  after a search narrowed the count). `▲` is one cell everywhere. */
const WARN = "▲";

/** One tab as fitted: the name it shows and its count (`""` when dropped). */
export interface FittedTab {
  name: string;
  count: string;
}

/** The whole strip as fitted to its width. */
export interface StripFit {
  tabs: Record<View, FittedTab>;
  signals: RightSegment[];
  /** `scope: `, `in `, or `""`. */
  prefix: string;
  scope: string;
}

/**
 * Fit the strip into `width` columns (inside its padding), giving way from
 * the least important part up so the scope's NAME stays whole: it says which
 * repo every list on screen is narrowed to, and `scope: d…` says nothing.
 *
 * In order, until the line fits:
 * 1. `N invoking` drops, then `active`, then the connection and degraded
 *    words shrink to `●` and `▲`. The glyphs are never dropped: a broken
 *    connection or a degraded daemon outranks anything else here.
 * 2. `scope: ` shortens to `in `: a word is cheaper to lose than the
 *    counts, which are data.
 * 3. Every tab drops its count.
 * 4. Every tab shortens its name to two letters.
 * 5. The prefix drops.
 * 6. Only then, on a strip too narrow for the name even so, the name is
 *    cut (and below two columns, dropped).
 *
 * The tab steps apply to all three tabs together, and the fit is not told
 * which view is active: the active tab differs only in color and weight, so
 * switching views never moves a label. (A `W`/`N` jump can still change the
 * current view's count TEXT, which is data, not layout.)
 */
export function fitStrip(input: {
  /** Each tab's count as drawn after its name (` (6)`), or `""`. */
  counts: Record<View, string>;
  status: StripStatus;
  scopeName: string;
  width: number;
}): StripFit {
  const { status } = input;
  const connection =
    status.connectionState && status.connectionState !== "connected"
      ? status.connectionState
      : null;
  // Each signal lists its forms from fullest to smallest; "" means dropped.
  type Signal = { forms: string[]; fg: string; shrink: number };
  const signals: Signal[] = [];
  // `shrink` orders the signal steps (lower shrinks first).
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
    signals.push({ forms: ["active", ""], fg: theme.subtext, shrink: 1 });
  const level = signals.map(() => 0);
  const shown = (): RightSegment[] =>
    signals
      .map((s, i) => ({ text: s.forms[level[i]!]!, fg: s.fg }))
      .filter((s) => s.text);

  const tabs = Object.fromEntries(
    VIEWS.map((v) => [v, { name: VIEW_NAMES[v], count: input.counts[v] }]),
  ) as Record<View, FittedTab>;
  let prefix: string = SCOPE_PREFIXES[0];
  let scope = input.scopeName;

  const used = () => {
    const tabCols = VIEWS.reduce(
      (n, v) =>
        n +
        tabDressing(v) +
        displayWidth(tabs[v].name) +
        displayWidth(tabs[v].count),
      0,
    );
    const parts = [
      ...shown().map((s) => s.text),
      ...(scope ? [prefix + scope] : []),
    ];
    const rightCols = parts.length
      ? parts.reduce((n, p) => n + displayWidth(p), 0) +
        (parts.length - 1) * SEP.length +
        RIGHT_DRESSING +
        MIN_FILL
      : 0;
    return tabCols + rightCols;
  };
  const fits = () => used() <= input.width;

  const steps: (() => void)[] = [
    ...signals
      .map((s, i) => ({ i, shrink: s.shrink }))
      .sort((x, y) => x.shrink - y.shrink)
      .map(
        ({ i }) =>
          () =>
            (level[i] = signals[i]!.forms.length - 1),
      ),
    () => (prefix = SCOPE_PREFIXES[1]),
    () => VIEWS.forEach((v) => (tabs[v].count = "")),
    () => VIEWS.forEach((v) => (tabs[v].name = SHORT_VIEW_NAMES[v])),
    () => (prefix = SCOPE_PREFIXES[2]),
  ];
  for (const step of steps) {
    if (fits()) break;
    step();
  }
  if (!fits()) {
    // The last resort: what the name has left once everything else is at
    // its smallest. Below two columns it would be a lone `…`.
    const room = input.width - (used() - displayWidth(scope));
    scope = room < 2 ? "" : truncateText(scope, room);
  }
  return { tabs, signals: shown(), prefix: scope ? prefix : "", scope };
}

/**
 * The view strip is a titled RULE, not a row of chips: `Sessions (2) ──
 * Worktrees ── Start ───────── scope: all repos`. Drawn that way so the
 * line above the list reads as chrome at a glance. A row of names on a plain
 * background looked like one more data row, and the column-header line that
 * follows it (see `SessionList`) then had nothing to set it apart from. The
 * first tab starts flush at column 0 with no rule before it, and the line
 * ends on the scope's name at the last column with none after it.
 *
 * The active view is marked by its label alone, the lazygit way: its name
 * and count are bold and in the accent color (`theme.blue`), where the
 * others are plain subtext. The rules between tabs are all the same
 * `theme.border` `──`, so switching views changes colors and weight but
 * never a column. The count rides after the name (`(2)`, or `(2/8)` while a
 * scope, `f` or a search hides rows). Each count is taken in its OWN view's scope:
 * a `W`/`N` jump narrows only the view it opened, so the other tabs count in
 * the base scope they will show when reached. The scope carries a `scope:`
 * prefix because bare at the right edge it read as a column label over the
 * last column; it names the current view's scope, and a narrow strip gives
 * up everything else before it cuts that name (see `fitStrip`).
 *
 * Board-wide signals (see `StripStatus`) sit inside the rule's right end,
 * ahead of `scope:` and joined to it by the same ` · `: `──── ● reconnecting
 * · 1 invoking · scope: all repos`. A healthy board draws none of them,
 * so its strip is exactly the plain titled rule.
 */
export const ViewStrip: Component<
  StripStatus & {
    view: View;
    /** The current view's scope. */
    scope: string | null;
    /** The scope every other view uses: differs from `scope` only while the
     *  current view is a `W`/`N` jump. Defaults to `scope`. */
    baseScope?: string | null;
    /** Sessions in the Sessions view's own scope and filters. */
    sessions: number;
    /** Sessions before a scope, `f` or a search hid any; shown as
     *  `(n/total)`. */
    total?: number;
    facts: RepoFacts[];
    onView: (view: View) => void;
  }
> = (props) => {
  const dims = useSharedTerminalDimensions();
  const scopeOf = (view: View) =>
    view === props.view
      ? props.scope
      : props.baseScope === undefined
        ? props.scope
        : props.baseScope;
  const repos = (view: View) => {
    const scope = scopeOf(view);
    return props.facts.filter((r) => !scope || r.repoRoot === scope);
  };
  const sum = (view: View, from: RepoFacts[]): number | undefined => {
    // A repo that never answered (no GitHub remote, say) must not blank the
    // total for every other repo; it only makes the sum partial, see `stale`.
    const values = from.flatMap((r) =>
      view === "worktrees"
        ? r.worktrees
          ? [r.worktrees.value.worktrees.length]
          : []
        : r.counts
          ? [r.counts.value.prs + r.counts.value.issues]
          : [],
    );
    return values.length ? values.reduce((n, v) => n + v, 0) : undefined;
  };
  const count = (view: View): number | string | undefined => {
    if (view === "sessions")
      return props.total == null
        ? props.sessions
        : `${props.sessions}/${props.total}`;
    const shown = sum(view, repos(view));
    if (shown === undefined || !scopeOf(view)) return shown;
    // Scoped: the total says how much the scope is hiding, the same way
    // the Sessions count does.
    return `${shown}/${sum(view, props.facts) ?? shown}`;
  };
  // Over every repo whose fact the count draws on, which is all of them
  // once a scoped count shows its total.
  const stale = (view: View) =>
    view === "sessions"
      ? false
      : (scopeOf(view) ? props.facts : repos(view)).some((r) => {
          const fact = view === "worktrees" ? r.worktrees : r.counts;
          return !fact || fact.stale;
        });
  // The name and its count are separate runs so the count can go quieter.
  const countText = (view: View) =>
    count(view) === undefined
      ? ""
      : ` (${count(view)}${stale(view) ? "~" : ""})`;
  const fit = createMemo(() =>
    fitStrip({
      counts: {
        sessions: countText("sessions"),
        worktrees: countText("worktrees"),
        start: countText("start"),
      },
      status: props,
      scopeName: props.scope?.split("/").pop() ?? "all repos",
      // No padding either side: the first tab starts at column 0, and the
      // scope's name ends on the last.
      width: dims().width,
    }),
  );
  const tabsWidth = () =>
    VIEWS.reduce(
      (n, v) =>
        n +
        tabDressing(v) +
        displayWidth(fit().tabs[v].name) +
        displayWidth(fit().tabs[v].count),
      0,
    );
  const rightWidth = () => {
    const { signals, prefix, scope } = fit();
    const parts = [
      ...signals.map((s) => s.text),
      ...(scope ? [prefix + scope] : []),
    ];
    return parts.length
      ? parts.reduce((n, p) => n + displayWidth(p), 0) +
          (parts.length - 1) * SEP.length +
          RIGHT_DRESSING
      : 0;
  };
  /** The right end as text nodes, each a run of colored spans. */
  const rightNodes = (): RightSegment[][] => {
    const { signals, prefix, scope } = fit();
    const nodes: RightSegment[][] = signals.map((seg) => [seg]);
    if (scope)
      nodes.push([
        ...(prefix ? [{ text: prefix, fg: theme.subtext }] : []),
        { text: scope, fg: props.scope ? theme.blue : theme.subtext },
      ]);
    nodes.forEach((node, i) => {
      if (i < nodes.length - 1) node.push({ text: SEP, fg: theme.overlay });
    });
    return nodes;
  };
  /** A tab's name and its count, as fitted. */
  const tabLabel = (view: View) =>
    fit().tabs[view].name + fit().tabs[view].count;
  const fill = () => Math.max(0, dims().width - tabsWidth() - rightWidth());
  return (
    <box
      height={1}
      width="100%"
      paddingLeft={0}
      paddingRight={0}
      flexDirection="row"
    >
      <For each={VIEWS}>
        {(view) => (
          <box
            height={1}
            flexDirection="row"
            onMouseDown={() => props.onView(view)}
          >
            {/* The rules BETWEEN tabs, all alike: the first tab has none
                before it, and no tab gets an accent of its own. */}
            <Show when={view !== VIEWS[0]}>
              <Text fg={theme.border}>{"── "}</Text>
            </Show>
            {/* The label, count included, is one run: accent and bold while
                active, subtext otherwise. Neither changes its width, so
                switching views never moves the strip. */}
            <Text fg={view === props.view ? theme.blue : theme.subtext}>
              <Show when={view === props.view} fallback={tabLabel(view)}>
                <b>{tabLabel(view)}</b>
              </Show>
            </Text>
            <Text> </Text>
          </box>
        )}
      </For>
      {/* The gap before the right end rides on the rule's text: the renderer
          drops a text node's leading space and keeps a trailing one. */}
      <Text fg={theme.border}>
        {"─".repeat(fill()) + (rightWidth() ? " " : "")}
      </Text>
      {/* One text node per item, each carrying the separator that FOLLOWS
          it (the last carries none): dynamic children inside a single text node
          are appended rather than inserted in place (a signal arriving after
          the scope drew behind it), and a node's leading space is dropped. */}
      <For each={rightNodes()}>
        {(node) => (
          <Text>
            <For each={node}>
              {(span) => <span style={{ fg: span.fg }}>{span.text}</span>}
            </For>
          </Text>
        )}
      </For>
    </box>
  );
};
