import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { RGBA } from "@opentui/core";
import { SessionList } from "./SessionList";
import { SessionItem, isAgeFaded } from "./SessionItem";
import { GroupHeader } from "./GroupHeader";
import { TickContext, createTUIStore } from "../store";
import {
  buildFlatItems,
  NEEDS_YOU_GROUP_KEY,
  type FilteredSession,
} from "../utils/grouping";
import { groupWorktreeFacts } from "./session-columns";
import { mockEnrichedSession } from "./test-helpers";
import { theme } from "../theme";
import type { GroupBy } from "../../lib/preferences";

let setup: Awaited<ReturnType<typeof testRender>>;
afterEach(() => setup?.renderer.destroy());
const make = (
  id: string,
  overrides: Parameters<typeof mockEnrichedSession>[0] = {},
): FilteredSession => ({
  session: mockEnrichedSession({
    id,
    project: "alpha",
    cwd: "/code/alpha",
    paneCwd: "/code/alpha",
    mainRepoRoot: "/code/alpha",
    gitBranch: "main",
    tmuxTarget: "dev:1.2",
    statusChangedAt: "2024-01-15T12:00:00Z",
    ...overrides,
  }),
  highlights: null,
});

describe("rows redesign", () => {
  for (const groupBy of [
    "project",
    "cwd",
    "session",
    "window",
    "none",
  ] as GroupBy[]) {
    it(`moves waiting rows ahead of ${groupBy} groups, oldest first`, () => {
      const items = buildFlatItems(
        [
          make("idle"),
          make("new", {
            status: "waiting",
            statusChangedAt: "2024-01-15T13:00:00Z",
          }),
          make("old", { status: "waiting" }),
        ],
        groupBy,
        new Set([NEEDS_YOU_GROUP_KEY]),
        false,
        ["alpha"],
      );
      expect(items[0]).toMatchObject({
        label: "needs you",
        count: 2,
        collapsed: false,
      });
      const rows = items.filter((item) => item.type === "session");
      expect(rows.map((row) => row.filteredSession.session.id)).toEqual([
        "old",
        "new",
        "idle",
      ]);
      expect(rows[0].identity).toBeUndefined();
      expect(rows[0].sharedTmuxSession).toBeUndefined();
      expect(rows[2].identity).toBe(
        groupBy === "project" ? "hidden" : undefined,
      );
      if (groupBy !== "none")
        expect(items.filter((item) => item.type === "header")[1].count).toBe(1);
    });
  }

  it("lifts only a branch shared by every remaining project row", () => {
    const items = buildFlatItems(
      [make("a"), make("b", { gitBranch: "topic" })],
      "project",
      new Set(),
      false,
    );
    expect(items[0]).toMatchObject({ sharedBranch: undefined, count: 2 });
    expect(items[1]).toMatchObject({
      identity: "branch",
      sharedTmuxSession: "dev",
    });
    const shared = buildFlatItems(
      [make("a"), make("b")],
      "project",
      new Set(),
      false,
    );
    expect(shared[0]).toMatchObject({ sharedBranch: "main" });
    expect(shared[1]).toMatchObject({ identity: "hidden" });
  });

  it("keeps the selected session across band moves and hide-idle, with factual group actions", () => {
    const store = createTUIStore({ groupBy: "project" });
    const a = make("a").session;
    const b = make("b").session;
    store.actions.setSessions([a, b]);
    store.actions.setSelectedIndex(1);
    const selected = store.selectedSession()!;
    store.actions.updateSession({ ...selected, status: "waiting" });
    expect(store.selectedSession()?.id).toBe(selected.id);
    expect(store.selectedIndex()).toBe(1);
    store.actions.toggleHideIdle();
    expect(store.flatItems()).toHaveLength(2);
    store.actions.setSelectedIndex(0);
    expect(store.selectedGroupSessions().map((session) => session.id)).toEqual([
      selected.id,
    ]);
    store.actions.toggleGroupCollapse(NEEDS_YOU_GROUP_KEY);
    expect(store.flatItems()).toHaveLength(2);
    store.actions.toggleHideIdle();
    store.actions.updateSession({ ...selected, status: "idle" });
    expect(
      store.flatItems().some((item) => item.groupKey === NEEDS_YOU_GROUP_KEY),
    ).toBe(false);
  });

  it("fades by idle duration, respects the boundary and disable, and never fades active work", () => {
    const session = make("old").session;
    const start = Date.parse(session.statusChangedAt!);
    expect(isAgeFaded(session, 24, start + 24 * 3_600_000)).toBe(false);
    expect(isAgeFaded(session, 24, start + 24 * 3_600_000 + 1)).toBe(true);
    expect(isAgeFaded(session, 0, start + 48 * 3_600_000)).toBe(false);
    expect(
      isAgeFaded({ ...session, status: "waiting" }, 1, start + 48 * 3_600_000),
    ).toBe(false);
    expect(
      isAgeFaded({ ...session, status: "working" }, 1, start + 48 * 3_600_000),
    ).toBe(false);
  });

  it("actually paints old row text in the dim color", async () => {
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <SessionItem
            session={make("old").session}
            selected={false}
            index={0}
            previewWidth={30}
          />
        </TickContext.Provider>
      ),
      { width: 96, height: 3 },
    );
    await setup.renderOnce();
    const frame = setup.captureSpans();
    const label = frame.lines[0].spans.find((span) =>
      span.text.includes("alpha"),
    );
    expect(label).toBeDefined();
    expect(label!.fg.toInts()).toEqual(RGBA.fromHex(theme.subtext).toInts());
  });

  for (const [width, height, sidebar] of [
    [160, 45, false],
    [96, 30, false],
    [30, 30, true],
  ] as const) {
    it(`renders the band, project suppression and sidebar target at ${width} columns`, async () => {
      const [rows, setRows] = createSignal([
        make("wait", {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash(git push)",
          gitBranch: "topic",
        }),
        make("idle", { summary: "Investigate rendering" }),
      ]);
      setup = await testRender(
        () => (
          <TickContext.Provider value={{ tick: () => 0 }}>
            <SessionList
              items={buildFlatItems(rows(), "project", new Set(), false)}
              selectedIndex={1}
              sidebar={sidebar}
              previewWidth={30}
            />
          </TickContext.Provider>
        ),
        { width, height },
      );
      await setup.renderOnce();
      let frame = setup.captureCharFrame();
      expect(frame).toContain("needs you (1)");
      expect(frame).toContain("◆ alpha");
      expect(frame).toContain("dev:1.2");
      expect(frame).toContain("alpha (1)");
      expect(frame).not.toContain("idle");
      expect(frame).not.toContain("waiting");
      expect(frame).not.toContain("Worktrees");
      expect(
        frame.split("\n").filter((line) => line.includes("◆")),
      ).toHaveLength(1);
      setRows([
        make("wait", { summary: "Finished" }),
        make("idle", { summary: "Investigate rendering" }),
      ]);
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      expect(frame).not.toContain("needs you");
      expect(frame).toContain("alpha (2)");
      expect(frame).toContain("main");
    });
  }

  for (const width of [160, 96]) {
    it(`aligns mixed branch lengths and PR badges at ${width} columns`, async () => {
      const rows = [
        make("short", {
          gitBranch: "main",
          summary: "Short summary",
          branchPRs: [{ id: "25", href: "https://github.com/x/y/pull/25" }],
        }),
        make("long", {
          gitBranch: "a-very-long-branch-that-must-leave-room-for-the-summary",
          summary: "Long summary",
        }),
      ];
      setup = await testRender(
        () => (
          <TickContext.Provider value={{ tick: () => 0 }}>
            <SessionList
              items={buildFlatItems(rows, "project", new Set(), false)}
              selectedIndex={1}
              previewWidth={30}
            />
          </TickContext.Provider>
        ),
        { width, height: 10 },
      );
      await setup.renderOnce();
      const lines = setup.captureCharFrame().split("\n");
      const short = lines.find((line) => line.includes("Short summary"))!;
      const long = lines.find((line) => line.includes("Long summary"))!;
      expect(short).toBeDefined();
      expect(long).toBeDefined();
      expect(short.indexOf("Short summary")).toBe(long.indexOf("Long summary"));
      expect(long).toContain("…");
    });
  }

  it("fits header facts without wrapping, and omits them for mixed repos or the band", async () => {
    const header = buildFlatItems([make("a")], "project", new Set(), false)[0];
    if (header.type !== "header") throw new Error("missing header");
    const repo = {
      repoRoot: "/code/alpha",
      repoName: "alpha",
      removable: 2,
      worktrees: [],
    };
    expect(groupWorktreeFacts(header, [repo])).toBe(
      "0 worktrees · 2 removable",
    );
    expect(
      groupWorktreeFacts(
        { ...header, groupKey: NEEDS_YOU_GROUP_KEY, label: "needs you" },
        [repo],
      ),
    ).toBeUndefined();
    expect(
      groupWorktreeFacts(
        {
          ...header,
          members: [make("a"), make("b", { mainRepoRoot: "/code/beta" })],
        },
        [repo],
      ),
    ).toBeUndefined();
    setup = await testRender(
      () => (
        <GroupHeader
          label="長いプロジェクト"
          count={42}
          collapsed={false}
          selected={false}
          members={[]}
          sharedBranch="long-shared-branch"
          facts="main + 10 worktrees · 3 removable"
          width={28}
        />
      ),
      { width: 30, height: 3 },
    );
    await setup.renderOnce();
    expect(setup.captureCharFrame().split("\n")[1].trim()).toBe("");
  });
});
