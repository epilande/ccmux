import { describe, it, expect } from "bun:test";
import { resolvePaneLocation, sendPromptToPane } from "./pane-io";

/**
 * Stub `Bun.spawn`, recording argv and replaying one tmux outcome.
 * `throws` covers the case where the spawn itself fails (tmux missing,
 * fork failure) rather than tmux exiting nonzero.
 */
function withTmux(outcome: { code?: number; out?: string; throws?: boolean }) {
  const original = Bun.spawn;
  const argv: string[][] = [];
  Bun.spawn = ((spawned: string[]) => {
    argv.push(spawned);
    if (outcome.throws) throw new Error("spawn tmux ENOENT");
    return {
      exited: Promise.resolve(outcome.code ?? 0),
      stdout: new Blob([outcome.out ?? ""]).stream(),
      stderr: new Blob([""]).stream(),
    };
  }) as unknown as typeof Bun.spawn;
  return { argv, restore: () => (Bun.spawn = original) };
}

/** As {@link withTmux}, plus the writable stdin `load-buffer` needs. */
function withBufferTmux() {
  const original = Bun.spawn;
  const argv: string[][] = [];
  Bun.spawn = ((spawned: string[]) => {
    argv.push(spawned);
    return {
      exited: Promise.resolve(0),
      stdin: { write: () => {}, end: () => Promise.resolve() },
      stdout: new Blob([""]).stream(),
      stderr: new Blob([""]).stream(),
    };
  }) as unknown as typeof Bun.spawn;
  return { argv, restore: () => (Bun.spawn = original) };
}

describe("sendPromptToPane", () => {
  it("names a distinct tmux buffer per call, even for the same pane", async () => {
    // Two sends aimed at one pane used to share `ccmux-invoke%N`, so the
    // second load could overwrite the first's text between its load and its
    // paste: the pane got the wrong prompt, both callers were told it
    // worked, and Enter was pressed twice. /invoke, /send and the handoff
    // delivery all come through here, so they can genuinely overlap.
    const { argv, restore } = withBufferTmux();
    try {
      await Promise.all([
        sendPromptToPane("%3", "first", false),
        sendPromptToPane("%3", "second", false),
      ]);
      const names = argv
        .filter((a) => a.includes("load-buffer"))
        .map((a) => a[a.indexOf("-b") + 1]);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);

      // Each paste still names the buffer its own load wrote.
      const pasted = argv
        .filter((a) => a.includes("paste-buffer"))
        .map((a) => a[a.indexOf("-b") + 1]);
      expect(pasted.sort()).toEqual([...names].sort());
    } finally {
      restore();
    }
  });
});

describe("resolvePaneLocation", () => {
  // This one lookup decides where EVERY spawned pane lands: the window
  // for an explicit --target, the session for an implicit caller pane,
  // and whether the pane exists at all. A wrong answer here puts a
  // window in someone else's session; a wrongly-null answer 400s a
  // spawn that should have worked.

  it("returns the window and session ids for a live pane", async () => {
    const { argv, restore } = withTmux({ out: "@9 $3\n" });
    try {
      expect(await resolvePaneLocation("%12")).toEqual({
        windowId: "@9",
        sessionId: "$3",
      });
      // The format string is load-bearing: both ids, space-separated,
      // in this order.
      expect(argv[0]).toEqual([
        "tmux",
        "display-message",
        "-p",
        "-t",
        "%12",
        "-F",
        "#{window_id} #{session_id}",
      ]);
    } finally {
      restore();
    }
  });

  it("tolerates surrounding whitespace", async () => {
    const { restore } = withTmux({ out: "  @9 $3  \n\n" });
    try {
      expect(await resolvePaneLocation("%12")).toEqual({
        windowId: "@9",
        sessionId: "$3",
      });
    } finally {
      restore();
    }
  });

  it("returns null for a pane that no longer exists", async () => {
    // tmux exits 0 with EMPTY output for a closed pane. Folding that
    // into null is what turns a stale target into a clean 400 instead
    // of silently becoming "no placement" and landing the spawn in an
    // arbitrary session.
    for (const out of ["", "\n", "   \n"]) {
      const { restore } = withTmux({ code: 0, out });
      try {
        expect(await resolvePaneLocation("%404")).toBeNull();
      } finally {
        restore();
      }
    }
  });

  it("returns null when tmux exits nonzero", async () => {
    const { restore } = withTmux({ code: 1, out: "" });
    try {
      expect(await resolvePaneLocation("%12")).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null on a partial answer", async () => {
    // A window id with no session id must not be reported as a
    // location; the session half is what the implicit path targets.
    for (const out of ["@9\n", "@9 \n"]) {
      const { restore } = withTmux({ out });
      try {
        expect(await resolvePaneLocation("%12")).toBeNull();
      } finally {
        restore();
      }
    }
  });

  it("returns null instead of throwing when the spawn fails", async () => {
    // The caller turns null into a 400; an exception here would escape
    // as an opaque 500.
    const { restore } = withTmux({ throws: true });
    try {
      expect(await resolvePaneLocation("%12")).toBeNull();
    } finally {
      restore();
    }
  });
});
