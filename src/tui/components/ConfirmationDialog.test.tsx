import { describe, it, expect, afterEach, mock } from "bun:test";
import { testRender } from "@opentui/solid";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { mockSession } from "./test-helpers";
import type { Session } from "../../types";
import type { ConfirmAction } from "../store";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderDialog(props: {
  session?: Session | null;
  action?: ConfirmAction | null;
  sessionCount?: number;
  groupLabel?: string;
}) {
  setup = await testRender(
    () => (
      <ConfirmationDialog
        session={props.session ?? null}
        action={props.action ?? "kill"}
        sessionCount={props.sessionCount}
        groupLabel={props.groupLabel}
      />
    ),
    { width: 60, height: 15 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("ConfirmationDialog", () => {
  it("shows Kill Session title for kill action", async () => {
    const frame = await renderDialog({
      action: "kill",
      session: mockSession(),
    });
    expect(frame).toContain("Kill Session?");
  });

  it("shows Kill All Sessions title for kill-all", async () => {
    const frame = await renderDialog({ action: "kill-all" });
    expect(frame).toContain("Kill All Sessions?");
  });

  it("shows Kill Group title for kill-group", async () => {
    const frame = await renderDialog({ action: "kill-group" });
    expect(frame).toContain("Kill Group?");
  });

  it("shows Restart Session title for restart", async () => {
    const frame = await renderDialog({
      action: "restart",
      session: mockSession(),
    });
    expect(frame).toContain("Restart Session?");
  });

  it("shows review count and agent for send-review", async () => {
    const frame = await renderDialog({
      action: "send-review",
      session: mockSession({ agentType: "codex" }),
      sessionCount: 2,
    });
    expect(frame).toContain("Send review comments");
    expect(frame).toContain("Send 2 comments to codex?");
  });

  it("shows session project in kill subtitle", async () => {
    const frame = await renderDialog({
      action: "kill",
      session: mockSession({ project: "myapp" }),
    });
    expect(frame).toContain("myapp");
  });

  it("shows session cwd when no project", async () => {
    const frame = await renderDialog({
      action: "kill",
      session: mockSession({ project: "", cwd: "/home/user/code" }),
    });
    expect(frame).toContain("/home/user/code");
  });

  it("shows group label and count for kill-group", async () => {
    const frame = await renderDialog({
      action: "kill-group",
      groupLabel: "ccmux",
      sessionCount: 4,
    });
    expect(frame).toContain("ccmux");
    expect(frame).toContain("4 sessions");
  });

  it("shows count for kill-all", async () => {
    const frame = await renderDialog({
      action: "kill-all",
      sessionCount: 3,
    });
    expect(frame).toContain("3 sessions");
  });

  it("handles singular session count", async () => {
    const frame = await renderDialog({
      action: "kill-all",
      sessionCount: 1,
    });
    expect(frame).toContain("1 session)");
    expect(frame).not.toContain("1 sessions");
  });

  it("handles zero session count", async () => {
    const frame = await renderDialog({
      action: "kill-all",
      sessionCount: 0,
    });
    expect(frame).toContain("0 sessions");
  });

  it("shows Y/N confirmation keys", async () => {
    const frame = await renderDialog({
      action: "kill",
      session: mockSession(),
    });
    expect(frame).toContain("Y");
    expect(frame).toContain("confirm");
    expect(frame).toContain("N");
    expect(frame).toContain("cancel");
  });

  it.each([
    { label: "Y confirm", fires: "onConfirm" as const },
    { label: "N cancel", fires: "onCancel" as const },
  ])("fires $fires when '$label' is clicked", async ({ label, fires }) => {
    const onConfirm = mock(() => {});
    const onCancel = mock(() => {});
    setup = await testRender(
      () => (
        <ConfirmationDialog
          session={mockSession()}
          action="kill"
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ),
      { width: 60, height: 15 },
    );
    await setup.renderOnce();
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((l) => l.includes(label));
    expect(row).toBeGreaterThanOrEqual(0);
    const col = lines[row].indexOf(label);
    await setup.mockMouse.click(col, row);
    if (fires === "onConfirm") {
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    } else {
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    }
  });
});
