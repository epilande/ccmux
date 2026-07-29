import { describe, it, expect } from "bun:test";
import { createTUIStore as _createTUIStore } from "./store";
import { mockEnrichedSession } from "./components/test-helpers";
import { getGroupKey, INVOKE_GROUP_KEY } from "./utils/grouping";
import type { InvocationStartedEvent, InvocationFinishedEvent } from "../types";

const noop = () => {};
function createTUIStore(options: Parameters<typeof _createTUIStore>[0] = {}) {
  return _createTUIStore({ onPersistState: noop, ...options });
}

function startEvent(
  overrides: Partial<InvocationStartedEvent> = {},
): InvocationStartedEvent {
  return {
    type: "invocation_started",
    timestamp: "2024-01-15T12:00:00Z",
    invocationId: "inv_abcd",
    agent: "codex",
    cwd: "/Users/test/Code/myapp",
    startedAt: "2024-01-15T12:00:00Z",
    ...overrides,
  };
}

function finishEvent(
  overrides: Partial<InvocationFinishedEvent> = {},
): InvocationFinishedEvent {
  return {
    type: "invocation_finished",
    timestamp: "2024-01-15T12:00:05Z",
    invocationId: "inv_abcd",
    agent: "codex",
    status: "succeeded",
    ...overrides,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("store invoke synthesis", () => {
  it("synthesizes a paneless row for a subprocess invoke", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(startEvent());
    expect(store.state.sessions.length).toBe(1);
    const row = store.state.sessions[0];
    expect(row.id).toBe("inv_abcd");
    expect(row.agentType).toBe("codex");
    expect(row.tmuxPane).toBeNull();
    expect(row.originInvocationId).toBe("inv_abcd");
    expect(row.originInvocationStatus).toBe("running");
    expect(row.status).toBe("working");
    // Falls back to the cwd basename when the event carries no project
    // (a daemon older than those fields).
    expect(row.project).toBe("myapp");
    // lastActivityAt is the start time so the age column counts up live
    expect(row.lastActivityAt).toBe("2024-01-15T12:00:00Z");
  });

  it("groups a worktree invoke with the repo's real sessions", () => {
    // The daemon resolves the project through the same `deriveProject` real
    // sessions go through; without it the row would strand itself under the
    // worktree's directory name for its whole lifetime.
    const store = createTUIStore({ groupBy: "project" });
    store.actions.setSessions([
      mockEnrichedSession({
        id: "real",
        project: "myapp",
        cwd: "/Users/test/Code/myapp",
      }),
    ]);
    store.actions.startInvocation(
      startEvent({
        cwd: "/Users/test/Code/trees/parking",
        project: "myapp",
        isWorktree: true,
        mainRepoRoot: "/Users/test/Code/myapp",
      }),
    );

    const row = store.state.sessions.find((s) => s.id === "inv_abcd")!;
    expect(row.project).toBe("myapp");
    expect(row.isWorktree).toBe(true);
    expect(row.mainRepoRoot).toBe("/Users/test/Code/myapp");
    expect(getGroupKey(row, "project")).toBe(
      getGroupKey(store.state.sessions[0], "project"),
    );
  });

  it("skips synthesizing a row for a claude invoke (skip-and-wait de-dup)", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(
      startEvent({ agent: "claude", invocationId: "inv_claude" }),
    );
    expect(store.state.sessions.length).toBe(0);
    // ...but it still counts toward the in-flight total
    expect(store.invocationInFlightCount()).toBe(1);
  });

  it("counts both claude and subprocess invokes in flight", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(
      startEvent({ invocationId: "inv_codex", agent: "codex" }),
    );
    store.actions.startInvocation(
      startEvent({ invocationId: "inv_claude", agent: "claude" }),
    );
    expect(store.invocationInFlightCount()).toBe(2);
    store.actions.finishInvocation(
      finishEvent({ invocationId: "inv_claude", agent: "claude" }),
    );
    expect(store.invocationInFlightCount()).toBe(1);
  });

  it("flips a finished subprocess row to its outcome and lingers", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(startEvent());
    store.actions.finishInvocation(
      finishEvent({ status: "failed", kind: "agent_error" }),
    );
    const row = store.state.sessions.find((s) => s.id === "inv_abcd");
    expect(row).toBeDefined();
    expect(row!.originInvocationStatus).toBe("failed");
    expect(row!.status).toBe("idle");
    expect(row!.attentionState).toBe("unread");
    expect(store.invocationInFlightCount()).toBe(0);
  });

  it("a finished invoke row survives the hideIdle filter during linger", () => {
    const store = createTUIStore({ groupBy: "none", hideIdle: true });
    store.actions.startInvocation(startEvent());
    store.actions.finishInvocation(finishEvent({ status: "succeeded" }));
    // hideIdle drops idle+null rows; the finished invoke row sets
    // attentionState so it stays visible through its linger window.
    const visibleIds = store.filteredSessions().map((fs) => fs.session.id);
    expect(visibleIds).toContain("inv_abcd");
  });

  it("removes the finished row after the linger window", async () => {
    const store = createTUIStore({
      groupBy: "none",
      invokeFinishedLingerMs: 20,
    });
    store.actions.startInvocation(startEvent());
    store.actions.finishInvocation(finishEvent());
    expect(store.state.sessions.length).toBe(1);
    await wait(50);
    expect(store.state.sessions.length).toBe(0);
  });

  it("newest-wins: a started for a lingering id cancels its removal", async () => {
    const store = createTUIStore({
      groupBy: "none",
      invokeFinishedLingerMs: 20,
    });
    store.actions.startInvocation(startEvent());
    store.actions.finishInvocation(finishEvent());
    // Reuse the id (running again) before the linger elapses.
    store.actions.startInvocation(startEvent());
    await wait(50);
    const row = store.state.sessions.find((s) => s.id === "inv_abcd");
    expect(row).toBeDefined();
    expect(row!.originInvocationStatus).toBe("running");
  });

  it("preserves synthetic invoke rows across an init/reconnect", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(startEvent());
    // init/reconnect carries only pane-matched daemon sessions
    store.actions.setSessions([
      mockEnrichedSession({ id: "real", tmuxPane: "%1" }),
    ]);
    const ids = store.state.sessions.map((s) => s.id);
    expect(ids).toContain("real");
    expect(ids).toContain("inv_abcd");
  });

  it("does not duplicate a synthetic row if init already includes its id", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(startEvent());
    store.actions.setSessions([
      mockEnrichedSession({ id: "inv_abcd", tmuxPane: "%2" }),
    ]);
    const matches = store.state.sessions.filter((s) => s.id === "inv_abcd");
    expect(matches.length).toBe(1);
  });
});

