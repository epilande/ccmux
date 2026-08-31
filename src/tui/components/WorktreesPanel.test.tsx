import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testRender } from "@opentui/solid";
import { RGBA, type CapturedFrame, type CapturedSpan } from "@opentui/core";
import { createMockKeys, createMockMouse } from "@opentui/core/testing";
import { deliverEscape } from "./test-helpers";
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
import type { OpenPR, PRListResponse } from "../../daemon/pr-list";
import {
  WorktreesPanel,
  clipboardArgv,
  copyToClipboard,
  describeRemoval,
  describeReason,
  describeSessions,
  describeSkip,
  detailSegments,
  headerLayout,
  headerParts,
  fitTabs,
  dirtyPhrases,
  formatTracking,
  isLivenessSkip,
  cachedScanFor,
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
  dividerText,
  headerRule,
  sortWorktreeRows,
  showsGroupHeaders,
  splitRemovable,
  visualLayout,
  worktreeHoldsPath,
  browserArgv,
  CURSOR_BAR,
  detailPhrases,
  openInBrowser,
  prStatusText,
  prStatusRowKey,
  prStatusRowRepo,
  type HeaderLayout,
  type ViewTab,
  initialView,
  PRS_TAB,
  WORKTREES_TAB,
  PRS_TAB_SHORT,
  rowPRUrl,
  type PanelRepo,
  type PanelRow,
  type PRPanelRow,
  type WorktreePanelRow,
} from "./WorktreesPanel";
import {
  fitSegments,
  oneLine,
  orderRepos,
  scrollTargetFor,
} from "./row-segments";
import {
  PR_MARKER,
  checkoutHolding,
  describeChecks,
  describeReview,
  isPRRowKey,
  prRowKey,
} from "./pr-rows";
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

function panelRow(overrides: Partial<WorktreePanelRow> = {}): WorktreePanelRow {
  const base = {
    kind: "worktree" as const,
    row: row(),
    candidate: null,
    skip: null,
    pr: null,
  };
  const merged = { ...base, ...overrides };
  // The key follows the row unless a test names one, which is what every
  // caller means: `panelRow({ row: row({ path: "/x" }) })` is a row at `/x`.
  return { key: overrides.key ?? merged.row.path, ...merged };
}

function openPR(overrides: Partial<OpenPR> = {}): OpenPR {
  return {
    number: 151,
    title: "Worktrees panel: open-PR list",
    url: "https://github.com/o/r/pull/151",
    author: "epilande",
    isDraft: false,
    reviewDecision: null,
    ciStatus: "none",
    headRefName: "feat/pr-list-panel",
    headRefOid: "sha-151",
    ...overrides,
  };
}

function prRow(overrides: Partial<PRPanelRow> = {}): PRPanelRow {
  const base = {
    kind: "pr" as const,
    repoRoot: "/repo",
    pr: openPR(),
    checkedOutPath: null,
    checkedOutName: null,
  };
  const merged = { ...base, ...overrides };
  return {
    key: overrides.key ?? prRowKey(merged.repoRoot, merged.pr.number),
    ...merged,
  };
}

/** One `GET /prs` body, grouping every PR under one repo. */
function prsOf(prs: OpenPR[], repoRoot = "/repo"): PRListResponse {
  return {
    repos: [{ repoRoot, repoName: repoRoot.split("/").pop() ?? "", prs }],
    errors: [],
  };
}

const noPRs: PRListResponse = { repos: [], errors: [] };

/** What a sorted row is called, whichever kind it is. */
function sortedName(entry: PanelRow): string {
  if (entry.kind === "pr") return `#${entry.pr.number}`;
  if (entry.kind === "pr-status") return "(pr-status)";
  return entry.row.name;
}

/** A repo group for the pure layout helpers, PR section off by default. */
function panelRepo(
  repoRoot: string,
  repoName: string,
  rows: PanelRow[],
  prSection: PanelRepo["prSection"] = { kind: "ready", count: 0 },
): PanelRepo {
  return { repoRoot, repoName, rows, prSection };
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
  /** Phase 3; defaults to a repo with no open PRs. */
  prs?: () => Promise<Response>;
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
    // Before the `/worktrees` fallback, and `/prs` shares no substring with
    // it, so the ordering here is not the trap `prune-candidates` is.
    if (url.includes("/prs")) return handlers.prs?.() ?? json(noPRs);
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
  onSpawnFromPR?: (t: {
    number: number;
    title: string;
    repoRoot: string;
    cursor: string;
    panelRepo: string | null;
    panelScope: string | null;
  }) => void;
  /** Whether the stubbed opener reports success; see {@link recordEffects}. */
  opensUrls?: boolean;
}

/**
 * The panel's side effects, recorded instead of performed.
 *
 * Every mount goes through here, which is the point: the component's
 * `effects` prop is REQUIRED, so a test cannot reach the real `open` or
 * `pbcopy` by forgetting something. It has to be handed a recorder.
 */
function recordEffects(opensUrls: boolean) {
  const openedUrls: string[] = [];
  const copiedText: string[] = [];
  return {
    openedUrls,
    copiedText,
    effects: {
      openUrl: (url: string) => {
        openedUrls.push(url);
        return opensUrls;
      },
      copyText: (text: string) => {
        copiedText.push(text);
        return { osc52: true, local: false };
      },
    },
  };
}

