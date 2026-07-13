import { describe, expect, it } from "bun:test";
import {
  resolveColumns,
  resolveSidebarColumns,
  resolveResponsive,
  resolveEntry,
  resolveRowSide,
  hasFieldData,
  entryRightWidth,
  stripPrompt,
  applyPromptDisplay,
  sessionPRs,
  prLabel,
  prColorState,
  rowHasContent,
  rowHasPrompt,
  SIDEBAR_DEFAULT_COLUMNS,
  trailingLabelsWidth,
  fitProjectCell,
  getAttentionLabel,
  subagentCountLabel,
  ATTENTION_LABEL_MAX,
} from "./session-columns";
import type { SubagentState } from "../../types";
import { DEFAULT_BREAKPOINTS, type Responsive } from "../../lib/preferences";
import { mockEnrichedSession } from "./test-helpers";

describe("resolveResponsive", () => {
  const bp = DEFAULT_BREAKPOINTS;

  it("returns simple value directly", () => {
    expect(resolveResponsive<string>("full", 50, bp, "icon")).toBe("full");
    expect(resolveResponsive<boolean>(false, 120, bp, true)).toBe(false);
  });

  it("returns arrays as leaf values (not responsive descriptors)", () => {
    const arr: Responsive<string[]> = ["a", "b"];
    expect(resolveResponsive<string[]>(arr, 100, bp, [])).toEqual(["a", "b"]);
  });

  it("treats objects with non-responsive keys as leaf values", () => {
    const obj = { field: "status", mode: "icon" } as unknown as Responsive<{
      field: string;
      mode: string;
    }>;
    const result = resolveResponsive(obj, 100, bp, {
      field: "x",
      mode: "y",
    });
    expect(result).toEqual({ field: "status", mode: "icon" });
  });

  it("uses implicit default below smallest breakpoint", () => {
    expect(resolveResponsive<string>({ sm: "full" }, 30, bp, "icon")).toBe(
      "icon",
    );
  });

  it("resolves xs breakpoint", () => {
    const value: Responsive<string> = { xs: "short", md: "full" };
    expect(resolveResponsive<string>(value, 30, bp, "icon")).toBe("icon");
    expect(resolveResponsive<string>(value, 40, bp, "icon")).toBe("short");
    expect(resolveResponsive<string>(value, 80, bp, "icon")).toBe("full");
  });

  it("uses default key when present", () => {
    const value: Responsive<string> = { default: "short", lg: "full" };
    expect(resolveResponsive<string>(value, 40, bp, "x")).toBe("short");
  });

  it("cascades mobile-first through all breakpoints", () => {
    const value: Responsive<string> = {
      xs: "short",
      sm: "short",
      lg: "full",
    };
    expect(resolveResponsive<string>(value, 30, bp, "x")).toBe("x");
    expect(resolveResponsive<string>(value, 40, bp, "x")).toBe("short");
    expect(resolveResponsive<string>(value, 80, bp, "x")).toBe("short");
    expect(resolveResponsive<string>(value, 100, bp, "x")).toBe("full");
  });

  it("default key is overridden by matching breakpoint", () => {
    const value: Responsive<string> = { default: "short", md: "full" };
    expect(resolveResponsive<string>(value, 50, bp, "x")).toBe("short");
    expect(resolveResponsive<string>(value, 80, bp, "x")).toBe("full");
  });

  it("handles empty responsive object using implicit default", () => {
    expect(resolveResponsive<boolean>({}, 100, bp, true)).toBe(true);
  });
});

describe("resolveEntry", () => {
  const bp = DEFAULT_BREAKPOINTS;

  it("parses shorthand string with no mode", () => {
    expect(resolveEntry("project", 100, bp)).toEqual({
      field: "project",
      mode: "dirname",
    });
  });

  it("parses shorthand with explicit mode", () => {
    expect(resolveEntry("status:full", 100, bp)).toEqual({
      field: "status",
      mode: "full",
    });
  });

  it("returns null for unknown field", () => {
    expect(resolveEntry("unknown", 100, bp)).toBeNull();
    expect(resolveEntry("nope:full", 100, bp)).toBeNull();
  });

  it("uses object form with literal mode", () => {
    expect(resolveEntry({ field: "agent", mode: "short" }, 100, bp)).toEqual({
      field: "agent",
      mode: "short",
    });
  });

  it("uses object form with responsive mode", () => {
    const entry = {
      field: "status" as const,
      mode: { default: "icon", md: "full" },
    };
    expect(resolveEntry(entry, 50, bp)).toEqual({
      field: "status",
      mode: "icon",
    });
    expect(resolveEntry(entry, 100, bp)).toEqual({
      field: "status",
      mode: "full",
    });
  });

  it("falls back to per-field default mode when no mode specified", () => {
    expect(resolveEntry("status", 100, bp)?.mode).toBe("icon");
    expect(resolveEntry("project", 100, bp)?.mode).toBe("dirname");
    expect(resolveEntry("agent", 100, bp)?.mode).toBe("full");
    expect(resolveEntry("pane", 100, bp)?.mode).toBeUndefined();
  });
});

