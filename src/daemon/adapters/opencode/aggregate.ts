import type { SessionState } from "../../../types/session";
import type { SessionPidMarker } from "../../session-markers";

/** The marker states that mean "blocked on the user" in the fold below. */
const WAITING_STATES: ReadonlySet<SessionPidMarker["state"]> = new Set([
  "waiting_permission",
  "waiting_question",
]);

/**
 * Fold N OpenCode markers (all sharing one server PID) into the single
 * ccmux Session that represents the hosting tmux pane. Status priority
 * is waiting > working > idle; attention/cwd/nativeSessionId are pulled
 * from the newest waiting or newest-activity marker so the sidebar
 * reflects the most recent user-relevant event.
 *
 * Two marker states count as waiting: `waiting_permission` (tool approval)
 * and `waiting_question` (the question-tool picker, issue #137). The
 * attention type follows whichever the NEWEST waiting marker carries, so a
 * question and a permission blocking sibling sessions at once surface the
 * most recent one — and set `ambiguousWait`, same as two permissions would.
 *
 * `ambiguousWait` is emitted on every fold: true when MORE THAN ONE marker
 * is waiting at once, so the notifier suppresses Approve/Deny buttons (a
 * single keystroke lands on whichever dialog the shared pane renders,
 * which may not be the one the notification described). See
 * `Session.ambiguousWait`.
 */
export function aggregateOpenCodeMarkers(
  markers: readonly SessionPidMarker[],
): Partial<SessionState> & { nativeSessionId?: string } {
  if (markers.length === 0) {
    return {
      status: "idle",
      attentionType: null,
      pendingTool: null,
      ambiguousWait: false,
    };
  }

  const waitingCount = markers.filter((m) =>
    WAITING_STATES.has(m.state),
  ).length;
  const hasWaiting = waitingCount > 0;
  const hasWorking = markers.some((m) => m.state === "working");
  const status = hasWaiting ? "waiting" : hasWorking ? "working" : "idle";

  const activityMs = (m: SessionPidMarker): number => {
    const seconds = m.state_timestamp ?? m.timestamp;
    return seconds * 1000;
  };

  const byActivityDesc = [...markers].sort(
    (a, b) => activityMs(b) - activityMs(a),
  );
  const newest = byActivityDesc[0];
  const newestWaiting = byActivityDesc.find((m) => WAITING_STATES.has(m.state));

  const aggregate: Partial<SessionState> & { nativeSessionId?: string } = {
    status,
    attentionType: newestWaiting
      ? newestWaiting.state === "waiting_question"
        ? "question"
        : "permission"
      : null,
    pendingTool: newestWaiting?.pending_tool ?? null,
    ambiguousWait: waitingCount > 1,
    lastActivityAt: new Date(activityMs(newest)).toISOString(),
    nativeSessionId: newest.session_id,
  };

  if (newest.directory) aggregate.cwd = newest.directory;
  // Always emit, with `null` when newest has no prompt yet, so a fresh
  // session in a multi-session server clears any stale prompt left over
  // from a previously-newest sibling. SessionManager.updateSession's
  // `state.lastPrompt !== undefined` guard treats `null` as "clear" and
  // `undefined` as "leave alone"; emitting unconditionally is what makes
  // the sticky-prompt path go away.
  aggregate.lastPrompt = newest.last_prompt ?? null;

  return aggregate;
}
