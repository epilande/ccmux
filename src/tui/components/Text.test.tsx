import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { theme } from "../theme";
import { Text } from "./Text";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function fgOf(node: () => ReturnType<typeof Text>, marker: string) {
  setup = await testRender(node, { width: 20, height: 1 });
  await setup.renderOnce();
  for (const line of setup.captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(marker)) return span.fg.toInts();
    }
  }
  return undefined;
}

describe("Text", () => {
  it("defaults fg to theme.text, not OpenTUI's opaque white", async () => {
    expect(await fgOf(() => <Text>NO_FG</Text>, "NO_FG")).toEqual(
      RGBA.fromHex(theme.text).toInts(),
    );
  });

  // The #143 shape: a color expression that resolves to `undefined`.
  it("defaults an explicit fg={undefined} too", async () => {
    expect(
      await fgOf(() => <Text fg={undefined}>UNDEF_FG</Text>, "UNDEF_FG"),
    ).toEqual(RGBA.fromHex(theme.text).toInts());
  });

  it("keeps an fg it is given", async () => {
    expect(
      await fgOf(() => <Text fg={theme.red}>RED_FG</Text>, "RED_FG"),
    ).toEqual(RGBA.fromHex(theme.red).toInts());
  });
});

// A raw `<text>` without an `fg` renders OpenTUI's default "#FFFFFF", which
// is invisible on a light theme. Every sweep for those sites missed one
// (#141, #143, #211, #212, #229), so no raw `<text>` is allowed outside the
// primitive. Parsed rather than regexed: prose in comments says `<text>` too.
describe("Text source guard", () => {
  it("no raw <text> in the TUI outside Text.tsx", () => {
    const root = join(import.meta.dir, "..");
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          name.endsWith(".tsx") &&
          !name.endsWith(".test.tsx") &&
          path !== join(import.meta.dir, "Text.tsx")
        ) {
          sources.push(path);
        }
      }
    };
    walk(root);

    const raw: string[] = [];
    for (const path of sources) {
      const file = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(file) === "text"
        ) {
          const { line } = file.getLineAndCharacterOfPosition(
            node.getStart(file),
          );
          raw.push(
            `${relative(root, path)}:${line + 1} uses a raw <text>; use <Text> from components/Text.tsx`,
          );
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect(sources.length).toBeGreaterThan(0);
    expect(raw).toEqual([]);
  });
});
