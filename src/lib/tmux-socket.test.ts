import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as preferences from "./preferences";
import {
  activeTmuxSocketOverride,
  attemptedTmuxSocketPath,
  markDaemonProcess,
  parseTmuxSocketValue,
  resetTmuxSocketCache,
  resolveTmuxSocketOverride,
  socketErrorMessage,
  tmuxSocketPath,
} from "./tmux-socket";

const ORIGINAL_ENV = {
  TMUX: process.env.TMUX,
  CCMUX_TMUX_SOCKET: process.env.CCMUX_TMUX_SOCKET,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
};

const uid = process.getuid?.() ?? 0;

/**
 * A symlinked TMUX_TMPDIR proves the label math realpaths the socket dir the
 * way tmux reports `#{socket_path}`, without depending on whether the host's
 * /tmp is itself a symlink (macOS) or a real directory (Linux CI).
 */
const realTmpBase = realpathSync(mkdtempSync(join(tmpdir(), "ccmux-socket-")));
const linkedTmpBase = `${realTmpBase}-link`;
symlinkSync(realTmpBase, linkedTmpBase);
mkdirSync(join(realTmpBase, `tmux-${uid}`));

afterAll(() => {
  rmSync(linkedTmpBase, { force: true });
  rmSync(realTmpBase, { recursive: true, force: true });
});

/**
 * `getPreferencesSync` reads the developer's real `~/.config/ccmux/ccmux.json`,
 * so every test stubs it (spyOn, not mock.module, which leaks across files).
 */
let prefsSpy: ReturnType<
  typeof spyOn<typeof preferences, "getPreferencesSync">
>;

function withPrefs(prefs: preferences.Preferences): void {
  prefsSpy.mockImplementation(() => prefs);
  resetTmuxSocketCache();
}

beforeEach(() => {
  prefsSpy = spyOn(preferences, "getPreferencesSync").mockImplementation(
    () => ({}),
  );
  delete process.env.TMUX;
  delete process.env.CCMUX_TMUX_SOCKET;
  // Pinned so the label -> path math is independent of the machine running it.
  process.env.TMUX_TMPDIR = "/tmp";
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

describe("parseTmuxSocketValue", () => {
  it("reads a leading slash as a socket path", () => {
    expect(parseTmuxSocketValue("/tmp/tmux-501/work")).toEqual({
      kind: "path",
      value: "/tmp/tmux-501/work",
    });
  });

  it("reads anything else as a socket label", () => {
    expect(parseTmuxSocketValue("work")).toEqual({
      kind: "label",
      value: "work",
    });
  });

  it("treats missing, empty and whitespace values as unconfigured", () => {
    expect(parseTmuxSocketValue(undefined)).toBe(null);
    expect(parseTmuxSocketValue(null)).toBe(null);
    expect(parseTmuxSocketValue("")).toBe(null);
    expect(parseTmuxSocketValue("   ")).toBe(null);
  });

  it("trims surrounding whitespace", () => {
    expect(parseTmuxSocketValue("  work  ")).toEqual({
      kind: "label",
      value: "work",
    });
  });
});

describe("resolveTmuxSocketOverride precedence", () => {
  it("returns null with nothing configured", () => {
    expect(resolveTmuxSocketOverride()).toBe(null);
  });

  it("falls back to the tmuxSocket preference", () => {
    withPrefs({ tmuxSocket: "from-prefs" });
    expect(resolveTmuxSocketOverride()).toEqual({
      kind: "label",
      value: "from-prefs",
    });
  });

  it("prefers the env var over the preference", () => {
    withPrefs({ tmuxSocket: "from-prefs" });
    process.env.CCMUX_TMUX_SOCKET = "from-env";
    expect(resolveTmuxSocketOverride()).toEqual({
      kind: "label",
      value: "from-env",
    });
  });

  it("ignores an empty env var rather than reading it as a value", () => {
    withPrefs({ tmuxSocket: "from-prefs" });
    process.env.CCMUX_TMUX_SOCKET = "";
    expect(resolveTmuxSocketOverride()).toEqual({
      kind: "label",
      value: "from-prefs",
    });
  });
});

describe("activeTmuxSocketOverride per-process rule", () => {
  it("applies to a client outside tmux", () => {
    withPrefs({ tmuxSocket: "work" });
    expect(activeTmuxSocketOverride()).toEqual({
      kind: "label",
      value: "work",
    });
  });

  it("defers to the ambient server for a client inside tmux", () => {
    withPrefs({ tmuxSocket: "work" });
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(activeTmuxSocketOverride()).toBe(null);
  });

  it("applies to the daemon even inside tmux (the issue #95 case)", () => {
    withPrefs({ tmuxSocket: "work" });
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    markDaemonProcess();
    expect(activeTmuxSocketOverride()).toEqual({
      kind: "label",
      value: "work",
    });
  });

  it("stays null for the daemon when nothing is configured", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    markDaemonProcess();
    expect(activeTmuxSocketOverride()).toBe(null);
  });
});

describe("tmuxSocketPath", () => {
  it("returns a path override verbatim", () => {
    expect(tmuxSocketPath({ kind: "path", value: "/tmp/mine" })).toBe(
      "/tmp/mine",
    );
  });

  it("resolves a label the way tmux does, under $TMUX_TMPDIR", () => {
    process.env.TMUX_TMPDIR = linkedTmpBase;
    expect(tmuxSocketPath({ kind: "label", value: "work" })).toBe(
      join(realTmpBase, `tmux-${uid}`, "work"),
    );
  });

  it("honors a custom $TMUX_TMPDIR", () => {
    process.env.TMUX_TMPDIR = "/no/such/tmpdir";
    const uid = process.getuid?.() ?? 0;
    // Nonexistent, so it cannot be realpath'd and is used as given.
    expect(tmuxSocketPath({ kind: "label", value: "work" })).toBe(
      join("/no/such/tmpdir", `tmux-${uid}`, "work"),
    );
  });
});

describe("attemptedTmuxSocketPath", () => {
  it("names the override when one applies", () => {
    withPrefs({ tmuxSocket: "/tmp/work.sock" });
    expect(attemptedTmuxSocketPath()).toBe("/tmp/work.sock");
  });

  it("names the ambient server when inside tmux", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(attemptedTmuxSocketPath()).toBe("/private/tmp/tmux-501/default");
  });

  it("falls back to tmux's default socket with nothing to go on", () => {
    process.env.TMUX_TMPDIR = linkedTmpBase;
    expect(attemptedTmuxSocketPath()).toBe(
      join(realTmpBase, `tmux-${uid}`, "default"),
    );
  });
});

describe("socketErrorMessage", () => {
  it("names the socket when known", () => {
    expect(socketErrorMessage("/tmp/tmux-501/work")).toBe(
      "tmux server unreachable at /tmp/tmux-501/work",
    );
  });

  it("stays generic when it is not", () => {
    expect(socketErrorMessage(null)).toBe("tmux server unreachable");
  });
});
