import type {
  AttentionState,
  AttentionType,
  Session,
  SessionStatus,
} from "../types/session";
import type { SessionManager, SessionEvent } from "./sessions";
import type { NotificationEventKind, NotificationPayload } from "../lib/notify";
import type { NotificationsConfig } from "../lib/preferences";
import type { AgentDef } from "../lib/agents";
import { SCAN_INTERVAL_MS } from "../lib/config";
import { getAgentDisplayName } from "../lib/agents";
import {
  buildFinishedContext,
  buildNotificationContext,
  type NotificationContext,
} from "./notify-context";

export type { NotificationsConfig };

const DEFAULT_DELAY_MS = 1000;
const DEFAULT_EVENTS: NotificationEventKind[] = ["waiting", "finished"];
const COOLDOWN_MS = 60_000;
/**
 * Boot-scoped grace window, re-armed on every `start()` (so a daemon
 * restart gets a fresh one). Covers a real restart's settle sequence:
 * process/pane discovery, marker re-assertion, and the first reconcile
 * pass all land as genuine `updated` events with fresh `statusChangedAt`s
 * on sessions the user never actually re-triggered — `decideNotification`
 * can't tell those apart from a real transition, so this window suppresses
 * delivery for anything landing in the first two scan intervals plus a
 * one-second buffer, without special-casing per-session age (a brand-new
 * session created after the window, e.g. a fast `ccmux invoke` worker,
 * still notifies immediately).
 */
const STARTUP_GRACE_MS = SCAN_INTERVAL_MS * 2 + 1000;