async function mountPanel(handlers: Handlers, opts: PanelOptions = {}) {
  // BEFORE `testRender`, so the component's first `load()` cannot reach a
  // real daemon. The prune POST it also covers would run a real `git worktree
  // remove` against this machine.
  installFetch(handlers);
  const recorder = recordEffects(opts.opensUrls ?? true);
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
        onSpawnFromPR={opts.onSpawnFromPR ?? (() => {})}
        effects={recorder.effects}
      />
    ),
    { width: opts.width ?? 90, height: opts.height ?? 24 },
  );
  await setup.renderOnce();
  return {
    ...recorder,
    keys: createMockKeys(setup.renderer),
    /** Escape, actually delivered (see `deliverEscape`). */
    escape: () => deliverEscape(setup!.renderer),
    mouse: createMockMouse(setup.renderer),
    /** Cell-level colours, for the things a char frame cannot show: the view
     *  tabs are filled CHIPS, and a chip is its background. */
    spans: () => setup!.captureSpans(),
    /** Re-render at a new terminal size, as a real resize does. */
    resize: (width: number, height: number) => setup!.resize(width, height),
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
  prs: PRListResponse = noPRs,
) {
  const harness = await mountPanel(
    {
      list: async () => json(list),
      scan: async () => json(scan),
      prs: async () => json(prs),
    },
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
    // The in-flight scan is said once, on the header line above the list.
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

  it("carries the announcement on the header while the scan is pending", async () => {
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

  // At sidebar widths the chips are the thing worth keeping. OpenTUI wraps
  // rather than clips, so an overlong header line does not truncate, it
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
 * The count on the `Worktrees` chip: the list's size, said once and on the
 * chip that names its subject. Counts describe the LOADED list, so a load
 * in flight says nothing rather than a number about to change.
 */
describe("WorktreesPanel header counts", () => {
  it("wears one repo's worktree count on its own chip", async () => {
    const { settled } = await mountSettled(listOf([mainRow(), row()]));
    expect(lineWith(settled, WORKTREES_TAB)).toContain("Worktrees 2");
  });

  // A bare number, because the chip it sits in already names its subject.
  // The old title needed the noun and so said `Worktrees` twice over.
  it("says the number and not the noun", async () => {
    const { settled } = await mountSettled(listOf([mainRow()]));
    const header = lineWith(settled, WORKTREES_TAB);
    expect(header).toContain("Worktrees 1");
    expect(header).not.toContain("1 worktree");
    expect(header).not.toContain("Worktrees · 1");
  });

  // The scope leads. Across a widened panel it is the axis Tab flips, not a
  // repo count: the number was dropped when the header became one line,
  // because a lead that arrives with the data shifts both chips sideways.
  it("leads with the scope, and counts every repo's worktrees at once", async () => {
    const { settled } = await mountSettled(
      listOf([
        mainRow(),
        row(),
        mainRow({ path: "/other", repoRoot: "/other", repoName: "other" }),
      ]),
    );
    const header = lineWith(settled, WORKTREES_TAB);
    expect(header).toContain("all repos");
    expect(header).toContain("Worktrees 3");
  });

  it("says the count and the scan together, the count first", async () => {
    const { frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: () => new Promise<Response>(() => {}),
    });
    const shown = await frame();
    const header = lineWith(shown, "scanning");
    const [countAt, scanningAt] = orderOf(header, "Worktrees 2", "scanning");
    expect(countAt).toBeLessThan(scanningAt!);
  });

  it("says nothing while the list itself is loading", async () => {
    const { frame } = await mountPanel({
      list: () => new Promise<Response>(() => {}),
      scan: () => new Promise<Response>(() => {}),
    });
    // "Reading worktrees..." is on screen; a COUNT is not. The chip goes
    // bare rather than showing the previous scope's number.
    const shown = await frame();
    expect(lineWith(shown, WORKTREES_TAB)).toContain(
      `${WORKTREES_TAB}   ${PRS_TAB}`,
    );
  });

  // A count CAN go stale where a scope name cannot: `load()` is what a
  // finished prune calls, so a held number states `Worktrees 2` for a panel
  // that has just removed one of the two. The rows are not on screen to
  // contradict it either — the loading body reads `Reading worktrees...`.
  it("blanks the count while any reload is in flight", async () => {
    let lists = 0;
    const { keys, frame } = await mountPanel({
      list: async () =>
        ++lists === 1
          ? json(listOf([mainRow(), row()]))
          : await new Promise<Response>(() => {}),
      scan: async () => json(emptyScan),
    });
    const settled = await frame();
    expect(lineWith(settled, WORKTREES_TAB)).toContain("Worktrees 2");
    keys.pressKey("r");
    expect(lists).toBe(2);
    expect(lineWith(await frame(), WORKTREES_TAB)).not.toMatch(/Worktrees \d/);
  });

  // The same rule, at the moment it actually costs something: the reload a
  // successful prune fires is the one where the old number is WRONG.
  it("never states the pre-prune count while the reload is in flight", async () => {
    let lists = 0;
    const { keys, frame } = await mountPanel({
      list: async () =>
        ++lists === 1
          ? json(listOf([mainRow(), row()]))
          : await new Promise<Response>(() => {}),
      scan: async () => json({ candidates: [candidate()], skipped: [] }),
      prune: async () => json(runResult([outcome()])),
    });
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    await frame();
    keys.pressKey("y");
    await frame();
    const after = await frame();
    expect(after).toContain("removed 1 worktree");
    expect(lineWith(after, WORKTREES_TAB)).not.toContain("Worktrees 2");
  });

  // A Tab IS a rescope: the rows on screen now answer a different question,
  // so the count that describes them has to go rather than tick from one
  // scope's number to another's.
  it("blanks the count while a rescope is in flight", async () => {
    let lists = 0;
    const { keys, frame } = await mountPanel(
      {
        list: async () =>
          ++lists === 1
            ? json(listOf([mainRow(), row()]))
            : await new Promise<Response>(() => {}),
        scan: async () => json(emptyScan),
      },
      { repo: "/repo" },
    );
    expect(lineWith(await frame(), WORKTREES_TAB)).toContain("Worktrees 2");
    keys.pressTab();
    const rescoping = await frame();
    expect(lists).toBe(2);
    expect(lineWith(rescoping, WORKTREES_TAB)).not.toMatch(/Worktrees \d/);
  });

  // The SCOPED lead is `props.repo` and a flag, so no request can change it:
  // it holds across a reload and both chips stay where the user aimed. This
  // is the half of the split that can make that promise.
  it("holds a scoped lead across a refresh", async () => {
    let lists = 0;
    const { keys, frame } = await mountPanel(
      {
        list: async () =>
          ++lists === 1
            ? json(listOf([mainRow(), row()]))
            : await new Promise<Response>(() => {}),
        scan: async () => json(emptyScan),
      },
      { repo: "/repo" },
    );
    expect(lineWith(await frame(), WORKTREES_TAB)).toContain("repo ");
    keys.pressKey("r");
    expect(lists).toBe(2);
    expect(lineWith(await frame(), WORKTREES_TAB)).toContain("repo ");
  });

  // The UNSCOPED lone-repo lead is the one derived from ROWS, and what it
  // really reports is how many repos answered — so a reload about to return
  // a second repo makes a held name wrong, exactly as a reload about to
  // return one fewer worktree makes a held count wrong. It blanks to `all
  // repos`, which is never untrue: the panel IS unscoped, and the name only
  // stands in for the group header a lone group does not draw.
  it("blanks an unscoped lone repo's name while reloading", async () => {
    let lists = 0;
    const { keys, frame } = await mountPanel({
      list: async () =>
        ++lists === 1
          ? json(listOf([mainRow(), row()]))
          : await new Promise<Response>(() => {}),
      scan: async () => json(emptyScan),
    });
    expect(lineWith(await frame(), WORKTREES_TAB)).toContain("repo ");
    keys.pressKey("r");
    expect(lists).toBe(2);
    expect(lineWith(await frame(), WORKTREES_TAB)).toContain("all repos");
  });

  it("flips the lead on the rescope, in the frame Tab produced", async () => {
    let lists = 0;
    const { keys, frame } = await mountPanel(
      {
        list: async () =>
          ++lists === 1
            ? json(listOf([mainRow(), row()]))
            : await new Promise<Response>(() => {}),
        scan: async () => json(emptyScan),
      },
      { repo: "/repo" },
    );
    expect(lineWith(await frame(), WORKTREES_TAB)).toContain("repo ");
    keys.pressTab();
    // The reload has not answered and never will, so this is the label
    // during the rescope: it states what the panel is now fetching, which is
    // the question Tab just asked, rather than the repo it left.
    expect(lists).toBe(2);
    expect(lineWith(await frame(), WORKTREES_TAB)).toContain("all repos");
  });

  it("drops the counts whole, a rung above the scope, when narrow", async () => {
    const { settled } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      { compact: true, width: 24 },
    );
    expect(settled).toContain(WORKTREES_TAB);
    expect(lineWith(settled, WORKTREES_TAB)).not.toMatch(/Worktrees \d/);
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

  it("leads the header with a single repo instead of a header line", async () => {
    const { settled } = await mountSettled(listOf([mainRow(), row()]));
    const header = lineWith(settled, WORKTREES_TAB);
    // The scope leads the very line the chips are on: one row, not two.
    expect(header).toContain("repo ");
    expect(header).toContain(PRS_TAB);
    // The repo header line that would repeat it underneath is gone, and the
    // list starts on the very next line.
    const lines = settled.split("\n");
    const at = lines.findIndex((l) => l.includes(PRS_TAB));
    expect(lines[at + 1]).toContain("main checkout");
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
    // The lead says the SCOPE, never a repo NAME: with several repos on
    // screen, naming one of them up there would lie.
    const header = lineWith(settled, WORKTREES_TAB);
    expect(header).toContain("all repos");
    expect(header).not.toContain("repo   Worktrees");
    expect(header).not.toContain("other   Worktrees");
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
    // Three phases now: the local list, the open-PR list and the prune scan.
    expect(requested).toHaveLength(3);
    expect(requested.every((url) => url.includes("repo=%2Frepo"))).toBe(true);
    expect(await frame()).toContain("tab all repos");

    keys.pressTab();
    const widened = await frame();
    expect(requested).toHaveLength(6);
    expect(requested.slice(3).some((url) => url.includes("repo="))).toBe(false);
    // Discovery by cwd is additive and survives the widening.
    expect(requested.slice(3).every((url) => url.includes("cwd=%2Frepo"))).toBe(
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
      removalDetails({
        includedDirty: 0,
        blockedDirty: 0,
        ignoredFiles: 0,
        endingSessions: 0,
      }),
    ).toEqual([]);
    expect(
      removalDetails({
        includedDirty: 1,
        blockedDirty: 2,
        ignoredFiles: 3,
        endingSessions: 4,
      }),
    ).toEqual([
      "including 1 worktree with uncommitted work",
      "ending 4 idle agent sessions",
      "skipping 2 dirty worktrees (needs D)",
      "3 ignored files go too",
    ]);
  });

  // The line only the sessions produce, in both of its numbers.
  it("counts the idle agents a removal would end", () => {
    const base = { includedDirty: 0, blockedDirty: 0, ignoredFiles: 0 };
    expect(removalDetails({ ...base, endingSessions: 1 })).toEqual([
      "ending 1 idle agent session",
    ]);
    expect(removalDetails({ ...base, endingSessions: 2 })).toEqual([
      "ending 2 idle agent sessions",
    ]);
    expect(removalDetails({ ...base, endingSessions: 0 })).toEqual([]);
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
    // The panel is still the panel: header above, list behind, hints below.
    expect(lineWith(shown, WORKTREES_TAB)).toContain("repo ");
    expect(shown).toContain("main checkout");
    expect(shown).toContain("j/k move");
  });

  it("restores the list on esc with the selection intact", async () => {
    const { keys, escape, frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => json({ candidates: [candidate()], skipped: [] }),
    });
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    expect(await frame()).toContain("Remove worktrees?");
    escape();
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

    expect(sortWorktreeRows(rows).map(sortedName)).toEqual([
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
    expect(sortWorktreeRows(rows).map(sortedName)).toEqual(["alpha", "zulu"]);
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

/** The header as a reader sees it: scope, chips, status, gaps and all. */
function headerText(layout: HeaderLayout): string {
  const chips = layout.tabs
    .map((tab) => tab.segments.map((seg) => seg.text).join(""))
    .join(" ");
  return [layout.lead, chips, layout.tail]
    .filter((zone) => zone !== null && zone !== "")
    .join("  ");
}

/** Columns the header occupies, which is what the ladder is measured on. */
function headerWidthOf(layout: HeaderLayout): number {
  return displayWidth(headerText(layout));
}

describe("header zones", () => {
  const base = {
    view: "worktrees" as const,
    lead: "all repos",
    worktrees: "42",
    prs: "7",
    tail: null as string | null,
    width: 80,
  };

  it("leads with the scope and trails with the status", () => {
    const layout = headerLayout({ ...base, tail: "◐ scanning" });
    expect(layout.lead).toBe("all repos");
    expect(layout.tail).toBe("◐ scanning");
  });

  // Whole, not truncated: half a word ("◐ scann…") is noise, and the columns
  // it eats are the ones carrying the chips.
  it("drops the tail rather than truncating it", () => {
    const full = headerLayout({ ...base, tail: "◐ scanning" });
    const exact = headerWidthOf(full);
    expect(
      headerLayout({ ...base, tail: "◐ scanning", width: exact }).tail,
    ).toBe("◐ scanning");
    expect(
      headerLayout({ ...base, tail: "◐ scanning", width: exact - 1 }).tail,
    ).toBeNull();
  });

  // The tail goes first and the lead last, because a count whose scope is
  // unknown is not a smaller truth but a misleading one.
  it("gives up the tail, then the counts, then the scope", () => {
    const at = (width: number) =>
      headerLayout({ ...base, tail: "◐ scanning", width });
    expect(at(55).tail).toBe("◐ scanning");
    expect(at(43).tail).toBeNull();
    expect(at(43).lead).toBe("all repos");
    expect(headerText(at(33))).toBe("all repos   Worktrees 42   PRs 7 ");
    expect(headerText(at(28))).toBe("all repos   Worktrees   PRs ");
    expect(at(17).lead).toBeNull();
  });

  // Every rung has to be narrower than the one above it, or a rung is
  // unreachable and the panel jumps straight past it.
  it("narrows at every rung, and never overflows its box", () => {
    let previous = Infinity;
    for (const width of [55, 43, 33, 28, 17]) {
      const used = headerWidthOf(
        headerLayout({ ...base, tail: "◐ scanning", width }),
      );
      expect(used).toBeLessThanOrEqual(width);
      expect(used).toBeLessThan(previous);
      previous = used;
    }
  });

  it("still fits itself at widths no rung survives", () => {
    for (let width = 1; width <= 20; width++) {
      const used = headerWidthOf(
        headerLayout({ ...base, tail: "◐ scanning", width }),
      );
      expect(used).toBeLessThanOrEqual(width);
    }
  });

  // A count is not known until phase 1 lands, and the chip simply goes
  // without one rather than showing the previous scope's number.
  it("wears no count when there is none to wear", () => {
    expect(headerText(headerLayout({ ...base, worktrees: "", prs: "" }))).toBe(
      "all repos   Worktrees   Pull Requests ",
    );
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
    expect(
      rowBranch(
        panelRow({ row: row({ name: "fix-codex", branch: "fix-codex" }) }),
      ),
    ).toBe("");
    expect(
      rowBranch(
        panelRow({
          row: row({ name: "worktree-panel", branch: "feat/worktree-panel" }),
        }),
      ),
    ).toBe("feat/worktree-panel");
  });

  it("names the main checkout for what it is, not for its directory", () => {
    expect(rowLabel(panelRow({ row: mainRow() }))).toBe("main checkout");
    expect(rowLabel(panelRow({ row: row() }))).toBe("alpha");
  });

  // `main checkout  main` in every repo group said nothing. The branch is
  // news only when the main checkout sits somewhere unexpected.
  it("hides the main checkout's default branch, keeps an unexpected one", () => {
    expect(rowBranch(panelRow({ row: mainRow() }))).toBe("");
    expect(rowBranch(panelRow({ row: mainRow({ branch: "master" }) }))).toBe(
      "",
    );
    expect(
      rowBranch(panelRow({ row: mainRow({ branch: "feat/overlay" }) })),
    ).toBe("feat/overlay");
    // The heuristic is scoped to the main checkout: a WORKTREE sitting on
    // main is unusual enough to say so.
    expect(
      rowBranch(panelRow({ row: row({ name: "wt-a", branch: "main" }) })),
    ).toBe("main");
  });

  it("says detached rather than leaving the branch blank", () => {
    expect(
      rowBranch(panelRow({ row: row({ branch: null, detached: true }) })),
    ).toBe("detached");
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

// ---------------------------------------------------------------------------
// The idle-agent consent (issue #175)
// ---------------------------------------------------------------------------

/** The detail line for a row the removal would end an agent in. */
function consentText(
  entry: PanelRow,
  opts: { selected?: boolean; compact?: boolean; dirtyOk?: boolean } = {},
): string {
  return detailSegments(entry, {
    compact: opts.compact === true,
    dirtyOk: opts.dirtyOk === true,
    selected: opts.selected,
  })
    .map((s) => s.text)
    .join("");
}

/** The colour the sessions phrase is drawn in, wherever it sits in the line. */
function sessionPhraseColor(
  entry: PanelRow,
  opts: { selected?: boolean } = {},
): string | undefined {
  return detailSegments(entry, {
    compact: false,
    dirtyOk: false,
    selected: opts.selected,
  }).find((s) => s.text.includes("claude idle"))?.fg;
}

describe("idle agent consent", () => {
  /** What the daemon now offers: a merged PR whose agents are all idle. */
  function endsAgent(
    sessions = [session({ status: "idle" })],
  ): WorktreePanelRow {
    return panelRow({
      row: row({ sessions }),
      candidate: candidate({ sessions }),
    });
  }

  it("says the removal ends the agent, and says it differently once picked", () => {
    expect(consentText(endsAgent())).toBe(
      "PR #68 merged · claude idle (x ends it)",
    );
    expect(consentText(endsAgent(), { selected: true })).toBe(
      "PR #68 merged · claude idle (will be ended)",
    );
  });

  it("counts the agents the note is about", () => {
    const two = [
      session({ status: "idle" }),
      session({ id: "s2", status: "idle" }),
    ];
    expect(consentText(endsAgent(two))).toContain(
      "2 agents idle (x ends them)",
    );
  });

  // The phrase reads the LIST's sessions and the note gates on the SCAN's,
  // fetched once at mount and seconds apart, so an agent that went
  // `working -> idle` in that window rendered `claude working (x ends it)`.
  it("withholds the note when the phrase it would ride disagrees", () => {
    const stale = panelRow({
      row: row({ sessions: [session({ status: "working" })] }),
      candidate: candidate({ sessions: [session({ status: "idle" })] }),
    });
    const text = detailSegments(stale, { compact: false, dirtyOk: false })
      .map((s) => s.text)
      .join(" ");
    expect(text).toContain("claude working");
    expect(text).not.toContain("(x ends it)");
    expect(text).not.toContain("(will be ended)");
  });

  // A kept row's sessions phrase is untouched: nothing is going to end there.
  it("leaves a row nobody can remove saying only what is true of it", () => {
    expect(consentText(panelRow({ row: row({ sessions: [session()] }) }))).toBe(
      "claude idle",
    );
  });

  // The scan's own copy stands in when the list's read has not caught up, so
  // the note always has a phrase to ride.
  it("borrows the scan's sessions when the list read has none", () => {
    const sessions = [session({ status: "idle" })];
    expect(
      consentText(panelRow({ row: row(), candidate: candidate({ sessions }) })),
    ).toContain("claude idle (x ends it)");
  });

  // Yellow, like the dirty counts on a row that would delete them, and never
  // red: an ended session resumes and its transcript survives.
  it("warns in yellow without borrowing the colour of lost work", () => {
    expect(sessionPhraseColor(endsAgent())).toBe(theme.yellow);
    expect(sessionPhraseColor(endsAgent(), { selected: true })).toBe(
      theme.yellow,
    );
    expect(
      sessionPhraseColor(panelRow({ row: row({ sessions: [session()] }) })),
    ).not.toBe(theme.yellow);
  });

  // At sidebar widths the tail is what truncates, so the consequence has to
  // lead, by the same rule the dirty phrase already follows.
  it("leads the compact line with the consequence, not the reason", () => {
    expect(consentText(endsAgent(), { compact: true })).toBe(
      "claude idle (x ends it) · PR #68 merged",
    );
  });

  // Both consents on one row: the dirty one is the higher stakes and leads.
  it("orders both consents by what they cost", () => {
    const sessions = [session({ status: "idle" })];
    const both = panelRow({
      row: row({ dirty: { dirty: true, modified: 2, untracked: 0 }, sessions }),
      candidate: candidate({ dirty: true, modified: 2, sessions }),
    });
    expect(consentText(both, { compact: true })).toBe(
      "2 modified (D deletes them) · claude idle (x ends it) · PR #68 merged",
    );
  });

  // The height derivation calls `detailPhrases` without a selection, and a
  // row that gained a note must not gain or lose a line by being picked.
  it("keeps the row two lines tall either way", () => {
    expect(rowVisualHeight(endsAgent())).toBe(2);
    expect(rowVisualHeight(endsAgent(), true)).toBe(2);
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

  it("labels the section with its count and no trailing rule", () => {
    // A tee, so the rail runs into the label instead of stopping at it. No
    // dash run after the words: the repo header owns the horizontal-rule
    // language, and even a capped run here read as a competing boundary.
    expect(dividerText(6, 40)).toBe("├─ removable · 6");
    expect(dividerText(6, 200)).toBe("├─ removable · 6");
  });

  it("truncates the label instead of letting it wrap away", () => {
    // OpenTUI wraps rather than clips, and a wrapped line in a height-1 box
    // vanishes; a width too small for the label must shorten it, not lose it.
    const narrow = dividerText(6, 8);
    expect(displayWidth(narrow)).toBeLessThanOrEqual(8);
    expect(displayWidth(narrow)).toBeGreaterThan(0);
    expect(displayWidth(dividerText(6, 1))).toBeGreaterThan(0);
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
      panelRepo("/r1", "r1", [kept, gone]),
      panelRepo("/r2", "r2", [other]),
    ];
    const layout = visualLayout(repos, () => 1);
    // The Worktrees view draws no PR line at all, which is the whole line it
    // reclaimed per repo: header(0) a(1) divider(2) b(3) | header(4) c(5).
    expect(layout.get("/a")).toEqual({ line: 1, height: 1 });
    expect(layout.get("/b")).toEqual({ line: 3, height: 1 });
    expect(layout.get("/c")).toEqual({ line: 5, height: 1 });
  });

  it("drops the group header line when there is only one repo", () => {
    const only = panelRow({ row: row({ path: "/a", name: "a" }) });
    const one = [panelRepo("/r", "r", [only])];
    expect(showsGroupHeaders(one)).toBe(false);
    expect(visualLayout(one, () => 1).get("/a")).toEqual({
      line: 0,
      height: 1,
    });
    const two = [
      ...one,
      panelRepo("/r2", "r2", [
        panelRow({ row: row({ path: "/b", name: "b" }) }),
      ]),
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
      [panelRepo("/r1", "r1", [plain, tall]), panelRepo("/r2", "r2", [next])],
      (entry) => rowVisualHeight(entry, false),
    );
    // header(0) a(1) divider(2) b(3,4) | header(5) c(6). `b` is classified,
    // so it sits under its group's removable divider.
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
    const layout = visualLayout([panelRepo("/r", "r", rows)], (entry) =>
      rowVisualHeight(entry, false),
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
    const before = visualLayout([panelRepo("/r", "r", rows)], () => 1);
    // Cursor on the first row, viewport at the top: nothing to scroll.
    expect(scrollTargetFor(before, "/w/0", 0, 6)).toBeNull();
    // Classification sinks it to the bottom, as a prunable candidate does.
    const resorted = [...rows.slice(1), rows[0]!];
    const after = visualLayout([panelRepo("/r", "r", resorted)], () => 1);
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

  // A successful prune reloads in place, so its notice rides the very rescan
  // it triggered and the two share the tail. The notice leads: it is what
  // just happened, where the spinner is only what has not finished yet.
  it("says the removal notice ahead of the scan it triggered", async () => {
    let scans = 0;
    const { keys, frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      // The reload's scan never answers, so both live on the tail at once.
      scan: async () =>
        ++scans === 1
          ? json({ candidates: [candidate()], skipped: [] })
          : await new Promise<Response>(() => {}),
      prune: async () => json(runResult([outcome()])),
    });
    await frame();
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    await frame();
    keys.pressKey("y");
    await frame();
    const tail = lineWith(await frame(), "removed 1 worktree");
    const [noticeAt, scanningAt] = orderOf(
      tail,
      "removed 1 worktree",
      "scanning",
    );
    expect(scanningAt).not.toBeUndefined();
    expect(noticeAt).toBeLessThan(scanningAt!);
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

describe("WorktreesPanel idle agent gate", () => {
  const idle = [session({ status: "idle" })];
  const agentList = listOf([row({ sessions: idle })]);
  const agentScan: ScanResponse = {
    candidates: [candidate({ sessions: idle })],
    skipped: [],
  };

  it("shows the consent on the row, under the removable divider", async () => {
    const { settled } = await mountSettled(agentList, agentScan);
    expect(settled).toContain("removable");
    const line = lineWith(settled, "claude idle");
    expect(isDetailLine(line)).toBe(true);
    expect(line).toContain("claude idle (x ends it)");
    // Still a checkbox row, so the consent is something to pick.
    expect(lineWith(settled, "alpha")).toContain("[ ]");
  });

  it("changes the wording once the row is picked", async () => {
    const { keys, frame } = await mountSettled(agentList, agentScan);
    keys.pressKey(" ");
    const shown = await frame();
    expect(lineWith(shown, "alpha")).toContain("[x]");
    expect(shown).toContain("claude idle (will be ended)");
    expect(shown).not.toContain("(x ends it)");
    expect(shown).toContain("x remove 1");
  });

  // A bulk key is never the consent, and it says so rather than leaving an
  // empty box on a row that is otherwise clean.
  it("leaves the row for space, and a says why", async () => {
    const { keys, frame } = await mountSettled(agentList, agentScan);
    keys.pressKey("a");
    const afterAll = await frame();
    expect(afterAll).not.toContain("[x]");
    // The note owns the hint line for a couple of seconds, which is why the
    // selection is read off the box rather than off `x remove N` here.
    expect(afterAll).toContain("a skips idle agent rows");
    keys.pressKey(" ");
    const afterSpace = await frame();
    expect(lineWith(afterSpace, "alpha")).toContain("[x]");
    expect(afterSpace).toContain("claude idle (will be ended)");
  });

  // `a` still takes every row it is allowed to, alongside the one it skips.
  it("still selects the agent-free rows beside it", async () => {
    const { keys, frame } = await mountSettled(
      listOf([row({ sessions: idle }), row({ path: "/repo/wt/b", name: "b" })]),
      {
        candidates: [
          candidate({ sessions: idle }),
          candidate({ path: "/repo/wt/b", name: "b" }),
        ],
        skipped: [],
      },
    );
    keys.pressKey("a");
    const shown = await frame();
    expect(lineWith(shown, "alpha")).toContain("[ ]");
    expect(lineWith(shown, " b ")).toContain("[x]");
  });

  it("names the ended sessions at the confirmation step", async () => {
    const { keys, frame } = await mountSettled(agentList, agentScan);
    keys.pressKey(" ");
    keys.pressKey("x");
    const confirm = await frame();
    expect(confirm).toContain("Remove worktrees?");
    expect(confirm).toContain("ending 1 idle agent session");
  });

  // `x` on the cursor row is the single-target shortcut, and the confirm it
  // opens is what names the consequence.
  it("reaches the confirm from the cursor row alone", async () => {
    const { keys, frame } = await mountSettled(agentList, agentScan);
    keys.pressKey("x");
    expect(await frame()).toContain("ending 1 idle agent session");
  });

  it("sends the consent with the run, for exactly the picked rows", async () => {
    let body: Record<string, unknown> = {};
    const { keys, frame } = await mountSettled(
      listOf([row({ sessions: idle }), row({ path: "/repo/wt/b", name: "b" })]),
      {
        candidates: [
          candidate({ sessions: idle }),
          candidate({ path: "/repo/wt/b", name: "b" }),
        ],
        skipped: [],
      },
    );
    fetchSpy!.mockImplementation((async (
      input: unknown,
      init?: RequestInit,
    ) => {
      if (String(input).includes("/worktrees/prune") && init?.body) {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      }
      return json({ outcomes: [] });
    }) as unknown as typeof fetch);

    keys.pressKey(" "); // the agent row
    keys.pressKey("j");
    keys.pressKey(" "); // the plain one
    keys.pressKey("x");
    keys.pressKey("y");
    await frame();

    expect(body).toMatchObject({
      paths: ["/repo/wt/alpha", "/repo/wt/b"],
      allowDirty: [],
      allowEndIdle: ["/repo/wt/alpha"],
    });
  });

  // A daemon predating the change offers no such candidate, and the field
  // rides along empty rather than disappearing.
  it("sends an empty consent when nothing ends an agent", async () => {
    let body: Record<string, unknown> = {};
    const { keys, frame } = await mountSettled(listOf([row()]), {
      candidates: [candidate()],
      skipped: [],
    });
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
    expect(body).toMatchObject({ allowEndIdle: [] });
  });

  // The sidebar's width, where the tail truncates: the consequence has to be
  // the half that survives.
  it("keeps the consent readable at sidebar width", async () => {
    const { settled } = await mountSettled(agentList, agentScan, {
      compact: true,
      width: 44,
    });
    expect(lineWith(settled, "claude idle")).toContain(
      "claude idle (x ends it)",
    );
  });
});

// ---------------------------------------------------------------------------
// The open-PR section (issue #151)
// ---------------------------------------------------------------------------

describe("PR row identity", () => {
  // Real keys are absolute paths, so a synthetic one starting with `pr:`
  // cannot collide with a worktree's.
  it("keys a PR row on its repo and number", () => {
    expect(prRowKey("/repo", 151)).toBe("pr:/repo#151");
    expect(prRowKey("/repo", 151).startsWith("/")).toBe(false);
  });

  // The whole point of carrying a tip: a branch NAME match would mark a PR as
  // checked out because someone else's fork reuses the word.
  it("marks a PR checked out only when the head SHA is a local tip", () => {
    const held = row({ path: "/wt/pr", branch: "feat/x", tip: "sha-a" });
    const other = row({ path: "/wt/other", branch: "feat/y", tip: "sha-b" });
    const pr = openPR({ headRefName: "feat/x", headRefOid: "sha-a" });

    expect(checkoutHolding(pr, [other, held])?.path).toBe("/wt/pr");
    // Same branch NAME, different commit: not this PR.
    expect(
      checkoutHolding(openPR({ headRefName: "feat/x", headRefOid: "sha-z" }), [
        held,
      ]),
    ).toBeNull();
  });

  // Both directions of "cannot tell" leave the row unmarked rather than
  // guessing: an old daemon sends no tip, and gh can withhold headRefOid.
  it("leaves the row unmarked when either side does not resolve", () => {
    const noTip = row({ path: "/wt/pr", branch: "feat/x" });
    delete noTip.tip;
    expect(
      checkoutHolding(openPR({ headRefOid: "sha-a" }), [noTip]),
    ).toBeNull();
    expect(
      checkoutHolding(openPR({ headRefOid: null }), [
        row({ tip: "sha-a", branch: "feat/x" }),
      ]),
    ).toBeNull();
  });

  // A worktree just cut from the branch shares its tip. Both are SHA-proven,
  // so the branch name is only a tie-break between them.
  it("prefers the branch that is actually the PR's head among tied tips", () => {
    const fresh = row({ path: "/wt/fresh", branch: "scratch", tip: "sha-a" });
    const real = row({ path: "/wt/real", branch: "feat/x", tip: "sha-a" });
    const pr = openPR({ headRefName: "feat/x", headRefOid: "sha-a" });
    expect(checkoutHolding(pr, [fresh, real])?.path).toBe("/wt/real");
  });
});

describe("PR row presentation", () => {
  it("puts the number and title on line 1 and drops the branch column", () => {
    const entry = prRow();
    expect(rowLabel(entry)).toBe("#151 Worktrees panel: open-PR list");
    // The head ref goes on the detail line: the label is already a title.
    expect(rowBranch(entry)).toBe("");
  });

  // A long PR title would otherwise push every worktree's branch column to
  // the cap, over a row that has no branch column of its own.
  it("keeps PR titles out of the worktree label column", () => {
    const long = prRow({
      pr: openPR({ title: "a".repeat(60) }),
    });
    const rows = [panelRow({ row: row({ name: "alpha" }) }), long];
    expect(labelColumnWidth(rows)).toBe(displayWidth("alpha"));
  });

  it("gives a PR row its own marker so the left edge stays a legend", () => {
    const segments = primarySegments(prRow(), {
      isCursor: false,
      labelWidth: 10,
      markerBase: 2,
    });
    expect(segments[0]?.text).toBe(`${PR_MARKER} `);
    // Not any of the four markers already spelled in that slot.
    expect([`⌂ `, `· `, `[ ] `, `[x] `]).not.toContain(segments[0]?.text);
  });

  it("says the branch, the author and only the states that are news", () => {
    const quiet = detailPhrases(prRow(), { dirtyOk: false }).map((p) => p.text);
    expect(quiet).toEqual(["feat/pr-list-panel", "@epilande"]);

    const loud = detailPhrases(
      prRow({
        pr: openPR({
          isDraft: true,
          reviewDecision: "CHANGES_REQUESTED",
          ciStatus: "failing",
        }),
      }),
      { dirtyOk: false },
    ).map((p) => p.text);
    expect(loud).toContain("draft");
    expect(loud).toContain("changes requested");
    expect(loud).toContain("checks fail");
  });

  // Both would appear on nearly every row and say nothing about that row.
  it("stays silent on REVIEW_REQUIRED and on a PR with no checks", () => {
    expect(
      describeReview(openPR({ reviewDecision: "REVIEW_REQUIRED" })),
    ).toBeNull();
    expect(describeReview(openPR({ reviewDecision: null }))).toBeNull();
    expect(describeChecks(openPR({ ciStatus: "none" }))).toBeNull();
    expect(describeChecks(openPR({ ciStatus: "passing" }))?.text).toBe(
      "checks pass",
    );
  });

  it("names the worktree a checked-out PR lives in, last on the line", () => {
    const phrases = detailPhrases(
      prRow({ checkedOutPath: "/wt/pr-151", checkedOutName: "pr-151" }),
      { dirtyOk: false },
    );
    expect(phrases[phrases.length - 1]?.text).toBe("checked out in pr-151");
  });

  // What a repo with no open PRs says. `0` is the answer the PR view exists
  // to give, so it takes a ROW there where the Worktrees view says nothing.
  it("says what a repo with no PR rows has to say", () => {
    expect(prStatusText({ kind: "pending" }, "◐")).toBe("◐ checking GitHub");
    // No spinner to spend: `rowLabel` is pure and has none to pass.
    expect(prStatusText({ kind: "pending" }, "")).toBe("checking GitHub");
    expect(prStatusText({ kind: "ready", count: 0 }, "◐")).toBe("no open PRs");
    // The cause travels with the failure, because the row sits under the
    // repo it applies to and a shared line below the list cannot say which.
    expect(
      prStatusText({ kind: "unavailable", reason: "gh is logged out" }, "◐"),
    ).toBe("unavailable: gh is logged out");
    expect(prStatusText({ kind: "unavailable", reason: null }, "◐")).toBe(
      "unavailable",
    );
  });

  // A newline is ZERO columns wide to `Bun.stringWidth`, so a two-line `gh`
  // stderr passes every width guard and then loses everything after the
  // break inside a `height={1}` box, with no ellipsis to say so.
  // Unauthenticated `gh` prints exactly two lines.
  it("flattens a multi-line gh failure to one line", () => {
    const text = prStatusText(
      {
        kind: "unavailable",
        reason: "gh auth login required\nTo get started with GitHub CLI, run:",
      },
      "◐",
    );
    expect(text).not.toContain("\n");
    expect(text).toBe(
      "unavailable: gh auth login required To get started with GitHub CLI, run:",
    );
    expect(oneLine("  a\n\tb  ")).toBe("a b");
  });
});

describe("view tabs", () => {
  const tabsOf = (view: "worktrees" | "prs", prs: string, width: number) =>
    headerLayout({
      view,
      lead: "all repos",
      worktrees: "42",
      prs,
      width,
      tail: null,
    }).tabs;
  // Chips are separated by one column that belongs to neither of them, so the
  // rendered strip is their texts joined by a space.
  const tabText = (view: "worktrees" | "prs", prs: string, width: number) =>
    tabsOf(view, prs, width)
      .map((tab) => tab.segments.map((s) => s.text).join(""))
      .join(" ");
  const labelFg = (tab: ViewTab) => tab.segments[0]!.fg;

  it("marks the showing view active and dims the other", () => {
    const [wtA, prA] = tabsOf("worktrees", "7", 60);
    expect(wtA!.active).toBe(true);
    expect(prA!.active).toBe(false);
    expect(labelFg(wtA!)).toBe(theme.text);
    expect(labelFg(prA!)).toBe(theme.overlay);
    const [wtB, prB] = tabsOf("prs", "7", 60);
    expect(wtB!.active).toBe(false);
    expect(prB!.active).toBe(true);
    expect(labelFg(wtB!)).toBe(theme.overlay);
    expect(labelFg(prB!)).toBe(theme.text);
  });

  // Each chip names the view its click selects. The render reads this and
  // nothing else, so a chip can never be wired to the view beside it.
  it("names the view each chip selects, in both views", () => {
    for (const view of ["worktrees", "prs"] as const) {
      expect(tabsOf(view, "7", 60).map((t) => t.view)).toEqual([
        "worktrees",
        "prs",
      ]);
    }
  });

  // No key badge, in either view. A `[l]` on the inactive tab was tried and
  // rejected: keyboard notation inside a label reads as documentation leaking
  // into the interface. The keys are taught on the hint line instead.
  it("carries labels and a count, never a key", () => {
    expect(tabText("worktrees", "7", 60)).toBe(
      " Worktrees 42   Pull Requests 7 ",
    );
    expect(tabText("prs", "7", 60)).toBe(" Worktrees 42   Pull Requests 7 ");
  });

  // The dot in this TUI divides PEERS (`9 untracked · 1 waiting`). Gluing a
  // count to the label it belongs to made one fact read as two, which is
  // also where two of `Worktrees`' three appearances came from.
  it("glues a count to its label with a space, never a dot", () => {
    expect(tabText("worktrees", "7", 60)).not.toContain("·");
    expect(tabText("worktrees", "unavailable", 60)).toContain(
      "Pull Requests unavailable",
    );
  });

  it("dims the count one step below its own label", () => {
    const [, active] = tabsOf("prs", "7", 60);
    expect(active!.segments[1]).toEqual({ text: " 7", fg: theme.subtext });
    const [, inactive] = tabsOf("worktrees", "7", 60);
    expect(inactive!.segments[1]).toEqual({ text: " 7", fg: theme.overlay });
  });

  // A ladder of WHOLE swaps: a `Pull Request…` cut mid-word would spend the
  // columns that carry everything after it.
  it("degrades one whole rung at a time", () => {
    expect(tabText("worktrees", "7", 43)).toBe(
      " Worktrees 42   Pull Requests 7 ",
    );
    expect(tabText("worktrees", "7", 33)).toBe(" Worktrees 42   PRs 7 ");
    expect(tabText("worktrees", "7", 33)).toContain(PRS_TAB_SHORT);
    expect(tabText("worktrees", "7", 28)).toBe(" Worktrees   PRs ");
  });

  // A 40-column sidebar's content width, which is the ladder's whole reason
  // for existing: both labels survive there, and so does the cause of a
  // failed lookup, which is the one count the body cannot restate as cheaply.
  it("keeps both labels and the count at sidebar width", () => {
    expect(tabText("worktrees", "7", 36)).toBe(" Worktrees 42   PRs 7 ");
    expect(tabText("worktrees", "unavailable", 36)).toBe(" Worktrees   PRs ");
  });

  // What survives when only one chip can is the ACTIVE one. The flat-label
  // version kept the LEFTMOST, which left `Worktrees` alone on the line while
  // the PR view was showing — harmless for a word, not for a chip that
  // carries a fill, since the strip would then show nothing filled at all.
  it("fits to its box, keeping the chip that is showing", () => {
    for (const width of [16, 14, 12, 8, 4]) {
      for (const view of ["worktrees", "prs"] as const) {
        const fitted = tabsOf(view, "7", width);
        const used =
          fitted.reduce(
            (n, tab) =>
              n + tab.segments.reduce((m, s) => m + displayWidth(s.text), 0),
            0,
          ) + Math.max(0, fitted.length - 1);
        expect(used).toBeLessThanOrEqual(width);
        // Whatever is left on the line, the view showing is on it.
        expect(fitted.some((tab) => tab.active)).toBe(true);
      }
    }
    expect(tabText("worktrees", "7", 12)).toStartWith(" Worktrees");
    expect(tabText("prs", "7", 12)).toStartWith(" PRs");
  });

  // Narrowing the panel may never WIDEN the header, and no width may produce
  // a header that overflows it. (The ladder also refuses to BUILD a rung no
  // narrower than its predecessor, which nothing here can see: an unreachable
  // rung is unreachable, so its absence and its presence look identical from
  // out here. That guard is construction safety, not tested behaviour.)
  it("never widens as the panel narrows, and never overflows", () => {
    for (const tail of [null, "◐ scanning"]) {
      for (const counts of [
        { worktrees: "42", prs: "7" },
        { worktrees: "", prs: "" },
      ]) {
        let previous = Infinity;
        // Descending widths walk the ladder rung by rung; every distinct
        // layout it yields has to be strictly narrower than the last.
        for (let width = 80; width >= 1; width--) {
          const used = headerWidthOf(
            headerLayout({
              view: "prs",
              lead: "all repos",
              tail,
              width,
              ...counts,
            }),
          );
          expect(used).toBeLessThanOrEqual(width);
          expect(used).toBeLessThanOrEqual(previous);
          previous = used;
        }
      }
    }
  });

  // The flat-segment version left the separator dangling with nothing after
  // it below about fifteen columns. A chip carries a BACKGROUND, so the same
  // shortfall would paint an empty block of colour where a label belongs.
  // `fitTabs` drops the chip it cannot fill instead.
  //
  // Called DIRECTLY, not through `headerLayout`. The ladder's last rung hands
  // it a single chip, so a test that goes through the layout cannot reach the
  // multi-chip walk at all: its `toHaveLength(1)` would be true no matter
  // what this function did. That is how this test quietly stopped proving
  // anything when the last rung changed.
  it("drops a chip it cannot fill rather than painting an empty one", () => {
    const strip = (width: number) =>
      fitTabs(
        headerLayout({
          view: "worktrees",
          lead: "all repos",
          worktrees: "",
          prs: "",
          tail: null,
          width: 200,
        }).tabs,
        width,
      );
    for (const width of [17, 16, 14, 12, 8, 4]) {
      for (const tab of strip(width)) {
        const text = tab.segments.map((s) => s.text).join("");
        // A chip fitted down to padding and an ellipsis is the same failure
        // wearing a character: on the active fill it is a block of colour
        // that names nothing. Every surviving chip keeps a real letter.
        expect(text.replace(/[\s…]/gu, "")).not.toBe("");
      }
    }
    // Two chips need seventeen columns; below that the second is dropped
    // whole rather than fitted into a block of colour with no label in it.
    expect(strip(17)).toHaveLength(2);
    expect(strip(14)).toHaveLength(1);
    expect(strip(12)).toHaveLength(1);
  });
});

/**
 * The tabs as they REACH THE SCREEN: a chip is its background and its click,
 * and a char frame can show neither. `captureSpans` carries per-run colours
 * and `createMockMouse` drives real pointer events at real coordinates.
 */
describe("view tabs on screen", () => {
  const onePR = prsOf([openPR()]);

  /**
   * The screen row the chips are drawn on.
   *
   * Identified by carrying BOTH labels, because the TITLE line directly above
   * also says `Worktrees` and matching on that alone silently pointed every
   * helper here at the title. One of these tests passed that way while
   * clicking a cell no tab occupies.
   */
  function tabRow(frame: string): number {
    const y = frame
      .split("\n")
      .findIndex(
        (line) => line.includes(WORKTREES_TAB) && line.includes(PRS_TAB),
      );
    if (y < 0) throw new Error("tab line not on screen");
    return y;
  }

  function tabLine(spans: CapturedFrame, frame: string): CapturedSpan[] {
    return spans.lines[tabRow(frame)]!.spans;
  }

  function bgOf(spans: CapturedSpan[], needle: string): number[] {
    const span = spans.find((s) => s.text.includes(needle));
    if (!span) throw new Error(`no span carrying "${needle}"`);
    return span.bg.toInts();
  }

  function fgOf(spans: CapturedSpan[], needle: string): number[] {
    const span = spans.find((s) => s.text.includes(needle));
    if (!span) throw new Error(`no span carrying "${needle}"`);
    return span.fg.toInts();
  }

  /** Where a chip's label sits on screen, as the mouse sees it. */
  function cellOf(frame: string, needle: string): { x: number; y: number } {
    const y = tabRow(frame);
    const x = frame.split("\n")[y]!.indexOf(needle);
    if (x < 0) throw new Error(`"${needle}" is not on the header line`);
    return { x, y };
  }

  // ONE fill, not two: `border` is darker than `surface` in dracula and
  // rose-pine, so a second fill on the inactive chip would draw it RAISED
  // above the active one in those palettes.
  it("fills only the tab that is showing", async () => {
    const { settled, spans } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      onePR,
    );
    expect(settled).toContain(WORKTREES_TAB);
    const line = tabLine(spans(), settled);
    expect(bgOf(line, WORKTREES_TAB)).toEqual(
      RGBA.fromHex(theme.border).toInts(),
    );
    expect(bgOf(line, PRS_TAB)).toEqual(RGBA.fromHex(theme.base).toInts());
  });

  it("switches the view when the other tab is clicked", async () => {
    const { settled, frame, spans, mouse } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      onePR,
    );
    expect(settled).toContain("main checkout");
    expect(settled).not.toContain("#151");

    const at = cellOf(settled, PRS_TAB);
    await mouse.click(at.x, at.y);
    const after = await frame();
    expect(after).toContain("#151");
    expect(after).not.toContain("main checkout");
    // And the chip that is now showing carries the brighter ground.
    const line = tabLine(spans(), after);
    expect(bgOf(line, PRS_TAB)).toEqual(RGBA.fromHex(theme.border).toInts());
    expect(bgOf(line, WORKTREES_TAB)).toEqual(
      RGBA.fromHex(theme.base).toInts(),
    );
  });

  // Clicking where you already are must not re-seed the cursor or reload:
  // `switchView` returns early on its own view, and this is what proves the
  // chip is wired through it rather than to a bare `setView`.
  it("does nothing when the tab already showing is clicked", async () => {
    const { settled, frame, mouse } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      onePR,
    );
    const at = cellOf(settled, WORKTREES_TAB);
    await mouse.click(at.x, at.y);
    expect(await frame()).toBe(settled);
  });

  // The width arithmetic lives in `headerLayout`, but the LINE is assembled
  // from separate `<text>` nodes for the zone gap and the chip gap — columns
  // the math has to account for and the JSX has to spend exactly once. Get
  // that wrong and the header does not overflow visibly: OpenTUI wraps, and
  // a wrapped line inside a `height={1}` box VANISHES. So the check is that
  // the header is still on screen at every width, and still one line, with
  // the list's first row directly beneath it.
  //
  // Swept rather than sampled, and across both views, because the rungs
  // change at different widths in each and an extra column shows up only at
  // the exact boundary where a rung is chosen.
  it("stays on one visible line at every width, in both views", async () => {
    for (const width of [
      90, 60, 47, 46, 45, 40, 37, 36, 35, 32, 30, 29, 24, 21, 20,
    ]) {
      for (const view of ["worktrees", "prs"] as const) {
        const { settled, frame, keys } = await mountSettled(
          listOf([mainRow(), row()]),
          emptyScan,
          { width },
          // A title carrying none of the header's words, so "the header did
          // not wrap onto the next line" cannot be satisfied or defeated by
          // a row that happens to mention them.
          prsOf([openPR({ title: "a pull request" })]),
        );
        let shown = settled;
        if (view === "prs") {
          keys.pressKey("l");
          shown = await frame();
        }
        const lines = shown.split("\n");
        const at = lines.findIndex(
          (line) => line.includes("Worktrees") || line.includes("PRs"),
        );
        expect({ width, view, at }).toEqual({ width, view, at: 1 });
        // One line, not two: the row under the header carries list content
        // and no second helping of the header (a wrapped chip strip would
        // land there, and a header that vanished would put a list row on
        // line 1 and pass the check above for the wrong reason).
        const under = lines[at + 1]!;
        expect({
          width,
          view,
          under: under.replace(/[│┌┐└┘\s]/gu, ""),
        }).not.toEqual({ width, view, under: "" });
        expect(under).not.toMatch(/Worktrees|PRs|Pull Requests/);

        // And what is drawn is EXACTLY what the ladder measured. The border
        // and one column of padding sit either side; everything between is
        // the header. An extra drawn column that the math never counted is
        // the failure this guards: it does not look wrong until the width
        // where it tips the line over into a wrap, and then the line is gone
        // entirely rather than clipped. (An empty `<text>` costs one column
        // in OpenTUI, which is how three "emptied" zones once did it.)
        const drawn = lines[at]!.slice(2).replace(/[│\s]+$/u, "");
        const expected = headerText(
          headerLayout({
            view,
            lead: "repo",
            worktrees: "2",
            prs: "1",
            tail: null,
            width: Math.max(8, width - 4),
          }),
        ).replace(/\s+$/u, "");
        expect({ width, view, drawn }).toEqual({
          width,
          view,
          drawn: expected,
        });

        // The same equality for the shapes the mount above cannot produce:
        // a tail present, and a lead that spells nothing (`basename("/")`).
        // Both are ways to smuggle an unmeasured column onto the line.
        for (const shape of [
          { lead: "repo", tail: "◐ scanning" },
          { lead: "", tail: null as string | null },
          { lead: "", tail: "◐ scanning" as string | null },
        ]) {
          const layout = headerLayout({
            view,
            worktrees: "2",
            prs: "1",
            width: Math.max(8, width - 4),
            ...shape,
          });
          // Measured against the BUDGET handed to the layout, not the
          // terminal width: the four columns of border and padding between
          // them are free slack an overflow could hide in.
          for (const part of headerParts(layout)) {
            if (part.kind !== "chip") expect(part.text).not.toBe("");
          }
          const spelled = headerParts(layout)
            .map((part) =>
              part.kind === "chip"
                ? part.tab.segments.map((seg) => seg.text).join("")
                : part.text,
            )
            .join("");
          const budget = Math.max(8, width - 4);
          expect({ width, view, over: displayWidth(spelled) > budget }).toEqual(
            { width, view, over: false },
          );
        }
        // Each width gets its own renderer; the shared afterEach only ever
        // reaches the last one this loop mounted.
        setup?.renderer.destroy();
        setup = undefined;
      }
    }
  });

  // The zones were once drawn as SIBLINGS of a `<For>`, and a `<Show>`
  // sibling that unmounts does not necessarily come back where it was:
  // dropped at a narrow width and restored on the way out, the scope lead
  // reappeared at the END of the row, reading `Worktrees 16   Pull Requests
  // 2   ccmux`.
  //
  // What holds that line now is ONE `<For>` over a flat parts list, where a
  // zone with nothing to say is simply ABSENT. Emptying the zones instead
  // was tried first and is wrong: an empty `<text>` occupies one column in
  // OpenTUI, so three emptied zones put the line three columns over what
  // `headerWidth` measured, and a line that overruns wraps and then vanishes
  // out of its `height={1}` box. Do not "simplify" this back toward always
  // rendering every zone.
  it("keeps the zones in order across a width round trip", async () => {
    const { frame, resize } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      { width: 90 },
      prsOf([openPR({ title: "a pull request" })]),
    );
    const before = lineWith(await frame(), WORKTREES_TAB);
    expect(before.replace(/^[│\s]+/u, "")).toStartWith("repo");
    // Narrow enough that the ladder drops the lead entirely...
    resize(24, 24);
    const narrow = await frame();
    expect(lineWith(narrow, WORKTREES_TAB)).not.toContain("repo ");
    // ...and wide again, where every zone has to come back where it was.
    // Compared WHOLE, not just by the lead's position: a chip or the tail
    // landing out of order is the same bug wearing a different zone.
    resize(90, 24);
    expect(lineWith(await frame(), WORKTREES_TAB)).toBe(before);
  });

  // A click is a second way into `switchView`, so it has to refuse wherever
  // the keys refuse. It did not: with `Remove worktrees?` up, the keyboard
  // ignores `l` (the confirm handler returns before the view keys), but a
  // click switched the list behind the dialog — and `y` then prunes a
  // selection that is no longer on screen, which is precisely what gating
  // the removal keys on the VIEW exists to prevent. Asserted as PARITY
  // rather than as two separate facts, so the two paths cannot drift again.
  it("refuses a tab click wherever the tab keys are refused", async () => {
    const { keys, frame, mouse, settled } = await mountSettled(
      listOf([mainRow(), row()]),
      { candidates: [candidate()], skipped: [] },
      {},
      prsOf([openPR({ title: "a pull request" })]),
    );
    const at = cellOf(settled, PRS_TAB);
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("x");
    const confirming = await frame();
    expect(confirming).toContain("Remove worktrees?");

    keys.pressKey("l");
    const afterKey = await frame();
    await mouse.click(at.x, at.y);
    const afterClick = await frame();

    // Neither reaches the PR view, and the confirm is still the thing on
    // screen. Compared to each other as well as to the truth, because a
    // guard that stopped BOTH by accident (say, by unmounting the chips)
    // would satisfy the first two assertions alone.
    expect(afterKey).not.toContain("#151");
    expect(afterClick).not.toContain("#151");
    expect(afterClick).toContain("Remove worktrees?");
    expect(afterClick).toBe(afterKey);
  });

  // The guard is exactly the confirm, not "anything but the list". A reload
  // also leaves the list phase, and the keys go on working through one — the
  // key handler only returns early for the confirm — so a guard written as
  // `phase() !== "list"` would silently stop both paths mid-refresh. Read
  // off the FILL, because the body is showing `Reading worktrees...` and has
  // no rows either way.
  it("still switches view while a reload is in flight", async () => {
    let lists = 0;
    const { keys, frame, spans } = await mountPanel({
      list: async () =>
        ++lists === 1
          ? json(listOf([mainRow(), row()]))
          : await new Promise<Response>(() => {}),
      scan: async () => json(emptyScan),
    });
    await frame();
    keys.pressKey("r");
    const reloading = await frame();
    expect(reloading).toContain("Reading worktrees...");
    keys.pressKey("l");
    const switched = await frame();
    expect(bgOf(tabLine(spans(), switched), PRS_TAB)).toEqual(
      RGBA.fromHex(theme.border).toInts(),
    );
  });

  // The affordance: a filled block that answers nothing until it is clicked
  // reads as decoration.
  it("brightens the tab under the pointer", async () => {
    const { settled, frame, spans, mouse } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      onePR,
    );
    const at = cellOf(settled, PRS_TAB);
    expect(fgOf(tabLine(spans(), settled), PRS_TAB)).toEqual(
      RGBA.fromHex(theme.overlay).toInts(),
    );
    await mouse.moveTo(at.x, at.y);
    const hovered = await frame();
    expect(fgOf(tabLine(spans(), hovered), PRS_TAB)).toEqual(
      RGBA.fromHex(theme.subtext).toInts(),
    );
  });
});

describe("initialView", () => {
  // One derivation covers all three return paths (a review reopen, a
  // spawn-from-PR cursor, a cancelled dialog) without any of them growing a
  // prop.
  it("opens the PR view only for a PR cursor", () => {
    expect(initialView(prRowKey("/repo", 151))).toBe("prs");
    expect(initialView("/repo/wt/alpha")).toBe("worktrees");
    expect(initialView(null)).toBe("worktrees");
    expect(initialView(undefined)).toBe("worktrees");
  });
});

describe("PR section layout", () => {
  it("sorts PRs below every worktree, newest first", () => {
    const rows: PanelRow[] = [
      prRow({ pr: openPR({ number: 7 }) }),
      panelRow({ row: row({ name: "alpha" }) }),
      prRow({ pr: openPR({ number: 151 }) }),
      panelRow({ row: mainRow() }),
    ];
    expect(sortWorktreeRows(rows).map(sortedName)).toEqual([
      "main checkout",
      "alpha",
      "#151",
      "#7",
    ]);
  });

  it("splits PR rows out of the worktree sections", () => {
    const split = splitRemovable([
      panelRow({ row: row({ path: "/a" }) }),
      panelRow({
        row: row({ path: "/b" }),
        candidate: candidate({ path: "/b" }),
      }),
      prRow(),
    ]);
    expect(split.kept.map((e) => e.key)).toEqual(["/a"]);
    expect(split.removable.map((e) => e.key)).toEqual(["/b"]);
    expect(split.prs.map((e) => e.key)).toEqual(["pr:/repo#151"]);
  });

  // The line each repo used to spend on an always-drawn PR header is the
  // whole reason the section became a view: thirteen repos meant thirteen
  // lines of a forty-five-line viewport spent mostly saying `0`.
  it("places no PR line at all in the worktrees view", () => {
    const a = panelRow({ row: row({ path: "/a", name: "a" }) });
    const b = panelRow({ row: row({ path: "/b", name: "b" }) });
    const layout = visualLayout(
      [
        panelRepo("/r1", "r1", [a, prRow()], { kind: "ready", count: 1 }),
        panelRepo("/r2", "r2", [b], { kind: "ready", count: 0 }),
      ],
      () => 1,
      "worktrees",
    );
    // header(0) a(1) | header(2) b(3) — no third section anywhere.
    expect(layout.get("/a")).toEqual({ line: 1, height: 1 });
    expect(layout.get("/b")).toEqual({ line: 3, height: 1 });
    expect(layout.get(prRow().key)).toBeUndefined();
  });

  // The PR view counts repo headers plus either the rows or the ONE line
  // standing in for them, and it places only PR rows: a layout that measured
  // both views' lines would put every row after the first group out of true.
  it("counts a repo's PR rows, or the one line that stands in", () => {
    const wt = panelRow({ row: row({ path: "/a", name: "a" }) });
    const pr = prRow();
    const layout = visualLayout(
      [
        panelRepo("/r1", "r1", [wt, pr], { kind: "ready", count: 1 }),
        panelRepo("/r2", "r2", [
          panelRow({ row: row({ path: "/b", name: "b" }) }),
        ]),
      ],
      () => 1,
      "prs",
    );
    // header(0) pr(1) | header(2) "no open PRs"(3)
    expect(layout.get(pr.key)).toEqual({ line: 1, height: 1 });
    expect(layout.get("/a")).toBeUndefined();
    expect(layout.get("/b")).toBeUndefined();
  });

  // Whichever answer phase 3 gives, the repo that has no open PRs spends
  // exactly one line saying so, so the groups below it do not move as it
  // resolves. It spends that line as a ROW now, which is what makes it
  // reachable; the layout has no arm for "a repo with no rows" at all.
  it("spends one line on every rowless PR-section state", () => {
    const pr = prRow({ pr: openPR({ number: 9 }), repoRoot: "/r2" });
    const states: PanelRepo["prSection"][] = [
      { kind: "pending" },
      { kind: "ready", count: 0 },
      { kind: "unavailable", reason: "gh is logged out" },
    ];
    const lines = states.map((prSection) => {
      const standIn: PanelRow = {
        kind: "pr-status",
        key: prStatusRowKey("/r1"),
        repoRoot: "/r1",
        status: prSection,
      };
      return visualLayout(
        [
          panelRepo("/r1", "r1", [standIn], prSection),
          panelRepo("/r2", "r2", [pr], { kind: "ready", count: 1 }),
        ],
        (entry) => rowVisualHeight(entry, false),
        "prs",
      ).get(pr.key)?.line;
    });
    // header(0) stand-in(1) | header(2) pr(3), in all three.
    expect(lines).toEqual([3, 3, 3]);
  });
});

describe("WorktreesPanel PR view", () => {
  const onePR = prsOf([openPR()]);

  // The whole reason the section became a view: the Worktrees view is exactly
  // what it was before phase 3 existed, and every line it used to spend on a
  // per-repo PR header is back.
  it("shows no trace of the PR section in the worktrees view", async () => {
    const { settled } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      onePR,
    );
    expect(settled).toContain("main checkout");
    expect(settled).not.toContain("open PRs");
    expect(settled).not.toContain("#151");
  });

  it("swaps the rows for the repo's PRs on l, and back on h", async () => {
    const { keys, frame, settled } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      onePR,
    );
    expect(settled).toContain("main checkout");

    keys.pressKey("l");
    const prs = await frame();
    expect(prs).toContain("#151 Worktrees panel: open-PR list");
    expect(prs).not.toContain("main checkout");

    keys.pressKey("h");
    const back = await frame();
    expect(back).toContain("main checkout");
    expect(back).not.toContain("#151");
  });

  // The count is the PANEL's, not the active view's: the inactive tab has to
  // state the other view's number, which is what it is there for.
  it("carries the live PR count on the tab from the worktrees view", async () => {
    const { settled } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      prsOf([openPR(), openPR({ number: 150 })]),
    );
    expect(settled).toContain("Pull Requests 2");
  });

  // The spinner rides the LABEL rather than a row, so nothing takes a line
  // and gives it back when GitHub answers.
  it("spins on the tab while phase 3 is in flight", async () => {
    let answer: ((r: Response) => void) | null = null;
    const { frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => json(emptyScan),
      prs: () => new Promise<Response>((resolve) => (answer = resolve)),
    });

    const pending = await frame();
    expect(pending).toContain("Pull Requests ");
    expect(pending).not.toContain("Pull Requests 0");
    // The worktrees are usable throughout that window, unchanged.
    expect(pending).toContain("main checkout");

    answer!(json(onePR));
    expect(await frame()).toContain("Pull Requests 1");
  });

  // The reversal that is the point: `0` is noise in the Worktrees view and
  // the ANSWER in this one, so it gets a line here and none there.
  it("says a repo has no open PRs, in the PR view only", async () => {
    const { keys, frame, settled } = await mountSettled(
      listOf([mainRow(), row()]),
    );
    expect(settled).not.toContain("no open PRs");

    keys.pressKey("l");
    expect(await frame()).toContain("no open PRs");
  });

  // ONE cause for every repo, so it is said ONCE and the groups go with it.
  // Under each repo it filled the whole viewport with copies of the same
  // sentence, and that is the FIRST-RUN state for every existing user, whose
  // daemon predates `/prs` until they restart it. Bare headers over the line
  // would be the same noise in a different shape: in this view a repo whose
  // PRs are entirely unknown carries no information.
  it("says a whole-request failure once, without the repo groups", async () => {
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
                  path: "/other/wt/d",
                  repoRoot: "/other",
                  repoName: "other",
                }),
              ],
            },
          ],
        }),
      scan: async () => json(emptyScan),
      prs: async () => {
        throw new Error("gh is logged out");
      },
    });
    const worktrees = await frame();
    expect(worktrees).toContain("Pull Requests unavailable");
    // Nothing leaks into the Worktrees view, which has no PR presence at all.
    expect(worktrees).not.toContain("gh is logged out");
    expect(worktrees).toContain("main checkout");
    // Both repo headers are there, since the Worktrees view still has rows.
    expect(worktrees).toContain("other ─");

    keys.pressKey("l");
    const prs = await frame();
    expect(prs).toContain("Open PRs unavailable: gh is logged out");
    // Said once, and the groups are gone with it.
    expect(prs.match(/gh is logged out/g)).toHaveLength(1);
    expect(prs).not.toContain("other ─");
    expect(prs).not.toContain("no open PRs");
  });

  // Per-repo failures arrive as HTTP 200 with `repos: []`, so `prError()` is
  // null and a naive count is 0: the tab asserted `· 0` while every line
  // beneath it said the answer was unknown, and the Worktrees view, which has
  // no such lines, showed only the fabricated zero.
  it("never asserts a count of zero it cannot stand behind", async () => {
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(listOf([mainRow(), row()])),
        scan: async () => json(emptyScan),
        prs: async () =>
          json({
            repos: [],
            errors: [
              {
                repoRoot: "/repo",
                repoName: "repo",
                error: "no GitHub remote",
              },
            ],
          }),
      },
      {},
    );
    const shown = await frame();
    expect(shown).toContain("Pull Requests unavailable");
    expect(shown).not.toContain("Pull Requests 0");
    // And the body agrees, because both read the same sections.
    keys.pressKey("l");
    expect(await frame()).toContain("unavailable: no GitHub remote");
  });

  // A repo's own error rides inside an otherwise fine response, so only that
  // repo's line is marked and the others still answer. This is the steady
  // state with a current daemon, and it keeps the per-repo line the
  // whole-request case gives up.
  it("marks only the repo whose own PR lookup failed", async () => {
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
                  path: "/other/wt/d",
                  repoRoot: "/other",
                  repoName: "other",
                }),
              ],
            },
          ],
        }),
      scan: async () => json(emptyScan),
      prs: async () =>
        json({
          repos: [{ repoRoot: "/other", repoName: "other", prs: [] }],
          errors: [
            { repoRoot: "/repo", repoName: "repo", error: "no GitHub remote" },
          ],
        }),
    });
    keys.pressKey("l");
    const shown = await frame();
    // The groups survive here, because they are what tells the two apart.
    expect(shown).toContain("unavailable: no GitHub remote");
    expect(shown).toContain("no open PRs");
    expect(shown).toContain("other ─");
  });

  // Degrades like phase 2: the panel never reaches its error phase, and the
  // worktrees are still the thing the user came for.
  it("keeps the panel usable when the PR list fails", async () => {
    const { frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => json(emptyScan),
      prs: async () => {
        throw new Error("gh is logged out");
      },
    });
    const shown = await frame();
    expect(shown).toContain("main checkout");
    expect(shown).toContain("enter open");
    // Not the error phase: `r retry · q close` is what that renders.
    expect(shown).not.toContain("r retry");
  });

  it("marks a PR whose head is a local branch tip as checked out", async () => {
    const held = row({
      path: "/repo/wt/pr",
      name: "pr-151",
      branch: "feat/pr-list-panel",
      tip: "sha-151",
    });
    const { keys, frame } = await mountSettled(
      listOf([mainRow(), held]),
      emptyScan,
      {},
      onePR,
    );
    keys.pressKey("l");
    expect(await frame()).toContain("checked out in pr-151");
  });

  // A FIRST visit to a view has nothing remembered, so it seeds on row 1.
  it("seeds the cursor on the new view's first row on a first visit", async () => {
    const { keys, frame } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      prsOf([openPR(), openPR({ number: 150 })]),
    );
    keys.pressKey("l");
    const prs = await frame();
    // The cursor bar sits in the rail's column on the row it is on.
    expect(lineWith(prs, "#151")).toContain(CURSOR_BAR);

    keys.pressKey("j");
    expect(lineWith(await frame(), "#150")).toContain(CURSOR_BAR);
  });

  // And a RETURN restores what the view was left on, both ways.
  it("remembers each view's cursor across a round trip", async () => {
    const { keys, frame } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      prsOf([openPR(), openPR({ number: 150 })]),
    );
    // Leave the worktrees view on its SECOND row.
    keys.pressKey("j");
    expect(lineWith(await frame(), "alpha")).toContain(CURSOR_BAR);

    keys.pressKey("l");
    keys.pressKey("j");
    expect(lineWith(await frame(), "#150")).toContain(CURSOR_BAR);

    // Back, and not to row 1.
    keys.pressKey("h");
    expect(lineWith(await frame(), "alpha")).toContain(CURSOR_BAR);
    expect(lineWith(await frame(), "main checkout")).not.toContain(CURSOR_BAR);

    // Forward, and not to row 1 either.
    keys.pressKey("l");
    expect(lineWith(await frame(), "#150")).toContain(CURSOR_BAR);
  });

  // The memory is a PREFERENCE, not an assignment. The PR view's keys change
  // under it — a `pr-status` row vanishes the moment its repo gains a PR, and
  // a PR that merges between visits takes its row with it — so a remembered
  // key that is no longer there falls back to the ordinary re-seed.
  it("falls back to the first row when the remembered row is gone", async () => {
    let answer: ((r: Response) => void) | null = null;
    const { keys, frame } = await mountPanel({
      list: async () => json(listOf([mainRow(), row()])),
      scan: async () => json(emptyScan),
      prs: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    await frame();

    // While pending the PR view is a list of stand-in rows; leave it on one.
    keys.pressKey("l");
    expect(lineWith(await frame(), "checking GitHub")).toContain(CURSOR_BAR);
    keys.pressKey("h");
    await frame();

    // Phase 3 lands and that stand-in row is REPLACED by a real PR row, so
    // the remembered key names nothing.
    answer!(json(prsOf([openPR()])));
    await frame();
    keys.pressKey("l");
    expect(lineWith(await frame(), "#151")).toContain(CURSOR_BAR);
  });

  // j/k walk the ACTIVE view's rows and nothing else. A consumer left on the
  // unfiltered list is a key acting on a row that is not on screen.
  it("never walks the cursor off the active view's rows", async () => {
    const { keys, frame } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      onePR,
    );
    for (let i = 0; i < 6; i++) keys.pressKey("j");
    const shown = await frame();
    expect(shown).not.toContain("#151");
    // Still on a worktree row, and the last one at that.
    expect(lineWith(shown, "alpha")).toContain(CURSOR_BAR);
  });
});

