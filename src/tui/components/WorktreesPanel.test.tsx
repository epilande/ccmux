import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testRender } from "@opentui/solid";
import { createMockKeys } from "@opentui/core/testing";
import type {
  PruneCandidate,
  PruneOutcome,
  PruneRunResult,
  ScanResponse,
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
  describeRemoval,
  describeReason,
  describeSessions,
  describeSkip,
  detailSegments,
  fitSegments,
  titleSegments,
  dirtyPhrases,
  formatTracking,
  isLivenessSkip,
  cachedScanFor,
  orderRepos,
  partitionSelection,
  pruneFullySucceeded,
  removalDetails,
  removalNotice,
  resetScanCache,
  detailGutter,
  labelColumnWidth,
  markerWidth,
  primarySegments,
  rowBranch,
  rowLabel,
  rowVisualHeight,
  scrollTargetFor,
  DIVIDER_MAX,
  dividerText,
  headerRule,
  sortWorktreeRows,
  showsGroupHeaders,
  splitRemovable,
  visualLayout,
  worktreeHoldsPath,
  type PanelRow,
} from "./WorktreesPanel";
import { theme } from "../theme";
import { displayWidth } from "../utils/format";
import { DOT_SPINNER_FRAMES, getStatusIcon } from "../../lib/icons";
import { SPINNER_INTERVAL_MS } from "../utils/useStatusIcon";

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
  // The scan cache is module state kept across mounts on purpose; across
  // TESTS it would make one test's scan another's seeded return-open.
  resetScanCache();
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

function panelRow(overrides: Partial<PanelRow> = {}): PanelRow {
  return { row: row(), candidate: null, skip: null, pr: null, ...overrides };
}

function outcome(overrides: Partial<PruneOutcome> = {}): PruneOutcome {
  return {
    path: "/repo/wt/alpha",
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
  initialCursor?: string;
  isReturn?: boolean;
  startWidened?: boolean;
  onClose?: () => void;
  onJump?: (s: WorktreeSession) => void;
  onSpawn?: (t: {
    cwd: string;
    existingWorktree: string | null;
    panelRepo: string | null;
    panelScope: string | null;
  }) => void;
  onReview?: (t: {
    path: string;
    sessionId: string | null;
    panelRepo: string | null;
    panelScope: string | null;
  }) => void;
}

async function mountPanel(handlers: Handlers, opts: PanelOptions = {}) {
  installFetch(handlers);
  setup = await testRender(
    () => (
      <WorktreesPanel
        repo={opts.repo ?? null}
        cwd="/repo"
        compact={opts.compact}
        initialCursor={opts.initialCursor}
        isReturn={opts.isReturn}
        startWidened={opts.startWidened}
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

/**
 * Whether a rendered line is a row's DETAIL line.
 *
 * Keyed on the rail plus the detail line's own indent, not on a bare `│`:
 * every line carries one as the panel's border, and now every line below a
 * group's first also carries the rail.
 *
 * The cursor bar takes the rail's own column on the cursor row's lines, so
 * both helpers accept either the rail or the bar there.
 */
function isDetailLine(line: string): boolean {
  return / [│┃] {3,5}\S/.test(line);
}

/** Whether a rendered line carries the group rail at all. */
function hasRail(line: string): boolean {
  return / [│┃] /.test(line);
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
    expect(shown).toContain("main checkout");
    expect(shown).toContain("alpha");
    // The in-flight scan is said once, on the title line above the list.
    const [scanningAt, mainAt, alphaAt] = orderOf(
      shown,
      "scanning",
      "main checkout",
      "alpha",
    );
    expect(scanningAt).toBeLessThan(mainAt!);
    expect(mainAt).toBeLessThan(alphaAt!);
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
    expect(recovered).toContain("main checkout");
    expect(recovered).toContain("alpha");
    expect(recovered).not.toContain("daemon is down");
  });
});

/**
 * Phase 2 lands a few hundred ms after phase 1 and re-sorts the list while
 * the reader is looking at it. The title carries a scanning suffix for
 * exactly that window, so the re-sort reads as the scan finishing instead of
 * as a flicker. It is decoration and nothing else: every key keeps working
 * throughout, and the suffix costs no rows.
 */
describe("WorktreesPanel scanning indicator", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const twoRows = listOf([mainRow(), row()]);
  /** A landed scan that moves `alpha` into the removable section. */
  const merged: ScanResponse = { candidates: [candidate()], skipped: [] };

  it("carries the suffix on the title line while the scan is pending", async () => {
    const pending = deferred<Response>();
    const { frame } = await mountPanel({
      list: async () => json(twoRows),
      scan: () => pending.promise,
    });

    const shown = await frame();
    // On the TITLE, above every row, rather than in a status row of its own.
    const title = lineWith(shown, "scanning");
    expect(title).toContain("Worktrees");
    const [scanningAt, mainAt, alphaAt] = orderOf(
      shown,
      "scanning",
      "main checkout",
      "alpha",
    );
    expect(scanningAt).toBeLessThan(mainAt!);
    expect(mainAt).toBeLessThan(alphaAt!);
    // The session list's working spinner, not a second vocabulary.
    expect(
      DOT_SPINNER_FRAMES.some((f) => title.includes(f)),
      `no spinner frame in ${JSON.stringify(title)}`,
    ).toBe(true);
  });

  // The indicator says something is happening; it must never be something
  // that HAS to happen before the panel answers a key.
  it("gates nothing while the scan is pending", async () => {
    const pending = deferred<Response>();
    const { keys, frame } = await mountPanel({
      list: async () => json(twoRows),
      scan: () => pending.promise,
    });

    await frame();
    keys.pressKey("j");
    const moved = await frame();
    expect(moved).toContain("scanning");
    expect(lineWith(moved, "alpha")).toContain("┃");
  });

  it("drops the suffix when the scan lands", async () => {
    const pending = deferred<Response>();
    const { frame } = await mountPanel({
      list: async () => json(twoRows),
      scan: () => pending.promise,
    });

    expect(await frame()).toContain("scanning");
    pending.resolve(json(merged));
    const landed = await frame();
    expect(landed).not.toContain("scanning");
    // ...and what it was waiting on is what the reader now sees: the row has
    // sunk into the removable section under its rule.
    const [titleAt, mainAt, ruleAt, alphaAt] = orderOf(
      landed,
      "Worktrees",
      "main checkout",
      "removable",
      "alpha",
    );
    expect(titleAt).toBeLessThan(mainAt!);
    expect(mainAt).toBeLessThan(ruleAt!);
    expect(ruleAt).toBeLessThan(alphaAt!);
  });

  it("drops the suffix when the scan fails, leaving one error line", async () => {
    const pending = deferred<Response>();
    const { frame } = await mountPanel({
      list: async () => json(twoRows),
      scan: () => pending.promise,
    });

    expect(await frame()).toContain("scanning");
    pending.reject(new Error("gh exploded"));
    const failed = await frame();
    expect(failed).not.toContain("scanning");
    // The existing failure line says it once; the title says nothing.
    expect(failed).toContain("Prune scan failed: gh exploded");
    expect(lineWith(failed, "Worktrees")).not.toContain("scan");
  });

  it("advances the spinner while the scan is pending", async () => {
    const pending = deferred<Response>();
    const { frame } = await mountPanel({
      list: async () => json(twoRows),
      scan: () => pending.promise,
    });

    const frames = [...DOT_SPINNER_FRAMES];
    const glyphOf = (text: string) =>
      frames.find((f) => lineWith(text, "scanning").includes(f));
    const before = glyphOf(await frame());
    expect(before).toBeDefined();
    // The real shared interval, which is what the title icon acquires.
    await new Promise((resolve) =>
      setTimeout(resolve, SPINNER_INTERVAL_MS + 80),
    );
    const after = glyphOf(await frame());
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  // At sidebar widths the title is the thing worth keeping. OpenTUI wraps
  // rather than clips, so an overlong title line does not truncate, it
  // vanishes out of its `height={1}` box.
  it("drops the suffix rather than the title when it cannot fit", async () => {
    const pending = deferred<Response>();
    const { frame } = await mountPanel(
      { list: async () => json(twoRows), scan: () => pending.promise },
      { compact: true, width: 24 },
    );
    const narrow = await frame();
    expect(narrow).toContain("Worktrees");
    expect(narrow).not.toContain("scanning");
  });

  // Tab re-fires both phases, and the slow scan from the previous scope is
  // still out there. The generation guard owns which one may speak.
  it("shows the suffix again for a re-fired scan and ignores the stale one", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const scans = [first, second];
    let handed = 0;
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(twoRows),
        scan: () => (scans[handed++] ?? second).promise,
      },
      { repo: "/repo" },
    );

    expect(await frame()).toContain("scanning");
    keys.pressTab();
    expect(await frame()).toContain("scanning");
    expect(handed).toBe(2);

    // The previous scope's scan lands late: it must not clear the indicator
    // for the scan that is still running, nor merge its rows.
    first.resolve(json(merged));
    const stale = await frame();
    expect(stale).toContain("scanning");
    expect(stale).not.toContain("removable");

    second.resolve(json(emptyScan));
    const settled = await frame();
    expect(settled).not.toContain("scanning");
    expect(settled).toContain("Worktrees");
  });
});

