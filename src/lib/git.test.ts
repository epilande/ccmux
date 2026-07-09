import { describe, it, expect } from "bun:test";
import { mkdtemp, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// Imported dynamically via a non-literal specifier with a "?real" suffix, so
// this file always sees the real implementation even though `review.test.ts`
// does a process-wide `mock.module("../lib/git", ...)` (same absolute path)
// that would otherwise clobber `resolveRepoRoot` here depending on file load
// order.
const REAL_GIT_SPECIFIER = "./git" + "?real";
const { resolveRepoRoot } = (await import(
  REAL_GIT_SPECIFIER
)) as typeof import("./git");

describe("resolveRepoRoot", () => {
  it("resolves the realpath'd toplevel from a subdirectory of this repo", async () => {
    const repoRoot = await realpath(join(import.meta.dir, "..", ".."));
    const root = await resolveRepoRoot(import.meta.dir);
    expect(root).toBe(repoRoot);
  });

  it("returns null for a directory that is not a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccmux-git-test-"));
    try {
      expect(await resolveRepoRoot(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a nonexistent path", async () => {
    expect(
      await resolveRepoRoot(join(tmpdir(), "ccmux-git-test-nonexistent")),
    ).toBeNull();
  });
});
