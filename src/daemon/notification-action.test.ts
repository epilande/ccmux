import { describe, it, expect } from "bun:test";
import {
  handleNotificationAction,
  sanitizeReply,
  MAX_NOTIFICATION_REPLY_CHARS,
  STATE_CHANGED_BODY,
  type NotificationActionDeps,
} from "./notification-action";
import { BUILTIN_AGENTS, type AgentDef } from "../lib/agents";
import type { Session } from "../types/session";

const opencodeAgent = BUILTIN_AGENTS.find((a) => a.name === "opencode")!;

const STAMP = "2024-01-15T12:00:00.000Z";

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "claude_pane1",
    agentType: "claude",
    trackingMode: "pane",
    project: "myapp",
    cwd: "/tmp/myapp",
    logPath: "/tmp/myapp/log.jsonl",
    status: "waiting",
    attentionType: "permission",
    pendingTool: "Bash",
    inPlanMode: false,
    tmuxPane: "%1",
    updatedAt: new Date("2024-01-15T12:00:00Z"),
    lastActivityAt: null,
    lastUserInputAt: null,
    subagents: [],
    gitBranch: null,
    version: null,
    pid: 123,
    statusChangedAt: STAMP,
    previousStatus: "working",
    attentionState: null,
    lastSeenAt: null,
    lastPrompt: null,
    prompts: [],
    ...overrides,
  };
}

/** Builds a deps object over a single session, recording every effect. */
function makeDeps(
  session: Session | undefined,
  overrides: Partial<{
    getAgent: (t: string) => AgentDef | undefined;
    sendKeyResult: boolean;
    sendTextResult: boolean;
  }> = {},
) {
  const sendKeyCalls: Array<{ pane: string; key: string }> = [];
  const sendTextCalls: Array<{ pane: string; text: string; enter: boolean }> =
    [];
  const reNotifyCalls: Array<{ id: string; body: string }> = [];
  const jumpCalls: Session[] = [];

  const deps: NotificationActionDeps = {
    getSession: (id) => (session && session.id === id ? session : undefined),
    getAgent:
      overrides.getAgent ?? ((t) => BUILTIN_AGENTS.find((a) => a.name === t)),
    sendKey: async (pane, key) => {
      sendKeyCalls.push({ pane, key });
      return overrides.sendKeyResult ?? true;
    },
    sendText: async (pane, text, enter) => {
      sendTextCalls.push({ pane, text, enter });
      return overrides.sendTextResult ?? true;
    },
    jump: async (s) => {
      jumpCalls.push(s);
    },
    reNotify: (s, body) => {
      reNotifyCalls.push({ id: s.id, body });
    },
    sleep: async () => {},
  };
  return { deps, sendKeyCalls, sendTextCalls, reNotifyCalls, jumpCalls };
}

describe("sanitizeReply", () => {
  it("collapses CRLF and control chars to single-line whitespace", () => {
    expect(sanitizeReply("line1\r\nline2\tend")).toBe("line1 line2 end");
  });
  it("trims and returns empty for whitespace-only input", () => {
    expect(sanitizeReply("   \n\t ")).toBe("");
    expect(sanitizeReply(undefined)).toBe("");
  });
});