/** Injectable dependencies, mirroring `StateReconcilerDeps`'s testability shape. */
export interface NotifierDeps {
  sessionManager: SessionManager;
  getActivePaneId: () => Promise<string | null>;
  /** Composes the pane-focus + frontmost-app checks (`src/daemon/focus.ts`,
   * a parallel stage). Injected so this module never imports it directly. */
  isTerminalFrontmost: () => Promise<boolean>;
  getPrefs: () => Promise<{ notifications?: NotificationsConfig }>;
  deliver: (payload: NotificationPayload) => Promise<void>;
  /** Resolves a session's agent definition so the payload builder can gate
   *  Approve/Deny buttons on its `notificationActions` map. Optional: absent
   *  means no session ever gets action buttons. */
  getAgent?: (agentType: string) => AgentDef | undefined;
  /** Builds the body-enrichment text plus an optional delivery-time
   *  reclassification for a waiting session. Injectable for tests; defaults
   *  to the real pane/transcript-backed extractor. Fail-open: any failure
   *  returns `{ body: null }`. */
  buildContext?: (session: Readonly<Session>) => Promise<NotificationContext>;
  /** Builds the finished-notification body (last assistant text, else
   *  `lastPrompt`). Injectable for tests; defaults to the real transcript-backed
   *  extractor. Fail-open: any failure returns null. */
  buildFinishedContext?: (session: Readonly<Session>) => Promise<string | null>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Pure decision core: given a status transition, what (if anything) should
 * be notified. Only real `"updated"` events carry a transition worth
 * evaluating — `"created"` never notifies (it would flood on daemon
 * restart) and `"removed"` has no next status.
 */
export function decideNotification(
  prev: SessionStatus | null,
  next: SessionStatus,
  eventType: SessionEvent["type"],
): NotificationEventKind | null {
  if (eventType !== "updated") return null;
  if (next === "waiting" && (prev === "working" || prev === "idle")) {
    return "waiting";
  }
  if (next === "idle" && (prev === "working" || prev === "waiting")) {
    return "finished";
  }
  return null;
}

function describeWaiting(session: Readonly<Session>): string {
  return describeAttention(session.attentionType, session.pendingTool);
}

/** Base "waiting" line for an attention type, split out so a delivery-time
 *  reclassification (permission → question) can rebuild the line for the
 *  effective type instead of the stored one. */
function describeAttention(
  attentionType: AttentionType,
  pendingTool: string | null,
): string {
  switch (attentionType) {
    case "permission":
      return pendingTool
        ? `Needs permission: ${pendingTool}`
        : "Needs permission";
    case "question":
      return "Waiting for your input";
    case "plan_approval":
      return "Plan ready for review";
    default:
      return "Waiting for you";
  }
}

function buildTitle(session: Readonly<Session>): string {
  const agent = getAgentDisplayName(session.agentType);
  // Agent-first, then the TUI's `project:branch` ref convention (see Preview.tsx
  // / session-columns.ts). The ref is passed whole (no pre-clipping): the agent
  // leads, so macOS's own single-line tail-truncation can only ever cost the
  // ref's tail, never the agent name.
  const ref = session.gitBranch
    ? `${session.project}:${session.gitBranch}`
    : session.project;
  return `${agent} · ${ref}`;
}

function buildBasePayload(
  session: Readonly<Session>,
  kind: NotificationEventKind,
  cfg: NotificationsConfig | undefined,
): NotificationPayload {
  // The event line lives in `subtitle` now (every backend renders it, folding
  // it into the body where there's no native subtitle slot); `body` is reserved
  // for the contextual enrichment `buildPayload` fills in, and stays empty when
  // there is none.
  const subtitle = kind === "finished" ? "Finished" : describeWaiting(session);
  return {
    title: buildTitle(session),
    subtitle,
    body: "",
    event: kind,
    sessionId: session.id,
    agent: getAgentDisplayName(session.agentType),
    project: session.project,
    branch: session.gitBranch,
    pane: session.tmuxPane,
    background: session.trackingMode === "background",
    sound: cfg?.sound,
    command: cfg?.command,
    // The staleness token the ccmux-notifier callback echoes back so
    // `/notification-action` can reject a press whose session moved on.
    statusChangedAt: session.statusChangedAt ?? undefined,
    // ccmux-notifier delivery fields (notifierPath/callbackUrl) are stamped by
    // the daemon's delivery wrapper (src/daemon/notify-delivery.ts), which owns
    // the resolved helper path and daemon port this module doesn't have.
  };
}

/**
 * The "your button press didn't land, look at the pane" notification fired
 * by `/notification-action` when a stale approve/deny/answer is rejected.
 * Informational: no buttons or reply, but default click-to-jump stays.
 * Exported for the daemon wiring's `reNotify` dep.
 */
export function buildStateChangedPayload(
  session: Readonly<Session>,
  body: string,
  cfg: NotificationsConfig | undefined,
): NotificationPayload {
  return {
    // Carry the live config so the "command" backend (payload.command) still
    // fires and the configured sound isn't dropped on a stale-press re-notify.
    ...buildBasePayload(session, "waiting", cfg),
    // `body` here is a self-contained message ("State changed. Check the
    // pane."); clear the base waiting subtitle so it doesn't prepend a stale
    // "Needs permission" line that no longer describes this notification.
    subtitle: undefined,
    body,
  };
}

/**
 * Daemon-side notification dispatcher. Subscribes to `SessionManager`'s
 * `"change"` event and turns `working/waiting/idle` transitions into
 * desktop notifications via an injected `deliver`. See the Notifications
 * section of `docs/architecture.md` for the behavior spec this implements:
 * edge-triggered events, finished-only debounce with a terminal-only floor,
 * two-condition focus suppression, dedup, and a 60s renotify cooldown
 * cleared early on read.
 *
 * Known limitation (accepted): the dedup key is keyed on `statusChangedAt`,
 * an ISO string with millisecond resolution — two genuinely distinct
 * transitions for the same session landing in the same millisecond would
 * collide and the second would be dropped. Not worth guarding against in
 * practice given the realistic cadence of status changes.
 */
export class Notifier {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** Pending `"finished"` debounce timers, keyed by session id. */
  private pendingTimers = new Map<string, unknown>();
  /** Fire-once-per-transition guard: the last `statusChangedAt` consumed
   * per session id. Only the newest edge can ever legitimately recur
   * (events always carry the session's *current* `statusChangedAt`, so an
   * older stamp never reappears), so one entry per session is sufficient —
   * bounded by session count instead of growing with every transition ever
   * seen. */
  private seen = new Map<string, string>();
  /** Last delivery time per `${session.id}:${kind}`, for the 60s cooldown. */
  private cooldowns = new Map<string, number>();
  /** Last observed `attentionState` per session id, so the cooldown clear
   * below fires only on the non-"read" -> "read" transition, not on every
   * subsequent change event while a session sits in "read". */
  private lastAttentionState = new Map<string, AttentionState>();
  /** Per-session generation counter for `armFinishedTimer`: bumped
   * synchronously at the start of each arm so an in-flight (awaiting
   * prefs) arm can detect a newer arm superseded it and bail without
   * touching `pendingTimers`. */
  private armGenerations = new Map<string, number>();
  private listener: ((event: SessionEvent) => void) | null = null;
  /** Timestamp (on the injected `now` clock) of the last `start()` call;
   * transitions within `STARTUP_GRACE_MS` of it are suppressed. */
  private startedAt = 0;

