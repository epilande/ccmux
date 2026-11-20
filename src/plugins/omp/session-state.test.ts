import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpHookAdapter } from "../../daemon/adapters/omp/hook-adapter";
import type { HookManagerContext } from "../../daemon/hook-adapter";
import { AttentionTracker } from "../../daemon/attention-tracker";
import { AttentionTransitions } from "../../daemon/attention-transitions";
import { evaluateCascade, genericMarkerSource } from "../../daemon/cascade-evaluator";
import { parseMarkerFile } from "../../daemon/session-markers";
import { SessionManager } from "../../daemon/sessions";
import type { TmuxPane } from "../../types/session";
import { createNativeHarness } from "./marker-test-helpers";

const pane: TmuxPane = {
  paneId: "%1", panePid: process.pid, sessionName: "verify", windowIndex: 0,
  paneIndex: 0, target: "verify:0.0", tty: null, startTime: null,
  windowActivity: null, paneTitle: "omp", currentCommand: "omp", currentPath: "/repo",
};

describe("OMP public observations through markers and attention", () => {
  let markersDir: string;
  let manager: SessionManager;
  let transitions: AttentionTransitions;
  let hooks: HookManagerContext;
  let id: string;
  let knownMarkers: Set<string>;
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    markersDir = mkdtempSync(join(tmpdir(), "ccmux-omp-state-"));
    manager = new SessionManager();
    id = manager.createPaneTrackedSession({ agentType: "omp", paneId: pane.paneId, cwd: "/repo", pid: process.pid }).id;
    hooks = {
      sessionManager: manager,
      getLogWatcher: () => undefined,
      getLogWatchers: () => [],
      listProcesses: async () => [],
      listPanes: async () => [pane],
      getPaneHostingPid: async () => pane,
    };
    transitions = new AttentionTransitions({ sessionManager: manager, tracker: new AttentionTracker(), getActivePaneId: async () => null });
    transitions.start();
    knownMarkers = new Set();
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
    transitions.stop();
    rmSync(markersDir, { recursive: true, force: true });
  });

  function producer<T extends object>(ui: T) {
    const h = createNativeHarness(markersDir, ui);
    cleanups.push(h.shutdown);
    return h;
  }

  async function reconcileMarkers() {
    const adapter = new OmpHookAdapter();
    for (const file of readdirSync(markersDir).filter(name => name.endsWith(".json"))) {
      const marker = parseMarkerFile(readFileSync(join(markersDir, file), "utf8"));
      if (!marker) throw new Error("Invalid extension marker");
      if (!knownMarkers.has(file)) {
        knownMarkers.add(file);
        await adapter.onMarkerAdded(marker, hooks);
      }
      if (manager.getSession(id)?.nativeSessionId === marker.session_id) {
        const built = genericMarkerSource(marker);
        manager.updateSession(id, { ...built.metadata, ...evaluateCascade([built.source]) });
      }
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }

  it("hydrates startup transcript identity and completes only on actual native idle", async () => {
    const h = producer({});
    await h.start();
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ nativeSessionId: "parent", logPath: "/sessions/parent.jsonl", status: "idle", attentionState: null });
    h.run(true);
    await h.wait("working");
    await reconcileMarkers();
    h.fire("agent_end", { willContinue: false });
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "working", attentionState: null });
    h.run(false);
    await h.wait("idle");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "idle", attentionState: "unread" });
  });

  it.each(["hasAdmittedSubmission", "isBashRunning", "isEvalRunning", "isCompacting"] as const)("projects %s without lifecycle events", async field => {
    const h = producer({});
    await h.start();
    await reconcileMarkers();
    h.session[field] = true;
    await h.wait("working");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "working", attentionState: null });
    h.session[field] = false;
    await h.wait("idle");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "idle", attentionState: "unread" });
  });

  it("keeps a visible question after native completion and ignores subagent shutdown", async () => {
    const answer = Promise.withResolvers<void>();
    const ui = { askDialog: () => answer.promise };
    const h = producer(ui);
    await h.start();
    h.run(true);
    await h.wait("working");
    await reconcileMarkers();
    const question = ui.askDialog();
    await h.wait("waiting_question");
    await reconcileMarkers();
    const child = { ...h.ctx, agent: { id: "child", kind: "sub" as const } };
    h.fire("session_shutdown", {}, child);
    h.run(false);
    h.fire("agent_end", { willContinue: false });
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "waiting", attentionType: "question", pendingTool: null });
    answer.resolve();
    await question;
    await h.wait("idle");
    await reconcileMarkers();
    expect(manager.getSession(id)?.status).toBe("idle");
  });

  it("bumps attention generation for consecutive questions without an idle gap", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    let calls = 0;
    const ui = { select: () => ++calls === 1 ? first.promise : second.promise };
    const h = producer(ui);
    await h.start();
    const a = ui.select();
    const initial = await h.wait("waiting_question");
    await reconcileMarkers();
    const generation = manager.getSession(id)?.attentionGeneration;
    const b = ui.select();
    first.resolve();
    await a;
    await h.wait("waiting_question", marker => marker.wait_id !== initial.wait_id);
    await reconcileMarkers();
    expect(manager.getSession(id)?.attentionGeneration).toBeGreaterThan(generation ?? 0);
    second.resolve();
    await b;
    await h.wait("idle");
  });

  it("distinguishes local permission input from question input and remote unsafe approvals", async () => {
    const answer = Promise.withResolvers<void>();
    const ui = { approve: () => answer.promise };
    const h = producer(ui);
    await h.start();
    h.fire("tool_approval_requested", { toolCallId: "call-1", toolName: "bash" });
    const decision = ui.approve();
    h.status("blocked:kind=permission");
    await h.wait("waiting_permission");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "waiting", attentionType: "permission", pendingTool: "bash", ambiguousWait: false });
    answer.resolve();
    h.status("idle");
    await decision;
    await h.wait("idle");
    h.status("blocked:kind=permission");
    await h.wait("waiting_permission", marker => marker.ambiguous_wait);
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "waiting", attentionType: "permission", pendingTool: null, ambiguousWait: true });
    h.status("blocked:kind=question");
    await h.wait("waiting_question");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "waiting", attentionType: "question", ambiguousWait: false });
  });

  it("projects plan review, save-dialog precedence, and accepted compaction separately", async () => {
    const answer = Promise.withResolvers<void>();
    const ui = { input: () => answer.promise };
    const h = producer(ui);
    await h.start();
    h.session.setPlanModeState({ enabled: true });
    h.session.pendingReview = { reviewId: "plan" };
    h.fire("plan_review_requested", h.session.pendingReview);
    h.status("blocked:kind=permission");
    await h.wait("waiting_plan");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "waiting", attentionType: "plan_approval", inPlanMode: true });
    const save = ui.input();
    h.status("blocked:kind=question");
    await h.wait("waiting_question");
    await reconcileMarkers();
    expect(manager.getSession(id)?.attentionType).toBe("question");
    answer.resolve();
    await save;
    h.status("blocked:kind=permission");
    await h.wait("waiting_plan");
    h.session.pendingReview = undefined;
    h.status("idle");
    h.session.isCompacting = true;
    h.notify();
    await h.wait("working");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "working", attentionType: null, attentionState: null });
  });

  it("projects collab replica lifecycle while the local session getters remain idle", async () => {
    const h = producer({});
    await h.start();
    await h.session.switchSession("/arbitrary/replica.jsonl", { preserveLocalCwd: true, keepModel: true });
    h.fire("agent_start");
    await h.wait("working");
    await reconcileMarkers();
    expect(h.session.isRunActive).toBe(false);
    expect(manager.getSession(id)).toMatchObject({ nativeSessionId: "replica", status: "working", attentionState: null });
    h.fire("agent_end", { willContinue: false });
    await h.wait("idle");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "idle", attentionState: "unread" });
  });

  it.each(["askDialog", "approve"])("live SDK fork preserves active consumer input for %s", async method => {
    const answer = Promise.withResolvers<unknown>();
    const ui: Record<string, (...args: unknown[]) => Promise<unknown>> = { [method]: () => answer.promise };
    const h = producer(ui);
    await h.start();
    h.run(true);
    h.fire("before_agent_start", { prompt: "before live input fork" });
    await h.wait("working", marker => marker.last_prompt === "before live input fork");
    await reconcileMarkers();
    if (method === "approve") h.fire("tool_approval_requested", { toolCallId: "live", toolName: "bash" });
    const pending = ui[method]("visible input");
    const state = method === "approve" ? "waiting_permission" : "waiting_question";
    const attentionType = method === "approve" ? "permission" : "question";
    await h.wait(state);
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ nativeSessionId: "parent", status: "waiting", attentionType });
    expect(await h.session.fork()).toBe(true);
    await h.wait(state, marker => marker.last_prompt === null);
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({
      nativeSessionId: "fork", status: "waiting", attentionType, attentionState: null,
      lastPrompt: null, logPath: "/sessions/fork.jsonl",
    });
    answer.resolve("answered after native fork");
    await pending;
    await h.wait("working");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "working", attentionType: null, attentionState: null });
    h.run(false);
    await h.wait("idle");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "idle", attentionState: "unread" });
  });

  it("does not finish a streaming SDK fork or carry the old prompt to its new identity", async () => {
    const h = producer({});
    await h.start();
    h.run(true);
    h.fire("before_agent_start", { prompt: "old task" });
    await h.wait("working", marker => marker.last_prompt === "old task");
    await reconcileMarkers();
    await h.rebind("fork", "session_branch");
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ nativeSessionId: "fork", status: "working", attentionState: null, lastPrompt: null, logPath: "/sessions/fork.jsonl" });
  });

  it("clears completed prompt and attention state on a same-id conversation reset", async () => {
    const h = producer({});
    await h.start();
    h.run(true);
    h.fire("before_agent_start", { prompt: "old task" });
    await h.wait("working", marker => marker.last_prompt === "old task");
    await reconcileMarkers();
    h.run(false);
    await h.wait("idle");
    await reconcileMarkers();
    expect(manager.getSession(id)?.attentionState).toBe("unread");
    const previousEpoch = h.read().conversation_epoch;
    h.session.transcriptEpoch++;
    h.fire("session_clear");
    await h.wait("idle", marker => marker.last_prompt === null);
    expect(h.read().conversation_epoch).not.toBe(previousEpoch);
    await reconcileMarkers();
    expect(manager.getSession(id)).toMatchObject({ status: "idle", lastPrompt: null, attentionState: null });
  });
});
