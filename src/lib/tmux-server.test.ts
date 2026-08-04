import { describe, expect, it, afterEach, beforeEach, spyOn } from "bun:test";
import * as preferences from "./preferences";
import { markDaemonProcess, resetTmuxSocketCache } from "./tmux-socket";
import { currentTmuxSocket, isSameTmuxServer } from "./tmux-server";

const ORIGINAL_ENV = {
  TMUX: process.env.TMUX,
  CCMUX_TMUX_SOCKET: process.env.CCMUX_TMUX_SOCKET,
  TMUX_TMPDIR: process.env.TMUX_TMPDIR,
};

let prefsSpy: ReturnType<
  typeof spyOn<typeof preferences, "getPreferencesSync">
>;

beforeEach(() => {
  prefsSpy = spyOn(preferences, "getPreferencesSync").mockImplementation(
    () => ({}),
  );
  delete process.env.CCMUX_TMUX_SOCKET;
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

describe("currentTmuxSocket", () => {
  it("returns the socket path (first field of $TMUX)", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,35273,3";
    expect(currentTmuxSocket()).toBe("/private/tmp/tmux-501/default");
  });

  it("returns null when not inside tmux", () => {
    delete process.env.TMUX;
    expect(currentTmuxSocket()).toBe(null);
  });

  it("returns the override's socket when outside tmux with one configured", () => {
    delete process.env.TMUX;
    process.env.CCMUX_TMUX_SOCKET = "/tmp/work.sock";
    expect(currentTmuxSocket()).toBe("/tmp/work.sock");
  });

  it("still reports the ambient socket for a client inside tmux", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    process.env.CCMUX_TMUX_SOCKET = "work";
    expect(currentTmuxSocket()).toBe("/private/tmp/tmux-501/default");
  });

  it("reports the override for the daemon even inside tmux", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    process.env.CCMUX_TMUX_SOCKET = "/tmp/work.sock";
    markDaemonProcess();
    expect(currentTmuxSocket()).toBe("/tmp/work.sock");
  });
});

describe("isSameTmuxServer", () => {
  it("returns false when both sockets are known and differ", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(isSameTmuxServer("/private/tmp/tmux-501/alt")).toBe(false);
  });

  it("returns true when both sockets are known and match", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(isSameTmuxServer("/private/tmp/tmux-501/default")).toBe(true);
  });

  it("fails open when the daemon socket is unknown", () => {
    process.env.TMUX = "/private/tmp/tmux-501/default,1,0";
    expect(isSameTmuxServer(null)).toBe(true);
  });

  it("fails open when this process is not inside tmux", () => {
    delete process.env.TMUX;
    expect(isSameTmuxServer("/private/tmp/tmux-501/default")).toBe(true);
  });

  /**
   * The override makes the guard strictly stronger: outside tmux it used to
   * know nothing about its own server, and now a client pointed at the same
   * one the daemon scans can prove it.
   */
  it("matches an override-configured client against the daemon's socket", () => {
    delete process.env.TMUX;
    process.env.CCMUX_TMUX_SOCKET = "/tmp/work.sock";
    expect(isSameTmuxServer("/tmp/work.sock")).toBe(true);
    expect(isSameTmuxServer("/private/tmp/tmux-501/default")).toBe(false);
  });
});
