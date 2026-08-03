/**
 * Copilot CLI transcript reader
 * (`~/.copilot/session-state/<uuid>/events.jsonl`).
 *
 * Envelope: `{type, data, id, timestamp, parentId}`. Turn structure is
 * explicit (`user.message` -> `assistant.turn_start` -> `assistant.message`
 * xN -> `assistant.turn_end`), and `data.content` is a PLAIN STRING rather
 * than a block array. A tool-only assistant message emits `""`, which is
 * dropped.
 *
 * `system.message` MUST be filtered: it is the ~27.5 KB system prompt and
 * Copilot re-inlines it on EVERY turn, so it would otherwise dominate any
 * window. The turn markers are not needed to fold backwards; the user prompt
 * is the boundary, exactly as for the other agents.
 */

import type { LineMeaning, TranscriptReader } from "../transcript-read";
import { SKIP_LINE, foldJsonlTurns } from "../transcript-read";

export function classifyCopilotLine(entry: unknown): LineMeaning {
  if (!entry || typeof entry !== "object") return SKIP_LINE;
  const record = entry as {
    type?: unknown;
    timestamp?: unknown;
    data?: { content?: unknown };
  };
  const timestamp =
    typeof record.timestamp === "string" ? record.timestamp : undefined;
  const content = record.data?.content;

  if (record.type === "assistant.message") {
    if (typeof content !== "string" || !content.trim()) return SKIP_LINE;
    return { kind: "assistant", text: content, timestamp };
  }

  if (record.type === "user.message") {
    if (typeof content !== "string" || !content.trim()) return SKIP_LINE;
    return { kind: "user", text: content, timestamp };
  }

  return SKIP_LINE;
}

export const copilotTranscriptReader: TranscriptReader = {
  agentType: "copilot",
  async read(session, turns) {
    if (!session.logPath) return null;
    return foldJsonlTurns(session.logPath, turns, classifyCopilotLine);
  },
};
