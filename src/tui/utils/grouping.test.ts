import { describe, it, expect } from "bun:test";
import {
  getGroupKey,
  getGroupLabel,
  computeStatusSummary,
  buildFlatItems,
  getSessionIndex,
  toVisualLine,
  itemVisualHeight,
  scrollTarget,
  sortGroups,
  groupSessions,
  headerGroupKeys,
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

describe("getGroupKey", () => {
  it("groups by project name", () => {
    const session = mockSession({ project: "my-app" });
    expect(getGroupKey(session, "project")).toBe("my-app");
  });

  it("falls back to cwd for project grouping when project is empty", () => {
    const session = mockSession({ project: "", cwd: "/some/path" });
    expect(getGroupKey(session, "project")).toBe("/some/path");
  });

  it("groups by cwd using paneCwd", () => {
    const session = mockSession({
      cwd: "/original",
      paneCwd: "/current/path",
    });
    expect(getGroupKey(session, "cwd")).toBe("/current/path");
  });

  it("falls back to cwd when paneCwd is null", () => {
    const session = mockSession({ cwd: "/original", paneCwd: null });
    expect(getGroupKey(session, "cwd")).toBe("/original");
  });

  it("groups by tmux session name", () => {
    const session = mockSession({ tmuxTarget: "my-session:2.0" });
    expect(getGroupKey(session, "session")).toBe("my-session");
  });

  it("groups by tmux window", () => {
    const session = mockSession({ tmuxTarget: "my-session:2.0" });
    expect(getGroupKey(session, "window")).toBe("my-session:2");
  });

  it("handles missing tmuxTarget for session", () => {
    const session = mockSession({ tmuxTarget: null });
    expect(getGroupKey(session, "session")).toBe("(no tmux)");
  });

  it("handles missing tmuxTarget for window", () => {
    const session = mockSession({ tmuxTarget: null });
    expect(getGroupKey(session, "window")).toBe("(no tmux)");
  });

  it("returns empty string for none", () => {
    const session = mockSession();
    expect(getGroupKey(session, "none")).toBe("");
  });

  it("groups background (paneless) sessions under (background) for session/window", () => {
    const session = mockSession({
      trackingMode: "background",
      tmuxPane: null,
      tmuxTarget: null,
    });
    expect(getGroupKey(session, "session")).toBe("(background)");
    expect(getGroupKey(session, "window")).toBe("(background)");
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
    expect(getGroupKey(session, "project")).toBe("repos");
    expect(getGroupKey(session, "cwd")).toBe("/home/user/repos");
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
    const groups = groupSessions(filtered, "project");
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
    const groups = groupSessions(filtered, "project");
    const alpha = groups.find((g) => g.key === "alpha")!;
    expect(alpha.members[0].session.id).toBe("a1");
    expect(alpha.members[1].session.id).toBe("a2");
  });

  it("returns empty array for empty input", () => {
    expect(groupSessions([], "project")).toEqual([]);
  });

  it("groups by session", () => {
    const filtered = [
      toFiltered(mockSession({ id: "a", tmuxTarget: "dev:0.0" })),
      toFiltered(mockSession({ id: "b", tmuxTarget: "dev:1.0" })),
      toFiltered(mockSession({ id: "c", tmuxTarget: "work:0.0" })),
    ];
    const groups = groupSessions(filtered, "session");
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.key === "dev")?.members).toHaveLength(2);
    expect(groups.find((g) => g.key === "work")?.members).toHaveLength(1);
  });
});