describe("resolveRowSide", () => {
  const bp = DEFAULT_BREAKPOINTS;

  it("returns empty array when undefined", () => {
    expect(resolveRowSide(undefined, 100, bp)).toEqual([]);
  });

  it("returns resolved entries for a literal array", () => {
    const entries = resolveRowSide(["index", "status:full"], 100, bp);
    expect(entries).toEqual([
      { field: "index", mode: undefined },
      { field: "status", mode: "full" },
    ]);
  });

  it("filters out invalid entries", () => {
    const entries = resolveRowSide(["index", "bogus", "pane"], 100, bp);
    expect(entries).toEqual([
      { field: "index", mode: undefined },
      { field: "pane", mode: undefined },
    ]);
  });

  it("resolves responsive arrays", () => {
    const side = {
      default: ["pane"],
      md: ["agent:full", "pane", "time"],
    };
    expect(resolveRowSide(side, 50, bp)).toEqual([
      { field: "pane", mode: undefined },
    ]);
    expect(resolveRowSide(side, 100, bp)).toEqual([
      { field: "agent", mode: "full" },
      { field: "pane", mode: undefined },
      { field: "time", mode: undefined },
    ]);
  });
});

describe("resolveColumns defaults", () => {
  it("at wide width includes agent/version/pane/time on right", () => {
    const cols = resolveColumns(120);
    const fields = cols.row1.right.map((e) => e.field);
    expect(fields).toContain("agent");
    expect(fields).toContain("version");
    expect(fields).toContain("pane");
    expect(fields).toContain("time");
  });

  it("at narrow width drops most right-side columns", () => {
    const cols = resolveColumns(40);
    const fields = cols.row1.right.map((e) => e.field);
    expect(fields).toContain("pane");
    expect(fields).not.toContain("version");
  });

  it("status mode cascades from icon to short to full", () => {
    expect(
      resolveColumns(40).row1.left.find((e) => e.field === "status")?.mode,
    ).toBe("icon");
    expect(
      resolveColumns(60).row1.left.find((e) => e.field === "status")?.mode,
    ).toBe("short");
    expect(
      resolveColumns(100).row1.left.find((e) => e.field === "status")?.mode,
    ).toBe("full");
  });

  it("project mode shifts to full at md", () => {
    expect(
      resolveColumns(60).row1.left.find((e) => e.field === "project")?.mode,
    ).toBe("dirname");
    expect(
      resolveColumns(100).row1.left.find((e) => e.field === "project")?.mode,
    ).toBe("full");
  });

  it("user override replaces row 1 right at all widths", () => {
    const cols = resolveColumns(120, {
      row1: { right: ["pane"] },
    });
    expect(cols.row1.right.map((e) => e.field)).toEqual(["pane"]);
  });

  it("user override keeps row 2 default when only row 1 is overridden", () => {
    const cols = resolveColumns(120, {
      row1: { right: [] },
    });
    // Default row2 carries the last-prompt subtitle with `pr` (branch PRs /
    // background children) pinned right; see DEFAULT_COLUMNS.
    expect(cols.row2.left.map((e) => e.field)).toEqual(["prompt"]);
    expect(cols.row2.right.map((e) => e.field)).toEqual(["pr"]);
  });

  it("includes the prompt subtitle on row 2 at every width", () => {
    for (const width of [40, 60, 80, 120, 200]) {
      const fields = resolveColumns(width).row2.left.map((e) => e.field);
      expect(fields).toContain("prompt");
    }
  });

  it("custom breakpoints shift thresholds", () => {
    // Move md down to 60 so a width=60 viewport gets md-tier defaults
    const cols = resolveColumns(60, undefined, { md: 60 });
    expect(cols.row1.left.find((e) => e.field === "status")?.mode).toBe("full");
  });
});

describe("resolveSidebarColumns", () => {
  it("uses sidebar defaults when no user override", () => {
    const cols = resolveSidebarColumns(40);
    expect(cols.row1.left.map((e) => e.field)).toEqual(["status", "project"]);
    expect(cols.row1.right.map((e) => e.field)).toEqual(["pr", "agent"]);
    expect(cols.row1.right[0]?.mode).toBe("short");
    expect(cols.row1.right[1]?.mode).toBe("short");
    expect(cols.row2.left.map((e) => e.field)).toEqual(["prompt"]);
    expect(cols.row2.right.map((e) => e.field)).toEqual(["time"]);
  });

  it("user can override row2 to add a right side", () => {
    const cols = resolveSidebarColumns(40, {
      row2: { left: ["pane"], right: ["time"] },
    });
    expect(cols.row2.left.map((e) => e.field)).toEqual(["pane"]);
    expect(cols.row2.right.map((e) => e.field)).toEqual(["time"]);
  });
});

