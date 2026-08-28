import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  renderSessionStartScript,
  renderSessionEndScript,
  renderBeforeSubmitPromptScript,
  renderStopScript,
} from "./hook-scripts";

interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runScript(
  scriptPath: string,
  stdin: string,
): Promise<ScriptResult> {
  const proc = Bun.spawn(["/bin/bash", scriptPath], {
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("cursor hook script templates", () => {
  const markersDir = "/tmp/ccmux-cursor-marker-dir-never-used";

  describe("renderSessionStartScript", () => {
    it("interpolates the markers directory path", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain(`MARKERS_DIR="${markersDir}"`);
    });

    it("keys the marker on conversation_id", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain(".conversation_id");
      expect(script).toContain(`"$MARKERS_DIR/cursor-$CONVERSATION_ID.json"`);
    });

    it("writes the marker via atomic tmp+mv with cursor- prefix", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain(`"$MARKER_FILE.tmp"`);
      expect(script).toContain(`mv "$MARKER_FILE.tmp" "$MARKER_FILE"`);
    });

    it("records agent_type cursor and initial idle state", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain(`agent_type: "cursor"`);
      expect(script).toContain(`state: "idle"`);
    });

    it("walks the ancestry for cursor-agent or bare agent", () => {
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain("cursor-agent|*/cursor-agent|agent|*/agent");
      expect(script).toContain("CURSOR_PID=");
    });

    it("falls back to a tty-bearing ancestor when comm is not cursor-agent", () => {
      // Regression: cursor-agent 2026.08.25 reports comm=MainThread, so the
      // comm walk misses it. The first ancestor with a real controlling
      // terminal is what resolves the live agent pid instead of the dead
      // $PPID wrapper.
      const script = renderSessionStartScript(markersDir);
      expect(script).toContain("CURSOR_TTY_PID");
      expect(script).toContain('!= "?"');
    });
  });

  describe("renderSessionEndScript", () => {
    it("unlinks the marker file", () => {
      const script = renderSessionEndScript(markersDir);
      expect(script).toContain(
        `rm -f "$MARKERS_DIR/cursor-$CONVERSATION_ID.json"`,
      );
    });

    it("keys on conversation_id", () => {
      const script = renderSessionEndScript(markersDir);
      expect(script).toContain(".conversation_id");
    });
  });

  describe("renderBeforeSubmitPromptScript", () => {
    it("sets state to working", () => {
      const script = renderBeforeSubmitPromptScript(markersDir);
      expect(script).toContain(`state: "working"`);
    });

    it("records last_prompt capped at 1024 bytes", () => {
      const script = renderBeforeSubmitPromptScript(markersDir);
      expect(script).toContain("head -c 1024");
      expect(script).toContain("last_prompt:");
    });

    it("creates the marker if missing (covers --resume)", () => {
      const script = renderBeforeSubmitPromptScript(markersDir);
      // Full body includes identity fields (agent_type, pid, session_id) not
      // just a merge; that's how we cover the no-sessionStart resume path.
      expect(script).toContain(`agent_type: "cursor"`);
      expect(script).toContain("pid: ($pid|tonumber)");
    });
  });

  describe("renderStopScript", () => {
    it("sets state to idle", () => {
      const script = renderStopScript(markersDir);
      expect(script).toContain(`state: "idle"`);
    });

    it("creates the marker if missing (covers --resume)", () => {
      const script = renderStopScript(markersDir);
      expect(script).toContain(`agent_type: "cursor"`);
      expect(script).toContain("pid: ($pid|tonumber)");
    });
  });

  describe.each([
    ["ccmux-session-start.sh", renderSessionStartScript],
    ["ccmux-session-end.sh", renderSessionEndScript],
    ["ccmux-before-submit-prompt.sh", renderBeforeSubmitPromptScript],
    ["ccmux-stop.sh", renderStopScript],
  ] as const)("static safety checks (%s)", (_name, render) => {
    const script = render(markersDir);
    const executableLines = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    it("does not use `set -e`", () => {
      expect(executableLines).not.toMatch(/^\s*set\s+-[a-z]*e/m);
    });

    it("does not emit `exit 2`", () => {
      expect(executableLines).not.toMatch(/exit\s+2\b/);
    });

    it("starts with a bash shebang", () => {
      expect(script.startsWith("#!/bin/bash")).toBe(true);
    });

    it("ends with an explicit `exit 0`", () => {
      expect(script.trimEnd().endsWith("exit 0")).toBe(true);
    });
  });
});

