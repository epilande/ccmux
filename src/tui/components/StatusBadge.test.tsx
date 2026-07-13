import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { StatusBadge, getStatusColor } from "./StatusBadge";
import { theme } from "../theme";
import type { AttentionState } from "../../types";
import { mockSession } from "./test-helpers";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderBadge(props: {
  status?: "idle" | "working" | "waiting";
  attentionType?: "permission" | "plan_approval" | null;
  attentionState?: AttentionState;
  mode?: "icon" | "short" | "full";
  iconStyle?: "dot" | "none";
  dimmed?: boolean;
}) {
  setup = await testRender(
    () => (
      <StatusBadge
        status={props.status ?? "idle"}
        attentionType={props.attentionType ?? null}
        attentionState={props.attentionState}
        mode={props.mode ?? "full"}
        iconStyle={props.iconStyle}
        dimmed={props.dimmed}
      />
    ),
    { width: 20, height: 3 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("StatusBadge", () => {
  it("renders icon only in icon mode", async () => {
    const frame = await renderBadge({ status: "idle", mode: "icon" });
    expect(frame).toContain("●");
    expect(frame).not.toContain("idle");
  });

  it("renders icon and short label in short mode", async () => {
    const frame = await renderBadge({ status: "idle", mode: "short" });
    expect(frame).toContain("● idle");
  });

  it("renders icon and full label in full mode", async () => {
    const frame = await renderBadge({ status: "waiting", mode: "full" });
    expect(frame).toContain("■ waiting");
  });

  it("renders short label truncated to 4 chars", async () => {
    const frame = await renderBadge({ status: "waiting", mode: "short" });
    expect(frame).toContain("■ wait");
    expect(frame).not.toContain("waiting");
  });

  it("renders working status with full label", async () => {
    const frame = await renderBadge({ status: "working", mode: "full" });
    expect(frame).toContain("working");
  });

  it("renders idle status with static dot", async () => {
    const frame = await renderBadge({ status: "idle", mode: "icon" });
    expect(frame).toContain("●");
  });

  it("renders waiting with square icon", async () => {
    const frame = await renderBadge({
      status: "waiting",
      attentionType: "permission",
      mode: "full",
    });
    expect(frame).toContain("■");
    expect(frame).toContain("waiting");
  });

  it("renders waiting icon mode with square", async () => {
    const frame = await renderBadge({
      status: "waiting",
      attentionType: null,
      mode: "icon",
    });
    expect(frame).toContain("■");
  });

  it("renders done label for unread attention state", async () => {
    const frame = await renderBadge({
      status: "idle",
      attentionState: "unread",
      mode: "full",
    });
    expect(frame).toContain("done");
    expect(frame).not.toContain("idle");
  });

  it("renders done label for read attention state", async () => {
    const frame = await renderBadge({
      status: "idle",
      attentionState: "read",
      mode: "full",
    });
    expect(frame).toContain("done");
    expect(frame).not.toContain("idle");
  });

  it("does not show done for working status with attention", async () => {
    const frame = await renderBadge({
      status: "working",
      attentionState: "unread",
      mode: "full",
    });
    expect(frame).toContain("working");
    expect(frame).not.toContain("done");
  });

  it("shows agents (not done) when an idle parent has a working subagent", async () => {
    // Regression: background agents keep working after the parent ends its
    // turn (parent legitimately idle by its own log); the row must render
    // the lifted "agents" state, not the bogus "done"/idle badge.
    const session = mockSession({
      status: "idle",
      attentionState: "unread",
      subagents: [
        {
          agentId: "sub1",
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: null,
        },
      ],
    });
    setup = await testRender(
      () => (
        <StatusBadge
          status={session.status}
          attentionState={session.attentionState}
          session={session}
          mode="full"
        />
      ),
      { width: 20, height: 3 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("agents");
    expect(frame).not.toContain("done");
    expect(frame).not.toContain("idle");
    expect(frame).not.toContain("working");
  });

  it("shows plain working when the lead itself is working, even with subagents", async () => {
    const session = mockSession({
      status: "working",
      subagents: [
        {
          agentId: "sub1",
          status: "working",
          attentionType: null,
          pendingTool: null,
          lastActivityAt: null,
        },
      ],
    });
    setup = await testRender(
      () => (
        <StatusBadge status={session.status} session={session} mode="full" />
      ),
      { width: 20, height: 3 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("working");
    expect(frame).not.toContain("agents");
  });

  it("renders nothing with none icon style", async () => {
    const frame = await renderBadge({
      status: "idle",
      iconStyle: "none",
      mode: "full",
    });
    expect(frame).toContain("idle");
    expect(frame).not.toContain("●");
  });
});

describe("getStatusColor", () => {
  it("returns peach for working", () => {
    expect(getStatusColor("working", null)).toBe(theme.peach);
  });

  it("returns red for waiting permission", () => {
    expect(getStatusColor("waiting", "permission")).toBe(theme.red);
  });

  it("returns teal for waiting plan_approval", () => {
    expect(getStatusColor("waiting", "plan_approval")).toBe(theme.teal);
  });

  it("returns red for generic waiting", () => {
    expect(getStatusColor("waiting", null)).toBe(theme.red);
  });

  it("returns red for waiting question", () => {
    expect(getStatusColor("waiting", "question")).toBe(theme.red);
  });

  it("returns overlay for idle", () => {
    expect(getStatusColor("idle", null)).toBe(theme.overlay);
  });

  it("returns green for idle with unread attention", () => {
    expect(getStatusColor("idle", null, "unread")).toBe(theme.green);
  });

  it("returns green for idle with read attention", () => {
    expect(getStatusColor("idle", null, "read")).toBe(theme.green);
  });
});
