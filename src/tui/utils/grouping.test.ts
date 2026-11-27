import { describe, it, expect } from "bun:test";
import {
  groupKeyOf,
  getGroupLabel,
  computeStatusSummary,
  buildFlatItems,
  getSessionIndex,
  toVisualLine,
  itemVisualHeight,
  scrollTarget,
  sortGroups,
  groupSessions,
  normalizeGroupAliases,
  normalizeGroupLayouts,
  resolveGroupName,
  sanitizeGroupName,
  GROUP_NAME_MAX_WIDTH,
  NEEDS_YOU_GROUP_KEY,
  type FilteredSession,
  type GroupEntry,
} from "./grouping";
import { mockEnrichedSession } from "../components/test-helpers";
import type { EnrichedSession } from "../../types";

function mockSession(
  overrides: Partial<EnrichedSession> = {},
): EnrichedSession {
  return mockEnrichedSession({
    project: "my-project",
    cwd: "/home/user/projects/my-project",
    tmuxPane: "%0",
    tmuxTarget: "dev:0.0",
    paneCwd: "/home/user/projects/my-project",
    ...overrides,
  });
}

function toFiltered(session: EnrichedSession): FilteredSession {
  return { session, highlights: null, paneMatch: false };
}

describe("groupKeyOf", () => {
  it("groups by project name", () => {
    const session = mockSession({ project: "my-app" });
    expect(groupKeyOf(session, "project", {})).toBe("my-app");
  });

  it("falls back to cwd for project grouping when project is empty", () => {
    const session = mockSession({ project: "", cwd: "/some/path" });
    expect(groupKeyOf(session, "project", {})).toBe("/some/path");
  });

  it("groups by cwd using paneCwd", () => {
    const session = mockSession({
      cwd: "/original",
      paneCwd: "/current/path",
    });
    expect(groupKeyOf(session, "cwd", {})).toBe("/current/path");
  });

  it("falls back to cwd when paneCwd is null", () => {
    const session = mockSession({ cwd: "/original", paneCwd: null });
    expect(groupKeyOf(session, "cwd", {})).toBe("/original");
  });

  it("groups by tmux session name", () => {
    const session = mockSession({ tmuxTarget: "my-session:2.0" });
    expect(groupKeyOf(session, "session", {})).toBe("my-session");
  });

  it("groups by tmux window", () => {
    const session = mockSession({ tmuxTarget: "my-session:2.0" });
    expect(groupKeyOf(session, "window", {})).toBe("my-session:2");
  });

  it("handles missing tmuxTarget for session", () => {
    const session = mockSession({ tmuxTarget: null });
    expect(groupKeyOf(session, "session", {})).toBe("(no tmux)");
  });

  it("handles missing tmuxTarget for window", () => {
    const session = mockSession({ tmuxTarget: null });
    expect(groupKeyOf(session, "window", {})).toBe("(no tmux)");
  });

  it("returns empty string for none", () => {
    const session = mockSession();
    expect(groupKeyOf(session, "none", {})).toBe("");
  });

  it("groups background (paneless) sessions under (background) for session/window", () => {
    const session = mockSession({
      trackingMode: "background",
      tmuxPane: null,
      tmuxTarget: null,
    });
    expect(groupKeyOf(session, "session", {})).toBe("(background)");
    expect(groupKeyOf(session, "window", {})).toBe("(background)");
  });

  it("co-locates background sessions by project/cwd under those modes", () => {
    const session = mockSession({
      trackingMode: "background",
      tmuxPane: null,
      tmuxTarget: null,
      project: "repos",
      cwd: "/home/user/repos",
      paneCwd: null,
    });
    expect(groupKeyOf(session, "project", {})).toBe("repos");
    expect(groupKeyOf(session, "cwd", {})).toBe("/home/user/repos");
  });
});

describe("getGroupLabel", () => {
  const origHome = process.env.HOME;

  it("abbreviates home directory for cwd groupBy", () => {
    process.env.HOME = "/home/user";
    expect(getGroupLabel("/home/user/projects", "cwd")).toBe("~/projects");
    process.env.HOME = origHome;
  });

  it("returns key as-is for non-cwd groupBy", () => {
    expect(getGroupLabel("my-project", "project")).toBe("my-project");
  });

  it("returns key as-is if not under home", () => {
    process.env.HOME = "/home/user";
    expect(getGroupLabel("/opt/projects", "cwd")).toBe("/opt/projects");
    process.env.HOME = origHome;
  });

  it("passes through session keys unchanged", () => {
    expect(getGroupLabel("my-session", "session")).toBe("my-session");
  });

  it("passes through window keys unchanged", () => {
    expect(getGroupLabel("my-session:2", "window")).toBe("my-session:2");
  });

  it("passes through project keys unchanged", () => {
    expect(getGroupLabel("my-project", "project")).toBe("my-project");
  });

  it("passes through none keys unchanged", () => {
    expect(getGroupLabel("", "none")).toBe("");
  });
});

describe("groupSessions", () => {
  it("groups sessions by project", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a", project: "alpha" })),
      toFiltered(mockSession({ id: "b", project: "beta" })),
      toFiltered(mockSession({ id: "c", project: "alpha" })),
    ];
    const groups = groupSessions(filtered, "project", {});
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === "alpha")?.members).toHaveLength(2);
    expect(groups.find((g) => g.key === "beta")?.members).toHaveLength(1);
  });

  it("preserves session order within each group", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a1", project: "alpha" })),
      toFiltered(mockSession({ id: "b1", project: "beta" })),
      toFiltered(mockSession({ id: "a2", project: "alpha" })),
    ];
    const groups = groupSessions(filtered, "project", {});
    const alpha = groups.find((g) => g.key === "alpha")!;
    expect(alpha.members[0].session.id).toBe("a1");
    expect(alpha.members[1].session.id).toBe("a2");
  });

  it("returns empty array for empty input", () => {
    expect(groupSessions([], "project", {})).toEqual([]);
  });

  it("groups by session", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a", tmuxTarget: "dev:0.0" })),
      toFiltered(mockSession({ id: "b", tmuxTarget: "dev:1.0" })),
      toFiltered(mockSession({ id: "c", tmuxTarget: "work:0.0" })),
    ];
    const groups = groupSessions(filtered, "session", {});
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === "dev")?.members).toHaveLength(2);
    expect(groups.find((g) => g.key === "work")?.members).toHaveLength(1);
  });
});

