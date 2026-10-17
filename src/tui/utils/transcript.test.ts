import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractLastAssistantTurn,
  readLastAssistantTurn,
  MAX_TRANSCRIPT_CHARS,
} from "./transcript";
import type { LogEntry } from "../../types/log";

const TS = "2024-01-15T12:00:00Z";
let uuidCounter = 0;
const base = () => ({
  parentUuid: null,
  uuid: `u${uuidCounter++}`,
  timestamp: TS,
});

function assistantText(text: string): LogEntry {
  return {
    ...base(),
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as LogEntry;
}

function assistantToolUse(): LogEntry {
  return {
    ...base(),
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
    },
  } as LogEntry;
}

function userPrompt(text: string): LogEntry {
  return {
    ...base(),
    type: "user",
    message: { role: "user", content: text },
  } as LogEntry;
}

function toolResult(): LogEntry {
  return {
    ...base(),
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  } as LogEntry;
}

describe("extractLastAssistantTurn", () => {
  it("returns the assistant text after the last user prompt", () => {
    const entries = [
      userPrompt("old question"),
      assistantText("old answer"),
      userPrompt("new question"),
      assistantText("new answer"),
    ];
    expect(extractLastAssistantTurn(entries)).toBe("new answer");
  });

  it("joins assistant text across tool_result boundaries within one turn", () => {
    const entries = [
      userPrompt("do the thing"),
      assistantText("Starting."),
      assistantToolUse(),
      toolResult(),
      assistantText("Done. Here is the result."),
    ];
    expect(extractLastAssistantTurn(entries)).toBe(
      "Starting.\n\nDone. Here is the result.",
    );
  });

  it("returns null when the last entry is an unanswered user prompt", () => {
    const entries = [
      userPrompt("q1"),
      assistantText("a1"),
      userPrompt("not yet answered"),
    ];
    expect(extractLastAssistantTurn(entries)).toBe(null);
  });

  it("returns null when there is no assistant text at all", () => {
    expect(extractLastAssistantTurn([])).toBe(null);
    expect(
      extractLastAssistantTurn([userPrompt("q"), assistantToolUse()]),
    ).toBe(null);
  });

  it("skips non-message entries (system, progress, summary)", () => {
    const entries: LogEntry[] = [
      userPrompt("q"),
      assistantText("answer"),
      { ...base(), type: "system", subtype: "turn_duration" } as LogEntry,
      { ...base(), type: "summary", summary: "s" } as LogEntry,
    ];
    expect(extractLastAssistantTurn(entries)).toBe("answer");
  });

  it("caps overlong turns from the front, keeping the conclusion", () => {
    const long = "x".repeat(MAX_TRANSCRIPT_CHARS) + "THE END";
    const result = extractLastAssistantTurn([
      userPrompt("q"),
      assistantText(long),
    ]);
    expect(result!.startsWith("… ")).toBe(true);
    expect(result!.endsWith("THE END")).toBe(true);
    expect(result!.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS + 2);
  });
});

describe("readLastAssistantTurn", () => {
  it("reads the final turn from a JSONL file on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccmux-transcript-"));
    const path = join(dir, "session.jsonl");
    const lines = [
      userPrompt("research the thing"),
      assistantText("Here is what I found."),
    ].map((e) => JSON.stringify(e));
    writeFileSync(path, lines.join("\n") + "\n");

    expect(await readLastAssistantTurn(path)).toBe("Here is what I found.");
  });

  it("returns null for a missing file", async () => {
    expect(await readLastAssistantTurn("/nonexistent/nope.jsonl")).toBe(null);
  });

  it("tolerates a transcript containing non-object JSONL lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccmux-transcript-"));
    const path = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify(userPrompt("q")),
      "null",
      JSON.stringify(assistantText("still works")),
    ];
    writeFileSync(path, lines.join("\n") + "\n");

    expect(await readLastAssistantTurn(path)).toBe("still works");
  });
});
