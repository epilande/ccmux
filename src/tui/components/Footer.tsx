import type { Component, JSX } from "solid-js";
import { Switch, Match, Show } from "solid-js";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { DEFAULT_GROUP_BY, type GroupBy } from "../../lib/preferences";
import { ACTIONS, PINNED, type View } from "../actions";
import { displayWidth, truncateText } from "../utils/format";
import { theme } from "../theme";
import { Text } from "./Text";

interface FooterProps {
  searchMode: boolean;
  confirmMode?: boolean;
  helpMode?: boolean;
  previewFocused?: boolean;
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
   *  ties drop right-to-left. `PINNED` hints are never dropped. */
  rank: number;
  /** What a pinned hint shrinks to (its bare key) when even the pinned
   *  hints alone overflow, as on the sidebar's rail. */
  short?: string;
}

/**
 * The widest prefix of `segments` that fits `width`, dropping whole hints
 * by rank rather than truncating the line mid-word.
 *
 * The default hint line grew past 120 columns once `n new` was added, which
 * clipped `quit`, the one hint a stuck user most needs. Every picker feature
 * wants a footer hint, so budgeting them by rank keeps the next one from
 * having to be withheld for want of room. The `PINNED` four (views, scope,
 * help, quit) are never dropped; when they alone overflow they shrink to
 * their bare keys instead, one at a time.
 *
 * Pure and exported for tests.
 */
export function fitHints(segments: HintSegment[], width: number): string {
  // Display order is preserved throughout; only whole entries are removed.
  const kept = [...segments];
  const render = () => kept.map((segment) => segment.text).join(HINT_SEPARATOR);

  while (render().length > width) {
    // Drop the lowest rank, and among equals the rightmost, so the line
    // shortens from the end the eye scans last.
    let victim = -1;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i]!.rank === PINNED) continue;
      if (victim === -1 || kept[i]!.rank <= kept[victim]!.rank) victim = i;
    }
    if (victim === -1) break;
    kept.splice(victim, 1);
  }
  // Still over with only the pinned left: shrink them to their keys one at
  // a time, left to right, so the way out keeps its word longest.
  for (let i = 0; i < kept.length && render().length > width; i++)
    kept[i] = { ...kept[i]!, text: kept[i]!.short ?? kept[i]!.text };
  return render();
}

/**
 * The footer's hints for `view`, built from the `ACTIONS` registry: every
 * action with a `hint` that the view handles, in registry order, so the
 * order and the verbs are the same on every view. `views`, `scope`, `help`
 * and `quit`/`back` are pinned.
 */
export function footerHints(
  view: View,
  opts: { groupBy?: GroupBy; reviewable?: boolean; sidebar?: boolean } = {},
): HintSegment[] {
  const segments: HintSegment[] = [];
  for (const action of ACTIONS) {
    if (!("hint" in action)) continue;
    if ("views" in action && !action.views.includes(view)) continue;
    if (action.id === "review" && !opts.reviewable) continue;
    // The sidebar's session list neither cycles views nor previews.
    if (opts.sidebar && view === "sessions" && action.id === "views") continue;
    if (opts.sidebar && action.id === "preview") continue;
    const { key, rank } = action.hint;
    const verb =
      typeof action.hint.verb === "string"
        ? action.hint.verb
        : action.hint.verb[view];
    const text =
      action.id === "group"
        ? `${key} ${verb}:${opts.groupBy ?? DEFAULT_GROUP_BY}`
        : `${key} ${verb}`;
    segments.push(
      rank === PINNED ? { text, rank, short: key } : { text, rank },
    );
  }
  return segments;
}

/** A confirmation's keys, the same in every view. */
export const CONFIRM_HINTS = "y confirm · n/Esc cancel";

/** A filter's own keys, the same wording wherever a list is being typed into
 *  (the session search and Start's filter). */
export const SEARCH_HINTS =
  "type to search · ↑/↓ or ^n/^p nav · enter go · esc cancel";

/**
 * The hint line for `view`, with an optional `note` (a flash message, a
 * scan state, a source error) ahead of it.
 *
 * The note never costs the pinned four. A note that fits beside them at
 * full length keeps them so, with the droppable hints fitted into what is
 * left. A longer one (an error and its remedy) shrinks them to their bare
 * keys first, and only truncates if it still does not fit.
 */