describe("computeStatusSummary", () => {
  it("counts statuses correctly", () => {
    const sessions = [
      toFiltered(mockSession({ id: "1", status: "working" })),
      toFiltered(mockSession({ id: "2", status: "waiting" })),
      toFiltered(mockSession({ id: "3", status: "idle" })),
      toFiltered(mockSession({ id: "4", status: "working" })),
    ];
    const summary = computeStatusSummary(sessions);
    expect(summary).toEqual({
      working: 2,
      waitingPermission: 0,
      waitingPlanApproval: 0,
      waitingGeneric: 1,
      idle: 1,
    });
  });

  it("handles empty list", () => {
    expect(computeStatusSummary([])).toEqual({
      working: 0,
      waitingPermission: 0,
      waitingPlanApproval: 0,
      waitingGeneric: 0,
      idle: 0,
    });
  });

  it("categorizes waiting subtypes by attention type", () => {
    const sessions = [
      toFiltered(
        mockSession({
          id: "1",
          status: "waiting",
          attentionType: "permission",
        }),
      ),
      toFiltered(
        mockSession({
          id: "2",
          status: "waiting",
          attentionType: "plan_approval",
        }),
      ),
      toFiltered(
        mockSession({
          id: "3",
          status: "waiting",
          attentionType: "question",
        }),
      ),
      toFiltered(
        mockSession({ id: "4", status: "waiting", attentionType: null }),
      ),
    ];
    const summary = computeStatusSummary(sessions);
    expect(summary).toEqual({
      working: 0,
      waitingPermission: 1,
      waitingPlanApproval: 1,
      waitingGeneric: 2,
      idle: 0,
    });
  });
});

describe("buildFlatItems", () => {
  it("returns flat session list when groupBy is none", () => {
    const sessions = [
      toFiltered(mockSession({ id: "a" })),
      toFiltered(mockSession({ id: "b" })),
    ];
    const items = buildFlatItems(sessions, "none", new Set(), false);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === "session")).toBe(true);
  });

  it("groups sessions with headers", () => {
    const sessions = [
      toFiltered(mockSession({ id: "a", project: "alpha" })),
      toFiltered(mockSession({ id: "b", project: "alpha" })),
      toFiltered(mockSession({ id: "c", project: "beta" })),
    ];
    const items = buildFlatItems(sessions, "project", new Set(), false);

    // header(alpha) + 2 sessions + header(beta) + 1 session = 5
    expect(items).toHaveLength(5);
    expect(items[0].type).toBe("header");
    if (items[0].type === "header") {
      expect(items[0].label).toBe("alpha");
      expect(items[0].count).toBe(2);
    }
    expect(items[1].type).toBe("session");
    expect(items[2].type).toBe("session");
    expect(items[3].type).toBe("header");
    if (items[3].type === "header") {
      expect(items[3].label).toBe("beta");
      expect(items[3].count).toBe(1);
    }
    expect(items[4].type).toBe("session");
  });

  it("carries raw group members on headers without a precomputed summary", () => {
    // Regression: buildFlatItems must not derive the status summary itself.
    // computeStatusSummary reads session.subagents, and this list is a memo;
    // reading subagents here would rebuild every FlatItem (and recreate every
    // reference-keyed row) on each subagent-log write during a fan-out. The
    // header carries raw members so the summary is derived downstream in the
    // header's own reactive scope.
    const lead = toFiltered(
      mockSession({
        id: "lead",
        project: "alpha",
        status: "idle",
        subagents: [
          {
            agentId: "a1",
            status: "working",
            attentionType: null,
            pendingTool: null,
            lastActivityAt: null,
            startedAt: null,
          },
        ],
      }),
    );
    const items = buildFlatItems([lead], "project", new Set(), false);
    const header = items[0];
    expect(header.type).toBe("header");
    if (header.type === "header") {
      expect(header.members).toEqual([lead]);
      expect("statusSummary" in header).toBe(false);
      // The effective-status summary (idle lead + working subagent = working)
      // is still recoverable from the carried members, so the header intent
      // survives the move downstream.
      expect(computeStatusSummary(header.members).working).toBe(1);
    }
  });

  it("hides children of collapsed groups", () => {
    const sessions = [
      toFiltered(mockSession({ id: "a", project: "alpha" })),
      toFiltered(mockSession({ id: "b", project: "alpha" })),
      toFiltered(mockSession({ id: "c", project: "beta" })),
    ];
    const collapsed = new Set(["alpha"]);
    const items = buildFlatItems(sessions, "project", collapsed, false);

    // header(alpha, collapsed) + header(beta) + 1 session = 3
    expect(items).toHaveLength(3);
    expect(items[0].type).toBe("header");
    if (items[0].type === "header") {
      expect(items[0].collapsed).toBe(true);
      expect(items[0].count).toBe(2);
    }
    expect(items[1].type).toBe("header");
    if (items[1].type === "header") {
      expect(items[1].collapsed).toBe(false);
    }
    expect(items[2].type).toBe("session");
  });

  it("forces all groups expanded during search", () => {
    const sessions = [
      toFiltered(mockSession({ id: "a", project: "alpha" })),
      toFiltered(mockSession({ id: "b", project: "beta" })),
    ];
    const collapsed = new Set(["alpha", "beta"]);
    const items = buildFlatItems(sessions, "project", collapsed, true);

    // All expanded: header + session + header + session = 4
    expect(items).toHaveLength(4);
    expect(items[0].type).toBe("header");
    if (items[0].type === "header") {
      expect(items[0].collapsed).toBe(false);
    }
    expect(items[1].type).toBe("session");
  });

  it("sorts groups alphabetically within same priority tier", () => {
    const sessions = [
      toFiltered(mockSession({ id: "a", project: "beta" })),
      toFiltered(mockSession({ id: "b", project: "alpha" })),
      toFiltered(mockSession({ id: "c", project: "beta" })),
    ];
    const items = buildFlatItems(sessions, "project", new Set(), false);
    const headers = items.filter((i) => i.type === "header");
    expect(headers).toHaveLength(2);
    if (headers[0].type === "header" && headers[1].type === "header") {
      expect(headers[0].label).toBe("alpha");
      expect(headers[1].label).toBe("beta");
    }
  });
});

