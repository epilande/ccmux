import { afterEach, describe, expect, it } from "bun:test";
import { LayoutSlotRenderable, testRender } from "@opentui/solid";
import type { BaseRenderable } from "@opentui/core";
import { createSignal, For } from "solid-js";
import { Text } from "./Text";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

type Row = { id: number; badge: boolean };
const ROWS = 16;
const makeRows = (generation: number): Row[] =>
  Array.from({ length: ROWS }, (_, i) => ({
    id: generation * 100 + i,
    badge: false,
  }));

function placeholders(root: BaseRenderable): LayoutSlotRenderable[] {
  const found: LayoutSlotRenderable[] = [];
  const walk = (node: BaseRenderable) => {
    if (node instanceof LayoutSlotRenderable) found.push(node);
    for (const child of node.getChildren()) walk(child);
  };
  walk(root);
  return found;
}

// OpenTUI 0.1.97 never freed the layout node behind Solid's slot placeholder,
// so every unmounted row with an empty conditional leaked one node, and a
// long-running sidebar grew by about 60 MB a day (#254). A status change that
// re-sorts the list unmounts every row, which is what this test repeats.
describe("row remounts", () => {
  it("destroy the slot placeholders of the rows they replace", async () => {
    const [rows, setRows] = createSignal(makeRows(0));
    setup = await testRender(
      () => (
        <box>
          <For each={rows()}>
            {(row) => (
              <box flexDirection="row">
                <Text>{`row ${row.id}`}</Text>
                {row.badge ? <Text>!</Text> : null}
                <Text>end</Text>
              </box>
            )}
          </For>
        </box>
      ),
      { width: 30, height: ROWS + 2 },
    );
    await setup.renderOnce();

    const replaced: LayoutSlotRenderable[] = [];
    for (let generation = 1; generation <= 20; generation++) {
      const current = placeholders(setup.renderer.root);
      expect(current).toHaveLength(ROWS);
      replaced.push(...current);
      setRows(makeRows(generation));
      await setup.renderOnce();
      // Removed nodes are destroyed on the next tick.
      await new Promise<void>((resolve) => process.nextTick(resolve));
    }

    expect(replaced).toHaveLength(ROWS * 20);
    expect(replaced.filter((slot) => !slot.isDestroyed)).toHaveLength(0);
    expect(placeholders(setup.renderer.root)).toHaveLength(ROWS);
  });
});
