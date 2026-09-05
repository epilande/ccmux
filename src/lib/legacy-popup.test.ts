import { describe, expect, it } from "bun:test";
import {
  detectLegacyPopupLaunch,
  isLegacyPopupLaunch,
  type LegacyPopupDeps,
} from "./legacy-popup";

const POPUP_TTY = "/dev/ttys099";
const PANE_TTYS = ["/dev/ttys001", "/dev/ttys002"];
const TWO_CLIENTS = ["/dev/ttys010", "/dev/ttys011"];

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

describe("isLegacyPopupLaunch", () => {
  it("flags a popup with two clients and no captured tty", () => {
    expect(
      isLegacyPopupLaunch({
        insideTmux: true,
        clientTtys: TWO_CLIENTS,
        ownTty: POPUP_TTY,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(true);
  });

  it("stays quiet with a single client, where tmux cannot pick wrong", () => {
    expect(
      isLegacyPopupLaunch({
        insideTmux: true,
        clientTtys: ["/dev/ttys010"],
        ownTty: POPUP_TTY,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });

  it("stays quiet in a real pane, where the current client is unambiguous", () => {
    expect(
      isLegacyPopupLaunch({
        insideTmux: true,
        clientTtys: TWO_CLIENTS,
        ownTty: "/dev/ttys002",
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });

  it("stays quiet outside tmux, where having no pane means nothing", () => {
    // A plain terminal has no pane either, and `list-clients` answers from
    // anywhere on the machine. Without this test a bare `ccmux` in a second
    // terminal looks exactly like a legacy popup and loses its switch.
    expect(
      isLegacyPopupLaunch({
        insideTmux: false,
        clientTtys: TWO_CLIENTS,
        ownTty: POPUP_TTY,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });

  it("stays quiet when a tmux query failed", () => {
    const base = {
      insideTmux: true,
      clientTtys: TWO_CLIENTS,
      ownTty: POPUP_TTY,
      paneTtys: PANE_TTYS,
    };
    expect(isLegacyPopupLaunch({ ...base, clientTtys: null })).toBe(false);
    expect(isLegacyPopupLaunch({ ...base, paneTtys: null })).toBe(false);
  });

  it("stays quiet when we have no tty of our own to compare", () => {
    expect(
      isLegacyPopupLaunch({
        insideTmux: true,
        clientTtys: TWO_CLIENTS,
        ownTty: null,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });
});

function countingDeps(overrides: Partial<LegacyPopupDeps> = {}): {
  deps: LegacyPopupDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: LegacyPopupDeps = {
    listClientTtys:
      overrides.listClientTtys ??
      (async () => {
        calls.push("list-clients");
        return TWO_CLIENTS;
      }),
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
  };
  return { deps, calls };
}

describe("detectLegacyPopupLaunch", () => {
  it("queries tmux and answers yes when the launch is a legacy popup", async () => {
    const { deps, calls } = countingDeps();
    expect(
      await withTmux("/tmp/tmux-501/default,1,0", () =>
        detectLegacyPopupLaunch(deps),
      ),
    ).toBe(true);
    expect(calls.sort()).toEqual(["list-clients", "list-panes", "tty"]);
  });

  it("runs no query at all outside tmux", async () => {
    const { deps, calls } = countingDeps();
    expect(await withTmux(undefined, () => detectLegacyPopupLaunch(deps))).toBe(
      false,
    );
    expect(calls).toEqual([]);
  });

  it("does not flag a picker running in a real pane", async () => {
    const { deps } = countingDeps({ readTty: async () => PANE_TTYS[0]! });
    expect(
      await withTmux("/tmp/tmux-501/default,1,0", () =>
        detectLegacyPopupLaunch(deps),
      ),
    ).toBe(false);
  });

  it("gives up on a probe that never answers rather than holding the switch", async () => {
    // A wedged tmux server must not wedge the key that gets the user out of
    // the picker. An unanswered probe reads the same as a failed one.
    const { deps } = countingDeps({
      listPaneTtys: () => new Promise(() => {}),
    });
    const started = Date.now();
    expect(
      await withTmux("/tmp/tmux-501/default,1,0", () =>
        detectLegacyPopupLaunch(deps),
      ),
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
