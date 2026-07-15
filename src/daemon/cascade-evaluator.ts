import type { AttentionType, Session, SessionStatus } from "../types/session";
import type { SessionPidMarker } from "./session-markers";
import type { TerminalDetectionResult } from "./terminal-detector";
import { aggregateOpenCodeMarkers } from "./adapters/opencode/aggregate";

/**
 * The subset of session state that genuinely competes across cascade
 * sources (marker / log / terminal). Metadata fields owned by the log
 * pipeline (cwd, project, lastUserInputAt, hasActiveSubagent,
 * pendingToolIds, pendingTaskIds, version, gitBranch, lastPrompt) are
 * intentionally excluded: they flow through `SessionManager.updateSession`
 * independently. A broader `Partial<SessionState>` here would silently
 * license source factories to clobber metadata they don't own.
 */
export interface CascadeState {
  status: SessionStatus;
  attentionType?: AttentionType;
  pendingTool?: string | null;
  lastActivityAt?: string;
}

export interface CascadeSource {
  /**
   * Identifies the source kind. Used for debugging AND as the
   * deterministic tie-break when two sources share a `timestamp`:
   * marker > log > terminal. Mirrors the imperative `markerTs >= logTs`
   * rule that the cascade replaces.
   */
  name: "marker" | "log" | "terminal";
  /** Wall-clock freshness in ms since epoch. Factories normalise. */
  timestamp: number;
  state: CascadeState;
  /**
   * Upgrade-only: this source may promote the baseline to one of these
   * statuses but never set any other status. Omit for baseline sources.
   * Typical use: pane terminal-rule sources with `canUpgrade: ["waiting"]`
   * so a "Permission" prompt can upgrade idle/working but a non-match
   * never downgrades.
   */
  canUpgrade?: SessionStatus[];
}

export function evaluateCascade(sources: CascadeSource[]): CascadeState {
  const baselines: CascadeSource[] = [];
  const upgrades: CascadeSource[] = [];
  for (const source of sources) {
    if (source.canUpgrade && source.canUpgrade.length > 0) {
      upgrades.push(source);
    } else {
      baselines.push(source);
    }
  }

  baselines.sort(compareSourcesFreshestFirst);
  upgrades.sort(compareSourcesFreshestFirst);

  const result: CascadeState = baselines[0]
    ? { ...baselines[0].state }
    : { status: "idle", attentionType: null, pendingTool: null };

  for (const upgrade of upgrades) {
    if (!upgrade.canUpgrade?.includes(upgrade.state.status)) continue;
    if (result.status === upgrade.state.status) continue;
    result.status = upgrade.state.status;
    result.attentionType = result.attentionType ?? upgrade.state.attentionType;
    result.pendingTool = result.pendingTool ?? upgrade.state.pendingTool;
  }

  // Normalise to explicit null so consumers spreading the result into
  // SessionManager.updateSession actually clear stale attention. `undefined`
  // is a no-op at that boundary and would leak prior-tick state, breaking
  // the Option Y cleanup invariant the imperative cascade writes by hand.
  result.attentionType = result.attentionType ?? null;
  result.pendingTool = result.pendingTool ?? null;
  return result;
}

/**
 * Pre-fold disambiguation for agents with an ambiguous permission marker
 * (opt-in via `ambiguousPermissionMarker`; no-op otherwise). Claude fires the
 * `Notification` hook for its AskUserQuestion picker with the exact same
 * `permission_prompt` payload as a real permission prompt (verified on Claude
 * Code 2.1.209/2.1.210 — see docs/agent-adapters.md), and the picker's
 * `tool_use` is not flushed during the wait, so the pane terminal rules are
 * the only source that tells them apart. When a terminal candidate
 * independently reports a `waiting`/`question` wait, relabel EVERY
 * `waiting`/`permission` candidate to `question` in place BEFORE the fold —
 * including the log candidate, which for native sessions echoes the session's
 * STORED state with a fresh timestamp: a mis-stored `permission` would
 * out-fresh the relabeled marker every tick and never heal (found live: the
 * store poisoned once, then self-sustained). Relabeling only, never
 * restatusing: this is a pre-fold source correction, NOT a change to the
 * fold — `evaluateCascade` stays a pure freshest-wins-with-tiebreak fold.
 * Safe because a real permission prompt never matches the picker signature
 * (live-widget `matchAll` strings).
 */