describe("store invoke finish edge cases", () => {
  it("clears the selection when a selected finished row is removed after linger", async () => {
    const store = createTUIStore({
      groupBy: "none",
      invokeFinishedLingerMs: 20,
    });
    store.actions.startInvocation(startEvent());
    store.actions.setSelectedSessionId("inv_abcd");
    store.actions.finishInvocation(finishEvent({ status: "succeeded" }));
    expect(store.state.selectedSessionId).toBe("inv_abcd");
    await wait(50);
    expect(store.state.sessions.length).toBe(0);
    expect(store.state.selectedSessionId).toBeNull();
  });

  it("finish for an unknown invocation id is a no-op (TUI opened mid-run)", () => {
    const store = createTUIStore({ groupBy: "none" });
    expect(() =>
      store.actions.finishInvocation(
        finishEvent({ invocationId: "inv_never" }),
      ),
    ).not.toThrow();
    expect(store.state.sessions.length).toBe(0);
    expect(store.invocationInFlightCount()).toBe(0);
  });

  it("a double finish does not throw and removes the row exactly once", async () => {
    const store = createTUIStore({
      groupBy: "none",
      invokeFinishedLingerMs: 20,
    });
    store.actions.startInvocation(startEvent());
    store.actions.finishInvocation(finishEvent({ status: "succeeded" }));
    // Second finish re-arms the (single) linger timer; it must not throw,
    // double-count the in-flight set, or leak a second removal.
    store.actions.finishInvocation(finishEvent({ status: "succeeded" }));
    expect(store.state.sessions.filter((s) => s.id === "inv_abcd").length).toBe(
      1,
    );
    expect(store.invocationInFlightCount()).toBe(0);
    await wait(50);
    expect(store.state.sessions.length).toBe(0);
  });
});

describe("getGroupKey for invoke rows", () => {
  const syntheticRow = mockEnrichedSession({
    id: "inv_abcd",
    cwd: "/Users/test/Code/myapp",
    project: "myapp",
    tmuxPane: null,
    tmuxTarget: null,
    originInvocationId: "inv_abcd",
    originInvocationStatus: "running",
  });

  it("co-locates by project (basename) under project grouping", () => {
    expect(getGroupKey(syntheticRow, "project")).toBe("myapp");
  });

  it("uses a deliberate invoke group under session grouping (not '(no tmux)')", () => {
    expect(getGroupKey(syntheticRow, "session")).toBe(INVOKE_GROUP_KEY);
  });

  it("uses a deliberate invoke group under window grouping", () => {
    expect(getGroupKey(syntheticRow, "window")).toBe(INVOKE_GROUP_KEY);
  });

  it("leaves a real paneless session in the '(no tmux)' bucket", () => {
    const realPaneless = mockEnrichedSession({
      tmuxPane: null,
      tmuxTarget: null,
      originInvocationId: null,
    });
    expect(getGroupKey(realPaneless, "session")).toBe("(no tmux)");
  });
});

