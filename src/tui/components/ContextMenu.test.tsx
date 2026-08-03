import { describe, it, expect, afterEach, mock } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { MouseButtons } from "@opentui/core/testing";
import { RGBA } from "@opentui/core";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { expectFrameIntegrity } from "./test-helpers";
import { theme } from "../theme";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

function itemSpies(labels: string[]) {
  return labels.map(
    (label) =>
      ({
        label,
        hint: label[0]!.toLowerCase(),
        color: theme.text,
        action: mock(() => {}),
      }) satisfies ContextMenuItem,
  );
}

async function renderMenu(
  opts: {
    items?: ContextMenuItem[];
    x?: number;
    y?: number;
    onClose?: ReturnType<typeof mock>;
    size?: { width: number; height: number };
    reservedRows?: number;
    highlight?: number | null;
  } = {},
) {
  const items = opts.items ?? itemSpies(["Attach", "Kill", "Restart"]);
  const onClose = opts.onClose ?? mock(() => {});
  const size = opts.size ?? { width: 60, height: 15 };
  setup = await testRender(
    () => (
      <ContextMenu
        x={opts.x ?? 5}
        y={opts.y ?? 2}
        items={items}
        reservedRows={opts.reservedRows}
        highlight={opts.highlight}
        onClose={onClose}
      />
    ),
    size,
  );
  await setup.renderOnce();
  return { frame: setup.captureCharFrame(), items, onClose };
}

/**
 * Which item rows are drawn on the raised background.
 *
 * `captureCharFrame` is text-only and the highlight IS the background, so the
 * only way to prove it reaches the screen is to read the spans. Returns
 * labels rather than row numbers so a menu that grows an item does not
 * silently change what the assertion means.
 */
function raisedLabels(items: ContextMenuItem[]): string[] {
  const raised = RGBA.fromHex(theme.border).toInts().join(",");
  const lit: string[] = [];
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.bg.toInts().join(",") !== raised) continue;
      const item = items.find((i) => span.text.includes(i.label));
      if (item && !lit.includes(item.label)) lit.push(item.label);
    }
  }
  return lit;
}

/** The box's own rows, border included, from a captured frame. */
function boxBounds(frame: string) {
  const lines = frame.split("\n");
  const top = lines.findIndex((l) => l.includes("┌"));
  const bottom = lines.findIndex((l) => l.includes("└"));
  return { top, bottom, height: bottom - top + 1, lines };
}

function locate(frame: string, label: string) {
  const lines = frame.split("\n");
  const row = lines.findIndex((l) => l.includes(label));
  if (row < 0) return null;
  return { row, col: lines[row].indexOf(label) };
}

