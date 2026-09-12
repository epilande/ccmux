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
      expect(rows[0].sharedTmuxSession).toBeUndefined();
      expect(rows[2].sharedTmuxSession).toBe(
        groupBy === "session" || groupBy === "window" ? "dev" : undefined,
      );
      if (groupBy !== "none")
        expect(items.filter((item) => item.type === "header")[1].count).toBe(1);
    });
  }

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

  it("fades task text while retaining identity and agent colors", async () => {
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <SessionItem
            session={make("old", { summary: "Old task" }).session}
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
      span.text.includes("Old task"),
    );
    expect(label).toBeDefined();
    expect(label!.fg.toInts()).toEqual(RGBA.fromHex(theme.subtext).toInts());
    const identity = frame.lines[0].spans.find((span) =>
      span.text.includes("alpha"),
    );
    expect(identity!.fg.toInts()).not.toEqual(
      RGBA.fromHex(theme.subtext).toInts(),
    );
    const agent = frame.lines[0].spans.find((span) =>
      span.text.includes("Claude"),
    );
    expect(agent!.fg.toInts()).toEqual(RGBA.fromHex(theme.peach).toInts());
  });

  for (const [width, height, sidebar] of [
    [160, 45, false],
    [96, 30, false],
    [30, 30, true],
  ] as const) {
    it(`renders the band, row identity and sidebar target at ${width} columns`, async () => {
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
      expect(frame).toContain("alpha:topic");
      expect(frame).toContain("dev:1.2");
      expect(frame).toContain("alpha (1)");
      if (!sidebar) expect(frame).toContain("idle");
      expect(frame).not.toContain("Worktrees");
      expect(
        frame.split("\n").filter((line) => line.includes("■")),
      ).toHaveLength(1);
      setRows([
        make("wait", { summary: "Finished" }),
        make("idle", { summary: "Investigate rendering" }),
      ]);
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      expect(frame).not.toContain("needs you");
      expect(frame).toContain("alpha (2)");
      expect(frame).toContain("alpha:main");
    });
  }

  for (const groupBy of [
    "project",
    "cwd",
    "session",
    "window",
    "none",
  ] as GroupBy[]) {
    for (const width of [160, 96, 30]) {
      it(`preserves checkout, branch and PR identity in ${groupBy} at ${width} columns`, async () => {
        const rows = [
          make("tree", {
            cwd: "/code/alpha/.claude/worktrees/wt",
            paneCwd: "/code/alpha/.claude/worktrees/wt",
            worktreeRoot: "/code/alpha/.claude/worktrees/wt",
            isWorktree: true,
            gitBranch: "fix",
            summary: "Repair rendering",
            branchPRs: [{ id: "25", href: "https://github.com/x/y/pull/25" }],
          }),
        ];
        setup = await testRender(
          () => (
            <TickContext.Provider value={{ tick: () => 0 }}>
              <SessionList
                items={buildFlatItems(rows, groupBy, new Set(), false)}
                selectedIndex={groupBy === "none" ? 0 : 1}
                sidebar={width === 30}
                previewWidth={30}
              />
            </TickContext.Provider>
          ),
          { width, height: 10 },
        );
        await setup.renderOnce();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("wt:fix+");
        expect(frame).toContain("#25");
        if (width > 30) {
          expect(frame).toContain("Repair rendering");
          if (groupBy === "project" || groupBy === "cwd" || groupBy === "none")
            expect(frame).toContain("dev:1.2");
        }
      });
    }
  }

  for (const width of [160, 96, 30]) {
    it(`keeps invoke outcomes and background identity distinct at ${width} columns`, async () => {
      const rows = [
        make("done", {
          originInvocationId: "i1",
          originInvocationStatus: "succeeded",
        }),
        make("failed", {
          originInvocationId: "i2",
          originInvocationStatus: "failed",
        }),
        make("cancel", {
          originInvocationId: "i3",
          originInvocationStatus: "cancelled",
        }),
        make("background", { trackingMode: "background" }),
        make("complete", { attentionState: "unread" }),
      ];
      setup = await testRender(
        () => (
          <TickContext.Provider value={{ tick: () => 0 }}>
            <SessionList
              items={buildFlatItems(rows, "none", new Set(), false)}
              selectedIndex={0}
              sidebar={width === 30}
              previewWidth={30}
            />
          </TickContext.Provider>
        ),
        { width, height: 12 },
      );
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      for (const icon of ["✓", "✗", "⊘", "◇"]) expect(frame).toContain(icon);
      if (width > 30) {
        expect(frame).toContain("done");
        expect(frame).toContain("failed");
        expect(frame).toContain("cancel");
      }
      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      expect(
        spans.find((span) => span.text.includes("✗"))!.fg.toInts(),
      ).toEqual(RGBA.fromHex(theme.red).toInts());
      expect(
        spans.find((span) => span.text.includes("✓"))!.fg.toInts(),
      ).toEqual(RGBA.fromHex(theme.green).toInts());
      expect(
        spans.find((span) => span.text.includes("●"))!.fg.toInts(),
      ).toEqual(RGBA.fromHex(theme.green).toInts());
    });
  }

  it("retains a waiting task summary and its search evidence alongside the reason", async () => {
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <SessionItem
            session={
              make("wait", {
                status: "waiting",
                attentionType: "permission",
                pendingTool: "Read",
                summary: "Fix grouped rows",
              }).session
            }
            selected={false}
            index={0}
            previewWidth={30}
            matchSource="transcript"
            transcriptSnippet="cursor evidence"
          />
        </TickContext.Provider>
      ),
      { width: 160, height: 4 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Read");
    expect(frame).toContain("cursor evidence");
    expect(frame).toContain("[transcript]");
  });

  it("fits header facts without wrapping, and omits them for mixed repos or the band", async () => {
    const header = buildFlatItems([make("a")], "project", new Set(), false)[0];
    if (header.type !== "header") throw new Error("missing header");
    const repo = {
      repoRoot: "/code/alpha",
      repoName: "alpha",
      worktrees: [],
    };
    expect(groupWorktreeFacts(header, [repo])).toBeUndefined();
    for (const groupBy of ["cwd", "session", "window"] as GroupBy[]) {
      const nonRepo = buildFlatItems([make("a")], groupBy, new Set(), false)[0];
      if (nonRepo.type !== "header") throw new Error("missing header");
      expect(nonRepo.repoRoot).toBeUndefined();
    }
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
          collapsed={true}
          selected={false}
          members={[make("idle"), make("work", { status: "working" })]}
          facts="main + 10 worktrees and a long tail"
          width={28}
        />
      ),
      { width: 30, height: 3 },
    );
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    expect(lines[1].trim()).toBe("");
    expect(lines[0]).toContain("(42)");
    expect(lines[0]).toMatch(/[●◐◓◑◒] 1/);
    expect(lines[0]).toContain("● 1");
    expect(lines[0]).not.toContain("worktrees");
  });
});
