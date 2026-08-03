import { describe, it, expect, afterEach, beforeEach, spyOn } from "bun:test";
import * as preferences from "../../lib/preferences";
import { resetTmuxSocketCache } from "../../lib/tmux-socket";
import { isSameServerCached, setDaemonSocketPath } from "./server-guard";

const ORIGINAL_ENV = {
  TMUX: process.env.TMUX,
  CCMUX_TMUX_SOCKET: process.env.CCMUX_TMUX_SOCKET,
};

/**
 * The guard now knows its own server from a configured socket override too, so
 * the developer's real env/config would decide these cases. Stub both (spyOn,
 * not mock.module, which leaks across files).
 */
let prefsSpy: ReturnType<
  typeof spyOn<typeof preferences, "getPreferencesSync">
>;

beforeEach(() => {
  prefsSpy = spyOn(preferences, "getPreferencesSync").mockImplementation(
    () => ({}),
  );
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
  // Module-global cache: restore fail-open for every other test file.
  setDaemonSocketPath(null);
});

describe("server-guard", () => {
  it("fails open while the daemon socket is unknown", () => {
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath(null);
    expect(isSameServerCached()).toBe(true);
  });

  it("caches a refusal when the sockets are known and differ", () => {
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath("/tmp/tmux-test/other");
    expect(isSameServerCached()).toBe(false);
  });

  it("caches an allow when the sockets match", () => {
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath("/tmp/tmux-test/mine");
    expect(isSameServerCached()).toBe(true);
  });

  it("fails open when this process has no server of its own (no $TMUX, no override)", () => {
    delete process.env.TMUX;
    setDaemonSocketPath("/tmp/tmux-test/other");
    expect(isSameServerCached()).toBe(true);
  });

  /**
   * Outside tmux a configured override IS this process's server, so the
   * comparison has two known sockets and the refusal is provable.
   */
  it("refuses a mismatch against a configured socket override", () => {
    delete process.env.TMUX;
    process.env.CCMUX_TMUX_SOCKET = "/tmp/tmux-test/mine";
    resetTmuxSocketCache();
    setDaemonSocketPath("/tmp/tmux-test/other");
    expect(isSameServerCached()).toBe(false);
  });

  it("re-learning an unknown socket returns to fail-open", () => {
    process.env.TMUX = "/tmp/tmux-test/mine,1,0";
    setDaemonSocketPath("/tmp/tmux-test/other");
    expect(isSameServerCached()).toBe(false);
    setDaemonSocketPath(null);
    expect(isSameServerCached()).toBe(true);
  });
});
