import { readLogTail } from "../../daemon/parser";
import type { LogEntry, TextBlock } from "../../types/log";

/** How many tail entries to consider. Bounds the backwards file read. */
const TAIL_ENTRIES = 50;

/**
 * Byte ceiling for the backwards read. Entry count alone is no bound when
 * entries carry large tool results (the last 50 can span megabytes, parsed
 * synchronously on the render thread); the render keeps at most
 * {@link MAX_TRANSCRIPT_CHARS} anyway.
 */
const TAIL_BYTES = 256 * 1024;

/** Render cap for the extracted turn; the peek must stay snappy. */
export const MAX_TRANSCRIPT_CHARS = 4000;

/**
 * Fold a JSONL tail into the final assistant turn's text: every assistant
 * text block emitted after the last real user prompt, joined in order.
 * Tool-result `user` entries belong to the same turn and do not end the
 * walk; a real prompt (string content, or text blocks) does. Returns null
 * when no assistant text exists in the window. Exported for tests.
 */
export function extractLastAssistantTurn(entries: LogEntry[]): string | null {
  const texts: string[] = [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "assistant") {
      const content = entry.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      const text = blocks
        .filter(
          (block): block is TextBlock =>
            block?.type === "text" &&
            typeof (block as TextBlock).text === "string",
        )
        .map((block) => block.text)
        .join("\n");
      if (text.trim()) texts.unshift(text);
      continue;
    }

    if (entry.type === "user") {
      const content = entry.message?.content;
      const isToolResult =
        Array.isArray(content) &&
        content.some(
          (item) =>
            item != null &&
            typeof item === "object" &&
            item.type === "tool_result",
        );
      if (!isToolResult) break;
    }
  }

  if (texts.length === 0) return null;

  const joined = texts.join("\n\n");
  if (joined.length <= MAX_TRANSCRIPT_CHARS) return joined;
  // Keep the tail: the answer's conclusion is at the end.
  return "… " + joined.slice(-MAX_TRANSCRIPT_CHARS);
}

/**
 * Read the final assistant turn from a Claude JSONL transcript. Client-side
 * and lazy by design (called only for the previewed background row); the
 * tail read is bounded by {@link TAIL_ENTRIES} and {@link TAIL_BYTES} via
 * `readLogTail`'s backwards chunking. Returns null on any read/parse
 * failure.
 */
export async function readLastAssistantTurn(
  logPath: string,
): Promise<string | null> {
  const entries = await readLogTail(logPath, TAIL_ENTRIES, TAIL_BYTES);
  return extractLastAssistantTurn(entries);
}
