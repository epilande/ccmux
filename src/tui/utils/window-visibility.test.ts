import { describe, it, expect } from "bun:test";
import { createRoot } from "solid-js";
import {
  createWindowVisibility,
  isVisibleWindowState,
} from "./window-visibility";
import { UNKNOWN_WINDOW_STATE, type WindowState } from "./tmux-window-state";

const state = (overrides: Partial<WindowState> = {}): WindowState => ({
  windowWidth: 200,
  windowActive: true,
  sessionAttached: true,
  ...overrides,
});

/** Lets the debounce timer plus the fetch microtask land. */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("isVisibleWindowState", () => {
  it("is visible only for the active window of an attached session", () => {
    expect(isVisibleWindowState(state())).toBe(true);
    expect(isVisibleWindowState(state({ windowActive: false }))).toBe(false);
    expect(isVisibleWindowState(state({ sessionAttached: false }))).toBe(false);
  });

  it("fails open on unknown fields", () => {
    // A sidebar wrongly frozen in the window the user is looking at is worse
    // than redraws nobody sees, so unknown must mean visible.
    expect(isVisibleWindowState(UNKNOWN_WINDOW_STATE)).toBe(true);
    expect(isVisibleWindowState(state({ windowActive: null }))).toBe(true);
    expect(isVisibleWindowState(state({ sessionAttached: null }))).toBe(true);
  });

  it("stays hidden when one field is known false and the other unknown", () => {
    expect(
      isVisibleWindowState(
        state({ windowActive: false, sessionAttached: null }),
      ),
    ).toBe(false);
  });
});

describe("createWindowVisibility", () => {
  it("starts visible before the first fetch resolves", () => {
    createRoot((dispose) => {
      const { visible } = createWindowVisibility({
        fetch: () => new Promise(() => {}),
        pollMs: 60_000,
      });
      expect(visible()).toBe(true);
      dispose();
    });
  });

  it("goes invisible once tmux reports a background window", async () => {
    let dispose = () => {};
    const { visible } = createRoot((d) => {
      dispose = d;
      return createWindowVisibility({
        fetch: async () => state({ windowActive: false }),
        pollMs: 60_000,
      });
    });
    await settle(10);
    expect(visible()).toBe(false);
    dispose();
  });

  it("goes invisible when the session has no attached client", async () => {
    let dispose = () => {};
    const { visible } = createRoot((d) => {
      dispose = d;
      return createWindowVisibility({
        fetch: async () => state({ sessionAttached: false }),
        pollMs: 60_000,
      });
    });
    await settle(10);
    expect(visible()).toBe(false);
    dispose();
  });

  it("fails open when the fetch rejects", async () => {
    let dispose = () => {};
    let attempt = 0;
    const { visible, refresh } = createRoot((d) => {
      dispose = d;
      return createWindowVisibility({
        fetch: async () => {
          attempt++;
          if (attempt === 1) return state({ windowActive: false });
          throw new Error("tmux gone");
        },
        debounceMs: 1,
        pollMs: 60_000,
      });
    });
    await settle(10);
    expect(visible()).toBe(false);
    refresh();
    await settle(20);
    expect(visible()).toBe(true);
    dispose();
  });

  it("transitions back to visible on refresh", async () => {
    let dispose = () => {};
    let active = false;
    const { visible, refresh } = createRoot((d) => {
      dispose = d;
      return createWindowVisibility({
        fetch: async () => state({ windowActive: active }),
        debounceMs: 1,
        pollMs: 60_000,
      });
    });
    await settle(10);
    expect(visible()).toBe(false);
    active = true;
    refresh();
    await settle(20);
    expect(visible()).toBe(true);
    dispose();
  });

  it("coalesces a burst of refreshes into one fetch", async () => {
    let dispose = () => {};
    let calls = 0;
    const { refresh } = createRoot((d) => {
      dispose = d;
      return createWindowVisibility({
        fetch: async () => {
          calls++;
          return state();
        },
        debounceMs: 20,
        pollMs: 60_000,
      });
    });
    await settle(5);
    expect(calls).toBe(1); // the initial check
    for (let i = 0; i < 10; i++) refresh();
    await settle(60);
    expect(calls).toBe(2);
    dispose();
  });

  it("polls as a safety net for attach/detach", async () => {
    let dispose = () => {};
    let calls = 0;
    createRoot((d) => {
      dispose = d;
      return createWindowVisibility({
        fetch: async () => {
          calls++;
          return state();
        },
        debounceMs: 1,
        pollMs: 15,
      });
    });
    await settle(60);
    expect(calls).toBeGreaterThan(2);
    dispose();
  });

  it("stops fetching after dispose", async () => {
    let dispose = () => {};
    let calls = 0;
    const { refresh } = createRoot((d) => {
      dispose = d;
      return createWindowVisibility({
        fetch: async () => {
          calls++;
          return state();
        },
        debounceMs: 5,
        pollMs: 10,
      });
    });
    await settle(5);
    const afterInit = calls;
    dispose();
    refresh();
    await settle(50);
    expect(calls).toBe(afterInit);
  });
});
