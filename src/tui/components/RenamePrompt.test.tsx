import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { RenamePrompt } from "./RenamePrompt";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

async function render(
  label: string,
  value: string,
  width = 100,
  mergesInto: string | null = null,
) {
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
        mergesInto={mergesInto}
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

  it("keeps a prefilled name longer than a name may be whole", async () => {
    const long = "x".repeat(70);
    const { typed } = await render(long, long, 120);
    setup!.mockInput.pressKey("y");
    await setup!.renderOnce();
    // The input does not clip the prefill; the name rules apply at commit.
    expect(typed.at(-1)).toBe(`${long}y`);
  });

  it("still teaches merging at a 40-column sidebar's width", async () => {
    await render("beta", "beta", 40);
    const frame = setup!.captureCharFrame();
    expect(frame).toContain("enter · esc · same name merges");
  });

  it("shows no counter for a short name", async () => {
    await render("beta", "Backend");
    expect(setup!.captureCharFrame()).not.toContain("/64");
  });

  it("counts columns near the 64-column cap", async () => {
    await render("beta", "x".repeat(50));
    expect(setup!.captureCharFrame()).toContain("50/64");
  });

  it("warns that a name past the cap is cut on Enter", async () => {
    await render("beta", "x".repeat(70));
    expect(setup!.captureCharFrame()).toContain("70/64 · cut");
  });

  it("says when the name merges, instead of counting", async () => {
    // A full path past the cap that names an existing group is not cut:
    // it merges, and the prompt says so.
    await render("beta", "x".repeat(70), 100, "~/Code/alpha");
    const frame = setup!.captureCharFrame();
    expect(frame).toContain("merges into ~/Code/alpha");
    expect(frame).not.toContain("70/64");
  });

  it("names the merge target whole in a 40-column sidebar", async () => {
    await render("px-web", "other", 40, "other");
    const frame = setup!.captureCharFrame();
    expect(frame).toContain("enter merges into other");
    // The title keeps the group being renamed readable too.
    expect(frame).toContain("Rename px-web to:");
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
