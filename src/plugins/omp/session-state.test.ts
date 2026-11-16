import { waitForIdleMarker } from "./marker-test-helpers";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeExtension, type OmpExtensionContext } from "./ccmux.js";
import { OmpHookAdapter } from "../../daemon/adapters/omp/hook-adapter";
import type { HookManagerContext } from "../../daemon/hook-adapter";
import { AttentionTracker } from "../../daemon/attention-tracker";
import { AttentionTransitions } from "../../daemon/attention-transitions";
import {
  evaluateCascade,
  genericMarkerSource,
} from "../../daemon/cascade-evaluator";
import { parseMarkerFile } from "../../daemon/session-markers";
import { SessionManager } from "../../daemon/sessions";
import type { TmuxPane } from "../../types/session";

const pane: TmuxPane = {
  paneId: "%1",
  panePid: process.pid,
  sessionName: "verify",
  windowIndex: 0,
  paneIndex: 0,
  target: "verify:0.0",
  tty: null,
  startTime: null,
  windowActivity: null,
  paneTitle: "omp",
  currentCommand: "omp",
  currentPath: "/repo",
};

function context(id: string, kind: "main" | "sub" = "main") {
  return {
    cwd: "/repo",
    agent: { kind },
    sessionManager: {
      getSessionId: () => id,
      getSessionFile: () => `/sessions/${id}.jsonl`,
    },
  };
}