/**
 * The muted count on the title line: the list's size, said once, where the
 * scoped view's repo name already lives. Counts describe the LOADED list, so
 * phase 1 in flight says nothing rather than a number about to change.
 */
describe("WorktreesPanel title counts", () => {
  it("counts one repo's worktrees on the title line", async () => {
    const { settled } = await mountSettled(listOf([mainRow(), row()]));
    expect(lineWith(settled, "Worktrees · repo")).toContain("2 worktrees");
  });

  it("pluralizes for real", async () => {
    const { settled } = await mountSettled(listOf([mainRow()]));
    const title = lineWith(settled, "Worktrees · repo");
    expect(title).toContain("1 worktree");
    expect(title).not.toContain("1 worktrees");
  });

  it("counts repos and worktrees across a widened panel", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row(),
        mainRow({ path: "/other", repoRoot: "/other", repoName: "other" }),
      ]),
    );
    expect(lineWith(settled, "Worktrees")).toContain("2 repos · 3 worktrees");
  });

  it("says the counts and the scan together, counts first", async () => {
    const { frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: () => new Promise<Response>(() => {}),
    });
    const shown = await frame();
    const title = lineWith(shown, "scanning");
    const [countsAt, scanningAt] = orderOf(title, "2 worktrees", "scanning");
    expect(countsAt).toBeLessThan(scanningAt!);
  });

  it("says nothing while the list itself is loading", async () => {
    const { frame } = await mountPanel({
      list: () => new Promise<Response>(() => {}),
      scan: () => new Promise<Response>(() => {}),
    });
    // "Reading worktrees..." is on screen; a COUNT is not.
    expect(await frame()).not.toMatch(/\d+ worktrees/);
  });

  it("drops the counts whole with the rest of the suffix when narrow", async () => {
    const { settled } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      { compact: true, width: 24 },
    );
    expect(settled).toContain("Worktrees");
    expect(settled).not.toMatch(/\d+ worktrees/);
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
    // Plain words, and no `held:` prefix in front of a full sentence.
    expect(settled).toContain("agent working here");
    expect(settled).not.toContain("held:");
    expect(settled).toContain("PR #102 open");
    // Only the classified row sits under the rule, and only it has a box.
    expect(settled).toContain("removable · 1");
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

    // Line 1 carries the name and (only when it differs) the branch; every
    // other fact moved to the detail line, which is what buys the alignment.
    expect(lineWith(settled, "alpha")).toContain("feat/alpha");
    expect(settled).toContain("↑3 ↓4");
    expect(settled).toContain("2 modified · 1 untracked");
    expect(settled).toContain("claude working");
  });

  // The dirty opt-in used to sit behind the PR badge and the session list,
  // which made it the FIRST thing a narrow panel truncated: a row still
  // selectable with the one sentence explaining the hold-back missing. It now
  // rides the work it would delete, ahead of everything optional.
  it("keeps the dirty opt-in ahead of what a narrow panel drops", async () => {
    const { settled } = await mountSettled(
      listOf([row({ dirty: { dirty: true, modified: 3, untracked: 2 } })]),
      {
        candidates: [
          candidate({
            dirty: true,
            modified: 3,
            untracked: 2,
            reason: "upstream-gone",
            detail: "upstream origin/feat/alpha is gone",
          }),
        ],
        skipped: [],
      },
      { width: 80, height: 16 },
    );

    expect(settled).toContain("(D deletes them)");
    const [reason, note] = orderOf(settled, "branch gone", "(D deletes them)");
    expect(reason).toBeLessThan(note!);
  });

  it("marks the main checkout and never offers it a checkbox", async () => {
    const { settled } = await mountSettled(listOf([mainRow(), row()]), {
      candidates: [candidate()],
      skipped: [],
    });

    expect(lineWith(settled, "main checkout")).toContain("main");
    // Exactly one checkbox on screen, and it is not the main row's.
    expect(settled.match(/\[ \]/g)?.length ?? 0).toBe(1);
    expect(lineWith(settled, "main checkout")).not.toContain("[ ]");
  });
});