describe("store invoke reconcile (reconnect)", () => {
  it("does not delete a worker whose started arrives after the init snapshot (no race)", () => {
    const store = createTUIStore({ groupBy: "none" });
    // onInit drives reconcile from the init snapshot FIRST. A worker that has
    // not started yet is absent from that snapshot...
    store.actions.reconcileInvocations([]);
    // ...then its invocation_started lands (SSE ordering guarantees it is
    // processed strictly after init), fabricating the row. It must survive:
    // this is the property that the embed-in-init design buys over a racy
    // post-connect fetch, which could reconcile a stale snapshot last.
    store.actions.startInvocation(startEvent({ invocationId: "inv_fresh" }));
    const row = store.state.sessions.find((s) => s.id === "inv_fresh");
    expect(row).toBeDefined();
    expect(row!.originInvocationStatus).toBe("running");
    expect(store.invocationInFlightCount()).toBe(1);
  });

  it("prunes a stranded running row + in-flight id the daemon no longer reports", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(startEvent());
    expect(store.state.sessions.length).toBe(1);
    expect(store.invocationInFlightCount()).toBe(1);
    // Daemon reports nothing (purged record / daemon restarted mid-invoke).
    store.actions.reconcileInvocations([]);
    expect(store.state.sessions.length).toBe(0);
    expect(store.invocationInFlightCount()).toBe(0);
  });

  it("flips a stranded running row whose daemon record is terminal (missed finished)", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(startEvent());
    store.actions.reconcileInvocations([
      { invocationId: "inv_abcd", status: "failed" },
    ]);
    const row = store.state.sessions.find((s) => s.id === "inv_abcd");
    expect(row).toBeDefined();
    expect(row!.originInvocationStatus).toBe("failed");
    expect(row!.status).toBe("idle");
    expect(row!.attentionState).toBe("unread");
    // A terminal record is not running, so the id leaves the in-flight set.
    expect(store.invocationInFlightCount()).toBe(0);
  });

  it("removes the flipped row after its linger window", async () => {
    const store = createTUIStore({
      groupBy: "none",
      invokeFinishedLingerMs: 20,
    });
    store.actions.startInvocation(startEvent());
    store.actions.reconcileInvocations([
      { invocationId: "inv_abcd", status: "succeeded" },
    ]);
    expect(store.state.sessions.length).toBe(1);
    await wait(50);
    expect(store.state.sessions.length).toBe(0);
  });

  it("leaves a genuinely still-running row and its in-flight entry intact", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(startEvent());
    store.actions.reconcileInvocations([
      { invocationId: "inv_abcd", status: "running" },
    ]);
    const row = store.state.sessions.find((s) => s.id === "inv_abcd");
    expect(row).toBeDefined();
    expect(row!.originInvocationStatus).toBe("running");
    expect(row!.status).toBe("working");
    expect(store.invocationInFlightCount()).toBe(1);
  });

  it("does not re-flip or remove an already-lingering finished row", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(startEvent());
    store.actions.finishInvocation(finishEvent({ status: "succeeded" }));
    // Daemon still has the terminal record within its TTL.
    store.actions.reconcileInvocations([
      { invocationId: "inv_abcd", status: "succeeded" },
    ]);
    const row = store.state.sessions.find((s) => s.id === "inv_abcd");
    expect(row).toBeDefined();
    expect(row!.originInvocationStatus).toBe("succeeded");
  });

  it("clears a phantom Claude in-flight id that has no on-screen row", () => {
    const store = createTUIStore({ groupBy: "none" });
    store.actions.startInvocation(
      startEvent({ agent: "claude", invocationId: "inv_claude" }),
    );
    expect(store.state.sessions.length).toBe(0);
    expect(store.invocationInFlightCount()).toBe(1);
    // Claude invoke lost to a daemon restart: no row, but the count must drop.
    store.actions.reconcileInvocations([]);
    expect(store.invocationInFlightCount()).toBe(0);
  });

  it("does not fabricate rows for running invokes it never saw start (deferred hydration)", () => {
    const store = createTUIStore({ groupBy: "none" });
    // Daemon reports a running invoke the client never received a started for.
    store.actions.reconcileInvocations([
      { invocationId: "inv_unseen", status: "running" },
    ]);
    expect(store.state.sessions.length).toBe(0);
    expect(store.invocationInFlightCount()).toBe(0);
  });
});