describe("OMP session state through markers and attention", () => {
  let markersDir: string;
  let manager: SessionManager;
  let transitions: AttentionTransitions;
  let hooks: HookManagerContext;
  let id: string;
  let knownMarkers: Set<string>;

  beforeEach(() => {
    markersDir = mkdtempSync(join(tmpdir(), "ccmux-omp-state-"));
    manager = new SessionManager();
    id = manager.createPaneTrackedSession({
      agentType: "omp",
      paneId: pane.paneId,
      cwd: "/repo",
      pid: process.pid,
    }).id;
    hooks = {
      sessionManager: manager,
      getLogWatcher: () => undefined,
      getLogWatchers: () => [],
      listProcesses: async () => [],
      listPanes: async () => [pane],
      getPaneHostingPid: async () => pane,
    };
    transitions = new AttentionTransitions({
      sessionManager: manager,
      tracker: new AttentionTracker(),
      getActivePaneId: async () => null,
    });
    transitions.start();
    knownMarkers = new Set();
  });

  afterEach(() => {
    transitions.stop();
    rmSync(markersDir, { recursive: true, force: true });
  });

  async function reconcileMarkers() {
    const adapter = new OmpHookAdapter();
    for (const file of readdirSync(markersDir).filter((name) =>
      name.endsWith(".json"),
    )) {
      const marker = parseMarkerFile(
        readFileSync(join(markersDir, file), "utf8"),
      );
      if (!marker) throw new Error("Invalid extension marker");
      if (!knownMarkers.has(file)) {
        knownMarkers.add(file);
        await adapter.onMarkerAdded(marker, hooks);
      }
      if (manager.getSession(id)?.nativeSessionId === marker.session_id) {
        manager.updateSession(
          id,
          evaluateCascade([genericMarkerSource(marker).source]),
        );
      }
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }

  function extension(
    ctx: OmpExtensionContext,
    sleep?: (ms: number) => Promise<void>,
    waitForCompletion = true,
  ) {
    const handlers = new Map<
      string,
      (event: unknown, ctx: OmpExtensionContext) => void | Promise<void>
    >();
    makeExtension({
      markersDir,
      version: "test",
      now: () => 1_700_000_000_000,
      sleep: sleep ?? (async () => {}),
    })({
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    });
    return async (event: string, payload: unknown = {}) => {
      await handlers.get(event)?.(payload, ctx);
      const settled = Promise.withResolvers<void>();
      queueMicrotask(settled.resolve);
      await settled.promise;
      if (
        event === "agent_end" &&
        ctx.agent?.kind !== "sub" &&
        waitForCompletion &&
        (sleep || ctx.isIdle?.() !== false)
      ) {
        const continuing =
          payload !== null &&
          typeof payload === "object" &&
          "willContinue" in payload &&
          payload.willContinue === true;
        if (!continuing)
          await waitForIdleMarker(
            markersDir,
            ctx.sessionManager.getSessionId()!,
          );
      }
      await reconcileMarkers();
    };
  }

  function expectWorking() {
    expect(manager.getSession(id)).toMatchObject({
      nativeSessionId: "parent",
      logPath: "/sessions/parent.jsonl",
      status: "working",
      attentionState: null,
    });
  }

  it.each([
    { willContinue: true },
    { willContinue: true, awaitingAsyncWork: true },
  ])("does not finish a continuing parent: %j", async (end) => {
    const parent = extension(context("parent"));
    await parent("session_start");
    await parent("agent_start");
    await parent("agent_end", end);
    expectWorking();
    await parent("agent_start");
    await parent("agent_end", { willContinue: false });
    expect(manager.getSession(id)).toMatchObject({
      status: "idle",
      attentionState: "unread",
    });
    await parent("agent_start");
    expectWorking();
  });

  it.each([
    ["quick", "slow"],
    ["slow", "quick"],
  ])(
    "keeps the parent working when children finish %s then %s",
    async (first, second) => {
      const parent = extension(context("parent"));
      await parent("session_start");
      await parent("agent_start");
      const children = [
        extension(context(first, "sub")),
        extension(context(second, "sub")),
      ];
      for (const child of children) {
        await child("session_start");
        await child("before_agent_start", { prompt: "child task" });
        await child("agent_start");
      }
      for (const child of children) {
        await child("agent_end");
        expectWorking();
        await child("session_shutdown");
        expectWorking();
      }
      await parent("agent_end");
      expect(manager.getSession(id)).toMatchObject({
        nativeSessionId: "parent",
        status: "idle",
        attentionState: "unread",
      });
    },
  );

  it("ignores a delayed terminal event while the next parent turn is active", async () => {
    let idle = false;
    const parent = extension({ ...context("parent"), isIdle: () => idle });
    await parent("session_start");
    await parent("agent_start");
    await parent("agent_start");
    await parent("agent_end");
    expectWorking();
    await parent("tool_approval_requested", {
      toolCallId: "next",
      toolName: "bash",
    });
    await parent("agent_end", { willContinue: true });
    expect(manager.getSession(id)).toMatchObject({
      status: "waiting",
      attentionType: "permission",
    });
    await parent("tool_approval_resolved", {
      toolCallId: "next",
      approved: false,
    });
    expectWorking();
    idle = true;
    await parent("agent_end");
    expect(manager.getSession(id)).toMatchObject({
      status: "idle",
      attentionState: "unread",
    });
  });

  it("finishes when OMP settles its live state after dispatching agent_end", async () => {
    let idle = false;
    const parent = extension({ ...context("parent"), isIdle: () => idle });
    await parent("session_start");
    await parent("agent_start");
    const ending = parent("agent_end");
    queueMicrotask(() => {
      idle = true;
    });
    await ending;
    expect(manager.getSession(id)).toMatchObject({
      status: "idle",
      attentionState: "unread",
    });
  });

  it("finishes when prompt cleanup outlasts the first event-loop turn", async () => {
    let idle = false;
    const parent = extension(
      { ...context("parent"), isIdle: () => idle },
      async () => {
        idle = true;
      },
    );
    await parent("session_start");
    await parent("agent_start");
    await parent("agent_end");
    expect(manager.getSession(id)).toMatchObject({
      status: "idle",
      attentionState: "unread",
    });
  });

  it("finishes after an earlier agent_start marker write still in the queue", async () => {
    const parent = extension(
      { ...context("parent"), isIdle: () => true },
      undefined,
      false,
    );
    await parent("session_start");
    await Promise.all([parent("agent_start"), parent("agent_end")]);
    await waitForIdleMarker(markersDir, "parent");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({
      status: "idle",
      attentionState: "unread",
    });
  });

  it.each(["agent_start", "tool_approval_requested", "session_shutdown"])(
    "does not let deferred completion overwrite %s",
    async (event) => {
      let idle = false;
      const waiting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const parent = extension(
        { ...context("parent"), isIdle: () => idle },
        async () => {
          waiting.resolve();
          await release.promise;
        },
        false,
      );
      await parent("session_start");
      await parent("agent_start");
      let returned = false;
      const ending = parent("agent_end").then(() => {
        returned = true;
      });
      await waiting.promise;
      try {
        expect(returned).toBe(true);
      } catch (error) {
        release.resolve();
        await ending;
        throw error;
      }
      await parent(event, { toolCallId: "new", toolName: "bash" });
      idle = true;
      release.resolve();
      await ending;
      if (event === "session_shutdown") {
        expect(readdirSync(markersDir)).toEqual([]);
      } else {
        expect(manager.getSession(id)).toMatchObject({
          status: event === "agent_start" ? "working" : "waiting",
          attentionState: null,
        });
      }
    },
  );

  it("does not finish the parent on a todo, tool, or internal turn completion", async () => {
    const parent = extension(context("parent"));
    await parent("session_start");
    await parent("agent_start");
    for (const toolName of ["todo", "bash", "task"]) {
      await parent("tool_execution_end", {
        toolCallId: toolName,
        toolName,
        isError: false,
      });
      expectWorking();
    }
    await parent("turn_end", { turnIndex: 0 });
    expectWorking();
  });

  it("keeps a main approval pending across same-id child events", async () => {
    const parent = extension(context("parent"));
    const child = extension(context("parent", "sub"));
    await parent("session_start");
    await parent("agent_start");
    await parent("tool_approval_requested", {
      toolCallId: "approve",
      toolName: "bash",
    });
    await child("agent_end");
    await child("session_switch");
    await child("session_shutdown");
    expect(manager.getSession(id)).toMatchObject({
      status: "waiting",
      attentionType: "permission",
      pendingTool: "bash",
      attentionState: null,
    });
    await parent("tool_approval_resolved", {
      toolCallId: "approve",
      approved: true,
    });
    expectWorking();
    await parent("agent_end");
    await parent("tool_approval_resolved", {
      toolCallId: "approve",
      approved: true,
    });
    expect(manager.getSession(id)).toMatchObject({
      status: "idle",
      attentionState: "unread",
    });
  });
});
