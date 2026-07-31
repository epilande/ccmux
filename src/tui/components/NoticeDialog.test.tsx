import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSpy } from "@opentui/core/testing";
import { NoticeDialog } from "./NoticeDialog";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => setup?.renderer.destroy());

/** Row indexes of the frame's bordered rows, top border first. */
function borderRows(frame: string): number[] {
  return frame
    .split("\n")
    .flatMap((line, row) => (/[┌└│]/.test(line) ? [row] : []));
}

describe("NoticeDialog", () => {
  it("wraps a long line rather than letting it run past the border", async () => {
    setup = await testRender(
      () => (
        <NoticeDialog
          title="Move failed"
          lines={[
            "Your changes are in stash entry abc1234; recover them with 'git stash apply abc1234'.",
          ]}
          onDismiss={() => {}}
        />
      ),
      { width: 60, height: 20 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    // Every rendered row fits the dialog, so the sha survives the wrap in one
    // piece somewhere in the frame.
    expect(frame.replace(/[\s│┌┐└┘─]/g, "")).toContain("gitstashapplyabc1234");
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("keeps its bottom border on screen when the message outruns the terminal", async () => {
    // A capped message, not a dialog drawn past the viewport: content that
    // overflows does not clip here, it draws over the rows above it.
    setup = await testRender(
      () => (
        <NoticeDialog
          title="Move failed"
          lines={Array.from({ length: 40 }, (_, i) => `line ${i}`)}
          onDismiss={() => {}}
        />
      ),
      { width: 60, height: 12 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const rows = frame.split("\n");
    expect(rows[0]).toContain("┌");
    // The last row carries the bottom border, and the dismiss hint is above it.
    const bottom = borderRows(frame).at(-1)!;
    expect(rows[bottom]).toContain("└");
    expect(rows[bottom - 1]).toContain("any key to dismiss");
  });

  it("dismisses on a click", async () => {
    const onDismiss = createSpy();
    setup = await testRender(
      () => (
        <NoticeDialog
          title="Move failed"
          lines={["something happened"]}
          onDismiss={onDismiss}
        />
      ),
      { width: 60, height: 12 },
    );
    await setup.renderOnce();
    const row = setup
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("something happened"));
    await setup.mockMouse.click(30, row);
    expect(onDismiss.callCount()).toBe(1);
  });
});
