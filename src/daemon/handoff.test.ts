/**
 * Unit tests for the pure halves of handoff: the FROZEN provenance header,
 * the cap/truncation rule, the spawn-field normalizer, and the queue's
 * lifecycle (enqueue, replace, take-once, TTL expiry).
 */

import { describe, it, expect } from "bun:test";
import {
  composeHandoff,
  formatHandoffHeader,
  formatHandoffTime,
  HANDOFF_PREFIX,
  HANDOFF_TTL_MS,
  HandoffQueue,
  normalizeHandoffSpawn,
  type PendingHandoffRecord,
} from "./handoff";

/** Local time, so the fixture is built the same way the formatter reads it. */
const AT = new Date(2026, 7, 3, 14, 5);

describe("formatHandoffTime", () => {
  it("is local time to the minute, zero-padded", () => {
    expect(formatHandoffTime(AT)).toBe("2026-08-03 14:05");
    expect(formatHandoffTime(new Date(2026, 0, 9, 4, 7))).toBe(
      "2026-01-09 04:07",
    );
  });
});

describe("formatHandoffHeader", () => {
  const source = {
    sessionId: "sess-1",
    agentType: "codex",
    cwd: "/Users/x/code/ccmux",
  };

  it("matches the frozen format with a branch and a note", () => {
    expect(
      formatHandoffHeader({ ...source, branch: "feat/x" }, AT, "take it"),
    ).toBe(
      `${HANDOFF_PREFIX} from: sess-1 (codex · /Users/x/code/ccmux · branch feat/x) at 2026-08-03 14:05\n` +
        `note: take it`,
    );
  });

  it("drops the branch segment cleanly when there is none", () => {
    expect(formatHandoffHeader({ ...source, branch: null }, AT)).toBe(
      `${HANDOFF_PREFIX} from: sess-1 (codex · /Users/x/code/ccmux) at 2026-08-03 14:05`,
    );
    // A blank-string branch is the same as none, not an empty segment.
    expect(formatHandoffHeader({ ...source, branch: "  " }, AT)).toBe(
      `${HANDOFF_PREFIX} from: sess-1 (codex · /Users/x/code/ccmux) at 2026-08-03 14:05`,
    );
  });

  it("omits the note line entirely when no note is given", () => {
    expect(formatHandoffHeader(source, AT).split("\n")).toHaveLength(1);
    expect(formatHandoffHeader(source, AT, "   ").split("\n")).toHaveLength(1);
  });

  it("folds a multi-line note onto one line", () => {
    const header = formatHandoffHeader(source, AT, "first\nsecond\n\tthird");
    expect(header.split("\n")).toHaveLength(2);
    expect(header.split("\n")[1]).toBe("note: first second third");
  });
});

describe("composeHandoff", () => {
  it("joins header and payload with a blank line", () => {
    const { text, truncated } = composeHandoff("HDR", "body", 1000);
    expect(text).toBe("HDR\n\nbody");
    expect(truncated).toBe(false);
  });

  it("truncates the payload tail-preserving and fits the cap", () => {
    const payload = "START" + "x".repeat(200) + "END";
    const { text, truncated } = composeHandoff("HDR", payload, 40);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(40);
    expect(text.startsWith("HDR\n\n… ")).toBe(true);
    // The conclusion is what a handoff is for, so the END survives and the
    // START does not.
    expect(text.endsWith("END")).toBe(true);
    expect(text).not.toContain("START");
  });

  it("never emits a negative slice when the header eats the budget", () => {
    const { text, truncated } = composeHandoff("H".repeat(50), "payload", 40);
    expect(truncated).toBe(true);
    expect(text).toBe("H".repeat(50) + "\n\n… ");
  });
});

