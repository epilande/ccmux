import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { SessionList } from "./SessionList";
import { TickContext } from "../store";
import { mockEnrichedSession } from "./test-helpers";
import { promptBlockWidth, PROMPT_BLOCK_MIN_WIDTH } from "./session-columns";
import type { PromptDisplay } from "../../lib/preferences";
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

interface Opts {
  promptDisplay?: PromptDisplay;
  searchActive?: boolean;
}

async function render(
  items: FlatItem[],
  promptLines: number,
  width = 60,
  opts: Opts = {},
) {
  const [tick] = createSignal(0);
  setup = await testRender(
    () => (
      <TickContext.Provider value={{ tick }}>
        <SessionList
          items={items}
          selectedIndex={0}
          previewWidth={30}
          promptLines={promptLines}
          promptDisplay={opts.promptDisplay}
          searchActive={opts.searchActive}
        />
      </TickContext.Provider>
    ),
    { width, height: 24 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

/** Index of the frame line carrying row N's identity (its number + status). */
function identityLine(frame: string, n: number): number {
  return frame
    .split("\n")
    .findIndex((l) => new RegExp(`^\\s*${n} [●◐◑◒◓]`).test(l));
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

  it("yields to the one-line prompt cell while a search is active", async () => {
    // The cell is the only place a row draws its match highlights and its
    // `[pane]`/`[transcript]`/`[cwd]` source tag, so the block stands down
    // rather than hide why the row is in the result set at all.
    const frame = await render([item("a", LONG)], 3, 60, {
      searchActive: true,
    });
    expect(frame).not.toContain("pending pool");
    expect(promptLinesIn(frame, "refactor")).toHaveLength(1);
    expect(identityLine(frame, 1)).toBe(0);
  });

  it("draws no block when promptDisplay is off", async () => {
    const frame = await render([item("a", LONG), item("b", "SECOND")], 3, 60, {
      promptDisplay: "off",
    });
    expect(frame).not.toContain("pending pool");
    expect(frame).not.toContain("refactor");
    // Both rows collapse to their identity line, one directly under the other.
    expect(identityLine(frame, 2) - identityLine(frame, 1)).toBe(1);
  });

  it("draws no block on a rail too narrow to wrap readably", async () => {
    // promptBlockWidth(12) lands under the floor, where a wrap is word
    // fragments rather than prose. The row keeps its one-line cell instead
    // and stays a single line tall.
    expect(promptBlockWidth(12)).toBeLessThan(PROMPT_BLOCK_MIN_WIDTH);
    const frame = await render([item("a", LONG), item("b", "SECOND")], 3, 12);
    expect(frame).not.toContain("pending");
    expect(identityLine(frame, 2) - identityLine(frame, 1)).toBe(1);
  });

  it("caps a runaway prompt at the configured height", async () => {
    const huge = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const frame = await render([item("a", huge), item("b", "SECOND")], 3);
    const second = frame.split("\n").findIndex((l) => /^\s*2 [●◐◑◒◓]/.test(l));
    // identity + 3 capped lines, no matter how long the prompt is.
    expect(second).toBe(4);
    expect(frame).toContain("…");
  });
});
