import { statSync } from "fs";
import { createLogTreeWatcher, type LogTreeWatcher } from "./log-tree-watcher";
import { WATCHER_DEBOUNCE_MS } from "../lib/config";
import { extractEncodedProjectPath, readTranscriptCwd } from "./parser";
import { discoverAgentProcesses } from "./processes";
import { listTmuxPanes, normalizeTty } from "./pane-discovery";
import { findPaneForNewSession, findPaneByMarker } from "./session-pane-match";
import { CLAUDE_AGENT_DEF } from "../lib/agents";
import {
  getSessionTimestampsIn,
  readClaudeHistory,
} from "./adapters/claude/history";
import {
  getSessionPidMarker,
  getMarkerPidSnapshot,
  type SessionPidMarker,
} from "./session-markers";
import {
  decideInitialClaudeBatch,
  decideReplaceHeuristic,
  encodeProjectPath,
  encodingDriftWarning,
  type InitialBatchItem,
  type ReplaceableSessionSlice,
} from "./binder";
import type { SessionManager } from "./sessions";
import type { Session, SessionState } from "../types/session";
import type { LogAdapter, RuntimeMode } from "./log-adapter";

/**
 * Extract SessionState from a Session object
 */
function sessionToState(session: Session): SessionState {
  return {
    status: session.status,
    attentionType: session.attentionType,
    pendingTool: session.pendingTool,
    inPlanMode: session.inPlanMode,
    cwd: session.cwd,
    project: session.project,
    lastActivityAt: session.lastActivityAt ?? undefined,
    lastUserInputAt: session.lastUserInputAt ?? undefined,
    hasActiveSubagent: session.subagents.length > 0,
    version: session.version ?? undefined,
    gitBranch: session.gitBranch ?? undefined,
    lastPrompt: session.lastPrompt ?? undefined,
    prompts: session.prompts,
  };
}

/**
 * Generic agent log watcher. Owns the chokidar lifecycle and offset
 * bookkeeping; delegates parsing and state derivation to a `LogAdapter`.
 *
 * A single `LogWatcher` instance is bound to one adapter. The daemon
 * constructs one instance per registered agent.
 *
 * Claude's hook-backed session creation flow lives here (not in
 * `ClaudeHookAdapter`) by design: it manages watcher-owned FD/offset state
 * (`fileOffsets`, `watchedFiles`, `knownLogPaths`) that doesn't belong on
 * the adapter. The `HookAdapter` seam is the delegation in
 * `handleMarkerAdded`/`handleMarkerRemoved`, which Claude's adapter calls
 * back into.
 */
export class LogWatcher {
  private watcher: LogTreeWatcher | null = null;
  private adapter: LogAdapter;
  private sessionManager: SessionManager;
  private runtimeMode: RuntimeMode = "claude-with-hooks";
  private fileOffsets: Map<string, number> = new Map();
  private debounceTimers: Map<string, Timer> = new Map();
  private isInitialScan = true;
  private initialScanQueue: string[] = [];
  /** Track when files were last processed to prevent race with stale timeout scan */
  private lastProcessedAt: Map<string, number> = new Map();
  /** Actively watched .jsonl file paths (files we have FDs for) */
  private watchedFiles: Set<string> = new Set();
  /** All discovered sessionId → logPath mappings (for re-watch via markers) */
  private knownLogPaths: Map<string, string> = new Map();
  /** Sessions already warned about encoding drift (warn once). */
  private encodingDriftWarned: Set<string> = new Set();
  /** Last unbound-rebind attempt per session (cooldown bookkeeping). */
  private rebindAttemptAt: Map<string, number> = new Map();
  /** Min interval between rebind attempts for an unbound session. */
  private static readonly REBIND_COOLDOWN_MS = 30_000;
  /** Resolver for the ready promise */
  private readyResolve: (() => void) | null = null;
  /** Promise that resolves when initial file processing is complete */
  public readonly ready: Promise<void>;

