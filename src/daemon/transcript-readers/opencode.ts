/**
 * OpenCode transcript reader. Unlike the other five, this is not a file tail:
 * OpenCode's own state lives in a hot, WAL-mode SQLite database
 * (`~/.local/share/opencode/opencode.db`, `OPENCODE_DB_FILE`), opened
 * READ-ONLY (`bun:sqlite`, `{ readonly: true }`) and closed before `read()`
 * returns. A busy/locked open or query is treated the same as "nothing to
 * read" (null, pane fallback) rather than retried against a live writer.
 *
 * Schema: `message(id, session_id, time_created, data)` where `data` is a
 * JSON blob with `role`; `part(id, message_id, session_id, time_created,
 * data)` where `data.type` is `text | reasoning | tool | step-start |
 * step-finish | patch`. A message is ALL of one turn's steps (including any
 * tool round-trip), not one line per fragment: its `text` parts, joined in
 * `time_created` order, are the turn's content, and a `step-finish` part
 * with `reason: "stop"` among that SAME message's parts is what marks the
 * turn complete — a message still missing that part is mid-turn and is
 * skipped entirely, the SQL analogue of the JSONL readers' "unanswered
 * prompt" rule. Tool/reasoning parts are separate rows a text-only query
 * never has to pay for.
 *
 * Session mapping: one ccmux row can aggregate N server-side OpenCode
 * sessions (`ambiguousWait`). `session.nativeSessionId`, when present, picks
 * the exact one. When absent, this reader falls back to the `session` row
 * (which carries `directory`, OpenCode's own cwd) whose most recent
 * ASSISTANT message is newest among every session sharing the ccmux row's
 * cwd — a heuristic, not a guarantee, and a known soft spot: an aggregated
 * row's OTHER concurrent session could be the one the caller actually wants.
 */

import { Database } from "bun:sqlite";
import { OPENCODE_DB_FILE } from "../../lib/config";
import type {
  TranscriptReader,
  TranscriptResult,
  TranscriptTurn,
} from "../transcript-read";
import { MAX_LINE_BYTES, capText } from "../transcript-read";

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  data: string;
}

interface ParsedPart {
  type?: unknown;
  text?: unknown;
  reason?: unknown;
}

function parsePart(row: PartRow): ParsedPart | null {
  try {
    const parsed = JSON.parse(row.data);
    return parsed && typeof parsed === "object" ? (parsed as ParsedPart) : null;
  } catch {
    return null;
  }
}

/** Join a message's `text` parts, applying the same oversized-fragment skip
 *  the JSONL fold applies to oversized raw lines. */
function collectText(parts: ParsedPart[]): {
  text: string;
  truncated: boolean;
} {
  let truncated = false;
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type !== "text") continue;
    if (typeof part.text !== "string" || part.text.length === 0) continue;
    if (part.text.length > MAX_LINE_BYTES) {
      truncated = true;
      continue;
    }
    chunks.push(part.text);
  }
  return { text: chunks.join("\n\n"), truncated };
}

