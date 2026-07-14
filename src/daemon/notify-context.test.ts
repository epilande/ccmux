import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNotificationContext,
  type NotifyContextSession,
} from "./notify-context";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-notify-ctx-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write JSONL lines to a transcript file and return its path. */
async function writeTranscript(lines: object[]): Promise<string> {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  await Bun.write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

function assistantToolUse(name: string, input: Record<string, unknown>) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name, input }],
    },
    timestamp: "2024-01-15T12:00:00Z",
  };
}

function assistantText(text: string) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: "2024-01-15T12:00:00Z",
  };
}

function permissionSession(
  logPath: string | null,
  pendingTool: string | null = "Bash",
): NotifyContextSession {
  return {
    agentType: "claude",
    logPath,
    attentionType: "permission",
    pendingTool,
  };
}

describe("buildNotificationContext: permission", () => {
  it("renders a Bash tool_use as the command", async () => {
    const path = await writeTranscript([
      assistantText("let me look"),
      assistantToolUse("Bash", {
        command: "rm -rf /tmp/x",
        description: "clean",
      }),
    ]);
    expect(await buildNotificationContext(permissionSession(path))).toBe(
      "Bash: rm -rf /tmp/x",
    );
  });

  it("renders an Edit tool_use as the file_path", async () => {
    const path = await writeTranscript([
      assistantToolUse("Edit", {
        file_path: "/repo/src/index.ts",
        old_string: "a",
        new_string: "b",
      }),
    ]);
    expect(
      await buildNotificationContext(permissionSession(path, "Edit")),
    ).toBe("Edit: /repo/src/index.ts");
  });

  it("falls back to the longest string field for an unknown tool", async () => {
    const path = await writeTranscript([
      assistantToolUse("MysteryTool", {
        short: "x",
        detail: "the longest descriptive value here",
        n: 5,
      }),
    ]);
    expect(
      await buildNotificationContext(permissionSession(path, "MysteryTool")),
    ).toBe("MysteryTool: the longest descriptive value here");
  });

  it("uses the newest tool_use matching the pending tool", async () => {
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "first" }),
      assistantToolUse("Bash", { command: "second" }),
    ]);
    expect(await buildNotificationContext(permissionSession(path))).toBe(
      "Bash: second",
    );
  });

  it("clamps a long command with an ellipsis", async () => {
    const long = "echo " + "y".repeat(400);
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: long }),
    ]);
    const out = await buildNotificationContext(permissionSession(path));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual("Bash: ".length + 301);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("returns null when there is no tool_use", async () => {
    const path = await writeTranscript([assistantText("just talking")]);
    expect(await buildNotificationContext(permissionSession(path))).toBeNull();
  });

  it("ignores malformed lines and still finds a valid tool_use", async () => {
    const path = join(dir, "mixed.jsonl");
    await Bun.write(
      path,
      "not json at all\n" +
        JSON.stringify(assistantToolUse("Bash", { command: "ok" })) +
        "\n{ broken\n",
    );
    expect(await buildNotificationContext(permissionSession(path))).toBe(
      "Bash: ok",
    );
  });
});

describe("buildNotificationContext: pending-tool matching", () => {
  it("describes the pending tool, not a newer unrelated tool_use", async () => {
    // The pending permission is for the Bash call, but a later (already
    // resolved) Read is the last tool_use in the transcript. The body must
    // describe the Bash command being approved — never the Read.
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "rm -rf /important" }),
      assistantToolUse("Read", { file_path: "/etc/hosts" }),
    ]);
    expect(
      await buildNotificationContext(permissionSession(path, "Bash")),
    ).toBe("Bash: rm -rf /important");
  });

  it("returns null when no tool_use matches the pending tool", async () => {
    // Rather than fall back to a wrong tool's detail, render nothing (the
    // caller keeps the bare "Needs permission: <tool>" line).
    const path = await writeTranscript([
      assistantToolUse("Read", { file_path: "/safe.ts" }),
    ]);
    expect(
      await buildNotificationContext(permissionSession(path, "Bash")),
    ).toBeNull();
  });

  it("returns null when the pending tool is unknown", async () => {
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "echo hi" }),
    ]);
    expect(
      await buildNotificationContext(permissionSession(path, null)),
    ).toBeNull();
  });
});

describe("buildNotificationContext: question", () => {
  it("renders the last assistant text", async () => {
    const path = await writeTranscript([
      assistantText("first"),
      assistantText("which option do you prefer?"),
    ]);
    expect(
      await buildNotificationContext({
        agentType: "claude",
        logPath: path,
        attentionType: "question",
        pendingTool: null,
      }),
    ).toBe("which option do you prefer?");
  });

  it("returns null when there is no assistant text", async () => {
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "x" }),
    ]);
    expect(
      await buildNotificationContext({
        agentType: "claude",
        logPath: path,
        attentionType: "question",
        pendingTool: null,
      }),
    ).toBeNull();
  });
});

describe("buildNotificationContext: gating", () => {
  it("returns null for a non-claude agent", async () => {
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "x" }),
    ]);
    expect(
      await buildNotificationContext({
        agentType: "codex",
        logPath: path,
        attentionType: "permission",
        pendingTool: "Bash",
      }),
    ).toBeNull();
  });

  it("returns null when logPath is absent", async () => {
    expect(await buildNotificationContext(permissionSession(null))).toBeNull();
  });

  it("returns null for a plan_approval wait", async () => {
    const path = await writeTranscript([
      assistantToolUse("Bash", { command: "x" }),
    ]);
    expect(
      await buildNotificationContext({
        agentType: "claude",
        logPath: path,
        attentionType: "plan_approval",
        pendingTool: "Bash",
      }),
    ).toBeNull();
  });

  it("returns null when the file does not exist (fail-open)", async () => {
    expect(
      await buildNotificationContext(
        permissionSession(join(dir, "nope.jsonl")),
      ),
    ).toBeNull();
  });
});
