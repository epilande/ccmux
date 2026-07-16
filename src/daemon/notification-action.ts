/**
 * Shared handler for actionable-notification callbacks, invoked both by the
 * HTTP route (`POST /notification-action`, from the macOS ccmux-notifier app)
 * and by the Linux D-Bus `ActionInvoked` dispatch — one in-process code path
 * so the safety rules can't drift between platforms.
 *
 * An action button types into a live agent pane, so this is the risk surface
 * of the whole feature. Every mutating action is gated on the session still
 * being in the exact state the notification was fired for (status + attention
 * type + the `statusChangedAt` staleness token). A press that lost the race
 * sends NO keystroke and fires a "state changed" re-notification so the user
 * is never left believing they approved something they didn't.
 *
 * Pure logic plus injected effects (session lookup, key/text send, jump,
 * re-notify) — no direct imports of tmux/session internals, so it unit-tests
 * without `mock.module`.
 */

import type { Session } from "../types/session";
import type { AgentDef } from "../lib/agents";
import { stripControlChars } from "./notify-text";

/** The only actions a notification callback may request. `dismiss` is
 *  deliberately absent — a dismissed notification posts nothing. */
const WHITELIST = ["default", "approve", "deny", "answer"] as const;
export type NotificationActionId = (typeof WHITELIST)[number];

/** Single-line reply cap: notifications are for short answers, not prompts, so
 *  this is deliberately tighter than `MAX_SEND_TEXT_CHARS` (10k). */
export const MAX_NOTIFICATION_REPLY_CHARS = 2000;

/** Body of the "your press didn't land" re-notification. */
export const STATE_CHANGED_BODY = "State changed. Check the pane.";

/** Delay between sequential approve/deny keystrokes, mirroring
 *  `sendLiteralToPane`'s gap so a TUI doesn't batch them into one paste. */
const KEY_SEQUENCE_GAP_MS = 30;

/** Settle delay after an `answerPrelude` (e.g. Escape to cancel Claude's
 *  AskUserQuestion picker) before the literal reply, so the picker's cancel
 *  lands and the composer is focused first. Longer than the keystroke gap
 *  because it waits on a TUI transition, not just an un-batched keypress. */
const ANSWER_PRELUDE_SETTLE_MS = 150;

export interface NotificationActionInput {
  sessionId: string;
  /** Untrusted: validated against {@link WHITELIST} before anything else. */
  action: string;
  /** Staleness token echoed from the notification payload. */
  statusChangedAt?: string;
  /** Reply text for the `answer` action. */
  userText?: string;
}

export interface NotificationActionResult {
  code: 200 | 400 | 404 | 409 | 500;
  ok: boolean;
  /** Present on failure. */
  error?: string;
  /** Present on success: the action that ran. */
  action?: NotificationActionId;
}

export interface NotificationActionDeps {
  getSession: (sessionId: string) => Session | undefined;
  getAgent: (agentType: string) => AgentDef | undefined;
  /** Named tmux keys for approve/deny (see `sendKeyToPane`). */
  sendKey: (paneId: string, key: string) => Promise<boolean>;
  /** Literal text + Enter for the answer reply (see `sendLiteralToPane`). */
  sendText: (
    paneId: string,
    text: string,
    pressEnter: boolean,
  ) => Promise<boolean>;
  /** Default-click jump (switch-client / display-popup routing). */
  jump: (session: Session) => Promise<void>;
  /** Fires a fresh "state changed" notification when a mutating action is
   *  rejected after its session was found (so the user learns it didn't land). */
  reNotify: (session: Session, body: string) => void;
  log?: (message: string, error?: unknown) => void;
  /** Injectable for tests to avoid real timers between keystrokes. */
  sleep?: (ms: number) => Promise<void>;
}

function isWhitelisted(action: string): action is NotificationActionId {
  return (WHITELIST as readonly string[]).includes(action);
}

/** Strip control chars and collapse to a single trimmed line (a reply typed
 *  from a notification must never inject Enter/escape sequences into a pane). */
