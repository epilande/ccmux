import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { testRender } from "@opentui/solid";
import { createMockKeys } from "@opentui/core/testing";
import type { CapturedSpan } from "@opentui/core";
import type { IssueListResponse, OpenIssue } from "../../daemon/issue-list";
import type { OpenPR, PRListResponse } from "../../daemon/pr-list";
import type {
  WorktreeListResponse,
  WorktreeRow,
} from "../../daemon/worktree-list";
import {
  SourcePicker,
  sourcePickerLayout,
  sourceRowHeight,
} from "./SourcePicker";
import { buildSourceRepos } from "./source-picker-rows";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup | undefined;
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
  // `spyOn` + `mockRestore`, never `mock.module`, which leaks across files.
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

const openPR = (overrides: Partial<OpenPR> = {}): OpenPR => ({
  number: 156,
  title: "park the renderer while hidden",
  url: "https://github.com/o/r/pull/156",
  author: "epilande",
  isDraft: false,
  reviewDecision: null,
  ciStatus: "none",
  headRefName: "feat/sidebar-parking",
  headRefOid: "sha-156",
  ...overrides,
});

const openIssue = (overrides: Partial<OpenIssue> = {}): OpenIssue => ({
  number: 144,
  title: "Notifications are swallowed",
  url: "https://github.com/o/r/issues/144",
  author: "epilande",
  labels: ["bug"],
  ...overrides,
});

const worktreeRow = (overrides: Partial<WorktreeRow> = {}): WorktreeRow => ({
  path: "/repo/wt/a",
  name: "a",
  repoRoot: "/repo",
  repoName: "repo",
  branch: "feat/a",
  tip: "sha-a",
  detached: false,
  isMain: false,
  locked: false,
  dirty: { dirty: false, modified: 0, untracked: 0 },
  upstream: null,
  sessions: [],
  ...overrides,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

interface Handlers {
  prs?: () => Promise<Response>;
  issues?: () => Promise<Response>;
  worktrees?: () => Promise<Response>;
}

function installFetch(handlers: Handlers) {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: unknown,
  ) => {
    const url = String(input);
    if (url.includes("/issues")) {
      return handlers.issues?.() ?? json({ repos: [], errors: [] });
    }
    if (url.includes("/prs")) {
      return handlers.prs?.() ?? json({ repos: [], errors: [] });
    }
    return handlers.worktrees?.() ?? json({ repos: [] });
  }) as unknown as typeof fetch);
}

interface Picked {
  prs: { number: number; cursor: string; filter: string }[];
  issues: { number: number; cursor: string; filter: string }[];
  worktrees: { path: string; cursor: string; filter: string }[];
  closes: number;
}

async function mount(
  handlers: Handlers,
  opts: {
    repo?: string | null;
    width?: number;
    height?: number;
    initialFilter?: string;
    initialCursor?: string | null;
    compact?: boolean;
  } = {},
) {
  // BEFORE `testRender`, so the component's first load cannot reach a real
  // daemon.
  installFetch(handlers);
  const picked: Picked = { prs: [], issues: [], worktrees: [], closes: 0 };
  setup = await testRender(
    () => (
      <SourcePicker
        repo={opts.repo ?? "/repo"}
        cwd="/repo"
        compact={opts.compact}
        initialFilter={opts.initialFilter}
        initialCursor={opts.initialCursor}
        onClose={() => {
          picked.closes += 1;
        }}
        onPickPR={(target) => picked.prs.push(target)}
        onPickIssue={(target) => picked.issues.push(target)}
        onOpenWorktree={(target) => picked.worktrees.push(target)}
      />
    ),
    { width: opts.width ?? 90, height: opts.height ?? 24 },
  );
  await setup.renderOnce();
  const keys = createMockKeys(setup.renderer);
  const frame = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await setup!.renderOnce();
    return setup!.captureCharFrame();
  };
  /**
   * Escape, actually delivered.
   *
   * A bare `\u001b` is the prefix of every escape SEQUENCE, so the parser
   * holds it until either more bytes arrive or its timeout elapses — which is
   * why `pressEscape()` followed by an immediate repaint reports nothing, and
   * why a following keypress arrives as meta-that-key instead. The wait is
   * the whole helper. (`pressKey("escape")` is a different trap: it types the
   * six letters, which is issue #160.)
   */
  const escape = async () => {
    keys.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await setup!.renderOnce();
  };
  return { picked, keys, escape, frame, spans: () => setup!.captureSpans() };
}

