import { matchSessionToPaneByTimestampIn } from "../adapters/claude/history";
import type { ProcessInfo, TmuxPane } from "../../types/session";
import { assignGroup, forwardGapCost } from "./assign";
import { pairProcsWithPanes } from "./primitives";
import type { MigrationBinding, MigrationObservation } from "./types";

interface ProcPane {
  proc: ProcessInfo;
  pane: TmuxPane;
}

/**
 * Ladder 4 (boot-time reconstruction), assignment-gated. For each
 * live Claude process with a tty-matched pane, resolve a session id by
 * priority:
 *
 *   P0 marker pid match (authoritative)
 *   P1 group-wise start-time assignment against history.jsonl: all
 *      markerless procs sharing a raw cwd are solved as one group over the
 *      cwd's history sessions, with direction/tolerance eligibility
 *      and ambiguity refusal — replacing the former greedy
 *      closest-|diff| loop whose `assignedSessionIds` exclusion made the
 *      outcome depend on process iteration order.
 *   P2 pane-start-time correlation, kept ONLY for procs whose start time is
 *      unusable (`ps etime` parse failure) — P1's original fallthrough for
 *      "nothing within tolerance" is gone: that state is now a refusal, not
 *      a cue to guess off the pane clock.
 *
 * A resolved session is emitted only when its log file exists and the
 * session is not already known; a proc whose winner fails those checks
 * emits nothing (the runner-up is NOT re-bound — original drop semantics),
 * and dropped sessions do not reserve their id.
 */
export interface MigrationDecision {
  bindings: MigrationBinding[];
  warnings: string[];
}

export function decideMigrationBindings(
  obs: MigrationObservation,
): MigrationDecision {
  const bindings: MigrationBinding[] = [];
  const warnings: string[] = [];
  const assignedSessionIds = new Set<string>();

  // The shared pairing (tty first, ancestry for a wrapper-hosted agent whose
  // tty belongs to no pane); process order is preserved for the tty arm, so
  // the priority walk below is unchanged.
  const procPanes: ProcPane[] = pairProcsWithPanes(obs.processes, obs.panes, {
    processTree: obs.processTree,
  }).map(({ proc, pane }) => ({ proc, pane }));

  /**
   * Original drop semantics: a winner that is already assigned, lacks its
   * log file, or is already a known session emits nothing for the proc.
   * Only an emitted binding reserves the session id.
   */
  const emit = (
    pp: ProcPane,
    sessionId: string,
    provenance: MigrationBinding["provenance"],
    confidence: MigrationBinding["confidence"],
  ): void => {
    if (assignedSessionIds.has(sessionId)) return;
    if (!obs.logPathExists(pp.proc.cwd!, sessionId)) return;
    if (obs.existingSessionIds.has(sessionId)) return;
    assignedSessionIds.add(sessionId);
    bindings.push({
      sessionId,
      cwd: pp.proc.cwd!,
      paneId: pp.pane.paneId,
      pid: pp.proc.pid,
      provenance,
      confidence,
    });
  };

  // P0: marker matches (authoritative when hooks are configured). A marker
  // whose session id is already taken falls through to the heuristics, as
  // before.
  const heuristicPool: ProcPane[] = [];
  for (const pp of procPanes) {
    const marker = obs.markers.find((m) => m.pid === pp.proc.pid);
    if (marker && !assignedSessionIds.has(marker.session_id)) {
      emit(pp, marker.session_id, "marker", "authoritative");
      continue;
    }
    heuristicPool.push(pp);
  }

  // P1: group-wise assignment per raw cwd over the cwd's history sessions.
  const timestampsByCwdSession = new Map<string, Map<string, number[]>>();
  for (const entry of obs.historyEntries) {
    let byCwd = timestampsByCwdSession.get(entry.project);
    if (!byCwd) {
      byCwd = new Map();
      timestampsByCwdSession.set(entry.project, byCwd);
    }
    const list = byCwd.get(entry.sessionId);
    if (list) {
      list.push(entry.timestamp);
    } else {
      byCwd.set(entry.sessionId, [entry.timestamp]);
    }
  }

  const groups = new Map<string, ProcPane[]>();
  const p2Pool: ProcPane[] = [];
  for (const pp of heuristicPool) {
    if (pp.proc.startTime == null) {
      p2Pool.push(pp);
      continue;
    }
    const bucket = groups.get(pp.proc.cwd!);
    if (bucket) {
      bucket.push(pp);
    } else {
      groups.set(pp.proc.cwd!, [pp]);
    }
  }

  for (const [cwd, group] of groups) {
    const byCwd = timestampsByCwdSession.get(cwd);
    if (!byCwd) continue;
    // P0 winners are settled; everything else — including ids that will
    // later fail the log/existing checks — competes, so such a winner
    // drops its proc exactly as the original per-proc loop did.
    const pool = [...byCwd.entries()].filter(
      ([sessionId]) => !assignedSessionIds.has(sessionId),
    );
    if (pool.length === 0) continue;

    const result = assignGroup(pool.length, group.length, (s, c) =>
      forwardGapCost(pool[s][1], group[c].proc.startTime),
    );
    if (result.overflow) {
      warnings.push(
        `migration group '${cwd}' exceeds the eligible-size cap ` +
          `(${pool.length} history sessions × ${group.length} procs); ` +
          `refusing heuristic reconstruction for the whole group`,
      );
    }
    for (const [s, c] of result.bound) {
      emit(group[c], pool[s][0], "start-time", "probable");
    }
    // Ambiguous / no-signal sessions and out-of-evidence procs emit
    // nothing: unbound at boot, healed by markers or the watcher.
  }

  // P2: pane-start-time fallback, unusable proc start times only.
  for (const pp of p2Pool) {
    const sessionId = matchSessionToPaneByTimestampIn(
      obs.historyEntries,
      pp.pane,
      pp.proc.cwd!,
    );
    if (!sessionId) continue;
    emit(pp, sessionId, "start-time", "probable");
  }

  return { bindings, warnings };
}
