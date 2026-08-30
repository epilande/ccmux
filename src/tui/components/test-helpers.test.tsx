import { describe, it, expect, afterEach } from "bun:test";
import { testRender, useKeyboard } from "@opentui/solid";
import { deliverEscape } from "./test-helpers";

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

async function mountProbe() {
  const seen: string[] = [];
  const Probe = () => {
    useKeyboard((event) => {
      seen.push(event.meta ? `meta+${event.name}` : event.name);
    });
    return <text>probe</text>;
  };
  setup = await testRender(() => <Probe />, { width: 20, height: 3 });
  await setup.renderOnce();
  return { seen, setup };
}

describe("deliverEscape", () => {
  it("delivers one escape event synchronously", async () => {
    const { seen, setup } = await mountProbe();
    deliverEscape(setup.renderer);
    expect(seen).toEqual(["escape"]);
    // The pending ESC was consumed rather than left in the parser's
    // window, so the next key is itself and not meta-that-key.
    setup.mockInput.pressKey("x");
    expect(seen).toEqual(["escape", "x"]);
  });

  // Pinned so an @opentui upgrade that fixes either trap fails here rather
  // than leaving a helper nobody remembers the reason for.
  it("pins why the raw harness paths cannot be used for escape", async () => {
    const { seen, setup } = await mountProbe();
    setup.mockInput.pressKey("escape");
    expect(seen).toEqual(["e", "s", "c", "a", "p", "e"]);
    seen.length = 0;
    setup.mockInput.pressEscape();
    await setup.renderOnce();
    expect(seen).toEqual([]);
    setup.mockInput.pressKey("x");
    expect(seen).toEqual(["meta+x"]);
  });
});