describe("normalizeHandoffSpawn", () => {
  it("reads absent / false as 'no spawn'", () => {
    for (const value of [undefined, null, false]) {
      expect(normalizeHandoffSpawn(value)).toEqual({ ok: true, value: null });
    }
  });

  it("reads true as an all-defaults spawn", () => {
    expect(normalizeHandoffSpawn(true)).toEqual({ ok: true, value: {} });
  });

  it("accepts overrides", () => {
    expect(
      normalizeHandoffSpawn({ agent: " claude ", cwd: "/tmp", split: "h" }),
    ).toEqual({
      ok: true,
      value: { agent: "claude", cwd: "/tmp", split: "h" },
    });
  });

  it("refuses malformed fields rather than coercing them", () => {
    expect(normalizeHandoffSpawn("claude").ok).toBe(false);
    expect(normalizeHandoffSpawn([]).ok).toBe(false);
    expect(normalizeHandoffSpawn({ agent: "" }).ok).toBe(false);
    expect(normalizeHandoffSpawn({ agent: 3 }).ok).toBe(false);
    expect(normalizeHandoffSpawn({ cwd: "" }).ok).toBe(false);
    expect(normalizeHandoffSpawn({ split: "x" }).ok).toBe(false);
  });
});

function record(
  to: string,
  from = "src",
): Omit<PendingHandoffRecord, "queuedAt" | "expiresAt"> {
  return {
    fromSessionId: from,
    toSessionId: to,
    text: "payload",
    truncated: false,
  };
}

/** A queue with a manual clock and no real timer. */
function makeQueue(expired: PendingHandoffRecord[] = []) {
  let now = 1_000;
  const queue = new HandoffQueue({
    now: () => now,
    onExpire: (r) => expired.push(r),
    setSweep: () => {},
  });
  return { queue, advance: (ms: number) => (now += ms), at: () => now };
}

describe("HandoffQueue", () => {
  it("enqueues, peeks and stamps the TTL", () => {
    const { queue, at } = makeQueue();
    const { record: stored, replaced } = queue.enqueue(record("t1"));
    expect(replaced).toBeNull();
    expect(stored.queuedAt).toBe(at());
    expect(stored.expiresAt).toBe(at() + HANDOFF_TTL_MS);
    expect(queue.peek("t1")).toEqual(stored);
    expect(queue.peek("other")).toBeNull();
  });

  it("replaces a second handoff for the same target and reports the first", () => {
    const { queue } = makeQueue();
    queue.enqueue(record("t1", "a"));
    const { replaced } = queue.enqueue(record("t1", "b"));
    expect(replaced?.fromSessionId).toBe("a");
    expect(queue.peek("t1")?.fromSessionId).toBe("b");
    expect(queue.size()).toBe(1);
  });

  it("take() hands the record out exactly once", () => {
    const { queue } = makeQueue();
    queue.enqueue(record("t1"));
    expect(queue.take("t1")?.fromSessionId).toBe("src");
    // The second observer of the same idle transition gets nothing, which is
    // what stops a handoff being pasted twice.
    expect(queue.take("t1")).toBeNull();
    expect(queue.size()).toBe(0);
  });

  it("purges an expired record on access and fires onExpire", () => {
    const expired: PendingHandoffRecord[] = [];
    const { queue, advance } = makeQueue(expired);
    queue.enqueue(record("t1"));
    advance(HANDOFF_TTL_MS + 1);
    expect(queue.peek("t1")).toBeNull();
    expect(queue.take("t1")).toBeNull();
    expect(expired.map((r) => r.toSessionId)).toEqual(["t1"]);
    expect(queue.size()).toBe(0);
  });

  it("sweeps expired records without anyone touching them", () => {
    const expired: PendingHandoffRecord[] = [];
    const { queue, advance } = makeQueue(expired);
    queue.enqueue(record("t1"));
    queue.enqueue(record("t2"));
    advance(HANDOFF_TTL_MS - 1);
    queue.enqueue(record("t3"));
    advance(2);
    queue.sweep();
    expect(expired.map((r) => r.toSessionId).sort()).toEqual(["t1", "t2"]);
    expect(queue.size()).toBe(1);
    expect(queue.peek("t3")).not.toBeNull();
  });

  it("drop() removes silently", () => {
    const expired: PendingHandoffRecord[] = [];
    const { queue } = makeQueue(expired);
    queue.enqueue(record("t1"));
    queue.drop("t1");
    expect(queue.peek("t1")).toBeNull();
    expect(expired).toHaveLength(0);
  });
});
