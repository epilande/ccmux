/**
 * Codex transcript reader (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 *
 * Line shape: `{type, timestamp, payload}`. Only `event_msg` payloads carry
 * conversation: `user_message` (the prompt) and `agent_message` (the
 * assistant's text, emitted several times per turn as the model narrates).
 * `task_complete` ends a turn and repeats the final text verbatim in
 * `last_agent_message`, so it is taken as authoritative for its turn and the
 * `agent_message` lines it duplicates are dropped.
 *
 * `response_item` (duplicates), `token_count` (~800 B, ~28x per session),
 * `web_search_end` and the rest are skipped.
 */

import type { LineMeaning, TranscriptReader } from "../transcript-read";
import { SKIP_LINE, foldJsonlTurns } from "../transcript-read";

export function classifyCodexLine(entry: unknown): LineMeaning {
  if (!entry || typeof entry !== "object") return SKIP_LINE;
  const record = entry as {
    type?: unknown;
    timestamp?: unknown;
    payload?: unknown;
  };
  if (record.type !== "event_msg") return SKIP_LINE;
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return SKIP_LINE;
  const typed = payload as {
    type?: unknown;
    message?: unknown;
    last_agent_message?: unknown;
  };
  const timestamp =
    typeof record.timestamp === "string" ? record.timestamp : undefined;

  if (typed.type === "task_complete") {
    const text = typed.last_agent_message;
    if (typeof text !== "string" || !text.trim()) return SKIP_LINE;
    return { kind: "assistant", text, timestamp, authoritative: true };
  }

  if (typed.type === "agent_message") {
    const text = typed.message;
    if (typeof text !== "string" || !text.trim()) return SKIP_LINE;
    return { kind: "assistant", text, timestamp };
  }

  if (typed.type === "user_message") {
    const text = typed.message;
    if (typeof text !== "string" || !text.trim()) return SKIP_LINE;
    return { kind: "user", text, timestamp };
  }

  return SKIP_LINE;
}

export const codexTranscriptReader: TranscriptReader = {
  agentType: "codex",
  async read(session, turns) {
    if (!session.logPath) return null;
    return foldJsonlTurns(session.logPath, turns, classifyCodexLine);
  },
};
