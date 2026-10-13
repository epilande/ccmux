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
 * The boot-time twin of watcher.marker-race.test.ts. A /clear while the
 * daemon starts puts the new transcript in the initial batch before its
 * SessionStart marker exists. The pre-clear session claims the pane, so the
 * binder gives the new transcript no action. The marker watcher is already
 * live, so the marker can land while the batch awaits its other actions, and
 * `handleMarkerAdded` skips the path because it is still watched. The batch
 * must notice the late marker instead of unwatching the transcript, or the
 * session stays untracked until the daemon restarts.
 */

type WatcherInternals = {
  processInitialHookBackedBatch(paths: string[]): Promise<void>;
  watchedFiles: Set<string>;
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

function transcriptLine(content: string): string {
  return (
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2024-01-15T12:00:00Z",
      cwd: "/repo/a",
      message: { role: "user", content },
    }) + "\n"
  );
}

const spies: { mockRestore(): void }[] = [];
const tempDirs: string[] = [];

/**
 * A daemon booting into a clear-in-place: the old session was restored (by
 * migration) bound to %1, and both transcripts are in the initial batch.
 * Deriving the old transcript's state, the batch's first await, blocks until
 * `release` is called, which is the window in which the test lands the
 * marker.
 */
function setup(markers: Map<string, sessionMarkers.SessionPidMarker>) {
  const manager = new SessionManager();
  const adapter = new ClaudeLogAdapter(manager);
  const watcher = new LogWatcher(adapter, manager);

  const root = mkdtempSync(join(tmpdir(), "ccmux-boot-marker-race-"));
  tempDirs.push(root);
  const projectDir = join(root, "projects", "-repo-a");
  mkdirSync(projectDir, { recursive: true });

  const oldPath = join(projectDir, `${OLD_SESSION_ID}.jsonl`);
  writeFileSync(oldPath, transcriptLine("hello"));
  manager.createSession(OLD_SESSION_ID, oldPath, "claude", "/repo/a");
  manager.setTmuxPane(OLD_SESSION_ID, PANE.paneId);
  manager.setPid(OLD_SESSION_ID, AGENT_PID);

  const newPath = join(projectDir, `${NEW_SESSION_ID}.jsonl`);
  writeFileSync(newPath, transcriptLine("/clear"));

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const deriveFullState = adapter.deriveFullState.bind(adapter);

  spies.push(
    spyOn(sessionMarkers, "getSessionPidMarker").mockImplementation(
      (id: string) => markers.get(id) ?? null,
    ),
    spyOn(sessionMarkers, "getMarkerPidSnapshot").mockImplementation(
      () => new Map([...markers].map(([id, m]) => [id, m.pid])),
    ),
    spyOn(paneDiscovery, "listTmuxPanes").mockResolvedValue([PANE]),
    spyOn(processes, "discoverAgentProcesses").mockResolvedValue([PROC]),
    spyOn(ProcessTree, "build").mockResolvedValue(TREE),
    spyOn(history, "readClaudeHistory").mockReturnValue([]),
    spyOn(adapter, "deriveFullState").mockImplementation(async (path) => {
      if (path === oldPath) {
        signalEntered();
        await gate;
      }
      return deriveFullState(path);
    }),
  );

  const internals = watcher as unknown as WatcherInternals;
  const batch = internals.processInitialHookBackedBatch([oldPath, newPath]);
  return { manager, watcher, internals, newPath, batch, entered, release };
}

describe("LogWatcher: marker lands while the initial batch is running", () => {
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds the session to its pane instead of unwatching the transcript", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { manager, watcher, internals, newPath, batch, entered, release } =
      setup(markers);

    // The SessionStart hook's marker lands while the batch is still busy
    // with the old session. The path is watched, so this is a no-op.
    await entered;
    expect(internals.watchedFiles.has(newPath)).toBe(true);
    markers.set(NEW_SESSION_ID, marker(NEW_SESSION_ID));
    watcher.handleMarkerAdded(marker(NEW_SESSION_ID));
    release();
    await batch;

    const session = manager.getSession(NEW_SESSION_ID);
    expect(session).toBeDefined();
    expect(session?.tmuxPane).toBe(PANE.paneId);
    expect(session?.pid).toBe(AGENT_PID);
    // Still watched, so its next write reaches the session.
    expect(internals.watchedFiles.has(newPath)).toBe(true);
  });

  it("still unwatches the transcript when no marker arrives", async () => {
    const markers = new Map<string, sessionMarkers.SessionPidMarker>();
    const { manager, internals, newPath, batch, entered, release } =
      setup(markers);

    await entered;
    release();
    await batch;

    expect(manager.hasSession(NEW_SESSION_ID)).toBe(false);
    expect(internals.watchedFiles.has(newPath)).toBe(false);
  });
});
