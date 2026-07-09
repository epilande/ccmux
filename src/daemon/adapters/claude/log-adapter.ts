import { watch, type FSWatcher } from "chokidar";
import { existsSync } from "fs";
import { join, dirname } from "path";
import {
  PROJECTS_DIR,
  MAX_LOG_ENTRIES,
  PANE_IDLE_THRESHOLD_MS,
} from "../../../lib/config";
import {
  extractSessionIdFromPath,
  readLogTail,
  readLogIncremental,
} from "../../parser";
import {
  deriveStateFromEntries,
  applyEntriesToState,
} from "../../status-machine";
import { getMarkerKey, type SessionManager } from "../../sessions";
import type { Session, SessionState } from "../../../types/session";
import type {
  FullDerivation,
  IncrementalDerivation,
  LogAdapter,
  SessionMetadata,
} from "../../log-adapter";

/**
 * When a Claude log's last activity is older than the idle threshold, a
 * `working` status cannot be genuine — the session just went silent.
 * Cap it to idle to prevent phantom working→idle flaps on daemon restart.
 */
function capStaleWorking(state: SessionState): SessionState {
  if (state.status !== "working" || !state.lastActivityAt) return state;
  const age = Date.now() - new Date(state.lastActivityAt).getTime();
  if (age <= PANE_IDLE_THRESHOLD_MS) return state;
  return {
    ...state,
    status: "idle",
    attentionType: null,
    pendingTool: null,
  };
}

/**
 * Claude Code log adapter.
 *
 * Wraps the existing Claude-specific parser and status machine, and owns
 * a private chokidar instance for Task-tool subagent log files. The main
 * `LogWatcher` watches Claude session files at `PROJECTS_DIR/<encoded>/*.jsonl`
 * (depth:1); this adapter watches the deeper `<session>/subagents/agent-*.jsonl`
 * layer that holds per-subagent log output.
 */
export class ClaudeLogAdapter implements LogAdapter {
  readonly agentType = "claude";
  readonly logDirGlob: string;
  readonly watchDepth = 1;

  private sessionManager: SessionManager;

  private subagentWatcher: FSWatcher | null = null;
  private watchedSubagentDirs = new Set<string>();
  private subagentFileOffsets = new Map<string, number>();

  // `projectsDir` defaults to the primary `~/.claude/projects`. A second
  // instance pointed at another Claude config dir's `projects` tree (e.g.
  // `~/.claude-personal/projects`) lets one daemon watch multiple accounts;
  // see `resolveClaudeProjectDirs`.
  constructor(
    sessionManager: SessionManager,
    projectsDir: string = PROJECTS_DIR,
  ) {
    this.sessionManager = sessionManager;
    this.logDirGlob = projectsDir;
  }

  resolveSessionIdFromPath(path: string): string | null {
    return extractSessionIdFromPath(path);
  }

  parseSessionMetadata(): SessionMetadata | null {
    return null;
  }

  async deriveFullState(path: string): Promise<FullDerivation> {
    const { state: seeded, newOffset } = await this.seedStateFromTail(path);
    const state = capStaleWorking(seeded);
    return { state, newOffset };
  }

  async deriveIncrementalState(
    path: string,
    offset: number,
    prev: SessionState,
  ): Promise<IncrementalDerivation> {
    const { entries, newOffset } = await readLogIncremental(path, offset);
    const state =
      entries.length > 0 ? applyEntriesToState(prev, entries) : prev;
    return { state, newOffset, hasNewEntries: entries.length > 0 };
  }

  /**
   * Read the tail of a file, derive initial state from the entries, and
   * backfill `lastActivityAt` from the last entry when the status machine
   * didn't produce one. Shared by full state derivation and subagent
   * seeding.
   */
  private async seedStateFromTail(path: string): Promise<FullDerivation> {
    const entries = await readLogTail(path, MAX_LOG_ENTRIES);
    let state = deriveStateFromEntries(entries);

    if (entries.length > 0 && !state.lastActivityAt) {
      state = {
        ...state,
        lastActivityAt: entries[entries.length - 1].timestamp,
      };
    }

    let newOffset = 0;
    try {
      newOffset = Bun.file(path).size;
    } catch {
      // Ignore file access errors; offset stays at 0 and next read re-seeds.
    }

    return { state, newOffset };
  }

  async stop(): Promise<void> {
    if (this.subagentWatcher) {
      await this.subagentWatcher.close();
      this.subagentWatcher = null;
    }
    this.watchedSubagentDirs.clear();
    this.subagentFileOffsets.clear();
  }

