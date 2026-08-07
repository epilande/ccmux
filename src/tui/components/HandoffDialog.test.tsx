import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  HandoffDialog,
  HANDOFF_DIALOG_FLOOR_ROWS,
  fitHandoffEndpoint,
  planHandoffDialogRows,
  type HandoffDialogField,
  type HandoffEndpoint,
} from "./HandoffDialog";
import { squish } from "./test-helpers";

describe("planHandoffDialogRows", () => {
  it("draws everything when the terminal has room", () => {
    expect(planHandoffDialogRows(24, true)).toEqual({
      spacers: true,
      buttons: true,
      source: true,
      hint: true,
      height: HANDOFF_DIALOG_FLOOR_ROWS + 8,
    });
  });

  it("budgets no hint row when the footer carries the hints", () => {
    expect(planHandoffDialogRows(24, false)).toEqual({
      spacers: true,
      buttons: true,
      source: true,
      hint: false,
      height: HANDOFF_DIALOG_FLOOR_ROWS + 7,
    });
  });

  it("gives up the blank rows first", () => {
    const plan = planHandoffDialogRows(HANDOFF_DIALOG_FLOOR_ROWS + 7, true);
    expect(plan).toEqual({
      spacers: false,
      buttons: true,
      source: true,
      hint: true,
      height: HANDOFF_DIALOG_FLOOR_ROWS + 5,
    });
  });

  it("gives up the buttons before the From row", () => {
    // The buttons duplicate Enter and Escape exactly; the From row is the
    // one fact the box would otherwise lose.
    const plan = planHandoffDialogRows(HANDOFF_DIALOG_FLOOR_ROWS + 4, true);
    expect(plan).toEqual({
      spacers: false,
      buttons: false,
      source: true,
      hint: true,
      height: HANDOFF_DIALOG_FLOOR_ROWS + 2,
    });
  });

  it("gives up the From row before the key hints", () => {
    // Which session it came from is context the user just supplied; that Tab
    // reaches the note is not guessable from the box.
    const plan = planHandoffDialogRows(HANDOFF_DIALOG_FLOOR_ROWS + 1, true);
    expect(plan.source).toBe(false);
    expect(plan.hint).toBe(true);
  });

  it("keeps the fields and the To row when nothing else fits", () => {
    expect(planHandoffDialogRows(HANDOFF_DIALOG_FLOOR_ROWS, true)).toEqual({
      spacers: false,
      buttons: false,
      source: false,
      hint: false,
      height: HANDOFF_DIALOG_FLOOR_ROWS,
    });
  });

  it("never asks for more rows than the terminal has", () => {
    // A box taller than the screen draws its bottom border off it.
    for (const height of [1, 2, 3, 4, 5]) {
      expect(planHandoffDialogRows(height, true).height).toBe(height);
    }
  });
});

describe("fitHandoffEndpoint", () => {
  const endpoint: HandoffEndpoint = {
    context: "ccmux:main",
    agent: "Claude",
    agentColor: "#fab387",
    pane: "ccmux:7.4",
  };

  it("keeps every token when they fit", () => {
    expect(fitHandoffEndpoint(endpoint, 40)).toEqual(endpoint);
  });

  it("truncates the context before touching the other tokens", () => {
    const fitted = fitHandoffEndpoint(
      { ...endpoint, context: "epilande/ccmux:feat/dialog-consistency" },
      40,
    );
    expect(fitted.agent).toBe("Claude");
    expect(fitted.pane).toBe("ccmux:7.4");
    expect(fitted.context).toContain("…");
  });

  it("drops the agent before the pane", () => {
    // Two same-project rows on the same agent differ by nothing BUT the
    // pane; naming the physical destination is the row's whole job.
    const fitted = fitHandoffEndpoint(endpoint, 16);
    expect(fitted.agent).toBe("");
    expect(fitted.pane).toBe("ccmux:7.4");
  });

  it("keeps a paneless endpoint's context at any width", () => {
    const fitted = fitHandoffEndpoint({ ...endpoint, pane: "" }, 10);
    expect(fitted.context.length).toBeGreaterThan(0);
  });
});

