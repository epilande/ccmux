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

/**
 * Pin `$TMUX`, which the resolver reads to decide whether the legacy-popup
 * probes are worth running at all. Left to the ambient environment these tests
 * would pass or fail depending on whether the suite itself runs inside tmux.
 */
async function withTmux<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.TMUX;
  if (value === undefined) delete process.env.TMUX;
  else process.env.TMUX = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.TMUX;
    else process.env.TMUX = previous;
  }
}

const INSIDE_TMUX = "/private/tmp/tmux-501/default,1,0";
const PANE_TTY = "/dev/pts/7";
/** The probe order behind an uncaptured resolve: the guess, then the three
 *  legacy-popup inputs, which run concurrently with it. */
const PROBE_CALLS = [
  ["tmux", "display-message", "-p", "#{client_tty}"],
  ["tmux", "list-clients", "-F", "#{client_tty}"],
  ["tmux", "list-panes", "-a", "-F", "#{pane_tty}"],
  ["tty"],
];

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

  it("falls back to the current tmux client in a real pane", async () => {
    // Our own tty IS a pane, so the guess cannot be some other client.
    const spawn = withSpawn([
      { stdout: `${PANE_TTY}\n` },
      { stdout: "/dev/ttys010\n/dev/ttys011\n" },
      { stdout: `${PANE_TTY}\n` },
      { stdout: `${PANE_TTY}\n` },
      {},
    ]);
    try {
      const result = await withTmux(INSIDE_TMUX, () =>
        withClientTty(undefined, () => switchToPane("%8")),
      );

      expect(result).toBe(true);
      expect(spawn.calls).toEqual([
        ...PROBE_CALLS,
        ["tmux", "switch-client", "-c", PANE_TTY, "-t", "%8"],
      ]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses the guess inside a legacy multi-client popup", async () => {
    // No captured tty, a popup (our tty is in no pane), more than one client:
    // #{client_tty} names the other client that typed last, so nobody moves.
    const spawn = withSpawn([
      { stdout: "/dev/pts/7\n" },
      { stdout: "/dev/ttys010\n/dev/ttys011\n" },
      { stdout: "/dev/ttys002\n" },
      { stdout: "/dev/ttys099\n" },
    ]);
    try {
      const result = await withTmux(INSIDE_TMUX, () =>
        withClientTty(undefined, () => switchToPane("%8")),
      );

      expect(result).toBe("legacy-popup");
      // The probes ran; the switch did not.
      expect(spawn.calls).toEqual(PROBE_CALLS);
    } finally {
      spawn.restore();
    }
  });

  it("takes the guess outside tmux without probing for a popup", async () => {
    // A plain terminal has no pane of its own either, so probing would flag it
    // as a popup and cost it every switch it ever makes.
    const spawn = withSpawn([{ stdout: "/dev/pts/7\n" }, {}]);
    try {
      const result = await withTmux(undefined, () =>
        withClientTty(undefined, () => switchToPane("%8")),
      );

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

      expect(result).toBe("malformed-capture");
      expect(spawn.calls).toEqual([]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses a client tty that is not a device path", async () => {
    const spawn = withSpawn([]);
    try {
      const result = await withClientTty("ttys005", () => switchToPane("%8"));

      expect(result).toBe("malformed-capture");
      expect(spawn.calls).toEqual([]);
    } finally {
      spawn.restore();
    }
  });

  it("reports no client when tmux names none", async () => {
    const spawn = withSpawn([{ exitCode: 1 }]);
    try {
      const result = await withTmux(undefined, () =>
        withClientTty(undefined, () => switchToPane("%8")),
      );

      expect(result).toBe("no-client");
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

      expect(result).toBe("malformed-capture");
      expect(spawn.calls).toEqual([]);
    } finally {
      spawn.restore();
    }
  });
});
