import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  CopyDialog,
  COPY_DIALOG_FLOOR_ROWS,
  planCopyDialogRows,
} from "./CopyDialog";
import { squish } from "./test-helpers";

// The turn label itself is the shared selector's; see
// `src/tui/turns-selection.test.ts`.

describe("planCopyDialogRows", () => {
  it("draws everything when the terminal has room", () => {
    expect(planCopyDialogRows(24, true)).toEqual({
      spacers: true,
      buttons: true,
      hint: true,
      height: COPY_DIALOG_FLOOR_ROWS + 5,
    });
  });

  it("budgets no hint row when the footer carries the hints", () => {
    expect(planCopyDialogRows(24, false)).toEqual({
      spacers: true,
      buttons: true,
      hint: false,
      height: COPY_DIALOG_FLOOR_ROWS + 4,
    });
  });

  it("gives up the blank row before the buttons", () => {
    const plan = planCopyDialogRows(COPY_DIALOG_FLOOR_ROWS + 4, true);
    expect(plan.spacers).toBe(false);
    expect(plan.buttons).toBe(true);
    expect(plan.hint).toBe(true);
    expect(plan.height).toBe(COPY_DIALOG_FLOOR_ROWS + 4);
  });

  it("gives up the buttons before the key hints", () => {
    // The buttons duplicate Enter and Escape exactly; that Enter copies is
    // not guessable from a box with one row in it.
    const plan = planCopyDialogRows(COPY_DIALOG_FLOOR_ROWS + 1, true);
    expect(plan.buttons).toBe(false);
    expect(plan.hint).toBe(true);
    expect(plan.height).toBe(COPY_DIALOG_FLOOR_ROWS + 1);
  });

  it("keeps the title and the count when nothing else fits", () => {
    expect(planCopyDialogRows(COPY_DIALOG_FLOOR_ROWS, true)).toEqual({
      spacers: false,
      buttons: false,
      hint: false,
      height: COPY_DIALOG_FLOOR_ROWS,
    });
  });

  it("never asks for more rows than the terminal has", () => {
    // A box taller than the screen draws its bottom border off it.
    for (const height of [1, 2, 3]) {
      expect(planCopyDialogRows(height, true).height).toBe(height);
    }
  });
});

describe("CopyDialog", () => {
  let setup: Awaited<ReturnType<typeof testRender>> | null = null;

  afterEach(() => {
    setup?.renderer.destroy();
    setup = null;
  });

  async function render(
    turns: number,
    width = 80,
    height = 24,
    showKeyHints?: boolean,
  ) {
    setup = await testRender(
      () => (
        <CopyDialog
          label="claude · myapp"
          turns={turns}
          onSubmit={() => {}}
          onCancel={() => {}}
          showKeyHints={showKeyHints}
        />
      ),
      { width, height },
    );
    await setup.renderOnce();
    return squish(setup.captureCharFrame());
  }

  it("opens on the last response, named after the row it copies from", async () => {
    const frame = await render(1);
    expect(frame).toContain("Copyfromclaude·myapp");
    expect(frame).toContain("Lastresponse");
    expect(frame).toContain("CancelCopy");
    expect(frame).toContain("entercopy·j/kturns·esccancel");
  });

  it("draws no hint row of its own when the footer carries the hints", async () => {
    const frame = await render(1, 80, 24, false);
    expect(frame).toContain("CancelCopy");
    expect(frame).not.toContain("entercopy");
  });

  it("says a multi-turn copy brings the user's own prompts", async () => {
    const frame = await render(3);
    expect(frame).toContain("Last3turns(withyourprompts)");
    expect(frame).not.toContain("Lastresponse");
  });

  it("keeps the count legible at a sidebar's width", async () => {
    // The parenthetical is what a narrow box loses; the count itself is
    // first in the line, so it survives.
    const frame = await render(3, 30);
    expect(frame).toContain("Last3turns");
  });

  it("drops the buttons and hints rather than drawing past a short terminal", async () => {
    const frame = await render(1, 80, COPY_DIALOG_FLOOR_ROWS);
    expect(frame).toContain("Lastresponse");
    expect(frame).not.toContain("Cancel");
    expect(frame).not.toContain("entercopy");
  });
});
