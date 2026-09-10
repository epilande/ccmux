import { describe, it, expect } from "bun:test";
import type { ProcessInfo, TmuxPane } from "../../types/session";
import { ProcessTree } from "../process-tree";
import {
  buildProcPaneMapByEncodedCwd,
  decideScanBindings,
  decideNewSessionPane,
  decideInitialClaudeBatch,
  decideMigrationBindings,
  pairProcsWithPanes,
  type AncestryPairOptions,
} from "./index";
import type { ProcessTreeLike, SessionSlice } from "./types";

/**
 * Issue #193: a pty-allocating wrapper (`script -q /dev/null claude`,
 * `nono run -- claude`, `fence`) forks, keeps the pane's tty for itself, and
 * setsid's the agent onto a fresh pty that no tmux pane owns:
 *
 *   zsh     ttys039   pane shell (pane_pid)
 *   script  ttys039   wrapper, matches no agent def
 *   claude  ttys041   discovered, cwd resolved, tty matches no pane
 *
 * Every process<->pane join used to be tty-only, so the agent was discovered
 * and then discarded. These tests pin the ancestry fallback and, above all,
 * its subordination to tty.
 */

const PANE_PID = 500;
const WRAPPER_PID = 501;
const AGENT_PID = 502;

/** The wrapper shape's real `ps` tree: pane shell -> script -> claude. */
const WRAPPER_TREE = ProcessTree.fromPsOutput(
  [
    "  PID  PPID COMM",
    `  ${PANE_PID}     1 /bin/zsh`,
    `  ${WRAPPER_PID}   ${PANE_PID} /usr/bin/script`,
    `  ${AGENT_PID}   ${WRAPPER_PID} claude`,
  ].join("\n"),
);

function proc(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: AGENT_PID,
    command: "claude",
    agentType: "claude",
    // A pty the wrapper allocated: no pane reports it.
    tty: "ttys041",
    cwd: "/repo/a",
    startTime: 1_000_000,
    ...overrides,
  };
}

function pane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId: "%1",
    panePid: PANE_PID,
    sessionName: "main",
    windowIndex: 1,
    paneIndex: 1,
    target: "main:1.1",
    tty: "/dev/ttys039",
    startTime: 900,
    windowActivity: null,
    paneTitle: null,
    currentCommand: "script",
    currentPath: "/repo/a",
    ...overrides,
  };
}

function slice(overrides: Partial<SessionSlice> = {}): SessionSlice {
  return {
    id: "s1",
    agentType: "claude",
    cwd: "/repo/a",
    tmuxPane: null,
    pid: null,
    isBackground: false,
    ...overrides,
  };
}

const NO_MARKERS = new Map<string, number | null>();

/**
 * Session activity just AFTER the process start, the direction
 * `forwardGapCost` requires (a prompt precedes its process by at most the
 * 2s clock-skew epsilon).
 */
const timestampsJustAfter = () => [1_000_000 + 5_000];