describe("hasFieldData", () => {
  it("returns true for fields that always render (status, index)", () => {
    const session = mockEnrichedSession();
    expect(hasFieldData(session, "status")).toBe(true);
    expect(hasFieldData(session, "index")).toBe(true);
  });

  it("returns false for prompt when missing", () => {
    expect(hasFieldData(mockEnrichedSession(), "prompt")).toBe(false);
    expect(
      hasFieldData(mockEnrichedSession({ lastPrompt: "hi" }), "prompt"),
    ).toBe(true);
  });

  it("returns false for prompt that normalizes to empty", () => {
    // The subtitle renders the normalized prompt; a value that reduces to
    // "" must not earn row 2 a line it would render blank.
    expect(
      hasFieldData(mockEnrichedSession({ lastPrompt: "   " }), "prompt"),
    ).toBe(false);
    expect(
      hasFieldData(
        mockEnrichedSession({
          lastPrompt: "<local-command-stdout></local-command-stdout>",
        }),
        "prompt",
      ),
    ).toBe(false);
    // Markup with real inner text still counts.
    expect(
      hasFieldData(
        mockEnrichedSession({
          lastPrompt: "<command-name>/clear</command-name>",
        }),
        "prompt",
      ),
    ).toBe(true);
  });

  it("returns false for branch when missing", () => {
    expect(hasFieldData(mockEnrichedSession(), "branch")).toBe(false);
    expect(
      hasFieldData(mockEnrichedSession({ gitBranch: "main" }), "branch"),
    ).toBe(true);
  });

  it("returns false for pane when no tmuxTarget", () => {
    expect(hasFieldData(mockEnrichedSession(), "pane")).toBe(false);
    expect(
      hasFieldData(mockEnrichedSession({ tmuxTarget: "sess:1" }), "pane"),
    ).toBe(true);
  });

  it("returns true for pr only when backgroundChildren has entries", () => {
    expect(hasFieldData(mockEnrichedSession(), "pr")).toBe(false);
    expect(
      hasFieldData(
        mockEnrichedSession({
          backgroundChildren: [
            { id: "10", href: "https://example/pull/10", kind: "pr" },
          ],
        }),
        "pr",
      ),
    ).toBe(true);
  });

  it("returns true for agent when agentType is set", () => {
    expect(hasFieldData(mockEnrichedSession(), "agent")).toBe(true);
    expect(
      hasFieldData(mockEnrichedSession({ agentType: "codex" }), "agent"),
    ).toBe(true);
  });

  it("returns false for version when missing", () => {
    expect(hasFieldData(mockEnrichedSession(), "version")).toBe(false);
    expect(
      hasFieldData(mockEnrichedSession({ version: "1.2.3" }), "version"),
    ).toBe(true);
  });

  it("returns false for time when no activity timestamps", () => {
    expect(hasFieldData(mockEnrichedSession(), "time")).toBe(false);
    expect(
      hasFieldData(
        mockEnrichedSession({ lastActivityAt: "2024-01-15T12:00:00Z" }),
        "time",
      ),
    ).toBe(true);
    expect(
      hasFieldData(
        mockEnrichedSession({ lastUserInputAt: "2024-01-15T12:00:00Z" }),
        "time",
      ),
    ).toBe(true);
  });

  it("returns true for cwd when either cwd or paneCwd is set", () => {
    expect(hasFieldData(mockEnrichedSession(), "cwd")).toBe(true);
    expect(hasFieldData(mockEnrichedSession({ paneCwd: "/a/b" }), "cwd")).toBe(
      true,
    );
  });
});

