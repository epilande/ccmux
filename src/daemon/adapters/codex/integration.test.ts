import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "fs";
import * as fsPromises from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SessionManager } from "../../sessions";
import {
  loadMarkerIntoCache,
  refreshMarkerCache,
  type SessionPidMarker,
} from "../../session-markers";
import { LogWatcher } from "../../watcher";
import { CodexLogAdapter } from "./log-adapter";
import {
  jsonl,
  codexSessionMeta,
  codexEventMsg as eventMsg,
  codexResponseItem as responseItem,
} from "./test-helpers";

type WatcherInternals = {
  handleAdd(path: string): Promise<void>;
  handleChange(path: string): void;
  processFile(path: string, sessionId: string): Promise<void>;
  pollOnce(): Promise<void>;
  startPolling(): void;
  pollTimer: Timer | null;
  pollInFlight: Promise<void> | null;
  debounceTimers: Map<string, Timer>;
};

const NATIVE_ID = "019c7dd4-ff41-79c0-8270-d030bb51cd90";
/**
 * Own id for the marker-threading test. The marker cache is module-global
 * and has no per-entry delete, so a distinct id keeps that test's marker from
 * colliding with anything else keyed on `NATIVE_ID` (the cache is refreshed
 * back to disk in `afterEach` regardless).
 */
const MARKER_NATIVE_ID = "019c7dd4-ff41-79c0-8270-d030bb51ce01";

function rolloutPath(dir: string, nativeId: string = NATIVE_ID): string {
  return join(dir, `rollout-2026-04-17T12-00-00-${nativeId}.jsonl`);
}

function sessionMeta() {
  return codexSessionMeta({
    id: NATIVE_ID,
    timestamp: "2026-04-17T12:00:00.000Z",
    cwd: "/Users/test/proj",
  });
}

