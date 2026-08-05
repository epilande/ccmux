import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readOpenCodeTranscript } from "./opencode";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-opencode-"));
  dbPath = join(dir, "opencode.db");
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function insertSession(id: string, directory: string, timeUpdated: number) {
  db.query(
    "INSERT INTO session (id, directory, time_updated) VALUES (?, ?, ?)",
  ).run(id, directory, timeUpdated);
}

function insertMessage(
  id: string,
  sessionId: string,
  timeCreated: number,
  data: unknown,
) {
  db.query(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  ).run(id, sessionId, timeCreated, JSON.stringify(data));
}

function insertPart(
  id: string,
  messageId: string,
  sessionId: string,
  timeCreated: number,
  data: unknown,
) {
  db.query(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  ).run(id, messageId, sessionId, timeCreated, JSON.stringify(data));
}

/** Build one complete user->assistant exchange, modeled on the real schema
 *  sampled 2026-08-03: a user message with one text part, and an assistant
 *  message whose parts include a step-start, a reasoning block, a text
 *  block, and a terminating step-finish/reason:"stop". */
function seedExchange(
  sessionId: string,
  base: number,
  userText: string,
  assistantText: string,
) {
  insertMessage(`${base}-u`, sessionId, base, { role: "user" });
  insertPart(`${base}-u-1`, `${base}-u`, sessionId, base + 1, {
    type: "text",
    text: userText,
  });
  insertMessage(`${base}-a`, sessionId, base + 2, { role: "assistant" });
  insertPart(`${base}-a-1`, `${base}-a`, sessionId, base + 3, {
    type: "step-start",
  });
  insertPart(`${base}-a-2`, `${base}-a`, sessionId, base + 4, {
    type: "reasoning",
    text: "thinking...",
  });
  insertPart(`${base}-a-3`, `${base}-a`, sessionId, base + 5, {
    type: "text",
    text: assistantText,
  });
  insertPart(`${base}-a-4`, `${base}-a`, sessionId, base + 6, {
    type: "step-finish",
    reason: "stop",
  });
}