describe("WorktreesPanel structure", () => {
  // The complaint that started the redesign was "not sure what I am looking
  // at": rows bled into each other because nothing marked where one ended.
  it("ties a row's two lines together with a connector", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row({ dirty: { dirty: true, modified: 0, untracked: 4 } }),
      ]),
    );
    expect(isDetailLine(lineWith(settled, "4 untracked"))).toBe(true);
  });

  // The surface highlight spans both lines of a two-line cursor row, so a
  // bar on line 1 alone read as lopsided against it.
  it("wears the cursor bar on both lines of a two-line row", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow({ dirty: { dirty: true, modified: 1, untracked: 0 } }),
        row({ dirty: { dirty: true, modified: 0, untracked: 4 } }),
      ]),
    );
    // The cursor starts on the main checkout: both its lines carry the bar...
    expect(lineWith(settled, "main checkout")).toContain("┃");
    expect(lineWith(settled, "1 modified")).toContain("┃");
    // ...and neither line of the neighbouring row carries one.
    expect(lineWith(settled, "alpha")).not.toContain("┃");
    expect(lineWith(settled, "4 untracked")).not.toContain("┃");
  });

  it("collapses a worktree with nothing to report to a single line", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row({ path: "/repo/wt/quiet", name: "quiet", branch: "quiet" }),
        row({ path: "/repo/wt/zulu", name: "zulu", branch: "zulu" }),
      ]),
    );
    // No branch repeat...
    expect(lineWith(settled, "quiet")).not.toContain("quiet  quiet");
    // ...and the very next line is the NEXT ROW, so `quiet` took exactly one.
    // A session-less row's line 1 and a detail line are deliberately the same
    // shape (the rail plus an indent), so this is asserted by what follows it
    // rather than by the prefix.
    const lines = settled.split("\n");
    const at = lines.findIndex((l) => l.includes("quiet"));
    expect(lines[at + 1]).toContain("zulu");
  });

  // A per-row connector appeared and vanished down the list, which read as a
  // broken rail. Continuous means one-line rows carry it too.
  it("carries the rail across a row that has nothing to say", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow({ dirty: { dirty: true, modified: 1, untracked: 0 } }),
        row({ path: "/repo/wt/quiet", name: "quiet", branch: "quiet" }),
        row({
          path: "/repo/wt/busy",
          name: "busy",
          branch: "busy",
          sessions: [session({ status: "idle" })],
        }),
      ]),
    );
    const lines = settled.split("\n");
    const first = lines.findIndex((l) => l.includes("main checkout"));
    const last = lines.findIndex((l) => l.includes("busy"));
    // EVERY row line carries the rail, the first row and the quiet one
    // included; the bare line it hangs from is the title above the group.
    for (let i = first; i <= last; i++) {
      expect(hasRail(lines[i]!), `line ${i} lost the rail`).toBe(true);
    }
  });

  // With headers shown the header IS the group's first line, so every row
  // hangs off it. The rail starting one line later left a hole under each
  // header, with the rail floating from the detail line below.
  it("hangs the rail from the repo header in the multi-repo view", async () => {
    const { settled } = await mountSettled({
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
              branch: "delta",
            }),
          ],
        },
      ],
    });
    // Each group's first ROW is railed, headers or not...
    expect(hasRail(lineWith(settled, "main checkout"))).toBe(true);
    expect(hasRail(lineWith(settled, "delta"))).toBe(true);
    // ...while the header itself stays bare: it is the anchor.
    expect(hasRail(lineWith(settled, "other"))).toBe(false);
  });

  it("rails the first removable row when a group has no kept rows", async () => {
    const { settled } = await mountSettled(listOf([row()]), {
      candidates: [candidate()],
      skipped: [],
    });
    // The divider above the section is the group's first line here, so the
    // removable row below it still carries the rail.
    expect(lineWith(settled, "removable · 1")).toContain("├─");
    expect(hasRail(lineWith(settled, "alpha"))).toBe(true);
  });

  // The bracket marker is four columns with its space where a status icon is
  // two, so a fixed detail indent would leave the removable section's two
  // lines out of step with each other.
  it("indents a detail line to whatever marker its row used", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow({ dirty: { dirty: true, modified: 1, untracked: 0 } }),
        row(),
      ]),
      { candidates: [candidate()], skipped: [] },
    );
    const columnOf = (line: string, needle: string) => line.indexOf(needle);
    // A kept row: name and detail start in the same column.
    expect(columnOf(lineWith(settled, "main checkout"), "main checkout")).toBe(
      columnOf(lineWith(settled, "1 modified"), "1 modified"),
    );
    // A removable row: both shift right by the wider marker, together.
    const nameCol = columnOf(lineWith(settled, "alpha  "), "alpha");
    const detailCol = columnOf(lineWith(settled, "PR #68"), "PR #68");
    expect(nameCol).toBe(detailCol);
    // ...and that column really is further right than the kept section's.
    expect(nameCol).toBeGreaterThan(
      columnOf(lineWith(settled, "main checkout"), "main checkout"),
    );
  });

  it("sizes the marker slot for the glyph it holds", () => {
    expect(markerWidth(false)).toBe(2);
    expect(markerWidth(true)).toBe(4);
    expect(detailGutter(true) - detailGutter(false)).toBe(2);
  });

  it("runs the rail into the removable rule rather than stopping at it", async () => {
    const { settled } = await mountSettled(listOf([mainRow(), row()]), {
      candidates: [candidate()],
      skipped: [],
    });
    const rule = lineWith(settled, "removable · 1");
    expect(rule).toContain("├─ removable · 1");
    // The row below the rule still carries the rail.
    const lines = settled.split("\n");
    const at = lines.findIndex((l) => l.includes("removable · 1"));
    expect(hasRail(lines[at + 1]!)).toBe(true);
  });

  /**
   * The user asked "if it is working shouldn't it be the spinner?" of a
   * static orange dot. These pin the panel to the SESSION LIST's vocabulary
   * rather than a second one that happens to look similar.
   */
  it("spins a working row through the shared frames", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row({
          path: "/repo/wt/busy",
          name: "busy",
          branch: "busy",
          sessions: [session({ status: "working" })],
        }),
      ]),
    );
    const frames = [...DOT_SPINNER_FRAMES];
    const shown = lineWith(settled, "busy");
    expect(
      frames.some((f) => shown.includes(f)),
      `no spinner frame in ${JSON.stringify(shown)}`,
    ).toBe(true);
    // ...and it is NOT the idle dot.
    expect(shown).not.toContain("●");
  });

  it("advances the spinner when the shared frame ticks", async () => {
    const { settled, frame } = await mountSettled(
      listOf([
        mainRow(),
        row({
          path: "/repo/wt/busy",
          name: "busy",
          branch: "busy",
          sessions: [session({ status: "working" })],
        }),
      ]),
    );
    const frames = [...DOT_SPINNER_FRAMES];
    const glyphOf = (text: string) =>
      frames.find((f) => lineWith(text, "busy").includes(f));
    const before = glyphOf(settled);
    expect(before).toBeDefined();
    // Driven by the REAL shared interval rather than by a test-only setter:
    // the row's `useStatusIcon` acquires it on mount, so waiting one tick is
    // what a working row actually does.
    await new Promise((resolve) =>
      setTimeout(resolve, SPINNER_INTERVAL_MS + 80),
    );
    const after = glyphOf(await frame());
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  it("leaves an idle row on the steady dot", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row({
          path: "/repo/wt/parked",
          name: "parked",
          branch: "parked",
          sessions: [session({ status: "idle" })],
        }),
      ]),
    );
    const shown = lineWith(settled, "parked");
    expect(shown).toContain("●");
    for (const f of DOT_SPINNER_FRAMES) expect(shown).not.toContain(f);
  });

  it("marks a waiting row the way the session list does", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row({
          path: "/repo/wt/blocked",
          name: "blocked",
          branch: "blocked",
          sessions: [session({ status: "waiting" })],
        }),
      ]),
    );
    expect(lineWith(settled, "blocked")).toContain(
      getStatusIcon("waiting", null, "dot"),
    );
  });

  it("puts a single repo in the title instead of a header line", async () => {
    const { settled } = await mountSettled(listOf([mainRow(), row()]));
    expect(settled).toContain("Worktrees · repo");
    // The header line that would repeat it directly underneath is gone.
    const lines = settled.split("\n");
    const title = lines.findIndex((l) => l.includes("Worktrees · repo"));
    expect(lines[title + 1]).toContain("main checkout");
  });

  it("keeps a header per repo once there are several", async () => {
    const { settled } = await mountSettled({
      repos: [
        { repoRoot: "/repo", repoName: "repo", worktrees: [mainRow()] },
        {
          repoRoot: "/other",
          repoName: "other",
          worktrees: [
            row({ path: "/other/wt/d", repoRoot: "/other", repoName: "other" }),
          ],
        },
      ],
    });
    expect(settled).toContain("Worktrees");
    // The title carries the panel-wide counts, but never a repo NAME: with
    // several repos on screen, naming one of them up there would lie.
    expect(settled).not.toContain("Worktrees · repo");
    expect(settled).not.toContain("Worktrees · other");
    expect(settled).toContain("other");
    expect(settled).toContain("repo");
  });

  // The header renders INSIDE the scrollbox, which keeps a column for its
  // bar, so a name fitted to the panel's CONTENT width overruns it by one.
  // The line survives that (the scrollbox cuts it where the divider's single
  // unbreakable word wrapped away instead), but the last column goes with no
  // ellipsis to say so: the name reads as complete when it is not.
  it("fits a repo header to the scrollbox, not to the panel", async () => {
    const wide = "r".repeat(36);
    const { settled } = await mountSettled(
      {
        repos: [
          {
            repoRoot: "/wide",
            repoName: wide,
            worktrees: [
              row({ path: "/wide/wt/a", repoRoot: "/wide", repoName: wide }),
            ],
          },
          {
            repoRoot: "/other",
            repoName: "other",
            worktrees: [
              row({
                path: "/other/wt/d",
                repoRoot: "/other",
                repoName: "other",
              }),
            ],
          },
        ],
      },
      emptyScan,
      { width: 40 },
    );
    expect(settled).toContain("r".repeat(20));
    // Cut by the panel, which says so, rather than shaved by the renderer,
    // which does not.
    expect(lineWith(settled, "r".repeat(20))).toContain("…");
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
      "main checkout",
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
    expect(lineWith(before, "alpha")).toContain("┃");

    releaseScan(json({ candidates: [candidate()], skipped: [] }));
    const after = await frame();

    // A proven-finished worktree sinks below the healthy one.
    const [alphaAfter, bravoAfter] = orderOf(after, "alpha", "bravo");
    expect(bravoAfter).toBeLessThan(alphaAfter!);
    // ...and the cursor went with the row, not with the slot.
    expect(lineWith(after, "alpha")).toContain("┃");
    expect(lineWith(after, "bravo")).not.toContain("┃");
  });

  /**
   * A reload can drop the row the cursor was on. What the user must see
   * afterwards is a cursor on a row that exists, on screen, which is what
   * this pins.
   *
   * It does NOT isolate the re-seed itself, and cannot from out here: the
   * index falls back to row 0 on its own, and a reload remounts the list at
   * the top, so the stale-path state is invisible from the frame today. The
   * re-seed keeps the two halves of the cursor from describing different rows;
   * this keeps the behaviour they add up to.
   */
  it("puts the cursor on a visible row when a reload drops its own", async () => {
    const many = (count: number, skip?: string) =>
      listOf(
        Array.from(
          { length: count },
          (_, i) => `wt${String(i).padStart(2, "0")}`,
        )
          .filter((name) => name !== skip)
          .map((name) =>
            row({ path: `/repo/wt/${name}`, name, branch: `feat/${name}` }),
          ),
      );
    let body = many(30);
    const { keys, frame } = await mountPanel(
      { list: async () => json(body), scan: async () => json(emptyScan) },
      { repo: "/repo", height: 12 },
    );
    await frame();
    for (let i = 0; i < 20; i++) keys.pressKey("j");
    const scrolled = await frame();
    expect(lineWith(scrolled, "wt20")).toContain("┃");
    // Deep enough that the top of the list is out of view.
    expect(scrolled).not.toContain("wt00");

    // Tab refetches, and this scope no longer holds the cursor's row.
    body = many(30, "wt20");
    keys.pressTab();
    const after = await frame();
    expect(after).not.toContain("wt20");
    // The cursor is on the first row, and the first row is on screen.
    expect(lineWith(after, "wt00")).toContain("┃");
  });

  // A reopen (after a review round-trip or a cancelled dialog) seeds the
  // cursor back on the row the user left, not on the top of the list.
  it("seeds the cursor on the initialCursor row", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row({ path: "/repo/wt/bravo", name: "bravo", branch: "bravo" }),
      ]),
      emptyScan,
      { initialCursor: "/repo/wt/bravo" },
    );
    expect(lineWith(settled, "bravo")).toContain("┃");
    expect(lineWith(settled, "main checkout")).not.toContain("┃");
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
    expect(lineWith(before, "delta")).toContain("┃");

    keys.pressKey("j");
    const shown = await frame();
    // One `j` from the last row of a group lands on the first row of the
    // next, crossing the group header rather than selecting it.
    expect(lineWith(shown, "main checkout")).toContain("┃");
    expect(lineWith(shown, "delta")).not.toContain("┃");
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

    // Rows settle as main, the held one, then the candidate under the rule.
    const settled = await frame();
    const [main, held, rule, prunable] = orderOf(
      settled,
      "main checkout",
      "bravo",
      "removable ·",
      "alpha",
    );
    expect(held).toBeLessThan(rule!);
    expect(rule).toBeLessThan(prunable!);
    expect(main).toBeLessThan(held!);
    expect(held).toBeLessThan(prunable!);

    // Cursor starts on the main checkout, which has no removal to opt into,
    // so the removal keys are not even advertised there.
    keys.pressKey(" ");
    const onMain = await frame();
    expect(onMain).not.toContain("[x]");
    expect(onMain).not.toContain("x remove");

    // The held row is likewise unselectable, and says why in plain words.
    keys.pressKey("j");
    keys.pressKey(" ");
    const onHeld = await frame();
    expect(onHeld).not.toContain("[x]");
    expect(onHeld).toContain("locked");

    // The candidate is selectable, and the removal keys appear with it.
    keys.pressKey("j");
    keys.pressKey(" ");
    const onCandidate = await frame();
    expect(onCandidate).toContain("[x]");
    expect(onCandidate).toContain("x remove 1");
    // The dirty opt-in is advertised in words, not shorthand.
    expect(onCandidate).toContain("D include dirty");
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
    expect(await frame()).toContain("x remove 1");

    // Enter is the row action now: it must not reach the delete confirmation.
    keys.pressEnter();
    const afterEnter = await frame();
    expect(afterEnter).not.toContain("Remove worktrees?");
    expect(spawned).toBe(1);
    expect(jumped).toBe(0);

    keys.pressKey("x");
    expect(await frame()).toContain("Remove worktrees?");
  });

  it("routes enter by what the row holds", async () => {
    const jumps: WorktreeSession[] = [];
    const spawns: {
      cwd: string;
      existingWorktree: string | null;
      panelRepo: string | null;
      panelScope: string | null;
    }[] = [];
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
    expect(spawns[0]).toEqual({
      cwd: "/repo",
      existingWorktree: null,
      panelRepo: null,
      panelScope: null,
    });

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
      panelRepo: null,
      panelScope: null,
    });
  });

  // Tab's rescope is panel-local, so the payload must carry the LIVE filter
  // out with the action: a return that read the store instead landed back on
  // the narrow opening repo (wrong scope, lost cursor, cache miss at once).
  it("reports the live filter on its action payloads after Tab", async () => {
    const spawns: {
      cwd: string;
      existingWorktree: string | null;
      panelRepo: string | null;
      panelScope: string | null;
    }[] = [];
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(listOf([mainRow(), row()])),
        scan: async () => json(emptyScan),
      },
      { repo: "/repo", onSpawn: (t) => spawns.push(t) },
    );
    await frame();
    keys.pressKey("j");
    keys.pressEnter();
    expect(spawns[0]).toMatchObject({
      panelRepo: "/repo",
      panelScope: "/repo",
    });

    keys.pressTab();
    await frame();
    keys.pressEnter();
    expect(spawns[1]).toMatchObject({ panelRepo: "/repo", panelScope: null });
  });

  it("opens already widened when the return left from the widened view", async () => {
    const { keys, frame } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      { repo: "/repo", startWidened: true },
    );
    // Both phase reads went out unscoped: this IS the widened view...
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => !url.includes("repo="))).toBe(true);
    // ...and Tab can still narrow back to the opening repo.
    keys.pressTab();
    await frame();
    expect(requested.some((url) => url.includes("repo="))).toBe(true);
  });

  it("keeps D for the dirty opt-in and gives bare d to review", async () => {
    const reviewed: {
      path: string;
      sessionId: string | null;
      panelRepo: string | null;
      panelScope: string | null;
    }[] = [];
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
    expect(await frame()).toContain("x remove 1");
    expect(reviewed).toHaveLength(0);

    keys.pressKey("d");
    await frame();
    expect(reviewed).toEqual([
      {
        path: "/repo/wt/alpha",
        sessionId: null,
        panelRepo: null,
        panelScope: null,
      },
    ]);
    // Reviewing must not have disturbed the opt-in.
    expect(await frame()).toContain("x remove 1");
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

/**
 * `x` with an empty selection used to do nothing at all, which reads as a
 * broken key rather than as an empty selection.
 */
describe("x with nothing selected", () => {
  const oneClean = {
    list: async () => json(listOf([mainRow(), row()])),
    scan: async () => json({ candidates: [candidate()], skipped: [] }),
  };

  it("removes the row under the cursor when it is removable", async () => {
    const { keys, frame } = await mountPanel(oneClean);
    await frame();
    // Down onto the one removable row, then straight to x with no selection.
    keys.pressKey("j");
    keys.pressKey("x");
    const confirm = await frame();
    expect(confirm).toContain("Remove worktrees?");
    // Exactly that row, and the confirm still stands in front of it.
    expect(confirm).toContain("Delete 1 worktree and its branch?");
    expect(confirm).toContain("[x]");
  });

  it("says what is missing when the cursor is not on a removable row", async () => {
    const { keys, frame } = await mountPanel(oneClean);
    await frame();
    // Cursor starts on the main checkout.
    keys.pressKey("x");
    const shown = await frame();
    expect(shown).not.toContain("Remove worktrees?");
    expect(shown).toContain("nothing selected");
  });

  // A dirty row selected alone still removes nothing, so a confirm reading
  // "delete 0 worktrees" would be the same dead end wearing a dialog.
  it("names the key that unblocks a dirty row instead of confirming zero", async () => {
    const { keys, frame } = await mountPanel({
      list: async () =>
        json(
          listOf([row({ dirty: { dirty: true, modified: 0, untracked: 1 } })]),
        ),
      scan: async () =>
        json({
          candidates: [candidate({ dirty: true, untracked: 1 })],
          skipped: [],
        }),
    });
    await frame();
    keys.pressKey("x");
    const shown = await frame();
    expect(shown).not.toContain("Remove worktrees?");
    expect(shown).toContain("D includes it");
  });

  // Reached from a row that is not the dirty one: the selection is real and
  // the footer is counting it two lines below, so "nothing selected" says the
  // opposite of what the panel is showing.
  it("names the dirty gate when it is all that holds the selection", async () => {
    const { keys, frame } = await mountPanel({
      list: async () =>
        json(
          listOf([
            mainRow(),
            row({ dirty: { dirty: true, modified: 1, untracked: 0 } }),
          ]),
        ),
      scan: async () =>
        json({
          candidates: [candidate({ dirty: true, modified: 1 })],
          skipped: [],
        }),
    });
    await frame();
    keys.pressKey("j"); // onto the dirty candidate
    keys.pressKey(" "); // selected, but held back by the dirty gate
    keys.pressKey("k"); // back to the main checkout
    keys.pressKey("x");
    const shown = await frame();
    expect(shown).not.toContain("Remove worktrees?");
    expect(shown).not.toContain("nothing selected");
    expect(shown).toContain("D includes it");
  });

  it("counts the selection only once there is one", async () => {
    const { keys, frame } = await mountPanel(oneClean);
    await frame();
    keys.pressKey("j");
    const empty = await frame();
    expect(empty).toContain("x remove");
    expect(empty).not.toContain("x remove 0");
    keys.pressKey(" ");
    expect(await frame()).toContain("x remove 1");
  });
});

describe("removal confirm", () => {
  it("reads as a sentence for one worktree and for many", () => {
    expect(describeRemoval(1, 1)).toBe("Delete 1 worktree and its branch?");
    expect(describeRemoval(3, 2)).toBe("Delete 3 worktrees and 2 branches?");
    expect(describeRemoval(3, 1)).toBe("Delete 3 worktrees and 1 branch?");
    // A branch nobody is deleting is not mentioned.
    expect(describeRemoval(2, 0)).toBe("Delete 2 worktrees?");
    expect(describeRemoval(1, 0)).toBe("Delete 1 worktree?");
  });

  it("lists only the consequences that apply", () => {
    expect(
      removalDetails({ includedDirty: 0, blockedDirty: 0, ignoredFiles: 0 }),
    ).toEqual([]);
    expect(
      removalDetails({ includedDirty: 1, blockedDirty: 2, ignoredFiles: 3 }),
    ).toEqual([
      "including 1 worktree with uncommitted work",
      "skipping 2 dirty worktrees (needs D)",
      "3 ignored files go too",
    ]);
  });

  it("centers over a list that stays visible underneath", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => json({ candidates: [candidate()], skipped: [] }),
    });
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    const shown = await frame();
    expect(shown).toContain("Remove worktrees?");
    expect(shown).toContain("Y confirm");
    expect(shown).toContain("N cancel");
    // The panel is still the panel: title above, list behind, hints below.
    expect(shown).toContain("Worktrees · repo");
    expect(shown).toContain("main checkout");
    expect(shown).toContain("j/k move");
  });

  it("restores the list on esc with the selection intact", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => json({ candidates: [candidate()], skipped: [] }),
    });
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    expect(await frame()).toContain("Remove worktrees?");
    // A bare ESC is the prefix of every CSI sequence, so the parser holds it
    // briefly to see whether more bytes follow. `frame()`'s single macrotask
    // is not long enough (App.test.tsx waits the same way).
    keys.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const back = await frame();
    expect(back).not.toContain("Remove worktrees?");
    expect(back).toContain("x remove 1");
  });

  it("swallows every key but the answer while it is up", async () => {
    let closed = 0;
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(listOf([mainRow(), row()])),
        scan: async () => json({ candidates: [candidate()], skipped: [] }),
      },
      { onClose: () => closed++ },
    );
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    await frame();
    // `q` closes the panel everywhere else; here it must not.
    keys.pressKey("q");
    expect(closed).toBe(0);
    expect(await frame()).toContain("Remove worktrees?");
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
            reason: "merged-locally",
            detail: "merged into origin/main",
          }),
        ],
        skipped: [],
      },
      { compact: true, width: 44, height: 18 },
    );

    // Compact says the same words on the same two lines: the sidebar's old
    // third line existed only to hold a warning that is now a phrase like any
    // other. What compact changes is the ORDER, so the sentence about work
    // that would be deleted outlives the truncation and the reason (which the
    // rule above the row already gives categorically) is what gets cut.
    // Singular: one untracked file reads as `it`, not `them`.
    expect(settled).toContain("(D deletes it)");
    const detail = lineWith(settled, "(D deletes it)");
    expect(isDetailLine(detail)).toBe(true);
    expect(detail.indexOf("untracked")).toBeLessThan(
      detail.indexOf("(D deletes it)"),
    );
  });

  // fitHints drops whole entries by rank, so the grown label must vanish
  // entirely at sidebar width rather than wrapping (a wrapped height-1 line
  // vanishes and takes the whole hint row with it).
  it("drops the dirty hint whole at sidebar width instead of wrapping it", async () => {
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(listOf([row()])),
        scan: async () => json({ candidates: [candidate()], skipped: [] }),
      },
      { compact: true, width: 44, height: 18 },
    );
    await frame();
    keys.pressKey(" ");
    const settled = await frame();
    // The essential removal hint survives on its one line...
    const hintLines = settled.split("\n").filter((l) => l.includes("x remove"));
    expect(hintLines.length).toBe(1);
    // ...and the optional dirty hint is gone whole, not clipped mid-word.
    expect(settled).not.toContain("D include");
    expect(settled).not.toContain(" D ");
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
      "main checkout",
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