describe("getSessionIndex", () => {
  it("counts only session items before the given index", () => {
    const sessions = [
      toFiltered(mockSession({ id: "a", project: "alpha" })),
      toFiltered(mockSession({ id: "b", project: "alpha" })),
      toFiltered(mockSession({ id: "c", project: "beta" })),
    ];
    const items = buildFlatItems(sessions, "project", new Set(), false);
    // items: [header(alpha), session(a), session(b), header(beta), session(c)]

    // At index 1 (session a): 0 sessions before it
    expect(getSessionIndex(items, 1)).toBe(0);
    // At index 2 (session b): 1 session before it
    expect(getSessionIndex(items, 2)).toBe(1);
    // At index 4 (session c): 2 sessions before it
    expect(getSessionIndex(items, 4)).toBe(2);
  });
});

describe("sortGroups", () => {
  it("sorts alphabetically with no pinned groups", () => {
    const groups: GroupEntry[] = [
      {
        key: "charlie",
        members: [toFiltered(mockSession({ id: "c", status: "idle" }))],
      },
      {
        key: "alpha",
        members: [toFiltered(mockSession({ id: "a", status: "working" }))],
      },
      {
        key: "bravo",
        members: [toFiltered(mockSession({ id: "b", status: "waiting" }))],
      },
    ];
    const sorted = sortGroups(groups, []);
    expect(sorted.map((g) => g.key)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("places pinned groups first in pinned order", () => {
    const groups: GroupEntry[] = [
      {
        key: "alpha",
        members: [toFiltered(mockSession({ id: "a", status: "idle" }))],
      },
      {
        key: "bravo",
        members: [toFiltered(mockSession({ id: "b", status: "idle" }))],
      },
      {
        key: "charlie",
        members: [toFiltered(mockSession({ id: "c", status: "idle" }))],
      },
    ];
    const sorted = sortGroups(groups, ["charlie", "alpha"]);
    expect(sorted.map((g) => g.key)).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("sorts unpinned alphabetically when pinned groups exist", () => {
    const groups: GroupEntry[] = [
      {
        key: "alpha",
        members: [toFiltered(mockSession({ id: "a", status: "idle" }))],
      },
      {
        key: "bravo",
        members: [toFiltered(mockSession({ id: "b", status: "waiting" }))],
      },
      {
        key: "charlie",
        members: [toFiltered(mockSession({ id: "c", status: "idle" }))],
      },
    ];
    // alpha is pinned; bravo and charlie are unpinned (alphabetical)
    const sorted = sortGroups(groups, ["alpha"]);
    expect(sorted.map((g) => g.key)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("ignores pinned keys not present in groups", () => {
    const groups: GroupEntry[] = [
      {
        key: "alpha",
        members: [toFiltered(mockSession({ id: "a", status: "idle" }))],
      },
    ];
    const sorted = sortGroups(groups, ["nonexistent", "alpha"]);
    expect(sorted.map((g) => g.key)).toEqual(["alpha"]);
  });

  const scored = (key: string, ...scores: number[]): GroupEntry => ({
    key,
    members: scores.map((score, i) => ({
      ...toFiltered(mockSession({ id: `${key}-${i}` })),
      score,
    })),
  });

  it("orders groups by best member score during search", () => {
    const groups = [scored("alpha", 400), scored("bravo", 3200, 100)];
    const sorted = sortGroups(groups, [], true);
    // bravo's single strong match (3200) beats alpha despite alphabetical
    // order; the weak second member does not dilute it (max, not sum).
    expect(sorted.map((g) => g.key)).toEqual(["bravo", "alpha"]);
  });

  it("lets relevance override pinning during search", () => {
    const groups = [scored("pinned-proj", 600), scored("zeta", 3200)];
    const sorted = sortGroups(groups, ["pinned-proj"], true);
    expect(sorted.map((g) => g.key)).toEqual(["zeta", "pinned-proj"]);
  });

  it("breaks score ties with the pinned-then-alphabetical order", () => {
    const groups = [
      scored("bravo", 1000),
      scored("alpha", 1000),
      scored("pinned-proj", 1000),
    ];
    const sorted = sortGroups(groups, ["pinned-proj"], true);
    expect(sorted.map((g) => g.key)).toEqual(["pinned-proj", "alpha", "bravo"]);
  });

  it("keeps pin/alphabetical order when not searching, even with scores present", () => {
    const groups = [scored("zeta", 3200), scored("alpha", 400)];
    const sorted = sortGroups(groups, [], false);
    expect(sorted.map((g) => g.key)).toEqual(["alpha", "zeta"]);
  });
});

describe("toVisualLine", () => {
  it("returns cumulative visual lines for session-only lists", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a" })),
        toFiltered(mockSession({ id: "b" })),
        toFiltered(mockSession({ id: "c" })),
      ],
      "none",
      new Set(),
      false,
    );
    // Each session is 2 visual lines (main row + subtitle)
    expect(toVisualLine(items, 0)).toBe(0);
    expect(toVisualLine(items, 1)).toBe(2);
    expect(toVisualLine(items, 2)).toBe(4);
  });

  it("counts every header as 1 line (the header draws its own rule)", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", project: "alpha" })),
        toFiltered(mockSession({ id: "b", project: "alpha" })),
        toFiltered(mockSession({ id: "c", project: "beta" })),
      ],
      "project",
      new Set(),
      false,
    );
    // items: [header(alpha), session(a), session(b), header(beta), session(c)]
    // visual: 0(header), 1-2(a), 3-4(b), 5(header beta), 6-7(c)
    expect(toVisualLine(items, 0)).toBe(0); // header(alpha)
    expect(toVisualLine(items, 1)).toBe(1); // session(a) - 2 lines
    expect(toVisualLine(items, 2)).toBe(3); // session(b) - 2 lines
    expect(toVisualLine(items, 3)).toBe(5); // header(beta) - 1 line, no divider
    expect(toVisualLine(items, 4)).toBe(6); // session(c)
  });

  it("handles collapsed groups correctly", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", project: "alpha" })),
        toFiltered(mockSession({ id: "b", project: "alpha" })),
        toFiltered(mockSession({ id: "c", project: "beta" })),
      ],
      "project",
      new Set(["alpha"]),
      false,
    );
    // items: [header(alpha, collapsed), header(beta), session(c)]
    // visual: 0(header), 1(header beta), 2-3(c)
    expect(toVisualLine(items, 0)).toBe(0); // header(alpha)
    expect(toVisualLine(items, 1)).toBe(1); // header(beta)
    expect(toVisualLine(items, 2)).toBe(2); // session(c) - 2 lines
  });

  it("accumulates offset across three or more groups", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", project: "alpha" })),
        toFiltered(mockSession({ id: "b", project: "beta" })),
        toFiltered(mockSession({ id: "c", project: "charlie" })),
      ],
      "project",
      new Set(),
      false,
    );
    // items: [header(alpha), session(a), header(beta), session(b), header(charlie), session(c)]
    // visual: 0(header), 1-2(a), 3(header beta), 4-5(b), 6(header charlie), 7-8(c)
    expect(toVisualLine(items, 0)).toBe(0); // header(alpha)
    expect(toVisualLine(items, 1)).toBe(1); // session(a) - 2 lines
    expect(toVisualLine(items, 2)).toBe(3); // header(beta)
    expect(toVisualLine(items, 3)).toBe(4); // session(b) - 2 lines
    expect(toVisualLine(items, 4)).toBe(6); // header(charlie)
    expect(toVisualLine(items, 5)).toBe(7); // session(c) - 2 lines
  });

  it("returns 0 for index 0", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", project: "alpha" }))],
      "project",
      new Set(),
      false,
    );
    expect(toVisualLine(items, 0)).toBe(0);
  });
});

