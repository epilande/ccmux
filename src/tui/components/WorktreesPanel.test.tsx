import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testRender } from "@opentui/solid";
import { createMockKeys } from "@opentui/core/testing";
import type {
  PruneCandidate,
  WorktreeSession,
} from "../../daemon/worktree-prune";
import type {
  WorktreeListResponse,
  WorktreeRow,
} from "../../daemon/worktree-list";
import {
  WorktreesPanel,
  clipboardArgv,
  copyToClipboard,
  describeHttpFailure,
  detailSegments,
  fitSegments,
  formatDirty,
  formatTracking,
  normalizeScan,
  orderRepos,
  partitionSelection,
  primarySegments,
  rowVisualHeight,
  scrollTargetFor,
  sortWorktreeRows,
  visualLayout,
  type PanelRow,
  type ScanResponse,
} from "./WorktreesPanel";
import { displayWidth } from "../utils/format";

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

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

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
    name: "mainline",
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

function panelRow(overrides: Partial<PanelRow> = {}): PanelRow {
  return { row: row(), candidate: null, skip: null, pr: null, ...overrides };
}

/** One `GET /worktrees` body, grouping rows by the repo they name. */
function listOf(rows: WorktreeRow[]): WorktreeListResponse {
  const repos: WorktreeListResponse["repos"] = [];
  for (const repoRoot of new Set(rows.map((r) => r.repoRoot))) {
    const worktrees = rows.filter((r) => r.repoRoot === repoRoot);
    repos.push({ repoRoot, repoName: worktrees[0]!.repoName, worktrees });
  }
  return { repos };
}

const emptyScan: ScanResponse = { candidates: [], skipped: [] };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Render harness
// ---------------------------------------------------------------------------

interface Handlers {
  list: () => Promise<Response>;
  scan: () => Promise<Response>;
  prune?: () => Promise<Response>;
}

/** Every URL the panel asked for, in order, for the scope assertions. */
let requested: string[] = [];

function installFetch(handlers: Handlers): void {
  requested = [];
  // Bun's `fetch` type carries a `preconnect` property a plain function can't
  // satisfy; the panel only ever calls it, so the cast is the whole gap.
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: unknown,
  ) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("prune-candidates")) return handlers.scan();
    if (url.includes("/worktrees/prune")) {
      return handlers.prune?.() ?? json({ outcomes: [] });
    }
    return handlers.list();
  }) as unknown as typeof fetch);
}

interface PanelOptions {
  repo?: string | null;
  compact?: boolean;
  width?: number;
  height?: number;
  onClose?: () => void;
  onJump?: (s: WorktreeSession) => void;
  onSpawn?: (t: { cwd: string; existingWorktree: string | null }) => void;
  onReview?: (t: { path: string; sessionId: string | null }) => void;
}

async function mountPanel(handlers: Handlers, opts: PanelOptions = {}) {
  installFetch(handlers);
  setup = await testRender(
    () => (
      <WorktreesPanel
        repo={opts.repo ?? null}
        cwd="/repo"
        compact={opts.compact}
        onClose={opts.onClose ?? (() => {})}
        onJump={opts.onJump ?? (() => {})}
        onSpawn={opts.onSpawn ?? (() => {})}
        onReview={opts.onReview}
      />
    ),
    { width: opts.width ?? 90, height: opts.height ?? 24 },
  );
  await setup.renderOnce();
  return {
    keys: createMockKeys(setup.renderer),
    /** Drain every pending microtask, then repaint. */
    frame: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await setup!.renderOnce();
      return setup!.captureCharFrame();
    },
  };
}

/** Both endpoints answer immediately, which is the settled state. */
async function mountSettled(
  list: WorktreeListResponse,
  scan: ScanResponse = emptyScan,
  opts: PanelOptions = {},
) {
  const harness = await mountPanel(
    { list: async () => json(list), scan: async () => json(scan) },
    opts,
  );
  return { ...harness, settled: await harness.frame() };
}

/**
 * Row ORDER, not presence: OpenTUI does not clip, so a row drawn where the
 * layout did not budget for it paints over its neighbour instead of
 * vanishing. Asserting on positions is the only way to see that.
 */
function orderOf(frame: string, ...needles: string[]): number[] {
  return needles.map((needle) => {
    const at = frame.indexOf(needle);
    expect(at, `"${needle}" is not on screen`).toBeGreaterThanOrEqual(0);
    return at;
  });
}

/** The rendered line holding `needle`. */
function lineWith(frame: string, needle: string): string {
  const line = frame.split("\n").find((l) => l.includes(needle));
  expect(line, `"${needle}" is not on screen`).toBeDefined();
  return line!;
}

