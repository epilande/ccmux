import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { For, createSignal } from "solid-js";
import { useSharedTerminalDimensions } from "./use-shared-dimensions";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

/** One row that subscribes via the shared hook and renders its dimensions. */
function DimensionsConsumer(props: {
  onDims?: (w: number, h: number) => void;
}) {
  const dims = useSharedTerminalDimensions();
  props.onDims?.(dims().width, dims().height);
  return (
    <text>
      {dims().width}x{dims().height}
    </text>
  );
}

describe("useSharedTerminalDimensions", () => {
  it("adds no listeners beyond the baseline with zero consumers", async () => {
    setup = await testRender(() => <text>no consumers</text>, {
      width: 80,
      height: 24,
    });
    await setup.renderOnce();
    expect(setup.renderer.listenerCount("resize")).toBe(0);
  });

  it("holds exactly one resize listener for many consumers, and returns real dimensions", async () => {
    const seen: Array<[number, number]> = [];
    setup = await testRender(
      () => (
        <For each={Array.from({ length: 15 }, (_, i) => i)}>
          {() => <DimensionsConsumer onDims={(w, h) => seen.push([w, h])} />}
        </For>
      ),
      { width: 100, height: 40 },
    );
    await setup.renderOnce();

    // Baseline (no consumers) is 0, so any 15-consumer tree should hold
    // exactly the one shared listener, not 15.
    expect(setup.renderer.listenerCount("resize")).toBe(1);
    expect(seen.length).toBe(15);
    for (const [w, h] of seen) {
      expect(w).toBe(setup.renderer.width);
      expect(h).toBe(setup.renderer.height);
    }
  });

  it("drops the shared listener once the last consumer unmounts", async () => {
    const [mounted, setMounted] = createSignal(true);
    setup = await testRender(
      () => (
        <For each={mounted() ? Array.from({ length: 15 }, (_, i) => i) : []}>
          {() => <DimensionsConsumer />}
        </For>
      ),
      { width: 80, height: 24 },
    );
    await setup.renderOnce();
    expect(setup.renderer.listenerCount("resize")).toBe(1);

    setMounted(false);
    await setup.renderOnce();
    expect(setup.renderer.listenerCount("resize")).toBe(0);
  });

  it("removes the listener on renderer destroy", async () => {
    setup = await testRender(
      () => (
        <For each={Array.from({ length: 5 }, (_, i) => i)}>
          {() => <DimensionsConsumer />}
        </For>
      ),
      { width: 80, height: 24 },
    );
    await setup.renderOnce();
    expect(setup.renderer.listenerCount("resize")).toBe(1);

    const renderer = setup.renderer;
    renderer.destroy();
    expect(renderer.listenerCount("resize")).toBe(0);
  });

  it("does not leak entries across separate renderer instances", async () => {
    const first = await testRender(() => <DimensionsConsumer />, {
      width: 80,
      height: 24,
    });
    await first.renderOnce();
    expect(first.renderer.listenerCount("resize")).toBe(1);

    setup = await testRender(() => <DimensionsConsumer />, {
      width: 80,
      height: 24,
    });
    await setup.renderOnce();
    expect(setup.renderer.listenerCount("resize")).toBe(1);
    expect(first.renderer.listenerCount("resize")).toBe(1);

    first.renderer.destroy();
    expect(first.renderer.listenerCount("resize")).toBe(0);
    // The second renderer's own listener is untouched by the first's teardown.
    expect(setup.renderer.listenerCount("resize")).toBe(1);
  });
});
