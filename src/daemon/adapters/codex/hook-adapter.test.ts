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
  `ccmux-codex-adapter-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const codexDir = join(tempRoot, ".codex");
const codexHooksDir = join(codexDir, "hooks");
const codexHooksFile = join(codexDir, "hooks.json");
const codexConfigFile = join(codexDir, "config.toml");
const markersDir = join(tempRoot, "markers");

const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  CODEX_DIR: codexDir,
  CODEX_HOOKS_DIR: codexHooksDir,
  CODEX_HOOKS_FILE: codexHooksFile,
  CODEX_CONFIG_FILE: codexConfigFile,
  MARKERS_DIR: markersDir,
}));

import { CodexHookAdapter } from "./hook-adapter";

function writeHooksFile(content: object) {
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(codexHooksFile, JSON.stringify(content, null, 2) + "\n");
}

function readHooksFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(codexHooksFile, "utf-8"));
}

function readConfigFile(): string {
  return readFileSync(codexConfigFile, "utf-8");
}

describe("CodexHookAdapter", () => {
  let adapter: CodexHookAdapter;

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    adapter = new CodexHookAdapter();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("install", () => {
    it("writes three scripts, creates hooks.json entries, and enables the feature flag", async () => {
      const { lines } = await adapter.install();

      for (const name of [
        "ccmux-session-start.sh",
        "ccmux-stop.sh",
        "ccmux-permission-request.sh",
      ]) {
        expect(existsSync(join(codexHooksDir, name))).toBe(true);
      }

      const hooks = readHooksFile() as {
        hooks: {
          SessionStart: Array<{
            matcher?: string;
            hooks: Array<{ type: string; command: string; timeoutSec: number }>;
          }>;
          Stop: Array<{
            hooks: Array<{ type: string; command: string; timeoutSec: number }>;
          }>;
          PermissionRequest: Array<{
            hooks: Array<{ type: string; command: string; timeoutSec: number }>;
          }>;
        };
      };
      expect(hooks.hooks.SessionStart[0].matcher).toBe("startup|resume|clear");
      expect(hooks.hooks.SessionStart[0].hooks[0].type).toBe("command");
      expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(
        join(codexHooksDir, "ccmux-session-start.sh"),
      );
      expect(hooks.hooks.SessionStart[0].hooks[0].timeoutSec).toBe(1);
      expect(hooks.hooks.Stop[0].hooks[0].command).toBe(
        join(codexHooksDir, "ccmux-stop.sh"),
      );
      expect(hooks.hooks.PermissionRequest[0].hooks[0].command).toBe(
        join(codexHooksDir, "ccmux-permission-request.sh"),
      );

      expect(readConfigFile()).toContain("[features]");
      expect(readConfigFile()).toContain("codex_hooks = true");

      expect(lines.some((l) => l.includes("Created hook script"))).toBe(true);
      expect(
        lines.some((l) => l.includes("Enabled [features] codex_hooks")),
      ).toBe(true);
    });

    it("is idempotent across repeat runs", async () => {
      await adapter.install();
      const firstHooks = readHooksFile();
      const firstConfig = readConfigFile();

      const { lines } = await adapter.install();
      const secondHooks = readHooksFile();
      const secondConfig = readConfigFile();

      expect(secondHooks).toEqual(firstHooks);
      expect(secondConfig).toBe(firstConfig);
      expect(
        lines.some((l) => l.includes("already installed in hooks.json")),
      ).toBe(true);
      expect(lines.some((l) => l.includes("already enabled"))).toBe(true);
    });

    it("preserves user-owned hooks in the same slot", async () => {
      writeHooksFile({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: "/Users/me/my-own-stop.sh",
                  timeoutSec: 5,
                },
              ],
            },
          ],
        },
      });

      await adapter.install();

      const hooks = readHooksFile() as {
        hooks: {
          Stop: Array<{
            matcher?: string;
            hooks: Array<{ command: string; timeoutSec: number }>;
          }>;
        };
      };
      const commands = hooks.hooks.Stop.flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(commands).toContain("/Users/me/my-own-stop.sh");
      expect(commands).toContain(join(codexHooksDir, "ccmux-stop.sh"));
    });

    it("preserves unrelated top-level keys in config.toml", async () => {
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        codexConfigFile,
        `model = "o3"\n# provider choice\n\n[providers.openai]\napi_base = "https://..."\n`,
      );

      await adapter.install();

      const content = readConfigFile();
      expect(content).toContain(`model = "o3"`);
      expect(content).toContain("# provider choice");
      expect(content).toContain("[providers.openai]");
      expect(content).toContain("[features]");
      expect(content).toContain("codex_hooks = true");
    });

    it("backs up existing hooks.json and config.toml before mutating", async () => {
      writeHooksFile({ hooks: { Stop: [] } });
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(codexConfigFile, `model = "o3"\n`);

      await adapter.install();

      expect(existsSync(`${codexHooksFile}.backup`)).toBe(true);
      expect(existsSync(`${codexConfigFile}.backup`)).toBe(true);
      expect(readFileSync(`${codexConfigFile}.backup`, "utf-8")).toBe(
        `model = "o3"\n`,
      );
    });

    it("skips the config.toml write when the flag is already set", async () => {
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(codexConfigFile, `[features]\ncodex_hooks = true\n`);

      await adapter.install();

      expect(existsSync(`${codexConfigFile}.backup`)).toBe(false);
    });
  });

  describe("uninstall", () => {
    it("removes ccmux hooks and scripts", async () => {
      await adapter.install();

      const { lines } = await adapter.uninstall();

      for (const name of [
        "ccmux-session-start.sh",
        "ccmux-stop.sh",
        "ccmux-permission-request.sh",
      ]) {
        expect(existsSync(join(codexHooksDir, name))).toBe(false);
      }

      const hooks = readHooksFile();
      expect(hooks).toEqual({});
      expect(lines.some((l) => l.includes("Removed ccmux entries"))).toBe(true);
    });

    it("leaves config.toml untouched with an advisory note", async () => {
      await adapter.install();
      const beforeConfig = readConfigFile();

      const { lines } = await adapter.uninstall();

      expect(readConfigFile()).toBe(beforeConfig);
      expect(
        lines.some((l) => l.includes("Codex hooks feature flag left as-is")),
      ).toBe(true);
    });

    it("preserves user-owned entries in shared slots", async () => {
      await adapter.install();
      const hooksBefore = readHooksFile() as {
        hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
      };
      hooksBefore.hooks.Stop.push({
        hooks: [
          {
            command: "/Users/me/my-own-stop.sh",
          },
        ],
      } as never);
      writeFileSync(
        codexHooksFile,
        JSON.stringify(hooksBefore, null, 2) + "\n",
      );

      await adapter.uninstall();

      const after = readHooksFile() as {
        hooks?: { Stop?: Array<{ hooks: Array<{ command: string }> }> };
      };
      const commands =
        after.hooks?.Stop?.flatMap((g) => g.hooks.map((h) => h.command)) ?? [];
      expect(commands).toContain("/Users/me/my-own-stop.sh");
      expect(commands).not.toContain(join(codexHooksDir, "ccmux-stop.sh"));
    });

    it("is a soft no-op when nothing is installed", async () => {
      const { lines } = await adapter.uninstall();
      expect(
        lines.some((l) => l.includes("Codex hooks feature flag left as-is")),
      ).toBe(true);
    });
  });

  describe("isInstalled", () => {
    it("returns false when hooks.json is absent", () => {
      expect(adapter.isInstalled()).toBe(false);
    });

    it("returns false when hooks.json has only user-owned entries", () => {
      writeHooksFile({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: "/Users/me/custom.sh",
                },
              ],
            },
          ],
        },
      });
      expect(adapter.isInstalled()).toBe(false);
    });

    it("returns true after install()", async () => {
      await adapter.install();
      expect(adapter.isInstalled()).toBe(true);
    });

    it("returns false on malformed hooks.json", () => {
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(codexHooksFile, "{ not valid json");
      expect(adapter.isInstalled()).toBe(false);
    });
  });

  describe("describeInstallAnomalies", () => {
    it("is silent when nothing is installed and the flag is off", () => {
      expect(adapter.describeInstallAnomalies()).toEqual([]);
    });

    it("is silent when fully installed with the flag on", async () => {
      await adapter.install();
      expect(adapter.describeInstallAnomalies()).toEqual([]);
    });

    it("warns when the flag is on but ccmux hooks are not installed", () => {
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(codexConfigFile, `[features]\ncodex_hooks = true\n`);
      const warnings = adapter.describeInstallAnomalies();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Run `ccmux setup`");
    });

    it("warns when ccmux hooks are installed but the flag is off", async () => {
      await adapter.install();
      // Flip the flag off to simulate the user manually disabling it.
      writeFileSync(codexConfigFile, `[features]\ncodex_hooks = false\n`);
      const warnings = adapter.describeInstallAnomalies();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("will not fire");
    });

    it("is silent when the Codex 0.124+ `hooks` flag is on", async () => {
      await adapter.install();
      // Codex 0.124+ rewrites or coexists with the new `hooks` key. ccmux
      // should recognize it as enabled and not flag a missing-feature warning.
      writeFileSync(
        codexConfigFile,
        `[features]\nhooks = true\nmulti_agent = true\n`,
      );
      expect(adapter.describeInstallAnomalies()).toEqual([]);
    });
  });

  describe("isSessionStillLive", () => {
    it("returns true when the marker has no transcript_path yet", () => {
      expect(
        adapter.isSessionStillLive({
          agent_type: "codex",
          pid: 1,
          tty: "ttys000",
          session_id: "s",
          timestamp: 1,
        }),
      ).toBe(true);
    });

    it("returns true when the transcript file exists on disk", () => {
      mkdirSync(tempRoot, { recursive: true });
      const transcript = join(tempRoot, "rollout.jsonl");
      writeFileSync(transcript, "");
      expect(
        adapter.isSessionStillLive({
          agent_type: "codex",
          pid: 1,
          tty: "ttys000",
          session_id: "s",
          transcript_path: transcript,
          timestamp: 1,
        }),
      ).toBe(true);
    });

    it("returns false when the recorded transcript file is missing", () => {
      expect(
        adapter.isSessionStillLive({
          agent_type: "codex",
          pid: 1,
          tty: "ttys000",
          session_id: "s",
          transcript_path: join(tempRoot, "vanished.jsonl"),
          timestamp: 1,
        }),
      ).toBe(false);
    });
  });

  describe("onMarkerAdded", () => {
    interface FakeSession {
      id: string;
      agentType: string;
      trackingMode: "native" | "pane";
      tmuxPane: string | null;
      nativeSessionId?: string;
      logPath: string | null;
    }

    function buildCtx(
      sessions: FakeSession[],
      panes: Array<{ paneId: string; tty: string | null }>,
      logWatcherSpy?: { processPath: (p: string) => Promise<void> },
    ) {
      // Faithful to the real SessionManager.setNativeSessionId three-way result
      // so the adapter's conflict branch is exercised.
      const setNativeSessionId = (
        id: string,
        nsid: string,
      ): "set" | "noop" | "conflict" => {
        const s = sessions.find((x) => x.id === id);
        if (!s || s.nativeSessionId === nsid) return "noop";
        if (sessions.some((o) => o.id !== id && o.nativeSessionId === nsid)) {
          return "conflict";
        }
        s.nativeSessionId = nsid;
        return "set";
      };
      const setLogPath = (id: string, path: string | null) => {
        const s = sessions.find((x) => x.id === id);
        if (!s) return false;
        s.logPath = path;
        return true;
      };
      return {
        sessionManager: {
          getSessions: () => sessions as never,
          setNativeSessionId,
          setLogPath,
        } as never,
        getLogWatcher: (agentType: string) =>
          agentType === "codex" ? (logWatcherSpy as never) : undefined,
        getLogWatchers: (agentType: string) =>
          agentType === "codex" ? [logWatcherSpy as never] : [],
        listProcesses: async () => [] as never,
        listPanes: async () => panes as never,
        getPaneHostingPid: async () => null,
      };
    }

    it("enriches the pane-tracked Codex session matching the marker's TTY", async () => {
      const session: FakeSession = {
        id: "pane-sess-1",
        agentType: "codex",
        trackingMode: "pane",
        tmuxPane: "%7",
        logPath: null,
      };
      const processed: string[] = [];
      const ctx = buildCtx([session], [{ paneId: "%7", tty: "/dev/ttys042" }], {
        processPath: async (p) => void processed.push(p),
      });

      await adapter.onMarkerAdded(
        {
          agent_type: "codex",
          pid: 4242,
          tty: "ttys042",
          session_id: "real-codex-sid",
          transcript_path: "/tmp/rollout-x.jsonl",
          timestamp: 1,
        },
        ctx,
      );

      expect(session.nativeSessionId).toBe("real-codex-sid");
      expect(session.logPath).toBe("/tmp/rollout-x.jsonl");
      expect(processed).toEqual(["/tmp/rollout-x.jsonl"]);
    });

    it("does NOT enrich the log path on a native-id conflict (another session owns it)", async () => {
      // Session A already owns the id; a marker for A's session_id arrives on
      // B's pane. setNativeSessionId returns "conflict", so B must not inherit
      // the transcript path / trigger parsing (that would converge both rows).
      const sessionA: FakeSession = {
        id: "codex-pane-a",
        agentType: "codex",
        trackingMode: "pane",
        tmuxPane: "%7",
        nativeSessionId: "shared-sid",
        logPath: "/tmp/rollout-a.jsonl",
      };
      const sessionB: FakeSession = {
        id: "codex-pane-b",
        agentType: "codex",
        trackingMode: "pane",
        tmuxPane: "%8",
        logPath: null,
      };
      const processed: string[] = [];
      const ctx = buildCtx(
        [sessionA, sessionB],
        [
          { paneId: "%7", tty: "/dev/ttys042" },
          { paneId: "%8", tty: "/dev/ttys043" },
        ],
        { processPath: async (p) => void processed.push(p) },
      );

      await adapter.onMarkerAdded(
        {
          agent_type: "codex",
          pid: 4343,
          tty: "ttys043", // matches B's pane
          session_id: "shared-sid", // already owned by A
          transcript_path: "/tmp/rollout-b.jsonl",
          timestamp: 1,
        },
        ctx,
      );

      // B was NOT enriched; A is untouched.
      expect(sessionB.nativeSessionId).toBeUndefined();
      expect(sessionB.logPath).toBeNull();
      expect(processed).toEqual([]);
      expect(sessionA.logPath).toBe("/tmp/rollout-a.jsonl");
    });

    it("skips the log watcher and logPath when transcript_path is absent", async () => {
      const session: FakeSession = {
        id: "pane-sess-2",
        agentType: "codex",
        trackingMode: "pane",
        tmuxPane: "%3",
        logPath: null,
      };
      const processed: string[] = [];
      const ctx = buildCtx([session], [{ paneId: "%3", tty: "/dev/ttys001" }], {
        processPath: async (p) => void processed.push(p),
      });

      await adapter.onMarkerAdded(
        {
          agent_type: "codex",
          pid: 1,
          tty: "ttys001",
          session_id: "partial-sid",
          timestamp: 1,
        },
        ctx,
      );

      expect(session.nativeSessionId).toBe("partial-sid");
      expect(session.logPath).toBeNull();
      expect(processed).toEqual([]);
    });

    it("is a no-op when no pane matches the marker's TTY", async () => {
      const session: FakeSession = {
        id: "pane-sess-3",
        agentType: "codex",
        trackingMode: "pane",
        tmuxPane: "%0",
        logPath: null,
      };
      const ctx = buildCtx([session], [{ paneId: "%0", tty: "/dev/ttys999" }]);

      await adapter.onMarkerAdded(
        {
          agent_type: "codex",
          pid: 1,
          tty: "ttys000",
          session_id: "orphan",
          timestamp: 1,
        },
        ctx,
      );

      expect(session.nativeSessionId).toBeUndefined();
    });

    it("ignores a matching pane without a pane-tracked Codex session", async () => {
      const claudeSession: FakeSession = {
        id: "claude-pane",
        agentType: "claude",
        trackingMode: "pane",
        tmuxPane: "%0",
        logPath: null,
      };
      const ctx = buildCtx(
        [claudeSession],
        [{ paneId: "%0", tty: "/dev/ttys000" }],
      );

      await adapter.onMarkerAdded(
        {
          agent_type: "codex",
          pid: 1,
          tty: "ttys000",
          session_id: "unrelated",
          timestamp: 1,
        },
        ctx,
      );

      expect(claudeSession.nativeSessionId).toBeUndefined();
    });

    it("skips markers with no tty without touching panes or sessions", async () => {
      const session: FakeSession = {
        id: "would-be-target",
        agentType: "codex",
        trackingMode: "pane",
        tmuxPane: "%0",
        logPath: null,
      };
      const processed: string[] = [];
      let listPanesCalls = 0;
      const ctx = {
        sessionManager: {
          getSessions: () => [session] as never,
          setNativeSessionId: () => true,
          setLogPath: () => true,
        } as never,
        getLogWatcher: () =>
          ({
            processPath: async (p: string) => void processed.push(p),
          }) as never,
        getLogWatchers: () => [] as never,
        listProcesses: async () => [] as never,
        listPanes: async () => {
          listPanesCalls++;
          return [] as never;
        },
        getPaneHostingPid: async () => null,
      };

      await adapter.onMarkerAdded(
        {
          agent_type: "codex",
          pid: 1,
          tty: "",
          session_id: "s",
          timestamp: 1,
        },
        ctx,
      );

      expect(listPanesCalls).toBe(0);
      expect(processed).toEqual([]);
      expect(session.nativeSessionId).toBeUndefined();
    });
  });
});
