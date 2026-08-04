import {
  describe,
  it,
  expect,
  spyOn,
  afterAll,
  afterEach,
  beforeEach,
  mock,
} from "bun:test";
import { join as joinPath } from "path";
import { tmpdir as osTmpdir } from "os";

/**
 * Redirect CCMUX_HOME before anything imports `lib/config`, whose
 * STATE_FILE is frozen at module load.
 *
 * `handleActivePaneNotification` reaches `AttentionTracker.save()`, which
 * writes state.json. Running this file ALONE therefore rewrote the
 * developer's real ~/.config/ccmux/state.json; a full `bun test` only
 * escaped it because another test file happens to set CCMUX_HOME
 * process-wide first, which is accidental and order-dependent. AGENTS.md
 * documents single-file runs as normal, so this file protects itself.
 *
 * The env var alone is not enough — `import` statements are hoisted, so
 * `lib/config` has already frozen STATE_FILE by the time this line runs.
 * The module mock is what actually redirects it, matching
 * `index.no-hooks.test.ts`; the env var covers the paths that re-read
 * CCMUX_HOME at call time.
 */
const serverTestHome = joinPath(
  osTmpdir(),
  `ccmux-server-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = serverTestHome;

const actualCcmuxConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualCcmuxConfig,
  STATE_FILE: joinPath(serverTestHome, "state.json"),
}));
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
import type { SpawnableAgent } from "../lib/spawnable-agents";
import type { Session, TmuxPane, EnrichedSession } from "../types/session";
import { AttentionTracker } from "./attention-tracker";
import { InvocationManager } from "./invocation-manager";
import { InvocationRegistry } from "./invokers/registry";
import { stubInvoker } from "./invokers/test-helpers";
import type { HookAdapter } from "./hook-adapter";
import { PRResolver } from "./pr-resolver";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "fs";
import { createWorktree } from "./worktree-create";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { resolvedHomeDir } from "../lib/config";
import type { sendLiteralToPane, sendPromptToPane } from "./pane-io";
import { MAX_SPAWN_PROMPT_BYTES } from "./spawn-command";

/**
 * Access private methods/fields on DaemonServer for unit testing.
 * Avoids starting the HTTP server (no port binding needed).
 */
type ServerInternals = {
  sessionEventToSSE(event: SessionEvent): Promise<SSEEvent | null>;
  enrichSession(session: Session): Promise<EnrichedSession>;
  sweepBranchPRs(): void;
  prResolver: PRResolver;
  sweepOffset: number;
  /** Exposed so a test can expire git facts the way the TTL does. */
  gitInfoCache: Map<string, unknown>;
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
  ): Promise<Response>;
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
  notePaneScanFailure(message: string): void;
  broadcastEvent(event: SSEEvent): void;
  sseClients: Map<
    string,
    { id: string; controller: { enqueue(data: string): void } }
  >;
  /** Stubbable for S4's $HOME-boundary tests; see project-derivation.ts's
   *  identical `DeriveProjectOptions.homeDir` for why a plain field. */
  homeDir: string;
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

/**
 * Environment for the real-git fixtures below, hermetic in both directions.
 *
 * Identity is supplied explicitly because a CI runner has none in any config
 * scope and refuses git's implicit fallback ("no email was given and
 * auto-detection is disabled"), while a developer machine infers one and
 * commits happily. A fixture that inherits the ambient identity therefore
 * passes locally and fails on CI, and it fails *late*: the empty commit
 * leaves HEAD unborn, `worktree add` builds an unborn worktree, and
 * `readGitInfo`'s exit-code guard correctly reports no git facts — so the
 * breakage surfaces as a null `mainRepoRoot` several steps from its cause.
 *
 * Both config scopes are neutered in the other direction, so a developer's
 * own settings (`commit.gpgsign`, hooks, templates) can't reach in either.
 */
const GIT_FIXTURE_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "ccmux test",
  GIT_AUTHOR_EMAIL: "test@ccmux.invalid",
  GIT_COMMITTER_NAME: "ccmux test",
  GIT_COMMITTER_EMAIL: "test@ccmux.invalid",
};

/**
 * Run one git setup command for a real-git fixture, throwing on a non-zero
 * exit. Every fixture command goes through this so a broken setup fails at
 * the step that broke, naming git's own error, instead of surviving to a
 * later assertion that reports a misleading value.
 */
function runFixtureGit(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: GIT_FIXTURE_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `fixture setup failed: git ${args.join(" ")} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`,
    );
  }
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

/**
 * Stub `Bun.spawn` for the enrichment path's `git rev-parse`, recording every
 * git argv so spawn merging / coalescing is observable. Non-git spawns (the PR
 * resolver's background `gh`) are answered but not recorded. `delayMs` keeps
 * the call in flight long enough for concurrent callers to pile up; `throws`
 * simulates a missing git binary.
 */
function stubGitSpawn(options: {
  stdout?: string;
  exitCode?: number;
  delayMs?: number;
  throws?: boolean;
}) {
  const original = Bun.spawn;
  const argv: string[][] = [];
  Bun.spawn = ((spawned: string[]) => {
    const isGit = spawned[0] === "git";
    if (isGit) {
      argv.push(spawned);
      if (options.throws) throw new Error("spawn git ENOENT");
    }
    const code = isGit ? (options.exitCode ?? 0) : 0;
    const out = isGit ? (options.stdout ?? "") : "";
    return {
      exited: options.delayMs
        ? Bun.sleep(options.delayMs).then(() => code)
        : Promise.resolve(code),
      stdout: new Blob([out]).stream(),
      stderr: new Blob([""]).stream(),
    };
  }) as unknown as typeof Bun.spawn;
  return { argv, restore: () => (Bun.spawn = original) };
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
    it("touches visible sessions' PR keys only", () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "vis",
        "/Users/test/.claude/projects/-Users-test-proj/vis.jsonl",
      );
      // Paneless pane-tracked session: the one shape the sweep skips.
      manager.createPaneTrackedSession({
        agentType: "codex",
        paneId: "%9",
        cwd: "/Users/test/other",
        pid: 42,
      });
      manager.setTmuxPane("codex_pane9", null);
      internals.visibleSessions.add("vis");
      // No cached branch for this cwd, so the key falls back to the
      // log-derived one.
      manager.updateSession("vis", { gitBranch: "feat/from-log" });

      const seen: Array<[string | null, string | null]> = [];
      const spy = spyOn(internals.prResolver, "get").mockImplementation(
        (cwd: string | null, branch: string | null) => {
          seen.push([cwd, branch]);
          return null;
        },
      );

      internals.sweepBranchPRs();

      expect(seen).toEqual([["/Users/test/proj", "feat/from-log"]]);
      spy.mockRestore();
    });

    it("never spawns git, even against a cold cache", () => {
      const { manager, internals } = createServer();
      // Installed before the session exists: creating one emits a `change`
      // event the server enriches on its own, which would otherwise prime the
      // cache off-camera.
      const git = stubGitSpawn({
        stdout: "feat/x\n/repo\n/repo/.git\n/repo/.git\n",
      });

      try {
        manager.createSession(
          "vis",
          "/Users/test/.claude/projects/-Users-test-proj/vis.jsonl",
        );
        internals.visibleSessions.add("vis");
        git.argv.length = 0;

        internals.sweepBranchPRs();

        // The sweep needs a PR key, not a fresh git read, so it reads the
        // cache (here: empty) and falls back to the log-derived branch.
        expect(git.argv).toEqual([]);
      } finally {
        git.restore();
      }
    });

    it("keys the PR lookup off the cached branch when one is warm", async () => {
      const { manager, internals } = createServer();
      const git = stubGitSpawn({
        stdout: "feat/live\n/repo\n/repo/.git\n/repo/.git\n",
      });

      try {
        manager.createSession(
          "vis",
          "/Users/test/.claude/projects/-Users-test-proj/vis.jsonl",
        );
        internals.visibleSessions.add("vis");
        // Prime the cache the way the SSE init does.
        await internals.enrichSession(manager.getSession("vis")!);

        const seen: Array<string | null> = [];
        const spy = spyOn(internals.prResolver, "get").mockImplementation(
          (_cwd: string | null, branch: string | null) => {
            seen.push(branch);
            return null;
          },
        );

        internals.sweepBranchPRs();

        expect(seen).toEqual(["feat/live"]);
        spy.mockRestore();
      } finally {
        git.restore();
      }
    });

    it("gives every key a refresh attempt within `len` sweeps under the resolver's concurrency cap", async () => {
      const { manager, internals } = createServer();
      const KEY_COUNT = 10; // > the resolver's MAX_CONCURRENT_REFRESHES (4)

      for (let i = 0; i < KEY_COUNT; i++) {
        manager.createSession(
          `s${i}`,
          `/Users/test/.claude/projects/-Users-test-proj${i}/s${i}.jsonl`,
        );
        manager.updateSession(`s${i}`, { gitBranch: `feat/${i}` });
        internals.visibleSessions.add(`s${i}`);
      }

      const attempted = new Set<string>();
      // Real PRResolver (not a hand-rolled stand-in) so its actual
      // MAX_CONCURRENT_REFRESHES=4 cap is what's under test. Each lookup
      // resolves on its own microtask, mirroring the real world where gh
      // calls settle well inside the sweep interval and free their slot
      // before the next sweep runs.
      internals.prResolver = new PRResolver({
        lookup: async (cwd, branch) => {
          attempted.add(`${cwd}\0${branch}`);
          return null;
        },
      });

      // Rotation scheme: sweepOffset advances by exactly one session per
      // sweep, so every session becomes the iteration's starting position
      // (and therefore first in line for the cap's slots) exactly once
      // every `len` sweeps. That guarantees every key gets at least one
      // refresh attempt within `len` sweeps in the worst case, so KEY_COUNT
      // sweeps is a sound (if pessimistic) bound to assert against.
      for (let sweep = 0; sweep < KEY_COUNT; sweep++) {
        internals.sweepBranchPRs();
        // Let each sweep's refresh promises settle (and free their inflight
        // slots) before the next sweep starts, same as the real interval
        // spacing gh calls out from sweeps.
        await Bun.sleep(0);
      }

      const expectedKeys = new Set(
        Array.from(
          { length: KEY_COUNT },
          (_, i) => `/Users/test/proj${i}\0feat/${i}`,
        ),
      );
      expect(attempted).toEqual(expectedKeys);
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

    it("resolves branch, worktree and main repo root from a single git spawn", async () => {
      const { internals } = createServer();
      const git = stubGitSpawn({
        stdout: "feat/x\n/trees/wt\n/repo/.git/worktrees/wt\n/repo/.git\n",
      });

      try {
        const enriched = await internals.enrichSession(fakeSession("s1"));

        expect(enriched.gitBranch).toBe("feat/x");
        expect(enriched.isWorktree).toBe(true);
        expect(enriched.mainRepoRoot).toBe("/repo");
        expect(enriched.worktreeRoot).toBe("/trees/wt");
        expect(git.argv).toEqual([
          [
            "git",
            "-C",
            "/Users/test/proj",
            "rev-parse",
            "--path-format=absolute",
            "--abbrev-ref",
            "HEAD",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
          ],
        ]);
      } finally {
        git.restore();
      }
    });

    it("does not call a repo under a `worktrees/` directory a worktree", async () => {
      // The old detection was a `/worktrees/` substring test on --git-dir,
      // which any repo living under a directory of that name tripped.
      const { internals } = createServer();
      const git = stubGitSpawn({
        stdout:
          "main\n/src/worktrees/app\n/src/worktrees/app/.git\n/src/worktrees/app/.git\n",
      });

      try {
        const enriched = await internals.enrichSession(fakeSession("s1"));

        expect(enriched.isWorktree).toBe(false);
        expect(enriched.mainRepoRoot).toBe("/src/worktrees/app");
      } finally {
        git.restore();
      }
    });

    it("resolves relative git dirs against the cwd before comparing them", async () => {
      // Real fixture from a plain checkout's subdirectory: git prints an
      // absolute --git-dir but a cwd-relative --git-common-dir, so comparing
      // the raw strings would report this as a worktree.
      const { internals } = createServer();
      const git = stubGitSpawn({
        stdout: "main\n/Users/test/proj\n/Users/test/proj/.git\n../.git\n",
      });
      const session = fakeSession("s1");
      session.cwd = "/Users/test/proj/src";

      try {
        const enriched = await internals.enrichSession(session);

        expect(enriched.isWorktree).toBe(false);
        expect(enriched.mainRepoRoot).toBe("/Users/test/proj");
      } finally {
        git.restore();
      }
    });

    it("treats a submodule's `.git` file gitdir as its own checkout, not a worktree", async () => {
      const { internals } = createServer();
      const git = stubGitSpawn({
        stdout:
          "main\n/super/sub\n/super/.git/modules/sub\n/super/.git/modules/sub\n",
      });

      try {
        const enriched = await internals.enrichSession(fakeSession("s1"));

        expect(enriched.isWorktree).toBe(false);
        // The common dir is the module dir, not a checkout's `.git`, but
        // this is not a worktree, so mainRepoRoot falls back to
        // --show-toplevel (S5), which is the submodule's own checkout root.
        expect(enriched.mainRepoRoot).toBe("/super/sub");
      } finally {
        git.restore();
      }
    });

    it("does not let a literal ~/.git collapse every home subdirectory into one project (S4)", async () => {
      const { internals } = createServer();
      internals.homeDir = "/Users/homie";
      const git = stubGitSpawn({
        stdout: "main\n/Users/homie\n/Users/homie/.git\n/Users/homie/.git\n",
      });
      const session = fakeSession("s1");
      session.cwd = "/Users/homie/notes";
      session.project = "notes";

      try {
        const enriched = await internals.enrichSession(session);

        // Git resolved mainRepoRoot to $HOME itself. Trusting that would
        // name every non-repo directory under home after the home
        // directory, so this must fall through to deriveProject's
        // $HOME-bounded walk instead, landing on the cwd's own basename.
        expect(enriched.mainRepoRoot).toBe("/Users/homie");
        expect(enriched.project).toBe("notes");
        expect(enriched.project).not.toBe("homie");
      } finally {
        git.restore();
      }
    });

    it("still guards when $HOME is a symlink, which git's answer never is (S4)", async () => {
      // `mainRepoRoot` comes from `git rev-parse --path-format=absolute`, which
      // resolves symlinks. An unresolved home therefore never compares equal to
      // it, and on a machine with a relocated home the guard silently stopped
      // firing: `resolvedHomeDir` is what keeps the two comparable.
      const fixture = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-s4-")));
      const realHome = join(fixture, "real-home");
      const linkedHome = join(fixture, "linked-home");
      mkdirSync(join(realHome, "notes"), { recursive: true });
      symlinkSync(realHome, linkedHome);
      const gitAnswer = `main\n${realHome}\n${realHome}/.git\n${realHome}/.git\n`;

      const unresolved = createServer();
      unresolved.internals.homeDir = linkedHome;
      const resolved = createServer();
      resolved.internals.homeDir = resolvedHomeDir(linkedHome);
      const git = stubGitSpawn({ stdout: gitAnswer });
      try {
        const inHome = (server: typeof unresolved) => {
          const session = fakeSession("s1");
          session.cwd = join(realHome, "notes");
          session.project = "notes";
          return server.internals.enrichSession(session);
        };

        // The bug: git says $HOME, the guard compares against a link and lets
        // the home directory's own name through.
        expect((await inHome(unresolved)).project).toBe("real-home");
        expect((await inHome(resolved)).project).toBe("notes");
      } finally {
        git.restore();
        rmSync(fixture, { recursive: true, force: true });
      }
    });

    it("initializes the $HOME boundary from the resolved home directory (S4)", async () => {
      // The field the guard reads must come through the resolver, not a raw
      // `homedir()`; on a machine whose home is a link this is the difference
      // between the guard working and doing nothing.
      const { internals } = createServer();
      expect(internals.homeDir).toBe(realpathSync(homedir()));
    });

    it("does not suppress git's project name when mainRepoRoot is merely under home, not $HOME itself (S4)", async () => {
      // A real repo checked out under home (e.g. ~/dotfiles) is not the
      // pattern the guard targets: only mainRepoRoot === $HOME exactly
      // triggers it, so an ordinary repo elsewhere under home keeps
      // grouping by its own name.
      const { internals } = createServer();
      internals.homeDir = "/Users/homie";
      const git = stubGitSpawn({
        stdout:
          "main\n/Users/homie/dotfiles\n/Users/homie/dotfiles/.git\n/Users/homie/dotfiles/.git\n",
      });
      const session = fakeSession("s1");
      session.cwd = "/Users/homie/dotfiles";

      try {
        const enriched = await internals.enrichSession(session);

        expect(enriched.mainRepoRoot).toBe("/Users/homie/dotfiles");
        expect(enriched.project).toBe("dotfiles");
      } finally {
        git.restore();
      }
    });

    it("warns once when git echoes an unrecognized flag back, the real old-git shape (O3)", async () => {
      // Real git on a version without `--path-format` doesn't just fail to
      // answer it - it echoes the flag back as an EXTRA stdout line and
      // still answers the rest of the argv, so the actual shape is 5
      // lines, not 4: the echoed flag, then branch/topLevel/gitDir/
      // commonDir in argument order. A 4-line mock of this case is a shape
      // real git cannot produce, and it hid that the length gate used to
      // return UNKNOWN_GIT_INFO before the warning check ever ran.
      const { internals } = createServer();
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const git = stubGitSpawn({
        stdout:
          "--path-format=absolute\nmain\n/Users/test/proj\n/Users/test/proj/.git\n/Users/test/proj/.git\n",
      });

      try {
        const enriched = await internals.enrichSession(fakeSession("s1"));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("older than 2.31");
        expect(enriched.gitBranch).toBeNull();
        expect(enriched.isWorktree).toBe(false);
        expect(enriched.mainRepoRoot).toBeNull();
        expect(enriched.worktreeRoot).toBeNull();

        // Said once, not per lookup: a second session on a different cwd
        // hits the same unanswerable git, but the warning doesn't repeat.
        const secondSession = fakeSession("s2");
        secondSession.cwd = "/Users/test/other";
        await internals.enrichSession(secondSession);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        git.restore();
        warn.mockRestore();
      }
    });

    it("coalesces concurrent lookups for one cwd onto a single git spawn", async () => {
      const { internals } = createServer();
      // Held in flight so all 20 callers arrive before the first resolves.
      const git = stubGitSpawn({
        stdout: "main\n/repo\n/repo/.git\n/repo/.git\n",
        delayMs: 5,
      });

      try {
        const enriched = await Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            internals.enrichSession(fakeSession(`s${i}`)),
          ),
        );

        expect(git.argv).toHaveLength(1);
        expect(enriched.every((e) => e.gitBranch === "main")).toBe(true);
      } finally {
        git.restore();
      }
    });

    it("does not cache a thrown git spawn; the next call retries", async () => {
      const { internals } = createServer();
      const git = stubGitSpawn({ throws: true });

      try {
        const first = await internals.enrichSession(fakeSession("s1"));
        expect(first.gitBranch).toBeNull();

        await internals.enrichSession(fakeSession("s2"));

        expect(git.argv).toHaveLength(2);
      } finally {
        git.restore();
      }
    });

    it("caches a non-repo answer instead of re-spawning git", async () => {
      const { internals } = createServer();
      // Exit 128 is a real answer about this cwd (not a repo), unlike a throw.
      const git = stubGitSpawn({ exitCode: 128 });

      try {
        await internals.enrichSession(fakeSession("s1"));
        await internals.enrichSession(fakeSession("s2"));

        expect(git.argv).toHaveLength(1);
      } finally {
        git.restore();
      }
    });

    it("reports nothing when git echoes a flag it doesn't understand", async () => {
      // `rev-parse` prints an unsupported option back verbatim AND exits 0,
      // so an older git (or a shim that drops unknown flags) would hand us
      // `--git-common-dir` as a "path" that compares unequal to the git dir
      // - marking every session on the machine a worktree. Weaker than the
      // substring test this replaced, so it is gated explicitly.
      const { internals } = createServer();
      const git = stubGitSpawn({
        stdout: "main\n--show-toplevel\n--git-dir\n--git-common-dir\n",
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const enriched = await internals.enrichSession(fakeSession("s1"));

        expect(enriched.isWorktree).toBe(false);
        expect(enriched.mainRepoRoot).toBeNull();
        expect(enriched.worktreeRoot).toBeNull();
        // Falls back to the log-derived branch rather than "main" from a
        // reply we can't trust.
        expect(enriched.gitBranch).toBeNull();

        // Losing every row's branch and worktree marker silently leaves the
        // user with no way to find out why, so it is said once...
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("2.31");

        // ...and only once, however many cwds hit the same broken git.
        internals.gitInfoCache.clear();
        await internals.enrichSession(fakeSession("s2"));
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
        git.restore();
      }
    });

    it("keeps project and the worktree facts from disagreeing after a topology change", async () => {
      // The two used to come from caches with different lifetimes: git info
      // expires after 30s, `deriveProject`'s walk cache never evicts. A cwd
      // that BECOMES a worktree (git allows `worktree add` into an existing
      // empty directory) then grouped under the stale name forever while its
      // label named the new repo - a contradiction only a daemon restart
      // could clear.
      const paneCache = new Map<string, TmuxPane>([
        ["%9", fakePane({ paneId: "%9", currentPath: "/src/scratch" })],
      ]);
      const server = createServer(undefined, paneCache).internals;

      const before = stubGitSpawn({
        stdout: "main\n/src/scratch\n/src/scratch/.git\n/src/scratch/.git\n",
      });
      let enriched;
      try {
        enriched = await server.enrichSession(fakeSession("s1", "%9"));
      } finally {
        before.restore();
      }
      expect(enriched.project).toBe("scratch");
      expect(enriched.isWorktree).toBe(false);

      // Same cwd, now a worktree of `myrepo`. Expire the git cache the way
      // the TTL does; nothing expires a project cache, which is the point.
      server.gitInfoCache.clear();
      const after = stubGitSpawn({
        stdout:
          "feat\n/src/scratch\n/repos/myrepo/.git/worktrees/feat\n/repos/myrepo/.git\n",
      });
      try {
        enriched = await server.enrichSession(fakeSession("s1", "%9"));
      } finally {
        after.restore();
      }

      expect(enriched.isWorktree).toBe(true);
      expect(enriched.mainRepoRoot).toBe("/repos/myrepo");
      // The row groups where its label says it lives.
      expect(enriched.project).toBe("myrepo");
    });

    it("names the worktree from its root, not from a pane sitting in a subdirectory", async () => {
      const { internals } = createServer();
      const git = stubGitSpawn({
        stdout:
          "feat\n/trees/parking\n/repo/.git/worktrees/parking\n/repo/.git\n",
      });
      const session = fakeSession("s1");
      session.cwd = "/trees/parking/src/tui";

      try {
        const enriched = await internals.enrichSession(session);

        expect(enriched.worktreeRoot).toBe("/trees/parking");
      } finally {
        git.restore();
      }
    });

    it("derives project from the same cwd the git facts come from", async () => {
      // A pane that `cd`s out of the directory the log recorded used to move
      // the branch and worktree marker (pane cwd) while leaving `project`
      // (log cwd) behind, so the row grouped under one repo and showed
      // another's branch.
      const root = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-cwd-")));
      try {
        const repo = join(root, "other-repo");
        mkdirSync(join(repo, ".git"), { recursive: true });
        const paneCache = new Map<string, TmuxPane>([
          ["%9", fakePane({ paneId: "%9", currentPath: repo })],
        ]);
        const { internals } = createServer(undefined, paneCache);
        const session = fakeSession("s1", "%9");

        const enriched = await internals.enrichSession(session);

        expect(session.project).toBe("proj"); // log-derived, left alone
        expect(enriched.project).toBe("other-repo");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("tells a real worktree from its main checkout (real git)", async () => {
      // The stubbed cases above pin the parsing; this one pins the premise —
      // that `--git-dir` and `--git-common-dir` really do diverge for a
      // linked worktree and agree for the checkout it was added from.
      // realpath'd: git records the worktree's gitdir by real path, and on
      // macOS `/tmp` is a symlink, so the raw mkdtemp path would not match.
      const root = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-wt-")));
      const main = join(root, "repo");
      const worktree = join(root, "trees", "feature");
      try {
        mkdirSync(main);
        runFixtureGit(main, "init", "-q", "-b", "main");
        runFixtureGit(main, "commit", "-q", "--allow-empty", "-m", "init");
        runFixtureGit(main, "worktree", "add", "-q", "-b", "feature", worktree);

        const { internals } = createServer();
        const mainSession = fakeSession("s1");
        mainSession.cwd = main;
        const worktreeSession = fakeSession("s2");
        worktreeSession.cwd = worktree;

        const enrichedMain = await internals.enrichSession(mainSession);
        const enrichedWorktree = await internals.enrichSession(worktreeSession);

        expect(enrichedMain.isWorktree).toBe(false);
        expect(enrichedMain.mainRepoRoot).toBe(main);
        expect(enrichedWorktree.isWorktree).toBe(true);
        expect(enrichedWorktree.gitBranch).toBe("feature");
        // Both checkouts point at the same main root, which is what
        // worktree management keys off.
        expect(enrichedWorktree.mainRepoRoot).toBe(main);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("treats an unborn HEAD (fresh git init) as no branch, not a phantom one", async () => {
      // Real fixture: `git init` exits 128 on `rev-parse` but still prints a
      // lone `HEAD` line, which an ungated parse would show as a branch.
      const dir = mkdtempSync(join(tmpdir(), "ccmux-unborn-"));
      try {
        runFixtureGit(dir, "init", "-q");
        const { internals } = createServer();
        const session = fakeSession("s1");
        session.cwd = dir;
        session.gitBranch = null;

        const enriched = await internals.enrichSession(session);

        expect(enriched.gitBranch).toBeNull();
        expect(enriched.isWorktree).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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

      const response = await internals.handleKillSession("nonexistent", {});
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

      const response = await internals.handleKillSession("s1", {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe("Session has no associated process");
    });

    it("should SIGTERM a normal (non-background) session's pid, unchanged from before", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setPid("s1", 999999);

      const killSpy = spyOn(process, "kill").mockImplementation(
        (() => true) as typeof process.kill,
      );

      try {
        const response = await internals.handleKillSession("s1", {});
        const data = (await response.json()) as { success: boolean };

        expect(data.success).toBe(true);
        expect(response.status).toBe(200);
        expect(killSpy).toHaveBeenCalledWith(999999, "SIGTERM");
      } finally {
        killSpy.mockRestore();
      }
    });

    it("should run the agent's backgroundStopCommand and report success without removing the row", async () => {
      const { manager, internals } = createServer();
      // Worker pid is supervisor-owned; ccmux must not SIGTERM it directly.
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

      const originalBunSpawn = Bun.spawn;
      let spawnedArgv: string[] | undefined;
      Bun.spawn = ((argv: string[]) => {
        spawnedArgv = argv;
        return {
          exited: Promise.resolve(0),
          stdout: new Blob([""]).stream(),
          stderr: new Blob([""]).stream(),
        };
      }) as unknown as typeof Bun.spawn;

      try {
        const response = await internals.handleKillSession("sup-k", {});
        const data = (await response.json()) as { success: boolean };

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        expect(spawnedArgv).toEqual(["claude", "stop", "sup-k"]);
        // Removal is event-driven (the roster watcher), never immediate.
        expect(manager.getSession("sup-k")).toBeDefined();
      } finally {
        Bun.spawn = originalBunSpawn;
      }
    });

    it("should return 500 with stderr when backgroundStopCommand exits nonzero", async () => {
      const { manager, internals } = createServer();
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

      const originalBunSpawn = Bun.spawn;
      Bun.spawn = ((_argv: string[]) => ({
        exited: Promise.resolve(1),
        stdout: new Blob([""]).stream(),
        stderr: new Blob(["worker not found\n"]).stream(),
      })) as unknown as typeof Bun.spawn;

      try {
        const response = await internals.handleKillSession("sup-k", {});
        const data = (await response.json()) as { error: string };

        expect(response.status).toBe(500);
        expect(data.error).toContain("worker not found");
      } finally {
        Bun.spawn = originalBunSpawn;
      }
    });

    it("should report success when the stop fails only because the worker was already gone", async () => {
      const { manager, internals } = createServer();
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

      const originalBunSpawn = Bun.spawn;
      // Verbatim `claude stop <gone-short>` output: a second `x` inside the
      // removal window must not report a failure for a stop that landed.
      Bun.spawn = ((_argv: string[]) => ({
        exited: Promise.resolve(1),
        stdout: new Blob([""]).stream(),
        stderr: new Blob([
          "No job matching 'sup-k'. Run 'claude agents' to list running sessions.\n",
        ]).stream(),
      })) as unknown as typeof Bun.spawn;

      try {
        const response = await internals.handleKillSession("sup-k", {});
        const data = (await response.json()) as { success: boolean };

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
      } finally {
        Bun.spawn = originalBunSpawn;
      }
    });

    it("should return 400 when the background session's agent has no backgroundStopCommand", async () => {
      const claudeWithoutStop: AgentDef = {
        ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
        backgroundStopCommand: undefined,
      };
      const { manager, internals } = createServer(
        undefined,
        undefined,
        undefined,
        undefined,
        (agentType: string) =>
          agentType === "claude" ? claudeWithoutStop : undefined,
      );
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

      const response = await internals.handleKillSession("sup-k", {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toContain("read-only");
      expect(data.error).toContain("no stop command");
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

    it("should return 400 for multiline text exceeding the paste cap", async () => {
      const { manager, internals } = createServer();
      manager.createSession(
        "s1",
        "/Users/test/.claude/projects/-Users-test-proj/s1.jsonl",
      );
      manager.setTmuxPane("s1", "%1");

      const req = new Request("http://localhost/sessions/s1/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x\n".repeat(32_769) }), // > 65,536 chars
      });

      const response = await internals.handleSendToSession("s1", req, {});
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(400);
      expect(data.error).toBe(
        "Text exceeds maximum length of 65,536 characters",
      );
    });

    it("routes an 11k single-line payload through the paste path instead of rejecting", async () => {
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

      const longSingleLine = "x".repeat(11_000);
      const response = await internals.handleSendToSession(
        "s1",
        new Request("http://localhost/sessions/s1/send", {
          method: "POST",
          body: JSON.stringify({ text: longSingleLine }),
        }),
        {},
      );

      expect(response.status).toBe(200);
      expect(paneSendDeps.sendPromptToPane).toHaveBeenCalledWith(
        "%1",
        longSingleLine,
        true,
      );
      expect(paneSendDeps.sendLiteralToPane).not.toHaveBeenCalled();
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

    it("strips control chars (e.g. a raw ESC) before delivery, keeping tabs and newlines", async () => {
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
          body: JSON.stringify({
            text: "line one\x1b[201~\tline\ttwo\nline three",
          }),
        }),
        {},
      );

      expect(response.status).toBe(200);
      expect(paneSendDeps.sendPromptToPane).toHaveBeenCalledWith(
        "%1",
        "line one[201~\tline\ttwo\nline three",
        true,
      );
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

  it("carries the git-aware project so an invoke row groups with the repo's sessions", () => {
    // The board fabricates this row and can't walk the filesystem itself, so
    // an invoke launched from a worktree only groups under the repo (rather
    // than the worktree's directory name) if the daemon resolves it here.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-invoke-wt-")));
    try {
      const main = join(root, "myrepo");
      const worktree = join(root, "trees", "parking");
      mkdirSync(join(main, ".git", "worktrees", "parking"), {
        recursive: true,
      });
      mkdirSync(worktree, { recursive: true });
      writeFileSync(
        join(worktree, ".git"),
        `gitdir: ${join(main, ".git", "worktrees", "parking")}\n`,
      );

      const event = invocationEventToSSE({
        type: "started",
        record: { ...runningRecord, cwd: worktree },
      });
      if (event.type !== "invocation_started") throw new Error("wrong type");

      expect(event.project).toBe("myrepo");
      expect(event.isWorktree).toBe(true);
      expect(event.mainRepoRoot).toBe(main);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
  function withSpawnQueue(
    outcomes: Array<{ code: number; out: string; err?: string }>,
  ) {
    const original = Bun.spawn;
    const state = { calls: 0 };
    const queue = [...outcomes];
    Bun.spawn = ((..._args: unknown[]) => {
      state.calls++;
      const next = queue.shift() ?? { code: 0, out: "" };
      return {
        exited: Promise.resolve(next.code),
        stdout: new Blob([next.out]).stream(),
        stderr: new Blob([next.err ?? ""]).stream(),
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

  it("drops the cached socket after a failed pane scan and re-probes", async () => {
    const { internals } = createServer();
    const { state, restore } = withSpawnQueue([
      { code: 0, out: "/tmp/first-sock\n" },
      { code: 0, out: "/tmp/second-sock\n" },
    ]);
    try {
      expect(await internals.getServerSocketPath()).toBe("/tmp/first-sock");
      expect(state.calls).toBe(1);

      // tmux restarted onto a different socket; the scan loop noticed. Without
      // invalidation every client would keep comparing against the dead one and
      // refuse every pane as "a different server".
      internals.notePaneScanFailure("tmux list-panes exited 1");
      expect(await internals.getServerSocketPath()).toBe("/tmp/second-sock");
      expect(state.calls).toBe(2);
    } finally {
      restore();
    }
  });

  it("reports socketError on GET /server-info when the probe fails, and clears it once tmux is back", async () => {
    const { internals } = createServer();
    const { restore } = withSpawnQueue([
      { code: 1, out: "", err: "no server running on /tmp/tmux-501/work\n" },
      { code: 0, out: "/tmp/tmux-501/work\n" },
    ]);
    try {
      const failed = (await (
        await internals.handleRequest(
          new Request("http://localhost/server-info"),
        )
      ).json()) as {
        socketPath: string | null;
        socketError: { attemptedSocket: string | null; message: string } | null;
      };
      expect(failed.socketPath).toBe(null);
      expect(failed.socketError?.message).toBe(
        "no server running on /tmp/tmux-501/work",
      );
      // Named so a client can say WHICH server it could not reach.
      expect(failed.socketError?.attemptedSocket).toBeTruthy();

      const recovered = (await (
        await internals.handleRequest(
          new Request("http://localhost/server-info"),
        )
      ).json()) as {
        socketPath: string | null;
        socketError: { attemptedSocket: string | null; message: string } | null;
      };
      expect(recovered.socketPath).toBe("/tmp/tmux-501/work");
      expect(recovered.socketError).toBe(null);
    } finally {
      restore();
    }
  });

  it("serves socketError: null on a healthy daemon", async () => {
    const { internals } = createServer();
    const { restore } = withSpawnQueue([{ code: 0, out: "/tmp/ok-sock\n" }]);
    try {
      const res = await internals.handleRequest(
        new Request("http://localhost/server-info"),
      );
      const data = (await res.json()) as { socketError: unknown };
      expect(data.socketError).toBe(null);
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

describe("GET /agents", () => {
  it("serves spawnable agents as JSON", async () => {
    const { internals } = createServer();
    const res = await internals.handleRequest(
      new Request("http://localhost/agents"),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { agents: SpawnableAgent[] };
    expect(Array.isArray(data.agents)).toBe(true);
    // Which agents are installed is a property of the machine, so assert the
    // shape and the invariant instead: every entry is a real agent name, so
    // the dialog can hand any of them straight back to POST /spawn.
    for (const agent of data.agents) {
      expect(typeof agent.name).toBe("string");
      expect(typeof agent.displayName).toBe("string");
      expect(typeof agent.shortCode).toBe("string");
      expect(typeof agent.supportsPrompt).toBe("boolean");
    }
    const names = data.agents.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("lists only agents the spawn path can resolve", async () => {
    // The daemon resolves its agent list once at boot. A name the config
    // knows but this daemon doesn't must not reach the dialog, or Enter
    // would answer "Unknown agent" for something the menu offered.
    const { internals } = createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      (agentType: string) =>
        agentType === "claude"
          ? BUILTIN_AGENTS.find((a) => a.name === "claude")
          : undefined,
    );
    const res = await internals.handleRequest(
      new Request("http://localhost/agents"),
    );
    const data = (await res.json()) as { agents: SpawnableAgent[] };
    expect(data.agents.every((a) => a.name === "claude")).toBe(true);
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

describe("broadcastEvent stringify-once (issue #55 item 3)", () => {
  function fakeController() {
    const received: string[] = [];
    return {
      received,
      controller: {
        enqueue: (data: string) => {
          received.push(data);
        },
      },
    };
  }

  it("stringifies the event exactly once regardless of client count", () => {
    const { internals } = createServer();
    const clients = [fakeController(), fakeController(), fakeController()];
    clients.forEach(({ controller }, i) => {
      internals.sseClients.set(`client-${i}`, {
        id: `client-${i}`,
        controller,
      });
    });

    const stringifySpy = spyOn(JSON, "stringify");
    const event: SSEEvent = {
      type: "daemon_health",
      timestamp: "2024-01-15T12:00:00Z",
      health: { degraded: false },
    };
    internals.broadcastEvent(event);
    const callCount = stringifySpy.mock.calls.length;
    stringifySpy.mockRestore();

    expect(callCount).toBe(1);
  });

  it("sends byte-identical frames to every connected client", () => {
    const { internals } = createServer();
    const clients = [fakeController(), fakeController(), fakeController()];
    clients.forEach(({ controller }, i) => {
      internals.sseClients.set(`client-${i}`, {
        id: `client-${i}`,
        controller,
      });
    });

    const event: SSEEvent = {
      type: "daemon_health",
      timestamp: "2024-01-15T12:00:00Z",
      health: {
        degraded: true,
        reason: "test",
        since: "2024-01-15T12:00:00Z",
      },
    };
    internals.broadcastEvent(event);

    const frames = clients.map((c) => c.received[0]);
    expect(frames.every((f) => f !== undefined)).toBe(true);
    expect(new Set(frames).size).toBe(1);
    expect(frames[0]).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });
});

describe("POST /spawn", () => {
  // Every argv here is executed against the user's live tmux server, and
  // the built command string is typed into the new pane and submitted
  // with Enter. Both are pinned end to end through the route.

  /**
   * A stubbed subcommand either exits with a code and output, or throws
   * synchronously the way `Bun.spawn` really does for an oversized argv
   * (E2BIG on macOS, a single over-128KiB argument on Linux) rather than
   * exiting non-zero.
   */
  type TmuxOutcome =
    | { code: number; out: string; err?: string }
    | { throws: true };

  /**
   * Stub `Bun.spawn`, recording every argv. Outcomes are matched by tmux
   * subcommand so a test only has to describe the calls it cares about;
   * anything unlisted succeeds with empty output.
   *
   * `panes` overrides the pane probe per pane id (`%12` -> `"@9 $3"`), and
   * `clients` the attached-client probe per session id (`$3` -> ttys), neither
   * of which a subcommand-keyed outcome can express: the cross-session cases
   * probe two different panes and need two different answers, and an empty
   * client list is a meaningful answer rather than a missing one.
   */
  function withTmuxRecorder(
    outcomes: Record<string, TmuxOutcome> = {},
    panes: Record<string, string> = {},
    clients: Record<string, string[]> = {},
  ) {
    const original = Bun.spawn;
    const argv: string[][] = [];
    const defaults: Record<string, TmuxOutcome> = {
      // Pane probe: `#{window_id} #{session_id}` for a live pane.
      "display-message": { code: 0, out: "@9 $3\n" },
      // Attached-client probe: a session with nobody looking at it.
      "list-clients": { code: 0, out: "" },
    };
    Bun.spawn = ((spawned: string[]) => {
      argv.push(spawned);
      const key = spawned[1] ?? "";
      // `display-message -p -t <pane> -F ...`
      const probed =
        key === "display-message" ? panes[spawned[4] ?? ""] : undefined;
      // `list-clients -t <session> -F ...`
      const attached =
        key === "list-clients" ? clients[spawned[3] ?? ""] : undefined;
      const next = (probed === undefined
        ? undefined
        : { code: 0, out: `${probed}\n` }) ??
        (attached === undefined
          ? undefined
          : { code: 0, out: `${attached.join("\n")}\n` }) ??
        outcomes[key] ??
        defaults[key] ?? { code: 0, out: "%99\n" };
      if ("throws" in next) {
        throw new Error("posix_spawn failed: E2BIG (Argument list too long)");
      }
      return {
        exited: Promise.resolve(next.code),
        stdout: new Blob([next.out]).stream(),
        stderr: new Blob([next.err ?? ""]).stream(),
      };
    }) as unknown as typeof Bun.spawn;
    return { argv, restore: () => (Bun.spawn = original) };
  }

  const promptAgent: AgentDef = {
    ...BUILTIN_AGENTS.find((a) => a.name === "claude")!,
    name: "prompty",
    promptCommand: "{bin} '{prompt}'",
    executable: "prompty",
  };
  const noPromptAgent: AgentDef = {
    ...promptAgent,
    name: "flagless",
    executable: "flagless",
    promptCommand: undefined,
  };

  function spawnRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/spawn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function serverForAgents(agents: AgentDef[]) {
    return createServer(
      undefined,
      undefined,
      undefined,
      undefined,
      (name: string) =>
        agents.find((a) => a.name === name) ??
        BUILTIN_AGENTS.find((a) => a.name === name),
    );
  }

  const cwd = tmpdir();

  it("creates a new window with no target by default", async () => {
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, detach: true }),
      );
      expect(res.status).toBe(200);
      expect(argv[0]).toEqual([
        "tmux",
        "new-window",
        "-d",
        "-c",
        cwd,
        "-P",
        "-F",
        "#{pane_id}",
      ]);
    } finally {
      restore();
    }
  });

  it("splits the target pane left/right for split 'h'", async () => {
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({
          agent: "prompty",
          cwd,
          split: "h",
          target: "%5",
          detach: true,
        }),
      );
      expect(res.status).toBe(200);
      // The pane is probed first so a stale target is a 400 on this path
      // too, rather than tmux's raw stderr as a 500.
      expect(argv[0]?.[1]).toBe("display-message");
      expect(argv[1]).toEqual([
        "tmux",
        "split-window",
        "-h",
        "-d",
        "-t",
        "%5",
        "-c",
        cwd,
        "-P",
        "-F",
        "#{pane_id}",
      ]);
    } finally {
      restore();
    }
  });

  it("keeps the legacy boolean split on tmux's stacked default", async () => {
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, split: true, detach: true }),
      );
      expect(argv[0]?.slice(1, 3)).toEqual(["split-window", "-v"]);
    } finally {
      restore();
    }
  });

  it("inserts after the window of an EXPLICIT target pane", async () => {
    // `new-window -t %pane` fails outright ("can't specify pane here"),
    // so the pane is translated. `-a` is accepted here because the user
    // named the target, even though it renumbers the windows after it.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, target: "%5", detach: true }),
      );
      expect(res.status).toBe(200);
      expect(argv[0]?.[1]).toBe("display-message");
      expect(argv[1]).toEqual([
        "tmux",
        "new-window",
        "-d",
        "-a",
        "-t",
        "@9",
        "-c",
        cwd,
        "-P",
        "-F",
        "#{pane_id}",
      ]);
    } finally {
      restore();
    }
  });

  it("appends to the caller's SESSION for an implicit caller pane", async () => {
    // Verified live: `-a -t @window` shifts every later window's index,
    // so a plain `ccmux spawn` must not use it. Targeting the session
    // appends at the end and renumbers nothing, while still landing in
    // the caller's session rather than the daemon's current one.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, callerPane: "%5", detach: true }),
      );
      expect(res.status).toBe(200);
      expect(argv[1]).toEqual([
        "tmux",
        "new-window",
        "-d",
        "-t",
        "$3:",
        "-c",
        cwd,
        "-P",
        "-F",
        "#{pane_id}",
      ]);
    } finally {
      restore();
    }
  });

  it("splits the caller's pane when no explicit target is given", async () => {
    // For a split the two fields mean the same thing: split HERE.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      await internals.handleRequest(
        spawnRequest({
          agent: "prompty",
          cwd,
          split: "v",
          callerPane: "%5",
          detach: true,
        }),
      );
      expect(argv[1]?.slice(1)).toEqual([
        "split-window",
        "-v",
        "-d",
        "-t",
        "%5",
        "-c",
        cwd,
        "-P",
        "-F",
        "#{pane_id}",
      ]);
    } finally {
      restore();
    }
  });

  it("rejects a stale target the same way on both branches", async () => {
    // Previously asymmetric: the split path surfaced tmux's raw stderr as
    // a 500 while the new-window path returned a clean 400.
    for (const split of [false, "h"]) {
      const { internals } = serverForAgents([promptAgent]);
      const { argv, restore } = withTmuxRecorder({
        "display-message": { code: 0, out: "\n" },
      });
      try {
        const res = await internals.handleRequest(
          spawnRequest({ agent: "prompty", cwd, split, target: "%404" }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(
          "%404",
        );
        // Nothing was created, so there is nothing to clean up.
        expect(argv).toHaveLength(1);
      } finally {
        restore();
      }
    }
  });

  it("rejects a prompt with a NUL before creating any pane", async () => {
    // NUL survives shell escaping but makes Bun.spawn reject the argv,
    // which used to happen AFTER the pane existed: an orphaned pane and
    // an opaque 500, repeatable as a pane leak.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, prompt: "a\u0000b" }),
      );
      expect(res.status).toBe(400);
      expect(argv).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("rejects an empty or non-string prompt", async () => {
    // `--prompt ""` used to spawn a bare agent AND bypass the refusal an
    // agent without promptCommand should get; a number threw a TypeError
    // outside the route's try block, surfacing as an opaque 500.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      for (const prompt of ["", "   ", 123]) {
        const res = await internals.handleRequest(
          spawnRequest({ agent: "prompty", cwd, prompt }),
        );
        expect(res.status).toBe(400);
      }
      expect(argv).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("rejects an over-cap prompt before any pane exists", async () => {
    // `/spawn` has no config gate on prompt size, unlike `/invoke`'s
    // `MAX_INVOKE_PROMPT_BYTES`. Below this cap `Bun.spawn` throws E2BIG
    // rather than exiting non-zero, well after the pane exists; the cap
    // turns that into a clean 400 with nothing created.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({
          agent: "prompty",
          cwd,
          prompt: "a".repeat(MAX_SPAWN_PROMPT_BYTES + 1),
        }),
      );
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain(String(MAX_SPAWN_PROMPT_BYTES));
      expect(argv).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("rejects a prompt Linux could not pass as one argument", async () => {
    // 200 KiB passed the old 256 KiB cap and then threw at spawn time on
    // Linux, where a SINGLE argument over 128 KiB (MAX_ARG_STRLEN) is rejected
    // no matter how small the rest of the argv is. That throw surfaced as a
    // 500 after the pane existed, which is exactly what the cap exists to
    // prevent, so the cap has to sit below the per-argument limit.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({
          agent: "prompty",
          cwd,
          prompt: "a".repeat(200 * 1024),
        }),
      );
      expect(res.status).toBe(400);
      expect(argv).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("rejects a prompt whose ESCAPED form outgrows the argument limit", async () => {
    // A raw-prompt cap cannot make the promise on its own: every single quote
    // becomes four bytes ('\''), so a prompt well inside the cap can build a
    // command that no longer fits. Measured on the built string instead, and
    // still before any pane exists.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const prompt = "'".repeat(64 * 1024);
      expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(
        MAX_SPAWN_PROMPT_BYTES,
      );
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, prompt }),
      );

      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain("single command argument");
      expect(argv).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("accepts a prompt exactly at the byte cap", async () => {
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({
          agent: "prompty",
          cwd,
          prompt: "a".repeat(MAX_SPAWN_PROMPT_BYTES),
          detach: true,
        }),
      );
      expect(res.status).toBe(200);
      expect(argv.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("kills the pane when a post-creation tmux spawn throws instead of exiting non-zero", async () => {
    // `Bun.spawn` throws synchronously for an oversized argv rather than
    // exiting non-zero (confirmed: E2BIG at ~1MB on macOS, a single
    // over-128KiB argument on Linux). Before this fix, that throw skipped
    // straight to the outer catch, which had no pane id in scope and left
    // the orphan behind.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder({
      "send-keys": { throws: true },
    });
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, detach: true }),
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(argv.map((a) => a[1])).toEqual([
        "new-window",
        "send-keys",
        "kill-pane",
      ]);
      expect(argv[2]).toEqual(["tmux", "kill-pane", "-t", "%99"]);
    } finally {
      restore();
    }
  });

  it("detaching passes -d and skips select-window", async () => {
    // Both halves are needed. `-d` stops tmux making the new window
    // current (which it does by default), and skipping select-window
    // stops us switching back to it afterwards. Either one alone leaves
    // `--detach` yanking the caller's view.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, detach: true }),
      );
      expect(argv[0]).toContain("-d");
      expect(argv.map((a) => a[1])).not.toContain("select-window");
    } finally {
      restore();
    }
  });

  it("not detaching omits -d and still selects the new window", async () => {
    // The default. A regression here would stop every plain spawn from
    // focusing what it just created.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, detach: false }),
      );
      expect(argv[0]).not.toContain("-d");
      expect(argv.map((a) => a[1])).toContain("select-window");
    } finally {
      restore();
    }
  });

  it("omitted detach behaves like false", async () => {
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      await internals.handleRequest(spawnRequest({ agent: "prompty", cwd }));
      expect(argv[0]).not.toContain("-d");
      expect(argv.map((a) => a[1])).toContain("select-window");
    } finally {
      restore();
    }
  });

  it("treats an explicitly null detach as absent", async () => {
    // The rest of the spawn body (prompt, resume, fork) deliberately reads an
    // explicit null as "field omitted", for clients that serialize it that
    // way; detach 400ing on it was the odd one out.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, detach: null }),
      );

      expect(res.status).toBe(200);
      expect(argv[0]).not.toContain("-d");
      expect(argv.map((a) => a[1])).toContain("select-window");
    } finally {
      restore();
    }
  });

  it("rejects a truthy non-boolean detach instead of treating it as true", async () => {
    // Before the fix, `body` was an unchecked cast: the string "false" is
    // truthy, so it passed tmux `-d` and suppressed `select-window` — the
    // opposite of what the caller wrote.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, detach: "false" }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        "detach",
      );
      expect(argv).toHaveLength(0);
    } finally {
      restore();
    }
  });

  describe("cross-session target (#75)", () => {
    // `--target` accepts any pane on the server, so it can name one in a
    // DIFFERENT session than the caller. `select-window` cannot move an
    // attached client between sessions — it only changes which window is
    // current inside the target's session — so the spawn used to report
    // success and leave the user where they were. Verified by hand on an
    // isolated tmux server: a client attached to A stayed on A across
    // `select-window -t <pane in B>` and followed `switch-client -c <tty>`.
    const twoSessions = { "%1": "@1 $1", "%2": "@2 $2" };
    /** The caller (session `$1`) has a terminal of its own attached. */
    const callerAttached = { $1: ["/dev/ttys004"] };

    /** The tmux argv that was supposed to move the caller's view. */
    function focusCall(argv: string[][]): string[] | undefined {
      return argv.find(
        (a) => a[1] === "select-window" || a[1] === "switch-client",
      );
    }

    it("switches the caller's client to a target in another session", async () => {
      const { internals } = serverForAgents([promptAgent]);
      const { argv, restore } = withTmuxRecorder(
        {},
        twoSessions,
        callerAttached,
      );
      try {
        const res = await internals.handleRequest(
          spawnRequest({
            agent: "prompty",
            cwd,
            target: "%2",
            callerPane: "%1",
            callerTty: "/dev/ttys004",
          }),
        );

        expect(res.status).toBe(200);
        expect(focusCall(argv)).toEqual([
          "tmux",
          "switch-client",
          "-c",
          "/dev/ttys004",
          "-t",
          "%99",
        ]);
      } finally {
        restore();
      }
    });

    it("still just selects the window when the target is in the caller's session", async () => {
      // Byte-for-byte the pre-fix behavior, which is the whole safety
      // property: a spawn in your own session must not touch your client.
      const { internals } = serverForAgents([promptAgent]);
      const { argv, restore } = withTmuxRecorder(
        {},
        { "%1": "@1 $1", "%2": "@2 $1" },
      );
      try {
        await internals.handleRequest(
          spawnRequest({
            agent: "prompty",
            cwd,
            target: "%2",
            callerPane: "%1",
            callerTty: "/dev/ttys004",
          }),
        );

        expect(focusCall(argv)).toEqual(["tmux", "select-window", "-t", "%99"]);
        expect(argv.map((a) => a[1])).not.toContain("switch-client");
        // Nothing to verify, so nothing is asked.
        expect(argv.map((a) => a[1])).not.toContain("list-clients");
      } finally {
        restore();
      }
    });

    it("refuses to move a client that is not in the caller's session", async () => {
      // The bystander case, and the reason the tty alone is not enough:
      // spawning from a DETACHED session makes tmux's `#{client_tty}` fall
      // back to the most-recently-active client of ANY session, so the CLI
      // honestly reports a terminal that belongs to someone else's work.
      // Switching it would drag that user into a pane they never asked for —
      // strictly worse than the `select-window` this replaced.
      const { internals } = serverForAgents([promptAgent]);
      const { argv, restore } = withTmuxRecorder({}, twoSessions, {
        // The caller's session `$1` has nobody attached; the tty the CLI sent
        // is a client of some third session entirely.
        $1: [],
      });
      try {
        const res = await internals.handleRequest(
          spawnRequest({
            agent: "prompty",
            cwd,
            target: "%2",
            callerPane: "%1",
            callerTty: "/dev/ttys004",
          }),
        );

        expect(res.status).toBe(200);
        expect(focusCall(argv)).toEqual(["tmux", "select-window", "-t", "%99"]);
        expect(argv.map((a) => a[1])).not.toContain("switch-client");
        // Membership is asked about the CALLER's session, not the target's.
        expect(argv.find((a) => a[1] === "list-clients")).toEqual([
          "tmux",
          "list-clients",
          "-t",
          "$1",
          "-F",
          "#{client_tty}",
        ]);
      } finally {
        restore();
      }
    });

    it("refuses when the membership probe itself fails", async () => {
      const { internals } = serverForAgents([promptAgent]);
      const { argv, restore } = withTmuxRecorder(
        { "list-clients": { code: 1, out: "" } },
        twoSessions,
      );
      try {
        const res = await internals.handleRequest(
          spawnRequest({
            agent: "prompty",
            cwd,
            target: "%2",
            callerPane: "%1",
            callerTty: "/dev/ttys004",
          }),
        );

        expect(res.status).toBe(200);
        expect(focusCall(argv)).toEqual(["tmux", "select-window", "-t", "%99"]);
      } finally {
        restore();
      }
    });

    it("suppresses the switch entirely when detached", async () => {
      const { internals } = serverForAgents([promptAgent]);
      const { argv, restore } = withTmuxRecorder({}, twoSessions);
      try {
        await internals.handleRequest(
          spawnRequest({
            agent: "prompty",
            cwd,
            target: "%2",
            callerPane: "%1",
            callerTty: "/dev/ttys004",
            detach: true,
          }),
        );

        expect(focusCall(argv)).toBeUndefined();
        // And the caller's pane is not even probed: nothing downstream of
        // `--detach` can use the answer.
        expect(argv.filter((a) => a[1] === "display-message")).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("selects the window when no client tty was sent", async () => {
      // Older CLIs, and every caller that places by `callerPane` alone. The
      // daemon has no client of its own, so with nothing to name it falls
      // back rather than moving whichever client tmux would have picked.
      const { internals } = serverForAgents([promptAgent]);
      const { argv, restore } = withTmuxRecorder({}, twoSessions);
      try {
        await internals.handleRequest(
          spawnRequest({
            agent: "prompty",
            cwd,
            target: "%2",
            callerPane: "%1",
          }),
        );

        expect(focusCall(argv)).toEqual(["tmux", "select-window", "-t", "%99"]);
        // The second probe is skipped too, so a spawn with no tty costs
        // exactly the tmux round-trips it always did.
        expect(argv.filter((a) => a[1] === "display-message")).toHaveLength(1);
      } finally {
        restore();
      }
    });

    it("logs a focus command tmux refused instead of dropping it", async () => {
      // The response still says `success: true`, and honestly so — the pane
      // exists and the agent is running. But a switch that silently did
      // nothing would leave the user with a view that never moved and no
      // trace anywhere of why. `can't find client` is the live failure mode
      // now that the tty arrives from off-process.
      const errors: string[] = [];
      const errorSpy = spyOn(console, "error").mockImplementation(
        (...args: unknown[]) => {
          errors.push(args.join(" "));
        },
      );
      const { internals } = serverForAgents([promptAgent]);
      const { restore } = withTmuxRecorder(
        { "switch-client": { code: 1, out: "", err: "can't find client\n" } },
        twoSessions,
        callerAttached,
      );
      try {
        const res = await internals.handleRequest(
          spawnRequest({
            agent: "prompty",
            cwd,
            target: "%2",
            callerPane: "%1",
            callerTty: "/dev/ttys004",
          }),
        );

        expect(res.status).toBe(200);
        const logged = errors.join("\n");
        expect(logged).toContain("switch-client");
        expect(logged).toContain("%99");
        expect(logged).toContain("can't find client");
      } finally {
        errorSpy.mockRestore();
        restore();
      }
    });

    it("rejects a callerTty that is not a device path", async () => {
      const { internals } = serverForAgents([promptAgent]);
      const { argv, restore } = withTmuxRecorder({}, twoSessions);
      try {
        const res = await internals.handleRequest(
          spawnRequest({
            agent: "prompty",
            cwd,
            target: "%2",
            callerTty: "not-a-tty",
          }),
        );

        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(
          "callerTty",
        );
        expect(argv).toHaveLength(0);
      } finally {
        restore();
      }
    });
  });

  it("succeeds without killing the pane when select-window itself throws", async () => {
    // The agent is already running by the time select-window runs
    // (send-keys succeeded), so a focus-switch failure here must not be
    // reported as a failed spawn or tear down a session the caller can
    // already see.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder({
      "select-window": { throws: true },
    });
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, detach: false }),
      );
      expect(res.status).toBe(200);
      expect(argv.map((a) => a[1])).not.toContain("kill-pane");
    } finally {
      restore();
    }
  });

  it("kills the new pane when the command cannot be sent", async () => {
    // The pane exists by then, so a failure that leaves it behind strands
    // an empty shell the caller never asked for.
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder({
      "send-keys": { code: 1, out: "" },
    });
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, detach: true }),
      );
      expect(res.status).toBe(500);
      expect(argv.map((a) => a[1])).toEqual([
        "new-window",
        "send-keys",
        "kill-pane",
      ]);
      expect(argv[2]).toEqual(["tmux", "kill-pane", "-t", "%99"]);
    } finally {
      restore();
    }
  });

  it("rejects an unknown split direction and a non-pane target", async () => {
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const bad = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, split: "horizontal" }),
      );
      expect(bad.status).toBe(400);
      const badTarget = await internals.handleRequest(
        spawnRequest({ agent: "prompty", cwd, target: "@3" }),
      );
      expect(badTarget.status).toBe(400);
      expect(argv).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("types the agent's promptCommand into the pane", async () => {
    const { internals } = serverForAgents([promptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({
          agent: "prompty",
          cwd,
          prompt: "don't stop",
          detach: true,
        }),
      );
      expect(res.status).toBe(200);
      expect(argv[1]).toEqual([
        "tmux",
        "send-keys",
        "-t",
        "%99",
        "prompty 'don'\\''t stop'",
        "Enter",
      ]);
    } finally {
      restore();
    }
  });

  it("refuses a prompt spawn for an agent with no promptCommand", async () => {
    // The old code emitted `--prompt` for every agent, which silently
    // means one-shot print mode (Copilot) or an unknown flag (pi).
    const { internals } = serverForAgents([noPromptAgent]);
    const { argv, restore } = withTmuxRecorder();
    try {
      const res = await internals.handleRequest(
        spawnRequest({ agent: "flagless", cwd, prompt: "hi" }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        "promptCommand",
      );
      expect(argv).toHaveLength(0);
    } finally {
      restore();
    }
  });

  describe("forking a session", () => {
    const forkAgent: AgentDef = {
      ...promptAgent,
      name: "forky",
      executable: "forky",
      forkCommand: "{bin} --resume {id} --fork-session",
    };
    const noForkAgent: AgentDef = {
      ...forkAgent,
      name: "unforkable",
      executable: "unforkable",
      forkCommand: undefined,
    };
    /** The shape Claude ships: resume by transcript PATH, so the fork is not
     *  tied to the directory the source happens to be sitting in. */
    const pathForkAgent: AgentDef = {
      ...forkAgent,
      name: "pathy",
      executable: "pathy",
      forkCommand: "{bin} --resume '{path}' --fork-session",
    };

    /**
     * tmux stubbed, everything else left alone, for the cases that drive REAL
     * git: a destination guard resolving two checkouts, or a worktree the
     * request actually creates. `withTmuxRecorder` intercepts every spawn, so
     * it cannot be used for those.
     */
    function withTmuxOnly() {
      const original = Bun.spawn;
      const argv: string[][] = [];
      Bun.spawn = ((spawned: string[], opts?: unknown) => {
        if (spawned[0] !== "tmux") {
          return (original as (a: string[], b?: unknown) => unknown)(
            spawned,
            opts,
          );
        }
        argv.push(spawned);
        const out = spawned[1] === "display-message" ? "@9 $3\n" : "%99\n";
        return {
          exited: Promise.resolve(0),
          stdout: new Blob([out]).stream(),
          stderr: new Blob([""]).stream(),
        };
      }) as unknown as typeof Bun.spawn;
      return { argv, restore: () => (Bun.spawn = original) };
    }

    const fixtureEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    function fixtureGit(cwd: string, ...args: string[]): void {
      const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
        env: fixtureEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${proc.stderr.toString()}`,
        );
      }
    }
    /** git's trimmed stdout, for the assertions that read a fixture back. */
    function gitOut(cwd: string, args: string[]): string {
      return Bun.spawnSync(["git", "-C", cwd, ...args], {
        env: fixtureEnv,
        stdout: "pipe",
        stderr: "pipe",
      })
        .stdout.toString()
        .trim();
    }
    /** Whatever `git init` named it here; `init.defaultBranch` is the user's. */
    function defaultBranch(repo: string): string {
      return gitOut(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    }
    /** A one-commit repo, realpath'd so it compares equal to git's answer. */
    function fixtureRepo(): string {
      const repo = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-forkid-")));
      Bun.spawnSync(["git", "init", "-q", repo], { env: fixtureEnv });
      fixtureGit(repo, "commit", "-q", "--allow-empty", "-m", "x");
      return repo;
    }

    /** A readable transcript on disk, since a `{path}` fork stats the file. */
    function transcriptFor(
      manager: SessionManager,
      sessionId: string,
      name = "src-sid.jsonl",
    ): { path: string; cleanup: () => void } {
      const dir = mkdtempSync(join(tmpdir(), "ccmux-forkpath-"));
      const path = join(dir, name);
      writeFileSync(path, "{}\n");
      manager.setLogPath(sessionId, path);
      return {
        path,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    }

    /** A row of `agentType` sitting in a pane in a real cwd. `null` for the
     *  native id is the no-hooks case: an agent ccmux can see but whose
     *  conversation it cannot name. */
    function trackedSession(
      manager: SessionManager,
      agentType: string,
      nativeSessionId: string | null = "src-sid",
    ) {
      return manager.createPaneTrackedSession({
        agentType,
        paneId: "%3",
        cwd,
        pid: 4242,
        nativeSessionId: nativeSessionId ?? undefined,
      });
    }

    it("builds the fork command from the source session's native id", async () => {
      const { manager, internals } = serverForAgents([forkAgent]);
      const source = trackedSession(manager, "forky");
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id, detach: true }),
        );
        expect(res.status).toBe(200);
        expect(argv[0]?.[1]).toBe("new-window");
        expect(argv[1]).toEqual([
          "tmux",
          "send-keys",
          "-t",
          "%99",
          "forky --resume src-sid --fork-session",
          "Enter",
        ]);
      } finally {
        restore();
      }
    });

    it("takes the agent from the source, ignoring the caller's", async () => {
      const { manager, internals } = serverForAgents([forkAgent, noForkAgent]);
      const source = trackedSession(manager, "forky");
      const { argv, restore } = withTmuxRecorder();
      try {
        // `agent` names a DIFFERENT agent and is ignored: the conversation
        // being continued decides what runs, not the caller.
        const res = await internals.handleRequest(
          spawnRequest({
            fork: source.id,
            agent: "unforkable",
            detach: true,
          }),
        );
        expect(res.status).toBe(200);
        // And with no cwd sent it starts in the SOURCE's directory.
        expect(argv[0]).toContain(source.cwd);
        expect(argv[1]?.[4]).toContain("forky --resume src-sid");
      } finally {
        restore();
      }
    });

    it("resolves the source by native id as well as by tracked id", async () => {
      const { manager, internals } = serverForAgents([forkAgent]);
      trackedSession(manager, "forky", "native-abc");
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: "native-abc", detach: true }),
        );
        expect(res.status).toBe(200);
        expect(argv[1]?.[4]).toBe("forky --resume native-abc --fork-session");
      } finally {
        restore();
      }
    });

    it("places the fork where the caller asks, beside the source pane", async () => {
      // Placement stays entirely the caller's: the fork path adds no
      // targeting of its own, which is what keeps command construction and
      // pane placement independent.
      const { manager, internals } = serverForAgents([forkAgent]);
      const source = trackedSession(manager, "forky");
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({
            fork: source.id,
            split: "h",
            target: "%3",
            detach: true,
          }),
        );
        expect(res.status).toBe(200);
        expect(argv[1]?.slice(1, 6)).toEqual([
          "split-window",
          "-h",
          "-d",
          "-t",
          "%3",
        ]);
      } finally {
        restore();
      }
    });

    it("refuses an agent with no forkCommand", async () => {
      const { manager, internals } = serverForAgents([noForkAgent]);
      const source = trackedSession(manager, "unforkable");
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(
          "forkCommand",
        );
        expect(argv).toHaveLength(0);
      } finally {
        restore();
      }
    });

    it("refuses a row with no native session id", async () => {
      // Pane-tracked without hooks: ccmux knows an agent is running there
      // but not which conversation, so there is nothing to continue.
      const { manager, internals } = serverForAgents([forkAgent]);
      const source = trackedSession(manager, "forky", null);
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(
          "no native session id",
        );
        expect(argv).toHaveLength(0);
      } finally {
        restore();
      }
    });

    it("forks into a DIFFERENT directory", async () => {
      // This used to be a 400. The model behind it was wrong: `--resume <id>`
      // is repo-scoped (it also tries every checkout `git worktree list`
      // reports), and the built-in template now resumes by transcript path,
      // which is directory-independent outright. The equality test refused
      // destinations that work, and never fired on the path the picker uses.
      const { manager, internals } = serverForAgents([pathForkAgent]);
      const source = trackedSession(manager, "pathy");
      const { path, cleanup } = transcriptFor(manager, source.id);
      const elsewhere = realpathSync(
        mkdtempSync(join(tmpdir(), "ccmux-fork-")),
      );
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id, cwd: elsewhere, detach: true }),
        );
        expect(res.status).toBe(200);
        // The pane really is created in the requested directory, and the
        // command it runs points at the source's own transcript.
        expect(argv[0]).toContain(elsewhere);
        expect(argv[1]?.[4]).toBe(`pathy --resume '${path}' --fork-session`);
      } finally {
        restore();
        cleanup();
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it("defaults to the source's directory when no cwd is sent", async () => {
      // What the picker does, and the reason it is a default rather than a
      // constraint: a fork belongs beside its original.
      const { manager, internals } = serverForAgents([pathForkAgent]);
      const source = trackedSession(manager, "pathy");
      const { cleanup } = transcriptFor(manager, source.id);
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id, detach: true }),
        );
        expect(res.status).toBe(200);
        expect(argv[0]).toContain(source.cwd);
      } finally {
        restore();
        cleanup();
      }
    });

    it("quotes a transcript path containing a space and a quote", async () => {
      // Byte-exact, because this string is typed into a pane's shell and a
      // project directory can legally hold either character.
      const { manager, internals } = serverForAgents([pathForkAgent]);
      const source = trackedSession(manager, "pathy");
      const { path, cleanup } = transcriptFor(
        manager,
        source.id,
        "it's a.jsonl",
      );
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id, detach: true }),
        );
        expect(res.status).toBe(200);
        expect(argv[1]?.[4]).toBe(
          `pathy --resume '${path.replace(/'/g, "'\\''")}' --fork-session`,
        );
        // Spelled out once, so a change to the escaping cannot pass by
        // rewriting the expression above.
        expect(argv[1]?.[4]).toContain("/it'\\''s a.jsonl'");
      } finally {
        restore();
        cleanup();
      }
    });

    it("refuses a {path} fork with no usable transcript, creating no pane", async () => {
      // The path form's whole value is that the agent opens the file instead
      // of deriving a directory. A path that resolves to nothing reproduces
      // the failure it prevents: a live pane that found no conversation,
      // which ccmux cannot detect. So this has to 400 BEFORE tmux is touched.
      const dir = mkdtempSync(join(tmpdir(), "ccmux-forkpath-"));
      const unusable = [
        // Never recorded (no hooks yet, or a row that has not taken a turn).
        null,
        // Relative, so it would resolve against the destination's cwd.
        "relative/src-sid.jsonl",
        // Absolute and named right, but not on disk.
        join(dir, "gone.jsonl"),
      ];
      try {
        for (const logPath of unusable) {
          const { manager, internals } = serverForAgents([pathForkAgent]);
          const source = trackedSession(manager, "pathy");
          if (logPath !== null) manager.setLogPath(source.id, logPath);
          const { argv, restore } = withTmuxRecorder();
          try {
            const res = await internals.handleRequest(
              spawnRequest({ fork: source.id, detach: true }),
            );
            expect(res.status).toBe(400);
            const { error } = (await res.json()) as { error: string };
            expect(error).toContain("Cannot fork session src-sid");
            // Actionable: names both ways out.
            expect(error).toContain("ccmux setup");
            expect(error).toContain("--resume {id}");
            expect(argv).toHaveLength(0);
          } finally {
            restore();
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("still forks an id-based template with no transcript at all", async () => {
      // The compatibility fallback. `--resume <absolute path>` is
      // undocumented (verified on Claude Code 2.1.218 through 2.1.220), so
      // reverting `agents.<name>.forkCommand` to the id form in ccmux.json
      // has to keep working, transcript or no transcript.
      const { manager, internals } = serverForAgents([forkAgent]);
      const source = trackedSession(manager, "forky");
      expect(source.logPath).toBeNull();
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id, detach: true }),
        );
        expect(res.status).toBe(200);
        expect(argv[1]?.[4]).toBe("forky --resume src-sid --fork-session");
      } finally {
        restore();
      }
    });

    it("allows an explicit cwd that MATCHES the source", async () => {
      // Echoing the session's own cwd is as accepted as omitting it.
      const { manager, internals } = serverForAgents([forkAgent]);
      const source = trackedSession(manager, "forky");
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id, cwd: source.cwd, detach: true }),
        );
        expect(res.status).toBe(200);
        expect(argv[1]?.[4]).toContain("forky --resume src-sid");
      } finally {
        restore();
      }
    });

    /**
     * The id-form template is repo-scoped, so its destination is not free the
     * way a `{path}` fork's is. These two drive real git (the guard resolves
     * both directories' main checkout), so tmux is stubbed on its own.
     */
    describe("an id-form template's destination", () => {
      it("is refused outside the source's repository, creating no pane", async () => {
        // `claude --resume <id>` derives the project directory from the launch
        // cwd and falls back to every checkout `git worktree list` reports, so
        // from outside the repo it finds no conversation, prints "No
        // conversation found" and drops to a shell: a live pane ccmux cannot
        // tell from a working fork. Refused before tmux is touched.
        const repo = fixtureRepo();
        const elsewhere = realpathSync(
          mkdtempSync(join(tmpdir(), "ccmux-forkid-out-")),
        );
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = manager.createPaneTrackedSession({
          agentType: "forky",
          paneId: "%3",
          cwd: repo,
          pid: 4242,
          nativeSessionId: "src-sid",
        });
        const { argv, restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({ fork: source.id, cwd: elsewhere, detach: true }),
          );

          expect(res.status).toBe(400);
          const { error } = (await res.json()) as { error: string };
          // Names the cause and the way out, since the id form is itself the
          // escape hatch someone chose in ccmux.json.
          expect(error).toContain("forkCommand");
          expect(error).toContain("{path}");
          expect(argv).toHaveLength(0);
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
          rmSync(elsewhere, { recursive: true, force: true });
        }
      });

      it("accepts a sibling worktree of the same repository", async () => {
        // The guard is repo-scoped, not the plain cwd equality it replaces:
        // every checkout of the repo is a directory the id resolves from, and
        // forking into one is the whole point of the worktree destination.
        const repo = fixtureRepo();
        const sibling = join(repo, "trees", "feature");
        fixtureGit(repo, "worktree", "add", "-q", "-b", "feature", sibling);
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = manager.createPaneTrackedSession({
          agentType: "forky",
          paneId: "%3",
          cwd: repo,
          pid: 4242,
          nativeSessionId: "src-sid",
        });
        const { argv, restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({ fork: source.id, cwd: sibling, detach: true }),
          );

          expect(res.status).toBe(200);
          expect(argv[0]).toContain(sibling);
          expect(argv[1]?.[4]).toBe("forky --resume src-sid --fork-session");
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });
    });

    /**
     * A fork whose destination the request CREATES (issue #70). Real git
     * throughout: the worktree, its branch and the ref it was cut from are
     * the whole subject, so stubbing git would test nothing.
     */
    describe("into a new worktree", () => {
      /** The source of a fork: a live agent sitting in `repo`. */
      function sourceIn(manager: SessionManager, repo: string) {
        return manager.createPaneTrackedSession({
          agentType: "forky",
          paneId: "%3",
          cwd: repo,
          pid: 4242,
          nativeSessionId: "src-sid",
        });
      }

      it("creates the worktree and starts the fork inside it", async () => {
        const repo = fixtureRepo();
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const { argv, restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({
              fork: source.id,
              worktree: { name: "forked" },
              detach: true,
            }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            worktree: { name: string; path: string; created: boolean };
          };
          const path = join(repo, ".claude", "worktrees", "forked");
          expect(body.worktree).toMatchObject({
            name: "forked",
            path,
            created: true,
          });
          expect(existsSync(join(path, ".git"))).toBe(true);
          // The worktree is created BEFORE the pane, and the pane opens in
          // it: the destination is the point of the request, so a fork that
          // came up in the source's directory would be a silent no-op.
          expect(argv[0]).toContain(path);
          expect(argv[1]?.[4]).toBe("forky --resume src-sid --fork-session");
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      // A fork carries no prompt (`resolveForkSource` refuses one), so the
      // source's branch is the only thing left to name the destination after.
      it("derives the name from the source's branch", async () => {
        const repo = fixtureRepo();
        fixtureGit(repo, "checkout", "-q", "-b", "feat/fork-worktree");
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const { restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({ fork: source.id, worktree: {}, detach: true }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            worktree: { name: string; branch: string; base?: string };
          };
          // Slash-bearing branches slugify like any other name.
          expect(body.worktree.name).toBe("feat-fork-worktree-fork");
          expect(body.worktree.branch).toBe("feat-fork-worktree-fork");
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      // The name is derived in two places — here and in the dialog's preview
      // — and the cap is where they used to disagree: appending `-fork` past
      // the 40-character cap left `resolveWorktreeName` to trim it back off,
      // so a branch this long forked into a worktree called after ITSELF,
      // which numbering then made `<branch>-2`.
      it("keeps the -fork suffix on a long branch", async () => {
        const repo = fixtureRepo();
        const branch = "long-branch-name-that-runs-right-past-cap";
        expect(branch.length).toBeGreaterThan(39);
        fixtureGit(repo, "checkout", "-q", "-b", branch);
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const { restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({ fork: source.id, worktree: {}, detach: true }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            worktree: { name: string; branch: string };
          };
          expect(body.worktree.name.endsWith("-fork")).toBe(true);
          expect(body.worktree.name).not.toBe(branch);
          expect(body.worktree.branch).toBe(body.worktree.name);
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      // Derived, so a second fork of one branch gets its own checkout rather
      // than joining the first fork's.
      it("numbers a second fork of the same branch", async () => {
        const repo = fixtureRepo();
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const { restore } = withTmuxOnly();
        try {
          const first = await internals.handleRequest(
            spawnRequest({ fork: source.id, worktree: {}, detach: true }),
          );
          const second = await internals.handleRequest(
            spawnRequest({ fork: source.id, worktree: {}, detach: true }),
          );

          expect(first.status).toBe(200);
          expect(second.status).toBe(200);
          const names = await Promise.all(
            [first, second].map(async (res) => {
              const body = (await res.json()) as { worktree: { name: string } };
              return body.worktree.name;
            }),
          );
          expect(names[0]).toBe(`${defaultBranch(repo)}-fork`);
          expect(names[1]).toBe(`${defaultBranch(repo)}-fork-2`);
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      // An explicit name is a request for THAT worktree, on a fork as on any
      // other spawn: the second one opens the first, it does not number past.
      it("keeps create-or-open for an explicit name", async () => {
        const repo = fixtureRepo();
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const { restore } = withTmuxOnly();
        try {
          await internals.handleRequest(
            spawnRequest({
              fork: source.id,
              worktree: { name: "forked" },
              detach: true,
            }),
          );
          const again = await internals.handleRequest(
            spawnRequest({
              fork: source.id,
              worktree: { name: "forked" },
              detach: true,
            }),
          );

          expect(again.status).toBe(200);
          const body = (await again.json()) as {
            worktree: { name: string; created: boolean };
          };
          expect(body.worktree).toMatchObject({
            name: "forked",
            created: false,
          });
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      // The commits the conversation was written against live on the SOURCE's
      // branch. `resolveBase`'s default is the main checkout's, which for a
      // fork out of a linked worktree is a different history entirely.
      it("cuts the branch from the source checkout, not the main one", async () => {
        const repo = fixtureRepo();
        const linked = join(repo, "trees", "feature");
        fixtureGit(repo, "worktree", "add", "-q", "-b", "feature", linked);
        fixtureGit(linked, "commit", "-q", "--allow-empty", "-m", "only-here");
        const expected = gitOut(linked, ["rev-parse", "HEAD"]);
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, linked);
        const { restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({ fork: source.id, worktree: {}, detach: true }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            worktree: { name: string; path: string; base?: string };
          };
          expect(body.worktree.name).toBe("feature-fork");
          expect(body.worktree.base).toBe("feature");
          expect(gitOut(body.worktree.path, ["rev-parse", "HEAD"])).toBe(
            expected,
          );
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it("still lets an explicit base win", async () => {
        const repo = fixtureRepo();
        const trunk = defaultBranch(repo);
        const expected = gitOut(repo, ["rev-parse", "HEAD"]);
        fixtureGit(repo, "checkout", "-q", "-b", "feature");
        fixtureGit(repo, "commit", "-q", "--allow-empty", "-m", "later");
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const { restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({
              fork: source.id,
              worktree: { base: trunk },
              detach: true,
            }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            worktree: { path: string; base?: string };
          };
          expect(body.worktree.base).toBe(trunk);
          expect(gitOut(body.worktree.path, ["rev-parse", "HEAD"])).toBe(
            expected,
          );
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      // A fork leaves the original running, and the checkout a move empties
      // is the one it is running in.
      it("refuses to move the changes with it, creating nothing", async () => {
        const repo = fixtureRepo();
        writeFileSync(join(repo, "dirty.txt"), "work in progress\n");
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const { argv, restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({
              fork: source.id,
              worktree: { withChanges: true },
              detach: true,
            }),
          );

          expect(res.status).toBe(400);
          const { error } = (await res.json()) as { error: string };
          expect(error).toContain("withChanges");
          expect(error).toContain("still running");
          // Refused before the first side effect: no worktree, no pane, and
          // the work still where the user left it rather than in a stash.
          expect(existsSync(join(repo, ".claude", "worktrees"))).toBe(false);
          expect(argv).toHaveLength(0);
          expect(gitOut(repo, ["status", "--porcelain"])).toContain(
            "dirty.txt",
          );
          // Untouched means untouched: the move's very first step is a stash,
          // so an empty stack is what says the refusal landed before it and
          // not somewhere in the middle with a rollback behind it.
          expect(gitOut(repo, ["stash", "list"])).toBe("");
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      /**
       * The shipping template shape, `{path}`, all the way through a created
       * worktree. Everything above drives the `{id}` form, which is the one
       * whose destination is guarded; this is the one Claude actually uses,
       * and it resumes from anywhere, so nothing about the worktree is
       * allowed to disturb the transcript it resumes from.
       */
      it("starts a {path} fork inside the worktree it creates", async () => {
        const repo = fixtureRepo();
        fixtureGit(repo, "checkout", "-q", "-b", "feature");
        const { manager, internals } = serverForAgents([pathForkAgent]);
        const source = manager.createPaneTrackedSession({
          agentType: "pathy",
          paneId: "%3",
          cwd: repo,
          pid: 4242,
          nativeSessionId: "src-sid",
        });
        const transcript = transcriptFor(manager, source.id);
        const { argv, restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({ fork: source.id, worktree: {}, detach: true }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            worktree: { name: string; path: string; created: boolean };
          };
          expect(body.worktree).toMatchObject({
            name: "feature-fork",
            path: join(repo, ".claude", "worktrees", "feature-fork"),
            created: true,
          });
          expect(argv[0]).toContain(body.worktree.path);
          // The transcript is the source's, in the source's directory: a
          // `{path}` resume does not follow the pane into the new checkout.
          expect(argv[1]?.[4]).toBe(
            `pathy --resume '${transcript.path}' --fork-session`,
          );
        } finally {
          restore();
          transcript.cleanup();
          rmSync(repo, { recursive: true, force: true });
        }
      });

      /**
       * Whether the source's branch is taken as the base is gated on the two
       * checkouts sharing a repository, and only a `{path}` fork can put them
       * in different ones (the `{id}` form's destination guard refuses that
       * outright). Both directions, because the gate is invisible from
       * either one alone: same-repo passes with or without it, and cross-repo
       * without it asks THIS repo to cut from a ref that lives in another.
       */
      describe("basing on the source's branch", () => {
        /**
         * A `{path}` fork whose source sits on `source-side` in a LINKED
         * worktree, one commit ahead of the main checkout.
         *
         * Linked rather than the main checkout itself, so that "the source's
         * branch" and "`resolveBase`'s default" are different answers. With
         * the source on the main checkout the two coincide and the same-repo
         * assertion below would hold whether or not the base was taken.
         */
        function pathSource() {
          const repo = fixtureRepo();
          const linked = join(repo, "trees", "source-side");
          fixtureGit(
            repo,
            "worktree",
            "add",
            "-q",
            "-b",
            "source-side",
            linked,
          );
          fixtureGit(
            linked,
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "only-here",
          );
          const { manager, internals } = serverForAgents([pathForkAgent]);
          const source = manager.createPaneTrackedSession({
            agentType: "pathy",
            paneId: "%3",
            cwd: linked,
            pid: 4242,
            nativeSessionId: "src-sid",
          });
          return {
            repo,
            linked,
            internals,
            source,
            ...transcriptFor(manager, source.id),
          };
        }

        it("takes it when the destination is the same repository", async () => {
          const { repo, linked, internals, source, cleanup } = pathSource();
          const expected = gitOut(linked, ["rev-parse", "HEAD"]);
          // The commit that only exists on the source's branch is the whole
          // point: cutting from the main checkout would start the continued
          // conversation on history it was never written against.
          expect(gitOut(repo, ["rev-parse", "HEAD"])).not.toBe(expected);
          const { restore } = withTmuxOnly();
          try {
            const res = await internals.handleRequest(
              spawnRequest({ fork: source.id, worktree: {}, detach: true }),
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as {
              worktree: { name: string; path: string; base?: string };
            };
            expect(body.worktree.name).toBe("source-side-fork");
            expect(body.worktree.base).toBe("source-side");
            expect(gitOut(body.worktree.path, ["rev-parse", "HEAD"])).toBe(
              expected,
            );
          } finally {
            restore();
            cleanup();
            rmSync(repo, { recursive: true, force: true });
          }
        });

        // The name is a label and travels; the base is a ref and does not.
        it("leaves it alone when the destination is another repository", async () => {
          const { repo, internals, source, cleanup } = pathSource();
          const destination = fixtureRepo();
          const trunk = defaultBranch(destination);
          const expected = gitOut(destination, ["rev-parse", "HEAD"]);
          const { restore } = withTmuxOnly();
          try {
            const res = await internals.handleRequest(
              spawnRequest({
                fork: source.id,
                cwd: destination,
                worktree: {},
                detach: true,
              }),
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as {
              worktree: { name: string; path: string; base?: string };
            };
            expect(body.worktree.name).toBe("source-side-fork");
            expect(body.worktree.path).toBe(
              join(destination, ".claude", "worktrees", "source-side-fork"),
            );
            expect(body.worktree.base).toBe(trunk);
            expect(gitOut(body.worktree.path, ["rev-parse", "HEAD"])).toBe(
              expected,
            );
          } finally {
            restore();
            cleanup();
            rmSync(destination, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
          }
        });
      });

      /**
       * When the name cannot be derived at all. The generic refusal for a
       * nameless worktree advises passing a name "or giving a prompt to
       * derive it from", and half of that is impossible here: a fork with a
       * prompt is refused outright by `resolveForkSource`. Both ways of
       * getting here are covered, because they are different code paths —
       * a branch that slugifies to nothing, and a HEAD that reads as null.
       */
      describe("with no derivable name", () => {
        function expectNamingRefusal(error: string): void {
          expect(error).toContain("Cannot derive a worktree name");
          expect(error).toContain("--worktree");
          expect(error).toContain("Name row");
          // The advice a fork cannot take.
          expect(error).not.toContain("give a prompt");
        }

        it("refuses a source branch with nothing usable in it", async () => {
          const repo = fixtureRepo();
          fixtureGit(repo, "checkout", "-q", "-b", "日本語");
          const { manager, internals } = serverForAgents([forkAgent]);
          const source = sourceIn(manager, repo);
          const { argv, restore } = withTmuxOnly();
          try {
            const res = await internals.handleRequest(
              spawnRequest({ fork: source.id, worktree: {}, detach: true }),
            );

            expect(res.status).toBe(400);
            const { error } = (await res.json()) as { error: string };
            expectNamingRefusal(error);
            expect(existsSync(join(repo, ".claude", "worktrees"))).toBe(false);
            expect(argv).toHaveLength(0);
          } finally {
            restore();
            rmSync(repo, { recursive: true, force: true });
          }
        });

        /**
         * The other path to the same place: `readCheckoutHead` answering
         * null. It takes a `{path}` fork to reach, and that is not a
         * contrivance — an unborn source is the ONLY shape that gets here,
         * since a repo with no commits reports no root at all and an id-form
         * fork out of one is refused by the destination guard first.
         */
        it("refuses a source whose HEAD is unborn", async () => {
          const unborn = realpathSync(
            mkdtempSync(join(tmpdir(), "ccmux-unborn-")),
          );
          Bun.spawnSync(["git", "init", "-q", unborn], { env: fixtureEnv });
          const repo = fixtureRepo();
          const { manager, internals } = serverForAgents([pathForkAgent]);
          const source = manager.createPaneTrackedSession({
            agentType: "pathy",
            paneId: "%3",
            cwd: unborn,
            pid: 4242,
            nativeSessionId: "src-sid",
          });
          const transcript = transcriptFor(manager, source.id);
          const { argv, restore } = withTmuxOnly();
          try {
            const res = await internals.handleRequest(
              spawnRequest({
                fork: source.id,
                cwd: repo,
                worktree: {},
                detach: true,
              }),
            );

            expect(res.status).toBe(400);
            const { error } = (await res.json()) as { error: string };
            expectNamingRefusal(error);
            expect(existsSync(join(repo, ".claude", "worktrees"))).toBe(false);
            expect(argv).toHaveLength(0);
          } finally {
            restore();
            transcript.cleanup();
            rmSync(unborn, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
          }
        });

        // The refusal is about the DERIVED name only: a name the user typed
        // is one nothing has to be derived from.
        it("still accepts an explicit name for the same source", async () => {
          const repo = fixtureRepo();
          fixtureGit(repo, "checkout", "-q", "-b", "日本語");
          const { manager, internals } = serverForAgents([forkAgent]);
          const source = sourceIn(manager, repo);
          const { restore } = withTmuxOnly();
          try {
            const res = await internals.handleRequest(
              spawnRequest({
                fork: source.id,
                worktree: { name: "mine" },
                detach: true,
              }),
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as { worktree: { name: string } };
            expect(body.worktree.name).toBe("mine");
          } finally {
            restore();
            rmSync(repo, { recursive: true, force: true });
          }
        });
      });

      /**
       * The worktree is created BEFORE the pane, and a failure after that
       * point is not rolled back. "Spawn failed" reads as "nothing happened",
       * so the checkout and branch the user now owns have to be named in the
       * error itself — there is nowhere else for them to appear.
       */
      it("names the worktree it left behind when tmux fails", async () => {
        const repo = fixtureRepo();
        fixtureGit(repo, "checkout", "-q", "-b", "feature");
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const original = Bun.spawn;
        Bun.spawn = ((spawned: string[], opts?: unknown) => {
          if (spawned[0] !== "tmux") {
            return (original as (a: string[], b?: unknown) => unknown)(
              spawned,
              opts,
            );
          }
          return {
            exited: Promise.resolve(1),
            stdout: new Blob([""]).stream(),
            stderr: new Blob([
              "no server running on /tmp/tmux-0/default",
            ]).stream(),
          };
        }) as unknown as typeof Bun.spawn;
        try {
          const res = await internals.handleRequest(
            spawnRequest({ fork: source.id, worktree: {}, detach: true }),
          );

          expect(res.status).toBe(500);
          const { error } = (await res.json()) as { error: string };
          expect(error).toContain("tmux new-window failed");
          const path = join(repo, ".claude", "worktrees", "feature-fork");
          expect(error).toContain(path);
          expect(error).toContain("left in place");
          // A DERIVED name, so re-running numbers a sibling rather than
          // reusing this one. The advice has to say which flag pins it.
          expect(error).toContain("--worktree 'feature-fork'");
          // And it really is there, which is what makes the note worth
          // printing rather than a description of a directory that was
          // cleaned up on the way out.
          expect(existsSync(join(path, ".git"))).toBe(true);
        } finally {
          Bun.spawn = original;
          rmSync(repo, { recursive: true, force: true });
        }
      });

      // A detached source answers the literal "HEAD" to `--abbrev-ref`, which
      // the main checkout would resolve to its own head.
      it("uses the sha when the source is on a detached HEAD", async () => {
        const repo = fixtureRepo();
        const sha = gitOut(repo, ["rev-parse", "HEAD"]);
        fixtureGit(repo, "checkout", "-q", "--detach");
        const { manager, internals } = serverForAgents([forkAgent]);
        const source = sourceIn(manager, repo);
        const { restore } = withTmuxOnly();
        try {
          const res = await internals.handleRequest(
            spawnRequest({ fork: source.id, worktree: {}, detach: true }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            worktree: { name: string; base?: string };
          };
          expect(body.worktree.name).toBe(`${sha.slice(0, 12)}-fork`);
          expect(body.worktree.base).toBe(sha);
        } finally {
          restore();
          rmSync(repo, { recursive: true, force: true });
        }
      });
    });

    it("refuses a paneless background row daemon-side too", async () => {
      // The picker hides Fork for these, but that is a DISPLAY gate. Verified
      // by review that a hand-rolled request reached tmux and spawned a
      // window, so the refusal has to be here as well.
      const { manager, internals } = serverForAgents([forkAgent]);
      const bg = manager.createBackgroundSession({
        daemonShort: "bgabc123",
        pid: 4242,
        cwd,
        nativeSessionId: "bgnative-1",
        logPath: null,
        version: null,
        status: "idle",
        attentionType: null,
        pendingTool: null,
        lastPrompt: null,
        lastActivityAt: null,
      });
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: bg.id, detach: true }),
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toContain(
          "background agent",
        );
        expect(argv).toHaveLength(0);
      } finally {
        restore();
      }
    });

    it("accepts a pane-tracked id the strict pattern would have rejected", async () => {
      // `body.fork` is a LOOKUP KEY, not a value reaching a shell. A custom
      // agent named `my.agent` yields the id `my.agent_pane3`, which the old
      // NATIVE_SESSION_ID_PATTERN check refused — making every row of that
      // agent unforkable no matter how it was configured.
      const dotted: AgentDef = {
        ...forkAgent,
        name: "my.agent",
        executable: "my-agent",
      };
      const { manager, internals } = serverForAgents([dotted]);
      const source = manager.createPaneTrackedSession({
        agentType: "my.agent",
        paneId: "%3",
        cwd,
        pid: 4242,
        nativeSessionId: "src-sid",
      });
      expect(source.id).toContain(".");
      const { argv, restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({ fork: source.id, detach: true }),
        );
        expect(res.status).toBe(200);
        expect(argv[1]?.[4]).toBe("my-agent --resume src-sid --fork-session");
      } finally {
        restore();
      }
    });

    it("treats an explicitly null resume/prompt as absent", async () => {
      // A client that serializes omitted fields as null could otherwise never
      // fork; null means absent everywhere else in this route.
      const { manager, internals } = serverForAgents([forkAgent]);
      const source = trackedSession(manager, "forky");
      const { restore } = withTmuxRecorder();
      try {
        const res = await internals.handleRequest(
          spawnRequest({
            fork: source.id,
            resume: null,
            prompt: null,
            detach: true,
          }),
        );
        expect(res.status).toBe(200);
      } finally {
        restore();
      }
    });

    it("refuses an unknown session, a malformed id, and combinations", async () => {
      const { manager, internals } = serverForAgents([forkAgent]);
      const source = trackedSession(manager, "forky");
      const { argv, restore } = withTmuxRecorder();
      try {
        // The expected message is pinned per case. Asserting only the status
        // would let the security case pass while 400ing for some unrelated
        // reason, which is the one rejection here that must not drift.
        const cases: { body: Record<string, unknown>; expect: string }[] = [
          { body: { fork: "nope" }, expect: "Unknown session to fork" },
          // Anything the shell could act on is rejected before it is ever
          // interpolated into a command.
          // A shell-shaped id is no longer rejected on SHAPE: `fork` is a
          // lookup key, compared against ids ccmux itself minted and never
          // interpolated into a command, so it simply matches nothing. What
          // reaches the shell is the resolved `nativeSessionId`, which the
          // builder pattern-checks (see spawn-command.test.ts).
          {
            body: { fork: "src-sid; rm -rf /" },
            expect: "Unknown session to fork",
          },
          { body: { fork: 42 }, expect: "Invalid 'fork' field" },
          { body: { fork: "" }, expect: "Invalid 'fork' field" },
          { body: { fork: "a b" }, expect: "Invalid 'fork' field" },
          // Each of these builds its own command; honoring one and dropping
          // the other silently would be worse than refusing.
          {
            body: { fork: source.id, resume: "other-sid" },
            expect: "Cannot combine 'fork'",
          },
          {
            body: { fork: source.id, prompt: "hi" },
            expect: "Cannot combine 'fork'",
          },
        ];
        for (const { body, expect: expected } of cases) {
          const res = await internals.handleRequest(spawnRequest(body));
          expect(res.status).toBe(400);
          const { error } = (await res.json()) as { error: string };
          expect(`${JSON.stringify(body)} -> ${error}`).toContain(expected);
        }
        expect(argv).toHaveLength(0);
      } finally {
        restore();
      }
    });
  });
});

/**
 * Worktree prune endpoints.
 *
 * The property under test is the one the design leans on hardest and the one
 * prose alone cannot guarantee: `POST /worktrees/prune` takes PATHS, re-scans
 * in this process, and refuses anything the fresh scan does not currently
 * classify as removable. Without that, a stale client list is a delete
 * primitive.
 */
describe("worktree prune endpoints", () => {
  let root: string;

  function makePruneFixture(): { repo: string; worktree: string } {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ccmux-prune-endpoint-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    runFixtureGit(root, "init", "--initial-branch=main", repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    runFixtureGit(repo, "add", "README.md");
    runFixtureGit(repo, "commit", "-m", "init");
    const worktree = join(root, "wt");
    runFixtureGit(repo, "worktree", "add", "-b", "feat/done", worktree, "main");
    writeFileSync(join(worktree, "a.txt"), "a\n");
    runFixtureGit(worktree, "add", "-A");
    runFixtureGit(worktree, "commit", "-m", "work");
    runFixtureGit(repo, "merge", "--no-ff", "-m", "merge", "feat/done");
    return { repo, worktree };
  }

  /** A server whose session list puts one session inside `cwd`. */
  function serverFor(cwd: string) {
    const ctx = createServer();
    ctx.manager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd,
      pid: null,
    });
    return ctx;
  }

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function post(
    internals: ServerInternals,
    body: unknown,
  ): Promise<Response> {
    return internals.handleRequest(
      new Request("http://127.0.0.1:2269/worktrees/prune", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("lists a merged worktree as a candidate", async () => {
    const { repo, worktree } = makePruneFixture();
    const { internals } = serverFor(repo);

    const res = await internals.handleRequest(
      new Request("http://127.0.0.1:2269/worktrees/prune-candidates"),
    );
    const body = (await res.json()) as { candidates: Array<{ path: string }> };

    expect(res.status).toBe(200);
    expect(body.candidates.map((c) => c.path)).toContain(
      realpathSync(worktree),
    );
  });

  // The core guarantee: a path the fresh scan does not classify is refused,
  // not removed. This covers a stale client list, a replayed request, and a
  // hand-written POST naming something outside the candidate set.
  it("rejects a path the fresh scan does not classify as removable", async () => {
    const { repo } = makePruneFixture();
    const { internals } = serverFor(repo);
    const outsider = join(root, "not-a-candidate");
    mkdirSync(outsider, { recursive: true });

    const res = await post(internals, { paths: [outsider] });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(409);
    expect(body.error).toContain("Not currently removable");
    // And it is still there.
    expect(existsSync(outsider)).toBe(true);
  });

  it("rejects the main checkout even though a session lives there", async () => {
    const { repo } = makePruneFixture();
    const { internals } = serverFor(repo);

    const res = await post(internals, { paths: [repo] });

    expect(res.status).toBe(409);
    expect(existsSync(repo)).toBe(true);
  });

  it("refuses an empty selection", async () => {
    const { repo } = makePruneFixture();
    const { internals } = serverFor(repo);

    const res = await post(internals, { paths: [] });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("No worktrees selected");
  });

  it("refuses a dirty worktree that carries no opt-in, and keeps it on disk", async () => {
    const { repo, worktree } = makePruneFixture();
    writeFileSync(join(worktree, "uncommitted.txt"), "work\n");
    const { internals } = serverFor(repo);

    const res = await post(internals, { paths: [worktree] });
    const body = (await res.json()) as {
      outcomes: Array<{ removed: boolean; error?: string }>;
    };

    expect(res.status).toBe(200);
    expect(body.outcomes[0].removed).toBe(false);
    expect(body.outcomes[0].error).toContain("not opted in");
    expect(existsSync(worktree)).toBe(true);
  });

  it("removes a dirty worktree once its path carries the opt-in", async () => {
    const { repo, worktree } = makePruneFixture();
    writeFileSync(join(worktree, "uncommitted.txt"), "work\n");
    const { internals } = serverFor(repo);

    const res = await post(internals, {
      paths: [worktree],
      allowDirty: [worktree],
    });
    const body = (await res.json()) as {
      outcomes: Array<{ removed: boolean }>;
    };

    expect(body.outcomes[0].removed).toBe(true);
    expect(existsSync(worktree)).toBe(false);
  });

  it("changes nothing under dryRun", async () => {
    const { repo, worktree } = makePruneFixture();
    const { internals } = serverFor(repo);

    const res = await post(internals, { paths: [worktree], dryRun: true });
    const body = (await res.json()) as { dryRun: boolean };

    expect(body.dryRun).toBe(true);
    expect(existsSync(worktree)).toBe(true);
  });

  // Duplicate spellings of one worktree used to produce several outcomes for
  // the same directory, and branch deletion always resolved the first, so a
  // successful run rendered as a wall of errors.
  it("collapses duplicate and aliased spellings of one path", async () => {
    const { repo, worktree } = makePruneFixture();
    const { internals } = serverFor(repo);

    const res = await post(internals, {
      paths: [worktree, worktree, `${worktree}/`],
    });
    const body = (await res.json()) as { outcomes: unknown[] };

    expect(body.outcomes).toHaveLength(1);
  });

  /**
   * O7: `MAX_PRUNE_PATHS` (500 in server.ts) used to silently `break` once
   * the de-duplicated set hit the cap, dropping the remainder with no error
   * and no field saying anything was dropped. It now rejects the request
   * outright, for both `paths` and `allowDirty` (a silently dropped opt-in
   * fails closed but is exactly as silent as a dropped path).
   */
  it("rejects a path list over the cap and names the cap", async () => {
    const { repo } = makePruneFixture();
    const { internals } = serverFor(repo);
    const over = Array.from({ length: 501 }, (_, i) => join(root, `p${i}`));

    const res = await post(internals, { paths: over });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("501");
    expect(body.error).toContain("500");
  });

  it("rejects an over-cap allowDirty list too, not just paths", async () => {
    const { repo, worktree } = makePruneFixture();
    const { internals } = serverFor(repo);
    const over = Array.from({ length: 501 }, (_, i) => join(root, `p${i}`));

    const res = await post(internals, {
      paths: [worktree],
      allowDirty: over,
    });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toContain("501");
    expect(existsSync(worktree)).toBe(true);
  });

  it("accepts a path list exactly at the cap", async () => {
    const { repo } = makePruneFixture();
    const { internals } = serverFor(repo);
    const atCap = Array.from({ length: 500 }, (_, i) => join(root, `p${i}`));

    const res = await post(internals, { paths: atCap });
    const body = (await res.json()) as { error?: string };

    // Not the cap rejection; it proceeds to the normal "not currently
    // removable" refusal for these made-up paths instead.
    expect(res.status).not.toBe(400);
    expect(body.error ?? "").not.toContain("the limit is");
  });
});

/**
 * `POST /spawn` with a worktree destination.
 *
 * tmux is stubbed but git is NOT: the whole point of the endpoint half is
 * that a real worktree exists at a real path before the pane is created, and
 * a stubbed git would assert nothing about that. Non-tmux commands therefore
 * pass through to the real `Bun.spawn`.
 */
describe("POST /spawn with a worktree", () => {
  let root: string;

  /**
   * `failWith` makes every tmux call exit non-zero with that stderr, which is
   * the only failure the handler can still hit AFTER the worktree exists: the
   * agent, the command and the placement are all resolved before it now, so
   * nothing cheaper than tmux reaches the note.
   */
  function withTmuxOnlyStub(options: { failWith?: string } = {}) {
    const original = Bun.spawn;
    const argv: string[][] = [];
    Bun.spawn = ((spawned: string[], opts?: unknown) => {
      if (spawned[0] !== "tmux") {
        return (original as (a: string[], b?: unknown) => unknown)(
          spawned,
          opts,
        );
      }
      argv.push(spawned);
      return {
        exited: Promise.resolve(options.failWith === undefined ? 0 : 1),
        stdout: new Blob(["%99\n"]).stream(),
        stderr: new Blob([options.failWith ?? ""]).stream(),
      };
    }) as unknown as typeof Bun.spawn;
    return { argv, restore: () => (Bun.spawn = original) };
  }

  /** Local branch names in a fixture repo, for leak assertions. */
  function localBranches(repo: string): string {
    const proc = Bun.spawnSync(
      ["git", "-C", repo, "branch", "--list", "--format=%(refname:short)"],
      { env: GIT_FIXTURE_ENV, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      throw new Error(`git branch --list failed: ${proc.stderr.toString()}`);
    }
    return proc.stdout.toString();
  }

  function makeRepo(): string {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ccmux-spawn-wt-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    runFixtureGit(root, "init", "--initial-branch=main", repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    runFixtureGit(repo, "add", "README.md");
    runFixtureGit(repo, "commit", "-m", "init");
    return repo;
  }

  async function spawnInto(
    internals: ServerInternals,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return internals.handleRequest(
      new Request("http://127.0.0.1:2269/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("creates the worktree and spawns the pane in it", async () => {
    const repo = makeRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "fix-thing" },
      });
      const body = (await res.json()) as {
        worktree?: {
          path: string;
          name: string;
          branch: string;
          created: boolean;
        };
      };

      expect(res.status).toBe(200);
      expect(body.worktree?.name).toBe("fix-thing");
      expect(body.worktree?.created).toBe(true);
      expect(existsSync(body.worktree!.path)).toBe(true);
      // The contract that matters: the pane was opened in the worktree, not
      // in the cwd the request named.
      const paneArgv = tmux.argv.find((a) => a.includes("-c"));
      expect(paneArgv?.[paneArgv.indexOf("-c") + 1]).toBe(body.worktree!.path);
    } finally {
      tmux.restore();
    }
  });

  it("derives the name from the prompt when none is given", async () => {
    const repo = makeRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        prompt: "fix sidebar flicker on resize",
        worktree: {},
      });
      const body = (await res.json()) as { worktree?: { name: string } };

      expect(body.worktree?.name).toBe("fix-sidebar-flicker");
    } finally {
      tmux.restore();
    }
  });

  it("rejects a worktree request with neither a name nor a prompt", async () => {
    const repo = makeRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: {},
      });
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      expect(body.error).toContain("needs a name");
      // And no pane was opened for a request that could not be satisfied.
      expect(tmux.argv).toEqual([]);
    } finally {
      tmux.restore();
    }
  });

  it("rejects a worktree request outside a git repository", async () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ccmux-spawn-nogit-"));
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: plain,
        worktree: { name: "nope" },
      });
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      expect(body.error).toContain("Not inside a git repository");
    } finally {
      tmux.restore();
    }
  });

  /**
   * The worktree is deliberately NOT rolled back when a later step fails, so
   * the error has to say it is there. Otherwise the user is left wondering
   * whether to clean it up by hand.
   */
  it("says the worktree survives when a later step fails", async () => {
    const repo = makeRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub({ failWith: "no space left for a window" });
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "left-behind" },
      });
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(500);
      expect(body.error).toContain("no space left for a window");
      expect(body.error).toContain("left-behind");
      expect(body.error).toContain("will reuse it");
      // And it really is on disk, as the message claims.
      expect(
        existsSync(join(repo, ".claude", "worktrees", "left-behind")),
      ).toBe(true);
    } finally {
      tmux.restore();
    }
  });

  /**
   * A derived name is not stable: `createWorktree` suffixes a taken one, so
   * telling the user a re-run reuses this worktree would be a lie that leaves
   * them with `<slug>-2`. The note has to name the flag that actually reuses it.
   */
  it("tells a derived name to pass the flag rather than re-run", async () => {
    const repo = makeRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub({ failWith: "tmux is unhappy" });
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        prompt: "fix sidebar flicker on resize",
        worktree: {},
      });
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(500);
      expect(body.error).toContain("numbered sibling");
      expect(body.error).toContain("--worktree 'fix-sidebar-flicker'");
      expect(body.error).not.toContain("will reuse it");
    } finally {
      tmux.restore();
    }
  });

  it("does not mention a worktree when one was merely opened", async () => {
    const repo = makeRepo();
    const { internals } = createServer();
    const ok = withTmuxOnlyStub();
    try {
      await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "reused" },
      });
    } finally {
      ok.restore();
    }
    const tmux = withTmuxOnlyStub({ failWith: "tmux is unhappy" });
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "reused" },
      });
      const body = (await res.json()) as { error: string };

      expect(body.error).toContain("tmux is unhappy");
      expect(body.error).not.toContain("was created");
    } finally {
      tmux.restore();
    }
  });

  /**
   * The validation the request fails on has to run BEFORE the worktree is
   * created, not after: a typo'd agent name that still costs the user a
   * checkout and a branch to clean up is the whole reason the ordering is
   * load-bearing rather than incidental.
   */
  it("creates nothing when the agent name is unknown", async () => {
    const repo = makeRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "no-such-agent",
        cwd: repo,
        worktree: { name: "never-made" },
      });
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      expect(body.error).toBe("Unknown agent: no-such-agent");
      expect(existsSync(join(repo, ".claude", "worktrees", "never-made"))).toBe(
        false,
      );
      expect(localBranches(repo)).not.toContain("never-made");
      expect(tmux.argv).toEqual([]);
    } finally {
      tmux.restore();
    }
  });

  it("spawns into the ordinary cwd when no worktree is requested", async () => {
    const repo = makeRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, { agent: "claude", cwd: repo });
      const body = (await res.json()) as { worktree?: unknown };

      expect(res.status).toBe(200);
      expect(body.worktree).toBeUndefined();
      const paneArgv = tmux.argv.find((a) => a.includes("-c"));
      expect(paneArgv?.[paneArgv.indexOf("-c") + 1]).toBe(repo);
    } finally {
      tmux.restore();
    }
  });
});

