import { describe, it, expect } from "bun:test";
import { resolveSessionRef, proximityLabel } from "./session-ref";
import type { Session, TmuxPane } from "../types/session";

function mkSession(over: Partial<Session> & { id: string }): Session {
  return {
    agentType: "claude",
    trackingMode: "native",
    project: "proj",
    cwd: "/Users/dev/Code/proj",
    logPath: null,
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    tmuxPane: null,
    updatedAt: new Date("2024-01-15T12:00:00Z"),
    lastActivityAt: null,
    lastUserInputAt: null,
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
    ...over,
  };
}

function mkPane(
  paneId: string,
  sessionName: string,
  windowIndex: number,
  paneIndex = 0,
): TmuxPane {
  return {
    paneId,
    panePid: 1,
    sessionName,
    windowIndex,
    paneIndex,
    target: `${sessionName}:${windowIndex}.${paneIndex}`,
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: null,
    currentCommand: null,
    currentPath: null,
  };
}

/**
 * Layout used by most cases:
 *   work:1.0 %1 claude  (the caller's own pane)
 *   work:1.1 %2 codex
 *   work:2.0 %3 codex   (same tmux session, different window)
 *   other:0.0 %4 codex  (different tmux session)
 */
function fixture() {
  const panes = new Map<string, TmuxPane>([
    ["%1", mkPane("%1", "work", 1, 0)],
    ["%2", mkPane("%2", "work", 1, 1)],
    ["%3", mkPane("%3", "work", 2, 0)],
    ["%4", mkPane("%4", "other", 0, 0)],
  ]);
  const sessions = [
    mkSession({ id: "claude-aaa", agentType: "claude", tmuxPane: "%1" }),
    mkSession({
      id: "codex-bbb",
      agentType: "codex",
      tmuxPane: "%2",
      project: "near",
      cwd: "/Users/dev/Code/near",
    }),
    mkSession({
      id: "codex-ccc",
      agentType: "codex",
      tmuxPane: "%3",
      project: "mid",
      cwd: "/Users/dev/Code/mid",
    }),
    mkSession({
      id: "codex-ddd",
      agentType: "codex",
      tmuxPane: "%4",
      project: "far",
      cwd: "/Users/dev/Code/far",
    }),
  ];
  return { panes, sessions, callerPane: "%1" };
}

describe("resolveSessionRef exact tiers", () => {
  it("resolves a session id", () => {
    const r = resolveSessionRef("codex-ccc", fixture());
    expect(r).toMatchObject({
      outcome: "resolved",
      tier: "id",
      exact: true,
      proximity: null,
    });
    expect(r.outcome === "resolved" && r.session.id).toBe("codex-ccc");
  });

  it("resolves a pane id", () => {
    const r = resolveSessionRef("%3", fixture());
    expect(r).toMatchObject({ outcome: "resolved", tier: "pane", exact: true });
    expect(r.outcome === "resolved" && r.session.id).toBe("codex-ccc");
  });

  it("resolves a tmux coordinate through the pane cache", () => {
    const r = resolveSessionRef("other:0.0", fixture());
    expect(r).toMatchObject({
      outcome: "resolved",
      tier: "coordinate",
      exact: true,
    });
    expect(r.outcome === "resolved" && r.session.id).toBe("codex-ddd");
  });

  it("resolves self to the caller's own pane", () => {
    const r = resolveSessionRef("self", fixture());
    expect(r).toMatchObject({ outcome: "resolved", tier: "self", exact: true });
    expect(r.outcome === "resolved" && r.session.id).toBe("claude-aaa");
  });

  it("does not resolve self without a caller pane", () => {
    const ctx = fixture();
    expect(resolveSessionRef("self", { ...ctx, callerPane: null })).toEqual({
      outcome: "not-found",
    });
  });

  it("reports not-found for an unknown pane or coordinate rather than falling through", () => {
    expect(resolveSessionRef("%99", fixture())).toEqual({
      outcome: "not-found",
    });
    expect(resolveSessionRef("work:9.9", fixture())).toEqual({
      outcome: "not-found",
    });
  });

  it("reports not-found for an unknown ref", () => {
    expect(resolveSessionRef("nothing-like-this", fixture())).toEqual({
      outcome: "not-found",
    });
    expect(resolveSessionRef("   ", fixture())).toEqual({
      outcome: "not-found",
    });
  });
});

