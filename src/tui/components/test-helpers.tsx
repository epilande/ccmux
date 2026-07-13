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
    originInvocationId: null,
    pid: null,
    statusChangedAt: null,
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

// Strip single-border box chars and whitespace from a captured frame so an
// assertion matches a message regardless of where word-wrap split it.
export function squish(s: string): string {
  return s.replace(/[│┌┐└┘─\s]/g, "");
}
