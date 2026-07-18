import type {
  LogEntry,
  AssistantLogEntry,
  UserLogEntry,
  ProgressLogEntry,
  ResultLogEntry,
  SummaryLogEntry,
  SystemLogEntry,
  QueueOperationLogEntry,
  ToolUseBlock,
  ToolResultContent,
} from "../types";
import type {
  SessionState,
  Session,
  SessionStatus,
  AttentionType,
} from "../types/session";
import {
  MAX_SESSION_PROMPTS,
  MAX_PROMPT_CHARS,
  MAX_PROMPTS_TOTAL_BYTES,
} from "../lib/config";

/**
 * Append a user prompt to the capped prompt index. Trims and truncates the
 * text, pushes it as the newest entry, then drops oldest entries until both
 * the count (MAX_SESSION_PROMPTS) and total UTF-8 byte (MAX_PROMPTS_TOTAL_BYTES)
 * ceilings hold. Empty/whitespace-only text (or a non-string, e.g. a
 * JSON-valid log entry with `content: null`) is a no-op: the existing array is
 * returned unchanged (same reference) so callers detect "nothing to append".
 * Returns a new array on a real append.
 */
export function appendPrompt(
  prompts: string[] | undefined,
  text: string,
): string[] {
  const existing = prompts ?? [];
  // Defensive: a malformed but JSON-valid log entry can deliver a non-string
  // here; returning unchanged keeps the daemon's incremental read from
  // throwing (an unhandled rejection under `void this.processFile`).
  if (typeof text !== "string") return existing;
  const trimmed = text.trim();
  if (trimmed.length === 0) return existing;

  let entry = trimmed;
  if (entry.length > MAX_PROMPT_CHARS) {
    let cut = MAX_PROMPT_CHARS;
    // Don't slice a surrogate pair in half (would leave a lone surrogate).
    const code = entry.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    entry = entry.slice(0, cut);
  }

  const next = [...existing, entry];
  // Drop oldest until within the count cap.
  while (next.length > MAX_SESSION_PROMPTS) {
    next.shift();
  }
  // Drop oldest until within the total-bytes cap (keep at least the newest).
  let totalBytes = next.reduce(
    (sum, p) => sum + Buffer.byteLength(p, "utf-8"),
    0,
  );
  while (next.length > 1 && totalBytes > MAX_PROMPTS_TOTAL_BYTES) {
    const dropped = next.shift()!;
    totalBytes -= Buffer.byteLength(dropped, "utf-8");
  }
  return next;
}

/**
 * Initial session state
 */
export function createInitialState(): SessionState {
  return {
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    hasActiveSubagent: false,
    pendingToolIds: undefined,
    pendingTaskIds: undefined,
    lastUserInputAt: undefined,
  };
}

/**
 * Process a log entry and return the new session state
 */
export function processEntry(
  entry: LogEntry,
  currentState: SessionState,
): SessionState {
  // Each case re-casts `entry`: LogEntry's open-ended final member
  // (BaseLogEntry & { type: string }) defeats discriminant narrowing on the
  // literal `type` values below, so TS won't narrow `entry` on its own.
  switch (entry.type) {
    case "progress":
      return processProgressEntry(entry as ProgressLogEntry, currentState);
    case "result":
      return processResultEntry(entry as ResultLogEntry, currentState);
    case "assistant":
      return processAssistantEntry(entry as AssistantLogEntry, currentState);
    case "user":
      return processUserEntry(entry as UserLogEntry, currentState);
    case "system":
      return processSystemEntry(entry as SystemLogEntry, currentState);
    case "summary":
      return processSummaryEntry(entry as SummaryLogEntry, currentState);
    case "queue-operation":
      return processQueueOperationEntry(
        entry as QueueOperationLogEntry,
        currentState,
      );
    default:
      return { ...currentState, lastActivityAt: entry.timestamp };
  }
}

/**
 * Process a progress entry (SessionStart, SessionEnd, Stop, bash_progress)
 */