export function hintLine(
  view: View,
  width: number,
  opts: {
    groupBy?: GroupBy;
    reviewable?: boolean;
    sidebar?: boolean;
    note?: string;
  } = {},
): { note: string; hints: string } {
  const all = footerHints(view, opts);
  if (!opts.note) return { note: "", hints: fitHints(all, width) };
  const pinned = all.filter((s) => s.rank === PINNED);
  const full = pinned.map((s) => s.text).join(HINT_SEPARATOR);
  const keys = pinned.map((s) => s.short ?? s.text).join(HINT_SEPARATOR);
  const noted = displayWidth(opts.note) + NOTE_GAP.length;
  if (noted + displayWidth(full) <= width)
    return { note: opts.note + NOTE_GAP, hints: fitHints(all, width - noted) };
  if (noted + displayWidth(keys) <= width)
    return {
      note: opts.note + NOTE_GAP,
      hints: fitHints(pinned, width - noted),
    };
  const room = width - displayWidth(keys) - NOTE_GAP.length;
  // Below a few columns a note is only an ellipsis, which says nothing.
  if (room < 6) return { note: "", hints: fitHints(all, width) };
  return { note: truncateText(opts.note, room) + NOTE_GAP, hints: keys };
}

const NOTE_GAP = "  ";

/** The footer's frame: a border-topped line. Shared by the session list's
 *  footer and the Worktrees and Start views, so all three look alike. */
export const FooterBar: Component<{ children: JSX.Element }> = (props) => (
  <box
    width="100%"
    height={2}
    flexShrink={0}
    paddingLeft={1}
    paddingRight={1}
    border={["top"]}
    borderStyle="single"
    borderColor={theme.border}
  >
    {props.children}
  </box>
);

/** One hint line, `note` first in its own color. */
export const HintLine: Component<{
  view: View;
  width: number;
  groupBy?: GroupBy;
  reviewable?: boolean;
  sidebar?: boolean;
  note?: string;
  noteColor?: string;
}> = (props) => {
  const line = () => hintLine(props.view, props.width, props);
  return (
    <Text wrapMode="none">
      <Show when={line().note}>
        <span style={{ fg: props.noteColor ?? theme.subtext }}>
          {line().note}
        </span>
      </Show>
      <span style={{ fg: theme.subtext }}>{line().hints}</span>
    </Text>
  );
};

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

export const Footer: Component<FooterProps> = (props) => {
  const dims = useSharedTerminalDimensions();

  return (
    <FooterBar>
      <Switch>
        <Match when={props.helpMode}>
          <Text fg={theme.subtext}>? or Esc close</Text>
        </Match>
        <Match when={props.previewFocused}>
          <Text fg={theme.subtext}>tab/esc exit focus · keys sent to pane</Text>
        </Match>
        <Match when={props.confirmMode}>
          <Text fg={theme.subtext}>{CONFIRM_HINTS}</Text>
        </Match>
        <Match when={props.newSessionMode}>
          <Text fg={theme.subtext}>
            {newSessionHintSegments(props.newSessionOption ?? "text")
              .map((segment) => `${segment.key} ${segment.gloss}`)
              .join(HINT_SEPARATOR)}
          </Text>
        </Match>
        <Match when={props.handoffDialogMode}>
          <Text fg={theme.subtext}>
            {handoffDialogHintSegments()
              .map((segment) => `${segment.key} ${segment.gloss}`)
              .join(HINT_SEPARATOR)}
          </Text>
        </Match>
        <Match when={props.copyDialogMode}>
          <Text fg={theme.subtext}>
            {copyDialogHintSegments()
              .map((segment) => `${segment.key} ${segment.gloss}`)
              .join(HINT_SEPARATOR)}
          </Text>
        </Match>
        <Match when={props.handoffPickMode}>
          <Text fg={theme.subtext}>
            j/k pick target · enter continue · esc cancel
          </Text>
        </Match>
        <Match when={props.searchMode}>
          <Text fg={theme.subtext}>{SEARCH_HINTS}</Text>
        </Match>
        <Match when={true}>
          <HintLine
            view="sessions"
            width={Math.max(1, dims().width - FOOTER_PADDING)}
            groupBy={props.groupBy}
            reviewable={props.reviewable}
          />
        </Match>
      </Switch>
    </FooterBar>
  );
};
