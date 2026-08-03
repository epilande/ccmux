import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testRender } from "@opentui/solid";
import { createMockKeys } from "@opentui/core/testing";
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
    ignoredFiles: [],
    ignoredDirs: [],
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

    expect(frame).toContain("Prune worktrees");
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

/**
 * Keyboard behaviour. These are the interactions that decide whether
 * uncommitted work is deleted, so they are driven through real key events
 * rather than by calling the handlers directly.
 */
describe("PruneDialog keys", () => {
  const clean = candidate({ path: "/repo/wt/clean", name: "clean" });
  const dirty = candidate({
    path: "/repo/wt/dirty",
    name: "dirty",
    dirty: true,
    untracked: 1,
  });

  async function renderWithKeys(
    scan: PruneScan,
    opts: { compact?: boolean; onClose?: () => void } = {},
  ) {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify(scan), {
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );
    setup = await testRender(
      () => (
        <PruneDialog
          repo={null}
          compact={opts.compact}
          onClose={opts.onClose ?? (() => {})}
        />
      ),
      { width: 90, height: 20 },
    );
    await setup.renderOnce();
    await Promise.resolve();
    await setup.renderOnce();
    const keys = createMockKeys(setup.renderer);
    return {
      keys,
      frame: async () => {
        await setup!.renderOnce();
        return setup!.captureCharFrame();
      },
    };
  }

  it("selects with space and counts it", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [clean],
      skipped: [],
    });

    keys.pressKey(" ");
    expect(await frame()).toContain("enter prune 1");
  });

  // Space alone must never arm a dirty row: that is the whole gate.
  it("does not count a dirty row selected with space alone", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [dirty],
      skipped: [],
    });

    keys.pressKey(" ");
    const shown = await frame();
    expect(shown).toContain("[x]");
    expect(shown).toContain("enter prune 0");
  });

  it("arms a dirty row with D and disarms it again", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [dirty],
      skipped: [],
    });

    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("enter prune 1");
    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("enter prune 0");
  });

  // Lowercase `d` used to opt in AND auto-select, putting deletion of
  // uncommitted work three keystrokes from the cursor on a vim operator key.
  it("ignores lowercase d", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [dirty],
      skipped: [],
    });

    keys.pressKey("d");
    const shown = await frame();
    expect(shown).toContain("[ ]");
    expect(shown).toContain("enter prune 0");
  });

  it("selects only clean rows with a", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [clean, dirty],
      skipped: [],
    });

    keys.pressKey("a");
    expect(await frame()).toContain("enter prune 1");
  });

  // A dirty opt-in must not outlive the selection that carried it.
  it("clears a dirty opt-in when a deselects everything", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [dirty],
      skipped: [],
    });

    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("enter prune 1");
    keys.pressKey("a"); // deselects: the only row is dirty
    expect(await frame()).toContain("enter prune 0");
    keys.pressKey(" "); // reselect by hand, with no fresh D
    expect(await frame()).toContain("enter prune 0");
  });

  it("drops the opt-in when the row is deselected directly", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [dirty],
      skipped: [],
    });

    keys.pressKey("D", { shift: true });
    keys.pressKey(" "); // deselect
    keys.pressKey(" "); // reselect
    expect(await frame()).toContain("enter prune 0");
  });

  it("names the destructive case at the confirmation step", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [dirty],
      skipped: [],
    });

    keys.pressKey("D", { shift: true });
    keys.pressEnter();
    expect(await frame()).toContain("INCLUDING 1 with uncommitted work");
  });

  it("does not advance to confirm with nothing effective", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [dirty],
      skipped: [],
    });

    keys.pressKey(" ");
    keys.pressEnter();
    const shown = await frame();
    expect(shown).not.toContain("y / n");
    expect(shown).toContain("enter prune 0");
  });

  it("backs out of confirm with n", async () => {
    const { keys, frame } = await renderWithKeys({
      candidates: [clean],
      skipped: [],
    });

    keys.pressKey(" ");
    keys.pressEnter();
    expect(await frame()).toContain("y / n");
    keys.pressKey("n");
    expect(await frame()).toContain("enter prune 1");
  });

  it("closes on q", async () => {
    let closed = 0;
    const { keys } = await renderWithKeys(
      { candidates: [clean], skipped: [] },
      { onClose: () => closed++ },
    );

    keys.pressKey("q");
    expect(closed).toBe(1);
  });

  it("keeps the live count visible in compact mode", async () => {
    const { keys, frame } = await renderWithKeys(
      { candidates: [clean], skipped: [] },
      { compact: true },
    );

    const before = await frame();
    expect(before).toContain("enter 0");
    keys.pressKey(" ");
    expect(await frame()).toContain("enter 1");
  });
});

/**
 * A ~40-column sidebar truncates from the right, so the compact layout puts
 * the dirty warning on its own line. Sharing one with the reason cut the
 * warning in half and lost the only text explaining why the row is held back.
 */
describe("PruneDialog compact layout", () => {
  const dirty = candidate({
    dirty: true,
    untracked: 1,
    detail: "merged into origin/main",
  });

  it("keeps the whole dirty warning readable at sidebar width", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ candidates: [dirty], skipped: [] }), {
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch,
    );
    setup = await testRender(
      () => <PruneDialog repo={null} compact onClose={() => {}} />,
      { width: 44, height: 16 },
    );
    await setup.renderOnce();
    await Promise.resolve();
    await setup.renderOnce();

    const frame = setup.captureCharFrame();
    expect(frame).toContain("DIRTY, press D to include");
    expect(frame).toContain("merged into origin/main");
  });
});
