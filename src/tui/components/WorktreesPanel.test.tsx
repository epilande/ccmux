import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createSignal } from "solid-js";
import type { RepoFactsResponse } from "../../daemon/repo-facts";
import { testRender } from "@opentui/solid";
import { createMockKeys } from "@opentui/core/testing";
import { deliverEscape } from "./test-helpers";
import type { WorktreeRow } from "../../daemon/worktree-list";
import type {
  PruneCandidate,
  WorktreeSession,
  ScanResponse,
  PruneOutcome,
  PruneRunResult,
} from "../../daemon/worktree-prune";
import {
  WorktreesPanel,
  worktreeHoldsPath,
  clipboardArgv,
  copyToClipboard,
  partitionSelection,
  resetScanCache,
  pruneFullySucceeded,
  cachedScanFor,
} from "./WorktreesPanel";
type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  fetchSpy?.mockRestore();
  resetScanCache();
});
function row(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return {
    path: "/repo/wt/alpha",
    repoRoot: "/repo",
    repoName: "repo",
    name: "alpha",
    branch: "feat/alpha",
    detached: false,
    isMain: false,
    locked: false,
    dirty: { dirty: false, modified: 0, untracked: 0 },
    upstream: {
      upstream: "origin/feat/alpha",
      gone: false,
      ahead: 0,
      behind: 0,
    },
    sessions: [],
    ...overrides,
  };
}

function mainRow(overrides: Partial<WorktreeRow> = {}): WorktreeRow {
  return row({
    path: "/repo",
    name: "main checkout",
    branch: "main",
    isMain: true,
    ...overrides,
  });
}

function session(overrides: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    id: "s1",
    agentType: "claude",
    status: "idle",
    tmuxPane: "%1",
    tmuxTarget: "w:0.1",
    pid: 1,
    ...overrides,
  };
}

