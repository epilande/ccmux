/**
 * On-demand full-transcript search for Claude and Codex sessions.
 *
 * The daemon keeps only a bounded prompt index in memory (see `appendPrompt`);
 * this module reads the live transcript file on demand so a search can match
 * ANY user or assistant text in the session, not just the recent prompts.
 * Pure logic plus one bounded, tail-limited file read per session.
 */

import { parseLogEntries } from "./parser";
import { parseEntries as parseCodexEntries } from "./adapters/codex/parse";
import type { CodexEntry } from "./adapters/codex/parse";
import type {
  LogEntry,
  AssistantLogEntry,
  UserLogEntry,
  TextBlock,
} from "../types";

/** Only the last N bytes of a transcript are scanned (a long-running session's
 *  rollout can be many MB; matching the whole thing per keystroke is wasteful). */
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Cap on matches returned per session (the row only needs a why-it-matched hint). */
const MAX_TRANSCRIPT_MATCHES = 5;
/**
 * The snippet window is asymmetric: a small LEADING radius keeps the matched
 * term near the snippet start (~first 25 chars) so a narrow TUI row box can't
 * clip it off before the match, and a larger TRAILING radius supplies the rest
 * of the context. Total (~160) mirrors the old symmetric 80+80.
 */
const SNIPPET_LEAD_RADIUS = 24;
const SNIPPET_TRAIL_RADIUS = 136;

/** Shortest query the transcript search will run for (shared with the server). */
export const MIN_QUERY_LEN = 2;
/** How many sessions to search concurrently (bounds open FDs / parse work). */
export const SEARCH_CONCURRENCY = 8;

export interface TranscriptMatch {
  role: "user" | "assistant";
  snippet: string;
  timestamp?: string;
}

export interface SessionMatches {
  sessionId: string;
  matches: TranscriptMatch[];
}

interface RoleText {
  role: "user" | "assistant";
  text: string;
}

/**
 * Extract the searchable user/assistant text from a Claude log entry. User
 * string content is a prompt; assistant `text` blocks are turn text. Tool
 * calls, tool results (array-form user turns), and thinking blocks carry no
 * conversational text and are skipped.
 */
export function claudeEntryTexts(entry: LogEntry): RoleText[] {
  // Shape guards throughout: a JSON-valid but schema-invalid line (a user
  // entry with no `message`, a non-array assistant `content`, etc.) must
  // yield [] rather than throw, so one bad line can't drop a whole session's
  // matches in `searchTranscript`.
  // A JSON primitive line (a bare `null`, number, or boolean) parses to a
  // non-object entry; guard before reading `entry.type` so one such line
  // yields [] rather than throwing and dropping the whole session.
  if (!entry || typeof entry !== "object") return [];
  if (entry.type === "user") {
    const message = (entry as UserLogEntry).message;
    const content = message?.content;
    // Array-form user turns are tool results, not user text.
    if (typeof content !== "string") return [];
    return [{ role: "user", text: content }];
  }
  if (entry.type === "assistant") {
    const content = (entry as AssistantLogEntry).message?.content;
    if (!Array.isArray(content)) return [];
    const texts: RoleText[] = [];
    for (const block of content) {
      if (block && block.type === "text") {
        const text = (block as TextBlock).text;
        if (typeof text === "string" && text.length > 0) {
          texts.push({ role: "assistant", text });
        }
      }
      // tool_use, thinking, redacted_thinking, etc. carry no user-facing text.
    }
    return texts;
  }
  return [];
}

/**
 * Extract the searchable user/assistant text from a Codex rollout entry.
 * `user_message` is a prompt; `agent_message` is the assistant's turn text.
 * Reasoning, token-count, and tool events are skipped.
 */
export function codexEntryTexts(entry: CodexEntry): RoleText[] {
  if (entry.type !== "event_msg") return [];
  const { payload } = entry;
  // A malformed line can carry a null / non-object payload; guard before
  // reading `payload.type` so a bad line yields [] instead of throwing.
  if (!payload || typeof payload !== "object") return [];
  if (payload.type === "user_message" || payload.type === "agent_message") {
    const message = "message" in payload ? payload.message : undefined;
    if (typeof message === "string" && message.length > 0) {
      return [
        {
          role: payload.type === "user_message" ? "user" : "assistant",
          text: message,
        },
      ];
    }
  }
  return [];
}

/**
 * Build a single-line snippet around the first match of `lowerQuery` in
 * `text`: `leadRadius` chars before the match and `trailRadius` after, with
 * `…` affixes when clipped. The asymmetric window keeps the matched term near
 * the start so a narrow row can't clip it off. `text` is the original (cased)
 * text; `lowerQuery` is pre-lowercased. Returns null when not present.
 */
