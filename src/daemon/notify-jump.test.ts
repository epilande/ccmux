import { describe, it, expect } from "bun:test";
import { performJump, type JumpDeps } from "./notify-jump";
import type { SpawnFn } from "../lib/notify";

/** Records spawn argv and lets `activateTerminal` be observed/ordered. */
function createDeps(overrides: Partial<JumpDeps> = {}): {
  deps: JumpDeps;
  spawnCalls: string[][];
  events: string[];
} {
  const spawnCalls: string[][] = [];
  const events: string[] = [];

  const spawn: SpawnFn = (argv) => {
    spawnCalls.push(argv);
    events.push(`spawn:${argv[1]}`);
    return { exited: Promise.resolve(0) };
  };

  const deps: JumpDeps = {
    resolveActiveClientTty:
      overrides.resolveActiveClientTty ?? (async () => "/dev/ttys002"),
    tmuxPath: overrides.tmuxPath ?? "/opt/homebrew/bin/tmux",
    ccmuxPath: "ccmuxPath" in overrides ? overrides.ccmuxPath! : "/bin/ccmux",
    spawn: overrides.spawn ?? spawn,
    log: overrides.log ?? (() => {}),
    activateTerminal:
      "activateTerminal" in overrides
        ? overrides.activateTerminal
        : async () => {
            events.push("activate");
          },
  };
  return { deps, spawnCalls, events };
}

describe("performJump: terminal activation", () => {
  it("switches the client to a bound pane, then activates the terminal", async () => {
    const { deps, spawnCalls, events } = createDeps();

    await performJump({ background: false, pane: "%5" }, deps);

    expect(spawnCalls[0]).toEqual([
      "/opt/homebrew/bin/tmux",
      "switch-client",
      "-c",
      "/dev/ttys002",
      "-t",
      "%5",
    ]);
    // Activation happens after the jump, not before.
    expect(events).toEqual(["spawn:switch-client", "activate"]);
  });

  it("opens the popup for a background session, then activates the terminal", async () => {
    const { deps, spawnCalls, events } = createDeps();

    await performJump({ background: true, pane: null }, deps);

    expect(spawnCalls[0]).toEqual([
      "/opt/homebrew/bin/tmux",
      "display-popup",
      "-c",
      "/dev/ttys002",
      "-E",
      "/bin/ccmux",
    ]);
    expect(events).toEqual(["spawn:display-popup", "activate"]);
  });

  it("does not activate when there is no active client tty (nothing to jump to)", async () => {
    const { deps, spawnCalls, events } = createDeps({
      resolveActiveClientTty: async () => null,
    });

    await performJump({ background: false, pane: "%5" }, deps);

    expect(spawnCalls).toHaveLength(0);
    expect(events).not.toContain("activate");
  });

  it("does not activate when a background jump has no ccmuxPath (jump impossible)", async () => {
    const { deps, spawnCalls, events } = createDeps({ ccmuxPath: null });

    await performJump({ background: true, pane: null }, deps);

    expect(spawnCalls).toHaveLength(0);
    expect(events).not.toContain("activate");
  });

  it("works without an activateTerminal dep (Linux path), still jumping", async () => {
    const { deps, spawnCalls } = createDeps({ activateTerminal: undefined });

    await performJump({ background: false, pane: "%5" }, deps);

    expect(spawnCalls[0]?.[1]).toBe("switch-client");
  });

  it("swallows an activateTerminal that throws (fail-open)", async () => {
    const { deps, spawnCalls } = createDeps({
      activateTerminal: async () => {
        throw new Error("open failed");
      },
    });

    await expect(
      performJump({ background: false, pane: "%5" }, deps),
    ).resolves.toBeUndefined();
    // The jump itself still happened.
    expect(spawnCalls[0]?.[1]).toBe("switch-client");
  });
});
