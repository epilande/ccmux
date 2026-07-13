import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { MouseButtons } from "@opentui/core/testing";
import { createSignal } from "solid-js";
import { SessionList, isActivePaneRow } from "./SessionList";
import { TickContext } from "../store";
import {
  mockEnrichedSession,
  emptySummary,
  membersFromSummary,
} from "./test-helpers";
import type { FlatItem } from "../utils/grouping";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

function makeHeader(label: string, count: number, groupKey?: string): FlatItem {
  return {
    type: "header",
    groupKey: groupKey ?? label,
    label,
    count,
    collapsed: false,
    members: membersFromSummary({ ...emptySummary(), idle: count }),
  };
}

function makeSessionItem(
  id: string,
  groupKey: string,
  overrides?: Parameters<typeof mockEnrichedSession>[0],
): FlatItem {
  return {
    type: "session",
    groupKey,
    filteredSession: {
      session: mockEnrichedSession({ id, ...overrides }),
      highlights: null,
    },
  };
}

async function renderList(
  items: FlatItem[],
  selectedIndex = 0,
  columns?: import("../../lib/preferences").ColumnsConfig,
  width = 80,
) {
  const [tick] = createSignal(0);
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <SessionList
          items={items}
          selectedIndex={selectedIndex}
          previewWidth={30}
          columns={columns}
        />
      </TickContext.Provider>
    ),
    { width, height: 20 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("SessionList", () => {
  it("renders empty state message", async () => {
    const frame = await renderList([]);
    expect(frame).toContain("No sessions found");
  });

  it("aligns the agent column across waiting and idle rows", async () => {
    // The waiting row carries an attention label the idle row does not. The
    // right-side metadata (agent) is fixed-width at the row end, so it stays
    // aligned regardless: the label eats into the flexible middle, not the
    // right columns.
    const items: FlatItem[] = [
      makeSessionItem("s1", "proj", {
        cwd: "/code/app-one",
        gitBranch: "main",
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash(git status)",
      }),
      makeSessionItem("s2", "proj", {
        cwd: "/code/app-two",
        gitBranch: "main",
      }),
    ];
    // Wide enough that both paths fit with room to spare, so the label eats
    // slack, not the path.
    const frame = await renderList(items, 0, undefined, 120);
    const agentLines = frame.split("\n").filter((l) => l.includes("Claude"));
    expect(agentLines.length).toBe(2);
    const cols = agentLines.map((l) => l.indexOf("Claude"));
    expect(cols[0]).toBe(cols[1]);
    // Both rows keep their full path:branch (no clipped mid-word).
    expect(frame).toContain("app-one:main");
    expect(frame).toContain("app-two:main");
  });

  it("lets an unlabeled row's prompt extend into the label's space", async () => {
    // Per-row label width (not a list-wide reservation): the idle row has no
    // trailing label, so its inline prompt runs further right than the waiting
    // sibling's, whose prompt truncates earlier to leave room for the label.
    const prompt =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
    const items: FlatItem[] = [
      makeSessionItem("s1", "proj", {
        cwd: "/code/app",
        gitBranch: "main",
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash(git status)",
        lastPrompt: prompt,
      }),
      makeSessionItem("s2", "proj", {
        cwd: "/code/app",
        gitBranch: "main",
        lastPrompt: prompt,
      }),
    ];
    // Default prompt display is inline, so the prompt rides row 1.
    const frame = await renderList(items, 0, undefined, 90);
    const lines = frame.split("\n");
    const waitingLine = lines.find((l) => l.includes("Bash(git"))!;
    const idleLine = lines.find(
      (l) => l.includes("alpha") && !l.includes("Bash(git"),
    )!;
    expect(waitingLine).toBeDefined();
    expect(idleLine).toBeDefined();
    // Count how many prompt words survive on each row. The idle row has no
    // trailing label, so more of the prompt fits before it truncates.
    const words = prompt.split(" ");
    const shown = (l: string) => words.filter((w) => l.includes(w)).length;
    expect(shown(idleLine)).toBeGreaterThan(shown(waitingLine));
    // Concretely: the idle row reaches "gamma"; the waiting row stops before it.
    expect(idleLine).toContain("gamma");
    expect(waitingLine).not.toContain("gamma");
  });

  it("renders group header", async () => {
    const items: FlatItem[] = [
      makeHeader("myproject", 2),
      makeSessionItem("s1", "myproject"),
      makeSessionItem("s2", "myproject"),
    ];
    const frame = await renderList(items);
    expect(frame).toContain("myproject");
    expect(frame).toContain("(2)");
  });

  it("renders session items", async () => {
    const items: FlatItem[] = [
      makeHeader("proj", 1),
      makeSessionItem("s1", "proj", {
        project: "my-app",
        cwd: "/code/my-app",
      }),
    ];
    const frame = await renderList(items, 1);
    expect(frame).toContain("my-app");
  });

  it("renders mixed-height sessions (collapsed vs expanded rows)", async () => {
    const items: FlatItem[] = [
      makeHeader("proj", 2),
      makeSessionItem("s1", "proj", {
        cwd: "/code/collapsed",
        lastPrompt: null,
      }),
      makeSessionItem("s2", "proj", {
        cwd: "/code/expanded",
        lastPrompt: "has a prompt",
      }),
    ];
    const frame = await renderList(items, 0, { row2: { left: ["prompt"] } });
    expect(frame).toContain("collapsed");
    expect(frame).toContain("expanded");
    expect(frame).toContain("has a prompt");
  });

  it("scrolls the initial selection into view when it starts below the viewport", async () => {
    // Regression: the scrollbox mounts in the same update that delivers the
    // first sessions, so the scroll effect's first run happens before yoga
    // measures it and scrollTo clamps to 0. The resize listener must re-fire
    // the effect once real dimensions exist.
    const items: FlatItem[] = [
      makeHeader("proj", 12),
      ...Array.from({ length: 12 }, (_, i) =>
        makeSessionItem(`s${i}`, "proj", {
          cwd: i === 11 ? "/code/target-end" : `/code/filler-${i}`,
          lastPrompt: `prompt ${i}`,
        }),
      ),
    ];
    const [tick] = createSignal(0);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          {/* Force the two-row layout so each session is tall enough for the
              selection to start well below the viewport (the scenario this
              regression guards). */}
          <SessionList
            items={items}
            selectedIndex={12}
            previewWidth={30}
            promptDisplay="row2"
          />
        </TickContext.Provider>
      ),
      { width: 80, height: 12 },
    );
    // First pass lays out the freshly mounted scrollbox (fires resize); the
    // second pass renders the re-applied scroll position.
    await setup.renderOnce();
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("target-end");
    expect(frame).not.toContain("filler-0");
  });

  it("routes clicks to onActivate with the right item and index", async () => {
    const items: FlatItem[] = [
      makeHeader("proj", 2),
      makeSessionItem("s1", "proj"),
      makeSessionItem("s2", "proj"),
    ];
    const calls: Array<{ item: FlatItem; index: number }> = [];
    const [tick] = createSignal(0);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <SessionList
            items={items}
            selectedIndex={0}
            previewWidth={30}
            onActivate={(item, index) => calls.push({ item, index })}
          />
        </TickContext.Provider>
      ),
      { width: 80, height: 20 },
    );
    await setup.renderOnce();

    // Header is at row 0; session rows follow.
    await setup.mockMouse.click(3, 0);
    await setup.mockMouse.click(3, 1);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.item.type).toBe("header");
    expect(calls[0]?.index).toBe(0);
    expect(calls[1]?.item.type).toBe("session");
    expect(calls[1]?.index).toBe(1);
  });

  it("routes right-clicks to onContextMenu with the right item, index, and coords", async () => {
    const items: FlatItem[] = [
      makeHeader("proj", 2),
      makeSessionItem("s1", "proj"),
      makeSessionItem("s2", "proj"),
    ];
    const calls: Array<{ type: string; index: number; x: number; y: number }> =
      [];
    const [tick] = createSignal(0);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <SessionList
            items={items}
            selectedIndex={0}
            previewWidth={30}
            onContextMenu={(item, index, event) =>
              calls.push({
                type: item.type,
                index,
                x: event.x,
                y: event.y,
              })
            }
          />
        </TickContext.Provider>
      ),
      { width: 80, height: 20 },
    );
    await setup.renderOnce();

    await setup.mockMouse.click(4, 0, MouseButtons.RIGHT);
    await setup.mockMouse.click(6, 1, MouseButtons.RIGHT);

    expect(calls).toEqual([
      { type: "header", index: 0, x: 4, y: 0 },
      { type: "session", index: 1, x: 6, y: 1 },
    ]);
  });

  it("renders separator between groups but not before first", async () => {
    const items: FlatItem[] = [
      makeHeader("group1", 1),
      makeSessionItem("s1", "group1"),
      makeHeader("group2", 1),
      makeSessionItem("s2", "group2"),
    ];
    const frame = await renderList(items);
    // Both groups render
    expect(frame).toContain("group1");
    expect(frame).toContain("group2");
    // Separator exists between groups (the ─ character)
    expect(frame).toContain("─");
    // Verify separator is between groups by checking line order
    const lines = frame.split("\n");
    const group1Line = lines.findIndex((l) => l.includes("group1"));
    const separatorLine = lines.findIndex(
      (l, i) => i > group1Line && l.includes("─"),
    );
    const group2Line = lines.findIndex((l) => l.includes("group2"));
    expect(group1Line).toBeGreaterThanOrEqual(0);
    expect(separatorLine).toBeGreaterThan(group1Line);
    expect(group2Line).toBeGreaterThan(separatorLine);
  });
});

describe("isActivePaneRow", () => {
  it("never marks a paneless invoke row active, even when activePaneId is null", () => {
    // The bug this guards: tmuxPane null === activePaneId null would be true,
    // falsely highlighting every paneless synthetic invoke row as active.
    expect(isActivePaneRow({ tmuxPane: null }, null)).toBe(false);
    expect(isActivePaneRow({ tmuxPane: null }, undefined)).toBe(false);
    expect(isActivePaneRow({ tmuxPane: null }, "%1")).toBe(false);
  });

  it("marks a real row active only when its pane matches activePaneId", () => {
    expect(isActivePaneRow({ tmuxPane: "%1" }, "%1")).toBe(true);
    expect(isActivePaneRow({ tmuxPane: "%1" }, "%2")).toBe(false);
    expect(isActivePaneRow({ tmuxPane: "%1" }, null)).toBe(false);
  });
});
