import type { Session, SessionState } from "../types/session";

/**
 * Claude-specific runtime mode. Currently the only agent with a runtime-mode
 * concept; the type lives here because `LogAdapter.setRuntimeMode` takes it.
 * Widen or generalize when a second mode-aware agent lands.
 */
export type RuntimeMode = "claude-with-hooks" | "claude-no-hooks";

/**
 * Session-level metadata extracted from an agent's log file header.
 *
 * Codex writes a `session_meta` line as the first entry of every rollout
 * file; Claude has no equivalent (its session ID lives in the filename).
 * Used by startup discovery to correlate log files to live processes by
 * cwd + timestamp.
 */
export interface SessionMetadata {
  nativeSessionId: string;
  cwd: string;
  /** ms epoch */
  timestamp: number;
  version?: string;
  gitBranch?: string;
}

/**
 * Incremental derivation result.
 *
 * `hasNewEntries` distinguishes "no file growth" from "file grew but no
 * semantic change" — LogWatcher uses this to decide whether to push a
 * sessionManager.updateSession() event.
 */
export interface IncrementalDerivation {
  state: SessionState;
  newOffset: number;
  hasNewEntries: boolean;
}

export interface FullDerivation {
  state: SessionState;
  /** Byte offset after the first full read; seeds subsequent incremental reads. */
  newOffset: number;
  /**
   * Set when the read itself failed, so `state` is a placeholder rather than
   * a derivation. `LogWatcher` must then leave the session and the offset
   * untouched: writing the placeholder would clobber live state, and
   * recording offset 0 for a non-empty file re-arms a full derive on every
   * subsequent pass. Adapters that cannot distinguish a read failure from an
   * empty log leave it unset.
   */
  failed?: true;
}

/**
 * Agent-specific log pipeline.
 *
 * One adapter instance per agent. The adapter owns its private entry
 * types, file-reading strategy, and state derivation. The generic
 * `LogWatcher` is responsible for chokidar lifecycle, offset bookkeeping,
 * and dispatching read events to the adapter.
 *
 * Optional methods:
 * - `start` / `stop`: adapter-private lifecycle (e.g. Claude's subagent
 *   chokidar). No-op for adapters that manage no extra resources.
 * - `onSessionStateUpdated`: post-update reaction hook. Claude uses this
 *   to toggle subagent directory watching based on `hasActiveSubagent`.
 * - `setRuntimeMode`: Claude-only today; tells the adapter whether hooks
 *   are installed (`claude-with-hooks` vs `claude-no-hooks`).
 */
export interface LogAdapter {
  readonly agentType: string;

  /**
   * Directory this adapter's main watcher should observe.
   *
   * Chokidar globs are unreliable under Bun (per `LogWatcher` comments), so
   * adapters expose a plain directory path and pair it with `watchDepth`.
   * Claude: the Claude projects directory.
   * Codex:  `~/.codex/sessions` (rollouts live at `YYYY/MM/DD/rollout-*.jsonl`).
   */
  readonly logDirGlob: string;

  /**
   * Chokidar `depth` value for the main watcher. `undefined` means no limit;
   * a number caps how many subdirectory levels are traversed. Adapters whose
   * logs sit immediately under `logDirGlob` use `1`; nested layouts (Codex
   * uses `YYYY/MM/DD/file`) bump it accordingly. The watcher passes this
   * through verbatim.
   */
  readonly watchDepth?: number;

  /**
   * Whether `LogWatcher` must stat-poll this adapter's log files instead of
   * relying on filesystem change events alone.
   *
   * Exists because Codex holds its rollout file descriptor OPEN for the life
   * of the session, and macOS emits no `fs.watch` change event for appends
   * made through an already-open fd (verified under both Bun and Node for the
   * recursive tree watch). Without polling the incremental feed never fires
   * and the rollout is parsed exactly once, at link time. Agents that
   * open/write/close per append (Claude) are seen by the watcher normally and
   * leave this unset.
   */
  readonly pollsLog?: boolean;

  /**
   * Extract the agent's native session ID from a log file path.
   * Returns null when the ID is not encoded in the filename (in which
   * case the adapter must rely on `parseSessionMetadata` instead).
   */
  resolveSessionIdFromPath(path: string): string | null;

  /**
   * Parse the first line of a log file into session-level metadata.
   * Returns null when the agent has no session_meta line (e.g. Claude).
   */
  parseSessionMetadata(firstLine: string): SessionMetadata | null;

  /**
   * Read the file from the start and produce a fresh session state.
   * Called by `LogWatcher` when it sees a file with no tracked offset.
   * Returns the new byte offset so subsequent reads can be incremental.
   */
  deriveFullState(path: string): Promise<FullDerivation>;

  /**
   * Read new entries from a known byte offset and apply them to the
   * previous state. Returns the updated state, the new offset, and a
   * flag indicating whether any new entries were applied.
   */
  deriveIncrementalState(
    path: string,
    offset: number,
    prev: SessionState,
  ): Promise<IncrementalDerivation>;

  /**
   * Adapter-private lifecycle hook, called once after `LogWatcher.start`.
   */
  start?(): void;

  /**
   * Adapter-private lifecycle hook, called during `LogWatcher.stop`.
   * Adapters must release any resources (FSWatchers, caches, etc.).
   */
  stop?(): Promise<void>;

  /**
   * Called by `LogWatcher` after every session state update. Adapters
   * may trigger agent-specific side effects (e.g. Claude's subagent dir
   * watching).
   */
  onSessionStateUpdated?(sessionId: string, state: SessionState): void;

  /**
   * Called by `LogWatcher` when a session is removed (marker deleted, log
   * unlinked, etc.). Adapters must release any per-session resources
   * (subagent watchers, cached offsets) for this session.
   */
  onSessionRemoved?(sessionId: string): void;

  /**
   * Called by the reconciler once per scan tick for each of this adapter's
   * sessions. Exists because `onSessionStateUpdated` only fires on parent
   * log parses, and those stop the moment the parent ends its turn — while
   * background teammates keep writing their own transcripts. Claude uses
   * this to (re-)evaluate subagent-dir watching when no parent parse will
   * ever come. Must be cheap: it runs every SCAN_INTERVAL_MS.
   */
  onReconcileTick?(session: Readonly<Session>): void;

  /**
   * Optional runtime-mode setter. Claude uses this to switch between
   * `claude-with-hooks` and `claude-no-hooks` behavior.
   */
  setRuntimeMode?(mode: RuntimeMode): void;
}
