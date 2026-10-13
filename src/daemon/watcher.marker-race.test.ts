import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { ProcessInfo, TmuxPane } from "../types/session";
import * as paneDiscovery from "./pane-discovery";
import * as processes from "./processes";
import * as sessionMarkers from "./session-markers";
import * as history from "./adapters/claude/history";
import { ProcessTree } from "./process-tree";
import { SessionManager, type SessionEvent } from "./sessions";
import { LogWatcher } from "./watcher";
import { ClaudeLogAdapter } from "./adapters/claude/log-adapter";

/**
 * /clear starts a new Claude session in the SAME process and pane. Claude
 * writes the new transcript ~100ms before its SessionStart hook writes the
 * marker, so the transcript's add runs with no marker, and the start-time
 * fallback finds no free pane because the pre-clear session still holds it.
 * The marker then lands while that add is awaiting tmux/ps, and
 * `handleMarkerAdded` skips the path because it is still watched. The add
 * must notice the late marker instead of unwatching the transcript, or the
 * session stays untracked until the daemon restarts.
 */

type WatcherInternals = {
  handleAdd(path: string): Promise<void>;
  watchedFiles: Set<string>;
};

const PANE_PID = 500;
const AGENT_PID = 502;
const AGENT_START = 1_000_000;
const AGENT_2_START = 2_000_000;
const OLD_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const NEW_SESSION_ID = "22222222-2222-4222-8222-222222222222";

const PANE: TmuxPane = {
  paneId: "%1",
  panePid: PANE_PID,
  sessionName: "main",
  windowIndex: 1,
  paneIndex: 1,
  target: "main:1.1",
  tty: "/dev/ttys041",
  startTime: 900,
  windowActivity: null,
  paneTitle: null,
  currentCommand: "claude",
  currentPath: "/repo/a",
};

const PROC: ProcessInfo = {
  pid: AGENT_PID,
  command: "claude",
  agentType: "claude",
  tty: "ttys041",
  cwd: "/repo/a",
  startTime: AGENT_START,
};

/** A second Claude in the same cwd, started well after the first. */
const PANE_2: TmuxPane = {
  ...PANE,
  paneId: "%2",
  panePid: 600,
  paneIndex: 2,
  target: "main:1.2",
  tty: "/dev/ttys042",
};

const PROC_2: ProcessInfo = {
  ...PROC,
  pid: 602,
  tty: "ttys042",
  startTime: AGENT_2_START,
};

const TREE = ProcessTree.fromPsOutput(
  [
    "  PID  PPID COMM",
    `  ${PANE_PID}     1 /bin/zsh`,
    `  ${AGENT_PID}   ${PANE_PID} claude`,
  ].join("\n"),
);

function marker(sessionId: string): sessionMarkers.SessionPidMarker {
  return {
    agent_type: "claude",
    pid: AGENT_PID,
    tty: "ttys041",
    session_id: sessionId,
    timestamp: 1_000_001,
  };
}

/** The new session's first prompt, shortly after a Claude started. */
function promptAfter(startTime: number): history.HistoryEntry {
  return {
    project: "/repo/a",
    sessionId: NEW_SESSION_ID,
    timestamp: startTime + 500,
  };
}

const spies: { mockRestore(): void }[] = [];
const tempDirs: string[] = [];

/**
 * Stub tmux/ps, the marker cache, and Claude's history. The first
 * `holdCalls` calls to `listTmuxPanes` block until `release` is called, and
 * `entered` resolves once all of them are waiting. With the default of one,
 * that is the start-time fallback's call, the window in which a test lands
 * the marker.
 */
function stubDiscovery(
  markers: Map<string, sessionMarkers.SessionPidMarker>,
  {
    holdCalls = 1,
    historyEntries = [],
    panes = [PANE],
    procs = [PROC],
  }: {
    holdCalls?: number;
    historyEntries?: history.HistoryEntry[];
    panes?: TmuxPane[];
    procs?: ProcessInfo[];
  } = {},
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let calls = 0;

  spies.push(
    spyOn(sessionMarkers, "getSessionPidMarker").mockImplementation(
      (id: string) => markers.get(id) ?? null,
    ),
    spyOn(paneDiscovery, "listTmuxPanes").mockImplementation(async () => {
      if (calls < holdCalls) {
        if (++calls === holdCalls) signalEntered();
        await gate;
      }
      return panes;
    }),
    spyOn(processes, "discoverAgentProcesses").mockResolvedValue(procs),
    spyOn(ProcessTree, "build").mockResolvedValue(TREE),
    spyOn(history, "readClaudeHistory").mockReturnValue(historyEntries),
  );

  return { entered, release };
}