  constructor(adapter: LogAdapter, sessionManager: SessionManager) {
    this.adapter = adapter;
    this.sessionManager = sessionManager;
    this.ready = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /**
   * Update runtime mode. Currently only affects Claude paths (hook-backed
   * processing gated off in `claude-no-hooks`). The adapter is notified so it
   * can react as well.
   */
  setRuntimeMode(mode: RuntimeMode): void {
    this.runtimeMode = mode;
    this.adapter.setRuntimeMode?.(mode);
  }

  /**
   * Check if a session was recently processed by the watcher.
   * Used to prevent race condition with stale timeout scan.
   */
  isRecentlyProcessed(sessionId: string, thresholdMs = 1000): boolean {
    const lastTime = this.lastProcessedAt.get(sessionId);
    return lastTime !== undefined && Date.now() - lastTime < thresholdMs;
  }

  private rememberDiscoveredLogPath(
    sessionId: string,
    path: string,
    options: { watchFile?: boolean } = {},
  ): void {
    this.knownLogPaths.set(sessionId, path);
    if (options.watchFile !== false) {
      this.watchedFiles.add(path);
    }
  }

  private scheduleProcessFile(path: string, sessionId: string): void {
    const existingTimer = this.debounceTimers.get(path);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(path);
      void this.processFile(path, sessionId);
    }, WATCHER_DEBOUNCE_MS);

