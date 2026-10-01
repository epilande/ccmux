import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSpy } from "@opentui/core/testing";
import { RGBA } from "@opentui/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { theme } from "../theme";
import { SearchInput } from "./SearchInput";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;
let onChange: ReturnType<typeof createSpy>;
let onSubmit: ReturnType<typeof createSpy>;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderSearch(value = "") {
  onChange = createSpy();
  onSubmit = createSpy();
  setup = await testRender(
    () => <SearchInput value={value} onChange={onChange} onSubmit={onSubmit} />,
    { width: 40, height: 4 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("SearchInput", () => {
  it("renders search prefix", async () => {
    const frame = await renderSearch();
    expect(frame).toContain("/");
  });

  it("renders placeholder text", async () => {
    const frame = await renderSearch();
    expect(frame).toContain("Search sessions...");
  });

  it("renders current value", async () => {
    const frame = await renderSearch("testquery");
    expect(frame).toContain("testquery");
  });

  it("calls onChange on text input", async () => {
    await renderSearch();
    await setup.mockInput.typeText("a");
    expect(onChange.callCount()).toBeGreaterThan(0);
  });

  it("calls onSubmit on Enter", async () => {
    await renderSearch("test");
    setup.mockInput.pressEnter();
    expect(onSubmit.callCount()).toBeGreaterThan(0);
  });
});

// @opentui/solid constructs every renderable with only `{ id }` and applies
// props through setters afterwards, so InputRenderable's constructor fallback
// (focusedTextColor <- textColor) never runs, and the `textColor` setter only
// sets the UNFOCUSED color. A focused <input> without `focusedTextColor`
// keeps OpenTUI's default "#FFFFFF", which is invisible on a light theme.
// Same bug class as #141/#142/#211.
describe("SearchInput text color", () => {
  it("renders typed text in theme.text while focused, not opaque white", async () => {
    await renderSearch("TYPED_QUERY");
    let fg: number[] | undefined;
    for (const line of setup.captureSpans().lines) {
      for (const span of line.spans) {
        if (span.text.includes("TYPED_QUERY")) fg = span.fg.toInts();
      }
    }
    expect(fg).toEqual(RGBA.fromHex(theme.text).toInts());
  });

  it("every <input> in the TUI sets focusedTextColor", () => {
    const root = join(import.meta.dir, "..");
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) {
          sources.push(path);
        }
      }
    };
    walk(root);

    const missing: string[] = [];
    let inputs = 0;
    for (const path of sources) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/<input\s[\s\S]*?\/>/g)) {
        inputs++;
        if (!match[0].includes("focusedTextColor=")) {
          const line = source.slice(0, match.index).split("\n").length;
          missing.push(`${relative(root, path)}:${line}`);
        }
      }
    }
    expect(inputs).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});
