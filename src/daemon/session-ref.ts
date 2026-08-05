/**
 * Session references: how a human (or a peer agent) names a session on the
 * command line without knowing its id.
 *
 * Tiers, in order, stopping at the FIRST tier with any match:
 *
 *   exact  1. ccmux session id
 *          2. tmux pane id (`%7`)
 *          3. tmux coordinate (`work:1.0`)
 *          4. `self` (the caller's own pane)
 *   fuzzy  5. agent type (`codex`)
 *          6. project / worktree directory name (`fix-codex`)
 *
 * Tiers 1-2 reproduce `DaemonServer.resolveSession` exactly, which is why
 * that function is left alone: existing callers keep their behavior and this
 * one extends around them.
 *
 * PRIME DIRECTIVE (inherited from the binder, which learned it the hard way):
 * AMBIGUITY REFUSES, NEVER GUESSES. Proximity narrows the SCOPE a fuzzy ref
 * is searched in (same window > same tmux session > global) and a unique
 * match in the nearest scope that has any wins even when farther matches
 * exist; more than one match in that scope is a refusal carrying the full
 * candidate list, sorted nearest-first. There is no tie-break on recency or
 * status, and deliberately no `--first`-style override: the listing IS the
 * recovery path.
 *
 * Pure and synchronous. Window/session facts come from the daemon's own pane
 * cache, so resolving never costs a tmux call.
 */

import type { Session, TmuxPane } from "../types/session";

export type RefProximity = "same-window" | "same-session" | "global";

export type RefTier =
  | "id"
  | "pane"
  | "coordinate"
  | "self"
  | "agent-type"
  | "project";

/** One row of an ambiguity refusal: everything the caller needs to re-ask. */
export interface SessionRefCandidate {
  sessionId: string;
  agentType: string;
  project: string;
  cwd: string;
  status: string;
  paneId: string | null;
  /** `session:window.pane`, or null for a paneless session. */
  coordinate: string | null;
  proximity: RefProximity;
}

export type SessionRefResolution =
  | {
      outcome: "resolved";
      session: Session;
      tier: RefTier;
      /** False for the fuzzy tiers, whose pick is worth echoing to the user. */
      exact: boolean;
      /** Null for the exact tiers, which ignore proximity entirely. */
      proximity: RefProximity | null;
    }
  | { outcome: "ambiguous"; candidates: SessionRefCandidate[] }
  | { outcome: "not-found" };

export interface SessionRefContext {
  sessions: Session[];
  panes: Map<string, TmuxPane>;
  /** The caller's `$TMUX_PANE`; absent when the caller is outside tmux, which
   *  simply means every fuzzy search runs at global scope. */
  callerPane?: string | null;
}

/** `work:1.0` — a tmux session name, a window index, a pane index. */
const COORDINATE_RE = /^[^:%\s][^:]*:\d+\.\d+$/;

const PROXIMITY_RANK: Record<RefProximity, number> = {
  "same-window": 0,
  "same-session": 1,
  global: 2,
};

