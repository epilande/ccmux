import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { HighlightedText } from "./HighlightedText";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderHighlight(text: string) {
  setup = await testRender(
    () => (
      <HighlightedText text={text} highlightColor="yellow" baseColor="white" />
    ),
    { width: 60, height: 3 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

/** Issue #186: a windowed prompt whose match sits one column past the box.
 *  Visible width of this markup (tags stripped) is 50. */
const WINDOWED_PROMPT =
  "…laining what a terminal <b>multiplexer</b> is to someone";

async function renderHighlightInRowBox(width: number) {
  setup = await testRender(
    () => (
      <box width={width} height={1} flexDirection="row">
        <box flexGrow={1} flexShrink={1} flexDirection="row">
          <HighlightedText
            text={WINDOWED_PROMPT}
            highlightColor="yellow"
            baseColor="white"
          />
        </box>
      </box>
    ),
    { width, height: 2 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("HighlightedText", () => {
  it("renders plain text without markers", async () => {
    const frame = await renderHighlight("hello world");
    expect(frame).toContain("hello world");
  });

  it("highlights bold segments", async () => {
    const frame = await renderHighlight("foo<b>bar</b>baz");
    expect(frame).toContain("foo");
    expect(frame).toContain("bar");
    expect(frame).toContain("baz");
    expect(frame).not.toContain("<b>");
    expect(frame).not.toContain("</b>");
  });

  it("renders multiple bold regions", async () => {
    const frame = await renderHighlight("<b>a</b>x<b>b</b>");
    expect(frame).toContain("a");
    expect(frame).toContain("x");
    expect(frame).toContain("b");
  });

  it("handles empty string", async () => {
    const frame = await renderHighlight("");
    expect(frame.trim()).toBe("");
  });

  it("renders full text as highlight", async () => {
    const frame = await renderHighlight("<b>all bold</b>");
    expect(frame).toContain("all bold");
    expect(frame).not.toContain("<b>");
  });

  // SessionItem's prompt cell is a flexGrow/flexShrink row. When the
  // windowed markup fills the budget exactly, Yoga shrinks the box by 1–2
  // cols. A sibling-per-segment render used to eat the space before <b>
  // (`terminalmultiplexer`). One Text node must keep that space.
  it("keeps the space before a highlight when the row box is 1 col short", async () => {
    const frame = await renderHighlightInRowBox(49);
    expect(frame).toContain("terminal multiplexer");
    expect(frame).not.toContain("terminalmultiplexer");
  });
});