describe("itemVisualHeight", () => {
  it("returns 2 for sessions (main row + subtitle)", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", project: "alpha" })),
        toFiltered(mockSession({ id: "b", project: "alpha" })),
      ],
      "project",
      new Set(),
      false,
    );
    // items: [header(alpha), session(a), session(b)]
    expect(itemVisualHeight(items, 1)).toBe(2);
    expect(itemVisualHeight(items, 2)).toBe(2);
  });

  it("returns 1 for the first header", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", project: "alpha" }))],
      "project",
      new Set(),
      false,
    );
    expect(itemVisualHeight(items, 0)).toBe(1);
  });

  it("returns 1 for later headers too: the header is its own rule", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", project: "alpha" })),
        toFiltered(mockSession({ id: "b", project: "beta" })),
      ],
      "project",
      new Set(),
      false,
    );
    // items: [header(alpha), session(a), header(beta), session(b)]
    expect(itemVisualHeight(items, 0)).toBe(1); // first header
    expect(itemVisualHeight(items, 2)).toBe(1); // second header
  });
});

describe("scrollTarget", () => {
  // Two groups: [header(alpha), session(a), session(b), header(beta), session(c)]
  // Visual lines (sessions=2 lines each):
  //   0: header(alpha) [1 line]
  //   1-2: session(a) [2 lines]
  //   3-4: session(b) [2 lines]
  //   5: header(beta) [1 line]
  //   6-7: session(c) [2 lines]
  const items = buildFlatItems(
    [
      toFiltered(mockSession({ id: "a", project: "alpha" })),
      toFiltered(mockSession({ id: "b", project: "alpha" })),
      toFiltered(mockSession({ id: "c", project: "beta" })),
    ],
    "project",
    new Set(),
    false,
  );

  it("returns null when item is visible within viewport", () => {
    // viewport shows lines 0-9, selecting session(a) at visual line 1
    expect(scrollTarget(items, 1, 0, 10)).toBeNull();
  });

  it("scrolls up when item is above viewport", () => {
    // viewport shows lines 5-9, selecting session(a) at visual line 1
    expect(scrollTarget(items, 1, 5, 5)).toBe(1);
  });

  it("scrolls down for a session below viewport", () => {
    // viewport shows lines 0-2, selecting session(c) at visual line 6
    // lastLine = 6 + 2 - 1 = 7, scrollTop = 7 - 3 + 1 = 5
    expect(scrollTarget(items, 4, 0, 3)).toBe(5);
  });

  it("scrolls down to a header just past the viewport", () => {
    // viewport shows lines 0-4, selecting header(beta) at visual line 5
    // scrollTop = 5 - 5 + 1 = 1
    expect(scrollTarget(items, 3, 0, 5)).toBe(1);
  });

  it("does not scroll when the header fits in viewport", () => {
    // viewport shows lines 0-5, header(beta) sits on line 5
    expect(scrollTarget(items, 3, 0, 6)).toBeNull();
  });
});

