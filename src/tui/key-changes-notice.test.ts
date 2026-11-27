import { describe, it, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KEY_CHANGES_NOTICE } from "./key-changes-notice";

const BLOB = "https://github.com/epilande/ccmux/blob/main/";

describe("KEY_CHANGES_NOTICE", () => {
  it("links a doc that exists in this repo", () => {
    const link = KEY_CHANGES_NOTICE.lines.find((line) =>
      line.startsWith(BLOB),
    );
    expect(link).toBeDefined();
    const repoRoot = join(import.meta.dir, "..", "..");
    expect(existsSync(join(repoRoot, link!.slice(BLOB.length)))).toBe(true);
  });

  it("names every key whose meaning changed", () => {
    const text = KEY_CHANGES_NOTICE.lines.join(" ");
    for (const key of ["h and l", "Space", " r ", " n ", "Tab", " D "]) {
      expect(text).toContain(key);
    }
  });
});
