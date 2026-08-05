import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readGeminiTranscript } from "./gemini";

let root: string; // fake GEMINI_TMP_DIR

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccmux-gemini-tmp-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Create `<root>/<dirName>/.project_root` = `cwd`, plus a chats/ dir. */
function project(dirName: string, cwd: string): string {
  const dir = join(root, dirName);
  mkdirSync(join(dir, "chats"), { recursive: true });
  writeFileSync(join(dir, ".project_root"), cwd);
  return dir;
}

function writeSession(
  projectDir: string,
  fileName: string,
  messages: unknown[],
  mtimeOffsetSeconds = 0,
): string {
  const path = join(projectDir, "chats", fileName);
  writeFileSync(
    path,
    JSON.stringify({
      sessionId: "s1",
      projectHash: "h1",
      startTime: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
      messages,
    }),
  );
  if (mtimeOffsetSeconds !== 0) {
    const t = new Date(Date.now() + mtimeOffsetSeconds * 1000);
    utimesSync(path, t, t);
  }
  return path;
}

describe("gemini reader", () => {
  it("discovers the project dir by scanning .project_root, not the dir name", async () => {
    // The dir name deliberately does NOT match the cwd's basename, matching
    // the documented dedupe scheme (ccmux, ccmux2, ...) — discovery must not
    // trust the directory name.
    const dir = project("some-dedup-suffix-3", "/Users/epilande/proj");
    writeSession(dir, "session-1.json", [
      { type: "user", timestamp: "t0", content: [{ text: "hi" }] },
      { type: "gemini", timestamp: "t1", content: "hello there" },
    ]);

    const result = await readGeminiTranscript(
      root,
      { cwd: "/Users/epilande/proj" },
      1,
    );
    expect(result?.turns).toEqual([
      { role: "assistant", text: "hello there", timestamp: "t1" },
    ]);
  });

  it("returns null when no project dir's .project_root matches the cwd", async () => {
    project("proj", "/Users/epilande/proj");
    const result = await readGeminiTranscript(
      root,
      { cwd: "/Users/epilande/other" },
      1,
    );
    expect(result).toBeNull();
  });

  it("picks the newest chats/session-*.json by mtime, skips info/error entries", async () => {
    const dir = project("proj", "/tmp/proj");
    writeSession(dir, "session-old.json", [
      { type: "gemini", timestamp: "old", content: "stale reply" },
    ]);
    writeSession(
      dir,
      "session-new.json",
      [
        { type: "info", timestamp: "t0", content: "update available" },
        {
          type: "user",
          timestamp: "t1",
          content: [{ text: "reply with exactly: pong" }],
        },
        { type: "gemini", timestamp: "t2", content: "pong" },
        { type: "user", timestamp: "t3", content: [{ text: "count to 3" }] },
        {
          type: "error",
          timestamp: "t4",
          content: "[API Error: quota exhausted]",
        },
      ],
      5, // newer mtime than session-old.json
    );

    const result = await readGeminiTranscript(root, { cwd: "/tmp/proj" }, 1);
    expect(result?.turns).toEqual([
      { role: "assistant", text: "pong", timestamp: "t2" },
    ]);
  });

  it("handles a native array content (real shape, contradicts the stringified-array notes) and a stringified fallback", async () => {
    const dir = project("proj", "/tmp/proj");
    writeSession(dir, "session-1.json", [
      // Real shape observed live 2026-08-03: a native array, not a string.
      {
        type: "user",
        timestamp: "t0",
        content: [{ text: "native array prompt" }],
      },
      { type: "gemini", timestamp: "t1", content: "native reply" },
      // Documented-but-unobserved shape: defensively still supported.
      {
        type: "user",
        timestamp: "t2",
        content: JSON.stringify([{ text: "stringified prompt" }]),
      },
      { type: "gemini", timestamp: "t3", content: "stringified reply" },
    ]);

    const result = await readGeminiTranscript(root, { cwd: "/tmp/proj" }, 2);
    expect(result?.turns).toEqual([
      { role: "assistant", text: "native reply", timestamp: "t1" },
      { role: "user", text: "stringified prompt", timestamp: "t2" },
      { role: "assistant", text: "stringified reply", timestamp: "t3" },
    ]);
  });

  it("does not attach a trailing UNANSWERED prompt to an older, unrelated reply", async () => {
    // Regression case: mirrors the OpenCode reader's identical fix. The
    // newest message is a user prompt gemini errored out on / never
    // answered (a real observed shape: a `[API Error: ...]` entry after the
    // final user message, no `gemini` reply). Its text must not drift onto
    // the previous, unrelated completed exchange.
    const dir = project("proj", "/tmp/proj");
    writeSession(dir, "session-1.json", [
      { type: "user", timestamp: "t0", content: [{ text: "first" }] },
      { type: "gemini", timestamp: "t1", content: "first reply" },
      {
        type: "user",
        timestamp: "t2",
        content: [{ text: "second, never answered" }],
      },
      {
        type: "error",
        timestamp: "t3",
        content: "[API Error: quota exhausted]",
      },
    ]);

    const result = await readGeminiTranscript(root, { cwd: "/tmp/proj" }, 2);
    expect(result?.turns).toEqual([
      { role: "assistant", text: "first reply", timestamp: "t1" },
    ]);
  });

  it("returns null for a project dir with no chats and for an unparseable session file", async () => {
    const empty = project("empty", "/tmp/empty");
    expect(
      await readGeminiTranscript(root, { cwd: "/tmp/empty" }, 1),
    ).toBeNull();
    void empty;

    const dir = project("broken", "/tmp/broken");
    writeFileSync(join(dir, "chats", "session-1.json"), "not valid json{{{");
    expect(
      await readGeminiTranscript(root, { cwd: "/tmp/broken" }, 1),
    ).toBeNull();
  });
});
