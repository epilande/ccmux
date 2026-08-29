import { describe, it, expect } from "bun:test";
import type { ProcessInfo, TmuxPane } from "../../types/session";
import {
  decideScanBindings,
  decideNewSessionPane,
  decideReplaceHeuristic,
  decideInitialClaudeBatch,
  decideMigrationBindings,
  decideCodexRolloutLinks,
  decideMarkerLinks,
  encodingDriftWarning,
} from "./index";
import type {
  InitialBatchItem,
  InitialBatchObservation,
  NewSessionPaneObservation,
  ReplaceableSessionSlice,
  SessionSlice,
} from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function proc(overrides: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid: 100,
    command: "claude",
    agentType: "claude",
    tty: "ttys001",
    cwd: "/repo/a",
    startTime: 1_000_000,
    ...overrides,
  };
}

function pane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId: "%1",
    panePid: 500,
    sessionName: "main",
    windowIndex: 1,
    paneIndex: 1,
    target: "main:1.1",
    tty: "/dev/ttys001",
    startTime: 900,
    ...overrides,
  } as TmuxPane;
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

function rSlice(
  overrides: Partial<ReplaceableSessionSlice> = {},
): ReplaceableSessionSlice {
  return {
    id: "s1",
    agentType: "claude",
    cwd: "/repo/a",
    encodedCwd: "-repo-a",
    tmuxPane: "%1",
    logPath: "/logs/-repo-a/s1.jsonl",
    hasMarker: false,
    ...overrides,
  };
}

const NO_MARKERS = new Map<string, number | null>();

// ---------------------------------------------------------------------------
// decideScanBindings (ladder 1)
// ---------------------------------------------------------------------------

