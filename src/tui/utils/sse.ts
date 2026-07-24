import { getDaemonUrl } from "../../lib/config";
import type {
  SSEEvent,
  EnrichedSession,
  InvocationStartedEvent,
  InvocationFinishedEvent,
  InvocationSnapshotEntry,
  DaemonHealth,
} from "../../types";

/**
 * Connection state for the SSE client
 */
export type ConnectionState = "connected" | "reconnecting" | "disconnected";

/**
 * SSE client callbacks
 */
export interface SSECallbacks {
  onInit: (
    sessions: EnrichedSession[],
    activePaneId: string | null,
    // Optional: production always supplies it (the daemon embeds the snapshot
    // in `init`, see handleEvent's `?? []`); a snapshot-less connect (an older
    // daemon, or a test simulating the client) simply skips reconciliation.
    invocations?: InvocationSnapshotEntry[],
  ) => void;
  onSessionCreated: (session: EnrichedSession) => void;
  onSessionUpdated: (session: EnrichedSession) => void;
  onSessionRemoved: (sessionId: string) => void;
  onActivePane?: (sessionId: string | null, paneId: string) => void;
  onSidebarState?: (
    selectedSessionId: string | null,
    selectedHeaderKey: string | null,
    version: number | undefined,
  ) => void;
  onInvocationStarted?: (event: InvocationStartedEvent) => void;
  onInvocationFinished?: (event: InvocationFinishedEvent) => void;
  /** Daemon scan-health, from the `daemon_health` event and the `init` frame
   *  (older daemons omit `init.health`, so init only calls this when present). */
  onDaemonHealth?: (health: DaemonHealth) => void;
  onConnectionStateChange: (state: ConnectionState) => void;
  onError: (error: string) => void;
}

/**
 * Route a non-heartbeat SSE event to its matching callback. Extracted from
 * the client's read loop so the dispatch (notably `init`'s `invocations`
 * threading, whose `onInit` arg is optional and otherwise silently
 * regressible) is unit-testable without driving a socket. Heartbeats stay in
 * the client as transport state.
 */
export function dispatchSSEEvent(
  event: SSEEvent,
  callbacks: SSECallbacks,
): void {
  switch (event.type) {
    case "init":
      // `?? []` guards a client briefly newer than a not-yet-restarted
      // daemon that still sends `init` without the invocations snapshot.
      callbacks.onInit(
        event.sessions,
        event.activePaneId,
        event.invocations ?? [],
      );
      // Older daemons don't send `health` on init; apply it only when present
      // so a connect against one leaves the default healthy state intact.
      if (event.health) callbacks.onDaemonHealth?.(event.health);
      break;
    case "session_created":
      callbacks.onSessionCreated(event.session);
      break;
    case "session_updated":
      callbacks.onSessionUpdated(event.session);
      break;
    case "session_removed":
      callbacks.onSessionRemoved(event.sessionId);
      break;
    case "active_pane":
      callbacks.onActivePane?.(event.sessionId, event.paneId);
      break;
    case "sidebar_state":
      callbacks.onSidebarState?.(
        event.selectedSessionId,
        event.selectedHeaderKey ?? null,
        event.version,
      );
      break;
    case "invocation_started":
      callbacks.onInvocationStarted?.(event);
      break;
    case "invocation_finished":
      callbacks.onInvocationFinished?.(event);
      break;
    case "daemon_health":
      callbacks.onDaemonHealth?.(event.health);
      break;
  }
}

/**
 * SSE Client for connecting to daemon
 */
export class SSEClient {
  private controller: AbortController | null = null;
  private callbacks: SSECallbacks;
  private reconnectTimeout: Timer | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;

  // Grace period handling - hide brief disconnections
  private graceTimeout: Timer | null = null;
  private readonly GRACE_PERIOD_MS = 2000;

  // Pending error to display after grace period expires
  private pendingError: string | null = null;

  // Heartbeat timeout detection
  private lastHeartbeat: number = 0;
  private heartbeatCheckInterval: Timer | null = null;
  private readonly HEARTBEAT_TIMEOUT_MS = 30000; // 2x server's 15s interval

  constructor(callbacks: SSECallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Connect to SSE endpoint
   */
  async connect(): Promise<void> {
    this.disconnect();

    this.controller = new AbortController();
    const url = `${getDaemonUrl()}/events`;

    try {
      const response = await fetch(url, {
        signal: this.controller.signal,
        headers: {
          Accept: "text/event-stream",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      // Successfully connected - clear any grace timeout and notify
      this.clearGraceTimeout();
      this.callbacks.onConnectionStateChange("connected");
      this.reconnectDelay = 1000;

      // Start heartbeat monitoring
      this.lastHeartbeat = Date.now();
      this.startHeartbeatCheck();

      // Process the stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete events
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const eventData of lines) {
          if (eventData.startsWith("data: ")) {
            const json = eventData.slice(6);
            try {
              const event = JSON.parse(json) as SSEEvent;
              this.handleEvent(event);
            } catch {
              // Invalid JSON, skip
            }
          }
        }
      }

      this.stopHeartbeatCheck();
      this.handleDisconnect();
      this.scheduleReconnect();
    } catch (error) {
      this.stopHeartbeatCheck();

      if (error instanceof Error && error.name === "AbortError") {
        // Intentional disconnect
        return;
      }

      this.handleDisconnect(
        error instanceof Error ? error.message : "Unknown error",
      );
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from SSE
   */
  disconnect(): void {
    this.stopHeartbeatCheck();
    this.clearGraceTimeout();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  /**
   * Handle disconnection with grace period
   * @param error Optional error message to display after grace period
   */
  private handleDisconnect(error?: string): void {
    if (error) {
      this.pendingError = error;
    }

    if (!this.graceTimeout) {
      this.graceTimeout = setTimeout(() => {
        this.graceTimeout = null;
        this.callbacks.onConnectionStateChange("reconnecting");
        if (this.pendingError) {
          this.callbacks.onError(this.pendingError);
          this.pendingError = null;
        }
      }, this.GRACE_PERIOD_MS);
    }
  }

  /**
   * Clear grace timeout and pending error
   */
  private clearGraceTimeout(): void {
    if (this.graceTimeout) {
      clearTimeout(this.graceTimeout);
      this.graceTimeout = null;
    }
    this.pendingError = null;
  }

  /**
   * Start heartbeat check interval
   */
  private startHeartbeatCheck(): void {
    this.stopHeartbeatCheck();

    this.heartbeatCheckInterval = setInterval(() => {
      const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeat;
      if (timeSinceLastHeartbeat > this.HEARTBEAT_TIMEOUT_MS) {
        this.reconnect("Heartbeat timeout");
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Stop heartbeat check interval
   */
  private stopHeartbeatCheck(): void {
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
      this.heartbeatCheckInterval = null;
    }
  }

  /**
   * Force reconnection
   * @param error Optional error message to display after grace period
   */
  private reconnect(error?: string): void {
    this.disconnect();
    this.handleDisconnect(error);
    this.scheduleReconnect();
  }

  /**
   * Handle incoming SSE event
   */
  private handleEvent(event: SSEEvent): void {
    // Heartbeats are transport state (drives the timeout check); every other
    // event routes to a callback via the pure, unit-tested dispatcher.
    if (event.type === "heartbeat") {
      this.lastHeartbeat = Date.now();
      return;
    }
    dispatchSSEEvent(event, this.callbacks);
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      this.maxReconnectDelay,
    );
  }
}
