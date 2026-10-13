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
import { SessionManager } from "./sessions";
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
};

const PANE_PID = 500;
const AGENT_PID = 502;
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
  startTime: 1_000_000,
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

const spies: { mockRestore(): void }[] = [];
const tempDirs: string[] = [];

/**
 * Stub tmux/ps and the marker cache. The FIRST `listTmuxPanes` call, made
 * by the start-time fallback, blocks until `release` is called, which is
 * the window in which the test lands the marker.
 */
function stubDiscovery(markers: Map<string, sessionMarkers.SessionPidMarker>) {
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
      if (calls++ === 0) {
        signalEntered();
        await gate;
      }
      return [PANE];
    }),
    spyOn(processes, "discoverAgentProcesses").mockResolvedValue([PROC]),
    spyOn(ProcessTree, "build").mockResolvedValue(TREE),
    spyOn(history, "readClaudeHistory").mockReturnValue([]),
  );

  return { entered, release };
}

/** A clear-in-place setup: the old session holds %1, the new transcript exists. */
function setup() {
  const manager = new SessionManager();
  const watcher = new LogWatcher(new ClaudeLogAdapter(manager), manager);

  const root = mkdtempSync(join(tmpdir(), "ccmux-marker-race-"));
  tempDirs.push(root);
  const projectDir = join(root, "projects", "-repo-a");
  mkdirSync(projectDir, { recursive: true });

  const oldPath = join(projectDir, `${OLD_SESSION_ID}.jsonl`);
  writeFileSync(oldPath, "");
  manager.createSession(OLD_SESSION_ID, oldPath, "claude", "/repo/a");
  manager.setTmuxPane(OLD_SESSION_ID, PANE.paneId);
  manager.setPid(OLD_SESSION_ID, AGENT_PID);

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

describe("LogWatcher: marker lands while a new transcript is being added", () => {
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds the session to its pane instead of dropping the transcript", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { entered, release } = stubDiscovery(markers);
    const { manager, watcher, newPath } = setup();

    const adding = (watcher as unknown as WatcherInternals).handleAdd(newPath);

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
  });

  it("still drops the transcript when no marker ever arrives", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { release } = stubDiscovery(markers);
    const { manager, watcher, newPath } = setup();

    release();
    await (watcher as unknown as WatcherInternals).handleAdd(newPath);

    expect(manager.hasSession(NEW_SESSION_ID)).toBe(false);
  });
});
