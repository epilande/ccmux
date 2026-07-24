import type { EnrichedSession } from "./session";
import type { InvokeErrorKind, FinishedInvocationStatus } from "./invocation";

/**
 * SSE event types
 */
export type SSEEventType =
  | "init"
  | "session_created"
  | "session_updated"
  | "session_removed"
  | "active_pane"
  | "sidebar_state"
  | "invocation_started"
  | "invocation_finished"
  | "daemon_health"
  | "heartbeat";

/**
 * Daemon scan-health snapshot carried on the wire. `degraded` flips true once
 * scans have failed `SCAN_DEGRADED_THRESHOLD` times in a row; `reason` +
 * `since` describe the streak so a client can render why and when.
 * Defined here (not in daemon code) to keep this wire type a leaf the daemon
 * imports, never the reverse.
 */
export type DaemonHealth =
  | { degraded: false }
  | { degraded: true; reason: string; since: string };

/**
 * Minimal projection of a daemon `InvocationRecord` carried in the `init`
 * event so the board can reconcile its invoke state synchronously on every
 * (re)connect (`store.reconcileInvocations`). Embedded in `init` rather than
 * fetched separately so reconciliation is atomic with session hydration:
 * SSE events are processed in order, so any `invocation_started` broadcast
 * after the snapshot is applied strictly after reconcile, with no window in
 * which a just-started worker's row could be pruned as "unknown".
 */
export interface InvocationSnapshotEntry {
  invocationId: string;
  status: "running" | FinishedInvocationStatus;
}

/**
 * Base SSE event structure
 */
export interface BaseSSEEvent {
  type: SSEEventType;
  timestamp: string;
}

/**
 * Init event - sent on connection with all current sessions plus a snapshot
 * of active + recently-finished invocations for reconnect reconciliation.
 */
export interface InitEvent extends BaseSSEEvent {
  type: "init";
  sessions: EnrichedSession[];
  activePaneId: string | null;
  invocations: InvocationSnapshotEntry[];
  /**
   * Scan-health at connect time so a client joining mid-degradation renders the
   * warning immediately, without waiting for the next `daemon_health` event.
   */
  health: DaemonHealth;
}

/**
 * Session created event
 */
export interface SessionCreatedEvent extends BaseSSEEvent {
  type: "session_created";
  session: EnrichedSession;
}

/**
 * Session updated event
 */
export interface SessionUpdatedEvent extends BaseSSEEvent {
  type: "session_updated";
  session: EnrichedSession;
}

/**
 * Session removed event
 */
export interface SessionRemovedEvent extends BaseSSEEvent {
  type: "session_removed";
  sessionId: string;
}

/**
 * Active pane event - broadcast when the focused tmux pane changes
 */
export interface ActivePaneEvent extends BaseSSEEvent {
  type: "active_pane";
  sessionId: string | null;
  paneId: string;
}

/**
 * Sidebar state event - syncs selection across sidebar instances
 */
export interface SidebarStateEvent extends BaseSSEEvent {
  type: "sidebar_state";
  selectedSessionId: string | null;
  /** Group header key when a header row is selected */
  selectedHeaderKey?: string | null;
  /** Monotonic version counter for stale echo detection */
  version?: number;
}

/**
 * Invocation started event - a `ccmux invoke` worker began executing.
 *
 * Flat top-level fields (like every other SSE event; a nested `data` key
 * would collide with the SSE frame's own `data:` line). Carries no
 * `sessionId`/`paneId`: those are unknowable at admission (a fresh Claude
 * invoke has no detached session yet), and the Claude linkage arrives via
 * the enrich-time name-match on `session_created`. The board synthesizes a
 * paneless row from this event for subprocess invokes; Claude invokes are
 * skipped here (they render as their real detached session).
 */
export interface InvocationStartedEvent extends BaseSSEEvent {
  type: "invocation_started";
  invocationId: string;
  /** Agent NAME (e.g. "claude", "codex"). */
  agent: string;
  cwd: string;
  /** ISO timestamp of admission; the source for the live board age. */
  startedAt: string;
}

/**
 * Invocation finished event - a worker reached a terminal state.
 */
export interface InvocationFinishedEvent extends BaseSSEEvent {
  type: "invocation_finished";
  invocationId: string;
  /** Agent NAME (e.g. "claude", "codex"). */
  agent: string;
  status: FinishedInvocationStatus;
  durationMs?: number;
  /** Failure kind, set for `failed` records. */
  kind?: InvokeErrorKind;
}

/**
 * Daemon health event - broadcast on each degraded/recovered transition so
 * connected clients flip their banner without polling.
 */
export interface DaemonHealthEvent extends BaseSSEEvent {
  type: "daemon_health";
  health: DaemonHealth;
}

/**
 * Heartbeat event
 */
export interface HeartbeatEvent extends BaseSSEEvent {
  type: "heartbeat";
}

/**
 * Union of all SSE events
 */
export type SSEEvent =
  | InitEvent
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionRemovedEvent
  | ActivePaneEvent
  | SidebarStateEvent
  | InvocationStartedEvent
  | InvocationFinishedEvent
  | DaemonHealthEvent
  | HeartbeatEvent;
