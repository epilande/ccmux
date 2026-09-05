import { expect } from "bun:test";
import type { CliRenderer } from "@opentui/core";
import { createMockKeys } from "@opentui/core/testing";
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
    paneTitle: null,
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

/**
 * Press Escape so the component actually receives it.
 *
 * Neither `@opentui/core/testing` path does this on its own (issue #160):
 *
 * - `pressKey("escape")` resolves its argument as key INPUT and knows the
 *   escape byte only under the `KeyCodes.ESCAPE` name, so the word falls
 *   through as text and the handler sees six keys: `e s c a p e`. The
 *   harness guard test (`test-harness-guard.test.ts`) fails the suite on
 *   that spelling.
 * - `pressEscape()` emits the right byte, but a bare `\x1b` is the prefix of
 *   every escape sequence, so the stdin parser HOLDS it for a 20ms
 *   disambiguation window (`StdinParser` `timeoutMs`, on the renderer's
 *   clock) before it will call it a key. A `renderOnce()` or a 0ms `settle()`
 *   right after sees nothing, and a keypress inside the window turns into
 *   meta-that-key instead.
 *
 * This forces the window closed instead of sleeping through it: it tells the
 * parser the timeout has elapsed and drains the event it then releases, so
 * the escape is dispatched synchronously and the caller only has to repaint.
 * Both members are private on `CliRenderer`; if an upgrade renames them the
 * helper throws rather than degrading into a silent no-op.
 */
export function deliverEscape(renderer: CliRenderer): void {
  const internals = renderer as unknown as {
    stdinParser?: { flushTimeout?: (nowMs?: number) => void };
    drainStdinParser?: () => void;
  };
  const flush = internals.stdinParser?.flushTimeout;
  const drain = internals.drainStdinParser;
  if (typeof flush !== "function" || typeof drain !== "function") {
    throw new Error(
      "deliverEscape: CliRenderer no longer exposes stdinParser.flushTimeout " +
        "and drainStdinParser; update the helper for this @opentui/core",
    );
  }
  createMockKeys(renderer).pressEscape();
  flush.call(internals.stdinParser, Number.MAX_SAFE_INTEGER);
  drain.call(internals);
}