describe("decideScanBindings", () => {
  it("P1: marker pid match wins and is authoritative", () => {
    const bindings = decideScanBindings({
      sessions: [
        slice({ id: "other", tmuxPane: "%1", pid: null }),
        slice({ id: "marked" }),
      ],
      processes: [proc({ pid: 42 })],
      panes: [pane()],
      markerPidBySessionId: new Map([["marked", 42]]),
    });

    expect(bindings).toEqual([
      {
        sessionId: "marked",
        paneId: "%1",
        pid: 42,
        provenance: "marker",
        confidence: "authoritative",
        nativeSessionId: null,
      },
    ]);
  });

  it("P2: session already on the pane with missing pid gets the pid", () => {
    const bindings = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: "%1", pid: null })],
      processes: [proc({ pid: 42 })],
      panes: [pane()],
      markerPidBySessionId: NO_MARKERS,
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId: "s1",
      paneId: "%1",
      pid: 42,
      provenance: "tty",
      confidence: "probable",
    });
  });

  it("P3: soft-evicted session with matching pid is re-bound to the pane", () => {
    const bindings = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: null, pid: 42 })],
      processes: [proc({ pid: 42 })],
      panes: [pane()],
      markerPidBySessionId: NO_MARKERS,
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ sessionId: "s1", paneId: "%1" });
  });

  it("excludes background sessions from all priorities", () => {
    const bindings = decideScanBindings({
      sessions: [slice({ id: "bg", pid: 42, isBackground: true })],
      processes: [proc({ pid: 42 })],
      panes: [pane()],
      markerPidBySessionId: NO_MARKERS,
    });

    expect(bindings).toEqual([]);
  });

  it("falls back to process-tree ancestry when no tty matches", () => {
    const bindings = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: "%9", pid: null })],
      processes: [proc({ pid: 42, tty: "ttys099" })],
      panes: [pane({ paneId: "%9", tty: "/dev/ttys050", panePid: 700 })],
      processTree: {
        findAgentDescendant: (panePid, agentPids) =>
          panePid === 700 && agentPids.has(42) ? 42 : null,
      },
      markerPidBySessionId: NO_MARKERS,
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId: "s1",
      provenance: "ancestry",
    });
  });

  it("AT-O2: a fully-populated wrong binding re-binds to the pane its live pid is actually on", () => {
    // Session s1 holds pane %2 with pid 42, but pid 42's tty is pane %1's.
    // Pre-Phase-2 the pid arm required tmuxPane === null, so this wrong
    // binding was a permanent fixed point; re-assert moves it in one scan.
    const bindings = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: "%2", pid: 42 })],
      processes: [proc({ pid: 42, tty: "ttys001" })],
      panes: [
        pane({ paneId: "%1", tty: "/dev/ttys001" }),
        pane({ paneId: "%2", tty: "/dev/ttys002" }),
      ],
      markerPidBySessionId: NO_MARKERS,
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId: "s1",
      paneId: "%1",
      pid: 42,
      provenance: "tty",
    });
  });

  it("AT-O2: a correct binding re-asserts (emitted every scan, a no-op at apply)", () => {
    const bindings = decideScanBindings({
      sessions: [slice({ id: "s1", tmuxPane: "%1", pid: 42 })],
      processes: [proc({ pid: 42 })],
      panes: [pane()],
      markerPidBySessionId: NO_MARKERS,
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ sessionId: "s1", paneId: "%1" });
  });

  it("AT-F3: a full three-way permutation corrects in one scan once markers are visible", () => {
    // The audit's confirmed end-state: three same-cwd sessions, each bound
    // to the wrong pane and holding that wrong pane's live pid. Markers
    // then become visible for all three. One scan must fix
    // all three via marker re-verification + re-assert.
    const bindings = decideScanBindings({
      sessions: [
        slice({ id: "s1", tmuxPane: "%2", pid: 2 }),
        slice({ id: "s2", tmuxPane: "%3", pid: 3 }),
        slice({ id: "s3", tmuxPane: "%1", pid: 1 }),
      ],
      processes: [
        proc({ pid: 1, tty: "ttys001" }),
        proc({ pid: 2, tty: "ttys002" }),
        proc({ pid: 3, tty: "ttys003" }),
      ],
      panes: [
        pane({ paneId: "%1", tty: "/dev/ttys001" }),
        pane({ paneId: "%2", tty: "/dev/ttys002" }),
        pane({ paneId: "%3", tty: "/dev/ttys003" }),
      ],
      markerPidBySessionId: new Map([
        ["s1", 1],
        ["s2", 2],
        ["s3", 3],
      ]),
    });

    const byId = Object.fromEntries(bindings.map((b) => [b.sessionId, b]));
    expect(bindings).toHaveLength(3);
    expect(byId["s1"]).toMatchObject({
      paneId: "%1",
      pid: 1,
      provenance: "marker",
      confidence: "authoritative",
    });
    expect(byId["s2"]).toMatchObject({ paneId: "%2", pid: 2 });
    expect(byId["s3"]).toMatchObject({ paneId: "%3", pid: 3 });
  });

  it("simulates the soft-evict: a P1 claim strips a same-cwd holder so later panes can't P2-match it", () => {
    // Pane %1 processing binds "marked" (marker) -> "holder" is evicted
    // (pane AND pid nulled). Pane %2's process pid 43 must then NOT
    // P3-match "holder" via its old pid.
    const bindings = decideScanBindings({
      sessions: [
        slice({ id: "holder", tmuxPane: "%1", pid: 43 }),
        slice({ id: "marked" }),
      ],
      processes: [
        proc({ pid: 42, tty: "ttys001" }),
        proc({ pid: 43, tty: "ttys002" }),
      ],
      panes: [
        pane({ paneId: "%1", tty: "/dev/ttys001" }),
        pane({ paneId: "%2", tty: "/dev/ttys002" }),
      ],
      markerPidBySessionId: new Map([["marked", 42]]),
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0].sessionId).toBe("marked");
  });

  it("AT-F2: a cross-cwd stale claim does not block the pane's real session", () => {
    // X (cwd /a) stale-holds %1; Y (cwd /b) owns the pid actually live on
    // %1. Y must bind — and the (now cwd-agnostic) soft-evict strips X at
    // apply time, so the two never share the pane.
    const bindings = decideScanBindings({
      sessions: [
        slice({ id: "X", cwd: "/a", tmuxPane: "%1", pid: 99 }),
        slice({ id: "Y", cwd: "/b", tmuxPane: null, pid: 42 }),
      ],
      processes: [proc({ pid: 42, cwd: "/b", tty: "ttys001" })],
      panes: [pane({ paneId: "%1", tty: "/dev/ttys001" })],
      markerPidBySessionId: NO_MARKERS,
    });

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ sessionId: "Y", paneId: "%1" });
  });

  it("AT-F1: bindings are injective over panes, pids, and sessions (property sweep)", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

    for (let round = 0; round < 150; round++) {
      const paneIds = ["%1", "%2", "%3", "%4"];
      const cwds = ["/a", "/b"];
      const procs: ProcessInfo[] = Array.from(
        { length: 1 + Math.floor(rand() * 4) },
        (_, i) =>
          proc({
            pid: i + 1,
            cwd: pick(cwds),
            tty: `ttys00${i + 1}`,
          }),
      );
      const panes: TmuxPane[] = paneIds.map((paneId, i) =>
        pane({ paneId, tty: `/dev/ttys00${i + 1}`, panePid: 500 + i }),
      );
      // Prior state may be arbitrarily wrong: duplicate pids, duplicate
      // pane claims, dangling references.
      const sessions: SessionSlice[] = Array.from(
        { length: 1 + Math.floor(rand() * 5) },
        (_, i) =>
          slice({
            id: `s${i}`,
            cwd: pick(cwds),
            tmuxPane: rand() < 0.5 ? pick(paneIds) : null,
            pid: rand() < 0.5 ? 1 + Math.floor(rand() * 4) : null,
          }),
      );
      const markers = new Map<string, number | null>();
      for (const s of sessions) {
        if (rand() < 0.3) markers.set(s.id, 1 + Math.floor(rand() * 4));
      }

      const bindings = decideScanBindings({
        sessions,
        processes: procs,
        panes,
        markerPidBySessionId: markers,
      });

      const paneSet = bindings.map((b) => b.paneId).filter(Boolean);
      const pidSet = bindings.map((b) => b.pid).filter((p) => p !== null);
      const sessionSet = bindings.map((b) => b.sessionId);
      expect(new Set(paneSet).size).toBe(paneSet.length);
      expect(new Set(pidSet).size).toBe(pidSet.length);
      expect(new Set(sessionSet).size).toBe(sessionSet.length);
    }
  });
});

// ---------------------------------------------------------------------------
// decideNewSessionPane (ladder 2)
// ---------------------------------------------------------------------------

function newPaneObs(
  overrides: Partial<NewSessionPaneObservation> = {},
): NewSessionPaneObservation {
  return {
    processes: [proc()],
    panes: [pane()],
    sessionId: "s-new",
    encodedProjectPath: "-repo-a",
    transcriptCwd: null,
    getSessionTimestamps: () => [],
    sessions: [],
    ...overrides,
  };
}

