import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { STATE_FILE } from "../lib/config";
import type { AttentionState, Session } from "../types/session";

/** Default timeout before "read" decays to null (ms) */
const DEFAULT_READ_TIMEOUT_MS = 5_000;

interface PersistedState {
  lastSeen: Record<string, string>;
  version: 1;
}

/**
 * Tracks inbox-style attention state (unread/read/null) per session.
 *
 * Attention is orthogonal to status. It only affects idle sessions:
 * - working/waiting always display their real status
 * - idle + unread = finished while user was away
 * - idle + read = user just acknowledged (brief visual, then clears)
 * - idle + null = nothing new
 *
 * This class holds the timers and the persisted `lastSeen`. Status edges are
 * turned into attention by `AttentionTransitions` (`attention-transitions.ts`)
 * as they happen; the scan (`reconcileAttentionStates`) owns the
 * unread -> read upgrade on viewing and the read -> null decay.
 */
export class AttentionTracker {
  private lastSeen: Map<string, number> = new Map();
  private readAt: Map<string, number> = new Map();
  private readTimeoutMs: number;

  constructor(readTimeoutMs: number = DEFAULT_READ_TIMEOUT_MS) {
    this.readTimeoutMs = readTimeoutMs;
    this.load();
  }

  /**
   * Mark a session as seen (user viewed it). Transitions unread -> read.
   * Pass `persist: false` when the caller will batch-save later.
   */
  markSeen(sessionId: string, persist = true): AttentionState {
    this.lastSeen.set(sessionId, Date.now());
    this.readAt.set(sessionId, Date.now());
    if (persist) this.save();
    return "read";
  }

  shouldClearRead(sessionId: string, now: number = Date.now()): boolean {
    const readTime = this.readAt.get(sessionId);
    if (readTime === undefined) return false;
    return now - readTime >= this.readTimeoutMs;
  }

  hasReadTimer(sessionId: string): boolean {
    return this.readAt.has(sessionId);
  }

  /**
   * Initialize the read decay timer without resetting it.
   * Used when "read" state was set externally (e.g., /seen API).
   */
  initReadTimer(sessionId: string): void {
    if (!this.readAt.has(sessionId)) {
      this.readAt.set(sessionId, Date.now());
    }
  }

  clearRead(sessionId: string): void {
    this.readAt.delete(sessionId);
  }

  isViewingSession(session: Session, activePaneId: string | null): boolean {
    if (!activePaneId || !session.tmuxPane) return false;
    return session.tmuxPane === activePaneId;
  }

  removeSession(sessionId: string): void {
    this.lastSeen.delete(sessionId);
    this.readAt.delete(sessionId);
  }

  /**
   * Prune tracking data for sessions that no longer exist.
   * Iterates all internal collections to avoid orphaned entries.
   */
  prune(activeSessionIds: Set<string>): boolean {
    // Only track lastSeen deletions: it's the only persisted collection,
    // so only its changes need to trigger a save().
    let pruned = false;
    for (const id of this.lastSeen.keys()) {
      if (!activeSessionIds.has(id)) {
        this.lastSeen.delete(id);
        pruned = true;
      }
    }
    for (const id of this.readAt.keys()) {
      if (!activeSessionIds.has(id)) this.readAt.delete(id);
    }
    return pruned;
  }

  private load(): void {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const data = JSON.parse(raw) as PersistedState;
      if (data.version === 1 && data.lastSeen) {
        for (const [id, ts] of Object.entries(data.lastSeen)) {
          this.lastSeen.set(id, new Date(ts).getTime());
        }
      }
    } catch {
      // File doesn't exist or is invalid, start fresh
    }
  }

  save(): void {
    const lastSeen: Record<string, string> = {};
    for (const [id, ts] of this.lastSeen) {
      lastSeen[id] = new Date(ts).toISOString();
    }
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      // STATE_FILE is shared with the TUI's persisted UI state
      // (src/lib/state.ts), so merge over the existing contents instead of
      // overwriting; a whole-file write here would clobber the UI keys.
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      } catch {
        // File doesn't exist or is invalid, write fresh
      }
      const data = { ...existing, lastSeen, version: 1 as const };
      writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch {
      // Ignore write errors
    }
  }
}