function processProgressEntry(
  entry: ProgressLogEntry,
  currentState: SessionState,
): SessionState {
  if (entry.data?.type === "bash_progress") {
    // Don't clear waiting state for non-Bash tools
    if (
      currentState.status === "waiting" &&
      currentState.pendingTool !== "Bash"
    ) {
      return { ...currentState, lastActivityAt: entry.timestamp };
    }
    return {
      ...currentState,
      status: "working",
      attentionType: null,
      pendingTool: "Bash",
      lastActivityAt: entry.timestamp,
    };
  }

  switch (entry.progress?.type) {
    case "SessionStart":
      return {
        ...createInitialState(),
        status: "idle",
        lastActivityAt: entry.timestamp,
      };
    case "SessionEnd":
    case "Stop":
      return {
        ...currentState,
        status: "idle",
        attentionType: null,
        pendingTool: null,
        pendingToolIds: undefined,
        pendingTaskIds: undefined,
        hasActiveSubagent: false,
        lastActivityAt: entry.timestamp,
      };
    default:
      return { ...currentState, lastActivityAt: entry.timestamp };
  }
}

/**
 * Process a result entry (turn completed)
 */
function processResultEntry(
  entry: ResultLogEntry,
  currentState: SessionState,
): SessionState {
  return {
    ...currentState,
    status: "idle",
    attentionType: null,
    pendingTool: null,
    pendingToolIds: undefined,
    pendingTaskIds: undefined,
    hasActiveSubagent: false,
    lastActivityAt: entry.timestamp,
  };
}

/**
 * Process an assistant entry (tool calls, responses)
 */
function processAssistantEntry(
  entry: AssistantLogEntry,
  currentState: SessionState,
): SessionState {
  const { content } = entry.message;
  let newState = {
    ...currentState,
    lastActivityAt: entry.timestamp,
    version: entry.version || currentState.version,
    gitBranch: entry.gitBranch || currentState.gitBranch,
  };

  const toolUses = content.filter(
    (block): block is ToolUseBlock => block.type === "tool_use",
  );

  if (toolUses.length > 0) {
    const taskToolIds: string[] = [];
    let hasExitPlanMode = false;
    let exitPlanModeId: string | undefined;
    let hasAskUserQuestion = false;
    let askUserQuestionId: string | undefined;

    for (const tool of toolUses) {
      if (tool.name === "EnterPlanMode") {
        newState.inPlanMode = true;
      }

      if (tool.name === "ExitPlanMode") {
        hasExitPlanMode = true;
        exitPlanModeId = tool.id;
      }

      if (tool.name === "AskUserQuestion") {
        hasAskUserQuestion = true;
        askUserQuestionId = tool.id;
      }

      if (tool.name === "Task") {
        taskToolIds.push(tool.id);
      }
    }

    // Merge task IDs once (shared across all branches below)
    const existingTaskIds = currentState.pendingTaskIds || [];
    const mergedTaskIds = [...existingTaskIds, ...taskToolIds];
    const taskFields = {
      pendingTaskIds: mergedTaskIds.length > 0 ? mergedTaskIds : undefined,
      hasActiveSubagent:
        mergedTaskIds.length > 0 ? true : currentState.hasActiveSubagent,
    };

    // No log-derived permission waiting: a tool_use that would require
    // permission is NOT surfaced as `waiting` here. Claude Code defers writing
    // a permission-gated tool_use to the transcript until AFTER the user
    // resolves the prompt (verified against Claude Code 2.1.214), so a
    // tool_use we can see has already been approved and is executing — deriving
    // `waiting` from it only phantom-fires under auto-accept/bypass modes,
    // where the tool runs with no prompt on screen. Genuine prompts reach the
    // row through the Notification-hook marker instead. See the fuller
    // rationale on `getEffectiveStatus` below. An unresolved tool_use falls
    // through to the working-state logic.

    // ExitPlanMode → waiting for plan approval
    if (hasExitPlanMode) {
      return {
        ...newState,
        status: "waiting",
        attentionType: "plan_approval",
        pendingTool: "ExitPlanMode",
        pendingToolIds: [exitPlanModeId!],
        ...taskFields,
      };
    }

    // AskUserQuestion → waiting for user answer
    if (hasAskUserQuestion) {
      return {
        ...newState,
        status: "waiting",
        attentionType: "question",
        pendingTool: "AskUserQuestion",
        pendingToolIds: [askUserQuestionId!],
        ...taskFields,
      };
    }

    // Task tools → working with subagent
    if (taskToolIds.length > 0) {
      return {
        ...newState,
        status: "working",
        attentionType: null,
        pendingTool: "Task",
        hasActiveSubagent: true,
        pendingTaskIds: mergedTaskIds,
      };
    }

    // A tool_use arriving while a plan/question wait is still pending
    // (pendingToolIds tracks the ExitPlanMode/AskUserQuestion tool) must not
    // clear that wait; carry the pending IDs forward until their tool_result
    // resolves them in `processUserEntry`.
    const existingPendingIds = currentState.pendingToolIds || [];
    if (existingPendingIds.length > 0) {
      return { ...newState, pendingToolIds: existingPendingIds };
    }

    return {
      ...newState,
      status: "working",
      attentionType: null,
      pendingTool: toolUses[0].name,
    };
  }

  // `stop_sequence` is terminal like `end_turn`: the model stopped at a
  // configured stop string, so the turn is over. Background agents commonly
  // end their transcripts with it (observed live), and treating it as
  // terminal makes their completion instant instead of waiting out the
  // silence-based stale sweep.
  if (
    entry.message.stop_reason === "end_turn" ||
    entry.message.stop_reason === "stop_sequence"
  ) {
    return {
      ...newState,
      status: "idle",
      attentionType: null,
      pendingTool: null,
      pendingToolIds: undefined,
      pendingTaskIds: undefined,
      hasActiveSubagent: false,
    };
  }

  // Streaming content - preserve current status
  return newState;
}

