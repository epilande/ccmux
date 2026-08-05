import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { classifyClaudeLine } from "./claude";
import { classifyCodexLine } from "./codex";
import { classifyCopilotLine } from "./copilot";
import { BUILTIN_TRANSCRIPT_READERS, readSessionTranscript } from "./index";
import type { TranscriptSession } from "../transcript-read";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-readers-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, entries: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

function session(agentType: string, logPath: string | null): TranscriptSession {
  return { id: "s1", agentType, logPath, cwd: "/tmp/proj" };
}

describe("claude reader", () => {
  it("collects text blocks and ignores thinking / tool_use", () => {
    expect(
      classifyClaudeLine({
        type: "assistant",
        timestamp: "2024-01-15T12:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "hello" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
      }),
    ).toEqual({
      kind: "assistant",
      text: "hello",
      timestamp: "2024-01-15T12:00:00Z",
    });
  });

  it("treats string user content as a turn boundary and array content as a tool result", () => {
    expect(
      classifyClaudeLine({
        type: "user",
        message: { content: "do the thing" },
      }),
    ).toEqual({ kind: "user", text: "do the thing", timestamp: undefined });
    expect(
      classifyClaudeLine({
        type: "user",
        message: { content: [{ type: "tool_result", content: "output" }] },
      }),
    ).toEqual({ kind: "skip" });
  });

  it("skips sidecar line types and malformed lines without throwing", () => {
    for (const entry of [
      null,
      42,
      "string",
      { type: "mode" },
      { type: "last-prompt", prompt: "x" },
      { type: "file-history-snapshot" },
      { type: "assistant" },
      { type: "assistant", message: { content: "not an array" } },
      { type: "assistant", message: { content: [{ type: "text", text: "" }] } },
    ]) {
      expect(classifyClaudeLine(entry)).toEqual({ kind: "skip" });
    }
  });

  it("skips Claude's own markup rather than reading it as the user's words", () => {
    for (const content of [
      "<command-name>/model</command-name><command-args>opus</command-args>",
      "<command-message>dev-extras:codex</command-message>\n<command-name>/dev-extras:codex</command-name>",
      "<local-command-stdout>Set model to opus</local-command-stdout>",
      "<local-command-caveat>Caveat: the messages below…</local-command-caveat>",
    ]) {
      expect(
        classifyClaudeLine({ type: "user", message: { content } }),
      ).toEqual({ kind: "skip" });
    }
  });

  it("skips isMeta entries, which are injected context and not a prompt", () => {
    expect(
      classifyClaudeLine({
        type: "user",
        isMeta: true,
        message: { content: "Another Claude session sent a message:\n…" },
      }),
    ).toEqual({ kind: "skip" });
  });

  it("keeps a teammate message verbatim: it IS the prompt that drove the turn", () => {
    const content =
      '<teammate-message teammate_id="lead">apply the fix-up batch</teammate-message>';
    expect(classifyClaudeLine({ type: "user", message: { content } })).toEqual({
      kind: "user",
      text: content,
      timestamp: undefined,
    });
  });

  it("folds responses either side of command noise into one entry", async () => {
    const path = fixture("markup.jsonl", [
      { type: "user", timestamp: "t0", message: { content: "q1" } },
      {
        type: "assistant",
        timestamp: "t1",
        message: { content: [{ type: "text", text: "A1" }] },
      },
      {
        type: "user",
        timestamp: "t2",
        message: {
          content:
            "<command-name>/model</command-name><command-args>x</command-args>",
        },
      },
      {
        type: "user",
        timestamp: "t3",
        message: {
          content: "<local-command-stdout>done</local-command-stdout>",
        },
      },
      {
        type: "assistant",
        timestamp: "t4",
        message: { content: [{ type: "text", text: "A2" }] },
      },
    ]);
    const result = await readSessionTranscript(session("claude", path), 2);
    // No markup reaches the payload, and with no real prompt between them the
    // two responses are one turn (the fold's documented merge semantics).
    expect(JSON.stringify(result)).not.toContain("command-name");
    expect(JSON.stringify(result)).not.toContain("local-command-stdout");
    expect(result?.turns).toEqual([
      { role: "assistant", text: "A1\n\nA2", timestamp: "t4" },
    ]);
  });

  it("reads the last turn across several assistant lines, ignoring tool results", async () => {
    const path = fixture("claude.jsonl", [
      { type: "user", timestamp: "t0", message: { content: "prompt" } },
      {
        type: "assistant",
        timestamp: "t1",
        message: { content: [{ type: "text", text: "first part" }] },
      },
      {
        type: "assistant",
        timestamp: "t2",
        message: { content: [{ type: "tool_use", name: "Bash" }] },
      },
      {
        type: "user",
        timestamp: "t3",
        message: { content: [{ type: "tool_result", content: "big output" }] },
      },
      {
        type: "assistant",
        timestamp: "t4",
        message: { content: [{ type: "text", text: "second part" }] },
      },
      { type: "mode", mode: "default" },
    ]);
    const result = await readSessionTranscript(session("claude", path), 1);
    expect(result).toEqual({
      turns: [
        {
          role: "assistant",
          text: "first part\n\nsecond part",
          timestamp: "t4",
        },
      ],
      truncated: false,
    });
  });
});

