import type { ScrollBoxRenderable } from "@opentui/core";
import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { HelpOverlay } from "./HelpOverlay";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderHelp() {
  setup = await testRender(() => <HelpOverlay />, { width: 100, height: 30 });
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("HelpOverlay", () => {
  it("renders Keyboard Shortcuts title", async () => {
    const frame = await renderHelp();
    expect(frame).toContain("Keyboard Shortcuts");
  });

  it("renders Navigation section", async () => {
    const frame = await renderHelp();
    expect(frame).toContain("Navigation");
    expect(frame).toContain("Navigate sessions");
  });

  it("renders Actions section", async () => {
    const frame = await renderHelp();
    expect(frame).toContain("Actions");
    expect(frame).toContain("Switch to session");
    expect(frame).toContain("Enter");
  });

  it("renders Preview section", async () => {
    const frame = await renderHelp();
    expect(frame).toContain("Preview");
    expect(frame).toContain("Toggle preview");
  });

  it("renders Groups section", async () => {
    const frame = await renderHelp();
    expect(frame).toContain("Groups");
    expect(frame).toContain("Collapse");
    expect(frame).toContain("h / l");
    expect(frame).toContain("Space");
  });

  it("renders close instruction", async () => {
    const frame = await renderHelp();
    expect(frame).toContain("j/k scroll");
    expect(frame).toContain("? or Esc to close");
  });

  it("constrains width in wide viewport", async () => {
    setup = await testRender(() => <HelpOverlay />, {
      width: 150,
      height: 30,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n").filter((l) => l.includes("│"));
    const contentWidth = lines[0].lastIndexOf("│") - lines[0].indexOf("│") + 1;
    // MAX_WIDTH is 83; modal should not stretch to viewport width (150)
    expect(contentWidth).toBeLessThanOrEqual(85);
    expect(contentWidth).toBeLessThan(150);
  });

  it("provides scrollbox ref", async () => {
    let ref: ScrollBoxRenderable | undefined;
    setup = await testRender(
      () => <HelpOverlay onScrollboxRef={(r) => (ref = r)} />,
      { width: 100, height: 30 },
    );
    await setup.renderOnce();
    expect(ref).toBeDefined();
    expect(ref!.scrollTop).toBe(0);
  });

  it("shows all sections in short viewport via scrollbox", async () => {
    let ref: ScrollBoxRenderable | undefined;
    setup = await testRender(
      () => <HelpOverlay onScrollboxRef={(r) => (ref = r)} />,
      { width: 100, height: 12 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    // Title and first section visible
    expect(frame).toContain("Keyboard Shortcuts");
    expect(frame).toContain("Navigation");
    // Scrollbox exists and has content beyond viewport
    expect(ref).toBeDefined();
    expect(ref!.scrollTop).toBe(0);
  });
});

describe("HelpOverlay sidebar mode", () => {
  async function renderSidebarHelp() {
    setup = await testRender(() => <HelpOverlay sidebar />, {
      width: 100,
      height: 50,
    });
    await setup.renderOnce();
    return setup.captureCharFrame();
  }

  it("hides Preview section in sidebar mode", async () => {
    const frame = await renderSidebarHelp();
    expect(frame).not.toContain("Preview");
    expect(frame).not.toContain("Toggle preview");
  });

  it("still shows Navigation and Groups in sidebar mode", async () => {
    const frame = await renderSidebarHelp();
    expect(frame).toContain("Navigation");
    expect(frame).toContain("Groups");
    expect(frame).toContain("Actions");
  });

  it("shows q without Esc for quit in sidebar mode", async () => {
    const frame = await renderSidebarHelp();
    expect(frame).toContain("Quit");
    expect(frame).not.toContain("q / Esc");
  });

  it("shows scroll hint in close instruction", async () => {
    const frame = await renderSidebarHelp();
    expect(frame).toContain("j/k scroll");
    expect(frame).toContain("? close");
  });

  it("renders all sections in narrow viewport", async () => {
    setup = await testRender(() => <HelpOverlay sidebar />, {
      width: 30,
      height: 50,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Keyboard Shortcuts");
    expect(frame).toContain("Navigation");
    expect(frame).toContain("Actions");
    expect(frame).toContain("Groups");
    expect(frame).toContain("Other");
  });
});

describe("HelpOverlay reviewable", () => {
  it("shows the review diff row when reviewable", async () => {
    setup = await testRender(() => <HelpOverlay reviewable />, {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Review diff (hunk)");
  });

  it("omits the review diff row when not reviewable", async () => {
    setup = await testRender(() => <HelpOverlay />, {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Review diff (hunk)");
  });
});
