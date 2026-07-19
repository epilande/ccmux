import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CopilotHookAdapter } from "./hook-adapter";
import type { HookManagerContext } from "../../hook-adapter";
import type { SessionPidMarker } from "../../session-markers";
import type { Session, TmuxPane } from "../../../types/session";

const root = join(
  tmpdir(),
  `ccmux-copilot-adapter-${process.pid}-${Date.now()}`,
);
const hooksDir = join(root, "hooks");
const scriptPath = join(hooksDir, "ccmux-copilot.sh");
const hooksJsonPath = join(hooksDir, "ccmux-copilot.json");

interface FakeSession {
  id: string;
  agentType: string;
  trackingMode: "pane";
  tmuxPane: string;
  nativeSessionId?: string;
  logPath?: string;
}

function marker(overrides: Partial<SessionPidMarker> = {}): SessionPidMarker {
  return {
    agent_type: "copilot",
    pid: 8000,
    tty: "ttys010",
    session_id: "sess-abc",
    transcript_path: "/tmp/.copilot/session-state/sess-abc/events.jsonl",
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
    paneTitle: "copilot",
    currentCommand: "copilot",
    currentPath: "/tmp",
  };
}

function context(
  session: FakeSession,
  panes: TmuxPane[],
  pidPane: TmuxPane | null = null,
): { ctx: HookManagerContext; processedPaths: string[] } {
  const processedPaths: string[] = [];
  const ctx: HookManagerContext = {
    sessionManager: {
      getSessions: () => [session] as unknown as Session[],
      setNativeSessionId: (_id: string, nativeId: string) => {
        session.nativeSessionId = nativeId;
        return "ok";
      },
      setLogPath: (_id: string, path: string) => {
        session.logPath = path;
        return true;
      },
    } as unknown as HookManagerContext["sessionManager"],
    getLogWatcher: () =>
      ({
        processPath: async (path: string) => {
          processedPaths.push(path);
        },
      }) as unknown as ReturnType<HookManagerContext["getLogWatcher"]>,
    getLogWatchers: () => [],
    listProcesses: async () => [],
    listPanes: async () => panes,
    getPaneHostingPid: async () => pidPane,
  };
  return { ctx, processedPaths };
}

describe("CopilotHookAdapter", () => {
  let adapter: CopilotHookAdapter;

  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    adapter = new CopilotHookAdapter(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("installs the script + hooks JSON, is idempotent, and self-reports installed", async () => {
    const first = await adapter.install();
    expect(first.changed).toBe(true);
    expect(existsSync(scriptPath)).toBe(true);
    expect(existsSync(hooksJsonPath)).toBe(true);
    const json = JSON.parse(readFileSync(hooksJsonPath, "utf-8"));
    expect(Object.keys(json.hooks).sort()).toEqual([
      "agentStop",
      "notification",
      "sessionEnd",
      "sessionStart",
      "userPromptSubmitted",
    ]);
    expect(json.hooks.permissionRequest).toBeUndefined();
    expect(adapter.isInstalled()).toBe(true);
    const second = await adapter.install();
    expect(second.changed).toBe(false);
  });

  it("preserves unrelated files in the drop-in dir on install and uninstall", async () => {
    mkdirSync(hooksDir, { recursive: true });
    const foreign = join(hooksDir, "someone-elses.json");
    writeFileSync(foreign, '{"version":1}');
    await adapter.install();
    expect(existsSync(foreign)).toBe(true);
    const result = await adapter.uninstall();
    expect(result.changed).toBe(true);
    expect(existsSync(scriptPath)).toBe(false);
    expect(existsSync(hooksJsonPath)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
  });

  it("flags a version-skewed script as an anomaly", async () => {
    await adapter.install();
    writeFileSync(scriptPath, "#!/bin/bash\n# not the ccmux script\n");
    expect(adapter.describeInstallAnomalies()).toHaveLength(1);
  });

  it("enriches a pane-tracked session by TTY match", async () => {
    const session: FakeSession = {
      id: "session-1",
      agentType: "copilot",
      trackingMode: "pane",
      tmuxPane: "%1",
    };
    const { ctx, processedPaths } = context(session, [
      pane("%1", 111, "/dev/ttys010"),
    ]);
    await adapter.onMarkerAdded(marker(), ctx);
    expect(session.nativeSessionId).toBe("sess-abc");
    expect(session.logPath).toBe(
      "/tmp/.copilot/session-state/sess-abc/events.jsonl",
    );
    expect(processedPaths).toEqual([
      "/tmp/.copilot/session-state/sess-abc/events.jsonl",
    ]);
  });

  it("falls back to PID correlation and no-ops without a pane", async () => {
    const session: FakeSession = {
      id: "session-2",
      agentType: "copilot",
      trackingMode: "pane",
      tmuxPane: "%2",
    };
    const hostingPane = pane("%2", 8000, null);
    const first = context(session, [], hostingPane);
    await adapter.onMarkerAdded(marker({ tty: "unknown" }), first.ctx);
    expect(session.nativeSessionId).toBe("sess-abc");

    session.nativeSessionId = undefined;
    const second = context(session, [], null);
    await adapter.onMarkerAdded(marker({ tty: "unknown" }), second.ctx);
    expect(session.nativeSessionId).toBeUndefined();
  });

  it("skips enrichment when setNativeSessionId conflicts", async () => {
    const session: FakeSession = {
      id: "session-3",
      agentType: "copilot",
      trackingMode: "pane",
      tmuxPane: "%3",
    };
    const { ctx, processedPaths } = context(session, [
      pane("%3", 111, "/dev/ttys010"),
    ]);
    (
      ctx.sessionManager as unknown as { setNativeSessionId: () => string }
    ).setNativeSessionId = () => "conflict";
    await adapter.onMarkerAdded(marker(), ctx);
    expect(session.logPath).toBeUndefined();
    expect(processedPaths).toEqual([]);
  });
});
