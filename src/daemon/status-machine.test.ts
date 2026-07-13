import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  createInitialState,
  processEntry,
  deriveStateFromEntries,
  resolveDeadProcessState,
  getEffectiveStatus,
  appendPrompt,
} from "./status-machine";
import {
  MAX_SESSION_PROMPTS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS_TOTAL_BYTES,
} from "../lib/config";
import {
  clearPermissionCache,
  _setGlobalSettingsDir,
} from "../lib/permission-resolver";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type {
  LogEntry,
  ProgressLogEntry,
  AssistantLogEntry,
  UserLogEntry,
  ResultLogEntry,
  SummaryLogEntry,
  SystemLogEntry,
} from "../types";
import type { Session } from "../types/session";

describe("status-machine", () => {
  let testCwd: string;
  let globalDir: string;

  beforeEach(() => {
    clearPermissionCache();
    testCwd = mkdtempSync(join(tmpdir(), "sm-test-"));
    globalDir = mkdtempSync(join(tmpdir(), "sm-global-"));
    _setGlobalSettingsDir(globalDir);
    // Settings that allow commonly auto-approved tools
    writeFileSync(
      join(globalDir, "settings.json"),
      JSON.stringify({
        permissions: {
          allow: [
            "Read",
            "Glob",
            "Grep",
            "Task",
            "ExitPlanMode",
            "AskUserQuestion",
            "EnterPlanMode",
          ],
        },
      }),
    );
  });

  afterEach(() => {
    _setGlobalSettingsDir(null);
    rmSync(testCwd, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  describe("createInitialState", () => {
    it("should create idle state", () => {
      const state = createInitialState();
      expect(state.status).toBe("idle");
      expect(state.attentionType).toBeNull();
      expect(state.pendingTool).toBeNull();
      expect(state.inPlanMode).toBe(false);
    });

    it("should have undefined lastUserInputAt", () => {
      const state = createInitialState();
      expect(state.lastUserInputAt).toBeUndefined();
    });
  });

  describe("processEntry", () => {
    it("should handle SessionStart", () => {
      const entry: ProgressLogEntry = {
        type: "progress",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        progress: { type: "SessionStart" },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("idle");
    });

    it("should handle SessionEnd", () => {
      const entry: ProgressLogEntry = {
        type: "progress",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        progress: { type: "SessionEnd" },
      };

      const workingState = {
        ...createInitialState(),
        status: "working" as const,
      };
      const state = processEntry(entry, workingState);
      expect(state.status).toBe("idle");
    });

    it("should handle result entry", () => {
      const entry: ResultLogEntry = {
        type: "result",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        result: { type: "success" },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("idle");
      expect(state.attentionType).toBeNull();
    });

    it("should handle assistant with permission-required tool", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingTool).toBe("Bash");
    });

    it("should handle assistant with auto-approved tool", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool1",
              name: "Read",
              input: { file_path: "/test" },
            },
          ],
        },
      };

      const state = processEntry(entry, {
        ...createInitialState(),
        cwd: testCwd,
      });
      expect(state.status).toBe("working");
      expect(state.attentionType).toBeNull();
    });

    it("should handle EnterPlanMode", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool1",
              name: "EnterPlanMode",
              input: {},
            },
          ],
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.inPlanMode).toBe(true);
    });

    it("should handle ExitPlanMode as waiting with plan_approval attention", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool1",
              name: "ExitPlanMode",
              input: {},
            },
          ],
        },
      };

      const initialState = {
        ...createInitialState(),
        inPlanMode: true,
        cwd: testCwd,
      };
      const state = processEntry(entry, initialState);
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("plan_approval");
      expect(state.pendingTool).toBe("ExitPlanMode");
      // inPlanMode should stay true until user responds
      expect(state.inPlanMode).toBe(true);
    });

    it("should exit plan mode when user responds after ExitPlanMode", () => {
      const userEntry: UserLogEntry = {
        type: "user",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content: "Approved",
        },
      };

      // State after ExitPlanMode was called
      const waitingState = {
        ...createInitialState(),
        status: "waiting" as const,
        attentionType: "plan_approval" as const,
        pendingTool: "ExitPlanMode",
        inPlanMode: true,
      };

      const state = processEntry(userEntry, waitingState);
      expect(state.status).toBe("working");
      expect(state.inPlanMode).toBe(false);
      expect(state.pendingTool).toBeNull();
    });

    it("should handle user message", () => {
      const entry: UserLogEntry = {
        type: "user",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content: "Hello",
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("working");
    });

    it("should set lastUserInputAt on user message", () => {
      const entry: UserLogEntry = {
        type: "user",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T12:30:00Z",
        message: {
          role: "user",
          content: "Hello",
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.lastUserInputAt).toBe("2024-01-01T12:30:00Z");
      expect(state.lastActivityAt).toBe("2024-01-01T12:30:00Z");
    });

    it("should NOT set lastUserInputAt on tool results", () => {
      const entry: UserLogEntry = {
        type: "user",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T12:30:00Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool1",
              content: "result data",
            },
          ],
        },
      };

      const initialState = {
        ...createInitialState(),
        lastUserInputAt: "2024-01-01T12:00:00Z",
      };

      const state = processEntry(entry, initialState);
      expect(state.lastUserInputAt).toBe("2024-01-01T12:00:00Z");
      expect(state.lastActivityAt).toBe("2024-01-01T12:30:00Z");
    });

    it("should preserve lastUserInputAt through assistant entries", () => {
      const userEntry: UserLogEntry = {
        type: "user",
        uuid: "1",
        parentUuid: null,
        timestamp: "2024-01-01T12:00:00Z",
        message: { role: "user", content: "Hello" },
      };

      const assistantEntry: AssistantLogEntry = {
        type: "assistant",
        uuid: "2",
        parentUuid: null,
        timestamp: "2024-01-01T12:01:00Z",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
        },
      };

      let state = processEntry(userEntry, createInitialState());
      expect(state.lastUserInputAt).toBe("2024-01-01T12:00:00Z");

      state = processEntry(assistantEntry, state);
      expect(state.lastUserInputAt).toBe("2024-01-01T12:00:00Z");
      expect(state.lastActivityAt).toBe("2024-01-01T12:01:00Z");
    });

    it("should handle AskUserQuestion as waiting with question attention", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool1",
              name: "AskUserQuestion",
              input: { questions: [] },
            },
          ],
        },
      };

      const state = processEntry(entry, {
        ...createInitialState(),
        cwd: testCwd,
      });
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("question");
      expect(state.pendingTool).toBe("AskUserQuestion");
    });

    it("should handle assistant end_turn with no tools as idle", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is my response" }],
          stop_reason: "end_turn",
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("idle");
      expect(state.attentionType).toBeNull();
    });

    it("should handle assistant stop_sequence with no tools as idle", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is my response" }],
          stop_reason: "stop_sequence",
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("idle");
      expect(state.attentionType).toBeNull();
    });

    it("should handle summary entry as idle", () => {
      const entry: SummaryLogEntry = {
        type: "summary",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        summary: "Conversation summary...",
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("idle");
      expect(state.attentionType).toBeNull();
      expect(state.pendingTool).toBeNull();
      expect(state.inPlanMode).toBe(false);
    });

    it("should transition to idle from plan_approval when summary received", () => {
      const entry: SummaryLogEntry = {
        type: "summary",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        summary: "Conversation summary...",
      };

      // State after ExitPlanMode - waiting for approval
      const waitingState = {
        ...createInitialState(),
        status: "waiting" as const,
        attentionType: "plan_approval" as const,
        pendingTool: "ExitPlanMode",
        inPlanMode: true,
      };

      const state = processEntry(entry, waitingState);
      expect(state.status).toBe("idle");
      expect(state.attentionType).toBeNull();
      expect(state.pendingTool).toBeNull();
      expect(state.inPlanMode).toBe(false);
    });

    it("should handle queue-operation enqueue as working", () => {
      const entry = {
        type: "queue-operation" as const,
        operation: "enqueue" as const,
        timestamp: "2024-01-01T00:00:00Z",
        sessionId: "test-session",
        content: "user input",
      };

      const idleState = createInitialState();
      const state = processEntry(entry, idleState);
      expect(state.status).toBe("working");
      expect(state.attentionType).toBeNull();
      expect(state.pendingTool).toBeNull();
    });

    it("should handle queue-operation dequeue without changing status", () => {
      const entry = {
        type: "queue-operation" as const,
        operation: "dequeue" as const,
        timestamp: "2024-01-01T00:00:00Z",
        sessionId: "test-session",
      };

      const workingState = {
        ...createInitialState(),
        status: "working" as const,
      };
      const state = processEntry(entry, workingState);
      expect(state.status).toBe("working");
    });
  });

  describe("deriveStateFromEntries", () => {
    it("should derive state from multiple entries", () => {
      const entries: LogEntry[] = [
        {
          type: "progress",
          uuid: "1",
          parentUuid: null,
          timestamp: "2024-01-01T00:00:00Z",
          progress: { type: "SessionStart" },
        },
        {
          type: "user",
          uuid: "2",
          parentUuid: null,
          timestamp: "2024-01-01T00:00:01Z",
          message: { role: "user", content: "Hello" },
        },
        {
          type: "assistant",
          uuid: "3",
          parentUuid: null,
          timestamp: "2024-01-01T00:00:02Z",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          },
        },
      ];

      const state = deriveStateFromEntries(entries);
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingTool).toBe("Bash");
    });
  });

  describe("resolveDeadProcessState", () => {
    it("should reset working session to idle when process is dead", () => {
      const state = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Read",
        lastActivityAt: new Date().toISOString(),
      };

      const result = resolveDeadProcessState(state, false);
      expect(result.status).toBe("idle");
      expect(result.attentionType).toBeNull();
      expect(result.pendingTool).toBeNull();
    });

    it("should keep working session when process is alive", () => {
      const state = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Read",
        lastActivityAt: new Date().toISOString(),
      };

      const result = resolveDeadProcessState(state, true);
      expect(result.status).toBe("working");
      expect(result.pendingTool).toBe("Read");
    });

    it("should never modify waiting sessions regardless of PID", () => {
      const state = {
        ...createInitialState(),
        status: "waiting" as const,
        attentionType: "permission" as const,
        pendingTool: "Bash",
        lastActivityAt: new Date().toISOString(),
      };

      expect(resolveDeadProcessState(state, false).status).toBe("waiting");
      expect(resolveDeadProcessState(state, true).status).toBe("waiting");
      expect(resolveDeadProcessState(state, null).status).toBe("waiting");
    });

    it("should never modify idle sessions", () => {
      const state = {
        ...createInitialState(),
        status: "idle" as const,
        lastActivityAt: new Date().toISOString(),
      };

      expect(resolveDeadProcessState(state, false).status).toBe("idle");
      expect(resolveDeadProcessState(state, null).status).toBe("idle");
    });

    it("should reset to idle when no PID and log file is old (>10min)", () => {
      const oldMtime = Date.now() - 11 * 60 * 1000;
      const state = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Read",
        lastActivityAt: new Date().toISOString(),
      };

      const result = resolveDeadProcessState(state, null, oldMtime);
      expect(result.status).toBe("idle");
      expect(result.pendingTool).toBeNull();
    });

    it("should keep working when no PID but log file is recent", () => {
      const recentMtime = Date.now() - 1000;
      const state = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Read",
        lastActivityAt: new Date().toISOString(),
      };

      const result = resolveDeadProcessState(state, null, recentMtime);
      expect(result.status).toBe("working");
      expect(result.pendingTool).toBe("Read");
    });

    it("should reset to idle when no PID and log file is missing (null mtime)", () => {
      // Regression for the far-future sentinel bypass: `Bun.file().lastModified`
      // returns 2 ** 52 - 1 for a missing file, which `readLogFileMtime`
      // normalizes to null. Null means the log will never append again, so
      // the safety net must idle instead of treating it as fresh activity.
      const state = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Read",
        lastActivityAt: new Date().toISOString(),
      };

      const result = resolveDeadProcessState(state, null, null);
      expect(result.status).toBe("idle");
      expect(result.pendingTool).toBeNull();
    });

    it("should keep working when no PID and no mtime provided", () => {
      const state = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Read",
        lastActivityAt: new Date().toISOString(),
      };

      const result = resolveDeadProcessState(state, null);
      expect(result.status).toBe("working");
    });

    it("should clear pendingTaskIds and hasActiveSubagent on dead process", () => {
      const state = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Task",
        hasActiveSubagent: true,
        pendingTaskIds: ["task1", "task2"],
        lastActivityAt: new Date().toISOString(),
      };

      const result = resolveDeadProcessState(state, false);
      expect(result.status).toBe("idle");
      expect(result.pendingTaskIds).toBeUndefined();
      expect(result.hasActiveSubagent).toBe(false);
    });

    it("should clear pendingTaskIds on no-PID safety net timeout", () => {
      const oldMtime = Date.now() - 11 * 60 * 1000;
      const state = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Task",
        hasActiveSubagent: true,
        pendingTaskIds: ["task1"],
        lastActivityAt: new Date().toISOString(),
      };

      const result = resolveDeadProcessState(state, null, oldMtime);
      expect(result.status).toBe("idle");
      expect(result.pendingTaskIds).toBeUndefined();
      expect(result.hasActiveSubagent).toBe(false);
    });
  });

  describe("Bug 1: Sibling tool tracking with early returns", () => {
    it("should detect waiting when Bash appears before Task in same message", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
            { type: "tool_use", id: "t2", name: "Task", input: {} },
          ],
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingToolIds).toContain("t1");
    });

    it("should detect waiting when Bash appears before ExitPlanMode in same message", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" },
            },
            { type: "tool_use", id: "t2", name: "ExitPlanMode", input: {} },
          ],
        },
      };

      const state = processEntry(entry, {
        ...createInitialState(),
        inPlanMode: true,
      });
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingToolIds).toContain("t1");
    });

    it("should detect waiting when Bash appears before AskUserQuestion in same message", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Write", input: {} },
            { type: "tool_use", id: "t2", name: "AskUserQuestion", input: {} },
          ],
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingToolIds).toContain("t1");
    });

    it("should track Task IDs alongside permission tool IDs", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: {} },
            { type: "tool_use", id: "t2", name: "Task", input: {} },
          ],
        },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.pendingTaskIds).toContain("t2");
      expect(state.hasActiveSubagent).toBe(true);
    });
  });

  describe("Bug 2: bash_progress clearing unrelated waiting", () => {
    it("should transition to working on bash_progress from idle", () => {
      const entry: ProgressLogEntry = {
        type: "progress",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        data: { type: "bash_progress", output: "" },
      };

      const state = processEntry(entry, createInitialState());
      expect(state.status).toBe("working");
      expect(state.pendingTool).toBe("Bash");
    });

    it("should NOT clear waiting state when bash_progress arrives for non-Bash pending tool", () => {
      const entry: ProgressLogEntry = {
        type: "progress",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        data: { type: "bash_progress", output: "" },
      };

      const waitingForWrite = {
        ...createInitialState(),
        status: "waiting" as const,
        attentionType: "permission" as const,
        pendingTool: "Write",
        pendingToolIds: ["w1"],
      };

      const state = processEntry(entry, waitingForWrite);
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingTool).toBe("Write");
    });
  });

  describe("Bug 4: Summary lastActivityAt", () => {
    it("should update lastActivityAt on summary entry", () => {
      const entry: SummaryLogEntry = {
        type: "summary",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T12:00:00Z",
        summary: "Conversation summary...",
      };

      const state = processEntry(entry, createInitialState());
      expect(state.lastActivityAt).toBe("2024-01-01T12:00:00Z");
    });
  });

  describe("Coverage: permission + auto-approved mix", () => {
    it("should preserve waiting when auto-approved tool follows permission tool", () => {
      const entry: AssistantLogEntry = {
        type: "assistant",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: {} },
            { type: "tool_use", id: "t2", name: "Read", input: {} },
          ],
        },
      };

      const state = processEntry(entry, {
        ...createInitialState(),
        cwd: testCwd,
      });
      expect(state.status).toBe("waiting");
      expect(state.attentionType).toBe("permission");
      expect(state.pendingToolIds).toEqual(["t1"]);
    });
  });

  describe("Coverage: tool result clears pendingTaskIds", () => {
    it("should clear pendingTaskIds when Task tool result arrives", () => {
      const userEntry: UserLogEntry = {
        type: "user",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task1", content: "done" },
          ],
        },
      };

      const stateWithTask = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Task",
        hasActiveSubagent: true,
        pendingTaskIds: ["task1"],
      };

      const state = processEntry(userEntry, stateWithTask);
      expect(state.pendingTaskIds).toBeUndefined();
      expect(state.hasActiveSubagent).toBe(false);
    });

    it("should keep remaining pendingTaskIds when only some complete", () => {
      const userEntry: UserLogEntry = {
        type: "user",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T00:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "task1", content: "done" },
          ],
        },
      };

      const stateWithTasks = {
        ...createInitialState(),
        status: "working" as const,
        pendingTool: "Task",
        hasActiveSubagent: true,
        pendingTaskIds: ["task1", "task2"],
      };

      const state = processEntry(userEntry, stateWithTasks);
      expect(state.pendingTaskIds).toEqual(["task2"]);
      expect(state.hasActiveSubagent).toBe(true);
    });
  });

  describe("Coverage: getEffectiveStatus", () => {
    const baseSession: Session = {
      id: "test",
      agentType: "claude",
      trackingMode: "native",
      nativeSessionId: "test",
      project: "test",
      cwd: "/test",
      logPath: "/test.jsonl",
      status: "working",
      attentionType: null,
      pendingTool: null,
      inPlanMode: false,
      tmuxPane: null,
      updatedAt: new Date(),
      lastActivityAt: null,
      lastUserInputAt: null,
      subagents: [],
      gitBranch: null,
      version: null,
      pid: null,
      statusChangedAt: null,
      previousStatus: null,
      attentionState: null,
      lastSeenAt: null,
      lastPrompt: null,
      prompts: [],
    };

    it("should return session status when no subagents are waiting", () => {
      const result = getEffectiveStatus(baseSession);
      expect(result.status).toBe("working");
      expect(result.fromSubagent).toBe(false);
    });

    it("should not surface subagent waiting on a working parent", () => {
      // Subagent waiting is log-derived (unresolved tool_use) and cannot
      // distinguish "blocked on approval" from "executing a long tool";
      // it must never turn the row red. Genuine prompts arrive via the
      // parent's own marker/terminal-driven waiting.
      const session: Session = {
        ...baseSession,
        subagents: [
          {
            agentId: "sub1",
            status: "waiting",
            attentionType: "permission",
            pendingTool: "Bash",
            lastActivityAt: null,
            startedAt: null,
          },
        ],
      };
      const result = getEffectiveStatus(session);
      expect(result.status).toBe("working");
      expect(result.fromSubagent).toBe(false);
    });

    it("should lift an idle parent to working when a subagent is waiting", () => {
      // Waiting counts as activity (mid tool call), not attention.
      const session: Session = {
        ...baseSession,
        status: "idle",
        subagents: [
          {
            agentId: "sub1",
            status: "waiting",
            attentionType: "permission",
            pendingTool: "Bash",
            lastActivityAt: null,
            startedAt: null,
          },
        ],
      };
      const result = getEffectiveStatus(session);
      expect(result.status).toBe("working");
      expect(result.attentionType).toBe(null);
      expect(result.fromSubagent).toBe(true);
    });

    it("should lift an idle parent to working when a subagent is still working", () => {
      const session: Session = {
        ...baseSession,
        status: "idle",
        attentionState: "unread",
        subagents: [
          {
            agentId: "sub1",
            status: "working",
            attentionType: null,
            pendingTool: null,
            lastActivityAt: null,
            startedAt: null,
          },
        ],
      };
      const result = getEffectiveStatus(session);
      expect(result.status).toBe("working");
      expect(result.attentionType).toBe(null);
      expect(result.fromSubagent).toBe(true);
    });

    it("should keep an idle parent idle when all subagents are idle", () => {
      const session: Session = {
        ...baseSession,
        status: "idle",
        subagents: [
          {
            agentId: "sub1",
            status: "idle",
            attentionType: null,
            pendingTool: null,
            lastActivityAt: null,
            startedAt: null,
          },
        ],
      };
      const result = getEffectiveStatus(session);
      expect(result.status).toBe("idle");
      expect(result.fromSubagent).toBe(false);
    });

    it("should not override a waiting parent when a subagent is working", () => {
      const session: Session = {
        ...baseSession,
        status: "waiting",
        attentionType: "permission",
        subagents: [
          {
            agentId: "sub1",
            status: "working",
            attentionType: null,
            pendingTool: null,
            lastActivityAt: null,
            startedAt: null,
          },
        ],
      };
      const result = getEffectiveStatus(session);
      expect(result.status).toBe("waiting");
      expect(result.attentionType).toBe("permission");
      expect(result.fromSubagent).toBe(false);
    });
  });

  describe("Coverage: unknown entry types", () => {
    it("should update lastActivityAt for unknown entry type", () => {
      const entry: LogEntry = {
        type: "unknown_type",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T12:00:00Z",
      };

      const state = processEntry(entry, createInitialState());
      expect(state.lastActivityAt).toBe("2024-01-01T12:00:00Z");
      expect(state.status).toBe("idle");
    });

    it("should preserve status for unknown system subtype", () => {
      const entry: SystemLogEntry = {
        type: "system",
        uuid: "123",
        parentUuid: null,
        timestamp: "2024-01-01T12:00:00Z",
        subtype: "unknown_subtype",
      };

      const workingState = {
        ...createInitialState(),
        status: "working" as const,
      };
      const state = processEntry(entry, workingState);
      expect(state.status).toBe("working");
      expect(state.lastActivityAt).toBe("2024-01-01T12:00:00Z");
    });
  });

  describe("appendPrompt", () => {
    it("appends to an undefined array, oldest to newest", () => {
      const one = appendPrompt(undefined, "first");
      expect(one).toEqual(["first"]);
      const two = appendPrompt(one, "second");
      expect(two).toEqual(["first", "second"]);
    });

    it("returns a new array on append (does not mutate input)", () => {
      const input = ["first"];
      const result = appendPrompt(input, "second");
      expect(result).not.toBe(input);
      expect(input).toEqual(["first"]);
    });

    it("trims and truncates to MAX_PROMPT_CHARS", () => {
      const long = "x".repeat(MAX_PROMPT_CHARS + 50);
      const result = appendPrompt([], `  ${long}  `);
      expect(result[0]!.length).toBe(MAX_PROMPT_CHARS);
    });

    it("skips empty/whitespace-only text, returning the same array reference", () => {
      const input = ["first"];
      expect(appendPrompt(input, "")).toBe(input);
      expect(appendPrompt(input, "   \n\t")).toBe(input);
    });

    it("caps the count at MAX_SESSION_PROMPTS, dropping oldest", () => {
      let prompts: string[] = [];
      for (let i = 0; i < MAX_SESSION_PROMPTS + 5; i++) {
        prompts = appendPrompt(prompts, `prompt-${i}`);
      }
      expect(prompts.length).toBe(MAX_SESSION_PROMPTS);
      // The oldest survivor is prompt-5 (0..4 dropped), newest is the last.
      expect(prompts[0]).toBe("prompt-5");
      expect(prompts[prompts.length - 1]).toBe(
        `prompt-${MAX_SESSION_PROMPTS + 4}`,
      );
    });

    it("caps the total bytes at MAX_PROMPTS_TOTAL_BYTES, dropping oldest and keeping newest", () => {
      // 20 prompts x 240 chars = 4800 bytes > 4096, so the byte cap must drop
      // the oldest entries even though the count cap (20) is not exceeded.
      let prompts: string[] = [];
      for (let i = 0; i < MAX_SESSION_PROMPTS; i++) {
        // Unique prefix so oldest/newest are identifiable; padded to the max.
        prompts = appendPrompt(prompts, `p${i}-`.padEnd(MAX_PROMPT_CHARS, "y"));
      }
      const totalBytes = prompts.reduce(
        (sum, p) => sum + Buffer.byteLength(p, "utf-8"),
        0,
      );
      // The byte cap actually bit: fewer than the count cap survive.
      expect(prompts.length).toBeLessThan(MAX_SESSION_PROMPTS);
      expect(totalBytes).toBeLessThanOrEqual(MAX_PROMPTS_TOTAL_BYTES);
      // Oldest dropped, newest kept.
      expect(prompts[0]).not.toStartWith("p0-");
      expect(prompts[prompts.length - 1]).toStartWith(
        `p${MAX_SESSION_PROMPTS - 1}-`,
      );
    });

    it("returns the array unchanged for non-string text (defensive)", () => {
      const input = ["first"];
      // A malformed but JSON-valid log entry can deliver a non-string here.
      expect(appendPrompt(input, null as unknown as string)).toBe(input);
      expect(appendPrompt(input, 42 as unknown as string)).toBe(input);
      expect(appendPrompt(input, {} as unknown as string)).toBe(input);
    });

    it("does not slice a surrogate pair in half when truncating", () => {
      // A string of astral emoji (each a surrogate pair) longer than the cap.
      const emoji = "😀".repeat(MAX_PROMPT_CHARS);
      const [result] = appendPrompt([], emoji);
      // No lone/unpaired surrogate at the boundary.
      expect(result).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(result!.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    });
  });

  describe("processUserEntry - prompt accumulation", () => {
    it("accumulates each user message prompt oldest to newest", () => {
      const mkUser = (text: string, ts: string): UserLogEntry => ({
        type: "user",
        uuid: ts,
        parentUuid: null,
        timestamp: ts,
        message: { role: "user", content: text },
      });

      let state = createInitialState();
      state = processEntry(
        mkUser("first prompt", "2024-01-01T12:00:00Z"),
        state,
      );
      state = processEntry(
        mkUser("second prompt", "2024-01-01T12:01:00Z"),
        state,
      );

      expect(state.prompts).toEqual(["first prompt", "second prompt"]);
      expect(state.lastPrompt).toBe("second prompt");
    });

    it("does not throw on a malformed user entry with content: null", () => {
      const entry = {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2024-01-01T12:00:00Z",
        message: { role: "user", content: null },
      } as unknown as UserLogEntry;

      let state = createInitialState();
      // Would previously throw inside appendPrompt (becoming an unhandled
      // rejection under the daemon's `void this.processFile`).
      expect(() => {
        state = processEntry(entry, state);
      }).not.toThrow();
      expect(state.prompts).toEqual([]);
    });
  });
});
