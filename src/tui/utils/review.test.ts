import { describe, it, expect, mock } from "bun:test";
// Imported dynamically via a non-literal specifier with a "?real" suffix,
// which resolves to a distinct module cache entry: App.test.tsx does
// `mock.module("./utils/review", ...)` (same absolute path), and without
// this, whichever of the two files bun loads second would silently bind to
// that mock instead of this real implementation. Non-literal so tsc doesn't
// attempt (and fail) to resolve the suffixed specifier on disk.
const REAL_REVIEW_SPECIFIER = "./review" + "?real";
const { HUNK_DIFF_ARGS, HUNK_INSTALL_HINT, isHunkAvailable, runHunkReview } =
  (await import(REAL_REVIEW_SPECIFIER)) as typeof import("./review");

function fakeRenderer() {
  const calls: string[] = [];
  return {
    calls,
    renderer: {
      suspend: mock(() => {
        calls.push("suspend");
      }),
      resume: mock(() => {
        calls.push("resume");
      }),
    },
  };
}

function fakeSpawn(exitCode: number) {
  const calls: unknown[] = [];
  const spawn = mock((cmd: string[], opts: unknown) => {
    calls.push([cmd, opts]);
    return { exited: Promise.resolve(exitCode) };
  });
  return { spawn, calls };
}

describe("isHunkAvailable", () => {
  it("is true when which resolves the binary", () => {
    expect(isHunkAvailable(() => "/opt/homebrew/bin/hunk")).toBe(true);
  });

  it("is false when which returns null", () => {
    expect(isHunkAvailable(() => null)).toBe(false);
  });
});

describe("runHunkReview", () => {
  it("returns the install hint and never suspends when hunk is missing", async () => {
    const { renderer } = fakeRenderer();
    const result = await runHunkReview(renderer, "/repo", {
      which: () => null,
    });
    expect(result).toEqual({ ok: false, error: HUNK_INSTALL_HINT });
    expect(renderer.suspend).not.toHaveBeenCalled();
  });

  it("returns a repo error and never suspends when cwd is not a git repo", async () => {
    const { renderer } = fakeRenderer();
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "/opt/homebrew/bin/hunk",
      resolveRoot: async () => null,
    });
    expect(result).toEqual({ ok: false, error: "not a git repository" });
    expect(renderer.suspend).not.toHaveBeenCalled();
  });

  it("suspends, spawns hunk in the repo root with inherited stdio, then resumes on exit 0", async () => {
    const { renderer, calls } = fakeRenderer();
    const { spawn, calls: spawnCalls } = fakeSpawn(0);
    const result = await runHunkReview(renderer, "/repo/sub", {
      which: () => "/opt/homebrew/bin/hunk",
      resolveRoot: async () => "/repo",
      spawn,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual(["suspend", "resume"]);
    expect(spawnCalls).toEqual([
      [
        ["hunk", ...HUNK_DIFF_ARGS],
        {
          cwd: "/repo",
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        },
      ],
    ]);
  });

  it("returns an error mentioning the exit code and still resumes on non-zero exit", async () => {
    const { renderer, calls } = fakeRenderer();
    const { spawn } = fakeSpawn(3);
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "/opt/homebrew/bin/hunk",
      resolveRoot: async () => "/repo",
      spawn,
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("3");
    expect(calls).toEqual(["suspend", "resume"]);
  });

  it("resumes even when spawn throws", async () => {
    const { renderer, calls } = fakeRenderer();
    const spawn = mock(() => {
      throw new Error("spawn exploded");
    });
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "/opt/homebrew/bin/hunk",
      resolveRoot: async () => "/repo",
      spawn: spawn as never,
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual(["suspend", "resume"]);
  });

  it("does not call resume when suspend itself throws", async () => {
    const { spawn } = fakeSpawn(0);
    const suspend = mock(() => {
      throw new Error("suspend exploded");
    });
    const resume = mock(() => {});
    const result = await runHunkReview({ suspend, resume }, "/repo", {
      which: () => "/opt/homebrew/bin/hunk",
      resolveRoot: async () => "/repo",
      spawn,
    });
    expect(result.ok).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
