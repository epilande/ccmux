import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AntigravityHookAdapter } from "./hook-adapter";
import type { HookManagerContext } from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import type { Session, TmuxPane } from "../../../types/session";

const root = join(
  tmpdir(),
  `ccmux-antigravity-adapter-${process.pid}-${Date.now()}`,
);
const hooksFile = join(root, "hooks.json");
const scriptsDir = join(root, "hooks");

interface FakeSession {
  id: string;
  agentType: string;
  trackingMode: "pane";
  tmuxPane: string;
  nativeSessionId?: string;
  state: Partial<Session>;
}

function marker(overrides: Partial<SessionPidMarker> = {}): SessionPidMarker {
  return {
    agent_type: "antigravity",
    pid: 9000,
    tty: "ttys001",
    session_id: "conversation-123",
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

function pane(paneId: string, panePid: number, tty: string | null): TmuxPane {
  return {
    paneId,
    panePid,
    sessionName: "test",
    windowIndex: 0,
    paneIndex: 0,
    target: `test:0.${paneId}`,
    tty,
    startTime: null,
    windowActivity: null,
    paneTitle: "agy",
    currentCommand: "agy",
    currentPath: "/tmp",
  };
}

function context(
  session: FakeSession,
  panes: TmuxPane[],
  pidPane: TmuxPane | null = null,
): HookManagerContext {
  return {
    sessionManager: {
      getSessions: () => [session] as unknown as Session[],
      setNativeSessionId: (_id: string, nativeId: string) => {
        session.nativeSessionId = nativeId;
        return true;
      },
      updateSession: (_id: string, patch: Partial<Session>) => {
        Object.assign(session.state, patch);
        return true;
      },
    } as unknown as HookManagerContext["sessionManager"],
    getLogWatcher: () => undefined,
    getLogWatchers: () => [],
    listProcesses: async () => [],
    listPanes: async () => panes,
    getPaneHostingPid: async () => pidPane,
  };
}

describe("AntigravityHookAdapter", () => {
  let adapter: AntigravityHookAdapter;

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    adapter = new AntigravityHookAdapter(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("installs scripts, preserves hooks, backs up, and is idempotent", async () => {
    writeFileSync(hooksFile, JSON.stringify({ user: { Stop: [] } }));
    const first = await adapter.install();
    expect(first.changed).toBe(true);
    expect(existsSync(`${hooksFile}.backup`)).toBe(true);
    const hooks = JSON.parse(readFileSync(hooksFile, "utf-8"));
    expect(hooks.user).toEqual({ Stop: [] });
    expect(Object.keys(hooks)).toEqual(["user", "ccmux"]);
    expect(hooks.ccmux.PreToolUse).toBeUndefined();
    expect(existsSync(join(scriptsDir, "ccmux-preinvocation.sh"))).toBe(true);
    expect(existsSync(join(scriptsDir, "ccmux-stop.sh"))).toBe(true);
    expect(adapter.isInstalled()).toBe(true);
    const second = await adapter.install();
    expect(second.changed).toBe(false);
  });

  it("refuses to clobber invalid JSON", async () => {
    writeFileSync(hooksFile, "not json");
    const result = await adapter.install();
    expect(result.changed).toBe(false);
    expect(result.lines[0]).toContain("Refused");
    expect(readFileSync(hooksFile, "utf-8")).toBe("not json");
  });

  it("uninstalls only ccmux files and key", async () => {
    writeFileSync(hooksFile, JSON.stringify({ user: { Stop: [] } }));
    await adapter.install();
    const result = await adapter.uninstall();
    expect(result.changed).toBe(true);
    expect(JSON.parse(readFileSync(hooksFile, "utf-8"))).toEqual({
      user: { Stop: [] },
    });
    expect(existsSync(join(scriptsDir, "ccmux-preinvocation.sh"))).toBe(false);
  });

  for (const [state, expectedStatus] of [
    ["working", "working"],
    ["idle", "idle"],
    ["waiting_permission", "waiting"],
  ] as const) {
    it(`projects ${state} marker state`, async () => {
      const session: FakeSession = {
        id: "session-1",
        agentType: "antigravity",
        trackingMode: "pane",
        tmuxPane: "%1",
        state: {},
      };
      await adapter.onMarkerAdded(
        marker({ state, pending_tool: "Command" }),
        context(session, [pane("%1", 111, "/dev/ttys001")]),
      );
      expect(session.nativeSessionId).toBe("conversation-123");
      expect(session.state.status).toBe(expectedStatus);
      if (state === "waiting_permission") {
        expect(session.state.attentionType).toBe("permission");
        expect(session.state.pendingTool).toBe("Command");
      }
    });
  }

  it("falls back to PID correlation and no-ops without a pane", async () => {
    const session: FakeSession = {
      id: "session-1",
      agentType: "antigravity",
      trackingMode: "pane",
      tmuxPane: "%2",
      state: {},
    };
    const hostingPane = pane("%2", 9000, null);
    await adapter.onMarkerAdded(
      marker({ tty: "unknown", state: "working" }),
      context(session, [], hostingPane),
    );
    expect(session.state.status).toBe("working");

    session.state = {};
    session.nativeSessionId = undefined;
    await adapter.onMarkerAdded(
      marker({ tty: "unknown", state: "working" }),
      context(session, [], null),
    );
    expect(session.nativeSessionId).toBeUndefined();
    expect(session.state.status).toBeUndefined();
  });
});
