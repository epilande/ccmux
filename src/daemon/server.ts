import { statSync } from "node:fs";
import {
  DAEMON_PORT,
  DAEMON_HOST,
  HEARTBEAT_INTERVAL_MS,
  isCcmuxPane,
} from "../lib/config";
import { getPreferences } from "../lib/preferences";
import {
  capturePane,
  sendLiteralToPane,
  sendPromptToPane,
} from "./pane-io";
import type { AgentDef } from "../lib/agents";
import {
  getMarkerKey,
  isBackgroundSession,
  type SessionManager,
  type SessionEvent,
} from "./sessions";
import type { SSEEvent, FinishedInvocationStatus } from "../types";
import type { Session, TmuxPane, EnrichedSession } from "../types/session";
import type { AttentionTracker } from "./attention-tracker";
import type { InvocationManager, InvocationEvent } from "./invocation-manager";
import { readInvocationResult } from "./invocation-results";
import { INVOCATION_ID_PATTERN } from "../lib/invoke-helpers";
import { noInvokeModeMessage } from "./invokers/helpers";
import { capabilitiesFor } from "./invokers/invoker";
import type { InvokeInput, InvokeResult } from "./invokers/types";
import type { HookAdapter } from "./hook-adapter";
import { PRResolver } from "./pr-resolver";
import {
  searchTranscript,
  MIN_QUERY_LEN,
  SEARCH_CONCURRENCY,
  type SessionMatches,
} from "./transcript-search";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * SSE client connection
 */
interface SSEClient {
  id: string;
  controller: ReadableStreamDefaultController<string>;
}

/** Function to get the current pane cache from the daemon */
type PaneCacheGetter = () => Map<string, TmuxPane>;
type AgentLookup = (agentType: string) => AgentDef | undefined;
interface PaneSendDeps {
  sendLiteralToPane: typeof sendLiteralToPane;
  sendPromptToPane: typeof sendPromptToPane;
}

/** Cached git branch result */
interface BranchCacheEntry {
  branch: string | null;
  expiresAt: number;
}

/** Cached git worktree result */
interface WorktreeCacheEntry {
  isWorktree: boolean;
  expiresAt: number;
}

const BRANCH_CACHE_TTL_MS = 30_000;
/** How often to sweep visible sessions' (cwd, branch) keys through the
 *  PR resolver. Sweeps are cheap (cached reads; only expired keys spawn
 *  gh), and worst-case PR staleness = resolver TTL + this interval. */
const PR_SWEEP_INTERVAL_MS = 2 * 60_000;

const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_INVOKE_TIMEOUT_MS = 30 * 60 * 1000;

/** Prefix `ClaudeInvoker` uses for its detached tmux session name. */
const INVOKE_SESSION_PREFIX = "ccmux-invoke-";

/**
 * Pull the `inv_...` invocation id out of a tmux session name when the
 * pane lives inside a `ccmux-invoke-<id>` detached session (the Claude
 * invoke path). Returns null for every normal user session name, and for
 * a malformed remainder that fails `INVOCATION_ID_PATTERN` (defense
 * against a user who happens to name a session `ccmux-invoke-foo`).
 */
function originInvocationIdFromSessionName(
  sessionName: string | null | undefined,
): string | null {
  if (!sessionName || !sessionName.startsWith(INVOKE_SESSION_PREFIX)) {
    return null;
  }
  const id = sessionName.slice(INVOKE_SESSION_PREFIX.length);
  return INVOCATION_ID_PATTERN.test(id) ? id : null;
}

/**
 * Map an `InvocationManager` lifecycle event to its flat SSE event. The
 * record's epoch-ms `startedAt` becomes an ISO string (consistent with
 * every other timestamp on the wire); the board derives the live age from
 * it. `started` carries no session/pane (unknowable at admission).
 */
export function invocationEventToSSE(event: InvocationEvent): SSEEvent {
  const { record } = event;
  const timestamp = new Date().toISOString();
  if (event.type === "started") {
    return {
      type: "invocation_started",
      timestamp,
      invocationId: record.invocationId,
      agent: record.agent,
      cwd: record.cwd,
      startedAt: new Date(record.startedAt).toISOString(),
    };
  }
  // `finish()` always sets a terminal status before emitting `finished`,
  // so `running` is unreachable here; narrow to it defensively as `failed`.
  const status: FinishedInvocationStatus =
    record.status === "running" ? "failed" : record.status;
  return {
    type: "invocation_finished",
    timestamp,
    invocationId: record.invocationId,
    agent: record.agent,
    status,
    ...(record.durationMs !== undefined
      ? { durationMs: record.durationMs }
      : {}),
    ...(record.kind !== undefined ? { kind: record.kind } : {}),
  };
}
/**
 * Upper bound on `prompt` body bytes. Accommodates realistic piped
 * inputs (git diffs, test logs) while preventing a misbehaving caller
 * from streaming gigabytes of stdin into daemon memory. Symmetric with
 * the much-smaller send-to-session cap (10K) above, but invoke prompts
 * are expected to include diffs and file contents, so the budget is
 * wider.
 */
const MAX_INVOKE_PROMPT_BYTES = 256 * 1024;
const STATE_CHANGING_METHODS = new Set(["POST", "DELETE", "PUT", "PATCH"]);

/** Hostnames that legitimately address the loopback-bound daemon socket. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Reject any non-loopback `Host` to defeat DNS rebinding: a browser lured to a
 * hostname rebound to 127.0.0.1 still sends that hostname in `Host`, and the
 * Origin guard doesn't cover GET (which can read pane contents). Missing Host is
 * allowed (browsers always send it, so it can't carry the attack).
 */