  constructor(private readonly deps: NotifierDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.startedAt = this.now();
    this.listener = (event) => this.handleChange(event);
    this.deps.sessionManager.on("change", this.listener);
  }

  stop(): void {
    if (this.listener) {
      this.deps.sessionManager.off("change", this.listener);
      this.listener = null;
    }
    for (const timer of this.pendingTimers.values()) this.clearTimer(timer);
    this.pendingTimers.clear();
    this.seen.clear();
    this.cooldowns.clear();
    this.lastAttentionState.clear();
    this.armGenerations.clear();
  }

  private handleChange(event: SessionEvent): void {
    if (event.type === "removed") {
      if (event.sessionId) this.handleRemoved(event.sessionId);
      return;
    }
    // Never notify on daemon (re)discovery — a restart would otherwise
    // flood every already-waiting session.
    if (event.type === "created") return;

    const session = event.session;
    if (!session) return;

    // The `/active-pane` focus-hook path flips `attentionState` to "read"
    // via `setAttentionState`, which emits this same "change" event — no
    // extra wiring needed to observe the clear. Only clear on the actual
    // non-"read" -> "read" transition: with a plain `=== "read"` check, any
    // unrelated update while the session is already in "read" (e.g. a
    // gitBranch refresh) would re-clear a fresh cooldown and reopen the
    // flicker-renotify hole the cooldown exists to guard against.
    const previousAttentionState =
      this.lastAttentionState.get(session.id) ?? null;
    this.lastAttentionState.set(session.id, session.attentionState);
    if (
      session.attentionState === "read" &&
      previousAttentionState !== "read"
    ) {
      this.clearCooldownsForSession(session.id);
    }

    if (session.statusChangedAt == null) return;
    if (this.seen.get(session.id) === session.statusChangedAt) return;

    const kind = decideNotification(
      session.previousStatus,
      session.status,
      event.type,
    );
    if (!kind) return;
    // Mark the edge consumed even when the startup grace window below
    // suppresses it: replaying the same event later (e.g. a redundant
    // marker re-fire) must not re-evaluate it once the window has passed.
    this.seen.set(session.id, session.statusChangedAt);

    if (this.now() - this.startedAt < STARTUP_GRACE_MS) {
      console.debug(
        `Notifier: suppressing ${kind} for session ${session.id} during startup grace window`,
      );
      return;
    }

    if (kind === "waiting") {
      // Permission prompts are time-sensitive: fire immediately rather than
      // debouncing. A transient false "waiting" is bounded by the cooldown.
      void this.fire(session, "waiting");
    } else {
      void this.armFinishedTimer(session);
    }
  }

  private handleRemoved(sessionId: string): void {
    this.clearPendingTimer(sessionId);
    this.seen.delete(sessionId);
    this.lastAttentionState.delete(sessionId);
    this.armGenerations.delete(sessionId);
    const prefix = `${sessionId}:`;
    for (const key of this.cooldowns.keys()) {
      if (key.startsWith(prefix)) this.cooldowns.delete(key);
    }
  }

