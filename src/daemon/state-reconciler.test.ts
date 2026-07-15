import { afterAll, describe, expect, it, mock, beforeEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { BUILTIN_AGENTS, type AgentDef } from "../lib/agents";
import type { ProcessInfo, Session, TmuxPane } from "../types/session";
import type { PaneDetectionResult } from "./pane-classify";

/** Redirect STATE_FILE to a temp dir so tests don't touch real ~/.config/ccmux/state.json */
const tempRoot = join(
  tmpdir(),
  `ccmux-reconciler-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

// Module-level mocks must be set up before importing the module under test
let mockDetectPaneState: (
  paneId: string,
  pane?: TmuxPane,
) => Promise<PaneDetectionResult>;
let mockCapturePane: (paneId: string, lines?: number) => Promise<string>;

// Captured during the mock-factory's first run so we can hand the real
// implementations back to the let-bindings in afterAll. Bun's mock.module
// is process-scoped and has no built-in restore, so a sibling test file that
// loads pane-classify after this file's tests would otherwise see the stale
// stub from the last test instead of real behavior.
let realDetectPaneState: typeof mockDetectPaneState | undefined;
let realCapturePane: typeof mockCapturePane | undefined;

mock.module("./pane-classify", () => {
  const actual = require("./pane-classify");
  realDetectPaneState = actual.detectPaneState;
  return {
    ...actual,
    detectPaneState: (...args: Parameters<typeof mockDetectPaneState>) =>
      mockDetectPaneState(...args),
  };
});

mock.module("./pane-io", () => {
  const actual = require("./pane-io");
  realCapturePane = actual.capturePane;
  return {
    ...actual,
    capturePane: (...args: Parameters<typeof mockCapturePane>) =>
      mockCapturePane(...args),
  };
});

afterAll(() => {
  if (realDetectPaneState) mockDetectPaneState = realDetectPaneState;
  if (realCapturePane) mockCapturePane = realCapturePane;
});

import {
  capStaleSubagents,
  clearTerminalRuleCache,
  collectPaneTrackedSources,
  readLogFileMtime,
  reconcileAll,
  reconcileOne,
  type ReconcilerDeps,
  type ScanSnapshot,
} from "./state-reconciler";
import type { LogAdapter } from "./log-adapter";
import type { SessionPidMarker } from "./session-markers";
import { SessionManager } from "./sessions";
import { evaluateCascade } from "./cascade-evaluator";
import { PANE_IDLE_THRESHOLD_MS } from "../lib/config";

interface MakeSessionOpts {
  id?: string;
  agentType?: string;
  trackingMode?: "native" | "pane";
  status?: "working" | "waiting" | "idle";
  attentionType?: Session["attentionType"];
  pendingTool?: string | null;
  pid?: number | null;
  tmuxPane?: string | null;
  lastActivityAt?: string | null;
  subagents?: Session["subagents"];
  nativeSessionId?: string;
}

function makeSession(
  manager: SessionManager,
  overrides: MakeSessionOpts = {},
): string {
  const agentType = overrides.agentType ?? "claude";
  const trackingMode = overrides.trackingMode ?? "native";

  let id: string;
  if (trackingMode === "pane") {
    const paneId = overrides.tmuxPane ?? "%1";
    const session = manager.createPaneTrackedSession({
      agentType,
      paneId,
      cwd: "/Users/test/proj",
      pid: overrides.pid ?? null,
      nativeSessionId: overrides.nativeSessionId,
    });
    id = session.id;
  } else {
    id = overrides.id ?? "session-1";
    manager.createSession(
      id,
      `/Users/test/.claude/projects/-Users-test-proj/${id}.jsonl`,
      agentType,
    );
    if (overrides.tmuxPane) manager.setTmuxPane(id, overrides.tmuxPane);
    if (overrides.pid != null) manager.setPid(id, overrides.pid);
  }

  // updateSession takes Partial<SessionState>, so only pass valid fields
  const updates: Record<string, unknown> = {};
  if (overrides.status) updates.status = overrides.status;
  if (overrides.attentionType !== undefined)
    updates.attentionType = overrides.attentionType;
  if (overrides.pendingTool !== undefined)
    updates.pendingTool = overrides.pendingTool;
  if (overrides.lastActivityAt !== undefined)
    updates.lastActivityAt = overrides.lastActivityAt ?? undefined;
  if (Object.keys(updates).length > 0) manager.updateSession(id, updates);

  // Set fields that aren't on SessionState directly.
  // `subagents` lives on Session but not on SessionState, so updateSession
  // can't accept it; reach into the internal map to set it.
  const internalSessions = (
    manager as unknown as { sessions: Map<string, Session> }
  ).sessions;
  const session = internalSessions.get(id)!;
  if (overrides.subagents) session.subagents = overrides.subagents;

  return id;
}

function fakePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId: "%1",
    panePid: 1000,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 0,
    target: "ccmux:0.1",
    tty: "ttys001",
    startTime: null,
    windowActivity: null,
    paneTitle: "✳ Claude Code",
    currentCommand: "claude",
    currentPath: "/Users/test/proj",
    ...overrides,
  };
}

function fakeProcess(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 12345,
    command: "claude",
    agentType: "claude",
    tty: "ttys001",
    cwd: "/Users/test/proj",
    startTime: Date.now() - 60_000,
    ...overrides,
  };
}

const TWO_MINUTES_AGO = new Date(Date.now() - 2 * 60_000).toISOString();

function makeDeps(
  sessionManager: SessionManager,
  overrides: Partial<ReconcilerDeps> = {},
): ReconcilerDeps {
  return {
    sessionManager,
    watcher: { isRecentlyProcessed: () => false },
    hookManager: {
      getMarkerForSession: () => null,
      getMarkersByAgentAndPid: () => [],
    },
    agents: [],
    logAdapters: new Map(),
    now: () => Date.now(),
    getLogFileMtime: () => 0,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ScanSnapshot> = {}): ScanSnapshot {
  return {
    processes: [],
    panes: [],
    processTree: { findShellDescendants: () => [] },
    ...overrides,
  };
}

describe("reconcileAll", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
    mockDetectPaneState = async () => ({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
    mockCapturePane = async () => "";
  });

  describe("native Claude: dead process", () => {
    it("resets to idle when process is dead", async () => {
      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      // Process list is empty, so PID 12345 is dead
      await reconcileAll(makeDeps(sessionManager), makeSnapshot());

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
      expect(session.attentionType).toBeNull();
      expect(session.pendingTool).toBeNull();
    });
  });

  describe("native Claude: stale working pane inspection", () => {
    it("downgrades stale working session when pane shows idle", async () => {
      mockDetectPaneState = async () => ({
        state: "idle",
        attentionType: null,
        pendingTool: null,
      });

      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
    });

    it("detects plan approval from pane inspection", async () => {
      mockDetectPaneState = async () => ({
        state: "plan_approval",
        attentionType: "plan_approval",
        pendingTool: null,
      });

      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("plan_approval");
      expect(session.inPlanMode).toBe(true);
    });
  });

  describe("native Claude: tool execution detection", () => {
    it("upgrades waiting-on-Bash to working when shell children exist", async () => {
      const id = makeSession(sessionManager, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: new Date().toISOString(),
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
          processTree: { findShellDescendants: () => [99999] },
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
      expect(session.attentionType).toBeNull();
    });

    it("does not upgrade when no shell children", async () => {
      const id = makeSession(sessionManager, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: new Date().toISOString(),
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
          processTree: { findShellDescendants: () => [] },
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("waiting");
    });
  });

  describe("pane-tracked Claude: fallback", () => {
    it("derives state from pane inspection for pane-tracked Claude", async () => {
      mockDetectPaneState = async () => ({
        state: "working",
        attentionType: null,
        pendingTool: null,
      });

      const id = makeSession(sessionManager, {
        agentType: "claude",
        trackingMode: "pane",
        status: "idle",
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({ panes: [fakePane()] }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
    });
  });

  describe("pane-tracked agent: timestamp-compare cascade", () => {
    const codexAgent: AgentDef = {
      name: "codex",
      shortCode: "CX",
      processMatch: /codex/,
      terminalRules: [
        {
          status: "waiting",
          attentionType: "permission",
          pendingTool: null,
          matchAny: ["approve"],
        },
      ],
      hooks: { type: "generic-status" },
    };

    function codexSession(lastActivityAt: string | null = null): string {
      return makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "idle",
        tmuxPane: "%2",
        nativeSessionId: "native-codex",
        lastActivityAt: lastActivityAt ?? undefined,
      });
    }

    function claudeMarker(
      overrides: Partial<SessionPidMarker> = {},
    ): SessionPidMarker {
      return {
        agent_type: "codex",
        pid: 1,
        tty: "/dev/ttys002",
        session_id: "native-codex",
        timestamp: 1,
        ...overrides,
      };
    }

    it("marker idle wins when fresher than log activity", async () => {
      const logAt = new Date("2026-04-17T12:00:00Z").toISOString();
      const markerTs = new Date(logAt).getTime() / 1000 + 60;
      const id = codexSession(logAt);

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () =>
              claudeMarker({ state: "idle", state_timestamp: markerTs }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
      expect(session.attentionType).toBeNull();
      expect(session.pendingTool).toBeNull();
    });

    it("marker waiting_permission carries pending_tool into the session", async () => {
      const id = codexSession();

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () =>
              claudeMarker({
                state: "waiting_permission",
                state_timestamp: 1_000,
                pending_tool: "Bash",
              }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("permission");
      expect(session.pendingTool).toBe("Bash");
    });

    it("log activity overrides a stale marker when log_ts > marker state_ts", async () => {
      const logAt = new Date("2026-04-17T12:05:00Z").toISOString();
      const staleMarkerTs = new Date(logAt).getTime() / 1000 - 120;
      const id = codexSession(logAt);

      // A log adapter is registered; cascade should fall through to the
      // "hasLogAdapter + no waiting rule" branch and return without overwriting.
      const logAdapters = new Map([["codex", {} as never]]);

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () =>
              claudeMarker({ state: "idle", state_timestamp: staleMarkerTs }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
          logAdapters,
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle"); // unchanged from initial state
    });

    it("terminal waiting upgrades an idle marker to waiting", async () => {
      mockCapturePane = async () => "please approve?";
      const id = codexSession();

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () =>
              claudeMarker({ state: "idle", state_timestamp: 1_000 }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("permission");
    });

    it("marker state=working propagates to session.status=working", async () => {
      // Regression: cursor and opencode hooks rewrite the marker to
      // state="working" mid-turn. Pre-fix, stateFromMarker squashed
      // anything-not-waiting_permission to idle, so the picker never
      // showed working for those agents.
      const id = codexSession();

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () =>
              claudeMarker({ state: "working", state_timestamp: 1_000 }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
      expect(session.attentionType).toBeNull();
      expect(session.pendingTool).toBeNull();
    });

    it("propagates marker.last_prompt to session.lastPrompt", async () => {
      const id = codexSession();

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () =>
              claudeMarker({
                state: "working",
                state_timestamp: 1_000,
                last_prompt: "count to 50",
              }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.lastPrompt).toBe("count to 50");
    });

    it("preserves session.lastPrompt when marker.last_prompt is undefined (sticky between prompts)", async () => {
      // After Cursor's stop hook fires, the marker has state=idle and no
      // last_prompt. The previously-recorded lastPrompt must persist; an
      // empty/undefined value here would clobber it.
      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%2",
        nativeSessionId: "native-codex",
      });
      sessionManager.updateSession(id, { lastPrompt: "earlier prompt" });

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () =>
              claudeMarker({ state: "idle", state_timestamp: 2_000 }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
      expect(session.lastPrompt).toBe("earlier prompt");
    });
  });

  describe("pane-tracked OpenCode: aggregator path", () => {
    const opencodeAgent: AgentDef = {
      name: "opencode",
      shortCode: "OC",
      processMatch: /opencode/,
      terminalRules: [],
      hooks: { type: "generic-status" },
    };

    function opencodeSession(): string {
      return makeSession(sessionManager, {
        agentType: "opencode",
        trackingMode: "pane",
        status: "idle",
        tmuxPane: "%2",
        nativeSessionId: "ses_primary",
      });
    }

    function ocMarker(overrides: Partial<SessionPidMarker>): SessionPidMarker {
      return {
        agent_type: "opencode",
        pid: 4242,
        session_id: "ses_x",
        timestamp: 1,
        ...overrides,
      };
    }

    it("uses aggregator (worst-of) instead of single-marker stateFromMarker", async () => {
      // One server PID hosts three sessions: one waiting_permission, one
      // working, one idle. The single marker matched by nativeSessionId
      // would only show that session's state; the aggregator must surface
      // the worst-of (waiting > working > idle) so the picker reflects
      // any sibling needing attention.
      const id = opencodeSession();
      const siblings: SessionPidMarker[] = [
        ocMarker({
          session_id: "ses_primary",
          state: "idle",
          state_timestamp: 1_000,
        }),
        ocMarker({
          session_id: "ses_other",
          state: "working",
          state_timestamp: 1_005,
        }),
        ocMarker({
          session_id: "ses_third",
          state: "waiting_permission",
          state_timestamp: 1_010,
          pending_tool: "Bash",
        }),
      ];

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () =>
              siblings.find((m) => m.session_id === "ses_primary") ?? null,
            getMarkersByAgentAndPid: (agentType, pid) =>
              agentType === "opencode" && pid === 4242 ? siblings : [],
          },
          agents: [opencodeAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("permission");
      expect(session.pendingTool).toBe("Bash");
    });

    it("single working sibling produces working session (single-marker case)", async () => {
      const id = opencodeSession();
      const siblings: SessionPidMarker[] = [
        ocMarker({
          session_id: "ses_primary",
          state: "working",
          state_timestamp: 1_000,
        }),
      ];

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () => siblings[0] ?? null,
            getMarkersByAgentAndPid: () => siblings,
          },
          agents: [opencodeAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
    });

    it("falls back to the matched marker when sibling lookup is empty (defensive)", async () => {
      // Race: the cache-refresh path may briefly see the matched marker
      // but no siblings (e.g. same-tick eviction). The reconciler should
      // still derive working from the one marker rather than reset to idle.
      const id = opencodeSession();
      const matched = ocMarker({
        session_id: "ses_primary",
        state: "working",
        state_timestamp: 1_000,
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () => matched,
            getMarkersByAgentAndPid: () => [],
          },
          agents: [opencodeAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
    });
  });

  describe("Option Y overlay: log-adapter agents", () => {
    // Codex-like agent: has terminal rules for waiting + working, no hooks.
    const codexAgent: AgentDef = {
      name: "codex",
      shortCode: "CX",
      processMatch: /codex/,
      terminalRules: [
        {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Command",
          matchAny: ["allow command?"],
        },
        {
          status: "working",
          attentionType: null,
          pendingTool: null,
          matchAny: ["codex is thinking"],
        },
      ],
    };

    function logAdapterMap(agentType: string): Map<string, LogAdapter> {
      // Minimal LogAdapter stub — only `has()` is called in reconcileAll.
      return new Map([[agentType, { agentType } as LogAdapter]]);
    }

    it("keeps log-derived working state when terminal rule does not match", async () => {
      mockCapturePane = async () => "idle shell\n$ ";

      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "working", // Simulates log-derived state
        tmuxPane: "%2",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          agents: [codexAgent],
          logAdapters: logAdapterMap("codex"),
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
      expect(session.attentionType).toBeNull();
    });

    it("upgrades log-derived working to waiting when terminal rule fires", async () => {
      mockCapturePane = async () => "Allow command?\nPress Enter to confirm";

      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%2",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          agents: [codexAgent],
          logAdapters: logAdapterMap("codex"),
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("permission");
      expect(session.pendingTool).toBe("Command");
    });

    it("keeps log-derived idle when terminal rule does not match (no default-idle stomp)", async () => {
      mockCapturePane = async () => "nothing interesting";

      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "idle",
        tmuxPane: "%2",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          agents: [codexAgent],
          logAdapters: logAdapterMap("codex"),
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
    });

    it("does not downgrade log-derived working to idle when terminal shows idle-equivalent", async () => {
      // Terminal matches a non-waiting rule (working), so the upgrade-only
      // guard should leave the existing log-derived working state alone.
      mockCapturePane = async () => "codex is thinking about your request";

      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%2",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          agents: [codexAgent],
          logAdapters: logAdapterMap("codex"),
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
    });

    it("heals a stuck working row when the linked log went silent and no rule matches", async () => {
      // Repro shape: no-hooks codex, rollout linked AFTER the turn already
      // completed. The one-shot link read left status=working, the file
      // never appends again, and the pane shows codex's idle footer (no
      // terminal rule matches). Pre-fix this deadlocked forever: the log
      // source echoed session.status and the upgrade-only terminal source
      // could never downgrade it.
      mockCapturePane = async () => "› done. anything else?\n$ ";

      const now = Date.now();
      const staleMtime = now - PANE_IDLE_THRESHOLD_MS - 1_000;
      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%2",
        lastActivityAt: new Date(staleMtime).toISOString(),
      });
      sessionManager.setLogPath(
        id,
        "/Users/test/.codex/sessions/2026/07/03/rollout-x.jsonl",
      );

      await reconcileAll(
        makeDeps(sessionManager, {
          agents: [codexAgent],
          logAdapters: logAdapterMap("codex"),
          now: () => now,
          getLogFileMtime: () => staleMtime,
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
      expect(session.attentionType).toBeNull();
      expect(session.pendingTool).toBeNull();
    });

    it("keeps working through a long silent stretch while the terminal still shows the working indicator", async () => {
      // Counterpart guard: exec begin/end events are not persisted to the
      // rollout, so a long-running command can leave the log silent past
      // the threshold mid-turn. The pane's working indicator must keep the
      // row working — the synthetic idle only stands in when the terminal
      // shows NO working/waiting evidence.
      mockCapturePane = async () => "codex is thinking about your request";

      const now = Date.now();
      const staleMtime = now - PANE_IDLE_THRESHOLD_MS - 1_000;
      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%2",
        lastActivityAt: new Date(staleMtime).toISOString(),
      });
      sessionManager.setLogPath(
        id,
        "/Users/test/.codex/sessions/2026/07/03/rollout-x.jsonl",
      );

      await reconcileAll(
        makeDeps(sessionManager, {
          agents: [codexAgent],
          logAdapters: logAdapterMap("codex"),
          now: () => now,
          getLogFileMtime: () => staleMtime,
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      expect(sessionManager.getSession(id)!.status).toBe("working");
    });

    it("clears stale permission fields when log is fresher than marker and no rule matches (regression: Issue 1 Layer B)", async () => {
      // Regression: after an approval resolved and the Stop hook
      // moved the marker back to idle, a subsequent log write made the log
      // timestamp fresher than the marker. The Option Y overlay path then
      // returned without clearing the stale `pendingTool` / `attentionType`
      // written by the earlier terminal-rule match.
      mockCapturePane = async () => "idle shell\n$ ";

      const logAt = new Date("2026-04-17T12:05:00Z").toISOString();
      const staleMarkerTs = new Date(logAt).getTime() / 1000 - 120;
      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "idle",
        attentionType: "permission",
        pendingTool: "Command",
        tmuxPane: "%2",
        lastActivityAt: logAt,
        nativeSessionId: "native-codex",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () => ({
              agent_type: "codex",
              pid: 1,
              tty: "/dev/ttys002",
              session_id: "native-codex",
              timestamp: 1,
              state: "idle",
              state_timestamp: staleMarkerTs,
            }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
          logAdapters: logAdapterMap("codex"),
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
      expect(session.attentionType).toBeNull();
      expect(session.pendingTool).toBeNull();
    });

    it("clears stale permission fields when no marker exists and no rule matches", async () => {
      // Same regression, different precondition: no hook marker at all.
      mockCapturePane = async () => "idle shell\n$ ";

      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "working",
        attentionType: "permission",
        pendingTool: "Command",
        tmuxPane: "%2",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          agents: [codexAgent],
          logAdapters: logAdapterMap("codex"),
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      // Log owns status; overlay only clears attention/pending fields.
      expect(session.status).toBe("working");
      expect(session.attentionType).toBeNull();
      expect(session.pendingTool).toBeNull();
    });

    it("falls back to pre-Option-Y behavior when agent has no registered adapter", async () => {
      // No logAdapters entry for "gemini" — terminal wins, default-idle on miss.
      const geminiAgent: AgentDef = {
        name: "gemini",
        shortCode: "GM",
        processMatch: /gemini/,
        terminalRules: [
          {
            status: "working",
            attentionType: null,
            pendingTool: null,
            matchAny: ["processing"],
          },
        ],
      };

      mockCapturePane = async () => "unrelated text";

      const id = makeSession(sessionManager, {
        agentType: "gemini",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%2",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          agents: [geminiAgent],
          logAdapters: new Map(), // empty — gemini has no adapter
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      // Old behavior: no rule match + no adapter → default idle, stomping working.
      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
    });
  });

  describe("windowActivity gating for reconcilePaneTrackedAgentSession", () => {
    // Pins the capturePane / matchTerminalRule amortization keyed by
    // `TmuxPane.windowActivity`. Marker and log sources still flow through
    // the cascade every tick; only the terminal source contribution is
    // cached so unchanged panes don't burn a `tmux capture-pane` subprocess.

    const gatedAgent: AgentDef = {
      name: "cursor",
      shortCode: "CR",
      processMatch: /cursor/,
      terminalRules: [
        {
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Command",
          matchAny: ["allow command?"],
        },
      ],
    };

    beforeEach(() => {
      clearTerminalRuleCache();
    });

    it("skips capturePane on the second tick when windowActivity is unchanged", async () => {
      let captureCalls = 0;
      mockCapturePane = async () => {
        captureCalls++;
        return "Allow command?";
      };

      const id = makeSession(sessionManager, {
        agentType: "cursor",
        trackingMode: "pane",
        tmuxPane: "%2",
      });

      const pane = fakePane({
        paneId: "%2",
        tty: "ttys002",
        windowActivity: 12345,
      });

      const deps = makeDeps(sessionManager, { agents: [gatedAgent] });
      await reconcileAll(deps, makeSnapshot({ panes: [pane] }));
      expect(captureCalls).toBe(1);
      const afterFirst = sessionManager.getSession(id)!;
      expect(afterFirst.status).toBe("waiting");
      expect(afterFirst.attentionType).toBe("permission");

      // Same pane (same windowActivity) → no new capture, status preserved
      // because the cached ruleMatch still contributes to the cascade.
      await reconcileAll(deps, makeSnapshot({ panes: [pane] }));
      expect(captureCalls).toBe(1);
      const afterSecond = sessionManager.getSession(id)!;
      expect(afterSecond.status).toBe("waiting");
      expect(afterSecond.attentionType).toBe("permission");
    });

    it("re-captures when windowActivity advances", async () => {
      let captureCalls = 0;
      let contentToReturn = "Allow command?";
      mockCapturePane = async () => {
        captureCalls++;
        return contentToReturn;
      };

      const id = makeSession(sessionManager, {
        agentType: "cursor",
        trackingMode: "pane",
        tmuxPane: "%2",
      });

      const deps = makeDeps(sessionManager, { agents: [gatedAgent] });
      await reconcileAll(
        deps,
        makeSnapshot({
          panes: [
            fakePane({ paneId: "%2", tty: "ttys002", windowActivity: 1 }),
          ],
        }),
      );
      expect(captureCalls).toBe(1);
      expect(sessionManager.getSession(id)!.status).toBe("waiting");

      // windowActivity advances → re-capture, fresh non-matching content
      // collapses status back to idle (no rule fired, no log adapter).
      contentToReturn = "nothing interesting now";
      await reconcileAll(
        deps,
        makeSnapshot({
          panes: [
            fakePane({ paneId: "%2", tty: "ttys002", windowActivity: 2 }),
          ],
        }),
      );
      expect(captureCalls).toBe(2);
      expect(sessionManager.getSession(id)!.status).toBe("idle");
    });

    it("always captures when windowActivity is null (safe fallback)", async () => {
      let captureCalls = 0;
      mockCapturePane = async () => {
        captureCalls++;
        return "";
      };

      makeSession(sessionManager, {
        agentType: "cursor",
        trackingMode: "pane",
        tmuxPane: "%2",
      });

      const deps = makeDeps(sessionManager, { agents: [gatedAgent] });
      const snapshot = makeSnapshot({
        panes: [
          fakePane({ paneId: "%2", tty: "ttys002", windowActivity: null }),
        ],
      });
      await reconcileAll(deps, snapshot);
      await reconcileAll(deps, snapshot);
      expect(captureCalls).toBe(2);
    });

    it("marker source still flows through the cascade when capture is gated", async () => {
      // Pin that gating only suppresses the terminal contribution, not the
      // marker/log inputs. A marker change between ticks must still update
      // session state even when windowActivity is unchanged.
      let captureCalls = 0;
      mockCapturePane = async () => {
        captureCalls++;
        return "";
      };

      const id = makeSession(sessionManager, {
        agentType: "cursor",
        trackingMode: "pane",
        tmuxPane: "%2",
        nativeSessionId: "cur-uuid",
      });

      let currentMarker: SessionPidMarker | null = null;
      const deps = makeDeps(sessionManager, {
        agents: [gatedAgent],
        hookManager: {
          getMarkerForSession: () => currentMarker,
          getMarkersByAgentAndPid: () => [],
        },
      });
      const pane = fakePane({
        paneId: "%2",
        tty: "ttys002",
        windowActivity: 99,
      });

      await reconcileAll(deps, makeSnapshot({ panes: [pane] }));
      expect(captureCalls).toBe(1);
      expect(sessionManager.getSession(id)!.status).toBe("idle");

      // New marker appears; windowActivity unchanged so capturePane is
      // skipped, but the marker should still drive the cascade to waiting.
      currentMarker = {
        agent_type: "cursor",
        pid: 1,
        tty: "/dev/ttys002",
        session_id: "cur-uuid",
        timestamp: 1,
        state: "waiting_permission",
        state_timestamp: Date.now() / 1000,
        pending_tool: "Command",
      };
      await reconcileAll(deps, makeSnapshot({ panes: [pane] }));
      expect(captureCalls).toBe(1);
      expect(sessionManager.getSession(id)!.status).toBe("waiting");
    });
  });

  describe("ambiguous permission marker correction (AskUserQuestion)", () => {
    const claudeAgent = BUILTIN_AGENTS.find((a) => a.name === "claude")!;

    /** A captured AskUserQuestion picker: the terminal question rule
     *  (`type something.` + `enter to select`) matches, but no real permission
     *  prompt terminator is present. */
    const QUESTION_PICKER = [
      " ☐ Fav color",
      "What's your favorite color?",
      "❯ 1. Blue",
      "  5. Type something.",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");

    function permissionMarker(): SessionPidMarker {
      return {
        agent_type: "claude",
        pid: 1,
        tty: "/dev/ttys001",
        session_id: "cc-uuid",
        timestamp: 1,
        state: "waiting_permission",
        state_timestamp: Date.now() / 1000,
      };
    }

    async function run(agent: AgentDef, paneContent: string): Promise<Session> {
      const id = makeSession(sessionManager, {
        trackingMode: "native",
        status: "idle",
        tmuxPane: "%1",
      });
      mockCapturePane = async () => paneContent;
      const deps = makeDeps(sessionManager, {
        agents: [agent],
        hookManager: {
          getMarkerForSession: () => permissionMarker(),
          getMarkersByAgentAndPid: () => [],
        },
      });
      const session = sessionManager.getSession(id)!;
      await reconcileOne(deps, session, new Map());
      return sessionManager.getSession(id)!;
    }

    it("relabels a permission marker as question when the pane shows the picker", async () => {
      const session = await run(claudeAgent, QUESTION_PICKER);
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("question");
    });

    it("preserves permission when the agent is not flagged", async () => {
      const unflagged: AgentDef = {
        ...claudeAgent,
        ambiguousPermissionMarker: false,
      };
      const session = await run(unflagged, QUESTION_PICKER);
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("permission");
    });

    it("preserves permission when the pane is a real permission prompt (not a question)", async () => {
      const permissionPane = [
        "Bash command",
        "  rm -rf /tmp/x",
        "This command requires approval",
        "Do you want to proceed?",
        "❯ 1. Yes",
      ].join("\n");
      const session = await run(claudeAgent, permissionPane);
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("permission");
    });

    /** A `waiting_permission` marker whose timestamp is well in the past —
     *  models the post-approval window where the marker is stuck `waiting`
     *  (no hook fires on keyboard approval) while the log has since advanced. */
    function stalePermissionMarker(): SessionPidMarker {
      return {
        agent_type: "claude",
        pid: 1,
        tty: "/dev/ttys001",
        session_id: "cc-uuid",
        timestamp: 1,
        state: "waiting_permission",
        state_timestamp: (Date.now() - 5 * 60_000) / 1000,
      };
    }

    /** Native Claude session already in `working` with a FRESH log activity
     *  (fresher than the stale marker), so the log source wins the baseline
     *  fold. The stale permission marker + `paneContent` drive the
     *  ambiguous-permission correction. */
    async function runWorkingLog(
      paneContent: string,
      marker: SessionPidMarker,
    ): Promise<Session> {
      const id = makeSession(sessionManager, {
        trackingMode: "native",
        status: "working",
        lastActivityAt: new Date().toISOString(),
        tmuxPane: "%1",
      });
      mockCapturePane = async () => paneContent;
      const deps = makeDeps(sessionManager, {
        agents: [claudeAgent],
        hookManager: {
          getMarkerForSession: () => marker,
          getMarkersByAgentAndPid: () => [],
        },
      });
      const session = sessionManager.getSession(id)!;
      await reconcileOne(deps, session, new Map());
      return sessionManager.getSession(id)!;
    }

    it("stays working when a stale permission marker meets a fresher working log and only residual 'requires approval' scrollback (regression: post-approval false-flip)", async () => {
      // The user already approved at the keyboard; the marker is stuck
      // `waiting_permission`, but the log advanced to `working`. Residual
      // "requires approval" text in scrollback matches Claude's permission
      // rule — which must NOT be pushed as an upgrade source, or it would flip
      // the fresher working state back to waiting/permission.
      const residualScrollback = [
        "This command requires approval",
        "  1. Yes",
        "",
        "> now running the approved command",
        "  Working... (esc to interrupt)",
      ].join("\n");
      const session = await runWorkingLog(
        residualScrollback,
        stalePermissionMarker(),
      );
      expect(session.status).toBe("working");
      expect(session.attentionType).toBeNull();
    });

    it("heals a mis-stored waiting/permission when the pane shows a live question picker (log-echo poisoning)", async () => {
      // Found live: if the wrong `permission` classification ever gets STORED
      // (e.g. the first reconcile raced the picker render), the native log
      // source echoes that stored state with a fresh timestamp every tick,
      // out-freshing the relabeled marker forever. The correction must relabel
      // the log echo too, or the poisoned state can never heal.
      const id = makeSession(sessionManager, {
        trackingMode: "native",
        status: "waiting",
        attentionType: "permission",
        lastActivityAt: new Date().toISOString(),
        tmuxPane: "%1",
      });
      mockCapturePane = async () => QUESTION_PICKER;
      const deps = makeDeps(sessionManager, {
        agents: [claudeAgent],
        hookManager: {
          getMarkerForSession: () => stalePermissionMarker(),
          getMarkersByAgentAndPid: () => [],
        },
      });
      const session = sessionManager.getSession(id)!;
      await reconcileOne(deps, session, new Map());
      const healed = sessionManager.getSession(id)!;
      expect(healed.status).toBe("waiting");
      expect(healed.attentionType).toBe("question");
    });

    it("detects the question picker even when a permission phrase elsewhere on screen would shadow it (first-match immunity)", async () => {
      // Found live: Claude's release-notes startup banner contains the literal
      // phrase "permission rules", which matches the permission rule's
      // matchAny. `matchTerminalRule` is first-match-wins, so matching ALL
      // rules would return the permission rule and never consult the question
      // rule — blinding the correction while the banner (or any permission
      // prose) is in the window. The correction must match question rules only.
      const bannerShadowedPicker = [
        "Added a startup warning for Write(path) permission rules — use Edit(path) instead",
        "",
        "What's your favorite season?",
        "❯ 1. Spring",
        "  2. Summer",
        "  5. Type something.",
        "Enter to select · ↑/↓ to navigate · Esc to cancel",
      ].join("\n");
      const session = await runWorkingLog(
        bannerShadowedPicker,
        stalePermissionMarker(),
      );
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("question");
    });

    it("upgrades a fresher working log to waiting/question when a live question picker is on the pane (the picker is genuine, not scrollback)", async () => {
      // Unlike the permission rule, the question rule matchAll's two
      // live-widget strings ("type something." + "enter to select") that do not
      // survive as scrollback. When they are present the agent is genuinely
      // blocked on the user, so the upgradeOnly question source legitimately
      // lifts even a fresher working log to waiting/question.
      const session = await runWorkingLog(
        QUESTION_PICKER,
        stalePermissionMarker(),
      );
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("question");
    });
  });

  describe("ordering guarantees", () => {
    it("tool execution runs before native state resolution", async () => {
      // A session waiting on Bash with shell children should be upgraded to working
      // by tool execution, and then native resolution should NOT downgrade it
      // (because it's now working with fresh activity)
      const id = makeSession(sessionManager, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: new Date().toISOString(),
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
          processTree: { findShellDescendants: () => [99999] },
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
    });
  });

  describe("waiting session protection", () => {
    it("does not downgrade waiting sessions via pane heuristics", async () => {
      mockDetectPaneState = async () => ({
        state: "active",
        attentionType: null,
        pendingTool: null,
      });

      const id = makeSession(sessionManager, {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      // Waiting sessions skip the "status !== working" check, so no pane inspection
      expect(session.status).toBe("waiting");
    });
  });

  describe("hook lookup via getMarkerForSession", () => {
    it("passes the Session to hookManager.getMarkerForSession", async () => {
      const codexAgent: AgentDef = {
        name: "codex",
        shortCode: "CX",
        processMatch: /codex/,
        terminalRules: [],
        hooks: { type: "generic-status" },
      };

      const lookedUpIds: string[] = [];
      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "idle",
        tmuxPane: "%2",
        nativeSessionId: "native-codex-123",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: (session) => {
              lookedUpIds.push(session.nativeSessionId ?? session.id);
              return null;
            },
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      expect(lookedUpIds).toEqual(["native-codex-123"]);

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
    });
  });

  describe("subagent suppression", () => {
    it("skips stale pane inspection when session has active subagents", async () => {
      let paneInspected = false;
      mockDetectPaneState = async () => {
        paneInspected = true;
        return { state: "idle", attentionType: null, pendingTool: null };
      };

      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
        subagents: [
          {
            agentId: "sub-1",
            status: "working",
            attentionType: null,
            pendingTool: null,
            lastActivityAt: null,
            startedAt: null,
          },
        ],
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
      expect(paneInspected).toBe(false);
    });
  });

  describe("active pane state handling divergence", () => {
    it("native: downgrades active + wasWorking to idle", async () => {
      mockDetectPaneState = async () => ({
        state: "active",
        attentionType: null,
        pendingTool: null,
      });

      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
    });

    it("pane-tracked Claude: active state has no explicit handling (no update)", async () => {
      mockDetectPaneState = async () => ({
        state: "active",
        attentionType: null,
        pendingTool: null,
      });

      const id = makeSession(sessionManager, {
        agentType: "claude",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({ panes: [fakePane()] }),
      );

      const session = sessionManager.getSession(id)!;
      // Pane-tracked Claude has no "active" case, so status stays as-is
      expect(session.status).toBe("working");
    });
  });

  describe("native Claude: no-PID mtime safety net", () => {
    it("uses log file mtime to resolve state when PID is unknown", async () => {
      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: null,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      // Mtime older than NO_PID_SAFETY_TIMEOUT_MS (10min) triggers idle reset
      await reconcileAll(
        makeDeps(sessionManager, {
          getLogFileMtime: () => Date.now() - 15 * 60_000,
        }),
        makeSnapshot(),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
    });

    it("missing or unreadable log file (null mtime) resets to idle", async () => {
      // Regression for the far-future sentinel bypass: `readLogFileMtime`
      // normalizes Bun's missing-file sentinel (2 ** 52 - 1; Bun does not
      // throw) to null, and a null mtime means the log will never append
      // again, so the no-PID safety net must idle the session instead of
      // reading the sentinel as fresh activity and deadlocking on "working".
      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: null,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          getLogFileMtime: () => null,
        }),
        makeSnapshot(),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
    });
  });

  describe("recently processed sessions", () => {
    it("skips native reconciliation when session was recently processed", async () => {
      let paneInspected = false;
      mockDetectPaneState = async () => {
        paneInspected = true;
        return { state: "idle", attentionType: null, pendingTool: null };
      };

      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          watcher: { isRecentlyProcessed: () => true },
        }),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
      expect(paneInspected).toBe(false);
    });

    it("skips pane-tracked Claude reconciliation when session was recently processed", async () => {
      let paneInspected = false;
      mockDetectPaneState = async () => {
        paneInspected = true;
        return { state: "idle", attentionType: null, pendingTool: null };
      };

      const id = makeSession(sessionManager, {
        agentType: "claude",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          watcher: { isRecentlyProcessed: () => true },
        }),
        makeSnapshot({ panes: [fakePane()] }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
      expect(paneInspected).toBe(false);
    });
  });

  describe("fresh activity skips pane inspection", () => {
    it("does not inspect pane when lastActivityAt is within threshold", async () => {
      let paneInspected = false;
      mockDetectPaneState = async () => {
        paneInspected = true;
        return { state: "idle", attentionType: null, pendingTool: null };
      };

      const FIVE_SECONDS_AGO = new Date(Date.now() - 5_000).toISOString();

      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: FIVE_SECONDS_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
      expect(paneInspected).toBe(false);
    });

    it("uses injected now() for staleness check", async () => {
      let paneInspected = false;
      mockDetectPaneState = async () => {
        paneInspected = true;
        return { state: "idle", attentionType: null, pendingTool: null };
      };

      const activityTime = new Date("2024-01-15T12:00:00Z").getTime();

      const id = makeSession(sessionManager, {
        status: "working",
        trackingMode: "native",
        pid: 12345,
        tmuxPane: "%1",
        lastActivityAt: new Date(activityTime).toISOString(),
      });

      // Inject now() to be 5 seconds after activity (within 30s threshold)
      await reconcileAll(
        makeDeps(sessionManager, {
          now: () => activityTime + 5_000,
        }),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
      expect(paneInspected).toBe(false);
    });
  });

  describe("pane-tracked Claude: waiting from pane", () => {
    it("detects waiting state from pane inspection", async () => {
      mockDetectPaneState = async () => ({
        state: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
      });

      const id = makeSession(sessionManager, {
        agentType: "claude",
        trackingMode: "pane",
        status: "idle",
        tmuxPane: "%1",
        lastActivityAt: TWO_MINUTES_AGO,
      });

      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({ panes: [fakePane()] }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("waiting");
      expect(session.attentionType).toBe("permission");
      expect(session.pendingTool).toBe("Bash");
    });
  });

  describe("pane-tracked agent: hook idle status", () => {
    it("maps hook idle status to idle", async () => {
      const codexAgent: AgentDef = {
        name: "codex",
        shortCode: "CX",
        processMatch: /codex/,
        terminalRules: [],
        hooks: { type: "generic-status" },
      };

      const id = makeSession(sessionManager, {
        agentType: "codex",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%2",
      });

      await reconcileAll(
        makeDeps(sessionManager, {
          hookManager: {
            getMarkerForSession: () => ({
              agent_type: "codex",
              pid: 1,
              tty: "/dev/ttys002",
              session_id: "native-codex",
              timestamp: 1,
              state: "idle",
              state_timestamp: Date.now() / 1000,
            }),
            getMarkersByAgentAndPid: () => [],
          },
          agents: [codexAgent],
        }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%2", tty: "ttys002" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("idle");
      expect(session.attentionType).toBeNull();
    });
  });

  describe("pane-tracked agent: unknown agent", () => {
    it("does nothing when agent is not in agents list", async () => {
      const id = makeSession(sessionManager, {
        agentType: "unknown-agent",
        trackingMode: "pane",
        status: "working",
        tmuxPane: "%3",
      });

      await reconcileAll(
        makeDeps(sessionManager, { agents: [] }),
        makeSnapshot({
          panes: [fakePane({ paneId: "%3", tty: "ttys003" })],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.status).toBe("working");
    });
  });

  describe("attention state reconciliation", () => {
    function makeAttentionDeps(activePaneId: string | null = null) {
      const { AttentionTracker } = require("./attention-tracker");
      const tracker = new AttentionTracker(15_000);
      return {
        attentionTracker: tracker,
        getActivePaneId: async () => activePaneId,
      };
    }

    it("should mark session as unread when working->idle and user not viewing", async () => {
      const id = makeSession(sessionManager, {
        status: "working",
        tmuxPane: "%1",
        pid: 12345,
        lastActivityAt: new Date().toISOString(),
      });

      // Simulate working -> idle transition
      sessionManager.updateSession(id, { status: "idle" });

      const attnDeps = makeAttentionDeps("%99"); // user is on a different pane

      await reconcileAll(
        makeDeps(sessionManager, attnDeps),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.attentionState).toBe("unread");
    });

    it("should mark session as read when working->idle and user IS viewing", async () => {
      const id = makeSession(sessionManager, {
        status: "working",
        tmuxPane: "%1",
        pid: 12345,
        lastActivityAt: new Date().toISOString(),
      });

      sessionManager.updateSession(id, { status: "idle" });

      const attnDeps = makeAttentionDeps("%1"); // user viewing this pane

      await reconcileAll(
        makeDeps(sessionManager, attnDeps),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.attentionState).toBe("read");
    });

    it("should NOT set attentionState for a background session on finish", async () => {
      // Background rows are paneless and read-only: the inbox/unread
      // semantics can never clear (no pane to view), so they must be
      // excluded from attention tracking; a finish must leave it null.
      const id = "sup-attn";
      sessionManager.createBackgroundSession({
        daemonShort: id,
        pid: 999,
        cwd: "/private/tmp",
        logPath: null,
        version: null,
        status: "working",
        attentionType: null,
        pendingTool: null,
        lastPrompt: null,
        lastActivityAt: new Date().toISOString(),
      });
      // working -> idle transition (sets previousStatus="working")
      sessionManager.updateSession(id, { status: "idle" });

      const attnDeps = makeAttentionDeps("%99"); // not viewing

      await reconcileAll(makeDeps(sessionManager, attnDeps), makeSnapshot());

      const session = sessionManager.getSession(id)!;
      expect(session.attentionState).toBeNull();
    });

    it("should NOT clobber a working background session's status on reconcile", async () => {
      // The `trackingMode !== "native"` guards keep a working background row
      // from being reaped to idle. Its pid is never in the snapshot, so an
      // empty snapshot is the regression trigger.
      const id = "sup-working";
      sessionManager.createBackgroundSession({
        daemonShort: id,
        pid: 4242, // deliberately absent from snapshot.processes
        cwd: "/private/tmp",
        logPath: null,
        version: null,
        status: "working",
        attentionType: null,
        pendingTool: null,
        lastPrompt: null,
        lastActivityAt: new Date().toISOString(),
      });

      await reconcileAll(makeDeps(sessionManager), makeSnapshot());

      const session = sessionManager.getSession(id);
      expect(session).toBeDefined();
      expect(session!.status).toBe("working");
    });

    it("should transition unread -> read when user views session", async () => {
      const id = makeSession(sessionManager, {
        status: "idle",
        tmuxPane: "%1",
      });
      sessionManager.setAttentionState(id, "unread");

      const attnDeps = makeAttentionDeps("%1"); // user now viewing

      await reconcileAll(
        makeDeps(sessionManager, attnDeps),
        makeSnapshot({ panes: [fakePane()] }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.attentionState).toBe("read");
    });

    it("should clear attention when new work starts", async () => {
      const id = makeSession(sessionManager, {
        status: "working",
        tmuxPane: "%1",
        pid: 12345,
        lastActivityAt: new Date().toISOString(),
      });
      sessionManager.setAttentionState(id, "unread");

      const attnDeps = makeAttentionDeps(null);

      await reconcileAll(
        makeDeps(sessionManager, attnDeps),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.attentionState).toBeNull();
    });

    it("should reset processedTransitions when new work starts with null attention", async () => {
      const id = makeSession(sessionManager, {
        status: "working",
        tmuxPane: "%1",
        pid: 12345,
        lastActivityAt: new Date().toISOString(),
      });

      // First cycle: working -> idle -> unread
      sessionManager.updateSession(id, { status: "idle" });
      const attnDeps = makeAttentionDeps("%99");
      const deps = makeDeps(sessionManager, attnDeps);

      await reconcileAll(
        deps,
        makeSnapshot({ processes: [fakeProcess()], panes: [fakePane()] }),
      );
      expect(sessionManager.getSession(id)!.attentionState).toBe("unread");

      // Simulate read decay: unread -> read -> null
      sessionManager.setAttentionState(id, null);

      // Second cycle: new work starts (attentionState is null)
      sessionManager.updateSession(id, { status: "working" });
      await reconcileAll(
        deps,
        makeSnapshot({ processes: [fakeProcess()], panes: [fakePane()] }),
      );

      // Third cycle: work finishes -> should trigger "done" again
      sessionManager.updateSession(id, { status: "idle" });
      await reconcileAll(
        deps,
        makeSnapshot({ processes: [fakeProcess()], panes: [fakePane()] }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.attentionState).toBe("unread");
    });

    it("should decay read -> null after timeout", async () => {
      const id = makeSession(sessionManager, {
        status: "idle",
        tmuxPane: "%1",
      });
      sessionManager.setAttentionState(id, "read");

      const attnDeps = makeAttentionDeps(null);
      const tracker = attnDeps.attentionTracker;
      tracker.markSeen(id);

      // Override shouldClearRead to simulate elapsed timeout
      const origShouldClear = tracker.shouldClearRead.bind(tracker);
      tracker.shouldClearRead = (sessionId: string) =>
        origShouldClear(sessionId, Date.now() + 20_000);

      await reconcileAll(
        makeDeps(sessionManager, attnDeps),
        makeSnapshot({ panes: [fakePane()] }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.attentionState).toBeNull();
    });

    it("should prune orphaned attention entries for removed sessions", async () => {
      const id = makeSession(sessionManager, {
        status: "idle",
        tmuxPane: "%1",
      });

      const attnDeps = makeAttentionDeps(null);
      const tracker = attnDeps.attentionTracker;

      // Seed tracker with an entry for a session that no longer exists
      tracker.markSeen("orphaned-session", false);

      await reconcileAll(
        makeDeps(sessionManager, attnDeps),
        makeSnapshot({ panes: [fakePane()] }),
      );

      // The orphaned entry should be pruned; the active session's entry should remain
      // Verify by checking that a second prune finds nothing to remove
      const activeIds = new Set([id]);
      expect(tracker.prune(activeIds)).toBe(false);
    });

    it("should not affect sessions without attentionTracker in deps", async () => {
      const id = makeSession(sessionManager, {
        status: "working",
        tmuxPane: "%1",
        pid: 12345,
        lastActivityAt: new Date().toISOString(),
      });
      sessionManager.updateSession(id, { status: "idle" });

      // No attentionTracker in deps
      await reconcileAll(
        makeDeps(sessionManager),
        makeSnapshot({
          processes: [fakeProcess()],
          panes: [fakePane()],
        }),
      );

      const session = sessionManager.getSession(id)!;
      expect(session.attentionState).toBeNull(); // unchanged
    });
  });
});

describe("collectPaneTrackedSources (wiring)", () => {
  function makeCollectorDeps(opts: {
    marker?: SessionPidMarker | null;
    siblings?: SessionPidMarker[];
    hasLogAdapter?: boolean;
    now?: () => number;
    getLogFileMtime?: (logPath: string) => number | null;
  }): Pick<
    ReconcilerDeps,
    "hookManager" | "logAdapters" | "now" | "getLogFileMtime"
  > {
    const logAdapters = new Map<string, LogAdapter>();
    if (opts.hasLogAdapter) {
      logAdapters.set("claude", {} as LogAdapter);
      logAdapters.set("codex", {} as LogAdapter);
    }
    return {
      hookManager: {
        getMarkerForSession: () => opts.marker ?? null,
        getMarkersByAgentAndPid: () => opts.siblings ?? [],
      },
      logAdapters,
      now: opts.now ?? (() => Date.now()),
      getLogFileMtime: opts.getLogFileMtime ?? (() => 0),
    };
  }

  function makeMarker(
    overrides: Partial<SessionPidMarker> = {},
  ): SessionPidMarker {
    return {
      agent_type: "claude",
      pid: 1234,
      session_id: "sess-1",
      timestamp: 1_700_000_000,
      state_timestamp: 1_700_000_500,
      state: "idle",
      ...overrides,
    };
  }

  function makePaneSession(overrides: Partial<Session> = {}): Session {
    return {
      id: "claude_pane1",
      agentType: "claude",
      trackingMode: "pane",
      project: "proj",
      cwd: "/x",
      logPath: null,
      status: "idle",
      attentionType: null,
      pendingTool: null,
      inPlanMode: false,
      tmuxPane: "%1",
      updatedAt: new Date(),
      lastActivityAt: null,
      lastUserInputAt: null,
      subagents: [],
      gitBranch: null,
      version: null,
      pid: 1234,
      statusChangedAt: null,
      previousStatus: null,
      attentionState: null,
      lastSeenAt: null,
      lastPrompt: null,
      prompts: [],
      ...overrides,
    };
  }

  it("no marker, no log adapter, no rule -> zero sources", () => {
    const { sources, metadata } = collectPaneTrackedSources(
      makeCollectorDeps({}),
      makePaneSession(),
      null,
    );
    expect(sources).toHaveLength(0);
    expect(metadata).toEqual({});
  });

  it("marker only (generic agent) -> single marker source + metadata bundle", () => {
    const marker = makeMarker({
      state: "waiting_permission",
      pending_tool: "Bash",
    });
    const { sources, metadata } = collectPaneTrackedSources(
      makeCollectorDeps({ marker }),
      makePaneSession(),
      null,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe("marker");
    expect(sources[0].state.status).toBe("waiting");
    expect(sources[0].state.attentionType).toBe("permission");
    expect(sources[0].state.pendingTool).toBe("Bash");
    expect(metadata).toEqual({});
  });

  it("opencode marker -> aggregates siblings into a single marker source", () => {
    const baseSibling = (o: Partial<SessionPidMarker>): SessionPidMarker => ({
      agent_type: "opencode",
      pid: 9000,
      session_id: o.session_id ?? "s",
      timestamp: 1_700_000_000,
      state_timestamp: 1_700_000_100,
      state: "idle",
      ...o,
    });
    const marker = baseSibling({ session_id: "a", state: "idle" });
    const siblings = [
      marker,
      baseSibling({
        session_id: "b",
        state: "waiting_permission",
        pending_tool: "Edit",
      }),
    ];
    const { sources, metadata } = collectPaneTrackedSources(
      makeCollectorDeps({ marker, siblings }),
      makePaneSession({ agentType: "opencode", id: "opencode_pane1" }),
      null,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].state.status).toBe("waiting");
    expect(sources[0].state.pendingTool).toBe("Edit");
    // Aggregator emits lastPrompt: null for stale-clear semantics.
    expect("lastPrompt" in metadata).toBe(true);
  });

  it("log adapter present -> log source pushed even without lastActivityAt", () => {
    const { sources } = collectPaneTrackedSources(
      makeCollectorDeps({ hasLogAdapter: true }),
      makePaneSession({ lastActivityAt: null }),
      null,
    );
    expect(sources.some((s) => s.name === "log")).toBe(true);
  });

  it("terminal-only signal -> baseline terminal source (no canUpgrade)", () => {
    const { sources } = collectPaneTrackedSources(
      makeCollectorDeps({}),
      makePaneSession(),
      { status: "waiting", attentionType: "permission", pendingTool: "Bash" },
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe("terminal");
    expect(sources[0].canUpgrade).toBeUndefined();
  });

  it("terminal source is upgrade-only when a marker is also present", () => {
    const marker = makeMarker({ state: "working" });
    const { sources } = collectPaneTrackedSources(
      makeCollectorDeps({ marker }),
      makePaneSession(),
      { status: "waiting", attentionType: "permission", pendingTool: "Bash" },
    );
    const terminal = sources.find((s) => s.name === "terminal");
    expect(terminal?.canUpgrade).toEqual(["waiting"]);
  });

  it("terminal source is upgrade-only when log adapter is registered (even without marker)", () => {
    const { sources } = collectPaneTrackedSources(
      makeCollectorDeps({ hasLogAdapter: true }),
      makePaneSession(),
      { status: "waiting", attentionType: "permission", pendingTool: "Bash" },
    );
    const terminal = sources.find((s) => s.name === "terminal");
    expect(terminal?.canUpgrade).toEqual(["waiting"]);
  });

  it("marker + log adapter + terminal -> all three sources in cascade", () => {
    const marker = makeMarker({ state: "working" });
    const { sources } = collectPaneTrackedSources(
      makeCollectorDeps({ marker, hasLogAdapter: true }),
      makePaneSession({
        status: "working",
        lastActivityAt: "2026-05-17T10:00:00.000Z",
      }),
      { status: "waiting", attentionType: "permission", pendingTool: "Edit" },
    );
    const kinds = sources.map((s) => s.name).sort();
    expect(kinds).toEqual(["log", "marker", "terminal"]);
  });

  describe("stale-log convergence (no-hooks codex stuck at working)", () => {
    const NOW = Date.parse("2026-07-03T12:00:00.000Z");
    const STALE_MTIME = NOW - PANE_IDLE_THRESHOLD_MS - 1_000;
    const FRESH_MTIME = NOW - PANE_IDLE_THRESHOLD_MS + 5_000;

    function stuckWorkingSession(overrides: Partial<Session> = {}): Session {
      // The repro state: rollout linked after the turn already completed,
      // log-derived status frozen at working, no marker, pane shows no
      // working/waiting indicators (null rule match).
      return makePaneSession({
        id: "codex_pane1",
        agentType: "codex",
        status: "working",
        logPath: "/Users/test/.codex/sessions/2026/07/03/rollout-x.jsonl",
        lastActivityAt: new Date(STALE_MTIME).toISOString(),
        ...overrides,
      });
    }

    it("null rule + markerless + silent log -> synthetic idle baseline that wins the cascade", () => {
      const { sources } = collectPaneTrackedSources(
        makeCollectorDeps({
          hasLogAdapter: true,
          now: () => NOW,
          getLogFileMtime: () => STALE_MTIME,
        }),
        stuckWorkingSession(),
        null,
      );

      const terminal = sources.find((s) => s.name === "terminal");
      expect(terminal).toBeDefined();
      expect(terminal!.state.status).toBe("idle");
      expect(terminal!.canUpgrade).toBeUndefined();
      expect(terminal!.timestamp).toBe(NOW);

      const resolved = evaluateCascade(sources);
      expect(resolved.status).toBe("idle");
      expect(resolved.attentionType).toBeNull();
      expect(resolved.pendingTool).toBeNull();
    });

    it("fresh log -> no synthetic source; log-derived working stands", () => {
      const { sources } = collectPaneTrackedSources(
        makeCollectorDeps({
          hasLogAdapter: true,
          now: () => NOW,
          getLogFileMtime: () => FRESH_MTIME,
        }),
        stuckWorkingSession(),
        null,
      );
      expect(sources.map((s) => s.name)).toEqual(["log"]);
      expect(evaluateCascade(sources).status).toBe("working");
    });

    it("unlinked session (logPath null) -> no synthetic source", () => {
      const { sources } = collectPaneTrackedSources(
        makeCollectorDeps({
          hasLogAdapter: true,
          now: () => NOW,
          getLogFileMtime: () => STALE_MTIME,
        }),
        stuckWorkingSession({ logPath: null }),
        null,
      );
      expect(sources.map((s) => s.name)).toEqual(["log"]);
    });

    it("marker-backed session -> no synthetic source even with a silent log", () => {
      const marker = makeMarker({ agent_type: "codex", state: "working" });
      const { sources } = collectPaneTrackedSources(
        makeCollectorDeps({
          marker,
          hasLogAdapter: true,
          now: () => NOW,
          getLogFileMtime: () => STALE_MTIME,
        }),
        stuckWorkingSession(),
        null,
      );
      expect(sources.map((s) => s.name).sort()).toEqual(["log", "marker"]);
    });

    it("matched rule takes the normal upgrade-only path instead of the synthetic source", () => {
      const { sources } = collectPaneTrackedSources(
        makeCollectorDeps({
          hasLogAdapter: true,
          now: () => NOW,
          getLogFileMtime: () => STALE_MTIME,
        }),
        stuckWorkingSession(),
        { status: "working", attentionType: null, pendingTool: null },
      );
      const terminal = sources.find((s) => s.name === "terminal");
      expect(terminal?.canUpgrade).toEqual(["waiting"]);
      // The working rule match is evidence the turn is live: no downgrade.
      expect(evaluateCascade(sources).status).toBe("working");
    });

    it("missing or unreadable log file (null mtime) counts as silent", () => {
      // The prod `getLogFileMtime` (`readLogFileMtime`) normalizes Bun's
      // far-future missing-file sentinel to null at the wiring site, so a
      // null here is the "missing" signal every consumer sees.
      const { sources } = collectPaneTrackedSources(
        makeCollectorDeps({
          hasLogAdapter: true,
          now: () => NOW,
          getLogFileMtime: () => null,
        }),
        stuckWorkingSession(),
        null,
      );
      expect(evaluateCascade(sources).status).toBe("idle");
    });
  });
});

describe("readLogFileMtime", () => {
  it("returns null for a missing file (Bun yields a far-future sentinel, not a throw)", () => {
    const missing = join(tempRoot, "does-not-exist.jsonl");
    // Document the raw Bun behavior the helper normalizes: a missing file
    // reads as the 2 ** 52 - 1 sentinel, not 0, and does not throw.
    expect(Bun.file(missing).lastModified).toBe(2 ** 52 - 1);
    expect(readLogFileMtime(missing)).toBeNull();
  });

  it("returns the real mtime for an existing file", async () => {
    const path = join(tempRoot, "read-log-file-mtime-real.jsonl");
    await Bun.write(path, "{}\n");
    const mtime = readLogFileMtime(path);
    expect(mtime).not.toBeNull();
    expect(mtime!).toBeGreaterThan(0);
    expect(mtime!).toBeLessThanOrEqual(Date.now());
  });
});

describe("native cascade (Claude + Codex)", () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
    mockDetectPaneState = async () => ({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
    mockCapturePane = async () => "";
  });

  function mkNativeMarker(
    sessionId: string,
    overrides: Partial<SessionPidMarker> = {},
  ): SessionPidMarker {
    return {
      agent_type: "claude",
      pid: 12345,
      session_id: sessionId,
      timestamp: 1_700_000_000,
      state_timestamp: 1_700_001_000,
      state: "idle",
      ...overrides,
    };
  }

  // Use a PID that matches the process in the snapshot AND a recent
  // lastActivityAt so the dead-process / stale-pane recovery paths in
  // resolveNativeClaudeStates don't preempt the cascade.
  const ALIVE_PID = 99999;
  const FRESH_ACTIVITY = new Date(Date.now() - 5_000).toISOString();

  function setupNative(
    id: string,
    agentType: "claude" | "codex",
    state: Partial<{
      status: "working" | "waiting" | "idle";
      attentionType: "permission" | "question" | "plan_approval" | null;
      pendingTool: string | null;
      lastActivityAt: string | null;
    }> = {},
  ): void {
    sessionManager.createSession(id, "/p.jsonl", agentType);
    sessionManager.setPid(id, ALIVE_PID);
    sessionManager.updateSession(id, {
      status: state.status ?? "working",
      attentionType: state.attentionType ?? null,
      pendingTool: state.pendingTool ?? null,
      lastActivityAt: state.lastActivityAt ?? FRESH_ACTIVITY,
    });
  }

  function setupPaneTrackedClaude(
    paneId: string,
    pid: number,
    nativeSessionId: string | undefined,
    state: Partial<{
      status: "working" | "waiting" | "idle";
      attentionType: "permission" | "question" | "plan_approval" | null;
      pendingTool: string | null;
      lastActivityAt: string | null;
    }> = {},
  ): string {
    const id = sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId,
      cwd: "/x",
      pid,
      nativeSessionId,
    }).id;
    sessionManager.updateSession(id, {
      status: state.status ?? "working",
      attentionType: state.attentionType ?? null,
      pendingTool: state.pendingTool ?? null,
      lastActivityAt: state.lastActivityAt ?? FRESH_ACTIVITY,
    });
    return id;
  }

  // Returns a stub that only feeds the marker to the pane-tracked arm —
  // the native arm filters pane-tracked sessions out before it ever calls
  // `getMarkerForSession`. Encoding the filter in the stub makes the
  // intent of "this marker is for the pane-tracked path" explicit.
  function paneOnlyMarker(
    marker: SessionPidMarker,
  ): (session: Session) => SessionPidMarker | null {
    return (session) => (session.trackingMode === "pane" ? marker : null);
  }

  it("marker absent: cascade falls back to log only, session preserves status", async () => {
    const id = "native-claude-1";
    setupNative(id, "claude", { status: "working", pendingTool: null });

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: () => null,
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({ processes: [fakeProcess({ pid: ALIVE_PID })] }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("working");
    expect(session.attentionType).toBeNull();
    expect(session.pendingTool).toBeNull();
  });

  it("marker waiting_permission overlays log working, preserves session.pendingTool", async () => {
    const id = "native-claude-2";
    setupNative(id, "claude", { status: "working", pendingTool: "Bash" });

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: () =>
            mkNativeMarker(id, {
              state: "waiting_permission",
              state_timestamp: Date.now() / 1000,
            }),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({ processes: [fakeProcess({ pid: ALIVE_PID })] }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("waiting");
    expect(session.attentionType).toBe("permission");
    expect(session.pendingTool).toBe("Bash");
  });

  it("marker state=idle clears attention/pendingTool (Notification idle_prompt path)", async () => {
    const id = "native-claude-3";
    setupNative(id, "claude", {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
    });

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: () =>
            mkNativeMarker(id, {
              state: "idle",
              state_timestamp: Date.now() / 1000,
            }),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({ processes: [fakeProcess({ pid: ALIVE_PID })] }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("idle");
    expect(session.attentionType).toBeNull();
    expect(session.pendingTool).toBeNull();
  });

  it("log fresher than marker: log state wins", async () => {
    const id = "native-claude-4";
    // Log is "now"; marker is 5s in the past.
    setupNative(id, "claude", {
      status: "working",
      pendingTool: "Edit",
      lastActivityAt: new Date(Date.now()).toISOString(),
    });

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: () =>
            mkNativeMarker(id, {
              state: "waiting_permission",
              state_timestamp: Date.now() / 1000 - 5,
            }),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({ processes: [fakeProcess({ pid: ALIVE_PID })] }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("working");
    expect(session.attentionType).toBeNull();
    expect(session.pendingTool).toBe("Edit");
  });

  it("works for native Codex, marker.pending_tool winning over the log", async () => {
    const id = "native-codex-1";
    setupNative(id, "codex", {
      status: "working",
      pendingTool: "ApplyPatch",
    });

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: () => ({
            agent_type: "codex",
            pid: 12345,
            session_id: id,
            timestamp: 1_700_000_000,
            state_timestamp: Date.now() / 1000,
            state: "waiting_permission",
            pending_tool: "MarkerTool",
          }),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: ALIVE_PID, agentType: "codex" })],
      }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("waiting");
    expect(session.attentionType).toBe("permission");
    // nativeMarkerSource now prefers marker.pending_tool (the hook's authoritative
    // signal) and falls back to the log-derived session.pendingTool only when the
    // marker omits it. See cascade-evaluator.ts nativeMarkerSource.
    expect(session.pendingTool).toBe("MarkerTool");
  });

  it("pane-tracked Claude routes through the pane reconciler (native cascade arm skips it)", async () => {
    const id = setupPaneTrackedClaude("%50", 99999, undefined, {
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "2026-05-17T10:00:00.000Z",
    });

    let nativeArmGetMarker = 0;
    let paneArmGetMarker = 0;
    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: (s) => {
            // The pane-tracked Claude arm reads the marker.
            // The native arm filters by trackingMode === "native", so it
            // never reaches getMarkerForSession for this session.
            if (s.trackingMode === "pane") paneArmGetMarker += 1;
            else nativeArmGetMarker += 1;
            return null;
          },
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: 99999 })],
        panes: [fakePane({ paneId: "%50" })],
      }),
    );

    expect(nativeArmGetMarker).toBe(0);
    expect(paneArmGetMarker).toBeGreaterThan(0);
    // No marker → cascade does not run → existing pane-detection
    // fall-through preserves the session's prior state.
    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("working");
  });

  it("pane-tracked Claude with fresh waiting_permission marker keeps log-derived pendingTool", async () => {
    // Locks the regression the read-time overlay used to mask: when the
    // hook marker is fresher than log activity, the cascade applies the
    // marker state, but session.pendingTool (set by the log adapter from
    // a Bash tool_use) must survive the overlay. `nativeMarkerSource`
    // peeks session.pendingTool for waiting_permission; using
    // `genericMarkerSource` here would clobber it to null because the
    // Claude `Notification` hook does not write `pending_tool`.
    const id = setupPaneTrackedClaude("%51", 88888, "claude-uuid", {
      pendingTool: "Bash",
      lastActivityAt: "2026-05-17T10:00:00.000Z",
    });
    const markerSec = new Date("2026-05-17T10:00:30.000Z").getTime() / 1000;

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: paneOnlyMarker(
            mkNativeMarker("claude-uuid", {
              pid: 88888,
              state: "waiting_permission",
              state_timestamp: markerSec,
              timestamp: markerSec,
            }),
          ),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: 88888 })],
        panes: [fakePane({ paneId: "%51" })],
      }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("waiting");
    expect(session.attentionType).toBe("permission");
    expect(session.pendingTool).toBe("Bash");
  });

  it("pane-tracked Claude with fresh idle marker clears attention/pendingTool", async () => {
    // The Notification idle_prompt path. Confirms the cascade applies a
    // fresh idle marker to a previously-waiting pane-tracked Claude session
    // and clears attention/pendingTool in the same write — matches the
    // read-time overlay's `state === "idle"` branch.
    const id = setupPaneTrackedClaude("%53", 66666, "claude-uuid-3", {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
      lastActivityAt: "2026-05-17T10:00:00.000Z",
    });
    const markerSec = new Date("2026-05-17T10:00:30.000Z").getTime() / 1000;

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: paneOnlyMarker(
            mkNativeMarker("claude-uuid-3", {
              pid: 66666,
              state: "idle",
              state_timestamp: markerSec,
              timestamp: markerSec,
            }),
          ),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: 66666 })],
        panes: [fakePane({ paneId: "%53" })],
      }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("idle");
    expect(session.attentionType).toBeNull();
    expect(session.pendingTool).toBeNull();
  });

  it("pane-tracked Claude with marker missing 'state' field falls through to pane detection", async () => {
    // The deleted overlay required BOTH marker.state AND state_timestamp;
    // the cascade branch guards on the same pair so a partial marker
    // (e.g. mid-write or a hook that only stamped a timestamp) does not
    // synthesise an idle source from `nativeMarkerSource`'s default branch.
    mockDetectPaneState = async () => ({
      state: "plan_approval",
      attentionType: "plan_approval",
      pendingTool: null,
    });
    const id = setupPaneTrackedClaude("%54", 55555, "claude-uuid-4", {
      status: "working",
      pendingTool: null,
      lastActivityAt: TWO_MINUTES_AGO,
    });
    const markerSec = Date.now() / 1000;

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: paneOnlyMarker({
            agent_type: "claude",
            pid: 55555,
            session_id: "claude-uuid-4",
            timestamp: markerSec,
            state_timestamp: markerSec,
            // No `state` field on purpose.
          }),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: 55555 })],
        panes: [fakePane({ paneId: "%54" })],
      }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("waiting");
    expect(session.attentionType).toBe("plan_approval");
    expect(session.inPlanMode).toBe(true);
  });

  it("pane-tracked Claude with stale marker falls through to pane detection", async () => {
    mockDetectPaneState = async () => ({
      state: "plan_approval",
      attentionType: "plan_approval",
      pendingTool: null,
    });
    const id = setupPaneTrackedClaude("%52", 77777, "claude-uuid-2", {
      status: "working",
      pendingTool: null,
      lastActivityAt: TWO_MINUTES_AGO,
    });
    // Marker is OLDER than session.lastActivityAt → cascade no-ops →
    // pane detection runs and detects plan_approval.
    const oldMarkerSec = new Date(TWO_MINUTES_AGO).getTime() / 1000 - 60;

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: paneOnlyMarker(
            mkNativeMarker("claude-uuid-2", {
              pid: 77777,
              state: "idle",
              state_timestamp: oldMarkerSec,
              timestamp: oldMarkerSec,
            }),
          ),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: 77777 })],
        panes: [fakePane({ paneId: "%52" })],
      }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("waiting");
    expect(session.attentionType).toBe("plan_approval");
    expect(session.inPlanMode).toBe(true);
  });

  it("pane-tracked Claude with marker timestamp equal to lastActivityAt falls through to pane detection", async () => {
    // The branch uses strict `>` so equal timestamps fall through, matching
    // the deleted overlay. Pin this against a future `>=` regression: with
    // `>=`, the marker would synthesise an idle overlay on top of an
    // equally-fresh log activity, silently masking pane-detected state.
    mockDetectPaneState = async () => ({
      state: "plan_approval",
      attentionType: "plan_approval",
      pendingTool: null,
    });
    const lastActivity = "2026-05-17T10:00:00.000Z";
    const equalSec = new Date(lastActivity).getTime() / 1000;
    const id = setupPaneTrackedClaude("%57", 22222, "claude-uuid-7", {
      status: "working",
      pendingTool: null,
      lastActivityAt: lastActivity,
    });

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: paneOnlyMarker(
            mkNativeMarker("claude-uuid-7", {
              pid: 22222,
              state: "idle",
              state_timestamp: equalSec,
              timestamp: equalSec,
            }),
          ),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: 22222 })],
        panes: [fakePane({ paneId: "%57" })],
      }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("waiting");
    expect(session.attentionType).toBe("plan_approval");
    expect(session.inPlanMode).toBe(true);
  });

  it("pane-tracked Claude with no lastActivityAt applies a fresh marker", async () => {
    // The deleted overlay used `logState.lastActivityAt ? ... : 0`, so any
    // positive marker timestamp beat a missing log activity. The new branch
    // mirrors this via `session.lastActivityAt ? ... : 0` — pin the contract
    // so a future refactor doesn't accidentally require log activity.
    //
    // Bypasses `setupPaneTrackedClaude` because the helper always populates
    // `lastActivityAt` via `updateSession`; `createPaneTrackedSession` leaves
    // it `null` by default. Passing `lastActivityAt: undefined` explicitly
    // suppresses `updateSession`'s status-change auto-set so the field stays
    // null.
    const id = sessionManager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%55",
      cwd: "/x",
      pid: 44444,
      nativeSessionId: "claude-uuid-5",
    }).id;
    sessionManager.updateSession(id, {
      status: "working",
      pendingTool: "Bash",
      lastActivityAt: undefined,
    });
    const markerSec = Date.now() / 1000;

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: paneOnlyMarker(
            mkNativeMarker("claude-uuid-5", {
              pid: 44444,
              state: "idle",
              state_timestamp: markerSec,
              timestamp: markerSec,
            }),
          ),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: 44444 })],
        panes: [fakePane({ paneId: "%55" })],
      }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("idle");
    expect(session.attentionType).toBeNull();
    expect(session.pendingTool).toBeNull();
  });

  it("pane-tracked Claude with marker missing 'state_timestamp' field falls through to pane detection", async () => {
    // Mirror of the "missing state" test. The guard is `marker?.state &&
    // marker.state_timestamp != null`, so both halves of a partial marker
    // must skip the cascade. Without this, `marker.state_timestamp * 1000`
    // would be `NaN`, the `NaN > lastActivityMs` comparison would be `false`,
    // and the branch would silently skip — but the cascade would still be
    // skipped by the wrong condition. Pin the explicit guard instead.
    mockDetectPaneState = async () => ({
      state: "plan_approval",
      attentionType: "plan_approval",
      pendingTool: null,
    });
    const id = setupPaneTrackedClaude("%56", 33333, "claude-uuid-6", {
      status: "working",
      pendingTool: null,
      lastActivityAt: TWO_MINUTES_AGO,
    });
    const markerSec = Date.now() / 1000;

    await reconcileAll(
      makeDeps(sessionManager, {
        hookManager: {
          getMarkerForSession: paneOnlyMarker({
            agent_type: "claude",
            pid: 33333,
            session_id: "claude-uuid-6",
            timestamp: markerSec,
            state: "idle",
            // No `state_timestamp` field on purpose.
          }),
          getMarkersByAgentAndPid: () => [],
        },
        agents: [],
      }),
      makeSnapshot({
        processes: [fakeProcess({ pid: 33333 })],
        panes: [fakePane({ paneId: "%56" })],
      }),
    );

    const session = sessionManager.getSession(id)!;
    expect(session.status).toBe("waiting");
    expect(session.attentionType).toBe("plan_approval");
    expect(session.inPlanMode).toBe(true);
  });
});

