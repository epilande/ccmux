import { join, basename } from "path";
import { CODEX_SESSION_FILE_PATTERN } from "../../../lib/agents";
import { CODEX_DIR } from "../../../lib/config";
import { appendPrompt } from "../../status-machine";
import type { SessionState } from "../../../types/session";
import type {
  FullDerivation,
  IncrementalDerivation,
  LogAdapter,
  SessionMetadata,
} from "../../log-adapter";
import {
  parseLine,
  parseEntries,
  type CodexEntry,
  type CodexSessionMetaPayload,
  type CodexEventPayload,
} from "./parse";

// Derived from CODEX_DIR so rollout discovery honors `$CODEX_HOME`, like the
// hooks/config paths.
const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");

function applySessionMeta(
  state: SessionState,
  payload: CodexSessionMetaPayload,
): SessionState {
  return {
    ...state,
    cwd: payload.cwd ?? state.cwd,
    version: payload.cli_version ?? state.version,
    gitBranch: payload.git?.branch ?? state.gitBranch,
  };
}

function applyEventMsg(
  state: SessionState,
  payload: CodexEventPayload,
  timestamp: string,
): SessionState {
  switch (payload.type) {
    case "task_started":
      return { ...state, status: "working" };
    case "task_complete":
    case "turn_aborted":
      return { ...state, status: "idle" };
    case "user_message": {
      const next: SessionState = { ...state, lastUserInputAt: timestamp };
      if ("message" in payload && typeof payload.message === "string") {
        next.lastPrompt = payload.message;
        next.prompts = appendPrompt(state.prompts, payload.message);
      }
      return next;
    }
    default:
      return state;
  }
}

function applyEntries(prev: SessionState, entries: CodexEntry[]): SessionState {
  let state = prev;
  for (const entry of entries) {
    state = { ...state, lastActivityAt: entry.timestamp };
    if (entry.type === "session_meta") {
      state = applySessionMeta(state, entry.payload);
    } else if (entry.type === "event_msg") {
      state = applyEventMsg(state, entry.payload, entry.timestamp);
    }
  }
  return state;
}

/**
 * Codex sessions have no Task-tool subagents and no parallel-tool tracking,
 * so the initial state is intentionally narrower than `createInitialState()`
 * in `status-machine.ts`.
 */
function createInitialCodexState(): SessionState {
  return {
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
  };
}

/**
 * Codex CLI log adapter.
 *
 * Codex rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) carry a
 * `session_meta` header line plus an event stream. Status transitions come
 * from `event_msg` payloads of type `task_started` / `task_complete` /
 * `turn_aborted`. `lastPrompt` comes from `user_message` events.
 *
 * Codex has no permission-asked event in the log; permission/waiting state
 * is layered on by the reconciler's terminal-rule overlay (Option Y).
 */
export class CodexLogAdapter implements LogAdapter {
  readonly agentType = "codex";
  readonly logDirGlob = CODEX_SESSIONS_DIR;
  // Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (4 levels
  // below the root). A bounded depth keeps Linux inotify FD pressure flat as
  // a user's history grows.
  readonly watchDepth = 4;

  resolveSessionIdFromPath(path: string): string | null {
    const match = basename(path).match(CODEX_SESSION_FILE_PATTERN);
    return match ? match[1] : null;
  }

  parseSessionMetadata(firstLine: string): SessionMetadata | null {
    const entry = parseLine(firstLine);
    if (!entry || entry.type !== "session_meta") return null;
    const { payload } = entry;
    if (
      typeof payload?.id !== "string" ||
      typeof payload?.cwd !== "string" ||
      typeof payload?.timestamp !== "string"
    ) {
      return null;
    }
    const ts = Date.parse(payload.timestamp);
    if (Number.isNaN(ts)) return null;
    return {
      nativeSessionId: payload.id,
      cwd: payload.cwd,
      timestamp: ts,
      version: payload.cli_version,
      gitBranch: payload.git?.branch,
    };
  }

  async deriveFullState(path: string): Promise<FullDerivation> {
    let content = "";
    let newOffset = 0;
    try {
      const file = Bun.file(path);
      content = await file.text();
      newOffset = file.size;
    } catch {
      return { state: createInitialCodexState(), newOffset: 0 };
    }
    const entries = parseEntries(content);
    const state = applyEntries(createInitialCodexState(), entries);
    return { state, newOffset };
  }

  async deriveIncrementalState(
    path: string,
    offset: number,
    prev: SessionState,
  ): Promise<IncrementalDerivation> {
    try {
      const file = Bun.file(path);
      const size = file.size;
      if (offset >= size) {
        return { state: prev, newOffset: offset, hasNewEntries: false };
      }
      const slice = await file.slice(offset).text();
      const lastNewline = slice.lastIndexOf("\n");
      if (lastNewline === -1) {
        return { state: prev, newOffset: offset, hasNewEntries: false };
      }
      const completeContent = slice.slice(0, lastNewline + 1);
      const entries = parseEntries(completeContent);
      const bytesConsumed = Buffer.byteLength(completeContent, "utf-8");
      const newOffset = offset + bytesConsumed;
      if (entries.length === 0) {
        return { state: prev, newOffset, hasNewEntries: false };
      }
      return {
        state: applyEntries(prev, entries),
        newOffset,
        hasNewEntries: true,
      };
    } catch {
      return { state: prev, newOffset: offset, hasNewEntries: false };
    }
  }
}
