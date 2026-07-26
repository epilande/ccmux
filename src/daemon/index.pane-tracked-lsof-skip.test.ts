import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test";
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

  describe("time-bounded skip (issue #55/#59 follow-up)", () => {
    afterEach(() => {
      setSystemTime();
    });

    it("keeps skipping lsof while the cached resolution is fresh", async () => {
      const pane = fakePane("%4", "/dev/ttys005", "/Users/test/proj4");
      const proc = fakeCopilotProcess(999, "ttys005", "/Users/test/proj4");

      setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      await internals.createOrUpdatePaneTrackedSessions([proc], [pane]);
      expect(lsofCalls).toBe(1);

      setSystemTime(new Date("2024-01-01T00:00:59.000Z")); // +59s, still fresh
      await internals.createOrUpdatePaneTrackedSessions([proc], [pane]);
      expect(lsofCalls).toBe(1);
    });

    it("re-spawns lsof once the cached resolution ages past the TTL and applies an id change", async () => {
      const pane = fakePane("%5", "/dev/ttys006", "/Users/test/proj5");
      const proc = fakeCopilotProcess(1010, "ttys006", "/Users/test/proj5");

      setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
      await internals.createOrUpdatePaneTrackedSessions([proc], [pane]);
      expect(lsofCalls).toBe(1);
      const afterFirst = internals.sessionManager.getSession("copilot_pane5");
      expect(afterFirst?.nativeSessionId).toBe(
        "12345678-1234-1234-1234-1234567890ab",
      );

      // Same pid opens a new session file (e.g. `/new`, no hooks installed):
      // lsof now reports a different session under the same pid.
      internals.getLsofLines = async () => {
        lsofCalls += 1;
        return [
          "n/Users/test/session-state/abcdefab-abcd-abcd-abcd-abcdefabcdef/session.db",
        ];
      };

      setSystemTime(new Date("2024-01-01T00:01:01.000Z")); // +61s, stale
      await internals.createOrUpdatePaneTrackedSessions([proc], [pane]);
      expect(lsofCalls).toBe(2);
      const afterSecond = internals.sessionManager.getSession("copilot_pane5");
      expect(afterSecond?.nativeSessionId).toBe(
        "abcdefab-abcd-abcd-abcd-abcdefabcdef",
      );
    });
  });
});
