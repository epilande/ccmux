import { describe, it, expect } from "bun:test";
import {
  shouldPersistWidth,
  passesLocalGates,
  passesWindowGates,
  createSidebarWidthPersister,
  PREFS_QUIET_MS,
} from "./sidebar-width";
import type { WindowState } from "./tmux-window-state";

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
    expect(shouldPersistWidth(passing({ prevWindowWidth: 80 }))).toBe(false);
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

  describe("split into local and window halves", () => {
    // The persister evaluates the halves in stages to avoid a subprocess; the
    // verdict must stay the conjunction of the two, whatever the order.
    it("is exactly the conjunction of both halves", () => {
      const cases = [
        passing(),
        passing({ settledWidth: 4 }),
        passing({ prefsAgeMs: 0 }),
        passing({ settledWidth: 30 }),
        passing({ windowActive: false }),
        passing({ prevWindowWidth: 80 }),
        passing({ windowWidth: null }),
        passing({ settledWidth: 111 }),
        passing({ settledWidth: 4, windowActive: false }),
      ];
      for (const c of cases) {
        expect(shouldPersistWidth(c)).toBe(
          passesLocalGates(c) && passesWindowGates(c),
        );
      }
    });

    it("keeps each gate on the side that can answer it locally", () => {
      // Degenerate width, quiet period and the no-op check need no tmux.
      expect(passesLocalGates(passing({ settledWidth: 4 }))).toBe(false);
      expect(passesLocalGates(passing({ prefsAgeMs: 0 }))).toBe(false);
      expect(passesLocalGates(passing({ settledWidth: 30 }))).toBe(false);
      expect(passesLocalGates(passing())).toBe(true);
      // Focus, ceiling and window-resize detection need live window state.
      expect(passesWindowGates(passing({ windowActive: false }))).toBe(false);
      expect(passesWindowGates(passing({ settledWidth: 111 }))).toBe(false);
      expect(passesWindowGates(passing({ prevWindowWidth: 80 }))).toBe(false);
      expect(passesWindowGates(passing())).toBe(true);
    });
  });
});

const flush = () => new Promise((r) => setTimeout(r, 5));

const windowState = (overrides: Partial<WindowState> = {}): WindowState => ({
  windowWidth: 220,
  windowActive: true,
  sessionAttached: true,
  ...overrides,
});

/**
 * Drives the persister with counted seams. `fetchWindowState` is the expensive
 * one (a `tmux display-message` subprocess in production), so the counts are
 * what the gate ordering is about.
 */
function persisterHarness(options: {
  prefsAgeMs?: number | null;
  configuredWidth?: number;
  state?: WindowState;
}) {
  const calls = { fetches: 0, applied: [] as number[] };
  const persist = createSidebarWidthPersister({
    fetchWindowState: async () => {
      calls.fetches++;
      return options.state ?? windowState();
    },
    getPrefsAgeMs: async () => options.prefsAgeMs ?? null,
    getConfiguredWidth: async () => options.configuredWidth ?? 30,
    applyWidth: (w) => calls.applied.push(w),
  });
  return { persist, calls };
}

describe("createSidebarWidthPersister", () => {
  it("persists a genuine drag", async () => {
    const { persist, calls } = persisterHarness({});
    await flush(); // let the mount baseline fetch land
    persist(40);
    await flush();
    expect(calls.applied).toEqual([40]);
  });

  it("does not fetch window state when the quiet period rejects", async () => {
    const { persist, calls } = persisterHarness({
      prefsAgeMs: PREFS_QUIET_MS - 1,
    });
    await flush();
    const afterMount = calls.fetches;
    persist(40);
    await flush();
    // A recent prefs write already decides this settle. Every backgrounded
    // sidebar hits this path on every propagated resize, so it must not cost
    // a subprocess just to learn it cannot persist.
    expect(calls.fetches).toBe(afterMount);
    expect(calls.applied).toEqual([]);
  });

  it("does not fetch window state when the width already matches prefs", async () => {
    const { persist, calls } = persisterHarness({ configuredWidth: 40 });
    await flush();
    const afterMount = calls.fetches;
    persist(40);
    await flush();
    expect(calls.fetches).toBe(afterMount);
    expect(calls.applied).toEqual([]);
  });

  it("does not fetch window state for a degenerate squeezed width", async () => {
    const { persist, calls } = persisterHarness({});
    await flush();
    const afterMount = calls.fetches;
    persist(4);
    await flush();
    expect(calls.fetches).toBe(afterMount);
    expect(calls.applied).toEqual([]);
  });

  it("fetches window state once a settle survives the local gates", async () => {
    const { persist, calls } = persisterHarness({});
    await flush();
    const afterMount = calls.fetches;
    persist(40);
    await flush();
    expect(calls.fetches).toBe(afterMount + 1);
  });

  it("still refuses a background sidebar after paying for the fetch", async () => {
    const { persist, calls } = persisterHarness({
      state: windowState({ windowActive: false }),
    });
    await flush();
    persist(40);
    await flush();
    expect(calls.applied).toEqual([]);
  });

  it("refuses a settle that coincides with a window resize", async () => {
    const calls = { applied: [] as number[] };
    let width = 220;
    const persist = createSidebarWidthPersister({
      fetchWindowState: async () => windowState({ windowWidth: width }),
      getPrefsAgeMs: async () => null,
      getConfiguredWidth: async () => 30,
      applyWidth: (w) => calls.applied.push(w),
    });
    await flush(); // baseline 220
    width = 120; // the window itself changed size
    persist(40);
    await flush();
    expect(calls.applied).toEqual([]);
    // The new width is now the baseline, so a later drag persists.
    persist(41);
    await flush();
    expect(calls.applied).toEqual([41]);
  });
});
