import type { ScrollBoxRenderable } from "@opentui/core";
import type { Component, JSX, ParentComponent } from "solid-js";
import { theme } from "../theme";

const KEY_COL_WIDTH = 14;
const COL_WIDTH = 38;
const COL_GAP = 3;
const MAX_WIDTH = COL_WIDTH * 2 + COL_GAP + 4 + 2; // cols + padding(2+2) + border(2)

type Group = { section: string; items: { key: string; desc: string }[] };

const leftGroups = (sidebar?: boolean, reviewable?: boolean): Group[] => [
  {
    section: "Navigation",
    items: [
      { key: "j/k ↑/↓", desc: "Navigate sessions" },
      { key: "gg / G", desc: "Jump to first / last" },
      { key: "1-9", desc: "Jump to session N" },
    ],
  },
  {
    section: "Actions",
    items: [
      { key: "Enter", desc: "Switch to session" },
      { key: "/", desc: "Search" },
      { key: "f", desc: "Toggle hide idle" },
      { key: "p", desc: "Cycle prompt (inline/row/off)" },
      { key: "b", desc: "Cycle group-by mode" },
      { key: "r", desc: "Restart session" },
      { key: "R", desc: "Reconnect" },
      { key: "x / X", desc: "Kill session / all" },
      ...(reviewable ? [{ key: "d", desc: "Review diff (hunk)" }] : []),
    ],
  },
  {
    section: "Other",
    items: [
      { key: "?", desc: "Help" },
      { key: sidebar ? "q" : "q / Esc", desc: "Quit" },
    ],
  },
];

const rightGroups: Group[] = [
  {
    section: "Preview",
    items: [
      { key: "P", desc: "Toggle preview" },
      { key: "Ctrl+D/U", desc: "Scroll preview" },
      { key: "Alt+H/L", desc: "Resize preview" },
      { key: "Tab", desc: "Focus preview" },
    ],
  },
  {
    section: "Groups",
    items: [
      { key: "h / l", desc: "Collapse / expand group" },
      { key: "Space", desc: "Toggle group" },
      { key: "J / K", desc: "Move group down / up" },
      { key: "< / >", desc: "Move to top / bottom" },
      { key: "- / =", desc: "Collapse / expand all" },
    ],
  },
];

const renderColumn = (columnGroups: Group[]): JSX.Element => (
  <box flexDirection="column" width={COL_WIDTH}>
    {columnGroups.map((group, gi) => (
      <>
        {gi > 0 && <box height={1} />}
        <box height={1}>
          <text fg={theme.blue}>
            <strong>{group.section}</strong>
          </text>
        </box>
        {group.items.map((item) => (
          <box height={1} flexDirection="row">
            <box width={KEY_COL_WIDTH}>
              <text fg={theme.mauve}>{item.key.padEnd(KEY_COL_WIDTH)}</text>
            </box>
            <text fg={theme.subtext}>{item.desc}</text>
          </box>
        ))}
      </>
    ))}
  </box>
);

const renderCompactColumn = (columnGroups: Group[]): JSX.Element => (
  <box flexDirection="column">
    {columnGroups.map((group, gi) => (
      <>
        {gi > 0 && <box height={1} />}
        <box height={1}>
          <text fg={theme.blue}>
            <strong>{group.section}</strong>
          </text>
        </box>
        {group.items.map((item, ii) => (
          <>
            {ii > 0 && <box height={1} />}
            <box height={1}>
              <text fg={theme.mauve}>{item.key}</text>
            </box>
            <box height={1}>
              <text fg={theme.subtext}>{item.desc}</text>
            </box>
          </>
        ))}
      </>
    ))}
  </box>
);

const HelpLayout: ParentComponent<{
  hint: string;
  onScrollboxRef?: (ref: ScrollBoxRenderable) => void;
}> = (props) => (
  <>
    <box justifyContent="center" width="100%" height={1}>
      <text fg={theme.text}>
        <strong>Keyboard Shortcuts</strong>
      </text>
    </box>

    <scrollbox
      flexGrow={1}
      ref={(r: ScrollBoxRenderable) => props.onScrollboxRef?.(r)}
    >
      {props.children}
    </scrollbox>

    <box justifyContent="center" width="100%" height={1}>
      <text fg={theme.overlay}>{props.hint}</text>
    </box>
  </>
);

interface HelpOverlayProps {
  sidebar?: boolean;
  reviewable?: boolean;
  onScrollboxRef?: (ref: ScrollBoxRenderable) => void;
}

export const HelpOverlay: Component<HelpOverlayProps> = (props) => {
  const filteredRightGroups = () =>
    props.sidebar
      ? rightGroups.filter((g) => g.section !== "Preview")
      : rightGroups;

  const groups = leftGroups(props.sidebar, props.reviewable);

  if (props.sidebar) {
    const allGroups = [...groups, ...filteredRightGroups()];
    return (
      <box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        backgroundColor={theme.base}
        borderStyle="single"
        borderColor={theme.border}
        flexDirection="column"
      >
        <HelpLayout
          hint="j/k scroll · ? close"
          onScrollboxRef={props.onScrollboxRef}
        >
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            {renderCompactColumn(allGroups)}
          </box>
        </HelpLayout>
      </box>
    );
  }

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
    >
      <box
        width="100%"
        maxWidth={MAX_WIDTH}
        height="100%"
        backgroundColor={theme.base}
        borderStyle="single"
        borderColor={theme.border}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <HelpLayout
          hint="j/k scroll · ? or Esc to close"
          onScrollboxRef={props.onScrollboxRef}
        >
          <box height={1} />
          <box flexDirection="row">
            {renderColumn(groups)}
            <box width={COL_GAP} />
            {renderColumn(filteredRightGroups())}
          </box>
        </HelpLayout>
      </box>
    </box>
  );
};
