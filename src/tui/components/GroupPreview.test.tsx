import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { GroupPreview } from "./GroupPreview";
import { TickContext } from "../store";
import {
  mockEnrichedSession,
  emptySummary,
  membersFromSummary,
} from "./test-helpers";
import type { StatusSummary } from "../utils/grouping";
import type { EnrichedSession } from "../../types";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderGroupPreview(
  header: { label: string; count: number; statusSummary: StatusSummary },
  sessions: EnrichedSession[],
) {
  const [tick] = createSignal(0);
  const headerProps = {
    label: header.label,
    count: header.count,
    members: membersFromSummary(header.statusSummary),
  };
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <GroupPreview header={headerProps} sessions={sessions} width={40} />
      </TickContext.Provider>
    ),
    { width: 100, height: 20 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("GroupPreview", () => {
  it("renders group label and session count", async () => {
    const frame = await renderGroupPreview(
      {
        label: "ccmux",
        count: 4,
        statusSummary: { ...emptySummary(), idle: 4 },
      },
      [],
    );
    expect(frame).toContain("ccmux");
    expect(frame).toContain("(4 sessions)");
  });

  it("shows working count when > 0", async () => {
    const frame = await renderGroupPreview(
      {
        label: "proj",
        count: 3,
        statusSummary: { ...emptySummary(), working: 2 },
      },
      [],
    );
    expect(frame).toContain("2 working");
  });

  it("hides working when 0", async () => {
    const frame = await renderGroupPreview(
      {
        label: "proj",
        count: 3,
        statusSummary: { ...emptySummary(), idle: 3 },
      },
      [],
    );
    expect(frame).not.toContain("working");
  });

  it("shows idle summary", async () => {
    const frame = await renderGroupPreview(
      {
        label: "proj",
        count: 3,
        statusSummary: { ...emptySummary(), idle: 3 },
      },
      [],
    );
    expect(frame).toContain("3 idle");
  });

  it("lists the group's worktree sessions with branch and status", async () => {
    // A repo's sessions group together regardless of which checkout they run
    // in, so the preview otherwise never says they sit in different trees.
    const sessions = [
      mockEnrichedSession({
        id: "s1",
        tmuxTarget: "dev:1",
        cwd: "/Users/test/Code/ccmux",
      }),
      mockEnrichedSession({
        id: "s2",
        tmuxTarget: "dev:2",
        cwd: "/Users/test/Code/ccmux/.claude/worktrees/parking",
        gitBranch: "feat/parking",
        isWorktree: true,
        status: "working",
      }),
    ];
    const frame = await renderGroupPreview(
      {
        label: "ccmux",
        count: 2,
        statusSummary: { ...emptySummary(), idle: 1, working: 1 },
      },
      sessions,
    );
    expect(frame).toContain("Worktrees");
    expect(frame).toContain("parking");
    expect(frame).toContain("feat/parking");
  });

  it("names a worktree from its root, not a pane sitting in a subdirectory", async () => {
    const frame = await renderGroupPreview(
      {
        label: "ccmux",
        count: 1,
        statusSummary: { ...emptySummary(), idle: 1 },
      },
      [
        mockEnrichedSession({
          id: "s1",
          tmuxTarget: "dev:1",
          cwd: "/Users/test/Code/ccmux/.claude/worktrees/parking/src/tui",
          worktreeRoot: "/Users/test/Code/ccmux/.claude/worktrees/parking",
          gitBranch: "feat/parking",
          isWorktree: true,
        }),
      ],
    );
    const worktreeLine = frame
      .split("\n")
      .find((l) => l.includes("feat/parking"))!;
    expect(worktreeLine).toContain("parking");
    expect(worktreeLine).not.toContain(" tui ");
  });

  it("counts two sessions in one worktree as one worktree", async () => {
    // A heading that says "Worktrees" over two identical lines reads as two
    // worktrees; the count carries the second session instead.
    const inParking = {
      cwd: "/Users/test/Code/ccmux/.claude/worktrees/parking",
      worktreeRoot: "/Users/test/Code/ccmux/.claude/worktrees/parking",
      gitBranch: "feat/parking",
      isWorktree: true,
    };
    const frame = await renderGroupPreview(
      {
        label: "ccmux",
        count: 2,
        statusSummary: { ...emptySummary(), idle: 1, waitingPermission: 1 },
      },
      [
        mockEnrichedSession({ id: "s1", tmuxTarget: "dev:1", ...inParking }),
        mockEnrichedSession({
          id: "s2",
          tmuxTarget: "dev:2",
          status: "waiting",
          attentionType: "permission",
          ...inParking,
        }),
      ],
    );
    const worktreeLines = frame
      .split("\n")
      .filter((l) => l.includes("feat/parking"));
    expect(worktreeLines).toHaveLength(1);
    expect(worktreeLines[0]).toContain("×2");
  });

  it("does not repeat the worktree marker on each session line", async () => {
    // The Worktrees block is the one place worktree context renders now.
    const frame = await renderGroupPreview(
      {
        label: "ccmux",
        count: 1,
        statusSummary: { ...emptySummary(), idle: 1 },
      },
      [
        mockEnrichedSession({
          id: "s1",
          tmuxTarget: "dev:1",
          cwd: "/Users/test/Code/ccmux/.claude/worktrees/parking",
          worktreeRoot: "/Users/test/Code/ccmux/.claude/worktrees/parking",
          gitBranch: "feat/parking",
          isWorktree: true,
        }),
      ],
    );
    expect(frame).toContain("Worktrees");
    expect(frame).not.toContain("(worktree)");
  });

  it("omits the worktree list when the group has no worktree sessions", async () => {
    const frame = await renderGroupPreview(
      {
        label: "ccmux",
        count: 1,
        statusSummary: { ...emptySummary(), idle: 1 },
      },
      [mockEnrichedSession({ id: "s1", tmuxTarget: "dev:1" })],
    );
    expect(frame).not.toContain("Worktrees");
  });

  it("renders session rows with tmux targets", async () => {
    const sessions = [
      mockEnrichedSession({
        id: "s1",
        tmuxTarget: "dev:1",
        lastActivityAt: "2024-01-15T12:00:00Z",
      }),
      mockEnrichedSession({
        id: "s2",
        tmuxTarget: "dev:2",
        lastActivityAt: "2024-01-15T12:00:00Z",
      }),
    ];
    const frame = await renderGroupPreview(
      {
        label: "proj",
        count: 2,
        statusSummary: { ...emptySummary(), idle: 2 },
      },
      sessions,
    );
    expect(frame).toContain("dev:1");
    expect(frame).toContain("dev:2");
  });
});
