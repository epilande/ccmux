import { COPILOT_SESSION_STATE_DIR } from "../../../lib/config";
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
  permissionToolLabel,
  type CopilotEntry,
  type CopilotPermissionRequestData,
  type CopilotSessionStartData,
  type CopilotUserMessageData,
} from "./parse";

/**
 * Copilot events.jsonl lives one directory below the session-state root:
 * `session-state/<uuid>/events.jsonl`. Capture group 1 is the session UUID.
 */
const COPILOT_EVENTS_FILE_PATTERN =
  /session-state\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/events\.jsonl$/i;

function applyEntry(state: SessionState, entry: CopilotEntry): SessionState {
  const next: SessionState = { ...state, lastActivityAt: entry.timestamp };
  switch (entry.type) {
    case "session.start": {
      const data = entry.data as CopilotSessionStartData | undefined;
      return {
        ...next,
        cwd: data?.context?.cwd ?? next.cwd,
        version: data?.copilotVersion ?? next.version,
      };
    }
    case "user.message": {
      const data = entry.data as CopilotUserMessageData | undefined;
      const withInput: SessionState = {
        ...next,
        status: "working",
        attentionType: null,
        pendingTool: null,
        lastUserInputAt: entry.timestamp,
      };
      if (typeof data?.content === "string") {
        withInput.lastPrompt = data.content;
        withInput.prompts = appendPrompt(state.prompts, data.content);
      }
      return withInput;
    }
    case "assistant.turn_start":
    case "permission.completed":
      return {
        ...next,
        status: "working",
        attentionType: null,
        pendingTool: null,
      };
    case "permission.requested": {
      const data = entry.data as CopilotPermissionRequestData | undefined;
      return {
        ...next,
        status: "waiting",
        attentionType: "permission",
        pendingTool: permissionToolLabel(data?.permissionRequest?.kind),
      };
    }
    case "assistant.turn_end":
    case "session.shutdown":
    case "abort":
      return {
        ...next,
        status: "idle",
        attentionType: null,
        pendingTool: null,
      };
    default:
      return next;
  }
}

function applyEntries(
  prev: SessionState,
  entries: CopilotEntry[],
): SessionState {
  let state = prev;
  for (const entry of entries) {
    state = applyEntry(state, entry);
  }
  return state;
}

/**
 * Copilot has no Task-tool subagents and no parallel-tool tracking, so the
 * initial state is intentionally narrower than `createInitialState()` in
 * `status-machine.ts` (mirrors the Codex adapter).
 */
function createInitialCopilotState(): SessionState {
  return {
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
  };
}

/**
 * GitHub Copilot CLI log adapter.
 *
 * Copilot writes `~/.copilot/session-state/<uuid>/events.jsonl` incrementally
 * in real time. Status transitions come from the event stream:
 * `user.message` / `assistant.turn_start` → working; `permission.requested`
 * → waiting (permission); `permission.completed` → working;
 * `assistant.turn_end` / `session.shutdown` / `abort` → idle.
 *
 * Unlike its append-and-close `events.jsonl`, Copilot keeps
 * `session-state/<uuid>/session.db` open (lsof-discoverable); the no-hooks
 * native-id path uses that (see `COPILOT_SESSION_FILE_PATTERN`), not this
 * adapter.
 */
export class CopilotLogAdapter implements LogAdapter {
  readonly agentType = "copilot";
  readonly logDirGlob = COPILOT_SESSION_STATE_DIR;
  // events.jsonl sits two levels below the root
  // (`session-state/<uuid>/events.jsonl`). A bounded depth keeps Linux
  // inotify FD pressure flat as a user's history grows.
  readonly watchDepth = 2;

  resolveSessionIdFromPath(path: string): string | null {
    const match = path.match(COPILOT_EVENTS_FILE_PATTERN);
    return match ? match[1] : null;
  }

  parseSessionMetadata(firstLine: string): SessionMetadata | null {
    const entry = parseLine(firstLine);
    if (!entry || entry.type !== "session.start") return null;
    const data = entry.data as CopilotSessionStartData | undefined;
    const cwd = data?.context?.cwd;
    const sessionId = data?.sessionId;
    if (typeof sessionId !== "string" || typeof cwd !== "string") {
      return null;
    }
    const ts = Date.parse(data?.startTime ?? entry.timestamp ?? "");
    if (Number.isNaN(ts)) return null;
    return {
      nativeSessionId: sessionId,
      cwd,
      timestamp: ts,
      version: data?.copilotVersion,
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
      return { state: createInitialCopilotState(), newOffset: 0 };
    }
    const entries = parseEntries(content);
    const state = applyEntries(createInitialCopilotState(), entries);
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