describe("cursor hook script execution (requires bash + jq)", () => {
  let tempRoot: string;
  let markersDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tempRoot = join(
      tmpdir(),
      `ccmux-cursor-script-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    markersDir = join(tempRoot, "markers");
    mkdirSync(markersDir, { recursive: true });
    scriptPath = join(tempRoot, "hook.sh");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeScript(content: string): void {
    writeFileSync(scriptPath, content, { mode: 0o755 });
  }

  describe("ccmux-session-start.sh", () => {
    it("writes a marker file for a valid payload", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const input = JSON.stringify({
        conversation_id: "b79e222a-6c21-4738-be97-f012cb701d6a",
        generation_id: "b79e222a-6c21-4738-be97-f012cb701d6a",
        session_id: "b79e222a-6c21-4738-be97-f012cb701d6a",
        hook_event_name: "sessionStart",
        cursor_version: "2026.04.17-787b533",
        workspace_roots: ["/tmp"],
        transcript_path: null,
      });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");

      const markerFile = join(
        markersDir,
        "cursor-b79e222a-6c21-4738-be97-f012cb701d6a.json",
      );
      expect(existsSync(markerFile)).toBe(true);
      const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
      expect(marker.agent_type).toBe("cursor");
      expect(marker.session_id).toBe("b79e222a-6c21-4738-be97-f012cb701d6a");
      expect(marker.state).toBe("idle");
      expect(marker.transcript_path).toBeNull();
      expect(typeof marker.pid).toBe("number");
      expect(typeof marker.timestamp).toBe("number");
    });

    it("populates transcript_path when present", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const input = JSON.stringify({
        conversation_id: "xyz",
        transcript_path: "/tmp/transcript.jsonl",
      });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      const marker = JSON.parse(
        readFileSync(join(markersDir, "cursor-xyz.json"), "utf-8"),
      );
      expect(marker.transcript_path).toBe("/tmp/transcript.jsonl");
    });

    it("exits 0 with empty stdout on empty stdin", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const result = await runScript(scriptPath, "");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 with empty stdout on malformed JSON stdin", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const result = await runScript(scriptPath, "not json {{{");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 without writing when conversation_id is missing", async () => {
      writeScript(renderSessionStartScript(markersDir));
      const result = await runScript(scriptPath, JSON.stringify({ foo: 1 }));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("ccmux-session-end.sh", () => {
    it("removes an existing marker file", async () => {
      writeScript(renderSessionEndScript(markersDir));
      const markerFile = join(markersDir, "cursor-abc.json");
      writeFileSync(markerFile, "{}");
      const result = await runScript(
        scriptPath,
        JSON.stringify({ conversation_id: "abc" }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(existsSync(markerFile)).toBe(false);
    });

    it("is a no-op when the marker is already gone", async () => {
      writeScript(renderSessionEndScript(markersDir));
      const result = await runScript(
        scriptPath,
        JSON.stringify({ conversation_id: "ghost" }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 on empty stdin", async () => {
      writeScript(renderSessionEndScript(markersDir));
      const result = await runScript(scriptPath, "");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 on malformed JSON", async () => {
      writeScript(renderSessionEndScript(markersDir));
      const result = await runScript(scriptPath, "garbage");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("ccmux-before-submit-prompt.sh", () => {
    it("creates a marker with state=working and last_prompt on first fire", async () => {
      writeScript(renderBeforeSubmitPromptScript(markersDir));
      const input = JSON.stringify({
        conversation_id: "resume-test",
        prompt: "please list the files",
      });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const marker = JSON.parse(
        readFileSync(join(markersDir, "cursor-resume-test.json"), "utf-8"),
      );
      expect(marker.agent_type).toBe("cursor");
      expect(marker.state).toBe("working");
      expect(marker.last_prompt).toBe("please list the files");
      expect(marker.session_id).toBe("resume-test");
    });

    it("caps the prompt at 1024 bytes", async () => {
      writeScript(renderBeforeSubmitPromptScript(markersDir));
      const longPrompt = "a".repeat(2000);
      const input = JSON.stringify({
        conversation_id: "long",
        prompt: longPrompt,
      });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      const marker = JSON.parse(
        readFileSync(join(markersDir, "cursor-long.json"), "utf-8"),
      );
      expect(marker.last_prompt.length).toBe(1024);
      expect(marker.last_prompt).toBe("a".repeat(1024));
    });

    it("stores last_prompt as null when prompt is absent or empty", async () => {
      writeScript(renderBeforeSubmitPromptScript(markersDir));
      const result = await runScript(
        scriptPath,
        JSON.stringify({ conversation_id: "no-prompt" }),
      );
      expect(result.exitCode).toBe(0);
      const marker = JSON.parse(
        readFileSync(join(markersDir, "cursor-no-prompt.json"), "utf-8"),
      );
      expect(marker.last_prompt).toBeNull();
    });

    it("exits 0 with empty stdout on malformed JSON", async () => {
      writeScript(renderBeforeSubmitPromptScript(markersDir));
      const result = await runScript(scriptPath, "{not valid");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 with empty stdout when conversation_id is missing", async () => {
      writeScript(renderBeforeSubmitPromptScript(markersDir));
      const result = await runScript(
        scriptPath,
        JSON.stringify({ prompt: "hi" }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("ccmux-stop.sh", () => {
    it("writes a marker with state=idle", async () => {
      writeScript(renderStopScript(markersDir));
      const input = JSON.stringify({
        conversation_id: "stop-test",
        transcript_path: "/tmp/t.jsonl",
      });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      const marker = JSON.parse(
        readFileSync(join(markersDir, "cursor-stop-test.json"), "utf-8"),
      );
      expect(marker.state).toBe("idle");
      expect(marker.transcript_path).toBe("/tmp/t.jsonl");
    });

    it("creates the marker if it does not already exist", async () => {
      writeScript(renderStopScript(markersDir));
      const input = JSON.stringify({ conversation_id: "new-on-stop" });
      const result = await runScript(scriptPath, input);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(markersDir, "cursor-new-on-stop.json"))).toBe(
        true,
      );
    });

    it("exits 0 on empty stdin", async () => {
      writeScript(renderStopScript(markersDir));
      const result = await runScript(scriptPath, "");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("exits 0 on malformed JSON", async () => {
      writeScript(renderStopScript(markersDir));
      const result = await runScript(scriptPath, "garbage");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });
});
