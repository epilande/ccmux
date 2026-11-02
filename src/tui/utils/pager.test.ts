import { describe, expect, it } from "bun:test";
import { openInPager, pagerCommand } from "./pager";

function fakeRenderer(events: string[], suspendThrows = false) {
  return {
    suspend() {
      if (suspendThrows) throw new Error("no tty");
      events.push("suspend");
    },
    resume() {
      events.push("resume");
    },
  };
}

describe("pagerCommand", () => {
  it("runs $PAGER through the shell, the way git does", () => {
    expect(pagerCommand({ PAGER: "bat -p" })).toEqual(["sh", "-c", "bat -p"]);
  });

  it("falls back to less, opened at the end, without raw escapes", () => {
    expect(pagerCommand({})).toEqual(["less", "+G"]);
    expect(pagerCommand({ PAGER: "  " })).toEqual(["less", "+G"]);
  });
});

describe("openInPager", () => {
  it("pipes the text to the pager between a suspend and a resume", async () => {
    const events: string[] = [];
    const result = await openInPager(fakeRenderer(events), "hello", {
      env: {},
      spawn: async (argv, text) => {
        events.push(`spawn ${argv.join(" ")} <${text}>`);
        return 0;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(events).toEqual(["suspend", "spawn less +G <hello>", "resume"]);
  });

  it("reports a pager that exits nonzero, as sh does for a missing one", async () => {
    const events: string[] = [];
    const result = await openInPager(fakeRenderer(events), "x", {
      env: { PAGER: "nope" },
      spawn: async () => 127,
    });
    expect(result).toEqual({ ok: false, error: "nope exited 127" });
    expect(events).toEqual(["suspend", "resume"]);
  });

  it("resumes even when the pager cannot be run", async () => {
    const events: string[] = [];
    const result = await openInPager(fakeRenderer(events), "x", {
      env: { PAGER: "nope" },
      spawn: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(result.ok).toBe(false);
    expect(events).toEqual(["suspend", "resume"]);
  });

  it("does not resume what it never suspended", async () => {
    const events: string[] = [];
    const result = await openInPager(fakeRenderer(events, true), "x", {
      spawn: async () => 0,
    });
    expect(result.ok).toBe(false);
    expect(events).toEqual([]);
  });
});
