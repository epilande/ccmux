import { describe, expect, it } from "bun:test";
import { Daemon } from "./index";
import type { AgentDef } from "../lib/agents";
import { getBuiltinAgent } from "../lib/agents-test-helpers";
import type { ProcessExecutable } from "./processes";
import { VersionResolver } from "./version-resolver";

interface VersionHarness {
  versionResolver: VersionResolver;
  resolveProcessExecutable(pid: number): Promise<ProcessExecutable | undefined>;
  getLsofLines(pid: number): Promise<string[]>;
  sessionManager: {
    getSession(id: string): { pid: number | null } | undefined;
    updateSession(id: string, patch: { version: string }): boolean;
  };
  resolvePaneTrackedSessionVersion(
    id: string,
    command: string,
    pid: number,
    agent: AgentDef,
  ): Promise<void>;
}

/**
 * A Daemon with only what version resolution touches, so the method runs
 * without starting services or reading user state. Every probe answers with
 * `version` and is recorded; the session's current pid is `sessionPid`.
 */
function harness(version: (argv: string[]) => string, sessionPid = 1234) {
  const daemon = Object.create(Daemon.prototype) as VersionHarness;
  const probes: string[][] = [];
  daemon.versionResolver = new VersionResolver({
    runCommand: async (argv) => {
      probes.push(argv);
      return { stdout: version(argv), stderr: "", exitCode: 0 };
    },
  });
  const updates: Array<{ id: string; version: string }> = [];
  daemon.sessionManager = {
    getSession: () => ({ pid: sessionPid }),
    updateSession: (id, patch) => {
      updates.push({ id, ...patch });
      return true;
    },
  };
  return { daemon, probes, updates };
}

/** A pid no process has, so procfs answers nothing and lsof is consulted. */
const NO_SUCH_PID = 2 ** 30;

describe("pane-tracked version provenance", () => {
  it.each([
    ["1.18.34", "2.0.21"],
    ["2.0.21", "1.18.34"],
  ])(
    "reports process version %s when PATH has %s",
    async (nativeVersion, pathVersion) => {
      // A successful PATH probe must never mask the PID binary.
      const { daemon, probes, updates } = harness((argv) =>
        argv[0] === "/agents/native/opencode" ? nativeVersion : pathVersion,
      );
      daemon.resolveProcessExecutable = async (pid) => {
        expect(pid).toBe(1234);
        return {
          path: "/agents/native/opencode",
          probePath: "/agents/native/opencode",
        };
      };
      await daemon.resolvePaneTrackedSessionVersion(
        "opencode_pane1",
        "opencode",
        1234,
        getBuiltinAgent("opencode"),
      );
      expect(updates).toEqual([
        { id: "opencode_pane1", version: nativeVersion },
      ]);
      expect(probes).toEqual([["/agents/native/opencode", "--version"]]);
    },
  );

  it("leaves a version-gated agent versionless rather than probe PATH for an unknown executable", async () => {
    // PATH may hold a 1.x while the pane runs 2.x; a guessed 1.x would
    // re-arm Approve/Deny keys that approve on 2.x.
    const { daemon, probes, updates } = harness(() => "1.18.34");
    daemon.resolveProcessExecutable = async () => undefined;
    await daemon.resolvePaneTrackedSessionVersion(
      "opencode_pane1",
      "opencode",
      1234,
      getBuiltinAgent("opencode"),
    );
    expect(probes).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("leaves it versionless when the known executable is not the agent", async () => {
    // A bare `opencode` whose PID executable is a runtime would otherwise be
    // probed through PATH, the same guess as an unknown executable.
    const { daemon, probes, updates } = harness(() => "1.18.34");
    daemon.resolveProcessExecutable = async () => ({
      path: "/usr/bin/bun",
      probePath: "/usr/bin/bun",
    });
    await daemon.resolvePaneTrackedSessionVersion(
      "opencode_pane1",
      "opencode",
      1234,
      getBuiltinAgent("opencode"),
    );
    expect(probes).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("still probes PATH for an agent whose keys are not version-gated", async () => {
    const { daemon, probes, updates } = harness(() => "0.160.0");
    daemon.resolveProcessExecutable = async () => undefined;
    await daemon.resolvePaneTrackedSessionVersion(
      "codex_pane1",
      "codex",
      1234,
      getBuiltinAgent("codex"),
    );
    expect(probes).toEqual([["codex", "--version"]]);
    expect(updates).toEqual([{ id: "codex_pane1", version: "0.160.0" }]);
  });

  it("drops a version probed for a process the pane no longer runs", async () => {
    // A 1.x probe finishing after a 2.x process replaced it in the pane must
    // not label the 2.x session 1.x.
    const { daemon, updates } = harness(() => "1.18.34", 5678);
    daemon.resolveProcessExecutable = async () => ({
      path: "/agents/native/opencode",
      probePath: "/agents/native/opencode",
    });
    await daemon.resolvePaneTrackedSessionVersion(
      "opencode_pane1",
      "opencode",
      1234,
      getBuiltinAgent("opencode"),
    );
    expect(updates).toEqual([]);
  });

  it("does not take a replaced binary's path from lsof", async () => {
    const { daemon } = harness(() => "");
    daemon.getLsofLines = async () => [
      "p1",
      "ftxt",
      "n/home/u/.opencode/bin/opencode (deleted)",
    ];
    expect(await daemon.resolveProcessExecutable(NO_SUCH_PID)).toBeUndefined();
  });

  it("takes a live binary's path from lsof when procfs has none", async () => {
    const { daemon } = harness(() => "");
    daemon.getLsofLines = async () => [
      "p1",
      "ftxt",
      "n/home/u/.opencode/bin/opencode",
    ];
    expect(await daemon.resolveProcessExecutable(NO_SUCH_PID)).toEqual({
      path: "/home/u/.opencode/bin/opencode",
      probePath: "/home/u/.opencode/bin/opencode",
    });
  });
});
