import { describe, it, expect } from "bun:test";
import { shouldPersistWidth, PREFS_QUIET_MS } from "./sidebar-width";

/** A decision where every gate passes; individual tests override one field to
 * isolate the gate under test. windowWidth 220 leaves 40 comfortably under the
 * half-window ceiling (110). */
function passing(
  overrides: Partial<Parameters<typeof shouldPersistWidth>[0]> = {},
) {
  return {
    settledWidth: 40,
    configuredWidth: 30,
    windowWidth: 220,
    prevWindowWidth: 220,
    windowActive: true,
    sessionAttached: true,
    prefsAgeMs: null,
    ...overrides,
  };
}

describe("shouldPersistWidth", () => {
  it("persists a drag: width changed while window size held", () => {
    expect(shouldPersistWidth(passing())).toBe(true);
  });

  it("ignores a settled width equal to the configured width", () => {
    expect(shouldPersistWidth(passing({ settledWidth: 30 }))).toBe(false);
  });

  it("ignores width changes that coincide with a window resize", () => {
    // Session switch / terminal resize: tmux rescaled the pane and the
    // window-resized hook will re-pin it. Must not persist the transient.
    expect(
      shouldPersistWidth(passing({ windowWidth: 220, prevWindowWidth: 80 })),
    ).toBe(false);
  });

  it("fails safe when window width cannot be determined", () => {
    expect(shouldPersistWidth(passing({ windowWidth: null }))).toBe(false);
    expect(shouldPersistWidth(passing({ prevWindowWidth: null }))).toBe(false);
  });

  it("ignores degenerate squeezed widths", () => {
    expect(shouldPersistWidth(passing({ settledWidth: 4 }))).toBe(false);
  });

  describe("window-relative ceiling", () => {
    it("rejects a settled width just over half the window", () => {
      // 111 * 2 = 222 > 220
      expect(shouldPersistWidth(passing({ settledWidth: 111 }))).toBe(false);
    });

    it("allows a settled width at exactly half the window", () => {
      // 110 * 2 = 220, not > 220
      expect(shouldPersistWidth(passing({ settledWidth: 110 }))).toBe(true);
    });

    it("allows a settled width comfortably under half the window", () => {
      expect(shouldPersistWidth(passing({ settledWidth: 60 }))).toBe(true);
    });
  });

  describe("focus gate", () => {
    it("rejects when the window is not active", () => {
      expect(shouldPersistWidth(passing({ windowActive: false }))).toBe(false);
    });

    it("rejects when the session is not attached", () => {
      expect(shouldPersistWidth(passing({ sessionAttached: false }))).toBe(
        false,
      );
    });

    it("rejects when focus state is unknown", () => {
      expect(shouldPersistWidth(passing({ windowActive: null }))).toBe(false);
      expect(shouldPersistWidth(passing({ sessionAttached: null }))).toBe(
        false,
      );
    });
  });

  describe("prefs quiet period", () => {
    it("rejects when the prefs file changed within the quiet period", () => {
      expect(
        shouldPersistWidth(passing({ prefsAgeMs: PREFS_QUIET_MS - 1 })),
      ).toBe(false);
      expect(shouldPersistWidth(passing({ prefsAgeMs: 0 }))).toBe(false);
    });

    it("allows once the prefs write is older than the quiet period", () => {
      expect(shouldPersistWidth(passing({ prefsAgeMs: PREFS_QUIET_MS }))).toBe(
        true,
      );
      expect(
        shouldPersistWidth(passing({ prefsAgeMs: PREFS_QUIET_MS + 1 })),
      ).toBe(true);
    });

    it("allows when the prefs age is unknown (no file)", () => {
      expect(shouldPersistWidth(passing({ prefsAgeMs: null }))).toBe(true);
    });
  });
});