/** Human words for the stderr echo and the refusal listing. */
export function proximityLabel(proximity: RefProximity): string {
  if (proximity === "same-window") return "same window";
  if (proximity === "same-session") return "same tmux session";
  return "global";
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function resolveSessionRef(
  ref: string,
  ctx: SessionRefContext,
): SessionRefResolution {
  const trimmed = ref.trim();
  if (!trimmed) return { outcome: "not-found" };
  const { sessions, panes } = ctx;

  // --- exact tiers -------------------------------------------------------
  const byId = sessions.find((s) => s.id === trimmed);
  if (byId) {
    return {
      outcome: "resolved",
      session: byId,
      tier: "id",
      exact: true,
      proximity: null,
    };
  }

  if (trimmed.startsWith("%")) {
    const byPane = sessions.find((s) => s.tmuxPane === trimmed);
    if (byPane) {
      return {
        outcome: "resolved",
        session: byPane,
        tier: "pane",
        exact: true,
        proximity: null,
      };
    }
    return { outcome: "not-found" };
  }

  if (COORDINATE_RE.test(trimmed)) {
    // The pane cache already maps every live pane to its coordinate, so the
    // translation costs nothing and stays consistent with the proximity
    // facts below (which come from the same snapshot).
    const pane = [...panes.values()].find((p) => p.target === trimmed);
    if (pane) {
      const byCoordinate = sessions.find((s) => s.tmuxPane === pane.paneId);
      if (byCoordinate) {
        return {
          outcome: "resolved",
          session: byCoordinate,
          tier: "coordinate",
          exact: true,
          proximity: null,
        };
      }
    }
    return { outcome: "not-found" };
  }

  if (trimmed === "self") {
    const callerPane = ctx.callerPane?.trim();
    if (!callerPane) return { outcome: "not-found" };
    const own = sessions.find((s) => s.tmuxPane === callerPane);
    if (!own) return { outcome: "not-found" };
    return {
      outcome: "resolved",
      session: own,
      tier: "self",
      exact: true,
      proximity: null,
    };
  }

  // --- fuzzy tiers -------------------------------------------------------
  const needle = trimmed.toLowerCase();
  const proximityOf = makeProximity(ctx);

  const byAgentType = sessions.filter(
    (s) => s.agentType.toLowerCase() === needle,
  );
  if (byAgentType.length > 0) {
    return narrow(byAgentType, "agent-type", proximityOf, panes);
  }

  const byProject = sessions.filter(
    (s) =>
      s.project.toLowerCase() === needle ||
      basename(s.cwd).toLowerCase() === needle,
  );
  if (byProject.length > 0) {
    return narrow(byProject, "project", proximityOf, panes);
  }

  return { outcome: "not-found" };
}

/** Proximity of a session to the caller, from the pane cache alone. */
function makeProximity(ctx: SessionRefContext): (s: Session) => RefProximity {
  const callerPane = ctx.callerPane?.trim();
  const caller = callerPane ? ctx.panes.get(callerPane) : undefined;
  if (!caller) return () => "global";
  return (session) => {
    const pane = session.tmuxPane ? ctx.panes.get(session.tmuxPane) : undefined;
    if (!pane) return "global";
    if (pane.sessionName !== caller.sessionName) return "global";
    return pane.windowIndex === caller.windowIndex
      ? "same-window"
      : "same-session";
  };
}

/**
 * Apply the scope ladder to one tier's matches: the nearest scope that holds
 * ANY match decides, and holding more than one there is a refusal.
 */
function narrow(
  matches: Session[],
  tier: RefTier,
  proximityOf: (s: Session) => RefProximity,
  panes: Map<string, TmuxPane>,
): SessionRefResolution {
  const scored = matches.map((session) => ({
    session,
    proximity: proximityOf(session),
  }));

  for (const scope of ["same-window", "same-session", "global"] as const) {
    const inScope = scored.filter((m) => m.proximity === scope);
    if (inScope.length === 0) continue;
    if (inScope.length === 1) {
      return {
        outcome: "resolved",
        session: inScope[0].session,
        tier,
        exact: false,
        proximity: scope,
      };
    }
    // Refuse. The listing carries EVERY match of this tier, not just the
    // ones in the refusing scope: the farther ones are legitimate next
    // commands, and sorting nearest-first keeps the near ones on top.
    return {
      outcome: "ambiguous",
      candidates: scored
        .map((m) => toCandidate(m.session, m.proximity, panes))
        .sort(
          (a, b) =>
            PROXIMITY_RANK[a.proximity] - PROXIMITY_RANK[b.proximity] ||
            a.sessionId.localeCompare(b.sessionId),
        ),
    };
  }

  return { outcome: "not-found" };
}

function toCandidate(
  session: Session,
  proximity: RefProximity,
  panes: Map<string, TmuxPane>,
): SessionRefCandidate {
  const pane = session.tmuxPane ? panes.get(session.tmuxPane) : undefined;
  return {
    sessionId: session.id,
    agentType: session.agentType,
    project: session.project,
    cwd: session.cwd,
    status: session.status,
    paneId: session.tmuxPane,
    coordinate: pane?.target ?? null,
    proximity,
  };
}
