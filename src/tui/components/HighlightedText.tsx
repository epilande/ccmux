import type { Component, JSX } from "solid-js";
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

// TextNodeRenderable accepts `fg`; @opentui/solid 0.1.97's SpanProps is
// ComponentProps<{}, TextNodeRenderable> and drops it.
function spanFg(color?: string): JSX.IntrinsicElements["span"] {
  return { fg: color } as unknown as JSX.IntrinsicElements["span"];
}

export const HighlightedText: Component<HighlightedTextProps> = (props) => {
  const segments = () => parseHighlight(props.text);

  // One Text node, not one per segment. Sibling Texts in a flexShrink row
  // let Yoga eat the space before a highlight when the box is 1–2 cols
  // short of the windowed line (issue #186). Shrink then happens once,
  // at the end of the line.
  return (
    <text fg={props.baseColor}>
      <For each={segments()}>
        {(segment) =>
          segment.bold ? (
            <span {...spanFg(props.highlightColor)}>
              <b>{segment.text}</b>
            </span>
          ) : (
            segment.text
          )
        }
      </For>
    </text>
  );
};