/**
 * Process a user entry (tool results, messages)
 */
function processUserEntry(
  entry: UserLogEntry,
  currentState: SessionState,
): SessionState {
  const { content } = entry.message;

  const cwd = entry.cwd || currentState.cwd;
  const project = cwd ? cwd.split("/").pop() : currentState.project;
  const version = entry.version || currentState.version;
  const gitBranch = entry.gitBranch || currentState.gitBranch;

  // When user provides input after ExitPlanMode, exit plan mode
  const inPlanMode =
    currentState.pendingTool === "ExitPlanMode"
      ? false
      : currentState.inPlanMode;

  // If content is an array, it's tool results
  if (Array.isArray(content)) {
    // Extract tool_use_ids from the results
    const resultIds = (content as ToolResultContent[])
      .filter((c) => c.type === "tool_result" && c.tool_use_id)
      .map((c) => c.tool_use_id);

    // Remove resolved tool IDs from pending list
    let remainingPendingIds = currentState.pendingToolIds || [];
    if (resultIds.length > 0 && remainingPendingIds.length > 0) {
      remainingPendingIds = remainingPendingIds.filter(
        (id) => !resultIds.includes(id),
      );
    }

    // Check if any completed tools were Task tools
    const pendingTaskIds = currentState.pendingTaskIds || [];
    const remainingTaskIds = pendingTaskIds.filter(
      (id) => !resultIds.includes(id),
    );

    // Clear hasActiveSubagent only when ALL Task tools have completed
    const hasActiveSubagent = remainingTaskIds.length > 0;

    // If there are still pending plan/question waits (ExitPlanMode /
    // AskUserQuestion tool IDs), stay in waiting state
    if (remainingPendingIds.length > 0) {
      return {
        ...currentState,
        pendingToolIds: remainingPendingIds,
        pendingTaskIds:
          remainingTaskIds.length > 0 ? remainingTaskIds : undefined,
        inPlanMode,
        hasActiveSubagent,
        cwd,
        project,
        version,
        gitBranch,
        lastActivityAt: entry.timestamp,
      };
    }

    // All pending tools resolved - Claude is working again
    return {
      ...currentState,
      status: "working",
      attentionType: null,
      pendingTool: null,
      pendingToolIds: undefined,
      pendingTaskIds:
        remainingTaskIds.length > 0 ? remainingTaskIds : undefined,
      inPlanMode,
      hasActiveSubagent,
      cwd,
      project,
      version,
      gitBranch,
      lastActivityAt: entry.timestamp,
    };
  }

  // User message - Claude will start working
  // Also clear hasActiveSubagent on new user message (session reset)
  // Track lastUserInputAt for stable sorting (only actual user input, not tool results)
  return {
    ...currentState,
    status: "working",
    attentionType: null,
    pendingTool: null,
    pendingToolIds: undefined,
    inPlanMode,
    hasActiveSubagent: false,
    cwd,
    project,
    version,
    gitBranch,
    lastActivityAt: entry.timestamp,
    lastUserInputAt: entry.timestamp,
    lastPrompt: content as string,
    prompts: appendPrompt(currentState.prompts, content as string),
  };
}

