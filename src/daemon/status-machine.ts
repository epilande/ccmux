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
  toolRequiresPermission,
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
    const permissionToolIds: string[] = [];
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

      // Collect permission-required tool IDs for parallel tracking
      if (toolRequiresPermission(tool.name, tool.input, currentState.cwd)) {
        permissionToolIds.push(tool.id);
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

    // Permission-required tools take precedence over everything
    if (permissionToolIds.length > 0) {
      const existingIds = currentState.pendingToolIds || [];
      const mergedIds = [...new Set([...existingIds, ...permissionToolIds])];
      return {
        ...newState,
        status: "waiting",
        attentionType: "permission",
        pendingTool: permissionToolIds[0]
          ? (toolUses.find((t) => t.id === permissionToolIds[0])?.name ?? null)
          : null,
        pendingToolIds: mergedIds,
        ...taskFields,
      };
    }

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

    // Auto-approved tools - preserve waiting state if permission-required tools still pending
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

  if (entry.message.stop_reason === "end_turn") {
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

    // If there are still pending permission-required tools, stay in waiting state
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
 * Subagent waiting states take precedence (permission > question).
 */
export function getEffectiveStatus(session: Session): EffectiveStatus {
  let hasWaitingQuestion = false;

  for (const sub of session.subagents) {
    if (sub.status === "waiting") {
      if (sub.attentionType === "permission") {
        return {
          status: "waiting",
          attentionType: "permission",
          fromSubagent: true,
        };
      }
      if (sub.attentionType === "question") {
        hasWaitingQuestion = true;
      }
    }
  }

  if (hasWaitingQuestion) {
    return { status: "waiting", attentionType: "question", fromSubagent: true };
  }

  // A working subagent means the session's work provably isn't finished, so
  // it must never render as idle/"done" while agents run. The parent reading
  // `idle` here is the NORMAL background-agent state, not an anomaly: the
  // `Agent` tool acks instantly and the lead genuinely ends its turn
  // (`end_turn` in its own transcript) while its agents keep working in
  // their own logs. Lift the parent back to `working`. Staleness is bounded
  // by the reconciler: idle subagents self-evict via updateSubagent, and
  // silent `working` ones are downgraded by the stale sweep
  // (SUBAGENT_STALE_TIMEOUT_MS).
  if (
    session.status === "idle" &&
    session.subagents.some((sub) => sub.status === "working")
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
