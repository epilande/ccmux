import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Temp dir created at module scope so mock.module has fixed MARKERS_DIR. */
const tempRoot = join(
  tmpdir(),
  `ccmux-hook-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const testMarkersDir = join(tempRoot, "session-pids");

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  MARKERS_DIR: testMarkersDir,
}));

import { HookManager } from "./hook-manager";
import type { HookAdapter } from "./hook-adapter";
import type { Session } from "../types/session";
import { refreshMarkerCache } from "./session-markers";
import type { SessionPidMarker } from "./session-markers";

function trivialContext() {
  return {
    sessionManager: {} as never,
    getLogWatcher: () => undefined,
    getLogWatchers: () => [],
    listProcesses: async () => [],
    listPanes: async () => [],
    getPaneHostingPid: async () => null,
  };
}

describe("HookManager", () => {
  let manager: HookManager;

  beforeEach(() => {
    mkdirSync(testMarkersDir, { recursive: true });
    refreshMarkerCache();
    manager = new HookManager();
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("adapter registry", () => {
    function makeAdapter(agentType: string): HookAdapter {
      return {
        agentType,
        install: async () => ({ lines: [], changed: false }),
        uninstall: async () => ({ lines: [], changed: false }),
        isInstalled: () => false,
        isSessionStillLive: () => true,
      };
    }

    it("registers and retrieves adapters by agentType", () => {
      const a = makeAdapter("claude");
      manager.register(a);
      expect(manager.getAdapter("claude")).toBe(a);
      expect(manager.getAdapter("codex")).toBeUndefined();
    });

    it("listAdapters returns every registered adapter", () => {
      const a = makeAdapter("claude");
      const b = makeAdapter("codex");
      manager.register(a);
      manager.register(b);
      expect(
        manager
          .listAdapters()
          .sort((x, y) => x.agentType.localeCompare(y.agentType)),
      ).toEqual([a, b]);
    });

    it("register is last-write-wins for the same agentType", () => {
      const a1 = makeAdapter("claude");
      const a2 = makeAdapter("claude");
      manager.register(a1);
      manager.register(a2);
      expect(manager.getAdapter("claude")).toBe(a2);
      expect(manager.listAdapters()).toHaveLength(1);
    });
  });

  describe("context", () => {
    it("returns null before setContext is called", () => {
      expect(manager.getContext()).toBeNull();
    });

    it("remembers the context passed to setContext", () => {
      const ctx = {
        sessionManager: {} as never,
        getLogWatcher: () => undefined,
        getLogWatchers: () => [],
        listProcesses: async () => [],
        listPanes: async () => [],
        getPaneHostingPid: async () => null,
      };
      manager.setContext(ctx);
      expect(manager.getContext()).toBe(ctx);
    });
  });

  describe("getMarkerForSession", () => {
    function writeMarker(filename: string, marker: SessionPidMarker) {
      writeFileSync(
        join(testMarkersDir, `${filename}.json`),
        JSON.stringify(marker),
      );
    }

    it("returns null when the session has no nativeSessionId", () => {
      const session = { id: "s", nativeSessionId: undefined } as Session;
      expect(manager.getMarkerForSession(session)).toBeNull();
    });

    it("returns null when no marker exists for the nativeSessionId", () => {
      refreshMarkerCache();
      const session = { id: "s", nativeSessionId: "sess-none" } as Session;
      expect(manager.getMarkerForSession(session)).toBeNull();
    });

    it("returns the cached marker matching nativeSessionId", () => {
      const marker: SessionPidMarker = {
        agent_type: "claude",
        pid: 1,
        tty: "/dev/ttys0",
        session_id: "sess-x",
        timestamp: 1,
      };
      writeMarker("claude-sess-x", marker);
      refreshMarkerCache();
      const session = { id: "s", nativeSessionId: "sess-x" } as Session;
      expect(manager.getMarkerForSession(session)?.session_id).toBe("sess-x");
    });
  });

  describe("marker dispatch", () => {
    function makeAdapter(agentType: string, events: string[]): HookAdapter {
      return {
        agentType,
        install: async () => ({ lines: [], changed: false }),
        uninstall: async () => ({ lines: [], changed: false }),
        isInstalled: () => false,
        isSessionStillLive: () => true,
        onMarkerAdded: async (m) => {
          events.push(`${agentType}:add:${m.session_id}`);
        },
        onMarkerRemoved: async (m) => {
          events.push(`${agentType}:rm:${m.session_id}`);
        },
      };
    }

    function writeMarker(filename: string, marker: SessionPidMarker): string {
      const path = join(testMarkersDir, `${filename}.json`);
      writeFileSync(path, JSON.stringify(marker));
      return path;
    }

    it("replays existing markers via onMarkerAdded on start()", async () => {
      const events: string[] = [];
      manager.register(makeAdapter("claude", events));
      manager.setContext(trivialContext());
      writeMarker("claude-s1", {
        agent_type: "claude",
        pid: 1,
        tty: "/dev/ttys0",
        session_id: "s1",
        timestamp: 1,
      });

      await manager.start();
      expect(events).toContain("claude:add:s1");
      await manager.stop();
    });

    it("handleMarkerAdded dispatches by marker.agent_type", async () => {
      const events: string[] = [];
      manager.register(makeAdapter("claude", events));
      manager.register(makeAdapter("codex", events));
      manager.setContext(trivialContext());

      const claudePath = writeMarker("claude-alpha", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "alpha",
        timestamp: 1,
      });
      const codexPath = writeMarker("codex-bravo", {
        agent_type: "codex",
        pid: 20,
        tty: "/dev/ttys0",
        session_id: "bravo",
        timestamp: 1,
      });

      await manager.handleMarkerAdded(claudePath);
      await manager.handleMarkerAdded(codexPath);

      expect(events).toEqual(["claude:add:alpha", "codex:add:bravo"]);
    });

    it("handleMarkerRemoved dispatches using the last-seen marker payload", async () => {
      const events: string[] = [];
      manager.register(makeAdapter("claude", events));
      manager.setContext(trivialContext());

      const path = writeMarker("claude-alpha", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "alpha",
        timestamp: 1,
      });
      await manager.handleMarkerAdded(path);
      rmSync(path);
      await manager.handleMarkerRemoved(path);

      expect(events).toEqual(["claude:add:alpha", "claude:rm:alpha"]);
    });

    it("does not call adapter hooks when no context is set", async () => {
      const events: string[] = [];
      manager.register(makeAdapter("claude", events));
      // Deliberately skip setContext.

      const path = writeMarker("claude-alpha", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "alpha",
        timestamp: 1,
      });
      await manager.handleMarkerAdded(path);

      expect(events).toEqual([]);
    });

    it("ignores markers for unregistered agent_types", async () => {
      const events: string[] = [];
      manager.register(makeAdapter("claude", events));
      manager.setContext(trivialContext());

      const path = writeMarker("codex-unreg", {
        agent_type: "codex",
        pid: 30,
        tty: "/dev/ttys0",
        session_id: "unreg",
        timestamp: 1,
      });
      await manager.handleMarkerAdded(path);

      expect(events).toEqual([]);
    });
  });

  describe("marker change events + onMarkerChanged callback", () => {
    function makeRichAdapter(agentType: string, events: string[]): HookAdapter {
      return {
        agentType,
        install: async () => ({ lines: [], changed: false }),
        uninstall: async () => ({ lines: [], changed: false }),
        isInstalled: () => false,
        isSessionStillLive: () => true,
        onMarkerAdded: async (m) => {
          events.push(`add:${m.session_id}`);
        },
        onMarkerChanged: async (m) => {
          events.push(`change:${m.session_id}`);
        },
        onMarkerRemoved: async (m) => {
          events.push(`remove:${m.session_id}`);
        },
      };
    }

    function writeMarker(filename: string, marker: SessionPidMarker): string {
      const path = join(testMarkersDir, `${filename}.json`);
      writeFileSync(path, JSON.stringify(marker));
      return path;
    }

    function contextWithReconcileSpy(notified: string[]) {
      return {
        ...trivialContext(),
        onMarkerChanged: (sessionId: string) => {
          notified.push(sessionId);
        },
      };
    }

    it("handleMarkerChanged dispatches to adapter.onMarkerChanged", async () => {
      const events: string[] = [];
      const notified: string[] = [];
      manager.register(makeRichAdapter("claude", events));
      manager.setContext(contextWithReconcileSpy(notified));

      const path = writeMarker("claude-c1", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "c1",
        timestamp: 1,
      });
      await manager.handleMarkerAdded(path);
      writeFileSync(
        path,
        JSON.stringify({
          agent_type: "claude",
          pid: 10,
          tty: "/dev/ttys0",
          session_id: "c1",
          timestamp: 2,
          state: "waiting_permission",
          state_timestamp: 2,
        }),
      );
      await manager.handleMarkerChanged(path);

      expect(events).toEqual(["add:c1", "change:c1"]);
    });

    it("notifies ctx.onMarkerChanged exactly once per add", async () => {
      const events: string[] = [];
      const notified: string[] = [];
      manager.register(makeRichAdapter("claude", events));
      manager.setContext(contextWithReconcileSpy(notified));

      const path = writeMarker("claude-add", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "add-sid",
        timestamp: 1,
      });
      await manager.handleMarkerAdded(path);

      expect(notified).toEqual(["add-sid"]);
    });

    it("notifies ctx.onMarkerChanged exactly once per change", async () => {
      const events: string[] = [];
      const notified: string[] = [];
      manager.register(makeRichAdapter("claude", events));
      manager.setContext(contextWithReconcileSpy(notified));

      const path = writeMarker("claude-chg", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "chg-sid",
        timestamp: 1,
      });
      await manager.handleMarkerAdded(path); // primes notified with "chg-sid"
      notified.length = 0;
      await manager.handleMarkerChanged(path);

      expect(notified).toEqual(["chg-sid"]);
    });

    it("notifies ctx.onMarkerChanged exactly once per unlink", async () => {
      const events: string[] = [];
      const notified: string[] = [];
      manager.register(makeRichAdapter("claude", events));
      manager.setContext(contextWithReconcileSpy(notified));

      const path = writeMarker("claude-rm", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "rm-sid",
        timestamp: 1,
      });
      await manager.handleMarkerAdded(path);
      notified.length = 0;
      rmSync(path);
      await manager.handleMarkerRemoved(path);

      expect(notified).toEqual(["rm-sid"]);
    });

    it("adapter without onMarkerChanged is allowed (notify still fires)", async () => {
      const notified: string[] = [];
      // No onMarkerChanged on this adapter.
      manager.register({
        agentType: "claude",
        install: async () => ({ lines: [], changed: false }),
        uninstall: async () => ({ lines: [], changed: false }),
        isInstalled: () => false,
        isSessionStillLive: () => true,
        onMarkerAdded: async () => {},
      });
      manager.setContext(contextWithReconcileSpy(notified));

      const path = writeMarker("claude-no-change-hook", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "no-hook-sid",
        timestamp: 1,
      });
      await manager.handleMarkerAdded(path);
      writeFileSync(
        path,
        JSON.stringify({
          agent_type: "claude",
          pid: 10,
          tty: "/dev/ttys0",
          session_id: "no-hook-sid",
          timestamp: 2,
          state: "idle",
          state_timestamp: 2,
        }),
      );
      notified.length = 0;
      await manager.handleMarkerChanged(path);

      expect(notified).toEqual(["no-hook-sid"]);
    });

    it("context without onMarkerChanged is allowed (no-op, no throw)", async () => {
      const events: string[] = [];
      manager.register(makeRichAdapter("claude", events));
      // Context omits onMarkerChanged entirely.
      manager.setContext({
        sessionManager: {} as never,
        getLogWatcher: () => undefined,
        getLogWatchers: () => [],
        listProcesses: async () => [],
        listPanes: async () => [],
        getPaneHostingPid: async () => null,
      });

      const path = writeMarker("claude-no-ctx", {
        agent_type: "claude",
        pid: 10,
        tty: "/dev/ttys0",
        session_id: "no-ctx-sid",
        timestamp: 1,
      });
      // Should not throw when context.onMarkerChanged is undefined.
      await manager.handleMarkerAdded(path);
    });

    it("adapter.onMarkerChanged runs BEFORE ctx.onMarkerChanged", async () => {
      // The OpenCode adapter's `onMarkerChanged` re-aggregates by server
      // PID before the daemon's generic `reconcileSessionFromMarkerEvent`
      // runs, which is what closes the non-winning-sibling latency gap
      // (the generic resolver looks up by marker `session_id` and only
      // matches the aggregator's winning marker). A refactor that swaps
      // the two dispatch calls in `handleMarkerChanged`, or drops the
      // `await` on `dispatchMarkerChanged`, would silently regress that
      // closure without failing any other test in this file.
      const order: string[] = [];
      const adapter: HookAdapter = {
        agentType: "opencode",
        install: async () => ({ lines: [], changed: false }),
        uninstall: async () => ({ lines: [], changed: false }),
        isInstalled: () => false,
        isSessionStillLive: () => true,
        onMarkerChanged: async (m) => {
          order.push(`adapter:${m.session_id}`);
        },
      };
      manager.register(adapter);
      manager.setContext({
        ...trivialContext(),
        onMarkerChanged: (sessionId: string) => {
          order.push(`ctx:${sessionId}`);
        },
      });

      const path = writeMarker("opencode-ord", {
        agent_type: "opencode",
        pid: 10,
        session_id: "ord-sid",
        timestamp: 1,
      });
      writeFileSync(
        path,
        JSON.stringify({
          agent_type: "opencode",
          pid: 10,
          session_id: "ord-sid",
          timestamp: 2,
          state: "waiting_permission",
          state_timestamp: 2,
        }),
      );
      await manager.handleMarkerChanged(path);

      expect(order).toEqual(["adapter:ord-sid", "ctx:ord-sid"]);
    });

    it("ctx.onMarkerChanged still fires when adapter.onMarkerChanged rejects", async () => {
      // The dispatch try/catch in `HookManager.dispatchMarkerChanged` must
      // absorb adapter failures so the daemon's generic reconcile still
      // runs. Without this pin, swapping the try/catch for `await` would
      // silently regress the freshness guarantee on marker change events.
      const notified: string[] = [];
      const consoleErrors: unknown[][] = [];
      const restoreConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        consoleErrors.push(args);
      };

      try {
        manager.register({
          agentType: "claude",
          install: async () => ({ lines: [], changed: false }),
          uninstall: async () => ({ lines: [], changed: false }),
          isInstalled: () => false,
          isSessionStillLive: () => true,
          onMarkerChanged: async () => {
            throw new Error("adapter blew up");
          },
        });
        manager.setContext({
          ...trivialContext(),
          onMarkerChanged: (sessionId: string) => {
            notified.push(sessionId);
          },
        });

        const path = writeMarker("claude-throws", {
          agent_type: "claude",
          pid: 10,
          tty: "/dev/ttys0",
          session_id: "throws-sid",
          timestamp: 1,
        });
        writeFileSync(
          path,
          JSON.stringify({
            agent_type: "claude",
            pid: 10,
            tty: "/dev/ttys0",
            session_id: "throws-sid",
            timestamp: 2,
            state: "waiting_permission",
            state_timestamp: 2,
          }),
        );
        await manager.handleMarkerChanged(path);

        expect(notified).toEqual(["throws-sid"]);
        expect(consoleErrors).toHaveLength(1);
      } finally {
        console.error = restoreConsoleError;
      }
    });
  });

  describe("getMarkerPidsByAgent", () => {
    function writeMarker(filename: string, marker: SessionPidMarker) {
      writeFileSync(
        join(testMarkersDir, `${filename}.json`),
        JSON.stringify(marker),
      );
    }

    it("returns only PIDs whose marker body carries the requested agent_type", () => {
      writeMarker("claude-a", {
        agent_type: "claude",
        pid: 100,
        tty: "/dev/ttys0",
        session_id: "a",
        timestamp: 1,
      });
      writeMarker("claude-b", {
        agent_type: "claude",
        pid: 200,
        tty: "/dev/ttys0",
        session_id: "b",
        timestamp: 1,
      });
      writeMarker("codex-c", {
        agent_type: "codex",
        pid: 300,
        tty: "/dev/ttys0",
        session_id: "c",
        timestamp: 1,
      });

      expect([...manager.getMarkerPidsByAgent("claude")].sort()).toEqual([
        100, 200,
      ]);
      expect([...manager.getMarkerPidsByAgent("codex")]).toEqual([300]);
      expect([...manager.getMarkerPidsByAgent("gemini")]).toEqual([]);
    });
  });

  describe("getMarkersByAgentAndPid", () => {
    function writeMarker(filename: string, marker: SessionPidMarker) {
      writeFileSync(
        join(testMarkersDir, `${filename}.json`),
        JSON.stringify(marker),
      );
    }

    it("returns every marker whose agent_type AND pid match", () => {
      writeMarker("oc-a", {
        agent_type: "opencode",
        pid: 500,
        session_id: "sess-a",
        timestamp: 1,
      });
      writeMarker("oc-b", {
        agent_type: "opencode",
        pid: 500,
        session_id: "sess-b",
        timestamp: 2,
      });
      writeMarker("oc-other-pid", {
        agent_type: "opencode",
        pid: 501,
        session_id: "sess-c",
        timestamp: 3,
      });
      writeMarker("claude-same-pid", {
        agent_type: "claude",
        pid: 500,
        tty: "/dev/ttys0",
        session_id: "claude-x",
        timestamp: 4,
      });
      refreshMarkerCache();

      const matches = manager
        .getMarkersByAgentAndPid("opencode", 500)
        .map((m) => m.session_id)
        .sort();
      expect(matches).toEqual(["sess-a", "sess-b"]);
    });

    it("returns an empty array when no marker matches", () => {
      expect(manager.getMarkersByAgentAndPid("opencode", 12345)).toEqual([]);
    });
  });
});
