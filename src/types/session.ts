import type { InvocationStatus } from "./invocation";

/**
 * Session status types
 */
export type SessionStatus = "working" | "waiting" | "idle";

/**
 * How ccmux identifies and tracks a live session.
 * - `native`: tracked by native agent session id (Claude/Codex via hooks).
 * - `pane`: tracked by tmux pane identity (process + terminal scanning).
 * - `background`: a Claude Code background/background agent (dispatched via
 *   `claude --bg` / the agent view). Paneless: it has a PID, cwd, and a JSONL
 *   transcript but no tmux pane. Sourced entirely from Claude's own
 *   `roster.json` / `state.json`, not from any ccmux hook or pane scan.
 */
export type SessionTrackingMode = "native" | "pane" | "background";

/**
 * A linked artifact a background agent produced, from `state.json`
 * `children[]`. `kind: "pr"` is the only value observed so far; kept open.
 */
export interface BackgroundChild {
  id: string;
  href: string;
  kind: string;
}

/**
 * An open PR for the branch a session's cwd is sitting on, resolved via
 * `gh pr list --head` by the daemon's PRResolver. Agent-agnostic, unlike
 * `backgroundChildren`, which is Claude's authoritative "PRs this
 * background agent created".
 */
export interface BranchPR {
  id: string;
  href: string;
  /**
   * PR review verdict (`gh pr list --json reviewDecision`). Note it is
   * `null` on branches without REQUIRED reviews even when approvals exist,
   * so it is NOT a reliable "approved" signal on unprotected repos. Absent
   * (not just null) on background-agent PRs, which carry no state.
   */
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  /**
   * CI rollup (`gh pr list --json statusCheckRollup`) folded daemon-side to
   * one signal, matching gh's PR-status rollup verdict (what `gh pr view` /
   * `gh pr status` show; see `foldChecks`). `"none"` = no checks are
   * configured (deliberately NOT the same as `"passing"`). Absent on
   * background-agent PRs.
   */
  ciStatus?: "passing" | "failing" | "pending" | "none" | null;
}

/**
 * A background agent's in-flight progress snapshot, from `state.json`
 * `inFlight`. Every field optional: the schema is undocumented (research
 * preview), so we surface what we find.
 */
export interface BackgroundInFlight {
  tasks?: number;
  queued?: number;
  kinds?: string[];
}

/**
 * Attention type - what kind of user attention is needed
 */
export type AttentionType = "permission" | "question" | "plan_approval" | null;

/**
 * Inbox-style attention state, orthogonal to session status.
 * Tracks whether the user has seen session results.
 * - null: nothing new (normal state)
 * - "unread": session finished while user was away, result not yet seen
 * - "read": user just acknowledged the result (brief visual confirmation, then clears)
 */
export type AttentionState = "unread" | "read" | null;

/**
 * Subagent state for tracking Task tool spawned agents
 */
export interface SubagentState {
  /** Subagent ID (extracted from log filename) */
  agentId: string;
  /** Current subagent status */
  status: SessionStatus;
  /** Type of attention needed (if waiting) */
  attentionType: AttentionType;
  /** Name of pending tool awaiting approval */
  pendingTool: string | null;
  /** Last activity timestamp */
  lastActivityAt: string | null;
  /**
   * Spawn timestamp (first entry in the subagent's transcript). Null when
   * the head read failed, in which case the preview renders no duration.
   */
  startedAt: string | null;
}

/**
 * Session interface representing an agent session
 */
