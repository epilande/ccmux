import { For, Show, type Component } from "solid-js";
import type { RepoFacts } from "../../daemon/repo-facts";
import { VIEWS, type View } from "../actions";
import { theme } from "../theme";
import { displayWidth, truncateText } from "../utils/format";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";

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
  const label = (view: View) =>
    `${view === "sessions" ? "Sessions" : view === "worktrees" ? "Worktrees" : "Start"}${count(view) === undefined ? "" : ` ${count(view)}${stale(view) ? " ~" : ""}`}`;
  const scope = () => {
    const left = VIEWS.reduce((n, v) => n + displayWidth(label(v)) + 3, 0);
    const budget = dims().width - left - 3;
    if (budget <= 0) return "";
    if (budget === 1) return "…";
    return truncateText(props.scope?.split("/").pop() ?? "all repos", budget);
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
      <text fg={props.scope ? theme.blue : theme.overlay}>{scope()}</text>
    </box>
  );
};
