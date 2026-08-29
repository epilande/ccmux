import type { ProcessInfo, TmuxPane } from "../../types/session";

/**
 * How a binding was derived.
 *
 * - `marker`     — hook-written PID marker matched (authoritative).
 * - `log-cwd`    — single process/pane matched the session's project cwd.
 * - `start-time` — timestamp correlation picked among same-cwd candidates.
 * - `ancestry`   — process found via pane PID ancestry (ProcessTree).
 * - `tty`        — process↔pane joined on tty; session joined on cwd + prior state.
 */
export type BindingProvenance =
  | "marker"
  | "log-cwd"
  | "start-time"
  | "ancestry"
  | "tty";

/**
 * Marker-backed bindings are the only ones allowed to be `authoritative`.
 * Heuristic provenances are at most `probable`; `ambiguous` is
 * reserved for Phase 3 (refuse-to-guess), where it implies `paneId: null`.
 */
export type BindingConfidence = "authoritative" | "probable" | "ambiguous";

/**
 * The binder's output unit: derived state, not a stored fact.
 * `paneId: null` means intentionally unbound (north-star invariant).
 */
export interface Binding {
  sessionId: string;
  paneId: string | null;
  pid: number | null;
  provenance: BindingProvenance;
  confidence: BindingConfidence;
  nativeSessionId: string | null;
}

/**
 * Minimal read-only slice of a Session that scan binding decides over.
 * Built by the caller from `SessionManager.getSessions()` (order preserved:
 * the ladder's `.find()` priorities depend on manager iteration order).
 */
export interface SessionSlice {
  id: string;
  agentType: string;
  cwd: string;
  tmuxPane: string | null;
  pid: number | null;
  /** `isBackgroundSession(s)` — background rows are excluded from binding. */
  isBackground: boolean;
}

/**
 * Structural subset of `ProcessTree` the binder uses. Kept structural so
 * fixtures can stub it without constructing a real tree.
 */
export interface ProcessTreeLike {
  findAgentDescendant(panePid: number, agentPids: Set<number>): number | null;
}

/** Observation for per-scan pane↔process↔session binding (ladder 1). */
export interface ScanObservation {
  sessions: readonly SessionSlice[];
  processes: readonly ProcessInfo[];
  panes: readonly TmuxPane[];
  processTree?: ProcessTreeLike;
  /**
   * Marker cache snapshot: session id → marker pid. Key presence means a
   * marker exists; a `null` value means the marker carries no usable pid
   * (matters for the batch sort, which keys on existence). Keyed exactly
   * like `getSessionPidMarker` (native session id), so pane-tracked
   * synthetic ids simply miss, as before.
   */
  markerPidBySessionId: ReadonlyMap<string, number | null>;
}

/** A process paired with the pane whose tty it owns. */
export interface ProcPaneMatch {
  proc: ProcessInfo;
  pane: TmuxPane;
}

/**
 * Decision for a new Claude session's pane (ladder 2), assignment-gated.
 * `ambiguous` means the evidence could not distinguish the best
 * candidate from a runner-up — the caller creates a visibly UNBOUND row
 * (north-star invariant), never a guessed binding. `none` means no
 * eligible candidate at all (no same-cwd process, direction/tolerance
 * failure, or no usable timestamps).
 */
export type NewSessionPaneDecision =
  | {
      kind: "bound";
      pane: TmuxPane;
      pid: number;
      provenance: "start-time";
      confidence: "probable";
    }
  | { kind: "ambiguous" }
  | { kind: "none" };

/** Observation for the ladder-2 decision (new Claude session → pane). */
export interface NewSessionPaneObservation {
  processes: readonly ProcessInfo[];
  panes: readonly TmuxPane[];
  sessionId: string;
  encodedProjectPath: string;
  /** Raw cwd from the session's transcript entries, when known. */
  transcriptCwd: string | null;
  /**
   * All history.jsonl timestamps for (sessionId, projectPath):
   * scanning every entry (not just the first) lets a resumed session
   * correlate to today's run instead of its original prompt. Injected so
   * the binder performs no I/O; the caller memoizes the history read.
   */
  getSessionTimestamps(
    sessionId: string,
    projectPath: string,
  ): readonly number[];
  /**
   * Existing sessions' pane/pid claims. A candidate pane is reserved only
   * when a session's claim is VERIFIED against it (`tmuxPane` matches and
   * `pid` is the pane's live process) — a stale claim, including one from
   * a different cwd, does not block the pane.
   */
  sessions: readonly { tmuxPane: string | null; pid: number | null }[];
}

/**
 * Session slice used by the replace-heuristic decision and the initial
 * Claude batch: adds the fields those ladders inspect.
 */
export interface ReplaceableSessionSlice {
  id: string;
  agentType: string;
  /**
   * Raw cwd as the SessionManager holds it (log-derived, or lossily decoded
   * at creation). Used to simulate `setTmuxPane`'s soft-evict rule, which
   * compares raw cwd equality.
   */
  cwd: string | null;
  /** Pre-encoded project path (`encodeProjectPath(cwd)`), or null if no cwd. */
  encodedCwd: string | null;
  tmuxPane: string | null;
  logPath: string | null;
  /** Marker exists AND carries a usable pid (the replace-guard semantic). */
  hasMarker: boolean;
}

