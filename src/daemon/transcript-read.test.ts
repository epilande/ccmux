import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MAX_LINE_BYTES,
  MAX_TURN_CHARS,
  foldJsonlTurns,
  readLinesBackwards,
  type LineMeaning,
} from "./transcript-read";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-transcript-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

async function collect(path: string, chunkSize?: number) {
  const out: (string | null)[] = [];
  for await (const line of readLinesBackwards(path, chunkSize)) out.push(line);
  return out;
}

describe("readLinesBackwards", () => {
  it("yields lines newest first", async () => {
    const path = write("a.jsonl", "one\ntwo\nthree\n");
    expect(await collect(path)).toEqual(["three", "two", "one"]);
  });

  it("yields the final line when the file has no trailing newline", async () => {
    const path = write("b.jsonl", "one\ntwo");
    expect(await collect(path)).toEqual(["two", "one"]);
  });

  it("returns nothing for an empty or missing file", async () => {
    expect(await collect(write("empty.jsonl", ""))).toEqual([]);
    expect(await collect(join(dir, "nope.jsonl"))).toEqual([]);
  });

  it("joins lines split across chunk boundaries", async () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `line-${i}-${"x".repeat(50)}`,
    );
    const path = write("c.jsonl", lines.join("\n") + "\n");
    // A tiny chunk forces most lines to straddle a boundary.
    expect(await collect(path, 17)).toEqual([...lines].reverse());
  });

  it("decodes multi-byte characters split across a chunk boundary", async () => {
    const path = write("d.jsonl", "héllo wörld ✨\nsecond ✅\n");
    expect(await collect(path, 3)).toEqual(["second ✅", "héllo wörld ✨"]);
  });

  it("yields null for an oversized line instead of its text", async () => {
    const huge = "x".repeat(MAX_LINE_BYTES + 10);
    const path = write("e.jsonl", `first\n${huge}\nlast\n`);
    expect(await collect(path)).toEqual(["last", null, "first"]);
  });

  it("skips blank lines", async () => {
    const path = write("f.jsonl", "one\n\n\ntwo\n");
    expect(await collect(path)).toEqual(["two", "one"]);
  });
});

