import { describe, expect, it } from "bun:test";
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
    statFile: async () => ({ dev: 1n, ino: 2n, size: 100n, mtimeMs: 0n }),
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

  it.each(["opencode", "/agents/opencode", "./opencode"])(
    "leaves an unknown executable versionless for %s",
    async (command) => {
      // PATH may hold a 1.x while the pane runs 2.x; a guessed 1.x would
      // re-arm Approve/Deny keys that approve on 2.x.
      const { daemon, probes, updates } = harness(() => "1.18.34");
      daemon.resolveProcessExecutable = async () => undefined;
      await daemon.resolvePaneTrackedSessionVersion(
        "opencode_pane1",
        command,
        1234,
        getBuiltinAgent("opencode"),
      );
      expect(probes).toEqual([]);
      expect(updates).toEqual([]);
    },
  );

  it.each(["opencode", "/agents/opencode"])(
    "leaves %s versionless when its executable is a runtime",
    async (command) => {
      // A bare `opencode` whose PID executable is a runtime would otherwise be
      // probed through PATH, the same guess as an unknown executable.
      const { daemon, probes, updates } = harness(() => "1.18.34");
      daemon.resolveProcessExecutable = async () => ({
        path: "/usr/bin/bun",
        probePath: "/usr/bin/bun",
      });
      await daemon.resolvePaneTrackedSessionVersion(
        "opencode_pane1",
        command,
        1234,
        getBuiltinAgent("opencode"),
      );
      expect(probes).toEqual([]);
      expect(updates).toEqual([]);
    },
  );

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
      "D0x1",
      "i2",
    ];
    expect(await daemon.resolveProcessExecutable(NO_SUCH_PID)).toEqual({
      path: "/home/u/.opencode/bin/opencode",
      probePath: "/home/u/.opencode/bin/opencode",
      identity: { dev: 1n, ino: 2n },
    });
  });

  it.each(["opencode", "/agents/opencode"])(
    "rejects an absolute fallback after a deleted executable lookup: %s",
    async (command) => {
      const { daemon, probes, updates } = harness(() => "1.18.34", NO_SUCH_PID);
      daemon.getLsofLines = async () => [
        "ftxt",
        "D0x1",
        "i2",
        "n/agents/opencode (deleted)",
      ];
      await daemon.resolvePaneTrackedSessionVersion(
        "opencode_pane1",
        command,
        NO_SUCH_PID,
        getBuiltinAgent("opencode"),
      );
      expect(probes).toEqual([]);
      expect(updates).toEqual([]);
    },
  );

  it.each(["opencode", "absolute"])(
    "refuses a replacement at lsof's unchanged pathname for %s argv",
    async (command) => {
      const dir = mkdtempSync(join(tmpdir(), "ccmux-version-"));
      try {
        const path = join(dir, "opencode");
        writeFileSync(path, "old running executable");
        const live = statSync(path, { bigint: true });
        writeFileSync(join(dir, "replacement"), "replacement executable");
        renameSync(join(dir, "replacement"), path);
        expect(statSync(path, { bigint: true }).ino).not.toBe(live.ino);

        const { daemon, updates } = harness(() => "", NO_SUCH_PID);
        let probes = 0;
        daemon.versionResolver = new VersionResolver({
          runCommand: async () => {
            probes++;
            return { stdout: "1.18.34", stderr: "", exitCode: 0 };
          },
        });
        // macOS retains the pathname without a deleted suffix. The live
        // inode comes from lsof; stat(path) now sees the replacement.
        daemon.getLsofLines = async () => [
          "p1",
          "ftxt",
          `D0x${live.dev.toString(16)}`,
          `i${live.ino}`,
          `n${path}`,
        ];
        await daemon.resolvePaneTrackedSessionVersion(
          "opencode_pane1",
          command === "absolute" ? path : command,
          NO_SUCH_PID,
          getBuiltinAgent("opencode"),
        );
        expect(probes).toBe(0);
        expect(updates).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
