import { describe, expect, it, mock, spyOn } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

/** Redirect STATE_FILE to a temp dir so tests don't touch real ~/.config/ccmux/state.json */
const tempRoot = join(
  tmpdir(),
  `ccmux-resolve-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import { Daemon } from "./index";
import { SessionManager } from "./sessions";
import * as paneIo from "./pane-io";
import { reconcileAll } from "./state-reconciler";
import type { ProcessInfo, TmuxPane } from "../types/session";

function fakePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId: "%1",
    panePid: 1000,
    sessionName: "ccmux",
    windowIndex: 2,
    paneIndex: 1,
    target: "ccmux:2.1",
    tty: "ttys001",
    startTime: null,
    windowActivity: null,
    paneTitle: "✳ Claude Code",
    currentCommand: "2.1.50",
    currentPath: "/Users/test/proj",
    ...overrides,
  };
}

/**
 * Run `fn` with the pane showing an idle Claude prompt: Claude up, nothing in
 * flight, which `detectPaneState` reads as `active`. Stubbed rather than
 * captured: a real `capture-pane -t %1` reads whatever pane %1 is on the
 * machine running the tests, and fails outright where no tmux is running.
 */
async function withIdlePromptPane(fn: () => Promise<void>): Promise<void> {
  const capture = spyOn(paneIo, "tryCapturePane").mockResolvedValue("❯ \n");
  try {
    await fn();
  } finally {
    capture.mockRestore();
  }
}

function fakeClaudeProcess(pid: number): ProcessInfo {
  return {
    pid,
    command: "claude",
    agentType: "claude",
    tty: "ttys001",
    cwd: "/Users/test/proj",
    startTime: Date.now() - 60_000,
  };
}

function createStaleClaudeSession(
  manager: SessionManager,
  status: "working" | "waiting",
): string {
  const sessionId = "session-1";
  manager.createSession(
    sessionId,
    "/Users/test/.claude/projects/-Users-test-proj/session-1.jsonl",
    "claude",
  );
  manager.setTmuxPane(sessionId, "%1");
  manager.setPid(sessionId, 12345);
  manager.updateSession(sessionId, {
    status,
    attentionType: status === "waiting" ? "permission" : null,
    pendingTool: status === "waiting" ? "Bash" : null,
    lastActivityAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  });
  return sessionId;
}

function makeDeps(sessionManager: SessionManager) {
  return {
    sessionManager,
    watcher: { isRecentlyProcessed: () => false },
    hookManager: {
      getMarkerForSession: () => null,
      getMarkersByAgentAndPid: () => [],
    },
    agents: [],
    logAdapters: new Map(),
    now: Date.now,
    getLogFileMtime: () => 0,
  };
}

describe("reconcileAll: native Claude state resolution", () => {
  it("does not downgrade waiting sessions to idle from pane heuristics", async () => {
    const daemon = new Daemon();
    const sessionManager = (
      daemon as unknown as { sessionManager: SessionManager }
    ).sessionManager;
    const sessionId = createStaleClaudeSession(sessionManager, "waiting");

    await reconcileAll(makeDeps(sessionManager), {
      processes: [fakeClaudeProcess(12345)],
      panes: [fakePane()],
      processTree: { findShellDescendants: () => [] },
    });

    const session = sessionManager.getSession(sessionId)!;
    expect(session.status).toBe("waiting");
    expect(session.attentionType).toBe("permission");
  });

  it("still downgrades stale working sessions when pane indicates not working", async () => {
    const daemon = new Daemon();
    const sessionManager = (
      daemon as unknown as { sessionManager: SessionManager }
    ).sessionManager;
    const sessionId = createStaleClaudeSession(sessionManager, "working");

    await withIdlePromptPane(() =>
      reconcileAll(makeDeps(sessionManager), {
        processes: [fakeClaudeProcess(12345)],
        panes: [fakePane()],
        processTree: { findShellDescendants: () => [] },
      }),
    );

    const session = sessionManager.getSession(sessionId)!;
    expect(session.status).toBe("idle");
    expect(session.attentionType).toBeNull();
  });

  it("downgrades working sessions with no lastActivityAt when pane indicates not working", async () => {
    const daemon = new Daemon();
    const sessionManager = (
      daemon as unknown as { sessionManager: SessionManager }
    ).sessionManager;

    const sessionId = "session-1";
    sessionManager.createSession(
      sessionId,
      "/Users/test/.claude/projects/-Users-test-proj/session-1.jsonl",
      "claude",
    );
    sessionManager.setTmuxPane(sessionId, "%1");
    sessionManager.setPid(sessionId, 12345);
    sessionManager.updateSession(sessionId, {
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: undefined,
    });

    await withIdlePromptPane(() =>
      reconcileAll(makeDeps(sessionManager), {
        processes: [fakeClaudeProcess(12345)],
        panes: [fakePane()],
        processTree: { findShellDescendants: () => [] },
      }),
    );

    const session = sessionManager.getSession(sessionId)!;
    expect(session.status).toBe("idle");
    expect(session.attentionType).toBeNull();
  });

  it("preserves Bash execution upgrades through status reconciliation", async () => {
    const daemon = new Daemon();
    const sessionManager = (
      daemon as unknown as { sessionManager: SessionManager }
    ).sessionManager;

    const pane = fakePane({
      paneTitle: "⠂ Claude Code",
      currentCommand: "claude",
    });

    const sessionId = "session-1";
    sessionManager.createSession(
      sessionId,
      "/Users/test/.claude/projects/-Users-test-proj/session-1.jsonl",
      "claude",
    );
    sessionManager.setTmuxPane(sessionId, "%1");
    sessionManager.setPid(sessionId, 12345);
    sessionManager.updateSession(sessionId, {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: new Date().toISOString(),
    });

    await reconcileAll(makeDeps(sessionManager), {
      processes: [fakeClaudeProcess(12345)],
      panes: [pane],
      processTree: { findShellDescendants: () => [99999] },
    });

    const session = sessionManager.getSession(sessionId)!;
    expect(session.status).toBe("working");
    expect(session.attentionType).toBeNull();
  });
});
