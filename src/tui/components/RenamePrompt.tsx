import type { Component } from "solid-js";
import { createMemo, Show } from "solid-js";
import { theme } from "../theme";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { displayWidth, truncateText } from "../utils/format";
import { GROUP_NAME_MAX_WIDTH } from "../utils/grouping";
import { Text } from "./Text";

/** The widest the box gets, matching the command palette it stands in for. */
const MAX_WIDTH = 72;
/** Rows above the box: the palette's, so the prompt opens where it does. */
const TOP_GAP = 2;
/** Title, input, rule and hint rows, plus the two borders. */
const HEIGHT = 6;

/** The hint line, longest first; the first that fits is drawn. Every step
 *  keeps the merge: it is the one thing the prompt cannot otherwise show,
 *  and the sidebar has no footer to teach it. */
const HINTS = [
  "enter rename · esc cancel · an existing name merges",
  "enter rename · esc cancel · same name merges",
  "enter · esc · same name merges",
  "same name merges",
];

/** How close to the cap a name gets before the prompt starts counting. */
const COUNT_FROM = GROUP_NAME_MAX_WIDTH - 16;

interface RenamePromptProps {
  /** The group's current label, for the title. */
  label: string;
  /** The name being typed (prefilled with the label). */
  value: string;
  onInput: (value: string) => void;
  /** Enter in the input. */
  onSubmit: () => void;
  /** The label of the existing group the typed name merges into, if any. */
  mergesInto?: string | null;
}

/**
 * The rename prompt for a group header: one input, prefilled with the
 * group's name. It is the `:` palette's rename mode (same modal slot, same
 * place on screen), drawn on its own because it has no command list.
 *
 * Keys are owned by App: it commits on Enter and cancels on Esc, and the
 * `<input>` sees every other key, `j`/`k` included, as text. The input has
 * no length cap: it counts code units, which would clip a long prefill, and
 * the name rules (`sanitizeGroupName`) are applied once, at commit.
 *
 * Instead of a cap on typing, the prompt says what Enter will do with a
 * name that is not a plain rename. The hint row reads `enter merges into
 * <group>` when the name is an existing group's (a full path past the cap
 * included, which a hard stop at 64 would have made impossible to type or
 * paste). Otherwise the title row counts columns from 48 on, `70/64 · cut`
 * once past the cap. Every string is
 * fitted before it is drawn, since OpenTUI wraps rather than clips, and the
 * box narrows to a sidebar's width.
 */
export const RenamePrompt: Component<RenamePromptProps> = (props) => {
  const dims = useSharedTerminalDimensions();
  const boxWidth = createMemo(() =>
    Math.max(20, Math.min(MAX_WIDTH, dims().width - 4)),
  );
  /** Inside the border and the one-column padding either side. */
  const inner = createMemo(() => boxWidth() - 4);
  /** The title row's right side: the column count near the cap. A name
   *  that merges is never cut, so it gets no count. */
  const note = createMemo((): { text: string; color: string } | null => {
    if (props.mergesInto) return null;
    const used = displayWidth(props.value.trim());
    if (used < COUNT_FROM) return null;
    const count = `${used}/${GROUP_NAME_MAX_WIDTH}`;
    return used > GROUP_NAME_MAX_WIDTH
      ? { text: `${count} · cut`, color: theme.peach }
      : { text: count, color: theme.subtext };
  });
  /** The note's columns, cut so the title keeps at least a short label. */
  const noteText = createMemo(() => {
    const n = note();
    return n ? truncateText(n.text, Math.max(1, inner() - 18)) : "";
  });
  const label = createMemo(() =>
    truncateText(
      props.label,
      Math.max(
        1,
        inner() -
          displayWidth("Rename ") -
          displayWidth(" to:") -
          (noteText() ? displayWidth(noteText()) + 2 : 0),
      ),
    ),
  );
  /** The hint row: what Enter does. A name that merges says so in place of
   *  the generic hints, the target's name kept whole where it fits. */
  const hint = createMemo((): { text: string; color: string } => {
    const target = props.mergesInto;
    if (target) {
      const steps = [
        `enter merges into ${target} · esc cancel`,
        `enter merges into ${target}`,
      ];
      return {
        text:
          steps.find((text) => displayWidth(text) <= inner()) ??
          truncateText(`merges into ${target}`, inner()),
        color: theme.blue,
      };
    }
    return {
      text:
        HINTS.find((text) => displayWidth(text) <= inner()) ??
        truncateText(HINTS.at(-1)!, inner()),
      color: theme.overlay,
    };
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      alignItems="center"
      paddingTop={TOP_GAP}
    >
      <box
        width={boxWidth()}
        height={HEIGHT}
        backgroundColor={theme.surface}
        borderStyle="single"
        borderColor={theme.border}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <box height={1} flexDirection="row" flexShrink={0}>
          <Text fg={theme.subtext} wrapMode="none">
            Rename{" "}
          </Text>
          <Text fg={theme.text} wrapMode="none">
            <b>{label()}</b>
          </Text>
          <Text fg={theme.subtext} wrapMode="none">
            {" "}
            to:
          </Text>
          <box flexGrow={1} />
          <Show when={note()}>
            {(n: () => { text: string; color: string }) => (
              <Text fg={n().color} wrapMode="none">
                {noteText()}
              </Text>
            )}
          </Show>
        </box>
        <box height={1} flexDirection="row" flexShrink={0}>
          <Text fg={theme.mauve} width={2}>
            ›{" "}
          </Text>
          <input
            value={props.value}
            onInput={props.onInput}
            onSubmit={props.onSubmit}
            focused
            placeholder="New name"
            placeholderColor={theme.overlay}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.blue}
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            width="100%"
          />
        </box>
        <box height={1} flexShrink={0}>
          <Text fg={theme.border}>{"─".repeat(inner())}</Text>
        </box>
        <box height={1} flexShrink={0}>
          <Text fg={hint().color} wrapMode="none">
            {hint().text}
          </Text>
        </box>
      </box>
    </box>
  );
};
