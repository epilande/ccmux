import { describe, expect, it } from "bun:test";
import {
  detectLegacyPopupBinding,
  shouldHintLegacyPopupBinding,
  type PopupHintDeps,
} from "./popup-hint";

const POPUP_TTY = "/dev/ttys099";
const PANE_TTYS = ["/dev/ttys001", "/dev/ttys002"];
const TWO_CLIENTS = ["/dev/ttys010", "/dev/ttys011"];

describe("shouldHintLegacyPopupBinding", () => {
  it("hints for a popup with two clients and no captured tty", () => {
    expect(
      shouldHintLegacyPopupBinding({
        captured: false,
        clientTtys: TWO_CLIENTS,
        ownTty: POPUP_TTY,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(true);
  });

  it("stays quiet once the binding captures a tty", () => {
    expect(
      shouldHintLegacyPopupBinding({
        captured: true,
        clientTtys: TWO_CLIENTS,
        ownTty: POPUP_TTY,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });

  it("stays quiet with a single client, where tmux cannot pick wrong", () => {
    expect(
      shouldHintLegacyPopupBinding({
        captured: false,
        clientTtys: ["/dev/ttys010"],
        ownTty: POPUP_TTY,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });

  it("stays quiet in a real pane, where the current client is unambiguous", () => {
    expect(
      shouldHintLegacyPopupBinding({
        captured: false,
        clientTtys: TWO_CLIENTS,
        ownTty: "/dev/ttys002",
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });

  it("stays quiet when a tmux query failed", () => {
    const base = {
      captured: false,
      clientTtys: TWO_CLIENTS,
      ownTty: POPUP_TTY,
      paneTtys: PANE_TTYS,
    };
    expect(shouldHintLegacyPopupBinding({ ...base, clientTtys: null })).toBe(
      false,
    );
    expect(shouldHintLegacyPopupBinding({ ...base, paneTtys: null })).toBe(
      false,
    );
  });

  it("stays quiet when we have no tty of our own to compare", () => {
    expect(
      shouldHintLegacyPopupBinding({
        captured: false,
        clientTtys: TWO_CLIENTS,
        ownTty: null,
        paneTtys: PANE_TTYS,
      }),
    ).toBe(false);
  });
});

function countingDeps(overrides: Partial<PopupHintDeps> = {}): {
  deps: PopupHintDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: PopupHintDeps = {
    hasCaptured: overrides.hasCaptured ?? (() => false),
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

describe("detectLegacyPopupBinding", () => {
  it("queries tmux and hints when the binding is legacy", async () => {
    const { deps, calls } = countingDeps();
    expect(await detectLegacyPopupBinding(deps)).toBe(true);
    expect(calls.sort()).toEqual(["list-clients", "list-panes", "tty"]);
  });

  it("runs no tmux query at all when a tty was captured", async () => {
    const { deps, calls } = countingDeps({ hasCaptured: () => true });
    expect(await detectLegacyPopupBinding(deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not hint a correctly bound picker running in a real pane", async () => {
    const { deps } = countingDeps({ readTty: async () => PANE_TTYS[0]! });
    expect(await detectLegacyPopupBinding(deps)).toBe(false);
  });
});