describe("resolveSessionRef fuzzy tiers", () => {
  it("lets a unique match in the nearest scope win over farther matches", () => {
    const r = resolveSessionRef("codex", fixture());
    expect(r).toMatchObject({
      outcome: "resolved",
      tier: "agent-type",
      exact: false,
      proximity: "same-window",
    });
    expect(r.outcome === "resolved" && r.session.id).toBe("codex-bbb");
  });

  it("falls to the tmux session scope when the window has no match", () => {
    const ctx = fixture();
    // Drop the same-window codex; the same-session one is now nearest.
    ctx.sessions = ctx.sessions.filter((s) => s.id !== "codex-bbb");
    const r = resolveSessionRef("codex", ctx);
    expect(r).toMatchObject({
      outcome: "resolved",
      proximity: "same-session",
    });
    expect(r.outcome === "resolved" && r.session.id).toBe("codex-ccc");
  });

  it("refuses when the nearest scope holds more than one match", () => {
    const ctx = fixture();
    ctx.sessions.push(
      mkSession({
        id: "codex-eee",
        agentType: "codex",
        tmuxPane: "%1b",
        project: "twin",
        cwd: "/Users/dev/Code/twin",
      }),
    );
    ctx.panes.set("%1b", mkPane("%1b", "work", 1, 2));
    const r = resolveSessionRef("codex", ctx);
    expect(r.outcome).toBe("ambiguous");
    if (r.outcome !== "ambiguous") return;
    // Every match of the tier is listed, nearest first, so the far ones are
    // still a usable next command.
    expect(r.candidates.map((c) => c.sessionId)).toEqual([
      "codex-bbb",
      "codex-eee",
      "codex-ccc",
      "codex-ddd",
    ]);
    expect(r.candidates.map((c) => c.proximity)).toEqual([
      "same-window",
      "same-window",
      "same-session",
      "global",
    ]);
    expect(r.candidates[0]).toMatchObject({
      coordinate: "work:1.1",
      paneId: "%2",
      agentType: "codex",
      status: "idle",
      cwd: "/Users/dev/Code/near",
    });
  });

  it("searches globally, and refuses globally, without a caller pane", () => {
    const ctx = { ...fixture(), callerPane: null };
    const r = resolveSessionRef("codex", ctx);
    expect(r.outcome).toBe("ambiguous");
    if (r.outcome !== "ambiguous") return;
    expect(r.candidates.map((c) => c.proximity)).toEqual([
      "global",
      "global",
      "global",
    ]);
  });

  it("resolves a unique global match without a caller pane", () => {
    const ctx = { ...fixture(), callerPane: null };
    const r = resolveSessionRef("claude", ctx);
    expect(r).toMatchObject({
      outcome: "resolved",
      tier: "agent-type",
      proximity: "global",
    });
  });

  it("matches a project name and a worktree directory name", () => {
    expect(resolveSessionRef("far", fixture())).toMatchObject({
      outcome: "resolved",
      tier: "project",
    });
    const ctx = fixture();
    ctx.sessions[3] = mkSession({
      id: "codex-ddd",
      agentType: "codex",
      tmuxPane: "%4",
      project: "renamed",
      cwd: "/Users/dev/Code/proj/.claude/worktrees/fix-codex",
    });
    const r = resolveSessionRef("fix-codex", ctx);
    expect(r.outcome === "resolved" && r.session.id).toBe("codex-ddd");
  });

  it("stops at the first tier with any match", () => {
    // A project literally named "codex" is never reached: the agent-type
    // tier matched first, so the resolution stays explainable.
    const ctx = fixture();
    ctx.sessions.push(
      mkSession({ id: "claude-zzz", project: "codex", tmuxPane: "%3" }),
    );
    const r = resolveSessionRef("codex", ctx);
    expect(r).toMatchObject({ outcome: "resolved", tier: "agent-type" });
  });

  it("treats a paneless session as globally distant", () => {
    const ctx = fixture();
    ctx.sessions = [
      mkSession({ id: "bg-1", agentType: "claude", tmuxPane: null }),
    ];
    const r = resolveSessionRef("claude", ctx);
    expect(r).toMatchObject({ outcome: "resolved", proximity: "global" });
  });
});

describe("proximityLabel", () => {
  it("spells each scope for the stderr echo", () => {
    expect(proximityLabel("same-window")).toBe("same window");
    expect(proximityLabel("same-session")).toBe("same tmux session");
    expect(proximityLabel("global")).toBe("global");
  });
});
