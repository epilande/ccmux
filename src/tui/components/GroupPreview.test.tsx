import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { RGBA } from "@opentui/core";
import { TEXT_ROLES } from "../text-roles";
import {
  GroupPreview,
  inventoryEntries,
  repositoryLines,
} from "./GroupPreview";
import { TickContext } from "../store";
import {
  mockEnrichedSession,
  emptySummary,
  membersFromSummary,
  expectContentSizedThumb,
  findScrollBoxes,
  scrollbarThumb,
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

describe("GroupPreview scrollbar thumb", () => {
  const sessionsOf = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      mockEnrichedSession({ id: `s${i}`, tmuxTarget: `dev:${i}` }),
    );

  async function mount(sessions: () => EnrichedSession[], height: number) {
    const [tick] = createSignal(0);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <GroupPreview
            header={{
              label: "proj",
              count: sessions().length,
              members: membersFromSummary({
                ...emptySummary(),
                idle: sessions().length,
              }),
            }}
            sessions={sessions()}
            width={40}
          />
        </TickContext.Provider>
      ),
      { width: 40, height },
    );
  }

  /** Two passes: one lays out and fires the resize listeners, one draws. */
  async function frame() {
    await setup.renderOnce();
    await setup.renderOnce();
    const [box] = findScrollBoxes(setup.renderer);
    return { frame: setup.captureCharFrame(), box: box! };
  }

  it("sizes the thumb to the session list on first render", async () => {
    await mount(() => sessionsOf(6), 20);
    const f = await frame();
    expectContentSizedThumb(f.frame, f.box);
  });

  it("follows the session list as it grows past the viewport", async () => {
    const [sessions, setSessions] = createSignal(sessionsOf(1));
    await mount(sessions, 20);
    let f = await frame();
    expect(scrollbarThumb(f.frame, f.box).expected).toBe(0);
    setSessions(sessionsOf(20));
    f = await frame();
    expectContentSizedThumb(f.frame, f.box);
  });

  it("re-sizes across a resize round trip", async () => {
    await mount(() => sessionsOf(6), 60);
    let f = await frame();
    expect(scrollbarThumb(f.frame, f.box).expected).toBe(0);
    setup.resize(40, 20);
    f = await frame();
    const small = expectContentSizedThumb(f.frame, f.box);
    setup.resize(40, 60);
    f = await frame();
    expect(scrollbarThumb(f.frame, f.box)).toEqual({ drawn: 0, expected: 0 });
    setup.resize(40, 20);
    f = await frame();
    expect(expectContentSizedThumb(f.frame, f.box)).toBe(small);
  });
});

describe("GroupPreview long paths", () => {
  it("cuts a long path with an ellipsis instead of clipping it", async () => {
    // 40% of 100 columns: the detail line has about 32 to draw in.
    const frame = await renderGroupPreview(
      {
        label: "repo",
        count: 1,
        statusSummary: { ...emptySummary(), idle: 1 },
      },
      [
        mockEnrichedSession({
          id: "s1",
          cwd: "/very/long/path/to/a/project/that/does/not/fit/the/preview",
          gitBranch: "feature/branch",
        }),
      ],
    );
    const line = frame.split("\n").find((l) => l.includes("/very/long"))!;
    expect(line).toContain("…");
    expect(line).not.toContain("feature/branch");
  });
});

