import { describe, it, expect } from "bun:test";
import { createFlashScheduler } from "./pane-flash";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  probed: string[];
  flashed: string[];
}

function harness(visible: boolean, sameServer = true) {
  const calls: Harness = { probed: [], flashed: [] };
  const scheduler = createFlashScheduler({
    visible: () => visible,
    sameServer: () => sameServer,
    paneInCurrentWindow: async (paneId) => {
      calls.probed.push(paneId);
      return true;
    },
    flash: (paneId) => calls.flashed.push(paneId),
    debounceMs: 5,
  });
  return { scheduler, calls };
}

describe("createFlashScheduler", () => {
  it("flashes a pane in the current window after the debounce", async () => {
    const { scheduler, calls } = harness(true);
    scheduler.schedule("%3");
    expect(calls.probed).toEqual([]); // nothing before the debounce fires
    await settle(20);
    expect(calls.probed).toEqual(["%3"]);
    expect(calls.flashed).toEqual(["%3"]);
  });

  it("skips everything while the window is invisible", async () => {
    const { scheduler, calls } = harness(false);
    scheduler.schedule("%3");
    await settle(20);
    // The early return happens before the timer is armed, so no tmux probe
    // and no flash ever happen for a background sidebar.
    expect(calls.probed).toEqual([]);
    expect(calls.flashed).toEqual([]);
  });

  it("coalesces rapid j/k into a single probe", async () => {
    const { scheduler, calls } = harness(true);
    scheduler.schedule("%1");
    scheduler.schedule("%2");
    scheduler.schedule("%3");
    await settle(20);
    expect(calls.probed).toEqual(["%3"]);
    expect(calls.flashed).toEqual(["%3"]);
  });

  it("skips the probe when the daemon is on another tmux server", async () => {
    const { scheduler, calls } = harness(true, false);
    scheduler.schedule("%3");
    await settle(20);
    expect(calls.probed).toEqual([]);
    expect(calls.flashed).toEqual([]);
  });

  it("does not flash a pane outside the current window", async () => {
    const flashed: string[] = [];
    const scheduler = createFlashScheduler({
      visible: () => true,
      sameServer: () => true,
      paneInCurrentWindow: async () => false,
      flash: (paneId) => flashed.push(paneId),
      debounceMs: 5,
    });
    scheduler.schedule("%9");
    await settle(20);
    expect(flashed).toEqual([]);
  });

  it("cancel drops a pending flash", async () => {
    const { scheduler, calls } = harness(true);
    scheduler.schedule("%3");
    scheduler.cancel();
    await settle(20);
    expect(calls.probed).toEqual([]);
  });

  it("ignores an empty pane id", async () => {
    const { scheduler, calls } = harness(true);
    scheduler.schedule("");
    await settle(20);
    expect(calls.probed).toEqual([]);
  });
});