/**
 * Process a system entry (turn_duration, stop_hook_summary, etc.)
 */
function processSystemEntry(
  entry: SystemLogEntry,
  currentState: SessionState,
): SessionState {
  if (
    entry.subtype === "turn_duration" ||
    entry.subtype === "stop_hook_summary"
  ) {
    return {
      ...currentState,
      status: "idle",
      attentionType: null,
      pendingTool: null,
      pendingToolIds: undefined,
      pendingTaskIds: undefined,
      hasActiveSubagent: false,
      lastActivityAt: entry.timestamp,
    };
  }
  return { ...currentState, lastActivityAt: entry.timestamp };
}

/**
 * Process a summary entry (conversation summary/end)
 */
function processSummaryEntry(
  entry: SummaryLogEntry,
  currentState: SessionState,
): SessionState {
  return {
    ...currentState,
    status: "idle",
    attentionType: null,
    pendingTool: null,
    pendingToolIds: undefined,
    pendingTaskIds: undefined,
    hasActiveSubagent: false,
    inPlanMode: false,
    lastActivityAt: entry.timestamp,
  };
}

/**
 * Process a queue-operation entry (user input enqueue/dequeue)
 */
function processQueueOperationEntry(
  entry: QueueOperationLogEntry,
  currentState: SessionState,
): SessionState {
  if (entry.operation === "enqueue") {
    return {
      ...currentState,
      status: "working",
      attentionType: null,
      pendingTool: null,
      pendingToolIds: undefined,
      lastActivityAt: entry.timestamp,
    };
  }
  return { ...currentState, lastActivityAt: entry.timestamp };
}

/**
 * Apply log entries to a state, returning the new state
 * Used for both initial state derivation and incremental updates
 */
export function applyEntriesToState(
  currentState: SessionState,
  entries: LogEntry[],
): SessionState {
  let state = currentState;

  for (const entry of entries) {
    try {
      state = processEntry(entry, state);
    } catch {
      // Skip malformed entries
    }
  }

  return state;
}

/**
 * Process multiple log entries to derive current state from scratch
 */
export function deriveStateFromEntries(entries: LogEntry[]): SessionState {
  return applyEntriesToState(createInitialState(), entries);
}

/**
 * Effective status result including subagent information
 */
interface EffectiveStatus {
  status: SessionStatus;
  attentionType: AttentionType;
  fromSubagent: boolean;
}

