/**
 * Notification body enrichment: given a waiting session, extract a short
 * plain-text description of WHAT it is waiting on, so an actionable
 * notification can show the pending command / question instead of a bare
 * "Needs permission: Bash".
 *
 * Fail-open by contract: any read/parse error, an unsupported agent, or a
 * missing transcript returns `null`, and the caller keeps the base body. The
 * text is agent-derived and travels through the argv-safe delivery path, so
 * this module normalizes control characters (keeping only `\n`) and caps the
 * length — the notifier renders `\n` verbatim.
 */

import { parseLogEntries } from "./parser";
import { readTranscriptTail, claudeEntryTexts } from "./transcript-search";
import { stripControlChars } from "./notify-text";
import type { AssistantLogEntry, LogEntry, ToolUseBlock } from "../types/log";

/** Minimal shape this module reads off a session (keeps it testable without
 *  the full `Session` type). */
export interface NotifyContextSession {
  agentType: string;
  logPath: string | null;
  attentionType: "permission" | "question" | "plan_approval" | null;
  /** Name of the tool the pending permission is actually for. The context
   *  body must describe THIS tool, not merely the last tool_use in the
   *  transcript (which may be an already-resolved call) — approving off a
   *  wrong detail is a destructive-approval hazard. */
  pendingTool: string | null;
}

/** Only the last slice of the transcript is scanned — the pending tool_use /
 *  last assistant turn is always at the very tail. */
const CONTEXT_TAIL_BYTES = 128 * 1024;
/** Body caps: multi-line is fine (macOS renders `\n`), but keep it glanceable. */
const MAX_CONTEXT_LINES = 4;
const MAX_CONTEXT_CHARS = 300;

/**
 * Per-tool preference for the single most human-salient input field. Falls
 * through to a generic "longest string field" pick for anything unlisted, so a
 * new tool still renders something useful rather than nothing.
 */
const SALIENT_INPUT_FIELDS: Record<string, string[]> = {
  Bash: ["command"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  Write: ["file_path"],
  Read: ["file_path"],
  NotebookEdit: ["notebook_path"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Glob: ["pattern"],
  Grep: ["pattern"],
};

/**
 * Strip control characters other than newline and collapse the result to at
 * most `MAX_CONTEXT_LINES` lines / `MAX_CONTEXT_CHARS` chars with an ellipsis.
 * Returns null when nothing printable survives.
 */
function clampBody(raw: string): string | null {
  const normalized = stripControlChars(raw.replace(/\r\n?/g, "\n"), {
    keepNewlines: true,
  });
  const lines = normalized.split("\n");
  let clipped = false;

  let kept = lines;
  if (kept.length > MAX_CONTEXT_LINES) {
    kept = kept.slice(0, MAX_CONTEXT_LINES);
    clipped = true;
  }
  let text = kept.join("\n").trimEnd();
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS).trimEnd();
    clipped = true;
  }
  if (text.trim().length === 0) return null;
  return clipped ? `${text}…` : text;
}

/** Pick the salient input string for a tool_use block. */
function describeToolInput(block: ToolUseBlock): string {
  const input = block.input ?? {};
  const preferred = SALIENT_INPUT_FIELDS[block.name] ?? [];
  for (const field of preferred) {
    const value = input[field];
    if (typeof value === "string" && value.trim().length > 0) {
      return `${block.name}: ${value}`;
    }
  }
  // Generic fallback: the longest string-valued field is usually the most
  // descriptive (a command, a path, a query).
  let best: string | null = null;
  for (const value of Object.values(input)) {
    if (
      typeof value === "string" &&
      value.trim().length > 0 &&
      (best === null || value.length > best.length)
    ) {
      best = value;
    }
  }
  return best !== null ? `${block.name}: ${best}` : block.name;
}

/**
 * Find the newest `tool_use` block whose name matches `toolName`, scanning the
 * tail backwards. Matching on the pending tool's name (rather than blindly
 * taking the last tool_use) keeps the rendered body describing the call the
 * permission is actually for — a later, already-resolved tool_use of a
 * different name must never masquerade as the thing being approved. Returns
 * null when `toolName` is absent or no matching block is found.
 */
function pendingToolUse(
  entries: LogEntry[],
  toolName: string | null,
): ToolUseBlock | null {
  if (!toolName) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "assistant") continue;
    const content = (entry as AssistantLogEntry).message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block && block.type === "tool_use") {
        const toolUse = block as ToolUseBlock;
        if (toolUse.name === toolName) return toolUse;
      }
    }
  }
  return null;
}

/** Find the last assistant text block across parsed entries. */
function lastAssistantText(entries: LogEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const texts = claudeEntryTexts(entries[i]);
    if (texts.length === 0) continue;
    for (let j = texts.length - 1; j >= 0; j--) {
      if (texts[j].role === "assistant") return texts[j].text;
    }
  }
  return null;
}

/**
 * Build a plain-text body enrichment for a waiting `session`, or null when
 * there's nothing to add. v2 supports Claude transcripts only (others return
 * null); `permission` waits render the pending tool + its salient input,
 * `question` waits render the last assistant message.
 */
export async function buildNotificationContext(
  session: NotifyContextSession,
): Promise<string | null> {
  if (session.agentType !== "claude" || !session.logPath) return null;
  if (
    session.attentionType !== "permission" &&
    session.attentionType !== "question"
  ) {
    return null;
  }

  try {
    const content = await readTranscriptTail(
      session.logPath,
      CONTEXT_TAIL_BYTES,
    );
    const entries = parseLogEntries(content);

    if (session.attentionType === "permission") {
      const block = pendingToolUse(entries, session.pendingTool);
      if (!block) return null;
      return clampBody(describeToolInput(block));
    }

    const text = lastAssistantText(entries);
    if (text === null) return null;
    return clampBody(text);
  } catch {
    return null;
  }
}