describe("pairProcsWithPanes: ancestry fallback (issue #193)", () => {
  it("(a) pairs a wrapper-hosted agent with the pane hosting its wrapper", () => {
    const matches = pairProcsWithPanes([proc()], [pane()], {
      processTree: WRAPPER_TREE,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].pane.paneId).toBe("%1");
    expect(matches[0].proc.pid).toBe(AGENT_PID);
    expect(matches[0].provenance).toBe("ancestry");
  });

  it("pairs nothing without a process tree (the historical tty-only form)", () => {
    expect(pairProcsWithPanes([proc()], [pane()])).toEqual([]);
  });

  it("(b) prefers the tty join when the agent owns the pane's terminal", () => {
    const matches = pairProcsWithPanes([proc({ tty: "ttys039" })], [pane()], {
      processTree: WRAPPER_TREE,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].provenance).toBe("tty");
  });

  it("(c) never re-claims by ancestry a pane a tty match already holds", () => {
    // A plain claude owns the pane's tty; a second, wrapper-hosted claude is
    // a descendant of the same pane. The pane is spoken for.
    const ttyOwner = proc({ pid: 900, tty: "ttys039" });
    const wrapped = proc({ pid: AGENT_PID, tty: "ttys041" });

    const matches = pairProcsWithPanes([ttyOwner, wrapped], [pane()], {
      processTree: WRAPPER_TREE,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].proc.pid).toBe(900);
    expect(matches[0].provenance).toBe("tty");
  });

  it("(d) never binds a process that has no tty at all", () => {
    // Pipe-stdio subprocesses (`codex exec`, MCP servers) are descendants of
    // the pane too; ancestry must not resurrect what discovery drops.
    const matches = pairProcsWithPanes([proc({ tty: null })], [pane()], {
      processTree: WRAPPER_TREE,
    });

    expect(matches).toEqual([]);
  });

  it("(f) binds two wrapper shapes to their own panes, never crosswise", () => {
    const tree = ProcessTree.fromPsOutput(
      [
        "  PID  PPID COMM",
        "  500     1 /bin/zsh",
        "  501   500 /usr/bin/script",
        "  502   501 claude",
        "  600     1 /bin/zsh",
        "  601   600 /usr/bin/script",
        "  602   601 claude",
      ].join("\n"),
    );
    const matches = pairProcsWithPanes(
      [
        proc({ pid: 502, tty: "ttys041" }),
        proc({ pid: 602, tty: "ttys042", cwd: "/repo/b" }),
      ],
      [
        pane({ paneId: "%1", panePid: 500 }),
        pane({ paneId: "%2", panePid: 600, tty: "/dev/ttys040" }),
      ],
      { processTree: tree },
    );

    expect(
      matches.map((m) => [m.pane.paneId, m.proc.pid, m.provenance]),
    ).toEqual([
      ["%1", 502, "ancestry"],
      ["%2", 602, "ancestry"],
    ]);
  });

  it("gives one process to one pane when panes nest in the same tree", () => {
    // Contrived: a real `pane_pid` is always a direct child of the tmux
    // server, so one pane's shell is never another's descendant under a
    // single server. It pins the invariant anyway — a process is claimed
    // once, by the first pane that reaches it, never by both.
    const tree = ProcessTree.fromPsOutput(
      [
        "  PID  PPID COMM",
        "  500     1 /bin/zsh",
        "  600   500 /bin/zsh",
        "  601   600 /usr/bin/script",
        "  602   601 claude",
      ].join("\n"),
    );
    const matches = pairProcsWithPanes(
      [proc({ pid: 602, tty: "ttys041" })],
      [
        pane({ paneId: "%1", panePid: 500 }),
        pane({ paneId: "%2", panePid: 600, tty: "/dev/ttys040" }),
      ],
      { processTree: tree },
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].pane.paneId).toBe("%1");
  });

  it("never hands a cwd-less process to the encoded-cwd map", () => {
    // The map encodes `proc.cwd` non-null. `requireCwd` is not part of
    // `AncestryPairOptions`, so it cannot be spelled here; the widened
    // variable below is the structural back door, and the map forces
    // `requireCwd: true` regardless of what reaches it.
    const sneaky: AncestryPairOptions = {
      processTree: WRAPPER_TREE,
      requireCwd: false,
    } as AncestryPairOptions & { requireCwd: boolean };

    const map = buildProcPaneMapByEncodedCwd(
      [proc({ cwd: null }), proc({ pid: 700, tty: "ttys043", cwd: "/repo/a" })],
      [pane(), pane({ paneId: "%2", panePid: 700, tty: "/dev/ttys040" })],
      sneaky,
    );

    for (const matches of map.values()) {
      for (const match of matches) expect(match.proc.cwd).not.toBeNull();
    }
    // The cwd-less process contributed no key at all.
    expect([...map.keys()]).toEqual(["-repo-a"]);
  });

  it("keeps a cwd-less process when the caller opts out of requireCwd", () => {
    // Pane-tracked creation falls back to the pane's own currentPath, so it
    // must still see a process whose cwd could not be read.
    const withCwd = pairProcsWithPanes([proc({ cwd: null })], [pane()], {
      processTree: WRAPPER_TREE,
    });
    expect(withCwd).toEqual([]);

    const withoutCwd = pairProcsWithPanes([proc({ cwd: null })], [pane()], {
      processTree: WRAPPER_TREE,
      requireCwd: false,
    });
    expect(withoutCwd).toHaveLength(1);
    expect(withoutCwd[0].pane.paneId).toBe("%1");
  });
});

