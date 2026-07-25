import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

/** Redirect STATE_FILE to a temp dir so tests don't touch real ~/.config/ccmux/state.json */
const tempRoot = join(
  tmpdir(),
  `ccmux-linkpasses-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
process.env.CCMUX_HOME = tempRoot;

const actualConfig = await import("../lib/config");
mock.module("../lib/config", () => ({
  ...actualConfig,
  STATE_FILE: join(tempRoot, "state.json"),
}));

import { Daemon } from "./index";
import type { ProcessInfo, TmuxPane } from "../types/session";

type LinkPassesInternals = {
  linkCodexSessions(
    processes: ProcessInfo[],
    panes: TmuxPane[],
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void>;
  linkOpenCodeSessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void>;
  linkCursorSessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void>;
  linkPiSessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void>;
  linkAntigravitySessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void>;
  linkCopilotSessions(
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void>;
  runLinkPasses(
    processes: ProcessInfo[],
    panes: TmuxPane[],
    processStartTimeByPid: ReadonlyMap<number, number | null>,
  ): Promise<void>;
};

describe("Daemon.runLinkPasses", () => {
  let daemon: Daemon;
  let internals: LinkPassesInternals;

  beforeEach(() => {
    daemon = new Daemon();
    internals = daemon as unknown as LinkPassesInternals;
  });

  it("runs every pass concurrently, isolating a single rejection (allSettled)", async () => {
    const calls: string[] = [];
    internals.linkCodexSessions = async () => {
      calls.push("codex");
      throw new Error("codex link pass boom");
    };
    internals.linkOpenCodeSessions = async () => {
      calls.push("opencode");
    };
    internals.linkCursorSessions = async () => {
      calls.push("cursor");
    };
    internals.linkPiSessions = async () => {
      calls.push("pi");
    };
    internals.linkAntigravitySessions = async () => {
      calls.push("antigravity");
    };
    internals.linkCopilotSessions = async () => {
      calls.push("copilot");
    };

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    // Must not reject/throw even though the codex pass does.
    await expect(
      internals.runLinkPasses([], [], new Map()),
    ).resolves.toBeUndefined();
    errorSpy.mockRestore();

    expect(calls.sort()).toEqual([
      "antigravity",
      "codex",
      "copilot",
      "cursor",
      "opencode",
      "pi",
    ]);
  });

  it("logs the rejected pass name and reason without dropping other passes' errors", async () => {
    internals.linkCodexSessions = async () => {};
    internals.linkOpenCodeSessions = async () => {
      throw new Error("opencode boom");
    };
    internals.linkCursorSessions = async () => {};
    internals.linkPiSessions = async () => {
      throw new Error("pi boom");
    };
    internals.linkAntigravitySessions = async () => {};
    internals.linkCopilotSessions = async () => {};

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await internals.runLinkPasses([], [], new Map());

    expect(errorSpy).toHaveBeenCalledTimes(2);
    const loggedText = errorSpy.mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    expect(loggedText).toContain("opencode");
    expect(loggedText).toContain("opencode boom");
    expect(loggedText).toContain("pi");
    expect(loggedText).toContain("pi boom");
    errorSpy.mockRestore();
  });

  it("all six passes succeed with no rejections and no error logs", async () => {
    const calls: string[] = [];
    internals.linkCodexSessions = async () => {
      calls.push("codex");
    };
    internals.linkOpenCodeSessions = async () => {
      calls.push("opencode");
    };
    internals.linkCursorSessions = async () => {
      calls.push("cursor");
    };
    internals.linkPiSessions = async () => {
      calls.push("pi");
    };
    internals.linkAntigravitySessions = async () => {
      calls.push("antigravity");
    };
    internals.linkCopilotSessions = async () => {
      calls.push("copilot");
    };

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await internals.runLinkPasses([], [], new Map());
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    expect(calls.sort()).toEqual([
      "antigravity",
      "codex",
      "copilot",
      "cursor",
      "opencode",
      "pi",
    ]);
  });
});