describe("PR row return cursor", () => {
  // `initialView` is the single authority on which view an open lands in, so
  // the fix is to feed it the right KEY rather than to send a view alongside
  // it. A view sent explicitly with the cursor still a path would reopen the
  // PR view on a key its list cannot hold, and the re-seed would drop the
  // cursor on row 1 — a wrong row instead of a wrong view.
  it("derives the PR view from the key a checked-out PR row sends", () => {
    expect(initialView(prRowKey("/repo", 151))).toBe("prs");
    // What the branch used to send, and why it came back to the wrong view.
    expect(initialView("/repo/wt/pr")).toBe("worktrees");
  });
});

describe("WorktreesPanel PR view reachability", () => {
  /** N repos, each with only its main checkout and no open PRs. */
  function prLessRepos(n: number): WorktreeListResponse {
    return listOf(
      Array.from({ length: n }, (_, i) =>
        mainRow({
          path: `/r${i}`,
          repoRoot: `/r${i}`,
          repoName: `repo-${i}`,
          name: `repo-${i}`,
        }),
      ),
    );
  }

  // The High this commit exists for. The stand-in line used to be a LINE:
  // the render drew it and `visualLayout` counted it, but `flatRows()` did
  // not contain it, so `moveCursor` returned on an empty list, the scroll
  // effect had no cursor to chase, and every repo past the first screenful
  // was unreachable from the keyboard while a scrollbar drew itself
  // alongside. As a ROW it is simply walked to.
  it("walks the cursor to the last repo when no repo has open PRs", async () => {
    const { keys, frame } = await mountSettled(
      prLessRepos(8),
      emptyScan,
      { height: 12 },
      noPRs,
    );
    keys.pressKey("l");
    const top = await frame();
    expect(top).toContain("repo-0");
    expect(top).not.toContain("repo-7");

    for (let i = 0; i < 30; i++) keys.pressKey("j");
    const bottom = await frame();
    expect(bottom).toContain("repo-7");
    expect(bottom).toContain("no open PRs");
  });

  // The mixed case from the same bug: the cursor used to pin to the single
  // PR row because it was the only thing in `flatRows()`.
  it("walks past a repo that does have PRs to the repos below it", async () => {
    const list = prLessRepos(8);
    const { keys, frame } = await mountSettled(
      list,
      emptyScan,
      { height: 12 },
      {
        repos: [{ repoRoot: "/r0", repoName: "repo-0", prs: [openPR()] }],
        errors: [],
      },
    );
    keys.pressKey("l");
    for (let i = 0; i < 30; i++) keys.pressKey("j");
    expect(await frame()).toContain("repo-7");
  });

  // The status row is an ordinary row, so it is keyed, sorted and placed by
  // the same machinery as every other one.
  it("gives the stand-in a key the layout places and nothing else claims", () => {
    const key = prStatusRowKey("/r0");
    expect(key).toBe("pr-status:/r0");
    // Not a worktree path, and NOT a PR key — the re-seed effect's hold must
    // not claim it, since no return path ever asks to land here.
    expect(isPRRowKey(key)).toBe(false);
    const statusRow: PanelRow = {
      kind: "pr-status",
      key,
      repoRoot: "/r0",
      status: { kind: "ready", count: 0 },
    };
    const layout = visualLayout(
      [
        panelRepo("/r0", "r0", [
          panelRow({ row: row({ path: "/a" }) }),
          statusRow,
        ]),
      ],
      (entry) => rowVisualHeight(entry, false),
      "prs",
    );
    expect(layout.get(key)).toEqual({ line: 0, height: 1 });
    // One line tall, derived from `detailPhrases` like every other row.
    expect(rowVisualHeight(statusRow, false)).toBe(1);
    // Never measured into the label column: a long `unavailable: …` would
    // otherwise stretch every worktree's branch column in the panel.
    expect(
      labelColumnWidth([
        statusRow,
        {
          ...statusRow,
          key: "pr-status:/r1",
          status: { kind: "unavailable", reason: "x".repeat(60) },
        },
      ]),
    ).toBe(0);
  });

  // Behaviour this commit deliberately introduces: while phase 3 is in
  // flight the PR view is a list of spinner rows, one per repo, and the
  // cursor sits on one. That is what makes the pending view scrollable.
  it("is a walkable list of spinner rows while phase 3 is pending", async () => {
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(prLessRepos(3)),
        scan: async () => json(emptyScan),
        prs: () => new Promise<Response>(() => {}),
      },
      { height: 16 },
    );
    keys.pressKey("l");
    const shown = await frame();
    expect(shown).toContain("checking GitHub");
    expect(lineWith(shown, "checking GitHub")).toContain(CURSOR_BAR);
  });

  // Enter has nothing to open here, and says which of the three things the
  // row is reporting rather than doing nothing.
  it("says what the stand-in row is reporting when Enter cannot act", async () => {
    const { keys, frame } = await mountSettled(
      prLessRepos(2),
      emptyScan,
      {},
      noPRs,
    );
    keys.pressKey("l");
    keys.pressEnter();
    expect(await frame()).toContain("no open PRs here");
  });
});

