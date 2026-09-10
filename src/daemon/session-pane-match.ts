import type { ProcessInfo, TmuxPane } from "../types/session";
import { CLAUDE_AGENT_DEF } from "../lib/agents";
import { ZOMBIE_STALE_MS } from "../lib/config";
import { isBackgroundSession, type SessionManager } from "./sessions";
import {
  lazyProcessTree,
  ProcessTree,
  type ProcessTreeProvider,
} from "./process-tree";
import {
  getSessionTimestampsIn,
  readClaudeHistory,
} from "./adapters/claude/history";
import { getSessionPidMarker, getMarkerPidSnapshot } from "./session-markers";
import { DaemonPerf } from "./perf";
import { discoverAgentProcesses } from "./processes";
import { listTmuxPanes, normalizeTty } from "./pane-discovery";
import {
  decideScanBindings,
  decideNewSessionPane,
  decideStaleCleanup,
  pairProcsWithPanes,
  type Binding,
  type NewSessionPaneDecision,
  type SessionSlice,
} from "./binder";

// Pure matching primitives live in the binder module (the single owner of
// matching policy); re-exported here so existing imports keep working.
export { encodeProjectPath, type ProcPaneMatch } from "./binder";

/**
 * Match sessions to tmux panes based on TTY.
 * Thin wrapper over the binder's scan decision (ladder 1): builds the
 * observation, lets the pure binder decide, applies the bindings in order.
 * The SessionManager's own no-op guards make unconditional setter calls
 * equivalent to the pre-binder conditional ones.
 */
export function matchSessionsToPanes(
  manager: SessionManager,
  agentProcesses: ProcessInfo[],
  panes: TmuxPane[],
  processTree?: ProcessTree,
): void {
  DaemonPerf.incFindIterations(panes.length + agentProcesses.length);

  const sessions: SessionSlice[] = manager.getSessions().map((s) => ({
    id: s.id,
    agentType: s.agentType,
    cwd: s.cwd,
    tmuxPane: s.tmuxPane,
    pid: s.pid,
    isBackground: isBackgroundSession(s),
  }));

  const bindings: Binding[] = decideScanBindings({
    sessions,
    processes: agentProcesses,
    panes,
    processTree,
    markerPidBySessionId: getMarkerPidSnapshot(),
  });

  for (const binding of bindings) {
    if (binding.paneId !== null) {
      manager.setTmuxPane(binding.sessionId, binding.paneId);
    }
    if (binding.pid !== null) {
      manager.setPid(binding.sessionId, binding.pid);
    }
  }
}

/**
 * Clean up sessions without active agent processes or with dead tmux panes.
 * Thin wrapper over the binder's pure `decideStaleCleanup` (branch logic and
 * the per-session rules documented there). Destructive transitions carry
 * two-scan hysteresis: `pending` is the previous scan's
 * unconfirmed proposals, and the returned set is this scan's — the caller
 * holds it across scans. Passing an empty set therefore never destroys
 * anything on the first call.
 */
export function cleanupStaleSessions(
  manager: SessionManager,
  agentProcesses: ProcessInfo[],
  panes: TmuxPane[],
  pending: ReadonlySet<string>,
): Set<string> {
  const decision = decideStaleCleanup(
    {
      sessions: manager.getSessions().map((s) => ({
        id: s.id,
        agentType: s.agentType,
        cwd: s.cwd,
        tmuxPane: s.tmuxPane,
        pid: s.pid,
        isBackground: isBackgroundSession(s),
        updatedAtMs: s.updatedAt.getTime(),
      })),
      processes: agentProcesses,
      panes,
      nowMs: Date.now(),
      zombieStaleMs: ZOMBIE_STALE_MS,
    },
    pending,
  );

  for (const sessionId of decision.unbinds) {
    manager.setTmuxPane(sessionId, null);
  }
  for (const sessionId of decision.removals) {
    manager.removeSession(sessionId);
  }

  return decision.nextPending;
}

