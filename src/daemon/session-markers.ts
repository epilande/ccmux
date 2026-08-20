import {
  readFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "fs";
import { join } from "path";
import { MARKERS_DIR } from "../lib/config";
import { DaemonPerf } from "./perf";
import { normalizeTty } from "./pane-discovery";

export interface SessionPidMarker {
  agent_type: string;
  pid: number;
  /** Omitted for agents (e.g. OpenCode) that correlate by PID ancestry. */
  tty?: string;
  session_id: string;
  transcript_path?: string;
  timestamp: number;
  state?: "idle" | "working" | "waiting_permission" | "waiting_question";
  state_timestamp?: number;
  pending_tool?: string;
  permission_context?: string;
  /** Per-session cwd. OpenCode only. */
  directory?: string;
  /** Session display title/slug. OpenCode only. */
  title?: string;
  /** Most recent user prompt, capped at 1KB. Cursor only. */
  last_prompt?: string;
}

/**
 * Parse a marker file's JSON content. Returns null when the body is not
 * JSON or when `agent_type` is missing / non-string. Marker files are
 * expected to be `{agent_type}-{session_id}.json` with an explicit
 * `agent_type` string in the body.
 */
export function parseMarkerFile(content: string): SessionPidMarker | null {
  try {
    const raw = JSON.parse(content) as Partial<SessionPidMarker> &
      Record<string, unknown>;
    if (!raw.agent_type || typeof raw.agent_type !== "string") {
      return null;
    }
    return raw as SessionPidMarker;
  } catch {
    return null;
  }
}

// --- In-memory marker cache (refreshed once per scan cycle) ---
const markerCache = new Map<string, SessionPidMarker>();

/**
 * Bulk-load all marker files into the in-memory cache.
 * Call once at the start of each scan cycle.
 */
export function refreshMarkerCache(): void {
  markerCache.clear();
  for (const marker of getAllSessionPidMarkers()) {
    markerCache.set(marker.session_id, marker);
  }
}

/**
 * Load a single marker file into the cache.
 * Used by event-driven paths (e.g. chokidar add) to avoid a full cache rebuild.
 */
export function loadMarkerIntoCache(markerPath: string): void {
  try {
    const content = readFileSync(markerPath, "utf-8");
    const marker = parseMarkerFile(content);
    if (marker) markerCache.set(marker.session_id, marker);
  } catch {
    // Skip malformed or unreadable files.
  }
}

/**
 * Get a session PID marker by session ID.
 * Reads from the in-memory cache populated by refreshMarkerCache().
 */
export function getSessionPidMarker(
  sessionId: string,
): SessionPidMarker | null {
  DaemonPerf.incMarkerReads();
  return markerCache.get(sessionId) ?? null;
}

/**
 * Snapshot the marker cache as session id → marker pid (`null` when the
 * marker carries no usable pid). Key presence means a marker exists. This
 * is the binder's marker observation: a
 * plain data snapshot instead of per-decision cache lookups.
 */
export function getMarkerPidSnapshot(): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const marker of markerCache.values()) {
    map.set(marker.session_id, marker.pid ?? null);
  }
  return map;
}

/**
 * Iterate the in-memory marker cache, returning markers where `predicate`
 * holds. Use this for per-event lookups (e.g. sibling aggregation in
 * hook adapters) instead of `getAllSessionPidMarkers`, which re-reads
 * every marker file from disk.
 */
export function filterMarkerCache(
  predicate: (marker: SessionPidMarker) => boolean,
): SessionPidMarker[] {
  const results: SessionPidMarker[] = [];
  for (const marker of markerCache.values()) {
    if (predicate(marker)) results.push(marker);
  }
  return results;
}

/**
 * Get all session PID markers.
 */
export function getAllSessionPidMarkers(): SessionPidMarker[] {
  DaemonPerf.incMarkerBatchReads();
  if (!existsSync(MARKERS_DIR)) return [];

  try {
    const files = readdirSync(MARKERS_DIR).filter((f) => f.endsWith(".json"));
    const markers: SessionPidMarker[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(join(MARKERS_DIR, file), "utf-8");
        const marker = parseMarkerFile(content);
        if (marker) markers.push(marker);
      } catch {
        // Skip unreadable files.
      }
    }

    return markers;
  } catch {
    return [];
  }
}

/**
 * Marker writers use tmp+rename; a crash between the two orphans the tmp file
 * (nothing reads or deletes non-`.json` files). One hour is far beyond any
 * legitimate write-to-rename window, so a mid-write tmp is never at risk.
 */
const TMP_MARKER_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Clean up stale marker files.
 *
 * Grouped by `(agent_type, session_id)` because OpenCode hosts many
 * sessions under one server PID, so PID is not a uniqueness key. Per
 * group: dedupe same-identity duplicates (newest wins), then apply
 * liveness checks against activePids, activeTtys, and the agent-specific
 * `isSessionStillLive` (dispatched via the HookAdapter registry).
 *
 * Also sweeps orphaned `*.tmp*` files (interrupted tmp+rename writes) past
 * {@link TMP_MARKER_MAX_AGE_MS}: inert, but they would accumulate forever.
 *
 * `pendingPidReap` carries one-scan hysteresis for the PID-liveness check
 * across calls; the caller owns the set and this updates it in place. Step 2
 * below says why that one check is hedged and the others are not.
 */
