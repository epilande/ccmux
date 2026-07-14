import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  SESSION_START_HOOK_SCRIPT,
  SESSION_END_HOOK_SCRIPT,
  STATE_NOTIFY_HOOK_SCRIPT,
} from "./hook-scripts";

// The exact runtime template every Claude hook now uses to resolve its markers dir.
// Single-quoted so the `${...}`/`$HOME` are literal (no TS interpolation). This is the
// behavior under test: the dir is resolved from $CCMUX_HOME at hook RUNTIME, not baked
// in at install time, so one installed hook serves both normal use and an isolated home.
const RUNTIME_MARKERS_DIR =
  'MARKERS_DIR="${CCMUX_HOME:-$HOME/.config/ccmux}/session-pids"';

interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

describe("claude hook script templates", () => {
  describe.each([
    ["ccmux-session-start.sh", SESSION_START_HOOK_SCRIPT],
    ["ccmux-session-end.sh", SESSION_END_HOOK_SCRIPT],
    ["ccmux-state-notify.sh", STATE_NOTIFY_HOOK_SCRIPT],
  ] as const)("%s", (_name, script) => {
    it("resolves the markers dir from CCMUX_HOME at runtime", () => {
      expect(script).toContain(RUNTIME_MARKERS_DIR);
    });

    it("does not bake a compile-time markers path", () => {
      // Pre-change scripts inlined an absolute MARKERS_DIR from config at build time.
      // Guard against a regression that reintroduces a literal (non-`$`) home path.
      expect(script).not.toMatch(/^MARKERS_DIR="\/[^$]/m);
    });

    it("starts with a bash shebang", () => {
      expect(script.startsWith("#!/bin/bash")).toBe(true);
    });
  });

  it("session-start writes a claude- marker via atomic tmp+mv", () => {
    expect(SESSION_START_HOOK_SCRIPT).toContain(
      'MARKER_FILE="$MARKERS_DIR/claude-$SESSION_ID.json"',
    );
    expect(SESSION_START_HOOK_SCRIPT).toContain(
      'mv "$MARKER_FILE.tmp" "$MARKER_FILE"',
    );
    expect(SESSION_START_HOOK_SCRIPT).toContain('agent_type: "claude"');
  });
});

describe("claude hook script execution (requires bash + jq)", () => {
  let tempRoot: string;
  let scriptPath: string;

  beforeEach(() => {
    tempRoot = join(
      tmpdir(),
      `ccmux-claude-script-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(tempRoot, { recursive: true });
    scriptPath = join(tempRoot, "hook.sh");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeScript(content: string): void {
    writeFileSync(scriptPath, content, { mode: 0o755 });
  }

  async function runScript(
    stdin: string,
    env: Record<string, string | undefined>,
  ): Promise<ScriptResult> {
    const proc = Bun.spawn(["/bin/bash", scriptPath], {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }

  it("session-start writes the marker under $CCMUX_HOME/session-pids when CCMUX_HOME is set", async () => {
    writeScript(SESSION_START_HOOK_SCRIPT);
    const ccmuxHome = join(tempRoot, "isolated-home");
    const result = await runScript(
      JSON.stringify({
        session_id: "sid-isolated",
        hook_event_name: "SessionStart",
      }),
      { ...process.env, CCMUX_HOME: ccmuxHome, HOME: join(tempRoot, "real") },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");

    const markerFile = join(
      ccmuxHome,
      "session-pids",
      "claude-sid-isolated.json",
    );
    expect(existsSync(markerFile)).toBe(true);
    const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
    expect(marker.agent_type).toBe("claude");
    expect(marker.session_id).toBe("sid-isolated");
    expect(marker.state).toBe("idle");
  });

  it("session-start falls back to $HOME/.config/ccmux/session-pids when CCMUX_HOME is unset", async () => {
    writeScript(SESSION_START_HOOK_SCRIPT);
    const fakeHome = join(tempRoot, "real");
    const result = await runScript(
      JSON.stringify({
        session_id: "sid-default",
        hook_event_name: "SessionStart",
      }),
      // CCMUX_HOME: undefined makes Bun.spawn unset it even if the dev's shell exports one.
      { ...process.env, HOME: fakeHome, CCMUX_HOME: undefined },
    );
    expect(result.exitCode).toBe(0);

    const markerFile = join(
      fakeHome,
      ".config",
      "ccmux",
      "session-pids",
      "claude-sid-default.json",
    );
    expect(existsSync(markerFile)).toBe(true);
  });

  it("session-end removes the marker under $CCMUX_HOME/session-pids", async () => {
    writeScript(SESSION_END_HOOK_SCRIPT);
    const ccmuxHome = join(tempRoot, "isolated-home");
    const markersDir = join(ccmuxHome, "session-pids");
    mkdirSync(markersDir, { recursive: true });
    const markerFile = join(markersDir, "claude-sid-end.json");
    writeFileSync(markerFile, JSON.stringify({ session_id: "sid-end" }));

    const result = await runScript(
      JSON.stringify({ session_id: "sid-end", hook_event_name: "SessionEnd" }),
      { ...process.env, CCMUX_HOME: ccmuxHome },
    );
    expect(result.exitCode).toBe(0);
    expect(existsSync(markerFile)).toBe(false);
  });

  it("state-notify creates the marker under $CCMUX_HOME/session-pids with the mapped state", async () => {
    writeScript(STATE_NOTIFY_HOOK_SCRIPT);
    const ccmuxHome = join(tempRoot, "isolated-home");
    const result = await runScript(
      JSON.stringify({
        session_id: "sid-notify",
        notification_type: "permission_prompt",
      }),
      { ...process.env, CCMUX_HOME: ccmuxHome },
    );
    expect(result.exitCode).toBe(0);

    const markerFile = join(
      ccmuxHome,
      "session-pids",
      "claude-sid-notify.json",
    );
    expect(existsSync(markerFile)).toBe(true);
    const marker = JSON.parse(readFileSync(markerFile, "utf-8"));
    expect(marker.agent_type).toBe("claude");
    expect(marker.state).toBe("waiting_permission");
  });

  /** Run state-notify against a fresh marker and return the parsed result. */
  async function runStateNotify(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    writeScript(STATE_NOTIFY_HOOK_SCRIPT);
    const ccmuxHome = join(tempRoot, "isolated-home");
    const result = await runScript(JSON.stringify(payload), {
      ...process.env,
      CCMUX_HOME: ccmuxHome,
    });
    expect(result.exitCode).toBe(0);
    const markerFile = join(
      ccmuxHome,
      "session-pids",
      `claude-${payload.session_id}.json`,
    );
    expect(existsSync(markerFile)).toBe(true);
    return JSON.parse(readFileSync(markerFile, "utf-8"));
  }

  it("state-notify parses the tool name out of a permission message", async () => {
    const marker = await runStateNotify({
      session_id: "sid-tool",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    });
    expect(marker.state).toBe("waiting_permission");
    expect(marker.pending_tool).toBe("Bash");
  });

  it("state-notify preserves an mcp__ tool name", async () => {
    const marker = await runStateNotify({
      session_id: "sid-mcp",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use mcp__github__create_issue",
    });
    expect(marker.pending_tool).toBe("mcp__github__create_issue");
  });

  it("state-notify leaves pending_tool null when the message has no tool", async () => {
    const marker = await runStateNotify({
      session_id: "sid-noshape",
      notification_type: "permission_prompt",
      message: "something unexpected with no parseable tool",
    });
    expect(marker.state).toBe("waiting_permission");
    expect(marker.pending_tool).toBeNull();
  });

  it("state-notify clears pending_tool on an idle_prompt", async () => {
    const marker = await runStateNotify({
      session_id: "sid-idle",
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });
    expect(marker.state).toBe("idle");
    expect(marker.pending_tool).toBeNull();
  });
});