describe("WorktreesPanel PR view cursor under phase 3", () => {
  /** N repos, each with only its main checkout. */
  function repos(n: number): WorktreeListResponse {
    return listOf(
      Array.from({ length: n }, (_, i) =>
        mainRow({
          path: `/r${i}`,
          repoRoot: `/r${i}`,
          repoName: `repo-${i}`,
          name: `repo-${i}`,
        }),
      ),
    );
  }

  // A `pr-status` key does not go missing because its row was removed: it
  // goes missing because that repo ANSWERED and its stand-in was replaced by
  // real PR rows. Falling back to `rows[0]` yanked the cursor to the top of
  // the list and dragged the viewport with it, away from the very rows the
  // user had parked on waiting for.
  it("keeps the cursor in the repo whose PRs just arrived", async () => {
    let answer: ((r: Response) => void) | null = null;
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(repos(4)),
        scan: async () => json(emptyScan),
        prs: () => new Promise<Response>((resolve) => (answer = resolve)),
      },
      { height: 24 },
    );
    await frame();

    // Park on the THIRD repo's stand-in row while GitHub is still thinking.
    keys.pressKey("l");
    keys.pressKey("j");
    keys.pressKey("j");
    const parked = await frame();
    expect(parked).toContain("repo-2");

    // That repo, and only that repo, answers.
    answer!(
      json({
        repos: [{ repoRoot: "/r2", repoName: "repo-2", prs: [openPR()] }],
        errors: [],
      }),
    );
    const settled = await frame();

    // The cursor is on the row that replaced the one it was parked on, not
    // at the top of the list.
    expect(lineWith(settled, "#151")).toContain(CURSOR_BAR);
    expect(lineWith(settled, "no open PRs")).not.toContain(CURSOR_BAR);
  });

  // Bounded: a repo OTHER than the cursor's answering leaves the key intact,
  // so the re-seed never runs at all.
  it("does not move the cursor when a different repo answers", async () => {
    let answer: ((r: Response) => void) | null = null;
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(repos(4)),
        scan: async () => json(emptyScan),
        prs: () => new Promise<Response>((resolve) => (answer = resolve)),
      },
      { height: 24 },
    );
    await frame();
    keys.pressKey("l");
    keys.pressKey("j");
    await frame();

    answer!(
      json({
        repos: [{ repoRoot: "/r3", repoName: "repo-3", prs: [openPR()] }],
        errors: [],
      }),
    );
    const settled = await frame();
    // Still on repo-1's stand-in, which never changed.
    const line = settled.split("\n").findIndex((l) => l.includes(CURSOR_BAR));
    expect(settled.split("\n")[line - 1]).toContain("repo-1");
  });

  // The whole-request failure replaces the list with one banner line, so
  // there is nothing on screen for a cursor to be on. The row list used to
  // hold a stand-in per repo anyway: the cursor seeded onto one and `j`
  // walked it invisibly. Nothing destructive is reachable there, but it is
  // exactly the shape this panel is built to avoid.
  it("holds no cursor at all behind the whole-request banner", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => json(repos(4)),
      scan: async () => json(emptyScan),
      prs: async () => {
        throw new Error("gh is logged out");
      },
    });
    keys.pressKey("l");
    const shown = await frame();
    expect(shown).toContain("Open PRs unavailable: gh is logged out");
    // Nothing is DRAWN either way here, since the banner replaces the list.
    // What the gate changes is whether a cursor exists behind it, and the
    // way to see that is to press a key that reports on the row it is on:
    // `y` answered "nothing to copy on this line" for a line that was not
    // on any line. With no cursor there is no row and no flash at all.
    keys.pressKey("j");
    keys.pressKey("j");
    keys.pressKey("y");
    const walked = await frame();
    expect(walked).not.toContain("nothing to copy on this line");
    expect(walked).toContain("Open PRs unavailable: gh is logged out");
    expect(walked).not.toContain(CURSOR_BAR);

    // The worktrees view is untouched by the gate.
    keys.pressKey("h");
    expect(await frame()).toContain(CURSOR_BAR);
  });

  it("maps a stand-in key back to the repo that owns it", () => {
    expect(prStatusRowRepo(prStatusRowKey("/r2"))).toBe("/r2");
    expect(prStatusRowRepo(prRowKey("/r2", 151))).toBeNull();
    expect(prStatusRowRepo("/repo/wt/alpha")).toBeNull();
  });
});

