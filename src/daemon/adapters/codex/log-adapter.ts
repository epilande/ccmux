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
  isSubagentRollout,
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
 * Slack for the FALLBACK arm of the stale-output gate below.
 * `statusChangedAt` is stamped by the daemon when the marker's `waiting` won
 * a cascade, which lands milliseconds to a second AFTER the hook observed the
 * request, and the rollout's entry timestamps come from Codex's own clock. A
 * genuine resolving output from an instant auto-approval could therefore
 * carry an entry timestamp slightly older than the stamp; the slack keeps
 * such outputs flipping (fail open, today's behavior) at the cost of not
 * gating stale entries inside the window. Truly stale outputs belong to a
 * PRIOR call, separated from the wait by at least a model round-trip, so
 * they sit well outside 2s in practice.
 */
const STALE_OUTPUT_SLACK_MS = 2000;

/**
 * Slack for the PREFERRED arm of the gate, `prev.waitEstablishedAt` (the
 * `PermissionRequest` marker's own `state_timestamp`). Marker and rollout
 * stamps come from the same machine's wall clock, and a genuine resolving
 * output is always AFTER the request that gated it — approval takes at least
 * a reviewer round-trip — so 250ms covers nothing but clock/stamp jitter.
 * The wide 2s window above exists solely for the imprecise `statusChangedAt`
 * fallback, which is stamped after daemon observation lag.
 */
const MARKER_ANCHOR_SLACK_MS = 250;

/**
 * The moment the live wait was established, plus the slack the gate may
 * forgive around it. Two tiers because the two sources have very different
 * precision (see the two slack constants). `null` means "no gate": either
 * `prev` is not waiting, or no usable anchor exists at all.
 */
interface WaitAnchor {
  anchorMs: number;
  slackMs: number;
}

/**
 * Pick the wait anchor for a batch. The marker stamp wins when present and
 * parseable; a missing or malformed one falls back to the store's
 * `statusChangedAt` with the wide slack (hookless Codex has no marker at all:
 * its waits come from the reconciler's terminal-rule overlay). A malformed
 * `statusChangedAt` yields NaN, which disables the gate through the
 * always-false comparison in `applyResponseItem` — fail open, as before.
 */
function waitAnchor(prev: SessionState): WaitAnchor | null {
  if (prev.status !== "waiting") return null;
  if (prev.waitEstablishedAt) {
    const markerMs = Date.parse(prev.waitEstablishedAt);
    if (!Number.isNaN(markerMs)) {
      return { anchorMs: markerMs, slackMs: MARKER_ANCHOR_SLACK_MS };
    }
  }
  if (prev.statusChangedAt) {
    return {
      anchorMs: Date.parse(prev.statusChangedAt),
      slackMs: STALE_OUTPUT_SLACK_MS,
    };
  }
  return null;
}

/**
 * Tool OUTPUT items are the only in-log signal that a permission wait
 * resolved: Codex fires no hook on approval (manual or via its automatic
 * approval reviewer), and outputs are flushed only after the gated tool
 * ran. Without this flip, nothing moves the session off the marker-written
 * `waiting` mid-turn, so the row stays waiting until end of turn. Request
 * items and token_count are deliberately NOT resolution evidence (they can
 * flush while the prompt is still up). A NEWER PermissionRequest still wins
 * in the cascade: its marker timestamp out-freshens this entry's
 * lastActivityAt.
 *
 * The recency gate: an output whose entry timestamp predates the wait's
 * establishment (`anchor.anchorMs`, minus `anchor.slackMs`) is a buffered
 * leftover from a PRIOR call, not resolution evidence, and must not flip.
 * The cascade alone is not enough protection here: it restores `waiting`
 * at the next tick, but the transient store write is enough to destroy
 * the delivered desktop notification. The notifier retracts the banner
 * the moment status leaves `waiting`, and the restore lands inside the 60s
 * renotify cooldown, so the banner is permanently lost while the prompt is
 * still up. Missing or malformed timestamps fail open (flip as before).
 *
 * The anchor is two-tier (see `waitAnchor`) because of how this feed is
 * driven. Codex holds its rollout fd open, so `fs.watch` never reports its
 * appends: the file is stat-polled once a second. Under event-driven parsing
 * the failed ungated attempt's output in Codex's standard
 * sandbox-fail-then-escalate flow was parsed BEFORE the wait even existed
 * (~200ms parse latency), so `prev.status` wasn't waiting and no flip was
 * possible. At 1s polling that same output is parsed AFTER the wait is
 * established, and it sits comfortably inside the 2s `statusChangedAt`
 * slack — it would spuriously clear the wait and destroy the banner.
 * Anchoring on the marker's own `state_timestamp` (`prev.waitEstablishedAt`)
 * fixes that: it is the request time itself, with no observation lag, so it
 * needs only a 250ms jitter slack. It also fixes the waiting->waiting case,
 * since the marker restamps on every request while `statusChangedAt` only
 * moves on a status edge.
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
  anchor: WaitAnchor | null,
): SessionState {
  if (state.status !== "waiting") return state;
  if (
    payload?.type !== "function_call_output" &&
    payload?.type !== "custom_tool_call_output"
  ) {
    return state;
  }
  if (anchor && Date.parse(timestamp) < anchor.anchorMs - anchor.slackMs) {
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
  // one moment, and every entry in this batch gates against that same
  // moment (and the slack its source earns).
  const anchor = waitAnchor(prev);
  let state = prev;
  for (const entry of entries) {
    state = { ...state, lastActivityAt: entry.timestamp };
    if (entry.type === "session_meta") {
      state = applySessionMeta(state, entry.payload);
    } else if (entry.type === "event_msg") {
      state = applyEventMsg(state, entry.payload, entry.timestamp);
    } else if (entry.type === "response_item") {
      state = applyResponseItem(state, entry.payload, entry.timestamp, anchor);
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
 * `PermissionRequest` hook marker, or the reconciler's terminal-rule
 * overlay when hooks aren't installed), but tool OUTPUT items serve as the
 * permission-RESOLVED signal via `applyResponseItem`.
 *
 * Codex keeps the rollout's file descriptor open for the whole session, and
 * macOS reports no `fs.watch` change event for appends through an open fd, so
 * this adapter declares `pollsLog`: without the watcher's stat-poll the
 * rollout would be parsed exactly once, at link time, and no in-log signal
 * (including the resolution flip above) would ever reach the store mid-turn.
 */
export class CodexLogAdapter implements LogAdapter {
  readonly agentType = "codex";
  readonly logDirGlob = CODEX_SESSIONS_DIR;
  // Rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (4 levels
  // below the root). A bounded depth keeps Linux inotify FD pressure flat as
  // a user's history grows.
  readonly watchDepth = 4;
  // Codex holds the rollout fd open; see the class doc above.
  readonly pollsLog = true;

  resolveSessionIdFromPath(path: string): string | null {
    const match = basename(path).match(CODEX_SESSION_FILE_PATTERN);
    return match ? match[1] : null;
  }

  /**
   * The sole consumer is `scanCodexRollouts` (index.ts), which treats every
   * non-null return as a rollout-link candidate. Returning `null` for a
   * subagent/reviewer thread (see `isSubagentRollout`) is therefore what
   * keeps codex >= 0.146's auto-approval reviewer rollout — which duplicates
   * its parent's session_id — out of link candidacy entirely, rather than
   * relying on downstream cwd/timestamp tie-breaking to avoid it.
   */
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
    if (isSubagentRollout(payload)) return null;
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
