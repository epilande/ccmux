import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal, For } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { Text } from "./Text";
import { scrollbarThumb } from "./test-helpers";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

/** A bare scrollbox of `rows()` one-line rows filling a 20-wide terminal. */
async function mount(rows: () => number, height: number) {
  let box!: ScrollBoxRenderable;
  setup = await testRender(
    () => (
      <scrollbox
        flexGrow={1}
        ref={(r: ScrollBoxRenderable) => {
          box = r;
        }}
      >
        <For each={Array.from({ length: rows() }, (_, i) => i)}>
          {(i) => <Text>{`row ${i}`}</Text>}
        </For>
      </scrollbox>
    ),
    { width: 20, height },
  );
  const s = setup;
  return async () => {
    // The first pass lays out, the second draws the bar for that layout.
    await s.renderOnce();
    await s.renderOnce();
    return scrollbarThumb(s.captureCharFrame(), box);
  };
}

// OpenTUI 0.1.97 needed a syncScrollbarThumb workaround for each of these
// cases. The native scrollbar in 0.8 sizes the thumb from the scroll state.
describe("scrollbox thumb", () => {
  it("sizes the thumb to viewport over content on first render", async () => {
    const thumb = await mount(() => 15, 10);
    // 20 half-cells * 10 / 15 = 13. OpenTUI 0.1.97 clamped the viewport to
    // the 5-row range and drew exactly half the track: 10.
    expect(await thumb()).toEqual({ drawn: 13, expected: 13 });
  });

  it("follows content that grows past the viewport after the first measure", async () => {
    const [rows, setRows] = createSignal(5);
    const thumb = await mount(rows, 10);
    expect(await thumb()).toEqual({ drawn: 0, expected: 0 });
    setRows(40);
    // 20 * 10 / 40 = 5. OpenTUI 0.1.97 measured the viewport against an empty
    // range and pinned the thumb at the slider's floor: 1.
    expect(await thumb()).toEqual({ drawn: 5, expected: 5 });
    setRows(15);
    expect(await thumb()).toEqual({ drawn: 13, expected: 13 });
  });

  it("re-sizes across a resize round trip", async () => {
    const thumb = await mount(() => 15, 20);
    expect(await thumb()).toEqual({ drawn: 0, expected: 0 });
    // Shrinking a viewport that fit its content set the new size against the
    // old, empty range, so OpenTUI 0.1.97 pinned the thumb at 1.
    setup!.resize(20, 10);
    expect(await thumb()).toEqual({ drawn: 13, expected: 13 });
    setup!.resize(20, 20);
    expect(await thumb()).toEqual({ drawn: 0, expected: 0 });
    setup!.resize(20, 10);
    expect(await thumb()).toEqual({ drawn: 13, expected: 13 });
  });
});