// ---------------------------------------------------------------------------

describe("WorktreesPanel loading", () => {
  it("renders the worktree list before the prune scan answers", async () => {
    // The scan never resolves: this is exactly the seconds-long window the
    // two-phase load exists for, and the list must be usable throughout it.
    const { frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: () => new Promise<Response>(() => {}),
    });

    const shown = await frame();
    expect(shown).toContain("mainline");
    expect(shown).toContain("alpha");
    expect(shown).toContain("Checking for finished worktrees");
    // Nothing is prune-selectable yet, so no row may show a checkbox.
    expect(shown).not.toContain("[ ]");
  });

  it("keeps the list usable when the prune scan fails", async () => {
    const { frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => {
        throw new Error("gh exploded");
      },
    });
    const shown = await frame();
    expect(shown).toContain("alpha");
    expect(shown).toContain("Prune scan failed: gh exploded");
    expect(shown).toContain("enter open");
  });

  it("shows the phase-1 failure as an error state", async () => {
    const { frame } = await mountPanel({
      list: async () => {
        throw new Error("daemon is down");
      },
      scan: async () => json(emptyScan),
    });
    const shown = await frame();
    expect(shown).toContain("daemon is down");
    expect(shown).toContain("q close");
  });

  // The likeliest phase-1 failure is a daemon started before this build, so
  // the error names the fix instead of reporting a bare status.
  it("names the out-of-date daemon on a 404", async () => {
    const { frame } = await mountPanel({
      list: async () => new Response("Not Found", { status: 404 }),
      scan: async () => json(emptyScan),
    });
    expect(await frame()).toContain("ccmux daemon restart");
  });

  // Without this the error phase is a dead end: the user restarts the daemon
  // in another pane and has no way back but closing and reopening.
  it("retries both phases on r", async () => {
    let listAttempts = 0;
    const { keys, frame } = await mountPanel({
      list: async () => {
        listAttempts++;
        if (listAttempts === 1) throw new Error("daemon is down");
        return json(listOf([mainRow(), row()]));
      },
      scan: async () => json(emptyScan),
    });

    expect(await frame()).toContain("daemon is down");
    expect(await frame()).toContain("r retry");

    keys.pressKey("r");
    const recovered = await frame();
    expect(listAttempts).toBe(2);
    expect(recovered).toContain("mainline");
    expect(recovered).toContain("alpha");
    expect(recovered).not.toContain("daemon is down");
  });
});

describe("WorktreesPanel merge", () => {
  it("annotates rows from every part of the scan", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row(),
        row({ path: "/repo/wt/bravo", name: "bravo", branch: "feat/bravo" }),
        row({
          path: "/repo/wt/charlie",
          name: "charlie",
          branch: "feat/charlie",
        }),
      ]),
      {
        candidates: [candidate()],
        skipped: [
          {
            path: "/repo/wt/bravo",
            repoRoot: "/repo",
            branch: "feat/bravo",
            reason: "an agent is working here",
          },
        ],
        open: [
          {
            path: "/repo/wt/charlie",
            repoRoot: "/repo",
            branch: "feat/charlie",
            pr: { number: 102, url: "u", state: "OPEN" },
          },
        ],
      },
    );

    expect(settled).toContain("PR #68 merged");
    expect(settled).toContain("held: an agent is working here");
    expect(settled).toContain("#102 OPEN");
  });

  it("shows tracking, dirty counts and sessions on the row", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row({
          dirty: { dirty: true, modified: 2, untracked: 1 },
          upstream: {
            upstream: "origin/feat/alpha",
            gone: false,
            ahead: 3,
            behind: 4,
          },
          sessions: [session({ status: "working" })],
        }),
      ]),
    );

    const line = lineWith(settled, "alpha");
    expect(line).toContain("↑3 ↓4");
    expect(line).toContain("2m/1u");
    expect(settled).toContain("[claude working]");
  });

  // Behind the PR badge and the session list, this was the FIRST thing a
  // narrow panel truncated, leaving a row still selectable with the one
  // sentence explaining why it is held back missing.
  it("keeps the dirty warning ahead of the badge that used to displace it", async () => {
    const { settled } = await mountSettled(
      listOf([row({ dirty: { dirty: true, modified: 3, untracked: 2 } })]),
      {
        candidates: [
          candidate({
            dirty: true,
            modified: 3,
            untracked: 2,
            detail: "PR #68 merged",
            pr: { number: 68, url: "u", state: "MERGED" },
          }),
        ],
        skipped: [],
      },
      { width: 80, height: 16 },
    );

    expect(settled).toContain("press D to include");
    const [reason, warning, badge] = orderOf(
      settled,
      "PR #68 merged",
      "press D to include",
      "#68 MERGED",
    );
    expect(reason).toBeLessThan(warning!);
    expect(warning).toBeLessThan(badge!);
  });

  it("marks the main checkout and never offers it a checkbox", async () => {
    const { settled } = await mountSettled(listOf([mainRow(), row()]), {
      candidates: [candidate()],
      skipped: [],
    });

    expect(lineWith(settled, "mainline")).toContain("main");
    // Exactly one checkbox on screen, and it is not the main row's.
    expect(settled.match(/\[ \]/g)?.length ?? 0).toBe(1);
    expect(lineWith(settled, "mainline")).not.toContain("[ ]");
  });
});

