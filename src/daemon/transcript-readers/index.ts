/**
 * The transcript reader registry: the one place that says which agent types
 * can be read from their own transcript. Adding an agent is a new file next
 * to this one plus one entry below; nothing in the endpoint changes.
 *
 * An agent with no reader (or a reader that returns null) falls back to a
 * pane capture, which is what `readSessionTranscript` returning null means to
 * its caller.
 */

import type {
  TranscriptReader,
  TranscriptResult,
  TranscriptSession,
} from "../transcript-read";
import { antigravityTranscriptReader } from "./antigravity";
import { claudeTranscriptReader } from "./claude";
import { codexTranscriptReader } from "./codex";
import { copilotTranscriptReader } from "./copilot";
import { cursorTranscriptReader } from "./cursor";
import { geminiTranscriptReader } from "./gemini";
import { ompTranscriptReader } from "./omp";
import { opencodeTranscriptReader } from "./opencode";
import { piTranscriptReader } from "./pi";

const READERS: TranscriptReader[] = [
  claudeTranscriptReader,
  codexTranscriptReader,
  copilotTranscriptReader,
  cursorTranscriptReader,
  piTranscriptReader,
  ompTranscriptReader,
  antigravityTranscriptReader,
  opencodeTranscriptReader,
  geminiTranscriptReader,
];

export const BUILTIN_TRANSCRIPT_READERS: Map<string, TranscriptReader> =
  new Map(READERS.map((reader) => [reader.agentType, reader]));

/**
 * Read a session's last `turns` turns from its own transcript. Returns null
 * when the agent has no reader, the reader has nothing to read, or the read
 * throws (a live transcript can be rewritten mid-read); every one of those is
 * a "fall back to the pane" for the caller.
 */
export async function readSessionTranscript(
  session: TranscriptSession,
  turns: number,
  readers: Map<string, TranscriptReader> = BUILTIN_TRANSCRIPT_READERS,
): Promise<TranscriptResult | null> {
  const reader = readers.get(session.agentType);
  if (!reader) return null;
  try {
    return await reader.read(session, turns);
  } catch {
    return null;
  }
}
