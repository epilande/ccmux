import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { RenamePrompt } from "./RenamePrompt";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function render(label: string, value: string, width = 100) {
  const typed: string[] = [];
  const submitted: number[] = [];
  const [current, setCurrent] = createSignal(value);
  setup = await testRender(
    () => (
      <RenamePrompt
        label={label}
        value={current()}
        onInput={(next) => {
          typed.push(next);
          setCurrent(next);
        }}
        onSubmit={() => submitted.push(1)}
      />
    ),
    { width, height: 16 },
  );
  await setup.renderOnce();
  return { typed, submitted };
}

describe("RenamePrompt", () => {
  it("names the group and shows the prefilled name", async () => {
    await render("px-api", "px-api");
    const frame = setup!.captureCharFrame();
    expect(frame).toContain("Rename px-api to:");
    expect(frame).toMatch(/›\s*px-api/);
  });

  it("says that Enter saves, Esc cancels and an existing name merges", async () => {
    await render("px-api", "px-api");
    const frame = setup!.captureCharFrame();
    expect(frame).toContain("enter rename");
    expect(frame).toContain("esc cancel");
    expect(frame).toContain("existing name merges");
  });

  it("passes typing to onInput", async () => {
    const { typed } = await render("px-api", "");
    for (const ch of "Pro") setup!.mockInput.pressKey(ch);
    await setup!.renderOnce();
    expect(typed.at(-1)).toBe("Pro");
  });

  it("fits a long label and the hints into a sidebar-width box", async () => {
    await render("a-very-long-project-name-that-cannot-fit", "x", 30);
    const lines = setup!.captureCharFrame().split("\n");
    // Nothing wraps: every line of the box stays inside the terminal and
    // the title is cut rather than spilling onto a second row.
    expect(lines.some((l) => l.includes("Rename"))).toBe(true);
    expect(lines.filter((l) => l.includes("to:"))).toHaveLength(1);
    expect(lines.every((l) => l.trimEnd().length <= 30)).toBe(true);
  });
});
