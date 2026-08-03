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
  type CodexResponseItemPayload,
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

/**
 * Slack for the stale-output gate below. `statusChangedAt` is stamped by
 * the daemon when the marker's `waiting` won a cascade, which lands
 * milliseconds to a second AFTER the hook observed the request, and the
 * rollout's entry timestamps come from Codex's own clock. A genuine
 * resolving output from an instant auto-approval could therefore carry an
 * entry timestamp slightly older than the stamp; the slack keeps such
 * outputs flipping (fail open, today's behavior) at the cost of not
 * gating stale entries inside the window. Truly stale outputs belong to a
 * PRIOR call, separated from the wait by at least a model round-trip, so
 * they sit well outside 2s in practice.
 */
const STALE_OUTPUT_SLACK_MS = 2000;

/**
 * Tool OUTPUT items are the only in-log signal that a permission wait
 * resolved: Codex fires no hook on approval (manual or via its automatic
 * approval reviewer), and outputs are flushed only after the gated tool
 * ran. Without this flip, the marker-written `waiting` echoes through the
 * store-fed `prev` with a fresh timestamp every parse and pins the session
 * at waiting until end of turn. Request items and token_count are
 * deliberately NOT resolution evidence (they can flush while the prompt
 * is still up). A NEWER PermissionRequest still wins in the cascade: its
 * marker timestamp out-freshens this entry's lastActivityAt.
 *
 * The recency gate: an output whose entry timestamp predates the wait's
 * establishment (`prev.statusChangedAt`, minus slack) is a buffered
 * leftover from a PRIOR call, not resolution evidence, and must not flip.
 * The cascade alone is not enough protection here: it restores `waiting`
 * at the next tick, but the transient store write is enough to destroy
 * the delivered desktop notification. The notifier retracts the banner
 * the moment status leaves `waiting`, the restore lands inside the 60s
 * renotify cooldown, and the consumed status edge never re-fires, so the
 * banner is permanently lost while the prompt is still up. Missing or
 * malformed timestamps fail open (flip as before).
 *
 * The flip is otherwise deliberately uncorrelated with the call that
 * established the wait, because no correlation key exists: the
 * PermissionRequest payload carries no call_id (verified on codex-cli
 * 0.146.0; it has session/turn ids, tool_name, and tool_input only), and
 * command-string matching is ambiguous in Codex's standard
 * sandbox-fail-then-escalate flow, which reuses the identical command
 * across the ungated attempt and the gated retry. The one known gap: an
 * unrelated PARALLEL tool's output flushing mid-wait is genuinely newer
 * than the wait and still clears it early.
 */
function applyResponseItem(
  state: SessionState,
  payload: CodexResponseItemPayload,
  timestamp: string,
  waitEstablishedAtMs: number | null,
): SessionState {
  if (state.status !== "waiting") return state;
  if (
    payload?.type !== "function_call_output" &&
    payload?.type !== "custom_tool_call_output"
  ) {
    return state;
  }
  if (
    waitEstablishedAtMs !== null &&
    Date.parse(timestamp) < waitEstablishedAtMs - STALE_OUTPUT_SLACK_MS
  ) {
    return state;
  }
  return {
    ...state,
    status: "working",
    attentionType: null,
    pendingTool: null,
  };
}

function applyEntries(prev: SessionState, entries: CodexEntry[]): SessionState {
  // Captured once per batch: the wait the store fed in was established at
  // prev.statusChangedAt, and every entry in this batch gates against that
  // same moment. NaN (malformed stamp) disables the gate via the always-
  // false comparison in applyResponseItem.
  const waitEstablishedAtMs =
    prev.status === "waiting" && prev.statusChangedAt
      ? Date.parse(prev.statusChangedAt)
      : null;
  let state = prev;
  for (const entry of entries) {
    state = { ...state, lastActivityAt: entry.timestamp };
    if (entry.type === "session_meta") {
      state = applySessionMeta(state, entry.payload);
    } else if (entry.type === "event_msg") {
      state = applyEventMsg(state, entry.payload, entry.timestamp);
    } else if (entry.type === "response_item") {
      state = applyResponseItem(
        state,
        entry.payload,
        entry.timestamp,
        waitEstablishedAtMs,
      );
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
 * Codex has no permission-ASKED event in the log (waiting comes from the
 * `PermissionRequest` hook marker), but tool OUTPUT items serve as the
 * permission-RESOLVED signal via `applyResponseItem`.
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
