import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { Toast } from "./Toast";

// A toast wider than its cap word-wraps inside the pill, so a long message can
// straddle a line break in the captured frame. Strip box borders and all
// whitespace so an assertion matches the message regardless of where the wrap
// fell (mirrors the `squish` helper in App.test.tsx).
const squish = (s: string): string => s.replace(/[│┌┐└┘─\s]/g, "");

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

/**
 * Each captured frame line is `width` cells; a card that overflows the left
 * edge shows up as a border row starting in column 0 with no `┌`/`└` corner.
 * A card that fits always has its top-left corner somewhere within the row.
 */
function hasLeftCorner(frame: string): boolean {
  return frame.includes("┌") && frame.includes("└");
}

describe("Toast", () => {
  const LONG = "Target pane is on a different tmux server";

  it("keeps the full card on-screen at the default sidebar width (30)", async () => {
    const frame = await renderAt(30, LONG);
    // The whole message survives despite word-wrap...
    expect(squish(frame)).toContain(squish(LONG));
    // ...and both left corners are present, i.e. nothing clipped off the left.
    expect(hasLeftCorner(frame)).toBe(true);
  });

  it("keeps the card on-screen at a very narrow width (20)", async () => {
    const frame = await renderAt(20, LONG);
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
