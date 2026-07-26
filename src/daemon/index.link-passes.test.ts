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

const LINK_PASS_NAMES = [
  "codex",
  "opencode",
  "cursor",
  "pi",
  "antigravity",
  "copilot",
] as const;
type LinkPassName = (typeof LINK_PASS_NAMES)[number];

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

const LINK_PASS_METHOD: Record<LinkPassName, keyof LinkPassesInternals> = {
  codex: "linkCodexSessions",
  opencode: "linkOpenCodeSessions",
  cursor: "linkCursorSessions",
  pi: "linkPiSessions",
  antigravity: "linkAntigravitySessions",
  copilot: "linkCopilotSessions",
};

/**
 * Wire all six link-pass methods on `internals` to record their name in
 * `calls` and, for any name listed in `failing`, throw. Centralizes the
 * six-method boilerplate every `runLinkPasses` test needs.
 */
function installLinkPassMocks(
  internals: LinkPassesInternals,
  options: { failing?: readonly LinkPassName[] } = {},
): string[] {
  const calls: string[] = [];
  const failing = new Set(options.failing ?? []);
  for (const name of LINK_PASS_NAMES) {
    internals[LINK_PASS_METHOD[name]] = (async () => {
      calls.push(name);
      if (failing.has(name)) throw new Error(`${name} link pass boom`);
    }) as never;
  }
  return calls;
}

describe("Daemon.runLinkPasses", () => {
  let daemon: Daemon;
  let internals: LinkPassesInternals;

  beforeEach(() => {
    daemon = new Daemon();
    internals = daemon as unknown as LinkPassesInternals;
  });

  it("runs every pass concurrently, isolating a single rejection (allSettled)", async () => {
    const calls = installLinkPassMocks(internals, { failing: ["codex"] });

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    // Must not reject/throw even though the codex pass does.
    await expect(
      internals.runLinkPasses([], [], new Map()),
    ).resolves.toBeUndefined();
    errorSpy.mockRestore();

    expect(calls.sort()).toEqual([...LINK_PASS_NAMES].sort());
  });

  it("logs the rejected pass name and reason without dropping other passes' errors", async () => {
    installLinkPassMocks(internals, { failing: ["opencode", "pi"] });

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await internals.runLinkPasses([], [], new Map());

    expect(errorSpy).toHaveBeenCalledTimes(2);
    const loggedText = errorSpy.mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    expect(loggedText).toContain("opencode");
    expect(loggedText).toContain("opencode link pass boom");
    expect(loggedText).toContain("pi");
    expect(loggedText).toContain("pi link pass boom");
    errorSpy.mockRestore();
  });

  it("all six passes succeed with no rejections and no error logs", async () => {
    const calls = installLinkPassMocks(internals);

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    await internals.runLinkPasses([], [], new Map());
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();

    expect(calls.sort()).toEqual([...LINK_PASS_NAMES].sort());
  });
});