export function cleanupStaleMarkers(
  activePids: Set<number>,
  activeTtys: Map<number, string> | undefined,
  isSessionStillLive: (marker: SessionPidMarker) => boolean,
  pendingPidReap: Set<string>,
): number {
  if (!existsSync(MARKERS_DIR)) return 0;

  let cleaned = 0;

  const tryUnlink = (path: string): void => {
    try {
      unlinkSync(path);
      cleaned++;
    } catch {
      // Ignore deletion errors.
    }
  };

  const proposedPidReap = new Set<string>();

  try {
    const entries = readdirSync(MARKERS_DIR);

    // Orphaned-tmp sweep: catches both the bare `<name>.json.tmp` and the
    // suffixed `<name>.json.tmp.<pid>.<rand>` writer forms.
    const now = Date.now();
    for (const file of entries) {
      if (file.endsWith(".json") || !file.includes(".tmp")) continue;
      const tmpPath = join(MARKERS_DIR, file);
      try {
        if (now - statSync(tmpPath).mtimeMs >= TMP_MARKER_MAX_AGE_MS) {
          tryUnlink(tmpPath);
        }
      } catch {
        // Raced away or unreadable; skip.
      }
    }

    const files = entries.filter((f) => f.endsWith(".json"));
    const bySession = new Map<
      string,
      Array<{ path: string; marker: SessionPidMarker }>
    >();

    for (const file of files) {
      const markerPath = join(MARKERS_DIR, file);
      let content: string;
      try {
        content = readFileSync(markerPath, "utf-8");
      } catch {
        tryUnlink(markerPath);
        continue;
      }
      const marker = parseMarkerFile(content);
      if (!marker) {
        tryUnlink(markerPath);
        continue;
      }

      const key = `${marker.agent_type}-${marker.session_id}`;
      const bucket = bySession.get(key);
      if (bucket) {
        bucket.push({ path: markerPath, marker });
      } else {
        bySession.set(key, [{ path: markerPath, marker }]);
      }
    }

    for (const markers of bySession.values()) {
      // 1. Same-identity dedupe: keep newest by timestamp.
      if (markers.length > 1) {
        markers.sort(
          (a, b) => (b.marker.timestamp || 0) - (a.marker.timestamp || 0),
        );
        for (let i = 1; i < markers.length; i++) {
          tryUnlink(markers[i].path);
        }
        markers.length = 1;
      }

      const { path: markerPath, marker } = markers[0];

      // 2. PID-liveness, hedged over two consecutive scans.
      //
      // `activePids` is the scan's process discovery, and on macOS that set is
      // gated on a single lsof call resolving each process's tty. A one-tick
      // omission of a live pid (lsof is racy against processes opening and
      // closing fds) would otherwise delete the authoritative marker of a
      // running session, taking its native session id and log path with it.
      // So a pid must be missing on two scans in a row before its marker is
      // reaped — the same two-scan rule stale-session cleanup uses
      // (`binder/cleanup.ts`). The pid is part of the key so a session that
      // re-execs under a new pid starts its own count.
      //
      // Only this check is hedged: the others read the marker's own contents,
      // which do not flicker.
      if (!activePids.has(marker.pid)) {
        const reapKey = `${marker.agent_type}\0${marker.session_id}\0${marker.pid}`;
        if (pendingPidReap.has(reapKey)) {
          tryUnlink(markerPath);
        } else {
          proposedPidReap.add(reapKey);
        }
        continue;
      }

      // 3. TTY mismatch (skipped for markers without a recorded TTY).
      // Normalize BOTH sides: `activeTtys` values are already normalized
      // (scan loop), but a marker's tty may carry a `/dev/` prefix depending on
      // how the hook captured it, so compare on the normalized form like every
      // other tty consumer. Without this a `/dev/ttysNNN` marker never equals a
      // `ttysNNN` snapshot and a live session's authoritative marker is deleted.
      if (activeTtys && marker.tty && marker.tty !== "unknown") {
        const actualTty = activeTtys.get(marker.pid);
        const markerTty = normalizeTty(marker.tty);
        if (actualTty && markerTty && markerTty !== normalizeTty(actualTty)) {
          tryUnlink(markerPath);
          continue;
        }
      }

      // 4. Agent-specific liveness.
      if (!isSessionStillLive(marker)) {
        tryUnlink(markerPath);
      }
    }

    // Swap in this scan's proposals, so a pid that came back silently drops
    // its pending reap. Only on the success path: a directory we could not
    // read is not evidence that anything recovered.
    pendingPidReap.clear();
    for (const reapKey of proposedPidReap) {
      pendingPidReap.add(reapKey);
    }
  } catch {
    // Ignore directory read errors.
  }

  return cleaned;
}
