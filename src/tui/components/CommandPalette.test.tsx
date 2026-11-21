import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { filterPalette, paletteCommands } from "../actions";
import {
  CommandPalette,
  paletteActiveIndex,
  paletteWindowStart,
} from "./CommandPalette";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

const matches = (query = "") =>
  filterPalette(paletteCommands("sessions"), query);

describe("paletteActiveIndex", () => {
  it("lights the first row until something is highlighted", () => {
    expect(paletteActiveIndex(matches(), null)).toBe(0);
  });

  it("follows the highlighted command, not a row number", () => {
    const list = matches();
    const id = list[5]!.command.id;
    expect(paletteActiveIndex(list, id)).toBe(5);
    // Filtered out from under the highlight: back to the top.
    expect(paletteActiveIndex(matches("toggle prev"), id)).toBe(0);
  });
});

describe("paletteWindowStart", () => {
  it("does not window a list that fits", () => {
    expect(paletteWindowStart(5, 10, 4)).toBe(0);
  });

  it("keeps the active row in view, centred where it can be", () => {
    expect(paletteWindowStart(40, 10, 0)).toBe(0);
    expect(paletteWindowStart(40, 10, 20)).toBe(15);
    expect(paletteWindowStart(40, 10, 39)).toBe(30);
  });
});

describe("CommandPalette", () => {
  const render = async (query: string, width = 100) => {
    setup = await testRender(
      () => (
        <CommandPalette
          query={query}
          matches={matches(query)}
          highlight={null}
          onQuery={() => {}}
          onSubmit={() => {}}
          onRun={() => {}}
        />
      ),
      { width, height: 24 },
    );
    await setup.renderOnce();
    return setup.captureCharFrame();
  };

  it("lists each command with its section and key", async () => {
    const frame = await render("toggle prev");
    const row = frame.split("\n").find((line) => line.includes("Toggle"));
    expect(row).toContain("Preview");
    expect(row).toContain("P");
  });

  it("says when nothing matches", async () => {
    expect(await render("zzqxv")).toContain("No matching commands");
  });

  it("drops the section column before squeezing labels on a narrow terminal", async () => {
    const frame = await render("", 40);
    expect(frame).toContain("Previous view");
    expect(frame).not.toContain("Navigation");
    // Every row stays one line inside the box.
    for (const line of frame.split("\n"))
      expect(line.trimEnd().length).toBeLessThanOrEqual(40);
  });
});
