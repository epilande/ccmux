import { describe, it, expect } from "bun:test";
import {
  handleNotificationAction,
  isPlanApprovalWait,
  sanitizeReply,
  MAX_NOTIFICATION_REPLY_CHARS,
  STATE_CHANGED_BODY,
  type NotificationActionDeps,
} from "./notification-action";
import { BUILTIN_AGENTS, type AgentDef } from "../lib/agents";
import type { Session } from "../types/session";

const opencodeAgent = BUILTIN_AGENTS.find((a) => a.name === "opencode")!;
/** An agent that carries NO notificationActions map at all. Derived by
 *  stripping the field so the fixture stays a "no map" agent even as built-in
 *  agents gain maps over time. */
const noMapAgent: AgentDef = {
  ...opencodeAgent,
  notificationActions: undefined,
};

const STAMP = "2024-01-15T12:00:00.000Z";

/** Pane captures classifyClaudePromptPane maps to each type: a permission prompt
 *  (terminator + numbered options, no auto mode) and a plan picker (terminator +
 *  the "use auto mode" option). The makeDeps default returns whichever matches
 *  the session's stored type, so the press-time guard passes unless a test
 *  overrides `captureText` to force a mismatch. */
const PERMISSION_PANE = [
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
].join("\n");
const PLAN_PANE = [
  " Would you like to proceed?",
  " ❯ 1. Yes, and use auto mode",
  "   2. Yes, manually approve edits",
].join("\n");
/** The pane a cancelled prompt leaves behind: a bare composer, no terminator
 *  and no option rows, so `classifyClaudePromptPane` returns null. What the
 *  post-prelude re-check must see before the reply text is typed. */
const CLEARED_PANE = [" > ", " ? for shortcuts"].join("\n");
/** A live AskUserQuestion picker: no plan/permission terminator of its own, so
 *  `classifyClaudePromptPane` returns null, but it carries the picker signature
 *  ("Type something." + "Enter to select"). The post-prelude re-check must treat
 *  this as NOT cleared, or a swallowed Escape lets the Enter select an option. */
