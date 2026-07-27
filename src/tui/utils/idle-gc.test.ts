import { describe, it, expect } from "bun:test";
import { createIdleGcScheduler } from "./idle-gc";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DELAY = 20;

function harness() {
  const collections: boolean[] = [];
  const scheduler = createIdleGcScheduler({
    gc: (force) => collections.push(force),
    delayMs: DELAY,
  });
  return { scheduler, collections };
}

describe("createIdleGcScheduler", () => {
  it("collects once the window has been hidden for the settle delay", async () => {
    const { scheduler, collections } = harness();
    scheduler.setVisible(false);
    expect(collections).toEqual([]); // not before the settle elapses
    await wait(DELAY * 3);
    // force=true: a synchronous full collection, affordable off screen.
    expect(collections).toEqual([true]);
  });

  it("never collects while visible", async () => {
    const { scheduler, collections } = harness();
    scheduler.setVisible(true);
    scheduler.setVisible(true);
    await wait(DELAY * 3);
    expect(collections).toEqual([]);
  });

  it("cancels when the window comes back before the settle elapses", async () => {
    const { scheduler, collections } = harness();
    scheduler.setVisible(false);
    await wait(DELAY / 2);
    scheduler.setVisible(true);
    await wait(DELAY * 3);
    expect(collections).toEqual([]);
  });

  it("does not thrash on rapid window flipping", async () => {
    const { scheduler, collections } = harness();
    for (let i = 0; i < 5; i++) {
      scheduler.setVisible(false);
      await wait(2);
      scheduler.setVisible(true);
      await wait(2);
    }
    await wait(DELAY * 3);
    expect(collections).toEqual([]);
  });

  it("keeps the original deadline when hidden repeatedly", async () => {
    const { scheduler, collections } = harness();
    scheduler.setVisible(false);
    await wait(DELAY / 2);
    scheduler.setVisible(false); // must not re-arm and push the deadline out
    await wait(DELAY);
    expect(collections).toEqual([true]);
  });

  it("re-arms after a hide -> show -> hide cycle", async () => {
    const { scheduler, collections } = harness();
    scheduler.setVisible(false);
    await wait(DELAY * 3);
    expect(collections).toEqual([true]);
    scheduler.setVisible(true);
    scheduler.setVisible(false);
    await wait(DELAY * 3);
    expect(collections).toEqual([true, true]);
  });

  it("cancel drops a pending collection", async () => {
    const { scheduler, collections } = harness();
    scheduler.setVisible(false);
    scheduler.cancel();
    await wait(DELAY * 3);
    expect(collections).toEqual([]);
  });
});