function buildSnippet(
  text: string,
  lowerQuery: string,
  leadRadius: number,
  trailRadius: number,
): string | null {
  const idx = text.toLowerCase().indexOf(lowerQuery);
  if (idx === -1) return null;

  const start = Math.max(0, idx - leadRadius);
  const end = Math.min(text.length, idx + lowerQuery.length + trailRadius);
  let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}

/** Read the tail of a transcript, discarding a partial first line when the
 *  file was larger than the window (same idiom as `readLogTail`). */
export async function readTranscriptTail(
  path: string,
  maxBytes: number,
): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  if (size <= maxBytes) {
    return file.text();
  }
  const tail = await file.slice(size - maxBytes).text();
  const firstNewline = tail.indexOf("\n");
  return firstNewline === -1 ? "" : tail.slice(firstNewline + 1);
}

/**
 * True when the query contains a character that JSON escapes into a longer
 * sequence in the raw transcript file: a double-quote, a backslash, or a C0
 * control (U+0000-U+001F). A raw-bytes substring scan would false-negative
 * against the parsed/unescaped text the matcher uses for those, so the
 * pre-filter is skipped and the full parse runs instead. Default serializers
 * (Claude JSON.stringify, Codex serde_json) emit non-ASCII and "/" literally,
 * so those stay eligible for the fast path.
 */
function queryHasJsonEscapedChar(query: string): boolean {
  for (let i = 0; i < query.length; i++) {
    const c = query.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c <= 0x1f) return true;
  }
  return false;
}

/**
 * Search a single session's transcript for `query` (already lowercased by the
 * caller). Returns up to `maxMatches` snippets, or null when the session isn't
 * a supported transcript-backed agent, has no log path, or the read/parse
 * fails. A session with a log path but no textual match returns an empty
 * `matches` array.
 */

export async function searchTranscript(
  sess: { id: string; agentType: string; logPath: string | null },
  query: string,
  opts: {
    maxBytes?: number;
    maxMatches?: number;
    leadRadius?: number;
    trailRadius?: number;
  } = {},
): Promise<SessionMatches | null> {
  const maxBytes = opts.maxBytes ?? MAX_TRANSCRIPT_BYTES;
  const maxMatches = opts.maxMatches ?? MAX_TRANSCRIPT_MATCHES;
  const leadRadius = opts.leadRadius ?? SNIPPET_LEAD_RADIUS;
  const trailRadius = opts.trailRadius ?? SNIPPET_TRAIL_RADIUS;

  if (sess.agentType !== "claude" && sess.agentType !== "codex") return null;
  if (!sess.logPath) return null;

  try {
    const content = await readTranscriptTail(sess.logPath, maxBytes);

    // Cheap pre-filter: skip the full per-line JSON.parse when the raw tail
    // can't contain the query at all. Matching runs on parsed/unescaped text,
    // so a raw-bytes `includes` is only sound when the query holds no chars
    // that JSON escapes (`"`, `\`, C0 controls): those serialize to a
    // multi-char escape in the raw file, so a raw scan could false-negative a
    // real match. When the query does contain one, fall through to the parse.
    // (A false positive from a raw hit in JSON keys/tool output is harmless:
    // the parse then finds no textual match and returns [].)
    if (
      !queryHasJsonEscapedChar(query) &&
      !content.toLowerCase().includes(query)
    ) {
      return { sessionId: sess.id, matches: [] };
    }

    const matches: TranscriptMatch[] = [];

    if (sess.agentType === "claude") {
      const entries: LogEntry[] = parseLogEntries(content);
      for (const entry of entries) {
        for (const { role, text } of claudeEntryTexts(entry)) {
          const snippet = buildSnippet(text, query, leadRadius, trailRadius);
          if (snippet) {
            matches.push({ role, snippet, timestamp: entry.timestamp });
            if (matches.length >= maxMatches) {
              return { sessionId: sess.id, matches };
            }
          }
        }
      }
    } else {
      const entries = parseCodexEntries(content);
      for (const entry of entries) {
        for (const { role, text } of codexEntryTexts(entry)) {
          const snippet = buildSnippet(text, query, leadRadius, trailRadius);
          if (snippet) {
            matches.push({ role, snippet, timestamp: entry.timestamp });
            if (matches.length >= maxMatches) {
              return { sessionId: sess.id, matches };
            }
          }
        }
      }
    }

    return { sessionId: sess.id, matches };
  } catch {
    return null;
  }
}