/**
 * Find tmux pane using session PID marker (authoritative when hooks are configured)
 * Returns the pane matching the marker's PID/TTY, or null if no marker exists
 *
 * Three passes, each subordinate to the one before: the marker's own tty, the
 * marker pid's process tty, then ancestry. The last exists because a
 * pty-allocating wrapper (`script -q /dev/null claude`, `nono run -- claude`,
 * `fence`) keeps the pane's tty for itself and setsid's the agent onto a
 * fresh pty no pane owns, so both tty passes miss and the session was
 * created unbound forever (issue #193). It runs the SAME pairing the scan
 * and the other creation sites use, so all four agree on the wrapper shape.
 *
 * `getProcessTree` is a build-at-most-once supplier so a caller that also
 * calls {@link findPaneForNewSession} pays for ONE `ps` across the pair
 * (the rebind pass does exactly that, every 30s per unbound session). Left
 * to itself, this function builds a tree only if it reaches pass 3.
 */
export async function findPaneByMarker(
  sessionId: string,
  getProcessTree: ProcessTreeProvider = lazyProcessTree(),
): Promise<TmuxPane | null> {
  const marker = getSessionPidMarker(sessionId);
  if (!marker) return null;

  const panes = await listTmuxPanes();
  const normalizedMarkerTty = normalizeTty(marker.tty);

  // Match by TTY (most reliable). OpenCode markers have no TTY, so this
  // pass no-ops for them; the PID fallback below picks them up.
  if (normalizedMarkerTty) {
    for (const pane of panes) {
      const normalizedPaneTty = normalizeTty(pane.tty);
      if (normalizedPaneTty === normalizedMarkerTty) {
        return pane;
      }
    }
  }

  // Fallback: match by PID
  const claudeProcs = await discoverAgentProcesses([CLAUDE_AGENT_DEF]);
  const matchingProc = claudeProcs.find((p) => p.pid === marker.pid);
  if (matchingProc?.tty) {
    const normalizedProcTty = normalizeTty(matchingProc.tty);
    for (const pane of panes) {
      if (normalizeTty(pane.tty) === normalizedProcTty) {
        return pane;
      }
    }
  }

  // Last resort: ancestry. The tree is built HERE rather than reused from the
  // scan because a marker fires the instant the agent starts — a tree from up
  // to one scan interval ago has no node for it. The common (tty) case
  // returns above and never pays for one.
  if (!matchingProc) return null;
  const processTree = await getProcessTree();
  const ancestryMatch = pairProcsWithPanes(claudeProcs, panes, {
    processTree,
  }).find((m) => m.provenance === "ancestry" && m.proc.pid === marker.pid);

  return ancestryMatch?.pane ?? null;
}

/**
 * Find the tmux pane for a newly created session. Thin wrapper over the
 * binder's ladder-2 decision (assignment-gated): gathers the
 * observation (process + pane discovery, existing sessions' claims, one
 * history.jsonl read) and returns the decision. `ambiguous` means the
 * caller should create the session visibly UNBOUND rather than bind
 * a guess; `none` means no eligible candidate.
 *
 * @param encodedProjectPath - The encoded project path from the log file
 * @param sessionId - Session ID whose history timestamps gate the match
 * @param transcriptCwd - Raw cwd from the transcript, when known
 */
export async function findPaneForNewSession(
  manager: SessionManager,
  encodedProjectPath: string,
  sessionId: string,
  transcriptCwd: string | null,
  getProcessTree: ProcessTreeProvider = lazyProcessTree(),
): Promise<NewSessionPaneDecision> {
  // A fresh tree, not the daemon's scan-cached one: this runs the moment a
  // new transcript appears, which is typically before the next scan has seen
  // the agent at all. The caller supplies a build-at-most-once provider, so
  // the marker pass above and this one cost ONE `ps` between them — one per
  // new session, and one per 30s rebind attempt, never one per scan tick.
  const [claudeProcs, panes, processTree] = await Promise.all([
    discoverAgentProcesses([CLAUDE_AGENT_DEF]),
    listTmuxPanes(),
    getProcessTree(),
  ]);

  const historyEntries = readClaudeHistory();

  return decideNewSessionPane({
    processes: claudeProcs,
    panes,
    processTree,
    sessionId,
    encodedProjectPath,
    transcriptCwd,
    getSessionTimestamps: (id, projectPath) =>
      getSessionTimestampsIn(historyEntries, id, projectPath),
    sessions: manager.getSessions().map((s) => ({
      tmuxPane: s.tmuxPane,
      pid: s.pid,
    })),
  });
}
