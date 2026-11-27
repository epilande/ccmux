import { describe, expect, it } from "bun:test";
import { openInPager, pagerCommand } from "./pager";

// OpenTUI 0.8's suspend and resume are async; each settles a tick late so a
// caller that does not await them would let the next step run first.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fakeRenderer(
  events: string[],
  suspendThrows = false,
  resumeFailures = 0,
) {
  let failures = resumeFailures;
  return {
    async suspend() {
      await tick();
      if (suspendThrows) throw new Error("no tty");
      events.push("suspend");
    },
    async resume() {
      await tick();
      if (failures > 0) {
        failures--;
        events.push("resume failed");
        throw new Error("resume exploded");
      }
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

  it("retries a failed resume once and keeps the pager's result", async () => {
    const events: string[] = [];
    const result = await openInPager(fakeRenderer(events, false, 1), "x", {
      env: {},
      spawn: async () => 0,
    });
    expect(result).toEqual({ ok: true });
    expect(events).toEqual(["suspend", "resume failed", "resume"]);
  });

  it("reports a resume that fails twice", async () => {
    const events: string[] = [];
    const result = await openInPager(fakeRenderer(events, false, 2), "x", {
      env: {},
      spawn: async () => 0,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("resume exploded");
    expect(events).toEqual(["suspend", "resume failed", "resume failed"]);
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