/**
 * A clear-in-place setup: the old session holds %1, the new transcript
 * exists. Without `clearInPlace` the new transcript is a fresh launch and %1
 * is free.
 */
function setup({ clearInPlace = true }: { clearInPlace?: boolean } = {}) {
  const manager = new SessionManager();
  const watcher = new LogWatcher(new ClaudeLogAdapter(manager), manager);

  const root = mkdtempSync(join(tmpdir(), "ccmux-marker-race-"));
  tempDirs.push(root);
  const projectDir = join(root, "projects", "-repo-a");
  mkdirSync(projectDir, { recursive: true });

  if (clearInPlace) {
    const oldPath = join(projectDir, `${OLD_SESSION_ID}.jsonl`);
    writeFileSync(oldPath, "");
    manager.createSession(OLD_SESSION_ID, oldPath, "claude", "/repo/a");
    manager.setTmuxPane(OLD_SESSION_ID, PANE.paneId);
    manager.setPid(OLD_SESSION_ID, AGENT_PID);
  }

  const newPath = join(projectDir, `${NEW_SESSION_ID}.jsonl`);
  writeFileSync(
    newPath,
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2024-01-15T12:00:00Z",
      cwd: "/repo/a",
      message: { role: "user", content: "/clear" },
    }) + "\n",
  );

  return { manager, watcher, newPath };
}

/** The marker re-arm starts its add without awaiting it; poll for the result. */
async function until(pred: () => boolean, maxMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (pred()) return true;
    await Bun.sleep(5);
  }
  return pred();
}

function cleanUp() {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("LogWatcher: marker lands while a new transcript is being added", () => {
  afterEach(cleanUp);

  it("binds the session to its pane instead of dropping the transcript", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { entered, release } = stubDiscovery(markers);
    const { manager, watcher, newPath } = setup();

    const internals = watcher as unknown as WatcherInternals;
    const adding = internals.handleAdd(newPath);

    // The SessionStart hook's marker lands while the add awaits tmux/ps.
    await entered;
    markers.set(NEW_SESSION_ID, marker(NEW_SESSION_ID));
    watcher.handleMarkerAdded(marker(NEW_SESSION_ID));
    release();
    await adding;

    const session = manager.getSession(NEW_SESSION_ID);
    expect(session).toBeDefined();
    expect(session?.tmuxPane).toBe(PANE.paneId);
    expect(session?.pid).toBe(AGENT_PID);
    // Still watched, or the session's next write would be lost.
    expect(internals.watchedFiles.has(newPath)).toBe(true);
  });

  it("still drops the transcript when no marker ever arrives", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { release } = stubDiscovery(markers);
    const { manager, watcher, newPath } = setup();
    const internals = watcher as unknown as WatcherInternals;

    release();
    await internals.handleAdd(newPath);

    expect(manager.hasSession(NEW_SESSION_ID)).toBe(false);
    expect(internals.watchedFiles.has(newPath)).toBe(false);
  });

  it("re-arms the dropped transcript when the marker lands after the add", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { release } = stubDiscovery(markers);
    const { manager, watcher, newPath } = setup();
    const internals = watcher as unknown as WatcherInternals;

    release();
    await internals.handleAdd(newPath);
    expect(internals.watchedFiles.has(newPath)).toBe(false);

    // Too late for the add, so the marker finds the path unwatched, re-arms
    // it, and starts a fresh add that binds through the marker.
    markers.set(NEW_SESSION_ID, marker(NEW_SESSION_ID));
    watcher.handleMarkerAdded(marker(NEW_SESSION_ID));

    expect(internals.watchedFiles.has(newPath)).toBe(true);
    expect(
      await until(() => manager.getSession(NEW_SESSION_ID)?.pid === AGENT_PID),
    ).toBe(true);
    expect(manager.getSession(NEW_SESSION_ID)?.tmuxPane).toBe(PANE.paneId);
  });
});

