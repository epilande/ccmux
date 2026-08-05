/**
 * Antigravity transcript reader. Marker `transcript_path` is wired to
 * `session.logPath` VERBATIM (usually `.../logs/transcript.jsonl`) with no
 * pre-resolution — this reader owns full-vs-plain resolution AT READ TIME:
 * if the path's basename is `transcript.jsonl` and a sibling
 * `transcript_full.jsonl` exists next to it, that sibling is read instead
 * (the two differ in `tool_calls.args` quoting; the plain file may be all
 * that exists yet when the marker is first wired, so resolving at read time
 * rather than once, at wiring time, matters).
 *
 * Line shape: `{step_index, source, type, status, created_at, content,
 * tool_calls?, thinking?}`. A completed reply is `type: "PLANNER_RESPONSE"`,
 * `source: "MODEL"`, `status: "DONE"`, plain-string `content`. A
 * PLANNER_RESPONSE that instead invokes tools carries `content: null` and a
 * populated `tool_calls[]` (verified live: a tool-only response is the
 * transcript's trailing entry when the agent's last visible act was running
 * a command); the plain-string check alone already skips it, walking back to
 * the last one that has real text. User turns are `type: "USER_INPUT"`,
 * `<USER_REQUEST>...</USER_REQUEST>`-wrapped (their content also carries
 * `<ADDITIONAL_METADATA>` and other sidecar blocks that are dropped).
 *
 * Everything else — `CONVERSATION_HISTORY`, `CHECKPOINT`, `ERROR_MESSAGE`,
 * `GENERIC`, and the tool-typed lines (`RUN_COMMAND`, `VIEW_FILE`, ...) — is
 * skipped. `created_at` is second-granularity, which the contract tolerates.
 */

import { basename, dirname, join } from "path";
import type { LineMeaning, TranscriptReader } from "../transcript-read";
import { SKIP_LINE, foldJsonlTurns } from "../transcript-read";

const FULL_TRANSCRIPT_NAME = "transcript_full.jsonl";
const PLAIN_TRANSCRIPT_NAME = "transcript.jsonl";

const USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;

/** Prefer the sibling `transcript_full.jsonl` when the marker points at the
 *  plain file and the full one exists; otherwise read the path as given. */
async function resolveTranscriptPath(path: string): Promise<string> {
  if (basename(path) !== PLAIN_TRANSCRIPT_NAME) return path;
  const fullPath = join(dirname(path), FULL_TRANSCRIPT_NAME);
  try {
    if (await Bun.file(fullPath).exists()) return fullPath;
  } catch {
    // fall through to the plain path
  }
  return path;
}

export function classifyAntigravityLine(entry: unknown): LineMeaning {
  if (!entry || typeof entry !== "object") return SKIP_LINE;
  const record = entry as {
    type?: unknown;
    status?: unknown;
    source?: unknown;
    created_at?: unknown;
    content?: unknown;
  };
  const timestamp =
    typeof record.created_at === "string" ? record.created_at : undefined;

  if (
    record.type === "PLANNER_RESPONSE" &&
    record.source === "MODEL" &&
    record.status === "DONE"
  ) {
    const text = record.content;
    if (typeof text !== "string" || !text.trim()) return SKIP_LINE; // tool-call-only step
    return { kind: "assistant", text, timestamp };
  }

  if (record.type === "USER_INPUT") {
    const raw = record.content;
    if (typeof raw !== "string") return SKIP_LINE;
    const match = raw.match(USER_REQUEST_RE);
    const text = (match ? match[1] : raw).trim();
    if (!text) return SKIP_LINE;
    return { kind: "user", text, timestamp };
  }

  return SKIP_LINE;
}

export const antigravityTranscriptReader: TranscriptReader = {
  agentType: "antigravity",
  async read(session, turns) {
    if (!session.logPath) return null;
    const path = await resolveTranscriptPath(session.logPath);
    return foldJsonlTurns(path, turns, classifyAntigravityLine);
  },
};
