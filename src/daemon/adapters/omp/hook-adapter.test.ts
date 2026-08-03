import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempRoot = join(
  tmpdir(),
  `ccmux-omp-adapter-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const ompExtensionDir = join(tempRoot, "omp", "agent", "extensions");
const ompExtensionFile = join(ompExtensionDir, "ccmux.js");
const markersDir = join(tempRoot, "markers");

const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  OMP_AGENT_DIR: join(tempRoot, "omp", "agent"),
  OMP_EXTENSION_DIR: ompExtensionDir,
  OMP_EXTENSION_FILE: ompExtensionFile,
  MARKERS_DIR: markersDir,
}));

import pkg from "../../../../package.json" with { type: "json" };
import { OmpHookAdapter } from "./hook-adapter";
import type { HookManagerContext } from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import { loadMarkerIntoCache, refreshMarkerCache } from "../../session-markers";
import type { Session, TmuxPane } from "../../../types/session";

const CCMUX_VERSION = pkg.version;

function makeMarker(overrides: Partial<SessionPidMarker>): SessionPidMarker {
  return {
    agent_type: "omp",
    pid: 9000,
    session_id: "019eee88-33a2-794a-b964-0e0079ea3245",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makePane(paneId: string, panePid: number): TmuxPane {
  return {
    paneId,
    panePid,
    sessionName: "ccmux",
    windowIndex: 0,
    paneIndex: 0,
    target: `ccmux:0.${paneId.replace("%", "")}`,
    tty: null,
    startTime: null,
    windowActivity: null,
    paneTitle: "omp",
    currentCommand: "omp",
    currentPath: "/tmp",
  };
}

interface FakeSession {
  id: string;
  agentType: string;
  trackingMode: "pane" | "native";
  tmuxPane: string | null;
  nativeSessionId?: string;
  state: Partial<Session>;
}

function makeCtx(
  sessions: FakeSession[],
  panes: TmuxPane[],
): HookManagerContext {
  return {
    sessionManager: {
      getSessions: () => sessions as unknown as Session[],
      updateSession: (id: string, patch: Partial<Session>) => {
        const s = sessions.find((x) => x.id === id);
        if (!s) return false;
        Object.assign(s.state, patch);
        return true;
      },
      setNativeSessionId: (id: string, nativeSessionId: string) => {
        const s = sessions.find((x) => x.id === id);
        if (!s) return false;
        s.nativeSessionId = nativeSessionId;
        return true;
      },
      setLogPath: (id: string, logPath: string | null) => {
        const s = sessions.find((x) => x.id === id);
        if (!s) return false;
        s.state.logPath = logPath;
        return true;
      },
    } as unknown as HookManagerContext["sessionManager"],
    getLogWatcher: () => undefined,
    getLogWatchers: () => [],
    listProcesses: async () => [],
    listPanes: async () => panes,
    getPaneHostingPid: async (pid: number) => {
      const pane = panes.find((p) => p.panePid === pid);
      return pane ?? null;
    },
  };
}

describe("OmpHookAdapter", () => {
  let adapter: OmpHookAdapter;

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    refreshMarkerCache();
    adapter = new OmpHookAdapter();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("install", () => {
    it("writes an extension file with the sentinel header and is idempotent", async () => {
      await adapter.install();
      expect(existsSync(ompExtensionFile)).toBe(true);
      const firstLine = readFileSync(ompExtensionFile, "utf-8").split(
        "\n",
        1,
      )[0];
      expect(firstLine).toBe(`// ccmux-extension v${CCMUX_VERSION}`);
      expect(adapter.isInstalled()).toBe(true);

      // Second install should succeed (our own sentinel present).
      await expect(adapter.install()).resolves.toBeDefined();
      expect(existsSync(ompExtensionFile)).toBe(true);
    });

    it("refuses to overwrite a same-named file lacking the sentinel", async () => {
      mkdirSync(ompExtensionDir, { recursive: true });
      writeFileSync(
        ompExtensionFile,
        "// user-authored extension\nexport default () => {};\n",
      );

      const { lines, changed } = await adapter.install();
      expect(changed).toBe(false);
      expect(lines.some((l) => l.toLowerCase().includes("skipped"))).toBe(true);
      const firstLine = readFileSync(ompExtensionFile, "utf-8").split(
        "\n",
        1,
      )[0];
      expect(firstLine).toBe("// user-authored extension");
    });

    it("substitutes MARKERS_DIR and CCMUX_VERSION into the template", async () => {
      await adapter.install();
      const body = readFileSync(ompExtensionFile, "utf-8");
      expect(body).toContain(`markersDir: ${JSON.stringify(markersDir)}`);
      expect(body).toContain(`version: "${CCMUX_VERSION}"`);
      // No raw sentinels survive.
      expect(body).not.toContain("__CCMUX_MARKERS_DIR__");
      expect(body).not.toContain("__CCMUX_VERSION__");
    });
  });

  describe("uninstall", () => {
    it("removes a ccmux-owned extension file", async () => {
      await adapter.install();
      expect(existsSync(ompExtensionFile)).toBe(true);
      const { lines, changed } = await adapter.uninstall();
      expect(changed).toBe(true);
      expect(existsSync(ompExtensionFile)).toBe(false);
      expect(lines.some((l) => l.includes("Removed"))).toBe(true);
    });

    it("leaves a non-ccmux file alone and reports skip", async () => {
      mkdirSync(ompExtensionDir, { recursive: true });
      writeFileSync(ompExtensionFile, "// user-authored extension\n");

      const { changed } = await adapter.uninstall();
      expect(changed).toBe(false);
      expect(existsSync(ompExtensionFile)).toBe(true);
    });
  });

  describe("onMarkerAdded", () => {
    function writeMarkerToCache(marker: SessionPidMarker): void {
      mkdirSync(markersDir, { recursive: true });
      const path = join(
        markersDir,
        `${marker.agent_type}-${marker.session_id}.json`,
      );
      writeFileSync(path, JSON.stringify(marker));
      loadMarkerIntoCache(path);
    }

    function paneSession(): FakeSession {
      return {
        id: "sess-1",
        agentType: "omp",
        trackingMode: "pane",
        tmuxPane: "%1",
        state: {},
      };
    }

    it("links nativeSessionId and projects working state onto the pane session", async () => {
      const session = paneSession();
      const ctx = makeCtx([session], [makePane("%1", 9000)]);
      const marker = makeMarker({
        pid: 9000,
        state: "working",
        state_timestamp: 1_700_000_000,
        last_prompt: "do the thing",
      });
      writeMarkerToCache(marker);

      await adapter.onMarkerAdded(marker, ctx);

      expect(session.nativeSessionId).toBe(marker.session_id);
      expect(session.state.status).toBe("working");
      expect(session.state.attentionType).toBe(null);
      expect(session.state.lastPrompt).toBe("do the thing");
    });

    it("projects idle state when the marker is idle", async () => {
      const session = paneSession();
      const ctx = makeCtx([session], [makePane("%1", 9000)]);
      const marker = makeMarker({ pid: 9000, state: "idle" });
      writeMarkerToCache(marker);

      await adapter.onMarkerAdded(marker, ctx);
      expect(session.state.status).toBe("idle");
    });

    it("projects a permission wait with the gated tool name", async () => {
      const session = paneSession();
      const ctx = makeCtx([session], [makePane("%1", 9000)]);
      const marker = makeMarker({
        pid: 9000,
        state: "waiting_permission",
        pending_tool: "bash",
        state_timestamp: 1_700_000_000,
      });
      writeMarkerToCache(marker);

      await adapter.onMarkerAdded(marker, ctx);

      expect(session.state.status).toBe("waiting");
      expect(session.state.attentionType).toBe("permission");
      expect(session.state.pendingTool).toBe("bash");
      expect(session.state.lastActivityAt).toBe(
        new Date(1_700_000_000 * 1000).toISOString(),
      );
    });

    it("projects a permission wait with a null tool when the marker omits it", async () => {
      const session = paneSession();
      const ctx = makeCtx([session], [makePane("%1", 9000)]);
      const marker = makeMarker({ pid: 9000, state: "waiting_permission" });
      writeMarkerToCache(marker);

      await adapter.onMarkerAdded(marker, ctx);

      expect(session.state.status).toBe("waiting");
      expect(session.state.attentionType).toBe("permission");
      expect(session.state.pendingTool).toBe(null);
    });

    it("clears the wait when a resolved marker comes back as working", async () => {
      const session = paneSession();
      const ctx = makeCtx([session], [makePane("%1", 9000)]);
      writeMarkerToCache(
        makeMarker({
          pid: 9000,
          state: "waiting_permission",
          pending_tool: "bash",
        }),
      );
      await adapter.onMarkerAdded(
        makeMarker({
          pid: 9000,
          state: "waiting_permission",
          pending_tool: "bash",
        }),
        ctx,
      );
      expect(session.state.status).toBe("waiting");

      const resolved = makeMarker({ pid: 9000, state: "working" });
      writeMarkerToCache(resolved);
      await adapter.onMarkerAdded(resolved, ctx);

      expect(session.state.status).toBe("working");
      expect(session.state.attentionType).toBe(null);
      expect(session.state.pendingTool).toBe(null);
    });

    it("no-ops when the marker pid maps to no tmux pane", async () => {
      const session = paneSession();
      const ctx = makeCtx([session], [makePane("%1", 9000)]);
      const marker = makeMarker({ pid: 4242, state: "working" });
      writeMarkerToCache(marker);

      await adapter.onMarkerAdded(marker, ctx);
      expect(session.nativeSessionId).toBeUndefined();
      expect(session.state.status).toBeUndefined();
    });

    it("sets logPath from the marker's transcript_path when the file exists", async () => {
      const session = paneSession();
      const ctx = makeCtx([session], [makePane("%1", 9000)]);
      const transcriptPath = join(tempRoot, "session.jsonl");
      writeFileSync(transcriptPath, "{}\n");
      const marker = makeMarker({
        pid: 9000,
        state: "working",
        transcript_path: transcriptPath,
      });
      writeMarkerToCache(marker);

      await adapter.onMarkerAdded(marker, ctx);
      expect(session.state.logPath).toBe(transcriptPath);
    });

    it("does not set logPath when transcript_path points to a missing file", async () => {
      const session = paneSession();
      const ctx = makeCtx([session], [makePane("%1", 9000)]);
      const marker = makeMarker({
        pid: 9000,
        state: "working",
        transcript_path: join(tempRoot, "vanished.jsonl"),
      });
      writeMarkerToCache(marker);

      await adapter.onMarkerAdded(marker, ctx);
      expect(session.state.logPath).toBeUndefined();
    });

    it("does not claim a pane-tracked pi session", async () => {
      const piSession: FakeSession = {
        id: "sess-pi",
        agentType: "pi",
        trackingMode: "pane",
        tmuxPane: "%1",
        state: {},
      };
      const ctx = makeCtx([piSession], [makePane("%1", 9000)]);
      const marker = makeMarker({ pid: 9000, state: "working" });
      writeMarkerToCache(marker);

      await adapter.onMarkerAdded(marker, ctx);
      expect(piSession.nativeSessionId).toBeUndefined();
      expect(piSession.state.status).toBeUndefined();
    });
  });
});
