import { describe, expect, it } from "bun:test";
import {
  isPopupLaunch,
  parsePopupSessionId,
  resolvePopupClient,
  type PopupClientDeps,
} from "./popup-client";
import { markDaemonProcess, resetTmuxSocketCache } from "./tmux-socket";

const SOCKET = "/private/tmp/tmux-501/default";
const INSIDE_TMUX = `${SOCKET},1,0`;
const POPUP_TTY = "/dev/ttys099";
const PANE_TTYS = ["/dev/ttys001", "/dev/ttys002"];
const LAUNCHER = "/dev/ttys010";
const TWO_CLIENTS = [LAUNCHER, "/dev/ttys011"];

/** The flag lives in the environment, so every test that reads it restores it. */
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

describe("isPopupLaunch", () => {
  it("flags a launch whose own tty belongs to no pane", () => {
    expect(
      isPopupLaunch({
        insideTmux: true,
        ownTty: POPUP_TTY,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(true);
  });

  it("stays quiet in a real pane, where the current client is unambiguous", () => {
    expect(
      isPopupLaunch({
        insideTmux: true,
        ownTty: "/dev/ttys002",
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });

  it("stays quiet outside tmux, where having no pane means nothing", () => {
    // A plain terminal has no pane either, and `list-panes` answers from
    // anywhere on the machine. Without this test a bare `ccmux` in a second
    // terminal looks exactly like a popup.
    expect(
      isPopupLaunch({
        insideTmux: false,
        ownTty: POPUP_TTY,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });

  it("stays quiet when a tmux query failed", () => {
    expect(
      isPopupLaunch({ insideTmux: true, ownTty: POPUP_TTY, paneTtys: null }),
    ).toBe(false);
  });

  it("stays quiet when we have no tty of our own to compare", () => {
    expect(
      isPopupLaunch({ insideTmux: true, ownTty: null, paneTtys: PANE_TTYS }),
    ).toBe(false);
  });
});

describe("parsePopupSessionId", () => {
  it("reads the launching session out of $TMUX's third field", () => {
    expect(parsePopupSessionId(`${SOCKET},1,7`)).toBe("$7");
  });

  it("answers null with no $TMUX at all", () => {
    expect(parsePopupSessionId(undefined)).toBeNull();
    expect(parsePopupSessionId("")).toBeNull();
  });

  it("answers null when the third field is missing", () => {
    expect(parsePopupSessionId(`${SOCKET},1`)).toBeNull();
  });

  it("answers null when the third field is not a session number", () => {
    // The value becomes a tmux target, so anything unrecognized is a reason to
    // know nothing rather than to build `$` plus whatever was in the
    // environment.
    expect(parsePopupSessionId(`${SOCKET},1,$0`)).toBeNull();
    expect(parsePopupSessionId(`${SOCKET},1,alpha`)).toBeNull();
    expect(parsePopupSessionId(`${SOCKET},1,`)).toBeNull();
  });
});

function countingDeps(overrides: Partial<PopupClientDeps> = {}): {
  deps: PopupClientDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: PopupClientDeps = {
    listPaneTtys:
      overrides.listPaneTtys ??
      (async () => {
        calls.push("list-panes");
        return PANE_TTYS;
      }),
    readTty:
      overrides.readTty ??
      (async () => {
        calls.push("tty");
        return POPUP_TTY;
      }),
    listSessionClientTtys:
      overrides.listSessionClientTtys ??
      (async (sessionId) => {
        calls.push(`list-clients ${sessionId}`);
        return [LAUNCHER];
      }),
  };
  return { deps, calls };
}

describe("resolvePopupClient", () => {
  it("names the launching session's one client", async () => {
    const { deps, calls } = countingDeps();
    expect(await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps))).toEqual(
      {
        kind: "clients",
        ttys: [LAUNCHER],
      },
    );
    expect(calls.sort()).toEqual(["list-clients $0", "list-panes", "tty"]);
  });

  it("hands back every client when the session has more than one", async () => {
    const { deps } = countingDeps({
      listSessionClientTtys: async () => TWO_CLIENTS,
    });
    expect(await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps))).toEqual(
      {
        kind: "clients",
        ttys: TWO_CLIENTS,
      },
    );
  });

  it("hands back an empty list when nobody is attached to that session", async () => {
    const { deps } = countingDeps({ listSessionClientTtys: async () => [] });
    expect(await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps))).toEqual(
      {
        kind: "clients",
        ttys: [],
      },
    );
  });

  it("knows nothing when the client query fails", async () => {
    const { deps } = countingDeps({ listSessionClientTtys: async () => null });
    expect(await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps))).toEqual(
      {
        kind: "unknown",
      },
    );
  });

  it("knows nothing when $TMUX names no session we can parse", async () => {
    const { deps, calls } = countingDeps();
    expect(
      await withTmux(`${SOCKET},1,alpha`, () => resolvePopupClient(deps)),
    ).toEqual({ kind: "unknown" });
    // The session query is the one probe that had nothing to ask for.
    expect(calls.sort()).toEqual(["list-panes", "tty"]);
  });

  it("runs no query at all outside tmux", async () => {
    const { deps, calls } = countingDeps();
    expect(await withTmux(undefined, () => resolvePopupClient(deps))).toEqual({
      kind: "not-popup",
    });
    expect(calls).toEqual([]);
  });

  it("does not flag a picker running in a real pane", async () => {
    const { deps } = countingDeps({ readTty: async () => PANE_TTYS[0]! });
    expect(await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps))).toEqual(
      {
        kind: "not-popup",
      },
    );
  });

  /** Point every tmux call at a server other than the one `$TMUX` names. Only
   *  the daemon applies an override while `$TMUX` is set, so a daemon-marked
   *  process is the one shape in which the two can disagree. */
  async function withOtherServer<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.CCMUX_TMUX_SOCKET;
    process.env.CCMUX_TMUX_SOCKET = "/private/tmp/tmux-501/other";
    markDaemonProcess();
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.CCMUX_TMUX_SOCKET;
      else process.env.CCMUX_TMUX_SOCKET = previous;
      resetTmuxSocketCache();
    }
  }

  it("knows nothing about a popup when our tmux calls go to another server", async () => {
    // The session `$TMUX` names does not live on the server we would ask, so
    // its client listing is not even attempted.
    const { deps, calls } = countingDeps();
    await withOtherServer(async () => {
      expect(
        await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps)),
      ).toEqual({ kind: "unknown" });
      expect(calls.sort()).toEqual(["list-panes", "tty"]);
    });
  });

  it("still reports a real pane as not-popup on a mismatched server", async () => {
    // A plain pane's current client is unambiguous whichever server answers,
    // so a mismatch must not cost it the caller's ordinary fallback.
    const { deps } = countingDeps({ readTty: async () => PANE_TTYS[0]! });
    await withOtherServer(async () => {
      expect(
        await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps)),
      ).toEqual({ kind: "not-popup" });
    });
  });

  it("probes normally when the override names the server we are inside", async () => {
    const { deps } = countingDeps();
    const previous = process.env.CCMUX_TMUX_SOCKET;
    process.env.CCMUX_TMUX_SOCKET = SOCKET;
    markDaemonProcess();
    try {
      expect(
        await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps)),
      ).toEqual({ kind: "clients", ttys: [LAUNCHER] });
    } finally {
      if (previous === undefined) delete process.env.CCMUX_TMUX_SOCKET;
      else process.env.CCMUX_TMUX_SOCKET = previous;
      resetTmuxSocketCache();
    }
  });

  it("gives up on a probe that never answers rather than holding the switch", async () => {
    // A wedged tmux server must not wedge the key that gets the user out of
    // the picker. An unanswered probe reads the same as a failed one.
    const { deps } = countingDeps({
      listPaneTtys: () => new Promise(() => {}),
    });
    const started = Date.now();
    expect(await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps))).toEqual(
      {
        kind: "not-popup",
      },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(3000);
  });

  it("gives up on a client query that never answers", async () => {
    const { deps } = countingDeps({
      listSessionClientTtys: () => new Promise(() => {}),
    });
    const started = Date.now();
    expect(await withTmux(INSIDE_TMUX, () => resolvePopupClient(deps))).toEqual(
      {
        kind: "unknown",
      },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(3000);
  });
});
