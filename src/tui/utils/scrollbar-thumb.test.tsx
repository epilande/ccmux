import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal, For } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { Text } from "../components/Text";
import { scrollbarThumb } from "../components/test-helpers";
import { syncScrollbarThumb } from "./scrollbar-thumb";

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
          syncScrollbarThumb(r);
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
    // The first pass lays out and fires the resize listeners, the second
    // draws what they set.
    await s.renderOnce();
    await s.renderOnce();
    return scrollbarThumb(s.captureCharFrame(), box);
  };
}

describe("syncScrollbarThumb", () => {
  it("sizes the thumb to viewport over content on first render", async () => {
    const thumb = await mount(() => 15, 10);
    // 20 half-cells * 10 / 15 = 13. Unsynced, the slider clamps its viewport
    // to the 5-row range and draws exactly half the track: 10.
    expect(await thumb()).toEqual({ drawn: 13, expected: 13 });
  });

  it("follows content that grows past the viewport after the first measure", async () => {
    const [rows, setRows] = createSignal(5);
    const thumb = await mount(rows, 10);
    expect(await thumb()).toEqual({ drawn: 0, expected: 0 });
    setRows(40);
    // 20 * 10 / 40 = 5. Unsynced, the viewport measured against an empty
    // range pins the thumb at the slider's floor: 1.
    expect(await thumb()).toEqual({ drawn: 5, expected: 5 });
    setRows(15);
    expect(await thumb()).toEqual({ drawn: 13, expected: 13 });
  });

  it("re-sizes across a resize round trip", async () => {
    const thumb = await mount(() => 15, 20);
    expect(await thumb()).toEqual({ drawn: 0, expected: 0 });
    // Shrinking a viewport that fit its content sets the new size against
    // the old, empty range: unsynced, the thumb pins at 1.
    setup!.resize(20, 10);
    expect(await thumb()).toEqual({ drawn: 13, expected: 13 });
    setup!.resize(20, 20);
    expect(await thumb()).toEqual({ drawn: 0, expected: 0 });
    setup!.resize(20, 10);
    expect(await thumb()).toEqual({ drawn: 13, expected: 13 });
  });
});