describe("reconcileOne (marker-event path)", () => {
  // The daemon resolves a marker event's session via
  // `SessionManager.resolveSessionForMarkerEvent` (priority covered in
  // sessions.test.ts) and hands it to `reconcileOne`. These tests pin
  // the post-resolution behavior for each pane-tracked agent: real
  // SessionManager, fresh marker, single immediate-reconcile call,
  // session state visibly updated by the cascade.
  //
  // Note on `skipDebounce`: the daemon passes `skipDebounce: true` to
  // `reconcileOne` for marker-event reconciles, but the pane-tracked
  // branch of `reconcileOne` (`reconcilePaneTrackedAgentSession`) does
  // not honor the option today (only the native branch does). These
  // tests therefore omit it. If the pane-tracked branch later starts
  // honoring it, add coverage here.

  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
    mockDetectPaneState = async () => ({
      state: "active",
      attentionType: null,
      pendingTool: null,
    });
    mockCapturePane = async () => "";
  });

  function buildDeps(marker: SessionPidMarker | null): ReconcilerDeps {
    const stubAgent = (name: string): AgentDef => ({
      name,
      shortCode: name.slice(0, 2),
      processMatch: new RegExp(`^${name}$`),
      terminalRules: [],
      hooks: { type: name },
    });
    return makeDeps(sessionManager, {
      hookManager: {
        getMarkerForSession: () => marker,
        getMarkersByAgentAndPid: () => (marker ? [marker] : []),
      },
      agents: [stubAgent("cursor"), stubAgent("codex"), stubAgent("opencode")],
    });
  }

  it("pane-tracked Cursor: marker waiting_permission flows through reconcileOne", async () => {
    const session = sessionManager.createPaneTrackedSession({
      agentType: "cursor",
      paneId: "%1",
      cwd: "/x",
      pid: 1234,
      nativeSessionId: "cursor-uuid",
    });
    const marker: SessionPidMarker = {
      agent_type: "cursor",
      pid: 1234,
      tty: "ttys001",
      session_id: "cursor-uuid",
      timestamp: Date.now() / 1000,
      state_timestamp: Date.now() / 1000,
      state: "waiting_permission",
      pending_tool: "Command",
    };
    const paneById = new Map<string, TmuxPane>([
      ["%1", fakePane({ paneId: "%1", currentCommand: "cursor-agent" })],
    ]);

    await reconcileOne(buildDeps(marker), session, paneById);

    const updated = sessionManager.getSession(session.id)!;
    expect(updated.status).toBe("waiting");
    expect(updated.attentionType).toBe("permission");
    expect(updated.pendingTool).toBe("Command");
  });

  it("pane-tracked Codex: marker waiting_permission flows through reconcileOne", async () => {
    const session = sessionManager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%2",
      cwd: "/x",
      pid: 2345,
      nativeSessionId: "codex-rollout",
    });
    const marker: SessionPidMarker = {
      agent_type: "codex",
      pid: 2345,
      tty: "ttys002",
      session_id: "codex-rollout",
      timestamp: Date.now() / 1000,
      state_timestamp: Date.now() / 1000,
      state: "waiting_permission",
      pending_tool: "Bash",
    };
    const paneById = new Map<string, TmuxPane>([
      ["%2", fakePane({ paneId: "%2", currentCommand: "codex" })],
    ]);

    await reconcileOne(buildDeps(marker), session, paneById);

    const updated = sessionManager.getSession(session.id)!;
    expect(updated.status).toBe("waiting");
    expect(updated.attentionType).toBe("permission");
    expect(updated.pendingTool).toBe("Bash");
  });

  it("pane-tracked OpenCode: winning-marker waiting_permission flows through reconcileOne", async () => {
    const session = sessionManager.createPaneTrackedSession({
      agentType: "opencode",
      paneId: "%3",
      cwd: "/x",
      pid: 3456,
      nativeSessionId: "ses_winner",
    });
    const marker: SessionPidMarker = {
      agent_type: "opencode",
      pid: 3456,
      session_id: "ses_winner",
      timestamp: Date.now() / 1000,
      state_timestamp: Date.now() / 1000,
      state: "waiting_permission",
      pending_tool: "external_directory",
    };
    const paneById = new Map<string, TmuxPane>([
      ["%3", fakePane({ paneId: "%3", currentCommand: "opencode" })],
    ]);

    await reconcileOne(buildDeps(marker), session, paneById);

    const updated = sessionManager.getSession(session.id)!;
    expect(updated.status).toBe("waiting");
    expect(updated.attentionType).toBe("permission");
    expect(updated.pendingTool).toBe("external_directory");
  });
});