describe("titleSegments", () => {
  const title = "Worktrees · ccmux";
  const suffix = " · ◐ scanning";

  it("keeps the scanning suffix when both fit", () => {
    expect(titleSegments(title, suffix, 40).map((s) => s.text)).toEqual([
      title,
      suffix,
    ]);
  });

  // Whole, not truncated: half a word ("· ◐ scann…") is noise, and the columns
  // it eats are the ones naming the repo.
  it("drops the suffix rather than truncating it", () => {
    const fitted = titleSegments(title, suffix, displayWidth(title) + 4);
    expect(fitted.map((s) => s.text)).toEqual([title]);
  });

  it("keeps the whole suffix at the exact width it fits in", () => {
    const exact = displayWidth(title) + displayWidth(suffix);
    expect(titleSegments(title, suffix, exact)).toHaveLength(2);
    expect(titleSegments(title, suffix, exact - 1)).toHaveLength(1);
  });

  it("still fits the title itself, which OpenTUI would wrap away", () => {
    for (let width = 1; width <= displayWidth(title) + 2; width++) {
      const fitted = titleSegments(title, suffix, width);
      const used = fitted.reduce((n, s) => n + displayWidth(s.text), 0);
      expect(used).toBeLessThanOrEqual(width);
    }
  });

  it("renders the bare title when nothing is scanning", () => {
    expect(titleSegments(title, null, 40).map((s) => s.text)).toEqual([title]);
  });
});

