import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testRender } from "@opentui/solid";
import type { WorktreeRow } from "../../daemon/worktree-list";
import type { WorktreeDetail } from "../../daemon/worktree-detail";
import { theme } from "../theme";
import { NEWER_DAEMON_NEEDED } from "../utils/detail-fetch";
import { mockEnrichedSession } from "./test-helpers";
import { changeColor, trackingText, WorktreePreview } from "./WorktreePreview";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

const row = (overrides: Partial<WorktreeRow> = {}): WorktreeRow => ({
  path: "/repo/wt/parking",
  name: "parking",
  repoRoot: "/repo",
  repoName: "repo",
  branch: "feat/parking",
  tip: "sha",
  detached: false,
  isMain: false,
  locked: false,
  dirty: { dirty: true, modified: 1, untracked: 1 },
  upstream: {
    upstream: "origin/feat/parking",
    gone: false,
    ahead: 2,
    behind: 0,
  },
  sessions: [
    {
      id: "s1",
      agentType: "claude",
      status: "waiting",
      tmuxPane: "%1",
      tmuxTarget: "work:1.0",
      pid: 1,
    },
  ],
  ...overrides,
});

const detail: WorktreeDetail = {
  path: "/repo/wt/parking",
  changes: [
    { code: " M", path: "src/park.ts" },
    { code: "??", path: "notes.md" },
  ],
  total: 2,
  truncated: false,
  commits: [
    {
      sha: "abc1234",
      subject: "feat: park the renderer",
      date: "2026-10-30T12:00:00Z",
    },
  ],
};

function answer(body: unknown, status = 200) {
  const asked: string[] = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: unknown,
  ) => {
    asked.push(String(input));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch);
  return asked;
}

async function render(target = row()) {
  setup = await testRender(
    () => (
      <WorktreePreview
        target={{
          row: target,
          facts: [{ text: "PR #206 ✓", fg: theme.green }],
        }}
        width={50}
        sessionById={(id) =>
          id === "s1"
            ? mockEnrichedSession({ id: "s1", summary: "Parking the renderer" })
            : undefined
        }
      />
    ),
    { width: 120, height: 30 },
  );
  await setup.renderOnce();
}

const settle = async () => {
  await new Promise((r) => setTimeout(r, 160));
  await setup!.renderOnce();
  return setup!.captureCharFrame();
};

describe("WorktreePreview", () => {
  it("paints the header from the row at once, before the read lands", async () => {
    answer({ ok: true, detail });
    await render();
    const frame = setup!.captureCharFrame();
    expect(frame).toContain("parking");
    expect(frame).toContain("feat/parking");
    expect(frame).toContain("↑2 origin/feat/parking");
    expect(frame).toContain("PR #206 ✓");
    expect(frame).toContain("Loading…");
  });

  it("lists changes, recent commits and the sessions there", async () => {
    const asked = answer({ ok: true, detail });
    await render();
    const frame = await settle();
    expect(asked[0]).toContain("/worktrees/detail?path=%2Frepo%2Fwt%2Fparking");
    expect(frame).toContain("Changes (2)");
    expect(frame).toContain("src/park.ts");
    expect(frame).toContain("notes.md");
    expect(frame).toContain("Recent commits");
    expect(frame).toContain("abc1234 feat: park the renderer");
    expect(frame).toContain("Sessions (1)");
    expect(frame).toContain("work:1.0 · Claude · Parking the renderer");
    // Changes come before the sessions however late they load.
    expect(frame.indexOf("Changes (2)")).toBeLessThan(
      frame.indexOf("Sessions (1)"),
    );
  });

  it("says when the daemon predates the route", async () => {
    answer({ error: "Not found" }, 404);
    await render();
    expect(await settle()).toContain(NEWER_DAEMON_NEEDED);
  });

  it("names the main checkout as such", async () => {
    answer({ ok: true, detail: { ...detail, changes: [], total: 0 } });
    await render(row({ isMain: true, name: "repo", branch: "main" }));
    const frame = await settle();
    expect(frame).toContain("⌂ main checkout");
    expect(frame).toContain("No uncommitted changes");
  });
});

describe("worktree preview helpers", () => {
  it("colors a status code by what happened to the file", () => {
    expect(changeColor("??")).toBe(theme.overlay);
    expect(changeColor(" D")).toBe(theme.red);
    expect(changeColor("A ")).toBe(theme.green);
    expect(changeColor(" M")).toBe(theme.yellow);
  });

  it("words the upstream", () => {
    expect(trackingText(row())).toBe("↑2 origin/feat/parking");
    expect(
      trackingText(
        row({
          upstream: { upstream: "origin/x", gone: true, ahead: 0, behind: 0 },
        }),
      ),
    ).toBe("origin/x gone");
    expect(trackingText(row({ upstream: null }))).toBe("");
  });
});
