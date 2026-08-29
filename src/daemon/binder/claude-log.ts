import { decodeProjectPath } from "../parser";
import { ASSIGN_MAX_GROUP, assignGroup, forwardGapCost } from "./assign";
import {
  buildProcPaneMapByEncodedCwd,
  encodeProjectPath,
  findSoftEvictTargets,
  pairProcsWithPanes,
} from "./primitives";
import type {
  InitialBatchAction,
  InitialBatchDecision,
  InitialBatchItem,
  InitialBatchObservation,
  NewSessionPaneDecision,
  NewSessionPaneObservation,
  ProcPaneMatch,
  ReplaceableSessionSlice,
  ReplaceHeuristicDecision,
} from "./types";

/**
 * Encoding-drift canary. Returns a warning when a session's raw
 * transcript cwd no longer re-encodes to the on-disk project dir name,
 * which would mean Claude changed its encoding rule (or the cwd contains
 * characters — e.g. non-ASCII — the shipped encoder was never verified
 * against). Matching still proceeds on the raw cwd per R1; the canary just
 * turns the unverifiable assumption into an observable signal.
 */
export function encodingDriftWarning(
  transcriptCwd: string,
  encodedProjectPath: string,
): string | null {
  const reEncoded = encodeProjectPath(transcriptCwd);
  if (reEncoded === encodedProjectPath) return null;
  return (
    `encoding drift: transcript cwd '${transcriptCwd}' re-encodes to ` +
    `'${reEncoded}' but the on-disk project dir is '${encodedProjectPath}'; ` +
    `matching on raw cwd (check for a Claude-side encoding change)`
  );
}

/**
 * Candidate selection for a claude session: when the session's raw
 * transcript cwd is known it is the AUTHORITATIVE key — candidates are the
 * tty-paired processes with exactly that cwd, which both separates sibling
 * cwds whose encodings collide and survives Claude-side encoding drift
 * (where the log's dir name no longer matches our encoding of the proc
 * cwd). Only when the transcript has no cwd yet does the lossy encoded key
 * pre-filter.
 */
function candidatesForSession(
  transcriptCwd: string | null,
  encodedProjectPath: string,
  allProcPanes: readonly ProcPaneMatch[],
  byEncodedCwd: ReadonlyMap<string, ProcPaneMatch[]>,
): ProcPaneMatch[] {
  if (transcriptCwd) {
    return allProcPanes.filter((mp) => mp.proc.cwd === transcriptCwd);
  }
  return byEncodedCwd.get(encodedProjectPath) ?? [];
}

/**
 * Pair cost for the claude heuristic assignment (via
 * `forwardGapCost`). Candidates are already cwd-selected (see
 * `candidatesForSession`); history timestamps are looked up under the
 * candidate's raw cwd, which is exactly what history.jsonl records.
 */
function claudePairCost(
  sessionId: string,
  candidate: ProcPaneMatch,
  getSessionTimestamps: (
    sessionId: string,
    projectPath: string,
  ) => readonly number[],
): number | null {
  return forwardGapCost(
    getSessionTimestamps(sessionId, candidate.proc.cwd!),
    candidate.proc.startTime,
  );
}

/**
 * Ladder 2 (new Claude session → pane), assignment-gated. A
 * single-session group over the same-encoded-cwd candidates: the D1/D2
 * eligibility gates and the D3 ambiguity refusal apply even when only one
 * candidate remains — AT-D2 requires refusing an hours-stale sole
 * candidate, and AT-D5 requires a leftover pane to earn its binding rather
 * than win it by default.
 *
 * Candidate panes claimed by a VERIFIED holder (an existing session whose
 * pid is that pane's live process) are excluded; unverified claims —
 * including stale cross-cwd ones — do not block.
 */
export function decideNewSessionPane(
  obs: NewSessionPaneObservation,
): NewSessionPaneDecision {
  const allProcPanes = pairProcsWithPanes(obs.processes, obs.panes);
  const byCwd = buildProcPaneMapByEncodedCwd(obs.processes, obs.panes);
  const matches = candidatesForSession(
    obs.transcriptCwd,
    obs.encodedProjectPath,
    allProcPanes,
    byCwd,
  );
  const available = matches.filter(
    (mp) =>
      !obs.sessions.some(
        (s) => s.tmuxPane === mp.pane.paneId && s.pid === mp.proc.pid,
      ),
  );

  if (available.length === 0) return { kind: "none" };

  const result = assignGroup(1, available.length, (_s, c) =>
    claudePairCost(obs.sessionId, available[c], obs.getSessionTimestamps),
  );

  const boundCandidate = result.bound.get(0);
  if (boundCandidate !== undefined) {
    const mp = available[boundCandidate];
    return {
      kind: "bound",
      pane: mp.pane,
      pid: mp.proc.pid,
      provenance: "start-time",
      confidence: "probable",
    };
  }

  return result.unbound.get(0) === "ambiguous"
    ? { kind: "ambiguous" }
    : { kind: "none" };
}

