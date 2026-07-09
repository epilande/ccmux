import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempRoot = join(
  tmpdir(),
  `ccmux-opencode-int-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const markersDir = join(tempRoot, "session-pids");

const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  MARKERS_DIR: markersDir,
}));

import { HookManager } from "../../hook-manager";
import { OpenCodePluginAdapter } from "./plugin-adapter";
import { SessionManager } from "../../sessions";
import { reconcileSessionMarkerLinks } from "../link";
import { refreshMarkerCache } from "../../session-markers";
import { makePlugin } from "../../../plugins/opencode/plugin.js";
import type {
  OpencodeBusEvent,
  OpencodePluginHooks,
  OpencodePluginInput,
} from "../../../plugins/opencode/plugin.js";
import type { HookManagerContext } from "../../hook-adapter";
import type { TmuxPane } from "../../../types/session";

// The authored plugin writes marker.pid = process.pid (the OpenCode server's
// own PID at runtime). Mirror that in the test so the adapter's
// pane-hosting-pid lookup resolves to our fixture pane.
const SERVER_PID = process.pid;
const PANE_ID = "%9";

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return {
    now: () => ++t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function emptyClient(): OpencodePluginInput["client"] {
  return {
    session: {
      list: async () => ({ data: [] }),
      status: async () => ({ data: {} }),
    },
  };
}

function makePane(): TmuxPane {
  return {
    paneId: PANE_ID,
    panePid: SERVER_PID,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 0,
    target: "ccmux:0.9",
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: "opencode",
    currentCommand: "opencode",
    currentPath: "/tmp",
  };
}

async function drainQueues(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

async function fire(
  hooks: OpencodePluginHooks,
  event: OpencodeBusEvent,
): Promise<void> {
  await hooks.event({ event });
  await drainQueues();
}

function sessionEvent(
  type: "session.created" | "session.updated" | "session.deleted",
  id: string,
  directory = "/proj",
  title = "t",
): OpencodeBusEvent {
  return { type, properties: { info: { id, directory, title } } };
}

function statusEvent(
  id: string,
  kind: "idle" | "busy" | "retry",
): OpencodeBusEvent {
  return {
    type: "session.status",
    properties: { sessionID: id, status: { type: kind } },
  };
}

function permissionAsked(
  id: string,
  tool = "bash",
  command = "ls -la",
): OpencodeBusEvent {
  return {
    type: "permission.asked",
    properties: {
      id: "p1",
      sessionID: id,
      permission: tool,
      patterns: [],
      metadata: { command },
      always: [],
    },
  };
}

describe("OpenCode plugin → HookManager → adapter pipeline", () => {
  let manager: HookManager;
  let sessionManager: SessionManager;
  let ctx: HookManagerContext;
  let pane: TmuxPane;

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(markersDir, { recursive: true });
    refreshMarkerCache();

    sessionManager = new SessionManager();
    manager = new HookManager();
    manager.register(new OpenCodePluginAdapter());
    pane = makePane();
    ctx = {
      sessionManager,
      getLogWatcher: () => undefined,
      getLogWatchers: () => [],
      listProcesses: async () => [],
      listPanes: async () => [pane],
      getPaneHostingPid: async (pid: number) =>
        pid === SERVER_PID ? pane : null,
    };
    manager.setContext(ctx);
  });

  afterEach(async () => {
    await manager.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function makeBoundPlugin(): Promise<{
    hooks: OpencodePluginHooks;
  }> {
    const plugin = makePlugin({
      markersDir,
      version: "1.0.0-test",
      now: makeClock().now,
    });
    const hooks = await plugin({ client: emptyClient() });
    return { hooks };
  }

  function markerPathFor(sessionId: string): string {
    return join(markersDir, `opencode-${sessionId}.json`);
  }

  function createPaneSession(): string {
    const session = sessionManager.createPaneTrackedSession({
      agentType: "opencode",
      paneId: PANE_ID,
      cwd: "/proj",
      pid: SERVER_PID,
    });
    return session.id;
  }

  it("plugin write → dispatch → adapter enriches pre-existing session (happy path)", async () => {
    const sid = createPaneSession();
    const { hooks } = await makeBoundPlugin();

    await fire(hooks, sessionEvent("session.created", "s1"));
    await fire(hooks, statusEvent("s1", "busy"));
    await manager.handleMarkerAdded(markerPathFor("s1"));

    const session = sessionManager.getSession(sid)!;
    expect(session.status).toBe("working");
    expect(session.nativeSessionId).toBe("s1");

    await fire(hooks, permissionAsked("s1"));
    await manager.handleMarkerAdded(markerPathFor("s1"));

    const updated = sessionManager.getSession(sid)!;
    expect(updated.status).toBe("waiting");
    expect(updated.attentionType).toBe("permission");
    expect(updated.pendingTool).toBe("bash");
  });

  it("user prompt flows plugin → marker → adapter → SessionManager.lastPrompt", async () => {
    const sid = createPaneSession();
    const { hooks } = await makeBoundPlugin();

    await fire(hooks, sessionEvent("session.created", "s1"));
    await fire(hooks, {
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "m1",
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "p", modelID: "m" },
        },
      },
    });
    await fire(hooks, {
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 2,
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "m1",
          type: "text",
          text: "summarize this repo",
        },
      },
    });
    refreshMarkerCache();
    await manager.handleMarkerAdded(markerPathFor("s1"));

    expect(sessionManager.getSession(sid)!.lastPrompt).toBe(
      "summarize this repo",
    );
  });

  it("new session in same server clears the previous session's sticky lastPrompt", async () => {
    // Regression guard: when a multi-session OpenCode server creates a
    // fresh session, the picker's prompt column must not keep showing the
    // previously-newest sibling's prompt. Pre-fix, applyAggregate omitted
    // lastPrompt when newest had none, and SessionManager.updateSession's
    // `state.lastPrompt !== undefined` guard fell through to leave the old
    // value in place.
    const sid = createPaneSession();
    const { hooks } = await makeBoundPlugin();

    await fire(hooks, sessionEvent("session.created", "s1"));
    await fire(hooks, {
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: {
          id: "m1",
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "p", modelID: "m" },
        },
      },
    });
    await fire(hooks, {
      type: "message.part.updated",
      properties: {
        sessionID: "s1",
        time: 2,
        part: {
          id: "p1",
          sessionID: "s1",
          messageID: "m1",
          type: "text",
          text: "first session prompt",
        },
      },
    });
    refreshMarkerCache();
    await manager.handleMarkerAdded(markerPathFor("s1"));
    expect(sessionManager.getSession(sid)!.lastPrompt).toBe(
      "first session prompt",
    );

    // Second session in the same server, with later activity (clock ticks
    // forward on every event), and no user prompt yet.
    await fire(hooks, sessionEvent("session.created", "s2"));
    await fire(hooks, statusEvent("s2", "idle"));
    refreshMarkerCache();
    await manager.handleMarkerAdded(markerPathFor("s2"));

    expect(sessionManager.getSession(sid)!.lastPrompt).toBeNull();
    expect(sessionManager.getSession(sid)!.nativeSessionId).toBe("s2");
  });

  it("marker-before-session race: no-op on add, then enrich helper converges", async () => {
    const { hooks } = await makeBoundPlugin();
    await fire(hooks, sessionEvent("session.created", "s-race"));
    await fire(hooks, statusEvent("s-race", "busy"));
    await manager.handleMarkerAdded(markerPathFor("s-race"));

    expect(sessionManager.getSessions()).toHaveLength(0);

    const sid = createPaneSession();

    const adapter = manager.getAdapter("opencode")!;
    await reconcileSessionMarkerLinks(adapter, ctx);

    const session = sessionManager.getSession(sid)!;
    expect(session.status).toBe("working");
    expect(session.nativeSessionId).toBe("s-race");
  });

  it("permission.asked + session.status in the same tick: last event wins", async () => {
    const sid = createPaneSession();
    const { hooks } = await makeBoundPlugin();
    await fire(hooks, sessionEvent("session.created", "s1"));
    await manager.handleMarkerAdded(markerPathFor("s1"));

    const p1 = hooks.event({ event: permissionAsked("s1") });
    const p2 = hooks.event({ event: statusEvent("s1", "busy") });
    await Promise.all([p1, p2]);
    await drainQueues();
    await manager.handleMarkerAdded(markerPathFor("s1"));

    const session = sessionManager.getSession(sid)!;
    expect(session.status).toBe("working");
    expect(session.attentionType).toBeNull();
    expect(session.pendingTool).toBeNull();
  });

  it("session.deleted → onMarkerRemoved re-aggregates across remaining siblings", async () => {
    const sid = createPaneSession();
    const { hooks } = await makeBoundPlugin();

    await fire(hooks, sessionEvent("session.created", "alive"));
    await fire(hooks, statusEvent("alive", "busy"));
    await manager.handleMarkerAdded(markerPathFor("alive"));

    await fire(hooks, sessionEvent("session.created", "dying"));
    await fire(hooks, permissionAsked("dying"));
    await manager.handleMarkerAdded(markerPathFor("dying"));

    expect(sessionManager.getSession(sid)!.status).toBe("waiting");

    await manager.handleMarkerAdded(markerPathFor("alive"));

    const pathBeforeUnlink = markerPathFor("dying");
    await fire(hooks, sessionEvent("session.deleted", "dying"));
    await manager.handleMarkerRemoved(pathBeforeUnlink);

    refreshMarkerCache();
    const final = sessionManager.getSession(sid)!;
    expect(final.status).toBe("working");
    expect(final.attentionType).toBeNull();
    expect(final.pendingTool).toBeNull();
    expect(final.nativeSessionId).toBe("alive");
  });

  it("siblings drop to zero → onMarkerRemoved resets session to idle", async () => {
    const sid = createPaneSession();
    const { hooks } = await makeBoundPlugin();

    await fire(hooks, sessionEvent("session.created", "only"));
    await fire(hooks, statusEvent("only", "busy"));
    await manager.handleMarkerAdded(markerPathFor("only"));
    expect(sessionManager.getSession(sid)!.status).toBe("working");

    const path = markerPathFor("only");
    await fire(hooks, sessionEvent("session.deleted", "only"));
    await manager.handleMarkerRemoved(path);

    refreshMarkerCache();
    const final = sessionManager.getSession(sid)!;
    expect(final.status).toBe("idle");
    expect(final.attentionType).toBeNull();
    expect(final.pendingTool).toBeNull();
  });

  it("HookManager.start replays pre-existing markers through the adapter", async () => {
    const sid = createPaneSession();
    const { hooks } = await makeBoundPlugin();

    await fire(hooks, sessionEvent("session.created", "pre-existing"));
    await fire(hooks, statusEvent("pre-existing", "busy"));

    refreshMarkerCache();
    await manager.start();

    const session = sessionManager.getSession(sid)!;
    expect(session.status).toBe("working");
    expect(session.nativeSessionId).toBe("pre-existing");
  });
});
