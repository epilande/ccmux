import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { NewSessionDialog, optionWindow, wrapText } from "./NewSessionDialog";
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
  field: "agent",
  ...overrides,
});

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
        onPromptInput={() => {}}
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
 * The worktree destination (issue #69). The row shows the name it WOULD
 * create, derived from the prompt, so the choice is concrete rather than a
 * promise and the branch name never arrives as a surprise.
 */
describe("NewSessionDialog destination", () => {
  it("offers both destinations, with this checkout selected by default", async () => {
    await renderDialog({});

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Where");
    expect(frame).toContain("[This checkout]");
    expect(frame).toContain("New worktree");
  });

  it("previews the derived worktree name from the prompt", async () => {
    await renderDialog({
      // A short prompt so the whole derived name fits: the dialog is capped
      // at MAX_WIDTH regardless of terminal size, so a long one is always
      // truncated (covered by the next test).
      draft: draft({ destination: "worktree", prompt: "fix bug" }),
    });

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[New worktree: fix-bug]");
  });

  /**
   * The derived name is budgeted against the row, not appended blindly. A
   * long slug pushed the dialog's own right border off screen, which reads
   * as a broken dialog rather than a long name.
   */
  it("truncates the name rather than overflowing the border", async () => {
    await renderDialog({
      draft: draft({
        destination: "worktree",
        prompt: "fix sidebar flicker on resize",
      }),
    });

    const frame = setup.captureCharFrame();
    expect(frame).toContain("New worktree: fix-sidebar-");
    // Every row of the box still ends with its border.
    expectFrameIntegrity(frame);
  });

  /**
   * With no derivable name the option cannot spawn at all, so the row says
   * what is missing instead of showing a name it does not have.
   */
  it("asks for a prompt until there is something to derive a name from", async () => {
    await renderDialog({ draft: draft({ destination: "worktree" }) });

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[New worktree (add a prompt)]");
    expect(frame).not.toContain("New worktree:");
    // The hint is budgeted like the name is; the border still closes.
    expectFrameIntegrity(frame);
  });

  it("keeps the hint off the unselected row, where it is only noise", async () => {
    const frame = await renderDialog({ draft: draft({ destination: "here" }) });

    expect(frame).toContain("[This checkout]");
    expect(frame).not.toContain("add a prompt");
  });

  /** A CJK-only prompt derives nothing, exactly like an empty one. */
  it("asks for a prompt when the prompt derives no slug at all", async () => {
    const frame = await renderDialog({
      draft: draft({ destination: "worktree", prompt: "修复侧边栏" }),
    });

    expect(frame).toContain("[New worktree (add a prompt)]");
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