describe("headerGroupKeys", () => {
  it("extracts group keys from header items", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", project: "alpha" })),
        toFiltered(mockSession({ id: "b", project: "beta" })),
      ],
      "project",
      new Set(),
      false,
    );
    expect(headerGroupKeys(items)).toEqual(["alpha", "beta"]);
  });

  it("returns empty array when no headers (groupBy none)", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a" }))],
      "none",
      new Set(),
      false,
    );
    expect(headerGroupKeys(items)).toEqual([]);
  });

  it("skips session items", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", project: "alpha" })),
        toFiltered(mockSession({ id: "b", project: "alpha" })),
        toFiltered(mockSession({ id: "c", project: "alpha" })),
      ],
      "project",
      new Set(),
      false,
    );
    // 1 header + 3 sessions = 4 items, but only 1 group key
    expect(items).toHaveLength(4);
    expect(headerGroupKeys(items)).toEqual(["alpha"]);
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

  it("counts first header as 1 line, subsequent headers as 2", () => {
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
    // visual: 0(header), 1-2(a), 3-4(b), 5-6(header beta), 7-8(c)
    expect(toVisualLine(items, 0)).toBe(0); // header(alpha) - first header, no divider
    expect(toVisualLine(items, 1)).toBe(1); // session(a) - 2 lines
    expect(toVisualLine(items, 2)).toBe(3); // session(b) - 2 lines
    expect(toVisualLine(items, 3)).toBe(5); // header(beta) - has divider above
    expect(toVisualLine(items, 4)).toBe(7); // session(c) - after 2-line header
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
    // visual: 0(header), 1-2(header beta), 3-4(c)
    expect(toVisualLine(items, 0)).toBe(0); // header(alpha)
    expect(toVisualLine(items, 1)).toBe(1); // header(beta) - has divider
    expect(toVisualLine(items, 2)).toBe(3); // session(c) - 2 lines
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
    // visual: 0(header), 1-2(a), 3-4(header beta), 5-6(b), 7-8(header charlie), 9-10(c)
    expect(toVisualLine(items, 0)).toBe(0); // header(alpha)
    expect(toVisualLine(items, 1)).toBe(1); // session(a) - 2 lines
    expect(toVisualLine(items, 2)).toBe(3); // header(beta)
    expect(toVisualLine(items, 3)).toBe(5); // session(b) - 2 lines
    expect(toVisualLine(items, 4)).toBe(7); // header(charlie)
    expect(toVisualLine(items, 5)).toBe(9); // session(c) - 2 lines
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

  it("returns 1 for first header (no divider)", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", project: "alpha" }))],
      "project",
      new Set(),
      false,
    );
    expect(itemVisualHeight(items, 0)).toBe(1);
  });

  it("returns 2 for non-first headers (divider + header)", () => {
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
    expect(itemVisualHeight(items, 2)).toBe(2); // second header
  });
});

describe("scrollTarget", () => {
  // Two groups: [header(alpha), session(a), session(b), header(beta), session(c)]
  // Visual lines (sessions=2 lines each):
  //   0: header(alpha) [1 line]
  //   1-2: session(a) [2 lines]
  //   3-4: session(b) [2 lines]
  //   5-6: header(beta) [2 lines: divider + header]
  //   7-8: session(c) [2 lines]
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
    // viewport shows lines 0-2, selecting session(c) at visual line 7
    // lastLine = 7 + 2 - 1 = 8, scrollTop = 8 - 3 + 1 = 6
    expect(scrollTarget(items, 4, 0, 3)).toBe(6);
  });

  it("scrolls down to show full header including divider", () => {
    // viewport shows lines 0-5, selecting header(beta) at visual line 5
    // header(beta) has divider at line 5 and header at line 6 (lastLine = 6)
    // scrollTop = 6 - 6 + 1 = 1
    expect(scrollTarget(items, 3, 0, 6)).toBe(1);
  });

  it("does not scroll when full header fits in viewport", () => {
    // viewport shows lines 0-8, selecting header(beta)
    // divider at 5, header at 6, both visible in viewport of height 9
    expect(scrollTarget(items, 3, 0, 9)).toBeNull();
  });
});

