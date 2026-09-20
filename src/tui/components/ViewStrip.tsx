import { For, Show, type Component } from "solid-js";
import type { RepoFacts } from "../../daemon/repo-facts";
import { VIEWS, type View } from "../actions";
import { theme } from "../theme";
import { displayWidth, truncateText } from "../utils/format";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";

const VIEW_NAMES: Record<View, string> = {
  sessions: "Sessions",
  worktrees: "Worktrees",
  start: "Start",
};

/** Columns spent on the scope's fixed dressing: `" scope: "` and `" ──"`. */
const SCOPE_DRESSING = 11;

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
 * the overlay color (`·2`) so the name reads alone. The scope carries a
 * `scope:` prefix because bare at the right edge it read as a column label
 * over the last column.
 */
export const ViewStrip: Component<{
  view: View;
  scope: string | null;
  sessions: number;
  facts: RepoFacts[];
  onView: (view: View) => void;
}> = (props) => {
  const dims = useSharedTerminalDimensions();
  const repos = () =>
    props.facts.filter((r) => !props.scope || r.repoRoot === props.scope);
  const count = (view: View): number | undefined => {
    if (view === "sessions") return props.sessions;
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
  const scopeName = () => props.scope?.split("/").pop() ?? "all repos";
  /** The scope as drawn, or "" when the strip cannot afford it. A budget of
   *  one column would draw a lone `…` after `scope:`, which says nothing. */
  const scopeLabel = () => {
    const budget = dims().width - 2 - tabsWidth() - SCOPE_DRESSING;
    return budget < 2 ? "" : truncateText(scopeName(), budget);
  };
  const fill = () =>
    Math.max(
      0,
      dims().width -
        2 -
        tabsWidth() -
        (scopeLabel() ? displayWidth(scopeLabel()) + SCOPE_DRESSING : 0),
    );
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
      {/* The gap before `scope:` rides on the rule's text: the renderer
          drops a text node's leading space and keeps a trailing one. */}
      <text fg={theme.border}>
        {"─".repeat(fill()) + (scopeLabel() ? " " : "")}
      </text>
      <Show when={scopeLabel()}>
        <text fg={theme.overlay}>{"scope: "}</text>
        <text fg={props.scope ? theme.blue : theme.subtext}>{scopeLabel()}</text>
        <text fg={theme.border}>{" ──"}</text>
      </Show>
    </box>
  );
};