export function correctAmbiguousPermissionMarker(
  sources: CascadeSource[],
  ambiguousPermissionMarker: boolean | undefined,
): void {
  if (!ambiguousPermissionMarker) return;
  const terminalQuestion = sources.some(
    (s) =>
      s.name === "terminal" &&
      s.state.status === "waiting" &&
      s.state.attentionType === "question",
  );
  if (!terminalQuestion) return;
  for (const source of sources) {
    if (
      source.name !== "terminal" &&
      source.state.status === "waiting" &&
      source.state.attentionType === "permission"
    ) {
      source.state.attentionType = "question";
    }
  }
}

const SOURCE_PRIORITY: Record<CascadeSource["name"], number> = {
  marker: 3,
  log: 2,
  terminal: 1,
};

function compareSourcesFreshestFirst(
  a: CascadeSource,
  b: CascadeSource,
): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  return SOURCE_PRIORITY[b.name] - SOURCE_PRIORITY[a.name];
}

/**
 * Marker-only metadata that flows alongside the cascade result. Kept
 * narrow (no cascade fields) so factories cannot accidentally bypass
 * the evaluator.
 */
export interface MarkerSourceMetadata {
  cwd?: string;
  lastPrompt?: string | null;
}

interface MarkerCascadeBuild {
  source: CascadeSource;
  metadata: MarkerSourceMetadata;
}

/**
 * Translate a hook-written marker into a cascade source + metadata bundle.
 * Used for every pane-tracked agent except OpenCode (which folds N markers
 * into one — see `openCodeMarkerSource`).
 *
 * Cursor's `last_prompt` is sticky between prompts (`stop` hook omits the
 * field). Undefined means "preserve, don't clear"; we keep it out of
 * metadata so `SessionManager.updateSession`'s `!== undefined` guard
 * leaves the prior prompt alone.
 */
export function genericMarkerSource(
  marker: SessionPidMarker,
): MarkerCascadeBuild {
  const state: CascadeState = markerStatusState(marker);
  if (marker.state_timestamp !== undefined) {
    state.lastActivityAt = new Date(
      marker.state_timestamp * 1000,
    ).toISOString();
  }
  const metadata: MarkerSourceMetadata = {};
  if (marker.last_prompt !== undefined)
    metadata.lastPrompt = marker.last_prompt;
  return { source: markerCascadeSource(marker, state), metadata };
}

/**
 * OpenCode hosts N sessions per server PID; one ccmux Session covers the
 * hosting tmux pane. Fold the sibling markers (`getMarkersByAgentAndPid`)
 * with the worst-of-status rule, then split into a cascade source +
 * metadata bundle.
 *
 * `nativeSessionId` from the aggregator is intentionally dropped: it's
 * owned by the OpenCode plugin adapter on marker add/remove and the
 * reconciler must not race that path.
 */
export function openCodeMarkerSource(
  marker: SessionPidMarker,
  siblings: readonly SessionPidMarker[],
): MarkerCascadeBuild {
  const aggregated = aggregateOpenCodeMarkers(
    siblings.length > 0 ? siblings : [marker],
  );
  const state: CascadeState = {
    status: aggregated.status ?? "idle",
    attentionType: aggregated.attentionType ?? null,
    pendingTool: aggregated.pendingTool ?? null,
  };
  if (aggregated.lastActivityAt)
    state.lastActivityAt = aggregated.lastActivityAt;
  const metadata: MarkerSourceMetadata = {};
  if (aggregated.cwd) metadata.cwd = aggregated.cwd;
  if (aggregated.lastPrompt !== undefined) {
    metadata.lastPrompt = aggregated.lastPrompt;
  }
  return { source: markerCascadeSource(marker, state), metadata };
}

/**
 * Build a log cascade source from the session's currently-recorded state.
 * The LogWatcher writes status / lastActivityAt to SessionManager directly
 * on every parse; this factory lifts them into cascade shape.
 *
 * `lastActivityAt` is intentionally omitted from `state`. `SessionManager`
 * treats "the key is present" as "caller manages lastActivityAt" and
 * skips its auto-stamp-on-status-change path. The LogWatcher already
 * owns the value; the log cascade source contributes status only.
 *
 * Always emits explicit `null` for attentionType / pendingTool so the
 * Option Y cleanup invariant holds: when log is the freshest baseline
 * and no upgrade fires, stale attention fields clear through the
 * evaluator instead of needing imperative bookkeeping.
 */
