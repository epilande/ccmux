import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  searchTranscript,
  claudeEntryTexts,
  codexEntryTexts,
} from "./transcript-search";
import type { LogEntry } from "../types";
import type { CodexEntry } from "./adapters/codex/parse";

function jsonl(...objs: object[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

/** A Claude transcript with a user prompt, an assistant text turn (plus a
 *  tool_use block that should be ignored), a tool-result user turn, and an
 *  assistant thinking block (both non-textual, ignored). */
function claudeFixture(): string {
  return jsonl(
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      timestamp: "2024-01-01T12:00:00Z",
      message: { role: "user", content: "please refactor the parser module" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2024-01-01T12:00:01Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will start by reading the parser." },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      timestamp: "2024-01-01T12:00:02Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "secret tool output about the parser",
          },
        ],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      timestamp: "2024-01-01T12:00:03Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden parser reasoning" }],
      },
    },
  );
}

function codexFixture(): string {
  return jsonl(
    {
      type: "session_meta",
      timestamp: "2026-04-01T12:00:00Z",
      payload: {
        id: "sid",
        cwd: "/x",
        timestamp: "2026-04-01T12:00:00Z",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-04-01T12:00:01Z",
      payload: { type: "user_message", message: "investigate the daemon race" },
    },
    {
      type: "event_msg",
      timestamp: "2026-04-01T12:00:02Z",
      payload: {
        type: "agent_message",
        message: "The daemon race is in the reconciler.",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-04-01T12:00:03Z",
      payload: { type: "agent_reasoning", text: "race reasoning noise" },
    },
    {
      type: "event_msg",
      timestamp: "2026-04-01T12:00:04Z",
      payload: { type: "token_count" },
    },
  );
}

describe("transcript-search", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccmux-transcript-search-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("claudeEntryTexts", () => {
    it("extracts user string content and assistant text, skipping tools/results/thinking", () => {
      const entries = claudeFixture()
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as LogEntry);

      const user = claudeEntryTexts(entries[0]);
      expect(user).toEqual([
        { role: "user", text: "please refactor the parser module" },
      ]);

      const assistant = claudeEntryTexts(entries[1]);
      expect(assistant).toEqual([
        { role: "assistant", text: "I will start by reading the parser." },
      ]);

      // Tool-result user turn (array content) and thinking-only assistant turn
      // carry no searchable text.
      expect(claudeEntryTexts(entries[2])).toEqual([]);
      expect(claudeEntryTexts(entries[3])).toEqual([]);
    });
  });

  describe("codexEntryTexts", () => {
    it("extracts user_message and agent_message, skipping reasoning/token events", () => {
      const entries = codexFixture()
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as CodexEntry);

      expect(codexEntryTexts(entries[1])).toEqual([
        { role: "user", text: "investigate the daemon race" },
      ]);
      expect(codexEntryTexts(entries[2])).toEqual([
        { role: "assistant", text: "The daemon race is in the reconciler." },
      ]);
      expect(codexEntryTexts(entries[3])).toEqual([]);
      expect(codexEntryTexts(entries[4])).toEqual([]);
    });
  });

  describe("searchTranscript - Claude", () => {
    it("matches user and assistant text but not tool-result or thinking noise", async () => {
      const logPath = join(dir, "claude.jsonl");
      writeFileSync(logPath, claudeFixture());

      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath },
        "parser",
      );
      expect(result).not.toBeNull();
      const snippets = result!.matches.map((m) => m.snippet);
      // User prompt + assistant text mention "parser"; the tool result and
      // thinking block also contain "parser" but must be excluded.
      expect(snippets.length).toBe(2);
      expect(result!.matches[0].role).toBe("user");
      expect(result!.matches[1].role).toBe("assistant");
      expect(snippets.some((s) => s.includes("refactor the parser"))).toBe(
        true,
      );
      expect(snippets.some((s) => s.includes("secret tool output"))).toBe(
        false,
      );
    });

    it("matches a query containing a JSON-escaped char (raw pre-filter skipped)", async () => {
      // The raw file stores `"` escaped as `\"`, so a raw-bytes pre-filter
      // would false-negative on a query containing `"`. The escaped-char guard
      // must skip the pre-filter and let the parse find the match in the
      // unescaped text.
      const logPath = join(dir, "claude.jsonl");
      writeFileSync(
        logPath,
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2024-01-01T12:00:00Z",
          message: { role: "user", content: 'he said "yes" to the plan' },
        }) + "\n",
      );

      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath },
        'said "yes',
      );
      expect(result).not.toBeNull();
      expect(result!.matches.length).toBe(1);
      expect(result!.matches[0].snippet).toContain('said "yes"');
    });

    it("keeps a deep match near the snippet start (asymmetric window)", async () => {
      const logPath = join(dir, "claude.jsonl");
      // The query sits ~200 chars into the text; a symmetric 80-char lead
      // would push it far into the snippet (and off a narrow row). The small
      // lead radius must keep it within ~25 chars of the snippet start.
      const content = "x".repeat(200) + " MERGEABLE " + "y".repeat(200);
      writeFileSync(
        logPath,
        JSON.stringify({
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "2024-01-01T12:00:00Z",
          message: { role: "user", content },
        }) + "\n",
      );

      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath },
        "mergeable",
      );
      const snippet = result!.matches[0].snippet;
      expect(snippet.toLowerCase().indexOf("mergeable")).toBeLessThanOrEqual(
        26,
      );
      expect(snippet.startsWith("…")).toBe(true);
      // Larger trailing radius: more context after the match than before it.
      const matchStart = snippet.toLowerCase().indexOf("mergeable");
      const afterLen = snippet.length - (matchStart + "mergeable".length);
      expect(afterLen).toBeGreaterThan(matchStart);
    });

    it("returns an empty matches array when nothing matches", async () => {
      const logPath = join(dir, "claude.jsonl");
      writeFileSync(logPath, claudeFixture());

      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath },
        "nonexistent-term",
      );
      expect(result).toEqual({ sessionId: "s1", matches: [] });
    });

    it("survives JSON-valid but schema-invalid lines, keeping other matches", async () => {
      const logPath = join(dir, "claude.jsonl");
      writeFileSync(
        logPath,
        jsonl(
          {
            type: "user",
            uuid: "u1",
            parentUuid: null,
            timestamp: "2024-01-01T12:00:00Z",
            message: { role: "user", content: "first match here" },
          },
          // Schema-invalid: a user entry with no `message` at all.
          { type: "user", uuid: "bad1", parentUuid: null, timestamp: "t" },
          // Schema-invalid: assistant `content` is a string, not an array.
          {
            type: "assistant",
            uuid: "bad2",
            parentUuid: null,
            timestamp: "t",
            message: { role: "assistant", content: "match but wrong shape" },
          },
          {
            type: "user",
            uuid: "u2",
            parentUuid: null,
            timestamp: "2024-01-01T12:01:00Z",
            message: { role: "user", content: "second match here" },
          },
        ),
      );

      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath },
        "match",
      );
      // The two well-formed user turns match; the malformed lines are skipped
      // without dropping the whole session (which the outer catch would do).
      expect(result).not.toBeNull();
      expect(result!.matches.length).toBe(2);
      expect(result!.matches.map((m) => m.snippet)).toEqual([
        "first match here",
        "second match here",
      ]);
    });

    it("respects maxMatches", async () => {
      const logPath = join(dir, "claude.jsonl");
      // Five user turns all containing the query.
      const lines: object[] = [];
      for (let i = 0; i < 5; i++) {
        lines.push({
          type: "user",
          uuid: `u${i}`,
          parentUuid: null,
          timestamp: `2024-01-01T12:0${i}:00Z`,
          message: { role: "user", content: `match number ${i}` },
        });
      }
      writeFileSync(logPath, jsonl(...lines));

      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath },
        "match",
        { maxMatches: 2 },
      );
      expect(result!.matches.length).toBe(2);
    });

    it("tail-truncates when the file exceeds maxBytes, dropping the partial first line", async () => {
      const logPath = join(dir, "claude.jsonl");
      const early = {
        type: "user",
        uuid: "early",
        parentUuid: null,
        timestamp: "2024-01-01T12:00:00Z",
        message: { role: "user", content: "EARLY unique marker text" },
      };
      const late = {
        type: "user",
        uuid: "late",
        parentUuid: null,
        timestamp: "2024-01-01T13:00:00Z",
        message: { role: "user", content: "LATE unique marker text" },
      };
      writeFileSync(logPath, jsonl(early, late));

      // maxBytes fully contains the late line but starts inside the early
      // line, so the early line's partial remainder is discarded and only the
      // late line survives.
      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath },
        "unique marker",
        { maxBytes: 200 },
      );
      const snippets = result!.matches.map((m) => m.snippet).join(" ");
      expect(snippets).toContain("LATE");
      expect(snippets).not.toContain("EARLY");
    });
  });

  describe("searchTranscript - Codex", () => {
    it("matches user and assistant text", async () => {
      const logPath = join(dir, "codex.jsonl");
      writeFileSync(logPath, codexFixture());

      const result = await searchTranscript(
        { id: "s1", agentType: "codex", logPath },
        "daemon race",
      );
      expect(result!.matches.length).toBe(2);
      expect(result!.matches[0].role).toBe("user");
      expect(result!.matches[1].role).toBe("assistant");
    });

    it("survives an event_msg with a null/non-object payload", async () => {
      const logPath = join(dir, "codex.jsonl");
      writeFileSync(
        logPath,
        jsonl(
          {
            type: "session_meta",
            timestamp: "2026-04-01T12:00:00Z",
            payload: {
              id: "sid",
              cwd: "/x",
              timestamp: "2026-04-01T12:00:00Z",
            },
          },
          // Schema-invalid: payload is null (would throw reading payload.type).
          { type: "event_msg", timestamp: "t", payload: null },
          {
            type: "event_msg",
            timestamp: "2026-04-01T12:00:02Z",
            payload: { type: "user_message", message: "keep the daemon race" },
          },
        ),
      );

      const result = await searchTranscript(
        { id: "s1", agentType: "codex", logPath },
        "daemon race",
      );
      expect(result!.matches.length).toBe(1);
      expect(result!.matches[0].role).toBe("user");
    });
  });

  describe("searchTranscript - unsupported / missing", () => {
    it("returns null for an unsupported agent", async () => {
      const logPath = join(dir, "x.jsonl");
      writeFileSync(logPath, claudeFixture());
      const result = await searchTranscript(
        { id: "s1", agentType: "gemini", logPath },
        "parser",
      );
      expect(result).toBeNull();
    });

    it("returns null when there is no log path", async () => {
      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath: null },
        "parser",
      );
      expect(result).toBeNull();
    });

    it("returns null when the log file cannot be read", async () => {
      const result = await searchTranscript(
        { id: "s1", agentType: "claude", logPath: join(dir, "missing.jsonl") },
        "parser",
      );
      expect(result).toBeNull();
    });
  });
});
