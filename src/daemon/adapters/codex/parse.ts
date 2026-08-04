/**
 * Codex rollout line parsing and entry types.
 *
 * Extracted from `log-adapter.ts` so both the status-deriving adapter and the
 * transcript-search module parse rollout lines through one implementation.
 * Pure: no I/O, no state.
 */

/**
 * Top-level Codex rollout entry envelope.
 *
 * Codex writes one JSON object per line. The first line is always a
 * `session_meta` entry; subsequent lines are `event_msg`, `response_item`,
 * or `turn_context`. `session_meta` and `event_msg` carry most session-state
 * signals; `response_item` contributes only the tool-output permission-resolved
 * flip (see `applyResponseItem` in `log-adapter.ts`); `turn_context` is kept
 * for `lastActivityAt` tracking only.
 */
export type CodexEntry =
  | {
      type: "session_meta";
      timestamp: string;
      payload: CodexSessionMetaPayload;
    }
  | { type: "event_msg"; timestamp: string; payload: CodexEventPayload }
  | {
      type: "response_item";
      timestamp: string;
      payload: CodexResponseItemPayload;
    }
  | { type: "turn_context"; timestamp: string; payload: unknown };

/**
 * Minimal `response_item.payload` shape. Only `type` is consumed: the two
 * `*_output` variants are the adapter's evidence that a permission-gated
 * tool executed (outputs are flushed only after execution, unlike the
 * call/request items, which can land while the approval prompt is still
 * up). `call_id` is present in the rollout but deliberately unused; the
 * PermissionRequest hook payload has no counterpart to correlate against
 * (see `applyResponseItem` in `log-adapter.ts`).
 */
export interface CodexResponseItemPayload {
  type?: string;
}

export interface CodexSessionMetaPayload {
  id: string;
  cwd: string;
  timestamp: string;
  cli_version?: string;
  git?: { branch?: string };
  /**
   * Present on codex >= 0.146 rollouts. `"user"` marks a real user session;
   * any other value (e.g. `"subagent"`, seen on the auto-approval reviewer's
   * own rollout) marks a thread that is not the user's conversation. The
   * reviewer thread's `session_id` duplicates its parent's, so callers
   * filtering rollout candidates for session linking MUST check
   * `isSubagentRollout()` rather than compare on session id. Absent on
   * older codex (backward compatible: treated as a user thread).
   */
  thread_source?: string;
  /**
   * Present on codex >= 0.146 subagent/reviewer rollouts; holds the parent
   * thread's id. Absence means a user thread. See `thread_source` above.
   */
  parent_thread_id?: string;
}

/**
 * True when a rollout's `session_meta` marks it as a subagent thread
 * (e.g. the codex >= 0.146 auto-approval reviewer) rather than a real user
 * session: `thread_source` is present and not `"user"`, or `parent_thread_id`
 * is present. Absent fields (codex < 0.146) means a user thread —
 * fail-open, for backward compatibility with older rollouts that predate
 * both fields. This is the ONE place that decides "is this rollout a real
 * user session"; every rollout-candidate/link site must reuse it rather
 * than re-deriving the check (see the danger note on `thread_source`).
 */
export function isSubagentRollout(meta: {
  thread_source?: string;
  parent_thread_id?: string;
}): boolean {
  if (meta.parent_thread_id != null) return true;
  if (meta.thread_source != null && meta.thread_source !== "user") {
    return true;
  }
  return false;
}

/**
 * Discriminated union of `event_msg.payload` variants the adapter consumes.
 * Codex emits many other event types (token_count, agent_reasoning, etc.);
 * the trailing `{ type: string }` variant accepts those without an index
 * signature so narrowing on a literal `payload.type` still pins the known
 * variants. `agent_message` carries the assistant's turn text (used by
 * transcript search).
 */
export type CodexEventPayload =
  | { type: "task_started" }
  | { type: "task_complete" }
  | { type: "turn_aborted" }
  | { type: "user_message"; message?: string }
  | { type: "agent_message"; message?: string }
  | { type: string };

export function parseLine(line: string): CodexEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as CodexEntry;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.type !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseEntries(content: string): CodexEntry[] {
  if (!content) return [];
  const entries: CodexEntry[] = [];
  for (const line of content.split("\n")) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}
