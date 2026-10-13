import { existsSync, mkdirSync, readFileSync } from "fs";
import { basename } from "path";
import { watch, type FSWatcher } from "chokidar";
import { MARKERS_DIR } from "../lib/config";
import type { Session } from "../types/session";
import type { HookAdapter, HookManagerContext } from "./hook-adapter";
import {
  getSessionPidMarker,
  getAllSessionPidMarkers,
  getAllSessionPidMarkerFiles,
  filterMarkerCache,
  loadMarkerIntoCache,
  parseMarkerFile,
  type SessionPidMarker,
} from "./session-markers";

export class HookManager {
  private adapters = new Map<string, HookAdapter>();
  private context: HookManagerContext | null = null;
  private markerWatcher: FSWatcher | null = null;
  /**
   * Last-known marker content per file path, used to dispatch
   * onMarkerRemoved with the full marker payload even after unlink.
   */
  private lastSeenByPath = new Map<string, SessionPidMarker>();

  register(adapter: HookAdapter): void {
    this.adapters.set(adapter.agentType, adapter);
  }

  getAdapter(agentType: string): HookAdapter | undefined {
    return this.adapters.get(agentType);
  }

  listAdapters(): HookAdapter[] {
    return [...this.adapters.values()];
  }

  setContext(ctx: HookManagerContext): void {
    this.context = ctx;
  }

  getContext(): HookManagerContext | null {
    return this.context;
  }

  getMarkerForSession(session: Session): SessionPidMarker | null {
    if (!session.nativeSessionId) return null;
    return getSessionPidMarker(session.nativeSessionId);
  }

  getMarkerPidsByAgent(agentType: string): Set<number> {
    const pids = new Set<number>();
    for (const marker of getAllSessionPidMarkers()) {
      if (marker.agent_type === agentType) pids.add(marker.pid);
    }
    return pids;
  }

  /**
   * Siblings of a marker sharing a server PID, used by OpenCode's
   * aggregation step in `onMarkerAdded`/`onMarkerRemoved` to fold all
   * sessions hosted by one server into a single ccmux row.
   */
  getMarkersByAgentAndPid(agentType: string, pid: number): SessionPidMarker[] {
    return filterMarkerCache(
      (m) => m.agent_type === agentType && m.pid === pid,
    );
  }