describe("WorktreesPanel PR view safety gate", () => {
  const removable = () => {
    const gone = row({ path: "/repo/wt/gone", name: "gone" });
    return {
      list: listOf([mainRow(), gone]),
      scan: {
        candidates: [candidate({ path: "/repo/wt/gone", name: "gone" })],
        skipped: [],
      } as ScanResponse,
    };
  };

  // The one way this panel could delete something the user cannot see. `x`
  // acts on the SELECTION, not on the cursor, so a selection made in the
  // Worktrees view is still live after `l` — the view is what has to gate it.
  it("refuses x in the PR view with a non-empty selection", async () => {
    const { list, scan } = removable();
    const { keys, frame } = await mountSettled(
      list,
      scan,
      {},
      prsOf([openPR()]),
    );
    // Select the removable row.
    keys.pressKey("j");
    keys.pressKey(" ");
    expect(await frame()).toContain("x remove 1");

    keys.pressKey("l");
    keys.pressKey("x");
    const shown = await frame();
    // The confirm never opened: its headline is what the phase renders.
    expect(shown).not.toContain("Delete 1 worktree");
    expect(shown).toContain("removal lives in the worktrees view");
  });

  // The selection is deliberately NOT cleared by a view switch: the gate is
  // the only thing that changed, so `h` gets the selection back intact.
  it("keeps the selection across a view round trip", async () => {
    const { list, scan } = removable();
    const { keys, frame } = await mountSettled(
      list,
      scan,
      {},
      prsOf([openPR()]),
    );
    keys.pressKey("j");
    keys.pressKey(" ");
    keys.pressKey("l");
    keys.pressKey("h");
    expect(await frame()).toContain("x remove 1");

    keys.pressKey("x");
    expect(await frame()).toContain("Delete 1 worktree");
  });

  it("makes space, a and D inert in the PR view", async () => {
    const { list, scan } = removable();
    const { keys, frame } = await mountSettled(
      list,
      scan,
      {},
      prsOf([openPR()]),
    );
    keys.pressKey("l");
    keys.pressKey(" ");
    keys.pressKey("a");
    keys.pressKey("D");
    await frame();

    keys.pressKey("h");
    const shown = await frame();
    // Nothing was selected while the PR view was up, so the hint still reads
    // the bare `x remove` it does with an empty selection.
    expect(shown).not.toContain("x remove 1");
  });

  // The keys are taught on the hint line, never on the chips. The `[l]`
  // badge that briefly lived there was rejected in live use.
  it("teaches the view key in the footer, and never on the tab", async () => {
    const { list, scan } = removable();
    const { settled } = await mountSettled(list, scan, {
      repo: "/repo",
      width: 90,
      onReview: () => {},
    });
    expect(settled).toContain("l PRs");
    // The chips carry their own padding, so what reaches the screen is the
    // two labels three columns apart, with no separator glyph between them
    // and no dot gluing either count to its own label.
    expect(lineWith(settled, WORKTREES_TAB)).toMatch(
      /Worktrees \d   Pull Requests \d/,
    );
    expect(settled).not.toContain("[l]");
  });

  // The accepted cost, asserted so it cannot regress silently in either
  // direction. What decides it at 80 columns is the CURSOR, not the width
  // alone: the removal keys are advertised only under the removable divider,
  // so the line is at its fullest there and the view hint is what gives way.
  // Deliberate — nothing that ACTS is displaced to keep it.
  it("keeps the view hint at 80 columns on an ordinary row", async () => {
    const { list, scan } = removable();
    const { settled } = await mountSettled(list, scan, {
      repo: "/repo",
      width: 80,
      onReview: () => {},
    });
    expect(settled).toContain("l PRs");
  });

  it("gives the view hint up before an acting key on a removable row", async () => {
    const { list, scan } = removable();
    const { keys, frame } = await mountSettled(list, scan, {
      repo: "/repo",
      width: 80,
      onReview: () => {},
    });
    keys.pressKey("j");
    const shown = await frame();
    expect(shown).not.toContain("l PRs");
    expect(shown).toContain("x remove");
    expect(shown).toContain("space select");
    expect(shown).toContain("enter open");
    expect(shown).toContain("q close");
  });

  // The footer teaches the keys that are live, and only those.
  it("drops the removal keys from the PR view's hint line", async () => {
    const { list, scan } = removable();
    const { keys, frame } = await mountSettled(
      list,
      scan,
      {},
      prsOf([openPR()]),
    );
    keys.pressKey("l");
    const shown = await frame();
    expect(shown).toContain("enter checkout");
    // This view's line is short enough to carry the way back at a rank that
    // survives the narrow widths.
    expect(shown).toContain("h worktrees");
    expect(shown).not.toContain("space select");
    expect(shown).not.toContain("x remove");
    expect(shown).not.toContain("y copy");
    expect(shown).not.toContain("d review");
  });
});

