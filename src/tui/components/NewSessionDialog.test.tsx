import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  NewSessionDialog,
  newSessionFloorRows,
  planDialogRows,
  wrapText,
} from "./NewSessionDialog";
import { optionWindow } from "./DropdownField";
import { expectFrameIntegrity, squish } from "./test-helpers";
import { displayWidth } from "../utils/format";
import type { SpawnableAgent } from "../../lib/spawnable-agents";
import type { NewSessionDraft } from "../store";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

const agent = (
  name: string,
  overrides: Partial<SpawnableAgent> = {},
): SpawnableAgent => ({
  name,
  displayName: name.charAt(0).toUpperCase() + name.slice(1),
  shortCode: name.slice(0, 2).toUpperCase(),
  supportsPrompt: true,
  ...overrides,
});

const draft = (overrides: Partial<NewSessionDraft> = {}): NewSessionDraft => ({
  cwd: "/Users/dev/code/ccmux",
  agent: "claude",
  placement: "window",
  destination: "here",
  prompt: "",
  moveChanges: false,
  untracked: "move",
  worktreeName: null,
  fork: null,
  existingWorktree: null,
  returnToWorktrees: null,
  field: "agent",
  dropdown: null,
  ...overrides,
});

/** A draft as the row menu's "Move changes" opens it. */
const moveDraft = (overrides: Partial<NewSessionDraft> = {}): NewSessionDraft =>
  draft({ moveChanges: true, destination: "worktree", ...overrides });

