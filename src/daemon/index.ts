import {
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "fs";
import {
  PID_FILE,
  SCAN_INTERVAL_MS,
  PROJECTS_DIR,
  CCMUX_DIR,
  DAEMON_HOST,
  DAEMON_PORT,
  resolveClaudeProjectDirs,
} from "../lib/config";
import { readFirstLine } from "./parser";
import { reconcileSessionMarkerLinks } from "./adapters/link";
import {
  decideMigrationBindings,
  decideCodexRolloutLinks,
  decideMarkerLinks,
  resolveExistingLogPath,
  type CodexLinkCandidate,
} from "./binder";
import { SessionManager } from "./sessions";
import { ClaudeBackgroundSource } from "./sources/claude-background";
import { LogWatcher } from "./watcher";
import { ClaudeLogAdapter } from "./adapters/claude/log-adapter";
import { createBuiltinHookAdapters } from "./adapters";
import { CodexLogAdapter } from "./adapters/codex/log-adapter";
import type { LogAdapter, SessionMetadata } from "./log-adapter";
import { DaemonServer } from "./server";
import { HookManager } from "./hook-manager";
import type { AgentDef } from "../lib/agents";
import { getAgents } from "../lib/agents";
import { getPreferences, type Preferences } from "../lib/preferences";
import { VersionResolver, parseShellTokens } from "./version-resolver";
import { readClaudeHistory } from "./adapters/claude/history";
import {
  getAllSessionPidMarkers,
  cleanupStaleMarkers,
  filterMarkerCache,
  refreshMarkerCache,
} from "./session-markers";
import type {
  ProcessInfo,
  Session,
  SessionState,
  TmuxPane,
} from "../types/session";
import {
  discoverAgentProcesses,
  discoverAgentProcessesOrThrow,
  ProcessDiscoveryError,
} from "./processes";
import {
  listTmuxPanes,
  listTmuxPanesOrThrow,
  PaneDiscoveryError,
  normalizeTty,
  findPaneHostingPid,
} from "./pane-discovery";
import {
  matchSessionsToPanes,
  cleanupStaleSessions,
} from "./session-pane-match";
import { sweepOrphanInvokeSessions } from "./detached-session";
import { ProcessTree } from "./process-tree";
import { DaemonPerf } from "./perf";
import { isProcessAlive } from "./lifecycle";
import {
  getActivePaneId,
  readLogFileMtime,
  reconcileAll,
  reconcileOne,
  type ReconcilerDeps,
} from "./state-reconciler";
import { AttentionTracker } from "./attention-tracker";
import { redirectStdioToLogFile } from "./log-redirect";
import { InvocationManager } from "./invocation-manager";
import { Notifier, buildStateChangedPayload } from "./notifier";
import { createNotifyDelivery } from "./notify-delivery";
import { performJump, type JumpDeps } from "./notify-jump";
import {
  handleNotificationAction,
  type NotificationActionInput,
} from "./notification-action";
import {
  capturePane,
  getPaneCurrentCommand,
  sendKeyToPane,
  sendLiteralToPane,
  sendPromptToPane,
} from "./pane-io";
import { DbusNotifier } from "../lib/notify-dbus";
import { isTerminalFrontmost, resolveTerminalBundleId } from "./focus";
import {
  getActiveTmuxClientPid,
  resolveActiveTmuxClientTty,
} from "../lib/tmux-client";
import {
  deliver as libDeliver,
  probeBackend,
  resolveBackend,
  resolveCcmuxNotifierBinary,
  type SpawnFn,
  type NotificationPayload,
} from "../lib/notify";
import {
  ClaudeInvoker,
  defaultClaudeInvokerDeps,
} from "./invokers/claude-invoker";
import { InvocationRegistry } from "./invokers/registry";
import {
  SubprocessInvoker,
  defaultSubprocessInvokerDeps,
} from "./invokers/subprocess-invoker";

type ClaudeRuntimeMode = "claude-with-hooks" | "claude-no-hooks";

/**
 * Fold the debounce check across every Claude watcher: an extra config-dir
 * watcher records freshness on its own `lastProcessedAt`, so consulting only
 * the primary would let second-account sessions bypass the reconciler's
 * just-processed guard.
 */
export function isRecentlyProcessedByAny(
  watchers: ReadonlyArray<{ isRecentlyProcessed: (id: string) => boolean }>,
  sessionId: string,
): boolean {
  return watchers.some((w) => w.isRecentlyProcessed(sessionId));
}

/**
 * Raise the terminal app hosting the active tmux client to the foreground
 * (macOS `open -b <bundleId>`), so a notification click that jumps to a buried
 * terminal actually surfaces it. Fail-open: any missing client, unresolved
 * bundle id, or spawn failure is swallowed — activation is a nicety on top of
 * the jump, never a hard dependency. Darwin-only by construction (the wiring
 * only installs it there).
 */
async function activateHostTerminal(): Promise<void> {
  try {
    const clientPid = await getActiveTmuxClientPid();
    if (clientPid === null) return;
    const bundleId = await resolveTerminalBundleId(clientPid);
    if (!bundleId) return;
    Bun.spawn(["open", "-b", bundleId], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // best-effort; the jump itself already happened
  }
}

/**
 * Main daemon class
 */
export class Daemon {
  private sessionManager: SessionManager;
  private watcher: LogWatcher;
  /** Extra Claude watchers for additional config dirs
   * (`additionalClaudeConfigDirs` / `CLAUDE_CONFIG_DIR`), one per non-default
   * `projects` tree. Empty unless
   * configured. The primary `watcher` above stays authoritative for
   * marker-driven, path-agnostic `processPath` routing; these add file
   * discovery for their own trees, all feeding the shared SessionManager. */
  private extraClaudeWatchers: LogWatcher[] = [];
  /** All Claude `projects` dirs watched this run (primary first). Used by
   * `buildLogPath` to locate a session's transcript across accounts. */
  private claudeProjectDirs: string[] = [PROJECTS_DIR];
  private codexWatcher: LogWatcher;
  private codexAdapter: CodexLogAdapter;
  private logAdapters: Map<string, LogAdapter> = new Map();
  private logWatchers: Map<string, LogWatcher> = new Map();
  private server: DaemonServer;
  private agents: AgentDef[] = [];
  private scanInterval: Timer | null = null;
  private running = false;
  /** Cache of tmux panes, updated during periodic scan */
  private paneCache: Map<string, TmuxPane> = new Map();
  private hookManager = new HookManager();
  private versionResolver = new VersionResolver();
  private attentionTracker = new AttentionTracker();
  private claudeRuntimeMode: ClaudeRuntimeMode = "claude-no-hooks";
  /** Latest scan's ProcessTree, reused by off-scan consumers so marker
   * events don't re-spawn `ps` on every fire. Null before first scan. */
  private latestProcessTree: ProcessTree | null = null;
  /** One-shot fallbacks for `resolvePaneHostingPid` calls that land before
   * the first scan fills `paneCache`/`latestProcessTree` (boot marker
   * replay). Cleared by the first scan so they can't serve stale data
   * later (e.g. if `paneCache` empties when all panes close). */
  private bootPanesSnapshot: Promise<TmuxPane[]> | null = null;
  private bootTreeSnapshot: Promise<ProcessTree> | null = null;
  /** Unconfirmed destructive-cleanup proposals carried between scans — the
   * two-scan hysteresis state for `cleanupStaleSessions`. */
  private stalePending: ReadonlySet<string> = new Set();
  private invocationManager: InvocationManager;
  /** Created in start() only when `backgroundAgents !== false`; null = the
   * feature is gated off (no watchers, no resync, zero overhead). */
  private backgroundSource: ClaudeBackgroundSource | null = null;
  private notifier: Notifier;
  /** Shared notification delivery closure (Notifier + stale-press re-notify).
   *  Set in the constructor before the server, which needs the action runner
   *  that depends on it. */
  private notifyDeliver: (payload: NotificationPayload) => Promise<void>;
  /** Retracts a session's delivered notification (used when the user views the
   *  pane). Shares the delivery closure's probe cache + dbus connection. */
  private notifyRetract: (sessionId: string) => Promise<void>;
  /** Default-click jump wiring (tmux/ccmux paths, terminal activation),
   *  resolved once at construction and shared by every notification-action
   *  callback rather than rebuilt per button press. */
  private readonly jumpDeps: JumpDeps;

  constructor() {
    this.sessionManager = new SessionManager();
    const claudeAdapter = new ClaudeLogAdapter(this.sessionManager);
    this.logAdapters.set(claudeAdapter.agentType, claudeAdapter);
    this.watcher = new LogWatcher(claudeAdapter, this.sessionManager);
    this.logWatchers.set(claudeAdapter.agentType, this.watcher);

    this.codexAdapter = new CodexLogAdapter();
    this.logAdapters.set(this.codexAdapter.agentType, this.codexAdapter);
    this.codexWatcher = new LogWatcher(this.codexAdapter, this.sessionManager);
    this.logWatchers.set(this.codexAdapter.agentType, this.codexWatcher);

    const claudeInvoker = new ClaudeInvoker(
      defaultClaudeInvokerDeps(this.sessionManager),
    );
    const subprocessInvoker = new SubprocessInvoker(
      defaultSubprocessInvokerDeps(),
    );
    const invocationRegistry = new InvocationRegistry(
      claudeInvoker,
      subprocessInvoker,
    );
    this.invocationManager = new InvocationManager(
      this.sessionManager,
      invocationRegistry,
    );

    // Resolve the daemon's own binaries once (mirroring how it resolves every
    // other tool — `Bun.which`), shared by the delivery layer and the jump
    // wiring below rather than re-resolved per notification-action press.
    const ccmuxPath = Bun.which("ccmux");
    const tmuxPath = Bun.which("tmux") ?? "tmux";
    this.jumpDeps = {
      resolveActiveClientTty: resolveActiveTmuxClientTty,
      tmuxPath,
      ccmuxPath,
      spawn: Bun.spawn as unknown as SpawnFn,
      log: (message: string, error?: unknown) =>
        console.warn(message, error ?? ""),
      // Raising the hosting terminal after a jump is macOS-only (see
      // `notify-jump.ts`); Linux `switch-client` needs no app activation.
      activateTerminal:
        process.platform === "darwin" ? activateHostTerminal : undefined,
    };

    // One delivery closure shared by the Notifier and the notification-action
    // handler's `reNotify`, so its per-backend probe cache and lazy dbus
    // connection aren't duplicated. Its `retract` companion shares the same
    // dbus connection (needed so `CloseNotification` can find the id). Built
    // here (before the server) because the server needs the action runner and
    // the retract hook that depend on it.
    const notifyDelivery = createNotifyDelivery(
      this.buildNotifyDeliveryDeps(ccmuxPath, tmuxPath),
    );
    this.notifyDeliver = notifyDelivery.deliver;
    this.notifyRetract = notifyDelivery.retract;

    this.server = new DaemonServer(
      this.sessionManager,
      () => this.paneCache,
      (agentType) => this.agents.find((a) => a.name === agentType),
      this.attentionTracker,
      this.invocationManager,
      (agentName) => this.hookManager.getAdapter(agentName) ?? null,
      { sendLiteralToPane, sendPromptToPane },
      (input) => this.runNotificationAction(input),
      (sessionId) => this.notifyRetract(sessionId),
    );

    this.hookManager.setContext({
      sessionManager: this.sessionManager,
      getLogWatcher: (agentType) => this.logWatchers.get(agentType),
      getLogWatchers: (agentType) => {
        if (agentType === "claude") return this.claudeWatchers();
        const single = this.logWatchers.get(agentType);
        return single ? [single] : [];
      },
      listProcesses: () => discoverAgentProcesses(this.agents),
      listPanes: () => listTmuxPanes(),
      getPaneHostingPid: (pid) => this.resolvePaneHostingPid(pid),
      onMarkerChanged: (sessionId) => {
        void this.reconcileSessionFromMarkerEvent(sessionId);
      },
    });
    for (const adapter of createBuiltinHookAdapters()) {
      this.hookManager.register(adapter);
    }

    this.sessionManager.on("change", (event) => {
      if (event.type === "removed" && event.sessionId) {
        this.attentionTracker.removeSession(event.sessionId);
      }
    });

    this.notifier = new Notifier({
      sessionManager: this.sessionManager,
      getActivePaneId,
      isTerminalFrontmost: () => isTerminalFrontmost(getActiveTmuxClientPid),
      getPrefs: getPreferences,
      deliver: notifyDelivery.deliver,
      // Same shared closure as the pane-focus retract, so it reuses the deliver
      // path's resolved helper binary and per-backend probe cache.
      retract: notifyDelivery.retract,
      getAgent: (agentType) => this.agents.find((a) => a.name === agentType),
    });
  }

  /**
   * Runs one actionable-notification callback (`POST /notification-action`,
   * and later the Linux D-Bus `ActionInvoked` path) through the shared safety
   * handler, wiring its effect deps: session/agent lookup, pane keystroke/text
   * send, the default-click jump (same routing as the dbus click action), and
   * the stale-press re-notification (reuses the shared delivery closure).
   */
  private runNotificationAction(input: NotificationActionInput) {
    return handleNotificationAction(input, {
      getSession: (id) => this.sessionManager.getSession(id),
      getAgent: (agentType) => this.agents.find((a) => a.name === agentType),
      sendKey: sendKeyToPane,
      sendText: sendLiteralToPane,
      capturePane: (paneId) => capturePane(paneId),
      getPaneCommand: getPaneCurrentCommand,
      jump: (session) =>
        performJump(
          {
            background: session.trackingMode === "background",
            pane: session.tmuxPane,
          },
          this.jumpDeps,
        ),
      reNotify: (session, body) => {
        // Read prefs live so the re-notify carries the configured command/sound
        // (a "command" backend delivers nothing without payload.command).
        void getPreferences()
          .then((prefs) =>
            this.notifyDeliver(
              buildStateChangedPayload(session, body, prefs.notifications),
            ),
          )
          .catch((error) => {
            console.debug("Notifier: state-changed re-notify failed", error);
          });
      },
    });
  }

  /**
   * Assembles what the notification delivery layer needs, given the `ccmux`/
   * `tmux` paths the constructor already resolved once (via `Bun.which`, the
   * same mechanism `resolveBackend`'s auto ladder and `lifecycle.ts`'s hook
   * installers use — shared with the jump wiring rather than re-resolved): the
   * resolved ccmux-notifier helper (env -> brew `libexec` sibling of `ccmux` ->
   * PATH) and the `/notification-action` callback URL (respects `CCMUX_PORT`).
   * `ccmux` not being on PATH degrades gracefully: the D-Bus popup jump is
   * omitted rather than built broken, and the notifier sibling rung is skipped.
   */
  private buildNotifyDeliveryDeps(ccmuxPath: string | null, tmuxPath: string) {
    return {
      getPrefs: getPreferences,
      resolveActiveClientTty: resolveActiveTmuxClientTty,
      resolveBackend,
      probeBackend,
      deliver: libDeliver,
      resolveNotifierPath: () =>
        resolveCcmuxNotifierBinary({ execPath: process.execPath, ccmuxPath }),
      notifierCallbackUrl: `http://${DAEMON_HOST}:${DAEMON_PORT}/notification-action`,
      runNotificationAction: (input: NotificationActionInput) =>
        this.runNotificationAction(input),
      ccmuxPath,
      tmuxPath,
      // `notify-delivery.ts` constructs at most one of these per daemon run,
      // lazily on the first "dbus" delivery (only relevant on Linux with the
      // dbus backend resolved); `dbus-next` itself is loaded even later,
      // inside `DbusNotifier.connect()`.
      createDbusNotifier: () => new DbusNotifier(),
    };
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Daemon is already running");
    }

    mkdirSync(CCMUX_DIR, { recursive: true });

    if (existsSync(PID_FILE)) {
      const existingPid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (isProcessAlive(existingPid)) {
        throw new Error(`Daemon is already running with PID ${existingPid}`);
      }
      unlinkSync(PID_FILE);
    }

    writeFileSync(PID_FILE, String(process.pid));

    // Load supported agents (builtins + user overrides/custom agents)
    const preferences = await getPreferences();
    this.agents = getAgents(preferences);
    // Build extra Claude watchers for any additional config dirs before
    // runtime-mode propagation and session migration so every tree is live
    // from boot.
    this.setupExtraClaudeWatchers(preferences);
    this.claudeRuntimeMode = this.resolveClaudeRuntimeMode();
    for (const w of this.claudeWatchers())
      w.setRuntimeMode(this.claudeRuntimeMode);
    this.checkHooksInstalled();

    // Reap detached `ccmux-invoke-*` tmux sessions from a previous
    // daemon run that exited mid-invocation (SIGKILL, OOM, crash).
    // Their agents would otherwise keep running and consume the user's
    // subscription quota. Best-effort: errors are swallowed. MUST run
    // before the server starts serving /invoke: the sweep kills every
    // ccmux-invoke-* session indiscriminately, so an invocation admitted
    // in the boot window would be reaped as a false orphan.
    const reaped = await sweepOrphanInvokeSessions();
    if (reaped > 0) {
      console.log(
        `Reaped ${reaped} orphan ccmux-invoke-* tmux session(s) from prior run`,
      );
    }

    // Listen before the slow hydration below (session migration, marker
    // replay, initial scan): auto-start callers poll /health with a short
    // budget and would otherwise give up while a session-heavy boot is
    // still replaying markers. Early SSE clients get a sparse `init` and
    // hydrate live via session_created/session_updated broadcasts, which
    // the constructor wires before this line.
    this.server.start();
    this.notifier.start();

    // Migrate/discover existing sessions before starting watcher
    await this.migrateExistingSessions();

    // Populate marker cache before watcher starts so initial batch
    // processing in processInitialHookBackedBatch() has valid data
    refreshMarkerCache();

    await this.hookManager.start();
    // Fire-and-forget: Cursor's anomaly check shells out to
    // `cursor-agent --version` (~0.5s) and must not gate boot. The catch
    // keeps a rejecting adapter from becoming an unhandled rejection,
    // which would take down the daemon.
    this.reportHookInstallAnomalies().catch((error) =>
      console.warn("Hook install anomaly check failed:", error),
    );
    // Claude background/background agents (paneless; sourced from Claude's
    // own roster.json / state.json, independent of hooks and pane scanning).
    // Opt-out gate: only an explicit `backgroundAgents: false` skips the
    // source entirely (no watchers, no rows, no per-scan resync).
    if (preferences.backgroundAgents !== false) {
      this.backgroundSource = new ClaudeBackgroundSource(this.sessionManager);
      await this.backgroundSource.start();
    }
    for (const w of this.claudeWatchers()) w.start();
    this.codexWatcher.start();

    await Promise.all([
      ...this.claudeWatchers().map((w) => w.ready),
      this.codexWatcher.ready,
    ]);

    // Initial scan - also matches existing sessions to panes
    DaemonPerf.startReporter(5);
    await this.scan();

    // Start periodic scan after initial scan completes
    const scheduleScan = () => {
      this.scanInterval = setTimeout(async () => {
        await this.scan();
        if (this.running) scheduleScan();
      }, SCAN_INTERVAL_MS);
    };
    scheduleScan();

    // Set up signal handlers
    this.setupSignalHandlers();

    this.running = true;
    console.log(`Daemon started with PID ${process.pid}`);
  }

  /**
   * Stop the daemon
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    console.log("Stopping daemon...");

    if (this.scanInterval) {
      clearTimeout(this.scanInterval);
      this.scanInterval = null;
    }

    await Promise.all(this.claudeWatchers().map((w) => w.stop()));
    await this.codexWatcher.stop();
    await this.hookManager.stop();
    await this.backgroundSource?.stop();
    this.notifier.stop();
    this.server.stop();

    // Remove PID file
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }

    this.running = false;
    console.log("Daemon stopped");
  }

  /**
   * Perform a scan for supported agent processes and tmux panes.
   */
  private async scan(): Promise<void> {
    const scanStartNs = DaemonPerf.scanStart();
    try {
      refreshMarkerCache();
      // Fail closed: `discoverAgentProcessesOrThrow` throws on a hard `ps`
      // failure rather than returning []. A transient failure then rejects this
      // Promise.all and the outer catch skips the whole cycle, leaving sessions
      // and markers untouched until the next scan. Treating a `ps` hiccup as
      // "no agents" would make cleanupStaleSessions wipe every session and
      // cleanupStaleMarkers delete every hook marker in one pass.
      // Panes fail closed too: a transient tmux failure throws (skipping the
      // cycle) instead of reading as "every pane vanished". A genuine
      // no-server condition still yields []. Hysteresis in cleanup is the
      // backstop for anything that slips through.
      const [processes, panes, processTree] = await Promise.all([
        discoverAgentProcessesOrThrow(this.agents),
        listTmuxPanesOrThrow(),
        ProcessTree.build(),
      ]);

      // Update pane cache for API response enrichment
      this.paneCache.clear();
      for (const pane of panes) {
        this.paneCache.set(pane.paneId, pane);
      }
      this.latestProcessTree = processTree;
      // The live caches above supersede the boot fallbacks; drop them so
      // a later empty paneCache re-lists panes instead of reusing the
      // boot-time snapshot.
      this.bootPanesSnapshot = null;
      this.bootTreeSnapshot = null;

      await this.createOrUpdatePaneTrackedSessions(processes, panes);
      matchSessionsToPanes(this.sessionManager, processes, panes, processTree);
      this.stalePending = cleanupStaleSessions(
        this.sessionManager,
        processes,
        panes,
        this.stalePending,
      );
      this.sessionManager.dedupe();

      const activePids = new Set(processes.map((p) => p.pid));
      const activeTtys = new Map<number, string>();
      const processStartTimeByPid = new Map<number, number | null>();
      for (const p of processes) {
        processStartTimeByPid.set(p.pid, p.startTime ?? null);
        if (p.tty) {
          const normalizedTty = normalizeTty(p.tty);
          if (normalizedTty) {
            activeTtys.set(p.pid, normalizedTty);
          }
        }
      }
      // Sweep stale markers BEFORE the link passes: a
      // marker this scan already knows is dead must not win a link and
      // route enrichment at a pane for one more cycle.
      const cleanupStartNs = DaemonPerf.markerCleanupStart();
      cleanupStaleMarkers(
        activePids,
        activeTtys,
        (marker) =>
          this.hookManager
            .getAdapter(marker.agent_type)
            ?.isSessionStillLive(marker) ?? true,
      );
      DaemonPerf.markerCleanupEnd(cleanupStartNs);

      await this.linkCodexSessions(processes, panes, processStartTimeByPid);
      await this.linkOpenCodeSessions(processStartTimeByPid);
      await this.linkCursorSessions(processStartTimeByPid);
      await this.linkPiSessions(processStartTimeByPid);
      await this.linkAntigravitySessions(processStartTimeByPid);
      await reconcileAll(this.buildReconcilerDeps(), {
        processes,
        panes,
        processTree,
      });

      // Safety resync for background (background-agent) sessions. The chokidar
      // watchers are the primary signal, but a dropped fs event (observed at
      // startup, and possible on macOS FSEvents) would otherwise orphan a row
      // until the next roster write — and nothing else reaps background
      // sessions. This cheap re-read (one small roster.json + a few state.json)
      // also lets the staleness guard flip a frozen worker to idle without an
      // event. Idempotent: unchanged fields no-op.
      this.backgroundSource?.syncFromRoster();

      DaemonPerf.scanEnd(scanStartNs);
      DaemonPerf.report();
    } catch (error) {
      DaemonPerf.scanEnd(scanStartNs);
      if (
        error instanceof ProcessDiscoveryError ||
        error instanceof PaneDiscoveryError
      ) {
        // Fail closed: skip this cycle's mutations entirely rather than act on
        // an empty process/pane list (which would wipe sessions + markers).
        // Retries next scan; a genuinely-empty result does not reach here.
        console.error(`Scan skipped: ${error.message}`);
      } else {
        console.error("Scan error:", error);
      }
    }
  }

  /**
   * Create/update pane-tracked sessions from process + pane discovery.
   */
  private async createOrUpdatePaneTrackedSessions(
    processes: ProcessInfo[],
    panes: TmuxPane[],
  ): Promise<void> {
    const paneByTty = new Map<string, TmuxPane>();
    for (const pane of panes) {
      const tty = normalizeTty(pane.tty);
      if (tty) {
        paneByTty.set(tty, pane);
      }
    }

    const paneTrackedTargets = processes.filter((proc) => {
      if (proc.agentType !== "claude") return true;
      return this.claudeRuntimeMode === "claude-no-hooks";
    });
    await Promise.all(
      paneTrackedTargets.map(async (proc) => {
        const tty = normalizeTty(proc.tty);
        if (!tty) return;
        const pane = paneByTty.get(tty);
        if (!pane) return;

        const cwd = proc.cwd ?? pane.currentPath;
        if (!cwd) return;

        const agent = this.agents.find((a) => a.name === proc.agentType);
        const nativeSessionId =
          proc.agentType === "claude" &&
          this.claudeRuntimeMode === "claude-no-hooks"
            ? undefined
            : await this.resolveNativeSessionId(proc.pid, agent);
        const session = this.sessionManager.createPaneTrackedSession({
          agentType: proc.agentType,
          paneId: pane.paneId,
          cwd,
          pid: proc.pid,
          nativeSessionId,
        });
        this.sessionManager.setTmuxPane(session.id, pane.paneId);
        this.sessionManager.setPid(session.id, proc.pid);
        if (nativeSessionId) {
          this.sessionManager.setNativeSessionId(session.id, nativeSessionId);
        }
        if (!session.version) {
          void this.resolvePaneTrackedSessionVersion(
            session.id,
            proc.command,
            proc.pid,
            agent,
          );
        }
      }),
    );
  }

  /**
   * Get parsed lsof output lines for a PID. Shared by session ID and executable
   * path resolution to avoid duplicating subprocess + parsing logic.
   */
  private async getLsofLines(pid: number): Promise<string[]> {
    DaemonPerf.incSubprocessSpawn("lsof-session");
    const proc = Bun.spawn(["lsof", "-p", String(pid), "-Fn"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.split("\n");
  }

  private async resolveNativeSessionId(
    pid: number,
    agent?: AgentDef,
  ): Promise<string | undefined> {
    if (!agent?.sessionFilePattern) {
      return undefined;
    }

    // Codex never keeps its rollout file FD open after writes settle, so lsof
    // will not surface it. The Codex linking step (`linkCodexSessions`) reads
    // session_meta from rollout files and sets nativeSessionId there.
    if (agent.name === "codex") {
      return undefined;
    }

    try {
      const lines = await this.getLsofLines(pid);
      for (const line of lines) {
        if (!line.startsWith("n") || !line.endsWith(".jsonl")) continue;
        const path = line.slice(1);
        const match = path.match(agent.sessionFilePattern);
        if (match?.[1]) {
          return match[1];
        }
      }
    } catch {
      // Ignore lookup failures
    }

    return undefined;
  }

  private async resolvePaneTrackedSessionVersion(
    sessionId: string,
    processCommand: string,
    pid: number,
    agent?: AgentDef,
  ): Promise<void> {
    if (!agent) return;

    try {
      let version = await this.versionResolver.resolve(agent, processCommand);

      // Some CLIs are launched by bare command names that are absent from daemon PATH.
      // Retry with PID-derived executable path when command token is not absolute.
      if (!version) {
        const firstToken = parseShellTokens(processCommand)[0];
        if (firstToken && !firstToken.includes("/")) {
          const executablePath = await this.resolveProcessExecutablePath(pid);
          if (executablePath) {
            version = await this.versionResolver.resolve(agent, executablePath);
          }
        }
      }

      if (version) {
        this.sessionManager.updateSession(sessionId, { version });
      }
    } catch {
      // Best-effort enrichment – ignore resolver errors.
    }
  }

  private async resolveProcessExecutablePath(
    pid: number,
  ): Promise<string | undefined> {
    try {
      const lines = await this.getLsofLines(pid);
      let expectTxtPath = false;

      for (const line of lines) {
        if (line === "ftxt") {
          expectTxtPath = true;
          continue;
        }
        if (expectTxtPath) {
          expectTxtPath = false;
          if (line.startsWith("n") && line.length > 1) {
            return line.slice(1);
          }
        }
      }
    } catch {}

    return undefined;
  }

  /**
   * Discover sessions for currently running Claude processes only
   * Only creates sessions that have an active tmux pane
   *
   * Matching priority:
   * 0. Marker match (authoritative) - PID from hook-created marker files
   * 1. Process start time correlation - Match session timestamp to process start time
   * 2. Pane timestamp matching - For compatibility with tmux pane_start_time
   */
  private async migrateExistingSessions(): Promise<void> {
    try {
      if (this.claudeRuntimeMode === "claude-no-hooks") return;
      if (!this.claudeProjectDirs.some((dir) => existsSync(dir))) return;

      const claudeProcs = await discoverAgentProcesses(
        this.agents.filter((a) => a.name === "claude"),
      );
      const panes = await listTmuxPanes();

      const { bindings, warnings } = decideMigrationBindings({
        processes: claudeProcs,
        panes,
        markers: getAllSessionPidMarkers(),
        historyEntries: readClaudeHistory(),
        existingSessionIds: new Set(
          this.sessionManager.getSessions().map((s) => s.id),
        ),
        logPathExists: (cwd, sessionId) =>
          existsSync(this.buildLogPath(cwd, sessionId)),
      });

      for (const warning of warnings) {
        console.warn(`[binder] ${warning}`);
      }

      for (const binding of bindings) {
        this.sessionManager.createSession(
          binding.sessionId,
          this.buildLogPath(binding.cwd, binding.sessionId),
          "claude",
        );
        this.sessionManager.setTmuxPane(binding.sessionId, binding.paneId);
        this.sessionManager.setPid(binding.sessionId, binding.pid);
      }
    } catch (error) {
      console.error("Migration error:", error);
    }
  }

  // Locate a session's transcript across every watched Claude config dir
  // (e.g. a `~/.claude-personal` account). See `resolveExistingLogPath`.
  private buildLogPath(cwd: string, sessionId: string): string {
    return resolveExistingLogPath(
      this.claudeProjectDirs,
      cwd,
      sessionId,
      existsSync,
    );
  }

  /** Primary Claude watcher plus any extra config-dir watchers. */
  private claudeWatchers(): LogWatcher[] {
    return [this.watcher, ...this.extraClaudeWatchers];
  }

  // Resolve the configured Claude `projects` dirs and stand up one extra
  // adapter+watcher per non-default tree, all feeding the shared
  // SessionManager — mirroring how each agent is a separate adapter+watcher.
  // The primary `~/.claude/projects` watcher is built in the constructor;
  // this only adds the extras.
  private setupExtraClaudeWatchers(preferences: Preferences): void {
    this.claudeProjectDirs = resolveClaudeProjectDirs(
      preferences.additionalClaudeConfigDirs,
    );
    for (const dir of this.claudeProjectDirs) {
      if (dir === PROJECTS_DIR) continue;
      const adapter = new ClaudeLogAdapter(this.sessionManager, dir);
      this.extraClaudeWatchers.push(
        new LogWatcher(adapter, this.sessionManager),
      );
    }
    if (this.extraClaudeWatchers.length > 0) {
      console.log(
        `Watching ${this.claudeProjectDirs.length} Claude projects dirs: ${this.claudeProjectDirs.join(", ")}`,
      );
    }
  }

  /**
   * Link pane-tracked Codex sessions to their rollout files.
   *
   * Codex writes one rollout file per session under
   * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The first line
   * carries `session_meta` with `id`, `cwd`, and `timestamp`. We match
   * pane-tracked Codex sessions (created without `nativeSessionId`) to the
   * rollout whose `cwd` matches and whose `timestamp` is at or after the
   * process start time, within the `CODEX_LINK_WINDOW_MS` forward window.
   *
   * The window matters: Codex writes the rollout file lazily on the first
   * turn, so a brand-new pane may have no fresh rollout yet. Without a
   * forward-only window, a prior-session rollout in the same cwd would
   * silently win the match. Skipping the link until a fresh rollout appears
   * is correct; the hook path will enrich authoritatively on SessionStart.
   *
   * Best-effort by design: two Codex panes in the same `cwd` started a few
   * seconds apart can swap. Hooks make this authoritative.
   *
   * Skips entirely when there are no unlinked Codex sessions.
   */
  private async linkCodexSessions(
    processes: ProcessInfo[],
    panes: TmuxPane[],
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void> {
    const codexSessions = this.sessionManager
      .getSessions()
      .filter((s) => s.agentType === "codex" && s.trackingMode === "pane");
    if (codexSessions.length === 0) return;

    // Marker-backed ownership re-derivation: verifies every
    // codex session's native id against its own pane's markers and
    // re-dispatches `onMarkerAdded` when a session is unlinked OR holds an
    // id none of its pane's markers carry (a heuristic mis-link the reclaim
    // path then heals). Also closes the daemon-startup replay race (markers
    // written before the first process scan created the session). The
    // adapter's enrichment path is idempotent, so re-running it is cheap.
    await this.reconcileCodexMarkerLinks(
      codexSessions,
      panes,
      processStartTimeByPid,
    );

    // Heuristic fallback only for sessions still unlinked after marker
    // enrichment. Marker-backed sessions don't need the cwd+timestamp
    // guess and could be wrongly linked to a stale rollout in the same cwd.
    const fallbackTargets = this.sessionManager
      .getSessions()
      .filter((s) => s.agentType === "codex" && !s.nativeSessionId);
    if (fallbackTargets.length === 0) return;

    const procByPid = new Map(processes.map((p) => [p.pid, p]));
    const candidates = fallbackTargets
      .map((session) => {
        const proc = session.pid != null ? procByPid.get(session.pid) : null;
        return proc?.cwd && proc.startTime != null
          ? { sessionId: session.id, cwd: proc.cwd, startTime: proc.startTime }
          : null;
      })
      .filter((x): x is CodexLinkCandidate => x !== null);
    if (candidates.length === 0) return;

    const rollouts = await this.scanCodexRollouts();
    if (rollouts.length === 0) return;

    const links = decideCodexRolloutLinks(candidates, rollouts);
    for (const { sessionId, rollout } of links) {
      // On a native-id conflict this rollout's id already belongs to another
      // session; skip the log/enrichment below or both sessions converge onto
      // one transcript (a "noop" re-fire still proceeds).
      if (
        this.sessionManager.setNativeSessionId(
          sessionId,
          rollout.metadata.nativeSessionId,
        ) === "conflict"
      ) {
        continue;
      }
      this.sessionManager.setLogPath(sessionId, rollout.path);
      const enrichment: Partial<SessionState> = {};
      if (rollout.metadata.version)
        enrichment.version = rollout.metadata.version;
      if (rollout.metadata.gitBranch)
        enrichment.gitBranch = rollout.metadata.gitBranch;
      if (Object.keys(enrichment).length > 0) {
        this.sessionManager.updateSession(sessionId, enrichment);
      }
      await this.codexWatcher.processPath(rollout.path);
    }
  }

  /**
   * Per-scan OpenCode marker link pass: closes the daemon-startup replay
   * race AND re-derives native-id ownership. The adapter's
   * aggregation path is idempotent, so re-running is cheap.
   */
  private async linkOpenCodeSessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void> {
    const adapter = this.hookManager.getAdapter("opencode");
    if (!adapter) return;
    const ctx = this.hookManager.getContext();
    if (!ctx) return;
    await reconcileSessionMarkerLinks(adapter, ctx, processStartTimeByPid);
  }

  /**
   * Per-scan Cursor marker link pass. Same shape as the OpenCode variant —
   * Cursor has no aggregation step because each chat has its own marker.
   */
  private async linkCursorSessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void> {
    const adapter = this.hookManager.getAdapter("cursor");
    if (!adapter) return;
    const ctx = this.hookManager.getContext();
    if (!ctx) return;
    await reconcileSessionMarkerLinks(adapter, ctx, processStartTimeByPid);
  }

  /**
   * Per-scan pi marker link pass. pi fires `session_start` (and thus writes
   * its marker) at launch, often before the first process scan has created
   * the pane-tracked session, so this link step is what actually attaches
   * `nativeSessionId`. One marker per session, like Cursor — no aggregation.
   */
  private async linkPiSessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void> {
    const adapter = this.hookManager.getAdapter("pi");
    if (!adapter) return;
    const ctx = this.hookManager.getContext();
    if (!ctx) return;
    await reconcileSessionMarkerLinks(adapter, ctx, processStartTimeByPid);
  }

  private async linkAntigravitySessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void> {
    const adapter = this.hookManager.getAdapter("antigravity");
    if (!adapter) return;
    const ctx = this.hookManager.getContext();
    if (!ctx) return;
    await reconcileSessionMarkerLinks(adapter, ctx, processStartTimeByPid);
  }

  /**
   * Backs `HookManagerContext.getPaneHostingPid`. During `hookManager.start()`
   * replay, chokidar fires before the first scan has filled either cache,
   * so fall back to live `listTmuxPanes` / `ProcessTree.build` when empty.
   * The fallbacks are memoized: the boot replay calls this once per marker
   * (dozens of times back-to-back), and re-spawning `ps`/tmux for each
   * marker dominated daemon boot. Every process a boot-replayed marker
   * references predates the snapshot, so one snapshot is sufficient; a
   * marker for a session spawned inside the pre-first-scan window can miss
   * here and self-heals on the next scan's enrichment pass.
   *
   * Memoizing is safe only because both fallbacks resolve rather than
   * reject (`listTmuxPanes` and `ProcessTree.build` swallow errors and
   * return empty); a cached rejection would otherwise rethrow for every
   * remaining boot-replayed marker.
   */
  private async resolvePaneHostingPid(pid: number): Promise<TmuxPane | null> {
    const panes =
      this.paneCache.size > 0
        ? [...this.paneCache.values()]
        : await (this.bootPanesSnapshot ??= listTmuxPanes());
    if (panes.length === 0) return null;
    const tree =
      this.latestProcessTree ??
      (await (this.bootTreeSnapshot ??= ProcessTree.build()));
    return findPaneHostingPid(pid, panes, tree);
  }

  /**
   * Print any one-shot install anomalies the registered adapters
   * know about (e.g., the Codex hooks feature flag enabled without
   * ccmux hook scripts, or the inverse). Runs once at daemon start.
   */
  private async reportHookInstallAnomalies(): Promise<void> {
    for (const adapter of this.hookManager.listAdapters()) {
      const warnings = (await adapter.describeInstallAnomalies?.()) ?? [];
      for (const warning of warnings) console.warn(warning);
    }
  }

  /**
   * Handle a marker chokidar event (`add` / `change` / `unlink`) for
   * `sessionId` by running a single-session cascade reconcile. Fire-and-
   * forget from the HookManager callback; failures only get logged.
   * `skipDebounce` is on because the event itself is the freshness
   * signal; we don't want the LogWatcher's per-session debounce gate
   * suppressing the immediate apply.
   *
   * Resolution is delegated to
   * `SessionManager.resolveSessionForMarkerEvent`; see that method's
   * JSDoc for the lookup priority, the OpenCode aggregation caveat, and
   * the defensive duplicate-id behavior.
   */
  private async reconcileSessionFromMarkerEvent(
    sessionId: string,
  ): Promise<void> {
    const session = this.sessionManager.resolveSessionForMarkerEvent(sessionId);
    if (!session) return;
    try {
      await reconcileOne(this.buildReconcilerDeps(), session, this.paneCache, {
        skipDebounce: true,
      });
    } catch (error) {
      console.error(
        `Daemon: reconcileOne failed for marker event on ${sessionId}`,
        error,
      );
    }
  }

  private buildReconcilerDeps(): ReconcilerDeps {
    return {
      sessionManager: this.sessionManager,
      // Fold the debounce check across every Claude watcher: an extra
      // config-dir watcher records freshness on its own `lastProcessedAt`, so
      // consulting only the primary would let second-account sessions bypass
      // the reconciler's just-processed guard.
      watcher: {
        isRecentlyProcessed: (id) =>
          isRecentlyProcessedByAny(this.claudeWatchers(), id),
      },
      hookManager: this.hookManager,
      attentionTracker: this.attentionTracker,
      agents: this.agents,
      logAdapters: this.logAdapters,
      now: Date.now,
      // Normalizes Bun's far-future missing-file sentinel to null so every
      // consumer (isLinkedLogSilent, resolveDeadProcessState) agrees on the
      // "missing" signal.
      getLogFileMtime: readLogFileMtime,
    };
  }

  /**
   * Per-scan marker link pass for `linkCodexSessions`. Codex
   * markers carry a TTY, so marker → pane correlates on it (the same join
   * the adapter's own `onMarkerAdded` uses); the ownership decision itself
   * is the binder's `decideMarkerLinks`. Panes come from the scan's own
   * listing, so a steady-state pass costs no extra subprocess.
   */
  private async reconcileCodexMarkerLinks(
    sessions: readonly Session[],
    panes: readonly TmuxPane[],
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void> {
    const adapter = this.hookManager.getAdapter("codex");
    if (!adapter?.onMarkerAdded) return;
    const ctx = this.hookManager.getContext();
    if (!ctx) return;

    const codexMarkers = filterMarkerCache((m) => m.agent_type === "codex");
    if (codexMarkers.length === 0) return;

    const paneIdByTty = new Map<string, string>();
    for (const pane of panes) {
      const tty = normalizeTty(pane.tty);
      if (tty) paneIdByTty.set(tty, pane.paneId);
    }
    const paneByPid = new Map<number, string | null>();
    for (const marker of codexMarkers) {
      const tty = normalizeTty(marker.tty);
      paneByPid.set(marker.pid, (tty && paneIdByTty.get(tty)) || null);
    }

    const links = decideMarkerLinks(
      sessions.map((s) => ({
        sessionId: s.id,
        tmuxPane: s.tmuxPane,
        nativeSessionId: s.nativeSessionId ?? null,
      })),
      codexMarkers,
      paneByPid,
      processStartTimeByPid,
    );
    for (const { marker } of links) {
      await adapter.onMarkerAdded(marker, ctx);
    }
  }

  /**
   * List the most recent Codex rollout files (capped at 200), reading the
   * first line of each and returning those with a parseable `session_meta`.
   * Cap keeps the per-scan globbing bounded under noisy `~/.codex/sessions/`
   * histories.
   */
  private async scanCodexRollouts(): Promise<
    { path: string; metadata: SessionMetadata }[]
  > {
    const sessionsDir = this.codexAdapter.logDirGlob;
    if (!existsSync(sessionsDir)) return [];

    const glob = new Bun.Glob("**/rollout-*.jsonl");
    const paths: string[] = [];
    try {
      for await (const rel of glob.scan({ cwd: sessionsDir, absolute: true })) {
        paths.push(rel);
      }
    } catch {
      return [];
    }

    const withMtime = paths
      .map((p) => {
        try {
          return { path: p, mtime: Bun.file(p).lastModified };
        } catch {
          return null;
        }
      })
      .filter((x): x is { path: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200);

    const results = await Promise.all(
      withMtime.map(async ({ path }) => {
        const firstLine = await readFirstLine(path);
        if (firstLine === null) return null;
        const metadata = this.codexAdapter.parseSessionMetadata(firstLine);
        return metadata ? { path, metadata } : null;
      }),
    );

    return results.filter(
      (r): r is { path: string; metadata: SessionMetadata } => r !== null,
    );
  }

  /**
   * Mode hinges on whether the Claude hook adapter is installed: with hooks
   * present and installed it's `claude-with-hooks`, otherwise `claude-no-hooks`.
   */
  private resolveClaudeRuntimeMode(): ClaudeRuntimeMode {
    const claudeAgent = this.agents.find((agent) => agent.name === "claude");
    if (!claudeAgent?.hooks?.type) {
      return "claude-no-hooks";
    }
    return this.hookManager.getAdapter("claude")?.isInstalled()
      ? "claude-with-hooks"
      : "claude-no-hooks";
  }

  /**
   * Warns (does not block startup) when Claude hooks aren't installed, since
   * the daemon falls back to pane-first tracking in that case.
   */
  private checkHooksInstalled(): void {
    if (this.claudeRuntimeMode === "claude-with-hooks") return;

    console.warn(
      "Warning: Session hooks not installed. Claude will use pane-first tracking until hooks are configured.",
    );
  }

  /**
   * Set up signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const shutdown = async () => {
      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }
}

/**
 * Start the daemon (entry point for daemon process)
 */
export async function startDaemon(): Promise<void> {
  redirectStdioToLogFile();
  const daemon = new Daemon();
  await daemon.start();

  // Keep process running
  await new Promise(() => {});
}

export * from "./lifecycle";
