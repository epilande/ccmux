import { beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

/** Redirect STATE_FILE to a temp dir so tests don't touch real ~/.config/ccmux/state.json */
const tempRoot = join(
  tmpdir(),
  `ccmux-ancestry-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import { Daemon } from "./index";
import { BUILTIN_AGENTS } from "../lib/agents";
import { ProcessTree } from "./process-tree";
import { decideScanBindings } from "./binder";
import type { SessionSlice } from "./binder";
import type { ProcessInfo, TmuxPane } from "../types/session";

/**
 * Issue #193, pane-tracked creation site: hookless agents (pi, gemini, agy,
 * and Claude in no-hooks mode) are discovered by process match and joined to
 * a pane. Under a pty-allocating wrapper the join used to fail outright and
 * no row was ever created.
 */

type DaemonInternals = {
  agents: typeof BUILTIN_AGENTS;
  claudeRuntimeMode: "claude-with-hooks" | "claude-no-hooks";
  sessionManager: ReturnType<Daemon["getSessionManager"]>;
  createOrUpdatePaneTrackedSessions(
    processes: ProcessInfo[],
    panes: TmuxPane[],
    processTree?: ProcessTree,
  ): Promise<void>;
  getLsofLines(pid: number): Promise<string[]>;
  resolvePaneTrackedSessionVersion(
    sessionId: string,
    processCommand: string,
    pid: number,
    agent?: (typeof BUILTIN_AGENTS)[number],
  ): Promise<void>;
};

const PANE_PID = 500;
const AGENT_PID = 502;

/** pane shell -> script -> pi */
const WRAPPER_TREE = ProcessTree.fromPsOutput(
  [
    "  PID  PPID COMM",
    `  ${PANE_PID}     1 /bin/zsh`,
    `  501   ${PANE_PID} /usr/bin/script`,
    `  ${AGENT_PID}   501 pi`,
  ].join("\n"),
);

function fakePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId: "%1",
    panePid: PANE_PID,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 1,
    target: "ccmux:0.1",
    tty: "/dev/ttys039",
    startTime: null,
    windowActivity: null,
    paneTitle: "pi",
    currentCommand: "script",
    currentPath: "/repo/a",
    ...overrides,
  };
}

function fakeClaudeProcess(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 900,
    command: "claude",
    agentType: "claude",
    tty: "ttys039",
    cwd: "/repo/a",
    startTime: Date.now() - 60_000,
    ...overrides,
  };
}

function fakePiProcess(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: AGENT_PID,
    command: "pi",
    agentType: "pi",
    // The wrapper's fresh pty: no pane reports it.
    tty: "ttys041",
    cwd: "/repo/a",
    startTime: Date.now() - 60_000,
    ...overrides,
  };
}

describe("Daemon.createOrUpdatePaneTrackedSessions ancestry (issue #193)", () => {
  let daemon: Daemon;
  let internals: DaemonInternals;

  beforeEach(() => {
    daemon = new Daemon();
    internals = daemon as unknown as DaemonInternals;
    internals.agents = BUILTIN_AGENTS;
    internals.claudeRuntimeMode = "claude-with-hooks";
    internals.resolvePaneTrackedSessionVersion = async () => {};
    internals.getLsofLines = async () => [];
  });

  it("(a) creates a bound row for a wrapper-hosted agent", async () => {
    await internals.createOrUpdatePaneTrackedSessions(
      [fakePiProcess()],
      [fakePane()],
      WRAPPER_TREE,
    );

    const session = internals.sessionManager.getSession("pi_pane1");
    expect(session?.tmuxPane).toBe("%1");
    expect(session?.pid).toBe(AGENT_PID);
    expect(session?.cwd).toBe("/repo/a");
  });

  it("creates nothing without a process tree (the pre-fix behavior)", async () => {
    await internals.createOrUpdatePaneTrackedSessions(
      [fakePiProcess()],
      [fakePane()],
    );

    expect(internals.sessionManager.getSession("pi_pane1")).toBeUndefined();
  });

  it("(b) binds the tty owner, not the wrapper-hosted process", async () => {
    await internals.createOrUpdatePaneTrackedSessions(
      [fakePiProcess(), fakePiProcess({ pid: 900, tty: "ttys039" })],
      [fakePane()],
      WRAPPER_TREE,
    );

    const session = internals.sessionManager.getSession("pi_pane1");
    expect(session?.pid).toBe(900);
  });

  it("(d) creates nothing for a process with no tty", async () => {
    await internals.createOrUpdatePaneTrackedSessions(
      [fakePiProcess({ tty: null })],
      [fakePane()],
      WRAPPER_TREE,
    );

    expect(internals.sessionManager.getSession("pi_pane1")).toBeUndefined();
  });

  it("falls back to the pane's path when the wrapper-hosted cwd is unreadable", async () => {
    await internals.createOrUpdatePaneTrackedSessions(
      [fakePiProcess({ cwd: null })],
      [fakePane({ currentPath: "/repo/from-pane" })],
      WRAPPER_TREE,
    );

    const session = internals.sessionManager.getSession("pi_pane1");
    expect(session?.cwd).toBe("/repo/from-pane");
  });

  it("(f) binds two wrapper shapes to their own panes", async () => {
    const tree = ProcessTree.fromPsOutput(
      [
        "  PID  PPID COMM",
        "  500     1 /bin/zsh",
        "  501   500 /usr/bin/script",
        "  502   501 pi",
        "  600     1 /bin/zsh",
        "  601   600 /usr/bin/script",
        "  602   601 pi",
      ].join("\n"),
    );

    await internals.createOrUpdatePaneTrackedSessions(
      [
        fakePiProcess({ pid: 502, tty: "ttys041" }),
        fakePiProcess({ pid: 602, tty: "ttys042", cwd: "/repo/b" }),
      ],
      [
        fakePane({ paneId: "%1", panePid: 500 }),
        fakePane({
          paneId: "%2",
          panePid: 600,
          paneIndex: 2,
          target: "ccmux:0.2",
          tty: "/dev/ttys040",
          currentPath: "/repo/b",
        }),
      ],
      tree,
    );

    expect(internals.sessionManager.getSession("pi_pane1")?.pid).toBe(502);
    expect(internals.sessionManager.getSession("pi_pane2")?.pid).toBe(602);
  });
});

/**
 * The two per-tick sites. `createOrUpdatePaneTrackedSessions` runs first in
 * `scan()`, then `matchSessionsToPanes` folds `decideScanBindings` over the
 * same observation. If they resolved one SESSION to different pids on
 * alternating ticks, the pane-reuse identity reset would fire every cycle
 * (`processes.ts:dropWrapperParents`): status wiped to idle, `statusChangedAt`
 * churn, enrichment cleared as fast as it is written.
 */
describe("per-tick sites agree on the wrapper shape (issue #193)", () => {
  let daemon: Daemon;
  let internals: DaemonInternals;

  beforeEach(() => {
    daemon = new Daemon();
    internals = daemon as unknown as DaemonInternals;
    internals.agents = BUILTIN_AGENTS;
    internals.claudeRuntimeMode = "claude-with-hooks";
    internals.resolvePaneTrackedSessionVersion = async () => {};
    internals.getLsofLines = async () => [];
  });

  /** Mirror of the manager→binder slice `matchSessionsToPanes` builds. */
  const slicesFromManager = (): SessionSlice[] =>
    internals.sessionManager.getSessions().map((session) => ({
      id: session.id,
      agentType: session.agentType,
      cwd: session.cwd ?? "",
      tmuxPane: session.tmuxPane,
      pid: session.pid,
      isBackground: false,
    }));

  it("resolve the same pane and pid when both see the same processes", async () => {
    const processes = [fakePiProcess()];
    const panes = [fakePane()];

    await internals.createOrUpdatePaneTrackedSessions(
      processes,
      panes,
      WRAPPER_TREE,
    );
    const created = internals.sessionManager.getSession("pi_pane1");
    expect(created?.tmuxPane).toBe("%1");
    expect(created?.pid).toBe(AGENT_PID);

    // Second tick: the scan re-asserts over what creation just wrote.
    const bindings = decideScanBindings({
      sessions: slicesFromManager(),
      processes,
      panes,
      processTree: WRAPPER_TREE,
      markerPidBySessionId: new Map(),
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId: "pi_pane1",
      paneId: "%1",
      pid: AGENT_PID,
      provenance: "ancestry",
    });
  });

  it("the scan stays SILENT where the pane-tracked pre-filter widens its view", async () => {
    // Hooks-mode Claude owns the pane's tty, so pane-tracked creation never
    // sees it and the pane looks unclaimed from there: the wrapper-hosted pi
    // ancestry-binds to %1. The scan sees BOTH, so %1 is tty-claimed by
    // claude and pi earns no ancestry pair. The two views differ — the point
    // is that the scan then emits NOTHING for pi rather than a rival pid,
    // so no session's pid ever alternates.
    const claude = fakeClaudeProcess();
    const pi = fakePiProcess();
    const panes = [fakePane()];

    // Site 3's own pre-filter drops hooks-mode Claude; pass both and let it.
    await internals.createOrUpdatePaneTrackedSessions(
      [claude, pi],
      panes,
      WRAPPER_TREE,
    );
    const piSession = internals.sessionManager.getSession("pi_pane1");
    expect(piSession?.tmuxPane).toBe("%1");
    expect(piSession?.pid).toBe(AGENT_PID);
    // Hooks-mode Claude got no pane-tracked row.
    expect(
      internals.sessionManager
        .getSessions()
        .filter((s) => s.agentType === "claude"),
    ).toEqual([]);

    const bindings = decideScanBindings({
      sessions: slicesFromManager(),
      processes: [claude, pi],
      panes,
      processTree: WRAPPER_TREE,
      markerPidBySessionId: new Map(),
    });

    // Silence, not a rival pid: the scan emits nothing at all here.
    expect(bindings).toEqual([]);
    // And pi_pane1 keeps its pid: a second creation tick is a no-op.
    await internals.createOrUpdatePaneTrackedSessions(
      [claude, pi],
      panes,
      WRAPPER_TREE,
    );
    expect(internals.sessionManager.getSession("pi_pane1")?.pid).toBe(
      AGENT_PID,
    );
  });

  it("both sites yield to the agent that owns the pane's tty", async () => {
    // A no-hooks Claude on the pane's tty plus a wrapper-hosted Claude under
    // it: now BOTH sites see the same processes, so both must pick the tty
    // owner and neither may hand the pane to the wrapper-hosted pid.
    internals.claudeRuntimeMode = "claude-no-hooks";
    const processes = [
      fakeClaudeProcess({ pid: 900, tty: "ttys039" }),
      fakeClaudeProcess({ pid: AGENT_PID, tty: "ttys041" }),
    ];
    const panes = [fakePane()];

    await internals.createOrUpdatePaneTrackedSessions(
      processes,
      panes,
      WRAPPER_TREE,
    );
    expect(internals.sessionManager.getSession("claude_pane1")?.pid).toBe(900);

    const bindings = decideScanBindings({
      sessions: slicesFromManager(),
      processes,
      panes,
      processTree: WRAPPER_TREE,
      markerPidBySessionId: new Map(),
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId: "claude_pane1",
      paneId: "%1",
      pid: 900,
      provenance: "tty",
    });
  });
});
