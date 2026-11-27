import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { Toast } from "./Toast";
import { squish } from "./test-helpers";

let destroy: (() => void) | null = null;
afterEach(() => {
  destroy?.();
  destroy = null;
});

async function renderAt(width: number, message: string): Promise<string> {
  const setup = await testRender(() => <Toast message={message} />, {
    width,
    height: 8,
  });
  destroy = () => setup.renderer.destroy();
  await setup.renderOnce();
  return setup.captureCharFrame();
}

// A card clipped off the left edge loses its corners; a card that fits keeps
// them. This is the "nothing clipped on the left" check.
function hasLeftCorner(frame: string): boolean {
  return frame.includes("┌") && frame.includes("└");
}

describe("Toast", () => {
  const LONG = "Target pane is on a different tmux server";

  it("keeps the full card on-screen at the default sidebar width (30)", async () => {
    const frame = await renderAt(30, LONG);
    expect(squish(frame)).toContain(squish(LONG));
    expect(hasLeftCorner(frame)).toBe(true);
  });

  it("renders the full message and card at a comfortable width (60)", async () => {
    const frame = await renderAt(60, LONG);
    expect(squish(frame)).toContain(squish(LONG));
    expect(hasLeftCorner(frame)).toBe(true);
  });

  it("fits a message to the columns it has, when given a fit", async () => {
    const fitted = async (width: number) => {
      const setup = await testRender(
        () => <Toast message="unused" fit={(columns) => `fit to ${columns}`} />,
        { width, height: 8 },
      );
      destroy = () => setup.renderer.destroy();
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      setup.renderer.destroy();
      destroy = null;
      return frame;
    };
    // 40 columns of card, less its border and padding.
    expect(await fitted(100)).toContain("fit to 36");
    // A 40-column sidebar leaves a 1-column gap either side of the card.
    expect(await fitted(40)).toContain("fit to 34");
  });

  it("shrinks to fit a short message", async () => {
    const frame = await renderAt(60, "Hi");
    expect(frame).toContain("Hi");
    expect(hasLeftCorner(frame)).toBe(true);
  });
});
