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

/**
 * The key's line index, plus the two-line window a description may occupy:
 * the key's own row (picker, where key and desc share a row) or the row
 * right below it (sidebar compact, which stacks desc under key).
 *
 * Joining the window with "\n" keeps `toContain` contiguous per line, since
 * no description contains a newline. That is the point of these helpers: a
 * clipped "Toggle prev" must not pass because a later row says "Scroll
 * preview".
 */
function keyWindow(
  frame: string,
  key: string,
): { lines: string[]; at: number } {
  const lines = frame.split("\n");
  const at = lines.findIndex((l) => lineHasKey(l, key));
  expect(at).toBeGreaterThan(-1);
  return { lines, at };
}

/** The FULL description sits on one line: the key's row or the next. */
function expectHelpEntry(frame: string, key: string, desc: string): void {
  const { lines, at } = keyWindow(frame, key);
  expect(lines.slice(at, at + 2).join("\n")).toContain(desc);
}

/**
 * A description that legitimately wraps at the tested width: `head` on the
 * key's row or the next, `tail` contiguous on one of the three rows after
 * whichever row held `head`.
 */
function expectWrappedHelpEntry(
  frame: string,
  key: string,
  head: string,
  tail: string,
): void {
  const { lines, at } = keyWindow(frame, key);
  expect(lines.slice(at, at + 2).join("\n")).toContain(head);
  const headLine = lines[at]!.includes(head) ? at : at + 1;
  expect(lines.slice(headLine + 1, headLine + 4).join("\n")).toContain(tail);
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
    expect(frame).toContain("Move cursor");
  });

  it("renders Actions section", async () => {
    const frame = await renderHelp();
    expect(frame).toContain("Actions");
    expect(frame).toContain("Go / toggle group");
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
    expect(frame).toContain("Back, then quit");
    expect(frame).toContain("q / Esc");
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

  it("reaches the last action by scrolling with every action present", async () => {
    let ref: ScrollBoxRenderable | undefined;
    // The tallest the two-column layout ever gets: `reviewable` adds `d` on
    // top of `n` and `F`. Overflow here is SILENT — the scrollbox scrolls,
    // the trailing section slides out of frame, and the overlay still looks
    // fine — so this asserts the BOTTOM of the tallest column rather than
    // the top. Two features have already had to raise these heights; this is
    // what turns the next overflow into a failing test instead of a bug
    // report about a missing Quit row.
    setup = await testRender(
      () => (
        <HelpOverlay
          reviewable
          onScrollboxRef={(r) => {
            ref = r;
          }}
        />
      ),
      { width: 100, height: 30 },
    );
    await setup.renderOnce();
    ref!.scrollTo(1000);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Fork session");
    expect(frame).toContain("Toggle hide idle");
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
    // Two-column clip: Groups sat on the Navigation row and lost its
    // descriptions off the right edge. One column stacks the sections.
    expect(nav!).not.toContain("Groups");
    expectHelpEntry(frame, "j/k ↑/↓", "Move cursor");
    expectHelpEntry(frame, "gg / G", "First / last row");
    expectHelpEntry(frame, "1-9", "Go to row N");
    expectHelpEntry(frame, "Enter", "Go / toggle group");
    // 26 columns against a 40-column single-column budget: one line, whole.
    expectHelpEntry(frame, "y", "Copy response / path / URL");
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
    ref!.scrollTo(1000);
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
    expect(nav!).toContain("Groups");
    expectHelpEntry(frame, "j/k ↑/↓", "Move cursor");
    expectHelpEntry(frame, "h / l", "Previous / next view");
    expectHelpEntry(frame, "P", "Toggle preview");
    expectHelpEntry(frame, "Ctrl+D/U", "Scroll preview");
    expectHelpEntry(frame, "Alt+H/L", "Resize preview");
    expectHelpEntry(frame, "Tab", "Focus preview");
    // 26 columns against the two-column budget of 24: wraps, never clips.
    expectWrappedHelpEntry(frame, "y", "Copy response / path /", "URL");
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
    ).not.toContain("Groups");
    expectHelpEntry(narrow, "y", "Copy response / path / URL");

    setup.resize(120, 35);
    await setup.renderOnce();
    const wide = setup.captureCharFrame();
    expect(wide.split("\n").find((l) => l.includes("Navigation"))).toContain(
      "Groups",
    );
    expectHelpEntry(wide, "P", "Toggle preview");
    expectWrappedHelpEntry(wide, "y", "Copy response / path /", "URL");

    setup.resize(60, 24);
    await setup.renderOnce();
    const again = setup.captureCharFrame();
    expect(
      again.split("\n").find((l) => l.includes("Navigation")),
    ).not.toContain("Groups");
    expectHelpEntry(again, "y", "Copy response / path / URL");
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
    expectHelpEntry(frame, "j/k ↑/↓", "Move cursor");
    expectHelpEntry(frame, "gg / G", "First / last row");
    expectHelpEntry(frame, "Enter", "Go / toggle group");
    // Compact is key-above-description; the key and its first desc
    // line are consecutive, not sharing a two-column row with Groups.
    const lines = frame.split("\n");
    const keyLine = lines.findIndex((l) => l.includes("j/k ↑/↓"));
    expect(keyLine).toBeGreaterThan(-1);
    expect(lines[keyLine]!).not.toContain("Move cursor");
    expect(lines[keyLine + 1]!).toContain("Move cursor");
    expect(squish(frame)).toContain(squish("j/k scroll · ? close"));
  });

  it("wraps the longest action description instead of clipping it", async () => {
    // 30-column compact has 26 columns of description, which fits the
    // longest current action. 24 columns of viewport leaves 20, which
    // is what forces "Copy response / path / URL" onto a second line.
    setup = await testRender(() => <HelpOverlay sidebar />, {
      width: 24,
      height: 70,
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expectWrappedHelpEntry(frame, "y", "Copy response / path", "/ URL");
  });
});
