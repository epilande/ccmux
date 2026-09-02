import {
  PANE_IDLE_THRESHOLD_MS,
  STALE_PERMISSION_GRACE_MS,
  SUBAGENT_STALE_TIMEOUT_MS,
} from "../lib/config";
import type { AgentDef } from "../lib/agents";
import type {
  ProcessInfo,
  Session,
  SessionState,
  SubagentState,
  TmuxPane,
} from "../types/session";
import {
  correctAmbiguousPermissionMarker,
  evaluateCascade,
  genericMarkerSource,
  logSource,
  nativeLogSource,
  nativeMarkerSource,
  openCodeMarkerSource,
  terminalSource,
  type CascadeSource,
  type MarkerSourceMetadata,
} from "./cascade-evaluator";
import { isPaneTrackedSession, isBackgroundSession } from "./sessions";
import { resolveDeadProcessState } from "./status-machine";
import { matchTerminalRule } from "./terminal-detector";
import { capturePane } from "./pane-io";
import { tmuxArgv } from "../lib/tmux-exec";
import { detectPaneState, showsIdleClaudeComposer } from "./pane-classify";
import { normalizeTty } from "./pane-discovery";
import type { AttentionTracker } from "./attention-tracker";
import type { LogAdapter } from "./log-adapter";
import type { SessionPidMarker } from "./session-markers";

export interface ReconcilerDeps {
  sessionManager: {
    getSessions(): Readonly<Session>[];
    updateSession(sessionId: string, updates: Partial<Session>): boolean;
    updateSubagent(sessionId: string, subagent: SubagentState): boolean;
    setAttentionState(
      sessionId: string,
      state: "unread" | "read" | null,
    ): boolean;
  };
  watcher: { isRecentlyProcessed(sessionId: string): boolean };
  hookManager: {
    getMarkerForSession(session: Session): SessionPidMarker | null;
    getMarkersByAgentAndPid(agentType: string, pid: number): SessionPidMarker[];
  };
  attentionTracker?: AttentionTracker;
  getActivePaneId?: () => Promise<string | null>;
  agents: AgentDef[];
  /**
   * Adapter registry keyed by `agentType`. Presence of an adapter enables
   * the Option Y overlay: log-derived state owns the baseline, terminal
   * rules only upgrade to `waiting`.
   */
  logAdapters: Map<string, LogAdapter>;
  now(): number;
  /**
   * Log file mtime in ms, or `null` when the file is missing or unreadable.
   * The prod implementation is {@link readLogFileMtime}, which owns the Bun
   * far-future-sentinel quirk so consumers only ever see a plausible mtime
   * or the `null` "missing" signal. Must not throw.
   */
  getLogFileMtime(logPath: string): number | null;
  /**
   * Pane hosting `pid` by process ancestry: the pane id, `null` when the pid
   * is not under any tracked pane, or `undefined` when the daemon has no
   * process snapshot yet (boot window) and cannot say. Backs the OpenCode
   * marker ownership check in `collectPaneTrackedSources`.
   */
  paneIdHostingPid?(pid: number): string | null | undefined;
}

/**
 * Prod `getLogFileMtime`. `Bun.file().lastModified` returns a far-future
 * sentinel (`2 ** 52 - 1`) for a missing or unreadable file rather than
 * throwing or returning 0. A real log's mtime can never be in the future,
 * so any implausible value (non-finite, `<= 0`, or past now) is normalized
 * to `null` here, keeping the Bun quirk out of every consumer.
 */
export function readLogFileMtime(logPath: string): number | null {
  const mtimeMs = Bun.file(logPath).lastModified;
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0 || mtimeMs > Date.now()) {
    return null;
  }
  return mtimeMs;
}

export interface ScanSnapshot {
  processes: ProcessInfo[];
  panes: TmuxPane[];
  processTree: { findShellDescendants(pid: number): number[] };
}

/**
 * Reconcile all session states in a single scan cycle.
 *
 * Ordering matters:
 * 1. Tool execution detection (upgrades waiting-on-Bash to working)
 * 2. Native Claude state resolution (PID liveness + pane inspection)
 * 3. Stale subagent sweep (silent working subagents count as finished)
 * 4. Log adapter tick (subagent-dir watch sync independent of parses)
 * 5. Pane-tracked session reconciliation (pane inspection + hooks)
 * 6. Attention state reconciliation (unread/read/null inbox tracking)
 */
export async function reconcileAll(
  deps: ReconcilerDeps,
  snapshot: ScanSnapshot,
): Promise<void> {
  const claudeProcesses = snapshot.processes.filter(
    (p) => p.agentType === "claude",
  );

  detectToolExecution(deps, claudeProcesses, snapshot);
  await resolveNativeClaudeStates(deps, claudeProcesses, snapshot);
  capStaleSubagents(deps);
  tickLogAdapters(deps);
  await reconcileNativeCascadeSessions(deps);
  await reconcilePaneTrackedSessions(deps, snapshot.panes);
  await reconcileAttentionStates(deps);
}

/**
 * Give each session's log adapter a per-tick nudge (`onReconcileTick`).
 * Parent-log-parse hooks stop firing the moment a session's transcript goes
 * quiet, but background teammates keep writing their own transcripts — the
 * tick lets the Claude adapter attach to (or tear down) a subagents dir
 * whose activity changed after the parent's last parse.
 */
export function tickLogAdapters(deps: ReconcilerDeps): void {
  for (const session of deps.sessionManager.getSessions()) {
    deps.logAdapters.get(session.agentType)?.onReconcileTick?.(session);
  }
}

/**
 * Downgrade active (`working` or `waiting`) subagents whose logs have gone
 * silent past SUBAGENT_STALE_TIMEOUT_MS. Background teammates (`Agent`
 * tool) never write a terminal `end_turn` to their transcripts, so silence
 * is the only completion signal; without this sweep a finished teammate
 * would keep its parent lifted to `working` forever (see
 * `getEffectiveStatus`). `waiting` is swept by the same rule because a
 * subagent's waiting is an unresolved tool_use, which both a killed agent
 * and one mid-tool-call exhibit — and since `getEffectiveStatus` counts
 * waiting subagents as activity, a frozen one would otherwise lift its
 * parent forever. Setting a subagent to idle also removes it:
 * `SessionManager.updateSubagent` filters idle entries out, which is what
 * lets the Claude log adapter tear down its subagents-dir watch on a later
 * parent parse.
 */
