import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { NewSessionDialog, optionWindow } from "./NewSessionDialog";
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
  });

  it("surfaces the daemon's error when the list could not be resolved", async () => {
    const frame = await renderDialog({
      agents: [],
      agentsError: "Failed to resolve agents: bad regex",
    });
    expect(frame).toContain("bad regex");
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
    const boxRows = frame
      .split("\n")
      .filter((row) => row.includes("│"))
      .map((row) => row.trimEnd());
    expect(boxRows.length).toBeGreaterThan(0);
    for (const row of boxRows) {
      expect(row.endsWith("│")).toBe(true);
    }
  });

  it("shows no name until the prompt has something to derive one from", async () => {
    await renderDialog({ draft: draft({ destination: "worktree" }) });

    const frame = setup.captureCharFrame();
    expect(frame).toContain("[New worktree]");
    expect(frame).not.toContain("New worktree:");
  });

  // The dialog grows a row per field; the height is derived from the field
  // list so a new one cannot silently clip the row below it.
  it("keeps the directory row visible with the destination row present", async () => {
    await renderDialog({ draft: draft({ destination: "worktree" }) });

    expect(setup.captureCharFrame()).toContain("Directory");
  });
});
