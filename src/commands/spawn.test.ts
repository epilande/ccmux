import { describe, it, expect, mock, spyOn, afterEach } from "bun:test";

// Neutralize ensureDaemon so the action never spawns/probes a real daemon.
// Counted as well as neutralized: argument validation that runs BEFORE it is
// the difference between rejecting a typo and leaving a daemon behind on the
// shared port.
let ensureDaemonCalls = 0;
const realShared = await import("./shared");
mock.module("./shared", () => ({
  ...realShared,
  ensureDaemon: async () => {
    ensureDaemonCalls++;
  },
}));

const { createSpawnCommand } = await import("./spawn");

interface SpawnBody {
  agent?: string;
  cwd?: string;
  fork?: string;
  prompt?: string;
  split: unknown;
  target?: string;
  callerPane?: string;
  callerTty?: string;
  detach: boolean;
  worktree?: {
    name?: string;
    base?: string;
    withChanges?: boolean;
    untracked?: string;
  };
}

/**
 * Capture the POST body the CLI would send. `/server-info` is answered
 * too, since the caller-pane guard consults it before every spawn.
 */
function withFetchCapture(socketPath: string | null = null) {
  const original = globalThis.fetch;
  const bodies: SpawnBody[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.endsWith("/server-info")) {
      return new Response(JSON.stringify({ socketPath }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as SpawnBody;
    bodies.push(body);
    return new Response(
      JSON.stringify({
        success: true,
        paneId: "%9",
        command: "claude",
        // Echoed when the request asked for a move, the way the daemon does.
        // A 200 with no `move` means a daemon too old to have honored
        // `--with-changes`, which the CLI treats as a failure, so a stub that
        // never sent one would make every `--with-changes` case exit.
        ...(body.worktree?.withChanges
          ? {
              move: {
                moved: 0,
                source: body.cwd,
                untracked: {
                  mode: body.worktree.untracked ?? "move",
                  files: [],
                },
              },
            }
          : {}),
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { bodies, restore: () => (globalThis.fetch = original) };
}

/** Set env vars for one run, restoring exactly what was there before. */
function withEnv(vars: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function runSpawn(argv: string[]): Promise<void> {
  await createSpawnCommand().parseAsync(["node", "spawn", ...argv]);
}

const originalLog = console.log;
const originalError = console.error;
afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

/**
 * Run the action with `process.exit` turned into a throw, so a validation
 * failure can be asserted on in-process instead of taking the test runner
 * down with it.
 */
async function runSpawnExpectingExit(argv: string[]): Promise<number> {
  const realExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit:${code ?? 0}`);
  }) as typeof process.exit;
  try {
    await runSpawn(argv);
  } catch (err) {
    const match = /^process\.exit:(\d+)$/.exec(
      err instanceof Error ? err.message : "",
    );
    if (!match) throw err;
    return Number(match[1]);
  } finally {
    process.exit = realExit;
  }
  throw new Error("expected the command to exit");
}

describe("ccmux spawn cwd resolution", () => {
  // bin/ccmux cds into the package root for module resolution, so
  // process.cwd() alone starts every agent inside the ccmux install
  // instead of where the user ran the command.

  it("starts the agent in the caller's directory, not the install dir", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      CCMUX_CALLER_PWD: "/caller/dir",
      TMUX_PANE: undefined,
    });
    try {
      await runSpawn([]);
      expect(bodies[0]?.cwd).toBe("/caller/dir");
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("resolves a relative --cwd against the caller's directory", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      CCMUX_CALLER_PWD: "/caller/dir",
      TMUX_PANE: undefined,
    });
    try {
      await runSpawn(["--cwd", "sub/proj"]);
      expect(bodies[0]?.cwd).toBe("/caller/dir/sub/proj");
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("passes an absolute --cwd through untouched", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      CCMUX_CALLER_PWD: "/caller/dir",
      TMUX_PANE: undefined,
    });
    try {
      await runSpawn(["--cwd", "/abs/path"]);
      expect(bodies[0]?.cwd).toBe("/abs/path");
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("falls back to process.cwd() outside the bin/ccmux launcher", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      CCMUX_CALLER_PWD: undefined,
      TMUX_PANE: undefined,
    });
    try {
      await runSpawn([]);
      expect(bodies[0]?.cwd).toBe(process.cwd());
    } finally {
      restoreEnv();
      restore();
    }
  });
});

describe("ccmux spawn caller pane", () => {
  it("sends the caller's pane as callerPane, not as an explicit target", async () => {
    // The daemon treats them differently: an explicit target inserts a
    // window next to it (renumbering later windows), while the caller's
    // pane only pins the session.
    console.log = () => {};
    const { bodies, restore } = withFetchCapture("/tmp/tmux-501/default");
    const restoreEnv = withEnv({
      TMUX_PANE: "%12",
      TMUX: "/tmp/tmux-501/default,123,0",
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn([]);
      expect(bodies[0]?.callerPane).toBe("%12");
      expect(bodies[0]?.target).toBeUndefined();
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("drops the caller's pane when the daemon watches another tmux server", async () => {
    // `%N` ids are unique only within one server and collide across them,
    // so a same-numbered pane on the daemon's server is a different pane.
    console.log = () => {};
    const { bodies, restore } = withFetchCapture("/tmp/tmux-501/other");
    const restoreEnv = withEnv({
      TMUX_PANE: "%12",
      TMUX: "/tmp/tmux-501/default,123,0",
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn([]);
      expect(bodies[0]?.callerPane).toBeUndefined();
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("opts out of placement entirely with --target none", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture("/tmp/tmux-501/default");
    const restoreEnv = withEnv({
      TMUX_PANE: "%12",
      TMUX: "/tmp/tmux-501/default,123,0",
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(["--target", "none"]);
      expect(bodies[0]?.target).toBeUndefined();
      expect(bodies[0]?.callerPane).toBeUndefined();
    } finally {
      restoreEnv();
      restore();
    }
  });
});

describe("ccmux spawn caller client tty", () => {
  // The daemon is attached to no tmux client, so a `--target` in another
  // session can only be switched to by naming the caller's client with
  // `switch-client -c <tty>` (issue #75). Only the CLI can find that tty.

  const IN_TMUX = {
    TMUX_PANE: "%12",
    TMUX: "/tmp/tmux-501/default,123,0",
    CCMUX_CALLER_PWD: "/caller/dir",
  };

  /**
   * Stub the `tmux display-message` the tty lookup shells out to. `spyOn`
   * rather than `mock.module`, which is process-wide and leaks into sibling
   * test files.
   */
  function withTmuxClientTty(tty: string) {
    const argv: string[][] = [];
    const spy = spyOn(Bun, "spawn").mockImplementation(((spawned: string[]) => {
      argv.push(spawned);
      return {
        exited: Promise.resolve(0),
        stdout: new Blob([`${tty}\n`]).stream(),
        stderr: new Blob([""]).stream(),
      };
    }) as unknown as typeof Bun.spawn);
    return { argv, restore: () => spy.mockRestore() };
  }

  it("sends the attached client's tty alongside an explicit --target", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture("/tmp/tmux-501/default");
    const tmux = withTmuxClientTty("/dev/ttys085");
    const restoreEnv = withEnv(IN_TMUX);
    try {
      await runSpawn(["--target", "%5"]);
      expect(bodies[0]?.callerTty).toBe("/dev/ttys085");
      // The CLIENT's tty, which is what `switch-client -c` takes — not the
      // pane's own pty, which tmux would not resolve to a client at all.
      expect(tmux.argv[0]).toEqual([
        "tmux",
        "display-message",
        "-p",
        "#{client_tty}",
      ]);
    } finally {
      restoreEnv();
      tmux.restore();
      restore();
    }
  });

  it("does not look one up without a --target", async () => {
    // A spawn placed by `callerPane` lands in the caller's own session by
    // construction, so there is never a client to move: paying for a tmux
    // round-trip on every ordinary spawn would buy nothing.
    console.log = () => {};
    const { bodies, restore } = withFetchCapture("/tmp/tmux-501/default");
    const tmux = withTmuxClientTty("/dev/ttys085");
    const restoreEnv = withEnv(IN_TMUX);
    try {
      await runSpawn([]);
      expect(bodies[0]?.callerTty).toBeUndefined();
      expect(tmux.argv).toHaveLength(0);
    } finally {
      restoreEnv();
      tmux.restore();
      restore();
    }
  });

  it("omits it under --detach, which asks for no switch at all", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture("/tmp/tmux-501/default");
    const tmux = withTmuxClientTty("/dev/ttys085");
    const restoreEnv = withEnv(IN_TMUX);
    try {
      await runSpawn(["--target", "%5", "--detach"]);
      expect(bodies[0]?.callerTty).toBeUndefined();
      expect(bodies[0]?.detach).toBe(true);
      expect(tmux.argv).toHaveLength(0);
    } finally {
      restoreEnv();
      tmux.restore();
      restore();
    }
  });

  it("drops it when the daemon watches another tmux server", async () => {
    // Same reason `callerPane` is dropped: the daemon would be switching a
    // client on a server whose panes have nothing to do with ours.
    console.log = () => {};
    const { bodies, restore } = withFetchCapture("/tmp/tmux-501/other");
    const tmux = withTmuxClientTty("/dev/ttys085");
    const restoreEnv = withEnv(IN_TMUX);
    try {
      await runSpawn(["--target", "%5"]);
      expect(bodies[0]?.callerTty).toBeUndefined();
      expect(tmux.argv).toHaveLength(0);
    } finally {
      restoreEnv();
      tmux.restore();
      restore();
    }
  });

  it("sends nothing when run outside tmux", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture(null);
    const tmux = withTmuxClientTty("/dev/ttys085");
    const restoreEnv = withEnv({
      TMUX: undefined,
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(["--target", "%5"]);
      expect(bodies[0]?.callerTty).toBeUndefined();
      expect(tmux.argv).toHaveLength(0);
    } finally {
      restoreEnv();
      tmux.restore();
      restore();
    }
  });
});

describe("ccmux spawn --split parsing", () => {
  it("accepts h and v, and keeps a bare --split truthy", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(["--split", "h"]);
      await runSpawn(["--split"]);
      expect(bodies[0]?.split).toBe("h");
      expect(bodies[1]?.split).toBe(true);
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("suggests the right argument order when given an agent name", async () => {
    // `ccmux spawn --split codex` is an easy slip, and the bare message
    // reads like the direction is wrong rather than the argument order.
    const command = createSpawnCommand().exitOverride();
    await expect(
      command.parseAsync(["node", "spawn", "--split", "codex"]),
    ).rejects.toThrow(/ccmux spawn codex --split/);
  });
});

describe("--base requires --worktree", () => {
  // `--base` alone is inert. Silently ignoring a flag someone typed costs a
  // confused debugging session, and unlike `--split` without a target there
  // is no sensible thing the command can do with it.
  //
  // The `ensureDaemonCalls` assertion is the point of running this in-process:
  // the check used to sit below `ensureDaemon()`, so rejecting the typo booted
  // a daemon on the shared port first, and this test left one running on
  // whoever's machine ran the suite.
  it("exits with a clear error without starting a daemon", async () => {
    const errors: string[] = [];
    console.error = (line: string) => errors.push(line);
    ensureDaemonCalls = 0;

    const code = await runSpawnExpectingExit(["claude", "--base", "main"]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--base requires --worktree");
    expect(ensureDaemonCalls).toBe(0);
  });
});

describe("ccmux spawn --worktree wire shape", () => {
  // The daemon accepts one shape for `worktree`: an object. Sending the raw
  // flag value (`true` for a bare `--worktree`) is rejected there, so the
  // conversion the CLI does is worth pinning from the wire side.
  it("always sends an object, with unset keys absent after the round-trip", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(["--worktree"]);
      await runSpawn(["--worktree", "x", "--base", "y"]);

      expect(bodies[0]?.worktree).toStrictEqual({});
      expect(Object.keys(bodies[0]?.worktree ?? { name: "" })).toEqual([]);
      expect(bodies[1]?.worktree).toStrictEqual({ name: "x", base: "y" });
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("omits worktree entirely without the flag", async () => {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn([]);
      expect(bodies[0]?.worktree).toBeUndefined();
    } finally {
      restoreEnv();
      restore();
    }
  });
});

describe("ccmux spawn --with-changes validation", () => {
  // Same rule and same placement as `--base requires --worktree`: pure
  // argument validation must not start a daemon on the shared port. Moving
  // uncommitted work is also the last operation that should begin on a
  // half-understood command line.
  it("refuses --with-changes with no destination, without starting a daemon", async () => {
    const errors: string[] = [];
    console.error = (line: string) => errors.push(line);
    ensureDaemonCalls = 0;

    const code = await runSpawnExpectingExit(["claude", "--with-changes"]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--with-changes requires --worktree");
    expect(ensureDaemonCalls).toBe(0);
  });

  it("refuses --untracked with no move to apply it to", async () => {
    const errors: string[] = [];
    console.error = (line: string) => errors.push(line);
    ensureDaemonCalls = 0;

    const code = await runSpawnExpectingExit([
      "claude",
      "--worktree",
      "wt",
      "--untracked",
      "copy",
    ]);

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--untracked requires --with-changes");
    expect(ensureDaemonCalls).toBe(0);
  });

  it("rejects an unknown untracked mode at parse time", async () => {
    // Commander refuses before the action runs at all, so this cannot reach
    // `ensureDaemon` even in principle.
    ensureDaemonCalls = 0;
    const command = createSpawnCommand().exitOverride();

    await expect(
      command.parseAsync([
        "node",
        "spawn",
        "--worktree",
        "wt",
        "--with-changes",
        "--untracked",
        "delete",
      ]),
    ).rejects.toThrow(/move, copy, leave/);
    expect(ensureDaemonCalls).toBe(0);
  });
});

describe("ccmux spawn --with-changes wire shape", () => {
  async function bodyFor(argv: string[]): Promise<SpawnBody | undefined> {
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(argv);
      return bodies[0];
    } finally {
      restoreEnv();
      restore();
    }
  }

  it("puts the move inside the worktree object, mode and all", async () => {
    const body = await bodyFor([
      "--worktree",
      "wt",
      "--with-changes",
      "--untracked",
      "leave",
    ]);

    expect(body?.worktree).toStrictEqual({
      name: "wt",
      withChanges: true,
      untracked: "leave",
    });
  });

  it("leaves the mode out so the daemon's default applies", async () => {
    const body = await bodyFor(["--worktree", "--with-changes"]);

    expect(body?.worktree?.withChanges).toBe(true);
    expect(body?.worktree?.untracked).toBeUndefined();
  });

  it("sends no move fields at all without the flag", async () => {
    // Not even `withChanges: false`: the daemon reads an untracked mode
    // without a move as a contradiction, and a plain `--worktree` has to keep
    // sending the shape it always did.
    const body = await bodyFor(["--worktree", "wt"]);

    expect(body?.worktree).toStrictEqual({ name: "wt" });
  });
});

describe("ccmux spawn --with-changes reporting", () => {
  function withResponse(status: number, payload: Record<string, unknown>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.endsWith("/server-info")) {
        return new Response(JSON.stringify({ socketPath: null }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(payload), { status });
    }) as unknown as typeof fetch;
    return () => (globalThis.fetch = original);
  }

  /**
   * `exits` is explicit rather than derived from the status: a 200 can still
   * exit non-zero (a daemon too old to have honored `--with-changes` answers
   * 200 with no `move`), so "did it exit" is a property of the case, not of
   * the status code.
   */
  async function runAgainst(
    status: number,
    payload: Record<string, unknown>,
    { exits = status !== 200 }: { exits?: boolean } = {},
  ): Promise<{ out: string; err: string; code: number | null }> {
    const out: string[] = [];
    const err: string[] = [];
    console.log = (line: string) => out.push(line);
    console.error = (line: string) => err.push(line);
    const restore = withResponse(status, payload);
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    const argv = ["--worktree", "wt", "--with-changes"];
    try {
      const code = exits
        ? await runSpawnExpectingExit(argv)
        : (await runSpawn(argv), null);
      return { out: out.join("\n"), err: err.join("\n"), code };
    } finally {
      restoreEnv();
      restore();
    }
  }

  it("says what moved, counting untracked files separately", async () => {
    const { out } = await runAgainst(200, {
      success: true,
      paneId: "%9",
      command: "claude",
      move: {
        moved: 3,
        untracked: { mode: "move", files: ["a.txt", "b.txt"] },
      },
    });

    expect(out).toContain("Moved 3 files changed, 2 files untracked moved");
    expect(out).toContain("/caller/dir");
  });

  it("says untracked files stayed behind on leave", async () => {
    const { out } = await runAgainst(200, {
      success: true,
      paneId: "%9",
      command: "claude",
      move: { moved: 1, untracked: { mode: "leave", files: [] } },
    });

    expect(out).toContain("Moved 1 file changed, untracked files left behind");
  });

  // A successful move that could not drop its own backup. Silence would leave
  // it to be found later as a stash entry nobody remembers making.
  it("reports a stash entry the move could not clean up", async () => {
    const { out } = await runAgainst(200, {
      success: true,
      paneId: "%9",
      command: "claude",
      move: {
        moved: 1,
        untracked: { mode: "move", files: [] },
        leftoverStash: "abc123",
      },
    });

    expect(out).toContain("abc123");
    expect(out).toContain("git stash drop");
  });

  /**
   * A daemon older than `--with-changes` drops the keys it does not know and
   * answers 200. The spawn then lands in a worktree with none of the user's
   * work in it, and nothing in the response says so — the absent `move` is
   * the only evidence there is, so it has to be treated as one.
   */
  it("refuses a 200 that carries no move, which means a stale daemon", async () => {
    const { err, code } = await runAgainst(
      200,
      { success: true, paneId: "%9", command: "claude" },
      { exits: true },
    );

    expect(code).toBe(1);
    expect(err).toContain("older build");
    expect(err).toContain("--with-changes");
    expect(err).toContain("not moved");
  });

  /**
   * A failure AFTER the move succeeds is a 500, and its body is the only
   * place that says the user's work has already left their checkout.
   * Collapsing it to "HTTP 500" throws away exactly the sentence they need.
   */
  it("prints the daemon's own message for a failure after the move", async () => {
    const { err, code } = await runAgainst(500, {
      error:
        "tmux new-window failed: no server running (your uncommitted changes were already moved out of /repo to /repo/.claude/worktrees/wt)",
      move: {
        moved: 2,
        source: "/repo",
        untracked: { mode: "move", files: ["a.txt"] },
      },
    });

    expect(code).toBe(1);
    expect(err).toContain("already moved out of /repo");
    expect(err).not.toContain("HTTP 500");
    // And the same accounting the success path prints, so the user can see
    // what left the checkout.
    expect(err).toContain("Moved 2 files changed");
    expect(err).toContain("out of /repo");
  });

  it("names the directory the daemon actually moved out of", async () => {
    // Under `--fork` the source is the forked session's checkout, which the
    // daemon resolves and the CLI never sees. Printing the local cwd there
    // names a directory nothing happened in.
    const { out } = await runAgainst(200, {
      success: true,
      paneId: "%9",
      command: "claude",
      move: {
        moved: 1,
        untracked: { mode: "move", files: [] },
        source: "/elsewhere/repo",
      },
    });

    expect(out).toContain("out of /elsewhere/repo");
    expect(out).not.toContain("/caller/dir");
  });

  it("notes when the staged/unstaged split could not be kept", async () => {
    // Not an error — every edit landed — but a `git add` the user had
    // already done did not survive, and finding that out at commit time is
    // worse than reading one line here.
    const { out, code } = await runAgainst(200, {
      success: true,
      paneId: "%9",
      command: "claude",
      move: {
        moved: 2,
        untracked: { mode: "move", files: [] },
        flattenedIndex: true,
      },
    });

    expect(code).toBe(null);
    expect(out).toContain("staged");
    expect(out).toContain("git add");
  });

  /**
   * The recovery path. A refused move can leave the work in a stash entry,
   * and the sha is the only handle the user has for getting it back, so it
   * has to reach the terminal rather than staying in the response body.
   */
  it("names the stash entry when the move is refused", async () => {
    const { err, code } = await runAgainst(400, {
      error: "Could not create the worktree: Base ref not found: nope",
      reason: "create-failed",
      stashSha: "deadbeef",
      sourceRestored: true,
    });

    expect(code).toBe(1);
    expect(err).toContain("Base ref not found");
    expect(err).toContain("deadbeef");
    // Restored, so the entry is a redundant copy rather than the only one.
    expect(err).toContain("back in the checkout");
  });

  it("tells an unrestored source that the stash is the only copy", async () => {
    const { err } = await runAgainst(400, {
      error: "Could not apply the changes in the new worktree: conflict",
      reason: "apply-failed",
      stashSha: "cafe1234",
      sourceRestored: false,
    });

    expect(err).toContain("git stash apply cafe1234");
    expect(err).not.toContain("back in the checkout");
  });

  it("says nothing about stashes when the refusal left none", async () => {
    const { err } = await runAgainst(400, {
      error: "Nothing to move: /caller/dir has no uncommitted changes.",
      reason: "nothing-to-move",
    });

    expect(err).toContain("Nothing to move");
    expect(err).not.toContain("stash");
  });
});

describe("ccmux spawn --worktree reporting", () => {
  /** Answer `/spawn` with a worktree result of the given shape. */
  function withWorktreeResponse(worktree: Record<string, unknown>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.endsWith("/server-info")) {
        return new Response(JSON.stringify({ socketPath: null }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          success: true,
          paneId: "%9",
          command: "claude",
          worktree,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    return () => (globalThis.fetch = original);
  }

  async function reportFor(
    worktree: Record<string, unknown>,
    argv: string[] = ["--worktree", "wt"],
  ): Promise<string> {
    const lines: string[] = [];
    console.log = (line: string) => lines.push(line);
    const restore = withWorktreeResponse(worktree);
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(argv);
      return lines.join("\n");
    } finally {
      restoreEnv();
      restore();
    }
  }

  // The default base is the MAIN checkout's current branch, not the caller's,
  // so which ref the branch was cut from is not something the user can infer.
  it("names the base a new branch was cut from", async () => {
    const out = await reportFor({
      name: "wt",
      path: "/repo/.claude/worktrees/wt",
      branch: "wt",
      created: true,
      branchCreated: true,
      base: "release/2.0",
    });

    expect(out).toContain("Created worktree wt on new branch wt");
    expect(out).toContain("from release/2.0");
  });

  // Branch reuse is intentional, but the reused branch can already carry
  // twenty commits: reporting it as created would misdescribe the starting
  // point of everything the agent is about to do.
  it("does not call a reused branch new", async () => {
    const out = await reportFor({
      name: "wt",
      path: "/repo/.claude/worktrees/wt",
      branch: "wt",
      created: true,
      branchCreated: false,
    });

    expect(out).toContain("Created worktree wt on existing branch wt");
    expect(out).not.toContain("new branch");
  });

  it("reports an opened worktree as reused", async () => {
    const out = await reportFor({
      name: "wt",
      path: "/repo/.claude/worktrees/wt",
      branch: "wt",
      created: false,
      branchCreated: false,
    });

    expect(out).toContain("Reusing worktree wt on branch wt");
  });

  // An existing worktree is already on its branch, so `--base` had nothing to
  // cut. Reporting the reuse without a word about it leaves the user believing
  // their agent started from the ref they named.
  it("says --base was ignored when the worktree was reused", async () => {
    const out = await reportFor(
      {
        name: "wt",
        path: "/repo/.claude/worktrees/wt",
        branch: "wt",
        created: false,
        branchCreated: false,
      },
      ["--worktree", "wt", "--base", "develop"],
    );

    expect(out).toContain("Reusing worktree wt on branch wt");
    expect(out).toContain("--base ignored");
  });
});

describe("ccmux spawn --fork", () => {
  it("sends the source session id and lets the daemon supply agent and cwd", async () => {
    // Both come off the session being forked: continuing a conversation
    // about one repo from a shell in another must not relocate it, and the
    // positional agent (which defaults to "claude") has no say either.
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(["--fork", "abc-123"]);
      expect(bodies[0]?.fork).toBe("abc-123");
      expect(bodies[0]?.agent).toBeUndefined();
      expect(bodies[0]?.cwd).toBeUndefined();
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("still honors an explicit --cwd when forking", async () => {
    // The escape hatch a worktree destination needs: same fork, elsewhere.
    console.log = () => {};
    const { bodies, restore } = withFetchCapture();
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(["--fork", "abc-123", "--cwd", "/other/tree"]);
      expect(bodies[0]?.cwd).toBe("/other/tree");
      expect(bodies[0]?.fork).toBe("abc-123");
    } finally {
      restoreEnv();
      restore();
    }
  });

  it("reports the fork rather than the positional agent", async () => {
    const lines: string[] = [];
    console.log = (line: string) => lines.push(line);
    const { restore } = withFetchCapture();
    const restoreEnv = withEnv({
      TMUX_PANE: undefined,
      CCMUX_CALLER_PWD: "/caller/dir",
    });
    try {
      await runSpawn(["--fork", "abc-123"]);
      expect(lines[0]).toContain("Forked abc-123");
    } finally {
      restoreEnv();
      restore();
    }
  });
});