describe("PR section title and cursor", () => {
  const onePR = prsOf([openPR()]);

  // `flatRows()` has held PR rows since the section landed, so the chip said
  // `Worktrees 4` for two worktrees and two PRs, and the number JUMPED from 2
  // to 4 when phase 3 answered - the exact flicker the loading gate exists
  // to prevent.
  it("counts worktrees on the chip, never PR rows", async () => {
    const { keys, frame, settled } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      {},
      prsOf([openPR(), openPR({ number: 150 })]),
    );
    expect(lineWith(settled, WORKTREES_TAB)).toContain("Worktrees 2");
    expect(settled).not.toContain("Worktrees 4");

    // The count is the PANEL's and not the active view's, so the chip says
    // the same thing in both. Counting `flatRows()` here said `Worktrees 0`
    // under the PR view.
    keys.pressKey("l");
    expect(lineWith(await frame(), WORKTREES_TAB)).toContain("Worktrees 2");
  });

  // Phase 1 is local git and phase 3 is a `gh` round trip, so phase 1 lands
  // first with worktrees only. Re-seeding on that frame threw away the cursor
  // restoration a cancelled PR-spawn dialog depends on.
  it("holds a PR cursor seed until phase 3 can deliver its row", async () => {
    let answer: ((r: Response) => void) | null = null;
    const { frame } = await mountPanel(
      {
        list: async () => json(listOf([mainRow(), row()])),
        scan: async () => json(emptyScan),
        prs: () => new Promise<Response>((resolve) => (answer = resolve)),
      },
      { initialCursor: prRowKey("/repo", 151) },
    );

    // A PR cursor opens the PR VIEW, which is the only one that can show it.
    // Phase 1 has painted and the seeded row does not exist yet; what must
    // survive is the seeded KEY, and the frame after phase 3 proves it did.
    const pending = await frame();
    expect(pending).toContain("checking GitHub");
    expect(pending).not.toContain("main checkout");

    answer!(json(onePR));
    const settled = await frame();
    expect(lineWith(settled, "#151")).toContain(CURSOR_BAR);
  });

  // The hold is scoped to the PR VIEW as well as to the key. In the
  // Worktrees view the row can never arrive however long phase 3 takes, so
  // holding there would leave `cursorPath` naming a row the list does not
  // have while the highlight sat on row 0 — the disagreement the re-seed
  // exists to repair.
  it("re-seeds when a held PR cursor is carried into the worktrees view", async () => {
    const { keys, frame } = await mountPanel(
      {
        list: async () => json(listOf([mainRow(), row()])),
        scan: async () => json(emptyScan),
        prs: () => new Promise<Response>(() => {}),
      },
      { initialCursor: prRowKey("/repo", 151) },
    );
    await frame();

    keys.pressKey("h");
    const shown = await frame();
    expect(lineWith(shown, "main checkout")).toContain(CURSOR_BAR);
  });

  // The hold is scoped to "phase 3 has not answered". A PR that merged
  // between the two opens is genuinely gone, and the cursor falls back.
  it("says so once phase 3 reports the seeded PR is gone", async () => {
    const { keys, frame, settled } = await mountSettled(
      listOf([mainRow(), row()]),
      emptyScan,
      { initialCursor: prRowKey("/repo", 151) },
      noPRs,
    );
    // The view stays where it was asked to open and ANSWERS. Silently
    // switching views would move the panel under a user who is looking at it
    // for a reason.
    expect(settled).toContain("no open PRs");

    keys.pressKey("h");
    expect(lineWith(await frame(), "main checkout")).toContain(CURSOR_BAR);
  });

  it("classifies a key without needing its row", () => {
    expect(isPRRowKey(prRowKey("/repo", 151))).toBe(true);
    // Every worktree key is an absolute path, so the prefix cannot collide.
    expect(isPRRowKey("/repo/wt/alpha")).toBe(false);
  });
});

