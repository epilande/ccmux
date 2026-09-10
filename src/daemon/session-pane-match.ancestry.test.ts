import { describe, it, expect, spyOn, afterEach } from "bun:test";
import type { ProcessInfo, TmuxPane } from "../types/session";
import * as paneDiscovery from "./pane-discovery";
import * as processes from "./processes";
import * as sessionMarkers from "./session-markers";
import { lazyProcessTree, ProcessTree } from "./process-tree";
import { findPaneByMarker } from "./session-pane-match";

/**
 * Issue #193, marker site: a pty-allocating wrapper keeps the pane's tty and
 * setsid's the agent onto a fresh pty, so both of `findPaneByMarker`'s tty
 * passes miss and the marker-backed session used to be created unbound
 * forever. Pass 3 resolves it through the SAME pairing the scan uses.
 */

const PANE_PID = 500;
const AGENT_PID = 502;

/** pane shell -> script -> claude */
const WRAPPER_TREE = ProcessTree.fromPsOutput(
  [
    "  PID  PPID COMM",
    `  ${PANE_PID}     1 /bin/zsh`,
    `  501   ${PANE_PID} /usr/bin/script`,
    `  ${AGENT_PID}   501 claude`,
  ].join("\n"),
);

const PANE: TmuxPane = {
  paneId: "%1",
  panePid: PANE_PID,
  sessionName: "main",
  windowIndex: 1,
  paneIndex: 1,
  target: "main:1.1",
  // The pane's own terminal, which the wrapper (not the agent) holds.
  tty: "/dev/ttys039",
  startTime: 900,
  windowActivity: null,
  paneTitle: null,
  currentCommand: "script",
  currentPath: "/repo/a",
};

function claudeProc(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: AGENT_PID,
    command: "claude",
    agentType: "claude",
    tty: "ttys041",
    cwd: "/repo/a",
    startTime: 1_000_000,
    ...overrides,
  };
}

const spies: { mockRestore(): void }[] = [];

function stub(opts: {
  marker: { pid: number; tty: string | null } | null;
  panes: TmuxPane[];
  procs: ProcessInfo[];
  tree?: ProcessTree;
}): void {
  spies.push(
    spyOn(sessionMarkers, "getSessionPidMarker").mockReturnValue(
      opts.marker
        ? // The marker file carries more than this; the resolver reads only
          // `pid` and `tty`.
          ({
            session_id: "s1",
            pid: opts.marker.pid,
            tty: opts.marker.tty,
          } as unknown as ReturnType<typeof sessionMarkers.getSessionPidMarker>)
        : null,
    ),
    spyOn(paneDiscovery, "listTmuxPanes").mockResolvedValue(opts.panes),
    spyOn(processes, "discoverAgentProcesses").mockResolvedValue(opts.procs),
    spyOn(ProcessTree, "build").mockResolvedValue(opts.tree ?? WRAPPER_TREE),
  );
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("findPaneByMarker ancestry fallback (issue #193)", () => {
  it("(a) resolves the wrapper's pane when neither tty pass matches", async () => {
    stub({
      // The hook ran inside the wrapper's fresh pty, so even the marker's own
      // tty belongs to no pane.
      marker: { pid: AGENT_PID, tty: "ttys041" },
      panes: [PANE],
      procs: [claudeProc()],
    });

    const pane = await findPaneByMarker("s1");
    expect(pane?.paneId).toBe("%1");
  });

  it("(b) still prefers the marker's own tty when a pane owns it", async () => {
    const other: TmuxPane = { ...PANE, paneId: "%2", tty: "/dev/ttys041" };
    stub({
      marker: { pid: AGENT_PID, tty: "ttys041" },
      panes: [PANE, other],
      procs: [claudeProc()],
    });

    const pane = await findPaneByMarker("s1");
    expect(pane?.paneId).toBe("%2");
  });

  it("(c) refuses a pane another agent already holds by tty", async () => {
    stub({
      marker: { pid: AGENT_PID, tty: "ttys041" },
      panes: [PANE],
      // A plain claude owns the pane's terminal; the wrapper-hosted one does
      // not get to evict it.
      procs: [claudeProc(), claudeProc({ pid: 900, tty: "ttys039" })],
    });

    expect(await findPaneByMarker("s1")).toBeNull();
  });

  it("(d) refuses a marker whose process has no tty", async () => {
    stub({
      marker: { pid: AGENT_PID, tty: null },
      panes: [PANE],
      procs: [claudeProc({ tty: null })],
    });

    expect(await findPaneByMarker("s1")).toBeNull();
  });

  it("returns null when the marker pid is not a live agent process", async () => {
    stub({
      marker: { pid: 777, tty: "ttys041" },
      panes: [PANE],
      procs: [claudeProc()],
    });

    expect(await findPaneByMarker("s1")).toBeNull();
  });

  it("builds no process tree on the common tty path", async () => {
    stub({
      marker: { pid: AGENT_PID, tty: "ttys039" },
      panes: [PANE],
      procs: [claudeProc({ tty: "ttys039" })],
    });

    const pane = await findPaneByMarker("s1");
    expect(pane?.paneId).toBe("%1");
    expect(ProcessTree.build).not.toHaveBeenCalled();
  });
});

describe("shared process tree across a rebind pass", () => {
  it("builds at most one tree however many resolvers ask for it", async () => {
    let builds = 0;
    const getProcessTree = lazyProcessTree(async () => {
      builds += 1;
      return WRAPPER_TREE;
    });

    stub({
      marker: { pid: AGENT_PID, tty: "ttys041" },
      panes: [PANE],
      procs: [claudeProc()],
    });

    // The rebind pass calls findPaneByMarker and then, on a miss,
    // findPaneForNewSession — sharing one provider between them.
    expect(await findPaneByMarker("s1", getProcessTree)).not.toBeNull();
    expect(builds).toBe(1);
    await getProcessTree();
    await getProcessTree();
    expect(builds).toBe(1);
  });

  it("builds nothing when an earlier tty pass already answered", async () => {
    let builds = 0;
    const getProcessTree = lazyProcessTree(async () => {
      builds += 1;
      return WRAPPER_TREE;
    });

    stub({
      marker: { pid: AGENT_PID, tty: "ttys039" },
      panes: [PANE],
      procs: [claudeProc({ tty: "ttys039" })],
    });

    expect((await findPaneByMarker("s1", getProcessTree))?.paneId).toBe("%1");
    expect(builds).toBe(0);
  });
});