describe("codex reader", () => {
  it("prefers task_complete's last_agent_message as the turn's text", async () => {
    const path = fixture("codex.jsonl", [
      {
        type: "event_msg",
        timestamp: "t0",
        payload: { type: "user_message", message: "review the PR" },
      },
      {
        type: "event_msg",
        timestamp: "t1",
        payload: { type: "agent_message", message: "narrating progress" },
      },
      { type: "response_item", timestamp: "t2", payload: { duplicate: true } },
      {
        type: "event_msg",
        timestamp: "t3",
        payload: { type: "token_count", info: {} },
      },
      {
        type: "event_msg",
        timestamp: "t4",
        payload: { type: "agent_message", message: "## Findings" },
      },
      {
        type: "event_msg",
        timestamp: "t5",
        payload: {
          type: "task_complete",
          turn_id: "1",
          last_agent_message: "## Findings",
        },
      },
    ]);
    const result = await readSessionTranscript(session("codex", path), 1);
    expect(result).toEqual({
      turns: [{ role: "assistant", text: "## Findings", timestamp: "t5" }],
      truncated: false,
    });
  });

  it("falls back to agent_message when a turn has no task_complete", async () => {
    const path = fixture("codex.jsonl", [
      {
        type: "event_msg",
        timestamp: "t0",
        payload: { type: "user_message", message: "hi" },
      },
      {
        type: "event_msg",
        timestamp: "t1",
        payload: { type: "agent_message", message: "hello" },
      },
    ]);
    const result = await readSessionTranscript(session("codex", path), 1);
    expect(result?.turns).toEqual([
      { role: "assistant", text: "hello", timestamp: "t1" },
    ]);
  });

  it("skips non-event_msg entries and malformed payloads", () => {
    for (const entry of [
      null,
      { type: "response_item", payload: { type: "agent_message" } },
      { type: "event_msg", payload: null },
      { type: "event_msg", payload: { type: "agent_message" } },
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "event_msg", payload: { type: "web_search_end" } },
    ]) {
      expect(classifyCodexLine(entry)).toEqual({ kind: "skip" });
    }
  });
});

describe("copilot reader", () => {
  it("filters the re-inlined system prompt and empty tool-only messages", () => {
    expect(
      classifyCopilotLine({
        type: "system.message",
        timestamp: "t0",
        data: { role: "system", content: "You are the GitHub Copilot CLI…" },
      }),
    ).toEqual({ kind: "skip" });
    expect(
      classifyCopilotLine({
        type: "assistant.message",
        timestamp: "t1",
        data: { content: "" },
      }),
    ).toEqual({ kind: "skip" });
  });

  it("reads plain-string content across a turn", async () => {
    const path = fixture("copilot.jsonl", [
      { type: "session.start", timestamp: "t0", data: { sessionId: "u" } },
      {
        type: "system.message",
        timestamp: "t1",
        data: { role: "system", content: "x".repeat(2000) },
      },
      {
        type: "user.message",
        timestamp: "t2",
        data: { content: "reply with ok" },
      },
      { type: "assistant.turn_start", timestamp: "t3", data: { turnId: "1" } },
      {
        type: "assistant.message",
        timestamp: "t4",
        data: { content: "", toolRequests: [{ name: "shell" }] },
      },
      { type: "assistant.message", timestamp: "t5", data: { content: "ok" } },
      { type: "assistant.turn_end", timestamp: "t6", data: { turnId: "1" } },
    ]);
    const result = await readSessionTranscript(session("copilot", path), 1);
    expect(result).toEqual({
      turns: [{ role: "assistant", text: "ok", timestamp: "t5" }],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("xxx");
  });
});

describe("registry", () => {
  it("registers exactly the agents wave 1 reads", () => {
    expect([...BUILTIN_TRANSCRIPT_READERS.keys()].sort()).toEqual([
      "claude",
      "codex",
      "copilot",
    ]);
  });

  it("returns null for an agent with no reader, and for a missing log path", async () => {
    expect(
      await readSessionTranscript(session("gemini", "/nope"), 1),
    ).toBeNull();
    expect(await readSessionTranscript(session("claude", null), 1)).toBeNull();
  });

  it("returns null when a reader throws", async () => {
    const readers = new Map([
      [
        "boom",
        {
          agentType: "boom",
          read: async () => {
            throw new Error("nope");
          },
        },
      ],
    ]);
    expect(
      await readSessionTranscript(session("boom", "/x"), 1, readers),
    ).toBeNull();
  });
});