describe("GroupPreview repository facts", () => {
  const facts = {
    repoRoot: "/code/ccmux",
    repoName: "ccmux",
    worktrees: {
      value: {
        repoRoot: "/code/ccmux",
        repoName: "ccmux",
        worktrees: [
          { path: "/code/ccmux", branch: "main", isMain: true },
          { path: "/code/wt/previews", branch: "feat/previews", isMain: false },
          { path: "/code/wt/idle", branch: "chore/idle", isMain: false },
        ],
      },
      updatedAt: 0,
      stale: false,
    },
    counts: { value: { prs: 4, issues: 1 }, updatedAt: 0, stale: true },
    branchPRs: {
      "feat/previews": {
        value: [
          {
            id: "206",
            href: "https://github.com/o/r/pull/206",
            ciStatus: "failing" as const,
            reviewDecision: null,
          },
        ],
        updatedAt: 0,
        stale: false,
      },
    },
  };
  const sessions = [
    mockEnrichedSession({
      id: "s1",
      worktreeRoot: "/code/wt/previews",
      mainRepoRoot: "/code/ccmux",
      isWorktree: true,
      status: "waiting",
    }),
  ];

  it("words the repo's facts, marking a stale answer", () => {
    expect(repositoryLines(facts)).toEqual([
      "main + 2 worktrees",
      "4 open PRs · 1 open issue ~",
    ]);
    expect(repositoryLines(undefined)).toEqual([]);
  });

  it("lists every checkout, idle ones included, with its PR and sessions", () => {
    const entries = inventoryEntries(facts, sessions);
    expect(entries.map((e) => [e.name, e.branch, e.count])).toEqual([
      ["⌂ main", "main", 0],
      ["previews", "feat/previews", 1],
      ["idle", "chore/idle", 0],
    ]);
    expect(entries[1]!.prs.map((p) => p.id)).toEqual(["206"]);
    expect(inventoryEntries(facts, sessions, false)[1]!.prs).toEqual([]);
  });

  it("draws the Repository block and the inventory for a repo header", async () => {
    const [tick] = createSignal(0);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <GroupPreview
            header={{
              label: "ccmux",
              count: 1,
              members: membersFromSummary({
                ...emptySummary(),
                waitingGeneric: 1,
              }),
              repoRoot: "/code/ccmux",
            }}
            sessions={sessions}
            facts={[facts]}
            width={60}
          />
        </TickContext.Provider>
      ),
      { width: 100, height: 20 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Repository");
    expect(frame).toContain("main + 2 worktrees");
    expect(frame).toContain("previews  feat/previews  PR #206 ✗");
    // The idle checkout is listed too: the inventory, not just where
    // sessions happen to be.
    expect(frame).toContain("idle  chore/idle");
  });
});

describe("GroupPreview renamed and merged groups", () => {
  async function render(header: {
    label: string;
    groupKey: string;
    rawKeys?: string[];
  }) {
    const [tick] = createSignal(0);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick }}>
          <GroupPreview
            header={{
              ...header,
              count: 2,
              members: membersFromSummary({ ...emptySummary(), idle: 2 }),
            }}
            sessions={[]}
            width={40}
          />
        </TickContext.Provider>
      ),
      { width: 100, height: 20 },
    );
    await setup.renderOnce();
    return setup.captureCharFrame();
  }

  it("lists the raw keys a merged group folds together, dimmed under its name", async () => {
    const frame = await render({
      label: "ProjectX",
      groupKey: "ProjectX",
      rawKeys: ["px-api", "px-infra", "px-web"],
    });
    const lines = frame.split("\n");
    const name = lines.findIndex((l) => l.includes("ProjectX"));
    expect(lines[name + 1]).toContain("3 sources: px-api · px-infra · px-web");
    const span = setup
      .captureSpans()
      .lines.flatMap((l) => l.spans)
      .find((s) => s.text.includes("3 sources"));
    // Dimmed as far as the theme allows while still reading at 4.5:1.
    expect(span?.fg.toInts()).toEqual(
      RGBA.fromHex(TEXT_ROLES.groupSources.fg()).toInts(),
    );
  });

  it("names the key a renamed group came from", async () => {
    const frame = await render({
      label: "Backend",
      groupKey: "Backend",
      rawKeys: ["beta"],
    });
    expect(frame).toContain("renamed from beta");
  });

  it("adds nothing for a group under its own name", async () => {
    const frame = await render({
      label: "alpha",
      groupKey: "alpha",
      rawKeys: ["alpha"],
    });
    expect(frame).not.toContain("renamed from");
    expect(frame).not.toContain("sources");
  });

  it("cuts a long sources line to the pane", async () => {
    const frame = await render({
      label: "Big",
      groupKey: "Big",
      rawKeys: Array.from({ length: 12 }, (_, i) => `repository-${i}`),
    });
    const line = frame.split("\n").find((l) => l.includes("12 sources"))!;
    expect(line).toContain("…");
  });
});