describe("entryRightWidth", () => {
  it("returns 1 for index and status icon", () => {
    expect(entryRightWidth({ field: "index" })).toBe(1);
    expect(entryRightWidth({ field: "status", mode: "icon" })).toBe(1);
  });

  it("returns 6 for status short, 9 for status full", () => {
    expect(entryRightWidth({ field: "status", mode: "short" })).toBe(6);
    expect(entryRightWidth({ field: "status", mode: "full" })).toBe(9);
  });

  it("returns 2 for agent short, 8 for agent full or missing mode", () => {
    expect(entryRightWidth({ field: "agent", mode: "short" })).toBe(2);
    expect(entryRightWidth({ field: "agent", mode: "full" })).toBe(8);
    expect(entryRightWidth({ field: "agent" })).toBe(8);
  });

  it("returns fixed widths for version, pane, time", () => {
    expect(entryRightWidth({ field: "version" })).toBe(10);
    expect(entryRightWidth({ field: "pane" })).toBe(12);
    expect(entryRightWidth({ field: "time" })).toBe(4);
  });

  it("returns 0 for intrinsic-width text fields", () => {
    expect(entryRightWidth({ field: "prompt" })).toBe(0);
    expect(entryRightWidth({ field: "cwd" })).toBe(0);
    expect(entryRightWidth({ field: "branch" })).toBe(0);
    expect(entryRightWidth({ field: "project", mode: "full" })).toBe(0);
  });
});

describe("resolveColumns row2 right side (subtitle split)", () => {
  it("resolves row2 right entries when user provides them", () => {
    const cols = resolveColumns(120, {
      row2: { left: ["prompt"], right: ["time"] },
    });
    expect(cols.row2.left.map((e) => e.field)).toEqual(["prompt"]);
    expect(cols.row2.right.map((e) => e.field)).toEqual(["time"]);
  });

  it("row2 defaults to prompt on the left, pr on the right", () => {
    const cols = resolveColumns(120);
    expect(cols.row2.left.map((e) => e.field)).toEqual(["prompt"]);
    expect(cols.row2.right.map((e) => e.field)).toEqual(["pr"]);
  });

  it("row2 right can hold multiple entries", () => {
    const cols = resolveColumns(120, {
      row2: { left: ["cwd"], right: ["branch", "time"] },
    });
    expect(cols.row2.right.map((e) => e.field)).toEqual(["branch", "time"]);
  });

  it("row2 right resolves responsive entries", () => {
    const cols40 = resolveColumns(40, {
      row2: {
        left: ["prompt"],
        right: { default: [], md: ["time"] },
      },
    });
    const cols100 = resolveColumns(100, {
      row2: {
        left: ["prompt"],
        right: { default: [], md: ["time"] },
      },
    });
    expect(cols40.row2.right).toEqual([]);
    expect(cols100.row2.right.map((e) => e.field)).toEqual(["time"]);
  });
});

describe("sessionPRs", () => {
  const pr25 = { id: "25", href: "https://github.com/x/y/pull/25" };
  const child42 = {
    kind: "pr",
    id: "42",
    href: "https://github.com/x/y/pull/42",
  };

  it("returns branch-derived PRs when no background children exist", () => {
    const session = mockEnrichedSession({ branchPRs: [pr25] });
    expect(sessionPRs(session)).toEqual([pr25]);
    expect(hasFieldData(session, "pr")).toBe(true);
  });

  it("prefers background children of kind pr", () => {
    const session = mockEnrichedSession({
      backgroundChildren: [child42],
      branchPRs: [pr25],
    });
    expect(sessionPRs(session)).toEqual([child42]);
  });

  it("falls back to branchPRs when children have no pr entries", () => {
    const session = mockEnrichedSession({
      backgroundChildren: [{ kind: "issue", id: "9", href: "x" }],
      branchPRs: [pr25],
    });
    expect(sessionPRs(session)).toEqual([pr25]);
  });

  it("reports no field data when both sources are empty", () => {
    const session = mockEnrichedSession({ branchPRs: null });
    expect(sessionPRs(session)).toEqual([]);
    expect(hasFieldData(session, "pr")).toBe(false);
  });

  it("labels PRs with a single PR prefix", () => {
    expect(prLabel(mockEnrichedSession({ branchPRs: [pr25] }))).toBe("PR #25");
    expect(
      prLabel(
        mockEnrichedSession({
          branchPRs: [pr25, { id: "26", href: "https://x/pull/26" }],
        }),
      ),
    ).toBe("PR #25 #26");
    expect(prLabel(mockEnrichedSession({ branchPRs: [] }))).toBe("");
  });

  it("drops the PR prefix in short mode", () => {
    expect(prLabel(mockEnrichedSession({ branchPRs: [pr25] }), "short")).toBe(
      "#25",
    );
    expect(
      prLabel(
        mockEnrichedSession({
          branchPRs: [pr25, { id: "26", href: "https://x/pull/26" }],
        }),
        "short",
      ),
    ).toBe("#25 #26");
    expect(prLabel(mockEnrichedSession({ branchPRs: [] }), "short")).toBe("");
  });
});

