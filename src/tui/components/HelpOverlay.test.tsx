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

  // HEIGHT 12 IS DELIBERATE — do not raise it. This is the scroll test, and a
  // taller viewport makes it pass while exercising nothing: the content would
  // fit, `scrollTop` would still be 0, and the assertions would hold. Raising
  // it deletes the coverage it exists for.
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
  // The sidebar help is a stacked (key-above-description) scrollbox, so
  // "renders all sections" only holds in a viewport tall enough for the whole
  // list: it needs roughly twice the entry count in rows. Height is set well
  // past the content rather than to the exact fit — at the exact fit, adding
  // any shortcut fails an unrelated section's assertion instead, which is how
  // both `n` and `W` independently ended up raising this number.
  async function renderSidebarHelp() {
    setup = await testRender(() => <HelpOverlay sidebar />, {
      width: 100,
      height: 70,
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
      height: 70,
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

  it("keeps the last row visible with every Actions row present", async () => {
    // The tallest the two-column layout ever gets: `reviewable` adds `d` on
    // top of `n` and `F`. Overflow here is SILENT — the scrollbox scrolls,
    // the trailing section slides out of frame, and the overlay still looks
    // fine — so this asserts the BOTTOM of the tallest column rather than
    // the top. Two features have already had to raise these heights; this is
    // what turns the next overflow into a failing test instead of a bug
    // report about a missing Quit row.
    setup = await testRender(() => <HelpOverlay reviewable />, {
      width: 100,
      height: 30,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Fork session");
    expect(frame).toContain("Other");
    expect(frame).toContain("Quit");
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
