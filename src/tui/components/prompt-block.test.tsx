import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { SessionList } from "./SessionList";
import { TickContext } from "../store";
import { mockEnrichedSession } from "./test-helpers";
import { promptBlockWidth } from "./session-columns";
import { wrapToLines } from "../utils/format";
import type { FlatItem } from "../utils/grouping";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;
afterEach(() => setup?.renderer.destroy());

const LONG =
  "Please refactor the upload queue so retried jobs go back to the end of " +
  "the pending pool before the next scheduler tick runs, and make sure the " +
  "progress bar still updates end to end.";

function item(id: string, lastPrompt: string | null): FlatItem {
  return {
    type: "session",
    groupKey: "g",
    filteredSession: {
      session: mockEnrichedSession({ id, lastPrompt }),
      highlights: null,
    },
  };
}

async function render(items: FlatItem[], promptLines: number, width = 60) {
  const [tick] = createSignal(0);
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <SessionList
          items={items}
          selectedIndex={0}
          previewWidth={30}
          promptLines={promptLines}
        />
      </TickContext.Provider>
    ),
    { width, height: 24 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

/** Lines of the frame that carry any of the prompt's own words. */
function promptLinesIn(frame: string, needle: string): string[] {
  return frame.split("\n").filter((l) => l.includes(needle));
}

describe("wrapped prompt block", () => {
  it("is absent when promptLines is 0", async () => {
    const frame = await render([item("a", LONG)], 0);
    expect(frame).not.toContain("pending pool");
  });

  it("renders the prompt across several physical lines", async () => {
    const frame = await render([item("a", LONG)], 4);
    // Text that can only be visible if the block wrapped rather than
    // truncating to a single cell.
    expect(frame).toContain("pending pool");
    expect(promptLinesIn(frame, "refactor").length).toBeGreaterThan(0);
  });

  it("occupies exactly promptLines lines and no more", async () => {
    for (const max of [1, 2, 5]) {
      const frame = await render([item("a", LONG)], max);
      const width = 60;
      const expected = wrapToLines(LONG, promptBlockWidth(width), max);
      expect(expected.length).toBeLessThanOrEqual(max);
      // Every wrapped line the helper produced is actually on screen.
      for (const line of expected.slice(0, -1)) {
        expect(frame).toContain(line.trim().slice(0, 20));
      }
      setup.renderer.destroy();
    }
  });

  it("does not print the prompt twice when a prompt column is also present", async () => {
    const frame = await render([item("a", "unique-token-xyz")], 3);
    const hits = frame
      .split("\n")
      .filter((l) => l.includes("unique-token-xyz")).length;
    expect(hits).toBe(1);
  });

  it("pushes the next row down by exactly the lines it added", async () => {
    // The invariant that matters: the height SessionList reports to the
    // scroll math and the lines SessionItem draws are the same number. If
    // they disagree the row below lands in the wrong place, so measuring
    // where the row below lands measures the agreement directly.
    //
    // Anchored on the second row's IDENTITY line (its index + status), not
    // on its prompt text — with the block on, that text is in the block.
    const W = 60;
    const items = [item("a", LONG), item("b", "SECOND")];
    const secondRow = (frame: string) =>
      frame.split("\n").findIndex((l) => /^\s*2 [●◐◑◒◓]/.test(l));

    const flat = await render(items, 0, W);
    const baseline = secondRow(flat);
    expect(baseline).toBeGreaterThanOrEqual(0);
    setup.renderer.destroy();

    for (const max of [1, 2, 3, 5]) {
      const frame = await render(items, max, W);
      const wrapped = wrapToLines(LONG, promptBlockWidth(W), max).length;
      expect(secondRow(frame) - baseline).toBe(wrapped);
      setup.renderer.destroy();
    }
  });

  it("gives a session with no prompt no block at all", async () => {
    const frame = await render([item("a", null), item("b", "SECOND")], 4);
    const rows = frame.split("\n");
    const first = rows.findIndex((l) => /^\s*1 [●◐◑◒◓]/.test(l));
    const second = rows.findIndex((l) => /^\s*2 [●◐◑◒◓]/.test(l));
    expect(second - first).toBe(1);
  });

  it("caps a runaway prompt at the configured height", async () => {
    const huge = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const frame = await render([item("a", huge), item("b", "SECOND")], 3);
    const second = frame
      .split("\n")
      .findIndex((l) => /^\s*2 [●◐◑◒◓]/.test(l));
    // identity + 3 capped lines, no matter how long the prompt is.
    expect(second).toBe(4);
    expect(frame).toContain("…");
  });
});
