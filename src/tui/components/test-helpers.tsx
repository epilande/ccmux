import { expect } from "bun:test";
import type { EnrichedSession, Session } from "../../types";
import type { FilteredSession, StatusSummary } from "../utils/grouping";

const FIXED_DATE = "2024-01-15T12:00:00Z";

export function mockEnrichedSession(
  overrides: Partial<EnrichedSession> = {},
): EnrichedSession {
  return {
    id: "test-id",
    agentType: "claude",
    trackingMode: "native",
    nativeSessionId: "test-id",
    project: "test-project",
    cwd: "/Users/test/Code/myapp",
    logPath: "/test/path/test-id.jsonl",
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    tmuxPane: null,
    tmuxTarget: null,
    paneCwd: null,
    updatedAt: new Date(FIXED_DATE),
    lastActivityAt: null,
    lastUserInputAt: null,
    subagents: [],
    gitBranch: null,
    version: null,
    isWorktree: false,
    mainRepoRoot: null,
    worktreeRoot: null,
    originInvocationId: null,
    pid: null,
    statusChangedAt: null,
    attentionGeneration: 0,
    previousStatus: null,
    attentionState: null,
    lastSeenAt: null,
    lastPrompt: null,
    prompts: [],
    ...overrides,
  };
}

export function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-id",
    agentType: "claude",
    trackingMode: "native",
    project: "",
    cwd: "/test/path",
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    tmuxPane: null,
    tmuxTarget: null,
    updatedAt: new Date(FIXED_DATE),
    ...overrides,
  } as Session;
}

export function emptySummary(): StatusSummary {
  return {
    working: 0,
    waitingPermission: 0,
    waitingPlanApproval: 0,
    waitingGeneric: 0,
    idle: 0,
  };
}

/** Build group members whose effective statuses reproduce `summary`, for
 *  components that now derive their own summary from raw members. */
export function membersFromSummary(summary: StatusSummary): FilteredSession[] {
  const members: FilteredSession[] = [];
  const add = (n: number, overrides: Partial<EnrichedSession>) => {
    for (let i = 0; i < n; i++) {
      members.push({
        session: mockEnrichedSession(overrides),
        highlights: null,
      });
    }
  };
  add(summary.working, { status: "working" });
  add(summary.waitingPermission, {
    status: "waiting",
    attentionType: "permission",
  });
  add(summary.waitingPlanApproval, {
    status: "waiting",
    attentionType: "plan_approval",
  });
  add(summary.waitingGeneric, { status: "waiting", attentionType: null });
  add(summary.idle, { status: "idle" });
  return members;
}

/**
 * Assert a rendered single-border box is structurally intact: every row that
 * carries a border character closes with one, and — when `expectedHeight` is
 * given — the box spans exactly that many rows, its own borders included.
 *
 * Be clear about what the first half does NOT catch, because it reads like a
 * general overflow detector and is not one. It only inspects rows that
 * already contain `│`, so content that spills past the rows its container
 * budgeted for it passes untouched: the overflowing rows have no border
 * character to check, and garbling INSIDE the box leaves the borders intact.
 * Run against the frames from both bugs this helper's tests cover (#85, #82)
 * it passed on both. Treat it as a cheap structural check and let the height
 * and content assertions carry the real weight — `expectedHeight` is here so
 * that the one line that does catch a box drawn taller than it claims can
 * ride along with it.
 */
export function expectFrameIntegrity(
  frame: string,
  expectedHeight?: number,
): void {
  const lines = frame.split("\n");
  const boxRows = lines
    .filter((row) => row.includes("│"))
    .map((row) => row.trimEnd());
  expect(boxRows.length).toBeGreaterThan(0);
  for (const row of boxRows) {
    expect(row.endsWith("│")).toBe(true);
  }
  if (expectedHeight === undefined) return;
  // Corners, not the `│` rows: a box whose bottom fell off the viewport has
  // no `└` to find, which is exactly the failure worth reporting.
  const top = lines.findIndex((row) => row.includes("┌"));
  const bottom = lines.findIndex((row) => row.includes("└"));
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeGreaterThanOrEqual(0);
  expect(bottom - top + 1).toBe(expectedHeight);
}

// Strip single-border box chars and whitespace from a captured frame so an
// assertion matches a message regardless of where word-wrap split it.
export function squish(s: string): string {
  return s.replace(/[│┌┐└┘─\s]/g, "");
}
