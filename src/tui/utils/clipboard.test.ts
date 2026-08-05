import { describe, it, expect } from "bun:test";
import {
  clipboardCommands,
  copyToClipboard,
  prefersOsc52,
  type CopyDeps,
} from "./clipboard";

describe("clipboardCommands", () => {
  it("uses pbcopy on darwin", () => {
    expect(clipboardCommands("darwin")).toEqual([["pbcopy"]]);
  });

  it("tries wl-copy before xclip on linux", () => {
    expect(clipboardCommands("linux")).toEqual([
      ["wl-copy"],
      ["xclip", "-selection", "clipboard"],
    ]);
  });

  it("has nothing to offer on a platform it knows no command for", () => {
    expect(clipboardCommands("win32")).toEqual([]);
  });
});

describe("prefersOsc52", () => {
  it("is false for a local session", () => {
    expect(prefersOsc52({})).toBe(false);
  });

  it("is true under SSH, where a local command copies to the wrong machine", () => {
    expect(prefersOsc52({ SSH_TTY: "/dev/ttys004" })).toBe(true);
    expect(prefersOsc52({ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" })).toBe(
      true,
    );
  });
});

/** A ladder that records what each tier was asked to do. */
function recordingDeps(overrides: Partial<CopyDeps> = {}) {
  const calls: string[] = [];
  const deps: CopyDeps = {
    osc52: (text) => {
      calls.push(`osc52:${text}`);
      return false;
    },
    runCommand: async (argv, text) => {
      calls.push(`${argv.join(" ")}:${text}`);
      return false;
    },
    platform: "darwin",
    env: {},
    ...overrides,
  };
  return { calls, deps };
}

describe("copyToClipboard", () => {
  it("takes the local command first and never reaches OSC 52", async () => {
    const { calls, deps } = recordingDeps({
      runCommand: async () => true,
      osc52: () => {
        calls.push("osc52");
        return true;
      },
    });
    const result = await copyToClipboard("hi", deps);
    expect(result).toEqual({ ok: true, via: "command" });
    expect(calls).toEqual([]);
  });

  it("falls through to OSC 52 when no command takes the text", async () => {
    const { calls, deps } = recordingDeps({ osc52: () => true });
    const result = await copyToClipboard("hi", deps);
    expect(result).toEqual({ ok: true, via: "osc52" });
    expect(calls).toEqual(["pbcopy:hi"]);
  });

  it("tries every command for the platform before giving up on the tier", async () => {
    const { calls, deps } = recordingDeps({ platform: "linux" });
    await copyToClipboard("hi", deps);
    expect(calls).toEqual([
      "wl-copy:hi",
      "xclip -selection clipboard:hi",
      "osc52:hi",
    ]);
  });

  it("stops at the first command that succeeds", async () => {
    const calls: string[] = [];
    const result = await copyToClipboard("hi", {
      osc52: () => false,
      runCommand: async (argv) => {
        calls.push(argv[0]!);
        return argv[0] === "wl-copy";
      },
      platform: "linux",
      env: {},
    });
    expect(result).toEqual({ ok: true, via: "command" });
    expect(calls).toEqual(["wl-copy"]);
  });

  it("leads with OSC 52 under SSH", async () => {
    const { calls, deps } = recordingDeps({
      env: { SSH_TTY: "/dev/ttys004" },
      osc52: () => true,
    });
    const result = await copyToClipboard("hi", deps);
    expect(result).toEqual({ ok: true, via: "osc52" });
    expect(calls).toEqual([]);
  });

  it("still reaches the local command when SSH's OSC 52 write fails", async () => {
    const { calls, deps } = recordingDeps({
      env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
    });
    await copyToClipboard("hi", deps);
    expect(calls).toEqual(["osc52:hi", "pbcopy:hi"]);
  });

  it("treats a throwing OSC 52 write as that tier declining", async () => {
    const result = await copyToClipboard("hi", {
      osc52: () => {
        throw new Error("renderer destroyed");
      },
      runCommand: async () => true,
      platform: "darwin",
      env: { SSH_TTY: "/dev/ttys004" },
    });
    expect(result).toEqual({ ok: true, via: "command" });
  });

  it("reports failure when no tier has a clipboard", async () => {
    const { deps } = recordingDeps({ platform: "win32" });
    expect(await copyToClipboard("hi", deps)).toEqual({ ok: false, via: null });
  });
});