describe("stripPrompt", () => {
  it("drops row 2 wholesale, pr cell included", () => {
    const cols = stripPrompt(resolveColumns(120));
    expect(cols.row2.left).toEqual([]);
    expect(cols.row2.right).toEqual([]);
  });

  it("removes a prompt placed on row 1 by a user override", () => {
    const cols = stripPrompt(
      resolveColumns(120, {
        row1: { left: ["index", "status", "project", "prompt"] },
        row2: { left: ["prompt"], right: ["prompt"] },
      }),
    );
    expect(cols.row1.left.map((e) => e.field)).toEqual([
      "index",
      "status",
      "project",
    ]);
    expect(cols.row2.left).toEqual([]);
    expect(cols.row2.right).toEqual([]);
  });

  it("keeps row 1 but drops row 2 for layouts without a prompt field", () => {
    const resolved = resolveSidebarColumns(40, {
      row2: { left: ["pane"], right: ["time"] },
    });
    const stripped = stripPrompt(resolved);
    expect(stripped.row1).toEqual(resolved.row1);
    expect(stripped.row2).toEqual({ left: [], right: [] });
  });

  it("keeps the sidebar's row-1 pr cell when stripping the prompt", () => {
    const stripped = stripPrompt(resolveSidebarColumns(40));
    expect(stripped.row1.right.map((e) => e.field)).toEqual(["pr", "agent"]);
    expect(stripped.row2).toEqual({ left: [], right: [] });
  });
});

describe("applyPromptDisplay", () => {
  it("inline flattens row 2 onto row 1 in the picker", () => {
    const cols = applyPromptDisplay(resolveColumns(120), "inline", false);
    expect(cols.row1.left.map((e) => e.field)).toContain("prompt");
    // pr tucks onto row 1 next to the branch, not the far-right metadata.
    expect(cols.row1.left.map((e) => e.field)).toContain("pr");
    expect(cols.row1.right.map((e) => e.field)).not.toContain("pr");
    expect(cols.row2.left).toEqual([]);
    expect(cols.row2.right).toEqual([]);
  });

  it("inline puts pr right after project and the prompt last on row 1 left", () => {
    const cols = applyPromptDisplay(resolveColumns(120), "inline", false);
    const left = cols.row1.left.map((e) => e.field);
    expect(left).toEqual(["index", "status", "project", "pr", "prompt"]);
  });

  it("inline forces pr to short (no `PR ` prefix) even at wide widths", () => {
    // At 120 (>= lg) the row2 pr default resolves to `full`; inline collapse
    // must still drop the prefix so the bare `#id` rides next to the branch.
    const cols = applyPromptDisplay(resolveColumns(120), "inline", false);
    const pr = cols.row1.left.find((e) => e.field === "pr");
    expect(pr?.mode).toBe("short");
  });

  it("row2 keeps the responsive pr prefix: short below lg, full at lg+", () => {
    expect(
      resolveColumns(80).row2.right.find((e) => e.field === "pr")?.mode,
    ).toBe("short");
    expect(
      resolveColumns(120).row2.right.find((e) => e.field === "pr")?.mode,
    ).toBe("full");
  });

  it("inline falls back to the two-row layout in the sidebar", () => {
    const resolved = resolveSidebarColumns(40);
    const cols = applyPromptDisplay(resolved, "inline", true);
    // No room to inline on a 30-col rail: prompt stays on row 2.
    expect(cols.row2.left.map((e) => e.field)).toContain("prompt");
    expect(cols).toEqual(resolved);
  });

  it("row2 leaves the resolved layout untouched", () => {
    const resolved = resolveColumns(120);
    expect(applyPromptDisplay(resolved, "row2", false)).toEqual(resolved);
  });

  it("off strips the prompt and drops row 2", () => {
    const cols = applyPromptDisplay(resolveColumns(120), "off", false);
    expect(cols.row1.left.map((e) => e.field)).not.toContain("prompt");
    expect(cols.row2).toEqual({ left: [], right: [] });
  });

  it("inline does not duplicate a prompt already on row 1 (custom config)", () => {
    // User puts prompt on row 1 but leaves the default row2 prompt in place.
    const resolved = resolveColumns(120, {
      row1: { left: ["index", "status", "project", "prompt"] },
    });
    const cols = applyPromptDisplay(resolved, "inline", false);
    const prompts = cols.row1.left.filter((e) => e.field === "prompt");
    expect(prompts).toHaveLength(1);
    expect(cols.row2).toEqual({ left: [], right: [] });
  });

  it("inline appends pr then prompt when row 1 has no project cell", () => {
    // Custom row 1 without `project`: flattenToRow1's projectIdx === -1 branch
    // appends the row-2 metadata (pr) and then the prompt to the end of the
    // left side, rather than inserting them after a project anchor.
    const resolved = resolveColumns(120, {
      row1: { left: ["index", "status"] },
    });
    const cols = applyPromptDisplay(resolved, "inline", false);
    expect(cols.row1.left.map((e) => e.field)).toEqual([
      "index",
      "status",
      "pr",
      "prompt",
    ]);
    // pr is still forced to short even without a project anchor.
    expect(cols.row1.left.find((e) => e.field === "pr")?.mode).toBe("short");
    expect(cols.row2).toEqual({ left: [], right: [] });
  });
});