describe("itemVisualHeight with lineCount", () => {
  it("returns 2 when lineCount is undefined (backward compat)", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", lastPrompt: null }))],
      "none",
      new Set(),
      false,
    );
    expect(itemVisualHeight(items, 0)).toBe(2);
  });

  it("returns 1 when lineCount returns 1", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", lastPrompt: null }))],
      "none",
      new Set(),
      false,
    );
    expect(itemVisualHeight(items, 0, () => 1)).toBe(1);
  });

  it("returns 2 when lineCount returns 2", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", lastPrompt: "hello" }))],
      "none",
      new Set(),
      false,
    );
    expect(itemVisualHeight(items, 0, () => 2)).toBe(2);
  });

  it("varies height per session based on the count", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", lastPrompt: "work" })),
        toFiltered(mockSession({ id: "b", lastPrompt: null })),
      ],
      "none",
      new Set(),
      false,
    );
    const lineCount = (s: EnrichedSession) => (s.lastPrompt ? 2 : 1);
    expect(itemVisualHeight(items, 0, lineCount)).toBe(2);
    expect(itemVisualHeight(items, 1, lineCount)).toBe(1);
  });

  it("ignores lineCount for header items", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", project: "alpha" })),
        toFiltered(mockSession({ id: "b", project: "beta" })),
      ],
      "project",
      new Set(),
      false,
    );
    // items: [header(alpha), session(a), header(beta), session(b)]
    expect(itemVisualHeight(items, 0, () => 1)).toBe(1); // first header
    expect(itemVisualHeight(items, 2, () => 1)).toBe(1); // second header
  });
});

describe("toVisualLine with mixed session heights", () => {
  it("accumulates 1-line sessions correctly", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a" })),
        toFiltered(mockSession({ id: "b" })),
        toFiltered(mockSession({ id: "c" })),
      ],
      "none",
      new Set(),
      false,
    );
    const lineCount = () => 1;
    expect(toVisualLine(items, 0, lineCount)).toBe(0);
    expect(toVisualLine(items, 1, lineCount)).toBe(1);
    expect(toVisualLine(items, 2, lineCount)).toBe(2);
  });

  it("mixes 1-line and 2-line sessions", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", lastPrompt: "work" })),
        toFiltered(mockSession({ id: "b", lastPrompt: null })),
        toFiltered(mockSession({ id: "c", lastPrompt: "more" })),
      ],
      "none",
      new Set(),
      false,
    );
    const lineCount = (s: EnrichedSession) => (s.lastPrompt ? 2 : 1);
    // visual: 0-1(a=2), 2(b=1), 3-4(c=2)
    expect(toVisualLine(items, 0, lineCount)).toBe(0);
    expect(toVisualLine(items, 1, lineCount)).toBe(2);
    expect(toVisualLine(items, 2, lineCount)).toBe(3);
  });

  it("counts headers as one line among 1-line sessions", () => {
    const items = buildFlatItems(
      [
        toFiltered(
          mockSession({ id: "a", project: "alpha", lastPrompt: null }),
        ),
        toFiltered(mockSession({ id: "b", project: "beta", lastPrompt: null })),
      ],
      "project",
      new Set(),
      false,
    );
    // items: [header(alpha), session(a), header(beta), session(b)]
    // visual: 0(header), 1(a=1), 2(header beta), 3(b=1)
    const lineCount = () => 1;
    expect(toVisualLine(items, 0, lineCount)).toBe(0);
    expect(toVisualLine(items, 1, lineCount)).toBe(1);
    expect(toVisualLine(items, 2, lineCount)).toBe(2);
    expect(toVisualLine(items, 3, lineCount)).toBe(3);
  });
});

describe("scrollTarget with mixed session heights", () => {
  // Three 1-line sessions with no group headers
  //   visual lines: 0, 1, 2
  const items1Line = buildFlatItems(
    [
      toFiltered(mockSession({ id: "a", lastPrompt: null })),
      toFiltered(mockSession({ id: "b", lastPrompt: null })),
      toFiltered(mockSession({ id: "c", lastPrompt: null })),
    ],
    "none",
    new Set(),
    false,
  );
  const lineCountAlways = () => 1;

  it("fits more 1-line items in the same viewport", () => {
    // viewport of height 3 fits all 3 one-line sessions
    expect(scrollTarget(items1Line, 2, 0, 3, lineCountAlways)).toBeNull();
  });

  it("scrolls by 1 line when next 1-line item is just below viewport", () => {
    // viewport shows line 0 only, selecting session(b) at visual line 1
    // lastLine = 1, scrollTop = 1 - 1 + 1 = 1
    expect(scrollTarget(items1Line, 1, 0, 1, lineCountAlways)).toBe(1);
  });

  it("scrolls based on actual mixed heights", () => {
    // Two sessions: first has prompt (2 lines), second does not (1 line)
    // visual: 0-1(a), 2(b) - total 3 lines
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", lastPrompt: "work" })),
        toFiltered(mockSession({ id: "b", lastPrompt: null })),
      ],
      "none",
      new Set(),
      false,
    );
    const lineCount = (s: EnrichedSession) => (s.lastPrompt ? 2 : 1);
    // viewport shows line 0 only, selecting session(b) at visual line 2
    // lastLine = 2, scrollTop = 2 - 1 + 1 = 2
    expect(scrollTarget(items, 1, 0, 1, lineCount)).toBe(2);
  });

  it("returns null when selected 1-line item already fits", () => {
    // viewport shows lines 0-2, selecting session(c) at visual line 2
    expect(scrollTarget(items1Line, 2, 0, 3, lineCountAlways)).toBeNull();
  });

  it("stops at a too-tall row's first line instead of its last", () => {
    // A row with a tall prompt block can outgrow a short sidebar pane. The
    // bottom-align target would scroll its identity line (index, status,
    // active marker) off the top, leaving an unidentifiable wall of prompt.
    const tall = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", lastPrompt: null })),
        toFiltered(mockSession({ id: "b", lastPrompt: "long" })),
      ],
      "none",
      new Set(),
      false,
    );
    // 12 lines each: session(b) spans visual lines 12-23 in a 5-line viewport.
    const lineCount = () => 12;
    // Bottom-aligning would give 23 - 5 + 1 = 19, four lines into the row.
    expect(scrollTarget(tall, 1, 0, 5, lineCount)).toBe(12);
  });
});