/** Decision output of the replace-heuristic ladder. */
export interface ReplaceHeuristicDecision {
  removeSessionId: string;
  removeLogPath: string;
  paneId: string;
}

/**
 * One log file discovered during the watcher's initial scan. Paths whose
 * session id could not be resolved still participate (they were part of the
 * original sort input; the comparator is not transitive when mtimes are
 * missing, so excluding them up front could reorder real items) and are
 * skipped during the ladder walk, as before.
 */
export interface InitialBatchItem {
  path: string;
  sessionId: string | null;
  /** `extractEncodedProjectPath(path)`, precomputed by the caller. */
  encodedProjectPath: string | null;
  /** File mtime for the recency sort; null when stat failed. */
  mtimeMs: number | null;
}

/** Observation for the initial Claude batch (ladder 3). */
export interface InitialBatchObservation {
  processes: readonly ProcessInfo[];
  panes: readonly TmuxPane[];
  /** Existing sessions, manager order (mutated copies tracked internally). */
  sessions: readonly ReplaceableSessionSlice[];
  markerPidBySessionId: ReadonlyMap<string, number | null>;
  /**
   * All history.jsonl timestamps for (sessionId, projectPath).
   * Injected so the binder performs no I/O; the caller memoizes the read.
   */
  getSessionTimestamps(
    sessionId: string,
    projectPath: string,
  ): readonly number[];
  /**
   * Raw cwd from a transcript's early entries, or null when the transcript
   * has none yet (the authoritative match key; the encoded path is
   * only a grouping pre-filter). Injected; only consulted for items that
   * reach the heuristic assignment, so the extra read is bounded.
   */
  getTranscriptCwd(path: string): string | null;
}

/**
 * Ordered actions the watcher applies after the batch decision: one applied
 * outcome of the initial Claude batch.
 *
 * The creating arms carry `cwd`: the session's REAL working directory, from
 * the transcript's own `cwd` field or the bound pane's process cwd. Null only
 * when neither was available, and then the applier falls back to decoding the
 * project dir name — a guess that cannot tell a `-` in a directory name from
 * the `/` it encodes (issue #156).
 */
export type InitialBatchAction =
  | { type: "process-existing"; sessionId: string; path: string }
  | {
      type: "create";
      sessionId: string;
      path: string;
      paneId: string;
      pid: number;
      provenance: BindingProvenance;
      confidence: BindingConfidence;
      /** The session's real cwd, when known; see the type's doc comment. */
      cwd: string | null;
    }
  | {
      /**
       * Create the session VISIBLY UNBOUND (no pane, no pid): the evidence
       * ties it to the same-cwd group but cannot distinguish which pane is
       * its own. Self-corrects when a marker appears.
       */
      type: "create-unbound";
      sessionId: string;
      path: string;
      /** The session's real cwd, when known; see the type's doc comment. */
      cwd: string | null;
    }
  | {
      type: "replace";
      removeSessionId: string;
      removeLogPath: string;
      sessionId: string;
      path: string;
      paneId: string;
      pid: number;
      /** The session's real cwd, when known; see the type's doc comment. */
      cwd: string | null;
    }
  | { type: "skip"; path: string };

/** Batch decision output: ordered actions plus caller-loggable warnings. */
export interface InitialBatchDecision {
  actions: InitialBatchAction[];
  warnings: string[];
}

/** Observation for boot-time migration (ladder 4). */
export interface MigrationObservation {
  processes: readonly ProcessInfo[];
  panes: readonly TmuxPane[];
  /** All marker files (pid → session identity), boot snapshot. */
  markers: readonly { session_id: string; pid: number }[];
  /** Parsed history.jsonl entries (raw project paths). */
  historyEntries: readonly {
    project: string;
    sessionId: string;
    timestamp: number;
  }[];
  existingSessionIds: ReadonlySet<string>;
  /**
   * Read-only snapshot query: does the Claude log file for (cwd, sessionId)
   * exist on disk? Injected so the binder performs no I/O itself.
   */
  logPathExists(cwd: string, sessionId: string): boolean;
}

/** One boot-migration binding: create session from logPath, bind pane+pid. */
export interface MigrationBinding {
  sessionId: string;
  cwd: string;
  paneId: string;
  pid: number;
  provenance: BindingProvenance;
  confidence: BindingConfidence;
}

/** Marker slice used by the marker-link re-derivation (ladder 5b). */
export interface MarkerSlice {
  session_id: string;
  pid: number;
  /** Marker creation time (epoch seconds). */
  timestamp?: number;
  /** Last per-turn state refresh (epoch seconds); fresher than `timestamp`. */
  state_timestamp?: number;
}

/** Session slice used by the marker-link re-derivation (ladder 5b). */
export interface MarkerLinkSessionSlice {
  sessionId: string;
  tmuxPane: string | null;
  /** Current claim, re-verified against the pane's own markers each scan. */
  nativeSessionId: string | null;
}