function candidate(overrides: Partial<PruneCandidate> = {}): PruneCandidate {
  return {
    path: "/repo/wt/alpha",
    repoRoot: "/repo",
    repoName: "repo",
    name: "alpha",
    branch: "feat/alpha",
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

describe("worktreeHoldsPath", () => {
  it("holds the worktree root itself", () => {
    expect(worktreeHoldsPath("/repo/wt/feature", "/repo/wt/feature")).toBe(
      true,
    );
  });

  // An agent that has cd-ed deeper is still in that worktree.
  it("holds a subdirectory", () => {
    expect(worktreeHoldsPath("/repo/wt/feature", "/repo/wt/feature/src")).toBe(
      true,
    );
  });

  // The separator is what keeps this from being a string-prefix test:
  // `feature-two` is a sibling, not a child.
  it("does not hold a sibling whose name starts the same way", () => {
    expect(worktreeHoldsPath("/repo/wt/feature", "/repo/wt/feature-two")).toBe(
      false,
    );
  });

  it("does not hold the parent or an unrelated path", () => {
    expect(worktreeHoldsPath("/repo/wt/feature", "/repo/wt")).toBe(false);
    expect(worktreeHoldsPath("/repo/wt/feature", "/elsewhere")).toBe(false);
    expect(worktreeHoldsPath("/repo/wt/feature", "")).toBe(false);
  });

  it("normalizes traversal rather than comparing raw strings", () => {
    expect(
      worktreeHoldsPath("/repo/wt/feature", "/repo/wt/feature/../feature/src"),
    ).toBe(true);
    expect(
      worktreeHoldsPath("/repo/wt/feature", "/repo/wt/feature/../other"),
    ).toBe(false);
  });

  /**
   * ccmux's linked worktrees physically nest under the main checkout, so a
   * plain descendant test lets a main checkout on a PR's head claim a session
   * living in `.claude/worktrees/<name>` on a different branch — and Enter's
   * revalidation then activates the wrong agent. A descendant that crosses
   * into a nested checkout belongs to that checkout, not this root.
   */
  it("does not hold a session inside a nested checkout", () => {
    expect(worktreeHoldsPath("/repo", "/repo/.claude/worktrees/foo")).toBe(
      false,
    );
  });

  // An agent that cd-ed deeper into the nested checkout is still ITS session.
  it("does not hold a subdirectory of a nested checkout", () => {
    expect(worktreeHoldsPath("/repo", "/repo/.claude/worktrees/foo/src")).toBe(
      false,
    );
  });

  // Only the RELATIVE path from root to candidate decides: a nested root's
  // own path contains the segments, and it still claims its own children.
  it("lets a nested root hold its own children", () => {
    expect(
      worktreeHoldsPath(
        "/repo/.claude/worktrees/foo",
        "/repo/.claude/worktrees/foo/src",
      ),
    ).toBe(true);
  });

  // Segments, not substrings: `worktrees-old` is not the checkout parent.
  it("does not treat a segment that merely starts with worktrees as a boundary", () => {
    expect(worktreeHoldsPath("/repo", "/repo/.claude/worktrees-old/x")).toBe(
      true,
    );
  });

  it("does not treat .claude alone as a boundary", () => {
    expect(worktreeHoldsPath("/repo", "/repo/.claude/other")).toBe(true);
  });

  // The container directory itself belongs to the containing tree: no nested
  // checkout starts until one segment further.
  it("holds a session sitting on the container directory itself", () => {
    expect(worktreeHoldsPath("/repo", "/repo/.claude/worktrees")).toBe(true);
  });
});

describe("clipboardArgv", () => {
  it("uses pbcopy on macOS and refuses elsewhere", () => {
    expect(clipboardArgv("darwin")).toEqual(["pbcopy"]);
    expect(clipboardArgv("linux")).toBeNull();
  });
});

describe("copyToClipboard", () => {
  const osc52 = (supported: boolean, accepted = true) => {
    const copied: string[] = [];
    return {
      copied,
      writer: {
        isOsc52Supported: () => supported,
        copyToClipboardOSC52: (text: string) => {
          if (accepted) copied.push(text);
          return accepted;
        },
      },
    };
  };

  // Both channels, not one with the other as fallback: OSC 52 reports success
  // for a sequence it merely WROTE, so a terminal that drops it would leave a
  // preferred-OSC-52 copy silently empty on the machine where pbcopy works.
  // The platform is pinned in every case: the local channel is
  // darwin-conditional, so a test that read the host's real platform would
  // pass on a mac and fail on Linux CI.
  it("writes through both channels when both are available", () => {
    const { writer, copied } = osc52(true);
    const spawns: string[][] = [];
    const how = copyToClipboard(
      "/wt/x",
      writer,
      (argv) => {
        spawns.push(argv);
        return true;
      },
      "darwin",
    );
    expect(how).toEqual({ osc52: true, local: true });
    expect(copied).toEqual(["/wt/x"]);
    expect(spawns).toEqual([["pbcopy"]]);
  });

  it("still copies locally when the terminal has no OSC 52", () => {
    const { writer } = osc52(false);
    const how = copyToClipboard("/wt/x", writer, () => true, "darwin");
    expect(how).toEqual({ osc52: false, local: true });
  });

  // Inside tmux, OSC 52 is advertised and then refused without
  // `set-clipboard on`.
  it("records a refused OSC 52 write as not copied", () => {
    const { writer } = osc52(true, false);
    const how = copyToClipboard("/wt/x", writer, () => true, "darwin");
    expect(how).toEqual({ osc52: false, local: true });
  });

  it("never spawns a local helper off macOS", () => {
    const { writer } = osc52(true);
    const spawns: string[][] = [];
    const how = copyToClipboard(
      "/wt/x",
      writer,
      (argv) => {
        spawns.push(argv);
        return true;
      },
      "linux",
    );
    expect(how).toEqual({ osc52: true, local: false });
    expect(spawns).toEqual([]);
  });

  it("reports nothing copied rather than claiming a copy that never happened", () => {
    const { writer } = osc52(false);
    expect(copyToClipboard("/wt/x", writer, () => false, "darwin")).toEqual({
      osc52: false,
      local: false,
    });
    expect(copyToClipboard("/wt/x", null, () => false, "darwin")).toEqual({
      osc52: false,
      local: false,
    });
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

async function mount(
  opts: {
    rows?: WorktreeRow[];
    scan?: () => Promise<ScanResponse>;
    list?: (url: URL) => Promise<Response>;
    run?: () => Promise<Response>;
    repo?: string | null;
    isReturn?: boolean;
    facts?: RepoFactsResponse;
    copyResult?: { osc52: boolean; local: boolean };
    openResult?: boolean;
    cursor?: string;
    width?: number;
    height?: number;
    enabled?: boolean;
    embedded?: boolean;
    activeSessionId?: string;
  } = {},
) {
  const posts: Record<string, unknown>[] = [],
    copies: string[] = [],
    reviews: boolean[] = [],
    scopes: (string | null)[] = [],
    jumps: string[] = [],
    newDirs: string[] = [],
    urls: string[] = [];
  let scanCalls = 0,
    refreshes = 0;
  const [sharedScope, setSharedScope] = createSignal<string | null | undefined>(
    undefined,
  );
  const reads: URL[] = [];
  fetchSpy?.mockRestore();
  const worktrees = opts.rows ?? [mainRow(), row()];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: unknown,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return (
        opts.run?.() ??
        Response.json({ outcomes: [], state: [], dryRun: false })
      );
    }
    reads.push(new URL(url));
    if (url.includes("prune-candidates")) {
      scanCalls++;
      return Response.json(
        await (opts.scan?.() ??
          Promise.resolve({ candidates: [candidate()], skipped: [] })),
      );
    }
    if (opts.list) return opts.list(new URL(url));
    return Response.json({
      repos: [{ repoRoot: "/repo", repoName: "repo", worktrees }],
    });
  }) as typeof fetch);
  setup = await testRender(
    () => (
      <WorktreesPanel
        activeSessionId={opts.activeSessionId}
        repo={opts.repo ?? null}
        scope={sharedScope()}
        isReturn={opts.isReturn}
        facts={opts.facts}
        cwd="/repo"
        initialCursor={opts.cursor}
        embedded={opts.embedded}
        enabled={opts.enabled}
        onClose={() => {}}
        onJump={(s) => jumps.push(s.id)}
        onSpawn={(t) => newDirs.push(t.cwd)}
        onReview={(t) => reviews.push(t.branch ?? false)}
        onScope={(scope) => scopes.push(scope)}
        onNew={(cwd) => newDirs.push(cwd)}
        onRefresh={() => refreshes++}
        effects={{
          openUrl: (url) => {
            urls.push(url);
            return opts.openResult ?? true;
          },
          copyText: (text) => {
            copies.push(text);
            return opts.copyResult ?? { local: true, osc52: true };
          },
        }}
      />
    ),
    { width: opts.width ?? 96, height: opts.height ?? 30 },
  );
  const keys = createMockKeys(setup.renderer);
  const frame = async () => {
    await new Promise((done) => setTimeout(done, 0));
    await setup!.renderOnce();
    return setup!.captureCharFrame();
  };
  await frame();
  return {
    keys,
    frame,
    posts,
    copies,
    reviews,
    scopes,
    jumps,
    newDirs,
    urls,
    reads,
    setScope: setSharedScope,
    scanCalls: () => scanCalls,
    refreshes: () => refreshes,
  };
}
describe("Worktrees view", () => {
  it("paints local rows before classification and keeps the path cursor as it arrives", async () => {
    let finish!: (scan: ScanResponse) => void;
    const h = await mount({
      cursor: row().path,
      scan: () =>
        new Promise((done) => {
          finish = done;
        }),
    });
    expect(await h.frame()).toContain("alpha +");
    expect(await h.frame()).toContain("scanning");
    finish({ candidates: [candidate()], skipped: [] });
    await h.frame();
    await h.keys.pressKey("y");
    expect(h.copies).toEqual([row().path]);
    expect(await h.frame()).toContain("PR #68 merged");
  });
  it("uses one line, the shared prefix, and no removable divider or PR tab", async () => {
    const h = await mount({ cursor: row().path });
    const frame = await h.frame();
    expect(frame).toContain(" 2   alpha +");
    expect(frame).toContain("⌂ main checkout");
    expect(frame).not.toContain("Pull Requests");
    expect(frame).not.toContain("removable ·");
    expect(
      frame
        .split("\n")
        .filter((l) => l.includes("alpha +") || l.includes("PR #68 merged")),
    ).toHaveLength(1);
  });
  it("uses the index column for marks and A clears them", async () => {
    const h = await mount({ cursor: row().path });
    await h.keys.pressKey(" ");
    expect(await h.frame()).toContain(" ✓");
    await h.keys.pressKey("A");
    expect(await h.frame()).toContain(" 2");
  });
  it("marks every row of a header while Enter alone folds it", async () => {
    const h = await mount({ cursor: row().path });
    await h.keys.pressKey("g");
    await h.keys.pressKey("g");
    await h.keys.pressKey(" ");
    expect((await h.frame()).match(/✓/g)).toHaveLength(2);
    await h.keys.pressEnter();
    expect(await h.frame()).not.toContain("alpha +");
    await h.keys.pressEnter();
    expect(await h.frame()).toContain("alpha +");
  });
  it("reviews working tree with d and branch with D; neither opts into deletion", async () => {
    const h = await mount({ cursor: row().path });
    await h.keys.pressKey("d");
    await h.keys.pressKey("D");
    expect(h.reviews).toEqual([false, true]);
    expect(h.posts).toEqual([]);
  });
  it("asks about dirty work before the final confirmation and carries exact consent", async () => {
    const c = candidate({
      dirty: true,
      modified: 1,
      sessions: [session()],
      ignoredFiles: [".env"],
    });
    const h = await mount({
      cursor: c.path,
      scan: async () => ({ candidates: [c], skipped: [] }),
    });
    await h.keys.pressKey("x");
    expect(await h.frame()).toContain("Delete uncommitted work");
    expect(await h.frame()).toContain("Y include N skip");
    expect(h.posts).toEqual([]);
    await h.keys.pressKey("y");
    expect(await h.frame()).toContain("ending 1 idle agent session");
    expect(await h.frame()).toContain("1 ignored file go too");
    expect(h.posts).toEqual([]);
    await h.keys.pressKey("y");
    await h.frame();
    expect(h.posts[0]?.allowDirty).toEqual([c.path]);
    expect(h.posts[0]?.allowEndIdle).toEqual([c.path]);
  });
  it("does not delete a dirty row declined at the dirty question", async () => {
    const h = await mount({
      cursor: row().path,
      scan: async () => ({
        candidates: [candidate({ dirty: true })],
        skipped: [],
      }),
    });
    await h.keys.pressKey("x");
    await h.keys.pressKey("n");
    await h.keys.pressKey("y");
    expect(h.posts).toEqual([]);
  });
  it("Escape cancels dirty consent and a later removal asks again", async () => {
    const h = await mount({
      cursor: row().path,
      scan: async () => ({
        candidates: [candidate({ dirty: true })],
        skipped: [],
      }),
    });
    await h.keys.pressKey("x");
    await deliverEscape(setup!.renderer);
    await h.keys.pressKey("x");
    expect(await h.frame()).toContain("Delete uncommitted work");
    expect(h.posts).toEqual([]);
  });
  it("refuses an unclassified mark instead of silently removing a subset", async () => {
    const h = await mount();
    await h.keys.pressKey("a");
    await h.keys.pressKey("x");
    expect(await h.frame()).toContain("not removable");
    expect(h.posts).toEqual([]);
  });
  it("ignores action keys under an owning modal", async () => {
    const h = await mount({ enabled: false, cursor: row().path });
    await h.keys.pressKey("x");
    await h.keys.pressKey("y");
    expect(h.posts).toEqual([]);
    expect(h.copies).toEqual([]);
  });
  it("uses R for refresh and s for scope, leaving Tab out of scope", async () => {
    const h = await mount();
    await h.keys.pressTab();
    expect(h.scopes).toEqual([]);
    await h.keys.pressKey("s");
    await h.frame();
    expect(h.scopes).toEqual(["/repo"]);
    await h.keys.pressKey("R");
    await h.frame();
    expect(h.refreshes()).toBe(1);
    expect(h.scanCalls()).toBe(3);
  });
  it("n starts a new session in the current checkout", async () => {
    const h = await mount({ cursor: row().path });
    await h.keys.pressKey("n");
    expect(h.newDirs).toEqual([row().path]);
  });
  it("scrolls the keyed cursor past the fold at sidebar width", async () => {
    const worktrees = Array.from({ length: 40 }, (_, i) =>
      row({ path: `/repo/${i}`, name: `work-${i}`, branch: `work-${i}` }),
    );
    const h = await mount({ rows: worktrees, width: 30, height: 30 });
    for (let i = 0; i < 35; i++) await h.keys.pressKey("j");
    expect(await h.frame()).toContain("work-35");
    await h.keys.pressKey("y");
    expect(h.copies).toEqual(["/repo/35"]);
  });
});

it("does not promise branch deletion for a closed PR whose branch is kept", async () => {
  const h = await mount({
    rows: [row()],
    scan: async () => ({
      candidates: [candidate({ reason: "pr-closed", branchDeletion: "none" })],
      skipped: [],
      open: [],
    }),
  });
  h.keys.pressKey("x");
  expect(await h.frame()).toContain("Delete 1 worktree?");
  expect(await h.frame()).not.toContain("and its branch");
});

it("reserves the bar for the active session while the cursor can move elsewhere", async () => {
  const h = await mount({
    rows: [row({ sessions: [session()] }), mainRow()],
    activeSessionId: "s1",
  });
  expect(await h.frame()).toContain("▎1 ● alpha");
  h.keys.pressKey("j");
  expect(await h.frame()).toContain("▎1 ● alpha");
  h.keys.pressKey("y");
  expect(h.copies).toEqual(["/repo"]);
});

it("keeps tracking, locks, dirty counts and all attached agents on one row", async () => {
  const h = await mount({
    width: 160,
    rows: [
      mainRow(),
      row({
        locked: true,
        dirty: { dirty: true, modified: 2, untracked: 1 },
        upstream: {
          upstream: "origin/alpha",
          gone: false,
          ahead: 3,
          behind: 2,
        },
        sessions: [
          session(),
          session({ id: "s2", status: "waiting" }),
          session({ id: "s3", status: "working" }),
        ],
      }),
    ],
    scan: async () => ({ candidates: [], skipped: [] }),
  });
  const frame = await h.frame();
  const line = frame.split("\n").find((l) => l.includes("alpha +")) ?? "";
  for (const field of [
    "locked",
    "2 modified",
    "1 untracked",
    "↑3",
    "↓2",
    "3 agents, 1 waiting",
  ])
    expect(line).toContain(field);
});

it("preserves dirty and session facts from classification while the local snapshot catches up", async () => {
  const h = await mount({
    width: 160,
    scan: async () => ({
      candidates: [candidate({ dirty: true, sessions: [session()] })],
      skipped: [],
    }),
  });
  const line =
    (await h.frame()).split("\n").find((l) => l.includes("alpha +")) ?? "";
  expect(line).toContain("uncommitted work");
  expect(line).toContain("Claude");
  expect(line).not.toContain("ends it");
});

function outcome(overrides: Partial<PruneOutcome> = {}): PruneOutcome {
  return {
    path: row().path,
    repoRoot: "/repo",
    branch: "feat/alpha",
    reason: "pr-merged",
    removed: true,
    trashPath: null,
    branchDeleted: true,
    panesClosed: [],
    steps: [{ step: "remove worktree", ok: true, detail: "removed" }],
    ...overrides,
  };
}
function runResult(outcomes: PruneOutcome[]): PruneRunResult {
  return { outcomes, state: [], dryRun: false };
}
function listResponse(rows: WorktreeRow[]) {
  return Response.json({
    repos: [...new Set(rows.map((r) => r.repoRoot))].map((root) => ({
      repoRoot: root,
      repoName: root.split("/").pop(),
      worktrees: rows.filter((r) => r.repoRoot === root),
    })),
  });
}
function destroyPanel() {
  setup?.renderer.destroy();
  setup = undefined;
}

describe("Worktrees read and effect regressions", () => {
  it("keeps local rows actionable after classification fails, and R retries both reads", async () => {
    let fail = true;
    const h = await mount({
      cursor: row().path,
      scan: async () => {
        if (fail) throw new Error("classification unavailable");
        return { candidates: [candidate()], skipped: [] };
      },
    });
    expect(await h.frame()).toContain("classification unavailable");
    await h.keys.pressEnter();
    expect(h.newDirs).toEqual([row().path]);
    await h.keys.pressKey("x");
    expect(h.posts).toEqual([]);
    fail = false;
    await h.keys.pressKey("R");
    expect(await h.frame()).not.toContain("classification unavailable");
    expect(h.reads.filter((u) => u.pathname === "/worktrees")).toHaveLength(2);
    expect(h.scanCalls()).toBe(2);
    await h.keys.pressKey("x");
    expect(await h.frame()).toContain("Delete 1 worktree");
  });
  for (const status of [404, 500]) {
    it(`surfaces a local ${status} failure and recovers on R`, async () => {
      let fail = true;
      const h = await mount({
        list: async () =>
          fail ? new Response("", { status }) : listResponse([row()]),
      });
      expect(await h.frame()).not.toContain("alpha +");
      expect(await h.frame()).toContain(status === 404 ? "daemon" : "500");
      fail = false;
      await h.keys.pressKey("R");
      expect(await h.frame()).toContain("alpha +");
      expect(h.scanCalls()).toBe(2);
    });
  }
  for (const change of ["refresh", "scope"]) {
    it(`ignores stale local and classification responses after ${change}`, async () => {
      let oldList!: (value: Response) => void;
      let oldScan!: (value: ScanResponse) => void;
      let lists = 0,
        scans = 0;
      const fresh = row({
        name: "fresh",
        path: "/other/fresh",
        repoRoot: "/other",
        branch: "fresh",
      });
      const h = await mount({
        list: () =>
          ++lists === 1
            ? new Promise((resolve) => {
                oldList = resolve;
              })
            : Promise.resolve(listResponse([fresh])),
        scan: () =>
          ++scans === 1
            ? new Promise((resolve) => {
                oldScan = resolve;
              })
            : Promise.resolve({ candidates: [], skipped: [] }),
      });
      if (change === "refresh") await h.keys.pressKey("R");
      else h.setScope("/other");
      expect(await h.frame()).toContain("fresh +");
      oldList(listResponse([row()]));
      oldScan({ candidates: [candidate()], skipped: [] });
      const frame = await h.frame();
      expect(frame).toContain("fresh +");
      expect(frame).not.toContain("alpha +");
      expect(frame).not.toContain("merged");
      if (change === "scope")
        expect(
          h.reads
            .slice(-2)
            .every((u) => u.searchParams.get("repo") === "/other"),
        ).toBe(true);
    });
  }
  it("keeps a path cursor across a reordered reload and reseeds when that path disappears", async () => {
    const beta = row({ path: "/repo/beta", name: "beta" });
    let rows = [row(), beta];
    const h = await mount({
      cursor: beta.path,
      list: async () => listResponse(rows),
    });
    rows = [beta, row()];
    await h.keys.pressKey("R");
    await h.frame();
    await h.keys.pressKey("y");
    expect(h.copies).toEqual([beta.path]);
    rows = [row()];
    await h.keys.pressKey("R");
    await h.frame();
    await h.keys.pressKey("y");
    expect(h.copies).toEqual([beta.path, row().path]);
  });
  for (const copied of [
    { local: false, osc52: false },
    { local: true, osc52: false },
    { local: false, osc52: true },
  ]) {
    it(`reports actual clipboard outcome ${JSON.stringify(copied)}`, async () => {
      const h = await mount({ cursor: row().path, copyResult: copied });
      await h.keys.pressKey("y");
      expect(await h.frame()).toContain(
        copied.local || copied.osc52
          ? "copied alpha"
          : "copy needs OSC 52 or pbcopy",
      );
      expect(h.copies).toEqual([row().path]);
    });
  }
  for (const opened of [true, false]) {
    it(`opens the cached branch PR despite a different local tip, reporting ${opened}`, async () => {
      const href = "https://github.com/o/r/pull/7";
      const h = await mount({
        cursor: row().path,
        rows: [row({ tip: "local-ahead" })],
        openResult: opened,
        facts: {
          headerPR: true,
          repos: [
            {
              repoRoot: "/repo",
              repoName: "repo",
              branchPRs: {
                "feat/alpha": {
                  value: [{ id: "7", href }],
                  stale: false,
                  updatedAt: 1,
                },
              },
            },
          ],
        },
      });
      await h.keys.pressKey("o");
      expect(h.urls).toEqual([href]);
      expect(await h.frame()).toContain(
        opened ? `opened ${href}` : "no browser opener here",
      );
    });
  }
  it("does not invoke the browser when no PR is known", async () => {
    const h = await mount({ cursor: row().path });
    await h.keys.pressKey("o");
    expect(h.urls).toEqual([]);
    expect(await h.frame()).toContain("No GitHub PR on this row");
  });
});

describe("Worktrees removal outcomes and cache", () => {
  it("requires a nonempty run with every removal and step successful", () => {
    expect(
      pruneFullySucceeded(runResult([outcome(), outcome({ path: "/other" })])),
    ).toBe(true);
    for (const results of [
      [],
      [outcome({ removed: false })],
      [outcome({ error: "refused" })],
      [
        outcome({
          steps: [
            { step: "delete branch", ok: false, detail: "branch refused" },
          ],
        }),
      ],
    ]) {
      expect(pruneFullySucceeded(runResult(results))).toBe(false);
    }
  });
  it("reuses cached classification only in its exact scope", () => {
    const scan = { candidates: [candidate()], skipped: [], open: [] };
    expect(cachedScanFor(null, null)).toBeNull();
    expect(cachedScanFor({ scope: "/repo", scan }, "/repo")).toBe(scan);
    expect(cachedScanFor({ scope: "/repo", scan }, null)).toBeNull();
    expect(cachedScanFor({ scope: null, scan }, "/repo")).toBeNull();
    expect(cachedScanFor({ scope: null, scan }, null)).toBe(scan);
  });
  for (const isReturn of [true, false]) {
    it(`${isReturn ? "reuses" : "ignores"} completed classification on ${isReturn ? "return" : "plain"} open`, async () => {
      await mount();
      destroyPanel();
      const h = await mount({
        isReturn,
        cursor: row().path,
        scan: () => new Promise(() => {}),
      });
      expect(h.scanCalls()).toBe(isReturn ? 0 : 1);
      await h.keys.pressKey("x");
      expect((await h.frame()).includes("Delete 1 worktree")).toBe(isReturn);
      if (isReturn) {
        deliverEscape(setup!.renderer);
        await h.keys.pressKey("R");
        await h.frame();
        expect(h.scanCalls()).toBe(1);
      }
    });
  }
  it("does not reuse a failed scan or a successful scan from another scope", async () => {
    await mount({
      scan: async () => {
        throw new Error("failed scan");
      },
    });
    destroyPanel();
    const retry = await mount({ isReturn: true, repo: "/repo" });
    expect(retry.scanCalls()).toBe(1);
    destroyPanel();
    const other = await mount({ isReturn: true, repo: "/other" });
    expect(other.scanCalls()).toBe(1);
  });
  it("does not let an unmounted read replace the return cache", async () => {
    let finish!: (value: ScanResponse) => void;
    await mount({
      repo: "/old",
      scan: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    destroyPanel();
    await mount({ repo: "/new" });
    finish({ candidates: [], skipped: [] });
    await new Promise((done) => setTimeout(done, 0));
    destroyPanel();
    const h = await mount({ repo: "/new", isReturn: true });
    expect(h.scanCalls()).toBe(0);
  });
  it("reloads after full success, keeps the success notice, and invalidates cached classification", async () => {
    let scans = 0,
      removed = false;
    const h = await mount({
      cursor: row().path,
      list: async () =>
        listResponse(removed ? [mainRow()] : [mainRow(), row()]),
      scan: () =>
        ++scans === 1
          ? Promise.resolve({ candidates: [candidate()], skipped: [] })
          : new Promise(() => {}),
      run: async () => {
        removed = true;
        return Response.json(runResult([outcome()]));
      },
    });
    await h.keys.pressKey("x");
    await h.keys.pressKey("y");
    const frame = await h.frame();
    expect(frame).toContain("removed 1 worktree");
    expect(frame).not.toContain("alpha +");
    expect(h.refreshes()).toBe(1);
    destroyPanel();
    const returned = await mount({
      isReturn: true,
      scan: () => new Promise(() => {}),
    });
    expect(returned.scanCalls()).toBe(1);
  });
  for (const result of [
    runResult([]),
    runResult([
      outcome(),
      outcome({
        path: "/repo/blocked",
        removed: false,
        error: "worktree became busy",
        steps: [{ step: "recheck", ok: false, detail: "active agent" }],
      }),
    ]),
  ]) {
    it(`retains the outcome screen for ${result.outcomes.length ? "partial failure" : "an empty run"} until explicitly reloaded`, async () => {
      const h = await mount({
        cursor: row().path,
        run: async () => Response.json(result),
      });
      await h.keys.pressKey("x");
      await h.keys.pressKey("y");
      const frame = await h.frame();
      expect(frame).toContain("Enter returns");
      if (result.outcomes.length) {
        expect(frame).toContain("worktree became busy");
        expect(frame).toContain("active agent");
      }
      expect(h.scanCalls()).toBe(1);
      await h.keys.pressEnter();
      await h.frame();
      expect(h.scanCalls()).toBe(2);
    });
  }
  it("reports a failed removal request and allows an explicit retry of the reads", async () => {
    const h = await mount({
      cursor: row().path,
      run: async () =>
        Response.json({ error: "recheck refused" }, { status: 409 }),
    });
    await h.keys.pressKey("x");
    await h.keys.pressKey("y");
    expect(await h.frame()).toContain("recheck refused");
    expect(h.refreshes()).toBe(0);
    await h.keys.pressKey("R");
    expect(await h.frame()).toContain("alpha +");
  });
  it("sends exact scoped paths, caller context and empty consent for an agent-free clean row", async () => {
    const previous = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%987";
    try {
      const h = await mount({ repo: "/repo", cursor: row().path });
      await h.keys.pressKey("x");
      await h.keys.pressKey("y");
      await h.frame();
      expect(h.posts).toEqual([
        {
          paths: [row().path],
          allowDirty: [],
          allowEndIdle: [],
          source: "picker",
          repo: "/repo",
          cwd: "/repo",
          callerPane: "%987",
        },
      ]);
    } finally {
      if (previous === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previous;
    }
  });
  it("omits caller pane when not running inside tmux", async () => {
    const previous = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    try {
      const h = await mount({ cursor: row().path });
      await h.keys.pressKey("x");
      await h.keys.pressKey("y");
      await h.frame();
      expect(Object.hasOwn(h.posts[0]!, "callerPane")).toBe(false);
    } finally {
      if (previous !== undefined) process.env.TMUX_PANE = previous;
    }
  });
  it("keeps dirty and session consequences readable at sidebar width", async () => {
    const c = candidate({
      dirty: true,
      modified: 1,
      sessions: [session()],
      ignoredFiles: [".env"],
    });
    const h = await mount({
      width: 30,
      height: 30,
      cursor: c.path,
      scan: async () => ({ candidates: [c], skipped: [] }),
    });
    await h.keys.pressKey("x");
    expect((await h.frame()).replace(/│/g, " ").replace(/\s+/g, " ")).toContain(
      "Delete uncommitted work?",
    );
    await h.keys.pressKey("y");
    const frame = (await h.frame()).replace(/│/g, " ").replace(/\s+/g, " ");
    expect(frame).toContain("1 idle agent session");
    expect(frame).toContain("1 ignored file");
    expect(h.posts).toEqual([]);
  });
});
