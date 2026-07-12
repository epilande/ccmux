import type { EnrichedSession, Session } from "../../types";
import type { StatusSummary } from "../utils/grouping";

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

// A message wider than a bordered box word-wraps inside it, so it can straddle
// a line break (even mid-token) in the captured frame. Strip single-border box
// chars and all whitespace so an assertion matches the message regardless of
// where the wrap fell.
export function squish(s: string): string {
  return s.replace(/[│┌┐└┘─\s]/g, "");
}