describe("buildFlatItems with pinnedGroups", () => {
  it("respects pinned order", () => {
    const sessions = [
      toFiltered(mockSession({ id: "a", project: "beta" })),
      toFiltered(mockSession({ id: "b", project: "alpha" })),
    ];
    const items = buildFlatItems(sessions, "project", new Set(), false, [
      "beta",
    ]);
    const headers = items.filter((i) => i.type === "header");
    expect(headers).toHaveLength(2);
    if (headers[0].type === "header" && headers[1].type === "header") {
      // beta pinned first, alpha unpinned second
      expect(headers[0].label).toBe("beta");
      expect(headers[1].label).toBe("alpha");
    }
  });

  it("sorts alphabetically regardless of session status", () => {
    const sessions = [
      toFiltered(mockSession({ id: "a", project: "alpha", status: "idle" })),
      toFiltered(mockSession({ id: "b", project: "beta", status: "waiting" })),
      toFiltered(
        mockSession({ id: "c", project: "charlie", status: "working" }),
      ),
    ];
    const items = buildFlatItems(sessions, "project", new Set(), false);
    const headers = items.filter((i) => i.type === "header");
    if (
      headers[0].type === "header" &&
      headers[1].type === "header" &&
      headers[2].type === "header"
    ) {
      // alphabetical regardless of status
      expect(headers[0].label).toBe("needs attention");
      expect(headers[1].label).toBe("alpha");
      expect(headers[2].label).toBe("charlie");
    }
  });

  it("sorts a waiting session with no timestamps as oldest", () => {
    const sessions = [
      toFiltered(
        mockSession({
          id: "dated-late",
          status: "waiting",
          statusChangedAt: "2024-01-15T13:00:00Z",
        }),
      ),
      toFiltered(
        mockSession({
          id: "undated",
          status: "waiting",
          statusChangedAt: null,
          lastActivityAt: null,
        }),
      ),
      toFiltered(
        mockSession({
          id: "dated-early",
          status: "waiting",
          statusChangedAt: "2024-01-15T12:00:00Z",
        }),
      ),
    ];
    const items = buildFlatItems(sessions, "none", new Set(), false);
    const ids = items
      .filter((item) => item.type === "session")
      .map((item) => item.filteredSession.session.id);
    expect(ids).toEqual(["undated", "dated-early", "dated-late"]);
  });
});

describe("buildFlatItems with the attention band off", () => {
  const sessions = () => [
    toFiltered(mockSession({ id: "a", project: "alpha", status: "idle" })),
    toFiltered(mockSession({ id: "b", project: "alpha", status: "waiting" })),
    toFiltered(mockSession({ id: "c", project: "beta", status: "waiting" })),
  ];

  it("keeps waiting rows in their own groups", () => {
    const items = buildFlatItems(
      sessions(),
      "project",
      new Set(),
      false,
      [],
      false,
    );
    expect(
      items.map((i) =>
        i.type === "header" ? `# ${i.label}` : i.filteredSession.session.id,
      ),
    ).toEqual(["# alpha", "a", "b", "# beta", "c"]);
    const alpha = items[0];
    if (alpha?.type === "header") expect(alpha.count).toBe(2);
  });

  it("leaves the flat list without synthetic headers", () => {
    const items = buildFlatItems(
      sessions(),
      "none",
      new Set(),
      false,
      [],
      false,
    );
    expect(items.every((i) => i.type === "session")).toBe(true);
    expect(
      items.map((i) =>
        i.type === "session" ? i.filteredSession.session.id : "",
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("hides a waiting row inside its collapsed group", () => {
    const items = buildFlatItems(
      sessions(),
      "project",
      new Set(["alpha"]),
      false,
      [],
      false,
    );
    expect(
      items.map((i) =>
        i.type === "header" ? `# ${i.label}` : i.filteredSession.session.id,
      ),
    ).toEqual(["# alpha", "# beta", "c"]);
  });
});

describe("buildFlatItems with waiting sessions the scope hides", () => {
  const label = (i: ReturnType<typeof buildFlatItems>[number]) =>
    i.type === "header"
      ? `# ${i.label} (${i.count}) +${i.hiddenWaiting ?? 0}`
      : i.filteredSession.session.id;

  it("draws the band for hidden sessions alone, and closes it in a flat list", () => {
    const rest = [toFiltered(mockSession({ id: "a", status: "idle" }))];
    expect(
      buildFlatItems(rest, "none", new Set(), false, [], true, 2).map(label),
    ).toEqual(["# needs attention (0) +2", "# sessions (1) +0", "a"]);
    expect(
      buildFlatItems(rest, "project", new Set(), false, [], true, 2).map(label),
    ).toEqual(["# needs attention (0) +2", "# my-project (1) +0", "a"]);
  });

  it("adds the count beside the band's own members", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "w", status: "waiting" }))],
      "none",
      new Set(),
      false,
      [],
      true,
      3,
    );
    expect(items.map(label)).toEqual(["# needs attention (1) +3", "w"]);
  });

  it("has no band to carry it when the band is off", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", status: "idle" }))],
      "none",
      new Set(),
      false,
      [],
      false,
      2,
    );
    expect(items.map(label)).toEqual(["a"]);
  });
});