describe("WorktreesPanel r refresh", () => {
  // `r` already meant reload on the done and error phases and simply never
  // reached the list, where the panel spends all its time.
  it("refetches all three phases from the list phase", async () => {
    const { keys, frame } = await mountSettled(listOf([mainRow(), row()]));
    const before = requested.length;

    keys.pressKey("r");
    await frame();

    const after = requested.slice(before);
    expect(after).toHaveLength(3);
    expect(after.some((url) => url.includes("/worktrees?"))).toBe(true);
    expect(after.some((url) => url.includes("prune-candidates"))).toBe(true);
    expect(after.some((url) => url.includes("/prs"))).toBe(true);
  });

  // A refresh key that answers from a 60s cache does nothing for the one
  // thing here that goes stale on its own, so the explicit press says so.
  it("asks the daemon to skip the PR cache, and only on an explicit press", async () => {
    const { keys, frame } = await mountSettled(listOf([mainRow()]));
    // The opening load is an ordinary one: the TTL is what makes a reopen and
    // a Tab rescope cheap.
    expect(requested.filter((u) => u.includes("refresh=1"))).toHaveLength(0);

    keys.pressKey("r");
    await frame();
    const prs = requested.filter((u) => u.includes("/prs"));
    expect(prs[prs.length - 1]).toContain("refresh=1");
    // Only the PR read: the other two have no cache to skip.
    expect(
      requested.filter((u) => u.includes("refresh=1") && !u.includes("/prs")),
    ).toHaveLength(0);
  });

  // The key was justified on "one key, one meaning, on every phase". A retry
  // from done or error that answered the PR section from a 60s cache would
  // have been the context-sensitive version of exactly that.
  it("refreshes the same way from the error phase", async () => {
    const { keys, frame } = await mountPanel({
      list: async () => {
        throw new Error("daemon is down");
      },
      scan: async () => json(emptyScan),
    });
    expect(await frame()).toContain("daemon is down");
    const before = requested.length;

    keys.pressKey("r");
    await frame();

    const prs = requested.slice(before).filter((u) => u.includes("/prs"));
    expect(prs).toHaveLength(1);
    expect(prs[0]).toContain("refresh=1");
  });

  it("matches both spellings of the capital", async () => {
    const { keys, frame } = await mountSettled(listOf([mainRow()]));
    const before = requested.length;
    keys.pressKey("R");
    await frame();
    expect(requested.length).toBeGreaterThan(before);
  });
});

