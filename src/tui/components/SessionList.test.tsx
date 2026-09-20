import { describe, it, expect, afterEach, spyOn } from "bun:test";
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
import { buildFlatItems, type FlatItem } from "../utils/grouping";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
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

describe("SessionList worktree counts", () => {
  async function renderSettled() {
    // Drain fetch/json continuations before capturing the rendered facts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup.renderOnce();
  }

  const rows = (roots: string[]) =>
    roots.map((root, index) => ({
      session: mockEnrichedSession({
        id: root,
        project: `project-${index}`,
        cwd: root,
        mainRepoRoot: root,
        tmuxTarget: "dev:1.0",
      }),
      highlights: null,
    }));

  it("renders scoped metadata counts and refreshes only on scope or connection changes", async () => {
    const [sessions, setSessions] = createSignal(rows(["/code/a", "/code/b"]));
    const [connection, setConnection] = createSignal("connected");
    const requests: URL[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: string | URL | Request,
    ) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      requests.push(url);
      return Response.json({
        repos: url.searchParams
          .getAll("repo")
          .map((repoRoot) => ({ repoRoot, hasMain: true, linked: 2 })),
      });
    }) as unknown as typeof fetch);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <SessionList
            items={buildFlatItems(sessions(), "project", new Set(), false)}
            selectedIndex={0}
            previewWidth={30}
            connectionState={connection()}
          />
        </TickContext.Provider>
      ),
      { width: 120, height: 20 },
    );
    await renderSettled();
    expect(requests).toHaveLength(1);
    expect(requests[0].pathname).toBe("/worktrees/counts");
    expect(requests[0].searchParams.getAll("repo")).toEqual([
      "/code/a",
      "/code/b",
    ]);
    expect(setup.captureCharFrame()).toContain("main + 2 worktrees");

    setSessions(rows(["/code/a", "/code/b"]));
    await renderSettled();
    expect(requests).toHaveLength(1);
    setSessions(rows(["/code/a"]));
    await renderSettled();
    expect(requests).toHaveLength(2);
    expect(requests[1].searchParams.getAll("repo")).toEqual(["/code/a"]);
    setConnection("disconnected");
    await renderSettled();
    expect(setup.captureCharFrame()).not.toContain("main + 2 worktrees");
    setConnection("connected");
    await renderSettled();
    expect(requests).toHaveLength(3);
    expect(setup.captureCharFrame()).toContain("main + 2 worktrees");
  });

  it("does not request facts for cwd, tmux, mixed-repo, or attention-only headers", async () => {
    const [items, setItems] = createSignal<FlatItem[]>([]);
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ repos: [] }),
    );
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <SessionList
            items={items()}
            selectedIndex={0}
            previewWidth={30}
            connectionState="connected"
          />
        </TickContext.Provider>
      ),
      { width: 120, height: 20 },
    );
    for (const groupBy of ["cwd", "session", "window", "none"] as const) {
      setItems(buildFlatItems(rows(["/code/a"]), groupBy, new Set(), false));
      await renderSettled();
    }
    setItems(
      buildFlatItems(
        rows(["/code/a"]).map((row) => ({
          ...row,
          session: { ...row.session, status: "waiting" },
        })),
        "project",
        new Set(),
        false,
      ),
    );
    await renderSettled();
    setItems(
      buildFlatItems(
        rows(["/code/a", "/code/b"]).map((row) => ({
          ...row,
          session: { ...row.session, project: "same-name" },
        })),
        "project",
        new Set(),
        false,
      ),
    );
    await renderSettled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aborts obsolete reads and prevents stale counts from replacing a new answer", async () => {
    const [sessions, setSessions] = createSignal(rows(["/code/a", "/code/b"]));
    const pending: Array<{
      response: ReturnType<typeof Promise.withResolvers<Response>>;
      signal?: AbortSignal | null;
    }> = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const response = Promise.withResolvers<Response>();
      pending.push({ response, signal: init?.signal });
      return response.promise;
    }) as unknown as typeof fetch);
    setup = await testRender(
      () => (
        <TickContext.Provider value={{ tick: () => 0 }}>
          <SessionList
            items={buildFlatItems(sessions(), "project", new Set(), false)}
            selectedIndex={0}
            previewWidth={30}
            connectionState="connected"
          />
        </TickContext.Provider>
      ),
      { width: 120, height: 20 },
    );
    await renderSettled();
    setSessions(rows(["/code/a"]));
    await renderSettled();
    expect(pending).toHaveLength(2);
    expect(pending[0].signal?.aborted).toBe(true);
    pending[1].response.resolve(
      Response.json({
        repos: [{ repoRoot: "/code/a", hasMain: true, linked: 2 }],
      }),
    );
    await renderSettled();
    expect(setup.captureCharFrame()).toContain("main + 2 worktrees");
    pending[0].response.resolve(
      Response.json({
        repos: [{ repoRoot: "/code/a", hasMain: true, linked: 99 }],
      }),
    );
    await renderSettled();
    expect(setup.captureCharFrame()).toContain("main + 2 worktrees");
    expect(setup.captureCharFrame()).not.toContain("99 worktrees");
  });
});

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

/** Empty-list render with a socket diagnostic in play. */
async function renderEmptyWithSocketError(
  socketError: import("../../types").TmuxSocketError | null,
) {
  const [tick] = createSignal(0);
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <SessionList
          items={[]}
          selectedIndex={0}
          previewWidth={30}
          socketError={socketError}
        />
      </TickContext.Provider>
    ),
    { width: 80, height: 20 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("SessionList", () => {
  it("renders empty state message", async () => {
    const frame = await renderList([]);
    expect(frame).toContain("No sessions found");
  });

  it("replaces the empty state with the unreachable-server diagnostic", async () => {
    // "No sessions found" would report a misaimed socket as an absence of
    // agents, which is the whole reason the reporter in #95 saw nothing.
    const frame = await renderEmptyWithSocketError({
      attemptedSocket: "/private/tmp/tmux-501/work",
      message: "no server running",
    });
    expect(frame).toContain("tmux server unreachable at");
    expect(frame).toContain("/private/tmp/tmux-501/work");
    expect(frame).not.toContain("No sessions found");
  });

  it("keeps the plain empty state when the server is reachable", async () => {
    const frame = await renderEmptyWithSocketError(null);
    expect(frame).toContain("No sessions found");
    expect(frame).not.toContain("unreachable");
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
