import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as preferences from "./preferences";
import { markDaemonProcess, resetTmuxSocketCache } from "./tmux-socket";
import {
  tmuxArgv,
  tmuxArgvFor,
  tmuxShellPrefix,
  tmuxSocketArgs,
} from "./tmux-exec";

const ORIGINAL_ENV = {
  TMUX: process.env.TMUX,
  CCMUX_TMUX_SOCKET: process.env.CCMUX_TMUX_SOCKET,
};

let prefsSpy: ReturnType<
  typeof spyOn<typeof preferences, "getPreferencesSync">
>;

beforeEach(() => {
  prefsSpy = spyOn(preferences, "getPreferencesSync").mockImplementation(
    () => ({}),
  );
  delete process.env.TMUX;
  delete process.env.CCMUX_TMUX_SOCKET;
  resetTmuxSocketCache();
});

afterEach(() => {
  prefsSpy.mockRestore();
  resetTmuxSocketCache();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * The regression that matters most: an install with nothing configured must
 * produce exactly the argv every call site spelled out by hand before this
 * module existed. Anything else is a silent behavior change on every user's
 * machine, on every tmux call ccmux makes.
 */
describe("passthrough with no override configured", () => {
  it("builds the bare argv, byte for byte", () => {
    expect(tmuxSocketArgs()).toEqual([]);
    expect(tmuxArgv("list-panes", "-a", "-F", "#{pane_id}")).toEqual([
      "tmux",
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}",
    ]);
    expect(tmuxArgv()).toEqual(["tmux"]);
  });

  it("keeps a caller-resolved binary path", () => {
    expect(
      tmuxArgvFor("/opt/homebrew/bin/tmux", "switch-client", "-t", "%3"),
    ).toEqual(["/opt/homebrew/bin/tmux", "switch-client", "-t", "%3"]);
  });

  it("leaves an embedded shell invocation as a bare `tmux`", () => {
    expect(tmuxShellPrefix()).toBe("tmux");
  });

  it("passes through inside tmux too", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(tmuxArgv("kill-pane", "-t", "%1")).toEqual([
      "tmux",
      "kill-pane",
      "-t",
      "%1",
    ]);
  });
});

describe("with a socket label configured", () => {
  beforeEach(() => {
    process.env.CCMUX_TMUX_SOCKET = "work";
  });

  it("prepends -L before the command", () => {
    expect(tmuxArgv("list-panes", "-a")).toEqual([
      "tmux",
      "-L",
      "work",
      "list-panes",
      "-a",
    ]);
  });

  it("prepends -L for a caller-resolved binary too", () => {
    expect(tmuxArgvFor("/usr/bin/tmux", "switch-client")).toEqual([
      "/usr/bin/tmux",
      "-L",
      "work",
      "switch-client",
    ]);
  });

  it("quotes the label in an embedded shell invocation", () => {
    expect(tmuxShellPrefix()).toBe("tmux -L 'work'");
  });
});

describe("with a socket path configured", () => {
  beforeEach(() => {
    process.env.CCMUX_TMUX_SOCKET = "/tmp/tmux-501/work";
  });

  it("prepends -S before the command", () => {
    expect(tmuxArgv("display-message", "-p", "#{socket_path}")).toEqual([
      "tmux",
      "-S",
      "/tmp/tmux-501/work",
      "display-message",
      "-p",
      "#{socket_path}",
    ]);
  });

  it("quotes the path in an embedded shell invocation", () => {
    expect(tmuxShellPrefix()).toBe("tmux -S '/tmp/tmux-501/work'");
  });

  it("escapes a single quote so the shell string cannot be broken out of", () => {
    process.env.CCMUX_TMUX_SOCKET = "/tmp/it's here";
    // '/tmp/it' + \' + 's here' reassembles to /tmp/it's here in the shell.
    expect(tmuxShellPrefix()).toBe(`tmux -S '/tmp/it'\\''s here'`);
  });
});

describe("per-process rule reaches the builder", () => {
  it("a client inside tmux builds the bare argv despite an override", () => {
    process.env.CCMUX_TMUX_SOCKET = "work";
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(tmuxArgv("list-panes")).toEqual(["tmux", "list-panes"]);
    expect(tmuxShellPrefix()).toBe("tmux");
  });

  it("the daemon inside tmux still targets the override", () => {
    process.env.CCMUX_TMUX_SOCKET = "work";
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    markDaemonProcess();
    expect(tmuxArgv("list-panes")).toEqual([
      "tmux",
      "-L",
      "work",
      "list-panes",
    ]);
  });
});
