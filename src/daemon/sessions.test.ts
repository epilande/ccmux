import { describe, it, expect, beforeEach } from "bun:test";
import { SessionManager, getMarkerKey } from "./sessions";
import type { Session } from "../types/session";
import type { SessionPidMarker } from "./session-markers";

const mockSession: Session = {
  id: "test-session-id",
  agentType: "claude",
  trackingMode: "native",
  nativeSessionId: "test-session-id",
  project: "test-project",
  cwd: "/test/path",
  logPath: "/test/path/test-session-id.jsonl",
  status: "waiting",
  attentionType: "plan_approval",
  pendingTool: null,
  inPlanMode: true,
  tmuxPane: null,
  updatedAt: new Date(),
  lastActivityAt: "2024-01-01T12:00:00.000Z",
  lastUserInputAt: "2024-01-01T11:55:00.000Z",
  subagents: [],
  gitBranch: null,
  version: null,
  pid: null,
  statusChangedAt: null,
  attentionGeneration: 0,
  previousStatus: null,
  attentionState: null,
  lastSeenAt: null,
  lastPrompt: null,
  prompts: [],
};

let mockMarkerMap: Map<string, SessionPidMarker | null> | null = null;

function mockGetMarker(sessionId: string): SessionPidMarker | null {
  return mockMarkerMap?.get(sessionId) ?? null;
}