describe("Codex LogWatcher integration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    // Drop anything a test seeded into the module-global marker cache.
    refreshMarkerCache();
  });

  function newTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ccmux-codex-int-"));
    tempDirs.push(dir);
    return dir;
  }

  it("ignores file events when no Codex session has the matching nativeSessionId", async () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals;

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(path, jsonl(sessionMeta()));

    await internals.handleAdd(path);

    expect(manager.getSessions()).toHaveLength(0);
  });

  it("processes the rollout once a pane-tracked session is linked via processPath", async () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%2",
      cwd: "/Users/test/proj",
      pid: 4321,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(
      path,
      jsonl(
        sessionMeta(),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
        eventMsg("2026-04-17T12:00:02Z", {
          type: "user_message",
          message: "describe this repo",
        }),
      ),
    );
    manager.setLogPath(session.id, path);

    await watcher.processPath(path);

    const refreshed = manager.getSession(session.id)!;
    expect(refreshed.status).toBe("working");
    expect(refreshed.lastPrompt).toBe("describe this repo");
    expect(refreshed.lastActivityAt).toBe("2026-04-17T12:00:02Z");
  });

  it("settles status to idle on subsequent file change after task_complete", async () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals;

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%3",
      cwd: "/Users/test/proj",
      pid: 5555,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(
      path,
      jsonl(
        sessionMeta(),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
      ),
    );
    manager.setLogPath(session.id, path);

    await watcher.processPath(path);
    expect(manager.getSession(session.id)?.status).toBe("working");

    appendFileSync(
      path,
      jsonl(eventMsg("2026-04-17T12:00:05Z", { type: "task_complete" })),
    );

    // Drive the change handler; processFile fires after WATCHER_DEBOUNCE_MS.
    // Poll for the expected state instead of sleeping a fixed interval so the
    // test stays responsive on slow CI without inflating local runtime.
    internals.handleChange(path);

    const deadline = Date.now() + 2000;
    let final = manager.getSession(session.id)!;
    while (final.status !== "idle" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      final = manager.getSession(session.id)!;
    }

    expect(final.status).toBe("idle");
    expect(final.lastActivityAt).toBe("2026-04-17T12:00:05Z");
  });

  it("settles to idle on the one-shot link read when the turn already completed", async () => {
    // A fast turn can finish before `linkCodexSessions` discovers the
    // rollout. The link's one-shot `processPath` read is then the ONLY
    // parse this file ever gets (no appends follow), so it must derive
    // the completed-turn idle state, not a mid-turn working state.
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%5",
      cwd: "/Users/test/proj",
      pid: 7777,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(
      path,
      jsonl(
        sessionMeta(),
        eventMsg("2026-04-17T12:00:01Z", {
          type: "user_message",
          message: "reply with the single word ok",
        }),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
        eventMsg("2026-04-17T12:00:02Z", { type: "agent_message" }),
        eventMsg("2026-04-17T12:00:02Z", { type: "task_complete" }),
        eventMsg("2026-04-17T12:00:02Z", { type: "token_count" }),
      ),
    );
    manager.setLogPath(session.id, path);

    await watcher.processPath(path);

    const refreshed = manager.getSession(session.id)!;
    expect(refreshed.status).toBe("idle");
    expect(refreshed.lastPrompt).toBe("reply with the single word ok");
    expect(refreshed.lastActivityAt).toBe("2026-04-17T12:00:02Z");
  });

  it("feeds appends no watcher event announces through the stat-poll pass", async () => {
    // Codex holds the rollout fd open, so macOS fires no fs.watch change
    // event for its appends: nothing here starts the tree watcher, and the
    // append below is exactly as invisible as a real one. The poll pass is
    // the only thing that can advance the store.
    const manager = new SessionManager();
    const adapter = new CodexLogAdapter();
    let incrementalParses = 0;
    const deriveIncremental = adapter.deriveIncrementalState.bind(adapter);
    adapter.deriveIncrementalState = async (path, offset, prev) => {
      incrementalParses++;
      return deriveIncremental(path, offset, prev);
    };

    const watcher = new LogWatcher(adapter, manager);
    const internals = watcher as unknown as WatcherInternals;

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%7",
      cwd: "/Users/test/proj",
      pid: 6161,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(path, jsonl(sessionMeta()));
    manager.setLogPath(session.id, path);

    // Link-time read: seeds the offset the poll pass compares sizes against.
    await watcher.processPath(path);
    expect(manager.getSession(session.id)?.status).toBe("idle");

    appendFileSync(
      path,
      jsonl(eventMsg("2026-04-17T12:00:01Z", { type: "task_started" })),
    );

    await internals.pollOnce();

    // processFile runs after WATCHER_DEBOUNCE_MS; poll for the result.
    const deadline = Date.now() + 2000;
    let refreshed = manager.getSession(session.id)!;
    while (refreshed.status !== "working" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      refreshed = manager.getSession(session.id)!;
    }

    expect(refreshed.status).toBe("working");
    expect(refreshed.lastActivityAt).toBe("2026-04-17T12:00:01Z");
    expect(incrementalParses).toBe(1);

    // A second pass over an unchanged file must not reparse: the recorded
    // offset already covers every byte on disk.
    await internals.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(incrementalParses).toBe(1);
  });

  it("arms one poll timer no matter how often polling is started, and clears it on stop", async () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals;

    internals.startPolling();
    const timer = internals.pollTimer;
    expect(timer).not.toBeNull();

    internals.startPolling();
    expect(internals.pollTimer).toBe(timer);

    await watcher.stop();
    expect(internals.pollTimer).toBeNull();

    // A stopped watcher can be armed again: `startPolling` clears the flag
    // its own `stop()` set, or a daemon restart would poll nothing.
    internals.startPolling();
    expect(internals.pollTimer).not.toBeNull();
    await watcher.stop();
    expect(internals.pollTimer).toBeNull();
  });

  it("a poll pass in flight across stop() dispatches nothing", async () => {
    // `stop()` clears the debounce timers LAST, so a pass suspended on its
    // `stat` must be drained first — otherwise it dispatches into the map
    // after the sweep and leaves a timer nobody clears.
    const manager = new SessionManager();
    const adapter = new CodexLogAdapter();
    let parses = 0;
    const deriveIncremental = adapter.deriveIncrementalState.bind(adapter);
    adapter.deriveIncrementalState = async (path, offset, prev) => {
      parses++;
      return deriveIncremental(path, offset, prev);
    };

    const watcher = new LogWatcher(adapter, manager);
    const internals = watcher as unknown as WatcherInternals;

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%9",
      cwd: "/Users/test/proj",
      pid: 9191,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(
      path,
      jsonl(
        sessionMeta(),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
      ),
    );
    // No recorded offset, so this pass would dispatch if it ran to completion.
    manager.setLogPath(session.id, path);

    // Hold the pass open inside its `stat` until the test releases it.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const statSpy = spyOn(fsPromises, "stat").mockImplementation(async (p) => {
      await gate;
      return statSync(p as string) as never;
    });

    try {
      internals.startPolling();

      const deadline = Date.now() + 3000;
      while (statSpy.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(statSpy.mock.calls.length).toBe(1);
      expect(internals.pollInFlight).not.toBeNull();

      const stopped = watcher.stop();
      release?.();
      await stopped;

      // Sampled well inside WATCHER_DEBOUNCE_MS: a straggler dispatch would
      // still be sitting in the map here, where the sweep can no longer see
      // it. (Later it would fire, delete itself, and leave no trace.)
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(internals.debounceTimers.size).toBe(0);

      // Past one full interval plus the debounce: nothing was parsed and the
      // loop never re-armed itself.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(parses).toBe(0);
      expect(internals.debounceTimers.size).toBe(0);
      expect(statSpy.mock.calls.length).toBe(1);

      expect(internals.pollTimer).toBeNull();
      expect(internals.pollInFlight).toBeNull();
    } finally {
      release?.();
      statSpy.mockRestore();
    }
  });

  it("threads the PermissionRequest marker's state_timestamp into the adapter as waitEstablishedAt", async () => {
    // The marker anchor is what holds the gate under 1s polling: the failed
    // ungated attempt of Codex's sandbox-fail-then-escalate flow is now
    // parsed AFTER the wait exists, and it sits inside the 2s
    // statusChangedAt slack. Only the marker's own request-time stamp (250ms
    // slack) rejects it. This test is discriminating: the output below is
    // 600ms old, which the statusChangedAt fallback would happily flip.
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals;

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%8",
      cwd: "/Users/test/proj",
      pid: 7373,
    });
    manager.setNativeSessionId(session.id, MARKER_NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir, MARKER_NATIVE_ID);
    writeFileSync(
      path,
      jsonl(
        codexSessionMeta({
          id: MARKER_NATIVE_ID,
          timestamp: "2026-04-17T12:00:00.000Z",
          cwd: "/Users/test/proj",
        }),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
      ),
    );
    manager.setLogPath(session.id, path);

    await watcher.processPath(path);
    manager.updateSession(session.id, {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
    });

    // The hook restamps the marker at request time, in float seconds.
    const requestedAt = Date.now();
    const marker: SessionPidMarker = {
      agent_type: "codex",
      pid: 7373,
      tty: "ttys042",
      session_id: MARKER_NATIVE_ID,
      timestamp: requestedAt / 1000,
      state: "waiting_permission",
      state_timestamp: requestedAt / 1000,
      pending_tool: "Bash",
    };
    const markerPath = join(dir, `codex-${MARKER_NATIVE_ID}.json`);
    writeFileSync(markerPath, JSON.stringify(marker));
    loadMarkerIntoCache(markerPath);

    appendFileSync(
      path,
      jsonl(
        responseItem(new Date(requestedAt - 600).toISOString(), {
          type: "function_call_output",
          call_id: "call-ungated-attempt",
        }),
      ),
    );

    await internals.processFile(path, session.id);

    expect(manager.getSession(session.id)?.status).toBe("waiting");
    expect(manager.getSession(session.id)?.attentionType).toBe("permission");

    // Positive control: an output stamped after the request resolves it.
    appendFileSync(
      path,
      jsonl(
        responseItem(new Date(requestedAt + 500).toISOString(), {
          type: "function_call_output",
          call_id: "call-gated-retry",
        }),
      ),
    );

    await internals.processFile(path, session.id);

    expect(manager.getSession(session.id)?.status).toBe("working");
  });

  it("does not remove the session when the rollout file is unlinked", () => {
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals & {
      handleUnlink(path: string): void;
    };

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%4",
      cwd: "/Users/test/proj",
      pid: 9999,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(path, jsonl(sessionMeta()));

    internals.handleUnlink(path);

    expect(manager.hasSession(session.id)).toBe(true);
  });

  it("threads the store's statusChangedAt into the adapter so a stale buffered output cannot clear a live wait", async () => {
    // Pins the production wiring the stale-output recency gate depends on:
    // sessionToState (watcher.ts:39) must forward session.statusChangedAt
    // into the SessionState the adapter receives as `prev`, or the gate in
    // applyResponseItem has no wait-establishment timestamp to compare
    // against and fails open. Deleting that one line leaves the rest of the
    // suite green (log-adapter.test.ts exercises the gate directly against
    // a hand-built `prev`), so this test is the only thing that would catch
    // the wiring regressing back to fail-open behavior.
    const manager = new SessionManager();
    const watcher = new LogWatcher(new CodexLogAdapter(), manager);
    const internals = watcher as unknown as WatcherInternals;

    const session = manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%6",
      cwd: "/Users/test/proj",
      pid: 8888,
    });
    manager.setNativeSessionId(session.id, NATIVE_ID);

    const dir = newTempDir();
    const path = rolloutPath(dir);
    writeFileSync(
      path,
      jsonl(
        sessionMeta(),
        eventMsg("2026-04-17T12:00:01Z", { type: "task_started" }),
      ),
    );
    manager.setLogPath(session.id, path);

    // Full derivation seeds the offset.
    await watcher.processPath(path);
    expect(manager.getSession(session.id)?.status).toBe("working");

    // The PermissionRequest marker establishes the wait NOW; the store
    // stamps statusChangedAt with the real wall clock, months after the
    // rollout's April 2026 timestamps.
    manager.updateSession(session.id, {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
    });
    expect(manager.getSession(session.id)?.statusChangedAt).not.toBeNull();

    // A buffered leftover output from a PRIOR call, timestamped long before
    // the wait was established.
    appendFileSync(
      path,
      jsonl(
        responseItem("2026-04-17T12:00:05Z", {
          type: "function_call_output",
          call_id: "call-stale",
        }),
      ),
    );

    await internals.processFile(path, session.id);

    expect(manager.getSession(session.id)?.status).toBe("waiting");
    expect(manager.getSession(session.id)?.attentionType).toBe("permission");
  });
});
