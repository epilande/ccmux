import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { MouseButtons } from "@opentui/core/testing";
import { GroupHeader } from "./GroupHeader";
import { emptySummary, membersFromSummary } from "./test-helpers";
import type { StatusSummary } from "../utils/grouping";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderHeader(props: {
  label?: string;
  count?: number;
  collapsed?: boolean;
  selected?: boolean;
  statusSummary?: StatusSummary;
  dimmed?: boolean;
}) {
  setup = await testRender(
    () => (
      <GroupHeader
        label={props.label ?? "testgroup"}
        count={props.count ?? 3}
        collapsed={props.collapsed ?? false}
        selected={props.selected ?? false}
        members={membersFromSummary(props.statusSummary ?? emptySummary())}
        dimmed={props.dimmed}
      />
    ),
    { width: 80, height: 3 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("GroupHeader", () => {
  it("renders collapse indicator when collapsed", async () => {
    const frame = await renderHeader({ collapsed: true });
    expect(frame).toContain("▶");
    expect(frame).not.toContain("▼");
  });

  it("renders expand indicator when expanded", async () => {
    const frame = await renderHeader({ collapsed: false });
    expect(frame).toContain("▼");
    expect(frame).not.toContain("▶");
  });

  it("renders group label and count", async () => {
    const frame = await renderHeader({ label: "ccmux", count: 4 });
    expect(frame).toContain("ccmux");
    expect(frame).toContain("(4)");
  });

  it("shows status dots when collapsed", async () => {
    const frame = await renderHeader({
      collapsed: true,
      statusSummary: { ...emptySummary(), working: 2, idle: 4 },
    });
    expect(frame).toContain("● 2");
    expect(frame).toContain("● 4");
  });

  it("hides status dots when expanded", async () => {
    const frame = await renderHeader({
      collapsed: false,
      statusSummary: { ...emptySummary(), working: 2, idle: 4 },
    });
    expect(frame).not.toContain("● 2");
    expect(frame).not.toContain("● 4");
  });

  it("shows waiting subtypes with correct counts when collapsed", async () => {
    const frame = await renderHeader({
      collapsed: true,
      statusSummary: {
        ...emptySummary(),
        waitingPermission: 5,
        waitingGeneric: 8,
      },
    });
    expect(frame).toContain("■ 5");
    expect(frame).toContain("■ 8");
  });

  it("hides waiting subtypes when expanded", async () => {
    const frame = await renderHeader({
      collapsed: false,
      statusSummary: {
        ...emptySummary(),
        waitingPermission: 5,
        waitingGeneric: 8,
      },
    });
    expect(frame).not.toContain("■ 5");
    expect(frame).not.toContain("■ 8");
  });

  it("shows all status types together when collapsed", async () => {
    const frame = await renderHeader({
      collapsed: true,
      statusSummary: {
        working: 2,
        waitingPermission: 1,
        waitingPlanApproval: 0,
        waitingGeneric: 3,
        idle: 4,
      },
    });
    expect(frame).toContain("● 2");
    expect(frame).toContain("■ 1");
    expect(frame).toContain("■ 3");
    expect(frame).toContain("● 4");
  });

  it("calls onActivate when clicked", async () => {
    let calls = 0;
    setup = await testRender(
      () => (
        <GroupHeader
          label="testgroup"
          count={3}
          collapsed={false}
          selected={false}
          members={[]}
          onActivate={() => {
            calls++;
          }}
        />
      ),
      { width: 80, height: 3 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(3, 0);
    expect(calls).toBe(1);
  });

  it("does not throw when clicked without onActivate", async () => {
    setup = await testRender(
      () => (
        <GroupHeader
          label="testgroup"
          count={3}
          collapsed={false}
          selected={false}
          members={[]}
        />
      ),
      { width: 80, height: 3 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(3, 0);
  });

  it("right-click fires onContextMenu, not onActivate", async () => {
    let activateCalls = 0;
    let contextMenuCalls = 0;
    let lastX = -1;
    let lastY = -1;
    setup = await testRender(
      () => (
        <GroupHeader
          label="testgroup"
          count={3}
          collapsed={false}
          selected={false}
          members={[]}
          onActivate={() => {
            activateCalls++;
          }}
          onContextMenu={(event) => {
            contextMenuCalls++;
            lastX = event.x;
            lastY = event.y;
          }}
        />
      ),
      { width: 80, height: 3 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(4, 0, MouseButtons.RIGHT);

    expect(contextMenuCalls).toBe(1);
    expect(activateCalls).toBe(0);
    expect(lastX).toBe(4);
    expect(lastY).toBe(0);
  });

  it("left-click does not fire onContextMenu", async () => {
    let activateCalls = 0;
    let contextMenuCalls = 0;
    setup = await testRender(
      () => (
        <GroupHeader
          label="testgroup"
          count={3}
          collapsed={false}
          selected={false}
          members={[]}
          onActivate={() => {
            activateCalls++;
          }}
          onContextMenu={() => {
            contextMenuCalls++;
          }}
        />
      ),
      { width: 80, height: 3 },
    );
    await setup.renderOnce();
    await setup.mockMouse.click(3, 0, MouseButtons.LEFT);

    expect(activateCalls).toBe(1);
    expect(contextMenuCalls).toBe(0);
  });
});