export function capStaleSubagents(deps: ReconcilerDeps): void {
  const now = deps.now();
  for (const session of deps.sessionManager.getSessions()) {
    // Iterate a copy: updateSubagent replaces the array as it filters.
    for (const sub of [...session.subagents]) {
      if (sub.status !== "working" && sub.status !== "waiting") continue;
      if (!sub.lastActivityAt) continue;
      const age = now - new Date(sub.lastActivityAt).getTime();
      if (age <= SUBAGENT_STALE_TIMEOUT_MS) continue;
      deps.sessionManager.updateSubagent(session.id, {
        ...sub,
        status: "idle",
        attentionType: null,
        pendingTool: null,
      });
    }
  }
}

/**
 * Per-tick cascade for native Claude / Codex sessions. Iterates the
 * sessions the read-time overlay in `sessions.ts` used to cover, builds
 * (marker, log) sources, and writes the resolved state. The read-time
 * overlay was deleted; this path is what makes that safe.
 */
async function reconcileNativeCascadeSessions(
  deps: ReconcilerDeps,
): Promise<void> {
  const sessions = deps.sessionManager
    .getSessions()
    .filter(
      (s) =>
        s.trackingMode === "native" && NATIVE_CASCADE_AGENTS.has(s.agentType),
    );
  await Promise.all(sessions.map((s) => reconcileNativeSession(deps, s)));
}

/**
 * Single-session native cascade: collects (marker, log) sources and
 * writes the evaluator's result. Used by the per-tick loop AND by the
 * marker-change event path (marker-triggered reconcile).
 */
async function reconcileNativeSession(
  deps: ReconcilerDeps,
  session: Session,
  options: { skipDebounce?: boolean } = {},
): Promise<void> {
  if (!options.skipDebounce && deps.watcher.isRecentlyProcessed(session.id)) {
    return;
  }

  const marker = deps.hookManager.getMarkerForSession(session);
  const sources = collectNativeSources(session, marker);
  await applyPermissionPaneEvidence(deps, session, sources);
  const resolved = evaluateCascade(sources);
  deps.sessionManager.updateSession(session.id, resolved);
}

/**
 * The ONE pane capture the native cascade paths take, and the two corrections
 * that read it. Both are gated on a marker that claims a `permission` wait,
 * because that is the only state in which the (marker, log) pair the native
 * paths build can be wrong in a way nothing else can see:
 *
 * 1. AskUserQuestion disambiguation (`correctAmbiguousPermissionMarker`),
 *    detailed below.
 * 2. Dismissed-prompt downgrade (`applyDismissedPermissionEvidence`): a
 *    permission prompt the user ESCAPES fires no hook, so the marker keeps
 *    claiming the wait, and on the native path nothing can contradict it:
 *    `nativeLogSource` echoes the stored `waiting` back at the marker's own
 *    timestamp every tick, so it ties the marker instead of out-freshening
 *    it, and the tie resolves to the marker. `resolveNativeClaudeStates`
 *    only pane-checks sessions that are `working`, so this path is not
 *    covered there either. The row then sits at `waiting` until the next
 *    real turn, refusing every handoff (issue #117).
 *
 * Both corrections mutate `sources` in place; any capture failure is a
 * fail-open no-op (the marker's `permission` stands).
 *
 * AskUserQuestion disambiguation, in full: for an agent flagged
 * `ambiguousPermissionMarker` (Claude), match ONLY the capture's `question`
 * rules; a picker match is pushed as a source for
 * `correctAmbiguousPermissionMarker` to relabel against. A `permission` rule
 * match is deliberately dropped —
 * Claude's permission rule matches plain narrative text ("requires approval")
 * that lingers in scrollback for the whole next turn after a keyboard
 * approval (no hook fires on approval, so the marker stays
 * `waiting_permission`), and as an `upgradeOnly` waiting source it would lift
 * a fresher log-derived `working` back to `waiting/permission`, re-arming a
 * spent notification's Approve button against a now-working pane. The
 * picker's `matchAll` of two interactive-widget strings does not survive as
 * scrollback, so the pane is consulted only to detect the live picker, never
 * to re-assert a permission wait. The marker gate means the capture runs
 * only while the agent's marker sits at a permission prompt; every other
 * reconcile stays capture-free.
 */
async function applyPermissionPaneEvidence(
  deps: Pick<ReconcilerDeps, "agents" | "now">,
  session: Session,
  sources: CascadeSource[],
  capture: (paneId: string, lines?: number) => Promise<string> = capturePane,
): Promise<void> {
  const agent = deps.agents.find((a) => a.name === session.agentType);
  if (!agent) return;
  if (!session.tmuxPane) return;
  const marker = sources.find((s) => s.name === "marker");
  if (!marker || marker.state.attentionType !== "permission") return;

  const now = deps.now();
  const disambiguates = agent.ambiguousPermissionMarker === true;
  // Claude-scoped, like the other Claude-only arms in this file: the pane
  // vocabulary the downgrade reads (`showsIdleClaudeComposer`) is Claude's,
  // and what a dismissal does to another agent's marker is unverified.
  //
  // Only a session the store already shows as WAITING, which is what makes
  // this one-shot rather than a pin. Claude leaves its composer on screen
  // while it works (verified live on 2.1.222), so the composer alone does not
  // separate idle from working. The log does, and where it says `working`
  // (the post-keyboard-approval case, whose marker is stale in exactly the
  // same way) it is already right and this must not overrule it. Once the
  // downgrade lands the session is `idle`, this gate closes, and the log owns
  // the row again.
  const downgrades =
    session.agentType === "claude" &&
    session.status === "waiting" &&
    now - marker.timestamp >= STALE_PERMISSION_GRACE_MS;
  if (!disambiguates && !downgrades) return;

  let content: string;
  try {
    content = await capture(session.tmuxPane, 50);
  } catch {
    return;
  }

  if (disambiguates) {
    // `matchTerminalRule` is first-match-wins over all rules, so a permission
    // phrase in the window (residual scrollback, or prose — Claude's own
    // release-notes banner literally contains "permission rules") would SHADOW
    // the question rule exactly when this correction is needed. Filter the
    // rules, not the result, so the picker stays detectable regardless of what
    // else is on screen.
    const questionRules = agent.terminalRules.filter(
      (r) => r.attentionType === "question",
    );
    const ruleMatch = matchTerminalRule(content, {
      ...agent,
      terminalRules: questionRules,
    });
    if (ruleMatch && ruleMatch.attentionType === "question") {
      sources.push(terminalSource(ruleMatch, { upgradeOnly: true }));
    }
    correctAmbiguousPermissionMarker(sources, agent.ambiguousPermissionMarker);
  }

  if (downgrades) {
    applyDismissedPermissionEvidence(content, agent, sources, now);
  }
}