describe("group aliases", () => {
  const headers = (items: ReturnType<typeof buildFlatItems>) =>
    items.filter(
      (i): i is Extract<(typeof items)[number], { type: "header" }> =>
        i.type === "header",
    );

  it("folds an aliased raw key into its alias", () => {
    const session = mockSession({ project: "px-api" });
    expect(
      groupKeyOf(session, "project", { project: { "px-api": "ProjectX" } }),
    ).toBe("ProjectX");
  });

  it("namespaces aliases by groupBy mode", () => {
    // The same string means a project in one mode and a tmux session in
    // another; an alias for one never reaches the other.
    const session = mockSession({ project: "dev", tmuxTarget: "dev:0.0" });
    const aliases = { project: { dev: "Development" } };
    expect(groupKeyOf(session, "project", aliases)).toBe("Development");
    expect(groupKeyOf(session, "session", aliases)).toBe("dev");
  });

  it("is one hop: an alias's value is never itself looked up", () => {
    const session = mockSession({ project: "a" });
    expect(
      groupKeyOf(session, "project", { project: { a: "b", b: "c" } }),
    ).toBe("b");
  });

  it("never reads an inherited property as an alias", () => {
    const session = mockSession({ project: "constructor" });
    expect(groupKeyOf(session, "project", { project: {} })).toBe("constructor");
  });

  it("renames paneless buckets like any other raw key", () => {
    const session = mockSession({ tmuxTarget: undefined, tmuxPane: undefined });
    expect(
      groupKeyOf(session, "session", { session: { "(no tmux)": "Loose" } }),
    ).toBe("Loose");
  });

  it("merges groups renamed to the same name, carrying every raw key", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a", project: "px-web" })),
      toFiltered(mockSession({ id: "b", project: "px-api" })),
      toFiltered(mockSession({ id: "c", project: "other" })),
      toFiltered(mockSession({ id: "d", project: "px-infra" })),
    ];
    const aliases = {
      project: {
        "px-api": "ProjectX",
        "px-infra": "ProjectX",
        "px-web": "ProjectX",
      },
    };
    const groups = groupSessions(filtered, "project", aliases);
    const merged = groups.find((g) => g.key === "ProjectX")!;
    expect(merged.members.map((m) => m.session.id)).toEqual(["a", "b", "d"]);
    expect(merged.rawKeys).toEqual(["px-api", "px-infra", "px-web"]);
    expect(groups.find((g) => g.key === "other")!.rawKeys).toEqual(["other"]);
  });

  it("merges into an existing raw group without an alias of its own", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a", project: "alpha" })),
      toFiltered(mockSession({ id: "b", project: "beta" })),
    ];
    const groups = groupSessions(filtered, "project", {
      project: { beta: "alpha" },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("alpha");
    expect(groups[0]!.rawKeys).toEqual(["alpha", "beta"]);
  });

  it("sorts groups by their displayed names", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a", project: "apple" })),
      toFiltered(mockSession({ id: "z", project: "zebra" })),
    ];
    const items = buildFlatItems(
      filtered,
      "project",
      new Set(),
      false,
      [],
      true,
      0,
      { project: { zebra: "Aardvark" } },
    );
    expect(headers(items).map((h) => h.label)).toEqual(["Aardvark", "apple"]);
  });

  it("puts rawKeys on headers and labels an aliased cwd key verbatim", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a", paneCwd: "/home/user/work/api" })),
      toFiltered(mockSession({ id: "b", paneCwd: "/home/user/work/web" })),
    ];
    const items = buildFlatItems(
      filtered,
      "cwd",
      new Set(),
      false,
      [],
      true,
      0,
      { cwd: { "/home/user/work/api": "API" } },
    );
    const api = headers(items).find((h) => h.groupKey === "API");
    const web = headers(items).find(
      (h) => h.groupKey === "/home/user/work/web",
    );
    expect(api!.label).toBe("API");
    expect(api!.rawKeys).toEqual(["/home/user/work/api"]);
    // An unaliased cwd key keeps the mode's formatting.
    expect(web!.rawKeys).toEqual(["/home/user/work/web"]);
    expect(web!.label).toBe(getGroupLabel("/home/user/work/web", "cwd"));
  });

  it("never home-shortens a typed name that looks like a path", () => {
    const typed = `${process.env.HOME}/named`;
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", paneCwd: "/srv/api" }))],
      "cwd",
      new Set(),
      false,
      [],
      true,
      0,
      { cwd: { "/srv/api": typed } },
    );
    expect(headers(items)[0]!.label).toBe(typed);
  });

  it("collapses and pins by the displayed name", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a", project: "px-api" })),
      toFiltered(mockSession({ id: "b", project: "px-web" })),
      toFiltered(mockSession({ id: "c", project: "aaa" })),
    ];
    const aliases = { project: { "px-api": "ProjectX", "px-web": "ProjectX" } };
    const items = buildFlatItems(
      filtered,
      "project",
      new Set(["ProjectX"]),
      false,
      ["ProjectX"],
      true,
      0,
      aliases,
    );
    expect(
      items.map((i) =>
        i.type === "header" ? i.label : i.filteredSession.session.id,
      ),
    ).toEqual(["ProjectX", "aaa", "c"]);
    expect(headers(items)[0]!.collapsed).toBe(true);
  });

  it("gives synthetic headers no rawKeys", () => {
    const filtered = [
      toFiltered(mockSession({ id: "w", project: "a", status: "waiting" })),
      toFiltered(mockSession({ id: "i", project: "a" })),
    ];
    const items = buildFlatItems(filtered, "project", new Set(), false);
    const band = headers(items).find((h) => h.groupKey === NEEDS_YOU_GROUP_KEY);
    expect(band?.rawKeys).toBeUndefined();
  });
});

describe("sanitizeGroupName", () => {
  it("trims the name", () => {
    expect(sanitizeGroupName("  ProjectX  ")).toBe("ProjectX");
  });

  it("strips C0, DEL and C1 control characters", () => {
    expect(sanitizeGroupName("Pro\0ject\x1b[31mX\x7f\x9b")).toBe(
      "Project[31mX",
    );
  });

  it("never yields a synthetic key", () => {
    expect(sanitizeGroupName("\0needs-you")).toBe("needs-you");
    expect(sanitizeGroupName("\0")).toBe("");
  });

  it("is empty for a blank or control-only name", () => {
    expect(sanitizeGroupName("   ")).toBe("");
    expect(sanitizeGroupName("\t\n")).toBe("");
  });

  it(`caps the name at ${GROUP_NAME_MAX_WIDTH} columns, not code units`, () => {
    expect(sanitizeGroupName("x".repeat(100))).toBe(
      "x".repeat(GROUP_NAME_MAX_WIDTH),
    );
    // A CJK glyph is two columns wide.
    const wide = sanitizeGroupName("漢".repeat(40));
    expect(wide).toBe("漢".repeat(GROUP_NAME_MAX_WIDTH / 2));
  });

  it("trims a space the cap leaves at the end", () => {
    expect(sanitizeGroupName(`${"x".repeat(63)} y`)).toBe("x".repeat(63));
  });
});