describe("handleNotificationAction: validation", () => {
  it("rejects an unknown action with 400 and never looks up the session", async () => {
    let looked = false;
    const res = await handleNotificationAction(
      { sessionId: "x", action: "dismiss" },
      {
        ...makeDeps(mkSession()).deps,
        getSession: (id) => {
          looked = true;
          return mkSession({ id });
        },
      },
    );
    expect(res.code).toBe(400);
    expect(looked).toBe(false);
  });

  it("returns 404 for a missing session", async () => {
    const { deps } = makeDeps(undefined);
    const res = await handleNotificationAction(
      { sessionId: "gone", action: "approve", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(404);
  });
});

describe("handleNotificationAction: default (jump)", () => {
  it("jumps and returns 200 regardless of status/staleness", async () => {
    const session = mkSession({ status: "idle", attentionType: null });
    const { deps, jumpCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "default" },
      deps,
    );
    expect(res.code).toBe(200);
    expect(jumpCalls).toHaveLength(1);
  });
});

describe("handleNotificationAction: approve/deny", () => {
  it("approve sends the mapped keys and returns 200", async () => {
    const session = mkSession();
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "approve", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(200);
    expect(res.action).toBe("approve");
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "1" }]);
  });

  it("deny sends the mapped deny keys", async () => {
    const session = mkSession();
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "deny", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
  });

  it("rejects a stale token with 409, re-notifies, and sends no key", async () => {
    const session = mkSession();
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "approve", statusChangedAt: "OLD" },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toEqual([
      { id: session.id, body: STATE_CHANGED_BODY },
    ]);
  });

  it("rejects when status is no longer waiting", async () => {
    const session = mkSession({ status: "working" });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "approve", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects when attentionType is not permission", async () => {
    const session = mkSession({ attentionType: "question" });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "approve", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects an unmapped agent with 409 and re-notifies", async () => {
    const session = mkSession({ agentType: "opencode" });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session, {
      getAgent: () => opencodeAgent,
    });
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "approve", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects with 409 + re-notify when the session has no pane", async () => {
    const session = mkSession({ tmuxPane: null });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "approve", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("returns 500 when a keystroke fails to send", async () => {
    const session = mkSession();
    const { deps } = makeDeps(session, { sendKeyResult: false });
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "approve", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(500);
  });
});

describe("handleNotificationAction: answer", () => {
  const questionSession = () =>
    mkSession({ attentionType: "question", pendingTool: null });

  it("sends a sanitized single-line reply and returns 200", async () => {
    const session = questionSession();
    const { deps, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        userText: "use\nthe blue\r\none",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "use the blue one", enter: true },
    ]);
  });

  it("sends the agent's answerPrelude keys before the reply text (Claude: Escape)", async () => {
    const session = questionSession(); // claude, answerPrelude: ["Escape"]
    const { deps, sendKeyCalls, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        userText: "teal",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
    expect(sendTextCalls).toEqual([{ pane: "%1", text: "teal", enter: true }]);
  });

  it("sends no prelude when the agent defines none", async () => {
    const noPreludeAgent: AgentDef = {
      ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
      notificationActions: { approve: ["1"], deny: ["Escape"] },
    };
    const session = questionSession();
    const { deps, sendKeyCalls, sendTextCalls } = makeDeps(session, {
      getAgent: () => noPreludeAgent,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        userText: "teal",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toHaveLength(0);
    expect(sendTextCalls).toEqual([{ pane: "%1", text: "teal", enter: true }]);
  });

  it("returns 500 (no reply text) when an answerPrelude keystroke fails", async () => {
    const session = questionSession();
    const { deps, sendTextCalls } = makeDeps(session, {
      sendKeyResult: false,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        userText: "teal",
      },
      deps,
    );
    expect(res.code).toBe(500);
    expect(sendTextCalls).toHaveLength(0);
  });

  it("rejects an empty reply with 400 and no re-notify", async () => {
    const session = questionSession();
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        userText: "   \n ",
      },
      deps,
    );
    expect(res.code).toBe(400);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(0);
  });

  it("rejects an over-long reply with 400", async () => {
    const session = questionSession();
    const { deps, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        userText: "x".repeat(MAX_NOTIFICATION_REPLY_CHARS + 1),
      },
      deps,
    );
    expect(res.code).toBe(400);
    expect(sendTextCalls).toHaveLength(0);
  });

  it("rejects a stale answer with 409 + re-notify", async () => {
    const session = questionSession();
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: "OLD",
        userText: "hi",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects an answer on a permission wait (wrong attentionType)", async () => {
    const session = mkSession(); // attentionType: "permission"
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        userText: "hi",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });
});