/**
 * Replace-heuristic decision (shared by ladders 2 and 3): find an existing
 * heuristically-bound Claude session for the same encoded project path that
 * a marker-backed newcomer may replace. Bails (no fallthrough to other
 * candidates — original behavior) when the first match lacks a log path, is
 * itself marker-backed, or fails the caller's pane verification.
 */
export function decideReplaceHeuristic(
  sessions: readonly ReplaceableSessionSlice[],
  encodedProjectPath: string,
  verifyPaneId?: (paneId: string) => boolean,
): ReplaceHeuristicDecision | null {
  const existing = sessions.find(
    (s) =>
      s.agentType === "claude" &&
      s.tmuxPane &&
      s.encodedCwd === encodedProjectPath,
  );

  if (!existing || !existing.logPath) return null;
  if (existing.hasMarker) return null;
  if (verifyPaneId && !verifyPaneId(existing.tmuxPane!)) return null;

  return {
    removeSessionId: existing.id,
    removeLogPath: existing.logPath,
    paneId: existing.tmuxPane!,
  };
}

/**
 * Mirror of `SessionManager.setTmuxPane`'s soft-evict as the apply phase
 * will replay it: binding `entry` to `paneId` clears the pane claim of any
 * other same-agent session holding that pane (any cwd).
 */
function bindInModel(
  model: ReplaceableSessionSlice[],
  entry: ReplaceableSessionSlice,
  paneId: string,
): void {
  // `ReplaceableSessionSlice` has no pid field, so unlike the manager's
  // setter this clears only the pane claim (tripwire: if the slice ever
  // grows a pid, clear it here too).
  for (const other of findSoftEvictTargets(model, entry, paneId)) {
    other.tmuxPane = null;
  }
  entry.tmuxPane = paneId;
}

/** A batch item deferred to the heuristic assignment (phase B). */
interface PoolEntry {
  sessionId: string;
  path: string;
  encodedProjectPath: string;
  transcriptCwd: string | null;
}

/**
 * Ladder 3 (initial Claude batch), two-phase:
 *
 * **Phase A — evidence claims, in sort order.** Existing sessions reserve
 * their panes (`process-existing`), marker-pid matches bind
 * authoritatively, and the marker-backed replace arm runs — exactly the
 * arms whose claims are evidence, not guesses. Items with no such claim
 * are deferred.
 *
 * **Phase B — group-wise heuristic assignment.** Deferred items are
 * grouped by cwd (raw transcript cwd when known — else the encoded
 * dir) and solved as one assignment per group against the panes phase A
 * left unclaimed. This replaces the greedy
 * closest-match-with-`assignedPaneIds` loop: no order dependence, no
 * leftover auto-bind (D5), direction/tolerance eligibility (D1/D2), and
 * ambiguity refusal (D3) — an ambiguous item becomes a visibly UNBOUND
 * session rather than a guessed binding.
 *
 * Phase A completing before ANY heuristic decision is itself a fix: the
 * old interleaved loop let a heuristic item claim (and soft-evict) an
 * existing session's pane merely because its file sorted earlier.
 */
