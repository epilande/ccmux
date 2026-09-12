import { helpGroups } from "../actions";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { Component, JSX, ParentComponent } from "solid-js";
import { createMemo } from "solid-js";
import { theme } from "../theme";
import { useSharedTerminalDimensions } from "../utils/use-shared-dimensions";
import { truncateText, wrapText } from "../utils/format";

const KEY_COL_WIDTH = 14;
const COL_WIDTH = 38;
const COL_GAP = 3;
const PAD_X = 4; // picker paddingLeft + paddingRight
const SIDEBAR_PAD_X = 2;
const BORDER = 2;
const MAX_WIDTH = COL_WIDTH * 2 + COL_GAP + PAD_X + BORDER; // cols + padding + border

const RIGHT_SECTIONS = new Set(["Groups", "Preview", "Other"]);

type Group = { section: string; items: { key: string; desc: string }[] };

/**
 * A shortcut row whose description is pre-wrapped to `descWidth`.
 *
 * The wrap happens here rather than in the renderer because the row height
 * IS the line count: a renderer wrap past a height-1 box clips the tail
 * (or paints it over the next shortcut). Lines from wrapText already fit,
 * so nothing can wrap a second time.
 */
const renderShortcut = (
  item: { key: string; desc: string },
  colWidth: number,
): JSX.Element => {
  const descWidth = Math.max(1, colWidth - KEY_COL_WIDTH);
  const descLines = wrapText(item.desc, descWidth);
  return (
    <box height={descLines.length} flexDirection="row" flexShrink={0}>
      <box width={KEY_COL_WIDTH} height={1} flexShrink={0}>
        <text fg={theme.mauve}>{item.key.padEnd(KEY_COL_WIDTH)}</text>
      </box>
      <box flexDirection="column" width={descWidth} flexShrink={0}>
        {descLines.map((line) => (
          <box height={1}>
            <text fg={theme.subtext}>{line}</text>
          </box>
        ))}
      </box>
    </box>
  );
};

const renderColumn = (columnGroups: Group[], colWidth: number): JSX.Element => (
  <box flexDirection="column" width={colWidth}>
    {columnGroups.map((group, gi) => (
      <>
        {gi > 0 && <box height={1} />}
        <box height={1}>
          <text fg={theme.blue}>
            <strong>{group.section}</strong>
          </text>
        </box>
        {group.items.map((item) => renderShortcut(item, colWidth))}
      </>
    ))}
  </box>
);

/**
 * The rail's version: one column, key above description, because a 30-column
 * sidebar has no room for the two-column grid.
 *
 * There is no blank row BETWEEN items, only between sections. It used to have
 * one, which put every entry three rows apart and ran the list off the bottom
 * of a full-height rail — silently, since the scrollbox simply scrolls. The
 * alternating mauve key and dim description are what separate one entry from
 * the next; the air was costing a third of the overlay to say the same thing.
 *
 * Descriptions wrap to `contentWidth` with one row per line, same reason as
 * {@link renderShortcut}: a height-1 box at 30 columns clips a long
 * description such as "Copy response / path / URL".
 */
const renderCompactColumn = (
  columnGroups: Group[],
  contentWidth: number,
): JSX.Element => (
  <box flexDirection="column">
    {columnGroups.map((group, gi) => (
      <>
        {gi > 0 && <box height={1} />}
        <box height={1}>
          <text fg={theme.blue}>
            <strong>{group.section}</strong>
          </text>
        </box>
        {group.items.map((item) => {
          const descLines = wrapText(item.desc, contentWidth);
          return (
            <>
              <box height={1}>
                <text fg={theme.mauve}>{item.key}</text>
              </box>
              {descLines.map((line) => (
                <box height={1}>
                  <text fg={theme.subtext}>{line}</text>
                </box>
              ))}
            </>
          );
        })}
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

    <box justifyContent="center" width="100%" height={1} flexShrink={0}>
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
  const dims = useSharedTerminalDimensions();

  const grouped = () =>
    helpGroups(props.sidebar, props.reviewable === true);

  const groups = () => grouped().filter((g) => !RIGHT_SECTIONS.has(g.section));

  const filteredRightGroups = () =>
    grouped().filter((g) =>
      props.sidebar
        ? g.section !== "Preview" && RIGHT_SECTIONS.has(g.section)
        : RIGHT_SECTIONS.has(g.section),
    );

  /**
   * Inner columns of the picker modal: the overlay is `min(term, MAX_WIDTH)`
   * minus border and horizontal padding. Two fixed COL_WIDTH columns plus
   * the gap need 79 of those; a 60-column picker only has 54, so the
   * ordinary two-column grid clips the right-hand descriptions off the
   * edge. One stacked column uses the full inner width instead.
   */
  const innerWidth = createMemo(() =>
    Math.max(1, Math.min(dims().width, MAX_WIDTH) - BORDER - PAD_X),
  );

  const twoColumns = createMemo(
    () => innerWidth() >= COL_WIDTH * 2 + COL_GAP,
  );

  const columnWidth = createMemo(() =>
    twoColumns()
      ? Math.floor((innerWidth() - COL_GAP) / 2)
      : innerWidth(),
  );

  const compactWidth = createMemo(() =>
    Math.max(1, dims().width - BORDER - SIDEBAR_PAD_X),
  );

  const pickerHint = createMemo(() =>
    truncateText("j/k scroll · ? or Esc to close", innerWidth()),
  );

  const sidebarHint = createMemo(() =>
    truncateText("j/k scroll · ? close", compactWidth()),
  );

  const pickerColumns = createMemo((): Group[][] => {
    const left = groups();
    const right = filteredRightGroups();
    return twoColumns() ? [left, right] : [[...left, ...right]];
  });

  if (props.sidebar) {
    const allGroups = [...groups(), ...filteredRightGroups()];
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
          hint={sidebarHint()}
          onScrollboxRef={props.onScrollboxRef}
        >
          <box flexDirection="column" paddingLeft={1} paddingRight={1}>
            {renderCompactColumn(allGroups, compactWidth())}
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
          hint={pickerHint()}
          onScrollboxRef={props.onScrollboxRef}
        >
          <box height={1} />
          <box flexDirection="row">
            {pickerColumns().map((column, i) => (
              <>
                {i > 0 && <box width={COL_GAP} />}
                {renderColumn(column, columnWidth())}
              </>
            ))}
          </box>
        </HelpLayout>
      </box>
    </box>
  );
};
