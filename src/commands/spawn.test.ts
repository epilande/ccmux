import { describe, it, expect, mock, afterEach } from "bun:test";

// Neutralize ensureDaemon so the action never spawns/probes a real daemon.
const realShared = await import("./shared");
mock.module("./shared", () => ({
  ...realShared,
  ensureDaemon: async () => {},
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
  detach: boolean;
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
    bodies.push(JSON.parse(String(init?.body)) as SpawnBody);
    return new Response(
      JSON.stringify({ success: true, paneId: "%9", command: "claude" }),
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
afterEach(() => {
  console.log = originalLog;
});

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
  it("exits with a clear error", async () => {
    const proc = Bun.spawnSync(
      ["bun", "run", "src/index.ts", "spawn", "claude", "--base", "main"],
      { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
    );

    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("--base requires --worktree");
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