/** The detail line as one string, which is how a reader sees it. */
function detailText(entry: PanelRow, dirtyOk = false): string {
  return detailSegments(entry, { compact: false, dirtyOk })
    .map((s) => s.text)
    .join("");
}

/** Line 1 as one string, cursor gutter excluded (the component draws that).
 *  `markerBase` defaults to the no-checkbox base a candidate-free panel
 *  uses; alignment tests across the divider pass the checkbox base. */
function primaryText(entry: PanelRow, labelWidth = 0, markerBase = 2): string {
  return primarySegments(entry, { isCursor: false, labelWidth, markerBase })
    .map((s) => s.text)
    .join("");
}

describe("row line 1", () => {
  // The loudest thing on the old screen was a worktree named after its branch
  // saying both, twice per row, for rows that had nothing else to report.
  it("omits a branch that only repeats the worktree name", () => {
    expect(rowBranch(row({ name: "fix-codex", branch: "fix-codex" }))).toBe("");
    expect(
      rowBranch(row({ name: "worktree-panel", branch: "feat/worktree-panel" })),
    ).toBe("feat/worktree-panel");
  });

  it("names the main checkout for what it is, not for its directory", () => {
    expect(rowLabel(mainRow())).toBe("main checkout");
    expect(rowLabel(row())).toBe("alpha");
  });

  // `main checkout  main` in every repo group said nothing. The branch is
  // news only when the main checkout sits somewhere unexpected.
  it("hides the main checkout's default branch, keeps an unexpected one", () => {
    expect(rowBranch(mainRow())).toBe("");
    expect(rowBranch(mainRow({ branch: "master" }))).toBe("");
    expect(rowBranch(mainRow({ branch: "feat/overlay" }))).toBe("feat/overlay");
    // The heuristic is scoped to the main checkout: a WORKTREE sitting on
    // main is unusual enough to say so.
    expect(rowBranch(row({ name: "wt-a", branch: "main" }))).toBe("main");
  });

  it("says detached rather than leaving the branch blank", () => {
    expect(rowBranch(row({ branch: null, detached: true }))).toBe("detached");
  });

  it("gives the main checkout a home icon and an agent row a dot", () => {
    expect(primaryText(panelRow({ row: mainRow() }))).toContain("⌂");
    expect(
      primaryText(panelRow({ row: row({ sessions: [session()] }) })),
    ).toContain("●");
    // A quiet worktree still marks the slot: rows are told apart from detail
    // lines by the marker column, so an empty slot would leave line 1 the
    // same shape as the line under it.
    expect(primaryText(panelRow())).toStartWith("· ");
  });

  // Checkboxes appear ONLY under the removable divider, which is what makes
  // an unexplained checkbox impossible.
  it("gives a checkbox to removable rows and to nothing else", () => {
    expect(primaryText(panelRow({ candidate: candidate() }))).toContain("[ ]");
    expect(
      primarySegments(panelRow({ candidate: candidate() }), {
        isCursor: false,
        labelWidth: 0,
        markerBase: 4,
        selected: true,
      })
        .map((s) => s.text)
        .join(""),
    ).toContain("[x]");
    expect(primaryText(panelRow())).not.toContain("[ ]");
    expect(primaryText(panelRow({ row: mainRow() }))).not.toContain("[ ]");
  });

  it("lines the branch column up across a group", () => {
    const rows = [
      panelRow({ row: row({ name: "a", branch: "feat/a" }) }),
      panelRow({ row: row({ name: "a-much-longer-name", branch: "feat/b" }) }),
    ];
    const width = labelColumnWidth(rows);
    expect(width).toBe("a-much-longer-name".length);
    const columnOf = (entry: PanelRow) =>
      primaryText(entry, width).indexOf("feat/");
    expect(columnOf(rows[0]!)).toBe(columnOf(rows[1]!));
  });

  // The branch column pads against the PANEL's widest marker, not the row's
  // own: a kept row's 2-column dot and a removable row's 4-column checkbox
  // must not put their branches two columns apart.
  it("keeps the branch column straight across the removable divider", () => {
    const kept = panelRow({ row: row({ name: "same-len", branch: "feat/a" }) });
    const removable = panelRow({
      row: row({ path: "/b", name: "same-len", branch: "feat/b" }),
      candidate: candidate({ path: "/b" }),
    });
    const width = labelColumnWidth([kept, removable]);
    const columnOf = (entry: PanelRow) =>
      primaryText(entry, width, 4).indexOf("feat/");
    expect(columnOf(kept)).toBe(columnOf(removable));
  });

  // One outlier name must not push every branch off the row.
  it("caps the column so a long name cannot eat the line", () => {
    const rows = [panelRow({ row: row({ name: "x".repeat(80) }) })];
    expect(labelColumnWidth(rows)).toBeLessThanOrEqual(28);
  });

  // Yellow means "removal would delete this work". A dirty main checkout is
  // Tuesday, and a panel of glowing names left no colour for the real risk.
  // The ordinary colour is the BRIGHT text tone: names are the loud layer of
  // a row, branches and detail phrases the dim one.
  it("keeps a dirty kept row's name in the ordinary bright colour, flags a dirty removable one", () => {
    const dirty = { dirty: true, modified: 2, untracked: 0 };
    const labelFg = (entry: PanelRow, isCursor = false) =>
      primarySegments(entry, { isCursor, labelWidth: 0, markerBase: 4 }).find(
        (s) => s.text === "alpha",
      )?.fg;
    expect(labelFg(panelRow({ row: row({ dirty }) }))).toBe(theme.text);
    const removable = panelRow({
      row: row({ dirty }),
      candidate: candidate({ dirty: true }),
    });
    expect(labelFg(removable)).toBe(theme.yellow);
    // The cursor row reads in the text colour wherever it is.
    expect(labelFg(removable, true)).toBe(theme.text);
  });
});

