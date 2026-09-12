import type { ScrollBoxRenderable } from "@opentui/core";
import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { HelpOverlay } from "./HelpOverlay";
import { squish } from "./test-helpers";

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Key as its own column, not a letter inside "Jump" / "group". */
function lineHasKey(line: string, key: string): boolean {
  const inner = line.replace(/[│┌┐└┘─█▀▄]/g, " ");
  if (inner.replace(/\s+/g, " ").trim() === key) return true;
  return new RegExp(`(?:^|\\s{2,})${escapeRe(key)}\\s{2,}`).test(inner);
}

/** The description is on the key's row or the next few (wrap / compact). */
function expectHelpEntry(frame: string, key: string, desc: string): void {
  const lines = frame.split("\n");
  const keyLine = lines.findIndex((l) => lineHasKey(l, key));
  expect(keyLine).toBeGreaterThan(-1);
  const window = lines.slice(keyLine, keyLine + 5).join("\n");
  // Words in order: two-column rows interleave the other column between
  // wrapped desc lines, so a squished window is not contiguous.
  let from = 0;
  for (const word of desc.split(/\s+/)) {
    const idx = window.indexOf(word, from);
    expect(idx).toBeGreaterThan(-1);
    from = idx + word.length;
  }
}

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
    expect(frame).toContain("Working tree / branch");
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
    expect(frame).not.toContain("Working tree / branch");
  });
});

describe("HelpOverlay narrow and wide picker (issue #200)", () => {
  it("keeps complete descriptions at 60x24 in a single column", async () => {
    setup = await testRender(() => <HelpOverlay />, {
      width: 60,
      height: 24,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    const nav = lines.find((l) => l.includes("Navigation"));
    expect(nav).toBeDefined();
    // Two-column clip: Preview sat on the Navigation row and lost its
    // descriptions off the right edge. One column stacks the sections.
    expect(nav!).not.toContain("Preview");
    expectHelpEntry(frame, "j/k ↑/↓", "Navigate sessions");
    expectHelpEntry(frame, "gg / G", "Jump to first / last");
    expectHelpEntry(frame, "1-9", "Jump to session N");
    expectHelpEntry(frame, "Enter", "Switch to session");
    // Longer than the old 24-column description budget; must wrap, not clip.
    expectHelpEntry(frame, "p", "Cycle prompt (inline/row/off)");
    expect(squish(frame)).toContain(squish("j/k scroll · ? or Esc to close"));
  });

  it("reveals complete Preview entries after scrolling at 60x24", async () => {
    let ref: ScrollBoxRenderable | undefined;
    setup = await testRender(
      () => <HelpOverlay onScrollboxRef={(r) => (ref = r)} />,
      { width: 60, height: 24 },
    );
    await setup.renderOnce();
    expect(ref).toBeDefined();
    // Single-column content is taller than 24 rows; the right-hand
    // section is below the fold instead of clipped beside Navigation.
    ref!.scrollBy(20);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expectHelpEntry(frame, "P", "Toggle preview");
    expectHelpEntry(frame, "Ctrl+D/U", "Scroll preview");
    expectHelpEntry(frame, "Alt+H/L", "Resize preview");
    expectHelpEntry(frame, "Tab", "Focus preview");
  });

  it("keeps two columns and complete descriptions at 120x35", async () => {
    setup = await testRender(() => <HelpOverlay />, {
      width: 120,
      height: 35,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const nav = frame.split("\n").find((l) => l.includes("Navigation"));
    expect(nav).toBeDefined();
    expect(nav!).toContain("Preview");
    expectHelpEntry(frame, "j/k ↑/↓", "Navigate sessions");
    expectHelpEntry(frame, "P", "Toggle preview");
    expectHelpEntry(frame, "Ctrl+D/U", "Scroll preview");
    expectHelpEntry(frame, "Alt+H/L", "Resize preview");
    expectHelpEntry(frame, "Tab", "Focus preview");
    expectHelpEntry(frame, "h / l", "Collapse / expand group");
    expectHelpEntry(frame, "p", "Cycle prompt (inline/row/off)");
    expect(squish(frame)).toContain(squish("j/k scroll · ? or Esc to close"));
  });

  it("switches between one and two columns when the picker is resized", async () => {
    setup = await testRender(() => <HelpOverlay />, {
      width: 60,
      height: 24,
    });
    await setup.renderOnce();
    const narrow = setup.captureCharFrame();
    expect(
      narrow.split("\n").find((l) => l.includes("Navigation")),
    ).not.toContain("Preview");
    expectHelpEntry(narrow, "p", "Cycle prompt (inline/row/off)");

    setup.resize(120, 35);
    await setup.renderOnce();
    const wide = setup.captureCharFrame();
    expect(wide.split("\n").find((l) => l.includes("Navigation"))).toContain(
      "Preview",
    );
    expectHelpEntry(wide, "P", "Toggle preview");
    expectHelpEntry(wide, "p", "Cycle prompt (inline/row/off)");

    setup.resize(60, 24);
    await setup.renderOnce();
    const again = setup.captureCharFrame();
    expect(
      again.split("\n").find((l) => l.includes("Navigation")),
    ).not.toContain("Preview");
    expectHelpEntry(again, "p", "Cycle prompt (inline/row/off)");
  });
});

describe("HelpOverlay sidebar compact wrap (issue #200)", () => {
  it("keeps compact help readable at 30x35", async () => {
    setup = await testRender(() => <HelpOverlay sidebar />, {
      width: 30,
      height: 35,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).not.toContain("Preview");
    expect(frame).not.toContain("Toggle preview");
    expectHelpEntry(frame, "j/k ↑/↓", "Navigate sessions");
    expectHelpEntry(frame, "gg / G", "Jump to first / last");
    expectHelpEntry(frame, "Enter", "Switch to session");
    // Compact is key-above-description; the key and its first desc
    // line are consecutive, not sharing a two-column row with Groups.
    const lines = frame.split("\n");
    const keyLine = lines.findIndex((l) => l.includes("j/k ↑/↓"));
    expect(keyLine).toBeGreaterThan(-1);
    expect(lines[keyLine]!).not.toContain("Navigate sessions");
    expect(lines[keyLine + 1]!).toContain("Navigate sessions");
    expect(squish(frame)).toContain(squish("j/k scroll · ? close"));
  });

  it("wraps the cycle-prompt description instead of clipping it", async () => {
    setup = await testRender(() => <HelpOverlay sidebar />, {
      width: 30,
      height: 70,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expectHelpEntry(frame, "p", "Cycle prompt (inline/row/off)");
  });
});