describe("SessionManager", () => {
  beforeEach(() => {
    mockMarkerMap = null;
  });

  it("should create a session", () => {
    const manager = new SessionManager();
    const session = manager.createSession(
      "test-id",
      "/Users/test/.claude/projects/-Users-test-myproject/test-id.jsonl",
    );

    expect(session.id).toBe("test-id");
    expect(session.project).toBe("myproject");
    expect(session.cwd).toBe("/Users/test/myproject");
    expect(session.trackingMode).toBe("native");
    expect(session.status).toBe("idle");
    expect(manager.hasSession("test-id")).toBe(true);
  });

  it("should update a session", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    const updated = manager.updateSession("test-id", {
      status: "working",
      pendingTool: "Bash",
    });

    expect(updated).toBe(true);
    const session = manager.getSession("test-id");
    expect(session?.status).toBe("working");
    expect(session?.pendingTool).toBe("Bash");
  });

  it("should track previousStatus and statusChangedAt on status transition", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    // idle → working
    manager.updateSession("test-id", { status: "working" });
    let session = manager.getSession("test-id");
    expect(session?.previousStatus).toBe("idle");
    expect(session?.statusChangedAt).not.toBeNull();

    // working → idle
    manager.updateSession("test-id", { status: "idle" });
    session = manager.getSession("test-id");
    expect(session?.previousStatus).toBe("working");
    expect(session?.statusChangedAt).not.toBeNull();

    // Verify the timestamp is recent (within last second)
    const elapsed = Date.now() - new Date(session!.statusChangedAt!).getTime();
    expect(elapsed).toBeLessThan(1000);
  });

  it("should not update statusChangedAt when status stays the same", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    manager.updateSession("test-id", { status: "working" });
    const session = manager.getSession("test-id");
    const changedAt = session!.statusChangedAt;

    // Update other fields, status stays "working"
    manager.updateSession("test-id", {
      status: "working",
      pendingTool: "Bash",
    });
    const session2 = manager.getSession("test-id");
    expect(session2?.statusChangedAt).toBe(changedAt);
    expect(session2?.previousStatus).toBe("idle");
  });

  describe("attentionGeneration", () => {
    it("starts at 0 for a newly created session", () => {
      const manager = new SessionManager();
      const session = manager.createSession(
        "test-id",
        "/some/path/test-id.jsonl",
      );
      expect(session.attentionGeneration).toBe(0);
    });

    it("bumps when attentionType changes", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");

      manager.updateSession("test-id", {
        status: "waiting",
        attentionType: "permission",
      });
      expect(manager.getSession("test-id")?.attentionGeneration).toBe(1);
    });

    it("bumps when pendingTool changes", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");

      manager.updateSession("test-id", { pendingTool: "Bash" });
      expect(manager.getSession("test-id")?.attentionGeneration).toBe(1);
    });

    it("bumps only once when attentionType and pendingTool both change in one call", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");

      manager.updateSession("test-id", {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
      });
      expect(manager.getSession("test-id")?.attentionGeneration).toBe(1);
    });

    it("does NOT bump on a status-only change with unchanged attention fields", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");

      manager.updateSession("test-id", { status: "working" });
      expect(manager.getSession("test-id")?.attentionGeneration).toBe(0);
    });

    it("bumps on a waiting->waiting swap where only pendingTool changes", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");

      // First permission wait.
      manager.updateSession("test-id", {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Bash",
      });
      expect(manager.getSession("test-id")?.attentionGeneration).toBe(1);

      // One wait resolves and a new same-type wait begins in the same status:
      // status stays "waiting", attentionType stays "permission", only the
      // pending tool flips. statusChangedAt can't catch this; the generation must.
      manager.updateSession("test-id", {
        status: "waiting",
        attentionType: "permission",
        pendingTool: "Write",
      });
      expect(manager.getSession("test-id")?.attentionGeneration).toBe(2);
    });
  });

  it("initializes prompts as an empty array", () => {
    const manager = new SessionManager();
    const session = manager.createSession(
      "test-id",
      "/some/path/test-id.jsonl",
    );
    expect(session.prompts).toEqual([]);
  });

  it("replaces prompts and flips changed when the array differs", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    const changed = manager.updateSession("test-id", {
      prompts: ["first", "second"],
    });
    expect(changed).toBe(true);
    expect(manager.getSession("test-id")?.prompts).toEqual(["first", "second"]);

    // An identical array is a no-op (shallow-equal replace guard).
    const again = manager.updateSession("test-id", {
      prompts: ["first", "second"],
    });
    expect(again).toBe(false);
  });

  it("appends to prompts on a marker-style update (lastPrompt only, no state.prompts)", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    // Marker-driven agents (Cursor/Pi/OpenCode) set lastPrompt but not prompts.
    manager.updateSession("test-id", { lastPrompt: "first turn" });
    manager.updateSession("test-id", { lastPrompt: "second turn" });
    expect(manager.getSession("test-id")?.prompts).toEqual([
      "first turn",
      "second turn",
    ]);

    // A re-fire of the same lastPrompt does not change it, so no double-append.
    manager.updateSession("test-id", { lastPrompt: "second turn" });
    expect(manager.getSession("test-id")?.prompts).toEqual([
      "first turn",
      "second turn",
    ]);
  });

  it("dedups a flip-flopping marker lastPrompt instead of churning the index", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    // OpenCode aggregated rows flip lastPrompt between sibling prompts (pa/pb)
    // as activity alternates. Each flip is a real "changed", so it appends;
    // without dedup the index churns to [pa, pb, pa, pb, ...] and the caps
    // evict older distinct prompts. The dedup must keep one copy each, ordered
    // by most-recent delivery.
    manager.updateSession("test-id", { lastPrompt: "prompt A" });
    manager.updateSession("test-id", { lastPrompt: "prompt B" });
    manager.updateSession("test-id", { lastPrompt: "prompt A" });
    manager.updateSession("test-id", { lastPrompt: "prompt B" });

    expect(manager.getSession("test-id")?.prompts).toEqual([
      "prompt A",
      "prompt B",
    ]);
  });

  it("preserves a distinct earlier prompt across a flip-flop (no eviction)", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    // A distinct older prompt must survive the A/B churn: with dedup the index
    // stays [older, A, B] rather than filling with A/B duplicates.
    manager.updateSession("test-id", { lastPrompt: "older distinct" });
    manager.updateSession("test-id", { lastPrompt: "prompt A" });
    manager.updateSession("test-id", { lastPrompt: "prompt B" });
    manager.updateSession("test-id", { lastPrompt: "prompt A" });

    expect(manager.getSession("test-id")?.prompts).toEqual([
      "older distinct",
      "prompt B",
      "prompt A",
    ]);
  });

  it("replaces (does not double) prompts on a log-style update (both fields)", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    // Claude/Codex set prompts alongside lastPrompt: the replace branch owns
    // the index, so the marker-style append must not also fire.
    manager.updateSession("test-id", {
      lastPrompt: "hello",
      prompts: ["hello"],
    });
    expect(manager.getSession("test-id")?.prompts).toEqual(["hello"]);

    manager.updateSession("test-id", {
      lastPrompt: "hello world",
      prompts: ["hello", "hello world"],
    });
    expect(manager.getSession("test-id")?.prompts).toEqual([
      "hello",
      "hello world",
    ]);
  });

  it("clears prompts when a pane-tracked row is reused by a new process", () => {
    const manager = new SessionManager();
    manager.createPaneTrackedSession({
      agentType: "cursor",
      paneId: "%1",
      cwd: "/tmp/proj",
      pid: 100,
    });
    manager.updateSession("cursor_pane1", { lastPrompt: "old run prompt" });
    expect(manager.getSession("cursor_pane1")?.prompts).toEqual([
      "old run prompt",
    ]);

    // A new pid in the same pane is a new run: identity (incl. prompts) resets.
    manager.createPaneTrackedSession({
      agentType: "cursor",
      paneId: "%1",
      cwd: "/tmp/proj",
      pid: 200,
    });
    expect(manager.getSession("cursor_pane1")?.prompts).toEqual([]);
  });

  it("should initialize statusChangedAt and previousStatus as null", () => {
    const manager = new SessionManager();
    const session = manager.createSession(
      "test-id",
      "/some/path/test-id.jsonl",
    );
    expect(session.statusChangedAt).toBeNull();
    expect(session.previousStatus).toBeNull();
  });

  it("should not update non-existent session", () => {
    const manager = new SessionManager();
    const updated = manager.updateSession("non-existent", {
      status: "working",
    });
    expect(updated).toBe(false);
  });

  it("should remove a session", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/some/path/test-id.jsonl");

    const removed = manager.removeSession("test-id");
    expect(removed).toBe(true);
    expect(manager.hasSession("test-id")).toBe(false);
  });

  it("should get all sessions", () => {
    const manager = new SessionManager();
    manager.createSession("id1", "/path/id1.jsonl");
    manager.createSession("id2", "/path/id2.jsonl");

    const sessions = manager.getSessions();
    expect(sessions).toHaveLength(2);
  });

  it("should set tmux pane", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/path/test-id.jsonl");

    const updated = manager.setTmuxPane("test-id", "%1");

    expect(updated).toBe(true);
    const session = manager.getSession("test-id");
    expect(session?.tmuxPane).toBe("%1");
  });

  it("should emit events", () => {
    const manager = new SessionManager();
    const events: string[] = [];

    manager.on("change", (event) => {
      events.push(event.type);
    });

    manager.createSession("test-id", "/path/test-id.jsonl");
    manager.updateSession("test-id", { status: "working" });
    manager.removeSession("test-id");

    expect(events).toEqual(["created", "updated", "removed"]);
  });

  it("should clear all sessions", () => {
    const manager = new SessionManager();
    manager.createSession("id1", "/path/id1.jsonl");
    manager.createSession("id2", "/path/id2.jsonl");

    manager.clear();

    expect(manager.getSessions()).toHaveLength(0);
  });

  it("getSession returns the same object across multiple reads within a tick", () => {
    // getSession is a pure storage read. The contract is
    // that two reads of the same id without an intervening mutation yield
    // the same reference; the daemon's reconciler owns all state writes,
    // and external callers must not observe state shifting on identical
    // reads.
    const manager = new SessionManager();
    manager.createSession("test-id", "/path/test-id.jsonl");
    manager.updateSession("test-id", {
      status: "waiting",
      attentionType: "permission",
      pendingTool: "Bash",
    });

    const first = manager.getSession("test-id");
    const second = manager.getSession("test-id");
    expect(first).toBe(second);
    expect(first?.status).toBe("waiting");
    expect(first?.attentionType).toBe("permission");
    expect(first?.pendingTool).toBe("Bash");
  });

  it("getSessions returns the same object references across multiple reads within a tick", () => {
    const manager = new SessionManager();
    manager.createSession("id1", "/path/id1.jsonl");
    manager.createSession("id2", "/path/id2.jsonl");

    const first = manager.getSessions();
    const second = manager.getSessions();
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    // The array itself is freshly built each call (Array.from), but the
    // session entries inside it must be the stored objects so callers
    // observe stable identity.
    expect(first[0]).toBe(second[0]);
    expect(first[1]).toBe(second[1]);
  });

  it("should set PID on a session", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/path/test-id.jsonl");

    const updated = manager.setPid("test-id", 12345);

    expect(updated).toBe(true);
    const session = manager.getSession("test-id");
    expect(session?.pid).toBe(12345);
  });

  it("should not update PID if same value", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/path/test-id.jsonl");
    manager.setPid("test-id", 12345);

    const updated = manager.setPid("test-id", 12345);

    expect(updated).toBe(false);
  });

  it("should allow setting PID to null", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/path/test-id.jsonl");
    manager.setPid("test-id", 12345);

    const updated = manager.setPid("test-id", null);

    expect(updated).toBe(true);
    const session = manager.getSession("test-id");
    expect(session?.pid).toBeNull();
  });

  it("should return false when setting PID on non-existent session", () => {
    const manager = new SessionManager();

    const updated = manager.setPid("non-existent", 12345);

    expect(updated).toBe(false);
  });

  it("should emit event when PID changes", () => {
    const manager = new SessionManager();
    manager.createSession("test-id", "/path/test-id.jsonl");
    const events: string[] = [];

    manager.on("change", (event) => {
      events.push(event.type);
    });

    manager.setPid("test-id", 12345);

    expect(events).toEqual(["updated"]);
  });

  it("should initialize session with null PID", () => {
    const manager = new SessionManager();
    const session = manager.createSession("test-id", "/path/test-id.jsonl");

    expect(session.pid).toBeNull();
  });

  it("should find a session by native session id", () => {
    const manager = new SessionManager();
    manager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/Users/test/proj",
      pid: 12345,
      nativeSessionId: "native-1",
    });

    const session = manager.getSessionByNativeSessionId("native-1");

    expect(session?.id).toBe("claude_pane1");
    expect(session?.trackingMode).toBe("pane");
  });

  it("should clear stale Claude enrichment when a pane-scoped session is reused", () => {
    const manager = new SessionManager();
    manager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/Users/test/proj",
      pid: 12345,
      nativeSessionId: "native-1",
    });
    manager.setLogPath(
      "claude_pane1",
      "/Users/test/.claude/projects/-Users-test-proj/native-1.jsonl",
    );
    manager.updateSession("claude_pane1", {
      status: "working",
      attentionType: "permission",
      pendingTool: "Bash",
      inPlanMode: true,
      gitBranch: "feature/test",
      lastActivityAt: new Date().toISOString(),
      lastUserInputAt: new Date().toISOString(),
    });
    manager.updateSubagent("claude_pane1", {
      agentId: "sub-1",
      status: "working",
      attentionType: null,
      pendingTool: "Task",
      lastActivityAt: new Date().toISOString(),
      startedAt: null,
    });

    manager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd: "/Users/test/other-proj",
      pid: 54321,
    });

    const session = manager.getSession("claude_pane1");
    expect(session?.cwd).toBe("/Users/test/other-proj");
    expect(session?.pid).toBe(54321);
    expect(session?.nativeSessionId).toBeUndefined();
    expect(session?.logPath).toBeNull();
    expect(session?.status).toBe("idle");
    expect(session?.attentionType).toBeNull();
    expect(session?.pendingTool).toBeNull();
    expect(session?.inPlanMode).toBe(false);
    expect(session?.gitBranch).toBeNull();
    expect(session?.lastActivityAt).toBeNull();
    expect(session?.lastUserInputAt).toBeNull();
    expect(session?.subagents).toHaveLength(0);
    expect(session?.previousStatus).toBeNull();
    expect(session?.statusChangedAt).toBeNull();
  });

  it("AT-E2: pane reuse clears prior identity for non-Claude agents too", () => {
    // A codex relaunch in the same pane (new pid, no marker
    // yet) must not inherit the dead run's nativeSessionId / logPath —
    // pre-Phase-2 the reset gate was Claude-only, so the new run showed
    // OLD's prompt and resumed OLD's dead transcript.
    const manager = new SessionManager();
    manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%3",
      cwd: "/Users/test/proj",
      pid: 111,
      nativeSessionId: "old-rollout",
    });
    manager.setLogPath("codex_pane3", "/tmp/rollout-old.jsonl");
    manager.updateSession("codex_pane3", {
      status: "working",
      lastActivityAt: new Date().toISOString(),
    });

    // Codex exits; a new codex starts in the same pane with a new pid.
    manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%3",
      cwd: "/Users/test/proj",
      pid: 222,
    });

    const session = manager.getSession("codex_pane3");
    expect(session?.pid).toBe(222);
    expect(session?.nativeSessionId).toBeUndefined();
    expect(session?.logPath).toBeNull();
    expect(session?.status).toBe("idle");
    expect(session?.lastActivityAt).toBeNull();
  });

  it("cwd-only change with the same pid updates cwd but keeps identity (lsof-flap guard)", () => {
    // A transient lsof miss makes the daemon fall back to
    // `pane.currentPath`, which can differ from the process cwd as a
    // string. Same pid = same run, so the row must keep its
    // nativeSessionId/logPath — only a NEW pid means a new run (E2).
    const manager = new SessionManager();
    manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%3",
      cwd: "/private/tmp/proj",
      pid: 111,
      nativeSessionId: "rollout-1",
    });
    manager.setLogPath("codex_pane3", "/tmp/rollout-1.jsonl");

    manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%3",
      cwd: "/tmp/proj",
      pid: 111,
    });

    const session = manager.getSession("codex_pane3");
    expect(session?.cwd).toBe("/tmp/proj");
    expect(session?.nativeSessionId).toBe("rollout-1");
    expect(session?.logPath).toBe("/tmp/rollout-1.jsonl");
  });

  it("pane reuse with an unchanged process does not reset enrichment", () => {
    const manager = new SessionManager();
    manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%3",
      cwd: "/Users/test/proj",
      pid: 111,
      nativeSessionId: "rollout-1",
    });
    manager.setLogPath("codex_pane3", "/tmp/rollout-1.jsonl");

    // Same pid, same cwd — the per-scan re-create must be a no-op.
    manager.createPaneTrackedSession({
      agentType: "codex",
      paneId: "%3",
      cwd: "/Users/test/proj",
      pid: 111,
    });

    const session = manager.getSession("codex_pane3");
    expect(session?.nativeSessionId).toBe("rollout-1");
    expect(session?.logPath).toBe("/tmp/rollout-1.jsonl");
  });

  describe("setTmuxPane soft-evict", () => {
    it("should soft-evict conflicting session instead of deleting it", () => {
      const manager = new SessionManager();
      // Both sessions share same cwd (extracted from logPath)
      manager.createSession(
        "old-session",
        "/Users/test/.claude/projects/-Users-test-proj/old-session.jsonl",
      );
      manager.setTmuxPane("old-session", "%1");
      manager.setPid("old-session", 111);

      manager.createSession(
        "new-session",
        "/Users/test/.claude/projects/-Users-test-proj/new-session.jsonl",
      );

      // Assign same pane to new session — old session should be soft-evicted
      manager.setTmuxPane("new-session", "%1");

      // Old session still exists but lost pane and PID
      expect(manager.hasSession("old-session")).toBe(true);
      const old = manager.getSession("old-session");
      expect(old?.tmuxPane).toBeNull();
      expect(old?.pid).toBeNull();

      // New session has the pane
      const newS = manager.getSession("new-session");
      expect(newS?.tmuxPane).toBe("%1");
    });

    it("AT-F2: evicts a same-agent claimant from a DIFFERENT cwd (pane exclusivity)", () => {
      const manager = new SessionManager();
      manager.createSession(
        "stale-cross-cwd",
        "/Users/test/.claude/projects/-Users-test-proj-a/stale.jsonl",
      );
      manager.setTmuxPane("stale-cross-cwd", "%5");
      manager.setPid("stale-cross-cwd", 111);

      manager.createSession(
        "real-session",
        "/Users/test/.claude/projects/-Users-test-proj-b/real.jsonl",
      );
      manager.setTmuxPane("real-session", "%5");

      // The cross-cwd stale claim yields: a pane hosts one agent process.
      const stale = manager.getSession("stale-cross-cwd");
      expect(stale?.tmuxPane).toBeNull();
      expect(stale?.pid).toBeNull();
      expect(manager.getSession("real-session")?.tmuxPane).toBe("%5");
    });

    it("should emit 'updated' not 'removed' when soft-evicting", () => {
      const manager = new SessionManager();
      manager.createSession(
        "old-session",
        "/Users/test/.claude/projects/-Users-test-proj/old-session.jsonl",
      );
      manager.setTmuxPane("old-session", "%1");

      manager.createSession(
        "new-session",
        "/Users/test/.claude/projects/-Users-test-proj/new-session.jsonl",
      );

      const events: Array<{ type: string; sessionId?: string }> = [];
      manager.on("change", (event) => {
        events.push({
          type: event.type,
          sessionId: event.session?.id ?? event.sessionId,
        });
      });

      manager.setTmuxPane("new-session", "%1");

      // Should get "updated" for evicted old-session, then "updated" for new-session
      const evictEvent = events.find((e) => e.sessionId === "old-session");
      expect(evictEvent?.type).toBe("updated");
      expect(events.some((e) => e.type === "removed")).toBe(false);
    });
  });

  describe("dedupe soft-evict", () => {
    it("should soft-evict duplicate losers instead of deleting", () => {
      const manager = new SessionManager();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.createSession(
        "s2",
        "/Users/test/.claude/projects/-Users-test-proj/s2.jsonl",
      );
      // Both assigned to same pane (simulating a race)
      manager.setTmuxPane("s1", "%1");
      // Directly set s2's pane to bypass the eviction in setTmuxPane
      const internal = (
        manager as unknown as { sessions: Map<string, Session> }
      ).sessions;
      internal.get("s2")!.tmuxPane = "%1";

      const evicted = manager.dedupe();

      expect(evicted).toBe(1);
      // Both sessions still exist
      expect(manager.hasSession("s1")).toBe(true);
      expect(manager.hasSession("s2")).toBe(true);

      // Winner keeps pane, loser loses it
      const sessions = manager.getSessions().filter((s) => s.tmuxPane === "%1");
      expect(sessions).toHaveLength(1);
    });

    it("should prefer marker-backed session over non-marker session in dedupe", () => {
      const manager = new SessionManager();
      // s1 is older but has a marker (set via mock)
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.createSession(
        "s2",
        "/Users/test/.claude/projects/-Users-test-proj/s2.jsonl",
      );

      // Both assigned to same pane
      manager.setTmuxPane("s1", "%1");
      const internal = (
        manager as unknown as { sessions: Map<string, Session> }
      ).sessions;
      internal.get("s2")!.tmuxPane = "%1";

      // Make s2 newer by updatedAt
      internal.get("s2")!.updatedAt = new Date(Date.now() + 60000);
      // Make s1 older
      internal.get("s1")!.updatedAt = new Date(Date.now() - 60000);

      // Mock marker for s1 only
      mockMarkerMap = new Map([
        [
          "s1",
          {
            agent_type: "claude",
            pid: 1234,
            tty: "/dev/ttys001",
            session_id: "s1",
            timestamp: Date.now() / 1000,
          },
        ],
      ]);

      const evicted = manager.dedupe(mockGetMarker);

      expect(evicted).toBe(1);
      // s1 should keep the pane (marker-backed wins)
      const s1 = manager.getSession("s1");
      expect(s1?.tmuxPane).toBe("%1");
    });
  });

  describe("attention state", () => {
    it("should initialize attentionState and lastSeenAt as null", () => {
      const manager = new SessionManager();
      const session = manager.createSession(
        "test-id",
        "/some/path/test-id.jsonl",
      );
      expect(session.attentionState).toBeNull();
      expect(session.lastSeenAt).toBeNull();
    });

    it("should initialize attention fields on pane-tracked session", () => {
      const manager = new SessionManager();
      const session = manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%5",
        cwd: "/test/path",
        pid: 123,
      });
      expect(session.attentionState).toBeNull();
      expect(session.lastSeenAt).toBeNull();
    });

    it("should set attention state via setAttentionState", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");

      const changed = manager.setAttentionState("test-id", "unread");
      expect(changed).toBe(true);

      const session = manager.getSession("test-id");
      expect(session?.attentionState).toBe("unread");
    });

    it("should not emit event when attention state unchanged", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");

      const changed = manager.setAttentionState("test-id", null);
      expect(changed).toBe(false);
    });

    it("should mark session as seen (unread -> read)", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");
      manager.setAttentionState("test-id", "unread");

      const changed = manager.markSeen("test-id");
      expect(changed).toBe(true);

      const session = manager.getSession("test-id");
      expect(session?.attentionState).toBe("read");
      expect(session?.lastSeenAt).not.toBeNull();
    });

    it("should set lastSeenAt when transitioning to read", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");

      manager.setAttentionState("test-id", "read");
      const session = manager.getSession("test-id");
      expect(session?.lastSeenAt).not.toBeNull();
    });

    it("should set lastSeenAt when clearing to null", () => {
      const manager = new SessionManager();
      manager.createSession("test-id", "/some/path/test-id.jsonl");
      manager.setAttentionState("test-id", "unread");

      manager.setAttentionState("test-id", null);
      const session = manager.getSession("test-id");
      expect(session?.lastSeenAt).not.toBeNull();
    });

    it("should return false for non-existent session", () => {
      const manager = new SessionManager();
      expect(manager.setAttentionState("nope", "unread")).toBe(false);
      expect(manager.markSeen("nope")).toBe(false);
    });
  });

  describe("resolveSessionForMarkerEvent", () => {
    // Encodes the resolution priority used by the daemon's
    // chokidar marker-event handler. Native Claude / Codex find via
    // `getSession(marker.session_id)`; pane-tracked agents find via
    // `getSessionByNativeSessionId(marker.session_id)`. Both succeed for
    // native agents (id === nativeSessionId); pane-tracked agents
    // historically failed the `getSession` lookup, which this method closes.

    it("resolves native Claude (session.id === marker.session_id)", () => {
      const manager = new SessionManager();
      manager.createSession("uuid-abc", "/p/uuid-abc.jsonl", "claude");
      const resolved = manager.resolveSessionForMarkerEvent("uuid-abc");
      expect(resolved?.id).toBe("uuid-abc");
      expect(resolved?.trackingMode).toBe("native");
    });

    it("resolves pane-tracked Cursor by nativeSessionId", () => {
      const manager = new SessionManager();
      const session = manager.createPaneTrackedSession({
        agentType: "cursor",
        paneId: "%1",
        cwd: "/x",
        pid: 12345,
        nativeSessionId: "cursor-uuid",
      });
      expect(session.id).toBe("cursor_pane1");
      const resolved = manager.resolveSessionForMarkerEvent("cursor-uuid");
      expect(resolved?.id).toBe("cursor_pane1");
      expect(resolved?.nativeSessionId).toBe("cursor-uuid");
    });

    it("resolves pane-tracked Codex by nativeSessionId", () => {
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%2",
        cwd: "/x",
        pid: 23456,
        nativeSessionId: "codex-rollout",
      });
      const resolved = manager.resolveSessionForMarkerEvent("codex-rollout");
      expect(resolved?.id).toBe("codex_pane2");
    });

    it("resolves OpenCode winning marker by nativeSessionId", () => {
      // OpenCode aggregates N markers; only the "winning" marker's id is
      // stored in nativeSessionId.
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "opencode",
        paneId: "%3",
        cwd: "/x",
        pid: 34567,
        nativeSessionId: "ses_winner",
      });
      const resolved = manager.resolveSessionForMarkerEvent("ses_winner");
      expect(resolved?.id).toBe("opencode_pane3");
    });

    it("non-winning OpenCode sibling misses this resolver by design", () => {
      // The non-winning sibling's id is not stored in any session record,
      // so neither lookup matches. This is expected: the OpenCode adapter
      // intercepts the chokidar `change` event via its own
      // `onMarkerChanged` (re-aggregates by server PID) before this
      // resolver runs, so the cascade still applies sub-second. See
      // `adapters/opencode/plugin-adapter.ts::onMarkerChanged`.
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "opencode",
        paneId: "%4",
        cwd: "/x",
        pid: 45678,
        nativeSessionId: "ses_winner",
      });
      expect(
        manager.resolveSessionForMarkerEvent("ses_sibling"),
      ).toBeUndefined();
    });

    it("returns undefined when no session matches", () => {
      const manager = new SessionManager();
      expect(manager.resolveSessionForMarkerEvent("missing")).toBeUndefined();
    });

    it("returns undefined when two pane-tracked sessions share a nativeSessionId (defensive)", () => {
      // getSessionByNativeSessionId requires a unique hit; this exists to
      // surface marker/session identity bugs rather than silently picking
      // one. The getSession fallback also misses because synthetic
      // pane-tracked ids never equal a marker session_id.
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "cursor",
        paneId: "%5",
        cwd: "/x",
        pid: 55555,
        nativeSessionId: "shared-id",
      });
      manager.createPaneTrackedSession({
        agentType: "cursor",
        paneId: "%6",
        cwd: "/y",
        pid: 66666,
        nativeSessionId: "shared-id",
      });
      expect(manager.resolveSessionForMarkerEvent("shared-id")).toBeUndefined();
    });
  });

  describe("setNativeSessionId", () => {
    it("refuses to assign a nativeSessionId already held by another session", () => {
      // Silent overwrite would leave both sessions sharing the id, which
      // makes `resolveSessionForMarkerEvent` return undefined for the
      // marker event (covered by the defensive resolver test above).
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "cursor",
        paneId: "%1",
        cwd: "/x",
        pid: 11111,
        nativeSessionId: "incumbent-id",
      });
      manager.createPaneTrackedSession({
        agentType: "cursor",
        paneId: "%2",
        cwd: "/y",
        pid: 22222,
      });

      const events: string[] = [];
      manager.on("change", (event) => {
        events.push(event.type);
      });

      // "conflict" (not "noop") so callers can skip conflict-dependent
      // follow-on enrichment without breaking benign re-fires.
      expect(manager.setNativeSessionId("cursor_pane2", "incumbent-id")).toBe(
        "conflict",
      );
      expect(
        manager.getSession("cursor_pane2")?.nativeSessionId,
      ).toBeUndefined();
      expect(events).toEqual([]);

      // Resolver still routes the marker to the incumbent.
      expect(manager.resolveSessionForMarkerEvent("incumbent-id")?.id).toBe(
        "cursor_pane1",
      );
    });

    it("returns 'noop' (not 'conflict') when reassigning the same id on the same session", () => {
      // A resumed marker re-firing must read as benign so callers proceed with
      // their follow-on enrichment; conflating it with a real conflict would
      // break resume.
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "cursor",
        paneId: "%1",
        cwd: "/x",
        pid: 11111,
        nativeSessionId: "id-a",
      });
      const events: string[] = [];
      manager.on("change", (event) => events.push(event.type));
      expect(manager.setNativeSessionId("cursor_pane1", "id-a")).toBe("noop");
      expect(events).toEqual([]); // idempotent: no spurious update event
    });

    it("returns 'noop' when the target session does not exist", () => {
      const manager = new SessionManager();
      expect(manager.setNativeSessionId("ghost", "some-id")).toBe("noop");
    });

    it("returns 'set' when assigning a fresh nativeSessionId with no collision", () => {
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "cursor",
        paneId: "%1",
        cwd: "/x",
        pid: 11111,
      });
      expect(manager.setNativeSessionId("cursor_pane1", "fresh-id")).toBe(
        "set",
      );
      expect(manager.getSession("cursor_pane1")?.nativeSessionId).toBe(
        "fresh-id",
      );
    });

    it("AT-E1: reclaim strips a pane-tracked heuristic holder and reassigns the id", () => {
      // The marker-backed path may reclaim an id another
      // pane-tracked session merely holds (its own primary key differs —
      // a heuristic grab). The holder loses the id AND the enrichment
      // that rode in on it, so marker events re-route to the true owner.
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%1",
        cwd: "/x",
        pid: 11111,
        nativeSessionId: "stolen-id",
      });
      manager.setLogPath("codex_pane1", "/tmp/foreign-rollout.jsonl");
      manager.updateSession("codex_pane1", {
        status: "working",
        lastActivityAt: new Date().toISOString(),
      });
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%2",
        cwd: "/y",
        pid: 22222,
      });

      expect(
        manager.setNativeSessionId("codex_pane2", "stolen-id", {
          reclaim: true,
        }),
      ).toBe("set");

      // New owner holds the id; marker events route to it.
      expect(manager.getSession("codex_pane2")?.nativeSessionId).toBe(
        "stolen-id",
      );
      expect(manager.resolveSessionForMarkerEvent("stolen-id")?.id).toBe(
        "codex_pane2",
      );
      // Old holder lost the id and the foreign enrichment.
      const holder = manager.getSession("codex_pane1");
      expect(holder?.nativeSessionId).toBeUndefined();
      expect(holder?.logPath).toBeNull();
      expect(holder?.status).toBe("idle");
    });

    it("reclaim still refuses when the owner's primary key IS the id (native row)", () => {
      const manager = new SessionManager();
      manager.createSession(
        "native-uuid",
        "/Users/test/.claude/projects/-x/native-uuid.jsonl",
      );
      manager.createPaneTrackedSession({
        agentType: "claude",
        paneId: "%2",
        cwd: "/x",
        pid: 22222,
      });

      expect(
        manager.setNativeSessionId("claude_pane2", "native-uuid", {
          reclaim: true,
        }),
      ).toBe("conflict");
      expect(manager.getSession("native-uuid")?.nativeSessionId).toBe(
        "native-uuid",
      );
      expect(
        manager.getSession("claude_pane2")?.nativeSessionId,
      ).toBeUndefined();
    });

    it("without reclaim, a pane-tracked holder still produces a conflict (heuristic callers)", () => {
      const manager = new SessionManager();
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%1",
        cwd: "/x",
        pid: 11111,
        nativeSessionId: "held-id",
      });
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%2",
        cwd: "/y",
        pid: 22222,
      });

      expect(manager.setNativeSessionId("codex_pane2", "held-id")).toBe(
        "conflict",
      );
      expect(manager.getSession("codex_pane1")?.nativeSessionId).toBe(
        "held-id",
      );
    });
  });
});

describe("getMarkerKey", () => {
  it("returns the common id when native-tracked (id === nativeSessionId)", () => {
    const session: Session = {
      ...mockSession,
      id: "uuid-abc",
      trackingMode: "native",
      nativeSessionId: "uuid-abc",
    };
    expect(getMarkerKey(session)).toBe("uuid-abc");
  });

  it("returns nativeSessionId for pane-tracked session after hook handoff", () => {
    const session: Session = {
      ...mockSession,
      id: "codex_pane963",
      trackingMode: "pane",
      nativeSessionId: "real-uuid-xyz",
    };
    expect(getMarkerKey(session)).toBe("real-uuid-xyz");
  });

  it("falls back to synthetic id when pane-tracked session has no nativeSessionId", () => {
    const session: Session = {
      ...mockSession,
      id: "codex_pane963",
      trackingMode: "pane",
      nativeSessionId: undefined,
    };
    expect(getMarkerKey(session)).toBe("codex_pane963");
  });
});
