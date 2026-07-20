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
import {
  classifyClaudePromptPane,
  isNonAgentCommand,
  matchesQuestionPickerSignature,
} from "./pane-classify";

/** The only actions a notification callback may request. `dismiss` is
 *  deliberately absent — a dismissed notification posts nothing. */
const WHITELIST = ["default", "approve", "deny", "answer"] as const;
export type NotificationActionId = (typeof WHITELIST)[number];

/** Single-line reply cap: notifications are for short answers, not prompts, so
 *  this is deliberately tighter than `MAX_SEND_TEXT_CHARS` (10k). */
export const MAX_NOTIFICATION_REPLY_CHARS = 2000;

/** Body of the "your press didn't land" re-notification. Used for approve/deny
 *  (a lost click, nothing to preserve) and for an `answer` with no reply text. */
export const STATE_CHANGED_BODY = "State changed. Check the pane.";

/** Re-notification body when an undelivered reply was Tier-2 prefilled into the
 *  pane's composer (typed, NOT submitted): the user jumps, sees their words, and
 *  presses Enter themselves. */
export const STATE_CHANGED_PREFILL_BODY =
  "State changed. Your reply is typed in the pane. Review and press Enter.";

/** Cap on the reply text echoed back inside the Tier-1 "not sent" body. Distinct
 *  from {@link MAX_NOTIFICATION_REPLY_CHARS} (the delivery cap): this only bounds
 *  how much text the re-notification quotes so a long paste can't blow the banner
 *  out. */
export const MAX_NOTIFICATION_REPLY_BODY_CHARS = 1000;

/** Tier-1 re-notification body: the reply could not be delivered OR safely
 *  prefilled, so quote it back (capped) so the user can copy it rather than lose
 *  their typing. */
