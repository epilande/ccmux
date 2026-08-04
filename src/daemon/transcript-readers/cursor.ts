/**
 * Cursor CLI transcript reader
 * (`~/.cursor/projects/<slug>/agent-transcripts/<cid>/<cid>.jsonl`).
 *
 * Exactly two line shapes: `{role, message}` and `{type: "turn_ended",
 * status}`. Verified live 2026-08-03: `turn_ended` fires once near end of
 * file, not once per exchange (a 56-line, 9-exchange fixture carried a
 * single trailing `turn_ended`), so it carries no turn-boundary information
 * and is simply skipped — the user line before each response is what
 * delimits turns, exactly as for the other JSONL agents.
 *
 * `message.content` is a block array for BOTH roles (same shape as Claude).
 * User text is wrapped: `<timestamp>...</timestamp>\n<user_query>\n...\n</user_query>`;
 * only the `<user_query>` interior is kept.
 *
 * No line in this format carries a timestamp at all (verified: no `timestamp`
 * key anywhere). Rather than fabricate one from file mtime, every turn is
 * emitted with `timestamp` omitted, which the contract allows.
 */

import type { LineMeaning, TranscriptReader } from "../transcript-read";
import { SKIP_LINE, foldJsonlTurns } from "../transcript-read";

const USER_QUERY_RE = /<user_query>([\s\S]*?)<\/user_query>/;

/** Pull the interior of `<user_query>...</user_query>`; if the wrapper is
 *  absent (a shape drift), fall back to the raw text rather than dropping it. */
function unwrapUserQuery(text: string): string {
  const match = text.match(USER_QUERY_RE);
  return (match ? match[1] : text).trim();
}

function collectTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type !== "text") continue; // tool_use carries no response text
    if (typeof typed.text === "string" && typed.text.length > 0) {
      parts.push(typed.text);
    }
  }
  return parts.join("\n");
}

export function classifyCursorLine(entry: unknown): LineMeaning {
  if (!entry || typeof entry !== "object") return SKIP_LINE;
  const record = entry as { role?: unknown; message?: { content?: unknown } };

  if (record.role === "assistant") {
    const text = collectTextBlocks(record.message?.content);
    if (!text) return SKIP_LINE;
    return { kind: "assistant", text };
  }

  if (record.role === "user") {
    const raw = collectTextBlocks(record.message?.content);
    if (!raw) return SKIP_LINE;
    const text = unwrapUserQuery(raw);
    if (!text) return SKIP_LINE;
    return { kind: "user", text };
  }

  return SKIP_LINE; // turn_ended and any other envelope shape
}

export const cursorTranscriptReader: TranscriptReader = {
  agentType: "cursor",
  async read(session, turns) {
    if (!session.logPath) return null;
    return foldJsonlTurns(session.logPath, turns, classifyCursorLine);
  },
};
