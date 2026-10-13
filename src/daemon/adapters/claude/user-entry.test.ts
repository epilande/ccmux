import { describe, expect, it } from "bun:test";
import { classifyClaudeUserEntry } from "./user-entry";

// Shapes copied from real Claude Code 2.1.296 transcripts.
const CLEAR_CAVEAT =
  "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>";
const CLEAR_RECORD =
  "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>";
const SKILL_RECORD =
  "<command-message>git-workflow:review-pr</command-message>\n<command-name>/git-workflow:review-pr</command-name>\n<command-args>https://github.com/epilande/ccmux/pull/1</command-args>";

const user = (content: unknown, isMeta?: boolean) => ({
  ...(isMeta === undefined ? {} : { isMeta }),
  message: { content },
});

describe("classifyClaudeUserEntry", () => {
  it("reads typed text, task notifications, teammate messages and `!` commands as prompts", () => {
    for (const content of [
      "fix the failing test",
      "<task-notification><summary>Build finished</summary></task-notification>",
      '<teammate-message teammate_id="lead">apply the batch</teammate-message>',
      // Claude answers a `!` shell command with a turn.
      "<bash-input>echo hi</bash-input>",
      "<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>",
    ]) {
      expect(classifyClaudeUserEntry(user(content))).toBe("prompt");
    }
  });

  it("keeps a prompt that merely quotes a tag a prompt", () => {
    expect(
      classifyClaudeUserEntry(
        user("why does <command-name>/clear</command-name> mark it unread?"),
      ),
    ).toBe("prompt");
  });

  it("reads a prompt-type slash command (led by <command-message>) as a command", () => {
    expect(classifyClaudeUserEntry(user(SKILL_RECORD))).toBe("command");
  });

  it("reads a local command's record and output as bookkeeping", () => {
    for (const content of [
      CLEAR_RECORD,
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>haiku</command-args>",
      "<local-command-stdout>Set model to `Haiku 5.5`</local-command-stdout>",
      "<local-command-stderr>Unknown model</local-command-stderr>",
    ]) {
      expect(classifyClaudeUserEntry(user(content))).toBe("bookkeeping");
    }
  });

  it("matches the leading tag past leading whitespace", () => {
    expect(classifyClaudeUserEntry(user(`\n  ${CLEAR_RECORD}`))).toBe(
      "bookkeeping",
    );
    expect(classifyClaudeUserEntry(user(`\n${SKILL_RECORD}`))).toBe("command");
  });

  it("reads every isMeta entry as bookkeeping, whatever its content", () => {
    expect(classifyClaudeUserEntry(user(CLEAR_CAVEAT, true))).toBe(
      "bookkeeping",
    );
    // Text that would otherwise read as a prompt.
    expect(
      classifyClaudeUserEntry(
        user("Another Claude session sent a message:\n…", true),
      ),
    ).toBe("bookkeeping");
    // A skill's expanded prompt and a plugin's notice arrive as text arrays,
    // which must not pass for tool results.
    expect(
      classifyClaudeUserEntry(
        user([{ type: "text", text: "Review the PR above." }], true),
      ),
    ).toBe("bookkeeping");
  });

  it("reads array content as tool results", () => {
    expect(
      classifyClaudeUserEntry(
        user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
      ),
    ).toBe("tool-result");
  });

  it("does not throw on a schema-invalid entry", () => {
    expect(() => classifyClaudeUserEntry({})).not.toThrow();
    expect(() => classifyClaudeUserEntry(user(null))).not.toThrow();
  });
});