export function sanitizeReply(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  return stripControlChars(raw, { replacement: " " })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How a legal action executes in the session's live state: `reply` sends the
 * (optional) prelude keys then the literal text, `keys` sends named keys. `null`
 * means the action is illegal in this state (rejected + re-notified). The
 * caller applies the staleness-token check separately; this is purely the
 * state-legality half of the gate.
 */
type ActionPlan =
  | { mode: "reply"; prelude?: string[] }
  | { mode: "keys"; keys?: string[] }
  | null;

/**
 * Decide whether an `approve`/`deny`/`answer` press is legal in the session's
 * CURRENT state, and how it should execute. Pure (no effects), so the gate is
 * unit-testable in isolation.
 *
 * Safety asymmetry, deliberate: for a permission/plan reply the prelude key's
 * PRESENCE is the legality gate. Without an Escape first, typing text + Enter at
 * a numbered picker would select the highlighted option (i.e. approve), so a
 * reply is only offered where a cancel-to-composer prelude exists. For an idle
 * (finished) reply there is deliberately NO prelude: Escape at Claude's idle
 * composer clears a typed draft and double-Escape opens history rewind, so idle
 * gates on `status === "idle"` plus `replyOnFinished` alone.
 */
function resolveActionPlan(
  action: "approve" | "deny" | "answer",
  session: Session,
  agentDef: AgentDef | undefined,
): ActionPlan {
  const na = agentDef?.notificationActions;

  if (session.status === "idle") {
    // Finished notification: the pane sits at an idle composer. Reply only,
    // no prelude; approve/deny are illegal.
    if (action === "answer" && na?.replyOnFinished) return { mode: "reply" };
    return null;
  }

  if (session.status !== "waiting") return null;

  switch (session.attentionType) {
    case "permission":
      if (action === "approve") return { mode: "keys", keys: na?.approve };
      if (action === "deny") return { mode: "keys", keys: na?.deny };
      return null; // commit 2: answer on permission = deny with feedback
    case "question":
      // approve/deny don't apply to a question wait; answer replies, gated on
      // `replyOnQuestion` for symmetry with the notifier's Reply button.
      if (action === "answer" && na?.replyOnQuestion) {
        return { mode: "reply", prelude: na.answerPrelude };
      }
      return null;
    case "plan_approval":
      return null; // commit 3: actions + reply for plan_approval
    default:
      return null;
  }
}

/**
 * Validate and dispatch one notification-action callback. Never throws: every
 * outcome is a structured {@link NotificationActionResult} the caller maps to
 * an HTTP status (or ignores, for D-Bus).
 */
export async function handleNotificationAction(
  input: NotificationActionInput,
  deps: NotificationActionDeps,
): Promise<NotificationActionResult> {
  const log = deps.log ?? (() => {});
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (!isWhitelisted(input.action)) {
    log(`notification-action: rejected unknown action "${input.action}"`);
    return { code: 400, ok: false, error: "Unknown action" };
  }
  const action = input.action;

  const session = deps.getSession(input.sessionId);
  if (!session) {
    return { code: 404, ok: false, error: "Session not found" };
  }

  if (action === "default") {
    await deps.jump(session);
    return { code: 200, ok: true, action };
  }

  // approve / deny / answer all mutate the pane. Two orthogonal gates: the
  // staleness token must still match the edge the notification fired for, AND
  // the action must be legal in the session's live state. `resolveActionPlan`
  // owns the state-legality half and returns how to execute the action.
  //
  // Token caveat: an attentionType flip WITHIN `waiting` (permission ->
  // question) does not bump `statusChangedAt` (`SessionManager.updateSession`
  // stamps only on status edges), so the token alone can't catch that flip. It
  // is benign for Claude: both waiting reply variants use the same Escape
  // prelude.
  const tokenMatches =
    (input.statusChangedAt ?? null) === (session.statusChangedAt ?? null);
  const plan = resolveActionPlan(
    action,
    session,
    deps.getAgent(session.agentType),
  );
  if (!tokenMatches || plan === null) {
    deps.reNotify(session, STATE_CHANGED_BODY);
    return {
      code: 409,
      ok: false,
      error: "Session state changed since the notification fired",
    };
  }

  if (!session.tmuxPane) {
    // No pane to type into (soft-evicted / background). Not a keystroke race,
    // but the press still didn't land — tell the user.
    deps.reNotify(session, STATE_CHANGED_BODY);
    return { code: 409, ok: false, error: "Session has no bound pane" };
  }
  const pane = session.tmuxPane;

  if (plan.mode === "reply") {
    const text = sanitizeReply(input.userText);
    if (text.length === 0) {
      return { code: 400, ok: false, error: "Empty reply" };
    }
    if (text.length > MAX_NOTIFICATION_REPLY_CHARS) {
      return {
        code: 400,
        ok: false,
        error: `Reply exceeds ${MAX_NOTIFICATION_REPLY_CHARS} characters`,
      };
    }
    // Some waits ignore typed text and need a prelude keystroke to reach a
    // composer that accepts it (Claude's AskUserQuestion picker, or an
    // Escape-cancel of a permission prompt). Send those named keys first, then
    // let the TUI settle before typing. Idle replies carry no prelude.
    const prelude = plan.prelude;
    if (prelude && prelude.length > 0) {
      for (let i = 0; i < prelude.length; i++) {
        if (i > 0) await sleep(KEY_SEQUENCE_GAP_MS);
        const sentKey = await deps.sendKey(pane, prelude[i]);
        if (!sentKey) {
          log("notification-action: sendKey failed for answer prelude");
          return { code: 500, ok: false, error: "Failed to send reply" };
        }
      }
      await sleep(ANSWER_PRELUDE_SETTLE_MS);
    }
    // A reply beginning with "/" would trip the agent's slash-command palette
    // instead of sending as text. One leading space defuses it agent-agnostically
    // without changing the visible content.
    const toSend = text.startsWith("/") ? ` ${text}` : text;
    const sent = await deps.sendText(pane, toSend, true);
    if (!sent) {
      log("notification-action: sendText failed for answer");
      return { code: 500, ok: false, error: "Failed to send reply" };
    }
    return { code: 200, ok: true, action };
  }

  // approve / deny: the plan carries the agent's key map. Its absence means the
  // notifier never should have shown a button, so reject and re-notify defensively.
  const keys = plan.keys;
  if (!keys || keys.length === 0) {
    deps.reNotify(session, STATE_CHANGED_BODY);
    log(
      `notification-action: no ${action} key map for agent "${session.agentType}"`,
    );
    return { code: 409, ok: false, error: "Agent has no action map" };
  }

  for (let i = 0; i < keys.length; i++) {
    if (i > 0) await sleep(KEY_SEQUENCE_GAP_MS);
    const sent = await deps.sendKey(pane, keys[i]);
    if (!sent) {
      log(`notification-action: sendKey failed for ${action}`);
      return { code: 500, ok: false, error: "Failed to send keystroke" };
    }
  }
  return { code: 200, ok: true, action };
}