  private clearCooldownsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`;
    for (const key of this.cooldowns.keys()) {
      if (key.startsWith(prefix)) this.cooldowns.delete(key);
    }
  }

  private clearPendingTimer(sessionId: string): void {
    const timer = this.pendingTimers.get(sessionId);
    if (timer !== undefined) {
      this.clearTimer(timer);
      this.pendingTimers.delete(sessionId);
    }
  }

  private async armFinishedTimer(session: Readonly<Session>): Promise<void> {
    const sessionId = session.id;
    // `session` is a live reference into `SessionManager`'s store, mutated
    // in place on every future update — so the values to compare against at
    // fire time must be snapshotted as primitives now, not read off the
    // object later (by then it may already reflect a newer transition).
    const armedStatus = session.status;
    const armedStatusChangedAt = session.statusChangedAt;

    // Bump the generation and clear any existing timer synchronously,
    // before the `getPrefs` await below. Two arms for the same session can
    // otherwise have their awaits resolve out of order: without a
    // synchronous claim here, the arm that resolves LAST would clear
    // whichever timer the other arm (which may be the NEWER transition)
    // already installed, replacing it with a stale one — and the stale
    // timer's fire-time re-read would then correctly drop it, silently
    // losing a valid notification. Claiming the generation up front means
    // whichever arm actually runs first (in call order) owns the pending
    // timer, and the other bails via the generation check post-await.
    const generation = (this.armGenerations.get(sessionId) ?? 0) + 1;
    this.armGenerations.set(sessionId, generation);
    this.clearPendingTimer(sessionId);

    let delayMs = DEFAULT_DELAY_MS;
    try {
      const prefs = await this.deps.getPrefs();
      delayMs = prefs.notifications?.delayMs ?? DEFAULT_DELAY_MS;
    } catch (error) {
      console.debug("Notifier: getPrefs failed while arming debounce", error);
    }

    // A newer arm for this session may have claimed the generation (and
    // cleared/replaced the timer) while this call was awaiting prefs. If
    // so, this arm is stale — bail without touching `pendingTimers`.
    if (this.armGenerations.get(sessionId) !== generation) return;

    // Terminal-only sessions (no log/marker enrichment) only change status
    // on a reconciler scan tick, so a 1s timer would fire before the next
    // tick and confirm nothing. Flooring at one extra scan interval lets a
    // real re-scan settle the status before we commit to "Finished".
    const isTerminalOnly = !session.logPath && !session.nativeSessionId;
    const effectiveDelay = isTerminalOnly
      ? Math.max(delayMs, SCAN_INTERVAL_MS + 1000)
      : delayMs;

    const timer = this.setTimer(() => {
      this.pendingTimers.delete(sessionId);
      void this.fireDebounced(sessionId, armedStatus, armedStatusChangedAt);
    }, effectiveDelay);
    this.pendingTimers.set(sessionId, timer);
  }

  /** Re-reads the session at fire time and drops the notification if its
   * status or `statusChangedAt` moved on since the timer was armed. */
  private async fireDebounced(
    sessionId: string,
    armedStatus: SessionStatus,
    armedStatusChangedAt: string | null,
  ): Promise<void> {
    const session = this.deps.sessionManager.getSession(sessionId);
    if (
      !session ||
      session.status !== armedStatus ||
      session.statusChangedAt !== armedStatusChangedAt
    ) {
      return;
    }
    await this.fire(session, "finished");
  }

  /** Both conditions must hold to suppress: the session's pane is the
   * active tmux pane AND the terminal hosting that client is frontmost.
   * Background sessions are paneless and never suppressed. Any lookup
   * failure fails open (not suppressed = notify). */
  private async isSuppressedByFocus(
    session: Readonly<Session>,
  ): Promise<boolean> {
    if (session.trackingMode === "background") return false;
    if (!session.tmuxPane) return false;
    try {
      const activePaneId = await this.deps.getActivePaneId();
      if (!activePaneId || activePaneId !== session.tmuxPane) return false;
      return await this.deps.isTerminalFrontmost();
    } catch (error) {
      console.debug("Notifier: focus check failed, notifying", error);
      return false;
    }
  }

  /**
   * Builds the delivered payload: the base fields (identity title + event-line
   * subtitle) plus the contextual `body` and the actionable extras (Approve/Deny
   * buttons, inline Reply). Buttons appear only for a `permission` wait whose
   * agent defines `approve`/`deny` keys. Reply is def-driven: on a `question`
   * wait when the agent sets `replyOnQuestion`, and on a `finished` (idle)
   * notification when it sets `replyOnFinished`. Every enrichment fails open, so
   * a null context leaves the body empty and the subtitle carrying the event on
   * its own.
   */
  private async buildPayload(
    session: Readonly<Session>,
    kind: NotificationEventKind,
    cfg: NotificationsConfig | undefined,
  ): Promise<NotificationPayload> {
    const payload = buildBasePayload(session, kind, cfg);

    if (kind === "finished") {
      const buildFinished =
        this.deps.buildFinishedContext ?? buildFinishedContext;
      const body = await buildFinished(session);
      if (body) payload.body = body;
      const map = this.deps.getAgent?.(session.agentType)?.notificationActions;
      if (map?.replyOnFinished)
        payload.reply = { id: "answer", label: "Reply" };
      return payload;
    }

    // Build the context first: its pane capture can reveal that a stored
    // `permission` wait is really an AskUserQuestion question (the marker's
    // next-scan correction hasn't landed yet). Actions/reply are then decided
    // off the effective type through this ONE decision path, so delivery-time
    // and stored classifications never diverge.
    const buildContext = this.deps.buildContext ?? buildNotificationContext;
    const context = await buildContext(session);
    const effectiveAttention = context.reclassifyAs ?? session.attentionType;
    const map = this.deps.getAgent?.(session.agentType)?.notificationActions;

    if (effectiveAttention === "permission") {
      const actions: NotificationPayload["actions"] = [];
      if (map?.approve && map.approve.length > 0) {
        actions.push({ id: "approve", label: "Approve" });
      }
      if (map?.deny && map.deny.length > 0) {
        actions.push({ id: "deny", label: "Deny" });
      }
      if (actions.length > 0) payload.actions = actions;
    } else if (effectiveAttention === "question" && map?.replyOnQuestion) {
      payload.reply = { id: "answer", label: "Reply" };
    }

    // A reclassification invalidates the base SUBTITLE (built for the stored
    // type), so rebuild it for the effective type. The context text is the body
    // on its own now — no longer prefixed by the event line.
    if (context.reclassifyAs) {
      payload.subtitle = describeAttention(context.reclassifyAs, null);
    }
    if (context.body) {
      payload.body = context.body;
    }

    return payload;
  }

  /**
   * Delivers (or drops) one notification for an already-current `session`
   * (freshness is the caller's job: `"waiting"` fires use the event's own
   * snapshot immediately, `"finished"` fires are re-checked by
   * `fireDebounced` first). Every subsequent step (prefs gate, focus check,
   * cooldown, delivery) can fail without taking the daemon down — the whole
   * path is one fail-open try/catch, logged at debug.
   */
  private async fire(
    session: Readonly<Session>,
    kind: NotificationEventKind,
  ): Promise<void> {
    try {
      const prefs = await this.deps.getPrefs();
      const cfg = prefs.notifications;
      if (!cfg?.enabled) return;
      const events = cfg.events ?? DEFAULT_EVENTS;
      if (!events.includes(kind)) return;

      if (await this.isSuppressedByFocus(session)) return;

      const cooldownKey = `${session.id}:${kind}`;
      const now = this.now();
      const lastFired = this.cooldowns.get(cooldownKey);
      if (lastFired !== undefined && now - lastFired < COOLDOWN_MS) return;

      // Stamped BEFORE awaiting delivery, not after: two concurrent fires
      // for the same session+kind could otherwise both pass the check
      // above while the first delivery is still in flight. A failed
      // delivery leaving a 60s stamp behind is an acceptable trade —
      // delivery failures are swallowed below regardless.
      this.cooldowns.set(cooldownKey, now);
      const payload = await this.buildPayload(session, kind, cfg);
      await this.deps.deliver(payload);
    } catch (error) {
      console.debug("Notifier: fire failed, dropping notification", error);
    }
  }
}
