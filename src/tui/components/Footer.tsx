import type { Component } from "solid-js";
import { Switch, Match } from "solid-js";
import { DEFAULT_GROUP_BY, type GroupBy } from "../../lib/preferences";
import { theme } from "../theme";

interface FooterProps {
  searchMode: boolean;
  confirmMode?: boolean;
  helpMode?: boolean;
  previewFocused?: boolean;
  persistent?: boolean;
  groupBy?: GroupBy;
  reviewable?: boolean;
}

export const Footer: Component<FooterProps> = (props) => {
  return (
    <box
      width="100%"
      height={2}
      paddingLeft={1}
      paddingRight={1}
      border={["top"]}
      borderStyle="single"
      borderColor={theme.border}
    >
      <Switch>
        <Match when={props.helpMode}>
          <text fg={theme.overlay}>? or Esc close</text>
        </Match>
        <Match when={props.previewFocused}>
          <text fg={theme.overlay}>tab/esc exit focus · keys sent to pane</text>
        </Match>
        <Match when={props.confirmMode}>
          <text fg={theme.overlay}>y confirm · n/Esc cancel</text>
        </Match>
        <Match when={props.searchMode}>
          <text fg={theme.overlay}>
            type to search · ^n/^p nav · enter{" "}
            {props.persistent ? "switch" : "select"} · esc cancel
          </text>
        </Match>
        <Match when={true}>
          <text fg={theme.overlay}>
            j/k nav · enter {props.persistent ? "switch" : "select"} · / search
            · b group:{props.groupBy ?? DEFAULT_GROUP_BY} · P preview · r
            restart · x kill{props.reviewable ? " · d review" : ""} · ? help · q
            quit
          </text>
        </Match>
      </Switch>
    </box>
  );
};