/**
 * Get the effective status of a session, considering subagent states.
 *
 * Active subagents (working OR waiting) lift an idle parent to `working`:
 * a lead sitting at its prompt while its agents run must never render as
 * idle/"done", because the session's work provably isn't finished. The
 * parent reading `idle` is the NORMAL background-agent state, not an
 * anomaly: the `Agent` tool acks instantly and the lead genuinely ends its
 * turn while its agents keep working in their own logs.
 *
 * Neither a subagent's `waiting` nor a MAIN transcript's unresolved
 * tool_use is surfaced as permission-waiting from the log. The signal is
 * log-derived, and a tool mid-execution and a genuine approval prompt are
 * indistinguishable in the transcript: Claude Code defers writing a
 * permission-gated tool_use until AFTER the user resolves the prompt
 * (verified against Claude Code 2.1.214), so any tool_use we can read has
 * already been approved and is running. Deriving `waiting` from it only
 * phantom-fires under auto-accept/`--dangerously-skip-permissions`/
 * `defaultMode: "auto"` (a tool executes with no prompt on screen), and
 * would false-alarm on every long Bash run under bypassPermissions.
 * Genuine prompts reach the row through the higher-fidelity signals: for
 * native Claude sessions the `Notification` hook fires and the marker
 * becomes `waiting_permission`; for pane-tracked sessions the terminal
 * detector reads the prompt off the pane. `processAssistantEntry` was the
 * main-transcript source of this permission inference and no longer derives
 * it (a would-require-permission tool_use is `working`), extending the
 * decision made earlier for subagents. ExitPlanMode/AskUserQuestion still
 * derive their own `waiting` from the main transcript, but only as a
 * best-effort, when-flushed signal: their tool_use is often NOT in the JSONL
 * during the wait (AskUserQuestion's is absent, ExitPlanMode's is frequently
 * deferred — see docs/agent-adapters.md), so the marker/pane path is the
 * authoritative source for those too; the log inference just catches the
 * cases where the entry is present. This intentionally includes `question`
 * (AskUserQuestion) for subagents: a subagent's prompt is answered in the
 * lead's pane, where the parent's own signals already turn the row red.
 *
 * Staleness is bounded by the reconciler: idle subagents self-evict via
 * updateSubagent, and silent active ones are downgraded by the stale
 * sweep (SUBAGENT_STALE_TIMEOUT_MS).
 */
export function getEffectiveStatus(session: Session): EffectiveStatus {
  if (
    session.status === "idle" &&
    session.subagents.some(
      (sub) => sub.status === "working" || sub.status === "waiting",
    )
  ) {
    return { status: "working", attentionType: null, fromSubagent: true };
  }

  return {
    status: session.status,
    attentionType: session.attentionType,
    fromSubagent: false,
  };
}

/** Safety net timeout for sessions without a known PID (10 minutes) */
const NO_PID_SAFETY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolve state for a "working" session based on PID liveness.
 * Replaces time-based stale timeout with process liveness checks.
 *
 * @param state - Current session state
 * @param isProcessAlive - true if PID is alive, false if dead, null if no PID known
 * @param logFileMtimeMs - Log file mtime in ms (safety net for no-PID
 *   sessions). `null` means a log is linked but missing or unreadable (it
 *   will never append again), which counts as silent past any timeout;
 *   `undefined` means no log is linked, so there is no mtime signal at all.
 */
export function resolveDeadProcessState(
  state: SessionState,
  isProcessAlive: boolean | null,
  logFileMtimeMs?: number | null,
): SessionState {
  // Only act on "working" sessions
  if (state.status !== "working") {
    return state;
  }

  // Process is alive → trust log-derived state
  if (isProcessAlive === true) {
    return state;
  }

  // Process is dead → reset to idle (crashed without end-of-turn entry)
  if (isProcessAlive === false) {
    return {
      ...state,
      status: "idle",
      attentionType: null,
      pendingTool: null,
      pendingToolIds: undefined,
      pendingTaskIds: undefined,
      hasActiveSubagent: false,
    };
  }

  // No PID known → use log file mtime as safety net. A missing/unreadable
  // log (`null`) will never append again, so it is silent past any timeout.
  if (logFileMtimeMs !== undefined) {
    const elapsed =
      logFileMtimeMs === null
        ? Number.POSITIVE_INFINITY
        : Date.now() - logFileMtimeMs;
    if (elapsed > NO_PID_SAFETY_TIMEOUT_MS) {
      return {
        ...state,
        status: "idle",
        attentionType: null,
        pendingTool: null,
        pendingToolIds: undefined,
        pendingTaskIds: undefined,
        hasActiveSubagent: false,
      };
    }
  }

  return state;
}