/**
 * Retire a `waiting_permission` marker the pane proves is spent: the composer
 * is back, empty, with no prompt under it, so whatever the marker is waiting
 * on was answered or dismissed without a hook (issue #117).
 *
 * The observation enters the fold as a BASELINE terminal source stamped NOW,
 * which is the only shape that can win here: an `upgradeOnly` source cannot
 * downgrade by construction, and a stale marker's `waiting` is echoed back by
 * `nativeLogSource` at the marker's own timestamp every tick, so it ties the
 * marker rather than out-freshening it, and the tie resolves to the marker.
 * Only a source stamped this tick can win. Once it lands, the store holds
 * `idle` and the log echo carries the correction forward on its own.
 *
 * Nothing is written to the marker file: it is the hook scripts' to own, and
 * the next real turn rewrites it anyway.
 */
function applyDismissedPermissionEvidence(
  content: string,
  agent: AgentDef,
  sources: CascadeSource[],
  now: number,
): void {
  if (!showsIdleClaudeComposer(content, agent.readyPattern)) return;
  sources.push(
    terminalSource(
      { status: "idle", attentionType: null, pendingTool: null },
      { upgradeOnly: false },
      now,
    ),
  );
}

/**
 * Pure source-collection seam for Claude / Codex sessions. Mirrors
 * `collectPaneTrackedSources` for the
 * `(nativeMarkerSource, nativeLogSource)` pair: native Claude / Codex per
 * tick, the marker-change event path, and pane-tracked Claude's marker
 * overlay branch all consume it.
 */
function collectNativeSources(
  session: Session,
  marker: SessionPidMarker | null,
): CascadeSource[] {
  const sources: CascadeSource[] = [];
  if (marker) sources.push(nativeMarkerSource(marker, session).source);
  sources.push(nativeLogSource(session));
  return sources;
}

/**
 * Per-session dispatch that the event-driven marker-change path uses to
 * trigger a single reconciliation through the same source-collection +
 * evaluator path the tick loop runs. `skipDebounce: true` skips the
 * recently-processed gate so a chokidar `change` event applies the new
 * marker state immediately rather than waiting up to `SCAN_INTERVAL_MS`.
 */
export async function reconcileOne(
  deps: ReconcilerDeps,
  session: Session,
  paneById: Map<string, TmuxPane>,
  options: { skipDebounce?: boolean } = {},
): Promise<void> {
  // Background sessions are owned solely by the claude-background source;
  // no reconciler arm may touch them (nativeLogSource would clobber the
  // state.json-derived status to idle). They carry no marker, so the
  // marker-event path never resolves to them either, but this guards it.
  if (isBackgroundSession(session)) return;
  if (session.trackingMode === "native") {
    if (NATIVE_CASCADE_AGENTS.has(session.agentType)) {
      await reconcileNativeSession(deps, session, options);
    }
    return;
  }
  if (isPaneTrackedSession(session) && session.tmuxPane !== null) {
    if (session.agentType === "claude") {
      await reconcilePaneTrackedClaudeSession(deps, session, paneById, options);
      return;
    }
    await reconcilePaneTrackedAgentSession(deps, session, paneById);
  }
}

/**
 * Agent types reconciled through the native cascade arm. The set mirrors
 * the per-tick "marker overlay" the daemon used to apply at read time;
 * extending it requires verifying the matching `nativeMarkerSource` /
 * `nativeLogSource` semantics in `cascade-evaluator.ts`.
 */
const NATIVE_CASCADE_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * Reconcile attention states (unread/read/null) for all sessions.
 *
 * - "read" sessions decay to null after timeout.
 * - Sessions starting new work (idle -> working/waiting) clear attention.
 * - Unread sessions viewed by user transition to read.
 */
async function reconcileAttentionStates(deps: ReconcilerDeps): Promise<void> {
  const tracker = deps.attentionTracker;
  if (!tracker) return;

  const sessions = deps.sessionManager.getSessions();

  // Background (background-agent) sessions are paneless and read-only: the
  // inbox/unread attention semantics clear on pane-viewing, which can never
  // happen for them, so a finish would stick "unread" forever. Exclude them
  // from transition tracking (prune below still runs over all sessions).
  const tracked = sessions.filter((s) => !isBackgroundSession(s));

  // Check if any session needs active pane info before spawning the subprocess
  const needsActivePaneId = tracked.some(
    (s) =>
      // Transition detection needs to know if user is viewing
      (s.status === "idle" &&
        s.attentionState === null &&
        (s.previousStatus === "working" || s.previousStatus === "waiting")) ||
      // Unread->read auto-detection needs to know if user is viewing
      s.attentionState === "unread",
  );

  const activePaneId = needsActivePaneId
    ? await (deps.getActivePaneId ?? getActivePaneId)()
    : null;

  let needsSave = false;

  for (const session of tracked) {
    // Clear attention and reset transition guard when new work starts
    if (session.status === "working" || session.status === "waiting") {
      tracker.clearOnNewWork(session.id);
      if (session.attentionState !== null) {
        deps.sessionManager.setAttentionState(session.id, null);
        needsSave = true;
      }
      continue;
    }

    // Decay "read" -> null after timeout
    if (session.attentionState === "read") {
      if (tracker.shouldClearRead(session.id)) {
        tracker.clearRead(session.id);
        deps.sessionManager.setAttentionState(session.id, null);
        needsSave = true;
      } else if (!tracker.hasReadTimer(session.id)) {
        // "read" set externally (e.g., /seen API), start decay timer
        tracker.initReadTimer(session.id);
      }
      continue;
    }

    // Detect working/waiting -> idle transitions
    if (
      session.status === "idle" &&
      session.attentionState === null &&
      (session.previousStatus === "working" ||
        session.previousStatus === "waiting")
    ) {
      const newState = tracker.resolveTransition(
        session,
        tracker.isViewingSession(session, activePaneId),
      );
      if (newState !== null) {
        deps.sessionManager.setAttentionState(session.id, newState);
        needsSave = true;
        continue;
      }
    }

    // Auto-mark unread as read when user views the session's pane
    if (session.attentionState === "unread") {
      if (tracker.isViewingSession(session, activePaneId)) {
        tracker.markSeen(session.id, false);
        deps.sessionManager.setAttentionState(session.id, "read");
        needsSave = true;
      }
    }
  }

  // Prune orphaned entries for sessions that no longer exist.
  const activeIds = new Set(sessions.map((s) => s.id));
  if (tracker.prune(activeIds)) needsSave = true;

  if (needsSave) {
    tracker.save();
  }
}

