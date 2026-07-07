import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempRoot = join(
  tmpdir(),
  `ccmux-opencode-link-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const markersDir = join(tempRoot, "markers");

const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  MARKERS_DIR: markersDir,
}));

import { reconcileSessionMarkerLinks } from "../link";
import {
  loadMarkerIntoCache,
  refreshMarkerCache,
  type SessionPidMarker,
} from "../../session-markers";
import type { HookAdapter, HookManagerContext } from "../../hook-adapter";
import type { Session, TmuxPane } from "../../../types/session";

function writeMarker(m: SessionPidMarker) {
  mkdirSync(markersDir, { recursive: true });
  const path = join(markersDir, `${m.agent_type}-${m.session_id}.json`);
  writeFileSync(path, JSON.stringify(m));
  loadMarkerIntoCache(path);
}

function makePane(paneId: string, panePid: number): TmuxPane {
  return {
    paneId,
    panePid,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 0,
    target: `ccmux:0.${paneId.replace("%", "")}`,
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: "opencode",
    currentCommand: "opencode",
    currentPath: "/tmp",
  };
}

function makeAdapter(onAdded: (m: SessionPidMarker) => void): HookAdapter {
  return {
    agentType: "opencode",
    install: async () => ({ lines: [], changed: false }),
    uninstall: async () => ({ lines: [], changed: false }),
    isInstalled: () => true,
    isSessionStillLive: () => true,
    onMarkerAdded: async (m) => onAdded(m),
  };
}

function makeCtx(sessions: Session[], panes: TmuxPane[]): HookManagerContext {
  return {
    sessionManager: {
      getSessions: () => sessions,
    } as unknown as HookManagerContext["sessionManager"],
    getLogWatcher: () => undefined,
    listProcesses: async () => [],
    listPanes: async () => panes,
    getPaneHostingPid: async (pid: number) => {
      return panes.find((p) => p.panePid === pid) ?? null;
    },
  };
}

function makeUnlinkedSession(paneId: string): Session {
  return {
    id: `sid-${paneId}`,
    agentType: "opencode",
    trackingMode: "pane",
    nativeSessionId: undefined,
    project: "x",
    cwd: "/x",
    logPath: null,
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    tmuxPane: paneId,
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
}

describe("reconcileSessionMarkerLinks", () => {
  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    refreshMarkerCache();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("re-dispatches one marker per unlinked session, even when the pane has many", async () => {
    const pane = makePane("%3", 8000);
    const session = makeUnlinkedSession("%3");
    writeMarker({
      agent_type: "opencode",
      pid: 8000,
      session_id: "s1",
      timestamp: 1,
    });
    writeMarker({
      agent_type: "opencode",
      pid: 8000,
      session_id: "s2",
      timestamp: 2,
    });

    const calls: string[] = [];
    const adapter = makeAdapter((m) => calls.push(m.session_id));
    const ctx = makeCtx([session], [pane]);

    await reconcileSessionMarkerLinks(adapter, ctx);
    expect(calls).toHaveLength(1);
    // The pane's freshest marker is the dispatch representative.
    expect(calls[0]).toBe("s2");
  });

  it("does nothing when there are no unlinked sessions", async () => {
    const pane = makePane("%3", 8000);
    writeMarker({
      agent_type: "opencode",
      pid: 8000,
      session_id: "s1",
      timestamp: 1,
    });
    const calls: string[] = [];
    const adapter = makeAdapter((m) => calls.push(m.session_id));
    const ctx = makeCtx([], [pane]);

    await reconcileSessionMarkerLinks(adapter, ctx);
    expect(calls).toEqual([]);
  });

  it("does nothing when there are no OpenCode markers", async () => {
    const pane = makePane("%3", 8000);
    const session = makeUnlinkedSession("%3");
    const calls: string[] = [];
    const adapter = makeAdapter((m) => calls.push(m.session_id));
    const ctx = makeCtx([session], [pane]);

    await reconcileSessionMarkerLinks(adapter, ctx);
    expect(calls).toEqual([]);
  });

  it("ignores sessions whose tmuxPane is not a hosting pane for any marker PID", async () => {
    const sessionPane = makePane("%1", 1000);
    const otherPane = makePane("%2", 2000);
    const session = makeUnlinkedSession("%1");
    // Marker belongs to a different pane's server.
    writeMarker({
      agent_type: "opencode",
      pid: 2000,
      session_id: "other",
      timestamp: 1,
    });
    const calls: string[] = [];
    const adapter = makeAdapter((m) => calls.push(m.session_id));
    const ctx = makeCtx([session], [sessionPane, otherPane]);

    await reconcileSessionMarkerLinks(adapter, ctx);
    expect(calls).toEqual([]);
  });

  it("only enriches sessions whose agentType matches the adapter", async () => {
    const pane = makePane("%3", 8000);
    const opencodeSession = makeUnlinkedSession("%3");
    const codexSession = {
      ...makeUnlinkedSession("%3"),
      id: "codex-sid",
      agentType: "codex",
    };
    writeMarker({
      agent_type: "opencode",
      pid: 8000,
      session_id: "oc",
      timestamp: 1,
    });
    const calls: string[] = [];
    const adapter = makeAdapter((m) => calls.push(m.session_id));
    const ctx = makeCtx([opencodeSession, codexSession], [pane]);

    await reconcileSessionMarkerLinks(adapter, ctx);
    expect(calls).toEqual(["oc"]);
  });

  it("skips sessions whose nativeSessionId matches one of their pane's markers (verified owner)", async () => {
    const pane = makePane("%3", 8000);
    const session = {
      ...makeUnlinkedSession("%3"),
      nativeSessionId: "oc",
    };
    writeMarker({
      agent_type: "opencode",
      pid: 8000,
      session_id: "oc",
      timestamp: 1,
    });
    const calls: string[] = [];
    const adapter = makeAdapter((m) => calls.push(m.session_id));
    const ctx = makeCtx([session], [pane]);

    await reconcileSessionMarkerLinks(adapter, ctx);
    expect(calls).toEqual([]);
  });

  it("AT-E1: re-dispatches for a session holding an id none of its pane's markers carry", async () => {
    // Pre-Phase-2 a session with ANY nativeSessionId was skipped forever,
    // so a heuristically-grabbed foreign id could never heal.
    const pane = makePane("%3", 8000);
    const session = {
      ...makeUnlinkedSession("%3"),
      nativeSessionId: "foreign-id",
    };
    writeMarker({
      agent_type: "opencode",
      pid: 8000,
      session_id: "oc",
      timestamp: 1,
    });
    const calls: string[] = [];
    const adapter = makeAdapter((m) => calls.push(m.session_id));
    const ctx = makeCtx([session], [pane]);

    await reconcileSessionMarkerLinks(adapter, ctx);
    expect(calls).toEqual(["oc"]);
  });
});
