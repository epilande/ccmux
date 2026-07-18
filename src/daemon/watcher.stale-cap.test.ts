import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createInitialState, applyEntriesToState } from "./status-machine";
import { SessionManager } from "./sessions";
import { PANE_IDLE_THRESHOLD_MS } from "../lib/config";
import { parseLogEntries } from "./parser";

function makeAssistantEntry(timestamp: string, toolName = "Read") {
  return JSON.stringify({
    type: "assistant",
    uuid: "a1",
    timestamp,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Running command" },
        { type: "tool_use", id: "tu1", name: toolName, input: {} },
      ],
    },
  });
}

function makeResultEntry(timestamp: string) {
  return JSON.stringify({
    type: "result",
    uuid: "r1",
    timestamp,
    result: { type: "success" },
  });
}

function deriveAndCapState(
  entries: ReturnType<typeof parseLogEntries>,
  cwd?: string,
) {
  let state = applyEntriesToState({ ...createInitialState(), cwd }, entries);

  if (entries.length > 0 && !state.lastActivityAt) {
    state = {
      ...state,
      lastActivityAt: entries[entries.length - 1].timestamp,
    };
  }

  if (state.status === "working" && state.lastActivityAt) {
    const age = Date.now() - new Date(state.lastActivityAt).getTime();
    if (age > PANE_IDLE_THRESHOLD_MS) {
      state = {
        ...state,
        status: "idle",
        attentionType: null,
        pendingTool: null,
      };
    }
  }

  return state;
}

describe("stale working cap on initial state derivation", () => {
  // A scratch dir used only as a `cwd` argument; status derivation no longer
  // consults settings, so its contents are irrelevant.
  let globalDir: string;

  beforeEach(() => {
    globalDir = mkdtempSync(join(tmpdir(), "stale-cap-"));
  });

  afterEach(() => {
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("should cap stale working state to idle", () => {
    const staleTime = new Date(
      Date.now() - PANE_IDLE_THRESHOLD_MS - 10_000,
    ).toISOString();
    const content = makeAssistantEntry(staleTime);
    const entries = parseLogEntries(content);

    const state = deriveAndCapState(entries, globalDir);

    expect(state.status).toBe("idle");
    expect(state.attentionType).toBeNull();
    expect(state.pendingTool).toBeNull();
  });

  it("should preserve recent working state", () => {
    const recentTime = new Date(Date.now() - 5_000).toISOString();
    const content = makeAssistantEntry(recentTime);
    const entries = parseLogEntries(content);

    const state = deriveAndCapState(entries, globalDir);

    expect(state.status).toBe("working");
  });

  it("should leave idle state unchanged regardless of staleness", () => {
    const staleTime = new Date(
      Date.now() - PANE_IDLE_THRESHOLD_MS - 10_000,
    ).toISOString();
    const content = [
      makeAssistantEntry(staleTime),
      makeResultEntry(staleTime),
    ].join("\n");
    const entries = parseLogEntries(content);

    const state = deriveAndCapState(entries, globalDir);

    expect(state.status).toBe("idle");
  });

  it("should not produce false 'just finished' on daemon restart", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/path/test-id.jsonl");

    const staleTime = new Date(
      Date.now() - PANE_IDLE_THRESHOLD_MS - 60_000,
    ).toISOString();
    const content = makeAssistantEntry(staleTime);
    const entries = parseLogEntries(content);
    const state = deriveAndCapState(entries, globalDir);

    manager.updateSession("test-id", state);

    const session = manager.getSession("test-id")!;
    expect(session.status).toBe("idle");
    expect(session.previousStatus).toBeNull();
    expect(session.statusChangedAt).toBeNull();
  });

  it("should not cap stale waiting state (only working is capped)", () => {
    const staleTime = new Date(
      Date.now() - PANE_IDLE_THRESHOLD_MS - 60_000,
    ).toISOString();
    // AskUserQuestion derives "waiting" (question), which the cap doesn't
    // target. (Bash no longer derives waiting: log-derived permission waiting
    // was removed.)
    const content = makeAssistantEntry(staleTime, "AskUserQuestion");
    const entries = parseLogEntries(content);

    const state = deriveAndCapState(entries, globalDir);

    expect(state.status).toBe("waiting");
  });

  it("should cap working at the threshold boundary", () => {
    // Add 100ms buffer so elapsed time between Date.now() calls doesn't cross the threshold
    const atThreshold = new Date(
      Date.now() - PANE_IDLE_THRESHOLD_MS + 100,
    ).toISOString();
    const content = makeAssistantEntry(atThreshold);
    const entries = parseLogEntries(content);

    const state = deriveAndCapState(entries, globalDir);

    expect(state.status).toBe("working");

    const pastThreshold = new Date(
      Date.now() - PANE_IDLE_THRESHOLD_MS - 1,
    ).toISOString();
    const content2 = makeAssistantEntry(pastThreshold);
    const entries2 = parseLogEntries(content2);

    const state2 = deriveAndCapState(entries2, globalDir);

    expect(state2.status).toBe("idle");
  });

  it("should record transition when recent working is followed by idle", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/path/test-id.jsonl");

    const recentTime = new Date(Date.now() - 5_000).toISOString();
    const content = makeAssistantEntry(recentTime);
    const entries = parseLogEntries(content);
    const state = deriveAndCapState(entries, globalDir);

    manager.updateSession("test-id", state);
    expect(manager.getSession("test-id")!.status).toBe("working");

    manager.updateSession("test-id", { status: "idle" });
    const session = manager.getSession("test-id")!;
    expect(session.status).toBe("idle");
    expect(session.previousStatus).toBe("working");
    expect(session.statusChangedAt).not.toBeNull();
  });
});