/**
 * `POST /spawn` with `worktree.withChanges` — the endpoint half of issue #71.
 *
 * Real git again, and for a sharper reason than the plain worktree tests: the
 * contract is about where the user's uncommitted work ENDS UP, and only git
 * can answer that. tmux stays stubbed so no pane is ever opened.
 */
describe("POST /spawn moving changes into a worktree", () => {
  let root: string;

  function withTmuxOnlyStub() {
    const original = Bun.spawn;
    const argv: string[][] = [];
    Bun.spawn = ((spawned: string[], opts?: unknown) => {
      if (spawned[0] !== "tmux") {
        return (original as (a: string[], b?: unknown) => unknown)(
          spawned,
          opts,
        );
      }
      argv.push(spawned);
      return {
        exited: Promise.resolve(0),
        stdout: new Blob(["%99\n"]).stream(),
        stderr: new Blob([""]).stream(),
      };
    }) as unknown as typeof Bun.spawn;
    return { argv, restore: () => (Bun.spawn = original) };
  }

  /**
   * A checkout with one commit, a tracked edit and an untracked file.
   *
   * The identity is written to the repo's own config rather than passed as
   * env: the daemon spawns git itself, and `git stash` writes a commit, so a
   * machine with no ambient identity (CI) would fail inside the code under
   * test rather than in the fixture.
   */
  function makeDirtyRepo(): string {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ccmux-spawn-move-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    runFixtureGit(root, "init", "--initial-branch=main", repo);
    runFixtureGit(repo, "config", "user.email", "test@ccmux.invalid");
    runFixtureGit(repo, "config", "user.name", "ccmux test");
    // git's DEFAULT excludes path (`~/.config/git/ignore`) is read even with
    // GIT_CONFIG_GLOBAL neutered, because it is not a config value. These
    // fixtures turn on whether a path is ignored, so without this they would
    // pass or fail depending on whose machine ran them.
    runFixtureGit(repo, "config", "core.excludesFile", "/dev/null");
    writeFileSync(join(repo, "tracked.txt"), "original\n");
    runFixtureGit(repo, "add", "tracked.txt");
    runFixtureGit(repo, "commit", "-m", "init");
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "brand new\n");
    return repo;
  }

  /**
   * The source's uncommitted paths, minus `.claude/` — the directory the
   * worktree itself is created in, which git reports as untracked in the
   * source. That is a property of where worktrees live (issue #69), not of
   * the move, and it would otherwise mask the paths these tests are about.
   */
  function dirtyPaths(repo: string): string[] {
    const proc = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain"], {
      env: GIT_FIXTURE_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.endsWith(".claude/"));
  }

  function stashList(repo: string): string {
    const proc = Bun.spawnSync(["git", "-C", repo, "stash", "list"], {
      env: GIT_FIXTURE_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.stdout.toString().trim();
  }

  async function spawnInto(
    internals: ServerInternals,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return internals.handleRequest(
      new Request("http://127.0.0.1:2269/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("relocates the work and starts the agent in the worktree", async () => {
    const repo = makeDirtyRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "moved", withChanges: true },
      });
      const body = (await res.json()) as {
        worktree?: { path: string; name: string };
        move?: {
          moved: number;
          source: string;
          untracked: { mode: string; files: string[] };
        };
      };

      expect(res.status).toBe(200);
      const path = body.worktree!.path;
      // The whole point: the changes are there and the source has none.
      expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("edited\n");
      expect(existsSync(join(path, "new.txt"))).toBe(true);
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe(
        "original\n",
      );
      expect(existsSync(join(repo, "new.txt"))).toBe(false);
      expect(dirtyPaths(repo)).toEqual([]);
      // And the backup was dropped, since the work is safely in the worktree.
      expect(stashList(repo)).toBe("");
      // `source` rides along because the CLI cannot derive it: on a `--fork`
      // spawn it is the forked session's checkout, resolved only here.
      expect(body.move).toEqual({
        moved: 1,
        source: repo,
        untracked: { mode: "move", files: ["new.txt"] },
      });
      // One worktree, and the agent started in it rather than in the source.
      const paneArgv = tmux.argv.find((a) => a.includes("-c"));
      expect(paneArgv?.[paneArgv.indexOf("-c") + 1]).toBe(path);
    } finally {
      tmux.restore();
    }
  });

  /**
   * The live-e2e finding. In a repo where ccmux made the FIRST worktree,
   * `.claude/` is untracked, so every later move saw the sibling checkouts as
   * work: `copy` physically duplicated them (a full recursive copy, `.git`
   * link file and all) and both modes counted them.
   *
   * The ordering is the subtle half. The move reads the source's status
   * BEFORE it creates anything, so an exclude written during creation would
   * arrive too late to affect this run's copy list.
   */
  it("does not treat a sibling worktree as work to move", async () => {
    const repo = makeDirtyRepo();
    // A worktree from an earlier spawn, added with raw git so the repo has
    // no exclude entry — exactly the state the live run found.
    const sibling = join(repo, ".claude", "worktrees", "earlier");
    runFixtureGit(repo, "worktree", "add", "-b", "earlier", sibling);
    writeFileSync(join(sibling, "SIBLING.txt"), "another agent's work\n");

    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "second", withChanges: true, untracked: "copy" },
      });
      const body = (await res.json()) as {
        worktree?: { path: string };
        move?: { untracked: { files: string[] } };
      };

      expect(res.status).toBe(200);
      const dest = body.worktree!.path;
      // The genuine untracked file came across...
      expect(existsSync(join(dest, "new.txt"))).toBe(true);
      // ...and the sibling checkout did not, in any form.
      expect(existsSync(join(dest, ".claude", "worktrees", "earlier"))).toBe(
        false,
      );
      expect(existsSync(join(dest, ".claude", "worktrees"))).toBe(false);
      // And the count is only what actually moved.
      expect(body.move!.untracked.files).toEqual(["new.txt"]);
      // The sibling is untouched where it lives.
      expect(readFileSync(join(sibling, "SIBLING.txt"), "utf8")).toBe(
        "another agent's work\n",
      );
    } finally {
      tmux.restore();
    }
  });

  it("leaves the source's untracked files alone on copy", async () => {
    const repo = makeDirtyRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "copied", withChanges: true, untracked: "copy" },
      });
      const body = (await res.json()) as { worktree?: { path: string } };

      expect(res.status).toBe(200);
      expect(existsSync(join(body.worktree!.path, "new.txt"))).toBe(true);
      // The tracked edit moved; the untracked file exists in both places.
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe(
        "original\n",
      );
      expect(dirtyPaths(repo)).toEqual(["?? new.txt"]);
    } finally {
      tmux.restore();
    }
  });

  it("refuses a checkout with nothing to move, and opens no pane", async () => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "ccmux-spawn-clean-"));
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    runFixtureGit(root, "init", "--initial-branch=main", repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    runFixtureGit(repo, "add", "README.md");
    runFixtureGit(repo, "commit", "-m", "init");
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "empty-move", withChanges: true },
      });
      const body = (await res.json()) as { error: string; reason?: string };

      expect(res.status).toBe(400);
      expect(body.reason).toBe("nothing-to-move");
      expect(tmux.argv).toEqual([]);
      // Refused before anything was created, so there is nothing to clean up.
      expect(existsSync(join(repo, ".claude", "worktrees", "empty-move"))).toBe(
        false,
      );
    } finally {
      tmux.restore();
    }
  });

  /**
   * The failure the module's whole ordering exists for: the changes are
   * already stashed when creation refuses. No pane may be opened, and the
   * response has to name the stash entry, because that sha is the handle for
   * getting the work back by hand.
   */
  it("opens no pane and names the stash when the move fails", async () => {
    const repo = makeDirtyRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: {
          name: "doomed",
          base: "no-such-ref",
          withChanges: true,
        },
      });
      const body = (await res.json()) as {
        error: string;
        reason?: string;
        stashSha?: string;
        sourceRestored?: boolean;
      };

      expect(res.status).toBe(400);
      expect(body.reason).toBe("create-failed");
      expect(tmux.argv).toEqual([]);
      // The recovery handle, and it names a real entry.
      expect(body.stashSha).toMatch(/^[0-9a-f]{40}$/);
      expect(stashList(repo)).toContain("ccmux move-changes");
      // The changes are back where they started, so nothing was lost.
      expect(body.sourceRestored).toBe(true);
      expect(readFileSync(join(repo, "tracked.txt"), "utf8")).toBe("edited\n");
      expect(existsSync(join(repo, "new.txt"))).toBe(true);
    } finally {
      tmux.restore();
    }
  });

  /**
   * The move is the handler's first side effect, like the plain worktree
   * creation it replaces. A request that cannot be satisfied must not stash
   * the user's work on its way to a 400.
   */
  it("touches nothing when the request is refused first", async () => {
    const repo = makeDirtyRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "no-such-agent",
        cwd: repo,
        worktree: { name: "never-made", withChanges: true },
      });

      expect(res.status).toBe(400);
      expect(dirtyPaths(repo)).toContain("M tracked.txt");
      expect(stashList(repo)).toBe("");
      expect(tmux.argv).toEqual([]);
    } finally {
      tmux.restore();
    }
  });

  /**
   * The move is committed by the time tmux is asked for a pane, so a failure
   * here leaves the source clean and the work somewhere the caller never
   * named. A bare 500 would tell them the spawn failed and nothing else.
   */
  it("says where the work went when the pane fails after the move", async () => {
    const repo = makeDirtyRepo();
    const { internals } = createServer();
    const original = Bun.spawn;
    Bun.spawn = ((spawned: string[], opts?: unknown) => {
      if (spawned[0] !== "tmux") {
        return (original as (a: string[], b?: unknown) => unknown)(
          spawned,
          opts,
        );
      }
      return {
        exited: Promise.resolve(1),
        stdout: new Blob([""]).stream(),
        stderr: new Blob(["no server running\n"]).stream(),
      };
    }) as unknown as typeof Bun.spawn;
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "moved", withChanges: true },
      });
      const body = (await res.json()) as {
        error: string;
        move?: { moved: number; source: string };
      };

      expect(res.status).toBe(500);
      // The move really did happen, so the failure has to account for it.
      expect(dirtyPaths(repo)).toEqual([]);
      expect(body.move?.moved).toBe(1);
      expect(body.move?.source).toBe(repo);
      expect(body.error).toContain("already moved");
      expect(body.error).toContain(join(".claude", "worktrees", "moved"));
    } finally {
      Bun.spawn = original;
    }
  });

  /**
   * A name that is already a worktree is refused BEFORE the stash, because
   * the move's rollback force-removes the worktree and there is no way to
   * tell git to take back only the part this run added. Refused up front,
   * nothing has been touched at all.
   */
  it("refuses a name that already exists, before touching anything", async () => {
    const repo = makeDirtyRepo();
    runFixtureGit(
      repo,
      "worktree",
      "add",
      "-b",
      "taken",
      join(repo, ".claude", "worktrees", "taken"),
    );
    // Somebody's uncommitted work, sitting in the worktree being asked for.
    const precious = join(
      repo,
      ".claude",
      "worktrees",
      "taken",
      "PRECIOUS.txt",
    );
    writeFileSync(precious, "hours of work\n");

    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "taken", withChanges: true },
      });
      const body = (await res.json()) as { error: string; reason?: string };

      expect(res.status).toBe(400);
      expect(body.error).toContain("already exists");
      expect(body.error).toContain("fresh worktree");
      // Nothing happened: no pane, no stash, source still dirty, and the
      // existing worktree still has its work.
      expect(tmux.argv).toEqual([]);
      expect(stashList(repo)).toBe("");
      expect(dirtyPaths(repo)).toContain("M tracked.txt");
      expect(readFileSync(precious, "utf8")).toBe("hours of work\n");
    } finally {
      tmux.restore();
    }
  });

  it("rejects an untracked mode with no move to apply it to", async () => {
    const repo = makeDirtyRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "confused", untracked: "leave" },
      });
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      expect(body.error).toContain("requires 'worktree.withChanges'");
      expect(tmux.argv).toEqual([]);
    } finally {
      tmux.restore();
    }
  });

  it("rejects an untracked mode it does not know", async () => {
    const repo = makeDirtyRepo();
    const { internals } = createServer();
    const tmux = withTmuxOnlyStub();
    try {
      const res = await spawnInto(internals, {
        agent: "claude",
        cwd: repo,
        worktree: { name: "confused", withChanges: true, untracked: "delete" },
      });
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      expect(body.error).toContain("move, copy, leave");
      expect(dirtyPaths(repo)).toContain("M tracked.txt");
      expect(tmux.argv).toEqual([]);
    } finally {
      tmux.restore();
    }
  });
});

