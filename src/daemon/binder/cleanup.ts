import type { ProcessInfo, TmuxPane } from "../../types/session";
import { encodeProjectPath } from "./primitives";

/**
 * Minimal read-only slice of a Session the stale-cleanup decision needs.
 * Built by the caller from `SessionManager.getSessions()`.
 */
export interface CleanupSessionSlice {
  id: string;
  agentType: string;
  cwd: string;
  tmuxPane: string | null;
  pid: number | null;
  /** `isBackgroundSession(s)` — background rows are never cleaned here. */
  isBackground: boolean;
  /** `session.updatedAt` in epoch ms (drives the zombie staleness clock). */
  updatedAtMs: number;
}

/** Observation for the stale-session cleanup decision. */
export interface CleanupObservation {
  sessions: readonly CleanupSessionSlice[];
  processes: readonly ProcessInfo[];
  panes: readonly TmuxPane[];
  nowMs: number;
  /** `ZOMBIE_STALE_MS`, injected so fixtures control the clock. */
  zombieStaleMs: number;
}

/**
 * The cleanup decision. `removals` / `unbinds` are CONFIRMED destructive
 * actions (proposed last scan AND still warranted this scan); the caller
 * applies them. `nextPending` is this scan's set of still-unconfirmed
 * proposals; the caller holds it and passes it back on the next scan.
 */
export interface CleanupDecision {
  /** Sessions to `removeSession`. */
  removals: string[];
  /** Sessions to soft-evict (`setTmuxPane(null)` — pane gone, pid alive). */
  unbinds: string[];
  nextPending: Set<string>;
}

type ProposedAction = { kind: "remove" | "unbind"; sessionId: string };

function actionKey(action: ProposedAction): string {
  return `${action.kind}:${action.sessionId}`;
}

/**
 * Pure decision form of stale-session cleanup, with two-scan hysteresis on
 * every destructive transition: an unbind or
 * removal only executes when two consecutive scans independently propose it.
 * A single scan's disappearance — `ps` etime jitter, a transient process-tree
 * gap, or a tmux hiccup that slipped past the observation-layer guard
 * (`scanTmuxPanesOrThrow`) — therefore proposes but never destroys; evidence
 * returning on the next scan silently drops the proposal.
 *
 * The per-session branch logic is unchanged from the pre-Phase-2
 * `cleanupStaleSessions`:
 *   1. tracked pid dead                          → remove
 *   2. tracked pid alive, pane gone              → unbind (soft-evict)
 *   3. no pid, pane gone                         → remove
 *   4. no pid, no pane, stale > zombieStaleMs    → remove
 *   5. no pid, no live process for the same
 *      agentType + encoded cwd                   → remove
 */
export function decideStaleCleanup(
  obs: CleanupObservation,
  pending: ReadonlySet<string>,
): CleanupDecision {
  const activePids = new Set(obs.processes.map((p) => p.pid));
  const activePaneIds = new Set(obs.panes.map((p) => p.paneId));
  const encodedCwdsByAgent = new Set(
    obs.processes
      .filter((p) => p.cwd)
      .map((p) => `${p.agentType}|${encodeProjectPath(p.cwd!)}`),
  );

  const proposals: ProposedAction[] = [];

  for (const session of obs.sessions) {
    // Background sessions are paneless and never appear in the tmux-derived
    // activePids/activePaneIds, so every branch below would reap them. The
    // claude-background roster watcher is their SOLE death signal.
    if (session.isBackground) continue;

    if (session.pid !== null) {
      if (!activePids.has(session.pid)) {
        proposals.push({ kind: "remove", sessionId: session.id });
      } else if (
        session.tmuxPane !== null &&
        !activePaneIds.has(session.tmuxPane)
      ) {
        // PID alive but pane gone: soft-evict so it can re-match
        proposals.push({ kind: "unbind", sessionId: session.id });
      }
      continue;
    }

    if (session.tmuxPane !== null && !activePaneIds.has(session.tmuxPane)) {
      proposals.push({ kind: "remove", sessionId: session.id });
      continue;
    }

    // Soft-evicted zombie: no pane, no PID. Remove once stale (prevents
    // zombies from being kept alive by cwd match alone).
    if (session.tmuxPane === null) {
      const age = obs.nowMs - session.updatedAtMs;
      if (age > obs.zombieStaleMs) {
        proposals.push({ kind: "remove", sessionId: session.id });
        continue;
      }
    }

    // No PID — fall back to a cwd-based liveness check.
    const agentCwdKey = `${session.agentType}|${encodeProjectPath(session.cwd)}`;
    if (!encodedCwdsByAgent.has(agentCwdKey)) {
      proposals.push({ kind: "remove", sessionId: session.id });
    }
  }

  const removals: string[] = [];
  const unbinds: string[] = [];
  const nextPending = new Set<string>();

  for (const action of proposals) {
    if (pending.has(actionKey(action))) {
      (action.kind === "remove" ? removals : unbinds).push(action.sessionId);
    } else {
      nextPending.add(actionKey(action));
    }
  }

  return { removals, unbinds, nextPending };
}