/** Minimal classifier: `{r: "assistant"|"user", t: "text", ts?}`. */
function classify(entry: unknown): LineMeaning {
  const e = entry as {
    r?: string;
    t?: string;
    ts?: string;
    authoritative?: boolean;
  };
  if (e?.r === "assistant") {
    return e.authoritative
      ? {
          kind: "assistant",
          text: e.t ?? "",
          timestamp: e.ts,
          authoritative: true,
        }
      : { kind: "assistant", text: e.t ?? "", timestamp: e.ts };
  }
  if (e?.r === "user")
    return { kind: "user", text: e.t ?? "", timestamp: e.ts };
  return { kind: "skip" };
}

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("foldJsonlTurns", () => {
  it("returns only the last response for turns=1", async () => {
    const path = write(
      "t.jsonl",
      jsonl(
        { r: "user", t: "q1" },
        { r: "assistant", t: "a1" },
        { r: "user", t: "q2" },
        { r: "assistant", t: "a2" },
      ),
    );
    const result = await foldJsonlTurns(path, 1, classify);
    expect(result).toEqual({
      turns: [{ role: "assistant", text: "a2" }],
      truncated: false,
    });
  });

  it("widens backwards without ever including a leading prompt", async () => {
    const path = write(
      "t.jsonl",
      jsonl(
        { r: "user", t: "q1" },
        { r: "assistant", t: "a1" },
        { r: "user", t: "q2" },
        { r: "assistant", t: "a2" },
      ),
    );
    const result = await foldJsonlTurns(path, 2, classify);
    expect(result?.turns).toEqual([
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ]);
  });

  it("keeps the same shape when the transcript runs out before the count", async () => {
    const path = write(
      "t.jsonl",
      jsonl({ r: "user", t: "q1" }, { r: "assistant", t: "a1" }),
    );
    const result = await foldJsonlTurns(path, 5, classify);
    expect(result?.turns).toEqual([{ role: "assistant", text: "a1" }]);
  });

  it("accumulates a turn's fragments oldest first, blank-line joined", async () => {
    const path = write(
      "t.jsonl",
      jsonl(
        { r: "user", t: "q" },
        { r: "assistant", t: "part one" },
        { r: "assistant", t: "part two" },
      ),
    );
    const result = await foldJsonlTurns(path, 1, classify);
    expect(result?.turns[0].text).toBe("part one\n\npart two");
  });

  it("lets an authoritative fragment replace the turn's other fragments", async () => {
    const path = write(
      "t.jsonl",
      jsonl(
        { r: "user", t: "q" },
        { r: "assistant", t: "narration" },
        { r: "assistant", t: "final", authoritative: true },
      ),
    );
    const result = await foldJsonlTurns(path, 1, classify);
    expect(result?.turns).toEqual([{ role: "assistant", text: "final" }]);
  });

  it("skips a trailing prompt the agent has not answered yet", async () => {
    const path = write(
      "t.jsonl",
      jsonl(
        { r: "user", t: "q1" },
        { r: "assistant", t: "a1" },
        { r: "user", t: "q2-unanswered" },
      ),
    );
    const result = await foldJsonlTurns(path, 1, classify);
    expect(result?.turns).toEqual([{ role: "assistant", text: "a1" }]);
  });

  it("carries the newest fragment's timestamp for a multi-line turn", async () => {
    const path = write(
      "t.jsonl",
      jsonl(
        { r: "user", t: "q", ts: "2024-01-15T12:00:00Z" },
        { r: "assistant", t: "one", ts: "2024-01-15T12:00:01Z" },
        { r: "assistant", t: "two", ts: "2024-01-15T12:00:09Z" },
      ),
    );
    const result = await foldJsonlTurns(path, 1, classify);
    expect(result?.turns[0].timestamp).toBe("2024-01-15T12:00:09Z");
  });

  it("caps a turn at MAX_TURN_CHARS keeping the tail, and flags truncation", async () => {
    const long = "a".repeat(MAX_TURN_CHARS + 500) + "THE-END";
    const path = write(
      "t.jsonl",
      jsonl({ r: "user", t: "q" }, { r: "assistant", t: long }),
    );
    const result = await foldJsonlTurns(path, 1, classify);
    expect(result?.truncated).toBe(true);
    expect(result?.turns[0].text.endsWith("THE-END")).toBe(true);
    expect(result?.turns[0].text.startsWith("… ")).toBe(true);
    expect(result?.turns[0].text.length).toBe(MAX_TURN_CHARS + 2);
  });

  it("skips an oversized line unparsed and flags truncation", async () => {
    const toolResult = JSON.stringify({
      r: "assistant",
      t: "x".repeat(MAX_LINE_BYTES),
    });
    const path = write(
      "t.jsonl",
      jsonl({ r: "user", t: "q" }, { r: "assistant", t: "real answer" }) +
        toolResult +
        "\n",
    );
    const result = await foldJsonlTurns(path, 1, classify);
    expect(result?.truncated).toBe(true);
    expect(result?.turns).toEqual([{ role: "assistant", text: "real answer" }]);
  });

  it("tolerates malformed and primitive lines", async () => {
    const path = write(
      "t.jsonl",
      "null\nnot json at all\n42\n" +
        jsonl({ r: "user", t: "q" }, { r: "assistant", t: "a" }),
    );
    const result = await foldJsonlTurns(path, 1, classify);
    expect(result?.turns).toEqual([{ role: "assistant", text: "a" }]);
  });

  it("returns null when the file is missing or holds no assistant text", async () => {
    expect(
      await foldJsonlTurns(join(dir, "gone.jsonl"), 1, classify),
    ).toBeNull();
    const path = write("t.jsonl", jsonl({ r: "user", t: "q" }));
    expect(await foldJsonlTurns(path, 1, classify)).toBeNull();
  });
});