describe("itemVisualHeight with hasSubtitle", () => {
  it("returns 2 when hasSubtitle is undefined (backward compat)", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", lastPrompt: null }))],
      "none",
      new Set(),
      false,
    );
    expect(itemVisualHeight(items, 0)).toBe(2);
  });

  it("returns 1 when hasSubtitle returns false", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", lastPrompt: null }))],
      "none",
      new Set(),
      false,
    );
    expect(itemVisualHeight(items, 0, () => false)).toBe(1);
  });

  it("returns 2 when hasSubtitle returns true", () => {
    const items = buildFlatItems(
      [toFiltered(mockSession({ id: "a", lastPrompt: "hello" }))],
      "none",
      new Set(),
      false,
    );
    expect(itemVisualHeight(items, 0, () => true)).toBe(2);
  });

  it("varies height per session based on predicate", () => {
    const items = buildFlatItems(
      [
        toFiltered(mockSession({ id: "a", lastPrompt: "work" })),
        toFiltered(mockSession({ id: "b", lastPrompt: null })),
      ],
      "none",
      new Set(),
      false,
    );
    const hasSubtitle = (s: EnrichedSession) => !!s.lastPrompt;
    expect(itemVisualHeight(items, 0, hasSubtitle)).toBe(2);
    expect(itemVisualHeight(items, 1, hasSubtitle)).toBe(1);
  });

  it("ignores hasSubtitle for header items", () => {
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
    expect(itemVisualHeight(items, 0, () => false)).toBe(1); // first header
    expect(itemVisualHeight(items, 2, () => false)).toBe(2); // second header
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
    const hasSubtitle = () => false;
    expect(toVisualLine(items, 0, hasSubtitle)).toBe(0);
    expect(toVisualLine(items, 1, hasSubtitle)).toBe(1);
    expect(toVisualLine(items, 2, hasSubtitle)).toBe(2);
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
    const hasSubtitle = (s: EnrichedSession) => !!s.lastPrompt;
    // visual: 0-1(a=2), 2(b=1), 3-4(c=2)
    expect(toVisualLine(items, 0, hasSubtitle)).toBe(0);
    expect(toVisualLine(items, 1, hasSubtitle)).toBe(2);
    expect(toVisualLine(items, 2, hasSubtitle)).toBe(3);
  });

  it("accounts for header divider lines with 1-line sessions", () => {
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
    // visual: 0(header), 1(a=1), 2-3(header beta), 4(b=1)
    const hasSubtitle = () => false;
    expect(toVisualLine(items, 0, hasSubtitle)).toBe(0);
    expect(toVisualLine(items, 1, hasSubtitle)).toBe(1);
    expect(toVisualLine(items, 2, hasSubtitle)).toBe(2);
    expect(toVisualLine(items, 3, hasSubtitle)).toBe(4);
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
  const hasSubtitleAlways = () => false;

  it("fits more 1-line items in the same viewport", () => {
    // viewport of height 3 fits all 3 one-line sessions
    expect(scrollTarget(items1Line, 2, 0, 3, hasSubtitleAlways)).toBeNull();
  });

  it("scrolls by 1 line when next 1-line item is just below viewport", () => {
    // viewport shows line 0 only, selecting session(b) at visual line 1
    // lastLine = 1, scrollTop = 1 - 1 + 1 = 1
    expect(scrollTarget(items1Line, 1, 0, 1, hasSubtitleAlways)).toBe(1);
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
    const hasSubtitle = (s: EnrichedSession) => !!s.lastPrompt;
    // viewport shows line 0 only, selecting session(b) at visual line 2
    // lastLine = 2, scrollTop = 2 - 1 + 1 = 2
    expect(scrollTarget(items, 1, 0, 1, hasSubtitle)).toBe(2);
  });

  it("returns null when selected 1-line item already fits", () => {
    // viewport shows lines 0-2, selecting session(c) at visual line 2
    expect(scrollTarget(items1Line, 2, 0, 3, hasSubtitleAlways)).toBeNull();
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
      expect(headers[0].label).toBe("alpha");
      expect(headers[1].label).toBe("beta");
      expect(headers[2].label).toBe("charlie");
    }
  });
});