async function renderDialog(props: {
  draft?: NewSessionDraft;
  agents?: SpawnableAgent[] | null;
  agentsError?: string | null;
  showKeyHints?: boolean;
  width?: number;
  height?: number;
}) {
  setup = await testRender(
    () => (
      <NewSessionDialog
        draft={props.draft ?? draft()}
        agents={props.agents === undefined ? [agent("claude")] : props.agents}
        agentsError={props.agentsError}
        onFocusField={() => {}}
        onOpenDropdown={() => {}}
        onCloseDropdown={() => {}}
        onSelectOption={() => {}}
        onPromptInput={() => {}}
        onWorktreeNameInput={() => {}}
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

describe("optionWindow", () => {
  it("returns the whole list when it fits", () => {
    expect(optionWindow(3, 2, 5)).toEqual({ start: 0, end: 3 });
  });

  it("keeps an early selection at the top of the window", () => {
    expect(optionWindow(9, 0, 3)).toEqual({ start: 0, end: 3 });
    expect(optionWindow(9, 1, 3)).toEqual({ start: 0, end: 3 });
  });

  it("centers a mid-list selection", () => {
    expect(optionWindow(9, 4, 3)).toEqual({ start: 3, end: 6 });
  });

  it("clamps at the end rather than running past it", () => {
    expect(optionWindow(9, 8, 3)).toEqual({ start: 6, end: 9 });
  });

  it("always includes the selection", () => {
    for (let selected = 0; selected < 9; selected++) {
      const { start, end } = optionWindow(9, selected, 4);
      expect(selected >= start && selected < end).toBe(true);
    }
  });
});

describe("wrapText", () => {
  it("breaks on words and keeps every line within the width", () => {
    const lines = wrapText("Daemon is out of date - run restart", 13);
    expect(lines).toEqual(["Daemon is out", "of date - run", "restart"]);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(13);
  });

  it("breaks a word that cannot fit a line of its own", () => {
    expect(wrapText("run ccmuxdaemonrestart now", 8)).toEqual([
      "run",
      "ccmuxdae",
      "monresta",
      "rt now",
    ]);
  });

  it("always yields at least one line", () => {
    expect(wrapText("", 10)).toEqual([""]);
    expect(wrapText("   ", 10)).toEqual([""]);
  });

  it("gives up rather than looping when there is no width to wrap into", () => {
    expect(wrapText("anything", 0)).toEqual(["anything"]);
  });

  /**
   * Issue #91: the widths above are display columns, so a line of CJK fills
   * its column exactly like an ASCII one. Measured in code units these lines
   * were twice their claimed width and the renderer clipped half of each.
   */
  it("wraps wide glyphs to the column they actually occupy", () => {
    const message = "エージェントを 解決できません でした デーモンを 再起動";
    const lines = wrapText(message, 19);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(19);
    }
    expect(lines.join(" ")).toBe(message);
  });

  it("breaks an over-wide CJK word on a glyph boundary", () => {
    const lines = wrapText("解決できませんでした", 9);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(9);
    expect(lines.join("")).toBe("解決できませんでした");
    // An odd budget stops a column short rather than splitting a glyph.
    expect(lines[0]).toBe("解決でき");
  });

  it("never splits an emoji cluster across lines", () => {
    const family = "👨‍👩‍👧‍👦";
    const lines = wrapText(family.repeat(6), 5);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(5);
      // Whole families only, so nothing renders as a replacement glyph.
      expect(line.replace(new RegExp(family, "gu"), "")).toBe("");
    }
    expect(lines.join("")).toBe(family.repeat(6));
  });

  it("emits an unsplittable glyph rather than spinning on it", () => {
    // A column too narrow for one wide glyph: it has to overflow, but the
    // loop must still terminate.
    expect(wrapText("日本", 1)).toEqual(["日本"]);
  });
});

describe("planDialogRows", () => {
  /** The move-changes dialog: the mode with the most fields, all one row
   *  each now that every option list lives in an overlay. */
  const move = {
    moveChanges: true,
    fork: false,
    namesAWorktree: true,
    existingWorktree: false,
    agentRows: 1,
    keyHints: true,
  };

  it("spends everything it has when the rows are there", () => {
    const plan = planDialogRows(move, 40);
    expect(plan.tooShort).toBe(false);
    expect(plan.showFieldSpacers).toBe(true);
    expect(plan.showButtons).toBe(true);
    expect(plan.showKeyHints).toBe(true);
    expect(plan.showModeNote).toBe(true);
    expect(plan.showDirectory).toBe(true);
    // Nothing is padded out to fill the screen: the dialog is its content —
    // border and title (3), the spacer, six one-row fields with the six
    // blank rows airing the stack (directory included), the directory, the
    // Changes note, the button row with its two blanks, and the two hint
    // rows.
    expect(plan.height).toBe(23);
  });

  it("gives up rows in an order that keeps the actionable ones", () => {
    // Each step is the same dialog one row shorter, so the sequence IS the
    // priority list: the field spacers (all at once — pure air), then the
    // buttons (a duplicate of enter/esc), then the hints, then the move
    // note, then the blank under the title, then the directory. The fields
    // never enter it: each is one row in every mode, with its list in an
    // overlay outside the budget.
    const given = (height: number) => {
      const plan = planDialogRows(move, height);
      return {
        fieldSpacers: plan.showFieldSpacers,
        buttons: plan.showButtons,
        hints: plan.showKeyHints,
        note: plan.showModeNote,
        spacer: plan.showTitleSpacer,
        directory: plan.showDirectory,
        tooShort: plan.tooShort,
      };
    };
    expect(given(23).fieldSpacers).toBe(true);
    expect(given(22).fieldSpacers).toBe(false);
    expect(given(22).buttons).toBe(true);
    expect(given(16).buttons).toBe(false);
    expect(given(16).hints).toBe(true);
    expect(given(13).hints).toBe(false);
    expect(given(13).note).toBe(true);
    expect(given(11).note).toBe(false);
    expect(given(10).spacer).toBe(false);
    expect(given(10).directory).toBe(true);
    // The last thing to go, because in this mode it names the checkout being
    // emptied.
    expect(given(9).directory).toBe(false);
    expect(given(9).tooShort).toBe(false);
  });

  it("shrinks the agent error back after the spacers, before the rest", () => {
    // The one thing that can still want more than a row is the agent
    // field's ERROR, and its tail is already summarised by an ellipsis, so
    // it gives up rows without losing anything actionable — but the pure-air
    // spacers go first.
    const plan = planDialogRows({ ...move, agentRows: 9 }, 20);
    expect(plan.showFieldSpacers).toBe(false);
    expect(plan.showButtons).toBe(false);
    expect(plan.agentRows).toBeLessThan(9);
    expect(plan.showKeyHints).toBe(true);
    expect(plan.showModeNote).toBe(true);
  });

  it("refuses to draw a dialog shorter than its own fields", () => {
    expect(planDialogRows(move, 8).tooShort).toBe(true);
    expect(planDialogRows(move, 8).height).toBe(3);
    // An ordinary spawn into this checkout has two fewer rows to find.
    const plain = {
      moveChanges: false,
      fork: false,
      namesAWorktree: false,
      existingWorktree: false,
      agentRows: 1,
      keyHints: false,
    };
    expect(newSessionFloorRows(plain)).toBe(7);
    expect(planDialogRows(plain, 7).tooShort).toBe(false);
    expect(planDialogRows(plain, 6).tooShort).toBe(true);
  });

  /**
   * Fork mode's own budget. The shape reaches this function from one call
   * site and the component reads every count back out of it, so a fork's
   * rows were only ever asserted through a rendered frame — where an extra
   * blank row is invisible until it is the row that overlaps the border.
   * These pin the numbers directly.
   */
  describe("in fork mode", () => {
    /** A fork on an ordinary terminal. `agentRows` is what an equivalent
     *  spawn's agent error would ask for, and a fork owes it nothing. */
    const wideFork = {
      moveChanges: false,
      fork: true,
      namesAWorktree: true,
      existingWorktree: false,
      agentRows: 3,
      keyHints: true,
    };

    it("spends its rows on three fields, an agent row on none", () => {
      expect(planDialogRows(wideFork, 40)).toEqual({
        tooShort: false,
        // Border and title (3), the spacer, the directory, the Source note,
        // the button row with its two blanks, the two hint rows, one row
        // each for Placement, Where and Name, and the three blank rows
        // airing that four-block stack.
        height: 17,
        showTitleSpacer: true,
        showFieldSpacers: true,
        showButtons: true,
        showDirectory: true,
        // The Source row: which conversation this continues.
        showModeNote: true,
        showKeyHints: true,
        // Not `Math.max(1, …)`: a fork has no agent row to floor at one, and
        // a row budgeted here that nothing renders is a blank line the rest
        // of the dialog is pushed down by.
        agentRows: 0,
      });
    });

    it("gives up everything optional at its floor and still fits", () => {
      expect(planDialogRows(wideFork, 6)).toEqual({
        tooShort: false,
        height: 6,
        showTitleSpacer: false,
        showFieldSpacers: false,
        showButtons: false,
        showDirectory: false,
        showModeNote: false,
        showKeyHints: false,
        // Still zero on the way down: the plan cannot shrink what was never
        // asked for.
        agentRows: 0,
      });
      expect(planDialogRows(wideFork, 5).tooShort).toBe(true);
    });

    it("asks for two fewer field rows than the same spawn would", () => {
      // Agent and Prompt, the two a fork does not have. The floor is a
      // border, a title and one row per field, so the gap IS those two rows.
      const shape = {
        moveChanges: false,
        namesAWorktree: true,
        existingWorktree: false,
      };
      expect(newSessionFloorRows({ ...shape, fork: true })).toBe(6);
      expect(newSessionFloorRows({ ...shape, fork: false })).toBe(8);
    });

    /** How a fork actually opens: continuing in the source's own checkout,
     *  where there is no worktree to name. */
    const forkHere = { ...wideFork, namesAWorktree: false };

    it("drops the name row's budget with the name row", () => {
      // One field fewer than the worktree variant above, and one row of air
      // with it. A count left at the worktree's would not clip the surplus —
      // it would draw the border over the last field.
      expect(planDialogRows(forkHere, 40)).toEqual({
        ...planDialogRows(wideFork, 40),
        height: 15,
      });
      expect(planDialogRows(forkHere, 5).tooShort).toBe(false);
      expect(planDialogRows(forkHere, 4).tooShort).toBe(true);
    });
  });

  /**
   * Existing-worktree mode's own budget (issue #102). Same fields an ordinary
   * spawn has minus the Where row, since the worktree the panel was on IS the
   * destination, plus the note that names it.
   */
  describe("in existing-worktree mode", () => {
    const existing = {
      moveChanges: false,
      fork: false,
      namesAWorktree: false,
      existingWorktree: true,
      agentRows: 1,
      keyHints: true,
    };

    it("spends its rows on three fields and a Worktree note", () => {
      expect(planDialogRows(existing, 40)).toEqual({
        tooShort: false,
        // Border and title (3), the spacer, the directory, the Worktree note,
        // the button row with its two blanks, the two hint rows, one row each
        // for Agent, Placement and Prompt, and the three blank rows airing
        // that four-block stack.
        height: 17,
        showTitleSpacer: true,
        showFieldSpacers: true,
        showButtons: true,
        showDirectory: true,
        // Which worktree, which the path above only spells out.
        showModeNote: true,
        showKeyHints: true,
        agentRows: 1,
      });
    });

    it("asks for one field row fewer than the same spawn elsewhere", () => {
      // The Where row, and only that: an ordinary spawn into a checkout has
      // the same agent, placement and prompt. A floor that still counted it
      // would report a row this mode does not need, and one SHORT of what is
      // drawn lands a row on its neighbour instead of clipping.
      const shape = { moveChanges: false, fork: false, namesAWorktree: false };
      expect(newSessionFloorRows({ ...shape, existingWorktree: true })).toBe(6);
      expect(newSessionFloorRows({ ...shape, existingWorktree: false })).toBe(
        7,
      );
    });

    it("gives up everything optional at its floor and still fits", () => {
      expect(planDialogRows(existing, 6)).toEqual({
        tooShort: false,
        height: 6,
        showTitleSpacer: false,
        showFieldSpacers: false,
        showButtons: false,
        showDirectory: false,
        showModeNote: false,
        showKeyHints: false,
        agentRows: 1,
      });
      expect(planDialogRows(existing, 5).tooShort).toBe(true);
    });
  });
});

describe("NewSessionDialog", () => {
  it("renders every field with its derived directory", async () => {
    const frame = await renderDialog({
      draft: draft({ cwd: "/Users/dev/code/ccmux" }),
      agents: [agent("claude"), agent("codex")],
    });
    expect(frame).toContain("New session");
    expect(frame).toContain("Agent");
    expect(frame).toContain("Placement");
    expect(frame).toContain("Prompt");
    expect(frame).toContain("Directory");
    expect(frame).toContain("/Users/dev/code/ccmux");
  });

  it("collapses the agents to the held value until the dropdown opens", async () => {
    const frame = await renderDialog({
      agents: [agent("claude"), agent("codex"), agent("pi")],
    });
    // The held value on its background pill, with the arrow as the
    // affordance that a list is behind it.
    expect(squish(frame)).toContain("Claude▾");
    // The list itself is not on screen, so nothing below it moved.
    expect(frame).not.toContain("2 Codex");
    expect(frame).not.toContain("3 Pi");
  });

  it("numbers the agents in the open dropdown so the keys are discoverable", async () => {
    const frame = await renderDialog({
      draft: draft({ dropdown: { field: "agent" as const, index: 0 } }),
      agents: [agent("claude"), agent("codex"), agent("pi")],
    });
    expect(frame).toContain("1 Claude");
    expect(frame).toContain("2 Codex");
    expect(frame).toContain("3 Pi");
  });

  it("draws the open dropdown over the rows below, not between them", async () => {
    const frame = await renderDialog({
      draft: draft({ dropdown: { field: "agent" as const, index: 0 } }),
      agents: [agent("claude"), agent("codex"), agent("pi")],
    });
    const lines = frame.split("\n");
    // The overlay starts directly under the Agent row...
    const agentRow = lines.findIndex((line) => /Claude\s+▾/.test(line));
    const first = lines.findIndex((line) => line.includes("1 Claude"));
    expect(agentRow).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(agentRow);
    // ...SHARING rows with the fields beneath it: the first option lands on
    // the Placement row's line (its top border in the gap between), which an
    // in-flow list would have pushed down past it instead. The label gutter
    // stays visible left of the overlay.
    expect(lines[first]).toContain("Placement");
    expect(frame).toContain("Directory");
  });

  it("airs the stack with a blank row between fields when the height affords it", async () => {
    const spacious = await renderDialog({});
    let lines = spacious.split("\n");
    const rowOf = (text: string) =>
      lines.findIndex((line) => line.includes(text));
    expect(rowOf("Placement")).toBe(rowOf("Agent") + 2);
    expect(rowOf("Prompt")).toBe(rowOf("Placement") + 2);
    expect(rowOf("Directory")).toBe(rowOf("Where") + 2);
    setup.renderer.destroy();

    // Tight, the air is the first thing given up: the stack closes back to
    // adjacent rows before anything actionable moves.
    const tight = await renderDialog({ height: 12 });
    lines = tight.split("\n");
    expect(rowOf("Placement")).toBe(rowOf("Agent") + 1);
    expect(rowOf("Directory")).toBe(rowOf("Where") + 1);
  });

  it("anchors the overlay under its own pill with the spacers on", async () => {
    const frame = await renderDialog({
      draft: draft({ dropdown: { field: "placement" as const, index: 0 } }),
    });
    const lines = frame.split("\n");
    const pill = lines.findIndex((line) => line.includes("Placement"));
    const first = lines.findIndex((line) => /▎ 1 New window/.test(line));
    // The overlay's top border sits in the gap row under the pill, so the
    // first option is exactly two rows below it — an anchor that ignored
    // the spacers would land the list a row high, over its own field.
    expect(pill).toBeGreaterThan(0);
    expect(first).toBe(pill + 2);
    // And it opens at the control's left edge: the border one column left
    // of the pill's value, exactly where the pill's own padding starts.
    const valueColumn = lines[pill]!.indexOf("New window");
    expect(lines[pill + 1]!.indexOf("┌")).toBe(valueColumn - 1);
  });

  it("marks the drafted agent inside the open dropdown", async () => {
    const frame = await renderDialog({
      draft: draft({
        agent: "codex",
        dropdown: { field: "agent" as const, index: 1 },
      }),
      agents: [agent("claude"), agent("codex")],
    });
    expect(frame).toContain("▎ 2 Codex");
    expect(frame).not.toContain("▎ 1 Claude");
  });

  it("holds the placement on its pill and offers the rest in its dropdown", async () => {
    const collapsed = await renderDialog({
      draft: draft({ placement: "split-h" }),
    });
    expect(collapsed).toMatch(/Split right\s+▾/);
    expect(collapsed).not.toContain("New window");
    setup.renderer.destroy();

    const open = await renderDialog({
      draft: draft({
        placement: "split-h",
        dropdown: { field: "placement" as const, index: 1 },
      }),
    });
    expect(open).toContain("1 New window");
    expect(open).toContain("▎ 2 Split right");
    expect(open).toContain("3 Split down");
  });

  it("abbreviates the placement pill when the row is short of room", async () => {
    const frame = await renderDialog({ width: 60 });
    expect(frame).toMatch(/Window\s+▾/);
    expect(frame).not.toContain("New window");
  });

  it("keeps the placements distinguishable at the real sidebar rail", async () => {
    // A 30-column rail leaves the overlay too few columns for the full
    // labels, which truncated `Split right`/`Split down` into two rows both
    // starting `Split` — indistinguishable, with number keys that still
    // worked. The overlay falls back to the short labels instead.
    const frame = await renderDialog({
      draft: draft({ dropdown: { field: "placement" as const, index: 0 } }),
      width: 30,
      height: 30,
    });
    expect(frame).toContain("Window");
    expect(frame).toContain("Right");
    expect(frame).toContain("Down");
    const lines = frame.split("\n");
    expect(lines.filter((l) => l.includes("Split")).length).toBe(0);
    // And nothing runs past the terminal's own edge.
    const widest = Math.max(...lines.map((l) => l.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(30);
  });

  it("marks the focused field without relying on colour", async () => {
    // The number keys are scoped to the focused field, so which field has
    // focus has to survive a colourless terminal.
    const onAgent = await renderDialog({ draft: draft({ field: "agent" }) });
    expect(onAgent).toContain("▎Agent");
    expect(onAgent).not.toContain("▎Placement");
    setup.renderer.destroy();

    const onPlacement = await renderDialog({
      draft: draft({ field: "placement" }),
    });
    expect(onPlacement).toContain("▎Placement");
    expect(onPlacement).not.toContain("▎Agent");
    setup.renderer.destroy();

    const onPrompt = await renderDialog({ draft: draft({ field: "prompt" }) });
    expect(onPrompt).toContain("▎Prompt");
    expect(onPrompt).not.toContain("▎Placement");
  });

  it("keeps the pills inside the border on a sidebar-width surface", async () => {
    // At a 34-column rail the full label still fits the pill; what must not
    // happen is any row running past the dialog's border.
    const frame = await renderDialog({ width: 34, height: 30 });
    const lines = frame.split("\n");
    expect(lines.filter((line) => line.includes("New window"))).toHaveLength(1);
    const widest = Math.max(...lines.map((line) => line.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(34);
    expectFrameIntegrity(frame);
  });

  it("shows the typed prompt", async () => {
    const frame = await renderDialog({
      draft: draft({ prompt: "fix the flaky test", field: "prompt" }),
    });
    expect(frame).toContain("fix the flaky test");
  });

  it("says so when the selected agent cannot take a prompt", async () => {
    const frame = await renderDialog({
      draft: draft({ agent: "pi" }),
      agents: [agent("pi", { supportsPrompt: false })],
    });
    expect(frame).toContain("can't start with a prompt");
  });

  it("shows a loading state until the agent list arrives", async () => {
    const frame = await renderDialog({ agents: null });
    expect(frame).toContain("Loading agents...");
  });

  it("reports an empty agent list instead of rendering nothing", async () => {
    const frame = await renderDialog({ agents: [] });
    expect(frame).toContain("No agents found on PATH");
    setup.renderer.destroy();

    // The daemon's error text is passed through as it comes, so an empty one
    // reaches here and must not render as a blank red row.
    const blank = await renderDialog({ agents: [], agentsError: "" });
    expect(blank).toContain("No agents found on PATH");
  });

  it("surfaces the daemon's error when the list could not be resolved", async () => {
    const frame = await renderDialog({
      agents: [],
      agentsError: "Failed to resolve agents: bad regex",
    });
    expect(frame).toContain("bad regex");
  });

  /**
   * Issue #85. The Agent field was budgeted one row for its error, so a
   * message that wrapped left the dialog that many rows short and its last
   * rows fell outside the border — at a sidebar width the third placement
   * and the whole Where field disappeared.
   */
  it("keeps every row inside the border when the agent error wraps", async () => {
    const error = "Daemon is out of date - run `ccmux daemon restart`";
    const frame = await renderDialog({
      agents: [],
      agentsError: error,
      width: 34,
      height: 30,
    });

    expectFrameIntegrity(frame);
    // The whole message survived, wherever the wrap fell.
    expect(squish(frame)).toContain(squish(error));
    // And so did every row budgeted below it, down to the last one.
    expect(frame).toContain("New window");
    expect(frame).toContain("Where");
    expect(frame).toContain("Here");
    expect(frame).toContain("Directory");
    expect(frame).toContain("enter");
  });

  /**
   * Issue #91, the reported repro: a Japanese agent error at a sidebar width.
   * Wrapped by code units every line was twice the column it claimed, the
   * renderer clipped the overflow, and the message read as garbage rather
   * than as a truncation.
   */
  it("wraps a wide-glyph agent error to the column it renders in", async () => {
    const error =
      "エージェントを解決できませんでした デーモンを再起動してください";
    const frame = await renderDialog({
      agents: [],
      agentsError: error,
      width: 34,
      height: 30,
    });

    expectFrameIntegrity(frame);
    // Every rendered row of the message is a contiguous prefix of the
    // original, in order, with nothing dropped between rows.
    const rendered = squish(frame);
    let cursor = 0;
    for (const char of squish(error)) {
      const at = rendered.indexOf(char, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at + 1;
    }
    // And the fields budgeted below the (now correctly counted) rows survive.
    expect(frame).toContain("New window");
    expect(frame).toContain("Here");
    expect(frame).toContain("Directory");
  });

  /** An error too tall for the screen cannot be shown whole; what it must
   *  not do is push the fields below it off the dialog. */
  it("caps an error taller than the screen instead of clipping the fields", async () => {
    const frame = await renderDialog({
      agents: [],
      agentsError: "spawnable agents could not be resolved ".repeat(20),
      width: 34,
      height: 22,
    });

    expectFrameIntegrity(frame);
    expect(frame).toContain("…");
    expect(frame).toContain("New window");
    expect(frame).toContain("Directory");
    expect(
      frame.split("\n").filter((l) => l.includes("│")).length,
    ).toBeLessThan(22);
  });

  it("shortens a home-relative directory", async () => {
    const home = process.env.HOME ?? "/Users/dev";
    const frame = await renderDialog({
      draft: draft({ cwd: `${home}/code/ccmux` }),
    });
    expect(frame).toContain("~/code/ccmux");
  });

  it("windows the dropdown against the screen and keeps the highlight visible", async () => {
    const many = Array.from({ length: 9 }, (_, i) => agent(`agent${i}`));
    const frame = await renderDialog({
      draft: draft({
        agent: "agent8",
        dropdown: { field: "agent" as const, index: 8 },
      }),
      agents: many,
      height: 14,
    });
    // The window slid to the tail: the highlighted agent is on screen with
    // its absolute number, and the first one has scrolled off.
    expect(frame).toContain("9 Agent8");
    expect(frame).not.toContain("1 Agent0");
  });

  it("keeps the key hints visible", async () => {
    const frame = await renderDialog({});
    expect(frame).toContain("enter");
    expect(frame).toContain("spawn");
    expect(frame).toContain("esc");
    expect(frame).toContain("cancel");
    // Focus starts on the agent field, where the hint also teaches the
    // dropdown's opener.
    expect(frame).toContain("space open");
  });

  it("offers Cancel and confirm buttons, primary rightmost, in the mode's verb", async () => {
    const spawn = await renderDialog({});
    const lines = spawn.split("\n");
    const row = lines.findIndex(
      (line) => line.includes("Spawn") && line.includes("Cancel"),
    );
    expect(row).toBeGreaterThan(0);
    // The macOS order: the quiet Cancel to the left, the primary action in
    // the rightmost position the right-aligned row leads the eye to.
    expect(lines[row]!.indexOf("Cancel")).toBeLessThan(
      lines[row]!.indexOf("Spawn"),
    );
    setup.renderer.destroy();

    // The move mode confirms in its own verb, the same word its title leads
    // with. (Only the button row carries a capitalized Cancel.)
    const move = await renderDialog({ draft: moveDraft() });
    const moveRow = move
      .split("\n")
      .find((line) => line.includes("Cancel") && /\bMove\b/.test(line));
    expect(moveRow).toBeDefined();
  });

  it("gives the buttons up at heights that can still afford the hints", async () => {
    const frame = await renderDialog({ height: 12 });
    expect(frame).not.toContain("Cancel");
    // The hint row survives: it teaches more than the buttons duplicate.
    expect(frame).toContain("esc");
  });

  it("keeps the opener hint on every option field, dropping it on text", async () => {
    // Placement is a pill now too, so the opener stays taught there...
    const onPlacement = await renderDialog({
      draft: draft({ field: "placement" }),
    });
    expect(onPlacement).toContain("space open");
    setup.renderer.destroy();

    // ...and only a text field, which owns its printable keys, drops it.
    const onPrompt = await renderDialog({ draft: draft({ field: "prompt" }) });
    expect(onPrompt).toContain("1-9 pick");
    expect(onPrompt).not.toContain("space open");
  });

  it("swaps the hint row to the dropdown's keys while it is open", async () => {
    const frame = await renderDialog({
      draft: draft({ dropdown: { field: "agent" as const, index: 0 } }),
      agents: [agent("claude"), agent("codex")],
    });
    expect(frame).toContain("enter/space");
    expect(frame).toContain("select");
    expect(frame).toContain("j/k move");
    expect(frame).toContain("esc cancel");
    // The dialog's own keys are not in effect while the overlay owns them.
    expect(frame).not.toContain("spawn");
    expect(frame).not.toContain("tab field");
  });

  it("drops its own hint row where a footer already carries one", async () => {
    // The picker's Footer switches to a near-identical line while this
    // dialog is open, so drawing both would print the hints twice.
    const frame = await renderDialog({ showKeyHints: false });
    expect(frame).not.toContain("spawn");
    expect(frame).not.toContain("cancel");
    // The fields themselves are untouched.
    expect(frame).toContain("New session");
    expect(frame).toContain("Directory");
  });

  it("shrinks by the hint row's height when it is dropped", async () => {
    const boxRows = (frame: string) =>
      frame.split("\n").filter((line) => line.includes("│")).length;
    const withHints = await renderDialog({});
    const tall = boxRows(withHints);
    setup.renderer.destroy();
    const withoutHints = await renderDialog({ showKeyHints: false });
    // The row plus its blank spacer, and no stray gap left behind.
    expect(tall - boxRows(withoutHints)).toBe(2);
  });
});

/**
 * The worktree destination (issue #69). The row is the choice alone; the name
 * it would create moved to a row of its own with issue #83, so the two are
 * checked separately below.
 */
describe("NewSessionDialog destination", () => {
  it("holds this checkout by default and offers both in its dropdown", async () => {
    const collapsed = await renderDialog({});
    expect(collapsed).toContain("Where");
    expect(collapsed).toMatch(/This checkout\s+▾/);
    expect(collapsed).not.toContain("New worktree");
    setup.renderer.destroy();

    const open = await renderDialog({
      draft: draft({ dropdown: { field: "destination" as const, index: 0 } }),
    });
    expect(open).toContain("▎ 1 This checkout");
    expect(open).toContain("2 New worktree");
  });

  /**
   * The name used to be appended here and truncated against what the row had
   * left, which is what made it unreadable at this dialog's width (#83).
   */
  it("leaves the name to its own row rather than appending it", async () => {
    await renderDialog({
      draft: draft({ destination: "worktree", prompt: "fix bug" }),
    });

    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/New worktree\s+▾/);
    expect(frame).not.toContain("New worktree: fix-bug");
    expect(frame).toContain("Name");
    expect(frame).toContain("fix-bug");
  });

  /**
   * The destination shares its label rule with Placement, so a sidebar-width
   * overlay has to keep BOTH choices readable — the same failure the
   * placements had, where two options rendered identically.
   */
  it("abbreviates the destinations in a sidebar-width overlay", async () => {
    const frame = await renderDialog({
      draft: draft({ dropdown: { field: "destination" as const, index: 0 } }),
      width: 34,
      height: 30,
    });

    // The capitalized short labels, which only the abbreviated forms carry
    // (`This checkout` / `New worktree` spell theirs differently), on rows of
    // their own rather than sharing one.
    const lines = frame.split("\n");
    const hereRow = lines.findIndex((line) => line.includes("Here"));
    const worktreeRow = lines.findIndex((line) => line.includes("Worktree"));
    expect(hereRow).toBeGreaterThanOrEqual(0);
    expect(worktreeRow).toBeGreaterThanOrEqual(0);
    expect(worktreeRow).not.toBe(hereRow);
    const widest = Math.max(...lines.map((line) => line.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(34);
  });

  // The dialog grows a row per field; the height is derived from the field
  // list so a new one cannot silently clip the row below it.
  it("keeps the directory row visible with the destination row present", async () => {
    await renderDialog({ draft: draft({ destination: "worktree" }) });

    expect(setup.captureCharFrame()).toContain("Directory");
  });
});

/**
 * The worktree name (issue #83): shown in full on a row of its own, and
 * editable, rather than previewed as a truncated suffix on the row above.
 */
describe("NewSessionDialog worktree name", () => {
  /** The row a label owns, or -1. */
  const rowOf = (frame: string, text: string) =>
    frame.split("\n").findIndex((line) => line.includes(text));

  /**
   * The name row, asserted to have stayed inside the dialog's border.
   *
   * Row-scoped rather than `expectFrameIntegrity`, which the narrow cases
   * cannot use: an input scrolled to its cursor draws past its own box, so a
   * long PROMPT already breaks the border at a sidebar width whether or not
   * this row exists. That is the input's behaviour and predates this field;
   * what belongs to this row is that a derived name is budgeted to fit.
   */
  const nameRow = (frame: string): string => {
    const line = frame.split("\n").find((l) => l.includes("Name"))!;
    expect(line.trimEnd().endsWith("│")).toBe(true);
    return line;
  };

  it("shows the derived name on a row of its own, under the destination", async () => {
    const frame = await renderDialog({
      draft: draft({
        destination: "worktree",
        prompt: "fix sidebar flicker on resize",
      }),
    });

    // In full: the whole point of the row is that nothing was cut.
    expect(frame).toContain("fix-sidebar-flicker");
    expect(rowOf(frame, "Name")).toBeGreaterThan(rowOf(frame, "Where"));
    expect(rowOf(frame, "Name")).toBeLessThan(rowOf(frame, "Directory"));
    expectFrameIntegrity(frame);
  });

  it("has no name row when the session starts in this checkout", async () => {
    const frame = await renderDialog({ draft: draft({ destination: "here" }) });

    // Nothing is being named, so a field for the name would be a row that
    // refuses every key.
    expect(rowOf(frame, "Name")).toBe(-1);
    expect(frame).not.toContain("auto");
  });

  /**
   * Below the name's own width there is no truncation that keeps everything,
   * so the cut goes in the middle: `fix-sidebar-…` loses exactly the words
   * that tell two "fix sidebar" tasks apart, and both are shown here.
   */
  it("keeps both ends readable when the name outgrows the row", async () => {
    const frame = await renderDialog({
      draft: draft({
        destination: "worktree",
        prompt: "fix sidebar flicker on resize",
      }),
      width: 34,
      height: 30,
    });

    expect(nameRow(frame)).toContain("fix-si…icker");
  });

  it("says a derived name may come back numbered", async () => {
    const frame = await renderDialog({
      draft: draft({ destination: "worktree", prompt: "fix bug" }),
    });

    // The name is a preview of a rule, not a reservation; the daemon numbers
    // a derived name that collides rather than joining the worktree there.
    expect(frame).toContain("auto · -2 if taken");
  });

  it("drops the hint before the name it is about", async () => {
    const frame = await renderDialog({
      draft: draft({
        destination: "worktree",
        // Long enough that the hint and the name cannot share the row.
        prompt: "fix the flickering sidebar",
      }),
      width: 34,
      height: 30,
    });

    // The name keeps the row; the caveat about it is what goes.
    expect(nameRow(frame)).toContain("fix-th…ering");
    expect(frame).not.toContain("auto");
  });

  it("shows a typed name instead of the derived one, with no hint", async () => {
    const frame = await renderDialog({
      draft: draft({
        destination: "worktree",
        prompt: "fix bug",
        worktreeName: "review-handback",
      }),
    });

    expect(frame).toContain("review-handback");
    // The prompt no longer names anything, and the suffix caveat is about
    // derived names only: an explicit one is taken as written.
    expect(frame).not.toContain("fix-bug");
    expect(frame).not.toContain("auto");
  });

  it("names both ways out when there is nothing to derive from", async () => {
    const frame = await renderDialog({
      draft: draft({ destination: "worktree" }),
    });

    expect(frame).toContain("Type a prompt, or a name here");
    expectFrameIntegrity(frame);
  });

  /** A CJK-only prompt derives nothing, exactly like an empty one. */
  it("asks again when the prompt derives no slug at all", async () => {
    const frame = await renderDialog({
      draft: draft({ destination: "worktree", prompt: "修复侧边栏" }),
    });

    expect(frame).toContain("Type a prompt, or a name here");
  });

  it("shows the focus marker on the name field", async () => {
    const frame = await renderDialog({
      draft: draft({ destination: "worktree", field: "worktreeName" }),
    });

    const row = frame
      .split("\n")
      .find((line) => line.includes("Name"))
      ?.trimEnd();
    expect(row).toContain("▎Name");
  });

  /**
   * The name is a field, so it is a row the height has to have budgeted. A
   * shortfall does not clip the bottom row, it draws two rows over each
   * other, so the order is what catches it.
   */
  it("keeps every row inside the border with the name row present", async () => {
    const frame = await renderDialog({
      draft: draft({ destination: "worktree", prompt: "fix bug" }),
      showKeyHints: true,
    });

    expectFrameIntegrity(frame);
    const order = [
      "Agent",
      "Placement",
      "Prompt",
      "Where",
      "Name",
      "Directory",
      "esc",
      "└",
    ];
    let previous = -1;
    for (const text of order) {
      const row = rowOf(frame, text);
      expect([text, row]).toEqual([text, expect.any(Number)]);
      expect(row).toBeGreaterThan(previous);
      previous = row;
    }
  });
});

/**
 * Move-changes mode (issue #71): the same dialog, opened to relocate a
 * checkout's uncommitted work rather than to start fresh in it.
 */
describe("NewSessionDialog move-changes mode", () => {
  it("says what it is doing in the title", async () => {
    const frame = await renderDialog({ draft: moveDraft() });

    expect(frame).toContain("Move changes to worktree");
    expect(frame).not.toContain("New session");
  });

  it("says the changes leave the checkout it names", async () => {
    const frame = await renderDialog({ draft: moveDraft() });

    // The two rows have to be read together: the note is only meaningful
    // because the directory it applies to is directly above it.
    expect(frame).toContain("Directory");
    expect(frame).toContain("Changes");
    expect(frame).toContain("Moved out of this checkout");
  });

  it("locks the destination to a worktree, with no second choice offered", async () => {
    const frame = await renderDialog({
      draft: moveDraft({ prompt: "fix bug" }),
    });

    expect(frame).toContain("Where");
    expect(frame).toContain("New worktree");
    // No numbered options and no "This checkout": the row is a statement,
    // not a choice, so nothing on it invites a keypress that would be refused.
    expect(frame).not.toContain("This checkout");
    expect(frame).not.toContain("[New worktree");
  });

  /**
   * The destination is locked but the NAME is not, which is why the move goes
   * through the dialog at all rather than happening on the click. It is the
   * same field the ordinary worktree destination gets: one implementation,
   * reached from two places.
   */
  it("keeps the name editable under the locked destination", async () => {
    const frame = await renderDialog({
      draft: moveDraft({ prompt: "fix bug" }),
    });

    const lines = frame.split("\n");
    const nameRow = lines.findIndex((line) => line.includes("Name"));
    expect(nameRow).toBeGreaterThan(
      lines.findIndex((line) => line.includes("Where")),
    );
    expect(lines[nameRow]).toContain("fix-bug");
  });

  it("names both ways out when a move has nothing to derive from", async () => {
    const frame = await renderDialog({ draft: moveDraft() });

    expect(frame).toContain("Type a prompt, or a name here");
  });

  it("holds the untracked default and offers the rest in its dropdown", async () => {
    const collapsed = await renderDialog({ draft: moveDraft() });
    expect(collapsed).toContain("Untracked");
    expect(collapsed).toMatch(/Move\s+▾/);
    expect(collapsed).not.toContain("Copy to both");
    setup.renderer.destroy();

    const open = await renderDialog({
      draft: moveDraft({
        dropdown: { field: "untracked" as const, index: 0 },
      }),
    });
    expect(open).toContain("▎ 1 Move");
    expect(open).toContain("2 Copy to both");
    expect(open).toContain("3 Leave here");
  });

  it("marks the selected untracked mode in its dropdown", async () => {
    const frame = await renderDialog({
      draft: moveDraft({
        untracked: "leave",
        dropdown: { field: "untracked" as const, index: 2 },
      }),
    });

    expect(frame).toMatch(/Leave here\s+▾/);
    expect(frame).toContain("▎ 3 Leave here");
    expect(frame).not.toContain("▎ 1 Move");
  });

  it("hides the untracked field outside move-changes mode", async () => {
    const frame = await renderDialog({ draft: draft() });

    expect(frame).not.toContain("Untracked");
    expect(frame).not.toContain("Leave here");
  });

  it("shows the focus marker on the untracked field", async () => {
    const frame = await renderDialog({
      draft: moveDraft({ field: "untracked" }),
    });

    // The number keys are scoped to the focused field, so the marker is what
    // says which field `1`/`2`/`3` will act on.
    const row = frame
      .split("\n")
      .find((line) => line.includes("Untracked"))
      ?.trimEnd();
    expect(row).toContain("▎Untracked");
  });

  /**
   * The height is summed from the field list plus the chrome, and this mode
   * adds two rows the ordinary dialog has not got. Getting it wrong clips the
   * bottom rows outside the border rather than failing to compile.
   */
  it("keeps every row inside the border, including the last", async () => {
    const frame = await renderDialog({
      draft: moveDraft(),
      showKeyHints: true,
    });

    expectFrameIntegrity(frame);
    const lines = frame.split("\n");
    const rowOf = (text: string) =>
      lines.findIndex((line) => line.includes(text));
    // Every row, in order, each on a line of its own. A height that
    // under-counts by even one does not clip the bottom row — it renders two
    // rows over each other ("Promptent fixNbugwindow]"), which destroys the
    // labels rather than the border, so the ordering chain is what catches it.
    const order = [
      "Agent",
      "Placement",
      "Prompt",
      "Where",
      "Name",
      "Untracked",
      "Directory",
      "Moved out of this checkout",
      // Last, and the row a shortfall eats first when the content does fit:
      // losing it takes both of the dialog's exits off the screen.
      "esc",
      "└",
    ];
    let previous = -1;
    for (const text of order) {
      const row = rowOf(text);
      expect([text, row]).toEqual([text, expect.any(Number)]);
      expect(row).toBeGreaterThan(previous);
      previous = row;
    }
  });

  it("stays inside its border on a sidebar-width surface", async () => {
    const frame = await renderDialog({
      draft: moveDraft({ prompt: "fix bug" }),
      width: 34,
      height: 30,
      showKeyHints: true,
    });

    expectFrameIntegrity(frame);
    expect(frame).toMatch(/Move\s+▾/);
    const lines = frame.split("\n");
    const widest = Math.max(...lines.map((line) => line.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(34);
  });

  it("keeps the untracked choices distinguishable in a rail-width overlay", async () => {
    // Each choice on a row of its own, with the abbreviated labels where the
    // full ones would not fit the overlay's columns.
    const frame = await renderDialog({
      draft: moveDraft({
        dropdown: { field: "untracked" as const, index: 0 },
      }),
      width: 34,
      height: 30,
    });

    const lines = frame.split("\n");
    const rowOf = (text: string) =>
      lines.findIndex((line) => line.includes(text));
    expect(rowOf("Move")).toBeGreaterThanOrEqual(0);
    expect(rowOf("Copy")).toBeGreaterThan(rowOf("Move"));
    expect(rowOf("Leave")).toBeGreaterThan(rowOf("Copy"));
    const widest = Math.max(...lines.map((line) => line.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(34);
  });

  /**
   * The mode's floor is twelve rows in the picker and eighteen stacked in the
   * sidebar, and a terminal shorter than that is not hypothetical (a split
   * pane, a laptop with a browser open). Nothing clips here: the box is
   * clamped to the screen while its children are not, so the rows past the
   * clamp draw straight over the ones above them, and the bottom border goes
   * off the screen entirely.
   */
  describe("under height pressure", () => {
    /** Every listed row exists, on its own line, in this order. */
    function expectRowOrder(frame: string, order: string[]) {
      const lines = frame.split("\n");
      let previous = -1;
      for (const text of order) {
        const row = lines.findIndex((line) => line.includes(text));
        expect([text, row]).not.toEqual([text, -1]);
        expect([text, row]).toEqual([text, expect.any(Number)]);
        expect(row).toBeGreaterThan(previous);
        previous = row;
      }
    }

    it("keeps every interactive row legible in an 11-row picker", async () => {
      const frame = await renderDialog({
        draft: moveDraft(),
        width: 60,
        height: 11,
        showKeyHints: false,
      });

      // The fields, in order, each on a line of its own — and a border to
      // close the dialog. What gives way under the pressure is the move note,
      // not a row the user has to act on.
      expectRowOrder(frame, [
        "Agent",
        "Placement",
        "Prompt",
        "Where",
        "Name",
        "Untracked",
        "Directory",
        "└",
      ]);
      expectFrameIntegrity(frame);
    });

    it("keeps every interactive row legible in a 16-row sidebar", async () => {
      // Stacked: each option gets a row of its own, which is what makes the
      // mode eighteen rows tall at this width.
      const frame = await renderDialog({
        draft: moveDraft(),
        width: 30,
        height: 16,
        showKeyHints: true,
      });

      expectRowOrder(frame, [
        "Agent",
        "Placement",
        "Prompt",
        "Where",
        "Name",
        "Untracked",
        "Directory",
        "└",
      ]);
      expectFrameIntegrity(frame);
    });

    it("says what it needs when even the fields will not fit", async () => {
      // Six rows cannot hold a six-field dialog. Drawing it anyway puts rows
      // over each other and the border off screen; this says so in one row
      // and leaves enter/esc working.
      const frame = await renderDialog({
        draft: moveDraft(),
        width: 60,
        height: 6,
        showKeyHints: false,
      });

      expect(frame).toContain("Needs 9 rows");
      expectFrameIntegrity(frame, 3);
    });

    it("windows an overlay taller than the screen, keeping the highlight", async () => {
      // The last field's dropdown opens with almost no rows below it: the
      // overlay windows itself against the screen and scrolls to the
      // highlight rather than drawing off the bottom.
      const frame = await renderDialog({
        draft: moveDraft({
          untracked: "leave",
          dropdown: { field: "untracked" as const, index: 2 },
        }),
        width: 30,
        height: 17,
        showKeyHints: true,
      });

      // The highlighted choice is on screen with its absolute number (the
      // pill above it repeats the label, so the number is the anchor). The
      // rail width leaves the overlay the short labels.
      expect(frame).toContain("3 Leave");
    });
  });

  it("keeps the agent list from overflowing the taller dialog", async () => {
    // The agent list sizes itself against whatever the other rows and the
    // chrome have left, so the mode's extra rows have to shrink it rather
    // than push the dialog past the screen.
    const frame = await renderDialog({
      draft: moveDraft(),
      agents: Array.from({ length: 12 }, (_, i) => agent(`agent${i}`)),
      height: 16,
    });

    expectFrameIntegrity(frame);
    expect(squish(frame)).toContain("Movedoutofthischeckout");
  });
});

/**
 * Fork mode (issue #70): the same dialog, opened over a SESSION to continue
 * it. The agent and the conversation come from the source, so what is left to
 * choose is where the pane goes, whether the fork continues in the source's
 * checkout or in a worktree of its own, and what that worktree is called.
 */
describe("NewSessionDialog fork mode", () => {
  const FORK = {
    sessionId: "s1",
    label: "Claude · feat/parking",
    branch: "feat/parking",
    canWorktree: true,
    pane: "%5",
  };

  /** The worktree destination, which is the one with a name to show. The
   *  in-place default is `forkHereDraft` below. */
  const forkDraft = (
    overrides: Partial<NewSessionDraft> = {},
  ): NewSessionDraft =>
    draft({
      destination: "worktree",
      field: "placement",
      fork: FORK,
      ...overrides,
    });

  /** How the dialog actually opens: continuing in the source's own checkout,
   *  which is the old one-shot `F` with a dialog in front of it. */
  const forkHereDraft = (
    overrides: Partial<NewSessionDraft> = {},
  ): NewSessionDraft =>
    forkDraft({ destination: "here", placement: "split-h", ...overrides });

  /** The Where row, whichever form it takes. */
  const whereRow = (frame: string) =>
    frame.split("\n").find((line) => line.includes("Where"));

  it("confirms with Fork on its button", async () => {
    const frame = await renderDialog({ draft: forkDraft() });
    // Only the button row carries a capitalized Cancel; its confirm twin
    // speaks this mode's verb.
    const row = frame.split("\n").find((line) => line.includes("Cancel"));
    expect(row).toBeDefined();
    expect(row).toContain("Fork");
  });

  it("says what it is doing, and names what it is forking", async () => {
    const frame = await renderDialog({ draft: forkDraft() });

    // The title names the MODE, not the destination: the destination is a row
    // of its own now, and a title that contradicted it would be worse than one
    // that says less.
    expect(frame).toContain("Fork session");
    expect(frame).not.toContain("New session");
    // The source row, read together with the Directory above it: between them
    // they say which conversation is being continued and from where.
    expect(frame).toContain("Source");
    expect(frame).toContain("Claude · feat/parking");
    expect(frame).toContain("/Users/dev/code/ccmux");
  });

  it("drops the agent and prompt rows", async () => {
    const frame = await renderDialog({
      draft: forkDraft(),
      agents: [agent("claude"), agent("codex")],
    });

    // Neither is a choice a fork has: the agent is the source's, and the
    // conversation continues rather than starting from a first message.
    expect(frame).not.toContain("Agent");
    expect(frame).not.toContain("Prompt");
    expect(frame).not.toContain("Codex");
    // What is left is still there.
    expect(frame).toContain("Placement");
    expect(frame).toContain("Name");
  });

  it("offers the destination as a choice, and no untracked one", async () => {
    const frame = await renderDialog({ draft: forkDraft() });

    // A real dropdown, not the locked restatement a move gets: `▾` is what
    // says the row has a list behind it.
    expect(whereRow(frame)).toContain("New worktree");
    expect(whereRow(frame)).toContain("▾");
    // Moving changes out from under a session that is still running in the
    // checkout is refused by the daemon; the mode never offers it.
    expect(frame).not.toContain("Untracked");
  });

  it("opens on the source's own checkout, with nothing to name", async () => {
    const frame = await renderDialog({ draft: forkHereDraft() });

    expect(whereRow(frame)).toContain("This checkout");
    expect(whereRow(frame)).toContain("▾");
    // No worktree is being made, so there is nothing to call one.
    expect(frame).not.toContain("Name");
    expectFrameIntegrity(frame);
  });

  it("locks the destination for a source outside a repository", async () => {
    // Drawn like Directory rather than as a field: there is no repository for
    // a linked checkout to hang off, so the choice would only ever be refused.
    const frame = await renderDialog({
      draft: forkHereDraft({ fork: { ...FORK, canWorktree: false } }),
    });

    expect(whereRow(frame)).toContain("This checkout");
    expect(whereRow(frame)).not.toContain("▾");
    expect(frame).not.toContain("New worktree");
    expectFrameIntegrity(frame);
  });

  it("previews the name the daemon will derive from the source branch", async () => {
    const frame = await renderDialog({ draft: forkDraft() });

    const nameRow = frame.split("\n").find((line) => line.includes("Name"));
    expect(nameRow).toContain("feat-parking-fork");
    // The same caveat every derived name carries: this is a rule's preview,
    // and a second fork of the branch gets numbered rather than joining.
    expect(nameRow).toContain("auto");
  });

  it("stands on the hint alone when the branch never reached the client", async () => {
    // `gitBranch` is null on a row the daemon has not resolved one for. The
    // daemon still derives a name (it reads the checkout's own HEAD), so the
    // row must not imply that leaving the field empty leaves it unnamed.
    const frame = await renderDialog({
      draft: forkDraft({
        fork: { ...FORK, label: "Claude", branch: null },
      }),
    });

    const nameRow = frame.split("\n").find((line) => line.includes("Name"));
    expect(nameRow).toContain("auto");
    expect(nameRow).toContain("Named after the source branch");
    // And no invented preview: with no branch to apply the rule to there is
    // no name this row can honestly show.
    expect(nameRow).not.toContain("-fork");
    // And nothing about a prompt, which this mode does not have.
    expect(frame).not.toContain("Type a prompt");
  });

  /** The Name row of a fork whose branch never reached the client, at a
   *  given terminal width. The no-slug path: nothing to preview, so the row
   *  is the sentence saying where the name comes from plus its caveat. */
  const branchlessNameRow = async (width: number) => {
    const frame = await renderDialog({
      draft: forkDraft({
        fork: { ...FORK, label: "Claude", branch: null },
      }),
      width,
    });
    const row = frame.split("\n").find((line) => line.includes("Name"));
    expect(row).toBeDefined();
    return row!;
  };

  /*
   * The module's rule for this row is that the name is given the whole row
   * first and the hint takes the leftovers. On the derived-slug path it
   * always held; on the no-slug path the hint was budgeted FIRST, so an
   * 18-column caveat survived intact while the sentence it was a caveat
   * ABOUT got cut down to a character or two.
   */
  it("keeps the whole sentence beside its hint on a wide surface", async () => {
    const row = await branchlessNameRow(60);
    expect(row).toContain("Named after the source branch");
    expect(row).toContain("auto");
  });

  it("keeps the short form whole at a middling width", async () => {
    const row = await branchlessNameRow(50);
    expect(row).toContain("Source branch");
    expect(row).toContain("auto");
  });

  it("keeps the short form whole at a narrow width", async () => {
    // The width the inversion was worst at: the placeholder was one column.
    const row = await branchlessNameRow(40);
    expect(row).toContain("Source branch");
    // The hint still survives in some form, since it is the only thing that
    // says the field can be left alone.
    expect(row).toContain("auto");
  });

  /** A branch with a name, but not one a directory can be called: nothing in
   *  it survives slugifying, so `<branch>-fork` derives to "". */
  const unslugifiableFork = {
    ...FORK,
    label: "Claude · 機能/検索",
    branch: "機能/検索",
  };

  it("asks for a name when the source branch slugifies to nothing", async () => {
    // The daemon refuses this fork rather than inventing a name for it, and
    // says to type one in this row. A row promising `auto` walks the user
    // into that refusal by doing exactly what it suggested.
    const frame = await renderDialog({
      draft: forkDraft({ fork: unslugifiableFork }),
    });

    const nameRow = frame.split("\n").find((line) => line.includes("Name"));
    expect(nameRow).toContain("Type a name");
    // Neither promise survives: there is no automatic name to caveat, and
    // none is coming from the source branch either.
    expect(nameRow).not.toContain("auto");
    expect(nameRow).not.toContain("Named after the source branch");
  });

  it("still takes a typed name for an unslugifiable source branch", async () => {
    const frame = await renderDialog({
      draft: forkDraft({ fork: unslugifiableFork, worktreeName: "search" }),
    });

    const nameRow = frame.split("\n").find((line) => line.includes("Name"));
    expect(nameRow).toContain("search");
    expect(nameRow).not.toContain("Type a name");
  });

  it("shows a typed name instead of the derived preview", async () => {
    const frame = await renderDialog({
      draft: forkDraft({ worktreeName: "parking-retry" }),
    });

    const nameRow = frame.split("\n").find((line) => line.includes("Name"));
    expect(nameRow).toContain("parking-retry");
    expect(nameRow).not.toContain("feat-parking-fork");
  });

  it("keeps every row inside the border, in order", async () => {
    const frame = await renderDialog({
      draft: forkDraft(),
      showKeyHints: true,
    });

    expectFrameIntegrity(frame);
    const lines = frame.split("\n");
    const rowOf = (text: string) =>
      lines.findIndex((line) => line.includes(text));
    // A height that under-counts does not clip: it draws two rows over each
    // other, so the ordering chain is what catches it.
    const order = [
      "Fork session",
      "Placement",
      "Where",
      "Name",
      "Directory",
      "Source",
      "esc",
      "└",
    ];
    let previous = -1;
    for (const text of order) {
      const row = rowOf(text);
      expect([text, row]).toEqual([text, expect.any(Number)]);
      expect(row).toBeGreaterThan(previous);
      previous = row;
    }
  });

  it("stays inside its border on a sidebar-width surface", async () => {
    const frame = await renderDialog({
      draft: forkDraft(),
      width: 34,
      height: 30,
      showKeyHints: true,
    });

    expectFrameIntegrity(frame);
    const lines = frame.split("\n");
    const widest = Math.max(...lines.map((line) => line.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(34);
  });

  it("fits in a terminal too short for any other mode", async () => {
    // Two fewer field rows than a worktree spawn (5 to 3, so a floor of 6
    // rather than 8) and three fewer than a move — and the budget has to know
    // that, or the mode reports a floor it already clears.
    expect(
      newSessionFloorRows({
        moveChanges: false,
        namesAWorktree: true,
        fork: true,
        existingWorktree: false,
      }),
    ).toBe(6);

    const frame = await renderDialog({
      draft: forkDraft(),
      width: 60,
      height: 6,
      showKeyHints: false,
    });

    expectFrameIntegrity(frame);
    expect(frame).not.toContain("Needs");
    expect(frame).toContain("Name");
  });

  it("gives up the name row's height with the name row", async () => {
    // The shortest mode there is: a fork staying in the source's checkout has
    // two fields and nothing to name. A floor that still counted the Name row
    // would report five rows it does not need — and a floor SHORT of what is
    // drawn is worse, since the extra row lands on its neighbour instead of
    // clipping.
    expect(
      newSessionFloorRows({
        moveChanges: false,
        namesAWorktree: false,
        fork: true,
        existingWorktree: false,
      }),
    ).toBe(5);

    const frame = await renderDialog({
      draft: forkHereDraft(),
      width: 60,
      height: 5,
      showKeyHints: false,
    });

    expectFrameIntegrity(frame);
    expect(frame).not.toContain("Needs");
    expect(frame).toContain("Where");
  });
});

/**
 * Existing-worktree mode (issue #102): the same dialog, opened from the
 * Worktrees panel over a checkout that is already on disk. An ordinary spawn
 * whose directory has already been chosen, so every row about creating a
 * worktree is gone and a note names the one being started in.
 */
describe("NewSessionDialog existing worktree mode", () => {
  const PATH = "/Users/dev/code/ccmux/.claude/worktrees/worktree-panel";

  const existingDraft = (
    overrides: Partial<NewSessionDraft> = {},
  ): NewSessionDraft =>
    draft({ cwd: PATH, existingWorktree: PATH, ...overrides });

  it("says what it is doing, and names the worktree", async () => {
    const frame = await renderDialog({ draft: existingDraft() });

    expect(frame).toContain("New session in worktree");
    // The note carries the worktree's own name; the Directory row above it
    // carries the path it sits at.
    expect(frame).toContain("Worktree");
    expect(frame).toContain("worktree-panel");
  });

  it("drops every row about creating a worktree", async () => {
    const frame = await renderDialog({
      draft: existingDraft(),
      agents: [agent("claude"), agent("codex")],
    });

    // The panel row IS the destination, nothing is being made to name, and
    // untracked files belong to a move.
    expect(frame).not.toContain("Where");
    expect(frame).not.toContain("This checkout");
    expect(frame).not.toContain("New worktree");
    expect(frame).not.toContain("Name");
    expect(frame).not.toContain("Untracked");
    // What an ordinary spawn chooses is all still there.
    expect(frame).toContain("Agent");
    expect(frame).toContain("Placement");
    expect(frame).toContain("Prompt");
  });

  it("confirms with Spawn, like any other new session", async () => {
    const frame = await renderDialog({ draft: existingDraft() });
    const row = frame.split("\n").find((line) => line.includes("Cancel"));
    expect(row).toContain("Spawn");
  });

  it("keeps every row inside the border, in order", async () => {
    const frame = await renderDialog({
      draft: existingDraft(),
      showKeyHints: true,
    });

    expectFrameIntegrity(frame);
    const lines = frame.split("\n");
    const rowOf = (text: string) =>
      lines.findIndex((line) => line.includes(text));
    // A height that under-counts does not clip: it draws two rows over each
    // other, so the ordering chain is what catches it.
    const order = [
      "New session in worktree",
      "Agent",
      "Placement",
      "Prompt",
      "Directory",
      "Worktree",
      "esc",
      "└",
    ];
    let previous = -1;
    for (const text of order) {
      const row = rowOf(text);
      expect([text, row]).toEqual([text, expect.any(Number)]);
      expect(row).toBeGreaterThan(previous);
      previous = row;
    }
  });

  it("stays inside its border on a sidebar-width surface", async () => {
    const frame = await renderDialog({
      draft: existingDraft(),
      width: 34,
      height: 30,
      showKeyHints: true,
    });

    expectFrameIntegrity(frame);
    const lines = frame.split("\n");
    const widest = Math.max(...lines.map((line) => line.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(34);
  });

  it("fits in a terminal one row shorter than an ordinary spawn needs", async () => {
    // One field row fewer than a spawn that still has a Where row to offer,
    // and the budget has to know it or the mode reports a floor it clears.
    const frame = await renderDialog({
      draft: existingDraft(),
      width: 60,
      height: 6,
      showKeyHints: false,
    });

    expectFrameIntegrity(frame);
    expect(frame).not.toContain("Needs");
    expect(frame).toContain("Prompt");
  });
});
