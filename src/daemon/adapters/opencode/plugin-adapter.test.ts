import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempRoot = join(
  tmpdir(),
  `ccmux-opencode-adapter-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const opencodeConfigDir = join(tempRoot, "opencode");
const opencodePluginDir = join(opencodeConfigDir, "plugin");
const opencodePluginFile = join(opencodePluginDir, "ccmux.js");
const opencodeTuiPluginDir = join(opencodeConfigDir, "plugins", "ccmux");
const opencodeTuiPluginFile = join(opencodeTuiPluginDir, "tui.js");
const markersDir = join(tempRoot, "markers");

// Every path the adapter writes MUST be overridden here: anything left to
// `actualConfig` is the developer's real OpenCode config.
const actualConfig = await import("../../../lib/config");
mock.module("../../../lib/config", () => ({
  ...actualConfig,
  OPENCODE_CONFIG_DIR: opencodeConfigDir,
  OPENCODE_PLUGIN_DIR: opencodePluginDir,
  OPENCODE_PLUGIN_FILE: opencodePluginFile,
  OPENCODE_TUI_PLUGIN_DIR: opencodeTuiPluginDir,
  OPENCODE_TUI_PLUGIN_FILE: opencodeTuiPluginFile,
  MARKERS_DIR: markersDir,
}));

import pkg from "../../../../package.json" with { type: "json" };
import { OpenCodePluginAdapter } from "./plugin-adapter";
import type { HookManagerContext } from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import { loadMarkerIntoCache, refreshMarkerCache } from "../../session-markers";
import type { Session, TmuxPane } from "../../../types/session";

const CCMUX_VERSION = pkg.version;

function makeMarker(overrides: Partial<SessionPidMarker>): SessionPidMarker {
  return {
    agent_type: "opencode",
    pid: 9000,
    session_id: "s",
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function writeMarkerToDisk(marker: SessionPidMarker): void {
  mkdirSync(markersDir, { recursive: true });
  const path = join(
    markersDir,
    `${marker.agent_type}-${marker.session_id}.json`,
  );
  writeFileSync(path, JSON.stringify(marker));
  loadMarkerIntoCache(path);
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
    paneTitle: "opencode",
    currentCommand: "opencode",
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

describe("OpenCodePluginAdapter", () => {
  let adapter: OpenCodePluginAdapter;
  // What the stubbed `opencode --version` probe reports; null = not runnable.
  let openCodeVersion: string | null;

  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    mkdirSync(tempRoot, { recursive: true });
    refreshMarkerCache();
    openCodeVersion = "1.18.34";
    adapter = new OpenCodePluginAdapter({
      readOpenCodeVersion: async () => openCodeVersion,
    });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("install", () => {
    it.each(["1.18.34", "2.0.21"])(
      "leaves identical installed plugins untouched on %s",
      async (version) => {
        openCodeVersion = version;
        await adapter.install();
        const files = version.startsWith("1.")
          ? [opencodePluginFile, opencodeTuiPluginFile]
          : [opencodeTuiPluginFile];
        const before = files.map((file) => {
          expect(readFileSync(file, "utf-8").split("\n", 1)[0]).toBe(
            `// ccmux-plugin v${CCMUX_VERSION}`,
          );
          const time = new Date("2024-01-15T12:00:00Z");
          utimesSync(file, time, time);
          return statSync(file);
        });
        const result = await adapter.install();
        expect(result.changed).toBe(false);
        expect(result.lines.some((line) => /Updated|Restart/.test(line))).toBe(
          false,
        );
        files.forEach((file, i) => {
          expect(statSync(file).ino).toBe(before[i].ino);
          expect(statSync(file).mtimeMs).toBe(before[i].mtimeMs);
        });
      },
    );

    it("refreshes same-version plugins when their contents or marker directory differ", async () => {
      await adapter.install();
      for (const file of [opencodePluginFile, opencodeTuiPluginFile]) {
        const expected = readFileSync(file, "utf-8");
        writeFileSync(
          file,
          expected.replace(
            JSON.stringify(markersDir),
            JSON.stringify("/old/markers"),
          ),
        );
        expect((await adapter.install()).changed).toBe(true);
        expect(readFileSync(file, "utf-8")).toBe(expected);
      }
    });

    it("refuses to overwrite a same-named file lacking the sentinel, returns advisory lines", async () => {
      mkdirSync(opencodePluginDir, { recursive: true });
      writeFileSync(
        opencodePluginFile,
        "// user-authored plugin\nexport default async () => ({});\n",
      );

      const { lines } = await adapter.install();
      expect(lines.some((l) => l.toLowerCase().includes("skipped"))).toBe(true);
      const firstLine = readFileSync(opencodePluginFile, "utf-8").split(
        "\n",
        1,
      )[0];
      expect(firstLine).toBe("// user-authored plugin");
    });

    it("renders with the MARKERS_DIR and CCMUX_VERSION substituted", async () => {
      await adapter.install();
      const body = readFileSync(opencodePluginFile, "utf-8");
      expect(body).toContain(`markersDir: ${JSON.stringify(markersDir)}`);
      expect(body).toContain(`version: "${CCMUX_VERSION}"`);
    });

    it("installs as before when the OpenCode version cannot be read", async () => {
      openCodeVersion = null;
      const { changed } = await adapter.install();
      expect(changed).toBe(true);
      expect(existsSync(opencodePluginFile)).toBe(true);
    });

    describe("on OpenCode 2", () => {
      beforeEach(() => {
        openCodeVersion = "2.0.21";
      });

      it("installs the TUI plugin and no server plugin", async () => {
        const { changed } = await adapter.install();
        expect(changed).toBe(true);
        expect(existsSync(opencodeTuiPluginFile)).toBe(true);
        expect(existsSync(opencodePluginFile)).toBe(false);
      });

      it("removes a plugin ccmux installed under 1.x, which 2.x rejects", async () => {
        openCodeVersion = "1.18.34";
        await adapter.install();
        expect(existsSync(opencodePluginFile)).toBe(true);

        openCodeVersion = "2.0.21";
        const { lines, changed } = await adapter.install();
        expect(changed).toBe(true);
        expect(existsSync(opencodePluginFile)).toBe(false);
        expect(lines.some((l) => l.startsWith("Removed"))).toBe(true);
      });

      it("leaves a same-named file ccmux did not write", async () => {
        mkdirSync(opencodePluginDir, { recursive: true });
        writeFileSync(opencodePluginFile, "// user-authored plugin\n");
        const { lines } = await adapter.install();
        expect(readFileSync(opencodePluginFile, "utf-8")).toBe(
          "// user-authored plugin\n",
        );
        expect(lines.some((l) => l.startsWith("Left"))).toBe(true);
      });
    });

    describe("the OpenCode 2 TUI plugin", () => {
      it("is installed alongside the server plugin on 1.x, which never loads it", async () => {
        await adapter.install();
        expect(existsSync(opencodePluginFile)).toBe(true);
        const body = readFileSync(opencodeTuiPluginFile, "utf-8");
        expect(body.split("\n", 1)[0]).toBe(
          `// ccmux-plugin v${CCMUX_VERSION}`,
        );
        expect(body).toContain(`markersDir: ${JSON.stringify(markersDir)}`);
        expect(body).toContain("makeTuiPlugin");
      });

      it("refuses to overwrite a tui.js ccmux did not write", async () => {
        mkdirSync(opencodeTuiPluginDir, { recursive: true });
        writeFileSync(opencodeTuiPluginFile, "// someone else's\n");
        const { lines } = await adapter.install();
        expect(readFileSync(opencodeTuiPluginFile, "utf-8")).toBe(
          "// someone else's\n",
        );
        expect(
          lines.some((l) => l.startsWith(`Skipped ${opencodeTuiPluginFile}`)),
        ).toBe(true);
        // The server plugin still installs.
        expect(existsSync(opencodePluginFile)).toBe(true);
      });
    });
  });

  describe("uninstall", () => {
    it("removes a ccmux-owned plugin file", async () => {
      await adapter.install();
      expect(existsSync(opencodePluginFile)).toBe(true);
      const { lines } = await adapter.uninstall();
      expect(existsSync(opencodePluginFile)).toBe(false);
      expect(lines.some((l) => l.includes("Removed"))).toBe(true);
    });

    it("leaves a non-ccmux file alone and reports skip", async () => {
      mkdirSync(opencodePluginDir, { recursive: true });
      writeFileSync(
        opencodePluginFile,
        "// user-authored plugin\nexport default async () => ({});\n",
      );
      const { lines } = await adapter.uninstall();
      expect(existsSync(opencodePluginFile)).toBe(true);
      expect(lines.some((l) => l.toLowerCase().includes("skipped"))).toBe(true);
    });

    it("removes both plugins and the TUI plugin's directory", async () => {
      await adapter.install();
      await adapter.uninstall();
      expect(existsSync(opencodePluginFile)).toBe(false);
      expect(existsSync(opencodeTuiPluginFile)).toBe(false);
      expect(existsSync(opencodeTuiPluginDir)).toBe(false);
    });

    it("keeps the TUI plugin's directory when something else is in it", async () => {
      await adapter.install();
      writeFileSync(join(opencodeTuiPluginDir, "notes.txt"), "mine\n");
      await adapter.uninstall();
      expect(existsSync(opencodeTuiPluginFile)).toBe(false);
      expect(existsSync(join(opencodeTuiPluginDir, "notes.txt"))).toBe(true);
    });

    it("is a no-op advisory when the plugin file is absent", async () => {
      const { lines } = await adapter.uninstall();
      expect(lines.some((l) => l.toLowerCase().includes("no ccmux"))).toBe(
        true,
      );
    });
  });

  describe("isInstalled / describeInstallAnomalies", () => {
    it("true after install, false before", async () => {
      expect(adapter.isInstalled()).toBe(false);
      await adapter.install();
      expect(adapter.isInstalled()).toBe(true);
    });

    it("false for a same-named non-sentinel file", () => {
      mkdirSync(opencodePluginDir, { recursive: true });
      writeFileSync(opencodePluginFile, "// something else\n");
      expect(adapter.isInstalled()).toBe(false);
    });

    it("reports no anomaly when versions match", async () => {
      await adapter.install();
      expect(await adapter.describeInstallAnomalies()).toEqual([]);
    });

    it("flags an installed plugin once OpenCode is upgraded to 2.x", async () => {
      await adapter.install();
      openCodeVersion = "2.0.21";
      const warnings = await adapter.describeInstallAnomalies();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("OpenCode 2.0.21 rejects it");
      expect(warnings[0]).toContain("ccmux setup --agent opencode");
    });

    it("counts the TUI plugin alone as installed (the OpenCode 2 shape)", async () => {
      openCodeVersion = "2.0.21";
      await adapter.install();
      expect(adapter.isInstalled()).toBe(true);
      expect(adapter.describeInstallDetail()).toContain(CCMUX_VERSION);
      expect(await adapter.describeInstallAnomalies()).toEqual([]);
    });

    it("reports a stale TUI plugin", async () => {
      mkdirSync(opencodeTuiPluginDir, { recursive: true });
      writeFileSync(opencodeTuiPluginFile, "// ccmux-plugin v0.0.0-stale\n");
      const warnings = await adapter.describeInstallAnomalies();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(opencodeTuiPluginFile);
      expect(warnings[0]).toContain("v0.0.0-stale");
    });

    it("reports nothing on 2.x when no plugin is installed", async () => {
      openCodeVersion = "2.0.21";
      expect(await adapter.describeInstallAnomalies()).toEqual([]);
    });

    it("reports version skew when the sentinel version disagrees", async () => {
      mkdirSync(opencodePluginDir, { recursive: true });
      writeFileSync(
        opencodePluginFile,
        `// ccmux-plugin v0.0.0-stale\n// body\n`,
      );
      const warnings = await adapter.describeInstallAnomalies();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("v0.0.0-stale");
      expect(warnings[0]).toContain(CCMUX_VERSION);
    });

    it("reports no anomaly for a foreign (non-ccmux) file", async () => {
      mkdirSync(opencodePluginDir, { recursive: true });
      writeFileSync(opencodePluginFile, "// not ccmux\n");
      expect(await adapter.describeInstallAnomalies()).toEqual([]);
    });
  });

  describe("describeInstallDetail", () => {
    it("returns null when no plugin is installed", () => {
      expect(adapter.describeInstallDetail()).toBeNull();
    });

    it("returns null for a foreign (non-ccmux) file", () => {
      mkdirSync(opencodePluginDir, { recursive: true });
      writeFileSync(opencodePluginFile, "// someone else's plugin\n");
      expect(adapter.describeInstallDetail()).toBeNull();
    });

    it("includes 'matches running ccmux' when versions agree", async () => {
      await adapter.install();
      expect(adapter.describeInstallDetail()).toBe(
        `(plugin v${CCMUX_VERSION}, matches running ccmux)`,
      );
    });

    it("omits the 'matches' phrase on version skew (anomaly line covers it)", () => {
      mkdirSync(opencodePluginDir, { recursive: true });
      writeFileSync(opencodePluginFile, `// ccmux-plugin v0.0.0-stale\n`);
      expect(adapter.describeInstallDetail()).toBe(`(plugin v0.0.0-stale)`);
    });
  });

  describe("isSessionStillLive", () => {
    it("returns true for any marker; PID liveness handles the rest", () => {
      expect(adapter.isSessionStillLive(makeMarker({ session_id: "x" }))).toBe(
        true,
      );
    });
  });

  describe("onMarkerAdded", () => {
    it("finds the pane-tracked session and applies the aggregate", async () => {
      const pane = makePane("%3", 8000);
      const session: FakeSession = {
        id: "sid-abc",
        agentType: "opencode",
        trackingMode: "pane",
        tmuxPane: pane.paneId,
        state: {},
      };
      const ctx = makeCtx([session], [pane]);

      const m1 = makeMarker({
        pid: 8000,
        session_id: "s1",
        state: "working",
        state_timestamp: 1_700_000_100,
        directory: "/proj",
      });
      const m2 = makeMarker({
        pid: 8000,
        session_id: "s2",
        state: "waiting_permission",
        pending_tool: "bash",
        state_timestamp: 1_700_000_200,
      });
      writeMarkerToDisk(m1);
      writeMarkerToDisk(m2);

      await adapter.onMarkerAdded(m2, ctx);

      expect(session.state.status).toBe("waiting");
      expect(session.state.attentionType).toBe("permission");
      expect(session.state.pendingTool).toBe("bash");
      expect(session.nativeSessionId).toBe("s2");
    });

    it("no-ops when the server PID does not map to any tmux pane", async () => {
      const session: FakeSession = {
        id: "sid-abc",
        agentType: "opencode",
        trackingMode: "pane",
        tmuxPane: "%9",
        state: {},
      };
      const ctx = makeCtx([session], [makePane("%9", 111)]);
      const m = makeMarker({ pid: 99999, session_id: "s1", state: "idle" });
      writeMarkerToDisk(m);

      await adapter.onMarkerAdded(m, ctx);
      expect(session.state.status).toBeUndefined();
    });

    it("no-ops when the pane has no matching pane-tracked session (race)", async () => {
      const pane = makePane("%5", 7000);
      const ctx = makeCtx([], [pane]);
      const m = makeMarker({ pid: 7000, session_id: "s1", state: "idle" });
      writeMarkerToDisk(m);
      await adapter.onMarkerAdded(m, ctx);
      // No session to update; the call should not throw.
    });

    it("ignores a session whose agentType is opencode but trackingMode is native", async () => {
      const pane = makePane("%2", 4200);
      const session: FakeSession = {
        id: "native-sid",
        agentType: "opencode",
        trackingMode: "native",
        tmuxPane: pane.paneId,
        state: {},
      };
      const ctx = makeCtx([session], [pane]);
      const m = makeMarker({ pid: 4200, session_id: "s1", state: "working" });
      writeMarkerToDisk(m);
      await adapter.onMarkerAdded(m, ctx);
      expect(session.state.status).toBeUndefined();
    });
  });

  describe("onMarkerRemoved", () => {
    it("re-aggregates from remaining siblings, excluding the removed marker", async () => {
      const pane = makePane("%4", 6000);
      const session: FakeSession = {
        id: "sid",
        agentType: "opencode",
        trackingMode: "pane",
        tmuxPane: pane.paneId,
        state: {},
      };
      const ctx = makeCtx([session], [pane]);

      const alive = makeMarker({
        pid: 6000,
        session_id: "alive",
        state: "working",
        state_timestamp: 1_700_000_100,
      });
      const dying = makeMarker({
        pid: 6000,
        session_id: "dying",
        state: "waiting_permission",
        pending_tool: "bash",
        state_timestamp: 1_700_000_200,
      });
      writeMarkerToDisk(alive);
      writeMarkerToDisk(dying);

      // Simulate chokidar unlink: the cache may still hold the removed
      // marker until the next scan, so the adapter must filter it out.
      await adapter.onMarkerRemoved(dying, ctx);
      expect(session.state.status).toBe("working");
      expect(session.state.attentionType).toBeNull();
      expect(session.state.pendingTool).toBeNull();
      expect(session.nativeSessionId).toBe("alive");
    });

    it("resets to idle when no siblings remain", async () => {
      const pane = makePane("%6", 5000);
      const session: FakeSession = {
        id: "sid",
        agentType: "opencode",
        trackingMode: "pane",
        tmuxPane: pane.paneId,
        state: {},
      };
      const ctx = makeCtx([session], [pane]);

      const only = makeMarker({
        pid: 5000,
        session_id: "only",
        state: "working",
      });
      writeMarkerToDisk(only);

      await adapter.onMarkerRemoved(only, ctx);
      expect(session.state.status).toBe("idle");
      expect(session.state.attentionType).toBeNull();
      expect(session.state.pendingTool).toBeNull();
    });

    it("no-ops when the pane is no longer hosting anything", async () => {
      const ctx = makeCtx([], []);
      const m = makeMarker({ pid: 9999, session_id: "s1" });
      await adapter.onMarkerRemoved(m, ctx);
      // Nothing to assert: the call must not throw.
    });
  });

  describe("onMarkerChanged", () => {
    // The daemon's generic
    // `resolveSessionForMarkerEvent(marker.session_id)` misses for
    // OpenCode non-winning siblings because `nativeSessionId` only
    // stores the winning marker's id. The adapter intercepts the
    // chokidar `change` event via this method, mapping by server PID
    // instead, and re-aggregates regardless of which sibling rewrote.

    it("re-aggregates when a non-winning sibling rewrites", async () => {
      const pane = makePane("%7", 7100);
      const session: FakeSession = {
        id: "sid",
        agentType: "opencode",
        trackingMode: "pane",
        tmuxPane: pane.paneId,
        state: {},
      };
      const ctx = makeCtx([session], [pane]);

      const winner = makeMarker({
        pid: 7100,
        session_id: "winner",
        state: "idle",
        state_timestamp: 1_700_000_100,
      });
      const siblingBefore = makeMarker({
        pid: 7100,
        session_id: "sibling",
        state: "idle",
        state_timestamp: 1_700_000_050,
      });
      writeMarkerToDisk(winner);
      writeMarkerToDisk(siblingBefore);

      // Rewrite the non-winning sibling to waiting_permission with a
      // fresher timestamp than the winner. The adapter must apply the
      // updated aggregate regardless of which sibling triggered the
      // event.
      const siblingAfter = makeMarker({
        pid: 7100,
        session_id: "sibling",
        state: "waiting_permission",
        pending_tool: "external_directory",
        state_timestamp: 1_700_000_200,
      });
      writeMarkerToDisk(siblingAfter);

      await adapter.onMarkerChanged(siblingAfter, ctx);

      expect(session.state.status).toBe("waiting");
      expect(session.state.attentionType).toBe("permission");
      expect(session.state.pendingTool).toBe("external_directory");
      // Aggregator picks the newest waiting-state marker; sibling wins.
      expect(session.nativeSessionId).toBe("sibling");
    });

    it("re-aggregates when the winning marker rewrites", async () => {
      const pane = makePane("%8", 7200);
      const session: FakeSession = {
        id: "sid",
        agentType: "opencode",
        trackingMode: "pane",
        tmuxPane: pane.paneId,
        state: {},
      };
      const ctx = makeCtx([session], [pane]);

      const winnerBefore = makeMarker({
        pid: 7200,
        session_id: "winner",
        state: "working",
        state_timestamp: 1_700_000_100,
      });
      writeMarkerToDisk(winnerBefore);

      const winnerAfter = makeMarker({
        pid: 7200,
        session_id: "winner",
        state: "waiting_permission",
        pending_tool: "bash",
        state_timestamp: 1_700_000_200,
      });
      writeMarkerToDisk(winnerAfter);

      await adapter.onMarkerChanged(winnerAfter, ctx);

      expect(session.state.status).toBe("waiting");
      expect(session.state.attentionType).toBe("permission");
      expect(session.state.pendingTool).toBe("bash");
      expect(session.nativeSessionId).toBe("winner");
    });

    it("no-ops when the server PID does not map to any tmux pane", async () => {
      const session: FakeSession = {
        id: "sid",
        agentType: "opencode",
        trackingMode: "pane",
        tmuxPane: "%9",
        state: {},
      };
      const ctx = makeCtx([session], [makePane("%9", 111)]);
      const m = makeMarker({ pid: 88888, session_id: "stray", state: "idle" });
      writeMarkerToDisk(m);
      await adapter.onMarkerChanged(m, ctx);
      expect(session.state.status).toBeUndefined();
    });
  });
});