export interface Session {
  /** Unique tracked session ID (native or pane-scoped, depending on runtime mode) */
  id: string;
  /** Agent runtime type (claude/codex/gemini/custom) */
  agentType: string;
  /** How this session is tracked (see {@link SessionTrackingMode}) */
  trackingMode: SessionTrackingMode;
  /** Native agent session ID used by resume commands when available */
  nativeSessionId?: string;
  /** Project name derived from cwd */
  project: string;
  /** Working directory of the session */
  cwd: string;
  /** Path to the session log file */
  logPath: string | null;
  /** Current session status */
  status: SessionStatus;
  /** Type of attention needed (if waiting) */
  attentionType: AttentionType;
  /** Name of pending tool awaiting approval */
  pendingTool: string | null;
  /** Whether session is in plan mode */
  inPlanMode: boolean;
  /** tmux pane ID (e.g., "%0") - immutable identifier */
  tmuxPane: string | null;
  /** Last update timestamp */
  updatedAt: Date;
  /** Last activity timestamp from log entries (for stale detection) */
  lastActivityAt: string | null;
  /** Last user input timestamp (for stable sorting) */
  lastUserInputAt: string | null;
  /** Active subagents spawned by Task tool */
  subagents: SubagentState[];
  /** Git branch for the session's cwd */
  gitBranch: string | null;
  /** Agent version */
  version: string | null;
  /** PID of the agent process (null if no process is running) */
  pid: number | null;
  /** ISO timestamp of last status transition */
  statusChangedAt: string | null;
  /**
   * Monotonic per-session counter, bumped whenever the attention identity
   * (`attentionType` or `pendingTool`) changes. Complements `statusChangedAt`:
   * a waiting->waiting swap (one wait resolves, a new same-type wait begins)
   * keeps `status` unchanged, so `statusChangedAt` can't catch it, but the
   * generation still advances. A notification-action press echoes the
   * generation it fired for and must match the session's current value, so a
   * press against a superseded wait is rejected instead of answered blind.
   */
  attentionGeneration: number;
  /** Status before the last transition */
  previousStatus: SessionStatus | null;
  /** Inbox-style attention state (null/unread/read), orthogonal to status */
  attentionState: AttentionState;
  /** ISO timestamp of when the user last viewed this session */
  lastSeenAt: string | null;
  /** Last user prompt text */
  lastPrompt: string | null;
  /**
   * Recent user prompts, oldest to newest, capped in count and total bytes
   * (see MAX_SESSION_PROMPTS / MAX_PROMPTS_TOTAL_BYTES). Always present
   * (defaults to `[]`); the newest entry mirrors `lastPrompt`. Powers
   * whole-session search over every prompt, not just the last.
   */
  prompts: string[];
  /**
   * Background-only: the Haiku-class one-line `detail` (falls back to
   * `name`) from `state.json`. Rendered as the row subtitle / peek heading.
   * Distinct from `lastPrompt`, which holds the raw `intent`.
   */
  backgroundDetail?: string;
  /**
   * Background-only: the longer `output.result` text from `state.json`
   * (present once a turn completes). Rendered in the peek panel.
   */
  backgroundResult?: string;
  /**
   * Background-only: linked artifacts (e.g. PRs) from `state.json`
   * `children[]`. Drives the PR column and the peek's PR links.
   */
  backgroundChildren?: BackgroundChild[];
  /**
   * Background-only: live progress (`state.json` `inFlight`) while the
   * agent is working. Rendered as the peek's progress line. An empty
   * object means "none" (mirrors `backgroundChildren`'s `[]`).
   */
  backgroundInFlight?: BackgroundInFlight;
  /**
   * True when this row's `waiting[permission]` folds MORE THAN ONE
   * concurrently-waiting server-side session into a single ccmux Session
   * (only OpenCode aggregates this way today; see `aggregateOpenCodeMarkers`).
   * A notification-action keystroke lands on whichever dialog the pane
   * currently renders, which may belong to a different server-side session
   * than the notification described, and the staleness tokens can't catch it
   * (same ccmux session, same edge). The notifier suppresses Approve/Deny/Reply
   * while this is true so a press can never approve the wrong session's tool.
   * Undefined/absent for every non-aggregating agent (treated as "not
   * ambiguous").
   */
  ambiguousWait?: boolean;
}

/**
 * Internal session state used by status machine
 */
