import { EventEmitter } from "events";
import type {
  AttentionState,
  AttentionType,
  Session,
  SessionState,
  SessionStatus,
  SubagentState,
  BackgroundChild,
  BackgroundInFlight,
} from "../types/session";
import { extractProjectInfo } from "./parser";
import { appendPrompt } from "./status-machine";
import { getSessionPidMarker } from "./session-markers";
import { findSoftEvictTargets } from "./binder/primitives";

interface PaneTrackedSessionInput {
  agentType: string;
  paneId: string;
  cwd: string;
  pid: number | null;
  nativeSessionId?: string;
}

/**
 * Inputs for a Claude background (background-agent) session. Identity fields
 * follow the background-source rules: `daemonShort` is the stable
 * dedup key (`Session.id`), `nativeSessionId` is `state.json.resumeSessionId`,
 * and `logPath` is `state.json.linkScanPath` VERBATIM (never reconstructed).
 */
interface BackgroundSessionInput {
  daemonShort: string;
  pid: number | null;
  cwd: string;
  nativeSessionId?: string;
  logPath: string | null;
  version: string | null;
  status: SessionStatus;
  attentionType: AttentionType;
  pendingTool: string | null;
  backgroundDetail?: string;
  backgroundResult?: string;
  backgroundChildren?: BackgroundChild[];
  backgroundInFlight?: BackgroundInFlight;
  lastPrompt: string | null;
  lastActivityAt: string | null;
}

/**
 * Structural equality for `backgroundChildren`. Treats `undefined` and `[]`
 * as equal so a never-set field doesn't churn into an empty array.
 */