export function logSource(session: Session): CascadeSource {
  return {
    name: "log",
    timestamp: session.lastActivityAt
      ? new Date(session.lastActivityAt).getTime()
      : 0,
    state: {
      status: session.status,
      attentionType: null,
      pendingTool: null,
    },
  };
}

/**
 * Marker source for Claude / Codex sessions, native and pane-tracked-with-
 * hook-handoff alike. The log adapter owns `pendingTool` (it parses
 * tool_use blocks from JSONL); the marker only fires for permission-prompt
 * and idle-prompt transitions. To match the read-time overlay this
 * replaces, the factory:
 *
 * - On `waiting_permission`: prefers `marker.pending_tool` (Claude's
 *   `Notification` hook parses the tool name out of the message; Codex's
 *   `PermissionRequest` already wrote it). The marker is authoritative
 *   because Claude does NOT flush the permission-gated `tool_use` to its
 *   JSONL until after approval, so the log-derived value is null during the
 *   wait; the `?? session.pendingTool` fallback covers the post-approval
 *   window and older markers written before this enrichment.
 * - On `idle`: emits explicit nulls. SessionEnd unlinks the marker
 *   entirely; the `state === "idle"` payload only fires for
 *   `idle_prompt` transitions, which legitimately clear attention.
 *
 * Pane-tracked Codex / Cursor use `genericMarkerSource` (their hooks DO
 * write `pending_tool`). OpenCode uses `openCodeMarkerSource` to fold
 * sibling markers.
 */
export function nativeMarkerSource(
  marker: SessionPidMarker,
  session: Session,
): MarkerCascadeBuild {
  const state: CascadeState =
    marker.state === "waiting_permission"
      ? {
          status: "waiting",
          attentionType: "permission",
          pendingTool: marker.pending_tool ?? session.pendingTool,
        }
      : { status: "idle", attentionType: null, pendingTool: null };
  if (marker.state_timestamp !== undefined) {
    state.lastActivityAt = new Date(
      marker.state_timestamp * 1000,
    ).toISOString();
  }
  return { source: markerCascadeSource(marker, state), metadata: {} };
}

/**
 * Log source for NATIVE sessions where the log adapter owns the full
 * status/attention/pendingTool tuple (Claude, Codex). Mirrors the
 * session's current state, which the LogWatcher writes directly on every
 * JSONL parse.
 *
 * Differs from `logSource` (pane-tracked) in two ways:
 * - Propagates `session.attentionType` and `session.pendingTool` rather
 *   than hardcoding nulls. Pane-tracked agents have markers as the
 *   attention authority; native agents have the log adapter.
 * - Same as `logSource`, `lastActivityAt` is intentionally omitted so
 *   `SessionManager.updateSession` keeps its auto-stamp-on-status-change
 *   path and the LogWatcher's recent writes aren't clobbered by a stale
 *   cascade write.
 */
export function nativeLogSource(session: Session): CascadeSource {
  return {
    name: "log",
    timestamp: session.lastActivityAt
      ? new Date(session.lastActivityAt).getTime()
      : 0,
    state: {
      status: session.status,
      attentionType: session.attentionType,
      pendingTool: session.pendingTool,
    },
  };
}

/**
 * Wrap a terminal-rule match as a cascade source. `upgradeOnly: true` is
 * the typical path (rule may upgrade to `waiting` but never downgrade);
 * `upgradeOnly: false` is only correct when the terminal is the sole
 * signal — no marker AND no log adapter for this agent.
 */
export function terminalSource(
  rule: TerminalDetectionResult,
  options: { upgradeOnly: boolean },
  now: number = Date.now(),
): CascadeSource {
  return {
    name: "terminal",
    timestamp: now,
    state: {
      status: rule.status,
      attentionType: rule.attentionType,
      pendingTool: rule.pendingTool,
    },
    canUpgrade: options.upgradeOnly ? ["waiting"] : undefined,
  };
}

function markerStatusState(marker: SessionPidMarker): CascadeState {
  if (marker.state === "waiting_permission") {
    return {
      status: "waiting",
      attentionType: "permission",
      pendingTool: marker.pending_tool ?? null,
    };
  }
  if (marker.state === "working") {
    return { status: "working", attentionType: null, pendingTool: null };
  }
  return { status: "idle", attentionType: null, pendingTool: null };
}

function markerCascadeSource(
  marker: SessionPidMarker,
  state: CascadeState,
): CascadeSource {
  return {
    name: "marker",
    timestamp: (marker.state_timestamp ?? 0) * 1000,
    state,
  };
}