describe("opencode reader", () => {
  it("reads the last turn by nativeSessionId, ignoring tool/reasoning parts", async () => {
    insertSession("ses_1", "/tmp/proj", 100);
    seedExchange("ses_1", 100, "reply with ok", "ok");

    const result = await readOpenCodeTranscript(
      dbPath,
      { nativeSessionId: "ses_1", cwd: "/tmp/proj" },
      1,
    );
    expect(result?.turns).toEqual([
      {
        role: "assistant",
        text: "ok",
        timestamp: new Date(102).toISOString(),
      },
    ]);
    expect(result?.truncated).toBe(false);
  });

  it("widens to turns=2 with the between-prompt shape (2N-1)", async () => {
    insertSession("ses_1", "/tmp/proj", 100);
    seedExchange("ses_1", 100, "first", "first reply");
    seedExchange("ses_1", 200, "second", "second reply");

    const result = await readOpenCodeTranscript(
      dbPath,
      { nativeSessionId: "ses_1", cwd: "/tmp/proj" },
      2,
    );
    expect(result?.turns.map((t) => [t.role, t.text])).toEqual([
      ["assistant", "first reply"],
      ["user", "second"],
      ["assistant", "second reply"],
    ]);
  });

  it("skips an assistant message with no step-finish/stop part (mid-turn, aborted)", async () => {
    insertSession("ses_1", "/tmp/proj", 100);
    seedExchange("ses_1", 100, "first", "first reply");
    // A second exchange whose assistant message never finished.
    insertMessage("200-u", "ses_1", 200, { role: "user" });
    insertPart("200-u-1", "200-u", "ses_1", 201, {
      type: "text",
      text: "second",
    });
    insertMessage("200-a", "ses_1", 202, { role: "assistant" });
    insertPart("200-a-1", "200-a", "ses_1", 203, {
      type: "text",
      text: "still working",
    });
    // no step-finish part at all

    const result = await readOpenCodeTranscript(
      dbPath,
      { nativeSessionId: "ses_1", cwd: "/tmp/proj" },
      1,
    );
    expect(result?.turns).toEqual([
      {
        role: "assistant",
        text: "first reply",
        timestamp: new Date(102).toISOString(),
      },
    ]);
  });

  it("does not attach a trailing UNANSWERED prompt to an older, unrelated reply", async () => {
    // Regression case: the newest message is a user prompt with no assistant
    // reply after it yet (agent still working / crashed mid-turn). Its text
    // must not drift onto the previous, unrelated completed exchange.
    insertSession("ses_1", "/tmp/proj", 100);
    seedExchange("ses_1", 100, "first", "first reply");
    insertMessage("300-u", "ses_1", 300, { role: "user" });
    insertPart("300-u-1", "300-u", "ses_1", 301, {
      type: "text",
      text: "unanswered prompt",
    });

    const result = await readOpenCodeTranscript(
      dbPath,
      { nativeSessionId: "ses_1", cwd: "/tmp/proj" },
      2, // widen past the unanswered trailing prompt
    );
    expect(result?.turns).toEqual([
      {
        role: "assistant",
        text: "first reply",
        timestamp: new Date(102).toISOString(),
      },
    ]);
  });

  it("falls back to the newest-assistant-activity session sharing cwd when nativeSessionId is absent", async () => {
    insertSession("ses_old", "/tmp/proj", 100);
    seedExchange("ses_old", 100, "old prompt", "old reply");
    insertSession("ses_new", "/tmp/proj", 500);
    seedExchange("ses_new", 500, "new prompt", "new reply");
    // A session with a DIFFERENT cwd must never be picked.
    insertSession("ses_other", "/tmp/elsewhere", 900);
    seedExchange("ses_other", 900, "other prompt", "other reply");

    const result = await readOpenCodeTranscript(
      dbPath,
      { cwd: "/tmp/proj" },
      1,
    );
    expect(result?.turns).toEqual([
      {
        role: "assistant",
        text: "new reply",
        timestamp: new Date(502).toISOString(),
      },
    ]);
  });

  it("returns null when no session matches the cwd", async () => {
    insertSession("ses_1", "/tmp/other", 100);
    seedExchange("ses_1", 100, "hi", "hello");

    const result = await readOpenCodeTranscript(
      dbPath,
      { cwd: "/tmp/proj" },
      1,
    );
    expect(result).toBeNull();
  });

  it("skips an oversized text part and sets truncated", async () => {
    insertSession("ses_1", "/tmp/proj", 100);
    insertMessage("100-u", "ses_1", 100, { role: "user" });
    insertPart("100-u-1", "100-u", "ses_1", 101, {
      type: "text",
      text: "prompt",
    });
    insertMessage("100-a", "ses_1", 102, { role: "assistant" });
    insertPart("100-a-1", "100-a", "ses_1", 103, {
      type: "text",
      text: "x".repeat(300_000), // > MAX_LINE_BYTES (256 KiB)
    });
    insertPart("100-a-2", "100-a", "ses_1", 104, {
      type: "text",
      text: "a real short reply",
    });
    insertPart("100-a-3", "100-a", "ses_1", 105, {
      type: "step-finish",
      reason: "stop",
    });

    const result = await readOpenCodeTranscript(
      dbPath,
      { nativeSessionId: "ses_1", cwd: "/tmp/proj" },
      1,
    );
    expect(result?.turns).toEqual([
      {
        role: "assistant",
        text: "a real short reply",
        timestamp: new Date(102).toISOString(),
      },
    ]);
    expect(result?.truncated).toBe(true);
  });

  it("returns null for a missing database file rather than throwing", async () => {
    const result = await readOpenCodeTranscript(
      join(dir, "does-not-exist.db"),
      { nativeSessionId: "ses_1", cwd: "/tmp/proj" },
      1,
    );
    expect(result).toBeNull();
  });
});
