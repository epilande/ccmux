import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildCopilotHooksFile,
  COPILOT_MARKER_SCRIPT,
  renderCopilotHooksJson,
} from "./hook-scripts";

const root = join(
  tmpdir(),
  `ccmux-copilot-scripts-${process.pid}-${Date.now()}`,
);
const scriptPath = join(root, "ccmux-copilot.sh");

function markerPath(sessionId: string): string {
  return join(root, "session-pids", `copilot-${sessionId}.json`);
}

async function runEvent(event: string, payload: unknown): Promise<string> {
  const proc = Bun.spawn(["bash", scriptPath, event], {
    env: { ...process.env, CCMUX_HOME: root },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return stdout;
}

describe("Copilot hook scripts", () => {
  beforeEach(() => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(scriptPath, COPILOT_MARKER_SCRIPT, { mode: 0o755 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses the safe marker contract and never the deciding permissionRequest hook", () => {
    expect(COPILOT_MARKER_SCRIPT).toContain(
      "${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids",
    );
    expect(COPILOT_MARKER_SCRIPT).toContain(
      'mv "$MARKER_FILE.tmp" "$MARKER_FILE"',
    );
    expect(COPILOT_MARKER_SCRIPT).toContain("# ccmux-copilot-hook v1");
    // The script is a passive marker writer: it must never emit a decision
    // (an allow/deny) nor write anything to stdout.
    expect(COPILOT_MARKER_SCRIPT).not.toContain('"decision"');
    expect(COPILOT_MARKER_SCRIPT).not.toContain("echo");
    expect(COPILOT_MARKER_SCRIPT.trimEnd().endsWith("exit 0")).toBe(true);
  });

  it("creates a working marker on session-start with an initial prompt", async () => {
    const stdout = await runEvent("session-start", {
      sessionId: "sess-1",
      cwd: "/tmp/x",
      initialPrompt: "do the thing",
    });
    expect(stdout).toBe("");
    const marker = JSON.parse(readFileSync(markerPath("sess-1"), "utf-8"));
    expect(marker.agent_type).toBe("copilot");
    expect(marker.session_id).toBe("sess-1");
    expect(marker.state).toBe("working");
    expect(marker.transcript_path).toContain(
      "/.copilot/session-state/sess-1/events.jsonl",
    );
    expect(marker.pid).toBeNumber();
  });

  it("creates an idle marker on session-start without an initial prompt", async () => {
    await runEvent("session-start", { sessionId: "sess-2", cwd: "/tmp/x" });
    const marker = JSON.parse(readFileSync(markerPath("sess-2"), "utf-8"));
    expect(marker.state).toBe("idle");
  });

  it("flips to waiting_permission on a permission_prompt notification", async () => {
    await runEvent("session-start", { sessionId: "sess-3", cwd: "/tmp/x" });
    await runEvent("notification", {
      sessionId: "sess-3",
      notification_type: "permission_prompt",
      title: "Permission needed",
      message: "Run command: touch probe.txt",
    });
    const marker = JSON.parse(readFileSync(markerPath("sess-3"), "utf-8"));
    expect(marker.state).toBe("waiting_permission");
    expect(marker.pending_tool).toBe("Command");
    expect(marker.permission_context).toBe("Run command: touch probe.txt");
  });

  it("ignores notifications that are not attention dialogs", async () => {
    await runEvent("notification", {
      sessionId: "sess-4",
      notification_type: "agent_idle",
      message: "idle",
    });
    expect(existsSync(markerPath("sess-4"))).toBe(false);
  });

  it("clears pending state back to idle on stop", async () => {
    await runEvent("session-start", { sessionId: "sess-5", cwd: "/tmp/x" });
    await runEvent("notification", {
      sessionId: "sess-5",
      notification_type: "permission_prompt",
      message: "Run command: rm x",
    });
    await runEvent("stop", { sessionId: "sess-5", stopReason: "end_turn" });
    const marker = JSON.parse(readFileSync(markerPath("sess-5"), "utf-8"));
    expect(marker.state).toBe("idle");
    expect(marker.pending_tool).toBeNull();
    expect(marker.permission_context).toBeNull();
  });

  it("removes the marker on sessionEnd", async () => {
    await runEvent("session-start", { sessionId: "sess-6", cwd: "/tmp/x" });
    expect(existsSync(markerPath("sess-6"))).toBe(true);
    await runEvent("end", { sessionId: "sess-6" });
    expect(existsSync(markerPath("sess-6"))).toBe(false);
  });

  it("exits without a marker when sessionId is missing", async () => {
    await runEvent("session-start", { cwd: "/tmp/x" });
    expect(existsSync(join(root, "session-pids"))).toBe(false);
  });

  describe("hooks JSON", () => {
    it("registers the observational events against the script and omits permissionRequest", () => {
      const file = buildCopilotHooksFile("/abs/ccmux-copilot.sh");
      expect(file.version).toBe(1);
      expect(Object.keys(file.hooks).sort()).toEqual([
        "agentStop",
        "notification",
        "sessionEnd",
        "sessionStart",
        "userPromptSubmitted",
      ]);
      expect(file.hooks.permissionRequest).toBeUndefined();
      expect(file.hooks.sessionStart[0].bash).toBe(
        '"/abs/ccmux-copilot.sh" session-start',
      );
      expect(file.hooks.notification[0].type).toBe("command");
    });

    it("serializes to trailing-newline JSON", () => {
      const json = renderCopilotHooksJson("/abs/ccmux-copilot.sh");
      expect(json.endsWith("\n")).toBe(true);
      expect(JSON.parse(json).hooks.agentStop[0].bash).toContain("stop");
    });
  });
});