/** Everything answered, with one PR and one issue. */
async function mountSettled(
  opts: {
    prs?: OpenPR[];
    issues?: OpenIssue[];
    worktrees?: WorktreeRow[];
  } & Parameters<typeof mount>[1] = {},
) {
  const harness = await mount(
    {
      prs: async () =>
        json({
          repos: [{ repoRoot: "/repo", repoName: "repo", prs: opts.prs ?? [] }],
          errors: [],
        } satisfies PRListResponse),
      issues: async () =>
        json({
          repos: [
            { repoRoot: "/repo", repoName: "repo", issues: opts.issues ?? [] },
          ],
          errors: [],
        } satisfies IssueListResponse),
      worktrees: async () =>
        json({
          repos: [
            {
              repoRoot: "/repo",
              repoName: "repo",
              worktrees: opts.worktrees ?? [],
            },
          ],
        } satisfies WorktreeListResponse),
    },
    opts,
  );
  await harness.frame();
  return harness;
}

describe("SourcePicker", () => {
  it("lists both sources under their own headers, with counts", async () => {
    const harness = await mountSettled({
      prs: [openPR()],
      issues: [openIssue()],
    });
    const frame = await harness.frame();

    expect(frame).toContain("Pull requests 1");
    expect(frame).toContain("Issues 1");
    expect(frame).toContain("#156 park the renderer while hidden");
    expect(frame).toContain("#144 Notifications are swallowed");
    // The count sits against its own label: in this TUI `·` divides PEERS.
    expect(frame).not.toContain("Pull requests · 1");
  });

  it("gives each kind its own marker", async () => {
    const harness = await mountSettled({
      prs: [openPR()],
      issues: [openIssue()],
    });
    const frame = await harness.frame();
    const prLine = frame.split("\n").find((line) => line.includes("#156"));
    const issueLine = frame.split("\n").find((line) => line.includes("#144"));

    // They share one list, so the left edge is what says which is which.
    expect(prLine).toContain("⊙");
    expect(issueLine).toContain("○");
    expect(issueLine).not.toContain("⊙");
  });

  it("says what a source is still doing rather than calling it zero", async () => {
    // The issue read never settles, so its section is still pending while the
    // PR one has answered.
    const harness = await mount({
      prs: async () =>
        json({
          repos: [{ repoRoot: "/repo", repoName: "repo", prs: [openPR()] }],
          errors: [],
        }),
      issues: () => new Promise<Response>(() => {}),
      worktrees: async () =>
        json({
          repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
        }),
    });
    const frame = await harness.frame();

    expect(frame).toContain("Pull requests 1");
    expect(frame).toContain("checking GitHub");
    expect(frame).not.toContain("Issues 0");
  });

  /**
   * The first-run state for every existing user, whose daemon predates
   * `/issues` until they restart it. It has to name the fix, under the source
   * it applies to, while the other source still answers.
   */
  it("states a failing source's cause under that source", async () => {
    const harness = await mount({
      prs: async () =>
        json({
          repos: [{ repoRoot: "/repo", repoName: "repo", prs: [openPR()] }],
          errors: [],
        }),
      issues: async () => new Response("nope", { status: 404 }),
      worktrees: async () =>
        json({
          repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
        }),
    });
    const frame = await harness.frame();

    expect(frame).toContain("Issues unavailable");
    expect(frame).toContain("ccmux daemon restart");
    // And it costs only its own section.
    expect(frame).toContain("#156 park the renderer while hidden");
  });

  it("marks a PR whose head a worktree holds, by SHA", async () => {
    const harness = await mountSettled({
      prs: [openPR()],
      worktrees: [worktreeRow({ name: "parking", tip: "sha-156" })],
    });
    expect(await harness.frame()).toContain("checked out in parking");
  });

  it("marks an issue whose worktree a previous spawn cut", async () => {
    const harness = await mountSettled({
      issues: [openIssue()],
      worktrees: [worktreeRow({ name: "issue-144-notifications" })],
    });
    expect(await harness.frame()).toContain(
      "checked out in issue-144-notifications",
    );
  });
});