describe("WorktreesPanel ordering", () => {
  it("puts the main checkout first, then occupied rows, then the rest", async () => {
    const { settled } = await mountSettled(
      listOf([
        row({ path: "/repo/wt/zulu", name: "zulu" }),
        row({
          path: "/repo/wt/busy",
          name: "busy",
          sessions: [session({ status: "working" })],
        }),
        row({
          path: "/repo/wt/parked",
          name: "parked",
          sessions: [session({ id: "s2", status: "idle" })],
        }),
        mainRow(),
      ]),
    );

    const [main, busy, parked, zulu] = orderOf(
      settled,
      "mainline",
      "busy",
      "parked",
      "zulu",
    );
    expect(main).toBeLessThan(busy!);
    expect(busy).toBeLessThan(parked!);
    expect(parked).toBeLessThan(zulu!);
  });

  it("re-sorts once when classification lands, and the cursor follows", async () => {
    let releaseScan: (response: Response) => void = () => {};
    const scanPromise = new Promise<Response>((resolve) => {
      releaseScan = resolve;
    });
    const { frame } = await mountPanel({
      list: async () =>
        json(
          listOf([
            row({ path: "/repo/wt/alpha", name: "alpha" }),
            row({
              path: "/repo/wt/bravo",
              name: "bravo",
              branch: "feat/bravo",
            }),
          ]),
        ),
      scan: () => scanPromise,
    });

    const before = await frame();
    const [alphaBefore, bravoBefore] = orderOf(before, "alpha", "bravo");
    expect(alphaBefore).toBeLessThan(bravoBefore!);
    // The cursor starts on the first row, which is what has to be followed.
    expect(lineWith(before, "alpha")).toContain("▎");

    releaseScan(json({ candidates: [candidate()], skipped: [] }));
    const after = await frame();

    // A proven-finished worktree sinks below the healthy one.
    const [alphaAfter, bravoAfter] = orderOf(after, "alpha", "bravo");
    expect(bravoAfter).toBeLessThan(alphaAfter!);
    // ...and the cursor went with the row, not with the slot.
    expect(lineWith(after, "alpha")).toContain("▎");
    expect(lineWith(after, "bravo")).not.toContain("▎");
  });

  it("leads with the repo it was opened over, then the alphabet", () => {
    const repos = [
      { repoRoot: "/x/charlie", repoName: "charlie" },
      { repoRoot: "/x/alpha", repoName: "alpha" },
      { repoRoot: "/x/bravo", repoName: "bravo" },
    ];
    expect(orderRepos(repos, "/x/charlie").map((r) => r.repoName)).toEqual([
      "charlie",
      "alpha",
      "bravo",
    ]);
    expect(orderRepos(repos, null).map((r) => r.repoName)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });
});

describe("WorktreesPanel keys", () => {
  const threeRows = listOf([
    mainRow(),
    row(),
    row({ path: "/repo/wt/bravo", name: "bravo", branch: "feat/bravo" }),
  ]);

  it("moves the cursor across repo groups", async () => {
    const { keys, frame } = await mountPanel({
      list: async () =>
        json({
          repos: [
            { repoRoot: "/repo", repoName: "repo", worktrees: [mainRow()] },
            {
              repoRoot: "/other",
              repoName: "other",
              worktrees: [
                row({
                  path: "/other/wt/delta",
                  repoRoot: "/other",
                  repoName: "other",
                  name: "delta",
                }),
              ],
            },
          ],
        }),
      scan: async () => json(emptyScan),
    });

    // Repos come out alphabetically, so `other` leads and its only row is
    // where the cursor starts.
    const before = await frame();
    expect(lineWith(before, "delta")).toContain("▎");

    keys.pressKey("j");
    const shown = await frame();
    // One `j` from the last row of a group lands on the first row of the
    // next, crossing the group header rather than selecting it.
    expect(lineWith(shown, "mainline")).toContain("▎");
    expect(lineWith(shown, "delta")).not.toContain("▎");
  });

  it("selects only classified candidates", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(threeRows),
      scan: async () =>
        json({
          candidates: [candidate()],
          skipped: [
            {
              path: "/repo/wt/bravo",
              repoRoot: "/repo",
              branch: "feat/bravo",
              reason: "locked",
            },
          ],
        }),
    });

    // Rows settle as main, the held one, then the candidate at the bottom.
    const settled = await frame();
    const [main, held, prunable] = orderOf(
      settled,
      "mainline",
      "bravo",
      "alpha",
    );
    expect(main).toBeLessThan(held!);
    expect(held).toBeLessThan(prunable!);

    // Cursor starts on the main checkout, which has no removal to opt into.
    keys.pressKey(" ");
    expect(await frame()).toContain("x prune 0");

    // The held row is likewise unselectable.
    keys.pressKey("j");
    keys.pressKey(" ");
    expect(await frame()).toContain("x prune 0");

    // The candidate is not.
    keys.pressKey("j");
    keys.pressKey(" ");
    expect(await frame()).toContain("x prune 1");
  });

  it("opens the confirmation on x, not on enter", async () => {
    let jumped = 0;
    let spawned = 0;
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(listOf([row()])),
        scan: async () => json({ candidates: [candidate()], skipped: [] }),
      },
      { onJump: () => jumped++, onSpawn: () => spawned++ },
    );

    await frame();
    keys.pressKey(" ");
    expect(await frame()).toContain("x prune 1");

    // Enter is the row action now: it must not reach the delete confirmation.
    keys.pressEnter();
    const afterEnter = await frame();
    expect(afterEnter).not.toContain("y / n");
    expect(spawned).toBe(1);
    expect(jumped).toBe(0);

    keys.pressKey("x");
    expect(await frame()).toContain("y / n");
  });

  it("routes enter by what the row holds", async () => {
    const jumps: WorktreeSession[] = [];
    const spawns: { cwd: string; existingWorktree: string | null }[] = [];
    const { keys, frame } = await mountPanel(
      {
        list: async () =>
          json(
            listOf([
              mainRow(),
              row({
                path: "/repo/wt/busy",
                name: "busy",
                sessions: [session({ id: "live" })],
              }),
              row(),
            ]),
          ),
        scan: async () => json(emptyScan),
      },
      { onJump: (s) => jumps.push(s), onSpawn: (t) => spawns.push(t) },
    );

    await frame();
    // Main checkout: an ordinary spawn whose destination stays selectable.
    keys.pressEnter();
    expect(spawns[0]).toEqual({ cwd: "/repo", existingWorktree: null });

    // Occupied worktree: jump to the agent already there.
    keys.pressKey("j");
    keys.pressEnter();
    expect(jumps[0]?.id).toBe("live");

    // Empty worktree: spawn locked to it.
    keys.pressKey("j");
    keys.pressEnter();
    expect(spawns[1]).toEqual({
      cwd: "/repo/wt/alpha",
      existingWorktree: "/repo/wt/alpha",
    });
  });

  it("keeps D for the dirty opt-in and gives bare d to review", async () => {
    const reviewed: { path: string; sessionId: string | null }[] = [];
    const { keys, frame } = await mountPanel(
      {
        list: async () =>
          json(
            listOf([
              row({ dirty: { dirty: true, modified: 0, untracked: 1 } }),
            ]),
          ),
        scan: async () =>
          json({
            candidates: [candidate({ dirty: true, untracked: 1 })],
            skipped: [],
          }),
      },
      { onReview: (t) => reviewed.push(t) },
    );

    await frame();
    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("x prune 1");
    expect(reviewed).toHaveLength(0);

    keys.pressKey("d");
    await frame();
    expect(reviewed).toEqual([{ path: "/repo/wt/alpha", sessionId: null }]);
    // Reviewing must not have disturbed the opt-in.
    expect(await frame()).toContain("x prune 1");
  });

  it("refetches both phases when tab changes scope", async () => {
    const { keys, frame } = await mountPanel(
      { list: async () => json(threeRows), scan: async () => json(emptyScan) },
      { repo: "/repo" },
    );

    await frame();
    expect(requested).toHaveLength(2);
    expect(requested.every((url) => url.includes("repo=%2Frepo"))).toBe(true);
    expect(await frame()).toContain("tab all repos");

    keys.pressTab();
    const widened = await frame();
    expect(requested).toHaveLength(4);
    expect(requested.slice(2).some((url) => url.includes("repo="))).toBe(false);
    // Discovery by cwd is additive and survives the widening.
    expect(requested.slice(2).every((url) => url.includes("cwd=%2Frepo"))).toBe(
      true,
    );
    expect(widened).toContain("tab this repo");
  });

  it("closes on q", async () => {
    let closed = 0;
    const { keys, frame } = await mountPanel(
      { list: async () => json(threeRows), scan: async () => json(emptyScan) },
      { onClose: () => closed++ },
    );
    await frame();
    keys.pressKey("q");
    expect(closed).toBe(1);
  });
});