  /**
   * Open the marker chokidar and fire `onMarkerAdded` for every marker
   * already on disk. Ensures hook-backed sessions are reconstructed when
   * the daemon is restarted mid-session.
   */
  async start(): Promise<void> {
    if (!existsSync(MARKERS_DIR)) {
      mkdirSync(MARKERS_DIR, { recursive: true });
    }

    // Replay existing markers through the adapter registry before starting
    // chokidar so initial state is consistent before live events begin.
    // Each one is recorded by path, like a live add: chokidar ignores these
    // files on its initial scan, and the file is already gone by the time
    // its unlink fires, so this is the only copy `handleMarkerRemoved` has.
    for (const { path, marker } of getAllSessionPidMarkerFiles()) {
      this.lastSeenByPath.set(path, marker);
      await this.dispatchMarkerAdded(marker);
    }

    this.markerWatcher = watch(MARKERS_DIR, {
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      // `atomic: true` is chokidar's default but pinned explicitly:
      // hook scripts write markers via `tmp+mv` (atomic rename), and we
      // need a single coherent `change` event rather than an unlink+add
      // pair on FSEvents/inotify.
      atomic: true,
    });

    this.markerWatcher.on("add", (path) => {
      if (!path.endsWith(".json")) return;
      void this.handleMarkerAdded(path);
    });
    this.markerWatcher.on("change", (path) => {
      if (!path.endsWith(".json")) return;
      void this.handleMarkerChanged(path);
    });
    this.markerWatcher.on("unlink", (path) => {
      if (!path.endsWith(".json")) return;
      void this.handleMarkerRemoved(path);
    });
    this.markerWatcher.on("error", (error) => {
      console.error("HookManager marker watcher error:", error);
    });

    // Wait until chokidar has scanned the directory so callers can emit
    // markers immediately after start() returns.
    await new Promise<void>((resolve) => {
      this.markerWatcher!.once("ready", () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.markerWatcher) {
      await this.markerWatcher.close();
      this.markerWatcher = null;
    }
    this.lastSeenByPath.clear();
  }

  /**
   * Parse a newly-observed marker file and dispatch onMarkerAdded to the
   * registered adapter. Public so tests can exercise the dispatch path
   * without depending on chokidar's filesystem-event timing; called
   * internally from the chokidar "add" listener.
   */
  async handleMarkerAdded(path: string): Promise<void> {
    loadMarkerIntoCache(path);
    const marker = this.readMarkerFromPath(path);
    if (!marker) return;
    this.lastSeenByPath.set(path, marker);
    await this.dispatchMarkerAdded(marker);
    this.notifyMarkerChanged(marker.session_id);
  }

  /**
   * Dispatch onMarkerChanged for a marker file rewrite (tmp+rename).
   * Called from the chokidar "change" listener. Refreshes the cache,
   * runs any per-agent onMarkerChanged, then notifies the daemon so it
   * can reconcile the session through the cascade evaluator immediately
   * instead of waiting for the next scan tick.
   */
  async handleMarkerChanged(path: string): Promise<void> {
    loadMarkerIntoCache(path);
    const marker = this.readMarkerFromPath(path);
    if (!marker) return;
    this.lastSeenByPath.set(path, marker);
    await this.dispatchMarkerChanged(marker);
    this.notifyMarkerChanged(marker.session_id);
  }

  /**
   * Dispatch onMarkerRemoved for a previously-observed marker. The payload
   * has to come from `lastSeenByPath`: by the time chokidar reports the
   * unlink the file is gone, so the re-read fallback finds nothing for a
   * marker that was never recorded. `start()` records the replayed ones.
   */
  async handleMarkerRemoved(path: string): Promise<void> {
    const marker =
      this.lastSeenByPath.get(path) ?? this.readMarkerFromPath(path);
    this.lastSeenByPath.delete(path);
    if (!marker) return;
    const adapter = this.adapters.get(marker.agent_type);
    if (adapter?.onMarkerRemoved && this.context) {
      try {
        await adapter.onMarkerRemoved(marker, this.context);
      } catch (error) {
        console.error(
          `HookManager: ${marker.agent_type} onMarkerRemoved failed for ${basename(path)}`,
          error,
        );
      }
    }
    this.notifyMarkerChanged(marker.session_id);
  }

  private async dispatchMarkerAdded(marker: SessionPidMarker): Promise<void> {
    const adapter = this.adapters.get(marker.agent_type);
    if (!adapter?.onMarkerAdded || !this.context) return;
    try {
      await adapter.onMarkerAdded(marker, this.context);
    } catch (error) {
      console.error(
        `HookManager: ${marker.agent_type} onMarkerAdded failed for session ${marker.session_id}`,
        error,
      );
    }
  }

  private async dispatchMarkerChanged(marker: SessionPidMarker): Promise<void> {
    const adapter = this.adapters.get(marker.agent_type);
    if (!adapter?.onMarkerChanged || !this.context) return;
    try {
      await adapter.onMarkerChanged(marker, this.context);
    } catch (error) {
      console.error(
        `HookManager: ${marker.agent_type} onMarkerChanged failed for session ${marker.session_id}`,
        error,
      );
    }
  }

  private notifyMarkerChanged(sessionId: string): void {
    if (!this.context?.onMarkerChanged) return;
    try {
      this.context.onMarkerChanged(sessionId);
    } catch (error) {
      console.error(
        `HookManager: onMarkerChanged callback failed for ${sessionId}`,
        error,
      );
    }
  }

  private readMarkerFromPath(path: string): SessionPidMarker | null {
    try {
      return parseMarkerFile(readFileSync(path, "utf-8"));
    } catch {
      return null;
    }
  }
}