describe("rowHasContent", () => {
  const sidebarRow2 = resolveSidebarColumns(40).row2;

  it("does not count time toward row 2 content", () => {
    const session = mockEnrichedSession({
      lastPrompt: null,
      lastActivityAt: "2024-01-15T12:00:00Z",
    });
    expect(rowHasContent(session, sidebarRow2)).toBe(false);
  });

  it("counts a prompt, with time then riding along", () => {
    const session = mockEnrichedSession({
      lastPrompt: "fix the bug",
      lastActivityAt: "2024-01-15T12:00:00Z",
    });
    expect(rowHasContent(session, sidebarRow2)).toBe(true);
  });

  it("counts non-time fields on either side", () => {
    const prRow = resolveColumns(120).row2;
    const session = mockEnrichedSession({
      lastPrompt: null,
      branchPRs: [{ id: "66", href: "https://github.com/x/y/pull/66" }],
    });
    expect(rowHasContent(session, prRow)).toBe(true);
  });
});

describe("rowHasPrompt", () => {
  it("is true when the prompt sits on the left side", () => {
    expect(rowHasPrompt(resolveColumns(120).row2)).toBe(true);
  });

  it("is true when the prompt sits on the right side", () => {
    expect(rowHasPrompt({ left: [], right: [{ field: "prompt" }] })).toBe(true);
  });

  it("is false when no prompt entry is present", () => {
    expect(rowHasPrompt(resolveColumns(120).row1)).toBe(false);
    expect(rowHasPrompt({ left: [], right: [] })).toBe(false);
  });

  it("sees the prompt after inline flatten moves it onto row 1", () => {
    const inline = applyPromptDisplay(resolveColumns(120), "inline", false);
    expect(rowHasPrompt(inline.row1)).toBe(true);
    expect(rowHasPrompt(inline.row2)).toBe(false);
  });
});

describe("SIDEBAR_DEFAULT_COLUMNS", () => {
  it("has status/project on row1 left and pr/agent shorts on right", () => {
    expect(SIDEBAR_DEFAULT_COLUMNS.row1?.left).toEqual(["status", "project"]);
    expect(SIDEBAR_DEFAULT_COLUMNS.row1?.right).toEqual([
      "pr:short",
      "agent:short",
    ]);
  });

  it("has prompt on row2 left and time on row2 right", () => {
    expect(SIDEBAR_DEFAULT_COLUMNS.row2?.left).toEqual(["prompt"]);
    expect(SIDEBAR_DEFAULT_COLUMNS.row2?.right).toEqual(["time"]);
  });
});

describe("prColorState", () => {
  const branchPR = (extra: Partial<import("../../types").BranchPR>) => ({
    id: "70",
    href: "https://github.com/x/y/pull/70",
    ...extra,
  });

  it("returns null when there is no PR", () => {
    expect(prColorState(mockEnrichedSession({ branchPRs: null }))).toBeNull();
  });

  it("returns null for background-agent PRs (no state) so they stay neutral", () => {
    const session = mockEnrichedSession({
      backgroundChildren: [
        { kind: "pr", id: "42", href: "https://github.com/x/y/pull/42" },
      ],
    });
    expect(prColorState(session)).toBeNull();
  });

  it("is red when CI is failing", () => {
    const session = mockEnrichedSession({
      branchPRs: [branchPR({ reviewDecision: null, ciStatus: "failing" })],
    });
    expect(prColorState(session)).toBe("red");
  });

  it("is red when changes were requested", () => {
    const session = mockEnrichedSession({
      branchPRs: [
        branchPR({ reviewDecision: "CHANGES_REQUESTED", ciStatus: "passing" }),
      ],
    });
    expect(prColorState(session)).toBe("red");
  });

  it("is green only on an explicit approval (strict)", () => {
    const session = mockEnrichedSession({
      branchPRs: [
        branchPR({ reviewDecision: "APPROVED", ciStatus: "passing" }),
      ],
    });
    expect(prColorState(session)).toBe("green");
  });

  it("lets failing CI override an approval (red wins over green)", () => {
    const session = mockEnrichedSession({
      branchPRs: [
        branchPR({ reviewDecision: "APPROVED", ciStatus: "failing" }),
      ],
    });
    expect(prColorState(session)).toBe("red");
  });

  it("is yellow for passing-but-unapproved (strict green never fires here)", () => {
    const session = mockEnrichedSession({
      branchPRs: [branchPR({ reviewDecision: null, ciStatus: "passing" })],
    });
    expect(prColorState(session)).toBe("yellow");
  });

  it("is yellow for pending CI and for no-CI repos", () => {
    expect(
      prColorState(
        mockEnrichedSession({
          branchPRs: [branchPR({ reviewDecision: null, ciStatus: "pending" })],
        }),
      ),
    ).toBe("yellow");
    expect(
      prColorState(
        mockEnrichedSession({
          branchPRs: [
            branchPR({ reviewDecision: "REVIEW_REQUIRED", ciStatus: "none" }),
          ],
        }),
      ),
    ).toBe("yellow");
  });

  it("folds multiple PRs to the worst color (red > yellow > green)", () => {
    const approved = branchPR({
      reviewDecision: "APPROVED",
      ciStatus: "passing",
    });
    const open = branchPR({
      id: "71",
      reviewDecision: null,
      ciStatus: "pending",
    });
    const failing = branchPR({
      id: "72",
      reviewDecision: null,
      ciStatus: "failing",
    });

    expect(
      prColorState(mockEnrichedSession({ branchPRs: [approved, failing] })),
    ).toBe("red");
    expect(
      prColorState(mockEnrichedSession({ branchPRs: [approved, open] })),
    ).toBe("yellow");
    expect(
      prColorState(mockEnrichedSession({ branchPRs: [approved, approved] })),
    ).toBe("green");
  });
});

