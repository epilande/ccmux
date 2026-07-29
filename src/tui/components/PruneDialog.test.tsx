import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testRender } from "@opentui/solid";
import type { PruneCandidate, PruneScan } from "../../daemon/worktree-prune";
import { PruneDialog, partitionSelection } from "./PruneDialog";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  // spyOn + mockRestore rather than mock.module: module mocks leak across
  // test files in Bun and take the whole suite down with them.
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

function candidate(overrides: Partial<PruneCandidate> = {}): PruneCandidate {
  return {
    path: "/repo/wt/feature",
    repoRoot: "/repo",
    repoName: "repo",
    name: "feature",
    branch: "feat/x",
    reason: "pr-merged",
    detail: "PR #68 merged",
    pr: null,
    dirty: false,
    modified: 0,
    untracked: 0,
    branchDeletion: "force",
    adminDir: null,
    sessions: [],
    ...overrides,
  };
}

async function renderDialog(scan: PruneScan) {
  // Bun's `fetch` type carries a `preconnect` property a plain function can't
  // satisfy; the dialog only ever calls it, so the cast is the whole gap.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (async () =>
      new Response(JSON.stringify(scan), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
  );
  setup = await testRender(
    () => <PruneDialog repo={null} onClose={() => {}} />,
    {
      width: 90,
      height: 20,
    },
  );
  await setup.renderOnce();
  // The candidate list arrives from an awaited fetch, so one more frame is
  // needed after the promise resolves.
  await Promise.resolve();
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("PruneDialog", () => {
  it("lists each candidate with its reason", async () => {
    const frame = await renderDialog({
      candidates: [
        candidate(),
        candidate({
          path: "/repo/wt/old",
          name: "old",
          branch: "feat/old",
          reason: "upstream-gone",
          detail: "upstream origin/feat/old is gone",
          branchDeletion: "safe",
        }),
      ],
      skipped: [],
    });

    expect(frame).toContain("Prune Worktrees");
    expect(frame).toContain("repo/feature");
    expect(frame).toContain("PR #68 merged");
    expect(frame).toContain("repo/old");
    expect(frame).toContain("upstream origin/feat/old is gone");
  });

  it("flags a dirty candidate and tells the user how to include it", async () => {
    const frame = await renderDialog({
      candidates: [candidate({ dirty: true, modified: 2, untracked: 1 })],
      skipped: [],
    });

    expect(frame).toContain("DIRTY 2m/1u");
    expect(frame).toContain("press D to include");
  });

  it("shows the sessions a removal would take down", async () => {
    const frame = await renderDialog({
      candidates: [
        candidate({
          sessions: [
            {
              id: "s1",
              agentType: "claude",
              status: "idle",
              tmuxPane: "%1",
              tmuxTarget: "w:0.1",
              pid: 1,
            },
          ],
        }),
      ],
      skipped: [],
    });

    expect(frame).toContain("claude idle");
  });

  it("reports withheld worktrees without listing them as candidates", async () => {
    const frame = await renderDialog({
      candidates: [],
      skipped: [
        {
          path: "/repo/wt/busy",
          repoRoot: "/repo",
          branch: "feat/busy",
          reason: "an agent is working here",
        },
      ],
    });

    expect(frame).toContain("No worktrees are ready to prune.");
    expect(frame).toContain("1 not offered");
  });

  it("starts with nothing selected", async () => {
    const frame = await renderDialog({
      candidates: [candidate()],
      skipped: [],
    });

    expect(frame).toContain("[ ]");
    expect(frame).not.toContain("[x]");
    expect(frame).toContain("enter prune 0");
  });
});

describe("partitionSelection", () => {
  const clean = candidate({ path: "/a" });
  const dirty = candidate({ path: "/b", dirty: true, untracked: 1 });

  it("removes a selected clean worktree", () => {
    const { removable, blockedDirty } = partitionSelection(
      [clean],
      new Set(["/a"]),
      new Set(),
    );
    expect(removable.map((c) => c.path)).toEqual(["/a"]);
    expect(blockedDirty).toEqual([]);
  });

  // Selecting a dirty row is not enough on its own — this is the gate that
  // keeps uncommitted work from riding along with a bulk selection.
  it("holds back a selected dirty worktree with no opt-in", () => {
    const { removable, blockedDirty } = partitionSelection(
      [clean, dirty],
      new Set(["/a", "/b"]),
      new Set(),
    );
    expect(removable.map((c) => c.path)).toEqual(["/a"]);
    expect(blockedDirty.map((c) => c.path)).toEqual(["/b"]);
  });

  it("removes a dirty worktree once it carries its own opt-in", () => {
    const { removable, blockedDirty } = partitionSelection(
      [dirty],
      new Set(["/b"]),
      new Set(["/b"]),
    );
    expect(removable.map((c) => c.path)).toEqual(["/b"]);
    expect(blockedDirty).toEqual([]);
  });

  it("ignores an opt-in for a row that was never selected", () => {
    const { removable, blockedDirty } = partitionSelection(
      [dirty],
      new Set(),
      new Set(["/b"]),
    );
    expect(removable).toEqual([]);
    expect(blockedDirty).toEqual([]);
  });
});
