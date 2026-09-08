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
 * Pin `$TMUX`, which the resolver reads to decide whether the popup probes are
 * worth running at all, and whose third field names the launching session.
 * Left to the ambient environment these tests would pass or fail depending on
 * whether the suite itself runs inside tmux.
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
 *  popup inputs, which run concurrently with it. The client listing is scoped
 *  to the session `$TMUX` names ($0 here), which is the launching one. */
const PROBE_CALLS = [
  ["tmux", "display-message", "-p", "#{client_tty}"],
  ["tmux", "list-panes", "-a", "-F", "#{pane_tty}"],
  ["tty"],
  ["tmux", "list-clients", "-t", "$0", "-F", "#{client_tty}"],
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
      { stdout: `${PANE_TTY}\n` },
      { stdout: `${PANE_TTY}\n` },
      { stdout: "/dev/ttys010\n/dev/ttys011\n" },
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

  it("switches the client that opened the popup, not tmux's guess", async () => {
    // No captured tty, a popup (our tty is in no pane): #{client_tty} names
    // whichever other client typed last, while the session `$TMUX` names has
    // exactly one client, and that is the terminal the popup came from.
    const spawn = withSpawn([
      { stdout: "/dev/ttys011\n" },
      { stdout: "/dev/ttys002\n" },
      { stdout: "/dev/ttys099\n" },
      { stdout: "/dev/ttys010\n" },
      {},
    ]);
    try {
      const result = await withTmux(INSIDE_TMUX, () =>
        withClientTty(undefined, () => switchToPane("%8")),
      );

      expect(result).toBe(true);
      expect(spawn.calls).toEqual([
        ...PROBE_CALLS,
        ["tmux", "switch-client", "-c", "/dev/ttys010", "-t", "%8"],
      ]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses inside a popup whose session has two terminals on it", async () => {
    // Both are attached to the launching session, so nothing distinguishes
    // them and nobody moves.
    const spawn = withSpawn([
      { stdout: "/dev/ttys011\n" },
      { stdout: "/dev/ttys002\n" },
      { stdout: "/dev/ttys099\n" },
      { stdout: "/dev/ttys010\n/dev/ttys011\n" },
    ]);
    try {
      const result = await withTmux(INSIDE_TMUX, () =>
        withClientTty(undefined, () => switchToPane("%8")),
      );

      expect(result).toBe("shared-session-popup");
      // The probes ran; the switch did not.
      expect(spawn.calls).toEqual(PROBE_CALLS);
    } finally {
      spawn.restore();
    }
  });

  it("refuses inside a popup whose session lists no client", async () => {
    // A popup is being drawn, so a client exists; an empty list only means the
    // binding named a session it is not attached to. The toast has to say the
    // launcher could not be worked out, not that nobody is here.
    const spawn = withSpawn([
      { stdout: "/dev/ttys011\n" },
      { stdout: "/dev/ttys002\n" },
      { stdout: "/dev/ttys099\n" },
      { stdout: "" },
    ]);
    try {
      const result = await withTmux(INSIDE_TMUX, () =>
        withClientTty(undefined, () => switchToPane("%8")),
      );

      expect(result).toBe("popup-client-unknown");
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
