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
  prompt: "",
  field: "agent",
  ...overrides,
});

async function renderDialog(props: {
  draft?: NewSessionDraft;
  agents?: SpawnableAgent[] | null;
  agentsError?: string | null;
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
        onPromptInput={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
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

  it("abbreviates the placements when the dialog is narrow", async () => {
    const frame = await renderDialog({ width: 44 });
    expect(frame).toContain("[Window]");
    expect(frame).toContain("Right");
    expect(frame).toContain("Down");
    expect(frame).not.toContain("Split right");
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
});
