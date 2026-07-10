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
 * or `turn_context`. Only `session_meta` and `event_msg` carry signals
 * relevant to session state; the others are kept for `lastActivityAt`
 * tracking only.
 */
export type CodexEntry =
  | {
      type: "session_meta";
      timestamp: string;
      payload: CodexSessionMetaPayload;
    }
  | { type: "event_msg"; timestamp: string; payload: CodexEventPayload }
  | { type: "response_item"; timestamp: string; payload: unknown }
  | { type: "turn_context"; timestamp: string; payload: unknown };

export interface CodexSessionMetaPayload {
  id: string;
  cwd: string;
  timestamp: string;
  cli_version?: string;
  git?: { branch?: string };
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
