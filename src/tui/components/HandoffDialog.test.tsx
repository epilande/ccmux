import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  HandoffDialog,
  HANDOFF_DIALOG_FLOOR_ROWS,
  planHandoffDialogRows,
  type HandoffDialogField,
} from "./HandoffDialog";
import { squish } from "./test-helpers";

describe("planHandoffDialogRows", () => {
  it("draws everything when the terminal has room", () => {
    expect(planHandoffDialogRows(24)).toEqual({
      spacers: true,
      source: true,
      hint: true,
      height: HANDOFF_DIALOG_FLOOR_ROWS + 4,
    });
  });

  it("gives up the blank rows first", () => {
    const plan = planHandoffDialogRows(HANDOFF_DIALOG_FLOOR_ROWS + 3);
    expect(plan).toEqual({
      spacers: false,
      source: true,
      hint: true,
      height: HANDOFF_DIALOG_FLOOR_ROWS + 2,
    });
  });

  it("gives up the source line before the key hints", () => {
    // Which session it came from is context the user just supplied; that Tab
    // reaches the note is not guessable from the box.
    const plan = planHandoffDialogRows(HANDOFF_DIALOG_FLOOR_ROWS + 1);
    expect(plan.source).toBe(false);
    expect(plan.hint).toBe(true);
  });

  it("keeps both fields when nothing else fits", () => {
    expect(planHandoffDialogRows(HANDOFF_DIALOG_FLOOR_ROWS)).toEqual({
      spacers: false,
      source: false,
      hint: false,
      height: HANDOFF_DIALOG_FLOOR_ROWS,
    });
  });

  it("never asks for more rows than the terminal has", () => {
    // A box taller than the screen draws its bottom border off it.
    for (const height of [1, 2, 3, 4]) {
      expect(planHandoffDialogRows(height).height).toBe(height);
    }
  });
});

describe("HandoffDialog", () => {
  let setup: Awaited<ReturnType<typeof testRender>> | null = null;

  afterEach(() => {
    setup?.renderer.destroy();
    setup = null;
  });

  async function render(
    props: {
      turns?: number;
      note?: string;
      field?: HandoffDialogField;
      width?: number;
      height?: number;
    } = {},
  ) {
    setup = await testRender(
      () => (
        <HandoffDialog
          fromLabel="claude · proj1"
          toLabel="codex · proj2"
          turns={props.turns ?? 1}
          note={props.note ?? ""}
          field={props.field ?? "turns"}
          onNoteInput={() => {}}
        />
      ),
      { width: props.width ?? 80, height: props.height ?? 24 },
    );
    await setup.renderOnce();
    return setup.captureCharFrame();
  }

  it("names both ends, and opens on the last response with no note", async () => {
    const frame = squish(await render());
    expect(frame).toContain("Handofftocodex·proj2");
    expect(frame).toContain("fromclaude·proj1");
    expect(frame).toContain("Lastresponse");
    expect(frame).toContain("note(optional)");
    expect(frame).toContain("j/kturns·tabnote·entersend·esccancel");
  });

  it("draws the rows in order: title, source, turns, note", async () => {
    // By ORDER rather than presence: nothing here clips, so a row the budget
    // did not account for draws OVER its neighbour instead of disappearing.
    const lines = (await render()).split("\n");
    const lineOf = (text: string) =>
      lines.findIndex((line) => squish(line).includes(text));
    expect(lineOf("Handoffto")).toBeLessThan(lineOf("fromclaude"));
    expect(lineOf("fromclaude")).toBeLessThan(lineOf("Turns"));
    expect(lineOf("Turns")).toBeLessThan(lineOf("Note"));
  });

  it("says a multi-turn handoff brings the user's own prompts", async () => {
    const frame = squish(await render({ turns: 3 }));
    expect(frame).toContain("Last3turns(withyourprompts)");
    expect(frame).not.toContain("Lastresponse");
  });

  it("marks the focused field, and only that one", async () => {
    const onTurns = (await render({ field: "turns" })).split("\n");
    const onNote = (await render({ field: "note" })).split("\n");
    const marked = (lines: string[], label: string) =>
      lines.some((line) => squish(line).includes(`>${label}`));
    expect(marked(onTurns, "Turns")).toBe(true);
    expect(marked(onTurns, "Note")).toBe(false);
    expect(marked(onNote, "Note")).toBe(true);
    expect(marked(onNote, "Turns")).toBe(false);
  });

  it("shows a typed note in place of the placeholder", async () => {
    const frame = squish(await render({ note: "take it from here" }));
    expect(frame).toContain("takeitfromhere");
    expect(frame).not.toContain("note(optional)");
  });

  it("drops the source line and the hints rather than drawing past a short terminal", async () => {
    const frame = squish(
      await render({ height: HANDOFF_DIALOG_FLOOR_ROWS, width: 80 }),
    );
    expect(frame).toContain("Handoffto");
    expect(frame).toContain("Turns");
    expect(frame).toContain("Note");
    expect(frame).not.toContain("fromclaude");
    expect(frame).not.toContain("entersend");
  });

  it("keeps the count and the fields legible at a sidebar's width", async () => {
    const frame = squish(await render({ turns: 3, width: 30 }));
    expect(frame).toContain("Last3turns");
    expect(frame).toContain("Turns");
    expect(frame).toContain("Note");
  });
});
