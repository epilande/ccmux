import { describe, it, expect, beforeEach, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Redirect STATE_FILE to a temp dir so tests don't touch real ~/.config/ccmux/state.json */
const tempRoot = join(
  tmpdir(),
  `ccmux-attn-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import { AttentionTracker } from "./attention-tracker";
import type { Session } from "../types/session";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-session",
    agentType: "claude",
    trackingMode: "native",
    project: "test",
    cwd: "/test",
    logPath: null,
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    tmuxPane: "%0",
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
    ...overrides,
  } as Session;
}

describe("AttentionTracker", () => {
  let tracker: AttentionTracker;

  beforeEach(() => {
    tracker = new AttentionTracker(15_000);
  });

  describe("markSeen", () => {
    it("should return read", () => {
      const result = tracker.markSeen("test-session");
      expect(result).toBe("read");
    });
  });

  describe("shouldClearRead", () => {
    it("should return false before timeout", () => {
      tracker.markSeen("test-session");
      expect(tracker.shouldClearRead("test-session")).toBe(false);
    });

    it("should return true after timeout", () => {
      tracker.markSeen("test-session");
      const future = Date.now() + 16_000;
      expect(tracker.shouldClearRead("test-session", future)).toBe(true);
    });

    it("should return false for unknown session", () => {
      expect(tracker.shouldClearRead("unknown")).toBe(false);
    });
  });

  describe("isViewingSession", () => {
    it("should return true when session pane matches active pane", () => {
      const session = makeSession({ tmuxPane: "%5" });
      expect(tracker.isViewingSession(session, "%5")).toBe(true);
    });

    it("should return false when panes differ", () => {
      const session = makeSession({ tmuxPane: "%5" });
      expect(tracker.isViewingSession(session, "%3")).toBe(false);
    });

    it("should return false when session has no pane", () => {
      const session = makeSession({ tmuxPane: null });
      expect(tracker.isViewingSession(session, "%5")).toBe(false);
    });

    it("should return false when no active pane", () => {
      const session = makeSession({ tmuxPane: "%5" });
      expect(tracker.isViewingSession(session, null)).toBe(false);
    });
  });

  describe("removeSession", () => {
    it("should clear all tracking state for the session", () => {
      tracker.markSeen("test-session"); // sets lastSeen + readAt

      tracker.removeSession("test-session");

      expect(tracker.shouldClearRead("test-session")).toBe(false);
      expect(tracker.hasReadTimer("test-session")).toBe(false);
    });

    it("should be a no-op for unknown sessions", () => {
      tracker.removeSession("nonexistent");
      // No error thrown
    });
  });

  describe("prune", () => {
    it("should remove tracking for sessions not in active set", () => {
      tracker.markSeen("session-1");
      tracker.markSeen("session-2");
      tracker.prune(new Set(["session-1"]));
      // session-2 should be cleaned up
      expect(tracker.shouldClearRead("session-2")).toBe(false);
    });

    it("should return true when entries were pruned", () => {
      tracker.markSeen("session-1");
      expect(tracker.prune(new Set())).toBe(true);
    });

    it("should return false when no persisted entries were pruned", () => {
      // Clear any entries loaded from the state file
      tracker.prune(new Set());
      tracker.markSeen("session-1");
      expect(tracker.prune(new Set(["session-1"]))).toBe(false);
    });

    it("should return false when tracker has no persisted entries", () => {
      // Clear any entries loaded from the state file
      tracker.prune(new Set());
      expect(tracker.prune(new Set())).toBe(false);
    });
  });

  describe("hasReadTimer / initReadTimer", () => {
    it("should return false when no timer exists", () => {
      expect(tracker.hasReadTimer("test-session")).toBe(false);
    });

    it("should return true after markSeen", () => {
      tracker.markSeen("test-session");
      expect(tracker.hasReadTimer("test-session")).toBe(true);
    });

    it("should initialize timer only once via initReadTimer", () => {
      tracker.initReadTimer("test-session");
      expect(tracker.hasReadTimer("test-session")).toBe(true);

      // Calling again should not reset the timer
      const before = tracker.shouldClearRead(
        "test-session",
        Date.now() + 4_000,
      );
      tracker.initReadTimer("test-session");
      const after = tracker.shouldClearRead("test-session", Date.now() + 4_000);
      expect(before).toBe(after);
    });

    it("should be cleared by clearRead", () => {
      tracker.markSeen("test-session");
      tracker.clearRead("test-session");
      expect(tracker.hasReadTimer("test-session")).toBe(false);
    });
  });

  describe("save", () => {
    const stateFile = join(tempRoot, "state.json");

    it("should preserve TUI-owned keys in the shared state file", () => {
      // STATE_FILE is shared with the TUI's UI state (src/lib/state.ts);
      // save() must merge, not overwrite.
      mkdirSync(tempRoot, { recursive: true });
      writeFileSync(
        stateFile,
        JSON.stringify({ showPrompt: false, hideIdle: true }),
      );

      tracker.markSeen("test-session");
      tracker.save();

      const data = JSON.parse(readFileSync(stateFile, "utf-8"));
      expect(data.showPrompt).toBe(false);
      expect(data.hideIdle).toBe(true);
      expect(data.version).toBe(1);
      expect(data.lastSeen["test-session"]).toBeString();
    });

    it("should write fresh when the file does not exist", () => {
      rmSync(stateFile, { force: true });
      tracker.markSeen("test-session");
      tracker.save();

      const data = JSON.parse(readFileSync(stateFile, "utf-8"));
      expect(data.version).toBe(1);
      expect(data.lastSeen["test-session"]).toBeString();
    });
  });
});
