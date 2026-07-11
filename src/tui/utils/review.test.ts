import { describe, it, expect, mock } from "bun:test";
// Imported dynamically via a non-literal specifier with a "?real" suffix,
// which resolves to a distinct module cache entry: App.test.tsx does
// `mock.module("./utils/review", ...)` (same absolute path), and without
// this, whichever of the two files bun loads second would silently bind to
// that mock instead of this real implementation. Non-literal so tsc doesn't
// attempt (and fail) to resolve the suffixed specifier on disk.
const REAL_REVIEW_SPECIFIER = "./review" + "?real";
const {
  HUNK_DIFF_ARGS,
  HUNK_INSTALL_HINT,
  MAX_REVIEW_PROMPT_CHARS,
  formatReviewPrompt,
  isHunkAvailable,
  runHunkReview,
} = (await import(REAL_REVIEW_SPECIFIER)) as typeof import("./review");

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

const dirtyGitStatus = async () => " M file\n";

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
      gitStatus: dirtyGitStatus,
      paneId: "",
    });
    expect(result).toEqual({ ok: false, error: HUNK_INSTALL_HINT });
    expect(renderer.suspend).not.toHaveBeenCalled();
  });

  it("returns a repo error and never suspends when cwd is not a git repo", async () => {
    const { renderer } = fakeRenderer();
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "/opt/homebrew/bin/hunk",
      resolveRoot: async () => null,
      gitStatus: dirtyGitStatus,
      paneId: "",
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
      gitStatus: dirtyGitStatus,
      paneId: "",
      spawn,
    });
    expect(result).toEqual({ ok: true, notes: [] });
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
      gitStatus: dirtyGitStatus,
      paneId: "",
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
      gitStatus: dirtyGitStatus,
      paneId: "",
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
      gitStatus: dirtyGitStatus,
      paneId: "",
      spawn,
    });
    expect(result.ok).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns before suspending when there are no changes to review", async () => {
    const { renderer } = fakeRenderer();
    const { spawn } = fakeSpawn(0);
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "/opt/homebrew/bin/hunk",
      resolveRoot: async () => "/repo",
      gitStatus: async () => "",
      paneId: "",
      spawn,
    });
    expect(result).toEqual({ ok: false, error: "no changes to review" });
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("discovers by pane id, harvests the final snapshot, and extracts snippets", async () => {
    const { renderer } = fakeRenderer();
    let resolveExit!: (code: number) => void;
    const spawn = mock(() => ({
      exited: new Promise<number>((resolve) => (resolveExit = resolve)),
    }));
    let commentReads = 0;
    const runHunkJson = mock(async (args: string[]) => {
      if (args[1] === "list") {
        return {
          sessions: [
            {
              sessionId: "wrong",
              terminal: { locations: [{ source: "tmux", paneId: "%8" }] },
            },
            {
              sessionId: "hunk-1",
              terminal: { locations: [{ source: "tmux", paneId: "%7" }] },
            },
          ],
        };
      }
      commentReads++;
      return commentReads === 1
        ? { comments: [] }
        : {
            comments: [
              {
                noteId: "n1",
                filePath: "src/foo.ts",
                hunkIndex: 0,
                newRange: [2, 10],
                body: "Handle this case.",
              },
              {
                noteId: "n2",
                filePath: "src/old.ts",
                hunkIndex: 1,
                oldRange: [4, 4],
                body: "Deleted behavior matters.",
              },
            ],
          };
    });
    const sleep = mock(async (ms: number) => {
      if (ms === 1_000) resolveExit(0);
    });
    const readFileLines = mock(async () => [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ]);

    const result = await runHunkReview(renderer, "/repo", {
      which: () => "/opt/homebrew/bin/hunk",
      resolveRoot: async () => "/repo",
      gitStatus: dirtyGitStatus,
      paneId: "%7",
      spawn,
      runHunkJson,
      sleep,
      readFileLines,
    });

    expect(result).toEqual({
      ok: true,
      notes: [
        {
          noteId: "n1",
          filePath: "src/foo.ts",
          hunkIndex: 0,
          newRange: [2, 10],
          body: "Handle this case.",
          snippet: "two\nthree\nfour\nfive\nsix\nseven",
        },
        {
          noteId: "n2",
          filePath: "src/old.ts",
          hunkIndex: 1,
          oldRange: [4, 4],
          body: "Deleted behavior matters.",
        },
      ],
    });
    expect(readFileLines).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last snapshot when every final read fails", async () => {
    const { renderer } = fakeRenderer();
    let resolveExit!: (code: number) => void;
    const spawn = mock(() => ({
      exited: new Promise<number>((resolve) => (resolveExit = resolve)),
    }));
    let commentReads = 0;
    const note = {
      noteId: "n1",
      filePath: "src/foo.ts",
      hunkIndex: 0,
      body: "Keep me.",
    };
    const runHunkJson = mock(async (args: string[]) => {
      if (args[1] === "list") {
        return {
          sessions: [
            {
              sessionId: "h1",
              terminal: { locations: [{ source: "tmux", paneId: "%1" }] },
            },
          ],
        };
      }
      commentReads++;
      return commentReads === 1 ? { comments: [note] } : null;
    });
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "hunk",
      resolveRoot: async () => "/repo",
      gitStatus: dirtyGitStatus,
      paneId: "%1",
      spawn,
      runHunkJson,
      sleep: async (ms) => {
        if (ms === 1_000) resolveExit(0);
      },
    });
    expect(result).toEqual({ ok: true, notes: [note] });
    expect(commentReads).toBe(4);
  });

  it("degrades to no notes when discovery never matches", async () => {
    const { renderer } = fakeRenderer();
    let resolveExit!: (code: number) => void;
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "hunk",
      resolveRoot: async () => "/repo",
      gitStatus: dirtyGitStatus,
      paneId: "%1",
      spawn: () => ({
        exited: new Promise<number>((resolve) => (resolveExit = resolve)),
      }),
      runHunkJson: async () => ({ sessions: [] }),
      sleep: async () => resolveExit(0),
    });
    expect(result).toEqual({ ok: true, notes: [] });
  });

  it("drops harvested notes when hunk exits non-zero", async () => {
    const { renderer } = fakeRenderer();
    let resolveExit!: (code: number) => void;
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "hunk",
      resolveRoot: async () => "/repo",
      gitStatus: dirtyGitStatus,
      paneId: "%1",
      spawn: () => ({
        exited: new Promise<number>((resolve) => (resolveExit = resolve)),
      }),
      runHunkJson: async (args) =>
        args[1] === "list"
          ? {
              sessions: [
                {
                  sessionId: "h1",
                  terminal: {
                    locations: [{ source: "tmux", paneId: "%1" }],
                  },
                },
              ],
            }
          : {
              comments: [
                { noteId: "n1", filePath: "x", hunkIndex: 0, body: "note" },
              ],
            },
      sleep: async () => resolveExit(2),
    });
    expect(result).toEqual({ ok: false, error: "hunk exited with code 2" });
  });

  it("parses comments missing noteId/hunkIndex (schema drift)", async () => {
    const { renderer } = fakeRenderer();
    let resolveExit!: (code: number) => void;
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "hunk",
      resolveRoot: async () => "/repo",
      gitStatus: dirtyGitStatus,
      paneId: "%1",
      spawn: () => ({
        exited: new Promise<number>((resolve) => (resolveExit = resolve)),
      }),
      runHunkJson: async (args) =>
        args[1] === "list"
          ? {
              sessions: [
                {
                  sessionId: "h1",
                  terminal: {
                    locations: [{ source: "tmux", paneId: "%1" }],
                  },
                },
              ],
            }
          : { comments: [{ filePath: "src/x.ts", body: "drifted note" }] },
      sleep: async () => resolveExit(0),
    });
    expect(result).toEqual({
      ok: true,
      notes: [{ filePath: "src/x.ts", body: "drifted note" }],
    });
  });

  it("leaves snippet undefined when reading the working tree fails", async () => {
    const { renderer } = fakeRenderer();
    let resolveExit!: (code: number) => void;
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "hunk",
      resolveRoot: async () => "/repo",
      gitStatus: dirtyGitStatus,
      paneId: "%1",
      spawn: () => ({
        exited: new Promise<number>((resolve) => (resolveExit = resolve)),
      }),
      runHunkJson: async (args) =>
        args[1] === "list"
          ? {
              sessions: [
                {
                  sessionId: "h1",
                  terminal: {
                    locations: [{ source: "tmux", paneId: "%1" }],
                  },
                },
              ],
            }
          : {
              comments: [
                {
                  noteId: "n1",
                  filePath: "x",
                  hunkIndex: 0,
                  newRange: [1, 1],
                  body: "note",
                },
              ],
            },
      sleep: async () => resolveExit(0),
      readFileLines: async () => {
        throw new Error("missing");
      },
    });
    expect(result).toEqual({
      ok: true,
      notes: [
        {
          noteId: "n1",
          filePath: "x",
          hunkIndex: 0,
          newRange: [1, 1],
          body: "note",
        },
      ],
    });
  });

  it("skips snippets for paths that escape the repo root", async () => {
    const { renderer } = fakeRenderer();
    let resolveExit!: (code: number) => void;
    const readPaths: string[] = [];
    const result = await runHunkReview(renderer, "/repo", {
      which: () => "hunk",
      resolveRoot: async () => "/repo",
      gitStatus: dirtyGitStatus,
      paneId: "%1",
      spawn: () => ({
        exited: new Promise<number>((resolve) => (resolveExit = resolve)),
      }),
      runHunkJson: async (args) =>
        args[1] === "list"
          ? {
              sessions: [
                {
                  sessionId: "h1",
                  terminal: {
                    locations: [{ source: "tmux", paneId: "%1" }],
                  },
                },
              ],
            }
          : {
              comments: [
                {
                  noteId: "n1",
                  filePath: "../../etc/passwd",
                  hunkIndex: 0,
                  newRange: [1, 1],
                  body: "note",
                },
              ],
            },
      sleep: async () => resolveExit(0),
      readFileLines: async (path) => {
        readPaths.push(path);
        return ["secret"];
      },
    });
    expect(readPaths).toEqual([]);
    expect(result).toEqual({
      ok: true,
      notes: [
        {
          noteId: "n1",
          filePath: "../../etc/passwd",
          hunkIndex: 0,
          newRange: [1, 1],
          body: "note",
        },
      ],
    });
  });
});