function backgroundChildrenEqual(
  a: BackgroundChild[] | undefined,
  b: BackgroundChild[] | undefined,
): boolean {
  const aLen = a?.length ?? 0;
  const bLen = b?.length ?? 0;
  if (aLen !== bLen) return false;
  for (let i = 0; i < aLen; i++) {
    if (
      a![i].id !== b![i].id ||
      a![i].href !== b![i].href ||
      a![i].kind !== b![i].kind
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Structural equality for `backgroundInFlight`. Treats `undefined` and `{}`
 * as equal so a never-set field doesn't churn into an empty object.
 */
function backgroundInFlightEqual(
  a: BackgroundInFlight | undefined,
  b: BackgroundInFlight | undefined,
): boolean {
  if (a?.tasks !== b?.tasks || a?.queued !== b?.queued) return false;
  const aKinds = a?.kinds ?? [];
  const bKinds = b?.kinds ?? [];
  if (aKinds.length !== bKinds.length) return false;
  return aKinds.every((kind, i) => kind === bKinds[i]);
}

/** Shallow element-wise equality for two string arrays. */
function arraysShallowEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function isPaneTrackedSession(session: Session): boolean {
  return session.trackingMode === "pane";
}

export function isPaneTrackedClaudeSession(session: Session): boolean {
  return session.agentType === "claude" && session.trackingMode === "pane";
}

export function isBackgroundSession(session: Session): boolean {
  return session.trackingMode === "background";
}

/**
 * Stable identifier to use for marker-cache lookups, resume commands, and
 * display. Pane-tracked sessions begin life with a synthetic `session.id`
 * (e.g. `codex_pane963`) and receive a real UUID in `nativeSessionId` once
 * the hook-driven enrichment handoff completes. Callers that need a stable
 * identity across that handoff must prefer `nativeSessionId`.
 *
 * Note: this is NOT for user-facing "(unresolved)" display. Callers that
 * want a placeholder when `nativeSessionId` is absent should handle that
 * separately (see `src/commands/debug.ts`).
 */
export function getMarkerKey(session: Session): string {
  return session.nativeSessionId ?? session.id;
}

type SessionEventType = "created" | "updated" | "removed";

export interface SessionEvent {
  type: SessionEventType;
  session?: Session;
  sessionId?: string;
}

/**
 * Outcome of {@link SessionManager.setNativeSessionId}. A plain boolean
 * conflated two very different "false" cases; callers need to tell them apart:
 * - `"set"`      — the id was newly assigned to this session.
 * - `"noop"`     — nothing changed because the session is gone OR it already
 *                  holds this exact id (a benign re-fire, e.g. a resumed
 *                  marker). Callers treat this as success and proceed.
 * - `"conflict"` — another live session already owns this id, so it was NOT
 *                  assigned. Callers MUST skip any follow-on enrichment that
 *                  assumes this session owns the id (log path, transcript
 *                  processing, marker-derived state); proceeding would strand
 *                  that enrichment on the wrong row and block marker routing.
 */
export type SetNativeSessionIdResult = "set" | "noop" | "conflict";

/**
 * Session manager - maintains in-memory session state
 */
export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();

  /**
   * Clear a pane-tracked session's per-run enrichment (status, activity,
   * log path, optionally native id). Used when the underlying process
   * changes so the row does not carry the previous run's identity — for
   * every pane-tracked agent, not just Claude (a codex/cursor/
   * pi/opencode relaunch in the same pane must not inherit the dead run's
   * `nativeSessionId`/`logPath` and keep showing its transcript).
   */
  private resetPaneTrackedSessionState(
    session: Session,
    options: {
      clearNativeSessionId?: boolean;
      clearLogPath?: boolean;
    } = {},
  ): boolean {
    if (!isPaneTrackedSession(session)) {
      return false;
    }

    let changed = false;

    if (session.status !== "idle") {
      session.status = "idle";
      changed = true;
    }
    if (session.attentionType !== null) {
      session.attentionType = null;
      changed = true;
    }
    if (session.pendingTool !== null) {
      session.pendingTool = null;
      changed = true;
    }
    if (session.inPlanMode) {
      session.inPlanMode = false;
      changed = true;
    }
    if (session.lastActivityAt !== null) {
      session.lastActivityAt = null;
      changed = true;
    }
    if (session.lastUserInputAt !== null) {
      session.lastUserInputAt = null;
      changed = true;
    }
    if (session.subagents.length > 0) {
      session.subagents = [];
      changed = true;
    }
    if (session.gitBranch !== null) {
      session.gitBranch = null;
      changed = true;
    }
    if (options.clearLogPath !== false && session.logPath !== null) {
      session.logPath = null;
      changed = true;
    }
    if (options.clearNativeSessionId && session.nativeSessionId !== undefined) {
      session.nativeSessionId = undefined;
      changed = true;
    }
    if (session.previousStatus !== null) {
      session.previousStatus = null;
      changed = true;
    }
    if (session.statusChangedAt !== null) {
      session.statusChangedAt = null;
      changed = true;
    }
    if (session.lastPrompt !== null) {
      session.lastPrompt = null;
      changed = true;
    }
    if (session.prompts.length > 0) {
      // Drop the dead run's prompt history so the reused row isn't searchable
      // by the previous session's prompts.
      session.prompts = [];
      changed = true;
    }

    return changed;
  }

  /**
   * Create a new session from a log file path
   */
  createSession(
    sessionId: string,
    logPath: string,
    agentType: string = "claude",
  ): Session {
    const { project, cwd } = extractProjectInfo(logPath);

    const session: Session = {
      id: sessionId,
      agentType,
      trackingMode: "native",
      nativeSessionId: sessionId,
      project,
      cwd,
      logPath,
      status: "idle",
      attentionType: null,
      pendingTool: null,
      inPlanMode: false,
      tmuxPane: null,
      updatedAt: new Date(),
      lastActivityAt: null,
      lastUserInputAt: null,
      subagents: [],
      gitBranch: null,
      version: null,
      pid: null,
      statusChangedAt: null,
      attentionGeneration: 0,
      previousStatus: null,
      attentionState: null,
      lastSeenAt: null,
      lastPrompt: null,
      prompts: [],
    };

    this.sessions.set(sessionId, session);
    this.emit("change", { type: "created", session } as SessionEvent);

    return session;
  }

  /**
   * Create a process-only pane-tracked session for pane-tracked agents.
   */
  createPaneTrackedSession(input: PaneTrackedSessionInput): Session {
    const paneNumberMatch = input.paneId.match(/^%(\d+)$/);
    const paneToken = paneNumberMatch ? `pane${paneNumberMatch[1]}` : "pane";
    const sessionId = `${input.agentType}_${paneToken}`;
    const project = input.cwd.split("/").pop() || input.agentType;

    const existing = this.sessions.get(sessionId);
    if (existing) {
      let changed = false;
      const pidChanged = existing.pid !== input.pid;

      // Pane reuse: a different process in this pane means a new run —
      // clear the previous run's identity for ALL pane-tracked agents,
      // not just Claude. The new run's own marker / rollout
      // link re-enriches it. Gated on pidChanged ONLY: a new run always
      // has a new pid, while a cwd-only change with the same pid is the
      // same run (a chdir, or a transient lsof miss making the caller fall
      // back to `pane.currentPath`) — resetting identity there would
      // flicker a live session's nativeSessionId/logPath.
      if (pidChanged) {
        if (
          this.resetPaneTrackedSessionState(existing, {
            clearNativeSessionId: true,
          })
        ) {
          changed = true;
        }
      }

      if (existing.cwd !== input.cwd) {
        existing.cwd = input.cwd;
        existing.project = project;
        changed = true;
      }
      if (existing.tmuxPane !== input.paneId) {
        existing.tmuxPane = input.paneId;
        changed = true;
      }
      if (existing.pid !== input.pid) {
        existing.pid = input.pid;
        // Force version refresh when the underlying process changes.
        existing.version = null;
        changed = true;
      }
      if (
        input.nativeSessionId &&
        existing.nativeSessionId !== input.nativeSessionId
      ) {
        // Pane-reuse path: a new agent process on the same pane reports a
        // new nativeSessionId, so we overwrite. Unlike `setNativeSessionId`
        // this does NOT refuse duplicates because the pane key already
        // scopes the write; a cross-pane collision here would surface as
        // an undefined `resolveSessionForMarkerEvent` result (pinned by
        // the defensive resolver test in sessions.test.ts).
        existing.nativeSessionId = input.nativeSessionId;
        changed = true;
      }
      if (changed) {
        existing.updatedAt = new Date();
        this.emit("change", {
          type: "updated",
          session: existing,
        } as SessionEvent);
      }
      return existing;
    }

    const session: Session = {
      id: sessionId,
      agentType: input.agentType,
      trackingMode: "pane",
      nativeSessionId: input.nativeSessionId,
      project,
      cwd: input.cwd,
      logPath: null,
      status: "idle",
      attentionType: null,
      pendingTool: null,
      inPlanMode: false,
      tmuxPane: input.paneId,
      updatedAt: new Date(),
      lastActivityAt: null,
      lastUserInputAt: null,
      subagents: [],
      gitBranch: null,
      version: null,
      pid: input.pid,
      statusChangedAt: null,
      attentionGeneration: 0,
      previousStatus: null,
      attentionState: null,
      lastSeenAt: null,
      lastPrompt: null,
      prompts: [],
    };

    this.sessions.set(session.id, session);
    this.emit("change", { type: "created", session } as SessionEvent);
    return session;
  }

  /**
   * Create a Claude background (background-agent) session. Paneless by
   * nature: `tmuxPane` is always null. Keyed by `daemonShort`. The
   * `claude-background` source is the sole authority for these rows; updates
   * flow through `updateSession` + the dedicated setters, and removal happens
   * only when the short drops from `roster.workers`.
   */
  createBackgroundSession(input: BackgroundSessionInput): Session {
    const project = input.cwd.split("/").pop() || "claude";

    const session: Session = {
      id: input.daemonShort,
      agentType: "claude",
      trackingMode: "background",
      nativeSessionId: input.nativeSessionId,
      project,
      cwd: input.cwd,
      logPath: input.logPath,
      status: input.status,
      attentionType: input.attentionType,
      pendingTool: input.pendingTool,
      inPlanMode: false,
      tmuxPane: null,
      updatedAt: new Date(),
      lastActivityAt: input.lastActivityAt,
      lastUserInputAt: null,
      subagents: [],
      gitBranch: null,
      version: input.version,
      pid: input.pid,
      statusChangedAt: null,
      attentionGeneration: 0,
      previousStatus: null,
      attentionState: null,
      lastSeenAt: null,
      lastPrompt: input.lastPrompt,
      prompts: input.lastPrompt ? [input.lastPrompt] : [],
      backgroundDetail: input.backgroundDetail,
      backgroundResult: input.backgroundResult,
      backgroundChildren: input.backgroundChildren,
      backgroundInFlight: input.backgroundInFlight,
    };

    this.sessions.set(session.id, session);
    this.emit("change", { type: "created", session } as SessionEvent);
    return session;
  }

  /**
   * Update a session with new state
   */
  updateSession(sessionId: string, state: Partial<SessionState>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    let changed = false;

    const statusChanged =
      state.status !== undefined && state.status !== session.status;
    if (statusChanged) {
      session.previousStatus = session.status;
      session.statusChangedAt = new Date().toISOString();
      session.status = state.status!;
      changed = true;
    }

    const attentionChanged =
      state.attentionType !== undefined &&
      state.attentionType !== session.attentionType;
    if (attentionChanged) {
      session.attentionType = state.attentionType!;
      changed = true;
    }

    let pendingToolChanged = false;
    if (
      state.pendingTool !== undefined &&
      state.pendingTool !== session.pendingTool
    ) {
      session.pendingTool = state.pendingTool;
      pendingToolChanged = true;
      changed = true;
    }

    // Advance the attention generation once per call when the attention
    // identity changed. This is the ONLY site that bumps it (see the field
    // doc on Session). A waiting->waiting swap that keeps `status` unchanged
    // is invisible to `statusChangedAt` but flips `attentionType`/`pendingTool`,
    // so the generation moves and a press against the resolved wait is rejected.
    // A single +1 covers both fields changing in one call.
    if (attentionChanged || pendingToolChanged) {
      session.attentionGeneration += 1;
      changed = true;
    }

    if (
      state.inPlanMode !== undefined &&
      state.inPlanMode !== session.inPlanMode
    ) {
      session.inPlanMode = state.inPlanMode;
      changed = true;
    }

    // Update cwd/project if provided from log entries (more accurate than decoded path)
    if (state.cwd && state.cwd !== session.cwd) {
      session.cwd = state.cwd;
      session.project = state.cwd.split("/").pop() || session.project;
      changed = true;
    }

    if (state.version && state.version !== session.version) {
      session.version = state.version;
      changed = true;
    }

    if (state.gitBranch && state.gitBranch !== session.gitBranch) {
      session.gitBranch = state.gitBranch;
      changed = true;
    }

    // Update lastActivityAt: use provided value, or auto-set on status/attentionType change
    // Only auto-set when caller didn't explicitly include lastActivityAt in the update
    const hasExplicitActivityAt = "lastActivityAt" in state;
    const effectiveLastActivityAt = hasExplicitActivityAt
      ? state.lastActivityAt
      : statusChanged || attentionChanged
        ? new Date().toISOString()
        : undefined;
    if (
      effectiveLastActivityAt !== undefined &&
      effectiveLastActivityAt !== session.lastActivityAt
    ) {
      session.lastActivityAt = effectiveLastActivityAt ?? null;
      changed = true;
    }

    // Update lastUserInputAt if provided
    if (
      state.lastUserInputAt !== undefined &&
      state.lastUserInputAt !== session.lastUserInputAt
    ) {
      session.lastUserInputAt = state.lastUserInputAt ?? null;
      changed = true;
    }

    if (
      state.lastPrompt !== undefined &&
      state.lastPrompt !== session.lastPrompt
    ) {
      session.lastPrompt = state.lastPrompt ?? null;
      changed = true;
      // Marker-driven agents (Cursor/Pi/OpenCode) update `lastPrompt` without
      // maintaining the prompt index (`state.prompts` stays undefined), so
      // append here to keep their prompt history searchable. Claude/Codex set
      // `state.prompts` alongside `lastPrompt` (the replace branch below owns
      // their index), so this is skipped for them: no double-append. The
      // enclosing guard (lastPrompt actually changed) also dedups a marker
      // re-firing the same prompt.
      if (state.prompts === undefined && typeof state.lastPrompt === "string") {
        const appended = appendPrompt(session.prompts, state.lastPrompt);
        // OpenCode aggregated rows flip `lastPrompt` between sibling sessions
        // on any status event (newest-by-activity wins), re-delivering an older
        // prompt that the "changed" guard alone can't catch. When a real append
        // happened, drop any earlier copy of the just-added entry so a repeat
        // refreshes recency instead of filling the capped index with
        // [pa,pb,pa,pb,...] dupes that evict distinct history. `appendPrompt`
        // returns the same reference on a no-op, so guard on identity to avoid
        // pruning a legitimate pre-existing duplicate.
        if (appended !== session.prompts) {
          const newest = appended[appended.length - 1];
          session.prompts = appended.filter(
            (p, i) => i === appended.length - 1 || p !== newest,
          );
        } else {
          session.prompts = appended;
        }
      }
    }

    // `appendPrompt` produces the full capped array, so this is a wholesale
    // replace, not a merge.
    if (
      state.prompts !== undefined &&
      !arraysShallowEqual(state.prompts, session.prompts)
    ) {
      session.prompts = state.prompts;
      changed = true;
    }

    if (
      state.backgroundDetail !== undefined &&
      state.backgroundDetail !== session.backgroundDetail
    ) {
      session.backgroundDetail = state.backgroundDetail;
      changed = true;
    }

    if (
      state.backgroundResult !== undefined &&
      state.backgroundResult !== session.backgroundResult
    ) {
      session.backgroundResult = state.backgroundResult;
      changed = true;
    }

    if (
      state.backgroundChildren !== undefined &&
      !backgroundChildrenEqual(
        state.backgroundChildren,
        session.backgroundChildren,
      )
    ) {
      session.backgroundChildren = state.backgroundChildren;
      changed = true;
    }

    if (
      state.backgroundInFlight !== undefined &&
      !backgroundInFlightEqual(
        state.backgroundInFlight,
        session.backgroundInFlight,
      )
    ) {
      session.backgroundInFlight = state.backgroundInFlight;
      changed = true;
    }

    if (changed) {
      session.updatedAt = new Date();
      this.emit("change", { type: "updated", session } as SessionEvent);
    }

    return changed;
  }

  /**
   * Set the attention state of a session (unread/read/null).
   */
  setAttentionState(
    sessionId: string,
    attentionState: AttentionState,
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.attentionState === attentionState) return false;

    session.attentionState = attentionState;
    if (attentionState === "read" || attentionState === null) {
      session.lastSeenAt = new Date().toISOString();
    }
    session.updatedAt = new Date();
    this.emit("change", { type: "updated", session } as SessionEvent);
    return true;
  }

  /**
   * Mark a session as seen by the user (unread -> read).
   */
  markSeen(sessionId: string): boolean {
    return this.setAttentionState(sessionId, "read");
  }

  /**
   * Update or add a subagent for a session.
   * Removes stale idle subagents and clears all if every subagent is idle.
   */
  updateSubagent(sessionId: string, subagent: SubagentState): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const idx = session.subagents.findIndex(
      (s) => s.agentId === subagent.agentId,
    );
    if (idx >= 0) {
      session.subagents[idx] = subagent;
    } else {
      session.subagents.push(subagent);
    }

    // Remove idle subagents immediately — they've finished their work
    session.subagents = session.subagents.filter((s) => s.status !== "idle");

    session.updatedAt = new Date();
    this.emit("change", { type: "updated", session } as SessionEvent);
    return true;
  }

  /**
   * Clear all subagents for a session
   */
  clearSubagents(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.subagents.length === 0) return false;

    session.subagents = [];
    session.updatedAt = new Date();
    this.emit("change", { type: "updated", session } as SessionEvent);
    return true;
  }

  /**
   * Set tmux pane association for a session
   * Dedupes by removing other sessions with the same cwd+paneId
   */
  setTmuxPane(sessionId: string, paneId: string | null): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.tmuxPane === paneId) {
      return false;
    }

    if (paneId !== null) {
      // Rule shared with the binder's working-model simulations
      // (`binder/primitives.ts`) so the three sites can't drift.
      for (const other of findSoftEvictTargets(
        this.sessions.values(),
        session,
        paneId,
      )) {
        // Soft-evict: clear pane/pid so it can re-match later
        other.tmuxPane = null;
        other.pid = null;
        other.updatedAt = new Date();
        this.emit("change", {
          type: "updated",
          session: other,
        } as SessionEvent);
      }
    }

    session.tmuxPane = paneId;
    session.updatedAt = new Date();
    this.emit("change", { type: "updated", session } as SessionEvent);

    return true;
  }

  /**
   * Set the PID of the agent process for a session
   */
  setPid(sessionId: string, pid: number | null): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.pid === pid) return false;

    session.pid = pid;
    session.updatedAt = new Date();
    this.emit("change", { type: "updated", session } as SessionEvent);

    return true;
  }

  /**
   * Set native session ID used by resume commands and log enrichment.
   *
   * Refuses to assign a `nativeSessionId` already in use by a different
   * session. `resolveSessionForMarkerEvent` returns undefined for the
   * duplicate case (see the defensive test in sessions.test.ts), so a
   * silent overwrite here would leave the resolver unable to route
   * marker events to either session.
   *
   * `reclaim: true` is for marker-backed (authoritative) callers only:
   * when the current owner is a pane-tracked session that
   * merely *holds* the id (its own `id` differs — a heuristic grab, e.g.
   * the codex rollout fallback picking the wrong same-cwd rollout), the id
   * is stripped from that session — along with the log path and derived
   * state that rode in on it — and assigned here, so marker events and
   * enrichment re-route to the true owner instead of being refused
   * forever. A session whose primary key IS the id (native rows) is never
   * stripped; that conflict still refuses.
   */
  setNativeSessionId(
    sessionId: string,
    nativeSessionId: string,
    options: { reclaim?: boolean } = {},
  ): SetNativeSessionIdResult {
    const session = this.sessions.get(sessionId);
    if (!session || session.nativeSessionId === nativeSessionId) {
      // Missing session, or an idempotent re-assignment (e.g. a resumed
      // marker re-firing). Benign: nothing to change, and callers should
      // proceed with their follow-on enrichment as normal.
      return "noop";
    }
    for (const other of this.sessions.values()) {
      if (other.id !== sessionId && other.nativeSessionId === nativeSessionId) {
        const reclaimable =
          options.reclaim === true &&
          isPaneTrackedSession(other) &&
          other.id !== nativeSessionId;
        if (!reclaimable) {
          // Another live session already owns this id. Refuse (a silent
          // overwrite would leave `resolveSessionForMarkerEvent` unable to
          // route marker events to either session) and surface it.
          console.warn(
            `setNativeSessionId: "${nativeSessionId}" already owned by session ` +
              `${other.id}; refusing to reassign to ${sessionId}`,
          );
          return "conflict";
        }
        // Authoritative reclaim: strip the heuristic holder's claim and the
        // enrichment that came with it (its log path / state belong to this
        // id, hence to the new owner). The holder re-links from its own
        // evidence on subsequent scans.
        console.warn(
          `setNativeSessionId: reclaiming "${nativeSessionId}" from session ` +
            `${other.id} for ${sessionId} (marker-backed re-derivation)`,
        );
        if (
          this.resetPaneTrackedSessionState(other, {
            clearNativeSessionId: true,
          })
        ) {
          other.updatedAt = new Date();
          this.emit("change", { type: "updated", session: other });
        }
      }
    }
    session.nativeSessionId = nativeSessionId;
    session.updatedAt = new Date();
    this.emit("change", { type: "updated", session } as SessionEvent);
    return "set";
  }

  setLogPath(sessionId: string, logPath: string | null): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.logPath === logPath) {
      return false;
    }
    session.logPath = logPath;
    session.updatedAt = new Date();
    this.emit("change", { type: "updated", session } as SessionEvent);
    return true;
  }

  /**
   * Remove a session
   */
  removeSession(sessionId: string): boolean {
    const existed = this.sessions.delete(sessionId);
    if (existed) {
      this.emit("change", { type: "removed", sessionId } as SessionEvent);
    }
    return existed;
  }

  /**
   * Get a session by ID. Pure storage read — the per-tick + per-event
   * reconcile path in `state-reconciler.ts` keeps `status`, `attentionType`,
   * and `pendingTool` correct via the cascade evaluator.
   *
   * Returns a live reference to the stored `Session`, typed `Readonly` so
   * the compiler enforces the contract that state writes must go through
   * `updateSession` (and the dedicated setters) so listeners see a coherent
   * change event.
   */
  getSession(sessionId: string): Readonly<Session> | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all sessions. Same purity and live-reference guarantees as
   * `getSession`: the array is freshly built per call, but each entry is
   * the stored `Session`, typed `Readonly` to forbid mutation.
   */
  getSessions(): Readonly<Session>[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getSessionByNativeSessionId(
    nativeSessionId: string,
  ): Readonly<Session> | undefined {
    const matches = this.getSessions().filter(
      (session) => session.nativeSessionId === nativeSessionId,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Resolve the session a marker file event refers to. Marker files carry
   * the agent's native session id (Claude UUID, Codex rollout id, Cursor
   * conversation id, OpenCode `ses_xxx`); pane-tracked agents store that
   * id under `nativeSessionId` while keying the session record by
   * `${agentType}_pane${num}`, so `getSessionByNativeSessionId` is the
   * authoritative lookup for them. Native Claude / Codex have
   * `session.id === nativeSessionId === marker.session_id`, so the same
   * lookup also finds them in steady state.
   *
   * The `getSession` fallback is defensive: it covers the (currently
   * unreachable) future case where a native session is created without
   * `nativeSessionId` populated, and the (also unreachable) collision
   * case where a marker `session_id` happens to equal a `${agentType}_
   * pane${num}` synthetic id. Both lookups return undefined for the
   * duplicate-nativeSessionId case, which is intentional.
   *
   * OpenCode aggregates N markers into one ccmux session, so non-winning
   * sibling marker `session_id`s miss this resolver. The OpenCode adapter
   * closes that by intercepting at `HookAdapter.onMarkerChanged`, which
   * runs BEFORE the daemon's generic `notifyMarkerChanged` callback and
   * re-aggregates by server PID rather than by marker id.
   */
  resolveSessionForMarkerEvent(
    sessionId: string,
  ): Readonly<Session> | undefined {
    return (
      this.getSessionByNativeSessionId(sessionId) ?? this.getSession(sessionId)
    );
  }

  /**
   * Get sessions by working directory.
   */
  getSessionsByCwd(cwd: string, agentType?: string): Readonly<Session>[] {
    return this.getSessions().filter((session) => {
      if (session.cwd !== cwd) return false;
      if (agentType && session.agentType !== agentType) return false;
      return true;
    });
  }

  /**
   * Dedupe sessions by agentType+cwd+paneId, keeping only the most recently updated
   */
  dedupe(
    getMarker: (
      id: string,
    ) =>
      | import("./session-markers").SessionPidMarker
      | null = getSessionPidMarker,
  ): number {
    const groups = new Map<string, Session[]>();

    for (const session of this.sessions.values()) {
      if (session.tmuxPane === null) continue;
      const key = `${session.agentType}|${session.cwd}|${session.tmuxPane}`;
      const group = groups.get(key) || [];
      group.push(session);
      groups.set(key, group);
    }

    let evicted = 0;

    for (const group of groups.values()) {
      if (group.length <= 1) continue;

      // Marker-backed sessions win regardless of updatedAt
      group.sort((a, b) => {
        const aMarker = getMarker(a.id);
        const bMarker = getMarker(b.id);
        if (aMarker && !bMarker) return -1;
        if (!aMarker && bMarker) return 1;
        return b.updatedAt.getTime() - a.updatedAt.getTime();
      });

      // Soft-evict losers instead of deleting
      for (let i = 1; i < group.length; i++) {
        group[i].tmuxPane = null;
        group[i].pid = null;
        group[i].updatedAt = new Date();
        this.emit("change", {
          type: "updated",
          session: group[i],
        } as SessionEvent);
        evicted++;
      }
    }

    return evicted;
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    const sessionIds = Array.from(this.sessions.keys());
    this.sessions.clear();
    for (const sessionId of sessionIds) {
      this.emit("change", { type: "removed", sessionId } as SessionEvent);
    }
  }
}
