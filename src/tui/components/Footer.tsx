import type { Component } from "solid-js";
import { Switch, Match } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { DEFAULT_GROUP_BY, type GroupBy } from "../../lib/preferences";
import { theme } from "../theme";

interface FooterProps {
  searchMode: boolean;
  confirmMode?: boolean;
  helpMode?: boolean;
  previewFocused?: boolean;
  persistent?: boolean;
  groupBy?: GroupBy;
  newSessionMode?: boolean;
  /**
   * What the dialog's focused option field is doing, because the keys change
   * with it: `focused` (a collapsed pill has focus, space opens its dropdown),
   * `dropdown` (an overlay is open and owns every key), or undefined for a
   * text field.
   */
  newSessionOption?: "focused" | "dropdown";
  reviewable?: boolean;
}

/** The box pads one column on each side. */
const FOOTER_PADDING = 2;

const HINT_SEPARATOR = " · ";

export interface HintSegment {
  text: string;
  /** Which hints survive a narrow terminal. Lowest rank is dropped first;
   *  ties drop right-to-left. See `defaultHints` for the scale. */
  rank: number;
}

/**
 * The widest prefix of `segments` that fits `width`, dropping whole hints
 * by rank rather than truncating the line mid-word.
 *
 * The default hint line grew past 120 columns once `n new` was added (121
 * characters at `group:project` with `d review` present), which clipped
 * `quit` — the one hint a stuck user most needs. Every picker feature wants
 * a footer hint, so budgeting them by rank keeps the next one from having
 * to be withheld for want of room.
 *
 * Pure and exported for tests.
 */
export function fitHints(segments: HintSegment[], width: number): string {
  // Display order is preserved throughout; only whole entries are removed.
  const kept = [...segments];
  const render = () => kept.map((segment) => segment.text).join(HINT_SEPARATOR);

  while (kept.length > 1 && render().length > width) {
    // Drop the lowest rank, and among equals the rightmost, so the line
    // shortens from the end the eye scans last.
    let victim = 0;
    for (let i = 1; i < kept.length; i++) {
      if (kept[i]!.rank <= kept[victim]!.rank) victim = i;
    }
    kept.splice(victim, 1);
  }
  return render();
}

/**
 * The new-session dialog's key hints, authored once for both surfaces: the
 * Footer joins them into one line, and the dialog renders the same segments
 * with its own width-drop rules and click targets. First and last are always
 * the two exits (confirm and esc), which is what the dialog's structure
 * leans on. Wording is sized to the DIALOG's 61-column hint row — "tab
 * field" and "1-9 pick", not the longer forms — since the footer has columns
 * to spare and the dialog does not. j/k (cycle a collapsed pill, move the
 * open list) is taught by the dropdown state's own line instead.
 */
export function newSessionHintSegments(
  state: "text" | "focused" | "dropdown",
): { key: string; gloss: string }[] {
  if (state === "dropdown") {
    return [
      { key: "enter/space", gloss: "select" },
      { key: "j/k", gloss: "move" },
      { key: "esc", gloss: "cancel" },
    ];
  }
  return [
    { key: "enter", gloss: "spawn" },
    { key: "tab", gloss: "field" },
    { key: "1-9", gloss: "pick" },
    // The opener, taught only where an option field is holding the keys.
    ...(state === "focused" ? [{ key: "space", gloss: "open" }] : []),
    { key: "esc", gloss: "cancel" },
  ];
}

/** The default (no-mode) hints, in display order. */
export function defaultHints(props: {
  persistent?: boolean;
  groupBy?: GroupBy;
  reviewable?: boolean;
}): HintSegment[] {
  return [
    // Ranks, loosely: view toggles (1) go before actions on the selected
    // session (2), which go before navigation (3-4), which goes before the
    // two ways out (5-6). `q quit` outranks even `? help` so the last hint
    // standing is how to leave.
    { text: "j/k nav", rank: 3 },
    { text: `enter ${props.persistent ? "switch" : "select"}`, rank: 4 },
    { text: "n new", rank: 3 },
    { text: "/ search", rank: 2 },
    { text: `b group:${props.groupBy ?? DEFAULT_GROUP_BY}`, rank: 1 },
    { text: "P preview", rank: 1 },
    { text: "r restart", rank: 2 },
    { text: "x kill", rank: 2 },
    ...(props.reviewable ? [{ text: "d review", rank: 2 }] : []),
    { text: "? help", rank: 5 },
    { text: "q quit", rank: 6 },
  ];
}

export const Footer: Component<FooterProps> = (props) => {
  const dims = useTerminalDimensions();
  const hints = () =>
    fitHints(defaultHints(props), Math.max(1, dims().width - FOOTER_PADDING));

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
        <Match when={props.newSessionMode}>
          <text fg={theme.overlay}>
            {newSessionHintSegments(props.newSessionOption ?? "text")
              .map((segment) => `${segment.key} ${segment.gloss}`)
              .join(HINT_SEPARATOR)}
          </text>
        </Match>
        <Match when={props.searchMode}>
          <text fg={theme.overlay}>
            type to search · ↑/↓ or ^n/^p nav · enter{" "}
            {props.persistent ? "switch" : "select"} · esc cancel
          </text>
        </Match>
        <Match when={true}>
          <text fg={theme.overlay}>{hints()}</text>
        </Match>
      </Switch>
    </box>
  );
};
