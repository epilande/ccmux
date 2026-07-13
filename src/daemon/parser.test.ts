import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LogEntry } from "../types";
import {
  parseLogEntries,
  extractSessionIdFromPath,
  decodeProjectPath,
  extractProjectInfo,
  readLogIncremental,
  readLogTail,
  readFirstEntryTimestamp,
} from "./parser";

describe("parser", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ccmux-parser-"));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("parseLogEntries", () => {
    it("should parse valid JSONL content", () => {
      const content = `{"type":"progress","uuid":"123","timestamp":"2024-01-01T00:00:00Z","progress":{"type":"SessionStart"}}
{"type":"assistant","uuid":"456","timestamp":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}`;

      const entries = parseLogEntries(content);
      expect(entries).toHaveLength(2);
      expect(entries[0].type).toBe("progress");
      expect(entries[1].type).toBe("assistant");
    });

    it("should skip invalid JSON lines", () => {
      const content = `{"type":"progress","uuid":"123"}
invalid json
{"type":"result","uuid":"456"}`;

      const entries = parseLogEntries(content);
      expect(entries).toHaveLength(2);
    });

    it("should handle empty content", () => {
      const entries = parseLogEntries("");
      expect(entries).toHaveLength(0);
    });
  });

  describe("readLogTail", () => {
    const line = (i: number) =>
      JSON.stringify({
        type: "progress",
        uuid: `u${i}`,
        timestamp: "2024-01-01T00:00:00Z",
      });

    it("returns the last N entries without a byte cap", async () => {
      const path = join(testDir, "tail.jsonl");
      const lines = Array.from({ length: 10 }, (_, i) => line(i));
      await Bun.write(path, lines.join("\n") + "\n");

      const entries = await readLogTail(path, 3);
      expect(entries).toHaveLength(3);
      expect(entries[2]).toMatchObject({ uuid: "u9" });
    });

    it("caps the backwards read at maxBytes, keeping the newest entries", async () => {
      const path = join(testDir, "tail-capped.jsonl");
      const lines = Array.from({ length: 100 }, (_, i) => line(i));
      await Bun.write(path, lines.join("\n") + "\n");

      // A cap of ~3 lines' worth must yield fewer than the requested 50,
      // and the entries it does yield must be the newest ones.
      const capped = await readLogTail(path, 50, line(0).length * 3);
      expect(capped.length).toBeGreaterThan(0);
      expect(capped.length).toBeLessThan(50);
      expect(capped[capped.length - 1]).toMatchObject({ uuid: "u99" });
    });

    it("returns [] for a zero maxBytes", async () => {
      const path = join(testDir, "tail-zero.jsonl");
      await Bun.write(path, line(1) + "\n");
      expect(await readLogTail(path, 10, 0)).toEqual([]);
    });
  });

  describe("readFirstEntryTimestamp", () => {
    it("returns the timestamp of the first entry (the head)", async () => {
      const path = join(testDir, "head.jsonl");
      const lines = [
        JSON.stringify({ uuid: "u0", timestamp: "2024-01-01T00:00:00Z" }),
        JSON.stringify({ uuid: "u1", timestamp: "2024-01-01T00:05:00Z" }),
      ];
      await Bun.write(path, lines.join("\n") + "\n");
      expect(readFirstEntryTimestamp(path)).toBe("2024-01-01T00:00:00Z");
    });

    it("skips leading lines without a timestamp", async () => {
      const path = join(testDir, "head-skip.jsonl");
      const lines = [
        JSON.stringify({ type: "summary" }),
        JSON.stringify({ uuid: "u0", timestamp: "2024-01-01T00:00:00Z" }),
      ];
      await Bun.write(path, lines.join("\n") + "\n");
      expect(readFirstEntryTimestamp(path)).toBe("2024-01-01T00:00:00Z");
    });

    it("returns null for an empty or missing file", async () => {
      const empty = join(testDir, "empty.jsonl");
      await Bun.write(empty, "");
      expect(readFirstEntryTimestamp(empty)).toBeNull();
      expect(readFirstEntryTimestamp(join(testDir, "nope.jsonl"))).toBeNull();
    });
  });

  describe("extractSessionIdFromPath", () => {
    it("should extract UUID from valid path", () => {
      const path =
        "/Users/test/.claude/projects/-Users-test-myproject/550e8400-e29b-41d4-a716-446655440000.jsonl";
      const id = extractSessionIdFromPath(path);
      expect(id).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("should return null for invalid path", () => {
      const path = "/Users/test/some-file.txt";
      const id = extractSessionIdFromPath(path);
      expect(id).toBeNull();
    });
  });

  describe("decodeProjectPath", () => {
    it("should decode encoded path", () => {
      const encoded = "-Users-test-myproject";
      const decoded = decodeProjectPath(encoded);
      expect(decoded).toBe("/Users/test/myproject");
    });

    it("should handle path without leading dash", () => {
      const encoded = "relative-path";
      const decoded = decodeProjectPath(encoded);
      expect(decoded).toBe("relative-path");
    });
  });

  describe("extractProjectInfo", () => {
    it("should extract project info from valid path", () => {
      const path =
        "/Users/test/.claude/projects/-Users-test-myproject/550e8400-e29b-41d4-a716-446655440000.jsonl";
      const info = extractProjectInfo(path);
      expect(info.project).toBe("myproject");
      expect(info.cwd).toBe("/Users/test/myproject");
    });

    it("should handle invalid path", () => {
      const path = "/some/random/path.jsonl";
      const info = extractProjectInfo(path);
      expect(info.project).toBe("unknown");
      expect(info.cwd).toBe("/");
    });
  });

  describe("readLogIncremental", () => {
    it("should return all entries and advance to the end for complete lines", async () => {
      const path = join(testDir, "complete.jsonl");
      const content = '{"a":1}\n{"b":2}\n';

      await Bun.write(path, content);

      const result = await readLogIncremental(path, 0);

      expect(result.entries).toEqual([
        { a: 1 },
        { b: 2 },
      ] as unknown as LogEntry[]);
      expect(result.newOffset).toBe(Buffer.byteLength(content, "utf-8"));
    });

    it("should stop at the last newline when a trailing partial line exists", async () => {
      const path = join(testDir, "partial-tail.jsonl");
      const content = '{"a":1}\n{"b":2';

      await Bun.write(path, content);

      const result = await readLogIncremental(path, 0);

      expect(result.entries).toEqual([{ a: 1 }] as unknown as LogEntry[]);
      expect(result.newOffset).toBe(Buffer.byteLength('{"a":1}\n', "utf-8"));
    });

    it("should return empty and keep the offset when no complete lines exist yet", async () => {
      const path = join(testDir, "partial-first.jsonl");

      await Bun.write(path, '{"partial');

      const result = await readLogIncremental(path, 0);

      expect(result.entries).toEqual([]);
      expect(result.newOffset).toBe(0);
    });

    it("should calculate offsets using UTF-8 byte length for multi-byte characters", async () => {
      const path = join(testDir, "utf8.jsonl");
      const completeLine = '{"message":"🙂"}\n';
      const content = `${completeLine}{"message":"later"`;

      await Bun.write(path, content);

      const result = await readLogIncremental(path, 0);

      expect(result.entries).toEqual([
        { message: "🙂" },
      ] as unknown as LogEntry[]);
      expect(result.newOffset).toBe(Buffer.byteLength(completeLine, "utf-8"));
    });

    it("should recover partial line on next read after file grows", async () => {
      const path = join(testDir, "growing.jsonl");

      // First write: one complete line + partial
      await Bun.write(path, '{"a":1}\n{"b":2');
      const r1 = await readLogIncremental(path, 0);
      expect(r1.entries).toEqual([{ a: 1 }] as unknown as LogEntry[]);

      // Append: complete the partial line + add another
      const { appendFileSync } = await import("fs");
      appendFileSync(path, '}\n{"c":3}\n');
      const r2 = await readLogIncremental(path, r1.newOffset);
      expect(r2.entries).toEqual([{ b: 2 }, { c: 3 }] as unknown as LogEntry[]);
    });

    it("should return empty when offset is at file size", async () => {
      const path = join(testDir, "caught-up.jsonl");
      const content = '{"a":1}\n';
      await Bun.write(path, content);

      const offset = Buffer.byteLength(content, "utf-8");
      const result = await readLogIncremental(path, offset);
      expect(result.entries).toEqual([]);
      expect(result.newOffset).toBe(offset);
    });

    it("should return empty when called at the end of an empty file", async () => {
      const path = join(testDir, "empty.jsonl");

      await Bun.write(path, "");

      const result = await readLogIncremental(path, 0);

      expect(result.entries).toEqual([]);
      expect(result.newOffset).toBe(0);
    });
  });
});
