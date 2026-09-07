import type { Component } from "solid-js";
import { For } from "solid-js";

interface HighlightedTextProps {
  text: string;
  highlightColor?: string;
  baseColor?: string;
}

interface Segment {
  text: string;
  bold: boolean;
}

function parseHighlight(text: string): Segment[] {
  const segments: Segment[] = [];
  const regex = /<b>(.*?)<\/b>/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), bold: false });
    }
    segments.push({ text: match[1], bold: true });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), bold: false });
  }

  return segments;
}

export const HighlightedText: Component<HighlightedTextProps> = (props) => {
  const segments = () => parseHighlight(props.text);

  // One Text node, not one per segment. Sibling Texts in a flexShrink row
  // let Yoga eat the space before a highlight when the box is 1–2 cols
  // short of the windowed line (issue #186). Shrink then happens once,
  // at the end of the line.
  return (
    // `wrapMode="none"` because the row is one line tall: a wrap would hide
    // the tail (a whole trailing word) instead of clipping it mid-word.
    <text fg={props.baseColor} wrapMode="none">
      <For each={segments()}>
        {(segment) =>
          segment.bold ? (
            <b style={{ fg: props.highlightColor }}>{segment.text}</b>
          ) : (
            segment.text
          )
        }
      </For>
    </text>
  );
};
