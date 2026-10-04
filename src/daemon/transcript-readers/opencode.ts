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
 * OpenCode 2 writes the same database but its own tables: a session found
 * in `session_v2` is read from `session_message` instead (one row per user
 * prompt, assistant step and turn-ending `idle`; see `openCode2Candidates`).
 * Both schemas feed the same `foldTurns`.
 *
 * Session mapping: one ccmux row can aggregate N server-side OpenCode
 * sessions (`ambiguousWait`). `session.nativeSessionId`, when present, picks
 * the exact one. When absent, this reader falls back to the `session` row
 * (which carries `directory`, OpenCode's own cwd) whose most recent
 * ASSISTANT message is newest among every session sharing the ccmux row's
 * cwd — a heuristic, not a guarantee, and a known soft spot: an aggregated
 * row's OTHER concurrent session could be the one the caller actually wants.
 * The fallback yields nothing once the cwd has newer OpenCode 2 activity
 * (see `newestOpenCode2Activity`).
 */

import { Database } from "bun:sqlite";
import { parseMajorVersion } from "../../lib/agents";
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
  version: string | null | undefined,
): string | null {
  if (nativeSessionId) return nativeSessionId;
  // The fallback only knows 1.x tables, so for a pane known to run 2.x any
  // session it finds is stale 1.x history, not what the pane is showing.
  const major = parseMajorVersion(version);
  if (major !== null && major >= 2) return null;

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
        return newestOpenCode2Activity(db, cwd) >= row.time_created
          ? null
          : row.session_id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Newest `time_updated` among the cwd's OpenCode 2 sessions, or -Infinity
 * when there are none (or no `session_v2` table, i.e. 1.x never upgraded).
 *
 * OpenCode 2 writes its sessions to `session_v2`/`session_message` in the
 * same database and leaves the 1.x tables behind (issue #214). This reader
 * only reads the 1.x tables, so once the cwd has a newer 2.x session its
 * newest 1.x session is stale history rather than what the pane is running,
 * and handing it to `ccmux handoff` would relay the wrong conversation.
 * Returning null instead lets `ccmux last` fall back to the pane capture.
 *
 * This is the second line of defense, behind the session's own version:
 * 2.x advances `time_updated` when a prompt is queued but not on replies or
 * turn completion, so an older 2.x session resumed after newer 1.x use in
 * the same cwd reads as older here until its first new prompt.
 */
function newestOpenCode2Activity(db: Database, cwd: string): number {
  try {
    const row = db
      .query<
        { newest: number | null },
        [string]
      >("SELECT MAX(time_updated) AS newest FROM session_v2 WHERE directory = ?")
      .get(cwd);
    return row?.newest ?? -Infinity;
  } catch {
    return -Infinity;
  }
}

/** One message offered to `foldTurns`, newest first. */
interface TurnCandidate {
  role: "user" | "assistant";
  text: string;
  /** An oversized fragment was skipped while collecting `text`. */
  truncated: boolean;
  /** Epoch ms. */
  time: number;
}

/**
 * Pair the newest `turns` completed assistant replies with their prompts.
 * Callers yield only COMPLETED assistant turns, newest first, with every
 * user prompt in between.
 *
 * Built newest-first, reversed at the end — same shape as foldJsonlTurns,
 * and deliberately mirroring its held-user state machine: a message row is
 * already a complete unit (unlike a JSONL line, nothing accumulates), but
 * pairing a user prompt with "the newer of the two adjacent accepted
 * assistant turns" needs the same care. `awaitingUser` is true only in the
 * window right after accepting an assistant turn and before its own
 * preceding prompt has been found; a user row seen OUTSIDE that window
 * (before any turn has been accepted yet — a trailing unanswered prompt —
 * or one already consumed) is invisible, exactly like `flushAssistant`
 * returning false leaves `heldUser` untouched in the JSONL fold. Without
 * this, a trailing INCOMPLETE turn's own prompt could otherwise drift
 * sideways and get attached to an older, unrelated accepted turn.
 */
function foldTurns(
  candidates: Iterable<TurnCandidate>,
  turns: number,
): TranscriptResult | null {
  const out: TranscriptTurn[] = [];
  let heldUser: TranscriptTurn | null = null;
  let awaitingUser = false;
  let assistantCount = 0;
  let truncated = false;

  for (const candidate of candidates) {
    if (candidate.role === "assistant") {
      if (candidate.truncated) truncated = true;
      if (!candidate.text) continue;
      const capped = capText(candidate.text);
      if (capped.truncated) truncated = true;
      if (heldUser) {
        out.push(heldUser);
        heldUser = null;
      }
      out.push({
        role: "assistant",
        text: capped.text,
        timestamp: toIso(candidate.time),
      });
      assistantCount++;
      awaitingUser = true;
      if (assistantCount >= turns) break;
    } else {
      if (!awaitingUser) continue; // no accepted-but-unpaired turn to attach to
      if (candidate.truncated) truncated = true;
      if (!candidate.text) continue; // blank prompt: invisible, keep awaiting
      const capped = capText(candidate.text);
      if (capped.truncated) truncated = true;
      heldUser = {
        role: "user",
        text: capped.text,
        timestamp: toIso(candidate.time),
      };
      awaitingUser = false;
    }
  }

  if (out.length === 0) return null;
  out.reverse();
  return { turns: out, truncated };
}

/** OpenCode 1.x: `message` rows with their `part` rows, newest first. */
function* openCodeCandidates(
  db: Database,
  sessionId: string,
): Generator<TurnCandidate> {
  const messages = db
    .query<
      MessageRow,
      [string]
    >("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC")
    .all(sessionId);

  const partsStmt = db.query<PartRow, [string]>(
    "SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC",
  );

  for (const message of messages) {
    let data: { role?: unknown };
    try {
      data = JSON.parse(message.data);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;
    if (data.role !== "assistant" && data.role !== "user") continue;

    // Parts are read lazily, so a fold that stops early stops querying.
    const parts = partsStmt
      .all(message.id)
      .map(parsePart)
      .filter((p): p is ParsedPart => p !== null);
    // Mid-turn / aborted: not completed.
    if (data.role === "assistant" && !hasStopFinish(parts)) continue;
    yield { role: data.role, ...collectText(parts), time: message.time_created };
  }
}

/**
 * OpenCode 2.x: `session_message` rows (`type` + JSON `data`), newest first.
 * A turn is every row since the previous `idle` row: usually a `user` row
 * and the `assistant` rows that answer it (one per model step, text in
 * `content[]` items of `type: "text"`), closed by an `idle` row whose
 * `outcome` is `succeeded` once it completes. A turn can also start with no
 * user row at all, from a `synthetic` row (a background subagent or shell
 * finishing), so a reply is emitted at the turn's boundary, not only at a
 * prompt. A turn that failed, was interrupted (a declined permission ends it
 * with no `idle` row at all), or is still running yields no assistant reply,
 * the analogue of 1.x's missing `step-finish`. Verified against rows written
 * by OpenCode 2.0.21.
 */
function* openCode2Candidates(
  db: Database,
  sessionId: string,
): Generator<TurnCandidate> {
  const rows = db
    .query<
      { type: string; time_created: number; data: string },
      [string]
    >("SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq DESC")
    .all(sessionId);

  let completed = false;
  let replyTime = 0;
  let reply: ParsedPart[][] = [];

  /** The completed reply gathered since the newer boundary, if any. */
  const pendingReply = (): TurnCandidate | null =>
    completed && reply.length > 0
      ? {
          role: "assistant",
          // Newest step first; reversed so the text reads in order.
          ...collectText(reply.reverse().flat()),
          time: replyTime,
        }
      : null;

  for (const row of rows) {
    let data: { text?: unknown; content?: unknown; outcome?: unknown };
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!data || typeof data !== "object") continue;

    if (row.type === "idle") {
      // The previous turn's end is this turn's start: a reply gathered with
      // no user row in between belongs to a synthetic-started turn.
      const turn = pendingReply();
      if (turn) yield turn;
      completed = data.outcome === "succeeded";
      reply = [];
      replyTime = 0;
    } else if (row.type === "assistant") {
      if (!completed) continue;
      reply.push(Array.isArray(data.content) ? (data.content as ParsedPart[]) : []);
      replyTime = Math.max(replyTime, row.time_created);
    } else if (row.type === "user") {
      const turn = pendingReply();
      if (turn) yield turn;
      completed = false;
      reply = [];
      replyTime = 0;
      const text = typeof data.text === "string" ? data.text : "";
      yield {
        role: "user",
        ...collectText([{ type: "text", text }]),
        time: row.time_created,
      };
    }
  }
  // The oldest turn, when no user row precedes it.
  const turn = pendingReply();
  if (turn) yield turn;
}

/**
 * Which schema holds the session: OpenCode 2 sessions live in `session_v2`.
 * Routed by the id rather than by version, since 1.18 has a
 * `session_message` table of its own.
 */
function isOpenCode2Session(db: Database, sessionId: string): boolean {
  try {
    return (
      db
        .query<{ found: number }, [string]>(
          "SELECT 1 AS found FROM session_v2 WHERE id = ?",
        )
        .get(sessionId) !== null
    );
  } catch {
    return false; // no session_v2 table: a database 2.x never opened
  }
}

/**
 * Core implementation, taking the db path explicitly so tests can point it at
 * a fixture database instead of the real `OPENCODE_DB_FILE`.
 */
export async function readOpenCodeTranscript(
  dbPath: string,
  session: { nativeSessionId?: string; cwd: string; version?: string | null },
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
      session.version,
    );
    if (!sessionId) return null;
    return foldTurns(
      isOpenCode2Session(db, sessionId)
        ? openCode2Candidates(db, sessionId)
        : openCodeCandidates(db, sessionId),
      turns,
    );
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
