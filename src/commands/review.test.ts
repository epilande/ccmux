import { describe, it, expect, spyOn, mock } from "bun:test";

// Neutralize ensureDaemon so the action never spawns/probes a real daemon.
const realShared = await import("./shared");
mock.module("./shared", () => ({
  ...realShared,
  ensureDaemon: async () => {},
}));

// git.ts is process-wide-mocked so tests control repo-root resolution without
// touching the real filesystem.
let repoRoot: string | null = "/repo";
const resolveRepoRootCalls: string[] = [];
mock.module("../lib/git", () => ({
  resolveRepoRoot: async (cwd: string) => {
    resolveRepoRootCalls.push(cwd);
    return repoRoot;
  },
}));

const { createReviewCommand } = await import("./review");

/**
 * Sentinel for process.exit: a no-op mock wouldn't halt execution, so a
 * refusal path would fall through to the hunk spawn. Throwing halts like the
 * real exit; the test catches it to assert the code.
 */
class ExitError extends Error {
  constructor(public code?: number) {
    super(`process.exit(${code})`);
  }
}

function withExitSentinel(): () => void {
  const original = process.exit;
  process.exit = ((code?: number) => {
    throw new ExitError(code);
  }) as never;
  return () => {
    process.exit = original;
  };
}

function withWhich(hunkPath: string | null): () => void {
  const original = Bun.which;
  Bun.which = ((cmd: string) =>
    cmd === "hunk" ? hunkPath : original(cmd)) as typeof Bun.which;
  return () => {
    Bun.which = original;
  };
}

type SessionShape = { paneCwd: string | null; cwd: string };

function withFetch(opts: {
  session?: SessionShape;
  notFound?: boolean;
}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    if (opts.notFound) {
      return { status: 404, ok: false, json: async () => ({}) } as Response;
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({
        session: opts.session ?? { paneCwd: null, cwd: "/code/myapp" },
      }),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Record every spawn without launching a real process. */
function withSpawnSpy(exitCode = 0): {
  calls: Array<{ cmd: string[]; opts: unknown }>;
  restore: () => void;
} {
  const original = Bun.spawn;
  const calls: Array<{ cmd: string[]; opts: unknown }> = [];
  Bun.spawn = ((cmd: string[], opts: unknown) => {
    calls.push({ cmd, opts });
    return { exited: Promise.resolve(exitCode) };
  }) as unknown as typeof Bun.spawn;
  return { calls, restore: () => (Bun.spawn = original) };
}

async function runReview(sessionId?: string): Promise<ExitError | null> {
  try {
    await createReviewCommand().parseAsync(sessionId ? [sessionId] : [], {
      from: "user",
    });
    return null;
  } catch (err) {
    if (err instanceof ExitError) return err;
    throw err;
  }
}

describe("ccmux review", () => {
  it("exits 1 with the install hint when hunk is missing", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreWhich = withWhich(null);
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy();
    try {
      const exit = await runReview();
      expect(exit?.code).toBe(1);
      expect(spawn.calls.length).toBe(0);
      expect(
        errorSpy.mock.calls.some((c) => String(c[0]).includes("hunk")),
      ).toBe(true);
    } finally {
      spawn.restore();
      restoreExit();
      restoreWhich();
      errorSpy.mockRestore();
    }
  });

  it("exits 1 when the session-id lookup 404s", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreWhich = withWhich("/opt/homebrew/bin/hunk");
    const restoreFetch = withFetch({ notFound: true });
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy();
    try {
      const exit = await runReview("missing-id");
      expect(exit?.code).toBe(1);
      expect(spawn.calls.length).toBe(0);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreWhich();
      errorSpy.mockRestore();
    }
  });

  it("spawns hunk in the resolved repo root of the session's paneCwd", async () => {
    repoRoot = "/repo/root";
    const restoreWhich = withWhich("/opt/homebrew/bin/hunk");
    const restoreFetch = withFetch({
      session: { paneCwd: "/code/myapp/sub", cwd: "/code/myapp" },
    });
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy(0);
    try {
      const exit = await runReview("s1");
      expect(exit?.code).toBe(0);
      expect(spawn.calls).toEqual([
        {
          cmd: ["/opt/homebrew/bin/hunk", "diff", "--watch"],
          opts: {
            cwd: "/repo/root",
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          },
        },
      ]);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreWhich();
    }
  });

  it("uses process.cwd() and never fetches without a session-id", async () => {
    repoRoot = "/repo/root";
    resolveRepoRootCalls.length = 0;
    const restoreWhich = withWhich("/opt/homebrew/bin/hunk");
    const fetchSpy = mock(async () => {
      throw new Error("should not fetch");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy(0);
    try {
      const exit = await runReview();
      expect(exit?.code).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(resolveRepoRootCalls).toEqual([process.cwd()]);
      expect(spawn.calls[0]?.opts).toMatchObject({ cwd: "/repo/root" });
    } finally {
      spawn.restore();
      restoreExit();
      globalThis.fetch = originalFetch;
      restoreWhich();
    }
  });

  it("prefers CCMUX_CALLER_PWD over process.cwd() without a session-id", async () => {
    // bin/ccmux cds into the package root before exec'ing the process, so
    // process.cwd() alone would resolve the repo root of ccmux itself
    // instead of wherever the user actually ran `ccmux review` from.
    repoRoot = "/repo/root";
    resolveRepoRootCalls.length = 0;
    const restoreWhich = withWhich("/opt/homebrew/bin/hunk");
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy(0);
    const originalCallerPwd = process.env.CCMUX_CALLER_PWD;
    process.env.CCMUX_CALLER_PWD = "/caller/dir";
    try {
      const exit = await runReview();
      expect(exit?.code).toBe(0);
      expect(resolveRepoRootCalls).toEqual(["/caller/dir"]);
    } finally {
      if (originalCallerPwd === undefined) {
        delete process.env.CCMUX_CALLER_PWD;
      } else {
        process.env.CCMUX_CALLER_PWD = originalCallerPwd;
      }
      spawn.restore();
      restoreExit();
      restoreWhich();
    }
  });

  it("exits 1 when the resolved cwd is not a git repository", async () => {
    repoRoot = null;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreWhich = withWhich("/opt/homebrew/bin/hunk");
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy();
    try {
      const exit = await runReview();
      expect(exit?.code).toBe(1);
      expect(spawn.calls.length).toBe(0);
    } finally {
      repoRoot = "/repo";
      spawn.restore();
      restoreExit();
      restoreWhich();
      errorSpy.mockRestore();
    }
  });

  it("propagates hunk's exit code", async () => {
    repoRoot = "/repo/root";
    const restoreWhich = withWhich("/opt/homebrew/bin/hunk");
    const restoreFetch = withFetch({});
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy(2);
    try {
      const exit = await runReview("s1");
      expect(exit?.code).toBe(2);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreWhich();
    }
  });
});
