import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  PREINVOCATION_HOOK_SCRIPT,
  STOP_HOOK_SCRIPT,
} from "./hook-scripts";

const root = join(tmpdir(), `ccmux-antigravity-scripts-${process.pid}`);

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Antigravity hook scripts", () => {
  it("use the safe marker contract and never hook tool events", () => {
    for (const script of [PREINVOCATION_HOOK_SCRIPT, STOP_HOOK_SCRIPT]) {
      expect(script).toContain("${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids");
      expect(script).toContain(".conversationId // empty");
      expect(script).toContain(".transcriptPath // empty");
      expect(script).toContain('mv "$MARKER_FILE.tmp" "$MARKER_FILE"');
      expect(script).not.toContain("PreToolUse");
      expect(script).not.toContain("PostToolUse");
      expect(script.trimEnd().endsWith("echo '{}'\nexit 0")).toBe(true);
    }
  });

  it("creates and updates markers end to end", async () => {
    mkdirSync(root, { recursive: true });
    const scriptPath = join(root, "hook.sh");
    const conversationId = "conversation-123";
    const transcriptPath = "/tmp/transcript_full.jsonl";
    const input = JSON.stringify({ conversationId, transcriptPath });

    for (const [script, state] of [
      [PREINVOCATION_HOOK_SCRIPT, "working"],
      [STOP_HOOK_SCRIPT, "idle"],
    ] as const) {
      writeFileSync(scriptPath, script, { mode: 0o755 });
      const proc = Bun.spawn(["bash", scriptPath], {
        env: { ...process.env, CCMUX_HOME: root },
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await new Response(proc.stdout).text()).toBe("{}\n");
      expect(await proc.exited).toBe(0);
      const markerPath = join(
        root,
        "session-pids",
        `antigravity-${conversationId}.json`,
      );
      expect(existsSync(markerPath)).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, "utf-8"));
      expect(marker.agent_type).toBe("antigravity");
      expect(marker.session_id).toBe(conversationId);
      expect(marker.state).toBe(state);
      expect(marker.transcript_path).toBe(transcriptPath);
      expect(marker.pid).toBeNumber();
      expect(marker.timestamp).toBeNumber();
    }
  });
});