/**
 * Live tmux query for the currently active pane, shared by the reconciler's
 * own attention-tracking arm and the daemon notifier's focus-suppression
 * check (`src/daemon/notifier.ts` via its `getActivePaneId` dep).
 */
export async function getActivePaneId(): Promise<string | null> {
  try {
    const proc = Bun.spawn(tmuxArgv("display-message", "-p", "#{pane_id}"), {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const paneId = output.trim();
    return paneId || null;
  } catch {
    return null;
  }
}

/**
 * Detect when a Bash tool is actively executing by checking for shell child processes.
 * Transitions sessions from "waiting [Bash]" to "working" when shell children are found.
 */
function detectToolExecution(
  deps: ReconcilerDeps,
  claudeProcesses: ProcessInfo[],
  snapshot: ScanSnapshot,
): void {
  const candidates = deps.sessionManager
    .getSessions()
    .filter(
      (session) =>
        session.agentType === "claude" &&
        session.status === "waiting" &&
        session.attentionType === "permission" &&
        session.pendingTool === "Bash" &&
        session.tmuxPane,
    );
  if (candidates.length === 0) return;

  const paneById = new Map(snapshot.panes.map((p) => [p.paneId, p]));
  const processByTty = new Map<string, ProcessInfo>();
  for (const p of claudeProcesses) {
    const tty = normalizeTty(p.tty);
    if (tty) processByTty.set(tty, p);
  }

  for (const session of candidates) {
    const pane = paneById.get(session.tmuxPane!);
    if (!pane?.tty) continue;

    const paneTty = normalizeTty(pane.tty);
    const claudeProc = paneTty ? processByTty.get(paneTty) : undefined;
    if (!claudeProc) continue;

    const shellPids = snapshot.processTree.findShellDescendants(claudeProc.pid);
    if (shellPids.length > 0) {
      deps.sessionManager.updateSession(session.id, {
        status: "working",
        attentionType: null,
      });
    }
  }
}

/**
 * Resolve native-tracked Claude sessions using PID liveness + log activity checks.
 *
 * Phase 1 (cheap): If process is alive, check lastActivityAt from log entries.
 *   Stale > PANE_IDLE_THRESHOLD_MS -> candidate for Phase 2.
 *   Skip if session has active subagents (parent pane silent during subagent work).
 *
 * Phase 2 (targeted): Capture pane content to distinguish plan approval vs idle.
 *   Only runs for stale "working" sessions identified in Phase 1.
 *
 * Dead process -> idle. No PID -> mtime safety net.
 */
async function resolveNativeClaudeStates(
  deps: ReconcilerDeps,
  processes: ProcessInfo[],
  snapshot: ScanSnapshot,
): Promise<void> {
  const alivePids = new Set(processes.map((p) => p.pid));
  const now = deps.now();

  // paneById built internally from snapshot, not from the caller's paneCache
  const paneById = new Map(snapshot.panes.map((p) => [p.paneId, p]));

  const stalePaneSessions: Array<{
    id: string;
    paneId: string;
    wasWorking: boolean;
  }> = [];

  for (const session of deps.sessionManager.getSessions()) {
    if (session.agentType !== "claude") continue;
    if (session.trackingMode !== "native") continue;
    if (session.status === "idle") continue;
    if (deps.watcher.isRecentlyProcessed(session.id)) continue;

    let isProcessAlive: boolean | null;
    if (session.pid != null) {
      isProcessAlive = alivePids.has(session.pid);
    } else {
      isProcessAlive = null;
    }

    if (isProcessAlive === false) {
      deps.sessionManager.updateSession(session.id, {
        status: "idle",
        attentionType: null,
        pendingTool: null,
      });
      continue;
    }

    if (isProcessAlive === null) {
      // `null` = linked log is missing/unreadable (it will never append
      // again); `undefined` = no log linked at all (no mtime signal).
      let logFileMtimeMs: number | null | undefined;
      if (session.logPath) {
        logFileMtimeMs = deps.getLogFileMtime(session.logPath);
      }

      const currentState = {
        status: session.status,
        attentionType: session.attentionType,
        pendingTool: session.pendingTool,
        inPlanMode: session.inPlanMode,
        lastActivityAt: session.lastActivityAt ?? undefined,
      };

      const newState = resolveDeadProcessState(
        currentState,
        null,
        logFileMtimeMs,
      );

      if (newState.status !== currentState.status) {
        deps.sessionManager.updateSession(session.id, newState);
      }
      continue;
    }

    if (session.status !== "working") continue;
    if (session.subagents.length > 0) continue;

    if (session.lastActivityAt) {
      const lastActivityMs = new Date(session.lastActivityAt).getTime();
      if (now - lastActivityMs <= PANE_IDLE_THRESHOLD_MS) continue;
    }

    if (!session.tmuxPane) continue;
    stalePaneSessions.push({
      id: session.id,
      paneId: session.tmuxPane,
      wasWorking: session.status === "working",
    });
  }

  if (stalePaneSessions.length === 0) {
    return;
  }

  const results = await Promise.all(
    stalePaneSessions.map(async ({ id, paneId, wasWorking }) => ({
      id,
      wasWorking,
      detection: await detectPaneState(paneId, paneById.get(paneId)),
    })),
  );

  for (const { id, detection, wasWorking } of results) {
    const { state, attentionType, pendingTool } = detection;
    if (state === "plan_approval") {
      deps.sessionManager.updateSession(id, {
        status: "waiting",
        attentionType: "plan_approval",
        inPlanMode: true,
        pendingTool: null,
      });
    } else if (state === "waiting") {
      deps.sessionManager.updateSession(id, {
        status: "waiting",
        attentionType: attentionType ?? "question",
        inPlanMode: false,
        pendingTool,
      });
    } else if (state === "idle") {
      deps.sessionManager.updateSession(id, {
        status: "idle",
        attentionType: null,
        pendingTool: null,
      });
    } else if (state === "active" && wasWorking) {
      deps.sessionManager.updateSession(id, {
        status: "idle",
        attentionType: null,
        pendingTool: null,
      });
    }
  }
}

/**
 * Reconcile pane-tracked sessions using pane inspection as the primary source
 * of truth. Logs may enrich these sessions, but they do not own the pane.
 */
async function reconcilePaneTrackedSessions(
  deps: ReconcilerDeps,
  panes: TmuxPane[],
): Promise<void> {
  const paneById = new Map(panes.map((pane) => [pane.paneId, pane]));
  const sessions = deps.sessionManager
    .getSessions()
    .filter(
      (session) => isPaneTrackedSession(session) && session.tmuxPane !== null,
    );

  await Promise.all(
    sessions.map((session) => reconcileOne(deps, session, paneById)),
  );
}

/**
 * Reconcile pane-tracked Claude using tmux inspection when log evidence is
 * stale or absent.
 *
 * When a hook-written marker is fresher than the log activity timestamp,
 * apply the marker state through the cascade evaluator and skip pane
 * detection for this tick. This is the tick-time replacement for the
 * read-time marker overlay. Uses `nativeMarkerSource`
 * (not `genericMarkerSource`) because Claude's `Notification` hook does not
 * write `pending_tool`; the log-derived value must survive a
 * `waiting_permission` overlay, matching the prior read-time behavior.
 */
async function reconcilePaneTrackedClaudeSession(
  deps: ReconcilerDeps,
  session: Session,
  paneById: Map<string, TmuxPane>,
  options: { skipDebounce?: boolean } = {},
): Promise<void> {
  if (!options.skipDebounce && deps.watcher.isRecentlyProcessed(session.id)) {
    return;
  }

  const now = deps.now();
  const lastActivityMs = session.lastActivityAt
    ? new Date(session.lastActivityAt).getTime()
    : 0;

  // Guard intentionally checks BOTH fields. The deleted read-time overlay
  // required `marker.state && marker.state_timestamp`; without `state`,
  // `nativeMarkerSource` falls through its `waiting_permission` ternary to
  // an idle source, which would synthesise an idle state out of a marker
  // that never claimed one. Strict `>` matches the overlay too (equal
  // timestamps fall through to pane detection; ms granularity makes
  // collisions negligible).
  const marker = deps.hookManager.getMarkerForSession(session);
  if (marker?.state && marker.state_timestamp != null) {
    const markerMs = marker.state_timestamp * 1000;
    if (markerMs > lastActivityMs) {
      // The marker arm does NOT clear `inPlanMode` on idle (the pane-detection
      // idle branch below does). Intentional: matches the deleted read-time
      // overlay, which only wrote `status`/`attentionType`/`pendingTool`.
      const sources = collectNativeSources(session, marker);
      await applyPermissionPaneEvidence(deps, session, sources);
      const resolved = evaluateCascade(sources);
      deps.sessionManager.updateSession(session.id, resolved);
      return;
    }
  }

  if (
    session.lastActivityAt &&
    now - lastActivityMs <= PANE_IDLE_THRESHOLD_MS
  ) {
    return;
  }

  const paneId = session.tmuxPane!;
  const pane = paneById.get(paneId);
  const detection = await detectPaneState(paneId, pane);
  const { state, attentionType, pendingTool } = detection;

  if (state === "plan_approval") {
    deps.sessionManager.updateSession(session.id, {
      status: "waiting",
      attentionType: "plan_approval",
      inPlanMode: true,
      pendingTool: null,
    });
    return;
  }

  if (state === "waiting") {
    deps.sessionManager.updateSession(session.id, {
      status: "waiting",
      attentionType: attentionType ?? "question",
      pendingTool,
      inPlanMode: false,
    });
    return;
  }

  if (state === "working") {
    deps.sessionManager.updateSession(session.id, {
      status: "working",
      attentionType: null,
      pendingTool: null,
    });
    return;
  }

  if (state === "idle") {
    deps.sessionManager.updateSession(session.id, {
      status: "idle",
      attentionType: null,
      pendingTool: null,
      inPlanMode: false,
    });
  }
}

/**
 * Per-session cache of the last `matchTerminalRule` result keyed by the
 * `TmuxPane.windowActivity` timestamp at which the capture ran. When tmux
 * reports the same activity timestamp on the next tick, no pane in this
 * window has produced new output, so we skip the subprocess `capturePane`
 * call and reuse the previously-derived terminal source. The cache is
 * intentionally NOT a state cache (marker/log sources still flow through
 * the cascade every tick); only the terminal-rule contribution is
 * amortized.
 *
 * Granularity: window-level, because tmux exposes `#{window_activity}`
 * but not `#{pane_activity}` (the latter is not a tmux format variable).
 * For the common case of one full-screen agent per window the gate is
 * exact. For multi-pane windows, any pane's activity also re-arms
 * neighbors' captures — over-capturing, not under-capturing, so still
 * safe.
 *
 * `windowActivity === null` (tmux didn't report a timestamp) always
 * misses — falling back to per-tick capture is the safe behavior for
 * that case.
 *
 * Same-second guard: `window_activity` has one-second granularity, so a
 * capture taken in the SAME second as the activity stamp may predate
 * output that landed later within that second — and if the pane then goes
 * quiet (a static permission prompt finishing its draw right after the
 * capture), the stamp never advances and the stale pre-draw match would
 * be trusted forever (observed live: Antigravity's permission prompt
 * pinned `working`). A cached entry is therefore reused only when its
 * capture ran in a LATER second than the activity stamp, which proves the
 * capture saw everything the stamp covers; until then every tick
 * re-captures.
 */
const terminalRuleCache = new Map<
  string,
  {
    windowActivity: number;
    capturedAtMs: number;
    ruleMatch: ReturnType<typeof matchTerminalRule>;
  }
>();

/**
 * Reset the cache. Exposed for tests that want to assert per-tick capture
 * behavior without bleed from prior tests in the same process.
 */
export function clearTerminalRuleCache(): void {
  terminalRuleCache.clear();
}

/**
 * Per-tick reconciliation for pane-tracked agent sessions. Collects the
 * available cascade sources (marker / log / terminal), hands them to the
 * evaluator, and writes the resolved state plus any marker-supplied
 * metadata back through `SessionManager.updateSession`.
 *
 * Source rules:
 * - marker source: present when the hook manager has a marker for this
 *   session. OpenCode folds N sibling markers into one via
 *   `openCodeMarkerSource`; every other agent goes through
 *   `genericMarkerSource`.
 * - log source: present when this agent has a registered log adapter AND the
 *   session has a LINKED log (`logPath`). The `LogWatcher` mutates
 *   `session.status` / `lastActivityAt` directly, so the factory just lifts
 *   those into cascade shape; with nothing linked there is nothing to lift
 *   and the source would only echo the store back at itself (see the
 *   deadlock note in `collectPaneTrackedSources`).
 * - terminal source: present when a terminal rule matched. Upgrade-only
 *   when there's another source to upgrade (canUpgrade=["waiting"]);
 *   baseline when it's the sole signal. A permission match the collector
 *   flags as suspect (`suspectPermissionUpgrade`, see
 *   `dropsStalePermissionTerminalUpgrade`) is settled here by a capture taken
 *   this tick, because only the caller can capture. When NO rule matched but the
 *   session is markerless and its linked log file has been silent past
 *   `PANE_IDLE_THRESHOLD_MS`, a synthetic idle baseline stands in so a
 *   frozen log-derived `working` converges instead of deadlocking
 *   (see `collectPaneTrackedSources`).
 *
 * Unlike `reconcileNativeSession` and `reconcilePaneTrackedClaudeSession`,
 * this function does NOT accept a `skipDebounce` option. There is nothing
 * here for `skipDebounce` to skip: `watcher.isRecentlyProcessed` is keyed
 * by `session.id` and only set by `LogWatcher.processFile`, and the
 * pane-tracked non-Claude agents that route through this function either
 * have no log adapter (cursor / opencode / gemini / custom) or only
 * acquire a `logPath` via marker enrichment (codex) — in which case the
 * marker-event path already drove the reconcile through the dispatched
 * adapter callback. The asymmetry with the sibling branches is
 * intentional; see the matching note at
 * `state-reconciler.test.ts::reconcileOne (marker-event path)`. If a
 * debounce gate is later added here, wire `skipDebounce` through and add
 * coverage.
 */
async function reconcilePaneTrackedAgentSession(
  deps: ReconcilerDeps,
  session: Session,
  paneById: Map<string, TmuxPane>,
): Promise<void> {
  const pane = paneById.get(session.tmuxPane!);
  if (!pane) return;

  const agent = deps.agents.find((a) => a.name === session.agentType);
  if (!agent) return;

  // Gate `capturePane` (and the rule match) on `TmuxPane.windowActivity`.
  // Tmux advances this timestamp whenever any pane in the window writes
  // new output; an unchanged value means no new content can have produced
  // a different rule match, so we reuse the cached result and avoid the
  // subprocess spawn. The cascade evaluator still runs every tick to
  // react to fresh marker / log sources.
  let ruleMatch: ReturnType<typeof matchTerminalRule>;
  let fromCache = false;
  const cached = terminalRuleCache.get(session.id);
  if (
    pane.windowActivity !== null &&
    cached !== undefined &&
    cached.windowActivity === pane.windowActivity &&
    // Same-second guard (see the cache doc): only trust a capture taken in
    // a later second than the activity stamp; a same-second capture may
    // have raced output that landed after it.
    pane.windowActivity < Math.floor(cached.capturedAtMs / 1000)
  ) {
    ruleMatch = cached.ruleMatch;
    fromCache = true;
  } else {
    ruleMatch = await captureTerminalRule(session, agent, pane);
  }

  const { sources, metadata, suspectPermissionUpgrade } =
    collectPaneTrackedSources(deps, session, ruleMatch);

  // The collector withheld a permission match its guard finds suspect. What
  // it cannot know is whether the widget is on screen RIGHT NOW — and since
  // Codex removes it on both approve and deny, a capture taken this tick
  // settles it. Confined to this branch, so routine ticks pay nothing.
  if (suspectPermissionUpgrade) {
    const live = fromCache
      ? await captureTerminalRule(session, agent, pane)
      : ruleMatch;
    if (live?.status === "waiting" && live.attentionType === "permission") {
      sources.push(terminalSource(live, { upgradeOnly: sources.length > 0 }));
    }
  }

  const resolved = evaluateCascade(sources);
  const update: Partial<SessionState> = { ...metadata, ...resolved };
  deps.sessionManager.updateSession(session.id, update);
}

/**
 * Capture the pane and match the agent's terminal rules against it, seeding
 * `terminalRuleCache` with the result (the same-second guard in the cache doc
 * decides whether a later tick may trust it). Shared by the windowActivity-
 * gated path above and the suspect-permission recapture beside it, so both
 * feed the cache identically.
 */
async function captureTerminalRule(
  session: Session,
  agent: AgentDef,
  pane: TmuxPane,
): Promise<ReturnType<typeof matchTerminalRule>> {
  const capturedAtMs = Date.now();
  const content = await capturePane(session.tmuxPane!, 50);
  const ruleMatch = matchTerminalRule(content, agent);
  if (pane.windowActivity !== null) {
    terminalRuleCache.set(session.id, {
      windowActivity: pane.windowActivity,
      capturedAtMs,
      ruleMatch,
    });
  }
  return ruleMatch;
}

/**
 * Pure source-collection seam for `reconcilePaneTrackedAgentSession`.
 * Exported so wiring tests can assert source shapes directly without
 * stubbing the evaluator module.
 *
 * `suspectPermissionUpgrade` reports that a permission terminal match was
 * WITHHELD by `dropsStalePermissionTerminalUpgrade`. Staying pure and sync is
 * the point: deciding whether that match is a live widget or a stale one needs
 * a fresh pane capture, which is the caller's job, not this function's.
 */
export function collectPaneTrackedSources(
  deps: Pick<
    ReconcilerDeps,
    | "hookManager"
    | "logAdapters"
    | "now"
    | "getLogFileMtime"
    | "agents"
    | "paneIdHostingPid"
  >,
  session: Session,
  ruleMatch: ReturnType<typeof matchTerminalRule>,
): {
  sources: CascadeSource[];
  metadata: MarkerSourceMetadata;
  suspectPermissionUpgrade: boolean;
} {
  // A log source is evidence only when a log is actually LINKED. Registering
  // an adapter for the agent type is not linkage: Codex acquires its
  // `logPath` from rollout linking, which legitimately refuses (ambiguous
  // same-cwd hookless sessions), and Cursor/OpenCode may never link at all.
  //
  // Pushing `logSource` for an unlinked session is a deadlock triad, verified
  // live on a hookless Codex pane stuck at `waiting`/`permission` for 90s
  // while the pane read `esc to interrupt`:
  //  1. echo loop — `logSource` reads the SESSION (cascade-evaluator.ts), so
  //     with no linked log it just re-asserts whatever the store already
  //     holds, with a fresh-looking `lastActivityAt` timestamp, every tick;
  //  2. upgrade-only pin — because that echo counts as a source, the terminal
  //     source becomes `upgradeOnly`, and an upgrade-only source can lift TO
  //     `waiting` but never move off it, so the live `working` rule match can
  //     never clear the pin;
  //  3. no escape — the synthetic-idle branch below needs `isLinkedLogSilent`,
  //     which is false BY DESIGN when `logPath` is null.
  // Dropping the echo leaves the terminal source as the primary (baseline,
  // hence bidirectional), which is exactly how agents with no log adapter at
  // all already behave. A marker, when present, still out-ranks it.
  const hasLinkedLog =
    deps.logAdapters.has(session.agentType) && !!session.logPath;
  const matched = deps.hookManager.getMarkerForSession(session);
  const marker = ownsOpenCodeMarker(deps, session, matched) ? matched : null;

  const sources: CascadeSource[] = [];
  let metadata: MarkerSourceMetadata = {};

  let markerSource: CascadeSource | null = null;
  if (marker) {
    const built =
      session.agentType === "opencode"
        ? openCodeMarkerSource(
            marker,
            deps.hookManager.getMarkersByAgentAndPid("opencode", marker.pid),
          )
        : genericMarkerSource(marker);
    markerSource = built.source;
    sources.push(built.source);
    metadata = built.metadata;
  }

  let logSourceBuilt: CascadeSource | null = null;
  if (hasLinkedLog) {
    logSourceBuilt = logSource(session);
    sources.push(logSourceBuilt);
  }

  let suspectPermissionUpgrade = false;
  if (ruleMatch) {
    suspectPermissionUpgrade = dropsStalePermissionTerminalUpgrade(
      deps,
      session,
      ruleMatch,
      markerSource,
      logSourceBuilt,
    );
    if (!suspectPermissionUpgrade) {
      sources.push(
        terminalSource(ruleMatch, { upgradeOnly: sources.length > 0 }),
      );
    }
  } else if (!marker && hasLinkedLog && isLinkedLogSilent(deps, session)) {
    // Stale-log convergence. A hookless session's log source
    // echoes its frozen `working` and the upgrade-only terminal source can
    // never downgrade it, so a log that stops appending would deadlock. With
    // no rule match (no working/waiting indicator on screen) and a silent
    // log, a fresh idle baseline safely breaks the cascade tie to idle.
    // Marker-backed sessions are excluded: hooks own their state, not this
    // synthetic source.
    sources.push({
      name: "terminal",
      timestamp: deps.now(),
      state: { status: "idle", attentionType: null, pendingTool: null },
    });
  }

  return { sources, metadata, suspectPermissionUpgrade };
}

/** One warn per (session, marker session id, marker pid); see below. */
const warnedForeignOpenCodeMarkers = new Set<string>();
const FOREIGN_MARKER_WARN_CAP = 500;

/**
 * OpenCode marker ownership (issue #177). Two `opencode` processes in one
 * directory share OpenCode's SQLite db, so a session id one server hosts is
 * visible to the other. A marker's `pid` is a HOSTING CLAIM, and the only
 * pane whose markers may fold onto a row is the row's OWN pane: the pane
 * that hosts the pid ancestrally.
 *
 * The row can be holding a foreign `nativeSessionId` (the plugin's old
 * blanket seed wrote one; a stale claim leaves one behind), and the marker
 * lookup here is BY that id, so without this check the row paints the other
 * pane's aggregate — newest `last_prompt` included — on every tick and on
 * every marker rewrite the other server does. `adapters/link.ts` heals the
 * held id on the next scan; this guard stops the paint in the meantime.
 * Dropping the marker source leaves the terminal/log sources to speak, and
 * leaves the row's existing `lastPrompt` alone rather than clearing it.
 *
 * Fails OPEN on anything but a definite mismatch. `undefined` is the boot
 * window before the first process snapshot (the same posture as the
 * recycled-pid tripwire in `binder/links.ts`); `null` is a pid that is not
 * under any pane the last snapshot saw, which is what a marker written
 * seconds after a fresh spawn looks like, and dropping it would blind the
 * row for a whole scan interval. The cost of that choice: a SIBLING's fresh
 * pid looks the same, so against a pre-fix plugin (whose boot seed still
 * rewrites this row's marker under the sibling's pid) the guard can lag its
 * trigger by up to one snapshot interval (689ms measured live) and let one
 * fold through before the next scan's tree closes it. The fixed plugin never
 * writes that marker, so the shipped pair has no such window.
 */
function ownsOpenCodeMarker(
  deps: Pick<ReconcilerDeps, "paneIdHostingPid">,
  session: Session,
  marker: SessionPidMarker | null,
): boolean {
  if (!marker) return false;
  if (session.agentType !== "opencode") return true;
  const hostingPane = deps.paneIdHostingPid?.(marker.pid);
  if (typeof hostingPane !== "string") return true;
  if (hostingPane === session.tmuxPane) return true;

  const key = `${session.id}|${marker.session_id}|${marker.pid}`;
  if (!warnedForeignOpenCodeMarkers.has(key)) {
    if (warnedForeignOpenCodeMarkers.size >= FOREIGN_MARKER_WARN_CAP) {
      warnedForeignOpenCodeMarkers.clear();
    }
    warnedForeignOpenCodeMarkers.add(key);
    console.warn(
      `[reconciler] opencode session ${session.id} (pane ${session.tmuxPane}) ` +
        `holds marker ${marker.session_id} whose pid ${marker.pid} is hosted ` +
        `by pane ${hostingPane}; ignoring it until the link pass heals the id`,
    );
  }
  return false;
}

/**
 * The pane-tracked counterpart to `applyPermissionPaneEvidence`: flag a
 * `permission` terminal-rule match that would re-pin a wait the LOG has
 * already moved past as SUSPECT, so the caller can withhold it pending a
 * fresh capture (see the discriminator note at the end of this block).
 *
 * The trap. `evaluateCascade` applies `upgradeOnly` sources with NO freshness
 * comparison (`cascade-evaluator.ts`), by design — a pane prompt has no
 * trustworthy timestamp of its own, and the whole point of the upgrade arm is
 * that a wait on screen beats a baseline that predates it. But the terminal
 * source is built from a 50-line capture that may be leftover prompt text, or
 * from a `terminalRuleCache` entry taken DURING the wait and replayed after
 * it, so "matched" is not the same as "still true". Once Codex's rules match
 * the modern approval widget again (issue #103), every tick after an approval
 * would lift the fresh log-derived `working` straight back to
 * `waiting`/`permission`.
 *
 * Why that is worse than a cosmetic flicker: the notifier retracts a
 * delivered banner when the wait clears and then refuses to renotify for 60s,
 * so a spurious re-pin re-arms a SPENT Approve button against a pane that has
 * already moved on — the same failure mode `applyPermissionPaneEvidence`
 * exists to prevent for Claude, and the same one commit 75fe2f9 guarded on the
 * log side. Claude's guard drops the permission rule outright (its rule text
 * lingers as narrative scrollback, so a match is never evidence of a LIVE
 * wait). Codex's widget is genuinely removed from the transcript on
 * resolution (verified live on 0.146.0), so its rule match is usually real;
 * dropping it unconditionally would delete detection. Hence the narrower
 * predicate below.
 *
 * Suspect only when ALL of:
 *  1. the agent declares `markerOwnsPermissionWait` (Codex alone — its
 *     `PermissionRequest` hook opens the wait and NOTHING closes it, so the
 *     marker is stuck at `waiting_permission` and the log is the resolution
 *     authority). Cursor et al. are excluded: their hooks have no permission
 *     event, so `terminalRules` are their ONLY wait source.
 *  2. the session is hook-enriched — a marker source exists. Hookless Codex
 *     keeps today's behavior exactly: the rules are its only waiting source.
 *  3. the rule match is a permission wait (a `working` match is not an
 *     upgrade and never re-pins anything).
 *  4. a log source exists — which, since the collector only builds one for a
 *     LINKED log, also means the rollout is linked — and is STRICTLY fresher
 *     than the marker: the log
 *     has seen something the marker has not, which is precisely the
 *     post-resolution window (`applyResponseItem` flipping on a
 *     `function_call_output`). A marker at least as fresh as the log means
 *     the hook is still the newest word, so the pane is trusted.
 *  5. that fresher log does NOT itself say `waiting`. A live wait keeps
 *     appending rollout entries (`token_count`), so the log can out-fresh the
 *     marker while still echoing the wait; only a log that has moved ON to
 *     `working`/`idle` is evidence the prompt on screen is spent.
 *
 * Known cost of (4)+(5): a Codex old enough to ignore `PermissionRequest`
 * (< 0.122, hooks installed so a `SessionStart` marker exists) has a marker
 * that never claims a wait, so a genuine prompt arriving while its log ticks
 * `working` is dropped. That window is pre-0.122 Codex with hooks — narrow,
 * and unfixable without a resolution signal — and it fails toward `working`,
 * which is the recoverable direction.
 *
 * Why the five conditions only make a match SUSPECT, not dead. They also all
 * hold during the parallel-output gap: an unrelated tool's output flushing
 * while the widget is still up flips the log to `working`
 * (`applyResponseItem`), and dropping the match there suppresses the very
 * self-correction that used to re-pin the live wait — the row reads `working`
 * while Codex sits blocked on approval, with the notification already
 * retracted. What separates that from a genuinely spent prompt is one fact:
 * the widget is REMOVED from the pane on both approve and deny (live-proven on
 * 0.146.0). So a capture taken RIGHT NOW discriminates them exactly, and
 * `reconcilePaneTrackedAgentSession` takes one — reusing this tick's capture
 * when the match was fresh, recapturing when it came from
 * `terminalRuleCache` — keeping the source when the widget is still there and
 * dropping it when it is not.
 */
function dropsStalePermissionTerminalUpgrade(
  deps: Pick<ReconcilerDeps, "agents">,
  session: Session,
  ruleMatch: NonNullable<ReturnType<typeof matchTerminalRule>>,
  markerSource: CascadeSource | null,
  logSourceBuilt: CascadeSource | null,
): boolean {
  if (!markerSource || !logSourceBuilt) return false;
  if (
    ruleMatch.status !== "waiting" ||
    ruleMatch.attentionType !== "permission"
  )
    return false;
  const agent = deps.agents.find((a) => a.name === session.agentType);
  if (!agent?.markerOwnsPermissionWait) return false;
  if (logSourceBuilt.timestamp <= markerSource.timestamp) return false;
  return logSourceBuilt.state.status !== "waiting";
}

/**
 * True when the session's linked log has been silent for at least
 * `PANE_IDLE_THRESHOLD_MS`. A missing or unreadable file (`getLogFileMtime`
 * returns `null`; the sentinel handling lives in `readLogFileMtime`) counts
 * as silent (it will never append again); an unlinked session
 * (`logPath === null`) does not.
 */
function isLinkedLogSilent(
  deps: Pick<ReconcilerDeps, "now" | "getLogFileMtime">,
  session: Session,
): boolean {
  if (!session.logPath) return false;
  const mtimeMs = deps.getLogFileMtime(session.logPath);
  if (mtimeMs === null) return true;
  return deps.now() - mtimeMs >= PANE_IDLE_THRESHOLD_MS;
}