const mockSubagent = (
  overrides: Partial<SubagentState> = {},
): SubagentState => ({
  agentId: "sub",
  status: "working",
  attentionType: null,
  pendingTool: null,
  lastActivityAt: null,
  startedAt: null,
  ...overrides,
});

describe("getAttentionLabel", () => {
  it("returns the pending tool name when present", () => {
    expect(
      getAttentionLabel(
        mockEnrichedSession({ pendingTool: "Bash(git status)" }),
      ),
    ).toBe("Bash(git status)");
  });

  it("returns Plan in plan mode", () => {
    expect(getAttentionLabel(mockEnrichedSession({ inPlanMode: true }))).toBe(
      "Plan",
    );
  });

  it("returns Permission / Question by attention type when waiting", () => {
    expect(
      getAttentionLabel(
        mockEnrichedSession({ status: "waiting", attentionType: "permission" }),
      ),
    ).toBe("Permission");
    expect(
      getAttentionLabel(
        mockEnrichedSession({ status: "waiting", attentionType: "question" }),
      ),
    ).toBe("Question");
  });

  it("returns null for an idle session with no signal", () => {
    expect(getAttentionLabel(mockEnrichedSession())).toBeNull();
  });
});

describe("subagentCountLabel", () => {
  it("counts live subagents when no tool/plan marker is up", () => {
    expect(
      subagentCountLabel(
        mockEnrichedSession({ subagents: [mockSubagent(), mockSubagent()] }),
      ),
    ).toBe("2 Agent");
  });

  it("is hidden while a pending tool or plan takes the slot", () => {
    expect(
      subagentCountLabel(
        mockEnrichedSession({
          pendingTool: "Edit",
          subagents: [mockSubagent()],
        }),
      ),
    ).toBeNull();
    expect(
      subagentCountLabel(
        mockEnrichedSession({ inPlanMode: true, subagents: [mockSubagent()] }),
      ),
    ).toBeNull();
  });

  it("is null with no subagents", () => {
    expect(subagentCountLabel(mockEnrichedSession())).toBeNull();
  });
});

describe("trailingLabelsWidth", () => {
  it("is 0 for an idle, label-less session", () => {
    expect(trailingLabelsWidth(mockEnrichedSession(), false)).toBe(0);
  });

  it("is the attention label width (capped) in the picker", () => {
    expect(
      trailingLabelsWidth(
        mockEnrichedSession({ status: "waiting", attentionType: "permission" }),
        false,
      ),
    ).toBe("Permission".length);
  });

  it("caps a long attention label at ATTENTION_LABEL_MAX", () => {
    const long = "Bash(git status --porcelain --untracked)";
    expect(
      trailingLabelsWidth(mockEnrichedSession({ pendingTool: long }), false),
    ).toBe(ATTENTION_LABEL_MAX);
  });

  it("sums attention + subagent + the inter-label gap", () => {
    // pendingTool suppresses the subagent count, so use a waiting session with
    // subagents but no pending tool.
    const s = mockEnrichedSession({
      status: "waiting",
      attentionType: "question",
      subagents: [mockSubagent(), mockSubagent()],
    });
    // "Question"(8) + gap(1) + "2 Agent"(7) = 16
    expect(trailingLabelsWidth(s, false)).toBe(8 + 1 + 7);
  });

  it("collapses to a single '!' in the sidebar and hides the subagent count", () => {
    const s = mockEnrichedSession({
      status: "waiting",
      attentionType: "question",
      subagents: [mockSubagent()],
    });
    expect(trailingLabelsWidth(s, true)).toBe(1);
    expect(trailingLabelsWidth(mockEnrichedSession(), true)).toBe(0);
  });
});

