import type { ProcessInfo, Session, TmuxPane } from "../types/session";
import type { SessionManager } from "./sessions";
import type { LogWatcher } from "./watcher";
import type { SessionPidMarker } from "./session-markers";

/**
 * Shared dependency surface passed to a HookAdapter when the HookManager
 * observes a marker lifecycle event. Adapters are forbidden from reaching
 * into chokidar, preferences, or the server; everything they need goes
 * through this context.
 */
export interface HookManagerContext {
  sessionManager: SessionManager;
  getLogWatcher(agentType: string): LogWatcher | undefined;
  listProcesses(): Promise<ProcessInfo[]>;
  listPanes(): Promise<TmuxPane[]>;

  /**
   * Walks the process ancestry of `pid` and returns the tmux pane whose
   * `panePid` is an ancestor, or null if the PID isn't hosted in any
   * tmux pane. Used by agents like OpenCode whose markers carry only the
   * server PID (no TTY) for pane correlation.
   */
  getPaneHostingPid(pid: number): Promise<TmuxPane | null>;

  /**
   * Notify the daemon that a marker file event happened for `sessionId`,
   * so it can immediately reconcile this session through the cascade
   * evaluator. HookManager fires this for chokidar `add`, `change`, and
   * `unlink` events after the per-agent adapter callback runs.
   *
   * Separated from the adapter callbacks so policy (reconcile via
   * cascade) stays out of the chokidar/dispatch layer. Resolution of
   * `sessionId` to a session record (including OpenCode's aggregator
   * caveat and the defensive duplicate-id behavior) lives in
   * `SessionManager.resolveSessionForMarkerEvent`.
   */
  onMarkerChanged?(sessionId: string): void;
}

/**
 * Per-agent install/uninstall result. `lines` are printed verbatim under
 * the adapter's per-agent header. `changed` is true if the operation
 * actually modified disk state, false for idempotent no-ops or refused
 * operations (e.g., sentinel mismatch). The CLI summary uses the flag to
 * avoid claiming success when every adapter short-circuited.
 */
export interface HookAdapterOutcome {
  lines: string[];
  changed: boolean;
  /**
   * True when the operation was skipped before running (e.g., the agent's
   * executable isn't on PATH), as opposed to an idempotent no-op. Lets the
   * CLI summary count skips separately from "already set up".
   */
  skipped?: boolean;
}

/**
 * Per-agent hook integration (install, uninstall, marker reconciliation).
 * HookManager owns the chokidar/cache/dispatch layer; adapters implement
 * agent-specific setup and marker handling.
 */
export interface HookAdapter {
  /** Matches `agentType` on AgentDef and SessionPidMarker.agent_type. */
  readonly agentType: string;

  /**
   * Write hook scripts, register them in the agent's config, and enable
   * any required feature flags. Idempotent.
   */
  install(): Promise<HookAdapterOutcome>;

  /**
   * Reverse of install. MUST preserve config the user owns independently
   * (e.g., don't flip an agent-level feature flag the user enabled for
   * their own reasons).
   */
  uninstall(): Promise<HookAdapterOutcome>;

  /** Synchronous filesystem read. Used at daemon startup and `--status`. */
  isInstalled(): boolean;

  /**
   * Optional per-agent detail appended to the `ccmux setup --status` line
   * (e.g. `opencode: installed (plugin v1.1.0, matches running ccmux)`).
   * Return null when there's nothing useful to report. Runs only when
   * `isInstalled()` is true; on version skew or other anomalies, prefer
   * `describeInstallAnomalies` for the follow-up advisory line.
   */
  describeInstallDetail?(): string | null;

  /** Optional one-shot warnings at daemon startup for inconsistent install
   * state. May be async when the check shells out (e.g. Cursor's
   * `cursor-agent --version` gate); callers must not block boot on it. */
  describeInstallAnomalies?(): string[] | Promise<string[]>;

  /**
   * Agent-specific "is the session still live?" check used by
   * cleanupStaleMarkers beyond raw PID liveness.
   */
  isSessionStillLive(marker: SessionPidMarker): boolean;

  /**
   * Called when chokidar observes a new marker file. The adapter
   * reconciles the marker with ccmux's session state (create / enrich /
   * noop, depending on the agent's tracking mode).
   */
  onMarkerAdded?(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void>;

  /**
   * Called on chokidar unlink. Claude removes the session (SessionEnd
   * hook -> marker delete). Codex: noop (no SessionEnd).
   */
  onMarkerRemoved?(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void>;

  /**
   * Called on chokidar `change` (tmp+rename rewrite). Default behavior
   * is "no per-agent enrichment needed"; the daemon's
   * `ctx.onMarkerChanged(sessionId)` callback handles the cascade
   * reconcile generically. Adapters override this only when they need
   * per-event side effects (e.g., re-correlating a marker whose payload
   * changed in a way that affects session identity).
   */
  onMarkerChanged?(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void>;
}

/**
 * Find the pane-tracked session for an agent on a specific tmux pane.
 * Pane discovery (TTY vs. PID ancestry) is agent-specific; this helper
 * only factors out the downstream session match.
 */
export function findPaneTrackedSession(
  ctx: HookManagerContext,
  agentType: string,
  paneId: string,
): Session | undefined {
  return ctx.sessionManager
    .getSessions()
    .find(
      (s) =>
        s.agentType === agentType &&
        s.trackingMode === "pane" &&
        s.tmuxPane === paneId,
    );
}
