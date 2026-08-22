import type { Component } from "solid-js";
import { Switch, Match } from "solid-js";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
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
  /** A handoff is being aimed at a row, which changes what the keys do. */
  handoffPickMode?: boolean;
  /** The Hand off dialog is open (the pick already landed). */
  handoffDialogMode?: boolean;
  /** The Copy dialog is open. */
  copyDialogMode?: boolean;
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
 * The new-session dialog's key hints. The Footer is the ONLY renderer: it
 * joins them into one line. The dialog itself drew these segments until the
 * sidebar's hint rows were removed, so the surface that has no footer now
 * shows no hints at all, deliberately (enter/esc in a dialog is convention,
 * and the rail has no columns to spend teaching it).
 *
 * First and last are the two exits (confirm and esc). Nothing enforces or
 * consumes that ordering any more, since the Footer joins positionally
 * indifferently, so treat it as a convention rather than a contract.
 * Likewise the terse wording ("tab field", "1-9 pick", not the longer forms)
 * is a leftover of the dialog's old 61-column hint row; the footer has
 * columns to spare, so these are free to grow. j/k (cycle a collapsed pill,
 * move the open list) is taught by the dropdown state's own line instead.
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

/**
 * The Hand off dialog's key hints, on the same terms as
 * `newSessionHintSegments`: the Footer is the only renderer and joins them
 * into one line. The sidebar has no footer and draws no hints of its own, so
 * these reach the picker only. First and last are the two exits, by
 * convention rather than by any contract.
 */
export function handoffDialogHintSegments(): { key: string; gloss: string }[] {
  return [
    { key: "enter", gloss: "send" },
    { key: "j/k", gloss: "turns" },
    { key: "tab", gloss: "note" },
    { key: "esc", gloss: "cancel" },
  ];
}

/** The Copy dialog's key hints; see `handoffDialogHintSegments`. */
export function copyDialogHintSegments(): { key: string; gloss: string }[] {
  return [
    { key: "enter", gloss: "copy" },
    { key: "j/k", gloss: "turns" },
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
    // Ranks, loosely: the hints something ELSE also teaches (1) go before the
    // ones this line is the only home for (2), which go before navigation
    // (3-4), which goes before the two ways out (5-6). `q quit` outranks even
    // `? help` so the last hint standing is how to leave.
    //
    // Rank 1 is what a narrow terminal can afford to forget, and `r`/`x` sit
    // there because the row menu (`m`) now names Restart and Kill on the row
    // itself, hint and all. The footer taught them when it was the only thing
    // that did; a second, discoverable home is what buys the columns back.
    //
    // Ties drop RIGHTMOST first (see `fitHints`), so within rank 1 the order
    // is kill, restart, preview, group — the two menu-backed actions before
    // the two view toggles, which have no home but this line and `?`. That
    // falls out of display order rather than being stated, so a reshuffle of
    // this array is a reshuffle of the drop order too.
    { text: "j/k nav", rank: 3 },
    { text: `enter ${props.persistent ? "switch" : "select"}`, rank: 4 },
    { text: "n new", rank: 3 },
    { text: "/ search", rank: 2 },
    { text: `b group:${props.groupBy ?? DEFAULT_GROUP_BY}`, rank: 1 },
    { text: "P preview", rank: 1 },
    { text: "r restart", rank: 1 },
    { text: "x kill", rank: 1 },
    // Rank 1, and rightmost within it, so it is the FIRST hint a narrowing
    // terminal gives up. `W` was previously taught only by the help overlay,
    // which is why it needs a home here at all; it is also the one action on
    // this line that opens a surface with its own hints, so losing the
    // pointer costs less than losing any of the keys above.
    { text: "W worktrees", rank: 1 },
    // Stays at 2 even though the row menu carries it too: this is the only
    // place the review integration is ADVERTISED, and it is already
    // conditional on hunk being installed, so the columns it costs are only
    // ever spent on someone who can use it. Restart and Kill need no such
    // advertisement — they are the two actions every session list has.
    // Both keys on one hint: `D` is the same review in the other mode, and a
    // second segment for it would cost a column the line does not have.
    ...(props.reviewable ? [{ text: "d/D review", rank: 2 }] : []),
    { text: "? help", rank: 5 },
    { text: "q quit", rank: 6 },
  ];
}

export const Footer: Component<FooterProps> = (props) => {
  const dims = useSharedTerminalDimensions();
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
        <Match when={props.handoffDialogMode}>
          <text fg={theme.overlay}>
            {handoffDialogHintSegments()
              .map((segment) => `${segment.key} ${segment.gloss}`)
              .join(HINT_SEPARATOR)}
          </text>
        </Match>
        <Match when={props.copyDialogMode}>
          <text fg={theme.overlay}>
            {copyDialogHintSegments()
              .map((segment) => `${segment.key} ${segment.gloss}`)
              .join(HINT_SEPARATOR)}
          </text>
        </Match>
        <Match when={props.handoffPickMode}>
          <text fg={theme.overlay}>
            j/k pick target · enter continue · esc cancel
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
