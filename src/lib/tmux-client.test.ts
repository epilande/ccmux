import { describe, it, expect } from "bun:test";
import {
  getActiveTmuxClientPid,
  resolveActiveTmuxClientTty,
  resolvePinnedTmuxClientTty,
  setPinnedTmuxClientTty,
} from "./tmux-client";

/** Stub `Bun.spawn` to return canned stdout/exit code for the next call. */
function withSpawn(stdout: string, exitCode = 0): () => void {
  const original = Bun.spawn;
  Bun.spawn = (() => ({
    stdout: new Blob([stdout]).stream(),
    exited: Promise.resolve(exitCode),
  })) as unknown as typeof Bun.spawn;
  return () => {
    Bun.spawn = original;
  };
}

function withThrowingSpawn(): () => void {
  const original = Bun.spawn;
  Bun.spawn = (() => {
    throw new Error("no tmux server");
  }) as unknown as typeof Bun.spawn;
  return () => {
    Bun.spawn = original;
  };
}

describe("getActiveTmuxClientPid", () => {
  it("parses the pid from display-message output", async () => {
    const restore = withSpawn("12345\n");
    try {
      expect(await getActiveTmuxClientPid()).toBe(12345);
    } finally {
      restore();
    }
  });

  it("returns null on a non-zero exit", async () => {
    const restore = withSpawn("", 1);
    try {
      expect(await getActiveTmuxClientPid()).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null when spawn throws (no tmux server)", async () => {
    const restore = withThrowingSpawn();
    try {
      expect(await getActiveTmuxClientPid()).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("resolveActiveTmuxClientTty", () => {
  it("picks the tty with the highest client_activity", async () => {
    const restore = withSpawn(
      "100 /dev/ttys001\n200 /dev/ttys002\n50 /dev/ttys003\n",
    );
    try {
      expect(await resolveActiveTmuxClientTty()).toBe("/dev/ttys002");
    } finally {
      restore();
    }
  });

  it("returns null when no clients are attached", async () => {
    const restore = withSpawn("");
    try {
      expect(await resolveActiveTmuxClientTty()).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null on a non-zero exit", async () => {
    const restore = withSpawn("100 /dev/ttys001\n", 1);
    try {
      expect(await resolveActiveTmuxClientTty()).toBeNull();
    } finally {
      restore();
    }
  });

  it("returns null when spawn throws", async () => {
    const restore = withThrowingSpawn();
    try {
      expect(await resolveActiveTmuxClientTty()).toBeNull();
    } finally {
      restore();
    }
  });
});

/**
 * Stub `Bun.spawn` per command, since the resolver's uncaptured arm fires four
 * of them concurrently (`display-message`, the two `list-` probes, and `tty`)
 * and a sequence-keyed stub would pin an order the code is free to change.
 */
function withCommandSpawn(byCommand: Record<string, string | number>): {
  calls: string[][];
  restore: () => void;
} {
  const original = Bun.spawn;
  const calls: string[][] = [];
  Bun.spawn = ((argv: string[]) => {
    calls.push([...argv]);
    const key = argv[0] === "tty" ? "tty" : (argv[1] ?? "");
    const canned = byCommand[key];
    return {
      stdout: new Blob([typeof canned === "string" ? canned : ""]).stream(),
      exited: Promise.resolve(typeof canned === "number" ? canned : 0),
    };
  }) as unknown as typeof Bun.spawn;
  return {
    calls,
    restore: () => {
      Bun.spawn = original;
    },
  };
}

/** Both the flag slot and `$TMUX` are process-wide, so every test puts them back. */
async function withLaunch<T>(
  launch: { flag?: string; tmux?: string },
  run: () => Promise<T>,
): Promise<T> {
  const previousTmux = process.env.TMUX;
  if (launch.tmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = launch.tmux;
  setPinnedTmuxClientTty(launch.flag);
  try {
    return await run();
  } finally {
    setPinnedTmuxClientTty(undefined);
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
  }
}

const INSIDE_TMUX = "/private/tmp/tmux-501/default,1,0";
const POPUP_TTY = "/dev/ttys099";
const PANE_TTY = "/dev/ttys002";

describe("resolvePinnedTmuxClientTty", () => {
  it("takes a captured tty without asking tmux anything", async () => {
    const spawn = withCommandSpawn({});
    try {
      const resolved = await withLaunch(
        { flag: "/dev/ttys005", tmux: INSIDE_TMUX },
        () => resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: "/dev/ttys005" });
      expect(spawn.calls).toEqual([]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses a malformed capture instead of falling back to the guess", async () => {
    const spawn = withCommandSpawn({});
    try {
      const resolved = await withLaunch(
        { flag: "ttys005", tmux: INSIDE_TMUX },
        () => resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "malformed-capture" });
      expect(spawn.calls).toEqual([]);
    } finally {
      spawn.restore();
    }
  });

  it("takes the guess when our own tty is a real pane", async () => {
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys010\n",
      "list-clients": "/dev/ttys010\n/dev/ttys011\n",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${PANE_TTY}\n`,
    });
    try {
      const resolved = await withLaunch({ tmux: INSIDE_TMUX }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: "/dev/ttys010" });
    } finally {
      spawn.restore();
    }
  });

  it("refuses the guess inside a legacy popup with several clients", async () => {
    // #{client_tty} names whichever OTHER client typed last, so the guess is
    // exactly the wrong terminal to move.
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys010\n",
      "list-clients": "/dev/ttys010\n/dev/ttys011\n",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    try {
      const resolved = await withLaunch({ tmux: INSIDE_TMUX }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "legacy-popup" });
    } finally {
      spawn.restore();
    }
  });

  it("takes the guess outside tmux, where no pane of our own proves nothing", async () => {
    // A plain terminal is not a popup: it has no pane, and `list-clients`
    // answers from anywhere on the machine. Probing at all would be wrong, so
    // `display-message` is the only command that may run.
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys010\n",
      "list-clients": "/dev/ttys010\n/dev/ttys011\n",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    try {
      const resolved = await withLaunch({ tmux: undefined }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: "/dev/ttys010" });
      expect(spawn.calls).toEqual([
        ["tmux", "display-message", "-p", "#{client_tty}"],
      ]);
    } finally {
      spawn.restore();
    }
  });

  it("reports no client when tmux names none", async () => {
    const spawn = withCommandSpawn({ "display-message": 1 });
    try {
      const resolved = await withLaunch({ tmux: undefined }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "no-client" });
    } finally {
      spawn.restore();
    }
  });
});
