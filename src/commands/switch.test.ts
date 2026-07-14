import { describe, it, expect, spyOn, mock } from "bun:test";

// Neutralize ensureDaemon so the action never spawns/probes a real daemon.
// mock.module is process-wide but no other test imports "./shared", so it's
// contained. Spread the real module to keep its other exports.
const realShared = await import("./shared");
mock.module("./shared", () => ({
  ...realShared,
  ensureDaemon: async () => {},
}));

// Import after the mock so switch.ts binds the no-op ensureDaemon.
const { createSwitchCommand } = await import("./switch");

/**
 * Sentinel for process.exit: a no-op mock wouldn't halt execution, so the
 * refusal path would fall through to `switch-client`. Throwing halts like the
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

/** Control the consumer's own tmux socket (first field of `$TMUX`). */
function withTmux(socket: string): () => void {
  const original = process.env.TMUX;
  process.env.TMUX = socket;
  return () => {
    if (original === undefined) delete process.env.TMUX;
    else process.env.TMUX = original;
  };
}

type SessionShape = { tmuxPane: string | null; tmuxTarget: string | null };

/**
 * Stub global fetch so the action is deterministic: `/sessions/:id` resolves a
 * session, `/server-info` returns a controllable socket (or throws to exercise
 * the `.catch(() => null)` fail-open), and `/seen` is a harmless ok.
 */
function withFetch(opts: {
  session?: SessionShape;
  serverInfoSocket?: string | null;
  serverInfoFails?: boolean;
}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/server-info")) {
      if (opts.serverInfoFails) throw new Error("network down");
      return {
        ok: true,
        json: async () => ({ socketPath: opts.serverInfoSocket ?? null }),
      } as Response;
    }
    if (u.includes("/seen")) {
      return { ok: true, json: async () => ({}) } as Response;
    }
    // GET /sessions/:id
    return {
      status: 200,
      ok: true,
      json: async () => ({
        session: opts.session ?? { tmuxPane: "%5", tmuxTarget: null },
      }),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Record every tmux spawn without launching one, so the target is
 * assertable. `listClientsOutput` canned-answers `tmux list-clients` (the
 * out-of-tmux `switch-client -c` fallback's client resolution); every other
 * command gets empty stdout and a zero exit.
 */
function withSpawnSpy(
  opts: {
    listClientsOutput?: string;
  } = {},
): { calls: string[][]; restore: () => void } {
  const original = Bun.spawn;
  const calls: string[][] = [];
  Bun.spawn = ((args: string[]) => {
    calls.push(args);
    const stdout =
      args[1] === "list-clients" ? (opts.listClientsOutput ?? "") : "";
    return {
      exited: Promise.resolve(0),
      stdout: new Blob([stdout]).stream(),
      stderr: new Blob([""]).stream(),
    };
  }) as unknown as typeof Bun.spawn;
  return { calls, restore: () => (Bun.spawn = original) };
}

/** Ensure `$TMUX` is unset for the duration of the test. */
function withoutTmux(): () => void {
  const original = process.env.TMUX;
  delete process.env.TMUX;
  return () => {
    if (original !== undefined) process.env.TMUX = original;
  };
}

/** Run the switch action; return the ExitError it threw, or null if it didn't. */
async function runSwitch(sessionId = "s1"): Promise<ExitError | null> {
  try {
    await createSwitchCommand().parseAsync([sessionId], { from: "user" });
    return null;
  } catch (err) {
    if (err instanceof ExitError) return err;
    throw err;
  }
}

describe("ccmux switch cross-server refusal", () => {
  it("refuses to switch to a pane on a different tmux server", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const restoreTmux = withTmux("/tmp/consumer-sock,1,0");
    const restoreFetch = withFetch({ serverInfoSocket: "/tmp/daemon-sock" });
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy();
    try {
      const exit = await runSwitch();

      // The refusal path calls process.exit(1); the sentinel surfaces the code.
      expect(exit?.code).toBe(1);
      // The cross-server console.error fired before the throw.
      expect(
        errorSpy.mock.calls.some((c) =>
          String(c[0]).includes("different tmux server"),
        ),
      ).toBe(true);
      // The ExitError halted the action before it reached switch-client.
      expect(spawn.calls.some((c) => c[1] === "switch-client")).toBe(false);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreTmux();
      errorSpy.mockRestore();
    }
  });

  it("switches when the pane is on the same tmux server", async () => {
    const restoreTmux = withTmux("/tmp/same-sock,1,0");
    const restoreFetch = withFetch({ serverInfoSocket: "/tmp/same-sock" });
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy();
    try {
      const exit = await runSwitch();

      // Sockets match -> no refusal, no exit(1).
      expect(exit).toBeNull();
      // Reached switch-client with the stable `%N` pane id.
      expect(spawn.calls).toContainEqual(["tmux", "switch-client", "-t", "%5"]);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreTmux();
    }
  });

  it("fails open and switches when /server-info is unreachable", async () => {
    const restoreTmux = withTmux("/tmp/consumer-sock,1,0");
    // serverInfoFails -> `.catch(() => null)` -> daemonSocket null -> same-server.
    const restoreFetch = withFetch({ serverInfoFails: true });
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy();
    try {
      const exit = await runSwitch();

      expect(exit).toBeNull();
      expect(spawn.calls).toContainEqual(["tmux", "switch-client", "-t", "%5"]);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreTmux();
    }
  });
});

describe("ccmux switch outside tmux", () => {
  it("targets the highest-activity attached client via -c when $TMUX is unset", async () => {
    const restoreTmux = withoutTmux();
    const restoreFetch = withFetch({});
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy({
      listClientsOutput:
        "100 /dev/ttys001\n200 /dev/ttys002\n50 /dev/ttys003\n",
    });
    try {
      const exit = await runSwitch();

      expect(exit).toBeNull();
      expect(spawn.calls).toContainEqual([
        "tmux",
        "switch-client",
        "-c",
        "/dev/ttys002",
        "-t",
        "%5",
      ]);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreTmux();
    }
  });

  it("exits 1 with a clear message when no tmux client is attached", async () => {
    const restoreTmux = withoutTmux();
    const restoreFetch = withFetch({});
    const restoreExit = withExitSentinel();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const spawn = withSpawnSpy({ listClientsOutput: "" });
    try {
      const exit = await runSwitch();

      expect(exit?.code).toBe(1);
      expect(
        errorSpy.mock.calls.some((c) =>
          String(c[0]).includes("No attached tmux client found"),
        ),
      ).toBe(true);
      expect(spawn.calls.some((c) => c[1] === "switch-client")).toBe(false);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreTmux();
      errorSpy.mockRestore();
    }
  });

  it("leaves argv unchanged (no -c) when inside tmux", async () => {
    const restoreTmux = withTmux("/tmp/same-sock,1,0");
    const restoreFetch = withFetch({ serverInfoSocket: "/tmp/same-sock" });
    const restoreExit = withExitSentinel();
    const spawn = withSpawnSpy();
    try {
      const exit = await runSwitch();

      expect(exit).toBeNull();
      expect(spawn.calls).toContainEqual(["tmux", "switch-client", "-t", "%5"]);
      expect(spawn.calls.some((c) => c.includes("list-clients"))).toBe(false);
    } finally {
      spawn.restore();
      restoreExit();
      restoreFetch();
      restoreTmux();
    }
  });
});
