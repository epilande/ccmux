/**
 * Claude Code transcript reader (`~/.claude/projects/<enc>/<sid>.jsonl`).
 *
 * Line shape: `{type, timestamp, message: {role, content}}`. Assistant
 * content is an array of blocks and, empirically, each assistant LINE carries
 * one block, so a turn's text arrives as several lines that the fold
 * accumulates. Claude is the only agent with no end-of-turn marker in its
 * message stream: what ends a turn is the next user prompt, which is a `user`
 * entry whose `message.content` is a STRING. Array-form user content is a
 * tool result and belongs to the turn it interrupts.
 *
 * Sidecar line types (`mode`, `last-prompt`, `ai-title`, `permission-mode`,
 * `file-history-snapshot`, ...) carry no conversation and some carry no
 * timestamp; they are skipped by falling through.
 *
 * Not every `user` entry is a prompt, though: `isMeta` entries and the markup
 * shapes below are Claude's own bookkeeping and are skipped too, which means
 * responses separated only by that noise merge into one turn (see
 * `foldJsonlTurns`).
 */

import type { LineMeaning, TranscriptReader } from "../transcript-read";
import { SKIP_LINE, foldJsonlTurns } from "../transcript-read";

/**
 * String user content that is Claude's own markup rather than something the
 * user typed: a slash command (`<command-message>…</command-message>\n
 * <command-name>/model</command-name><command-args>…</command-args>`, either
 * tag able to lead) and the local-command wrappers a command's output arrives
 * in. Emitting these verbatim would put ccmux's own plumbing in the payload as
 * the user's words, and treating them as boundaries would credit a response to
 * a prompt nobody wrote. Matched as a PREFIX because each entry is entirely
 * markup, so a real prompt that merely quotes a tag is unaffected.
 * `src/tui/components/session-columns.ts:341-369` is the TUI's equivalent
 * reduction of the same shapes (it rewrites rather than drops, since a
 * subtitle still owes the row a line).
 */
const MARKUP_PREFIXES = [
  "<command-message>",
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-caveat>",
];

/**
 * Classify one Claude JSONL line. Shape-guarded throughout (same reason as
 * `transcript-search.ts:claudeEntryTexts`): a JSON-valid but schema-invalid
 * line, including a bare `null`, must yield "skip" rather than throw.
 */
export function classifyClaudeLine(entry: unknown): LineMeaning {
  if (!entry || typeof entry !== "object") return SKIP_LINE;
  const record = entry as {
    type?: unknown;
    timestamp?: unknown;
    isMeta?: unknown;
    message?: { content?: unknown };
  };
  // Claude's own injected context (command caveats, image placeholders,
  // cross-session notes), never a prompt and never a turn boundary.
  if (record.isMeta === true) return SKIP_LINE;
  const timestamp =
    typeof record.timestamp === "string" ? record.timestamp : undefined;

  if (record.type === "assistant") {
    const content = record.message?.content;
    if (!Array.isArray(content)) return SKIP_LINE;
    const parts: string[] = [];
    for (const block of content) {
      // thinking / redacted_thinking / tool_use carry no response text.
      if (!block || typeof block !== "object") continue;
      const typed = block as { type?: unknown; text?: unknown };
      if (typed.type !== "text") continue;
      if (typeof typed.text === "string" && typed.text.length > 0) {
        parts.push(typed.text);
      }
    }
    if (parts.length === 0) return SKIP_LINE;
    // Blocks of one entry are one paragraph run; separate ENTRIES of the same
    // turn are joined with a blank line by the fold.
    return { kind: "assistant", text: parts.join("\n"), timestamp };
  }

  if (record.type === "user") {
    const content = record.message?.content;
    if (typeof content !== "string") return SKIP_LINE; // tool result
    const trimmed = content.trim();
    if (!trimmed) return SKIP_LINE;
    if (MARKUP_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      return SKIP_LINE;
    }
    return { kind: "user", text: content, timestamp };
  }

  return SKIP_LINE;
}

export const claudeTranscriptReader: TranscriptReader = {
  agentType: "claude",
  async read(session, turns) {
    if (!session.logPath) return null;
    return foldJsonlTurns(session.logPath, turns, classifyClaudeLine);
  },
};