const QUESTION_PANE = [
  " Which color?",
  " ❯ 1. Blue",
  "   2. Teal",
  " Type something.",
  " Enter to select",
].join("\n");

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
    attentionGeneration: 0,
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
    /** Force the press-time pane capture; default matches the session's type. */
    captureText: string;
    /** Make the pane capture throw (guard fails closed). */
    captureThrows: boolean;
    /** Model the prelude's cancel NOT landing (Escape+text coalesced into one
     *  Alt+char read), so the prompt is still live when the reply would type. */
    preludeFailsToCancel: boolean;
    /** Foreground command for the liveness guard. `undefined` => "claude"
     *  (agent alive); pass a shell name or `null` to trip the guard. */
    paneCommand: string | null;
  }> = {},
) {
  const sendKeyCalls: Array<{ pane: string; key: string }> = [];
  const sendTextCalls: Array<{ pane: string; text: string; enter: boolean }> =
    [];
  const reNotifyCalls: Array<{ id: string; body: string }> = [];
  const jumpCalls: Session[] = [];
  const capturePaneCalls: string[] = [];

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
    capturePane: async (pane) => {
      capturePaneCalls.push(pane);
      if (overrides.captureThrows) throw new Error("capture failed");
      // The pane changes over time: a reply's prelude (Escape) cancels the
      // prompt, so any capture after it sees the bare composer. Keying the
      // prompt-shaped pane forever would make the post-prelude re-check
      // unfalsifiable.
      if (sendKeyCalls.length > 0 && !overrides.preludeFailsToCancel) {
        return CLEARED_PANE;
      }
      if (overrides.captureText !== undefined) return overrides.captureText;
      return session && isPlanApprovalWait(session)
        ? PLAN_PANE
        : PERMISSION_PANE;
    },
    getPaneCommand: async () =>
      overrides.paneCommand !== undefined ? overrides.paneCommand : "claude",
    jump: async (s) => {
      jumpCalls.push(s);
    },
    reNotify: (s, body) => {
      reNotifyCalls.push({ id: s.id, body });
    },
    sleep: async () => {},
  };
  return {
    deps,
    sendKeyCalls,
    sendTextCalls,
    reNotifyCalls,
    jumpCalls,
    capturePaneCalls,
  };
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
      {
        sessionId: "gone",
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
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
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
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
      {
        sessionId: session.id,
        action: "deny",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
  });

  it("rejects a stale token with 409, re-notifies, and sends no key", async () => {
    const session = mkSession();
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: "OLD",
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toEqual([
      { id: session.id, body: STATE_CHANGED_BODY },
    ]);
  });

  it("rejects a mismatched attentionGeneration with 409, re-notifies, and sends no key", async () => {
    // A waiting->waiting swap advances the session's generation while the token
    // above still matches. A press echoing the superseded generation must fail.
    const session = mkSession({ attentionGeneration: 3 });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 2,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toEqual([
      { id: session.id, body: STATE_CHANGED_BODY },
    ]);
  });

  it("rejects a missing input.attentionGeneration when the session has one (fail closed)", async () => {
    const session = mkSession({ attentionGeneration: 1 });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      { sessionId: session.id, action: "approve", statusChangedAt: STAMP },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("approves when the attentionGeneration matches", async () => {
    const session = mkSession({ attentionGeneration: 5 });
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 5,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "1" }]);
  });

  it("does NOT gate the default (jump) action on a mismatched attentionGeneration", async () => {
    const session = mkSession({ attentionGeneration: 9 });
    const { deps, jumpCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "default",
        attentionGeneration: 1,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(jumpCalls).toHaveLength(1);
    expect(reNotifyCalls).toHaveLength(0);
  });

  it("rejects when status is no longer waiting", async () => {
    const session = mkSession({ status: "working" });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
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
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects an unmapped agent with 409 and re-notifies", async () => {
    const session = mkSession({ agentType: "opencode" });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session, {
      getAgent: () => noMapAgent,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
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
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
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
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(500);
  });

  // OpenCode has no `planApprove`, so the pane-authoritative gate never runs;
  // approve/deny resolve straight to the def's key sequences (verified e2e on
  // OpenCode 1.18.3: Enter approves the initially-highlighted "Allow once",
  // Right Right Enter navigates to and confirms "Reject").
  const opencodeSession = () =>
    mkSession({ agentType: "opencode", pendingTool: "external_directory" });

  it("opencode approve sends bare Enter and returns 200", async () => {
    const session = opencodeSession();
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Enter" }]);
  });

  it("opencode deny sends Right Right Enter in order and returns 200", async () => {
    const session = opencodeSession();
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "deny",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([
      { pane: "%1", key: "Right" },
      { pane: "%1", key: "Right" },
      { pane: "%1", key: "Enter" },
    ]);
  });

  // Codex, like OpenCode, has no `planApprove`, so the pane-authoritative gate
  // never runs; approve/deny resolve straight to the def's keys (verified e2e on
  // codex-cli 0.144.5: Enter confirms the highlighted "Yes, proceed", Escape
  // cancels the request without running the tool).
  const codexSession = () =>
    mkSession({ agentType: "codex", pendingTool: "Bash" });

  it("codex approve sends Enter and returns 200", async () => {
    const session = codexSession();
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Enter" }]);
  });

  it("codex deny sends Escape and returns 200", async () => {
    const session = codexSession();
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "deny",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
  });

  it("refuses approve on an aggregated row with multiple concurrent waits (409, no keys)", async () => {
    // A second server-side session began waiting between delivery and press, so
    // the shared pane's dialog may not be the one the notification described.
    const session = opencodeSession();
    session.ambiguousWait = true;
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
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
        attentionGeneration: 0,
        userText: "use\nthe blue\r\none",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "use the blue one", enter: true },
    ]);
  });

  it("prefixes a space to a reply starting with '/' so it doesn't trip the slash palette", async () => {
    const session = questionSession();
    const { deps, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "/compact everything",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: " /compact everything", enter: true },
    ]);
  });

  it("prefixes a space to a reply starting with '!' so it doesn't trip shell mode", async () => {
    // SAFETY: Claude's composer offers "! for shell mode" (verified on 2.1.211),
    // where the text runs as a shell command with NO permission prompt instead of
    // reaching the agent. A natural reply ("!!! no, stop") hits this.
    const session = questionSession();
    const { deps, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "!!! no, stop",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: " !!! no, stop", enter: true },
    ]);
  });

  it("leaves a reply starting with '#' unchanged (not a mode trigger)", async () => {
    const session = questionSession();
    const { deps, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "#3 looks right",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "#3 looks right", enter: true },
    ]);
  });

  it("leaves a non-slash reply unchanged", async () => {
    const session = questionSession();
    const { deps, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "compact everything",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "compact everything", enter: true },
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
        attentionGeneration: 0,
        userText: "teal",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
    expect(sendTextCalls).toEqual([{ pane: "%1", text: "teal", enter: true }]);
  });

  it("refuses a question reply when the agent defines no prelude", async () => {
    // SAFETY: the picker ignores typed text, so with no cancel key the Enter
    // would select whichever option is highlighted -- an answer the user never
    // chose. `replyOnQuestion` alone must not open the reply path; the prelude
    // is half the gate, exactly as on the permission and plan rows. Reachable
    // only via an override, since `notificationActions` is a whole-map replace
    // and the built-in claude def always carries `answerPrelude: ["Escape"]`.
    const noPreludeAgent: AgentDef = {
      ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
      notificationActions: {
        approve: ["1"],
        deny: ["Escape"],
        replyOnQuestion: true,
      },
    };
    const session = questionSession();
    const { deps, sendKeyCalls, sendTextCalls, reNotifyCalls } = makeDeps(
      session,
      { getAgent: () => noPreludeAgent },
    );
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "teal",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
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
        attentionGeneration: 0,
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
        attentionGeneration: 0,
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
        attentionGeneration: 0,
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
        attentionGeneration: 0,
        userText: "hi",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("answers a permission wait as deny-with-feedback (Claude: Escape then text)", async () => {
    const session = mkSession(); // permission; builtin claude has permissionReplyPrelude
    const { deps, sendKeyCalls, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "use a safer flag",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "use a safer flag", enter: true },
    ]);
  });

  it("rejects an answer on a permission wait when the agent has no permissionReplyPrelude", async () => {
    const noPermReplyAgent: AgentDef = {
      ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
      notificationActions: {
        approve: ["1"],
        deny: ["Escape"],
        answerPrelude: ["Escape"],
        replyOnQuestion: true,
        replyOnFinished: true,
        // no permissionReplyPrelude -> answer on a permission wait is illegal
      },
    };
    const session = mkSession(); // attentionType: "permission"
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session, {
      getAgent: () => noPermReplyAgent,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "hi",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });
});