describe("PR row keys", () => {
  async function onPRRow(opts: PanelOptions = {}, prs = prsOf([openPR()])) {
    const harness = await mountSettled(
      listOf([mainRow()]),
      emptyScan,
      opts,
      prs,
    );
    // The PR view's first row, which the cursor re-seeds onto.
    harness.keys.pressKey("l");
    await harness.frame();
    return harness;
  }

  it("cuts a worktree from a PR that is not checked out", async () => {
    const spawns: unknown[] = [];
    const fromPR: unknown[] = [];
    const { keys, frame } = await onPRRow({
      repo: "/repo",
      onSpawn: (t) => spawns.push(t),
      onSpawnFromPR: (t) => fromPR.push(t),
    });
    keys.pressEnter();
    await frame();

    expect(spawns).toHaveLength(0);
    expect(fromPR[0]).toMatchObject({
      number: 151,
      title: "Worktrees panel: open-PR list",
      repoRoot: "/repo",
      cursor: "pr:/repo#151",
      panelRepo: "/repo",
      panelScope: "/repo",
    });
  });

  // Not a second jump path: a checked-out PR IS the worktree holding it, so
  // Enter takes the existing revalidated verb.
  it("routes a checked-out PR through the ordinary worktree spawn", async () => {
    const held = row({
      path: "/repo/wt/pr",
      name: "pr-151",
      branch: "feat/pr-list-panel",
      tip: "sha-151",
    });
    const spawns: unknown[] = [];
    const fromPR: unknown[] = [];
    const harness = await mountSettled(
      listOf([mainRow(), held]),
      emptyScan,
      { onSpawn: (t) => spawns.push(t), onSpawnFromPR: (t) => fromPR.push(t) },
      prsOf([openPR()]),
    );
    harness.keys.pressKey("l");
    harness.keys.pressEnter();
    await harness.frame();

    expect(fromPR).toHaveLength(0);
    expect(spawns[0]).toMatchObject({
      cwd: "/repo/wt/pr",
      existingWorktree: "/repo/wt/pr",
      // The ROW's key, not the destination path: a cancelled dialog reopens
      // through `initialView`, which reads the cursor, so a path here sent
      // the user back to the Worktrees view while the adjacent
      // not-checked-out row returned correctly.
      cursor: prRowKey("/repo", 151),
    });
  });

  // Explicitly guarded, not left to fall through: both act on a directory a
  // PR row does not have, and a silent key reads as broken.
  it("guards y and d on a PR row and says why", async () => {
    const reviewed: unknown[] = [];
    const { keys, frame } = await onPRRow({
      onReview: (t) => reviewed.push(t),
    });

    keys.pressKey("y");
    expect(await frame()).toContain("no directory yet");

    keys.pressKey("d");
    expect(await frame()).toContain("d reviews a worktree");
    expect(reviewed).toHaveLength(0);
  });

  it("leaves the removal keys inert on a PR row", async () => {
    const { keys, frame } = await onPRRow();
    keys.pressKey(" ");
    keys.pressKey("x");
    const shown = await frame();
    // No checkbox appeared, and `x` named the view that owns removal rather
    // than opening a confirm over rows that are not on screen.
    expect(shown).not.toContain("[x]");
    expect(shown).toContain("removal lives in the worktrees view");
  });
});

describe("rowPRUrl", () => {
  // ONE meaning on every row is the rule; `o` never reads the row to decide
  // what it does.
  it("answers with the PR a row points at, whichever kind it is", () => {
    expect(rowPRUrl(prRow())).toBe("https://github.com/o/r/pull/151");
    expect(
      rowPRUrl(
        panelRow({
          pr: {
            number: 9,
            url: "https://github.com/o/r/pull/9",
            state: "OPEN",
          },
        }),
      ),
    ).toBe("https://github.com/o/r/pull/9");
    // A merged PR reaches the row through `merged()`, which folds the
    // candidate's PR into `entry.pr` — so it is the SAME field, not a second
    // one to fall back to.
    expect(
      rowPRUrl(
        panelRow({
          pr: {
            number: 8,
            url: "https://github.com/o/r/pull/8",
            state: "MERGED",
          },
          candidate: candidate(),
        }),
      ),
    ).toBe("https://github.com/o/r/pull/8");
    expect(rowPRUrl(panelRow())).toBeNull();
  });

  it("picks the platform's opener, and reports where there is none", () => {
    expect(browserArgv("https://x", "darwin")).toEqual(["open", "https://x"]);
    expect(browserArgv("https://x", "linux")).toEqual([
      "xdg-open",
      "https://x",
    ]);
    expect(browserArgv("https://x", "win32")).toBeNull();

    const argv: string[][] = [];
    expect(
      openInBrowser(
        "https://x",
        (a) => {
          argv.push(a);
          return true;
        },
        "darwin",
      ),
    ).toBe(true);
    expect(argv).toEqual([["open", "https://x"]]);
    expect(openInBrowser("https://x", () => true, "win32")).toBe(false);
  });
});

describe("WorktreesPanel o key", () => {
  /**
   * Through the recorder, never the real opener. The first version of this
   * test called the live default and put real browser windows on the
   * developer's screen; its assertion was a disjunction that passed either
   * way, so a green suite said nothing about which had happened.
   */
  it("hands the row's PR to the opener and names the URL it opened", async () => {
    const { keys, frame, openedUrls } = await mountSettled(
      listOf([mainRow()]),
      emptyScan,
      {},
      prsOf([openPR()]),
    );
    keys.pressKey("l");
    keys.pressKey("o");
    const shown = await frame();

    expect(openedUrls).toEqual(["https://github.com/o/r/pull/151"]);
    expect(shown).toContain("opened https://github.com/o/r/pull/151");
  });

  // Forced by the stub, so it cannot stand in for the success case above.
  it("says so when the machine has no opener", async () => {
    const { keys, frame, openedUrls } = await mountSettled(
      listOf([mainRow()]),
      emptyScan,
      { opensUrls: false },
      prsOf([openPR()]),
    );
    keys.pressKey("l");
    keys.pressKey("o");
    const shown = await frame();

    expect(openedUrls).toEqual(["https://github.com/o/r/pull/151"]);
    expect(shown).toContain("no browser opener here");
    expect(shown).not.toContain("opened https://");
  });

  /**
   * The same hazard on the other key, closed by the same seam. `y` was never
   * pressed on a worktree row by any test (every other `y` here is the
   * confirm phase's), so this was latent rather than live — one keypress from
   * writing to the developer's real clipboard through `pbcopy`.
   */
  it("copies through the seam rather than through pbcopy", async () => {
    const { keys, frame, copiedText } = await mountSettled(
      listOf([mainRow(), row()]),
    );
    keys.pressKey("j");
    keys.pressKey("y");

    expect(await frame()).toContain("copied alpha");
    expect(copiedText).toEqual(["/repo/wt/alpha"]);
  });

  it("says so on a row with no PR at all, without reaching the opener", async () => {
    const { keys, frame, openedUrls } = await mountSettled(
      listOf([mainRow(), row()]),
    );
    keys.pressKey("o");
    expect(await frame()).toContain("no PR on this row");
    expect(openedUrls).toEqual([]);
  });
});
