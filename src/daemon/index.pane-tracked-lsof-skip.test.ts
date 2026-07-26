import { beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

/** Redirect STATE_FILE to a temp dir so tests don't touch real ~/.config/ccmux/state.json */
const tempRoot = join(
  tmpdir(),
  `ccmux-lsof-skip-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import { Daemon } from "./index";
import { BUILTIN_AGENTS } from "../lib/agents";
import type { ProcessInfo, TmuxPane } from "../types/session";

type DaemonInternals = {
  agents: typeof BUILTIN_AGENTS;
  claudeRuntimeMode: "claude-with-hooks" | "claude-no-hooks";
  sessionManager: ReturnType<Daemon["getSessionManager"]>;
  createOrUpdatePaneTrackedSessions(
    processes: ProcessInfo[],
    panes: TmuxPane[],
  ): Promise<void>;
  getLsofLines(pid: number): Promise<string[]>;
  resolvePaneTrackedSessionVersion(
    sessionId: string,
    processCommand: string,
    pid: number,
    agent?: (typeof BUILTIN_AGENTS)[number],
  ): Promise<void>;
};

function fakePane(
  paneId: string,
  tty: string,
  currentPath: string,
  overrides: Partial<TmuxPane> = {},
): TmuxPane {
  return {
    paneId,
    panePid: 1000,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 0,
    target: `ccmux:0.${paneId.replace("%", "")}`,
    tty,
    startTime: null,
    windowActivity: null,
    paneTitle: "copilot",
    currentCommand: "copilot",
    currentPath,
    ...overrides,
  };
}

function fakeCopilotProcess(
  pid: number,
  tty: string,
  cwd: string,
): ProcessInfo {
  return {
    pid,
    command: "copilot",
    agentType: "copilot",
    tty,
    cwd,
    startTime: Date.now() - 60_000,
  };
}

describe("Daemon.createOrUpdatePaneTrackedSessions lsof skip (issue #55 item 2)", () => {
  let daemon: Daemon;
  let internals: DaemonInternals;
  let lsofCalls: number;

  beforeEach(() => {
    daemon = new Daemon();
    internals = daemon as unknown as DaemonInternals;
    internals.agents = BUILTIN_AGENTS;
    internals.claudeRuntimeMode = "claude-with-hooks";
    internals.resolvePaneTrackedSessionVersion = async () => {};
    lsofCalls = 0;
    internals.getLsofLines = async () => {
      lsofCalls += 1;
      return [
        "n/Users/test/session-state/12345678-1234-1234-1234-1234567890ab/session.db",
      ];
    };
  });

  it("skips the lsof spawn when the existing session already has a nativeSessionId for the same pid", async () => {
    const pane = fakePane("%1", "/dev/ttys002", "/Users/test/proj");
    const proc = fakeCopilotProcess(555, "ttys002", "/Users/test/proj");

    // First tick: no existing session, resolves via lsof.
    await internals.createOrUpdatePaneTrackedSessions([proc], [pane]);
    expect(lsofCalls).toBe(1);
    const afterFirst = internals.sessionManager.getSession("copilot_pane1");
    expect(afterFirst?.nativeSessionId).toBeDefined();

    // Second tick, same pid, same pane, session already resolved: no new lsof spawn.
    await internals.createOrUpdatePaneTrackedSessions([proc], [pane]);
    expect(lsofCalls).toBe(1);
    const afterSecond = internals.sessionManager.getSession("copilot_pane1");
    expect(afterSecond?.nativeSessionId).toBe(afterFirst?.nativeSessionId);
  });

  it("still resolves via lsof when a new process (different pid) takes over the pane", async () => {
    const pane = fakePane("%2", "/dev/ttys003", "/Users/test/proj2");
    const proc1 = fakeCopilotProcess(666, "ttys003", "/Users/test/proj2");

    await internals.createOrUpdatePaneTrackedSessions([proc1], [pane]);
    expect(lsofCalls).toBe(1);

    const proc2 = fakeCopilotProcess(777, "ttys003", "/Users/test/proj2");
    await internals.createOrUpdatePaneTrackedSessions([proc2], [pane]);
    expect(lsofCalls).toBe(2);
  });

  it("resolves via lsof on every tick for a session with no nativeSessionId yet", async () => {
    internals.getLsofLines = async () => {
      lsofCalls += 1;
      return []; // no match found -> nativeSessionId stays unresolved
    };
    const pane = fakePane("%3", "/dev/ttys004", "/Users/test/proj3");
    const proc = fakeCopilotProcess(888, "ttys004", "/Users/test/proj3");

    await internals.createOrUpdatePaneTrackedSessions([proc], [pane]);
    expect(lsofCalls).toBe(1);
    await internals.createOrUpdatePaneTrackedSessions([proc], [pane]);
    expect(lsofCalls).toBe(2);
  });
});
