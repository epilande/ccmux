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

  // Odd heights included: a 50%-offset-plus-negative-margin centering rounds
  // the two halves apart by a row, and the row it loses is the bottom border.
  for (const height of [11, 12]) {
    it(`keeps its bottom border on screen when the message outruns a ${height}-row terminal`, async () => {
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
        { width: 60, height },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      const rows = frame.split("\n");
      expect(rows[0]).toContain("┌");
      // The last row carries the bottom border, and the dismiss hint is above.
      const bottom = borderRows(frame).at(-1)!;
      expect(rows[bottom]).toContain("└");
      expect(rows[bottom - 1]).toContain("any key to dismiss");
    });
  }

  it("centers itself rather than sitting a row below center", async () => {
    setup = await testRender(
      () => (
        <NoticeDialog
          title="Move failed"
          lines={["something happened"]}
          onDismiss={() => {}}
        />
      ),
      { width: 60, height: 21 },
    );
    await setup.renderOnce();
    const rows = borderRows(setup.captureCharFrame());
    const top = rows[0]!;
    const bottom = rows.at(-1)!;
    // CHROME_ROWS (6) + one message row = 7, centered in 21 rows: rows 7..13.
    expect(top).toBe(7);
    expect(bottom).toBe(13);
  });

  it("widens to keep a link in one piece when the terminal has room", async () => {
    // A URL broken across two rows is two halves no terminal can open.
    const url =
      "https://github.com/epilande/ccmux/blob/main/docs/tui-views-migration.md";
    setup = await testRender(
      () => (
        <NoticeDialog
          title="Keys changed"
          lines={[`Details: ${url}`]}
          onDismiss={() => {}}
        />
      ),
      { width: 100, height: 12 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain(url);
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  it("keeps ordinary prose at its usual width", async () => {
    setup = await testRender(
      () => (
        <NoticeDialog
          title="Move failed"
          lines={["word ".repeat(40).trim()]}
          onDismiss={() => {}}
        />
      ),
      { width: 100, height: 20 },
    );
    await setup.renderOnce();
    const top = setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("┌"))!;
    // MAX_WIDTH (72) wide, border to border.
    expect(top.trim().length).toBe(72);
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
