import { watch, type FSWatcher } from "chokidar";
import { existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import {
  PROJECTS_DIR,
  MAX_LOG_ENTRIES,
  PANE_IDLE_THRESHOLD_MS,
  SUBAGENT_STALE_TIMEOUT_MS,
} from "../../../lib/config";
import {
  extractSessionIdFromPath,
  readLogTail,
  readLogIncremental,
  readFirstEntryTimestamp,
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
 * Subagent-seeding variant of `capStaleWorking` that also caps `waiting`.
 * A killed or finished subagent's log commonly ends with an unresolved
 * tool_use (derives `waiting`), and subagent waiting counts as activity in
 * `getEffectiveStatus` — replaying an old file must not resurrect it. The
 * parent path deliberately keeps `waiting` on seed (a real prompt persists
 * however old it is); this is for subagents only.
 */
function capStaleSubagentSeed(state: SessionState): SessionState {
  if (
    (state.status !== "working" && state.status !== "waiting") ||
    !state.lastActivityAt
  ) {
    return state;
  }
  const age = Date.now() - new Date(state.lastActivityAt).getTime();
  if (age <= SUBAGENT_STALE_TIMEOUT_MS) return state;
  return {
    ...state,
    status: "idle",
    attentionType: null,
    pendingTool: null,
  };
}

/** How long a subagents-dir activity probe result stays cached. Parent log
 * parses can arrive many times per second while the lead streams; the probe
 * (readdir + per-file stat) must not run on every one of them. */
const DIR_ACTIVITY_CACHE_TTL_MS = 15_000;

/**
 * Claude Code log adapter.
 *
 * Wraps the existing Claude-specific parser and status machine, and owns
 * a private chokidar instance for subagent log files. The main `LogWatcher`
 * watches Claude session files at `PROJECTS_DIR/<encoded>/*.jsonl` (depth:1);
 * this adapter watches the deeper `<session>/subagents/agent-*.jsonl` layer
 * that holds per-subagent log output.
 *
 * Subagents come in two flavors with different lifecycles:
 * - Blocking `Task` tools: the parent log tracks pending task IDs
 *   (`hasActiveSubagent`), and the subagent's own log ends with `end_turn`.
 * - Background teammates (`Agent` tool, `taskKind: in_process_teammate`):
 *   the tool_result acks instantly and the parent ends its turn, so the
 *   parent log carries no subagent bookkeeping and the teammate's log never
 *   records `end_turn`. Discovery keys off write activity in the subagents
 *   dir, and completion is inferred from silence (the reconciler's stale
 *   sweep, SUBAGENT_STALE_TIMEOUT_MS).
 */
export class ClaudeLogAdapter implements LogAdapter {
  readonly agentType = "claude";
  readonly logDirGlob: string;
  readonly watchDepth = 1;

  private sessionManager: SessionManager;

  private subagentWatcher: FSWatcher | null = null;
  private watchedSubagentDirs = new Set<string>();
  private subagentFileOffsets = new Map<string, number>();
  private dirActivityCache = new Map<
    string,
    { checkedAt: number; active: boolean }
  >();

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
    this.dirActivityCache.clear();
  }

  onSessionStateUpdated(sessionId: string, state: SessionState): void {
    this.syncSubagentWatch(sessionId, state.hasActiveSubagent === true);
  }

  /**
   * Reconciler-driven re-evaluation. Parent log parses stop at `end_turn`,
   * but background teammates keep writing their own transcripts afterwards
   * — without this tick, a subagents dir that becomes active after the
   * parent's last parse would never be picked up (and a watched dir would
   * never be torn down once everything went quiet).
   */
  onReconcileTick(session: Readonly<Session>): void {
    if (session.agentType !== "claude") return;
    // `hasActiveSubagent` is parse-state, not persisted on Session; the
    // tick only contributes the dir-activity signal. Blocking-Task attach
    // still comes from the parse path.
    this.syncSubagentWatch(session.id, false);
  }

  private syncSubagentWatch(
    sessionId: string,
    hasActiveSubagent: boolean,
  ): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.logPath) return;

    const subagentDir = this.getSubagentDir(
      session.logPath,
      this.getSessionLogKey(session),
    );
    const isWatching = this.watchedSubagentDirs.has(subagentDir);

    if (!isWatching) {
      // Attach on either subagent signal:
      // - `hasActiveSubagent`: the parent log recorded a blocking `Task`
      //   tool_use whose result hasn't arrived yet.
      // - recent write activity in the subagents dir: background teammates
      //   (`Agent` tool) ack instantly and the parent ends its turn, so the
      //   parent log carries no Task bookkeeping at all. The files being
      //   actively written is the only signal they exist.
      if (hasActiveSubagent || this.subagentDirRecentlyActive(subagentDir)) {
        this.startWatchingSubagents(sessionId);
      }
      return;
    }

    // Watching: decide whether the run is over. Idle subagents remove
    // themselves (SessionManager.updateSubagent filters them out), so a
    // non-empty array means live subagents — never tear down under those,
    // even when the parent reads idle (a lead sitting at its prompt while
    // teammates work is the normal background-agent state, not an exit
    // signal). Working entries whose logs went silent are downgraded by the
    // reconciler's stale sweep, which empties the array and lets this
    // teardown fire on a later tick or parse.
    if (
      session.subagents.length === 0 &&
      !hasActiveSubagent &&
      !this.subagentDirRecentlyActive(subagentDir)
    ) {
      this.stopWatchingSubagents(sessionId);
    }
  }

  /**
   * True when any `agent-*.jsonl` in the dir was modified within
   * SUBAGENT_STALE_TIMEOUT_MS. Results are cached briefly (see
   * DIR_ACTIVITY_CACHE_TTL_MS) because this runs on parent log parses.
   * Sharing the staleness threshold with the reconciler sweep is what
   * prevents an attach/teardown loop: any file old enough to fail this
   * probe also seeds/caps to idle rather than `working`.
   */
  private subagentDirRecentlyActive(subagentDir: string): boolean {
    const cached = this.dirActivityCache.get(subagentDir);
    const now = Date.now();
    if (cached && now - cached.checkedAt <= DIR_ACTIVITY_CACHE_TTL_MS) {
      return cached.active;
    }

    let active = false;
    try {
      for (const name of readdirSync(subagentDir)) {
        if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
        const { mtimeMs } = statSync(join(subagentDir, name));
        if (now - mtimeMs <= SUBAGENT_STALE_TIMEOUT_MS) {
          active = true;
          break;
        }
      }
    } catch {
      // Missing dir or race with file removal → treat as inactive.
      active = false;
    }

    this.dirActivityCache.set(subagentDir, { checkedAt: now, active });
    return active;
  }

  onSessionRemoved(sessionId: string): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !session.logPath) return;

    const subagentDir = this.getSubagentDir(
      session.logPath,
      this.getSessionLogKey(session),
    );
    // Unconditional: onReconcileTick probes (and caches) every session, so
    // even one that never spawned subagents has an entry to drop here.
    this.dirActivityCache.delete(subagentDir);
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
    // Agent IDs come in two shapes: bare hex for anonymous Task subagents
    // (`agent-a3a022...jsonl`) and name-prefixed for named agents/teammates
    // (`agent-areviewer-functionality-962e7b...jsonl`), so accept anything
    // between `agent-` and `.jsonl`.
    const match = path.match(
      /\/([0-9a-f-]{36})\/subagents\/agent-([^/]+)\.jsonl$/,
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
    this.dirActivityCache.delete(subagentDir);

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

    const existing = session.subagents.find((s) => s.agentId === agentId);
    // Spawn time = first transcript entry; read once and carry it forward so
    // the preview can show runtime-since-spawn (the clock Claude's own agent
    // panel displays). The head is immutable, so a re-read after eviction or
    // a daemon restart derives the same value.
    const startedAt =
      existing?.startedAt ?? (await readFirstEntryTimestamp(path));

    const offset = this.subagentFileOffsets.get(path) ?? 0;
    let state: SessionState;

    if (offset === 0) {
      const seeded = await this.seedStateFromTail(path);
      // Seeding often replays finished logs (attach fires `add` for every
      // existing file). Cap silent working/waiting to idle so they don't
      // come back to life; idle entries are filtered out by updateSubagent.
      state = capStaleSubagentSeed(seeded.state);
      this.subagentFileOffsets.set(path, seeded.newOffset);
    } else {
      const { entries, newOffset } = await readLogIncremental(path, offset);
      this.subagentFileOffsets.set(path, newOffset);

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
      startedAt,
    });

    // Propagate subagent activity to parent session to keep it fresh
    if (state.lastActivityAt) {
      this.sessionManager.updateSession(session.id, {
        lastActivityAt: state.lastActivityAt,
      });
    }
  }
}
