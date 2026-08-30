/**
 * Lint for the `@opentui/core/testing` key harness (issue #160).
 *
 * `pressKey()` takes key INPUT, and its only names are the `KeyCodes`
 * constants (`RETURN`, `ESCAPE`, ...). Any other multi-character string is
 * typed out letter by letter, so `pressKey("escape")` presses `e s c a p e`,
 * `pressKey("space")` presses `a` among others, and the test keeps passing
 * for whatever those letters happen to do. And a raw `pressEscape()` emits a
 * byte the parser holds for 20ms, so an assertion made right after it tests
 * a screen escape never reached. Both are silent; this is what makes them
 * loud. Use `deliverEscape` from `test-helpers` for escape and a real
 * character (or `KeyCodes` name) for everything else.
 *
 * Known gap: for `pressKeys([...])` only the first element is checked.
 */
import { describe, it, expect } from "bun:test";
import { KeyCodes } from "@opentui/core/testing";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SELF = import.meta.path;
/** The files allowed to use the raw paths: the helper itself and the test
 *  that pins why each raw path is a trap. */
const ALLOWLIST = new Set(["test-helpers.tsx", "test-helpers.test.tsx"]);

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") testFiles(path, acc);
    } else if (/\.test\.tsx?$/.test(name) && path !== SELF) {
      acc.push(path);
    }
  }
  return acc;
}

const KEY_LITERAL = /\bpressKeys?\((?:\[)?\s*(["'])((?:(?!\1).){2,})\1/g;
const RAW_ESCAPE = /\.pressEscape\(/g;

function offenders(source: string, path: string): string[] {
  const found: string[] = [];
  if (ALLOWLIST.has(basename(path))) return found;
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  for (const match of source.matchAll(KEY_LITERAL)) {
    const literal = match[2];
    // A KeyCodes NAME is fine; an escaped byte sequence (`\r`, `\x1b[A`)
    // is real input, not a name that fell through.
    if (literal in KeyCodes || literal.startsWith("\\")) continue;
    found.push(
      `${relative(ROOT, path)}:${lineOf(match.index)} pressKey("${literal}") types ${literal.length} characters`,
    );
  }
  for (const match of source.matchAll(RAW_ESCAPE)) {
    found.push(
      `${relative(ROOT, path)}:${lineOf(match.index)} raw pressEscape(); use deliverEscape from test-helpers`,
    );
  }
  return found;
}

describe("key harness guard", () => {
  it("flags the misuses it exists for", () => {
    const sample = [
      'keys.pressKey("escape");',
      'setup.mockInput.pressKey("space");',
      "keys.pressKeys(['return', 'j']);",
      "setup.mockInput.pressEscape();",
      // Not offenders: a character, a KeyCodes name, an escaped byte.
      'keys.pressKey("j");',
      'keys.pressKey("ESCAPE");',
      'keys.pressKey("\\x1b[A");',
    ].join("\n");
    const hits = offenders(sample, join(ROOT, "sample.test.tsx"));
    expect(hits).toHaveLength(4);
    expect(hits[0]).toContain('pressKey("escape")');
    expect(hits[1]).toContain('pressKey("space")');
    expect(hits[2]).toContain('pressKey("return")');
    expect(hits[3]).toContain("raw pressEscape()");
  });

  it("finds no key-name-as-input or raw escape in the test suite", () => {
    const files = testFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap((path) =>
      offenders(readFileSync(path, "utf8"), path),
    );
    expect(hits).toEqual([]);
  });
});
