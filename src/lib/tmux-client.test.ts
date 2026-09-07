import { describe, it, expect } from "bun:test";
import {
  getActiveTmuxClientPid,
  resolveActiveTmuxClientTty,
  resolvePinnedTmuxClientTty,
  setPinnedTmuxClientTty,
} from "./tmux-client";
import { markDaemonProcess, resetTmuxSocketCache } from "./tmux-socket";

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
 * The tmux verb an argv runs, past any socket flags a configured override
 * prepends (`tmux -L popfix list-clients ...`).
 */
function spawnVerb(argv: string[]): string {
  if (argv[0] === "tty") return "tty";
  let i = 1;
  while (argv[i] === "-L" || argv[i] === "-S") i += 2;
  return argv[i] ?? "";
}

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
    const canned = byCommand[spawnVerb(argv)];
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

  it("names the launching client inside a popup, not tmux's guess", async () => {
    // #{client_tty} names whichever OTHER client typed last, so the guess is
    // exactly the wrong terminal to move. The session `$TMUX` names has one
    // client, and that client is the one that opened the popup.
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys011\n",
      "list-clients": "/dev/ttys010\n",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    try {
      const resolved = await withLaunch({ tmux: INSIDE_TMUX }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: "/dev/ttys010" });
      // The session came out of `$TMUX`, so the listing is scoped to it.
      expect(spawn.calls).toContainEqual([
        "tmux",
        "list-clients",
        "-t",
        "$0",
        "-F",
        "#{client_tty}",
      ]);
    } finally {
      spawn.restore();
    }
  });

  it("refuses when two terminals share the popup's session", async () => {
    // Both are attached to the session `$TMUX` names, and nothing here can say
    // which one opened the popup. Only the binding can.
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys011\n",
      "list-clients": "/dev/ttys010\n/dev/ttys011\n",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    try {
      const resolved = await withLaunch({ tmux: INSIDE_TMUX }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "shared-session-popup" });
    } finally {
      spawn.restore();
    }
  });

  it("reports no client when the popup's session has none attached", async () => {
    // The launching client detached while the popup was up. The guess is no
    // fallback here: inside a popup it names some other terminal by definition.
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys011\n",
      "list-clients": "",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    try {
      const resolved = await withLaunch({ tmux: INSIDE_TMUX }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "no-client" });
    } finally {
      spawn.restore();
    }
  });

  it("says the popup's client is unknown when the listing failed", async () => {
    // A launching client exists, we just could not name it. That is not
    // "no client": a caller that places a window untargeted on it would place
    // it relative to whichever session tmux picks instead.
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys011\n",
      "list-clients": 1,
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    try {
      const resolved = await withLaunch({ tmux: INSIDE_TMUX }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "popup-client-unknown" });
    } finally {
      spawn.restore();
    }
  });

  it("says the popup's client is unknown when $TMUX names no session", async () => {
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys011\n",
      "list-clients": "/dev/ttys010\n",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    try {
      const resolved = await withLaunch(
        { tmux: "/private/tmp/tmux-501/default,1,alpha" },
        () => resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "popup-client-unknown" });
    } finally {
      spawn.restore();
    }
  });

  it("refuses a lone client tty that is not a device path", async () => {
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys011\n",
      "list-clients": "(none)\n",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    try {
      const resolved = await withLaunch({ tmux: INSIDE_TMUX }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "no-client" });
    } finally {
      spawn.restore();
    }
  });

  it("refuses a popup whose client would have to be read off another server", async () => {
    // The session `$TMUX` names is not on the server we query, so no client
    // listing is attempted and the guess is no fallback either.
    const spawn = withCommandSpawn({
      "display-message": "/dev/ttys011\n",
      "list-clients": "/dev/ttys010\n",
      "list-panes": `${PANE_TTY}\n`,
      tty: `${POPUP_TTY}\n`,
    });
    const previousSocket = process.env.CCMUX_TMUX_SOCKET;
    process.env.CCMUX_TMUX_SOCKET = "/private/tmp/tmux-501/other";
    // Only the daemon applies an override while `$TMUX` is set, so this is the
    // one process shape in which the two can disagree.
    markDaemonProcess();
    try {
      const resolved = await withLaunch({ tmux: INSIDE_TMUX }, () =>
        resolvePinnedTmuxClientTty(),
      );

      expect(resolved).toEqual({ tty: null, refusal: "popup-client-unknown" });
      // The pane probes still run (they are what proves this is a popup at
      // all); the per-session client listing is the one that cannot apply.
      expect(spawn.calls.map(spawnVerb).sort()).toEqual([
        "display-message",
        "list-panes",
        "tty",
      ]);
    } finally {
      if (previousSocket === undefined) delete process.env.CCMUX_TMUX_SOCKET;
      else process.env.CCMUX_TMUX_SOCKET = previousSocket;
      resetTmuxSocketCache();
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