export function buildUndeliveredReplyBody(text: string): string {
  const capped =
    text.length > MAX_NOTIFICATION_REPLY_BODY_CHARS
      ? `${text.slice(0, MAX_NOTIFICATION_REPLY_BODY_CHARS)}...`
      : text;
  return `State changed. Your reply was not sent: "${capped}"`;
}

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
  /**
   * Per-wait generation echoed from the notification payload. Enforced for
   * `approve`/`deny`/`answer` only: a press must match the session's current
   * `attentionGeneration` (missing = fail closed), catching a waiting->waiting
   * swap that `statusChangedAt` can't.
   */
  attentionGeneration?: number;
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
  /** Captures the target pane's visible text, for the press-time plan/permission
   *  guard (see `sendKeyToPane`'s sibling `capturePane`). */
  capturePane: (paneId: string) => Promise<string>;
  /** The pane's foreground command (`tmux display-message #{pane_current_command}`),
   *  for the liveness guard. Null on query failure. */
  getPaneCommand: (paneId: string) => Promise<string | null>;
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
 * Choose the re-notification body for a rejected action so a carried reply is
 * never silently discarded, and Tier-2 prefill the reply into the composer when
 * (and only when) the pane verifiably shows a plain, empty agent composer.
 *
 * Failure-mode asymmetry drives the guard: wrongly REFUSING to prefill costs the
 * user a copy-paste from the banner (the text is still in the body); wrongly
 * TYPING lands keystrokes on an unknown screen, and several agents' dialogs act
 * on raw characters (Gemini/Antigravity/Copilot pickers select-and-submit on
 * digits, Cursor on `y`, Claude's permission prompt on `1`/`2`), so a prefill on
 * the wrong screen can EXECUTE an action. Prefill is therefore positive-signal
 * only: it proceeds solely on a matched empty-composer `readyPattern`, never on
 * the mere ABSENCE of a recognized prompt.
 *
 * Returns the body to hand to `deps.reNotify`. Never throws: any guard failure
 * (or a throwing dep) falls through to the Tier-1 quoted-text body.
 */
async function preserveUndeliveredReply(
  session: Session,
  rawUserText: string | undefined,
  deps: NotificationActionDeps,
  { allowPrefill }: { allowPrefill: boolean },
): Promise<string> {
  const text = sanitizeReply(rawUserText);
  // No reply to preserve (approve/deny, or an empty `answer`): the plain body.
  if (text.length === 0) return STATE_CHANGED_BODY;

  let prefilled = false;
  if (allowPrefill) {
    try {
      prefilled = await tryPrefillReply(session, text, deps);
    } catch {
      prefilled = false;
    }
  }
  if (prefilled) {
    (deps.log ?? (() => {}))(
      `notification-action: prefilled undelivered reply into pane ${session.tmuxPane} (not submitted)`,
    );
    return STATE_CHANGED_PREFILL_BODY;
  }
  return buildUndeliveredReplyBody(text);
}

/**
 * Type `text` into the pane's composer WITHOUT pressing Enter, but only after a
 * fresh, positive check that the pane is a plain empty agent composer. Returns
 * whether the text was typed. Every gate below must hold; the first failure
 * returns false (the caller degrades to Tier 1).
 */
async function tryPrefillReply(
  session: Session,
  text: string,
  deps: NotificationActionDeps,
): Promise<boolean> {
  // Never type text the normal delivery path would 400.
  if (text.length > MAX_NOTIFICATION_REPLY_CHARS) return false;

  const pane = session.tmuxPane;
  if (!pane) return false;

  // Tier-2 prefill is scoped to Claude outright. Every "safe to type" signal
  // below is verified against Claude's TUI only: the prompt classifiers
  // (`classifyClaudePromptPane`, `matchesQuestionPickerSignature`) recognize
  // Claude dialogs, and the empty-composer reading of `readyPattern` holds for
  // Claude's `/^[>❯]\s*$/` (a drafted composer stops matching, so we never type
  // over in-progress text). Issue #35 made other agents Reply-capable
  // (`replyOnFinished`), so reply capability no longer implies those
  // classifiers apply: Antigravity now carries both the flag and a
  // `readyPattern`, but its `? for shortcuts` footer is a hint line, not an
  // empty-composer signal: verified on agy 1.1.4 that it does vanish while a
  // live permission dialog renders, but it stays matched while a DRAFT sits in
  // the composer, so prefill would type over in-progress text. Widen per agent
  // only with agent-specific prompt classifiers plus a live verification pass.
  if (session.agentType !== "claude") return false;

  // Still require genuine reply capability: a user override replaces
  // `notificationActions` wholesale, and a def stripped of every reply field
  // (`replyOnQuestion`, `replyOnFinished`, `permissionReplyPrelude`,
  // `planReplyPrelude`) never offers Reply, so its stale text must not be
  // typed either.
  const agentDef = deps.getAgent(session.agentType);
  const na = agentDef?.notificationActions;
  const replyCapable = !!(
    na?.replyOnQuestion ||
    na?.replyOnFinished ||
    na?.permissionReplyPrelude?.length ||
    na?.planReplyPrelude?.length
  );
  const readyPattern = replyCapable ? agentDef?.readyPattern : undefined;
  if (!readyPattern) return false;

  // Per-agent unsafe reply shapes can't be space-defused (composers strip
  // leading whitespace before trigger detection, or fuzzy-match a command
  // token anywhere), and prefill IS typing, so never prefill them. Same gate
  // as the submit path.
  const unsafePattern = na?.unsafeReplyPattern;
  if (unsafePattern) {
    // Reset for /g-flagged user-override regexes; `.test()` is stateful.
    unsafePattern.lastIndex = 0;
    if (unsafePattern.test(text)) return false;
  }

  // Foreground liveness. The token gates run BEFORE the main liveness guard, so
  // a reply rejected there never reached it; re-check here so a prefill can't
  // land in a shell (where it would EXECUTE) or a terminal editor. Fail closed
  // on a query miss.
  const foreground = await deps.getPaneCommand(pane);
  if (foreground === null || isNonAgentCommand(foreground)) return false;

  let capture: string;
  try {
    capture = await deps.capturePane(pane);
  } catch {
    return false;
  }
  // A live prompt, a question picker, an empty/failed capture, or a composer
  // that doesn't match the empty-composer pattern all fail closed. Only a
  // non-empty capture with a matched `readyPattern` line and NO recognized
  // prompt/picker is safe to type into.
  if (capture.trim().length === 0) return false;
  if (classifyClaudePromptPane(capture) !== null) return false;
  if (matchesQuestionPickerSignature(capture)) return false;
  const composerReady = capture.split("\n").some((line) => {
    // Reset for /g-flagged user-override regexes; `.test()` is stateful.
    readyPattern.lastIndex = 0;
    return readyPattern.test(line);
  });
  if (!composerReady) return false;

  // Same leading-`/`/`!` defuse as the submit path: a prefilled `/foo` would open
  // the slash palette (and a later Enter could select a command), and `!foo`
  // trips Claude's shell mode. One leading space neutralizes both without
  // changing the visible content.
  const toSend = /^[/!]/.test(text) ? ` ${text}` : text;
  return deps.sendText(pane, toSend, false);
}

/**
 * A plan-approval (ExitPlanMode) wait, per the STORED classification. Shared by
 * `buildNotificationContext` and this handler so the offer and the accept never
 * diverge. The `permission` arm is load-bearing: a live hook-tracked plan wait
 * is stored as a permission (see the plan-approval bullet in
 * docs/agent-adapters.md), and without it Approve would send the permission key
 * at the plan picker.
 */
export function isPlanApprovalWait(session: {
  attentionType: string | null;
  pendingTool: string | null;
}): boolean {
  return (
    session.attentionType === "plan_approval" ||
    (session.attentionType === "permission" &&
      session.pendingTool === "ExitPlanMode")
  );
}

/**
 * How a legal action executes in the session's live state: `reply` sends the
 * (optional) prelude keys then the literal text, `keys` sends named keys. `null`
 * means the action is illegal in this state (rejected + re-notified). The
 * caller applies the staleness-token check separately; this is purely the
 * state-legality half of the gate.
 *
 * `{ mode: "keys", keys: undefined }` is deliberately NON-null: the action is
 * legal for the state, but the agent defined no key map. That distinction lets
 * the keys path return the distinct "Agent has no action map" 409 (a misconfig)
 * instead of the generic state-changed 409.
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
 * `waitTypeOverride` is the live pane's classification of the plan-vs-permission
 * split. When present it beats the stored classification, which is unreliable in
 * both directions (see the `paneAuthoritative` block in the caller); absent it
 * (no-ambiguity agent, or a null classification where `answer` falls back rather
 * than failing closed) the stored classification is used.
 *
 * A permission/plan reply is gated on the prelude key's PRESENCE: without an
 * Escape first, text + Enter at a numbered picker selects the highlighted
 * (approve) option, so a reply is offered only where a cancel-to-composer prelude
 * exists. An idle (finished) reply deliberately has NO prelude (Escape at the idle
 * composer clears a draft, double-Escape opens history rewind), so it gates on
 * `status === "idle"` + `replyOnFinished` alone.
 */
function resolveActionPlan(
  action: "approve" | "deny" | "answer",
  session: Session,
  agentDef: AgentDef | undefined,
  waitTypeOverride?: "plan_approval" | "permission",
): ActionPlan {
  const na = agentDef?.notificationActions;

  if (session.status === "idle") {
    // Finished notification: the pane sits at an idle composer. Reply only,
    // no prelude; approve/deny are illegal.
    if (action === "answer" && na?.replyOnFinished) return { mode: "reply" };
    return null;
  }

  if (session.status !== "waiting") return null;

  // Pane override wins; else the stored classification (`isPlanApprovalWait`
  // covers `plan_approval` and the permission+ExitPlanMode window).
  const isPlan = waitTypeOverride
    ? waitTypeOverride === "plan_approval"
    : isPlanApprovalWait(session);

  // A plan wait's ExitPlanMode picker is a DIFFERENT shape from a permission
  // prompt, so approve/deny use the separate `planApprove`/`planDeny` keys
  // (approve = `2`, NOT `1` = auto mode).
  if (isPlan) {
    if (action === "approve") return { mode: "keys", keys: na?.planApprove };
    if (action === "deny") return { mode: "keys", keys: na?.planDeny };
    return na?.planReplyPrelude?.length
      ? { mode: "reply", prelude: na.planReplyPrelude }
      : null;
  }

  // Not a plan wait. When the pane override forced `permission`, use that row
  // even if the stored attentionType is something else.
  const effectiveType = waitTypeOverride ?? session.attentionType;
  switch (effectiveType) {
    case "permission":
      if (action === "approve") return { mode: "keys", keys: na?.approve };
      if (action === "deny") return { mode: "keys", keys: na?.deny };
      // answer = deny with feedback: the prelude cancels the prompt, then the
      // reply arrives as the next user message. Legal only when the prelude is
      // defined (else text + Enter selects the highlighted approve option).
      return na?.permissionReplyPrelude?.length
        ? { mode: "reply", prelude: na.permissionReplyPrelude }
        : null;
    case "question":
      // approve/deny don't apply; answer replies, gated on `replyOnQuestion` (for
      // symmetry with the offer) plus the prelude: the picker ignores typed text,
      // so without a cancel key Enter selects the highlighted option.
      if (
        action === "answer" &&
        na?.replyOnQuestion &&
        na.answerPrelude?.length
      ) {
        return { mode: "reply", prelude: na.answerPrelude };
      }
      return null;
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

  // Every mutating-action rejection re-notifies through here so a carried reply
  // is preserved (Tier 1: quoted in the body; Tier 2: prefilled into a verified
  // composer) instead of silently discarded. approve/deny carry no `userText`,
  // so the helper returns the plain STATE_CHANGED_BODY for them. `allowPrefill`
  // is false only where the pane can't be trusted even if it looks like a
  // composer (the ambiguous aggregated-row case below).
  const reNotifyPreserving = async (allowPrefill: boolean): Promise<void> => {
    deps.reNotify(
      session,
      await preserveUndeliveredReply(session, input.userText, deps, {
        allowPrefill,
      }),
    );
  };

  // approve / deny / answer all mutate the pane; first the staleness token must
  // still match the edge the notification fired for. An attentionType flip
  // WITHIN `waiting` (permission -> question) doesn't bump `statusChangedAt`
  // (stamped only on status edges); the attention generation check below
  // covers that case.
  const tokenMatches =
    (input.statusChangedAt ?? null) === (session.statusChangedAt ?? null);
  if (!tokenMatches) {
    await reNotifyPreserving(true);
    return {
      code: 409,
      ok: false,
      error: "Session state changed since the notification fired",
    };
  }

  // The attention generation closes the gap `statusChangedAt` leaves open: a
  // waiting->waiting swap (one wait resolves, a new same-type wait begins)
  // keeps `status` unchanged, so the token above still matches, but the
  // generation advanced. Require an exact match so a press approves the wait it
  // was fired for, never the one that silently replaced it. Fail closed on a
  // missing input field (an older daemon build's notification carries none),
  // and scope this to the prompt-consuming actions (`default` already returned
  // above, so only approve/deny/answer reach here).
  const generationMatches =
    (input.attentionGeneration ?? null) ===
    (session.attentionGeneration ?? null);
  if (!generationMatches) {
    await reNotifyPreserving(true);
    return {
      code: 409,
      ok: false,
      error: "Session state changed since the notification fired",
    };
  }

  // Aggregating-agent ambiguity guard (OpenCode). The notifier only attaches
  // buttons when exactly one server-side session is waiting, but a SECOND wait
  // can begin between delivery and press, flipping the row to ambiguous. Neither
  // staleness token catches that (a new sibling's marker doesn't change THIS
  // row's status or attention identity), and the pane-authority gate below is
  // Claude-shaped (it never runs for OpenCode). Refuse the press: a keystroke
  // would land on whichever dialog the shared pane renders, possibly the wrong
  // session's tool. `default` (jump) already returned above.
  if (session.ambiguousWait) {
    // allowPrefill FALSE: the pane is shared by multiple server-side sessions, so
    // even a verified empty composer could belong to a different session than the
    // reply was meant for. Preserve the text (Tier 1) but never type it.
    await reNotifyPreserving(false);
    log(
      `notification-action: refusing ${action} on an aggregated row with multiple concurrent waits`,
    );
    return {
      code: 409,
      ok: false,
      error: "Multiple sessions are waiting; press is ambiguous",
    };
  }

  const agentDef = deps.getAgent(session.agentType);

  // Pane-authoritative wait type. For an agent whose plan picker differs from its
  // permission prompt (`planApprove` defined), the stored plan/permission split is
  // unreliable both ways and the token can't catch it (status stays `waiting`):
  // the common plan window is `{ permission, pendingTool: null }` and a permission
  // wait right after a plan can retain a stale `ExitPlanMode` pendingTool. Only the
  // pane is reliably present at the picker, so let it DECIDE the wait type — the
  // same classify the notifier's offer side runs.
  const paneAuthoritative =
    !!agentDef?.notificationActions?.planApprove &&
    session.status === "waiting" &&
    (session.attentionType === "permission" ||
      session.attentionType === "plan_approval") &&
    session.tmuxPane !== null;

  let plan: ActionPlan;
  if (paneAuthoritative) {
    let paneKind: "plan_approval" | "permission" | null;
    try {
      paneKind = classifyClaudePromptPane(
        await deps.capturePane(session.tmuxPane!),
      );
    } catch {
      paneKind = null;
    }
    if (paneKind !== null) {
      plan = resolveActionPlan(action, session, agentDef, paneKind);
    } else if (action === "answer") {
      // Null is usually an AskUserQuestion picker; a reply safely falls back to
      // the stored type (for Claude every waiting prelude is the same Escape, so
      // the question path still lands).
      plan = resolveActionPlan(action, session, agentDef);
    } else {
      // approve/deny with no picker classified: fail CLOSED. "1" at a plan picker
      // enables auto mode, "2" at a Bash prompt is the persistent grant, so a
      // press with no visible prompt sends nothing.
      deps.reNotify(session, STATE_CHANGED_BODY);
      log(
        `notification-action: no active prompt visible on pane for ${action}`,
      );
      return {
        code: 409,
        ok: false,
        error: "No active prompt on the pane",
      };
    }
  } else {
    plan = resolveActionPlan(action, session, agentDef);
  }
  if (plan === null) {
    await reNotifyPreserving(true);
    return {
      code: 409,
      ok: false,
      error: "Session state changed since the notification fired",
    };
  }

  if (!session.tmuxPane) {
    // No pane to type into (soft-evicted / background). Not a keystroke race,
    // but the press still didn't land — tell the user. The prefill helper's own
    // pane guard degrades to Tier 1 here (no pane to type into).
    await reNotifyPreserving(true);
    return { code: 409, ok: false, error: "Session has no bound pane" };
  }
  const pane = session.tmuxPane;

  // Liveness guard (before ANY send): the reconciler keeps a dead agent's session
  // idle with its pane bound, so a press after the agent exited lands at whatever
  // now holds the pane. Refuse if the foreground is a shell (a Reply would EXECUTE
  // as a command), a terminal editor (keystrokes become normal-mode commands), or
  // if the query fails (fail CLOSED — a dropped press is recoverable, a command in
  // the shell is not).
  const foreground = await deps.getPaneCommand(pane);
  if (foreground === null || isNonAgentCommand(foreground)) {
    // The prefill helper re-runs this same liveness check, so it degrades to
    // Tier 1 here (it won't type into a shell/editor either).
    await reNotifyPreserving(true);
    log(
      `notification-action: pane foreground is "${foreground ?? "unknown"}", refusing to type`,
    );
    return { code: 409, ok: false, error: "Session is no longer at the agent" };
  }

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
    // Per-agent unsafe reply shapes. Most composers strip leading whitespace
    // BEFORE their trigger detection, so the space defuse below cannot
    // neutralize a leading trigger char (verified live: Codex 0.144.5 runs a
    // `!`-prefixed reply as a shell command with NO approval; Gemini 0.29.5
    // trims for both `/` and `!`); Cursor's slash autocomplete fuzzy-matches
    // a `/token` ANYWHERE and swallows the submitting Enter. Refuse
    // fail-closed BEFORE any prelude keystroke, since a prelude cancels a
    // live prompt, which must not happen for a reply that will never be
    // typed. The text is preserved via re-notify (Tier 1 only: prefilling it
    // is exactly the hazard) and the user delivers it from the pane.
    const unsafePattern = agentDef?.notificationActions?.unsafeReplyPattern;
    if (unsafePattern) {
      // Reset for /g-flagged user-override regexes; `.test()` is stateful.
      unsafePattern.lastIndex = 0;
      if (unsafePattern.test(text)) {
        await reNotifyPreserving(false);
        log(
          `notification-action: reply matches unsafeReplyPattern for agent "${session.agentType}", refusing to type`,
        );
        return {
          code: 409,
          ok: false,
          error:
            "Reply contains text this agent's composer cannot receive safely",
        };
      }
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
      // The prelude is fire-and-forget: `sendKey` true means tmux accepted the
      // keystroke, not that the TUI acted on it. An Escape immediately followed by
      // printable bytes can read as ONE Alt+char sequence, so the cancel never
      // lands and the Enter below selects the HIGHLIGHTED option ("1. Yes", or auto
      // mode at a plan picker) — a deny-with-feedback press silently approves,
      // reported as 200. The settle makes this rare, not impossible, so type only
      // once the prompt is provably gone.
      //
      // Runs after EVERY prelude, including the question and null-fallback reply
      // paths: the picker (null BY DESIGN from `classifyClaudePromptPane`) is where
      // a swallowed cancel selects an option. "Cleared" = non-empty capture, no
      // terminator, AND no question picker. The non-empty check is load-bearing:
      // `capturePane` signals failure as "" (never throws), which classifies null
      // and would read as "cleared". Any live prompt, picker, or failed capture
      // fails CLOSED — a dropped reply is recoverable, a wrong approve is not.
      let promptCleared: boolean;
      try {
        const paneText = await deps.capturePane(pane);
        promptCleared =
          paneText.trim().length > 0 &&
          classifyClaudePromptPane(paneText) === null &&
          !matchesQuestionPickerSignature(paneText);
      } catch {
        promptCleared = false;
      }
      if (!promptCleared) {
        // Prelude keys were already sent; the prefill helper re-captures fresh,
        // so it prefills only if the prompt has since cleared to a bare composer,
        // else Tier 1.
        await reNotifyPreserving(true);
        log(
          "notification-action: prompt still live after the reply prelude, refusing to type",
        );
        return {
          code: 409,
          ok: false,
          error: "Prompt did not clear for the reply",
        };
      }
    }
    // A reply beginning with "/" would trip the agent's slash-command palette,
    // and one beginning with "!" trips Claude's shell mode, where the text runs
    // as a command with no permission prompt (verified on 2.1.211: the composer
    // footer offers "! for shell mode"). Neither reaches the agent as a message.
    // One leading space defuses both agent-agnostically without changing the
    // visible content. ("#" is NOT a mode trigger on 2.1.211; it types through.)
    const toSend = /^[/!]/.test(text) ? ` ${text}` : text;
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

  // No separate pane guard here: the pane already DECIDED this wait's type above
  // (`paneAuthoritative`), so `keys` is the map for the picker actually on screen.

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
