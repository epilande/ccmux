import { describe, expect, it } from "bun:test";
import { Daemon } from "./index";
import type { AgentDef } from "../lib/agents";
import { getBuiltinAgent } from "../lib/agents-test-helpers";
import { VersionResolver } from "./version-resolver";

interface VersionHarness {
  versionResolver: VersionResolver;
  resolveProcessExecutablePath(pid: number): Promise<string | undefined>;
  sessionManager: {
    updateSession(id: string, patch: { version: string }): boolean;
  };
  resolvePaneTrackedSessionVersion(
    id: string,
    command: string,
    pid: number,
    agent: AgentDef,
  ): Promise<void>;
}

describe("pane-tracked version provenance", () => {
  it.each([
    ["1.18.34", "2.0.21"],
    ["2.0.21", "1.18.34"],
  ])(
    "reports process version %s when PATH has %s",
    async (nativeVersion, pathVersion) => {
      // Exercise the daemon method without starting its services or reading
      // user state. A successful PATH probe must never mask the PID binary.
      const daemon = Object.create(Daemon.prototype) as VersionHarness;
      const probes: string[][] = [];
      daemon.versionResolver = new VersionResolver({
        runCommand: async (argv) => {
          probes.push(argv);
          return {
            stdout:
              argv[0] === "/agents/native/opencode"
                ? nativeVersion
                : pathVersion,
            stderr: "",
            exitCode: 0,
          };
        },
      });
      daemon.resolveProcessExecutablePath = async (pid) => {
        expect(pid).toBe(1234);
        return "/agents/native/opencode";
      };
      const updates: Array<{ id: string; version: string }> = [];
      daemon.sessionManager = {
        updateSession: (id, patch) => {
          updates.push({ id, ...patch });
          return true;
        },
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
});
