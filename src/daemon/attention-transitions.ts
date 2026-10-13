import type { SessionStatus } from "../types/session";
import {
  isBackgroundSession,
  type SessionEvent,
  type SessionManager,
} from "./sessions";
import type { AttentionTracker } from "./attention-tracker";

/** Injectable dependencies, mirroring `NotifierDeps`' testability shape. */
export interface AttentionTransitionsDeps {
  sessionManager: SessionManager;
  tracker: AttentionTracker;
  /** Live tmux query for the focused pane: `getActivePaneId` in
   * `state-reconciler.ts`, the same source the scan's unread -> read upgrade
   * and the notifier's focus check read, so a finish and the scan that
   * follows it can never judge "viewing" against different panes. */
  getActivePaneId: () => Promise<string | null>;
}

/** What a status edge means for attention. `new-work` clears it; a
 * `finished` turn lands `unread` or `read`. */
export type AttentionEdge = "new-work" | "finished";

/**
 * Pure decision core: given a status transition, what it does to attention.
 * Entering `working`/`waiting` is new work (a `working <-> waiting` swap
 * included, where the clear is a no-op); entering `idle` from either is a
 * finished turn.
 */
export function classifyAttentionEdge(
  prev: SessionStatus | null,
  next: SessionStatus,
): AttentionEdge | null {
  if (next === "working" || next === "waiting") return "new-work";
  if (next === "idle" && (prev === "working" || prev === "waiting")) {
    return "finished";
  }
  return null;
}

/**
 * Resolves inbox attention (unread/read/null) the moment a session's status
 * changes, rather than on the next 5s scan (issue #232). A turn that started
 * and ended between two scans used to go unnoticed, a finish was judged
 * against whichever pane was focused at scan time, and a new turn kept the
 * last turn's unread mark until the scan caught up.
 *
 * Subscribes to `SessionManager`'s `"change"` event, so every status writer
 * (log watchers, marker reconciles, the scan, hook adapters) is covered
 * without any of them knowing about attention. What still depends on time or
 * on focus moving with no status change stays on the scan
 * (`reconcileAttentionStates`): the unread -> read upgrade when the user
 * views a pane, and the read -> null decay.
 *
 * Background (paneless) sessions are skipped: unread clears on viewing a
 * pane, which they have none of, so a finish would stick forever.
 */
export class AttentionTransitions {
  /** Last `statusChangedAt` consumed per session id: the edge identity, as in
   * the notifier. Keying on the stamp rather than the
   * `previousStatus -> status` pair is load-bearing, since every non-status
   * update (a branch refresh, a prompt append) re-emits the same pair, and
   * `resetPaneTrackedSessionState` flips `status` to idle without a new
   * stamp, which is a relaunch, not a finished turn. Shares the notifier's
   * accepted limitation: two transitions in the same millisecond collide. */
  private seen = new Map<string, string>();
  private listener: ((event: SessionEvent) => void) | null = null;

  constructor(private readonly deps: AttentionTransitionsDeps) {}

  start(): void {
    if (this.listener) return;
    // Edges that landed before the listener existed were never observed as
    // edges; replaying them off a later unrelated update would judge an old
    // finish against today's focus.
    for (const session of this.deps.sessionManager.getSessions()) {
      if (session.statusChangedAt !== null) {
        this.seen.set(session.id, session.statusChangedAt);
      }
    }
    this.listener = (event) => this.handleChange(event);
    this.deps.sessionManager.on("change", this.listener);
  }

  stop(): void {
    if (this.listener) {
      this.deps.sessionManager.off("change", this.listener);
      this.listener = null;
    }
    this.seen.clear();
  }

  private handleChange(event: SessionEvent): void {
    if (event.type === "removed") {
      if (event.sessionId) {
        this.seen.delete(event.sessionId);
        this.deps.tracker.removeSession(event.sessionId);
      }
      return;
    }

    const session = event.session;
    if (!session || isBackgroundSession(session)) return;

    const stamp = session.statusChangedAt;
    if (stamp === null || this.seen.get(session.id) === stamp) return;
    this.seen.set(session.id, stamp);

    const edge = classifyAttentionEdge(session.previousStatus, session.status);
    if (edge === "new-work") {
      // Synchronous on purpose: no await between the status change and the
      // clear, so no client ever sees a new turn still carrying the last
      // one's unread mark.
      this.deps.tracker.clearRead(session.id);
      this.deps.sessionManager.setAttentionState(session.id, null);
    } else if (edge === "finished") {
      void this.resolveFinish(session.id, stamp).catch((error) => {
        console.debug("AttentionTransitions: finish resolve failed", error);
      });
    }
  }

  /**
   * Decide a finished turn against the pane focused as it finished. The
   * tmux lookup is async, and the session can start a new turn (or finish
   * again) before it answers; the stamp check drops a verdict that belongs
   * to a finish the session has already moved past, so a stale lookup can
   * never mark a new turn unread.
   */
  private async resolveFinish(sessionId: string, stamp: string): Promise<void> {
    const activePaneId = await this.deps.getActivePaneId().catch(() => null);

    const session = this.deps.sessionManager.getSession(sessionId);
    if (
      !session ||
      session.status !== "idle" ||
      session.statusChangedAt !== stamp
    ) {
      return;
    }

    const { tracker } = this.deps;
    const state = tracker.isViewingSession(session, activePaneId)
      ? tracker.markSeen(sessionId)
      : "unread";
    this.deps.sessionManager.setAttentionState(sessionId, state);
  }
}