describe("SourcePicker keys", () => {
  it("moves the cursor with j and k", async () => {
    const harness = await mountSettled({
      prs: [openPR(), openPR({ number: 155, title: "second" })],
      issues: [],
    });

    // The cursor row carries a background, which a char frame cannot show.
    const backgroundOf = (needle: string): number[] => {
      for (const line of harness.spans().lines) {
        const span: CapturedSpan | undefined = line.spans.find((s) =>
          s.text.includes(needle),
        );
        if (span) return span.bg.toInts();
      }
      throw new Error(`no span carrying "${needle}"`);
    };
    const cursorBg = backgroundOf("#156");
    const restBg = backgroundOf("#155");
    expect(cursorBg).not.toEqual(restBg);

    harness.keys.pressKey("j");
    await harness.frame();

    // The highlight MOVED with the cursor, rather than a second row lighting
    // up beside the first.
    expect(backgroundOf("#155")).toEqual(cursorBg);
    expect(backgroundOf("#156")).toEqual(restBg);
  });

  it("clamps rather than wrapping at both ends", async () => {
    const harness = await mountSettled({ prs: [openPR()], issues: [] });
    harness.keys.pressKey("k");
    harness.keys.pressKey("k");
    harness.keys.pressKey("j");
    harness.keys.pressKey("j");
    await harness.frame();
    // Nothing to assert but that it did not throw and the row is still there:
    // one row means every movement is a clamp.
    expect(await harness.frame()).toContain("#156");
  });

  it("starts a PR on enter, carrying the cursor and the filter back", async () => {
    const harness = await mountSettled({ prs: [openPR()], issues: [] });
    harness.keys.pressEnter();
    await harness.frame();

    expect(harness.picked.prs).toHaveLength(1);
    expect(harness.picked.prs[0]?.number).toBe(156);
    expect(harness.picked.prs[0]?.cursor).toContain("156");
  });

  it("starts an issue on enter", async () => {
    const harness = await mountSettled({ prs: [], issues: [openIssue()] });
    harness.keys.pressEnter();
    await harness.frame();

    expect(harness.picked.issues[0]?.number).toBe(144);
    expect(harness.picked.prs).toHaveLength(0);
  });

  /**
   * A source already checked out here is not a spawn question at all: it is
   * the worktree that holds it, and this surface obeys the same one-agent-per-
   * worktree rule the panel does.
   */
  it("opens the worktree instead of spawning when one already holds the row", async () => {
    const harness = await mountSettled({
      prs: [openPR()],
      worktrees: [
        worktreeRow({
          name: "parking",
          tip: "sha-156",
          path: "/repo/wt/parking",
        }),
      ],
    });
    harness.keys.pressEnter();
    await harness.frame();

    expect(harness.picked.worktrees[0]?.path).toBe("/repo/wt/parking");
    expect(harness.picked.prs).toHaveLength(0);
  });

  it("closes on q", async () => {
    const harness = await mountSettled({ prs: [openPR()] });
    harness.keys.pressKey("q");
    await harness.frame();
    expect(harness.picked.closes).toBe(1);
  });

  it("closes on escape too", async () => {
    const harness = await mountSettled({ prs: [openPR()] });
    await harness.escape();
    expect(harness.picked.closes).toBe(1);
  });

  /**
   * The scroll effect has to SUBSCRIBE, which it only does if every signal it
   * depends on is read before the `listBox` guard.
   *
   * `listBox` is a plain ref rather than a signal, and the scrollbox mounts
   * only once rows arrive, so an effect that reads the guard first bails at
   * mount having tracked nothing — and Solid never runs a dependency-less
   * effect again. The list is then unscrollable for the whole life of the
   * picker while `j` goes on moving a cursor nobody can see, and every key
   * that acts, acts on that invisible row. The panel's counterpart carries
   * the same rule in a comment; this asserts it instead.
   */
  it("scrolls the cursor's row into view past the fold", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      openPR({
        number: 200 + i,
        title: `pr ${200 + i}`,
        headRefOid: `sha-${200 + i}`,
        headRefName: `feat/${200 + i}`,
      }),
    );
    const harness = await mountSettled({
      prs: many,
      issues: [],
      height: 14,
    });
    // The top of the list is what a fresh picker shows.
    expect(await harness.frame()).toContain("#200");

    for (let i = 0; i < 25; i += 1) harness.keys.pressKey("j");
    const frame = await harness.frame();

    // The cursor is on #225, so #225 must be ON SCREEN and the first row
    // must have scrolled off. Asserting both matters: a viewport that never
    // moved still "contains" the cursor row's number if you only look for it
    // at the top of a long list.
    expect(frame).toContain("#225");
    expect(frame).not.toContain("#200");
  });

  /**
   * The same effect, revived with NO keypress at all.
   *
   * This is the test that pins `void scrollboxLayout()` specifically. Once a
   * viewport has a size, `cursorKey` changing is enough to re-run the effect,
   * so the `j`-pressing test above still passes if that read is deleted as
   * unused — while this one does not. The initial scroll has only one
   * carrier: `layout()` re-runs the effect too early, when the box exists but
   * yoga has not measured it and the viewport height is still 0, and
   * `scrollTargetFor` refuses a zero-height viewport. What actually lands the
   * scroll is the resize event the scrollbox ref subscribes to, arriving as a
   * `scrollboxLayout` bump.
   *
   * The path is the cancel-return: a dialog opened from a row far down the
   * list, cancelled, reopening on that row.
   */
  it("scrolls a seeded cursor into view with no keypress", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      openPR({
        number: 200 + i,
        title: `pr ${200 + i}`,
        headRefOid: `sha-${200 + i}`,
        headRefName: `feat/${200 + i}`,
      }),
    );
    const harness = await mountSettled({
      prs: many,
      issues: [],
      height: 14,
      initialCursor: "pr:/repo#225",
    });

    const frame = await harness.frame();
    expect(frame).toContain("#225");
    expect(frame).not.toContain("#200");
  });

  it("does nothing on enter with no row under the cursor", async () => {
    const harness = await mountSettled({ prs: [], issues: [] });
    harness.keys.pressEnter();
    await harness.frame();

    expect(harness.picked.prs).toHaveLength(0);
    expect(harness.picked.issues).toHaveLength(0);
    expect(harness.picked.worktrees).toHaveLength(0);
  });
});