describe("decideNewSessionPane", () => {
  it("returns none when no process matches the encoded cwd", () => {
    const decision = decideNewSessionPane(
      newPaneObs({ processes: [proc({ cwd: "/repo/b" })] }),
    );
    expect(decision.kind).toBe("none");
  });

  it("binds a 1×1 pairing whose timestamp is eligible", () => {
    const decision = decideNewSessionPane(
      newPaneObs({ getSessionTimestamps: () => [1_005_000] }),
    );
    expect(decision).toMatchObject({
      kind: "bound",
      pid: 100,
      provenance: "start-time",
      confidence: "probable",
    });
  });

  it("AT-D2: refuses the sole candidate when the gap exceeds the tolerance cap", () => {
    // Only eligible process started 40 minutes before the first prompt:
    // decline, don't bind an hours-stale pairing.
    const decision = decideNewSessionPane(
      newPaneObs({ getSessionTimestamps: () => [1_000_000 + 40 * 60_000] }),
    );
    expect(decision.kind).toBe("none");
  });

  it("AT-D4: refuses when the session has no usable timestamps", () => {
    const decision = decideNewSessionPane(newPaneObs());
    expect(decision.kind).toBe("none");
  });

  it("AT-D1: a process launched after the first prompt is ineligible", () => {
    // P_late started 45s AFTER the prompt (numerically closer than
    // P_early's 300s gap); direction makes it ineligible.
    const decision = decideNewSessionPane(
      newPaneObs({
        processes: [
          proc({ pid: 1, startTime: 700_000, tty: "ttys001" }),
          proc({ pid: 2, startTime: 1_045_000, tty: "ttys002" }),
        ],
        panes: [
          pane({ paneId: "%1", tty: "/dev/ttys001" }),
          pane({ paneId: "%2", tty: "/dev/ttys002" }),
        ],
        getSessionTimestamps: () => [1_000_000],
      }),
    );
    expect(decision).toMatchObject({ kind: "bound", pid: 1 });
  });

  it("AT-D3: refuses when the runner-up is within start-time jitter", () => {
    const decision = decideNewSessionPane(
      newPaneObs({
        processes: [
          proc({ pid: 1, startTime: 1_000_000, tty: "ttys001" }),
          proc({ pid: 2, startTime: 1_000_500, tty: "ttys002" }),
        ],
        panes: [
          pane({ paneId: "%1", tty: "/dev/ttys001" }),
          pane({ paneId: "%2", tty: "/dev/ttys002" }),
        ],
        getSessionTimestamps: () => [1_180_000],
      }),
    );
    expect(decision.kind).toBe("ambiguous");
  });

  it("a VERIFIED pane claim reserves the pane; a stale claim does not (F2)", () => {
    const verified = decideNewSessionPane(
      newPaneObs({
        getSessionTimestamps: () => [1_005_000],
        sessions: [{ tmuxPane: "%1", pid: 100 }],
      }),
    );
    expect(verified.kind).toBe("none");

    // Same claim but the pid is NOT the pane's live process: unverified,
    // does not block (cross-cwd stale claims land here too).
    const stale = decideNewSessionPane(
      newPaneObs({
        getSessionTimestamps: () => [1_005_000],
        sessions: [{ tmuxPane: "%1", pid: 999 }],
      }),
    );
    expect(stale.kind).toBe("bound");
  });

  it("AT-R1: raw transcript cwd separates encoded-collision siblings", () => {
    // /x/a.b and /x/a-b encode identically; identical start times would be
    // hopelessly ambiguous on timing alone. The raw cwd keys the match.
    const decision = decideNewSessionPane(
      newPaneObs({
        processes: [
          proc({ pid: 1, cwd: "/x/a.b", tty: "ttys001" }),
          proc({ pid: 2, cwd: "/x/a-b", tty: "ttys002" }),
        ],
        panes: [
          pane({ paneId: "%1", tty: "/dev/ttys001" }),
          pane({ paneId: "%2", tty: "/dev/ttys002" }),
        ],
        encodedProjectPath: "-x-a-b",
        transcriptCwd: "/x/a.b",
        getSessionTimestamps: () => [1_005_000],
      }),
    );
    expect(decision).toMatchObject({ kind: "bound", pid: 1 });
  });
});

// ---------------------------------------------------------------------------
// encodingDriftWarning
// ---------------------------------------------------------------------------

describe("encodingDriftWarning", () => {
  it("is silent when the raw cwd re-encodes to the on-disk dir", () => {
    expect(encodingDriftWarning("/repo/a", "-repo-a")).toBeNull();
  });

  it("AT-R2: warns with both encodings when they disagree", () => {
    const warning = encodingDriftWarning("/repo/ä", "-repo-a");
    expect(warning).toContain("/repo/ä");
    expect(warning).toContain("-repo--");
    expect(warning).toContain("-repo-a");
  });
});

// ---------------------------------------------------------------------------
// decideReplaceHeuristic
// ---------------------------------------------------------------------------

