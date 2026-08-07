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
      height: COPY_DIALOG_FLOOR_ROWS + 6,
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
    const plan = planCopyDialogRows(COPY_DIALOG_FLOOR_ROWS + 5, true);
    expect(plan.spacers).toBe(false);
    expect(plan.buttons).toBe(true);
    expect(plan.hint).toBe(true);
    expect(plan.height).toBe(COPY_DIALOG_FLOOR_ROWS + 5);
  });

  it("gives up the buttons before the key hints", () => {
    // The buttons duplicate Enter and Escape exactly; that Enter copies is
    // not guessable from a box with one row in it.
    const plan = planCopyDialogRows(COPY_DIALOG_FLOOR_ROWS + 2, true);
    expect(plan.buttons).toBe(false);
    expect(plan.hint).toBe(true);
    // Two rows, not one: the hints keep the blank above them wherever they
    // are drawn, the same unit the new-session dialog budgets.
    expect(plan.height).toBe(COPY_DIALOG_FLOOR_ROWS + 2);
  });

  it("budgets the hint row's own blank, so it never sits flush", () => {
    // The last tier that still draws hints is exactly the floor plus the
    // two-row hint unit; one row short of it, the hints go entirely rather
    // than landing against the count row.
    expect(planCopyDialogRows(COPY_DIALOG_FLOOR_ROWS + 1, true).hint).toBe(
      false,
    );
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

  it("keeps a blank row above the hints, under the buttons and without them", async () => {
    // The new-session dialog's `KEY_HINT_ROWS`: the hint line owns the air
    // above it, so it reads as a line under the dialog rather than another
    // row inside it. Under the buttons that stacks with the button unit's
    // own trailing blank (two rows between), and at the tier where the
    // buttons are gone the blank is what stops the hints sitting flush
    // against the count.
    const lineOf = (lines: string[], text: string) =>
      lines.findIndex((line) => squish(line).includes(text));

    setup = await testRender(
      () => (
        <CopyDialog
          label="claude · myapp"
          turns={1}
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      ),
      { width: 80, height: 24 },
    );
    await setup.renderOnce();
    const roomy = setup.captureCharFrame().split("\n");
    expect(lineOf(roomy, "entercopy") - lineOf(roomy, "CancelCopy")).toBe(3);
    setup.renderer.destroy();

    setup = await testRender(
      () => (
        <CopyDialog
          label="claude · myapp"
          turns={1}
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      ),
      { width: 80, height: COPY_DIALOG_FLOOR_ROWS + 2 },
    );
    await setup.renderOnce();
    const tight = setup.captureCharFrame().split("\n");
    expect(tight.some((line) => squish(line).includes("Cancel"))).toBe(false);
    expect(lineOf(tight, "entercopy") - lineOf(tight, "Lastresponse")).toBe(2);
  });

  it("drops the middle segment rather than blanking it, right at the boundary", async () => {
    // Terminal width 42 -> contentWidth 34, exactly COMPACT_HINT_WIDTH's old
    // (wrong) value of 34: the full hint row is actually 35 columns wide, so
    // the buggy threshold used to draw the full row anyway and yoga's
    // flexShrink on the middle segment blanked "turns" out to spaces
    // ("enter copy · j/k      · esc cancel") while leaving "j/k" and the
    // trailing "· esc cancel" intact. squish() strips whitespace, which
    // would hide that blanking, so this reads the raw frame instead. At the
    // fixed threshold this width now correctly drops the whole middle
    // segment, so "j/k" must not appear at all — a stronger assertion than
    // merely allowing it to be absent.
    setup = await testRender(
      () => (
        <CopyDialog
          label="claude · myapp"
          turns={3}
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      ),
      { width: 42, height: 24 },
    );
    await setup.renderOnce();
    const hintLine = setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("enter") || line.includes("esc"));
    expect(hintLine).toBeDefined();
    expect(hintLine).not.toContain("j/k");
  });

  it("draws the full hint row intact right past the boundary", async () => {
    // Terminal width 43 -> contentWidth 35, exactly COMPACT_HINT_WIDTH: the
    // full row must fit and render "turns" whole, not blanked.
    setup = await testRender(
      () => (
        <CopyDialog
          label="claude · myapp"
          turns={3}
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      ),
      { width: 43, height: 24 },
    );
    await setup.renderOnce();
    const hintLine = setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("j/k"));
    expect(hintLine).toBeDefined();
    expect(hintLine).toContain("turns");
  });

  it("keeps the exits' gloss words at a sidebar's width, dropping only the middle segment", async () => {
    // A sidebar (40 columns) lands in the compact band but not the narrower
    // one: the new-session dialog's own two-tier trade, mirrored here so a
    // compact row still reads as a sentence rather than bare keys.
    const frame = await render(1, 40);
    expect(frame).toContain("entercopy·esccancel");
    expect(frame).not.toContain("j/kturns");
  });

  it("drops the exits' gloss words only once the row is genuinely too narrow for them", async () => {
    const frame = await render(1, 26);
    expect(frame).toContain("entercopy·esc");
    expect(frame).not.toContain("esccancel");
  });
});