describe("SourcePicker filter", () => {
  it("narrows to what was typed, across both kinds at once", async () => {
    const harness = await mountSettled({
      prs: [openPR({ title: "auto-detect nested tmux" })],
      issues: [
        openIssue({ title: "Notifications swallowed in nested tmux" }),
        openIssue({ number: 12, title: "unrelated", author: "someone" }),
      ],
      initialFilter: "nested",
    });
    const frame = await harness.frame();

    // One typed word reaching both kinds is the whole argument for one list
    // over two tabs.
    expect(frame).toContain("#156");
    expect(frame).toContain("#144");
    expect(frame).not.toContain("#12 unrelated");
  });

  it("restates each section's count for what the filter left", async () => {
    const harness = await mountSettled({
      prs: [openPR()],
      issues: [openIssue()],
      initialFilter: "swallowed",
    });
    const frame = await harness.frame();

    // A repo whose rows all failed to match keeps its headers and says zero,
    // which is the answer to "is it in this one".
    expect(frame).toContain("Pull requests 0");
    expect(frame).toContain("Issues 1");
  });

  it("says nothing matches rather than drawing an empty list", async () => {
    const harness = await mountSettled({
      prs: [openPR()],
      issues: [openIssue()],
      initialFilter: "kubernetes",
    });
    expect(await harness.frame()).toContain('Nothing matches "kubernetes"');
  });

  /**
   * The row is the session picker's search row, down to being absent until
   * `/` is pressed. A permanently-drawn prompt was the first design and the
   * inconsistency was the whole objection to it: one surface asking to be
   * searched while the other waits to be asked.
   */
  it("draws no filter row until the filter is entered", async () => {
    const harness = await mountSettled({ prs: [openPR()] });
    expect(await harness.frame()).not.toContain("Filter pull requests");

    harness.keys.pressKey("/");
    expect(await harness.frame()).toContain("Filter pull requests and issues");
  });

  it("hints the nav keys in nav mode and the input keys in filter mode", async () => {
    const harness = await mountSettled({ prs: [openPR()] });
    expect(await harness.frame()).toContain("/ filter");

    harness.keys.pressKey("/");
    const filtering = await harness.frame();
    // `q` types here, so the hint that names it must go: the surface would
    // otherwise advertise a key that does something else entirely.
    expect(filtering).toContain("esc cancel");
    expect(filtering).not.toContain("q close");
  });

  /**
   * Esc drops the query along with the row that showed it, which is what
   * `exitSearchMode` does for the session picker's search. Keeping the query
   * while hiding the row would leave the list narrowed with nothing on screen
   * saying why.
   */
  it("drops the query when escape leaves the filter, then closes", async () => {
    const harness = await mountSettled({
      prs: [openPR()],
      issues: [openIssue()],
      initialFilter: "park",
    });
    // A carried query opens in the filter, so the row is there to leave.
    expect(await harness.frame()).toContain("Issues 0");

    await harness.escape();
    const frame = await harness.frame();

    expect(frame).not.toContain("Filter pull requests");
    // The whole list is back, both sections restated.
    expect(frame).toContain("Issues 1");
    expect(frame).toContain("#144");
    // And the first Esc did not close the surface.
    expect(harness.picked.closes).toBe(0);

    await harness.escape();
    expect(harness.picked.closes).toBe(1);
  });

  /**
   * A seeded cursor survives its own source answering LAST.
   *
   * The three reads are independent and the re-seed effect cannot tell "this
   * row is gone" from "this row has not arrived yet". If it clobbers a seeded
   * issue key the moment the PR list lands, the damage is permanent: the
   * cursor now names a row that DOES exist, so when the issue list finally
   * arrives the guard finds the key present and returns. The row comes back
   * and the cursor does not — and Enter starts work on the wrong source.
   */
  it("holds a seeded cursor while its own source is still in flight", async () => {
    let releaseIssues: (() => void) | undefined;
    const issuesArrived = new Promise<void>((resolve) => {
      releaseIssues = resolve;
    });
    const harness = await mount(
      {
        prs: async () =>
          json({
            repos: [{ repoRoot: "/repo", repoName: "repo", prs: [openPR()] }],
            errors: [],
          } satisfies PRListResponse),
        issues: async () => {
          await issuesArrived;
          return json({
            repos: [
              {
                repoRoot: "/repo",
                repoName: "repo",
                issues: [openIssue()],
              },
            ],
            errors: [],
          } satisfies IssueListResponse);
        },
        worktrees: async () =>
          json({
            repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
          } satisfies WorktreeListResponse),
      },
      { initialCursor: "issue:/repo#144" },
    );

    // The PR list has landed and the issue list has not. The seeded issue row
    // does not exist yet, and the PR row does.
    await harness.frame();
    expect(await harness.frame()).toContain("#156");

    releaseIssues?.();
    await harness.frame();
    await harness.frame();

    // Enter must reach the ISSUE the cursor was seeded on, not the PR that
    // happened to answer first.
    harness.keys.pressEnter();
    await harness.frame();
    expect(harness.picked.prs).toHaveLength(0);
    expect(harness.picked.issues).toHaveLength(1);
    expect(harness.picked.issues[0]?.number).toBe(144);
  });

  /**
   * Enter is INERT while the cursor is held, not merely aimed elsewhere.
   *
   * The hold keeps `cursorKey` naming a row the list does not have yet, and
   * `cursorIndex` answers 0 for a key it cannot find — so without a guard the
   * held state highlights nothing while Enter fires on the first row. That is
   * strictly worse than the clobber the hold replaced, which at least showed
   * the user which row Enter was about to take.
   */
  it("does nothing on enter while the cursor is held for a pending source", async () => {
    let releaseIssues: (() => void) | undefined;
    const issuesArrived = new Promise<void>((resolve) => {
      releaseIssues = resolve;
    });
    const harness = await mount(
      {
        prs: async () =>
          json({
            repos: [{ repoRoot: "/repo", repoName: "repo", prs: [openPR()] }],
            errors: [],
          } satisfies PRListResponse),
        issues: async () => {
          await issuesArrived;
          return json({
            repos: [{ repoRoot: "/repo", repoName: "repo", issues: [] }],
            errors: [],
          } satisfies IssueListResponse);
        },
        worktrees: async () =>
          json({
            repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
          } satisfies WorktreeListResponse),
      },
      { initialCursor: "issue:/repo#144" },
    );

    // The PR has landed and the issue read has not: the seeded row does not
    // exist, and the only row that does is one the user never aimed at.
    await harness.frame();
    expect(await harness.frame()).toContain("#156");

    harness.keys.pressEnter();
    await harness.frame();
    expect(harness.picked.prs).toHaveLength(0);
    expect(harness.picked.issues).toHaveLength(0);
    expect(harness.picked.worktrees).toHaveLength(0);

    releaseIssues?.();
  });

  it("re-seeds the cursor onto a row the filter left standing", async () => {
    const harness = await mountSettled({
      prs: [openPR()],
      issues: [openIssue()],
      // The cursor names a row this query removes.
      initialCursor: "pr:/repo#156",
      initialFilter: "swallowed",
    });
    harness.keys.pressEnter();
    await harness.frame();

    // Falling to the first surviving row is what makes typing feel like
    // narrowing rather than losing your place.
    expect(harness.picked.issues[0]?.number).toBe(144);
    expect(harness.picked.prs).toHaveLength(0);
  });
});