describe("fitProjectCell", () => {
  const base = {
    prefix: "epilande/",
    dirname: "ccmux",
    branch: "main" as string | null,
    isWorktree: false,
  };

  it("renders everything unchanged when it fits", () => {
    const out = fitProjectCell(base, 40, 24);
    expect(out).toEqual({
      prefix: "epilande/",
      dirname: "ccmux",
      branchLabel: ":main",
    });
  });

  it("appends the worktree marker and caps the branch with ~", () => {
    const out = fitProjectCell(
      { ...base, branch: "feature/really-long-branch", isWorktree: true },
      60,
      8,
    );
    // 8-char cap: 7 chars + "~", then "+"
    expect(out.branchLabel).toBe(":feature~+");
  });

  it("shrinks the prefix with an ellipsis before touching the dirname", () => {
    // budget forces the prefix to give up chars; dirname + branch stay whole
    const out = fitProjectCell(base, 12, 24);
    expect(out.dirname).toBe("ccmux");
    expect(out.branchLabel).toBe(":main");
    expect(out.prefix.endsWith("…")).toBe(true);
    expect(
      out.prefix.length + out.dirname.length + out.branchLabel.length,
    ).toBe(12);
  });

  it("drops the prefix entirely when under 2 usable chars remain", () => {
    // dirname(5) + branch(5) = 10 already fills the budget, no prefix room
    const out = fitProjectCell(base, 10, 24);
    expect(out.prefix).toBe("");
    expect(out.dirname).toBe("ccmux");
    expect(out.branchLabel).toBe(":main");
  });

  it("truncates the dirname with an ellipsis, keeping a floor", () => {
    const out = fitProjectCell(
      {
        prefix: "",
        dirname: "claude-toolkit",
        branch: null,
        isWorktree: false,
      },
      8,
      24,
    );
    expect(out.dirname.endsWith("…")).toBe(true);
    expect(out.dirname).not.toBe("claude-toolkit");
    // floor keeps it identifiable, never a negative slice
    expect(out.dirname.length).toBeGreaterThanOrEqual(5);
  });

  it("never produces negative slices on a zero/negative budget", () => {
    const out = fitProjectCell(
      {
        prefix: "a/b/c/",
        dirname: "very-long-dirname",
        branch: "main",
        isWorktree: false,
      },
      0,
      24,
    );
    // Prefix collapses, dirname holds at its floor with an ellipsis (not a
    // raw mid-word clip), and no slice went negative.
    expect(out.prefix).toBe("");
    expect(out.dirname.endsWith("…")).toBe(true);
    expect(out.dirname.length).toBeGreaterThanOrEqual(5);
  });

  it("keeps a short dirname whole even when the budget is exhausted", () => {
    const out = fitProjectCell(base, 0, 24);
    // "ccmux" already sits at the floor, so it is shown in full (no fake `…`).
    expect(out.dirname).toBe("ccmux");
    expect(out.prefix).toBe("");
  });

  it("leaves a branch-less cell without a stray colon", () => {
    const out = fitProjectCell(
      { prefix: "", dirname: "app", branch: null, isWorktree: false },
      20,
      24,
    );
    expect(out.branchLabel).toBe("");
  });

  it("shortens the branch as a last resort with a ~ marker", () => {
    // Tight budget: even after dropping the prefix and flooring the dirname to
    // its 5-char minimum, the branch still overflows, so step 3 truncates it
    // with `~` rather than dropping it to "". Exercises the positive
    // shortenBranchLabel path (avail >= 3), not the zero-budget drop.
    const out = fitProjectCell(
      {
        prefix: "epilande/",
        dirname: "claude-toolkit",
        branch: "feature-x",
        isWorktree: false,
      },
      12,
      24,
    );
    expect(out.prefix).toBe("");
    expect(out.dirname.endsWith("…")).toBe(true);
    // Branch truncated with the `~` marker: neither dropped to "" nor left whole.
    expect(out.branchLabel).toBe(":featu~");
    expect(out.branchLabel.endsWith("~")).toBe(true);
    // The cascade never overshoots its budget.
    expect(
      out.prefix.length + out.dirname.length + out.branchLabel.length,
    ).toBeLessThanOrEqual(12);
  });
});