export function decideInitialClaudeBatch(
  items: readonly InitialBatchItem[],
  obs: InitialBatchObservation,
): InitialBatchDecision {
  const actions: InitialBatchAction[] = [];
  const warnings: string[] = [];

  // Sort: marker-backed sessions first (authoritative PID match), then by
  // modification time (most recent first). Determines replace/existing
  // precedence; heuristic pane competition is no longer order-sensitive.
  const sorted = [...items].sort((a, b) => {
    const aHasMarker =
      a.sessionId !== null && obs.markerPidBySessionId.has(a.sessionId);
    const bHasMarker =
      b.sessionId !== null && obs.markerPidBySessionId.has(b.sessionId);
    if (aHasMarker && !bHasMarker) return -1;
    if (!aHasMarker && bHasMarker) return 1;
    if (a.mtimeMs == null || b.mtimeMs == null) return 0;
    return b.mtimeMs - a.mtimeMs;
  });

  const allProcPanes = pairProcsWithPanes(obs.processes, obs.panes);
  const cwdToProcsMap = buildProcPaneMapByEncodedCwd(obs.processes, obs.panes);
  const claimedPaneIds = new Set<string>();

  // Working model of sessions, updated as the batch creates/replaces.
  const model: ReplaceableSessionSlice[] = obs.sessions.map((s) => ({ ...s }));
  const modelIds = new Set(model.map((s) => s.id));

  const pool: PoolEntry[] = [];

  // ---- Phase A: evidence claims ----------------------------------------
  for (const item of sorted) {
    const { path, sessionId, encodedProjectPath } = item;
    if (!sessionId) continue;

    if (modelIds.has(sessionId)) {
      const existing = model.find((s) => s.id === sessionId);
      if (existing?.tmuxPane) {
        claimedPaneIds.add(existing.tmuxPane);
      }
      actions.push({ type: "process-existing", sessionId, path });
      continue;
    }

    if (!encodedProjectPath) continue;

    let matchingProcs = cwdToProcsMap.get(encodedProjectPath);
    let transcriptCwd: string | null = null;
    if (!matchingProcs || matchingProcs.length === 0) {
      // The encoded dir matched no live process. Before dropping the item,
      // consult the raw transcript cwd: under Claude-side
      // encoding drift the encoded key misses even though the process is
      // right there. The read is lazy — items in genuinely dead cwds with
      // no transcript cwd still exit here.
      transcriptCwd = obs.getTranscriptCwd(path);
      if (!transcriptCwd) continue;
      matchingProcs = allProcPanes.filter(
        (mp) => mp.proc.cwd === transcriptCwd,
      );
      if (matchingProcs.length === 0) continue;
    }

    const availableProcs = matchingProcs.filter(
      (mp) => !claimedPaneIds.has(mp.pane.paneId),
    );

    const markerPid = obs.markerPidBySessionId.get(sessionId) ?? null;

    const markerMatch = markerPid
      ? availableProcs.find((mp) => mp.proc.pid === markerPid)
      : null;

    if (markerMatch) {
      // The transcript's own cwd when the drift fallback already read one,
      // else the bound process's — both are the real path, where decoding
      // the project dir name is a lossy guess (issue #156). `proc.cwd` is
      // non-null for anything `pairProcsWithPanes` returns.
      const realCwd = transcriptCwd ?? markerMatch.proc.cwd ?? null;
      actions.push({
        type: "create",
        sessionId,
        path,
        paneId: markerMatch.pane.paneId,
        pid: markerMatch.proc.pid,
        provenance: "marker",
        confidence: "authoritative",
        cwd: realCwd,
      });
      claimedPaneIds.add(markerMatch.pane.paneId);
      const created: ReplaceableSessionSlice = {
        id: sessionId,
        agentType: "claude",
        cwd: realCwd ?? decodeProjectPath(encodedProjectPath),
        encodedCwd: encodedProjectPath,
        tmuxPane: null,
        logPath: path,
        hasMarker: true,
      };
      model.push(created);
      modelIds.add(sessionId);
      bindInModel(model, created, markerMatch.pane.paneId);
      continue;
    }

    if (availableProcs.length === 0) {
      if (!markerPid) continue;

      // Verify the marker PID matches the candidate pane's actual process.
      const replace = decideReplaceHeuristic(
        model,
        encodedProjectPath,
        (paneId) => {
          const paneProc = matchingProcs.find(
            (mp) => mp.pane.paneId === paneId,
          );
          return !!paneProc && paneProc.proc.pid === markerPid;
        },
      );
      if (replace) {
        // Real cwd over the lossy decode, as in the marker arm. The verify
        // callback above only passed because `matchingProcs` holds this pane.
        const realCwd =
          transcriptCwd ??
          matchingProcs.find((mp) => mp.pane.paneId === replace.paneId)?.proc
            .cwd ??
          null;
        actions.push({
          type: "replace",
          removeSessionId: replace.removeSessionId,
          removeLogPath: replace.removeLogPath,
          sessionId,
          path,
          paneId: replace.paneId,
          pid: markerPid,
          cwd: realCwd,
        });
        // Model: replaced session leaves; newcomer joins bound to its pane.
        const idx = model.findIndex((s) => s.id === replace.removeSessionId);
        if (idx >= 0) model.splice(idx, 1);
        modelIds.delete(replace.removeSessionId);
        const replacement: ReplaceableSessionSlice = {
          id: sessionId,
          agentType: "claude",
          cwd: realCwd ?? decodeProjectPath(encodedProjectPath),
          encodedCwd: encodedProjectPath,
          tmuxPane: null,
          logPath: path,
          hasMarker: true,
        };
        model.push(replacement);
        modelIds.add(sessionId);
        bindInModel(model, replacement, replace.paneId);
        // The replaced pane is an evidence claim like any other;
        // the pre-Phase-3 code left it out of the exclusion set.
        claimedPaneIds.add(replace.paneId);
      }
      continue;
    }

    // No authoritative claim — defer to the group-wise assignment. This
    // includes marker-backed items whose marker pid matched no candidate:
    // the marker failed verification, so it earns no more trust than any
    // other heuristic (its pid may be stale or recycled).
    pool.push({
      sessionId,
      path,
      encodedProjectPath,
      transcriptCwd: transcriptCwd ?? obs.getTranscriptCwd(path),
    });
  }

  // ---- Phase B: group-wise heuristic assignment -------------------------
  // Two group families: entries whose raw transcript cwd is known
  // group under it (authoritative — separates encoded-collision siblings,
  // survives encoding drift); entries without one fall back to the encoded
  // dir. Raw groups solve first: their evidence is strictly stronger, so
  // they claim panes ahead of encoded-keyed guesses. The `enc:` prefix
  // keeps the two key spaces from colliding.
  const groups = new Map<string, PoolEntry[]>();
  for (const entry of pool) {
    const key = entry.transcriptCwd ?? `enc:${entry.encodedProjectPath}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  const orderedGroups = [...groups.entries()].sort(
    ([a], [b]) => Number(a.startsWith("enc:")) - Number(b.startsWith("enc:")),
  );

  for (const [key, group] of orderedGroups) {
    for (const entry of group) {
      if (entry.transcriptCwd) {
        const drift = encodingDriftWarning(
          entry.transcriptCwd,
          entry.encodedProjectPath,
        );
        if (drift) warnings.push(`${entry.sessionId}: ${drift}`);
      }
    }

    const candidates = candidatesForSession(
      key.startsWith("enc:") ? null : key,
      key.startsWith("enc:") ? key.slice(4) : "",
      allProcPanes,
      cwdToProcsMap,
    ).filter((mp) => !claimedPaneIds.has(mp.pane.paneId));
    if (candidates.length === 0) continue;

    const result = assignGroup(group.length, candidates.length, (s, c) =>
      claudePairCost(
        group[s].sessionId,
        candidates[c],
        obs.getSessionTimestamps,
      ),
    );
    if (result.overflow) {
      warnings.push(
        `same-cwd group '${key}' exceeds ${ASSIGN_MAX_GROUP} eligible ` +
          `(${group.length} sessions × ${candidates.length} candidates); ` +
          `refusing heuristic binding for the whole group`,
      );
    }

    for (const [s, c] of result.bound) {
      const entry = group[s];
      const mp = candidates[c];
      const realCwd = entry.transcriptCwd ?? mp.proc.cwd ?? null;
      actions.push({
        type: "create",
        sessionId: entry.sessionId,
        path: entry.path,
        paneId: mp.pane.paneId,
        pid: mp.proc.pid,
        provenance: "start-time",
        confidence: "probable",
        cwd: realCwd,
      });
      claimedPaneIds.add(mp.pane.paneId);
      const created: ReplaceableSessionSlice = {
        id: entry.sessionId,
        agentType: "claude",
        cwd: realCwd ?? decodeProjectPath(entry.encodedProjectPath),
        encodedCwd: entry.encodedProjectPath,
        tmuxPane: null,
        logPath: entry.path,
        hasMarker: false,
      };
      model.push(created);
      modelIds.add(entry.sessionId);
      bindInModel(model, created, mp.pane.paneId);
    }

    for (const [s, reason] of result.unbound) {
      // Only ambiguity earns a visible unbound row: the session is tied to
      // the live group but its pane is genuinely indistinguishable.
      // No-signal / outcompeted items are stale transcripts that merely
      // share the cwd — creating rows for those would flood the picker.
      if (reason !== "ambiguous") continue;
      const entry = group[s];
      actions.push({
        type: "create-unbound",
        sessionId: entry.sessionId,
        path: entry.path,
        // No pane to read a cwd from: only the transcript can say.
        cwd: entry.transcriptCwd,
      });
    }
  }

  return { actions, warnings };
}