describe("ancestry at the binding sites (issue #193)", () => {
  it("(a) scan re-bind: an unbound session binds to the wrapper's pane", () => {
    const bindings = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: "%1", pid: null })],
      processes: [proc()],
      panes: [pane()],
      processTree: WRAPPER_TREE,
      markerPidBySessionId: NO_MARKERS,
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId: "s1",
      paneId: "%1",
      pid: AGENT_PID,
      provenance: "ancestry",
    });
  });

  it("(a) new-session creation: the transcript-driven ladder binds it too", () => {
    const decision = decideNewSessionPane({
      processes: [proc()],
      panes: [pane()],
      processTree: WRAPPER_TREE,
      sessionId: "s1",
      encodedProjectPath: "-repo-a",
      transcriptCwd: "/repo/a",
      getSessionTimestamps: timestampsJustAfter,
      sessions: [],
    });

    expect(decision).toMatchObject({
      kind: "bound",
      pid: AGENT_PID,
    });
    expect(decision.kind === "bound" && decision.pane.paneId).toBe("%1");
  });

  it("(a) initial batch: a wrapper-hosted marker match creates a bound row", () => {
    const { actions } = decideInitialClaudeBatch(
      [
        {
          path: "/logs/-repo-a/s1.jsonl",
          sessionId: "s1",
          encodedProjectPath: "-repo-a",
          mtimeMs: 10,
        },
      ],
      {
        processes: [proc()],
        panes: [pane()],
        processTree: WRAPPER_TREE,
        sessions: [],
        markerPidBySessionId: new Map([["s1", AGENT_PID]]),
        getSessionTimestamps: timestampsJustAfter,
        getTranscriptCwd: () => "/repo/a",
      },
    );

    expect(actions).toEqual([
      {
        type: "create",
        sessionId: "s1",
        path: "/logs/-repo-a/s1.jsonl",
        paneId: "%1",
        pid: AGENT_PID,
        provenance: "marker",
        confidence: "authoritative",
        cwd: "/repo/a",
      },
    ]);
  });

  it("(a) boot migration: a wrapper-hosted process reconstructs its session", () => {
    const { bindings } = decideMigrationBindings({
      processes: [proc()],
      panes: [pane()],
      processTree: WRAPPER_TREE,
      markers: [{ session_id: "s1", pid: AGENT_PID }],
      historyEntries: [],
      existingSessionIds: new Set<string>(),
      logPathExists: () => true,
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId: "s1",
      paneId: "%1",
      pid: AGENT_PID,
      provenance: "marker",
    });
  });

  it("(e) scan and new-session creation resolve the SAME pane and pid", () => {
    // Two panes, one of them hosting the wrapper. If the two sites disagreed
    // the row's pid would flip-flop every scan and trip the pane-reuse
    // identity reset (processes.ts:dropWrapperParents).
    const panes = [
      pane({ paneId: "%0", panePid: 400, tty: "/dev/ttys038" }),
      pane({ paneId: "%1", panePid: PANE_PID }),
    ];
    const processes = [proc()];

    const scan = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: "%1", pid: null })],
      processes,
      panes,
      processTree: WRAPPER_TREE,
      markerPidBySessionId: NO_MARKERS,
    });
    const created = decideNewSessionPane({
      processes,
      panes,
      processTree: WRAPPER_TREE,
      sessionId: "s1",
      encodedProjectPath: "-repo-a",
      transcriptCwd: "/repo/a",
      getSessionTimestamps: timestampsJustAfter,
      sessions: [],
    });

    expect(created.kind).toBe("bound");
    if (created.kind !== "bound") return;
    expect(scan[0].paneId).toBe(created.pane.paneId);
    expect(scan[0].pid).toBe(created.pid);
  });

  it("(e) scan and creation still agree when the agent owns the pane's tty", () => {
    const processes = [proc({ tty: "ttys039" })];
    const panes = [pane()];

    const scan = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: "%1", pid: null })],
      processes,
      panes,
      processTree: WRAPPER_TREE,
      markerPidBySessionId: NO_MARKERS,
    });
    const created = decideNewSessionPane({
      processes,
      panes,
      processTree: WRAPPER_TREE,
      sessionId: "s1",
      encodedProjectPath: "-repo-a",
      transcriptCwd: "/repo/a",
      getSessionTimestamps: timestampsJustAfter,
      sessions: [],
    });

    expect(scan[0].provenance).toBe("tty");
    expect(created.kind === "bound" && created.pane.paneId).toBe("%1");
    expect(scan[0].paneId).toBe("%1");
  });

  it("(b) a tty-owning agent wins the pane over a wrapper-hosted rival, at both sites", () => {
    const processes = [
      proc({ pid: 900, tty: "ttys039" }),
      proc({ pid: AGENT_PID, tty: "ttys041" }),
    ];
    const panes = [pane()];

    const scan = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: null, pid: 900 })],
      processes,
      panes,
      processTree: WRAPPER_TREE,
      markerPidBySessionId: NO_MARKERS,
    });

    expect(scan).toHaveLength(1);
    expect(scan[0]).toMatchObject({
      paneId: "%1",
      pid: 900,
      provenance: "tty",
    });

    const decision = decideNewSessionPane({
      processes,
      panes,
      processTree: WRAPPER_TREE,
      sessionId: "s1",
      encodedProjectPath: "-repo-a",
      transcriptCwd: "/repo/a",
      getSessionTimestamps: timestampsJustAfter,
      sessions: [],
    });
    expect(decision.kind === "bound" && decision.pid).toBe(900);
  });

  it("leaves the old stub-shaped ProcessTreeLike contract intact", () => {
    // The interface is still just `findAgentDescendant`, so existing
    // fixtures that stub it keep working.
    const stub: ProcessTreeLike = {
      findAgentDescendant: (panePid, agentPids) =>
        panePid === PANE_PID && agentPids.has(AGENT_PID) ? AGENT_PID : null,
    };
    const matches = pairProcsWithPanes([proc()], [pane()], {
      processTree: stub,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].provenance).toBe("ancestry");
  });
});
