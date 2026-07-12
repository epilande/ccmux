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

  it("shrinks to fit a short message", async () => {
    const frame = await renderAt(60, "Hi");
    expect(frame).toContain("Hi");
    expect(hasLeftCorner(frame)).toBe(true);
  });
});