describe("WorktreesPanel compact", () => {
  it("keeps the whole dirty warning readable at sidebar width", async () => {
    const { settled } = await mountSettled(
      listOf([row({ dirty: { dirty: true, modified: 0, untracked: 1 } })]),
      {
        candidates: [
          candidate({
            dirty: true,
            untracked: 1,
            detail: "merged into origin/main",
          }),
        ],
        skipped: [],
      },
      { compact: true, width: 44, height: 18 },
    );

    expect(settled).toContain("DIRTY, press D to include");
    expect(settled).toContain("merged into origin/main");
    // The warning owns its own line rather than sharing the reason's.
    expect(lineWith(settled, "DIRTY, press D")).not.toContain("merged into");
  });

  it("draws nothing past the panel border", async () => {
    const width = 44;
    const { settled } = await mountSettled(
      listOf([
        row({
          name: "a-worktree-with-a-very-long-derived-name",
          branch: "feat/a-branch-name-that-keeps-going-and-going",
          dirty: { dirty: true, modified: 12, untracked: 34 },
          upstream: {
            upstream: "origin/feat/x",
            gone: false,
            ahead: 11,
            behind: 22,
          },
          sessions: [session({ agentType: "opencode", status: "waiting" })],
        }),
      ]),
      emptyScan,
      { compact: true, width, height: 18 },
    );

    for (const line of settled.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe("sortWorktreeRows", () => {
  it("orders main, active, idle, empty, then prunable", () => {
    const rows: PanelRow[] = [
      panelRow({
        row: row({ name: "prunable" }),
        candidate: candidate({ name: "prunable" }),
      }),
      panelRow({ row: row({ name: "empty" }) }),
      panelRow({
        row: row({ name: "idle", sessions: [session({ status: "idle" })] }),
      }),
      panelRow({
        row: row({
          name: "active",
          sessions: [session({ status: "waiting" })],
        }),
      }),
      panelRow({ row: mainRow() }),
    ];

    expect(sortWorktreeRows(rows).map((r) => r.row.name)).toEqual([
      "mainline",
      "active",
      "idle",
      "empty",
      "prunable",
    ]);
  });

  it("breaks ties alphabetically", () => {
    const rows = [
      panelRow({ row: row({ name: "zulu" }) }),
      panelRow({ row: row({ name: "alpha" }) }),
    ];
    expect(sortWorktreeRows(rows).map((r) => r.row.name)).toEqual([
      "alpha",
      "zulu",
    ]);
  });
});

describe("fitSegments", () => {
  const segments = [
    { text: "aaaa", fg: "#1" },
    { text: "bbbb", fg: "#2" },
    { text: "cccc", fg: "#3" },
  ];

  it("keeps everything that fits", () => {
    expect(fitSegments(segments, 12)).toEqual(segments);
  });

  it("cuts the segment that straddles the limit and drops the rest", () => {
    const fitted = fitSegments(segments, 6);
    expect(fitted.map((s) => s.text)).toEqual(["aaaa", "b…"]);
    expect(fitted[1]!.fg).toBe("#2");
  });

  it("never exceeds the width it was given", () => {
    for (let width = 1; width <= 14; width++) {
      const total = fitSegments(segments, width).reduce(
        (n, s) => n + s.text.length,
        0,
      );
      expect(total).toBeLessThanOrEqual(width);
    }
  });

  // COLUMNS, not code units. A CJK glyph is one code unit and two columns and
  // an emoji is two code units and two columns, so a length-based fit
  // overflows the border on one and underfills on the other. Measuring the
  // result with `displayWidth` is what makes that claim actually tested.
  it("fits wide glyphs by display width", () => {
    const wide = [
      { text: "日本語のブランチ", fg: "#1" },
      { text: "🎉🎉🎉", fg: "#2" },
      { text: "tail", fg: "#3" },
    ];
    for (let width = 1; width <= 26; width++) {
      const fitted = fitSegments(wide, width);
      const used = fitted.reduce((n, s) => n + displayWidth(s.text), 0);
      expect(used).toBeLessThanOrEqual(width);
    }
    // Eight CJK glyphs are sixteen columns, so at sixteen the first segment
    // fits exactly and nothing of it is lost.
    expect(fitSegments(wide, 16)[0]!.text).toBe("日本語のブランチ");
    // At fifteen it cannot, and the cut lands on a grapheme boundary rather
    // than splitting a glyph.
    const cut = fitSegments(wide, 15)[0]!.text;
    expect(displayWidth(cut)).toBeLessThanOrEqual(15);
    expect(cut).toEndWith("…");
  });
});

describe("row formatting", () => {
  it("omits tracking for an in-sync branch and reports a gone upstream", () => {
    expect(formatTracking(row())).toBe("");
    expect(
      formatTracking(
        row({
          upstream: { upstream: "origin/x", gone: false, ahead: 2, behind: 0 },
        }),
      ),
    ).toBe("↑2");
    expect(
      formatTracking(
        row({
          upstream: { upstream: "origin/x", gone: true, ahead: 0, behind: 0 },
        }),
      ),
    ).toBe("gone");
    // Detached HEAD has no branch to track.
    expect(
      formatTracking(row({ branch: null, detached: true, upstream: null })),
    ).toBe("");
  });

  it("omits dirty counts for a clean tree", () => {
    expect(formatDirty(row())).toBe("");
    expect(
      formatDirty(row({ dirty: { dirty: true, modified: 1, untracked: 2 } })),
    ).toBe("1m/2u");
  });

  it("names a detached row rather than leaving the branch blank", () => {
    const text = primarySegments(
      panelRow({ row: row({ branch: null, detached: true, upstream: null }) }),
      false,
    )
      .map((s) => s.text)
      .join("");
    expect(text).toContain("detached");
  });

  it("draws no detail line for a healthy, empty worktree", () => {
    expect(
      detailSegments(panelRow(), { compact: false, dirtyOk: false }),
    ).toEqual([]);
  });

  it("collapses several sessions to one in compact mode", () => {
    const entry = panelRow({
      row: row({
        sessions: [
          session({ status: "working" }),
          session({ id: "s2", agentType: "codex" }),
        ],
      }),
    });
    const wide = detailSegments(entry, { compact: false, dirtyOk: false })
      .map((s) => s.text)
      .join("");
    const narrow = detailSegments(entry, { compact: true, dirtyOk: false })
      .map((s) => s.text)
      .join("");
    expect(wide).toContain("claude working, codex idle");
    expect(narrow).toContain("[claude working +1]");
  });
});

/**
 * Scrolling is measured in LINES and rows are 1-3 of them, so scrolling by row
 * INDEX put the cursor off screen while space/x/Enter/y/D went on acting on
 * the row nobody could see.
 */
describe("visual scrolling", () => {
  it("counts a plain row as one line and a detailed one as two", () => {
    expect(rowVisualHeight(panelRow(), false)).toBe(1);
    expect(rowVisualHeight(panelRow({ candidate: candidate() }), false)).toBe(
      2,
    );
  });

  // Compact gives the dirty warning a line of its own, which is a third line.
  it("counts compact's dirty warning as its own line", () => {
    const entry = panelRow({
      row: row({ dirty: { dirty: true, modified: 0, untracked: 1 } }),
      candidate: candidate({ dirty: true, untracked: 1 }),
    });
    expect(rowVisualHeight(entry, true)).toBe(3);
    expect(rowVisualHeight(entry, false)).toBe(2);
  });

  it("lays rows out after their repo header, in lines not indexes", () => {
    const plain = panelRow({ row: row({ path: "/a", name: "a" }) });
    const tall = panelRow({
      row: row({ path: "/b", name: "b" }),
      candidate: candidate({ path: "/b" }),
    });
    const next = panelRow({ row: row({ path: "/c", name: "c" }) });
    const layout = visualLayout(
      [
        { repoRoot: "/r1", repoName: "r1", rows: [plain, tall] },
        { repoRoot: "/r2", repoName: "r2", rows: [next] },
      ],
      (entry) => rowVisualHeight(entry, false),
    );
    // header(1) | a(1) | b(2) | header(1) | c
    expect(layout.get("/a")).toEqual({ line: 1, height: 1 });
    expect(layout.get("/b")).toEqual({ line: 2, height: 2 });
    expect(layout.get("/c")).toEqual({ line: 5, height: 1 });
  });

  it("scrolls only when the row is not already fully visible", () => {
    const layout = new Map([
      ["/a", { line: 1, height: 1 }],
      ["/b", { line: 20, height: 2 }],
    ]);
    // Fully inside the viewport: nothing to do.
    expect(scrollTargetFor(layout, "/a", 0, 10)).toBeNull();
    // Above the viewport: scroll so it is the top line.
    expect(scrollTargetFor(layout, "/a", 5, 10)).toBe(1);
    // Below it: scroll so its LAST line is the bottom one, which is what a
    // multi-line row needs to be readable rather than half on screen.
    expect(scrollTargetFor(layout, "/b", 0, 10)).toBe(12);
    expect(scrollTargetFor(layout, null, 0, 10)).toBeNull();
    expect(scrollTargetFor(layout, "/missing", 0, 10)).toBeNull();
    // A viewport nobody has measured yet must not produce a scroll.
    expect(scrollTargetFor(layout, "/b", 0, 0)).toBeNull();
  });

  it("keeps the cursor visible walking a 20-row list", () => {
    // Every row two lines tall, so 20 rows is 41 lines against a viewport of
    // 10: scrolling by index would be off by a factor of two by the bottom.
    const rows = Array.from({ length: 20 }, (_, i) =>
      panelRow({
        row: row({ path: `/w/${i}`, name: `w${i}` }),
        candidate: candidate({ path: `/w/${i}` }),
      }),
    );
    const layout = visualLayout(
      [{ repoRoot: "/r", repoName: "r", rows }],
      (entry) => rowVisualHeight(entry, false),
    );
    const viewport = 10;
    let scrollTop = 0;
    for (const entry of rows) {
      const target = scrollTargetFor(
        layout,
        entry.row.path,
        scrollTop,
        viewport,
      );
      if (target !== null) scrollTop = target;
      const slot = layout.get(entry.row.path)!;
      expect(slot.line).toBeGreaterThanOrEqual(scrollTop);
      expect(slot.line + slot.height - 1).toBeLessThan(scrollTop + viewport);
    }
  });

  // The phase-2 re-sort moves rows with no keypress at all, which is why the
  // component scrolls from an effect rather than from `moveCursor`.
  it("brings the cursor's row back after a re-sort moves it", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      panelRow({ row: row({ path: `/w/${i}`, name: `w${i}` }) }),
    );
    const before = visualLayout(
      [{ repoRoot: "/r", repoName: "r", rows }],
      () => 1,
    );
    // Cursor on the first row, viewport at the top: nothing to scroll.
    expect(scrollTargetFor(before, "/w/0", 0, 6)).toBeNull();
    // Classification sinks it to the bottom, as a prunable candidate does.
    const resorted = [...rows.slice(1), rows[0]!];
    const after = visualLayout(
      [{ repoRoot: "/r", repoName: "r", rows: resorted }],
      () => 1,
    );
    expect(scrollTargetFor(after, "/w/0", 0, 6)).toBe(7);
  });
});

describe("describeHttpFailure", () => {
  // The daemon is long-lived and `GET /worktrees` is new, so a 404 here is
  // the ordinary case, not an exotic one.
  it("names the out-of-date daemon on 404", () => {
    expect(describeHttpFailure(404)).toContain("ccmux daemon restart");
  });

  it("leaves other statuses as the status", () => {
    expect(describeHttpFailure(500)).toBe("HTTP 500");
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
  it("writes through both channels when both are available", () => {
    const { writer, copied } = osc52(true);
    const spawns: string[][] = [];
    const how = copyToClipboard("/wt/x", writer, (argv) => {
      spawns.push(argv);
      return true;
    });
    expect(how).toEqual({ osc52: true, local: true });
    expect(copied).toEqual(["/wt/x"]);
    expect(spawns).toEqual([["pbcopy"]]);
  });

  it("still copies locally when the terminal has no OSC 52", () => {
    const { writer } = osc52(false);
    const how = copyToClipboard("/wt/x", writer, () => true);
    expect(how).toEqual({ osc52: false, local: true });
  });

  // Inside tmux, OSC 52 is advertised and then refused without
  // `set-clipboard on`.
  it("records a refused OSC 52 write as not copied", () => {
    const { writer } = osc52(true, false);
    const how = copyToClipboard("/wt/x", writer, () => true);
    expect(how).toEqual({ osc52: false, local: true });
  });

  it("reports nothing copied rather than claiming a copy that never happened", () => {
    const { writer } = osc52(false);
    expect(copyToClipboard("/wt/x", writer, () => false)).toEqual({
      osc52: false,
      local: false,
    });
    expect(copyToClipboard("/wt/x", null, () => false)).toEqual({
      osc52: false,
      local: false,
    });
  });
});

describe("normalizeScan", () => {
  // An older daemon is a live possibility, not a hypothetical: it is a
  // long-lived background process that can predate the picker talking to it.
  it("fills in the arrays an older daemon does not send", () => {
    expect(normalizeScan({})).toEqual({
      candidates: [],
      skipped: [],
      open: [],
    });
  });

  it("keeps what it is given", () => {
    const one = candidate();
    expect(normalizeScan({ candidates: [one] })).toEqual({
      candidates: [one],
      skipped: [],
      open: [],
    });
  });

  it("survives a body with no open array end to end", async () => {
    const { settled } = await mountSettled(listOf([mainRow(), row()]), {
      candidates: [candidate()],
      skipped: [],
    });
    expect(settled).toContain("PR #68 merged");
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
 * The interactions that decide whether uncommitted work is deleted, driven
 * through real key events rather than by calling the handlers directly.
 */
describe("WorktreesPanel dirty gate", () => {
  const dirtyList = listOf([
    row({ dirty: { dirty: true, modified: 0, untracked: 1 } }),
  ]);
  const dirtyScan: ScanResponse = {
    candidates: [candidate({ dirty: true, untracked: 1 })],
    skipped: [],
  };
  const cleanList = listOf([row()]);
  const cleanScan: ScanResponse = { candidates: [candidate()], skipped: [] };

  it("does not count a dirty row selected with space alone", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(dirtyList),
      scan: async () => json(dirtyScan),
    });
    await frame();
    keys.pressKey(" ");
    const shown = await frame();
    expect(shown).toContain("[x]");
    expect(shown).toContain("x prune 0");
  });

  it("arms a dirty row with D and disarms it again", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(dirtyList),
      scan: async () => json(dirtyScan),
    });
    await frame();
    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("x prune 1");
    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("x prune 0");
  });

  it("selects only clean rows with a", async () => {
    const { keys, frame } = await mountPanel({
      list: async () =>
        json(
          listOf([
            row(),
            row({
              path: "/repo/wt/bravo",
              name: "bravo",
              dirty: { dirty: true, modified: 0, untracked: 1 },
            }),
          ]),
        ),
      scan: async () =>
        json({
          candidates: [
            candidate(),
            candidate({
              path: "/repo/wt/bravo",
              name: "bravo",
              dirty: true,
              untracked: 1,
            }),
          ],
          skipped: [],
        }),
    });
    await frame();
    keys.pressKey("a");
    expect(await frame()).toContain("x prune 1");
  });

  // A dirty opt-in must not outlive the selection that carried it.
  it("clears a dirty opt-in when a deselects everything", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(dirtyList),
      scan: async () => json(dirtyScan),
    });
    await frame();
    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("x prune 1");
    keys.pressKey("a"); // deselects: the only row is dirty
    expect(await frame()).toContain("x prune 0");
    keys.pressKey(" "); // reselect by hand, with no fresh D
    expect(await frame()).toContain("x prune 0");
  });

  it("names the destructive case at the confirmation step", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(dirtyList),
      scan: async () => json(dirtyScan),
    });
    await frame();
    keys.pressKey("D", { shift: true });
    keys.pressKey("x");
    expect(await frame()).toContain("INCLUDING 1 with uncommitted work");
  });

  it("backs out of confirm with n", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(cleanList),
      scan: async () => json(cleanScan),
    });
    await frame();
    keys.pressKey(" ");
    keys.pressKey("x");
    expect(await frame()).toContain("y / n");
    keys.pressKey("n");
    expect(await frame()).toContain("x prune 1");
  });

  it("sends the scope and the caller cwd with the run", async () => {
    let body: unknown;
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(cleanList),
        scan: async () => json(cleanScan),
      },
      { repo: "/repo" },
    );

    await frame();
    fetchSpy!.mockImplementation((async (
      input: unknown,
      init?: RequestInit,
    ) => {
      if (String(input).includes("/worktrees/prune") && init?.body) {
        body = JSON.parse(String(init.body));
      }
      return json({ outcomes: [] });
    }) as unknown as typeof fetch);

    keys.pressKey(" ");
    keys.pressKey("x");
    keys.pressKey("y");
    await frame();

    expect(body).toMatchObject({
      paths: ["/repo/wt/alpha"],
      allowDirty: [],
      source: "picker",
      repo: "/repo",
      cwd: "/repo",
    });
  });
});
