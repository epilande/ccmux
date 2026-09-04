import { afterEach, describe, expect, it } from "bun:test";
import { setPinnedTmuxClientTty } from "../../lib/tmux-client";

// App.test.tsx process-wide mocks tmux.ts, which re-exports this function.
// Use a distinct cache entry so this file always exercises the implementation.
const REAL_CLIENT_SWITCH_SPECIFIER = "./client-switch" + "?real";
const { switchToPane } = (await import(
  REAL_CLIENT_SWITCH_SPECIFIER
)) as typeof import("./client-switch");

interface SpawnResponse {
  stdout?: string;
  exitCode?: number;
}

function withSpawn(responses: SpawnResponse[]): {
  calls: string[][];
  restore: () => void;
} {
  const original = Bun.spawn;
  const calls: string[][] = [];
  Bun.spawn = ((argv: string[]) => {
    calls.push([...argv]);
    const response = responses.shift() ?? {};
    return {
      stdout: new Blob([response.stdout ?? ""]).stream(),
      exited: Promise.resolve(response.exitCode ?? 0),
    };
  }) as unknown as typeof Bun.spawn;
  return {
    calls,
    restore: () => {
      Bun.spawn = original;
    },
  };
}

async function withClientTty<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.CCMUX_CLIENT_TTY;
  if (value === undefined) delete process.env.CCMUX_CLIENT_TTY;
  else process.env.CCMUX_CLIENT_TTY = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CCMUX_CLIENT_TTY;
    else process.env.CCMUX_CLIENT_TTY = previous;
  }
}

/**
 * The `--client-tty` flag lives in a module-level slot rather than an
 * argument, so every test that sets it has to put it back.
 */
async function withClientTtyFlag<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  setPinnedTmuxClientTty(value);
  try {
    return await run();
  } finally {
    setPinnedTmuxClientTty(undefined);
  }
}

afterEach(() => {
  setPinnedTmuxClientTty(undefined);
});

describe("switchToPane", () => {
  it("pins the switch to the client tty captured by the picker binding", async () => {
    const spawn = withSpawn([{}]);
    try {
      const result = await withClientTty("/dev/ttys005", () =>
        switchToPane("%42"),
      );

      expect(result).toBe(true);
      expect(spawn.calls).toEqual([
        ["tmux", "switch-client", "-c", "/dev/ttys005", "-t", "%42"],
      ]);
    } finally {
      spawn.restore();
    }
  });

  it("falls back to the current tmux client for legacy picker launches", async () => {
    const spawn = withSpawn([{ stdout: "/dev/pts/7\n" }, {}]);
    try {
      const result = await withClientTty(undefined, () => switchToPane("%8"));

      expect(result).toBe(true);
      expect(spawn.calls).toEqual([
        ["tmux", "display-message", "-p", "#{client_tty}"],
        ["tmux", "switch-client", "-c", "/dev/pts/7", "-t", "%8"],
      ]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses an explicitly invalid client tty without falling back", async () => {
    const spawn = withSpawn([]);
    try {
      const result = await withClientTty("", () => switchToPane("%8"));

      expect(result).toBe("client-unavailable");
      expect(spawn.calls).toEqual([]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses a client tty that is not a device path", async () => {
    const spawn = withSpawn([]);
    try {
      const result = await withClientTty("ttys005", () => switchToPane("%8"));

      expect(result).toBe("client-unavailable");
      expect(spawn.calls).toEqual([]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses when a legacy launch has no current tmux client", async () => {
    const spawn = withSpawn([{ exitCode: 1 }]);
    try {
      const result = await withClientTty(undefined, () => switchToPane("%8"));

      expect(result).toBe("client-unavailable");
      expect(spawn.calls).toEqual([
        ["tmux", "display-message", "-p", "#{client_tty}"],
      ]);
    } finally {
      spawn.restore();
    }
  });

  it("reports a directed switch failure", async () => {
    const spawn = withSpawn([{ exitCode: 1 }]);
    try {
      const result = await withClientTty("/dev/ttys005", () =>
        switchToPane("%42"),
      );

      expect(result).toBe("switch-failed");
    } finally {
      spawn.restore();
    }
  });
  it("prefers the --client-tty flag over the environment and the fallback", async () => {
    const spawn = withSpawn([{}]);
    try {
      const result = await withClientTtyFlag("/dev/ttys011", () =>
        withClientTty("/dev/ttys005", () => switchToPane("%42")),
      );

      expect(result).toBe(true);
      expect(spawn.calls).toEqual([
        ["tmux", "switch-client", "-c", "/dev/ttys011", "-t", "%42"],
      ]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses an invalid --client-tty instead of falling back to the env or tmux", async () => {
    // A malformed capture means the user's tmux binding is broken. Guessing
    // here is how the wrong client gets moved, which is the whole bug.
    const spawn = withSpawn([]);
    try {
      const result = await withClientTtyFlag("ttys011", () =>
        withClientTty("/dev/ttys005", () => switchToPane("%42")),
      );

      expect(result).toBe("client-unavailable");
      expect(spawn.calls).toEqual([]);
    } finally {
      spawn.restore();
    }
  });
});