describe("decideReplaceHeuristic", () => {
  it("targets the first same-encoded-cwd claude session with a pane", () => {
    const decision = decideReplaceHeuristic(
      [rSlice({ id: "old", tmuxPane: "%3" })],
      "-repo-a",
    );
    expect(decision).toEqual({
      removeSessionId: "old",
      removeLogPath: "/logs/-repo-a/s1.jsonl",
      paneId: "%3",
    });
  });

  it("never replaces a marker-backed session", () => {
    expect(
      decideReplaceHeuristic([rSlice({ hasMarker: true })], "-repo-a"),
    ).toBeNull();
  });

  it("bails on the FIRST match (no fallthrough to later candidates)", () => {
    // First match lacks a logPath -> null, even though the second would
    // qualify. Pinned current behavior.
    const decision = decideReplaceHeuristic(
      [
        rSlice({ id: "first", logPath: null }),
        rSlice({ id: "second", tmuxPane: "%4" }),
      ],
      "-repo-a",
    );
    expect(decision).toBeNull();
  });

  it("honors the caller's pane verification", () => {
    expect(
      decideReplaceHeuristic([rSlice()], "-repo-a", () => false),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideInitialClaudeBatch (ladder 3)
// ---------------------------------------------------------------------------

function batchItem(overrides: Partial<InitialBatchItem>): InitialBatchItem {
  return {
    path: "/logs/-repo-a/x.jsonl",
    sessionId: "x",
    encodedProjectPath: "-repo-a",
    mtimeMs: 1_000,
    ...overrides,
  };
}

function batchObs(
  overrides: Partial<InitialBatchObservation> = {},
): InitialBatchObservation {
  return {
    processes: [],
    panes: [],
    sessions: [],
    markerPidBySessionId: NO_MARKERS,
    getSessionTimestamps: () => [],
    getTranscriptCwd: () => null,
    ...overrides,
  };
}

describe("decideInitialClaudeBatch", () => {
  const twoProcsTwoPanes = {
    processes: [
      proc({ pid: 1, tty: "ttys001", startTime: 1_000 }),
      proc({ pid: 2, tty: "ttys002", startTime: 9_000 }),
    ],
    panes: [
      pane({ paneId: "%1", tty: "/dev/ttys001" }),
      pane({ paneId: "%2", tty: "/dev/ttys002" }),
    ],
  };

  it("marker claims settle first (phase A), then the assignment binds the rest", () => {
    const { actions, warnings } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "plain", path: "/p/plain.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "marked", path: "/p/marked.jsonl", mtimeMs: 1 }),
      ],
      batchObs({
        ...twoProcsTwoPanes,
        markerPidBySessionId: new Map([["marked", 2]]),
        getSessionTimestamps: (sessionId) =>
          sessionId === "plain" ? [2_000] : [],
      }),
    );

    expect(warnings).toEqual([]);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      type: "create",
      sessionId: "marked",
      paneId: "%2",
      pid: 2,
      provenance: "marker",
      confidence: "authoritative",
    });
    expect(actions[1]).toMatchObject({
      type: "create",
      sessionId: "plain",
      paneId: "%1",
      provenance: "start-time",
    });
  });

  // Issue #156: the applier used to derive the cwd by decoding the project
  // dir name, which cannot tell a `-` in a directory name from the `/` it
  // encodes. Every creating arm now carries the real one.
  it("carries the bound process's real cwd on a marker claim", () => {
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({
          sessionId: "marked",
          encodedProjectPath: "-repo-notes-cli",
        }),
      ],
      batchObs({
        processes: [proc({ pid: 2, tty: "ttys002", cwd: "/repo/notes-cli" })],
        panes: [pane({ paneId: "%2", tty: "/dev/ttys002" })],
        markerPidBySessionId: new Map([["marked", 2]]),
      }),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "create",
      provenance: "marker",
      cwd: "/repo/notes-cli",
    });
  });

  it("prefers the transcript's own cwd over the bound process's", () => {
    const { actions } = decideInitialClaudeBatch(
      [batchItem({ sessionId: "marked", encodedProjectPath: "-nowhere" })],
      batchObs({
        // The encoded key matches no process, so the drift fallback reads the
        // transcript and matches on the raw cwd instead.
        processes: [proc({ pid: 2, tty: "ttys002", cwd: "/repo/notes-cli" })],
        panes: [pane({ paneId: "%2", tty: "/dev/ttys002" })],
        markerPidBySessionId: new Map([["marked", 2]]),
        getTranscriptCwd: () => "/repo/notes-cli",
      }),
    );

    expect(actions[0]).toMatchObject({
      type: "create",
      cwd: "/repo/notes-cli",
    });
  });

  it("carries the real cwd on a heuristic binding too", () => {
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({
          sessionId: "plain",
          encodedProjectPath: "-repo-notes-cli",
        }),
      ],
      batchObs({
        processes: [
          proc({
            pid: 1,
            tty: "ttys001",
            cwd: "/repo/notes-cli",
            startTime: 1_000,
          }),
        ],
        panes: [pane({ paneId: "%1", tty: "/dev/ttys001" })],
        getSessionTimestamps: () => [2_000],
      }),
    );

    expect(actions[0]).toMatchObject({
      type: "create",
      provenance: "start-time",
      cwd: "/repo/notes-cli",
    });
  });

  it("existing sessions reserve their pane and get process-existing", () => {
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "known", path: "/p/known.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "fresh", path: "/p/fresh.jsonl", mtimeMs: 1 }),
      ],
      batchObs({
        processes: [proc({ pid: 1, tty: "ttys001" })],
        panes: [pane({ paneId: "%1", tty: "/dev/ttys001" })],
        sessions: [rSlice({ id: "known", tmuxPane: "%1" })],
        getSessionTimestamps: () => [1_005_000],
      }),
    );

    // "known" reserves %1, so "fresh" has no available candidate and no
    // marker to justify a replace -> only one action.
    expect(actions).toEqual([
      { type: "process-existing", sessionId: "known", path: "/p/known.jsonl" },
    ]);
  });

  it("AT-D4: items with no usable timestamps produce no actions at all", () => {
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "a", path: "/p/a.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "b", path: "/p/b.jsonl", mtimeMs: 5 }),
      ],
      batchObs({ ...twoProcsTwoPanes }),
    );

    expect(actions).toEqual([]);
  });

  it("AT-D5: a no-signal item does NOT inherit the leftover pane after a timestamped bind", () => {
    // Pre-Phase-3: "a" correlated to %2, then "b" auto-bound the leftover
    // %1 with zero signal — the exact cascade that turned one guess into a
    // permutation. Now "b" simply produces nothing.
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "a", path: "/p/a.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "b", path: "/p/b.jsonl", mtimeMs: 5 }),
      ],
      batchObs({
        ...twoProcsTwoPanes,
        getSessionTimestamps: (sessionId) => (sessionId === "a" ? [9_100] : []),
      }),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "create",
      sessionId: "a",
      paneId: "%2",
      provenance: "start-time",
    });
  });

  it("AT-D3: the demo scenario yields three visibly UNBOUND rows, never a permutation", () => {
    // Three same-cwd no-marker sessions, three processes launched within
    // ~1s, prompts typed minutes later: every pairing is eligible and the
    // timing carries no per-pane signal.
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "a", path: "/p/a.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "b", path: "/p/b.jsonl", mtimeMs: 5 }),
        batchItem({ sessionId: "c", path: "/p/c.jsonl", mtimeMs: 1 }),
      ],
      batchObs({
        processes: [
          proc({ pid: 1, tty: "ttys001", startTime: 1_000_000 }),
          proc({ pid: 2, tty: "ttys002", startTime: 1_000_400 }),
          proc({ pid: 3, tty: "ttys003", startTime: 1_000_800 }),
        ],
        panes: [
          pane({ paneId: "%1", tty: "/dev/ttys001" }),
          pane({ paneId: "%2", tty: "/dev/ttys002" }),
          pane({ paneId: "%3", tty: "/dev/ttys003" }),
        ],
        getSessionTimestamps: (sessionId) =>
          sessionId === "a"
            ? [1_180_000]
            : sessionId === "b"
              ? [1_200_000]
              : [1_220_000],
      }),
    );

    expect(actions).toEqual([
      { type: "create-unbound", sessionId: "a", path: "/p/a.jsonl", cwd: null },
      { type: "create-unbound", sessionId: "b", path: "/p/b.jsonl", cwd: null },
      { type: "create-unbound", sessionId: "c", path: "/p/c.jsonl", cwd: null },
    ]);
  });

  it("AT-D6: solves the group globally where greedy-closest-first cascades wrong", () => {
    // s1's closest process (by gap) is pid 2 — but pid 2's pane is s2's
    // ONLY eligible match (s2 is out of tolerance for pid 1). Greedy took
    // %2 for s1 and stranded s2; the assignment binds both correctly, and
    // the sort order (s1 first by mtime) no longer matters.
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "s1", path: "/p/s1.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "s2", path: "/p/s2.jsonl", mtimeMs: 5 }),
      ],
      batchObs({
        processes: [
          proc({ pid: 1, tty: "ttys001", startTime: 0 }),
          proc({ pid: 2, tty: "ttys002", startTime: 300_000 }),
        ],
        panes: [
          pane({ paneId: "%1", tty: "/dev/ttys001" }),
          pane({ paneId: "%2", tty: "/dev/ttys002" }),
        ],
        getSessionTimestamps: (sessionId) =>
          sessionId === "s1" ? [302_000] : [601_000],
      }),
    );

    const byId = Object.fromEntries(
      actions.map((a) => [
        "sessionId" in a ? a.sessionId : "",
        a as { paneId?: string },
      ]),
    );
    expect(actions).toHaveLength(2);
    expect(byId["s1"]).toMatchObject({ type: "create", paneId: "%1" });
    expect(byId["s2"]).toMatchObject({ type: "create", paneId: "%2" });
  });

  it("AT-D7: a resumed session correlates to today's run, not its original prompt", () => {
    const threeDays = 259_200_000;
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "resumed", path: "/p/r.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "fresh", path: "/p/f.jsonl", mtimeMs: 5 }),
      ],
      batchObs({
        processes: [
          proc({ pid: 1, tty: "ttys001", startTime: threeDays }),
          proc({ pid: 2, tty: "ttys002", startTime: threeDays + 60_000 }),
        ],
        panes: [
          pane({ paneId: "%1", tty: "/dev/ttys001" }),
          pane({ paneId: "%2", tty: "/dev/ttys002" }),
        ],
        getSessionTimestamps: (sessionId) =>
          sessionId === "resumed"
            ? [1_000, threeDays + 5_000] // 3-day-old prompt + today's
            : [threeDays + 65_000],
      }),
    );

    const byId = Object.fromEntries(
      actions.map((a) => [
        "sessionId" in a ? a.sessionId : "",
        a as { paneId?: string },
      ]),
    );
    expect(actions).toHaveLength(2);
    expect(byId["resumed"]).toMatchObject({ type: "create", paneId: "%1" });
    expect(byId["fresh"]).toMatchObject({ type: "create", paneId: "%2" });
  });

  it("AT-R1: encoded-collision siblings bind by raw cwd, not timing", () => {
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({
          sessionId: "sA",
          path: "/p/sA.jsonl",
          encodedProjectPath: "-x-a-b",
          mtimeMs: 9,
        }),
        batchItem({
          sessionId: "sB",
          path: "/p/sB.jsonl",
          encodedProjectPath: "-x-a-b",
          mtimeMs: 5,
        }),
      ],
      batchObs({
        processes: [
          proc({ pid: 1, cwd: "/x/a.b", tty: "ttys001" }),
          proc({ pid: 2, cwd: "/x/a-b", tty: "ttys002" }),
        ],
        panes: [
          pane({ paneId: "%1", tty: "/dev/ttys001" }),
          pane({ paneId: "%2", tty: "/dev/ttys002" }),
        ],
        getSessionTimestamps: () => [1_005_000],
        getTranscriptCwd: (path) =>
          path === "/p/sA.jsonl" ? "/x/a.b" : "/x/a-b",
      }),
    );

    const byId = Object.fromEntries(
      actions.map((a) => [
        "sessionId" in a ? a.sessionId : "",
        a as { paneId?: string },
      ]),
    );
    expect(actions).toHaveLength(2);
    expect(byId["sA"]).toMatchObject({ type: "create", paneId: "%1" });
    expect(byId["sB"]).toMatchObject({ type: "create", paneId: "%2" });
  });

  it("AT-R2: encoding drift warns once and still binds via raw cwd", () => {
    // Claude drifted: the on-disk dir is '-repo-a' but our encoder maps
    // the real cwd elsewhere. Raw-cwd candidate selection still finds the
    // process; the canary makes the drift observable.
    const { actions, warnings } = decideInitialClaudeBatch(
      [batchItem({ sessionId: "sD", path: "/p/sD.jsonl", mtimeMs: 9 })],
      batchObs({
        processes: [proc({ pid: 1, cwd: "/repo/ä", tty: "ttys001" })],
        panes: [pane({ paneId: "%1", tty: "/dev/ttys001" })],
        getSessionTimestamps: () => [1_005_000],
        getTranscriptCwd: () => "/repo/ä",
      }),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("encoding drift");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "create",
      sessionId: "sD",
      paneId: "%1",
    });
  });

  it("replaces a heuristic session when its pane was reserved earlier in the batch and the newcomer's marker pid matches", () => {
    // "known" (marker exists but pid-less: sorts into the marker group, yet
    // stays replaceable — the replace guard needs a marker WITH a pid)
    // processes first and reserves %1. "marked" then finds no available
    // pane and takes the replace arm; its marker pid matches %1's process.
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "known", path: "/p/known.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "marked", path: "/p/marked.jsonl", mtimeMs: 1 }),
      ],
      batchObs({
        processes: [proc({ pid: 7, tty: "ttys001" })],
        panes: [pane({ paneId: "%1", tty: "/dev/ttys001" })],
        sessions: [
          rSlice({ id: "known", tmuxPane: "%1", encodedCwd: "-repo-a" }),
        ],
        markerPidBySessionId: new Map<string, number | null>([
          ["known", null],
          ["marked", 7],
        ]),
      }),
    );

    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      type: "process-existing",
      sessionId: "known",
    });
    expect(actions[1]).toMatchObject({
      type: "replace",
      removeSessionId: "known",
      sessionId: "marked",
      paneId: "%1",
      pid: 7,
    });
  });

  it("does not replace when the marker pid doesn't match the pane's process", () => {
    const { actions } = decideInitialClaudeBatch(
      [
        batchItem({ sessionId: "known", path: "/p/known.jsonl", mtimeMs: 9 }),
        batchItem({ sessionId: "marked", path: "/p/marked.jsonl", mtimeMs: 1 }),
      ],
      batchObs({
        processes: [proc({ pid: 7, tty: "ttys001" })],
        panes: [pane({ paneId: "%1", tty: "/dev/ttys001" })],
        sessions: [
          rSlice({ id: "known", tmuxPane: "%1", encodedCwd: "-repo-a" }),
        ],
        markerPidBySessionId: new Map<string, number | null>([
          ["known", null],
          ["marked", 999],
        ]),
      }),
    );

    expect(actions).toEqual([
      { type: "process-existing", sessionId: "known", path: "/p/known.jsonl" },
    ]);
  });

  it("AT-O3: a marker pid that fails pane verification earns no trust — the item competes as a heuristic", () => {
    // The marker claims pid 999 but the pane's live process is 7. The item
    // still binds (its timestamp is eligible) with the PANE's pid, and only
    // probable confidence — never the marker's unverified pid.
    const { actions } = decideInitialClaudeBatch(
      [batchItem({ sessionId: "marked", path: "/p/marked.jsonl" })],
      batchObs({
        processes: [proc({ pid: 7, tty: "ttys001" })],
        panes: [pane({ paneId: "%1", tty: "/dev/ttys001" })],
        markerPidBySessionId: new Map([["marked", 999]]),
        getSessionTimestamps: () => [1_005_000],
      }),
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: "create",
      sessionId: "marked",
      paneId: "%1",
      pid: 7,
      provenance: "start-time",
      confidence: "probable",
    });
  });
});