describe("ContextMenu", () => {
  it("renders each item label", async () => {
    const { frame } = await renderMenu();
    expect(frame).toContain("Attach");
    expect(frame).toContain("Kill");
    expect(frame).toContain("Restart");
  });

  it("renders the hint next to each item", async () => {
    const { frame } = await renderMenu({
      items: [
        { label: "Pin to top", hint: "<", color: theme.blue, action: () => {} },
        {
          label: "Pin to bottom",
          hint: ">",
          color: theme.blue,
          action: () => {},
        },
      ],
    });
    expect(frame).toContain("Pin to top");
    expect(frame).toContain("<");
    expect(frame).toContain("Pin to bottom");
    expect(frame).toContain(">");
  });

  it("left-click on an item fires only that item's action", async () => {
    const { frame, items, onClose } = await renderMenu();
    const pos = locate(frame, "Kill");
    expect(pos).not.toBeNull();
    await setup.mockMouse.click(pos!.col, pos!.row, MouseButtons.LEFT);
    expect(items[1]!.action).toHaveBeenCalledTimes(1);
    expect(items[0]!.action).not.toHaveBeenCalled();
    expect(items[2]!.action).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("right-click on a menu item fires onClose and no item action", async () => {
    const { frame, items, onClose } = await renderMenu();
    const pos = locate(frame, "Attach");
    expect(pos).not.toBeNull();
    await setup.mockMouse.click(pos!.col, pos!.row, MouseButtons.RIGHT);
    expect(onClose).toHaveBeenCalledTimes(1);
    for (const item of items) {
      expect(item.action).not.toHaveBeenCalled();
    }
  });

  it("clamps position so the menu stays within the terminal bounds", async () => {
    const { frame } = await renderMenu({
      x: 9999,
      y: 9999,
      size: { width: 40, height: 10 },
    });
    expect(frame).toContain("Attach");
    expect(frame).toContain("Restart");
  });
});

/**
 * The keyboard highlight (the `m` key's menus). The menu draws it; which item
 * is lit, and what moves it, belong to `App.tsx` and the store — so these
 * cover the rendering half only: that a highlight arrives on screen at all,
 * on the right row, and that it cannot be told apart from the pointer's.
 */
describe("ContextMenu keyboard highlight", () => {
  it("raises the highlighted row", async () => {
    const { items } = await renderMenu({ highlight: 1 });
    expect(raisedLabels(items)).toEqual(["Kill"]);
  });

  it("raises nothing for a menu the pointer opened", async () => {
    // Null is how a right-click opens: the pointer highlights on hover, and a
    // row lit under a pointer that is elsewhere would promise a pending key.
    const { items } = await renderMenu({ highlight: null });
    expect(raisedLabels(items)).toEqual([]);
    const { items: none } = await renderMenu();
    expect(raisedLabels(none)).toEqual([]);
  });

  it("uses the same affordance the pointer does", async () => {
    // Hovering row 2 with no keyboard highlight, and highlighting row 2 with
    // no pointer, have to be indistinguishable — two different "current" rows
    // in one 22-column box would be a puzzle rather than a hint.
    const { items } = await renderMenu();
    const row = locate(setup.captureCharFrame(), "Kill")!.row;
    await setup.mockMouse.moveTo(10, row);
    await setup.renderOnce();
    expect(raisedLabels(items)).toEqual(["Kill"]);
  });

  it("follows the pointer while it is over a row", async () => {
    // Both at once: the hand wins, because it is the one still moving.
    const { items } = await renderMenu({ highlight: 0 });
    expect(raisedLabels(items)).toEqual(["Attach"]);
    const row = locate(setup.captureCharFrame(), "Restart")!.row;
    await setup.mockMouse.moveTo(10, row);
    await setup.renderOnce();
    expect(raisedLabels(items)).toEqual(["Restart"]);
  });

  it("falls back to the keyboard's row when the pointer leaves", async () => {
    const { items } = await renderMenu({ highlight: 0 });
    const row = locate(setup.captureCharFrame(), "Restart")!.row;
    await setup.mockMouse.moveTo(10, row);
    await setup.renderOnce();
    expect(raisedLabels(items)).toEqual(["Restart"]);
    // Off the menu entirely: the keyboard's row is still where Enter would
    // land, so it has to come back rather than leaving the menu blank.
    await setup.mockMouse.moveTo(45, 12);
    await setup.renderOnce();
    expect(raisedLabels(items)).toEqual(["Attach"]);
  });
});

/**
 * Issue #82. The menu is a fixed 22 columns and sizes itself as
 * `items.length + 2`. A label long enough to wrap rendered two rows while
 * still counting as one item, so the box height — and with it the viewport
 * clamp that keeps the menu on screen — was wrong for the whole menu,
 * silently: content assertions pass on a wrapped label just the same.
 */
describe("ContextMenu sizing", () => {
  const LONG = "Move changes to a new worktree";

  it("keeps an over-long label to one row, and the height to the item count", async () => {
    const items = itemSpies(["Attach", LONG, "Kill"]);
    const { frame } = await renderMenu({ items });

    expectFrameIntegrity(frame, items.length + 2);
    const { lines, top } = boxBounds(frame);
    // Legibly cut rather than merely clipped, and still beside its hint.
    const row = lines[top + 2]!;
    expect(row).toContain("Move changes to");
    expect(row).toContain("…");
    expect(row).toContain("m");
    expect(frame).not.toContain("worktree");
  });

  it("leaves the labels that fit alone", async () => {
    // The longest labels the app actually authors, each with its hint.
    const items: ContextMenuItem[] = [
      { label: "New session here", hint: "n", color: theme.text, action() {} },
      { label: "Attach agent", hint: "enter", color: theme.text, action() {} },
      { label: "Prune worktrees", hint: "W", color: theme.text, action() {} },
      { label: "Open agent view", hint: "", color: theme.text, action() {} },
    ];
    const { frame } = await renderMenu({ items });

    expectFrameIntegrity(frame, items.length + 2);
    for (const item of items) expect(frame).toContain(item.label);
    expect(frame).not.toContain("…");
  });

  it("keeps the whole box on screen at the bottom edge", async () => {
    // A wrapping label used to make the real box taller than the height the
    // clamp was computed from, so the bottom border fell off the screen.
    const items = itemSpies(["Attach", LONG, "Kill", "Restart"]);
    const size = { width: 40, height: 10 };
    const { frame } = await renderMenu({ items, x: 9999, y: 9999, size });

    // The height assertion is the one that fails pre-fix here: a box taller
    // than `menuHeight()` loses its bottom border off the viewport, so there
    // is no `└` to measure to.
    expectFrameIntegrity(frame, items.length + 2);
    const { top, bottom } = boxBounds(frame);
    expect(top).toBeGreaterThanOrEqual(0);
    // Flush against the bottom row of the viewport, not past it.
    expect(bottom).toBe(size.height - 1);
    // Every item is still on screen, first and last included.
    expect(frame).toContain("Attach");
    expect(frame).toContain("Restart");
  });
});

/**
 * A menu that has been DRAWN must never move.
 *
 * One of its items arrives asynchronously (the row menu's "Move changes",
 * gated on a `git status` the daemon runs after the menu is up). Appending it
 * last keeps everything above it still — but only where the menu grows
 * downward. Clamped against the bottom edge it grows UPWARD instead, so every
 * row slides one line up as the answer lands, under a pointer that is already
 * travelling: the click aimed at Fork lands on Kill.
 */
describe("ContextMenu with an item still to come", () => {
  it("holds its position at the bottom edge when the item arrives", async () => {
    const base = itemSpies(["Attach", "New session", "Kill", "Restart"]);
    const late = itemSpies(["Move changes"])[0]!;
    const [items, setItems] = createSignal<ContextMenuItem[]>(base);
    const [reserved, setReserved] = createSignal(1);
    const size = { width: 40, height: 10 };

    setup = await testRender(
      () => (
        <ContextMenu
          x={5}
          y={9999}
          items={items()}
          reservedRows={reserved()}
          onClose={() => {}}
        />
      ),
      size,
    );
    await setup.renderOnce();
    const before = boxBounds(setup.captureCharFrame());
    const rowOf = (label: string) =>
      locate(setup.captureCharFrame(), label)?.row;
    const killBefore = rowOf("Kill");

    // The answer lands: the item is appended and its reservation released.
    setItems([...base, late]);
    setReserved(0);
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    const after = boxBounds(frame);
    expect(frame).toContain("Move changes");
    // The top border, and therefore every row measured from it, is where it
    // was. Asserted as a position, not a shape: this is about the pointer.
    expect(after.top).toBe(before.top);
    expect(rowOf("Kill")).toBe(killBefore);
    // And it is still a whole menu on screen.
    expectFrameIntegrity(frame, base.length + 3);
    expect(after.bottom).toBe(size.height - 1);
  });

  it("stays put when the item never comes", async () => {
    // A clean checkout answers "no item", and releasing the reservation then
    // would drop the menu back down a row — the same shift, later.
    const base = itemSpies(["Attach", "New session", "Kill", "Restart"]);
    const size = { width: 40, height: 10 };
    const { frame } = await renderMenu({
      items: base,
      y: 9999,
      size,
      reservedRows: 1,
    });
    const { top, bottom } = boxBounds(frame);
    expect(bottom - top + 1).toBe(base.length + 2);
    // One row of air below it: the space the item that never came would have
    // taken.
    expect(bottom).toBe(size.height - 2);
  });
});
