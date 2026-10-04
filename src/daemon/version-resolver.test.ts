import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentDef } from "../lib/agents";
import { getBuiltinAgent } from "../lib/agents-test-helpers";
import {
  VersionResolver,
  buildVersionProbeCommand,
  extractVersionFromOutput,
  inferVersionFromProcessCommand,
  probesThroughPath,
} from "./version-resolver";

const exe = (path: string, probePath = path) => ({ path, probePath });

describe("version-resolver", () => {
  describe("buildVersionProbeCommand", () => {
    it("builds npm exec probe for gemini package wrapper", () => {
      const gemini = getBuiltinAgent("gemini");
      const probe = buildVersionProbeCommand(
        "npm exec @google/gemini-cli",
        gemini,
      );
      expect(probe).toEqual([
        "npm",
        "exec",
        "@google/gemini-cli",
        "--",
        "--version",
      ]);
    });

    it("builds node wrapper probe for brew-installed gemini", () => {
      const gemini = getBuiltinAgent("gemini");
      const probe = buildVersionProbeCommand(
        "/opt/homebrew/opt/node/bin/node /opt/homebrew/bin/gemini",
        gemini,
      );
      expect(probe).toEqual([
        "/opt/homebrew/opt/node/bin/node",
        "/opt/homebrew/bin/gemini",
        "--version",
      ]);
    });

    it("builds direct executable probe for opencode", () => {
      const opencode = getBuiltinAgent("opencode");
      const probe = buildVersionProbeCommand(
        "/usr/local/bin/opencode --continue",
        opencode,
      );
      expect(probe).toEqual(["/usr/local/bin/opencode", "--version"]);
    });

    it("falls back to configured version command", () => {
      const customAgent: AgentDef = {
        name: "custom",
        shortCode: "Cu",
        processMatch: /\bcustom\b/i,
        versionCommand: "customctl version --short",
        terminalRules: [],
      };
      const probe = buildVersionProbeCommand(
        "python some-wrapper.py",
        customAgent,
      );
      expect(probe).toEqual(["customctl", "version", "--short"]);
    });
  });

  describe("extractVersionFromOutput", () => {
    it("extracts semantic versions and strips leading v", () => {
      expect(extractVersionFromOutput("Codex CLI v0.2.4")).toBe("0.2.4");
    });

    it("supports custom capture patterns", () => {
      const output = "gemini-cli release: 1.4.9";
      const version = extractVersionFromOutput(output, [/release:\s*(\S+)/i]);
      expect(version).toBe("1.4.9");
    });
  });

  describe("inferVersionFromProcessCommand", () => {
    it("infers Homebrew cellar version from a node script path", () => {
      const gemini = getBuiltinAgent("gemini");
      const tempDir = mkdtempSync(join(process.cwd(), "tmp-version-test-"));
      try {
        const cellarBin = join(
          tempDir,
          "Cellar",
          "gemini-cli",
          "0.29.5",
          "bin",
        );
        mkdirSync(cellarBin, { recursive: true });
        const target = join(cellarBin, "gemini");
        writeFileSync(target, "#!/usr/bin/env node\n");

        const shim = join(tempDir, "gemini");
        symlinkSync(target, shim);

        const inferred = inferVersionFromProcessCommand(`node ${shim}`, gemini);
        expect(inferred).toBe("0.29.5");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("prefers gemini shim version over node runtime version", () => {
      const gemini = getBuiltinAgent("gemini");
      const tempDir = mkdtempSync(join(process.cwd(), "tmp-version-test-"));
      try {
        const nodeBinDir = join(tempDir, "Cellar", "node", "25.6.1", "bin");
        mkdirSync(nodeBinDir, { recursive: true });
        const fakeNode = join(nodeBinDir, "node");
        writeFileSync(fakeNode, "#!/usr/bin/env node\n");

        const cellarBin = join(
          tempDir,
          "Cellar",
          "gemini-cli",
          "0.29.5",
          "bin",
        );
        mkdirSync(cellarBin, { recursive: true });
        const target = join(cellarBin, "gemini");
        writeFileSync(target, "#!/usr/bin/env node\n");

        const shim = join(tempDir, "gemini");
        symlinkSync(target, shim);

        const inferred = inferVersionFromProcessCommand(
          `${fakeNode} ${shim}`,
          gemini,
        );
        expect(inferred).toBe("0.29.5");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("VersionResolver.resolve", () => {
    it("uses each native process's executable instead of a shared PATH probe", async () => {
      const probes: string[][] = [];
      const resolver = new VersionResolver({
        runCommand: async (argv) => {
          probes.push(argv);
          return {
            stdout: argv[0] === "/agents/v1/opencode" ? "1.18.34" : "2.0.21",
            stderr: "",
            exitCode: 0,
          };
        },
      });
      const agent = getBuiltinAgent("opencode");
      expect(
        await resolver.resolve(agent, "opencode", exe("/agents/v1/opencode")),
      ).toBe("1.18.34");
      expect(
        await resolver.resolve(agent, "opencode", exe("/agents/v2/opencode.exe")),
      ).toBe("2.0.21");
      expect(probes).toEqual([
        ["/agents/v1/opencode", "--version"],
        ["/agents/v2/opencode.exe", "--version"],
      ]);
    });

    it("does not fall back to another installation when the known binary cannot be probed", async () => {
      const probes: string[][] = [];
      const resolver = new VersionResolver({
        runCommand: async (argv) => {
          probes.push(argv);
          return {
            stdout: argv[0] === "opencode" ? "1.18.34" : "",
            stderr: "",
            exitCode: 1,
          };
        },
      });
      expect(
        await resolver.resolve(
          getBuiltinAgent("opencode"),
          "opencode",
          exe("/agents/v2/opencode"),
        ),
      ).toBeNull();
      expect(probes).toEqual([["/agents/v2/opencode", "--version"]]);
    });

    it("preserves node script probes instead of reporting the runtime version", async () => {
      const probes: string[][] = [];
      const resolver = new VersionResolver({
        runCommand: async (argv) => {
          probes.push(argv);
          return { stdout: "0.29.5", stderr: "", exitCode: 0 };
        },
      });
      expect(
        await resolver.resolve(
          getBuiltinAgent("gemini"),
          "node /agents/gemini",
          exe("/usr/bin/node"),
        ),
      ).toBe("0.29.5");
      expect(probes).toEqual([["node", "/agents/gemini", "--version"]]);
    });

    it("does not replace a renamed agent process with its Bun runtime", async () => {
      const probes: string[][] = [];
      const resolver = new VersionResolver({
        runCommand: async (argv) => {
          probes.push(argv);
          return { stdout: "0.79.9", stderr: "", exitCode: 0 };
        },
      });
      expect(
        await resolver.resolve(getBuiltinAgent("pi"), "pi", exe("/usr/bin/bun")),
      ).toBe("0.79.9");
      expect(probes).toEqual([["pi", "--version"]]);
    });

    it("preserves spaces and quotes in the PID executable path", async () => {
      const executable = "/agents/owner's tools/opencode";
      const probes: string[][] = [];
      const resolver = new VersionResolver({
        runCommand: async (argv) => {
          probes.push(argv);
          return { stdout: "2.0.21", stderr: "", exitCode: 0 };
        },
      });
      expect(
        await resolver.resolve(
          getBuiltinAgent("opencode"),
          "/other/opencode",
          exe(executable),
        ),
      ).toBe("2.0.21");
      expect(probes).toEqual([[executable, "--version"]]);
    });

    it("deduplicates in-flight probes and caches successful results", async () => {
      const opencode = getBuiltinAgent("opencode");
      let calls = 0;
      let now = 0;
      const resolver = new VersionResolver({
        ttlMs: 1000,
        now: () => now,
        runCommand: async (_argv, _timeoutMs) => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return {
            stdout: `opencode v2.5.${calls}`,
            stderr: "",
            exitCode: 0,
          };
        },
      });

      const [first, second] = await Promise.all([
        resolver.resolve(opencode, "/usr/local/bin/opencode --continue"),
        resolver.resolve(opencode, "/usr/local/bin/opencode --continue"),
      ]);
      expect(first).toBe("2.5.1");
      expect(second).toBe("2.5.1");
      expect(calls).toBe(1);

      const cached = await resolver.resolve(
        opencode,
        "/usr/local/bin/opencode --continue",
      );
      expect(cached).toBe("2.5.1");
      expect(calls).toBe(1);

      now = 1500;
      const refreshed = await resolver.resolve(
        opencode,
        "/usr/local/bin/opencode --continue",
      );
      expect(refreshed).toBe("2.5.2");
      expect(calls).toBe(2);
    });

    it("re-probes a binary replaced at the same path instead of reusing its cached version", async () => {
      // OpenCode 2's installer writes over 1.x's ~/.opencode/bin/opencode, so
      // a path-only cache key would stamp the new 2.x process with 1.x.
      const opencode = getBuiltinAgent("opencode");
      const path = "/home/u/.opencode/bin/opencode";
      let installed = { version: "1.18.34", ino: 1 };
      let calls = 0;
      const resolver = new VersionResolver({
        statFile: async () => ({
          dev: 1,
          ino: installed.ino,
          size: 100,
          mtimeMs: installed.ino,
        }),
        runCommand: async () => {
          calls += 1;
          return { stdout: installed.version, stderr: "", exitCode: 0 };
        },
      });

      expect(await resolver.resolve(opencode, "opencode", exe(path))).toBe(
        "1.18.34",
      );
      expect(await resolver.resolve(opencode, "opencode", exe(path))).toBe(
        "1.18.34",
      );
      expect(calls).toBe(1);

      installed = { version: "opencode v2.0.21", ino: 2 };
      expect(await resolver.resolve(opencode, "opencode", exe(path))).toBe(
        "2.0.21",
      );
      expect(calls).toBe(2);
    });

    it("probes a replaced binary through its exe link but matches it by its original name", async () => {
      const probes: string[][] = [];
      const resolver = new VersionResolver({
        runCommand: async (argv) => {
          probes.push(argv);
          return { stdout: "1.18.26", stderr: "", exitCode: 0 };
        },
      });
      expect(
        await resolver.resolve(
          getBuiltinAgent("opencode"),
          "opencode",
          exe("/home/u/.opencode/bin/opencode", "/proc/100/exe"),
        ),
      ).toBe("1.18.26");
      expect(probes).toEqual([["/proc/100/exe", "--version"]]);
    });
  });

  describe("probesThroughPath", () => {
    const opencode = getBuiltinAgent("opencode");

    it("is true for the agent's bare name, which the daemon's PATH resolves", () => {
      expect(probesThroughPath(opencode, "opencode --continue")).toBe(true);
    });

    it("is false once the process's own executable is known to be the agent", () => {
      expect(
        probesThroughPath(opencode, "opencode", exe("/home/u/.opencode/bin/opencode")),
      ).toBe(false);
    });

    it("stays true when the known executable is a runtime or another binary", () => {
      // The resolver would not swap to it, so the probe would go to PATH.
      expect(probesThroughPath(opencode, "opencode", exe("/usr/bin/bun"))).toBe(
        true,
      );
    });

    it("is false for an absolute path or another program", () => {
      expect(probesThroughPath(opencode, "/opt/opencode/bin/opencode")).toBe(
        false,
      );
      expect(probesThroughPath(opencode, "node /agents/opencode")).toBe(false);
      expect(probesThroughPath(opencode, "")).toBe(false);
    });
  });
});