describe("formatReviewPrompt", () => {
  it("formats new and old ranges, snippets, singular count, and omitted snippets", () => {
    expect(
      formatReviewPrompt([
        {
          noteId: "n1",
          filePath: "src/foo.ts",
          hunkIndex: 0,
          newRange: [12, 14],
          body: "Check the token.",
          snippet: "const token = getToken();\nif (!token) return;",
        },
        {
          noteId: "n2",
          filePath: "src/bar.ts",
          hunkIndex: 1,
          oldRange: [7, 7],
          body: "Preserve this behavior.",
        },
      ]),
    ).toBe(
      "I reviewed your changes in hunk and left 2 review comments:\n\n1. src/foo.ts:12-14\n   > const token = getToken();\n   > if (!token) return;\n   Check the token.\n2. src/bar.ts:old 7\n   Preserve this behavior.\n\nPlease address each comment.",
    );
  });

  it("strips control sequences that could break bracketed paste, keeping \\n and \\t", () => {
    const prompt = formatReviewPrompt([
      {
        filePath: "src/x.ts",
        newRange: [1, 1],
        body: "before\x1b[201~evil\rmore",
        snippet: "a\tb\nc\x1b[201~evil\rmore",
      },
    ]);
    expect(prompt).toContain("evil");
    expect(prompt).toContain("more");
    expect(prompt).not.toContain("\x1b");
    expect(prompt).not.toContain("\r");
    // Tabs and newlines inside snippets survive the sanitizer.
    expect(prompt).toContain("\t");
    expect(prompt).toContain("\n");
  });

  it("caps the prompt below the daemon limit with a truncation marker", () => {
    const prompt = formatReviewPrompt([
      {
        noteId: "n1",
        filePath: "x",
        hunkIndex: 0,
        newRange: [1, 1],
        body: "x".repeat(12_000),
      },
    ]);
    expect(prompt.length).toBe(MAX_REVIEW_PROMPT_CHARS);
    expect(prompt).toEndWith("(truncated)");
  });
});