describe("normalizeGroupAliases", () => {
  it("keeps string-to-string entries for known modes", () => {
    expect(
      normalizeGroupAliases({
        project: { a: "A", b: 3, c: "" },
        bogus: { x: "y" },
        session: "nope",
        cwd: { "/x": "X", "/y": "/y" },
      }),
    ).toEqual({ project: { a: "A" }, cwd: { "/x": "X" } });
  });

  it("drops names that sanitize to something else or to nothing", () => {
    expect(
      normalizeGroupAliases({ project: { a: "\0needs-you", b: " B " } }),
    ).toEqual({
      project: { a: "needs-you", b: "B" },
    });
  });

  it("is empty for anything that is not an object", () => {
    expect(normalizeGroupAliases(undefined)).toEqual({});
    expect(normalizeGroupAliases(null)).toEqual({});
    expect(normalizeGroupAliases([])).toEqual({});
    expect(normalizeGroupAliases("x")).toEqual({});
  });

  it("keeps a raw key named __proto__ as data", () => {
    const parsed = JSON.parse('{"project":{"__proto__":"Weird"}}');
    const result = normalizeGroupAliases(parsed);
    expect(Object.hasOwn(result.project!, "__proto__")).toBe(true);
    expect(
      groupKeyOf(mockSession({ project: "__proto__" }), "project", result),
    ).toBe("Weird");
  });
});

describe("resolveGroupName", () => {
  const home = process.env.HOME ?? "/home/user";
  const groups = (...keys: string[]) =>
    groupSessions(
      keys.map((k, i) => toFiltered(mockSession({ id: `s${i}`, paneCwd: k }))),
      "cwd",
      {},
    );

  it("resolves a displayed label to the group's key", () => {
    const beta = `${home}/Code/beta`;
    expect(
      resolveGroupName(getGroupLabel(beta, "cwd"), groups(beta), "cwd"),
    ).toBe(beta);
  });

  it("matches a key past the width cap before cutting it", () => {
    const long = `/srv/${"nested-directory/".repeat(5)}beta`;
    expect(resolveGroupName(` ${long} `, groups(long), "cwd")).toBe(long);
    expect(resolveGroupName(long, groups(), "cwd")).toBe(
      sanitizeGroupName(long),
    );
  });

  it("prefers the group whose key is the name over one that only shows it", () => {
    // `/srv/x` was already named after beta's shortened label (what this
    // fix stops new renames from doing): the name's own group wins.
    const beta = `${home}/Code/beta`;
    const shown = getGroupLabel(beta, "cwd");
    const twins = groupSessions(
      [
        toFiltered(mockSession({ id: "a", paneCwd: beta })),
        toFiltered(mockSession({ id: "b", paneCwd: "/srv/x" })),
      ],
      "cwd",
      { cwd: { "/srv/x": shown } },
    );
    expect(resolveGroupName(shown, twins, "cwd")).toBe(shown);
  });

  it("is empty for a blank name", () => {
    expect(resolveGroupName("  \0 ", groups("/a"), "cwd")).toBe("");
  });
});

describe("normalizeGroupAliases width", () => {
  it("keeps a merge target past the name cap whole", () => {
    const long = `/srv/${"nested-directory/".repeat(5)}beta`;
    expect(normalizeGroupAliases({ cwd: { "/a": long } })).toEqual({
      cwd: { "/a": long },
    });
  });
});

describe("normalizeGroupLayouts", () => {
  it("keeps merge records for known modes, and their well-formed entries", () => {
    expect(
      normalizeGroupLayouts({
        project: {
          pins: ["a", "x", "b"],
          merged: {
            a: { collapsed: false },
            b: { collapsed: true },
            c: { collapsed: "yes" },
            d: "nope",
          },
        },
        // Nothing merged is left to record.
        cwd: { pins: ["a"], merged: { a: { pin: 0 } } },
        none: { pins: [], merged: { x: { collapsed: false } } },
        bogus: { pins: [], merged: { y: { collapsed: false } } },
      }),
    ).toEqual({
      project: {
        pins: ["a", "x", "b"],
        merged: { a: { collapsed: false }, b: { collapsed: true } },
      },
    });
  });

  it("drops a mode whose pins are not a list of keys", () => {
    const merged = { a: { collapsed: false } };
    expect(
      normalizeGroupLayouts({
        project: { pins: ["a", 7], merged },
        session: { pins: "a", merged },
        window: { merged },
      }),
    ).toEqual({});
  });

  it("drops the per-key maps earlier builds wrote", () => {
    // An index alone, then neighbours by name, then by raw keys: none says
    // where a pin goes, so the merge resets as an unrecorded one.
    expect(
      normalizeGroupLayouts({
        project: { a: { pin: 0, collapsed: false } },
        cwd: { s: { pin: 0, collapsed: false, order: ["s", "N", "t"] } },
        session: {
          b: { pin: 1, collapsed: true, order: [["x"], ["b"], ["y", "z"]] },
        },
      }),
    ).toEqual({});
  });

  it("keeps a key spelled __proto__ as data", () => {
    const { project } = normalizeGroupLayouts(
      JSON.parse(
        '{"project":{"pins":["__proto__"],"merged":{"__proto__":{"collapsed":true}}}}',
      ),
    );
    expect(Object.hasOwn(project!.merged, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(project!.merged)).toBe(Object.prototype);
    expect(project!.pins).toEqual(["__proto__"]);
  });

  it("is empty for anything that is not an object", () => {
    expect(normalizeGroupLayouts(undefined)).toEqual({});
    expect(normalizeGroupLayouts([])).toEqual({});
  });
});