describe("handleNotificationAction: answer on finished (idle)", () => {
  const idleSession = () =>
    mkSession({
      status: "idle",
      attentionType: null,
      previousStatus: "working",
    });

  it("sends the reply with NO prelude and returns 200", async () => {
    const session = idleSession();
    const { deps, sendKeyCalls, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "keep going",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toHaveLength(0);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "keep going", enter: true },
    ]);
  });

  it("rejects when the agent has no replyOnFinished with 409 + re-notify", async () => {
    const noFinishedAgent: AgentDef = {
      ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
      notificationActions: { approve: ["1"], deny: ["Escape"] },
    };
    const session = idleSession();
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session, {
      getAgent: () => noFinishedAgent,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "keep going",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects a stale token with 409 + re-notify", async () => {
    const session = idleSession();
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: "OLD",
        attentionGeneration: 0,
        userText: "keep going",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects approve on an idle session (illegal action) with 409", async () => {
    const session = idleSession();
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });
});

describe("handleNotificationAction: plan_approval", () => {
  const planSession = () =>
    mkSession({ attentionType: "plan_approval", pendingTool: null });

  it("approve sends the plan-approve key (2), never the permission key (1)", async () => {
    const session = planSession();
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "2" }]);
  });

  it("deny sends Escape", async () => {
    const session = planSession();
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "deny",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
  });

  it("answer sends Escape then the reply text", async () => {
    const session = planSession();
    const { deps, sendKeyCalls, sendTextCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "tweak step 2",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "tweak step 2", enter: true },
    ]);
  });

  it("SAFETY: a live plan wait stored as permission + ExitPlanMode approves with 2, never 1", async () => {
    // The marker stores a live ExitPlanMode wait as permission with pendingTool
    // ExitPlanMode. isPlanApprovalWait routes it to the plan keys BEFORE the
    // permission rows, so approve is `2` (plain manual approve), not `1` (which
    // at the ExitPlanMode picker enables auto mode).
    const session = mkSession({
      attentionType: "permission",
      pendingTool: "ExitPlanMode",
    });
    const { deps, sendKeyCalls } = makeDeps(session);
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "2" }]);
  });

  it("rejects answer when the agent has no planReplyPrelude with 409 + re-notify", async () => {
    const noPlanReplyAgent: AgentDef = {
      ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
      notificationActions: { planApprove: ["2"], planDeny: ["Escape"] },
    };
    const session = planSession();
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session, {
      getAgent: () => noPlanReplyAgent,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "hi",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects approve when the agent has no planApprove with 409 + re-notify", async () => {
    const noPlanApproveAgent: AgentDef = {
      ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
      notificationActions: {
        planDeny: ["Escape"],
        planReplyPrelude: ["Escape"],
      },
    };
    const session = planSession();
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session, {
      getAgent: () => noPlanApproveAgent,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });
});

