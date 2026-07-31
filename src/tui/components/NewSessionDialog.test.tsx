import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import {
  NewSessionDialog,
  newSessionFloorRows,
  optionWindow,
  planDialogRows,
  wrapText,
} from "./NewSessionDialog";
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
  field: "agent",
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
        onSelectAgent={() => {}}
        onSelectPlacement={() => {}}
        onSelectDestination={() => {}}
        onSelectUntracked={() => {}}
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
  /** The move-changes dialog on a sidebar rail: the tallest shape there is. */
  const stackedMove = {
    moveChanges: true,
    namesAWorktree: true,
    agentRows: 1,
    stacked: true,
    keyHints: true,
  };

  it("spends everything it has when the rows are there", () => {
    const plan = planDialogRows(stackedMove, 40);
    expect(plan.tooShort).toBe(false);
    expect(plan.showKeyHints).toBe(true);
    expect(plan.showMoveNote).toBe(true);
    expect(plan.showDirectory).toBe(true);
    expect(plan.untrackedRows).toBe(3);
    // Nothing is padded out to fill the screen: the dialog is its content.
    expect(plan.height).toBe(18);
  });

  it("gives up rows in an order that keeps the actionable ones", () => {
    // Each step is the same dialog one row shorter, so the sequence IS the
    // priority list: hints, then the move note, then the blank under the
    // title, then the stacked options collapse, then the directory.
    const given = (height: number) => {
      const plan = planDialogRows(stackedMove, height);
      return {
        hints: plan.showKeyHints,
        note: plan.showMoveNote,
        spacer: plan.showTitleSpacer,
        untracked: plan.untrackedRows,
        placement: plan.placementRows,
        directory: plan.showDirectory,
        tooShort: plan.tooShort,
      };
    };
    expect(given(16).hints).toBe(false);
    expect(given(16).note).toBe(true);
    expect(given(15).note).toBe(false);
    expect(given(14).spacer).toBe(false);
    // Now the options, bottom-up, and never below one row each.
    expect(given(13).untracked).toBe(2);
    expect(given(12).untracked).toBe(1);
    expect(given(11).placement).toBe(2);
    expect(given(10).placement).toBe(1);
    expect(given(10).directory).toBe(true);
    // The last thing to go, because in this mode it names the checkout being
    // emptied.
    expect(given(9).directory).toBe(false);
    expect(given(9).tooShort).toBe(false);
  });

  it("shrinks the agent list before anything else", () => {
    // It is the only field whose natural size is somebody else's list, and
    // it already scrolls, so it gives up rows without losing anything.
    const plan = planDialogRows({ ...stackedMove, agentRows: 9 }, 20);
    expect(plan.agentRows).toBeLessThan(9);
    expect(plan.showKeyHints).toBe(true);
    expect(plan.showMoveNote).toBe(true);
  });

  it("refuses to draw a dialog shorter than its own fields", () => {
    expect(planDialogRows(stackedMove, 8).tooShort).toBe(true);
    expect(planDialogRows(stackedMove, 8).height).toBe(3);
    // An ordinary spawn into this checkout has two fewer rows to find.
    const plain = {
      moveChanges: false,
      namesAWorktree: false,
      agentRows: 1,
      stacked: false,
      keyHints: false,
    };
    expect(newSessionFloorRows(plain)).toBe(7);
    expect(planDialogRows(plain, 7).tooShort).toBe(false);
    expect(planDialogRows(plain, 6).tooShort).toBe(true);
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

  it("numbers the agents so the number keys are discoverable", async () => {
    const frame = await renderDialog({
      agents: [agent("claude"), agent("codex"), agent("pi")],
    });
    expect(frame).toContain("1 Claude");
    expect(frame).toContain("2 Codex");
    expect(frame).toContain("3 Pi");
  });

  it("marks the drafted agent as selected", async () => {
    const frame = await renderDialog({
      draft: draft({ agent: "codex" }),
      agents: [agent("claude"), agent("codex")],
    });
    expect(frame).toContain("> 2 Codex");
    expect(frame).not.toContain("> 1 Claude");
  });

  it("offers all three placements and brackets the chosen one", async () => {
    const frame = await renderDialog({
      draft: draft({ placement: "split-h" }),
    });
    expect(frame).toContain("New window");
    expect(frame).toContain("[Split right]");
    expect(frame).toContain("Split down");
    expect(frame).not.toContain("[New window]");
  });

  it("abbreviates the placements when the row is short of room", async () => {
    const frame = await renderDialog({ width: 60 });
    expect(frame).toContain("[Window]");
    expect(frame).toContain("Right");
    expect(frame).toContain("Down");
    expect(frame).not.toContain("Split right");
  });

  it("keeps the placements distinguishable at the real sidebar rail", async () => {
    // A 30-column rail leaves 8 columns for the label, which truncated
    // `New window`/`Split right`/`Split down` to `New`/`Split`/`Split` —
    // two of three indistinguishable, with number keys that still worked.
    const frame = await renderDialog({ width: 30, height: 30 });
    expect(frame).toContain("Window");
    expect(frame).toContain("Right");
    expect(frame).toContain("Down");
    const lines = frame.split("\n");
    expect(lines.filter((l) => l.includes("Split")).length).toBe(0);
    // And nothing runs past the dialog's own border.
    const widest = Math.max(...lines.map((l) => l.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(30);
  });

  it("marks the focused field without relying on colour", async () => {
    // The number keys are scoped to the focused field, so which field has
    // focus has to survive a colourless terminal.
    const onAgent = await renderDialog({ draft: draft({ field: "agent" }) });
    expect(onAgent).toContain(">Agent");
    expect(onAgent).not.toContain(">Placement");
    setup.renderer.destroy();

    const onPlacement = await renderDialog({
      draft: draft({ field: "placement" }),
    });
    expect(onPlacement).toContain(">Placement");
    expect(onPlacement).not.toContain(">Agent");
    setup.renderer.destroy();

    const onPrompt = await renderDialog({ draft: draft({ field: "prompt" }) });
    expect(onPrompt).toContain(">Prompt");
    expect(onPrompt).not.toContain(">Placement");
  });

  it("stacks the placements on a sidebar-width surface", async () => {
    // At a 34-column rail the row cannot hold three options at any label
    // length, and clipping would hide two of the three choices.
    const frame = await renderDialog({ width: 34, height: 30 });
    const lines = frame.split("\n");
    const placement = lines.filter((line) => line.includes("New window"));
    expect(placement).toHaveLength(1);
    expect(placement[0]).toContain("[New window]");
    expect(lines.some((line) => line.includes("Split right"))).toBe(true);
    expect(lines.some((line) => line.includes("Split down"))).toBe(true);
    // Nothing runs past the dialog's own border.
    const widest = Math.max(...lines.map((line) => line.trimEnd().length));
    expect(widest).toBeLessThanOrEqual(34);
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
    expect(frame).toContain("Split right");
    expect(frame).toContain("Split down");
    expect(frame).toContain("Where");
    expect(frame).toContain("Here");
    expect(frame).toContain("Worktree");
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
    expect(frame).toContain("Split down");
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
    expect(frame).toContain("Split down");
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

  it("scrolls a long agent list to keep the selection visible", async () => {
    const many = Array.from({ length: 9 }, (_, i) => agent(`agent${i}`));
    const frame = await renderDialog({
      draft: draft({ agent: "agent8" }),
      agents: many,
      height: 14,
    });
    // The window slid to the tail: the last agent is on screen with its
    // absolute number, and the first one has scrolled off.
    expect(frame).toContain("9 Agent8");
    expect(frame).not.toContain("1 Agent0");
  });

  it("keeps the key hints visible", async () => {
    const frame = await renderDialog({});
    expect(frame).toContain("enter");
    expect(frame).toContain("spawn");
    expect(frame).toContain("esc");
    expect(frame).toContain("cancel");
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
  it("offers both destinations, with this checkout selected by default", async () => {
    await renderDialog({});

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Where");
    expect(frame).toContain("[This checkout]");
    expect(frame).toContain("New worktree");
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
    expect(frame).toContain("[New worktree]");
    expect(frame).not.toContain("New worktree: fix-bug");
    expect(frame).toContain("Name");
    expect(frame).toContain("fix-bug");
  });

  /**
   * The destination shares its label rule with Placement, so a sidebar-width
   * surface has to keep BOTH choices readable and on their own rows — the
   * same failure the placements had, where two options rendered identically.
   */
  it("stacks and abbreviates the destinations on a sidebar-width surface", async () => {
    const frame = await renderDialog({ width: 34, height: 30 });

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

    expect(nameRow(frame)).toContain("fix-sid…flicker");
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
    expect(nameRow(frame)).toContain("fix-the…ckering");
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
    expect(row).toContain(">Name");
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

  it("offers the untracked choices, moving them by default", async () => {
    const frame = await renderDialog({ draft: moveDraft() });

    expect(frame).toContain("Untracked");
    expect(frame).toContain("[Move]");
    expect(frame).toContain("Copy to both");
    expect(frame).toContain("Leave here");
  });

  it("marks the selected untracked mode", async () => {
    const frame = await renderDialog({
      draft: moveDraft({ untracked: "leave" }),
    });

    expect(frame).toContain("[Leave here]");
    expect(frame).not.toContain("[Move]");
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
    expect(row).toContain(">Untracked");
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
    // Stacked, so each untracked choice gets its own row rather than three
    // clipped ones sharing a line.
    const lines = frame.split("\n");
    const rowOf = (text: string) =>
      lines.findIndex((line) => line.includes(text));
    expect(rowOf("Move")).toBeGreaterThanOrEqual(0);
    expect(rowOf("Copy")).not.toBe(rowOf("Move"));
    expect(rowOf("Leave")).not.toBe(rowOf("Copy"));
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

    it("windows a stacked option field rather than drawing off the bottom", async () => {
      // Below the point where every option can have a row, the field becomes
      // a window over its own list — the same shape the agent list has always
      // had — with the selection inside it and each option still showing the
      // number that picks it.
      const frame = await renderDialog({
        draft: moveDraft({ untracked: "leave" }),
        width: 30,
        height: 12,
        showKeyHints: true,
      });

      const lines = frame.split("\n");
      const first = lines.findIndex((line) => line.includes("Untracked"));
      expect(first).toBeGreaterThan(0);
      const shown = lines.slice(first).join("\n");
      // The selected one is what the window keeps, with its own number.
      expect(shown).toContain("[Leave");
      expect(shown).toContain("3");
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

    it("shows every option its number key can select", async () => {
      // One row short is the quiet failure: the third untracked choice is off
      // the bottom while `3` still selects it, so the dialog acts on a choice
      // that was never on screen.
      const frame = await renderDialog({
        draft: moveDraft(),
        width: 30,
        height: 17,
        showKeyHints: true,
      });

      const lines = frame.split("\n");
      // From the Untracked label down, so the title ("Move changes to…")
      // cannot stand in for the option it names.
      const first = lines.findIndex((line) => line.includes("Untracked"));
      expect(first).toBeGreaterThan(0);
      const optionRows = lines.slice(first);
      for (const [index, label] of ["Move", "Copy", "Leave"].entries()) {
        const row = optionRows.findIndex((line) => line.includes(label));
        expect([label, row]).not.toEqual([label, -1]);
        // The number beside it is the key that picks it.
        expect(optionRows[row]).toContain(`${index + 1}`);
      }
      expectFrameIntegrity(frame);
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