describe("row detail line", () => {
  it("draws nothing for a healthy, quiet, clean worktree", () => {
    expect(
      detailSegments(panelRow(), { compact: false, dirtyOk: false }),
    ).toEqual([]);
    // ...which is what lets such a row collapse to a single line.
    expect(rowVisualHeight(panelRow(), false)).toBe(1);
  });

  it("spells uncommitted work out and omits the zero halves", () => {
    expect(dirtyPhrases(row())).toEqual([]);
    expect(
      dirtyPhrases(row({ dirty: { dirty: true, modified: 2, untracked: 4 } })),
    ).toEqual(["2 modified", "4 untracked"]);
    expect(
      dirtyPhrases(row({ dirty: { dirty: true, modified: 0, untracked: 4 } })),
    ).toEqual(["4 untracked"]);
    expect(
      dirtyPhrases(row({ dirty: { dirty: true, modified: 2, untracked: 0 } })),
    ).toEqual(["2 modified"]);
  });

  // Same rule as the name colour: counts are information on a kept row and a
  // warning only where a removal would delete the work being counted.
  it("colours dirty counts as information on kept rows, warning on removable", () => {
    const dirty = { dirty: true, modified: 2, untracked: 4 };
    const kept = detailSegments(panelRow({ row: row({ dirty }) }), {
      compact: false,
      dirtyOk: false,
    });
    expect(kept.find((s) => s.text === "2 modified")?.fg).toBe(theme.subtext);

    const removable = panelRow({
      row: row({ dirty }),
      candidate: candidate({ dirty: true, modified: 2, untracked: 4 }),
    });
    const segs = detailSegments(removable, { compact: false, dirtyOk: false });
    expect(segs.find((s) => s.text === "2 modified")?.fg).toBe(theme.yellow);
    expect(segs.find((s) => s.text.includes("(D deletes them)"))?.fg).toBe(
      theme.yellow,
    );
    const armed = detailSegments(removable, { compact: false, dirtyOk: true });
    expect(armed.find((s) => s.text.includes("D armed"))?.fg).toBe(theme.red);
  });

  // `readDirtyState` reports a worktree whose `git status` FAILED as dirty
  // with both counts at zero, which is the safe direction for a destructive
  // action and used to leave the row with nothing at all to say.
  it("still says a worktree is dirty when it cannot say how dirty", () => {
    expect(
      dirtyPhrases(row({ dirty: { dirty: true, modified: 0, untracked: 0 } })),
    ).toEqual(["uncommitted work"]);
  });

  // The note rides the LAST dirty phrase, so no phrase meant the destructive
  // opt-in produced no visible change on screen at all.
  it("hangs the opt-in note on an uncounted dirty row", () => {
    const entry = panelRow({
      row: row({ dirty: { dirty: true, modified: 0, untracked: 0 } }),
      candidate: candidate({ dirty: true }),
    });
    // Both counts at zero: the uncounted fallback reads as singular work.
    expect(detailText(entry)).toContain("uncommitted work (D deletes it)");
    expect(detailText(entry, true)).toContain(
      "uncommitted work (D armed, will be deleted)",
    );
  });

  // The phrases read the phase-1 list and the note gates on the phase-2 scan.
  // They are separate reads joined by path, so the scan can be the only half
  // that saw the work, and the row still has to show what `D` would delete.
  it("speaks for uncommitted work only the scan saw", () => {
    const entry = panelRow({
      row: row({ dirty: { dirty: false, modified: 0, untracked: 0 } }),
      candidate: candidate({ dirty: true, modified: 2 }),
    });
    // The note pluralizes from the LIST's counts, and here only the scan has
    // any: it rides the singular fallback phrase, so `it` is the right word.
    expect(detailText(entry)).toContain("uncommitted work (D deletes it)");
    // Stated once: the fallback stands IN for the phrases, never beside them.
    expect(detailText(entry).match(/uncommitted work/g)).toHaveLength(1);
  });

  it("does not add the fallback beside counts that exist", () => {
    const entry = panelRow({
      row: row({ dirty: { dirty: true, modified: 2, untracked: 0 } }),
      candidate: candidate({ dirty: true, modified: 2 }),
    });
    expect(detailText(entry)).toBe(
      "PR #68 merged · 2 modified (D deletes them)",
    );
  });

  it("says what is gone rather than a bare gone", () => {
    expect(
      formatTracking(
        row({
          upstream: { upstream: "origin/x", gone: true, ahead: 0, behind: 0 },
        }),
      ),
    ).toBe("branch gone");
    expect(formatTracking(row())).toBe("");
    expect(
      formatTracking(
        row({
          upstream: { upstream: "origin/x", gone: false, ahead: 2, behind: 1 },
        }),
      ),
    ).toBe("↑2 ↓1");
    expect(
      formatTracking(row({ branch: null, detached: true, upstream: null })),
    ).toBe("");
  });

  // The old row said `PR #100 merged  #100 MERGED`: the reason and the badge
  // were rendered as independent facts about the same pull request.
  it("states a pull request once, never as reason plus badge", () => {
    const pr = { number: 100, url: "u", state: "MERGED" as const };
    const text = detailText(
      panelRow({
        candidate: candidate({ reason: "pr-merged", pr }),
        pr,
      }),
    );
    expect(text).toContain("PR #100 merged");
    expect(text).not.toContain("MERGED");
    expect(text.match(/#100/g)).toHaveLength(1);
  });

  it("keeps an open pull request on a healthy row", () => {
    const text = detailText(
      panelRow({ pr: { number: 101, url: "u", state: "OPEN" } }),
    );
    expect(text).toBe("PR #101 open");
  });

  // The reason and the tracking state are the same event: `upstream-gone` IS
  // "branch gone", and a merged PR is why GitHub deleted the branch.
  it("does not say the branch is gone twice", () => {
    const text = detailText(
      panelRow({
        row: row({
          upstream: { upstream: "origin/x", gone: true, ahead: 0, behind: 0 },
        }),
        candidate: candidate({ reason: "upstream-gone" }),
      }),
    );
    expect(text.match(/branch gone/g)).toHaveLength(1);
    // Same for a merged PR whose branch went with it.
    const merged = detailText(
      panelRow({
        row: row({
          upstream: { upstream: "origin/x", gone: true, ahead: 0, behind: 0 },
        }),
        candidate: candidate({
          reason: "pr-merged",
          pr: { number: 100, url: "u", state: "MERGED" },
        }),
      }),
    );
    expect(merged).toBe("PR #100 merged");
  });

  it("puts removal reasons in plain words", () => {
    expect(
      describeReason(
        candidate({
          reason: "pr-merged",
          pr: { number: 68, url: "u", state: "MERGED" },
        }),
      ),
    ).toBe("PR #68 merged");
    expect(describeReason(candidate({ reason: "upstream-gone" }))).toBe(
      "branch gone",
    );
    // The remote the reader never asked about is dropped.
    expect(
      describeReason(
        candidate({
          reason: "merged-locally",
          detail: "merged into origin/main",
        }),
      ),
    ).toBe("merged into main");
  });

  // The reasons come off the wire from a daemon that may be NEWER than this
  // build. An unrecognized one still puts a checkbox on the row, so it must
  // still put a sentence beside it: a checkbox nothing explains is the one
  // thing the removable section rules out.
  it("falls back to the daemon's own words for a reason it does not know", () => {
    const future = candidate({
      reason: "abandoned" as unknown as PruneCandidate["reason"],
      detail: "untouched for 90 days",
    });
    expect(describeReason(future)).toBe("untouched for 90 days");
    expect(detailText(panelRow({ candidate: future }))).toBe(
      "untouched for 90 days",
    );
  });

  it("drops the daemon's article from a withheld reason", () => {
    expect(describeSkip("an agent is working here")).toBe("agent working here");
    expect(describeSkip("locked")).toBe("locked");
  });

  // `locked` is phase-1 truth, so it must not wait for the scan and must not
  // then be said twice when the scan repeats it.
  it("says locked once, from the worktree itself", () => {
    const text = detailText(
      panelRow({
        row: row({ locked: true }),
        skip: {
          path: "/repo/wt/alpha",
          repoRoot: "/repo",
          branch: "feat/alpha",
          reason: "locked",
        },
      }),
    );
    expect(text.match(/locked/g)).toHaveLength(1);
  });

  /**
   * The scan's liveness gate and the session summary are the same fact, and
   * the summary says it better (it names the agent and counts them). This
   * showed up live as "agent working here · 4 modified · claude working".
   */
  it("lets the session summary speak for a live worktree", () => {
    const text = detailText(
      panelRow({
        row: row({ sessions: [session({ status: "working" })] }),
        skip: {
          path: "/repo/wt/alpha",
          repoRoot: "/repo",
          branch: "feat/alpha",
          reason: "an agent is working here",
        },
      }),
    );
    expect(text).toBe("claude working");
    expect(text).not.toContain("agent working here");
  });

  // Without a summary to defer to, the gate is the only thing that knows.
  it("keeps the liveness reason when there is no session to state it", () => {
    const text = detailText(
      panelRow({
        skip: {
          path: "/repo/wt/alpha",
          repoRoot: "/repo",
          branch: "feat/alpha",
          reason: "an agent is idle here",
        },
      }),
    );
    expect(text).toBe("agent idle here");
  });

  // A lock is not a liveness fact, so it survives alongside the summary.
  it("keeps a locked row's lock beside its session summary", () => {
    const text = detailText(
      panelRow({
        row: row({ locked: true, sessions: [session({ status: "idle" })] }),
        skip: {
          path: "/repo/wt/alpha",
          repoRoot: "/repo",
          branch: "feat/alpha",
          reason: "locked",
        },
      }),
    );
    expect(text).toBe("locked · claude idle");
  });

  // Nor is an unresolvable PR state: nothing else on the row carries it.
  it("keeps a non-liveness reason beside the session summary", () => {
    const text = detailText(
      panelRow({
        row: row({ sessions: [session({ status: "idle" })] }),
        skip: {
          path: "/repo/wt/alpha",
          repoRoot: "/repo",
          branch: "feat/alpha",
          reason: "PR state could not be determined: gh is not installed",
        },
      }),
    );
    expect(text).toContain("PR state could not be determined");
    expect(text).toContain("claude idle");
  });

  it("recognizes the liveness gate by the daemon's own wording", () => {
    expect(isLivenessSkip("an agent is working here")).toBe(true);
    expect(isLivenessSkip("an agent is idle here")).toBe(true);
    expect(isLivenessSkip("an agent is waiting here")).toBe(true);
    // Anything unrecognized keeps its phrase rather than losing the fact.
    expect(isLivenessSkip("locked")).toBe(false);
    expect(isLivenessSkip("PR state could not be determined: x")).toBe(false);
  });

  it("names one agent and counts several", () => {
    expect(describeSessions([])).toBe("");
    expect(describeSessions([session({ status: "working" })])).toBe(
      "claude working",
    );
    expect(
      describeSessions([
        session({ status: "idle" }),
        session({ id: "s2", status: "idle" }),
        session({ id: "s3", status: "idle" }),
      ]),
    ).toBe("3 agents idle");
    // A mixed group leads with the count worth acting on.
    expect(
      describeSessions([
        session({ status: "idle" }),
        session({ id: "s2", status: "waiting" }),
      ]),
    ).toBe("2 agents, 1 waiting");
  });

  it("attaches the dirty opt-in to the work it would delete", () => {
    const entry = panelRow({
      row: row({ dirty: { dirty: true, modified: 0, untracked: 1 } }),
      candidate: candidate({ dirty: true, untracked: 1 }),
    });
    expect(detailText(entry)).toContain("1 untracked (D deletes it)");
    expect(detailText(entry, true)).toContain("D armed");
  });

  // A row nobody can remove has no opt-in to offer.
  it("leaves a healthy dirty row's counts unqualified", () => {
    const text = detailText(
      panelRow({
        row: row({ dirty: { dirty: true, modified: 3, untracked: 0 } }),
      }),
    );
    expect(text).toBe("3 modified");
  });

  it("separates phrases with a middle dot", () => {
    const text = detailText(
      panelRow({
        row: row({
          dirty: { dirty: true, modified: 0, untracked: 4 },
          sessions: [
            session({ status: "idle" }),
            session({ id: "s2", status: "idle" }),
          ],
        }),
      }),
    );
    expect(text).toBe("4 untracked · 2 agents idle");
  });
});

describe("removable section", () => {
  it("splits a group at the classified rows", () => {
    const kept = panelRow({ row: row({ path: "/a", name: "a" }) });
    const gone = panelRow({
      row: row({ path: "/b", name: "b" }),
      candidate: candidate({ path: "/b" }),
    });
    const split = splitRemovable([kept, gone]);
    expect(split.kept.map((e) => e.row.path)).toEqual(["/a"]);
    expect(split.removable.map((e) => e.row.path)).toEqual(["/b"]);
  });

  it("rules off the section with its count", () => {
    const text = dividerText(6, 40);
    // A tee, so the rail runs into the rule instead of stopping at it.
    expect(text).toStartWith("├─ removable · 6 ");
    expect(displayWidth(text)).toBe(40);
    // A width too small to hold the label must not produce a negative repeat.
    expect(displayWidth(dividerText(6, 4))).toBeGreaterThan(0);
  });

  // On a 200-column terminal a full-width dash run per repo is the heaviest
  // ink on the screen; the rule reads as a break at a fraction of that.
  it("caps the rule instead of filling a wide terminal", () => {
    expect(displayWidth(dividerText(6, 200))).toBe(DIVIDER_MAX);
    // A narrower list still rules to its own edge, not past it.
    expect(displayWidth(dividerText(6, 40))).toBe(40);
  });

  // The header's trailing rule is what makes a group boundary scannable on a
  // tall multi-repo list without spending a blank line on it.
  it("rules a repo header out to the full list width", () => {
    // A space, then dashes to the width: name + rule together fill it.
    expect(headerRule("ccmux", 40)).toBe(` ${"─".repeat(34)}`);
    expect(displayWidth("ccmux" + headerRule("ccmux", 40))).toBe(40);
    // Full width, unlike the removable divider's capped run: the header is
    // the panel's primary boundary, the divider a break inside one group.
    expect(displayWidth("ccmux" + headerRule("ccmux", 200))).toBe(200);
  });

  it("drops the header rule whole when the name leaves no room", () => {
    // No room for a space plus at least one dash: no rule, never a negative
    // repeat. The name itself is fitted by the caller.
    expect(headerRule("ccmux", 5)).toBe("");
    expect(headerRule("ccmux", 6)).toBe("");
    expect(headerRule("ccmux", 7)).toBe(" ─");
    expect(headerRule("a-name-longer-than-the-width", 10)).toBe("");
  });

  // The divider is not a row, but it IS a line: a layout without it puts
  // every row below the divider one line out.
  it("counts the divider in the line layout", () => {
    const kept = panelRow({ row: row({ path: "/a", name: "a" }) });
    const gone = panelRow({
      row: row({ path: "/b", name: "b" }),
      candidate: candidate({ path: "/b" }),
    });
    const other = panelRow({ row: row({ path: "/c", name: "c" }) });
    const repos = [
      { repoRoot: "/r1", repoName: "r1", rows: [kept, gone] },
      { repoRoot: "/r2", repoName: "r2", rows: [other] },
    ];
    const layout = visualLayout(repos, () => 1);
    // header(0) | a(1) | divider(2) | b(3) | header(4) | c(5)
    expect(layout.get("/a")).toEqual({ line: 1, height: 1 });
    expect(layout.get("/b")).toEqual({ line: 3, height: 1 });
    expect(layout.get("/c")).toEqual({ line: 5, height: 1 });
  });

  it("drops the group header line when there is only one repo", () => {
    const only = panelRow({ row: row({ path: "/a", name: "a" }) });
    const one = [{ repoRoot: "/r", repoName: "r", rows: [only] }];
    expect(showsGroupHeaders(one)).toBe(false);
    expect(visualLayout(one, () => 1).get("/a")).toEqual({
      line: 0,
      height: 1,
    });
    const two = [
      ...one,
      {
        repoRoot: "/r2",
        repoName: "r2",
        rows: [panelRow({ row: row({ path: "/b", name: "b" }) })],
      },
    ];
    expect(showsGroupHeaders(two)).toBe(true);
    expect(visualLayout(two, () => 1).get("/a")).toEqual({
      line: 1,
      height: 1,
    });
  });
});

describe("visual scrolling", () => {
  it("counts a plain row as one line and a detailed one as two", () => {
    expect(rowVisualHeight(panelRow(), false)).toBe(1);
    expect(rowVisualHeight(panelRow({ candidate: candidate() }), false)).toBe(
      2,
    );
  });

  // Compact no longer spends a third line on the dirty warning: it is a
  // phrase on the detail line like every other fact.
  it("is the same height in compact as at full width", () => {
    const entry = panelRow({
      row: row({ dirty: { dirty: true, modified: 0, untracked: 1 } }),
      candidate: candidate({ dirty: true, untracked: 1 }),
    });
    expect(rowVisualHeight(entry, true)).toBe(2);
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
    // header(0) | a(1) | divider(2) | b(3,4) | header(5) | c(6). `b` is
    // classified, so it sits under its group's removable divider.
    expect(layout.get("/a")).toEqual({ line: 1, height: 1 });
    expect(layout.get("/b")).toEqual({ line: 3, height: 2 });
    expect(layout.get("/c")).toEqual({ line: 6, height: 1 });
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
    // One repo, so no header line: eleven rows above it, and its own line is
    // the twelfth (index 11), which must sit on the viewport's last line.
    expect(scrollTargetFor(after, "/w/0", 0, 6)).toBe(6);
  });
});

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

// `normalizeScan` itself is unit-tested beside the scan it normalizes, in
// src/daemon/worktree-prune.test.ts. What belongs here is the panel actually
// surviving the older daemon's body.
describe("normalizeScan", () => {
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

describe("pruneFullySucceeded", () => {
  it("holds only when every worktree was removed with every step ok", () => {
    expect(
      pruneFullySucceeded(runResult([outcome(), outcome({ path: "/b" })])),
    ).toBe(true);
  });

  it("fails on a refusal, a recorded error, or a failed step", () => {
    expect(pruneFullySucceeded(runResult([outcome({ removed: false })]))).toBe(
      false,
    );
    expect(pruneFullySucceeded(runResult([outcome({ error: "boom" })]))).toBe(
      false,
    );
    // A removed worktree can still carry a failed step (a surviving branch,
    // a skipped liveness check); that detail must stay on screen.
    expect(
      pruneFullySucceeded(
        runResult([
          outcome({
            steps: [
              {
                step: "live-pane check skipped",
                ok: false,
                detail: "tmux could not be listed",
              },
            ],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it("treats an empty run as not a success", () => {
    expect(pruneFullySucceeded(runResult([]))).toBe(false);
  });
});

describe("removalNotice", () => {
  it("pluralizes for real", () => {
    expect(removalNotice(1)).toBe("removed 1 worktree");
    expect(removalNotice(3)).toBe("removed 3 worktrees");
  });
});

describe("WorktreesPanel prune outcome", () => {
  it("returns to the list with a title notice when every removal succeeded", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => json({ candidates: [candidate()], skipped: [] }),
      prune: async () => json(runResult([outcome()])),
    });
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    expect(await frame()).toContain("Remove worktrees?");
    keys.pressKey("y");
    await frame();
    const after = await frame();
    // Back on the list (freshly reloaded), not parked on the outcome screen...
    expect(after).not.toContain("✓");
    expect(after).toContain("main checkout");
    // ...with the run's one-line record riding the title.
    expect(after).toContain("removed 1 worktree");
  });

  it("keeps the outcome screen when anything failed", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => json({ candidates: [candidate()], skipped: [] }),
      prune: async () =>
        json(
          runResult([
            outcome(),
            outcome({
              path: "/repo/wt/bravo",
              removed: false,
              steps: [{ step: "refused", ok: false, detail: "occupied" }],
            }),
          ]),
        ),
    });
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    keys.pressKey("y");
    await frame();
    const after = await frame();
    // The partial failure is exactly what the per-row screen exists for.
    expect(after).toContain("✗ /repo/wt/bravo");
    expect(after).not.toContain("removed 2 worktrees");
  });
});

describe("WorktreesPanel scan cache", () => {
  it("answers only for the scope it was scanned for", () => {
    const scan = { candidates: [candidate()], skipped: [], open: [] };
    expect(cachedScanFor(null, "/repo")).toBeNull();
    expect(cachedScanFor({ scope: "/repo", scan }, "/repo")).toBe(scan);
    expect(cachedScanFor({ scope: "/repo", scan }, "/other")).toBeNull();
    expect(cachedScanFor({ scope: null, scan }, null)).toBe(scan);
    expect(cachedScanFor({ scope: "/repo", scan }, null)).toBeNull();
  });

  it("seeds a return-open from the last completed scan, without rescanning", async () => {
    // A first open completes a real scan, which is what fills the cache.
    await mountSettled(listOf([mainRow(), row()]), {
      candidates: [candidate()],
      skipped: [],
    });
    setup!.renderer.destroy();
    setup = undefined;
    fetchSpy!.mockRestore();

    // The return-open's own scan never resolves: only the cache can
    // classify, and it must not even be asked.
    let scanCalls = 0;
    const { frame } = await mountPanel(
      {
        list: async () => json(listOf([mainRow(), row()])),
        scan: () => {
          scanCalls++;
          return new Promise<Response>(() => {});
        },
      },
      { isReturn: true, initialCursor: "/repo/wt/alpha" },
    );
    const shown = await frame();
    expect(shown).toContain("removable · 1");
    expect(shown).toContain("PR #68 merged");
    expect(shown).not.toContain("scanning");
    expect(scanCalls).toBe(0);
  });

  it("ignores the cache on a plain open", async () => {
    await mountSettled(listOf([mainRow(), row()]), {
      candidates: [candidate()],
      skipped: [],
    });
    setup!.renderer.destroy();
    setup = undefined;
    fetchSpy!.mockRestore();

    let scanCalls = 0;
    const { frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: () => {
        scanCalls++;
        return new Promise<Response>(() => {});
      },
    });
    const shown = await frame();
    // Fresh opens rescan for real, so PR badges cannot go stale quietly.
    expect(shown).toContain("scanning");
    expect(shown).not.toContain("PR #68 merged");
    expect(scanCalls).toBe(1);
  });

  it("does not cache a failed scan", async () => {
    await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => {
        throw new Error("gh exploded");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    setup!.renderer.destroy();
    setup = undefined;
    fetchSpy!.mockRestore();

    const { frame } = await mountPanel(
      {
        list: async () => json(listOf([mainRow(), row()])),
        scan: () => new Promise<Response>(() => {}),
      },
      { isReturn: true },
    );
    // Nothing worth reusing was stored, so the return-open scans for real.
    expect(await frame()).toContain("scanning");
  });

  it("is cleared by a prune run", async () => {
    // The first scan fills the cache; the post-removal reload's scan hangs,
    // so if the cache survives the prune the return-open below would render
    // the stale candidate instead of scanning.
    let scans = 0;
    const list = () => json(listOf([mainRow(), row()]));
    const hangAfterFirst = () => {
      scans++;
      if (scans === 1) {
        return Promise.resolve(
          json({ candidates: [candidate()], skipped: [] }),
        );
      }
      return new Promise<Response>(() => {});
    };
    const { keys, frame } = await mountPanel({
      list: async () => list(),
      scan: hangAfterFirst,
      prune: async () => json(runResult([outcome()])),
    });
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    keys.pressKey("y");
    await frame();
    await frame();
    setup!.renderer.destroy();
    setup = undefined;
    fetchSpy!.mockRestore();

    const { frame: frame2 } = await mountPanel(
      {
        list: async () => list(),
        scan: () => new Promise<Response>(() => {}),
      },
      { isReturn: true },
    );
    const shown = await frame2();
    expect(shown).toContain("scanning");
    expect(shown).not.toContain("PR #68 merged");
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
    expect(shown).toContain("x remove");
  });

  it("arms a dirty row with D and disarms it again", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(dirtyList),
      scan: async () => json(dirtyScan),
    });
    await frame();
    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("x remove 1");
    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("x remove");
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
    expect(await frame()).toContain("x remove 1");
  });

  // A dirty opt-in must not outlive the selection that carried it.
  it("clears a dirty opt-in when a deselects everything", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(dirtyList),
      scan: async () => json(dirtyScan),
    });
    await frame();
    keys.pressKey("D", { shift: true });
    expect(await frame()).toContain("x remove 1");
    keys.pressKey("a"); // deselects: the only row is dirty
    expect(await frame()).toContain("x remove");
    keys.pressKey(" "); // reselect by hand, with no fresh D
    expect(await frame()).toContain("x remove");
  });

  it("names the destructive case at the confirmation step", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(dirtyList),
      scan: async () => json(dirtyScan),
    });
    await frame();
    keys.pressKey("D", { shift: true });
    keys.pressKey("x");
    const confirm = await frame();
    expect(confirm).toContain("Remove worktrees?");
    expect(confirm).toContain("including 1 worktree with uncommitted work");
  });

  it("backs out of confirm with n", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(cleanList),
      scan: async () => json(cleanScan),
    });
    await frame();
    keys.pressKey(" ");
    keys.pressKey("x");
    expect(await frame()).toContain("Remove worktrees?");
    keys.pressKey("n");
    const back = await frame();
    expect(back).not.toContain("Remove worktrees?");
    // The selection survives the cancel.
    expect(back).toContain("x remove 1");
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

  /**
   * The daemon exempts the requesting surface's own pane from its live-pane
   * occupancy guard. The picker's popup is invisible to that guard anyway (a
   * `display-popup` never appears in `list-panes -a`), but the SIDEBAR runs in
   * a real pane, so without this it would refuse to prune the worktree it is
   * itself sitting in.
   */
  async function pruneBody(): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    const { keys, frame } = await mountPanel({
      list: async () => json(cleanList),
      scan: async () => json(cleanScan),
    });
    await frame();
    fetchSpy!.mockImplementation((async (
      input: unknown,
      init?: RequestInit,
    ) => {
      if (String(input).includes("/worktrees/prune") && init?.body) {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      }
      return json({ outcomes: [] });
    }) as unknown as typeof fetch);
    keys.pressKey(" ");
    keys.pressKey("x");
    keys.pressKey("y");
    await frame();
    return body;
  }

  it("names its own pane so the guard does not refuse on it", async () => {
    const original = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%7";
    try {
      expect(await pruneBody()).toMatchObject({ callerPane: "%7" });
    } finally {
      if (original === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = original;
    }
  });

  // Outside tmux there is no pane to exempt, and the field is optional on the
  // wire: it must be ABSENT rather than sent as null or an empty string.
  it("omits the pane entirely when there is none", async () => {
    const original = process.env.TMUX_PANE;
    delete process.env.TMUX_PANE;
    try {
      expect(await pruneBody()).not.toHaveProperty("callerPane");
    } finally {
      if (original !== undefined) process.env.TMUX_PANE = original;
    }
  });
});
