import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { RGBA, TextAttributes, type CapturedFrame } from "@opentui/core";
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

/** Unambiguous hexes so a span's fg identifies which segment drew it. */
const HIGHLIGHT_HEX = "#ff0000";
const BASE_HEX = "#00ff00";

async function renderHighlightInRowBox(width: number) {
  setup = await testRender(
    () => (
      // Height 3 with one logical line of content: a wrap has room to spill
      // onto row 2, so the test can tell clipping from wrapping. The real
      // row is 1 tall, where a wrapped tail would just vanish.
      <box width={width} height={3} flexDirection="row">
        <box flexGrow={1} flexShrink={1} flexDirection="row">
          <HighlightedText
            text={WINDOWED_PROMPT}
            highlightColor={HIGHLIGHT_HEX}
            baseColor={BASE_HEX}
          />
        </box>
      </box>
    ),
    { width, height: 3 },
  );
  await setup.renderOnce();
  return { frame: setup.captureCharFrame(), spans: setup.captureSpans() };
}

function spanContaining(frame: CapturedFrame, needle: string) {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span;
    }
  }
  throw new Error(`no span containing ${JSON.stringify(needle)} in frame`);
}

const hex = (h: string) => RGBA.fromHex(h).toInts();

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
    const { frame } = await renderHighlightInRowBox(49);
    expect(frame).toContain("terminal multiplexer");
    expect(frame).not.toContain("terminalmultiplexer");
    // The overflow is clipped mid-word at the box edge, not word-wrapped
    // onto a second row. A wrap would push the whole trailing word down,
    // where the real 1-line-tall row would drop it (`who has` for
    // `who has neve…`).
    const lines = frame.split("\n");
    expect(lines[0]).toContain("is to someon");
    expect(lines[1]?.trim() ?? "").toBe("");
    expect(frame).not.toContain("someone");
  });

  // captureCharFrame() is text-only, so the highlight's color and bold have
  // to be read off captureSpans(). A `<b>` inside the single Text node only
  // carries `fg` through `style`: 0.1.97's text-node setProperty honors
  // `href` and `style` and drops a bare `fg` prop.
  it("colors the highlight and leaves the surrounding text in the base color", async () => {
    const { spans } = await renderHighlightInRowBox(49);

    const bold = spanContaining(spans, "multiplexer");
    expect(bold.fg.toInts()).toEqual(hex(HIGHLIGHT_HEX));
    expect(bold.attributes & TextAttributes.BOLD).not.toBe(0);

    const base = spanContaining(spans, "terminal ");
    expect(base.fg.toInts()).toEqual(hex(BASE_HEX));
  });
});