describe("sourcePickerLayout", () => {
  const repos = (opts: { prs: OpenPR[]; issues: OpenIssue[] }) =>
    buildSourceRepos({
      prs: {
        repos: [{ repoRoot: "/repo", repoName: "repo", prs: opts.prs }],
        errors: [],
      },
      prError: null,
      issues: {
        repos: [{ repoRoot: "/repo", repoName: "repo", issues: opts.issues }],
        errors: [],
      },
      issueError: null,
      worktrees: {
        repos: [{ repoRoot: "/repo", repoName: "repo", worktrees: [] }],
      },
      home: null,
    });

  /**
   * The headers are LINES the cursor never stops on, but they are lines the
   * layout must COUNT: a scroll target computed without them puts every row
   * below one at a position the arithmetic disagrees with, which is the drift
   * the Worktrees panel already paid for over its removable divider.
   */
  it("counts the section headers the cursor cannot land on", () => {
    const built = repos({ prs: [openPR()], issues: [openIssue()] });
    const layout = sourcePickerLayout(built, (row) => sourceRowHeight(row), {
      repoHeaders: false,
    });

    // Line 0 is the PR header, so the PR row starts at 1 and is two lines
    // tall; the Issues header takes line 3 and its row starts at 4.
    expect(layout.get("pr:/repo#156")).toEqual({ line: 1, height: 2 });
    expect(layout.get("issue:/repo#144")).toEqual({ line: 4, height: 2 });
  });

  it("counts a repo header too, where one is drawn", () => {
    const built = repos({ prs: [openPR()], issues: [] });
    const withHeader = sourcePickerLayout(
      built,
      (row) => sourceRowHeight(row),
      { repoHeaders: true },
    );
    expect(withHeader.get("pr:/repo#156")?.line).toBe(2);
  });

  it("places a one-line row as one line", () => {
    // An issue with no author and no labels has nothing to say on a second
    // line, so it does not draw one.
    const built = repos({
      prs: [],
      issues: [openIssue({ author: null, labels: [] })],
    });
    const layout = sourcePickerLayout(built, (row) => sourceRowHeight(row), {
      repoHeaders: false,
    });
    expect(layout.get("issue:/repo#144")).toEqual({ line: 2, height: 1 });
  });
});