describe("capStaleSubagents", () => {
  const STALE = new Date(Date.now() - 4 * 60_000).toISOString();
  const FRESH = new Date(Date.now() - 30_000).toISOString();

  function subagent(
    overrides: Partial<Session["subagents"][number]> = {},
  ): Session["subagents"][number] {
    return {
      agentId: "sub-1",
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastActivityAt: FRESH,
      startedAt: null,
      ...overrides,
    };
  }

  it("downgrades a working subagent whose log went silent past the threshold", () => {
    const manager = new SessionManager();
    const id = makeSession(manager, {
      status: "idle",
      subagents: [subagent({ lastActivityAt: STALE })],
    });

    capStaleSubagents(makeDeps(manager));

    // Idle subagents are filtered out by updateSubagent, so the downgrade
    // manifests as removal.
    expect(manager.getSession(id)!.subagents).toHaveLength(0);
  });

  it("keeps a recently active working subagent", () => {
    const manager = new SessionManager();
    const id = makeSession(manager, {
      status: "idle",
      subagents: [subagent({ lastActivityAt: FRESH })],
    });

    capStaleSubagents(makeDeps(manager));

    const subs = manager.getSession(id)!.subagents;
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe("working");
  });

  it("downgrades only the stale subagent when fresh and stale coexist", () => {
    const manager = new SessionManager();
    const id = makeSession(manager, {
      status: "idle",
      subagents: [
        subagent({ agentId: "sub-stale", lastActivityAt: STALE }),
        subagent({ agentId: "sub-fresh", lastActivityAt: FRESH }),
      ],
    });

    capStaleSubagents(makeDeps(manager));

    const subs = manager.getSession(id)!.subagents;
    expect(subs.map((s) => s.agentId)).toEqual(["sub-fresh"]);
  });

  it("downgrades stale waiting subagents like working ones", () => {
    // A subagent's waiting is an unresolved tool_use, which a killed agent
    // exhibits forever; since waiting counts as activity in
    // getEffectiveStatus, a frozen one must not lift its parent forever.
    const manager = new SessionManager();
    const id = makeSession(manager, {
      status: "idle",
      subagents: [
        subagent({
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
          lastActivityAt: STALE,
        }),
      ],
    });

    capStaleSubagents(makeDeps(manager));

    expect(manager.getSession(id)!.subagents).toHaveLength(0);
  });

  it("keeps a recently active waiting subagent", () => {
    const manager = new SessionManager();
    const id = makeSession(manager, {
      status: "idle",
      subagents: [
        subagent({
          status: "waiting",
          attentionType: "permission",
          pendingTool: "Bash",
          lastActivityAt: FRESH,
        }),
      ],
    });

    capStaleSubagents(makeDeps(manager));

    expect(manager.getSession(id)!.subagents).toHaveLength(1);
  });

  it("leaves working subagents without lastActivityAt alone", () => {
    const manager = new SessionManager();
    const id = makeSession(manager, {
      status: "idle",
      subagents: [subagent({ lastActivityAt: null })],
    });

    capStaleSubagents(makeDeps(manager));

    expect(manager.getSession(id)!.subagents).toHaveLength(1);
  });
});