/**
 * A change event starts an add for every write to a transcript that has no
 * session yet, and the marker re-arm and the retry above start more, so
 * several adds for one transcript can be in flight at once. All of them pass
 * the `hasSession` check before awaiting tmux/ps. Each one used to create the
 * session on resuming, and every create after the first swapped the bound
 * session for a fresh unbound one and emitted another `created`, which the
 * TUI appended as a frozen duplicate row.
 */
describe("LogWatcher: adds racing for one new transcript", () => {
  afterEach(cleanUp);

  const arms = [
    { through: "the marker", withMarker: true, historyEntries: [] },
    {
      through: "the start-time fallback",
      withMarker: false,
      historyEntries: [promptAfter(AGENT_START)],
    },
  ];

  for (const { through, withMarker, historyEntries } of arms) {
    it(`creates the session once when both adds bind through ${through}`, async () => {
      const markers = new Map<string, sessionMarkers.SessionPidMarker>();
      if (withMarker) markers.set(NEW_SESSION_ID, marker(NEW_SESSION_ID));
      const { entered, release } = stubDiscovery(markers, {
        holdCalls: 2,
        historyEntries,
      });
      const { manager, watcher, newPath } = setup({ clearInPlace: false });

      let created = 0;
      let bound = false;
      let unboundAfterBind = false;
      manager.on("change", (event: SessionEvent) => {
        if (event.session?.id !== NEW_SESSION_ID) return;
        if (event.type === "created") created++;
        if (event.session.tmuxPane !== null) bound = true;
        else if (bound) unboundAfterBind = true;
      });

      // Both adds are parked on tmux before either has created anything.
      const internals = watcher as unknown as WatcherInternals;
      const adds = [internals.handleAdd(newPath), internals.handleAdd(newPath)];
      await entered;
      expect(manager.hasSession(NEW_SESSION_ID)).toBe(false);
      release();
      await Promise.all(adds);

      expect(created).toBe(1);
      expect(unboundAfterBind).toBe(false);
      const session = manager.getSession(NEW_SESSION_ID);
      expect(session?.tmuxPane).toBe(PANE.paneId);
      expect(session?.pid).toBe(AGENT_PID);
    });
  }

  // The two cases below park one add on tmux, let a sibling create the
  // session in the meantime, then resume the first. `createSession` alone
  // would not stop the damage in either; only the add's own re-check does.

  it("keeps the marker's binding when a start-time guess resumes after it", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { entered, release } = stubDiscovery(markers, {
      panes: [PANE, PANE_2],
      procs: [PROC, PROC_2],
      // Points at the second Claude, so the guess is %2.
      historyEntries: [promptAfter(AGENT_2_START)],
    });
    const { manager, watcher, newPath } = setup({ clearInPlace: false });
    const internals = watcher as unknown as WatcherInternals;

    // This add read no marker, so it is waiting on the start-time fallback.
    const guessing = internals.handleAdd(newPath);
    await entered;

    // The marker lands and a later write's add binds the session through it.
    markers.set(NEW_SESSION_ID, marker(NEW_SESSION_ID));
    await internals.handleAdd(newPath);
    expect(manager.getSession(NEW_SESSION_ID)?.tmuxPane).toBe(PANE.paneId);

    release();
    await guessing;

    const session = manager.getSession(NEW_SESSION_ID);
    expect(session?.tmuxPane).toBe(PANE.paneId);
    expect(session?.pid).toBe(AGENT_PID);
  });

  it("keeps the transcript watched when the session appeared while it found no pane", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { entered, release } = stubDiscovery(markers, {
      historyEntries: [promptAfter(AGENT_START)],
    });
    const { manager, watcher, newPath } = setup({ clearInPlace: false });
    const internals = watcher as unknown as WatcherInternals;

    const late = internals.handleAdd(newPath);
    await entered;

    // A sibling binds the only pane first, so the parked add, once resumed,
    // finds nothing left for it.
    await internals.handleAdd(newPath);
    expect(manager.getSession(NEW_SESSION_ID)?.tmuxPane).toBe(PANE.paneId);

    release();
    await late;

    expect(manager.hasSession(NEW_SESSION_ID)).toBe(true);
    expect(internals.watchedFiles.has(newPath)).toBe(true);
  });
});
