/**
 * Lint for the `@opentui/core/testing` key harness (issue #160).
 *
 * `pressKey()` takes key INPUT, and its only names are the `KeyCodes`
 * constants (`RETURN`, `ARROW_UP`, ...). Any other multi-character string is
 * typed out letter by letter, so the test keeps passing for whatever those
 * letters happen to do. A raw `pressEscape()` — and `pressKey("ESCAPE")`,
 * which emits the same lone ESC byte — is delivered late for the reason
 * `deliverEscape` in `test-helpers` documents; use that instead.
 *
 * `"escape"` / `"space"` / `"return"` are never valid input. Every quoted
 * or template token on a `press` / `pressKey` / `pressKeys` call is checked
 * (wrappers, later array slots, templates), not only the first `pressKey(`
 * argument.
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

/** press / pressKey / pressKeys. These calls are single-line. */
const PRESS_CALL = /\bpress(?:Keys?)?\s*\(([^)]*)\)/g;
const QUOTED_TOKEN = /(["'`])((?:(?!\1).)+)\1/g;
const RAW_ESCAPE = /\.pressEscape\(/g;

function offenders(source: string, path: string): string[] {
  const found: string[] = [];
  if (ALLOWLIST.has(basename(path))) return found;
  const lineOf = (index: number) => source.slice(0, index).split("\n").length;
  for (const call of source.matchAll(PRESS_CALL)) {
    const args = call[1];
    const argsAt = (call.index ?? 0) + call[0].indexOf(args);
    for (const token of args.matchAll(QUOTED_TOKEN)) {
      const literal = token[2];
      const index = argsAt + (token.index ?? 0);
      if (literal === "ESCAPE") {
        found.push(
          `${relative(ROOT, path)}:${lineOf(index)} pressKey("ESCAPE") is a lone ESC; use deliverEscape from test-helpers`,
        );
        continue;
      }
      // A KeyCodes NAME is fine; an escaped byte sequence (`\r`, `\x1b[A`)
      // is real input, not a name that fell through. One character is itself.
      if (literal.length < 2 || literal in KeyCodes || literal.startsWith("\\")) {
        continue;
      }
      found.push(
        `${relative(ROOT, path)}:${lineOf(index)} pressKey("${literal}") types ${literal.length} characters`,
      );
    }
  }
  for (const match of source.matchAll(RAW_ESCAPE)) {
    found.push(
      `${relative(ROOT, path)}:${lineOf(match.index ?? 0)} raw pressEscape(); use deliverEscape from test-helpers`,
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
      'await press("escape");',
      "keys.pressKeys(['j', 'escape']);",
      "press(`escape`);",
      'keys.pressKey("ESCAPE");',
      "setup.mockInput.pressEscape();",
      // Not offenders: a character, a KeyCodes name (not ESCAPE), an escaped byte.
      'keys.pressKey("j");',
      'keys.pressKey("RETURN");',
      'keys.pressKey("\\x1b[A");',
    ].join("\n");
    const hits = offenders(sample, join(ROOT, "sample.test.tsx"));
    expect(hits).toHaveLength(8);
    expect(hits[0]).toContain('pressKey("escape")');
    expect(hits[1]).toContain('pressKey("space")');
    expect(hits[2]).toContain('pressKey("return")');
    expect(hits[3]).toContain('pressKey("escape")');
    expect(hits[4]).toContain('pressKey("escape")');
    expect(hits[5]).toContain('pressKey("escape")');
    expect(hits[6]).toContain('pressKey("ESCAPE")');
    expect(hits[7]).toContain("raw pressEscape()");
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
