import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Temp dirs allocated at module scope so `mock.module` can freeze the
 * paths before the adapter is imported. Per-test `beforeEach` resets
 * directory contents but keeps the paths stable.
 */
const tempRoot = join(
  tmpdir(),
  `ccmux-cursor-adapter-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const cursorDir = join(tempRoot, ".cursor");
const cursorHooksDir = join(cursorDir, "hooks");
const cursorHooksFile = join(cursorDir, "hooks.json");
const markersDir = join(tempRoot, "markers");

const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  CURSOR_DIR: cursorDir,
  CURSOR_HOOKS_DIR: cursorHooksDir,
  CURSOR_HOOKS_FILE: cursorHooksFile,
  MARKERS_DIR: markersDir,
}));

// Stub the version helper so adapter tests don't shell out to a real
// cursor-agent binary. Per-test overrides in `setVersionStub`.
let versionStub: {
  ok: boolean;
  detected: string | null;
  error: string | null;
} = {
  ok: true,
  detected: "2026.04.17-787b533",
  error: null,
};
const actualVersionModule = await import("./version");
mock.module("./version", () => ({
  ...actualVersionModule,
  cursorVersionMeetsHookRequirement: async () => versionStub,
}));

function setVersionStub(stub: {
  ok: boolean;
  detected: string | null;
  error: string | null;
}): void {
  versionStub = stub;
}

import { CursorHookAdapter } from "./hook-adapter";
import { parseCursorVersion, MIN_CURSOR_VERSION } from "./version";

function writeHooksFile(content: object) {
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(cursorHooksFile, JSON.stringify(content, null, 2) + "\n");
}

function readHooksFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(cursorHooksFile, "utf-8"));
}

describe("CursorHookAdapter", () => {
  let adapter: CursorHookAdapter;

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    setVersionStub({
      ok: true,
      detected: "2026.04.17-787b533",
      error: null,
    });
    adapter = new CursorHookAdapter();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("install", () => {
    it("writes four scripts and creates hooks.json entries", async () => {
      const { lines } = await adapter.install();

      for (const name of [
        "ccmux-session-start.sh",
        "ccmux-session-end.sh",
        "ccmux-before-submit-prompt.sh",
        "ccmux-stop.sh",
      ]) {
        expect(existsSync(join(cursorHooksDir, name))).toBe(true);
      }

      const hooks = readHooksFile() as {
        version: number;
        hooks: Record<string, Array<{ command: string; type: string }>>;
      };
      expect(hooks.version).toBe(1);
      expect(hooks.hooks.sessionStart[0].command).toBe(
        join(cursorHooksDir, "ccmux-session-start.sh"),
      );
      expect(hooks.hooks.sessionStart[0].type).toBe("command");
      expect(hooks.hooks.sessionEnd[0].command).toBe(
        join(cursorHooksDir, "ccmux-session-end.sh"),
      );
      expect(hooks.hooks.beforeSubmitPrompt[0].command).toBe(
        join(cursorHooksDir, "ccmux-before-submit-prompt.sh"),
      );
      expect(hooks.hooks.stop[0].command).toBe(
        join(cursorHooksDir, "ccmux-stop.sh"),
      );

      expect(lines.some((l) => l.includes("Created hook script"))).toBe(true);
    });

    it("is idempotent across repeat runs", async () => {
      await adapter.install();
      const firstHooks = readHooksFile();

      const { lines } = await adapter.install();
      const secondHooks = readHooksFile();

      expect(secondHooks).toEqual(firstHooks);
      expect(
        lines.some((l) => l.includes("already installed in hooks.json")),
      ).toBe(true);
    });

    it("preserves user-authored entries in the same slot", async () => {
      writeHooksFile({
        version: 1,
        hooks: {
          stop: [{ command: "/Users/me/custom-stop.sh", type: "command" }],
          beforeSubmitPrompt: [
            { command: "/Users/me/logger.sh", type: "command" },
          ],
        },
      });

      await adapter.install();

      const hooks = readHooksFile() as {
        hooks: Record<string, Array<{ command: string }>>;
      };
      expect(hooks.hooks.stop.map((h) => h.command)).toContain(
        "/Users/me/custom-stop.sh",
      );
      expect(hooks.hooks.stop.map((h) => h.command)).toContain(
        join(cursorHooksDir, "ccmux-stop.sh"),
      );
      expect(hooks.hooks.beforeSubmitPrompt.map((h) => h.command)).toContain(
        "/Users/me/logger.sh",
      );
    });

    it("preserves the user-authored version field", async () => {
      writeHooksFile({
        version: 42,
        hooks: {},
      });

      await adapter.install();

      const hooks = readHooksFile() as { version: number };
      expect(hooks.version).toBe(42);
    });

    it("writes version: 1 when creating the file from scratch", async () => {
      await adapter.install();
      const hooks = readHooksFile() as { version: number };
      expect(hooks.version).toBe(1);
    });

    it("errors when cursor-agent is missing from PATH", async () => {
      setVersionStub({
        ok: false,
        detected: null,
        error: "cursor-agent not on PATH",
      });
      await expect(adapter.install()).rejects.toThrow(/cursor-agent/);
    });

    it("warns but does not block when cursor-agent is too old", async () => {
      setVersionStub({
        ok: false,
        detected: "2025.10.01-abcd123",
        error:
          "cursor-agent 2025.10.01-abcd123 is older than required 2026.1.16",
      });
      const { lines } = await adapter.install();
      expect(
        lines.some((l) => l.startsWith("Warning:") && l.includes("older")),
      ).toBe(true);
      expect(existsSync(join(cursorHooksDir, "ccmux-session-start.sh"))).toBe(
        true,
      );
    });
  });

  describe("uninstall", () => {
    it("removes ccmux hooks and scripts", async () => {
      await adapter.install();

      const { lines } = await adapter.uninstall();

      for (const name of [
        "ccmux-session-start.sh",
        "ccmux-session-end.sh",
        "ccmux-before-submit-prompt.sh",
        "ccmux-stop.sh",
      ]) {
        expect(existsSync(join(cursorHooksDir, name))).toBe(false);
      }

      const hooks = readHooksFile() as {
        version?: number;
        hooks?: Record<string, unknown>;
      };
      // hooks object is pruned when empty; version stays untouched.
      expect(hooks.hooks).toBeUndefined();
      expect(lines.some((l) => l.includes("Removed ccmux entries"))).toBe(true);
    });

    it("preserves user-authored entries in shared slots", async () => {
      await adapter.install();
      const hooksBefore = readHooksFile() as {
        version: number;
        hooks: Record<string, Array<{ command: string; type: string }>>;
      };
      hooksBefore.hooks.stop.push({
        command: "/Users/me/custom-stop.sh",
        type: "command",
      });
      hooksBefore.hooks.beforeSubmitPrompt.push({
        command: "/Users/me/logger.sh",
        type: "command",
      });
      writeFileSync(
        cursorHooksFile,
        JSON.stringify(hooksBefore, null, 2) + "\n",
      );

      await adapter.uninstall();

      const after = readHooksFile() as {
        hooks: Record<string, Array<{ command: string }>>;
      };
      const stopCommands = after.hooks.stop.map((h) => h.command);
      expect(stopCommands).toContain("/Users/me/custom-stop.sh");
      expect(stopCommands).not.toContain(join(cursorHooksDir, "ccmux-stop.sh"));
      const promptCommands = after.hooks.beforeSubmitPrompt.map(
        (h) => h.command,
      );
      expect(promptCommands).toContain("/Users/me/logger.sh");
    });

    it("preserves the version field across uninstall", async () => {
      writeHooksFile({ version: 7, hooks: {} });
      await adapter.install();
      await adapter.uninstall();

      const hooks = readHooksFile() as { version: number };
      expect(hooks.version).toBe(7);
    });

    it("is a soft no-op when nothing is installed", async () => {
      const { lines, changed } = await adapter.uninstall();
      expect(changed).toBe(false);
      expect(lines).toEqual([]);
    });
  });

  describe("isInstalled", () => {
    it("returns false when hooks.json is absent", () => {
      expect(adapter.isInstalled()).toBe(false);
    });

    it("returns false when only user-authored entries are present", () => {
      writeHooksFile({
        version: 1,
        hooks: {
          stop: [{ command: "/Users/me/custom.sh", type: "command" }],
        },
      });
      expect(adapter.isInstalled()).toBe(false);
    });

    it("returns true after install()", async () => {
      await adapter.install();
      expect(adapter.isInstalled()).toBe(true);
    });

    it("returns false on malformed hooks.json", () => {
      mkdirSync(cursorDir, { recursive: true });
      writeFileSync(cursorHooksFile, "{ not valid json");
      expect(adapter.isInstalled()).toBe(false);
    });
  });

  describe("describeInstallAnomalies", () => {
    it("is silent when cursor-agent meets the version requirement", async () => {
      setVersionStub({
        ok: true,
        detected: "2026.04.17-787b533",
        error: null,
      });
      expect(await adapter.describeInstallAnomalies()).toEqual([]);
    });

    it("warns when cursor-agent is missing from PATH", async () => {
      setVersionStub({
        ok: false,
        detected: null,
        error: "cursor-agent not on PATH",
      });
      const warnings = await adapter.describeInstallAnomalies();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/not on PATH/);
    });

    it("warns when cursor-agent is older than required", async () => {
      setVersionStub({
        ok: false,
        detected: "2025.10.01-abcd",
        error: "too old",
      });
      const warnings = await adapter.describeInstallAnomalies();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/older than required/);
    });
  });

  describe("isSessionStillLive", () => {
    it("always returns true (SQLite store is persistent)", () => {
      expect(
        adapter.isSessionStillLive({
          agent_type: "cursor",
          pid: 1,
          session_id: "s",
          timestamp: 1,
        }),
      ).toBe(true);
    });
  });

  describe("onMarkerAdded", () => {
    interface FakeSession {
      id: string;
      agentType: string;
      trackingMode: "native" | "pane";
      tmuxPane: string | null;
      nativeSessionId?: string;
      status?: string;
      lastPrompt?: string | null;
    }

    function buildCtx(
      sessions: FakeSession[],
      paneByPid: Map<number, { paneId: string } | null>,
    ) {
      return {
        sessionManager: {
          getSessions: () => sessions as never,
          setNativeSessionId: (id: string, nsid: string) => {
            const s = sessions.find((x) => x.id === id);
            if (!s) return false;
            s.nativeSessionId = nsid;
            return true;
          },
          updateSession: (id: string, state: Record<string, unknown>) => {
            const s = sessions.find((x) => x.id === id);
            if (!s) return false;
            Object.assign(s, state);
            return true;
          },
        } as never,
        getLogWatcher: () => undefined,
        getLogWatchers: () => [],
        listProcesses: async () => [] as never,
        listPanes: async () => [] as never,
        getPaneHostingPid: async (pid: number) =>
          (paneByPid.get(pid) ?? null) as never,
      };
    }

    it("enriches the pane-tracked cursor session matching marker.pid via PID ancestry", async () => {
      const session: FakeSession = {
        id: "cursor-pane-1",
        agentType: "cursor",
        trackingMode: "pane",
        tmuxPane: "%7",
      };
      const ctx = buildCtx([session], new Map([[4242, { paneId: "%7" }]]));

      await adapter.onMarkerAdded(
        {
          agent_type: "cursor",
          pid: 4242,
          session_id: "cursor-sid",
          state: "working",
          state_timestamp: 1_700_000_001,
          timestamp: 1_700_000_000,
          last_prompt: "please list the files",
        },
        ctx,
      );

      expect(session.nativeSessionId).toBe("cursor-sid");
      expect(session.status).toBe("working");
      expect(session.lastPrompt).toBe("please list the files");
    });

    it("maps state=idle → status=idle", async () => {
      const session: FakeSession = {
        id: "cursor-pane-2",
        agentType: "cursor",
        trackingMode: "pane",
        tmuxPane: "%3",
      };
      const ctx = buildCtx([session], new Map([[99, { paneId: "%3" }]]));

      await adapter.onMarkerAdded(
        {
          agent_type: "cursor",
          pid: 99,
          session_id: "s-idle",
          state: "idle",
          timestamp: 1,
        },
        ctx,
      );

      expect(session.status).toBe("idle");
    });

    it("no-ops when no pane hosts the marker PID", async () => {
      const session: FakeSession = {
        id: "cursor-pane-3",
        agentType: "cursor",
        trackingMode: "pane",
        tmuxPane: "%0",
      };
      const ctx = buildCtx([session], new Map());

      await adapter.onMarkerAdded(
        {
          agent_type: "cursor",
          pid: 777,
          session_id: "orphan",
          state: "working",
          timestamp: 1,
        },
        ctx,
      );

      expect(session.nativeSessionId).toBeUndefined();
      expect(session.status).toBeUndefined();
    });

    it("no-ops when the pane has no cursor pane-tracked session yet (race)", async () => {
      const claudeSession: FakeSession = {
        id: "claude-pane",
        agentType: "claude",
        trackingMode: "pane",
        tmuxPane: "%0",
      };
      const ctx = buildCtx([claudeSession], new Map([[1, { paneId: "%0" }]]));

      await adapter.onMarkerAdded(
        {
          agent_type: "cursor",
          pid: 1,
          session_id: "unrelated",
          state: "working",
          timestamp: 1,
        },
        ctx,
      );

      expect(claudeSession.nativeSessionId).toBeUndefined();
    });
  });
});

describe("parseCursorVersion", () => {
  it("parses the canonical year.month.day-commit format", () => {
    expect(parseCursorVersion("2026.04.17-787b533")).toEqual([2026, 4, 17]);
  });

  it("parses without the commit suffix", () => {
    expect(parseCursorVersion("2026.1.1")).toEqual([2026, 1, 1]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseCursorVersion("  2025.12.31  ")).toEqual([2025, 12, 31]);
  });

  it("returns null for non-matching strings", () => {
    expect(parseCursorVersion("v1.2.3")).toBeNull();
    expect(parseCursorVersion("")).toBeNull();
    expect(parseCursorVersion("garbage")).toBeNull();
  });

  it("exposes MIN_CURSOR_VERSION as the 2026-01-16 release", () => {
    expect(MIN_CURSOR_VERSION).toEqual([2026, 1, 16]);
  });
});