describe("handleNotificationAction: liveness guard", () => {
  it("rejects approve when the pane's foreground is a shell (agent exited)", async () => {
    const session = mkSession(); // permission
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session, {
      paneCommand: "zsh",
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects a reply when the pane's foreground is a login shell (-bash)", async () => {
    const session = mkSession({ attentionType: "question", pendingTool: null });
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session, {
      paneCommand: "-bash",
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "hi",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  // The guard shares pane-classify's non-agent command set, so ksh (a reply
  // would EXECUTE), the login shell -zsh/-fish, and a terminal editor (nvim,
  // keystrokes land as normal-mode commands) all fail closed.
  for (const cmd of ["ksh", "nvim", "-fish", "-zsh"]) {
    it(`rejects approve when the pane's foreground is "${cmd}"`, async () => {
      const session = mkSession(); // permission
      const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session, {
        paneCommand: cmd,
      });
      const res = await handleNotificationAction(
        {
          sessionId: session.id,
          action: "approve",
          statusChangedAt: STAMP,
          attentionGeneration: 0,
        },
        deps,
      );
      expect(res.code).toBe(409);
      expect(sendKeyCalls).toHaveLength(0);
      expect(reNotifyCalls).toHaveLength(1);
    });
  }

  it("proceeds when the pane's foreground is the agent (node)", async () => {
    const session = mkSession(); // permission
    const { deps, sendKeyCalls } = makeDeps(session, { paneCommand: "node" });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "1" }]);
  });

  it("rejects when the pane-command query fails (fail closed)", async () => {
    const session = mkSession();
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session, {
      paneCommand: null,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });
});

describe("handleNotificationAction: pane-authoritative wait type", () => {
  it("KEY FIX: stored permission + pendingTool null with a plan-picker capture sends planApprove [2]", async () => {
    // The common live-plan window: marker null tool + deferred log tool_use, so
    // isPlanApprovalWait is false. The pane is the only signal, and it wins:
    // approve sends "2" (plain manual approve), NEVER "1" (auto mode).
    const session = mkSession({ pendingTool: null }); // stored permission
    const { deps, sendKeyCalls } = makeDeps(session, {
      captureText: PLAN_PANE,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "2" }]);
  });

  it("the same session with a Bash-prompt capture sends the permission key [1]", async () => {
    const session = mkSession({ pendingTool: null }); // stored permission
    const { deps, sendKeyCalls } = makeDeps(session, {
      captureText: PERMISSION_PANE,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "1" }]);
  });

  it("stored permission + stale ExitPlanMode pendingTool, but pane shows permission -> sends [1]", async () => {
    // Direction (b): the cascade carried a stale ExitPlanMode pendingTool
    // forward onto a real permission wait. The pane overrides it back.
    const session = mkSession({
      attentionType: "permission",
      pendingTool: "ExitPlanMode",
    });
    const { deps, sendKeyCalls } = makeDeps(session, {
      captureText: PERMISSION_PANE,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "1" }]);
  });

  it("rejects (fail closed) when the pane shows no active prompt", async () => {
    const session = mkSession({ pendingTool: null });
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session, {
      captureText: "just some idle output, no prompt",
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("rejects (fail closed) when the pane capture throws", async () => {
    const session = mkSession();
    const { deps, sendKeyCalls, reNotifyCalls } = makeDeps(session, {
      captureThrows: true,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("does not consult the pane (uses stored type) when the agent def has no planApprove", async () => {
    const noPlanAgent: AgentDef = {
      ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
      notificationActions: { approve: ["1"], deny: ["Escape"] },
    };
    const session = mkSession(); // permission
    const { deps, sendKeyCalls, capturePaneCalls } = makeDeps(session, {
      getAgent: () => noPlanAgent,
      // Would classify as null (no prompt) and 409 IF the pane were consulted.
      captureText: "",
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "approve",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "1" }]);
    expect(capturePaneCalls).toHaveLength(0);
  });

  // An agent with DISTINCT plan vs permission reply preludes, so the answer
  // tests can prove which one the pane selected (Claude's are both Escape).
  const distinctPreludeAgent: AgentDef = {
    ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
    notificationActions: {
      approve: ["1"],
      deny: ["Escape"],
      answerPrelude: ["Escape"],
      permissionReplyPrelude: ["Escape"],
      planApprove: ["2"],
      planDeny: ["Escape"],
      planReplyPrelude: ["q"],
      replyOnQuestion: true,
    },
  };

  it("answer picks the plan reply prelude when the pane shows the plan picker", async () => {
    const session = mkSession({ pendingTool: null }); // stored permission
    const { deps, sendKeyCalls, sendTextCalls } = makeDeps(session, {
      getAgent: () => distinctPreludeAgent,
      captureText: PLAN_PANE,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "tweak it",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "q" }]); // planReplyPrelude
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "tweak it", enter: true },
    ]);
  });

  it("answer picks the permission reply prelude when the pane shows a permission prompt", async () => {
    const session = mkSession({ pendingTool: null }); // stored permission
    const { deps, sendKeyCalls } = makeDeps(session, {
      getAgent: () => distinctPreludeAgent,
      captureText: PERMISSION_PANE,
    });
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "no thanks",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]); // permissionReplyPrelude
  });

  it("SAFETY: refuses to type when the reply prelude did not clear the prompt", async () => {
    // Reproduced against Claude Code 2.1.212: an Escape immediately followed by
    // printable bytes can be read as ONE escape sequence (Alt+char), so the
    // cancel never lands. The reply text is then swallowed by the still-live
    // picker and the Enter selects the HIGHLIGHTED option -- "1. Yes" -- turning
    // a deny-with-feedback press into a silent APPROVE reported as 200. The
    // settle makes that rare, not impossible, so the prompt's disappearance is
    // verified rather than assumed.
    const session = mkSession({ pendingTool: null }); // stored permission
    const { deps, sendKeyCalls, sendTextCalls, reNotifyCalls } = makeDeps(
      session,
      {
        getAgent: () => distinctPreludeAgent,
        captureText: PERMISSION_PANE,
        preludeFailsToCancel: true,
      },
    );
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "no, do not do that",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]);
    expect(sendTextCalls).toHaveLength(0); // nothing typed => nothing approved
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("SAFETY: refuses to type when the post-prelude capture fails (fails closed)", async () => {
    // A dropped reply is recoverable; a wrong approve is not.
    const session = mkSession({ pendingTool: null });
    let captures = 0;
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session, {
      getAgent: () => distinctPreludeAgent,
      captureText: PERMISSION_PANE,
    });
    const realCapture = deps.capturePane;
    deps.capturePane = async (pane) => {
      captures++;
      if (captures > 1) throw new Error("capture failed");
      return realCapture(pane);
    };
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "no, do not do that",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0);
    expect(reNotifyCalls).toHaveLength(1);
  });

  it('SAFETY: refuses to type when the post-prelude capture returns empty (real dep signals failure as "", not a throw)', async () => {
    // The wired `capturePane` catches every error and returns "" (it never
    // throws, unlike the test above), and "" classifies as null = "no prompt".
    // Without the non-empty guard that reads as "prompt cleared" and the reply
    // is typed into a prompt that may still be live -- the fail-OPEN hole the
    // throw-based test could not catch, since the real dep can't throw.
    const session = mkSession({ pendingTool: null }); // stored permission
    let captures = 0;
    const { deps, sendTextCalls, reNotifyCalls } = makeDeps(session, {
      getAgent: () => distinctPreludeAgent,
      captureText: PERMISSION_PANE,
    });
    const realCapture = deps.capturePane;
    deps.capturePane = async (pane) => {
      captures++;
      if (captures > 1) return ""; // transient tmux failure, dep-contract shape
      return realCapture(pane);
    };
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "no, do not do that",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendTextCalls).toHaveLength(0); // nothing typed => nothing approved
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("SAFETY: refuses to type a QUESTION reply when the prelude leaves the picker live", async () => {
    // A question wait is NOT pane-authoritative, so the pre-fix re-check (gated
    // on a plan/permission classification) skipped this path entirely -- exactly
    // where a live picker is most likely to swallow the reply. `classifyClaude-
    // PromptPane` returns null for the picker BY DESIGN, so the re-check also has
    // to reject on the picker signature, not just a non-null classification.
    const session = mkSession({ attentionType: "question", pendingTool: null });
    const { deps, sendKeyCalls, sendTextCalls, reNotifyCalls } = makeDeps(
      session,
      { captureText: QUESTION_PANE, preludeFailsToCancel: true },
    );
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "no, the other one",
      },
      deps,
    );
    expect(res.code).toBe(409);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]); // prelude sent
    expect(sendTextCalls).toHaveLength(0); // picker still up => nothing selected
    expect(reNotifyCalls).toHaveLength(1);
  });

  it("answer falls back to the stored type when the pane classifies null (question reply still lands)", async () => {
    // A null classification is usually an AskUserQuestion picker; a reply must
    // NOT fail closed (unlike a keys press), so it falls back to the stored type.
    const session = mkSession({ pendingTool: null }); // stored permission
    const { deps, sendKeyCalls, sendTextCalls, reNotifyCalls } = makeDeps(
      session,
      { getAgent: () => distinctPreludeAgent, captureText: "" },
    );
    const res = await handleNotificationAction(
      {
        sessionId: session.id,
        action: "answer",
        statusChangedAt: STAMP,
        attentionGeneration: 0,
        userText: "the blue one",
      },
      deps,
    );
    expect(res.code).toBe(200);
    expect(reNotifyCalls).toHaveLength(0);
    expect(sendKeyCalls).toEqual([{ pane: "%1", key: "Escape" }]); // permissionReplyPrelude
    expect(sendTextCalls).toEqual([
      { pane: "%1", text: "the blue one", enter: true },
    ]);
  });
});