// ---------------------------------------------------------------------------
// decideMigrationBindings (ladder 4)
// ---------------------------------------------------------------------------

describe("decideMigrationBindings", () => {
  const baseObs = {
    processes: [proc({ pid: 1, tty: "ttys001", cwd: "/repo/a" })],
    panes: [pane({ paneId: "%1", tty: "/dev/ttys001" })],
    markers: [] as { session_id: string; pid: number }[],
    historyEntries: [] as {
      project: string;
      sessionId: string;
      timestamp: number;
    }[],
    existingSessionIds: new Set<string>(),
    logPathExists: () => true,
  };

  it("P0: marker pid match is authoritative", () => {
    const { bindings } = decideMigrationBindings({
      ...baseObs,
      markers: [{ session_id: "m1", pid: 1 }],
    });
    expect(bindings).toEqual([
      {
        sessionId: "m1",
        cwd: "/repo/a",
        paneId: "%1",
        pid: 1,
        provenance: "marker",
        confidence: "authoritative",
      },
    ]);
  });

  it("P1: start-time correlation within tolerance", () => {
    const { bindings } = decideMigrationBindings({
      ...baseObs,
      processes: [
        proc({ pid: 1, tty: "ttys001", cwd: "/repo/a", startTime: 50_000 }),
      ],
      historyEntries: [
        { project: "/repo/a", sessionId: "h1", timestamp: 60_000 },
      ],
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sessionId: "h1",
      provenance: "start-time",
      confidence: "probable",
    });
  });

  it("AT-D1 (migrate): a history entry BEFORE the process start no longer matches", () => {
    // Old behavior matched on absolute distance, so an entry 10s before
    // the launch bound; direction now refuses it.
    const { bindings } = decideMigrationBindings({
      ...baseObs,
      processes: [
        proc({ pid: 1, tty: "ttys001", cwd: "/repo/a", startTime: 50_000 }),
      ],
      historyEntries: [
        { project: "/repo/a", sessionId: "h1", timestamp: 40_000 },
      ],
    });
    expect(bindings).toEqual([]);
  });

  it("AT-D3 (migrate): jitter-close processes refuse rather than permute", () => {
    const { bindings } = decideMigrationBindings({
      ...baseObs,
      processes: [
        proc({ pid: 1, tty: "ttys001", cwd: "/repo/a", startTime: 1_000_000 }),
        proc({ pid: 2, tty: "ttys002", cwd: "/repo/a", startTime: 1_000_500 }),
      ],
      panes: [
        pane({ paneId: "%1", tty: "/dev/ttys001" }),
        pane({ paneId: "%2", tty: "/dev/ttys002" }),
      ],
      historyEntries: [
        { project: "/repo/a", sessionId: "h1", timestamp: 1_180_000 },
        { project: "/repo/a", sessionId: "h2", timestamp: 1_200_000 },
      ],
    });
    expect(bindings).toEqual([]);
  });

  it("AT-D6 (migrate): the same-cwd group solves globally", () => {
    const { bindings } = decideMigrationBindings({
      ...baseObs,
      processes: [
        proc({ pid: 1, tty: "ttys001", cwd: "/repo/a", startTime: 0 }),
        proc({ pid: 2, tty: "ttys002", cwd: "/repo/a", startTime: 300_000 }),
      ],
      panes: [
        pane({ paneId: "%1", tty: "/dev/ttys001" }),
        pane({ paneId: "%2", tty: "/dev/ttys002" }),
      ],
      historyEntries: [
        { project: "/repo/a", sessionId: "h1", timestamp: 302_000 },
        { project: "/repo/a", sessionId: "h2", timestamp: 601_000 },
      ],
    });
    const byId = Object.fromEntries(bindings.map((b) => [b.sessionId, b]));
    expect(bindings).toHaveLength(2);
    expect(byId["h1"]).toMatchObject({ paneId: "%1" });
    expect(byId["h2"]).toMatchObject({ paneId: "%2" });
  });

  it("P2: pane-start correlation when process start is unusable", () => {
    const { bindings } = decideMigrationBindings({
      ...baseObs,
      processes: [
        proc({ pid: 1, tty: "ttys001", cwd: "/repo/a", startTime: null }),
      ],
      panes: [pane({ paneId: "%1", tty: "/dev/ttys001", startTime: 900 })],
      historyEntries: [
        { project: "/repo/a", sessionId: "h2", timestamp: 950_000 },
      ],
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0].sessionId).toBe("h2");
  });

  it("skips bindings whose log file does not exist and does not reserve the id", () => {
    const { bindings } = decideMigrationBindings({
      ...baseObs,
      markers: [{ session_id: "m1", pid: 1 }],
      logPathExists: () => false,
    });
    expect(bindings).toEqual([]);
  });

  it("already-known sessions are skipped; the same id can't bind twice", () => {
    const twoProcs = {
      ...baseObs,
      processes: [
        proc({ pid: 1, tty: "ttys001", cwd: "/repo/a" }),
        proc({ pid: 2, tty: "ttys002", cwd: "/repo/a" }),
      ],
      panes: [
        pane({ paneId: "%1", tty: "/dev/ttys001" }),
        pane({ paneId: "%2", tty: "/dev/ttys002" }),
      ],
      markers: [
        { session_id: "dup", pid: 1 },
        { session_id: "dup", pid: 2 },
      ],
    };
    const { bindings } = decideMigrationBindings(twoProcs);
    expect(bindings).toHaveLength(1);

    const none = decideMigrationBindings({
      ...twoProcs,
      existingSessionIds: new Set(["dup"]),
    });
    expect(none.bindings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// decideCodexRolloutLinks / decideMarkerLinks (ladder 5)
// ---------------------------------------------------------------------------

describe("decideCodexRolloutLinks", () => {
  const rollout = (id: string, cwd: string, ts: number) => ({
    path: `/rollouts/${id}.jsonl`,
    metadata: { nativeSessionId: id, cwd, timestamp: ts },
  });

  it("solves session↔rollout attribution group-wise", () => {
    // s2 started 30s in; r1 predates it (direction-ineligible for s2), so
    // the unique maximal assignment is the diagonal — independent of
    // candidate order, unlike the former greedy claim loop.
    const links = decideCodexRolloutLinks(
      [
        { sessionId: "s2", cwd: "/repo/a", startTime: 30_000 },
        { sessionId: "s1", cwd: "/repo/a", startTime: 1_000 },
      ],
      [rollout("r1", "/repo/a", 2_000), rollout("r2", "/repo/a", 31_000)],
    );

    expect(
      Object.fromEntries(
        links.map((l) => [l.sessionId, l.rollout.metadata.nativeSessionId]),
      ),
    ).toEqual({ s1: "r1", s2: "r2" });
  });

  it("AT-D3 (codex): refuses when rollout attribution is ambiguous", () => {
    // Two sessions started within a second, two rollouts equally close to
    // both: no permutation is signal. Formerly the greedy loop dealt them
    // in candidate order.
    const links = decideCodexRolloutLinks(
      [
        { sessionId: "s1", cwd: "/repo/a", startTime: 1_000 },
        { sessionId: "s2", cwd: "/repo/a", startTime: 1_000 },
      ],
      [rollout("r1", "/repo/a", 2_000), rollout("r2", "/repo/a", 3_000)],
    );
    expect(links).toEqual([]);
  });

  it("returns no link when no rollout falls in the forward window", () => {
    const links = decideCodexRolloutLinks(
      [{ sessionId: "s1", cwd: "/repo/a", startTime: 1_000 }],
      [rollout("r1", "/repo/a", 900_000)],
    );
    expect(links).toEqual([]);
  });
});

describe("decideMarkerLinks", () => {
  it("pairs each unlinked pane session with its own pane's marker", () => {
    const links = decideMarkerLinks(
      [
        { sessionId: "a", tmuxPane: "%1", nativeSessionId: null },
        { sessionId: "b", tmuxPane: "%2", nativeSessionId: null },
        { sessionId: "c", tmuxPane: null, nativeSessionId: null },
      ],
      [
        { session_id: "m1", pid: 10 },
        { session_id: "m2", pid: 20 },
      ],
      new Map([
        [10, "%1"],
        [20, null], // marker not hosted by any pane -> no link
      ]),
    );

    expect(links).toEqual([
      { sessionId: "a", marker: { session_id: "m1", pid: 10 } },
    ]);
  });

  it("picks the pane's freshest marker when several are hosted by it", () => {
    const links = decideMarkerLinks(
      [{ sessionId: "a", tmuxPane: "%1", nativeSessionId: null }],
      [
        { session_id: "old", pid: 10, timestamp: 100 },
        { session_id: "new", pid: 11, timestamp: 200, state_timestamp: 300 },
      ],
      new Map([
        [10, "%1"],
        [11, "%1"],
      ]),
    );

    expect(links.map((l) => l.marker.session_id)).toEqual(["new"]);
  });

  it("skips a session that already owns one of its pane's marker ids (verified owner)", () => {
    // Includes holding an OLDER sibling id: the event path chose it; the
    // scan link must not flap the id to the fresher sibling.
    const links = decideMarkerLinks(
      [{ sessionId: "a", tmuxPane: "%1", nativeSessionId: "old" }],
      [
        { session_id: "old", pid: 10, timestamp: 100 },
        { session_id: "new", pid: 11, timestamp: 200 },
      ],
      new Map([
        [10, "%1"],
        [11, "%1"],
      ]),
    );

    expect(links).toEqual([]);
  });

  it("AT-E1: a session holding an id none of its pane's markers carry is re-linked", () => {
    // Session "a" heuristically grabbed an id that really belongs to
    // another pane's session. Pre-Phase-2 any non-null
    // nativeSessionId was skipped forever; now its own pane's marker is
    // re-dispatched so the reclaim path can heal both rows.
    const links = decideMarkerLinks(
      [
        { sessionId: "a", tmuxPane: "%1", nativeSessionId: "id-of-b" },
        { sessionId: "b", tmuxPane: "%2", nativeSessionId: null },
      ],
      [
        { session_id: "id-of-a", pid: 10 },
        { session_id: "id-of-b", pid: 20 },
      ],
      new Map([
        [10, "%1"],
        [20, "%2"],
      ]),
    );

    expect(links).toEqual([
      { sessionId: "a", marker: { session_id: "id-of-a", pid: 10 } },
      { sessionId: "b", marker: { session_id: "id-of-b", pid: 20 } },
    ]);
  });

  it("pid-recycling tripwire: a marker older than its hosting process never links", () => {
    // Marker written at t=100s, but pid 10's live process started at
    // t=500s: the pid was recycled onto an unrelated process.
    const links = decideMarkerLinks(
      [{ sessionId: "a", tmuxPane: "%1", nativeSessionId: null }],
      [{ session_id: "m1", pid: 10, timestamp: 100 }],
      new Map([[10, "%1"]]),
      new Map([[10, 500_000]]),
    );
    expect(links).toEqual([]);
  });

  it("pid-recycling tripwire fails open without positive evidence", () => {
    const sessions = [
      { sessionId: "a", tmuxPane: "%1", nativeSessionId: null },
    ];
    const paneByPid = new Map([[10, "%1"]]);

    // No start-time map at all.
    expect(
      decideMarkerLinks(
        sessions,
        [{ session_id: "m1", pid: 10, timestamp: 100 }],
        paneByPid,
      ),
    ).toHaveLength(1);

    // Pid missing from the map.
    expect(
      decideMarkerLinks(
        sessions,
        [{ session_id: "m1", pid: 10, timestamp: 100 }],
        paneByPid,
        new Map(),
      ),
    ).toHaveLength(1);

    // Marker without a creation timestamp.
    expect(
      decideMarkerLinks(
        sessions,
        [{ session_id: "m1", pid: 10 }],
        paneByPid,
        new Map([[10, 500_000]]),
      ),
    ).toHaveLength(1);
  });
});