    this.debounceTimers.set(path, timer);
  }

  /**
   * Unwatch a .jsonl file to release its FD while keeping directory watches active
   */
  private unwatchFile(path: string): void {
    this.watcher?.unwatch(path);
    this.watchedFiles.delete(path);
    this.fileOffsets.delete(path);
  }

  /**
   * Re-watch a previously unwatched .jsonl file (e.g. resumed session via marker)
   */
  private rewatchFile(path: string): void {
    this.watcher?.add(path);
    this.watchedFiles.add(path);
  }

  /**
   * Reconcile a newly-created marker with this watcher's session state.
   * Called by HookAdapter.onMarkerAdded via ctx.getLogWatcher(...).
   *
   * For Claude: re-arms watching on a known log path so the session's
   * next jsonl write is picked up immediately. No-op for non-Claude
   * adapters and for the Claude no-hooks runtime mode.
   */
  handleMarkerAdded(marker: SessionPidMarker): void {
    if (this.adapter.agentType !== "claude") return;
    if (this.runtimeMode === "claude-no-hooks") return;

    const logPath = this.knownLogPaths.get(marker.session_id);
    if (logPath && !this.watchedFiles.has(logPath)) {
      this.rewatchFile(logPath);
      void this.handleAdd(logPath);
    }
  }

  /**
   * Reconcile a deleted marker with this watcher's session state.
   * Called by HookAdapter.onMarkerRemoved via ctx.getLogWatcher(...).
   */
  handleMarkerRemoved(marker: SessionPidMarker): void {
    if (this.adapter.agentType !== "claude") return;
    if (this.runtimeMode === "claude-no-hooks") return;

    const session = this.sessionManager.getSession(marker.session_id);
    if (!session) return;
    if (session.logPath) this.unwatchFile(session.logPath);
    this.lastProcessedAt.delete(marker.session_id);
    this.adapter.onSessionRemoved?.(marker.session_id);
    this.sessionManager.removeSession(marker.session_id);
  }

  /**
   * Start watching for log file changes.
   *
   * Note: We watch the adapter's log directory directly instead of using
   * glob patterns (chokidar-style globs don't work correctly in Bun, and
   * the native tree watcher has no glob support at all).
   */
  start(): void {
    this.watcher = createLogTreeWatcher(
      this.adapter.logDirGlob,
      this.adapter.watchDepth,
    );

    this.watcher.on("add", (path) => {
      if (!path.endsWith(".jsonl")) return;

      if (this.isInitialScan) {
        this.initialScanQueue.push(path);
      } else {
        void this.handleAdd(path);
      }
    });

    this.watcher.on("ready", () => {
      void this.processInitialBatch();
    });

    this.watcher.on("change", (path) => {
      if (!path.endsWith(".jsonl")) return;
      this.handleChange(path);
    });
    this.watcher.on("unlink", (path) => {
      if (!path.endsWith(".jsonl")) return;
      this.handleUnlink(path);
    });
    this.watcher.on("error", (error) => {
      console.error("Watcher error:", error);
    });

    // Adapter-private lifecycle (e.g. Claude subagent chokidar).
    this.adapter.start?.();
  }

  async stop(): Promise<void> {
    this.isInitialScan = false;
    this.initialScanQueue = [];

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    await this.adapter.stop?.();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.fileOffsets.clear();
    this.lastProcessedAt.clear();
    this.watchedFiles.clear();
    this.knownLogPaths.clear();
  }

  /**
   * Process all files discovered during initial scan with a single batch of
   * subprocess calls. Uses process start time correlation when multiple
   * processes share the same cwd.
   */
  private async processInitialBatch(): Promise<void> {
    const paths = this.initialScanQueue;
    this.initialScanQueue = [];
    this.isInitialScan = false;

    if (paths.length === 0) {
      this.readyResolve?.();
      return;
    }

    if (this.runtimeMode === "claude-no-hooks") {
      this.readyResolve?.();
      return;
    }

    if (this.adapter.agentType === "claude") {
      await this.processInitialHookBackedBatch(paths);
    }

    this.readyResolve?.();
  }

  /**
   * Snapshot the sessions the binder's replace/batch decisions inspect.
   * `hasMarker` carries the replace-guard semantic: marker exists AND has
   * a usable pid.
   */
  private buildReplaceableSlices(): ReplaceableSessionSlice[] {
    return this.sessionManager.getSessions().map((s) => ({
      id: s.id,
      agentType: s.agentType,
      cwd: s.cwd,
      encodedCwd: s.cwd ? encodeProjectPath(s.cwd) : null,
      tmuxPane: s.tmuxPane,
      logPath: s.logPath,
      hasMarker: !!getSessionPidMarker(s.id)?.pid,
    }));
  }

  private async processInitialHookBackedBatch(paths: string[]): Promise<void> {
    const [claudeProcs, panes] = await Promise.all([
      discoverAgentProcesses([CLAUDE_AGENT_DEF]),
      listTmuxPanes(),
    ]);

    // Gather the observation: one item per discovered path (unresolvable
    // ones included — see InitialBatchItem), stat'd once for the sort.
    const items: InitialBatchItem[] = paths.map((path) => {
      const sessionId = this.adapter.resolveSessionIdFromPath(path);
      if (sessionId) {
        // Track all discovered paths for potential re-watch via markers
        this.rememberDiscoveredLogPath(sessionId, path);
      }
      let mtimeMs: number | null = null;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        mtimeMs = null;
      }
      return {
        path,
        sessionId,
        encodedProjectPath: extractEncodedProjectPath(path),
        mtimeMs,
      };
    });

    const historyEntries = readClaudeHistory();
    // Memoized: the binder may consult the same transcript twice (encoded
    // pre-filter miss, then pool entry); one bounded head read per path.
    const transcriptCwdMemo = new Map<string, string | null>();
    const { actions, warnings } = decideInitialClaudeBatch(items, {
      processes: claudeProcs,
      panes,
      sessions: this.buildReplaceableSlices(),
      markerPidBySessionId: getMarkerPidSnapshot(),
      getSessionTimestamps: (sessionId, projectPath) =>
        getSessionTimestampsIn(historyEntries, sessionId, projectPath),
      getTranscriptCwd: (path) => {
        let cwd = transcriptCwdMemo.get(path);
        if (cwd === undefined) {
          cwd = readTranscriptCwd(path);
          transcriptCwdMemo.set(path, cwd);
        }
        return cwd;
      },
    });

    for (const warning of warnings) {
      console.warn(`[binder] ${warning}`);
    }

    for (const action of actions) {
      switch (action.type) {
        case "process-existing":
          this.fileOffsets.set(action.path, 0);
          await this.processFile(action.path, action.sessionId);
          break;
        case "create":
          this.sessionManager.createSession(
            action.sessionId,
            action.path,
            "claude",
          );
          this.sessionManager.setTmuxPane(action.sessionId, action.paneId);
          this.sessionManager.setPid(action.sessionId, action.pid);
          this.fileOffsets.set(action.path, 0);
          await this.processFile(action.path, action.sessionId);
          break;
        case "create-unbound":
          // Visibly unbound: the session is real, but the
          // evidence could not distinguish its pane from a runner-up's.
          // No pane, no pid; a marker or a later unambiguous
          // rebind attaches it.
          this.sessionManager.createSession(
            action.sessionId,
            action.path,
            "claude",
          );
          this.fileOffsets.set(action.path, 0);
          await this.processFile(action.path, action.sessionId);
          break;
        case "replace":
          await this.applyReplace(action);
          break;
      }
    }

    // Unwatch files that didn't become active sessions to reduce FDs
    for (const path of this.watchedFiles) {
      if (!this.fileOffsets.has(path)) {
        this.unwatchFile(path);
      }
    }
  }

  /**
   * Replace a heuristically-matched session with a marker-backed one.
   * The decision (which session, whether at all) is the binder's
   * `decideReplaceHeuristic`; this wrapper feeds it the live session
   * snapshot and applies the outcome. Returns true if replaced.
   */
  private async replaceHeuristicSession(
    encodedProjectPath: string,
    sessionId: string,
    path: string,
    markerPid: number,
  ): Promise<boolean> {
    const decision = decideReplaceHeuristic(
      this.buildReplaceableSlices(),
      encodedProjectPath,
    );
    if (!decision) return false;

    await this.applyReplace({
      removeSessionId: decision.removeSessionId,
      removeLogPath: decision.removeLogPath,
      sessionId,
      path,
      paneId: decision.paneId,
      pid: markerPid,
    });
    return true;
  }

  /** Apply a replace decision: swap the heuristic session for the marker-backed one. */
  private async applyReplace(action: {
    removeSessionId: string;
    removeLogPath: string;
    sessionId: string;
    path: string;
    paneId: string;
    pid: number;
  }): Promise<void> {
    this.adapter.onSessionRemoved?.(action.removeSessionId);
    this.sessionManager.removeSession(action.removeSessionId);
    this.rebindAttemptAt.delete(action.removeSessionId);
    this.encodingDriftWarned.delete(action.removeSessionId);
    this.unwatchFile(action.removeLogPath);

    this.sessionManager.createSession(action.sessionId, action.path, "claude");
    this.sessionManager.setTmuxPane(action.sessionId, action.paneId);
    this.sessionManager.setPid(action.sessionId, action.pid);
    this.fileOffsets.set(action.path, 0);
    await this.processFile(action.path, action.sessionId);
  }

  /**
   * Handle new log file added.
   * - Claude with hooks: full hook-backed session creation flow.
   * - Claude no-hooks:   no-op (pane tracking owns session creation).
   * - Other agents:      dispatch to processFile only when the daemon has
   *                      already linked the rollout file to a pane-tracked
   *                      session via `setNativeSessionId` + `setLogPath`.
   */
  private async handleAdd(path: string): Promise<void> {
    const nativeId = this.adapter.resolveSessionIdFromPath(path);
    if (!nativeId) return;

    if (this.adapter.agentType !== "claude") {
      await this.dispatchByNativeSessionId(nativeId, path);
      return;
    }

    if (this.runtimeMode === "claude-no-hooks") return;

    this.rememberDiscoveredLogPath(nativeId, path);

    await this.handleHookBackedClaudeAdd(nativeId, path);
  }

  /**
   * Look up the ccmux session associated with a log file by `nativeSessionId`
   * and feed the file through `processFile`. Used by non-Claude adapters whose
   * session creation/linking is owned by the daemon, not the watcher.
   */
  private async dispatchByNativeSessionId(
    nativeId: string,
    path: string,
  ): Promise<void> {
    const session = this.sessionManager.getSessionByNativeSessionId(nativeId);
    if (!session) return;
    this.rememberDiscoveredLogPath(session.id, path);
    if (!this.fileOffsets.has(path)) {
      this.fileOffsets.set(path, 0);
    }
    await this.processFile(path, session.id);
  }

  /**
   * Process a specific path now, used by the daemon after linking a
   * pane-tracked session to a newly-discovered rollout file. Resets the
   * offset so the file reads from the start.
   */
  async processPath(path: string): Promise<void> {
    const nativeId = this.adapter.resolveSessionIdFromPath(path);
    if (!nativeId) return;
    this.fileOffsets.delete(path);
    await this.dispatchByNativeSessionId(nativeId, path);
  }

  /**
   * Create or update a session from a new log file.
   * Priority:
   * 1. Marker file (authoritative when hooks are configured)
   * 2. Assignment-gated start-time correlation (binder ladder 2:
   *    direction/tolerance eligibility, ambiguity refusal)
   *
   * An ambiguous correlation creates the session visibly UNBOUND (no pane,
   * no pid) instead of binding a guess; a marker or a later
   * unambiguous rebind attempt (see `handleHookBackedClaudeChange`)
   * attaches it.
   */
  private async handleHookBackedClaudeAdd(
    sessionId: string,
    path: string,
  ): Promise<void> {
    if (this.sessionManager.hasSession(sessionId)) {
      this.fileOffsets.set(path, 0);
      await this.processFile(path, sessionId);
      return;
    }

    const encodedProjectPath = extractEncodedProjectPath(path);
    if (!encodedProjectPath) {
      this.unwatchFile(path);
      return;
    }

    const marker = getSessionPidMarker(sessionId);
    const paneInfo = await findPaneByMarker(sessionId);

    if (paneInfo) {
      this.sessionManager.createSession(sessionId, path, "claude");
      this.sessionManager.setTmuxPane(sessionId, paneInfo.paneId);
      const processPid = await this.findProcessPidForPane(paneInfo.paneId);
      this.sessionManager.setPid(sessionId, marker?.pid ?? processPid ?? null);
      this.fileOffsets.set(path, 0);
      await this.processFile(path, sessionId);
      return;
    }

    const transcriptCwd = readTranscriptCwd(path);
    this.warnOnEncodingDrift(sessionId, transcriptCwd, encodedProjectPath);

    const decision = await findPaneForNewSession(
      this.sessionManager,
      encodedProjectPath,
      sessionId,
      transcriptCwd,
    );

    if (decision.kind === "bound") {
      this.sessionManager.createSession(sessionId, path, "claude");
      this.sessionManager.setTmuxPane(sessionId, decision.pane.paneId);
      this.sessionManager.setPid(sessionId, decision.pid);
      this.fileOffsets.set(path, 0);
      await this.processFile(path, sessionId);
      return;
    }

    if (decision.kind === "ambiguous") {
      this.sessionManager.createSession(sessionId, path, "claude");
      this.fileOffsets.set(path, 0);
      await this.processFile(path, sessionId);
      return;
    }

    // No eligible pane. Only replace an existing heuristic-matched session
    // when the new session has an authoritative marker claim.
    if (marker?.pid) {
      const replaced = await this.replaceHeuristicSession(
        encodedProjectPath,
        sessionId,
        path,
        marker.pid,
      );
      if (replaced) return;
    }
    this.unwatchFile(path);
  }

  /** Encoding-drift canary, warned at most once per session. */
  private warnOnEncodingDrift(
    sessionId: string,
    transcriptCwd: string | null,
    encodedProjectPath: string,
  ): void {
    if (!transcriptCwd || this.encodingDriftWarned.has(sessionId)) return;
    const drift = encodingDriftWarning(transcriptCwd, encodedProjectPath);
    if (drift) {
      this.encodingDriftWarned.add(sessionId);
      console.warn(`[binder] ${sessionId}: ${drift}`);
    }
  }

  /**
   * Re-attempt pane resolution for a session that exists but is unbound
   * (created via the ambiguity arm, or soft-evicted). Runs off transcript
   * activity with a cooldown so a working session retries at most every
   * `REBIND_COOLDOWN_MS`: when the evidence has since become unambiguous
   * (e.g. the competing panes exited, or a marker appeared), the row heals
   * without waiting for a daemon restart.
   */
  private async tryRebindUnboundClaudeSession(
    sessionId: string,
    path: string,
  ): Promise<void> {
    const encodedProjectPath = extractEncodedProjectPath(path);
    if (!encodedProjectPath) return;

    const marker = getSessionPidMarker(sessionId);
    const paneInfo = await findPaneByMarker(sessionId);
    if (paneInfo) {
      this.sessionManager.setTmuxPane(sessionId, paneInfo.paneId);
      const processPid = await this.findProcessPidForPane(paneInfo.paneId);
      this.sessionManager.setPid(sessionId, marker?.pid ?? processPid ?? null);
      return;
    }

    const decision = await findPaneForNewSession(
      this.sessionManager,
      encodedProjectPath,
      sessionId,
      readTranscriptCwd(path),
    );
    if (decision.kind === "bound") {
      this.sessionManager.setTmuxPane(sessionId, decision.pane.paneId);
      this.sessionManager.setPid(sessionId, decision.pid);
    }
  }

  /** Resolves the Claude process (not just any pane process) by matching pane TTY. */
  private async findProcessPidForPane(paneId: string): Promise<number | null> {
    const panes = await listTmuxPanes();
    const pane = panes.find((p) => p.paneId === paneId);
    if (!pane?.tty) return null;

    const claudeProcesses = await discoverAgentProcesses([CLAUDE_AGENT_DEF]);
    const normalizedPaneTty = normalizeTty(pane.tty);
    const process = claudeProcesses.find(
      (p) => normalizeTty(p.tty) === normalizedPaneTty,
    );
    return process?.pid ?? null;
  }

  /**
   * Handle log file changed.
   * - Claude with hooks: hook-backed change handler.
   * - Claude no-hooks:   no-op (pane tracking owns updates).
   * - Other agents:      schedule processFile if the daemon has linked the
   *                      file to a session.
   */
  private handleChange(path: string): void {
    const nativeId = this.adapter.resolveSessionIdFromPath(path);
    if (!nativeId) return;

    if (this.adapter.agentType !== "claude") {
      const session = this.sessionManager.getSessionByNativeSessionId(nativeId);
      if (!session) return;
      this.scheduleProcessFile(path, session.id);
      return;
    }

    if (this.runtimeMode === "claude-no-hooks") return;

    this.handleHookBackedClaudeChange(nativeId, path);
  }

  private handleHookBackedClaudeChange(sessionId: string, path: string): void {
    if (!this.sessionManager.hasSession(sessionId)) {
      void this.handleAdd(path);
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (session && session.tmuxPane === null) {
      const last = this.rebindAttemptAt.get(sessionId) ?? 0;
      const now = Date.now();
      if (now - last >= LogWatcher.REBIND_COOLDOWN_MS) {
        this.rebindAttemptAt.set(sessionId, now);
        void this.tryRebindUnboundClaudeSession(sessionId, path);
      }
    }

    this.scheduleProcessFile(path, sessionId);
  }

  /**
   * Handle log file removed.
   *
   * For non-Claude agents and Claude no-hooks, only the per-file caches are
   * cleared. SessionManager removal is owned by `cleanupStaleSessions` (PID
   * liveness). Hook-backed Claude removes the session here because hooks
   * provide an authoritative session-end signal via the marker file as well.
   */
  private handleUnlink(path: string): void {
    const nativeId = this.adapter.resolveSessionIdFromPath(path);
    if (!nativeId) return;

    this.fileOffsets.delete(path);
    this.watchedFiles.delete(path);

    if (this.adapter.agentType !== "claude") {
      const session = this.sessionManager.getSessionByNativeSessionId(nativeId);
      if (session) {
        this.knownLogPaths.delete(session.id);
        this.lastProcessedAt.delete(session.id);
      }
      return;
    }

    this.knownLogPaths.delete(nativeId);
    this.lastProcessedAt.delete(nativeId);
    this.rebindAttemptAt.delete(nativeId);
    this.encodingDriftWarned.delete(nativeId);
    if (this.runtimeMode === "claude-no-hooks") return;
    this.adapter.onSessionRemoved?.(nativeId);
    this.sessionManager.removeSession(nativeId);
  }

  /**
   * Process a log file and update session state via the adapter.
   */
  private async processFile(path: string, sessionId: string): Promise<void> {
    const offset = this.fileOffsets.get(path) || 0;

    if (offset === 0) {
      const { state, newOffset } = await this.adapter.deriveFullState(path);
      this.sessionManager.updateSession(sessionId, state);
      this.fileOffsets.set(path, newOffset);
      this.adapter.onSessionStateUpdated?.(sessionId, state);
      this.lastProcessedAt.set(sessionId, Date.now());
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    const currentState = sessionToState(session);
    const {
      state: newState,
      newOffset,
      hasNewEntries,
    } = await this.adapter.deriveIncrementalState(path, offset, currentState);

    this.fileOffsets.set(path, newOffset);

    if (newState.status !== session.status || hasNewEntries) {
      this.sessionManager.updateSession(sessionId, newState);
    }

    this.adapter.onSessionStateUpdated?.(sessionId, newState);
    this.lastProcessedAt.set(sessionId, Date.now());
  }
}