describe("HandoffDialog", () => {
  let setup: Awaited<ReturnType<typeof testRender>> | null = null;

  afterEach(() => {
    setup?.renderer.destroy();
    setup = null;
  });

  const FROM: HandoffEndpoint = {
    context: "proj1:main",
    agent: "Claude",
    agentColor: "#fab387",
    pane: "ccmux:1.1",
  };
  const TO: HandoffEndpoint = {
    context: "proj2:main",
    agent: "Codex",
    agentColor: "#a6e3a1",
    pane: "ccmux:2.2",
  };

  async function render(
    props: {
      turns?: number;
      note?: string;
      field?: HandoffDialogField;
      width?: number;
      height?: number;
      showKeyHints?: boolean;
    } = {},
  ) {
    setup = await testRender(
      () => (
        <HandoffDialog
          from={FROM}
          to={TO}
          turns={props.turns ?? 1}
          note={props.note ?? ""}
          field={props.field ?? "turns"}
          onNoteInput={() => {}}
          onFocusField={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          showKeyHints={props.showKeyHints}
        />
      ),
      { width: props.width ?? 80, height: props.height ?? 24 },
    );
    await setup.renderOnce();
    return setup.captureCharFrame();
  }

  it("names both ends with project, agent, and pane, and opens on the last response", async () => {
    const frame = squish(await render());
    expect(frame).toContain("Handoff");
    expect(frame).toContain("Toproj2:mainCodexccmux:2.2");
    expect(frame).toContain("Fromproj1:mainClaudeccmux:1.1");
    expect(frame).toContain("Lastresponse");
    expect(frame).toContain("note(optional)");
    expect(frame).toContain("entersend·j/kturns·tabnote·esccancel");
  });

  it("shows the Cancel and Send buttons when there is room", async () => {
    const frame = squish(await render());
    expect(frame).toContain("CancelSend");
  });

  it("draws no hint row of its own when the footer carries the hints", async () => {
    const frame = squish(await render({ showKeyHints: false }));
    expect(frame).toContain("CancelSend");
    expect(frame).not.toContain("entersend");
  });

  it("draws the rows in order: title, turns, note, From, To, buttons", async () => {
    // By ORDER rather than presence: nothing here clips, so a row the budget
    // did not account for draws OVER its neighbour instead of disappearing.
    // From sits above To — source above destination, the way the text will
    // travel.
    const lines = (await render()).split("\n");
    const lineOf = (text: string) =>
      lines.findIndex((line) => squish(line).includes(text));
    expect(lineOf("Handoff")).toBeLessThan(lineOf("Turns"));
    expect(lineOf("Turns")).toBeLessThan(lineOf("Note"));
    expect(lineOf("Note")).toBeLessThan(lineOf("Fromproj1"));
    expect(lineOf("Fromproj1")).toBeLessThan(lineOf("Toproj2"));
    expect(lineOf("Toproj2")).toBeLessThan(lineOf("Cancel"));
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
      lines.some((line) => squish(line).includes(`▎${label}`));
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

  it("keeps the To row even at the floor, dropping everything else first", async () => {
    const frame = squish(
      await render({ height: HANDOFF_DIALOG_FLOOR_ROWS, width: 80 }),
    );
    expect(frame).toContain("Handoff");
    expect(frame).toContain("Turns");
    expect(frame).toContain("Note");
    expect(frame).toContain("Toproj2");
    expect(frame).not.toContain("Fromproj1");
    expect(frame).not.toContain("Cancel");
    expect(frame).not.toContain("entersend");
  });

  it("keeps the pane visible at a sidebar's width", async () => {
    // The context yields and the agent goes whole; the pane is the token the
    // row exists to show.
    const frame = squish(await render({ turns: 3, width: 30 }));
    expect(frame).toContain("Last3turns");
    expect(frame).toContain("ccmux:2.2");
    expect(frame).toContain("ccmux:1.1");
  });
});