  onSessionStateUpdated(sessionId: string, state: SessionState): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.logPath) return;

    // Fast path: no active subagent and no existing subagents → nothing to do.
    if (!state.hasActiveSubagent && session.subagents.length === 0) return;

    const subagentDir = this.getSubagentDir(
      session.logPath,
      this.getSessionLogKey(session),
    );
    const isWatching = this.watchedSubagentDirs.has(subagentDir);

    if (state.hasActiveSubagent && !isWatching) {
      this.startWatchingSubagents(sessionId);
      return;
    }

    if (session.subagents.length > 0) {
      const allSubagentsIdle = session.subagents.every(
        (s) => s.status === "idle",
      );
      const shouldClear =
        state.status === "idle" ||
        !state.hasActiveSubagent ||
        (state.status === "waiting" && allSubagentsIdle);

      if (shouldClear) {
        if (isWatching) {
          this.stopWatchingSubagents(sessionId);
        } else {
          this.sessionManager.clearSubagents(sessionId);
        }
      }
    }
  }

  onSessionRemoved(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.logPath) return;

    const subagentDir = this.getSubagentDir(
      session.logPath,
      this.getSessionLogKey(session),
    );
    if (!this.watchedSubagentDirs.has(subagentDir)) return;

    this.subagentWatcher?.unwatch(subagentDir);
    this.watchedSubagentDirs.delete(subagentDir);
    for (const path of this.subagentFileOffsets.keys()) {
      if (path.startsWith(subagentDir)) {
        this.subagentFileOffsets.delete(path);
      }
    }
  }

  private getSessionLogKey(session: Session): string {
    return getMarkerKey(session);
  }

  private getSubagentDir(logPath: string, sessionId: string): string {
    const dir = dirname(logPath);
    return join(dir, sessionId, "subagents");
  }

  private extractSubagentInfo(
    path: string,
  ): { sessionId: string; agentId: string } | null {
    const match = path.match(
      /\/([0-9a-f-]{36})\/subagents\/agent-([a-f0-9]+)\.jsonl$/,
    );
    return match ? { sessionId: match[1], agentId: match[2] } : null;
  }

  private ensureSubagentWatcher(): FSWatcher {
    if (this.subagentWatcher) {
      return this.subagentWatcher;
    }

    const watcher = watch([], {
      persistent: true,
      ignoreInitial: false,
    });

    watcher.on("add", (path) => {
      if (!path.endsWith(".jsonl")) return;
      if (!path.includes("/subagents/agent-")) return;
      this.subagentFileOffsets.set(path, 0);
      void this.handleSubagentChange(path);
    });

    watcher.on("change", (path) => {
      if (!path.endsWith(".jsonl")) return;
      if (!path.includes("/subagents/agent-")) return;
      void this.handleSubagentChange(path);
    });

    watcher.on("error", (error) => {
      console.error("Subagent watcher error:", error);
    });

    this.subagentWatcher = watcher;
    return watcher;
  }

  private startWatchingSubagents(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.logPath) return;

    const subagentDir = this.getSubagentDir(
      session.logPath,
      this.getSessionLogKey(session),
    );
    if (this.watchedSubagentDirs.has(subagentDir)) return;
    if (!existsSync(subagentDir)) return;

    const watcher = this.ensureSubagentWatcher();
    watcher.add(subagentDir);
    this.watchedSubagentDirs.add(subagentDir);
  }

  private stopWatchingSubagents(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.logPath) return;

    const subagentDir = this.getSubagentDir(
      session.logPath,
      this.getSessionLogKey(session),
    );
    if (!this.watchedSubagentDirs.has(subagentDir)) return;

    this.subagentWatcher?.unwatch(subagentDir);
    this.watchedSubagentDirs.delete(subagentDir);

    for (const path of this.subagentFileOffsets.keys()) {
      if (path.startsWith(subagentDir)) {
        this.subagentFileOffsets.delete(path);
      }
    }

    this.sessionManager.clearSubagents(sessionId);
  }

  private async handleSubagentChange(path: string): Promise<void> {
    const info = this.extractSubagentInfo(path);
    if (!info) return;

    const { sessionId, agentId } = info;
    const session =
      this.sessionManager.getSessionByNativeSessionId(sessionId) ?? null;
    if (!session) return;

    const offset = this.subagentFileOffsets.get(path) ?? 0;
    let state: SessionState;

    if (offset === 0) {
      const seeded = await this.seedStateFromTail(path);
      state = seeded.state;
      this.subagentFileOffsets.set(path, seeded.newOffset);
    } else {
      const { entries, newOffset } = await readLogIncremental(path, offset);
      this.subagentFileOffsets.set(path, newOffset);

      const existing = session.subagents.find((s) => s.agentId === agentId);
      const currentState: SessionState = existing
        ? {
            status: existing.status,
            attentionType: existing.attentionType,
            pendingTool: existing.pendingTool,
            inPlanMode: false,
            lastActivityAt: existing.lastActivityAt ?? undefined,
          }
        : {
            status: "idle",
            attentionType: null,
            pendingTool: null,
            inPlanMode: false,
          };

      state =
        entries.length > 0
          ? applyEntriesToState(currentState, entries)
          : currentState;
    }

    this.sessionManager.updateSubagent(session.id, {
      agentId,
      status: state.status,
      attentionType: state.attentionType,
      pendingTool: state.pendingTool,
      lastActivityAt: state.lastActivityAt ?? null,
    });

    // Propagate subagent activity to parent session to keep it fresh
    if (state.lastActivityAt) {
      this.sessionManager.updateSession(session.id, {
        lastActivityAt: state.lastActivityAt,
      });
    }
  }
}