function hasStopFinish(parts: ParsedPart[]): boolean {
  return parts.some((p) => p.type === "step-finish" && p.reason === "stop");
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Resolve which `session` row to read: the caller's `nativeSessionId` when
 *  known, else the newest-assistant-activity session sharing its cwd. */
function resolveSessionId(
  db: Database,
  nativeSessionId: string | undefined,
  cwd: string,
): string | null {
  if (nativeSessionId) return nativeSessionId;

  const candidates = db
    .query<
      { id: string },
      [string]
    >("SELECT id FROM session WHERE directory = ?")
    .all(cwd);
  if (candidates.length === 0) return null;

  const placeholders = candidates.map(() => "?").join(",");
  const rows = db
    .query<
      { session_id: string; data: string; time_created: number },
      string[]
    >(
      `SELECT session_id, data, time_created FROM message
       WHERE session_id IN (${placeholders})
       ORDER BY time_created DESC
       LIMIT 200`,
    )
    .all(...candidates.map((c) => c.id));

  for (const row of rows) {
    try {
      const data = JSON.parse(row.data);
      if (data && typeof data === "object" && data.role === "assistant") {
        return row.session_id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function readOpenCodeSession(
  db: Database,
  sessionId: string,
  turns: number,
): TranscriptResult | null {
  const messages = db
    .query<
      MessageRow,
      [string]
    >("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC")
    .all(sessionId);

  const partsStmt = db.query<PartRow, [string]>(
    "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC",
  );

  // Built newest-first, reversed at the end — same shape as foldJsonlTurns,
  // and deliberately mirroring its held-user state machine: a message row is
  // already a complete unit (unlike a JSONL line, nothing accumulates), but
  // pairing a user prompt with "the newer of the two adjacent accepted
  // assistant turns" needs the same care. `awaitingUser` is true only in the
  // window right after accepting an assistant turn and before its own
  // preceding prompt has been found; a user row seen OUTSIDE that window
  // (before any turn has been accepted yet — a trailing unanswered prompt —
  // or one already consumed) is invisible, exactly like `flushAssistant`
  // returning false leaves `heldUser` untouched in the JSONL fold. Without
  // this, a trailing INCOMPLETE turn's own prompt could otherwise drift
  // sideways and get attached to an older, unrelated accepted turn.
  const out: TranscriptTurn[] = [];
  let heldUser: TranscriptTurn | null = null;
  let awaitingUser = false;
  let assistantCount = 0;
  let truncated = false;

  for (const message of messages) {
    let data: { role?: unknown };
    try {
      data = JSON.parse(message.data);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;

    const parts = partsStmt
      .all(message.id)
      .map(parsePart)
      .filter((p): p is ParsedPart => p !== null);

    if (data.role === "assistant") {
      if (!hasStopFinish(parts)) continue; // mid-turn / aborted: not completed
      const collected = collectText(parts);
      if (collected.truncated) truncated = true;
      if (!collected.text) continue;
      const capped = capText(collected.text);
      if (capped.truncated) truncated = true;
      if (heldUser) {
        out.push(heldUser);
        heldUser = null;
      }
      out.push({
        role: "assistant",
        text: capped.text,
        timestamp: toIso(message.time_created),
      });
      assistantCount++;
      awaitingUser = true;
      if (assistantCount >= turns) break;
    } else if (data.role === "user") {
      if (!awaitingUser) continue; // no accepted-but-unpaired turn to attach to
      const collected = collectText(parts);
      if (collected.truncated) truncated = true;
      if (!collected.text) continue; // blank prompt: invisible, keep awaiting
      const capped = capText(collected.text);
      if (capped.truncated) truncated = true;
      heldUser = {
        role: "user",
        text: capped.text,
        timestamp: toIso(message.time_created),
      };
      awaitingUser = false;
    }
  }

  if (out.length === 0) return null;
  out.reverse();
  return { turns: out, truncated };
}

/**
 * Core implementation, taking the db path explicitly so tests can point it at
 * a fixture database instead of the real `OPENCODE_DB_FILE`.
 */
export async function readOpenCodeTranscript(
  dbPath: string,
  session: { nativeSessionId?: string; cwd: string },
  turns: number,
): Promise<TranscriptResult | null> {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true, strict: true });
  } catch {
    return null; // no db, or busy/locked opening it
  }
  try {
    const sessionId = resolveSessionId(
      db,
      session.nativeSessionId,
      session.cwd,
    );
    if (!sessionId) return null;
    return readOpenCodeSession(db, sessionId, turns);
  } catch {
    return null; // a query against a live WAL writer failed
  } finally {
    db.close();
  }
}

export const opencodeTranscriptReader: TranscriptReader = {
  agentType: "opencode",
  read(session, turns) {
    return readOpenCodeTranscript(OPENCODE_DB_FILE, session, turns);
  },
};
