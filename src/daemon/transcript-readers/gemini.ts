/**
 * Gemini CLI transcript reader. No hooks, no marker, no `logPath` — this
 * reader locates the transcript itself from `session.cwd` (see
 * `GEMINI_TMP_DIR`'s doc comment for the discovery scheme) and reads the
 * WHOLE file as one JSON document rather than tailing it: real transcripts
 * are small (largest observed message 747 chars; no tool data is recorded
 * at all), so there is no backwards line walk here.
 *
 * File shape: `{sessionId, projectHash, startTime, lastUpdated, messages[]}`,
 * rewritten in place while live (mtime tracks `lastUpdated`). A completed
 * reply is `messages[]` entry `type: "gemini"` with a plain-string
 * `content`; `info`/`error` entries are skipped.
 *
 * Format drift found vs the research notes (2026-08-03): the notes describe
 * a user entry's `content` as a JSON-STRINGIFIED array needing a second
 * `JSON.parse`. Every real sample checked here (spanning Feb-Aug 2026, one
 * as recent as today) instead carries a native array of `{text}` objects,
 * never a string. Both are handled defensively (string content is parsed as
 * JSON, falling back to using it verbatim if that fails) since the
 * documented shape may still appear on another machine or CLI version.
 */

import { readdir } from "fs/promises";
import { join } from "path";
import { GEMINI_TMP_DIR } from "../../lib/config";
import type {
  TranscriptReader,
  TranscriptResult,
  TranscriptTurn,
} from "../transcript-read";
import { capText } from "../transcript-read";

interface GeminiMessage {
  id?: unknown;
  timestamp?: unknown;
  type?: unknown;
  content?: unknown;
}

interface GeminiSessionFile {
  messages?: unknown;
}

/** Find the project dir under `tmpRoot` whose `.project_root` sidecar equals
 *  `cwd` exactly, scanning every entry rather than guessing from the dir
 *  name (dedupe suffixes make the name untrustworthy). */
async function findProjectDir(
  tmpRoot: string,
  cwd: string,
): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(tmpRoot);
  } catch {
    return null;
  }
  for (const name of entries) {
    const dir = join(tmpRoot, name);
    let root: string;
    try {
      root = (await Bun.file(join(dir, ".project_root")).text()).trim();
    } catch {
      continue;
    }
    if (root === cwd) return dir;
  }
  return null;
}

/** The newest `chats/session-*.json` in a project dir by mtime, or null if
 *  there are none. */
async function findNewestChatFile(projectDir: string): Promise<string | null> {
  const chatsDir = join(projectDir, "chats");
  let entries: string[];
  try {
    entries = await readdir(chatsDir);
  } catch {
    return null;
  }
  const candidates = entries.filter(
    (name) => name.startsWith("session-") && name.endsWith(".json"),
  );
  if (candidates.length === 0) return null;

  let newestPath: string | null = null;
  let newestMtime = -Infinity;
  for (const name of candidates) {
    const path = join(chatsDir, name);
    const mtime = Bun.file(path).lastModified;
    if (Number.isFinite(mtime) && mtime > newestMtime) {
      newestMtime = mtime;
      newestPath = path;
    }
  }
  return newestPath;
}

/** User `content` is normally a native array of `{text}` blocks; the
 *  research notes describe a JSON-stringified variant, handled defensively. */
function extractUserText(content: unknown): string {
  let blocks: unknown = content;
  if (typeof content === "string") {
    try {
      blocks = JSON.parse(content);
    } catch {
      return content.trim();
    }
  }
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n").trim();
}

function foldGeminiTurns(
  messages: GeminiMessage[],
  turns: number,
): TranscriptResult | null {
  // See `readOpenCodeSession`'s comment for why `awaitingUser` exists: a
  // trailing UNANSWERED user message (sent, gemini hasn't replied yet) must
  // not drift sideways and get attached to an older, unrelated reply.
  const out: TranscriptTurn[] = [];
  let heldUser: TranscriptTurn | null = null;
  let awaitingUser = false;
  let assistantCount = 0;
  let truncated = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const timestamp =
      typeof message.timestamp === "string" ? message.timestamp : undefined;

    if (message.type === "gemini") {
      const text =
        typeof message.content === "string" ? message.content.trim() : "";
      if (!text) continue;
      const capped = capText(text);
      if (capped.truncated) truncated = true;
      if (heldUser) {
        out.push(heldUser);
        heldUser = null;
      }
      out.push(
        timestamp
          ? { role: "assistant", text: capped.text, timestamp }
          : { role: "assistant", text: capped.text },
      );
      assistantCount++;
      awaitingUser = true;
      if (assistantCount >= turns) break;
    } else if (message.type === "user") {
      if (!awaitingUser) continue; // no accepted-but-unpaired turn to attach to
      const text = extractUserText(message.content);
      if (!text) continue; // blank prompt: invisible, keep awaiting
      const capped = capText(text);
      if (capped.truncated) truncated = true;
      heldUser = timestamp
        ? { role: "user", text: capped.text, timestamp }
        : { role: "user", text: capped.text };
      awaitingUser = false;
    }
    // else: "info" / "error" / anything else — skip
  }

  if (out.length === 0) return null;
  out.reverse();
  return { turns: out, truncated };
}

/**
 * Core implementation, taking the tmp root explicitly so tests can point it
 * at a fixture tree instead of the real `GEMINI_TMP_DIR`.
 */
export async function readGeminiTranscript(
  tmpRoot: string,
  session: { cwd: string },
  turns: number,
): Promise<TranscriptResult | null> {
  const projectDir = await findProjectDir(tmpRoot, session.cwd);
  if (!projectDir) return null;
  const chatFile = await findNewestChatFile(projectDir);
  if (!chatFile) return null;

  let parsed: GeminiSessionFile;
  try {
    parsed = (await Bun.file(chatFile).json()) as GeminiSessionFile;
  } catch {
    return null; // missing, unreadable, or mid-rewrite invalid JSON
  }
  if (!Array.isArray(parsed.messages)) return null;
  return foldGeminiTurns(parsed.messages as GeminiMessage[], turns);
}

export const geminiTranscriptReader: TranscriptReader = {
  agentType: "gemini",
  read(session, turns) {
    return readGeminiTranscript(GEMINI_TMP_DIR, session, turns);
  },
};