export interface SessionState {
  status: SessionStatus;
  attentionType: AttentionType;
  pendingTool: string | null;
  inPlanMode: boolean;
  cwd?: string;
  project?: string;
  /** Last activity timestamp from log entries (for stale detection) */
  lastActivityAt?: string;
  /** Last user input timestamp (for stable sorting) */
  lastUserInputAt?: string;
  /** Whether a Task tool (subagent) is currently running */
  hasActiveSubagent?: boolean;
  /** Tool use IDs waiting for permission (for parallel tool call tracking) */
  pendingToolIds?: string[];
  /** Task tool use IDs currently pending (for tracking when subagents complete) */
  pendingTaskIds?: string[];
  /** Agent version from log entries */
  version?: string;
  /** Git branch from log entries */
  gitBranch?: string;
  /** Last user prompt text. `null` is the explicit "clear" signal that
   * SessionManager.updateSession honors; `undefined` means "leave alone". */
  lastPrompt?: string | null;
  /** Recent user prompts (oldest to newest), already capped by
   * `appendPrompt`. `undefined` means "leave alone"; a defined array
   * replaces the session's prompts wholesale (the fold is a full re-derive,
   * not a merge). Mirrors the `lastPrompt` non-clear convention. */
  prompts?: string[];
  /** Background-only: row subtitle from `state.json` `detail`/`name`.
   * Non-null (undefined = "leave alone") to mirror `Session.backgroundDetail`
   * so `Partial<SessionState>` stays assignable to `Partial<Session>`. */
  backgroundDetail?: string;
  /** Background-only: peek text from `state.json` `output.result`. */
  backgroundResult?: string;
  /** Background-only: linked artifacts from `state.json` `children[]`. */
  backgroundChildren?: BackgroundChild[];
  /** Background-only: live progress from `state.json` `inFlight`. */
  backgroundInFlight?: BackgroundInFlight;
  /** True when the fold aggregates >1 concurrently-waiting server-side
   * session into this row (see `Session.ambiguousWait`). Emitted by
   * `aggregateOpenCodeMarkers` on every fold (true or false) so the notifier's
   * button suppression tracks the live waiting-marker count. */
  ambiguousWait?: boolean;
}

/**
 * Process info from pgrep/ps
 */
export interface ProcessInfo {
  pid: number;
  command: string;
  /** Agent runtime type detected from process command */
  agentType: string;
  /** TTY device (e.g., "ttys061") */
  tty: string | null;
  /** Working directory of the process */
  cwd: string | null;
  /** Process start time as Unix timestamp in milliseconds */
  startTime: number | null;
}

/**
 * Session with computed tmuxTarget for API responses
 * tmuxTarget is derived from paneId using the daemon's pane cache
 */
export interface EnrichedSession extends Session {
  /** tmux target for switching (e.g., "session:window.pane") - computed from paneId */
  tmuxTarget: string | null;
  /** The pane's current working directory (preferred over log-derived cwd) */
  paneCwd: string | null;
  /** Whether the session's cwd is a git worktree */
  isWorktree: boolean;
  /**
   * The `ccmux invoke` invocation id that spawned this session, when it
   * runs inside a `ccmux-invoke-<id>` detached tmux session (the Claude
   * invoke path). Derived at enrich time from the pane's `sessionName`,
   * never persisted on the stored `Session` (keeps `SessionManager`
   * invocation-unaware). `null` for every normal user-opened session.
   */
  originInvocationId: string | null;
  /**
   * Lifecycle state of a client-synthesized subprocess invoke row (the
   * board fabricates these from `invocation_started`/`invocation_finished`
   * SSE events for paneless workers). `undefined` for real sessions,
   * including Claude invoke sessions (which render through the normal
   * status machine and carry only `originInvocationId`). Drives the
   * invoke-specific status glyph (running spinner / ✓ / ✗ / ⊘).
   */
  originInvocationStatus?: InvocationStatus;
  /**
   * Open PRs for the branch the session's cwd is on (gh-derived, cached by
   * the daemon's PRResolver; enrich-time only, never persisted). `null`
   * when unknown, gh is unavailable, or the branch is a default branch.
   * The TUI's `pr` field falls back to this when `backgroundChildren` has
   * no PR entries.
   */
  branchPRs?: BranchPR[] | null;
}

/**
 * Tmux pane info
 */
export interface TmuxPane {
  paneId: string;
  panePid: number;
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  target: string;
  /** TTY device for this pane (e.g., "/dev/ttys061") */
  tty: string | null;
  /** Pane start time (Unix timestamp in seconds) */
  startTime: number | null;
  /**
   * Last window activity timestamp (Unix timestamp in seconds). tmux
   * exposes activity at window scope, not pane scope; this advances
   * whenever ANY pane in the same tmux window writes output.
   */
  windowActivity: number | null;
  /** Pane title (set by agent to show status) */
  paneTitle: string | null;
  /** Current foreground command in this pane */
  currentCommand: string | null;
  /** Current working directory of the pane */
  currentPath: string | null;
}