/**
 * `GET /sessions/:id/dirty` — the lazy gate behind the picker's "Move changes
 * to worktree" item. Driven against a REAL fixture repo, because the property
 * that matters is that it agrees with what the move itself would do.
 */
describe("GET /sessions/:id/dirty", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-dirty-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Fixture setup goes through `runFixtureGit` like every other real-git
   * fixture in this file, so a machine with no ambient git identity (CI)
   * fails at the setup step naming git's own error rather than several
   * assertions later.
   */
  function makeRepo(name: string): string {
    const repo = join(root, name);
    mkdirSync(repo, { recursive: true });
    runFixtureGit(root, "init", "--initial-branch=main", repo);
    // See makeDirtyRepo: git's default excludes path is read regardless of
    // GIT_CONFIG_GLOBAL, and these fixtures turn on what git ignores.
    runFixtureGit(repo, "config", "core.excludesFile", "/dev/null");
    writeFileSync(join(repo, "tracked.txt"), "original\n");
    runFixtureGit(repo, "add", "tracked.txt");
    runFixtureGit(repo, "commit", "-m", "init");
    return repo;
  }

  /** A session whose checkout is `cwd`. */
  function sessionIn(manager: SessionManager, cwd: string): string {
    const session = manager.createPaneTrackedSession({
      agentType: "claude",
      paneId: "%1",
      cwd,
      pid: 999,
    });
    return session.id;
  }

  async function dirtyRequest(
    internals: ServerInternals,
    id: string,
    query = "",
  ): Promise<Response> {
    return internals.handleRequest(
      new Request(`http://localhost/sessions/${id}/dirty${query}`),
    );
  }

  async function dirtyOf(
    internals: ServerInternals,
    id: string,
    query = "",
  ): Promise<Record<string, unknown>> {
    const res = await dirtyRequest(internals, id, query);
    return (await res.json()) as Record<string, unknown>;
  }

  it("reports a clean checkout as not dirty", async () => {
    const { manager, internals } = createServer();
    const repo = makeRepo("clean");
    const id = sessionIn(manager, repo);

    expect(await dirtyOf(internals, id)).toEqual({
      repo: true,
      dirty: false,
      modified: 0,
      untracked: 0,
    });
  });

  it("counts tracked edits and untracked files separately", async () => {
    const { manager, internals } = createServer();
    const repo = makeRepo("messy");
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    const id = sessionIn(manager, repo);

    expect(await dirtyOf(internals, id)).toEqual({
      repo: true,
      dirty: true,
      modified: 1,
      untracked: 1,
    });
  });

  it("counts untracked-only work as dirty", async () => {
    // The move can relocate it, so the menu has to offer the action.
    const { manager, internals } = createServer();
    const repo = makeRepo("untracked-only");
    writeFileSync(join(repo, "new.txt"), "new\n");
    const id = sessionIn(manager, repo);

    const body = await dirtyOf(internals, id);
    expect(body.dirty).toBe(true);
    expect(body.modified).toBe(0);
    expect(body.untracked).toBe(1);
  });

  /**
   * The desirable side effect of the exclude entry: a repo that HOSTS ccmux
   * worktrees is not permanently "dirty" because of them, so the menu stops
   * offering a move for a checkout whose only "work" is other agents'
   * checkouts.
   */
  it("does not count the worktrees ccmux created as work", async () => {
    const { manager, internals } = createServer();
    const repo = makeRepo("hosts-worktrees");
    // Through the real engine, which is what writes the exclude entry.
    const created = await createWorktree(repo, { name: "sibling" });
    expect(created.ok).toBe(true);
    const id = sessionIn(manager, repo);

    expect(await dirtyOf(internals, id)).toEqual({
      repo: true,
      dirty: false,
      modified: 0,
      untracked: 0,
    });
  });

  it("counts the files inside an untracked directory, not the directory", async () => {
    // git collapses a wholly untracked directory into one `?? deep/` record,
    // so the menu would offer to move "1 untracked file" for a tree of them.
    const { manager, internals } = createServer();
    const repo = makeRepo("nested-untracked");
    mkdirSync(join(repo, "deep", "nested"), { recursive: true });
    writeFileSync(join(repo, "deep", "a.txt"), "1\n");
    writeFileSync(join(repo, "deep", "nested", "b.txt"), "2\n");
    const id = sessionIn(manager, repo);

    const body = await dirtyOf(internals, id);
    expect(body.untracked).toBe(2);
  });

  it("answers 'not a repo' plainly rather than erroring", async () => {
    // An ordinary answer to what the menu is asking, not a failure. Note this
    // deliberately differs from readDirtyState, which calls an unreadable
    // checkout DIRTY because its caller (prune) is destructive.
    const { manager, internals } = createServer();
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    const id = sessionIn(manager, plain);

    expect(await dirtyOf(internals, id)).toEqual({
      repo: false,
      dirty: false,
      modified: 0,
      untracked: 0,
    });
  });

  it("404s an unknown session", async () => {
    const { internals } = createServer();
    const res = await internals.handleRequest(
      new Request("http://localhost/sessions/nope/dirty"),
    );
    expect(res.status).toBe(404);
  });

  /**
   * The menu has to ask about the directory the move will actually run in,
   * which is the pane's current path when the pane has `cd`ed somewhere, not
   * the directory the session started in.
   */
  it("answers about an explicit cwd rather than the session's", async () => {
    const { manager, internals } = createServer();
    const started = makeRepo("started-here");
    const elsewhere = makeRepo("moved-here");
    writeFileSync(join(elsewhere, "tracked.txt"), "edited\n");
    const id = sessionIn(manager, started);

    // The session's own checkout is clean...
    expect(await dirtyOf(internals, id)).toMatchObject({ dirty: false });
    // ...while the one the caller names is not.
    expect(
      await dirtyOf(internals, id, `?cwd=${encodeURIComponent(elsewhere)}`),
    ).toEqual({ repo: true, dirty: true, modified: 1, untracked: 0 });
  });

  it("rejects a cwd that is not an absolute path", async () => {
    const { manager, internals } = createServer();
    const repo = makeRepo("relative");
    const id = sessionIn(manager, repo);

    const res = await dirtyRequest(internals, id, "?cwd=../elsewhere");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "absolute",
    );
  });

  it("ignores gitignored files, which the move never relocates", async () => {
    // The engine's own file setup covers ignored content, so counting it here
    // would offer a move for a checkout that has nothing to move.
    const { manager, internals } = createServer();
    const repo = makeRepo("ignored");
    writeFileSync(join(repo, ".gitignore"), "secret.env\n");
    runFixtureGit(repo, "add", ".gitignore");
    runFixtureGit(repo, "commit", "-m", "ignore");
    writeFileSync(join(repo, "secret.env"), "TOKEN=1\n");
    const id = sessionIn(manager, repo);

    const body = await dirtyOf(internals, id);
    expect(body.dirty).toBe(false);
    expect(body.untracked).toBe(0);
  });
});