export function rejectNonLoopbackHost(req: Request): Response | null {
  const host = req.headers.get("Host");
  if (!host) return null;

  let hostname = host;
  if (hostname.startsWith("[")) {
    const close = hostname.indexOf("]");
    if (close !== -1) hostname = hostname.slice(1, close);
  } else {
    // A lone colon is a `:port` suffix; multiple colons is a bare IPv6
    // literal (`::1`) with no port, which we keep intact.
    const colon = hostname.indexOf(":");
    if (colon !== -1 && colon === hostname.lastIndexOf(":")) {
      hostname = hostname.slice(0, colon);
    }
  }

  if (LOOPBACK_HOSTS.has(hostname)) return null;

  return new Response("Invalid Host header", {
    status: 403,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Browsers always send `Origin` on cross-origin fetches with side effects;
 * ccmux's first-party CLIs and the in-process TUI never do. Treat any
 * state-changing request that carries an `Origin` header as a hostile
 * CSRF attempt and reject with 403 + no CORS allowance, so the browser's
 * own CORS layer also blocks the response from being read.
 */
export function rejectCrossOriginBrowser(req: Request): Response | null {
  const origin = req.headers.get("Origin");
  if (!origin) return null;

  let method = req.method;
  if (method === "OPTIONS") {
    const requested = req.headers.get("Access-Control-Request-Method");
    if (requested) method = requested.toUpperCase();
  }
  if (!STATE_CHANGING_METHODS.has(method)) return null;

  return new Response("Cross-origin requests are not allowed", {
    status: 403,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * HTTP/SSE Server for the daemon
 */
export class DaemonServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private sessionManager: SessionManager;
  private sseClients: Map<string, SSEClient> = new Map();
  private heartbeatInterval: Timer | null = null;
  private prSweepInterval: Timer | null = null;
  private getPaneCache: PaneCacheGetter;
  private getAgentByType: AgentLookup;
  private visibleSessions = new Set<string>();
  private branchCache = new Map<string, BranchCacheEntry>();
  private worktreeCache = new Map<string, WorktreeCacheEntry>();
  private prResolver: PRResolver;
  private lastActivePaneId: string | null = null;
  /**
   * The tmux socket this daemon scans (`#{socket_path}`), resolved lazily and
   * cached. Exposed via `GET /server-info` so consumers can refuse a cross-server
   * `%N` (see the single-server invariant in pane-discovery.ts).
   */
  private serverSocketPath: string | null = null;
  private lastSidebarState: {
    selectedSessionId: string | null;
    selectedHeaderKey: string | null;
  } = { selectedSessionId: null, selectedHeaderKey: null };
  private attentionTracker: AttentionTracker;
  private invocationManager: InvocationManager;
  private getHookAdapter: (agentName: string) => HookAdapter | null;
  private paneSendDeps: PaneSendDeps;

  constructor(
    sessionManager: SessionManager,
    getPaneCache: PaneCacheGetter,
    getAgentByType: AgentLookup,
    attentionTracker: AttentionTracker,
    invocationManager: InvocationManager,
    getHookAdapter: (agentName: string) => HookAdapter | null,
    paneSendDeps: PaneSendDeps = { sendLiteralToPane, sendPromptToPane },
  ) {
    this.sessionManager = sessionManager;
    this.getPaneCache = getPaneCache;
    this.getAgentByType = getAgentByType;
    this.attentionTracker = attentionTracker;
    this.invocationManager = invocationManager;
    this.getHookAdapter = getHookAdapter;
    this.paneSendDeps = paneSendDeps;

    // Listen for session changes
    this.sessionManager.on("change", async (event: SessionEvent) => {
      const sseEvent = await this.sessionEventToSSE(event);
      if (sseEvent) this.broadcastEvent(sseEvent);
    });

    // Subscribe to invocation lifecycle, mirroring the sessionManager
    // subscription above. Broadcasts a flat `invocation_started` /
    // `invocation_finished` SSE event for every invoke (Claude included).
    // The server stays dumb transport here: the board's de-dup policy
    // (skip-and-wait for Claude, which renders as its real detached
    // session via `session_created`) lives in the TUI, not here.
    this.invocationManager.on("change", (event: InvocationEvent) => {
      this.broadcastEvent(invocationEventToSSE(event));
    });

    // PR lookups resolve in the background; when one lands a changed
    // value, re-broadcast the affected sessions so idle rows pick it up
    // without waiting for their next organic event.
    this.prResolver = new PRResolver({
      onChange: (cwd, branch) => {
        void this.onBranchPRsChanged(cwd, branch);
      },
    });
  }

  /**
   * Touch every visible session's (cwd, branch) key so the PR resolver
   * refreshes expired entries even when no organic event re-enriches the
   * session. Enrichment reads are cache-backed; results are discarded —
   * the point is the `get()` side effect, and any landed change
   * broadcasts via onBranchPRsChanged.
   */
  private async sweepBranchPRs(): Promise<void> {
    for (const session of this.sessionManager.getSessions()) {
      if (!this.visibleSessions.has(session.id)) continue;
      await this.enrichSession(session);
    }
  }

  private async onBranchPRsChanged(cwd: string, branch: string) {
    const timestamp = new Date().toISOString();
    const paneCache = this.getPaneCache();
    for (const session of this.sessionManager.getSessions()) {
      if (!this.visibleSessions.has(session.id)) continue;
      // Cheap synchronous pre-filter on cwd before paying for the enrich:
      // on a cold cache this handler fires once per changed key, so
      // enriching every visible session here is sessions × keys calls.
      // Mirrors enrichSession's effectiveCwd (pane cwd, else log cwd).
      const paneInfo = session.tmuxPane
        ? paneCache.get(session.tmuxPane)
        : null;
      if ((paneInfo?.currentPath ?? session.cwd) !== cwd) continue;
      const enriched = await this.enrichSession(session);
      if (enriched.gitBranch !== branch) continue;
      this.broadcastEvent({
        type: "session_updated",
        timestamp,
        session: enriched,
      });
    }
  }

  private async getGitBranch(cwd: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.branchCache.get(cwd);
    if (cached && cached.expiresAt > now) return cached.branch;

    let branch: string | null = null;
    try {
      const proc = Bun.spawn(
        ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        branch = (await new Response(proc.stdout).text()).trim() || null;
      }
    } catch {
      // Not a git repo or git not available
    }

    this.branchCache.set(cwd, { branch, expiresAt: now + BRANCH_CACHE_TTL_MS });
    return branch;
  }

  private async isGitWorktree(cwd: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.worktreeCache.get(cwd);
    if (cached && cached.expiresAt > now) return cached.isWorktree;

    let isWorktree = false;
    try {
      const proc = Bun.spawn(["git", "-C", cwd, "rev-parse", "--git-dir"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const gitDir = (await new Response(proc.stdout).text()).trim();
        isWorktree = gitDir.includes("/worktrees/");
      }
    } catch {
      // Not a git repo or git not available
    }

    this.worktreeCache.set(cwd, {
      isWorktree,
      expiresAt: now + BRANCH_CACHE_TTL_MS,
    });
    return isWorktree;
  }

  private async enrichSession(session: Session): Promise<EnrichedSession> {
    const paneCache = this.getPaneCache();
    const paneInfo = session.tmuxPane ? paneCache.get(session.tmuxPane) : null;
    const tmuxTarget = paneInfo?.target ?? null;
    const paneCwd = paneInfo?.currentPath ?? null;
    // Use pane cwd (real shell state) when available, fall back to log-derived cwd
    const effectiveCwd = paneCwd ?? session.cwd;
    const gitBranch =
      (await this.getGitBranch(effectiveCwd)) ?? session.gitBranch;
    const isWorktree = await this.isGitWorktree(effectiveCwd);
    // Synchronous cache read; the resolver refreshes in the background and
    // onBranchPRsChanged re-broadcasts when a lookup lands a new value.
    const branchPRs = this.prResolver.get(effectiveCwd, gitBranch);
    // Derived exactly like tmuxTarget, off the same paneInfo: a Claude
    // invoke runs inside a `ccmux-invoke-<id>` detached session, so the
    // pane's sessionName carries the invocation id. No cold-cache
    // listTmuxPanes fallback: enrichSession re-runs on every
    // session_updated and an active invoke ticks continuously, so a cold
    // cache resolves on the next tick.
    const originInvocationId = originInvocationIdFromSessionName(
      paneInfo?.sessionName,
    );

    return {
      ...session,
      tmuxTarget,
      paneCwd,
      gitBranch,
      isWorktree,
      branchPRs,
      originInvocationId,
    };
  }

  private async enrichSessions(
    sessions: Session[],
  ): Promise<EnrichedSession[]> {
    return Promise.all(sessions.map((s) => this.enrichSession(s)));
  }

  private resolveSession(id: string): Session | undefined {
    const session = this.sessionManager.getSession(id);
    if (session) return session;

    // Fall back to pane ID lookup
    return this.sessionManager.getSessions().find((s) => s.tmuxPane === id);
  }

  /**
   * Start the HTTP server
   */
  start(): void {
    this.server = Bun.serve({
      port: DAEMON_PORT,
      hostname: DAEMON_HOST,
      idleTimeout: 30, // Must exceed HEARTBEAT_INTERVAL_MS (15s) for SSE connections
      fetch: (req) => this.handleRequest(req),
    });

    this.heartbeatInterval = setInterval(() => {
      this.broadcastEvent({
        type: "heartbeat",
        timestamp: new Date().toISOString(),
      });
    }, HEARTBEAT_INTERVAL_MS);

    // PR refreshes are demand-driven (a read of a stale key schedules
    // one), so a fully idle session would serve a stale PR indefinitely —
    // e.g. a merged PR lingering as open. Sweeping enrichment over the
    // visible sessions touches every (cwd, branch) key, capping staleness
    // at the resolver TTL plus this interval; landed changes broadcast
    // through onBranchPRsChanged like any other refresh.
    this.prSweepInterval = setInterval(() => {
      void this.sweepBranchPRs();
    }, PR_SWEEP_INTERVAL_MS);

    console.log(`Daemon server listening on ${DAEMON_HOST}:${DAEMON_PORT}`);

    this.installPaneFocusHook();
  }

  stop(): void {
    this.removePaneFocusHook();
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.prSweepInterval) {
      clearInterval(this.prSweepInterval);
      this.prSweepInterval = null;
    }

    for (const client of this.sseClients.values()) {
      try {
        client.controller.close();
      } catch {
        // Ignore
      }
    }
    this.sseClients.clear();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  private static readonly ACTIVE_PANE_HOOKS = [
    "after-select-pane[50]",
    "after-select-window[50]",
  ] as const;

  /**
   * Install tmux hooks to notify daemon of pane focus changes.
   * Uses after-select-pane and after-select-window (compatible with tmux 3.x).
   */
  private installPaneFocusHook(): void {
    // Trailing `|| true` keeps the shell exit status 0 when the daemon isn't
    // listening (curl exit 7). Without it, tmux surfaces the non-zero exit
    // from `run-shell -b` as a status-line message on every pane switch
    // whenever a stale hook outlives the daemon.
    const hookCmd = `run-shell -b 'curl -s -X POST http://${DAEMON_HOST}:${DAEMON_PORT}/active-pane -H "Content-Type:application/json" -d "{\\"paneId\\":\\"#{pane_id}\\"}" > /dev/null 2>&1 || true'`;
    for (const hook of DaemonServer.ACTIVE_PANE_HOOKS) {
      Bun.spawn(["tmux", "set-hook", "-g", hook, hookCmd], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  }

  /**
   * Remove pane focus hooks on shutdown
   */
  private removePaneFocusHook(): void {
    for (const hook of DaemonServer.ACTIVE_PANE_HOOKS) {
      Bun.spawn(["tmux", "set-hook", "-gu", hook], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const badHost = rejectNonLoopbackHost(req);
    if (badHost) return badHost;

    const cross = rejectCrossOriginBrowser(req);
    if (cross) return cross;

    const url = new URL(req.url);
    const path = url.pathname;

    // No Access-Control-Allow-Origin: ccmux has no browser clients, and an
    // omitted Allow-Origin makes the browser refuse to expose response bodies
    // for any read that does sneak through. Methods/Headers are kept for
    // tooling that might preflight a same-origin request.
    const corsHeaders = {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Route requests
    if (path === "/health" && req.method === "GET") {
      return this.handleHealth(corsHeaders);
    }

    if (path === "/server-info" && req.method === "GET") {
      return Response.json(
        { socketPath: await this.getServerSocketPath() },
        { headers: corsHeaders },
      );
    }

    if (path === "/sessions" && req.method === "GET") {
      return await this.handleGetSessions(url, corsHeaders);
    }

    if (path === "/search" && req.method === "GET") {
      return await this.handleSearch(url, corsHeaders);
    }

    // Suffixed GET routes must come before the generic GET /sessions/{id} catch-all
    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/screen") &&
      req.method === "GET"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/screen".length);
      return await this.handleScreenSession(sessionId, url, corsHeaders);
    }

    if (path.startsWith("/sessions/") && req.method === "GET") {
      const sessionId = path.slice("/sessions/".length);
      return await this.handleGetSession(sessionId, corsHeaders);
    }

    if (path === "/sessions/kill-all" && req.method === "POST") {
      return this.handleKillAllSessions(corsHeaders);
    }

    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/send") &&
      req.method === "POST"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/send".length);
      return await this.handleSendToSession(sessionId, req, corsHeaders);
    }

    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/restart") &&
      req.method === "POST"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/restart".length);
      return await this.handleRestartSession(sessionId, corsHeaders);
    }

    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/kill") &&
      req.method === "POST"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/kill".length);
      return this.handleKillSession(sessionId, corsHeaders);
    }

    if (
      path.startsWith("/sessions/") &&
      path.endsWith("/seen") &&
      req.method === "POST"
    ) {
      const sessionId = path.slice("/sessions/".length, -"/seen".length);
      return this.handleMarkSeen(sessionId, corsHeaders);
    }

    if (path.startsWith("/sessions/") && req.method === "DELETE") {
      const sessionId = path.slice("/sessions/".length);
      return this.handleDeleteSession(sessionId, corsHeaders);
    }

    if (path === "/active-pane" && req.method === "POST") {
      return await this.handleActivePaneNotification(req, corsHeaders);
    }

    if (path === "/sidebar-state" && req.method === "POST") {
      return await this.handleSidebarStateUpdate(req, corsHeaders);
    }

    if (path === "/sidebar-state" && req.method === "GET") {
      return Response.json(this.lastSidebarState, { headers: corsHeaders });
    }

    if (path === "/spawn" && req.method === "POST") {
      return await this.handleSpawn(req, corsHeaders);
    }

    if (path === "/invoke" && req.method === "POST") {
      return await this.handleInvoke(req, corsHeaders);
    }

    if (
      path.startsWith("/invoke/") &&
      path.endsWith("/cancel") &&
      req.method === "POST"
    ) {
      const id = path.slice("/invoke/".length, -"/cancel".length);
      return await this.handleInvokeCancel(id, corsHeaders);
    }

    if (path === "/invocations" && req.method === "GET") {
      return Response.json(
        { invocations: this.invocationManager.listInvocations() },
        { headers: corsHeaders },
      );
    }

    if (
      path.startsWith("/invocations/") &&
      path.endsWith("/result") &&
      req.method === "GET"
    ) {
      const id = path.slice("/invocations/".length, -"/result".length);
      return await this.handleInvocationResult(id, corsHeaders);
    }

    if (path === "/events" && req.method === "GET") {
      return this.handleSSE();
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  /**
   * Whether a session should be surfaced to clients. Pane-tracked/native
   * sessions are visible once they have a tmux pane; background
   * (background-agent) sessions are paneless by nature and visible from
   * creation (their `created` event IS their visible moment).
   */
  private isVisibleSession(s: Readonly<Session>): boolean {
    return (
      s.tmuxPane !== null ||
      s.trackingMode === "background" ||
      // Transcript-backed native sessions are visible even without a pane:
      // when the binder refuses to guess (ambiguous
      // evidence) the row must be VISIBLY unbound, not hidden — an unbound
      // row self-corrects (marker arrival, rebind attempt) or is reaped by
      // the zombie cleanup, and hiding it would just re-disguise the
      // refusal as a missing session. Pane-tracked sessions keep the
      // pane-gated promotion: their existence IS their pane.
      (s.trackingMode === "native" && s.logPath !== null)
    );
  }

  /**
   * Resolve this daemon's tmux socket path. Works without an attached client
   * (the daemon runs detached): `display-message -p` reads the server from the
   * inherited env — the same one `list-panes -a` scans. Caches the first success;
   * a null (no server up yet) is not cached, so the guard engages once tmux is up.
   */
  private async getServerSocketPath(): Promise<string | null> {
    if (this.serverSocketPath) return this.serverSocketPath;
    try {
      const proc = Bun.spawn(
        ["tmux", "display-message", "-p", "#{socket_path}"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const [out, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      if (code === 0) {
        this.serverSocketPath = out.trim() || null;
      }
    } catch {
      // No server / spawn failure: leave unresolved, retry on next request.
    }
    return this.serverSocketPath;
  }

  private handleHealth(headers: Record<string, string>): Response {
    const allSessions = this.sessionManager.getSessions();
    const data = {
      status: "ok",
      sessions: allSessions.filter((s) => this.isVisibleSession(s)).length,
      trackedSessions: allSessions.length,
      clients: this.sseClients.size,
      uptime: process.uptime(),
    };

    return Response.json(data, { headers });
  }

  private async handleGetSessions(
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const showAll = url.searchParams.get("all") === "true";
    let sessions = this.sessionManager.getSessions();
    if (!showAll) sessions = sessions.filter((s) => this.isVisibleSession(s));
    return Response.json(
      { sessions: await this.enrichSessions(sessions) },
      { headers },
    );
  }

  /**
   * On-demand transcript search across the visible Claude/Codex sessions.
   * Reads each session's live transcript (tail-bounded) and returns per-session
   * snippets so the TUI can match text the in-memory prompt index doesn't cover
   * (full history, plus assistant turns). Runs in bounded concurrent batches.
   */
  private async handleSearch(
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (q.length < MIN_QUERY_LEN) {
      return Response.json(
        { error: "query too short" },
        { status: 400, headers },
      );
    }

    const query = q.toLowerCase();
    const sessions = this.sessionManager
      .getSessions()
      .filter((s) => this.isVisibleSession(s));

    const results: SessionMatches[] = [];
    for (let i = 0; i < sessions.length; i += SEARCH_CONCURRENCY) {
      const batch = sessions.slice(i, i + SEARCH_CONCURRENCY);
      const settled = await Promise.all(
        batch.map((s) =>
          searchTranscript(
            { id: s.id, agentType: s.agentType, logPath: s.logPath },
            query,
          ),
        ),
      );
      for (const match of settled) {
        // Drop nulls (unsupported agent / no log / read failure) and sessions
        // with no textual hit, so the response carries only genuine matches.
        if (match && match.matches.length > 0) results.push(match);
      }
    }

    return Response.json({ query: q, results }, { headers });
  }

  private async handleGetSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    return Response.json(
      { session: await this.enrichSession(session) },
      { headers },
    );
  }

  private handleMarkSeen(
    sessionId: string,
    headers: Record<string, string>,
  ): Response {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }
    this.attentionTracker.markSeen(sessionId);
    this.sessionManager.markSeen(sessionId);
    return Response.json({ success: true }, { headers });
  }

  private handleDeleteSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Response {
    const removed = this.sessionManager.removeSession(sessionId);

    if (!removed) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    return Response.json({ success: true }, { headers });
  }

  private async handleActivePaneNotification(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
    }

    const paneId = body.paneId;
    if (!paneId || typeof paneId !== "string") {
      return Response.json(
        { error: "Missing paneId" },
        { status: 400, headers },
      );
    }

    // Skip broadcasting if the focused pane belongs to ccmux (sidebar, picker, etc.)
    const paneInfo = this.getPaneCache().get(paneId);
    if (isCcmuxPane(paneInfo?.paneTitle ?? null)) {
      return Response.json({ success: true, sessionId: null }, { headers });
    }

    // Dedup identical consecutive focus events (caller discards the response)
    if (paneId === this.lastActivePaneId) {
      return Response.json({ success: true }, { headers });
    }
    this.lastActivePaneId = paneId;

    const session = this.resolveSession(paneId);
    const sessionId = session?.id ?? null;

    // Mark session as seen when user switches to its pane
    if (session?.attentionState) {
      this.attentionTracker.markSeen(session.id, false);
      this.sessionManager.setAttentionState(session.id, "read");
      this.attentionTracker.save();
    }

    this.broadcastEvent({
      type: "active_pane",
      timestamp: new Date().toISOString(),
      sessionId,
      paneId,
    });

    return Response.json({ success: true, sessionId }, { headers });
  }

  /**
   * Handle sidebar state update - relay selection to all sidebars
   */
  private async handleSidebarStateUpdate(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
    }

    const selectedSessionId =
      typeof body.selectedSessionId === "string"
        ? body.selectedSessionId
        : null;
    const selectedHeaderKey =
      typeof body.selectedHeaderKey === "string"
        ? body.selectedHeaderKey
        : null;
    const version = typeof body.version === "number" ? body.version : undefined;

    this.lastSidebarState = {
      selectedSessionId,
      selectedHeaderKey,
    };

    this.broadcastEvent({
      type: "sidebar_state",
      timestamp: new Date().toISOString(),
      selectedSessionId,
      selectedHeaderKey,
      version,
    });

    return Response.json({ success: true }, { headers });
  }

  /**
   * Kill a session's agent process
   */
  private handleKillSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Response {
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    // Background rows are read-only: removal goes through `claude rm`, never
    // a SIGTERM to the supervisor-owned worker pid.
    if (isBackgroundSession(session)) {
      return Response.json(
        { error: "Background sessions are read-only; remove via `claude rm`" },
        { status: 400, headers },
      );
    }

    if (!session.pid) {
      return Response.json(
        { error: "Session has no associated process" },
        { status: 400, headers },
      );
    }

    try {
      process.kill(session.pid, "SIGTERM");
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "ESRCH") {
        // Process already dead — not an error
      } else {
        return Response.json(
          { error: `Failed to kill process: ${errorMessage(err)}` },
          { status: 500, headers },
        );
      }
    }

    return Response.json({ success: true }, { headers });
  }

  /**
   * Restart a session: kill process (if alive), then resume in the same tmux pane
   */
  private async handleRestartSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    if (!session.tmuxPane) {
      return Response.json(
        { error: "Session has no associated tmux pane" },
        { status: 400, headers },
      );
    }

    // Kill the process if it's still alive
    if (session.pid) {
      try {
        process.kill(session.pid, "SIGTERM");
      } catch (err: unknown) {
        if (!isErrnoException(err) || err.code !== "ESRCH") {
          return Response.json(
            { error: `Failed to kill process: ${errorMessage(err)}` },
            { status: 500, headers },
          );
        }
      }

      // Poll until process exits (up to 5s)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          process.kill(session.pid, 0);
        } catch {
          break; // Process is gone
        }
        await Bun.sleep(100);
      }
    }

    // Resume in the same pane via the stable `%N` id, not the cached
    // `session:window.pane` coordinate (which goes stale when a lower-indexed
    // window closes mid-scan). `%N` is immutable for the pane's life.
    //
    // Re-read `session.tmuxPane`: the earlier guard held before the kill-wait,
    // but the binder nulls it if the pane closed during the wait. Bail instead
    // of running `send-keys -t null`.
    const target = session.tmuxPane;
    if (!target) {
      return Response.json(
        { error: "Session's tmux pane closed during restart" },
        { status: 409, headers },
      );
    }
    const agent = this.getAgentByType(session.agentType);

    let restartCommand: string;
    if (agent?.resumeCommand) {
      if (session.agentType === "codex" && !session.nativeSessionId) {
        return Response.json(
          { error: "Session has no native Codex session ID for resume" },
          { status: 400, headers },
        );
      }
      const resumeId = getMarkerKey(session);
      restartCommand = agent.resumeCommand.replace("{id}", resumeId);
    } else {
      const { command = "claude" } = await getPreferences();
      restartCommand = session.nativeSessionId
        ? `${command} --resume ${session.nativeSessionId}`
        : command;
    }

    try {
      const proc = Bun.spawn(
        ["tmux", "send-keys", "-t", target, restartCommand, "Enter"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return Response.json(
          { error: `tmux send-keys failed: ${stderr.trim()}` },
          { status: 500, headers },
        );
      }
    } catch (err: unknown) {
      return Response.json(
        { error: `Failed to restart session: ${errorMessage(err)}` },
        { status: 500, headers },
      );
    }

    return Response.json({ success: true }, { headers });
  }

  /**
   * Kill all sessions with active processes, and reap every in-flight
   * invoke worker.
   *
   * Invoke teardown is owned here, not by the client: a subprocess invoke
   * has no session for the SIGTERM loop to reach, and a Claude invoke runs
   * `claude` in a detached `ccmux-invoke-<id>` session that SIGTERM alone
   * does not unwind (the invoker keeps polling for the turn end until its
   * per-invocation timeout). The daemon's `listInvocations()` is the
   * authoritative set of what is in flight; cancelling each one aborts the
   * invoker so it tears down its own resources and emits
   * `invocation_finished`. The client's in-flight set is a lossy mirror
   * (it never hydrates invokes it did not see start), so relying on it
   * would strand any invoke a mid-run-opened TUI never observed.
   */
  private handleKillAllSessions(headers: Record<string, string>): Response {
    // `cancel()` only fires the async abort; the synchronous SIGTERM loop below
    // may still reach a Claude invoke's live pid first, but the `cancelled`
    // outcome holds (the turn-end poll exits on the abort, not the SIGTERM).
    let cancelledInvocations = 0;
    for (const record of this.invocationManager.listInvocations()) {
      if (record.status !== "running") continue;
      this.invocationManager.cancel(record.invocationId);
      cancelledInvocations++;
    }

    // Exclude background rows: their worker pid is owned by Claude's
    // supervisor, not ccmux (read-only; remove via `claude rm`).
    const sessions = this.sessionManager
      .getSessions()
      .filter((s) => s.pid !== null && !isBackgroundSession(s));

    let killed = 0;
    let failed = 0;

    for (const session of sessions) {
      try {
        process.kill(session.pid!, "SIGTERM");
        killed++;
      } catch (err: unknown) {
        if (isErrnoException(err) && err.code === "ESRCH") {
          killed++; // Already dead counts as success
        } else {
          failed++;
        }
      }
    }

    return Response.json(
      { success: true, killed, failed, cancelledInvocations },
      { headers },
    );
  }

  /**
   * Send text to a session's tmux pane
   */
  private async handleSendToSession(
    sessionId: string,
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.resolveSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    if (!session.tmuxPane) {
      return Response.json(
        { error: "Session has no associated tmux pane" },
        { status: 400, headers },
      );
    }

    let body: { text?: string; enter?: boolean };
    try {
      body = (await req.json()) as { text?: string; enter?: boolean };
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400, headers },
      );
    }

    const { text, enter = true } = body;
    if (!text || typeof text !== "string") {
      return Response.json(
        { error: "Missing or invalid 'text' field" },
        { status: 400, headers },
      );
    }

    if (text.length > 10_000) {
      return Response.json(
        { error: "Text exceeds maximum length of 10,000 characters" },
        { status: 400, headers },
      );
    }

    // Target the stable `%N` pane id (guaranteed non-null by the guard above),
    // NOT the cached `session:window.pane` coordinate, which goes stale on a
    // window renumber within the scan interval and would inject text into the
    // wrong pane. `%N` is immutable for the pane's life.
    const target = session.tmuxPane;

    const sent = text.includes("\n")
      ? await this.paneSendDeps.sendPromptToPane(target, text, enter)
      : await this.paneSendDeps.sendLiteralToPane(target, text, enter);
    if (!sent) {
      return Response.json(
        { error: "Failed to send to session" },
        { status: 500, headers },
      );
    }

    return Response.json({ success: true }, { headers });
  }

  /**
   * Capture pane content for a session
   */
  private async handleScreenSession(
    sessionId: string,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.resolveSession(sessionId);

    if (!session) {
      return Response.json(
        { error: "Session not found" },
        { status: 404, headers },
      );
    }

    if (!session.tmuxPane) {
      return Response.json(
        { error: "Session has no associated tmux pane" },
        { status: 400, headers },
      );
    }

    const lines = parseInt(url.searchParams.get("lines") ?? "50", 10);
    const lineCount = isNaN(lines) || lines < 1 ? 50 : lines;

    const content = await capturePane(session.tmuxPane, lineCount);

    return Response.json(
      {
        content,
        sessionId: session.id,
        paneId: session.tmuxPane,
        lines: lineCount,
      },
      { headers },
    );
  }

  /**
   * Handle SSE connection
   */
  private handleSSE(): Response {
    const clientId = crypto.randomUUID();

    const stream = new ReadableStream<string>({
      start: async (controller) => {
        // Store the client
        this.sseClients.set(clientId, { id: clientId, controller });

        // Send init event with pane-matched + background (paneless) sessions
        const matched = this.sessionManager
          .getSessions()
          .filter((s) => this.isVisibleSession(s));
        for (const s of matched) this.visibleSessions.add(s.id);
        const initEvent: SSEEvent = {
          type: "init",
          timestamp: new Date().toISOString(),
          sessions: await this.enrichSessions(matched),
          activePaneId: this.lastActivePaneId,
          // Snapshot of active + recently-finished invocations so a client
          // (re)connecting after a missed `invocation_finished` can reconcile
          // its synthetic rows and in-flight count against daemon truth.
          invocations: this.invocationManager
            .listInvocations()
            .map((r) => ({ invocationId: r.invocationId, status: r.status })),
        };
        this.sendToClient(controller, initEvent);
      },
      cancel: () => {
        this.sseClients.delete(clientId);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  /**
   * Convert session event to SSE event, filtering paneless sessions.
   * Tracks visibility state so the TUI only sees pane-matched sessions.
   */
  private async sessionEventToSSE(
    event: SessionEvent,
  ): Promise<SSEEvent | null> {
    const timestamp = new Date().toISOString();

    switch (event.type) {
      case "created": {
        const session = event.session!;
        // Background rows (paneless by nature) and transcript-backed native
        // rows (visible even before — or without — a pane) emit their
        // session_created at creation. Pane-tracked sessions start
        // tmuxPane=null and are suppressed until a pane is assigned
        // (promoted in the "updated" branch).
        if (this.isVisibleSession(session)) {
          this.visibleSessions.add(session.id);
          return {
            type: "session_created",
            timestamp,
            session: await this.backfillInvocationLink(session),
          };
        }
        return null;
      }

      case "updated": {
        const session = event.session!;
        const isVisibleNow = this.isVisibleSession(session);
        const wasVisible = this.visibleSessions.has(session.id);

        if (isVisibleNow && !wasVisible) {
          // Pane just assigned — promote to visible as "created"
          this.visibleSessions.add(session.id);
          return {
            type: "session_created",
            timestamp,
            session: await this.backfillInvocationLink(session),
          };
        }
        if (isVisibleNow && wasVisible) {
          return {
            type: "session_updated",
            timestamp,
            session: await this.backfillInvocationLink(session),
          };
        }
        if (!isVisibleNow && wasVisible) {
          // Pane lost — demote from visible
          this.visibleSessions.delete(session.id);
          return {
            type: "session_removed",
            timestamp,
            sessionId: session.id,
          };
        }
        // No pane, never visible — suppress
        return null;
      }

      case "removed": {
        const sessionId = event.sessionId!;
        if (this.visibleSessions.has(sessionId)) {
          this.visibleSessions.delete(sessionId);
          return {
            type: "session_removed",
            timestamp,
            sessionId,
          };
        }
        return null;
      }
    }
  }

  /**
   * Enrich a session and, when it belongs to a Claude invoke, back-fill the
   * invocation record with where it landed so `ccmux invoke list` shows the
   * session/pane and the board can cancel it via POST /invoke/:id/cancel.
   * Runs on every visible create/update (idempotent field write) because a
   * native invoke session is now visible BEFORE its pane binds, so the
   * pane can arrive on any later update, not only at promotion.
   */
  private async backfillInvocationLink(
    session: Readonly<Session>,
  ): Promise<EnrichedSession> {
    const enriched = await this.enrichSession(session);
    if (enriched.originInvocationId) {
      this.invocationManager.linkSession(
        enriched.originInvocationId,
        session.id,
        session.tmuxPane,
      );
    }
    return enriched;
  }

  private sendToClient(
    controller: ReadableStreamDefaultController<string>,
    event: SSEEvent,
  ): void {
    try {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      controller.enqueue(data);
    } catch {
      // Client disconnected - clean up dead client
      for (const [id, client] of this.sseClients.entries()) {
        if (client.controller === controller) {
          this.sseClients.delete(id);
          break;
        }
      }
    }
  }

  /**
   * Spawn a new agent session in a tmux pane
   */
  private async handleSpawn(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    let body: {
      agent?: string;
      cwd?: string;
      resume?: string;
      prompt?: string;
      split?: boolean;
      detach?: boolean;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400, headers },
      );
    }

    const {
      agent: agentName = "claude",
      cwd,
      resume,
      prompt,
      split = false,
      detach = false,
    } = body;

    if (!cwd || typeof cwd !== "string") {
      return Response.json(
        { error: "Missing or invalid 'cwd' field" },
        { status: 400, headers },
      );
    }

    // `resume` is interpolated into a shell command typed into the pane, so an
    // unconstrained value is command injection. Constrain it like `/invoke`.
    if (resume !== undefined) {
      if (
        typeof resume !== "string" ||
        !NATIVE_SESSION_ID_PATTERN.test(resume)
      ) {
        return Response.json(
          { error: "Invalid 'resume' field" },
          { status: 400, headers },
        );
      }
    }

    // Validate cwd exists and is a directory
    try {
      const stat = statSync(cwd);
      if (!stat.isDirectory()) {
        return Response.json(
          { error: `Not a directory: ${cwd}` },
          { status: 400, headers },
        );
      }
    } catch {
      return Response.json(
        { error: `Directory does not exist: ${cwd}` },
        { status: 400, headers },
      );
    }

    // Resolve agent definition (custom agents from config are also valid)
    const agent = this.getAgentByType(agentName);
    if (!agent) {
      return Response.json(
        { error: `Unknown agent: ${agentName}` },
        { status: 400, headers },
      );
    }

    // Build agent command
    const preferences = await getPreferences();
    const cmd =
      agentName === "claude"
        ? (preferences.command ?? "claude")
        : (agent.executable ?? agentName);
    let command: string;

    if (resume) {
      if (agent.resumeCommand) {
        command = agent.resumeCommand.replace("{id}", resume);
      } else {
        command = `${cmd} --resume ${resume}`;
      }
    } else if (prompt) {
      const escaped = prompt.replace(/'/g, "'\\''");
      command = `${cmd} --prompt '${escaped}'`;
    } else {
      command = cmd;
    }

    // Create tmux pane
    const tmuxCmd = split ? "split-window" : "new-window";
    try {
      const proc = Bun.spawn(
        ["tmux", tmuxCmd, "-c", cwd, "-P", "-F", "#{pane_id}"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return Response.json(
          { error: `tmux ${tmuxCmd} failed: ${stderr.trim()}` },
          { status: 500, headers },
        );
      }

      const paneId = (await new Response(proc.stdout).text()).trim();

      // Send the agent command into the new pane
      const sendProc = Bun.spawn(
        ["tmux", "send-keys", "-t", paneId, command, "Enter"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const sendExit = await sendProc.exited;
      if (sendExit !== 0) {
        const stderr = await new Response(sendProc.stderr).text();
        return Response.json(
          { error: `Failed to send command to pane: ${stderr.trim()}` },
          { status: 500, headers },
        );
      }

      // Switch to the new pane unless detached
      if (!detach) {
        const selectProc = Bun.spawn(["tmux", "select-window", "-t", paneId], {
          stdout: "pipe",
          stderr: "pipe",
        });
        await selectProc.exited;
      }

      return Response.json({ success: true, paneId, command }, { headers });
    } catch (err: unknown) {
      return Response.json(
        { error: `Failed to spawn session: ${errorMessage(err)}` },
        { status: 500, headers },
      );
    }
  }

  private async handleInvoke(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response> {
    // The `invocationId` is echoed back on every failure response so the
    // CLI can correlate against the id it generated locally. Captured by
    // the inner helper once we've validated it; before that, it's
    // intentionally omitted from the response body.
    let invocationId: string | undefined;
    const badRequest = (message: string): Response =>
      Response.json(
        {
          success: false,
          ...(invocationId !== undefined ? { invocationId } : {}),
          kind: "unknown",
          message,
        },
        { status: 400, headers },
      );

    let body: {
      invocationId?: string;
      agent?: string;
      prompt?: string;
      cwd?: string;
      sessionId?: string;
      timeoutMs?: number;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return badRequest("Invalid JSON body");
    }

    const {
      invocationId: rawInvocationId,
      agent: agentName,
      prompt,
      cwd,
      sessionId,
      timeoutMs,
    } = body;

    if (
      !rawInvocationId ||
      typeof rawInvocationId !== "string" ||
      !INVOCATION_ID_PATTERN.test(rawInvocationId)
    ) {
      return badRequest("Missing or invalid 'invocationId'");
    }
    invocationId = rawInvocationId;

    if (!agentName || typeof agentName !== "string") {
      return badRequest("Missing or invalid 'agent'");
    }
    if (!prompt || typeof prompt !== "string") {
      return badRequest("Missing or invalid 'prompt'");
    }
    if (Buffer.byteLength(prompt, "utf8") > MAX_INVOKE_PROMPT_BYTES) {
      return badRequest(
        `Prompt exceeds maximum size of ${MAX_INVOKE_PROMPT_BYTES} bytes`,
      );
    }
    if (!cwd || typeof cwd !== "string") {
      return badRequest("Missing or invalid 'cwd'");
    }
    try {
      const stat = statSync(cwd);
      if (!stat.isDirectory()) return badRequest(`Not a directory: ${cwd}`);
    } catch {
      return badRequest(`Directory does not exist: ${cwd}`);
    }

    if (sessionId !== undefined) {
      if (
        typeof sessionId !== "string" ||
        !NATIVE_SESSION_ID_PATTERN.test(sessionId)
      ) {
        return badRequest("Invalid 'sessionId'");
      }
    }

    if (timeoutMs !== undefined) {
      if (
        typeof timeoutMs !== "number" ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > MAX_INVOKE_TIMEOUT_MS
      ) {
        return badRequest(
          `Invalid 'timeoutMs' (must be 1..${MAX_INVOKE_TIMEOUT_MS})`,
        );
      }
    }

    const agent = this.getAgentByType(agentName);
    if (!agent) return badRequest(`Unknown agent: ${agentName}`);

    // Resolve the invoker so `capabilitiesFor` can derive invoke-time
    // gates from `AgentDef`. Undefined here means a custom ccmux.json
    // agent that isn't `claude` and lacks `invokeMode`; reject up front
    // with the same `agent_error` shape `InvocationManager.invoke` would
    // have produced as defense-in-depth, so existing CLI matchers keying
    // on the word `invokeMode` keep working. `noInvokeModeMessage` is the
    // shared template.
    const invoker = this.invocationManager.getInvokerFor(agent);
    if (!invoker) {
      // 200 (not 400): same rationale as `hooks_missing` below. The CLI
      // routes on `data.kind`, not status.
      return Response.json(
        {
          success: false,
          invocationId,
          kind: "agent_error",
          message: noInvokeModeMessage(agent),
        },
        { status: 200, headers },
      );
    }

    // Hooks precheck applies only to invokers that need them for session
    // correlation (today: the Claude tmux path). Subprocess invocations
    // shell out to a non-interactive subcommand and don't need hooks for
    // invoke itself. Skipped when no adapter is registered (custom
    // ccmux.json agents have no built-in hook integration).
    if (capabilitiesFor(agent, invoker).requiresHooks) {
      const adapter = this.getHookAdapter(agent.name);
      if (adapter && !adapter.isInstalled()) {
        // 200 (not 400): the request is well-formed; the agent's hooks
        // not being installed is a logical runtime gate, mirroring how
        // rate_limit / timeout / agent_error are returned. The CLI keys
        // off `data.kind` either way and maps to exit code 3.
        return Response.json(
          {
            success: false,
            invocationId,
            kind: "hooks_missing",
            message: `Run \`ccmux setup --agent ${agent.name}\``,
          },
          { status: 200, headers },
        );
      }
    }

    // Claude's binary is user-overridable so wrappers/forks still work.
    // The subprocess path reads its binary from `invokeMode.args[0]`.
    const preferences = await getPreferences();
    const claudeBinary =
      agent.name === "claude" ? (preferences.command ?? "claude") : undefined;

    const input: InvokeInput = {
      invocationId,
      agent,
      claudeBinary,
      prompt,
      cwd,
      sessionId,
      timeoutMs: timeoutMs ?? 300_000,
    };
    let result: InvokeResult;
    try {
      result = await this.invocationManager.invoke(input);
    } catch (err) {
      result = {
        success: false,
        invocationId,
        kind: "unknown",
        message: errorMessage(err),
      };
    }
    // Logical agent failures (rate_limit, timeout, hooks_missing, cancelled,
    // agent_error, unknown) ride on 200 so the CLI's `data.kind` is the
    // single source of truth for outcome. Protocol-level rejections
    // (missing/invalid fields) still return 400 above.
    return Response.json(result, { status: 200, headers });
  }

  private async handleInvokeCancel(
    invocationId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      return Response.json(
        { success: false, message: "Invalid 'invocationId'" },
        { status: 400, headers },
      );
    }
    // Classify BEFORE cancelling so the CLI can ack truthfully instead of
    // always printing "Cancelled": a `running` record is genuinely being
    // cancelled; a terminal record already finished; no record means the
    // id is unknown (a typo, or a cancel racing ahead of invoke(), which
    // the manager stashes for the pending start). `cancel()` itself stays
    // best-effort and returns true either way.
    const record = this.invocationManager.getInvocation(invocationId);
    const state: "cancelling" | "already_finished" | "not_found" =
      record === undefined
        ? "not_found"
        : record.status === "running"
          ? "cancelling"
          : "already_finished";
    const ok = this.invocationManager.cancel(invocationId);
    return Response.json({ success: ok, state }, { status: 200, headers });
  }

  /**
   * Return an invocation's full captured output from the ephemeral
   * `/tmp` result store. Reap-tolerant: a gone file (reaped, never
   * written, or written by a since-restarted daemon) is a clean
   * `{ available: false }` on 200, never an error, so `ccmux invoke
   * result <id>` can print a clean "result no longer available" miss.
   * Only the subprocess invoke path writes results; Claude invokes drive
   * a tmux session with no stdout buffer, so their result is always a
   * miss in v1.
   */
  private async handleInvocationResult(
    invocationId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      return Response.json(
        { available: false, message: "Invalid 'invocationId'" },
        { status: 400, headers },
      );
    }
    const output = await readInvocationResult(invocationId);
    if (output === null) {
      return Response.json({ available: false }, { status: 200, headers });
    }
    return Response.json({ available: true, output }, { status: 200, headers });
  }

  private broadcastEvent(event: SSEEvent): void {
    for (const client of this.sseClients.values()) {
      this.sendToClient(client.controller, event);
    }
  }
}
